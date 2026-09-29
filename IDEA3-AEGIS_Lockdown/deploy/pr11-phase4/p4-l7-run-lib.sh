#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7 owner-run gate library (sourced by the external frozen owner runner; nothing here runs on its own and
# nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Reuses the L6b gates that are
# stage-independent (AP runtime, nft/PF-01, TrustedClock). Every function returns 0 on PASS; on FAIL it prints one `reason` line to
# stderr and returns 1. Commands are resolved from PATH so tests can stub them; SUDO defaults to `sudo` (tests set SUDO="").
# Read-only: only `systemctl show`, `ss`, `df`, `getent`, `id`, git reads, file tests and the read-only helper tools are issued.
# It never runs reset-failed or any other systemctl verb and never repairs a predecessor: a residual or missing prerequisite fails
# closed BEFORE the one-attempt authorization marker is consumed.

: "${SUDO=sudo}"
_L7_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l6b-run-lib.sh
. "$_L7_LIB_DIR/p4-l6b-run-lib.sh"

l7_reason() { printf '%s\n' "$1" >&2; return 1; }

# l7_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent; a second invocation for the same AUTH_DIR
# fails closed even if the first attempt failed. Distinct marker name from every other stage.
l7_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l7_reason "L7_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L7-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  l7_reason "L7_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# l7_receipt_gate REPO — predecessor ACCEPTANCE (L2..L5, L6a, L6b) proven by receipts read from the PINNED commit, never the working
# tree. Historical acceptance only; current runtime is gated separately. Refuses when L7 is already recorded as accepted.
l7_receipt_gate() {
  local repo=${1:-}
  l6b_receipt_gate "$repo" >/dev/null || return 1
  git -C "$repo" grep -qE "L6B_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l7_reason "L7_L6B_ACCEPTANCE_RECEIPT_MISSING"; return 1; }
  ! git -C "$repo" grep -qE "L7_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l7_reason "L7_ALREADY_ACCEPTED (L7 is recorded as proven; a new live attempt needs a new owner decision)"; return 1; }
}

# l7_release_gate REPO REL_LOGICAL EXPECTED_MAIN PY P4_DIR OWNER(root|any) [FS_ROOT] — the immutable release must ALREADY be installed:
# guard PASS (layout, no symlink, not writable, owner, checksums, manifest provenance), built from a commit on the pinned main, and
# `current` absent or already pointing at it. A missing release is a PREREQUISITE (a separate owner-supplied install step), never
# something L7 creates. Read-only.
l7_release_gate() {
  local repo=$1 rel=$2 main=$3 py=$4 p4=$5 owner=${6:-root} root=${7:-} host out sha current target
  host="$root$rel"
  # The real host's /opt/aegis-idea3 is root:root mode 0700: an unprivileged owner-run process cannot even traverse
  # into it. Existence/type must cross the SAME $SUDO privilege boundary as the release-guard invocation right below
  # -- never a bare unprivileged `test` -- or a genuinely installed release is wrongly reported as missing.
  $SUDO test -d "$host" && ! $SUDO test -L "$host" || { l7_reason "L7_RELEASE_NOT_INSTALLED_PREREQUISITE:$rel"; return 1; }
  out=$($SUDO "$py" "$p4/p4-l7-release-guard.py" check --logical-path "$rel" --host-path "$host" --expect-owner "$owner" 2>&1) \
    || { l7_reason "L7_RELEASE_GUARD_FAILED:$(sed -n 's/.*reason=//p' <<< "$out" | head -n 1)"; return 1; }
  sha=$(sed -n 's/.*source_git_sha=//p' <<< "$out" | head -n 1)
  git -C "$repo" merge-base --is-ancestor "$sha" "$main" 2>/dev/null || { l7_reason "L7_RELEASE_SOURCE_NOT_ON_MAIN:$sha"; return 1; }
  current="$root/opt/aegis-idea3/current"
  # Same privilege boundary: /opt/aegis-idea3/current sits under the same root-owned parent.
  if $SUDO test -L "$current"; then
    target=$($SUDO readlink "$current")
    [ "$target" = "$rel" ] || { l7_reason "L7_CURRENT_POINTER_MISMATCH"; return 1; }
  elif $SUDO test -e "$current"; then
    l7_reason "L7_CURRENT_POINTER_MISMATCH"
    return 1
  fi
  printf 'L7_RELEASE=%s SOURCE=%s\n' "${rel##*/}" "$sha"
}

