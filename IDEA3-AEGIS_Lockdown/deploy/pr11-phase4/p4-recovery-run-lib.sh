#!/usr/bin/env bash
# AEGIS IDEA3 Phase 4 — the one governed Recovery R2-R8 owner-run library.
# Core owns all Recovery mutations and evidence. The owner runner owns only
# authorization, captures, and the interactive D4 command. It never receives a
# RESTORE secret and never calls SQLite, MQTT, nft, or an attacker-supplied
# target directly.
set -uo pipefail

: "${SUDO:=sudo}"
RECOVERY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$RECOVERY_LIB_DIR/p4-f1u-run-lib.sh"
# Reuse the existing, reviewed predecessor gate; do not duplicate it here.
. "$RECOVERY_LIB_DIR/p4-r1bv-run-lib.sh"

recovery_reason() { printf '%s\n' "$1" >&2; return 1; }
recovery_commit_gate() { r1bv_commit_gate "$@"; }
recovery_predecessor_gate() { r1bv_recovery_predecessor_gate "$@"; }

recovery_marker_unconsumed() {
  local marker=${1:-}
  [ -n "$marker" ] && [[ "$marker" == /* ]] && [[ "$marker" != *..* ]] || { recovery_reason RECOVERY_ATTEMPT_MARKER_PATH_INVALID; return 1; }
  [ ! -e "$marker" ] && [ ! -L "$marker" ] || { recovery_reason RECOVERY_ATTEMPT_ALREADY_CONSUMED; return 1; }
}

# Exclusive marker, immediately before ISOLATE. It is never removed or rewritten.
recovery_consume_attempt() {
  local marker=${1:-} parent
  recovery_marker_unconsumed "$marker" || return 1
  parent=$(dirname -- "$marker")
  [ -d "$parent" ] && [ ! -L "$parent" ] || { recovery_reason RECOVERY_ATTEMPT_MARKER_PARENT_INVALID; return 1; }
  ( set -o noclobber; umask 077; printf 'RECOVERY_ATTEMPT_CONSUMED=YES\nRECOVERY_ATTEMPT_RETRY=NEVER\n' > "$marker" ) 2>/dev/null || { recovery_reason RECOVERY_ATTEMPT_ALREADY_CONSUMED; return 1; }
  printf 'RECOVERY_ATTEMPT_CONSUMED=YES\n'
}

recovery_sudo_noninteractive_gate() {
  [ -z "$SUDO" ] || ${SUDO%% *} -n true 2>/dev/null || { recovery_reason RECOVERY_SUDO_CREDENTIAL_NOT_ACTIVE; return 1; }
}

recovery_normal_restore_boundary() {
  # The owner enters the secret interactively in aegisctl. This wrapper passes
  # no secret and only records the resulting exit code in the stage driver.
  [ "${RECOVERY_RESTORE_MODE:-NORMAL}" = NORMAL ] || { recovery_reason RECOVERY_NORMAL_RESTORE_REQUIRED; return 1; }
  [ "${RECOVERY_RESTORE_CONFIRMATION:-}" = 'RESTORE UPLINK' ] || { recovery_reason RECOVERY_CONFIRMATION_REQUIRED; return 1; }
  command -v aegisctl >/dev/null 2>&1 || { recovery_reason RECOVERY_AEGISCTL_MISSING; return 1; }
  aegisctl restore
}

recovery_no_live_claims() {
  cat <<'EOF'
RECOVERY_REPOSITORY_IMPLEMENTED=YES
RECOVERY_LIVE_EXECUTED=NO
RECOVERY_R2_R8_EXECUTED=NO
R1B_RESULT=FAIL_IMMUTABLE
R1BV_RESULT=PASS
LVR_PROVEN=NO
L8_ACCEPTANCE=NO
L9_PROVEN=NO
EOF
}
