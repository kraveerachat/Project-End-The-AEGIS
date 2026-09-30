#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7 Core verification handler. READ-ONLY (probes and reads only).
# Proves: the staged material is exactly what apply installed (modes, owner:group, entry set), core.env and the unit are the reviewed
# ones, the release pointer + immutable release guard hold, the Core is active/running/enabled with zero restarts and exactly the four
# projected credentials (effective CREDENTIALS_DIRECTORY view, byte parity with the staged sources), no plaintext secret variable is in
# its environment, the runtime status is the expected no-device state (WAIT_DEVICE or DEGRADED) with the broker CONNECTED and no containment, ZERO actuation exists in the protocol store and audit DB,
# no new listener appeared, the Core holds an outbound TLS connection to the AP broker port 8883, the D4 credential is readable by the
# Core account, the journal holds no secret and no command, and legacy mosquitto / the L6b broker are unchanged.
# It never prints passwords, keys, PINs or hashes.
set -uo pipefail

fail() { printf 'L7_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
CORE_ACCOUNT=aegis-idea3
CREDS_DIR=/etc/aegis-idea3/credentials
CORE_ENV=/etc/aegis-idea3/core.env
PKI_CA=/etc/aegis-idea3/pki/mqtt-ca.crt
L6B_MQTT_DIR=/etc/aegis-idea3/mqtt
L6B_CA=/etc/aegis-idea3/mqtt/ca.crt
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CURRENT=/opt/aegis-idea3/current
LEGACY_DIR=/etc/mosquitto
DEVICE_ID=aegis-relay-01
TLS_SERVER_NAME=mqtt.aegis.home.arpa
CRED_FILES=(k_c2d k_d2c mqtt-core.pass admin.pin restore.credential)
FORBIDDEN_ENV=(AEGIS_MQTT_PASS AEGIS_ADMIN_PIN AEGIS_P1_C2D_KEY_FILE AEGIS_P1_D2C_KEY_FILE AEGIS_TG_TOKEN)

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$P4_HERE/../.." && pwd)"
# shellcheck source=l7-listener-lib.sh
source "$HERE/l7-listener-lib.sh"
UNIT_SOURCE="$REPO_ROOT/deploy/aegis-idea3-core.service.example"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seams, honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real tools.
FIXTURE_SYSTEMCTL="${AEGIS_L7_FIXTURE_SYSTEMCTL:-}"
FIXTURE_SS="${AEGIS_L7_FIXTURE_SS:-}"
FIXTURE_GROUP="${AEGIS_L7_FIXTURE_SERVICE_GROUP:-}"
FIXTURE_JOURNAL="${AEGIS_L7_FIXTURE_JOURNAL:-}"
WORK="${AEGIS_L7_WORK_DIR:-}"
INPUT="${AEGIS_L7_INPUT_DIR:-}"
RELEASE_DIR="${AEGIS_L7_RELEASE_DIR:-}"
AP_ADDRESS="${AEGIS_AP_ADDRESS:-}"

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() {
  if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi
}
use_ss() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SS" ]; }
ss_do() {
  if [ -z "$ROOT" ]; then ss "$@"; else "$FIXTURE_SS" "$@"; fi
}
as_service() {
  if [ -z "$ROOT" ]; then runuser -u "$CORE_ACCOUNT" -- "$@"; else "$@"; fi
}
snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"
  else
    : > "$out"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING
[ -n "$RELEASE_DIR" ] || fail AEGIS_L7_RELEASE_DIR_REQUIRED
[ -n "$AP_ADDRESS" ] || fail AEGIS_AP_ADDRESS_REQUIRED
for f in journal.tsv ownership-plan.tsv legacy-tree.sha256 l6b-material.txt listeners-baseline.txt release-dir.txt; do
  [ -f "$WORK/$f" ] || fail APPLY_ARTIFACTS_MISSING
done
use_systemd && { [ -f "$WORK/legacy-service.txt" ] || fail APPLY_ARTIFACTS_MISSING; }

creds_dir=$(host_path "$CREDS_DIR")
core_env=$(host_path "$CORE_ENV")
pki_ca=$(host_path "$PKI_CA")
l6b_dir=$(host_path "$L6B_MQTT_DIR")
l6b_ca=$(host_path "$L6B_CA")
unit_dest=$(host_path "$UNIT_DEST")
current=$(host_path "$CURRENT")
legacy_dir=$(host_path "$LEGACY_DIR")
rel_host=$(host_path "$RELEASE_DIR")
# Probes that must run as the Core account use the INSTALLED release's own interpreter and code (root-owned, world-readable): the
# runner's interpreter and this checkout live under the owner's home, which the Core account cannot read.
if [ -z "$ROOT" ]; then SVC_PY="$rel_host/venv/bin/python"; SVC_CODE_ROOT="$rel_host"; else SVC_PY="$PY"; SVC_CODE_ROOT="$REPO_ROOT"; fi

# ── staged material: exact entry set, no CA private key, exact modes and owner:group from the ownership plan ───────────────
[ -d "$creds_dir" ] && [ ! -L "$creds_dir" ] || fail CREDENTIALS_DIR_INVALID
[ "$(ls -A "$creds_dir" | LC_ALL=C sort | paste -sd,)" = "admin.pin,k_c2d,k_d2c,mqtt-core.pass,restore.credential" ] \
  || fail CREDENTIALS_ENTRIES_NOT_EXACT
[ -z "$(find "$(host_path /etc/aegis-idea3)" -maxdepth 3 -name 'ca.key' -print -quit)" ] || fail CA_PRIVATE_KEY_FORBIDDEN
while IFS=$'\t' read -r logical mode owner; do
  [ "$logical" != path ] || continue
  real=$(host_path "$logical")
  name=${logical##*/}
  [ "$logical" != "$CREDS_DIR" ] || name=credentials
  if [ "$logical" = "$CREDS_DIR" ]; then
    [ -d "$real" ] && [ ! -L "$real" ] || fail CREDENTIALS_DIR_INVALID
  else
    [ -f "$real" ] && [ ! -L "$real" ] || fail "MATERIAL_NOT_REGULAR:${name}"
  fi
  [ "$(stat -c '%a' "$real")" = "$mode" ] || fail "MATERIAL_MODE_INVALID:${name}"
  if [ -z "$ROOT" ]; then
    [ "$(stat -c '%U:%G' "$real")" = "$owner" ] || fail "MATERIAL_OWNER_INVALID:${name}"
  elif [ "${owner#*:}" != root ] && [ -n "$FIXTURE_GROUP" ]; then
    [ "$(stat -c '%G' "$real")" = "$FIXTURE_GROUP" ] || fail "MATERIAL_OWNER_INVALID:${name}"
  fi
done < "$WORK/ownership-plan.tsv"

"$PY" "$P4_HERE/p4-l7-core-env.py" check --file "$core_env" --ap-address "$AP_ADDRESS" --device-id "$DEVICE_ID" --server-name "$TLS_SERVER_NAME" \
  > "$WORK/core-env-check.txt" 2>&1 || fail "CORE_ENV_INVALID:$(sed -n 's/.*reason=//p' "$WORK/core-env-check.txt" | head -n 1)"
[ -f "$unit_dest" ] && [ ! -L "$unit_dest" ] && cmp -s "$UNIT_SOURCE" "$unit_dest" || fail UNIT_CONTENT_CHANGED
[ -f "$pki_ca" ] && [ ! -L "$pki_ca" ] && cmp -s "$l6b_ca" "$pki_ca" || fail CA_COPY_MISMATCH

# ── release pointer + immutable release guard ────────────────────────────────────────────────────────────────────────────
[ -L "$current" ] && [ "$(readlink "$current")" = "$RELEASE_DIR" ] || fail RELEASE_POINTER_INVALID
owner_expect=any
[ -z "$ROOT" ] && owner_expect=root
guard_out=$("$PY" "$P4_HERE/p4-l7-release-guard.py" check --logical-path "$RELEASE_DIR" --host-path "$rel_host" --expect-owner "$owner_expect" 2>&1) \
  || fail "RELEASE_GUARD_FAILED:$(sed -n 's/.*reason=//p' <<< "$guard_out" | head -n 1)"

# ── legacy + predecessor boundary ────────────────────────────────────────────────────────────────────────────────────────
snapshot_tree "$legacy_dir" "$WORK/legacy-tree.current"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.current" || fail LEGACY_CONFIG_TREE_CHANGED
{
  (cd "$l6b_dir" && find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 -r stat -c '%n %a %U:%G %s %Y')
  printf 'ca.crt.sha256 %s\n' "$(sha256sum -- "$l6b_ca" | cut -d' ' -f1)"
} > "$WORK/l6b-material.current"
cmp -s "$WORK/l6b-material.txt" "$WORK/l6b-material.current" || fail L6B_MATERIAL_CHANGED
if use_systemd; then
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" > "$WORK/legacy-service.current" || fail PREDECESSOR_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.current" || fail PREDECESSOR_SERVICE_CHANGED
fi

# ── live service health (live, or fixture with the fake systemd) ─────────────────────────────────────────────────────────
core_state=NOT_RUN_FIXTURE
broker_connection=NOT_RUN_FIXTURE
new_listeners=NOT_RUN_FIXTURE
if use_systemd; then
  sysctl_do is-active --quiet "$UNIT" || fail CORE_SERVICE_NOT_ACTIVE
  sysctl_do is-enabled --quiet "$UNIT" || fail CORE_SERVICE_NOT_ENABLED
  [ "$(sysctl_do show -p SubState --value "$UNIT")" = running ] || fail CORE_SERVICE_NOT_RUNNING
  [ "$(sysctl_do show -p Result --value "$UNIT")" = success ] || fail CORE_SERVICE_RESULT_INVALID
  [ "$(sysctl_do show -p NRestarts --value "$UNIT")" = 0 ] || fail CORE_SERVICE_RESTARTED
  pid=$(sysctl_do show -p MainPID --value "$UNIT")
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_SERVICE_NOT_RUNNING

  # no plaintext secret variable may be in the service process environment (secrets arrive only via LoadCredential=)
  environ=$(host_path "/proc/$pid/environ")
  [ -r "$environ" ] || fail PROCESS_ENV_UNREADABLE
  # effective LoadCredential= proof. The four reviewed LoadCredential= directives are proven statically (exact unit comparison above);
  # here the credentials systemd actually delivered to THIS process are proven from its own view. systemctl's textual rendering of the
  # structured LoadCredential property is deliberately never consulted.
  mapfile -d '' -t env_entries < "$environ" || fail LOADCREDENTIAL_INVALID
  cred_dir_entries=()
  for e in "${env_entries[@]}"; do
    [[ "$e" == CREDENTIALS_DIRECTORY=* ]] && cred_dir_entries+=("${e#CREDENTIALS_DIRECTORY=}")
  done
  [ "${#cred_dir_entries[@]}" -eq 1 ] || fail LOADCREDENTIAL_INVALID
  cred_rt=${cred_dir_entries[0]}
  [[ "$cred_rt" =~ ^/[A-Za-z0-9._@:-]+(/[A-Za-z0-9._@:-]+)*$ ]] || fail LOADCREDENTIAL_INVALID
  case "/$cred_rt/" in */../*|*/./*) fail LOADCREDENTIAL_INVALID ;; esac
  # live: resolve through the Core's own mount namespace (the host view need not equal the service's view); fixture: below the fs root
  if [ -z "$ROOT" ]; then rt_dir="/proc/$pid/root$cred_rt"; else rt_dir=$(host_path "$cred_rt"); fi
  [ -d "$rt_dir" ] && [ ! -L "$rt_dir" ] || fail LOADCREDENTIAL_INVALID
  [ "$(ls -A "$rt_dir" | LC_ALL=C sort | paste -sd,)" = "admin.pin,k_c2d,k_d2c,mqtt-core.pass" ] || fail LOADCREDENTIAL_INVALID
  for n in admin.pin k_c2d k_d2c mqtt-core.pass; do
    [ -f "$rt_dir/$n" ] && [ ! -L "$rt_dir/$n" ] || fail LOADCREDENTIAL_INVALID
    cmp -s -- "$creds_dir/$n" "$rt_dir/$n" || fail LOADCREDENTIAL_INVALID
  done

  names=$(tr '\0' '\n' < "$environ" | cut -d= -f1)
  for v in "${FORBIDDEN_ENV[@]}"; do
    ! grep -qx -- "$v" <<< "$names" || fail PROCESS_ENV_LEAK
  done

  # runtime status: expected no-device state, broker connected, no containment. armed is the operational gate (the
  # production Core starts ARMED with AEGIS_AUTO_CONTAIN=0); containment is auto_contain/uplink/device plus the
  # zero-command and zero-actuation checks, so ARMED alone is not treated as containment.
  status=$(host_path /run/aegis-idea3/status.json)
  status_out=$("$PY" - "$status" <<'PYC' 2>/dev/null
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    print("STATUS_UNREADABLE"); sys.exit(0)
if s.get("state") not in ("WAIT_DEVICE", "DEGRADED"):
    print("STATUS_STATE_INVALID"); sys.exit(0)
if s.get("broker") != "CONNECTED":
    print("BROKER_NOT_CONNECTED"); sys.exit(0)
if (s.get("profile") != "production" or s.get("dry_run") is not False or s.get("auto_contain") is not False
        or s.get("armed") not in ("ARMED", "MONITOR_ONLY") or s.get("uplink") == "LOCKDOWN" or s.get("device") == "ONLINE"):
    print("STATUS_CONTAINMENT_INVALID"); sys.exit(0)
print("OK " + s["state"])
PYC
  ) || fail STATUS_UNREADABLE
  case "$status_out" in
    "OK "*) core_state=${status_out#OK } ;;
    *) fail "${status_out:-STATUS_UNREADABLE}" ;;
  esac

  # D4: the Core account itself must be able to load its credential (root would hide a permission problem)
  # Importing aegis_soc.local_restore is not side-effect-free (it imports aegis_soc.database, which creates a
  # RotatingFileHandler(config.LOG_PATH, ...) at module import time); outside systemd, AEGIS_LOG_PATH is unset and
  # config.LOG_PATH falls back to the relative "aegis_soc.log", so this probe would try to write a log file into
  # whatever directory verify.sh happens to run from. Pin its own logging to /dev/null.
  as_service env AEGIS_LOG_PATH=/dev/null "$SVC_PY" - "$SVC_CODE_ROOT" "$creds_dir/restore.credential" >/dev/null 2>&1 <<'PYC' || fail D4_CREDENTIAL_UNSAFE
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.local_restore import RestoreCredential
RestoreCredential.load(Path(sys.argv[2]))
PYC

  # ZERO actuation: read-only database access; the protocol store must hold no command at all
  data=$(host_path /var/lib/aegis-idea3/data)
  db_out=$("$PY" - "$data/core-audit.sqlite3" "$data/core-protocol.sqlite3" <<'PYC' 2>/dev/null
import os, sqlite3, sys
audit, proto = sys.argv[1], sys.argv[2]
def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True)
try:
    if not os.path.isfile(audit):
        raise sqlite3.Error("missing")
    n = ro(audit).execute("SELECT count(*) FROM audit_logs WHERE event_type IN ('CUT_UPLINK','RESTORE_UPLINK') "
                          "OR details LIKE '%CUT_UPLINK%' OR details LIKE '%RESTORE_UPLINK%'").fetchone()[0]
except Exception:
    print("AUDIT_DB_UNREADABLE"); sys.exit(0)
if n:
    print("ACTUATION_DETECTED"); sys.exit(0)
if not os.path.isfile(proto):
    print("PROTOCOL_DB_MISSING"); sys.exit(0)
try:
    m = ro(proto).execute("SELECT count(*) FROM protocol_commands").fetchone()[0]
except Exception:
    print("PROTOCOL_DB_UNREADABLE"); sys.exit(0)
print("ACTUATION_DETECTED" if m else "OK")
PYC
  ) || fail AUDIT_DB_UNREADABLE
  [ "$db_out" = OK ] || fail "${db_out:-AUDIT_DB_UNREADABLE}"

  # journal: no command and no secret (never printed)
  if [ -z "$ROOT" ]; then
    journal_text=$(journalctl -u "$UNIT" -o cat --no-pager 2>/dev/null || true)
  elif [ -n "$FIXTURE_JOURNAL" ] && [ -f "$FIXTURE_JOURNAL" ]; then
    journal_text=$(cat "$FIXTURE_JOURNAL")
  else
    journal_text=""
  fi
  ! grep -Eq 'CUT_UPLINK|RESTORE_UPLINK' <<< "$journal_text" || fail ACTUATION_IN_JOURNAL
  if [ -n "$INPUT" ] && [ -d "$INPUT" ]; then
    for f in "${CRED_FILES[@]}"; do
      [ -r "$INPUT/$f" ] || continue
      secret=$(head -n 1 "$INPUT/$f" | tr -d '\r\n')
      [ "${#secret}" -ge 6 ] || continue
      ! grep -qF -- "$secret" <<< "$journal_text" || fail JOURNAL_SECRET_LEAK
    done
  fi
fi

if use_ss; then
  l7_listener_snapshot "$(host_path /proc/sys/net/ipv4/ip_local_port_range)" ss_do -H -ltnu > "$WORK/listeners.current"
  [ -z "$(LC_ALL=C comm -13 "$WORK/listeners-baseline.txt" "$WORK/listeners.current")" ] || fail NEW_LISTENER
  [ -z "$(LC_ALL=C comm -23 "$WORK/listeners-baseline.txt" "$WORK/listeners.current")" ] || fail LISTENER_REMOVED
  new_listeners=NONE
  if use_systemd; then
    ss_do -H -tnp state established '( dport = :8883 )' 2>/dev/null | grep -F -- "$AP_ADDRESS:8883" | grep -q "pid=$pid," \
      || fail BROKER_CONNECTION_MISSING
    broker_connection=ESTABLISHED
  fi
fi

# ── non-secret validation evidence ───────────────────────────────────────────────────────────────────────────────────────
umask 077
{
  printf 'schema\t1\n'
  printf 'stage\tL7\n'
  printf 'result\tPASS\n'
  printf 'core_state\t%s\n' "$core_state"
  printf 'broker_connection\t%s\n' "$broker_connection"
  printf 'new_listeners\t%s\n' "$new_listeners"
  printf 'material_exact\tPASS\n'
  printf 'zero_actuation\tPASS\n'
  printf 'legacy_unchanged\tPASS\n'
} > "$WORK/validation-evidence.tsv"

printf 'L7_VERIFY=PASS\n'
printf 'L7_CORE_STATE=%s\n' "$core_state"
printf 'L7_MATERIAL_EXACT=PASS\n'
printf 'L7_ZERO_ACTUATION=PASS\n'
printf 'L7_NEW_LISTENERS=%s\n' "$new_listeners"
printf 'L7_BROKER_CONNECTION=%s\n' "$broker_connection"
printf 'L7_D4_CREDENTIAL=READABLE_BY_CORE_ACCOUNT\n'
printf 'LEGACY_UNCHANGED=PASS\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