# l7_core_prestate_gate UNIT [FS_ROOT] — the Core unit must be in the EXACT clean pre-attempt state BEFORE the authorization is
# consumed (not-found alone is not enough: failed metadata survives unit removal), no L7-owned path may pre-exist, the L6b CA and the
# pre-existing pki directory must be present (an existing pki CA must be identical), and the Core account must exist with its primary
# gid equal to its group's gid (supplementary groups are not judged). Read-only.
l7_core_prestate_gate() {
  local unit=${1:-} root=${2:-} out k want got group_gid user_gid
  [ -n "$unit" ] || { l7_reason "L7_CORE_PRESTATE_UNIT_REQUIRED"; return 1; }
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p Result -p MainPID -p NRestarts "$unit" 2>/dev/null) \
    || { l7_reason "L7_CORE_PRESTATE_UNREADABLE"; return 1; }
  got=$(awk -F= '$1 == "LoadState" { print $2 }' <<< "$out")
  [ "$got" = not-found ] || { l7_reason "L7_UNIT_ALREADY_LOADED:LoadState=$got"; return 1; }
  for want in ActiveState=inactive SubState=dead Result=success MainPID=0 NRestarts=0; do
    k=${want%%=*}
    got=$(awk -F= -v k="$k" '$1 == k { print $2 }' <<< "$out")
    [ "$got" = "${want#*=}" ] || { l7_reason "L7_RESIDUAL_FAILED_STATE_CLEANUP_REQUIRED=YES:$k=${got:-MISSING}"; return 1; }
  done
  [ ! -e "$root/etc/systemd/system/$unit" ] && [ ! -L "$root/etc/systemd/system/$unit" ] || { l7_reason "L7_UNIT_FILE_ALREADY_EXISTS"; return 1; }
  $SUDO test ! -e "$root/etc/aegis-idea3/core.env" || { l7_reason "L7_CORE_ENV_ALREADY_EXISTS"; return 1; }
  $SUDO test ! -e "$root/etc/aegis-idea3/credentials" || { l7_reason "L7_CREDENTIALS_DIR_ALREADY_EXISTS"; return 1; }
  $SUDO test ! -e "$root/run/aegis-idea3" || { l7_reason "L7_RUNTIME_DIR_ALREADY_EXISTS"; return 1; }
  $SUDO test -f "$root/etc/aegis-idea3/mqtt/ca.crt" || { l7_reason "L7_L6B_CA_MISSING"; return 1; }
  $SUDO test -d "$root/etc/aegis-idea3/pki" || { l7_reason "L7_PKI_DIR_MISSING"; return 1; }
  if $SUDO test -e "$root/etc/aegis-idea3/pki/mqtt-ca.crt"; then
    $SUDO cmp -s "$root/etc/aegis-idea3/mqtt/ca.crt" "$root/etc/aegis-idea3/pki/mqtt-ca.crt" || { l7_reason "L7_PKI_CA_CONFLICT"; return 1; }
  fi
  group_gid=$(getent group aegis-idea3 2>/dev/null | cut -d: -f3)
  [ -n "$group_gid" ] || { l7_reason "L7_CORE_IDENTITY_INVALID:GROUP_MISSING"; return 1; }
  getent passwd aegis-idea3 >/dev/null 2>&1 || { l7_reason "L7_CORE_IDENTITY_INVALID:USER_MISSING"; return 1; }
  user_gid=$(id -g aegis-idea3 2>/dev/null)
  [ -n "$user_gid" ] && [ "$user_gid" = "$group_gid" ] || { l7_reason "L7_CORE_IDENTITY_INVALID:PRIMARY_GID_MISMATCH"; return 1; }
}

# Bounded broker stability window: fixed constants assigned unconditionally at source time (never read from the environment, so an inherited variable cannot shorten or
# remove the observation). Prerequisite gate, not a soak test: 3 samples, 2 s apart.
L7_BROKER_STABILITY_SAMPLES=3
L7_BROKER_STABILITY_INTERVAL_S=2

