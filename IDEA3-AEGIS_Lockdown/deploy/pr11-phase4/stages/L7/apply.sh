#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7 Core credential delivery + Core start apply handler (OD-L7-01..08, 2026-09-27 amendments).
# MUTATING in live mode. The stage OWNS: /etc/aegis-idea3/credentials (+5 credential files), /etc/aegis-idea3/core.env, the Core CA copy
# /etc/aegis-idea3/pki/mqtt-ca.crt (only if absent), /etc/systemd/system/aegis-idea3-core.service, the /opt/aegis-idea3/current pointer
# (only if absent) and the enabled+started Core unit. Every Production path is written to $WORK/journal.tsv BEFORE it is created, so
# rollback.sh acts on exactly that set. It never generates secrets (K_C2D/K_D2C/PIN/passwords are owner-supplied JIT input), never
# publishes to MQTT (zero CUT_UPLINK/RESTORE_UPLINK), never touches legacy mosquitto, the L6b broker, NetworkManager, nftables or IDEA1/2.
# Ownership model: credentials dir root:aegis-idea3 0750 (the Core reads restore.credential itself); k_c2d/k_d2c/mqtt-core.pass/admin.pin
# root:root 0600 (systemd LoadCredential= reads them as root); restore.credential aegis-idea3:aegis-idea3 0600 (RestoreCredential.load
# requires the Core account as owner); core.env root:aegis-idea3 0640 (no secrets); CA copy and unit root:root 0644.
set -uo pipefail

UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
CORE_ACCOUNT=aegis-idea3
DEVICE_ID=aegis-relay-01           # pinned Production device identity (same as L6b)
TLS_SERVER_NAME=mqtt.aegis.home.arpa
CREDS_DIR=/etc/aegis-idea3/credentials
CORE_ENV=/etc/aegis-idea3/core.env
PKI_DIR=/etc/aegis-idea3/pki
PKI_CA=/etc/aegis-idea3/pki/mqtt-ca.crt
L6B_MQTT_DIR=/etc/aegis-idea3/mqtt
L6B_CA=/etc/aegis-idea3/mqtt/ca.crt
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CURRENT=/opt/aegis-idea3/current
IDEA3_ETC=/etc/aegis-idea3
LEGACY_DIR=/etc/mosquitto
RUNTIME_DIRS=(/var/lib/aegis-idea3 /var/log/aegis-idea3 /run/aegis-idea3)
CRED_FILES=(k_c2d k_d2c mqtt-core.pass admin.pin restore.credential)

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$P4_HERE/../.." && pwd)"
# shellcheck source=l7-listener-lib.sh
source "$HERE/l7-listener-lib.sh"
UNIT_SOURCE="$REPO_ROOT/deploy/aegis-idea3-core.service.example"
ENV_EXAMPLE="$REPO_ROOT/deploy/aegis-idea3-core.env.example"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seams, honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real tools and the real accounts.
FIXTURE_SYSTEMCTL="${AEGIS_L7_FIXTURE_SYSTEMCTL:-}"
FIXTURE_ANALYZE="${AEGIS_L7_FIXTURE_SYSTEMD_ANALYZE:-}"
FIXTURE_SS="${AEGIS_L7_FIXTURE_SS:-}"
FIXTURE_GROUP="${AEGIS_L7_FIXTURE_SERVICE_GROUP:-}"
WORK="${AEGIS_L7_WORK_DIR:-}"
INPUT="${AEGIS_L7_INPUT_DIR:-}"
RELEASE_DIR="${AEGIS_L7_RELEASE_DIR:-}"
AP_ADDRESS="${AEGIS_AP_ADDRESS:-}"
JOURNAL=""

fail() {
  printf 'L7_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

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
# as_service: run a read-only probe as the Core account (live) so permission problems that root would hide are caught.
as_service() {
  if [ -z "$ROOT" ]; then runuser -u "$CORE_ACCOUNT" -- "$@"; else "$@"; fi
}

valid_ipv4() {
  /usr/bin/python3 - "$1" <<'PY'
import ipaddress, sys
try:
    a = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if a.version == 4 and not (a.is_unspecified or a.is_multicast or a.is_loopback) else 1)
PY
}

