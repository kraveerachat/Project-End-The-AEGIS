#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7u (post-L7 Recovery Core upgrade) owner-run gate library (sourced by the external frozen owner runner; nothing
# here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories. Every
# function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub
# them; SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only `systemctl show`, git reads and `id` are issued here.
# L7u owns its OWN one-attempt marker, receipt gate and authorization records; it reuses the stage-independent L6b/L7 gates (disk headroom,
# IDEA2 §10 precondition) instead of copying them. L7u never adds recovery_authorization (an L8-only gate) and never authorizes L8.

: "${SUDO=sudo}"
_L7U_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l7-run-lib.sh
. "$_L7U_LIB_DIR/p4-l7-run-lib.sh"

l7u_reason() { printf '%s\n' "$1" >&2; return 1; }

# l7u_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one L7u attempt.
l7u_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l7u_reason "L7U_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/L7u-ATTEMPT-CONSUMED" ] || { l7u_reason "L7U_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# l7u_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent; a second invocation for the same AUTH_DIR fails
# closed even if the first attempt failed. The marker name is distinct from every other stage, so no old marker ever authorizes L7u.
l7u_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l7u_reason "L7U_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L7u-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  l7u_reason "L7U_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# l7u_receipt_gate REPO — predecessor ACCEPTANCE (L2..L5, L6a) plus the current L7 acceptance, proven by receipts read from the PINNED commit,
# never the working tree. Refuses when L7u itself is already recorded as accepted (one-shot). Historical acceptance only; current runtime is
# gated separately.
l7u_receipt_gate() {
  local repo=${1:-}
  l6b_receipt_gate "$repo" >/dev/null || return 1
  git -C "$repo" grep -qE "L7_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l7u_reason "L7U_L7_ACCEPTANCE_RECEIPT_MISSING"; return 1; }
  ! git -C "$repo" grep -qE "L7U_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l7u_reason "L7U_ALREADY_ACCEPTED (L7u is recorded as proven; a new live attempt needs a new owner decision)"; return 1; }
}

# l7u_core_running_gate UNIT — the OLD Core must be in the exact running baseline NOW: loaded, active/running, enabled, Result=success,
# NRestarts=0, a real MainPID. Read-only (systemctl show only); never repairs anything.
l7u_core_running_gate() {
  local unit=${1:-} out k want got
  [ -n "$unit" ] || { l7u_reason "L7U_CORE_UNIT_REQUIRED"; return 1; }
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p NRestarts -p MainPID "$unit" 2>/dev/null) \
    || { l7u_reason "L7U_CORE_NOT_RUNNING_BASELINE:UNREADABLE"; return 1; }
  for want in LoadState=loaded ActiveState=active SubState=running UnitFileState=enabled Result=success NRestarts=0; do
    k=${want%%=*}
    got=$(awk -F= -v k="$k" '$1 == k { print $2 }' <<< "$out")
    [ "$got" = "${want#*=}" ] || { l7u_reason "L7U_CORE_NOT_RUNNING_BASELINE:$k=${got:-MISSING}"; return 1; }
  done
  got=$(awk -F= '$1 == "MainPID" { print $2 }' <<< "$out")
  [[ "$got" =~ ^[1-9][0-9]*$ ]] || { l7u_reason "L7U_CORE_NOT_RUNNING_BASELINE:MainPID=${got:-MISSING}"; return 1; }
}

# l7u_identity_gate OPERATOR_USER OPERATOR_UID — the runner is invoked by exactly the frozen operator identity (the SO_PEERCRED authority).
l7u_identity_gate() {
  local user=${1:-} uid=${2:-}
  [ -n "$user" ] && [[ "$uid" =~ ^[1-9][0-9]*$ ]] || { l7u_reason "L7U_OPERATOR_IDENTITY_INVALID"; return 1; }
  [ "$(id -un)" = "$user" ] && [ "$(id -u)" = "$uid" ] || { l7u_reason "L7U_OPERATOR_IDENTITY_MISMATCH"; return 1; }
  [ "$(id -un "$user" 2>/dev/null)" = "$user" ] && [ "$(id -u "$user" 2>/dev/null)" = "$uid" ] || { l7u_reason "L7U_OPERATOR_IDENTITY_MISMATCH"; return 1; }
}

# l7u_alert_identity_gate ACCOUNT UID CORE_ACCOUNT OPERATOR_UID — OD-F1-DEPLOY-01: the frozen alert source uid is exactly the uid of the dedicated
# account (exact name, never an input), non-root, not the Core account's uid and not the operator's. Read-only (`id` only). The account itself is
# an owner precondition: this gate VERIFIES it and never creates it.
l7u_alert_identity_gate() {
  local account=${1:-} uid=${2:-} core=${3:-} operator_uid=${4:-} core_uid
  [ "$account" = "aegis-idea3-detector" ] || { l7u_reason "L7U_ALERT_ACCOUNT_NAME_INVALID"; return 1; }
  [[ "$uid" =~ ^[1-9][0-9]{0,9}$ ]] || { l7u_reason "L7U_ALERT_SOURCE_UID_INVALID"; return 1; }
  [ "$(id -u "$account" 2>/dev/null)" = "$uid" ] || { l7u_reason "L7U_ALERT_ACCOUNT_UID_MISMATCH"; return 1; }
  core_uid=$(id -u "$core" 2>/dev/null) || { l7u_reason "L7U_CORE_ACCOUNT_UNRESOLVED"; return 1; }
  [ "$uid" != "$core_uid" ] || { l7u_reason "L7U_ALERT_SOURCE_IS_CORE_ACCOUNT"; return 1; }
  [ "$uid" != "$operator_uid" ] || { l7u_reason "L7U_ALERT_SOURCE_IS_OPERATOR"; return 1; }
}

# l7u_secret_scan EVID_DIR PY — none of the evidence may contain a private-key block, a password hash, or any secret-bearing core.env key.
# L7u handles no owner secret of its own; this is the generic evidence scan. Prints only counts, never values.
l7u_secret_scan() {
  local evid=$1 py=$2
  $SUDO "$py" - "$evid" <<'PYC'
import pathlib, re, sys
ev = pathlib.Path(sys.argv[1])
pem = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
scrypt = re.compile(rb"scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{32,}")
keys = re.compile(rb"^(AEGIS_MQTT_PASS|AEGIS_ADMIN_PIN|AEGIS_TG_TOKEN|AEGIS_P1_C2D_KEY_FILE|AEGIS_P1_D2C_KEY_FILE)=", re.M)
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    data = f.read_bytes()
    if pem.search(data) or scrypt.search(data) or keys.search(data):
        bad += 1
print(f"SECRET_SCAN_FILES={scanned} SECRET_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}