# _l7_broker_sample UNIT AP_ADDR — one read-only sample. Prints "MainPID/NRestarts/InvocationID" on success; otherwise emits the
# reason on stderr (l7_reason, which returns 1). Historical NRestarts > 0 is allowed (the V5 recovery relies on systemd auto-restart).
_l7_broker_sample() {
  local unit=$1 ap=$2 out want k got pid nr inv listeners
  out=$(systemctl show -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts -p InvocationID "$unit" 2>/dev/null) \
    || { l7_reason "L7_BROKER_NOT_HEALTHY:UNREADABLE"; return 1; }
  for want in ActiveState=active SubState=running UnitFileState=enabled Result=success; do
    k=${want%%=*}
    got=$(awk -F= -v k="$k" '$1 == k { print $2 }' <<< "$out")
    [ "$got" = "${want#*=}" ] \
      || { l7_reason "PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES:L7_BROKER_NOT_HEALTHY:$k=${got:-MISSING}"; return 1; }
  done
  pid=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  nr=$(awk -F= '$1 == "NRestarts" { print $2 }' <<< "$out")
  inv=$(awk -F= '$1 == "InvocationID" { print $2 }' <<< "$out")
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 0 ] \
    || { l7_reason "L7_BROKER_NOT_HEALTHY:MainPID=${pid:-MISSING}"; return 1; }
  [[ "$nr" =~ ^[0-9]+$ ]] \
    || { l7_reason "L7_BROKER_NOT_HEALTHY:NRestarts=${nr:-MISSING}"; return 1; }
  [ -n "$inv" ] \
    || { l7_reason "L7_BROKER_NOT_HEALTHY:InvocationID=MISSING"; return 1; }
  listeners=$(ss -H -ltn "sport = :8883" | awk '{ print $4 }' | LC_ALL=C sort -u | paste -sd,)
  [ "$listeners" = "$ap:8883,127.0.0.1:8883" ] || [ "$listeners" = "127.0.0.1:8883,$ap:8883" ] \
    || { l7_reason "L7_BROKER_LISTENERS_INVALID"; return 1; }
  printf '%s/%s/%s' "$pid" "$nr" "$inv"
}

# l7_broker_runtime_gate UNIT AP_ADDR — the persistent L6b broker must be healthy NOW and stable across a bounded read-only window,
# listening on exactly loopback + AP 8883. A non-zero historical NRestarts is accepted; any change of MainPID/NRestarts/InvocationID,
# health or listener set between samples fails closed. L7 does not repair it (PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED is a
# separate owner action). Strictly read-only.
l7_broker_runtime_gate() {
  local unit=$1 ap=$2 i first cur
  first=$(_l7_broker_sample "$unit" "$ap") || return 1
  for ((i = 1; i < L7_BROKER_STABILITY_SAMPLES; i++)); do
    sleep "$L7_BROKER_STABILITY_INTERVAL_S"
    cur=$(_l7_broker_sample "$unit" "$ap") || return 1
    [ "$cur" = "$first" ] || { l7_reason "L7_BROKER_UNSTABLE:$first->$cur"; return 1; }
  done
}

# l7_disk_gate MAX_USED_PCT PATH... — design §6.9: at least 20% free (<= 80% used) on every named path.
l7_disk_gate() {
  local max=$1 p pct
  shift
  for p in "$@"; do
    pct=$(df -P "$p" 2>/dev/null | awk 'NR == 2 { sub("%", "", $5); print $5 }')
    [[ "$pct" =~ ^[0-9]+$ ]] || { l7_reason "L7_DISK_UNREADABLE:$p"; return 1; }
    [ "$pct" -le "$max" ] || { l7_reason "L7_DISK_HEADROOM:$p=$pct"; return 1; }
  done
}

# l7_idea2_s10_gate ENGINE_UNIT TUNNEL_UNIT — fresh IDEA2 §10 precondition: both IDEA2 units active/running. The owner-accepted
# window-delta criterion (unchanged MainPID/NRestarts over the L7 window) is proven separately by the PRE/POST comparison and the
# runner's before/after snapshot; this gate never touches IDEA2.
l7_idea2_s10_gate() {
  local u
  for u in "$@"; do
    [ "$(systemctl show -p ActiveState --value "$u" 2>/dev/null)" = active ] && [ "$(systemctl show -p SubState --value "$u" 2>/dev/null)" = running ] \
      || { l7_reason "L7_IDEA2_S10_NOT_PRESERVABLE:$u"; return 1; }
  done
}

# l7_d6_gate AUTH_FILE — the A-L7 record must carry the exact Pub / D6 notice line (the stage gate also enforces it).
l7_d6_gate() {
  [ -f "${1:-}" ] && grep -qx 'd6_notice=pub' "$1" || { l7_reason "L7_D6_NOTICE_MISSING"; return 1; }
}