# core_identity_check: read-only. The Core account and its group must exist and the account's PRIMARY gid must equal the group's gid.
# Supplementary groups are deliberately not judged, and no account or group is ever created or modified here.
core_identity_check() {
  local group_gid user_gid
  group_gid=$(getent group "$CORE_ACCOUNT" | cut -d: -f3)
  [ -n "$group_gid" ] || fail CORE_GROUP_MISSING
  getent passwd "$CORE_ACCOUNT" >/dev/null || fail CORE_USER_MISSING
  user_gid=$(id -g "$CORE_ACCOUNT" 2>/dev/null)
  [ -n "$user_gid" ] && [ "$user_gid" = "$group_gid" ] || fail CORE_USER_PRIMARY_GID_MISMATCH
}

snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"
  else
    : > "$out"
  fi
}

journal() { printf '%s\t%s\n' "$1" "$2" >> "$JOURNAL" || fail JOURNAL_WRITE_FAILED; }
plan() { printf '%s\t%s\troot:%s\n' "$1" "$2" "$3" >> "$WORK/ownership-plan.tsv" || fail OWNERSHIP_PLAN_WRITE_FAILED; }
plan_owner() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$WORK/ownership-plan.tsv" || fail OWNERSHIP_PLAN_WRITE_FAILED; }

# install_owned MODE SRC LOGICAL_DEST OWNER GROUP: journal, then install. Never group- or world-writable.
install_owned() {
  local mode=$1 src=$2 logical=$3 owner=$4 group=$5 dest
  dest=$(host_path "$logical")
  journal FILE "$logical"
  plan_owner "$logical" "${mode#0}" "$owner:$group"
  if [ -z "$ROOT" ]; then
    install -m "$mode" -o "$owner" -g "$group" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  elif [ "$group" != root ] && [ -n "$FIXTURE_GROUP" ]; then
    install -m "$mode" -g "$FIXTURE_GROUP" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  else
    install -m "$mode" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  fi
}

# ── 1. environment ───────────────────────────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_L7_WORK_DIR_REQUIRED
[ -n "$INPUT" ] || fail AEGIS_L7_INPUT_DIR_REQUIRED
[ -n "$RELEASE_DIR" ] || fail AEGIS_L7_RELEASE_DIR_REQUIRED
[ -n "$AP_ADDRESS" ] || fail AEGIS_AP_ADDRESS_REQUIRED
valid_ipv4 "$AP_ADDRESS" || fail AEGIS_AP_ADDRESS_INVALID

if [ -z "$ROOT" ]; then
  [ "${AEGIS_L7_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi

case "$WORK" in
  /etc/*) fail WORK_DIR_INSIDE_ETC ;;
esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

# ── 2. work dir + journal first, so any later failure is rollback-able ───────────────────────────────────────────────────
umask 077
mkdir -p "$WORK" || fail WORK_DIR_CREATE_FAILED
chmod 700 "$WORK"
JOURNAL="$WORK/journal.tsv"
: > "$JOURNAL"
chmod 600 "$JOURNAL"

# ── 3. private owner input contract (never prints contents) ──────────────────────────────────────────────────────────────
[ -d "$INPUT" ] && [ ! -L "$INPUT" ] || fail INPUT_DIR_INVALID
[ "$(stat -c '%a' "$INPUT")" = 700 ] || fail INPUT_DIR_MODE_NOT_0700
expect_uid="${SUDO_UID:-$(id -u)}"
[ "$(stat -c '%u' "$INPUT")" = "$expect_uid" ] || fail INPUT_DIR_OWNER_MISMATCH
[ ! -e "$INPUT/ca.key" ] && [ ! -L "$INPUT/ca.key" ] || fail CA_PRIVATE_KEY_FORBIDDEN
[ "$(ls -A "$INPUT" | LC_ALL=C sort | paste -sd,)" = "admin.pin,k_c2d,k_d2c,mqtt-core.pass,restore.credential" ] \
  || fail INPUT_DIR_ENTRIES_NOT_EXACT
for f in "${CRED_FILES[@]}"; do
  [ -f "$INPUT/$f" ] && [ ! -L "$INPUT/$f" ] || fail "INPUT_FILE_NOT_REGULAR:${f}"
done
for f in "${CRED_FILES[@]}"; do
  case "$(stat -c '%a' "$INPUT/$f")" in 600 | 400) ;; *) fail "INPUT_SECRET_MODE_INVALID:${f}" ;; esac
done

# Protocol keys (OD-L7-02): the Core's own loader is the single source of truth (64 lowercase hex, non-zero, independent, not a known
# test key). Its output is discarded so a rejected key is never echoed.
"$PY" - "$REPO_ROOT" "$INPUT/k_c2d" "$INPUT/k_d2c" >/dev/null 2>&1 <<'PYC' || fail PROTOCOL_KEY_INVALID
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.protocol_v1 import load_protocol_keys
load_protocol_keys(Path(sys.argv[2]), Path(sys.argv[3]))
PYC

# Admin PIN and MQTT password (OD-L7-04)
admin_pin=$(head -n 1 "$INPUT/admin.pin" | tr -d '\r\n')
[ -n "$admin_pin" ] && [ "$admin_pin" != "1234" ] && ! [[ "$admin_pin" =~ [[:space:]] ]] || fail ADMIN_PIN_INVALID
mqtt_pass=$(head -n 1 "$INPUT/mqtt-core.pass" | tr -d '\r\n')
[ -n "$mqtt_pass" ] || fail MQTT_PASSWORD_EMPTY

# D4 restore credential (OD-L7-08): FORMAT only here. load() also demands mode 0600 and owner == the running account, which is
# meaningless for a root-run staging step; the staged copy is proven readable by the Core account below.
[ "$(stat -c '%s' "$INPUT/restore.credential")" -le 4096 ] || fail RESTORE_CREDENTIAL_INVALID
# Importing aegis_soc.local_restore is not side-effect-free: it imports aegis_soc.database, whose module import
# creates a RotatingFileHandler(config.LOG_PATH, ...) immediately. Outside the production systemd environment,
# AEGIS_LOG_PATH is unset and config.LOG_PATH falls back to the relative "aegis_soc.log", so this probe would try
# to write a log file into whatever directory apply.sh happens to run from -- and fail closed with a masked
# reason if that directory isn't writable. Point the probe's own logging at /dev/null; it never touches the
# credential check itself.
env AEGIS_LOG_PATH=/dev/null "$PY" - "$REPO_ROOT" "$INPUT/restore.credential" >/dev/null 2>&1 <<'PYC' || fail RESTORE_CREDENTIAL_INVALID
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.local_restore import RestoreCredential
RestoreCredential.parse(Path(sys.argv[2]).read_text(encoding="ascii"))
PYC

# ── 4. host paths, immutable release guard, pre-state, predecessor baselines (all before the first mutation) ────────────────
creds_dir=$(host_path "$CREDS_DIR")
core_env=$(host_path "$CORE_ENV")
pki_dir=$(host_path "$PKI_DIR")
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

[ -z "$ROOT" ] && core_identity_check

owner_expect=any
[ -z "$ROOT" ] && owner_expect=root
guard_out=$("$PY" "$P4_HERE/p4-l7-release-guard.py" check --logical-path "$RELEASE_DIR" --host-path "$rel_host" --expect-owner "$owner_expect" 2>&1) \
  || fail "RELEASE_GUARD_FAILED:$(sed -n 's/.*reason=//p' <<< "$guard_out" | head -n 1)"

[ -d "$(host_path "$IDEA3_ETC")" ] && [ ! -L "$(host_path "$IDEA3_ETC")" ] || fail IDEA3_ETC_MISSING_OR_SYMLINK
for p in "$creds_dir" "$core_env" "$unit_dest"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "PRESTATE_UNEXPECTED:${p}"
done
current_owned=1
if [ -L "$current" ]; then
  [ "$(readlink "$current")" = "$RELEASE_DIR" ] || fail RELEASE_POINTER_MISMATCH
  current_owned=0
elif [ -e "$current" ]; then
  fail "PRESTATE_UNEXPECTED:${current}"
fi

[ -f "$UNIT_SOURCE" ] && [ ! -L "$UNIT_SOURCE" ] || fail UNIT_SOURCE_INVALID
[ -f "$ENV_EXAMPLE" ] && [ ! -L "$ENV_EXAMPLE" ] || fail CORE_ENV_EXAMPLE_INVALID
[ -f "$l6b_ca" ] && [ ! -L "$l6b_ca" ] || fail L6B_CA_MISSING
openssl x509 -in "$l6b_ca" -noout >/dev/null 2>&1 || fail L6B_CA_INVALID
[ -d "$pki_dir" ] && [ ! -L "$pki_dir" ] || fail PKI_DIR_MISSING
pki_ca_owned=1
if [ -e "$pki_ca" ] || [ -L "$pki_ca" ]; then
  [ -f "$pki_ca" ] && [ ! -L "$pki_ca" ] && cmp -s "$l6b_ca" "$pki_ca" || fail PKI_CA_CONFLICT
  pki_ca_owned=0
fi
[ -d "$legacy_dir" ] && [ ! -L "$legacy_dir" ] || fail LEGACY_CONFIG_TREE_INVALID

if use_systemd; then
  pre=$(sysctl_do show -p LoadState -p ActiveState -p SubState -p Result -p MainPID -p NRestarts "$UNIT" 2>/dev/null) || fail CORE_UNIT_STATE_UNREADABLE
  [ "$(awk -F= '$1 == "LoadState" { print $2 }' <<< "$pre")" = not-found ] || fail CORE_UNIT_ALREADY_LOADED
  [ "$(LC_ALL=C sort <<< "$pre" | paste -sd,)" = "ActiveState=inactive,LoadState=not-found,MainPID=0,NRestarts=0,Result=success,SubState=dead" ] \
    || fail CORE_UNIT_STATE_NOT_CLEAN
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" > "$WORK/legacy-service.txt" || fail PREDECESSOR_SERVICE_SNAPSHOT_FAILED
fi
if use_ss; then
  l7_listener_snapshot "$(host_path /proc/sys/net/ipv4/ip_local_port_range)" ss_do -H -ltnu > "$WORK/listeners-baseline.txt"
else
  : > "$WORK/listeners-baseline.txt"
fi
snapshot_tree "$legacy_dir" "$WORK/legacy-tree.sha256"
# L6b broker material is snapshotted by metadata only (never content or digests of secrets); the public CA also by digest.
{
  (cd "$l6b_dir" && find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 -r stat -c '%n %a %U:%G %s %Y')
  printf 'ca.crt.sha256 %s\n' "$(sha256sum -- "$l6b_ca" | cut -d' ' -f1)"
} > "$WORK/l6b-material.txt"
printf '%s\n' "$RELEASE_DIR" > "$WORK/release-dir.txt"

# ── 5. render + validate core.env (no secret ever enters it) ─────────────────────────────────────────────────────────────
mkdir -m 700 "$WORK/render" || fail RENDER_DIR_CREATE_FAILED
"$PY" "$P4_HERE/p4-l7-core-env.py" render --example "$ENV_EXAMPLE" --ap-address "$AP_ADDRESS" --device-id "$DEVICE_ID" \
  --server-name "$TLS_SERVER_NAME" --output "$WORK/render/core.env" >/dev/null || fail CORE_ENV_RENDER_FAILED
"$PY" "$P4_HERE/p4-l7-core-env.py" check --file "$WORK/render/core.env" --ap-address "$AP_ADDRESS" --device-id "$DEVICE_ID" \
  --server-name "$TLS_SERVER_NAME" >/dev/null || fail CORE_ENV_RENDER_FAILED

# ── 6. first Production mutation: stage-owned installation, journaled before every create ────────────────────────────────
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
printf 'YES\n' > "$WORK/production-mutation"
printf 'path\tmode\towner\n' > "$WORK/ownership-plan.tsv" || fail OWNERSHIP_PLAN_WRITE_FAILED

journal DIR "$CREDS_DIR"
plan_owner "$CREDS_DIR" 750 "root:$CORE_ACCOUNT"
if [ -z "$ROOT" ]; then
  install -d -m 0750 -o root -g "$CORE_ACCOUNT" -- "$creds_dir" || fail CREDENTIALS_DIR_CREATE_FAILED
elif [ -n "$FIXTURE_GROUP" ]; then
  install -d -m 0750 -g "$FIXTURE_GROUP" -- "$creds_dir" || fail CREDENTIALS_DIR_CREATE_FAILED
else
  install -d -m 0750 -- "$creds_dir" || fail CREDENTIALS_DIR_CREATE_FAILED
fi
for f in k_c2d k_d2c mqtt-core.pass admin.pin; do
  install_owned 0600 "$INPUT/$f" "$CREDS_DIR/$f" root root
done
install_owned 0600 "$INPUT/restore.credential" "$CREDS_DIR/restore.credential" "$CORE_ACCOUNT" "$CORE_ACCOUNT"
install_owned 0640 "$WORK/render/core.env" "$CORE_ENV" root "$CORE_ACCOUNT"
if [ "$pki_ca_owned" = 1 ]; then
  install_owned 0644 "$l6b_ca" "$PKI_CA" root root
fi
if [ "$current_owned" = 1 ]; then
  journal LINK "$CURRENT"
  ln -s "$RELEASE_DIR" "$current" || fail CURRENT_LINK_CREATE_FAILED
fi

# what the Core account itself must be able to read (the service reads these directly; systemd reads the others as root)
# Same import-side-effect hazard as the RESTORE_CREDENTIAL_INVALID probe above (see that comment): pin this probe's
# own logging to /dev/null so it can never attempt a relative aegis_soc.log write as the Core account.
as_service env AEGIS_LOG_PATH=/dev/null "$SVC_PY" - "$SVC_CODE_ROOT" "$creds_dir/restore.credential" >/dev/null 2>&1 <<'PYC' || fail D4_CREDENTIAL_UNSAFE
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.local_restore import RestoreCredential
RestoreCredential.load(Path(sys.argv[2]))
PYC
as_service test -r "$pki_ca" || fail CORE_CA_NOT_READABLE

# runtime directories are created by systemd (StateDirectory/LogsDirectory/RuntimeDirectory), never by this handler; record which
# ones do not exist yet so rollback may archive+remove exactly those.
for d in "${RUNTIME_DIRS[@]}"; do
  [ -e "$(host_path "$d")" ] || journal RUNTIME "$d"
done

journal UNIT "$UNIT_DEST"
if [ -z "$ROOT" ]; then
  install -D -m 0644 -o root -g root -- "$UNIT_SOURCE" "$unit_dest" || fail UNIT_INSTALL_FAILED
else
  mkdir -p "$(dirname "$unit_dest")"
  install -m 0644 -- "$UNIT_SOURCE" "$unit_dest" || fail UNIT_INSTALL_FAILED
fi
plan "$UNIT_DEST" 644 root
if [ -z "$ROOT" ]; then
  systemd-analyze verify "$unit_dest" >/dev/null 2>&1 || fail UNIT_VERIFY_FAILED
elif [ -n "$FIXTURE_ANALYZE" ]; then
  "$FIXTURE_ANALYZE" verify "$unit_dest" >/dev/null 2>&1 || fail UNIT_VERIFY_FAILED
fi

if use_systemd; then
  journal SERVICE "$UNIT"
  sysctl_do daemon-reload || fail DAEMON_RELOAD_FAILED
  sysctl_do enable --now "$UNIT" || fail CORE_SERVICE_START_FAILED
  # Type=simple + Restart=on-failure can hide a crash loop from one is-active probe; wait, then require active and zero restarts.
  sleep "${AEGIS_L7_STABLE_WAIT_SEC:-3}"
  sysctl_do is-active --quiet "$UNIT" || fail CORE_SERVICE_NOT_STABLE
  [ "$(sysctl_do show -p NRestarts --value "$UNIT")" = 0 ] || fail CORE_SERVICE_NOT_STABLE
fi

# ── 7. non-secret apply manifest (digests only for non-secret material) ─────────────────────────────────────────────────
{
  printf 'path\tmode\towner\tsize\tsha256\n'
  for logical in "$CORE_ENV" "$PKI_CA" "$UNIT_DEST" "$CREDS_DIR/k_c2d" "$CREDS_DIR/k_d2c" "$CREDS_DIR/mqtt-core.pass" "$CREDS_DIR/admin.pin" \
    "$CREDS_DIR/restore.credential"; do
    real=$(host_path "$logical")
    case "$logical" in
      "$CORE_ENV" | "$PKI_CA" | "$UNIT_DEST") digest=$(sha256sum -- "$real" | cut -d' ' -f1) ;;
      *) digest=SECRET_NOT_RECORDED ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\n' "$logical" "$(stat -c '%a' "$real")" "$(stat -c '%U:%G' "$real")" "$(stat -c '%s' "$real")" "$digest"
  done
} > "$WORK/apply-manifest.tsv"

printf 'L7_APPLY=PASS\n'
printf 'L7_SECRETS_PRINTED=NO\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