# l7_input_gate INPUT_DIR PY REPO_ROOT — private JIT owner input contract. Contents are validated (Protocol keys via the Core's own
# loader, non-default PIN, non-empty MQTT password, D4 credential format) and NEVER printed.
l7_input_gate() {
  local dir=$1 py=$2 repo=$3 f pin pass
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l7_reason "L7_INPUT_DIR_INVALID"; return 1; }
  [ "$(stat -c %a "$dir")" = 700 ] || { l7_reason "L7_INPUT_DIR_MODE_NOT_0700"; return 1; }
  [ "$(stat -c %u "$dir")" = "$(id -u)" ] || { l7_reason "L7_INPUT_DIR_OWNER_MISMATCH"; return 1; }
  [ ! -e "$dir/ca.key" ] && [ ! -L "$dir/ca.key" ] || { l7_reason "L7_CA_PRIVATE_KEY_FORBIDDEN"; return 1; }
  [ "$(ls -A "$dir" | LC_ALL=C sort | paste -sd,)" = "admin.pin,k_c2d,k_d2c,mqtt-core.pass,restore.credential" ] \
    || { l7_reason "L7_INPUT_ENTRIES_NOT_EXACT"; return 1; }
  for f in admin.pin k_c2d k_d2c mqtt-core.pass restore.credential; do
    [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || { l7_reason "L7_INPUT_NOT_REGULAR:$f"; return 1; }
    case "$(stat -c %a "$dir/$f")" in 600 | 400) ;; *) l7_reason "L7_INPUT_SECRET_MODE_INVALID:$f"; return 1 ;; esac
  done
  "$py" - "$repo" "$dir/k_c2d" "$dir/k_d2c" >/dev/null 2>&1 <<'PYC' || { l7_reason "L7_PROTOCOL_KEY_INVALID"; return 1; }
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.protocol_v1 import load_protocol_keys
load_protocol_keys(Path(sys.argv[2]), Path(sys.argv[3]))
PYC
  pin=$(head -n 1 "$dir/admin.pin" | tr -d '\r\n')
  [ -n "$pin" ] && [ "$pin" != 1234 ] && ! [[ "$pin" =~ [[:space:]] ]] || { l7_reason "L7_ADMIN_PIN_INVALID"; return 1; }
  pass=$(head -n 1 "$dir/mqtt-core.pass" | tr -d '\r\n')
  [ -n "$pass" ] || { l7_reason "L7_MQTT_PASSWORD_EMPTY"; return 1; }
  [ "$(stat -c %s "$dir/restore.credential")" -le 4096 ] || { l7_reason "L7_RESTORE_CREDENTIAL_INVALID"; return 1; }
  # Importing aegis_soc.local_restore is not side-effect-free: it imports aegis_soc.database, whose module import
  # creates a RotatingFileHandler(config.LOG_PATH, ...) immediately. Outside the production systemd environment,
  # AEGIS_LOG_PATH is unset and config.LOG_PATH falls back to the relative "aegis_soc.log", so this read-only
  # pre-gate would try to write a log file into whatever directory it happens to run from. Pin its own logging to
  # /dev/null (same fix as the D4 probes in stages/L7/apply.sh and verify.sh).
  env AEGIS_LOG_PATH=/dev/null "$py" - "$repo" "$dir/restore.credential" >/dev/null 2>&1 <<'PYC' || { l7_reason "L7_RESTORE_CREDENTIAL_INVALID"; return 1; }
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from aegis_soc.local_restore import RestoreCredential
RestoreCredential.parse(Path(sys.argv[2]).read_text(encoding="ascii"))
PYC
}

# l7_tls_probe PY P4_DIR REPO_ROOT CA_FILE AP_ADDR SERVER_NAME — handshake-only proof (no credentials, no protocol bytes) that the Core's
# real TLS code path verifies the broker certificate by DNS name while connecting to the AP address. Runs through $SUDO because the L6b
# CA lives in a root:mosquitto 0750 directory.
l7_tls_probe() {
  local py=$1 p4=$2 repo=$3 ca=$4 addr=$5 name=$6 out
  out=$($SUDO "$py" "$p4/p4-l7-broker-probe.py" tls --repo-root "$repo" --ca-file "$ca" --address "$addr" --port 8883 --server-name "$name" 2>&1) \
    || { l7_reason "L7_BROKER_TLS_PROBE_FAILED:$(sed -n 's/.*reason=//p' <<< "$out" | head -n 1)"; return 1; }
  printf '%s\n' "$out"
}

# l7_secret_scan INPUT_DIR EVID_DIR PY — none of the five owner secrets (nor the restore credential hash, nor any private-key block)
# may appear anywhere in the evidence, including the rollback archive. Runs through $SUDO so root-owned captures are covered. Prints
# only counts, never values.
l7_secret_scan() {
  local inp=$1 evid=$2 py=$3
  $SUDO "$py" - "$inp" "$evid" <<'PYC'
import pathlib, re, sys
inp, ev = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
secrets = []
for name in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential"):
    for line in (inp / name).read_text().splitlines():
        line = line.strip()
        if len(line) >= 6:
            secrets.append(line.encode())
pem = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
scrypt = re.compile(rb"scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{32,}")
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    data = f.read_bytes()
    if any(s in data for s in secrets) or pem.search(data) or scrypt.search(data):
        bad += 1
print(f"SECRET_SCAN_FILES={scanned} SECRET_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}
