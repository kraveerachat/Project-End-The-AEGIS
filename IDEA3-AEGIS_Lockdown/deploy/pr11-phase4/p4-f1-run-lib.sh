#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1 (governed F1 detector unit install + ONE start) owner-run gate library (sourced by the external frozen owner runner;
# nothing here runs on its own and nothing here mutates the host). Pure gate logic so it can be tested with stubs and fixture repositories.
# Every function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them;
# SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file stats, `systemctl show`, `pgrep`, and root READS of core.env and /proc.
# F1 owns its OWN one-attempt marker (F1-ATTEMPT-CONSUMED), receipt gate and authorization records (stage=F1, no extra field); it reuses the L8p/L7u gates
# (receipt-field lookup, Core running baseline, alert identity, evidence secret scan) instead of copying them. It never restarts the Core, never edits
# core.env/users/groups, never enables the unit and never claims real detector acceptance, Recovery R1-R8, LVR, L8 or L9.

: "${SUDO=sudo}"
_F1_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l8p-run-lib.sh
. "$_F1_LIB_DIR/p4-l8p-run-lib.sh"

F1_L8P_CLOSEOUT_RECEIPT_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"
F1_DETECTOR_UNIT=aegis-idea3-detector.service
F1_DETECTOR_ACCOUNT=aegis-idea3-detector
F1_CORE_ENV=/etc/aegis-idea3/core.env
F1_ALERT_DIR=/run/aegis-idea3-alert
F1_ALERT_SOCK=/run/aegis-idea3-alert/alert.sock

f1_reason() { printf '%s\n' "$1" >&2; return 1; }

# f1_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one F1 attempt.
f1_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1_reason "F1_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/F1-ATTEMPT-CONSUMED" ] || { f1_reason "F1_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# f1_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR fails
# closed even if the first attempt failed. The marker name is distinct from every other stage, so no other stage's marker ever authorizes F1.
f1_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { f1_reason "F1_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/F1-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  f1_reason "F1_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# f1_receipt_gate REPO — F1 is allowed only AFTER L8p is closed and only while F1 itself is not yet recorded, proven by receipts read from the PINNED commit,
# never the working tree. L8p: exactly ONE receipt carries BOTH whole-line fields L8P_LIVE_EXECUTED=YES and L8P_PROVISIONING=PASS, and it is the canonical
# L8p closeout receipt. F1: refuses when one receipt already carries BOTH F1_PRODUCTION_DEPLOYED=YES and F1_DETECTOR_STARTED=YES (one-shot).
f1_receipt_gate() {
  local repo=${1:-} both
  [ -n "$repo" ] || { f1_reason "F1_REPO_REQUIRED"; return 1; }
  both=$(comm -12 <(l8p_result_field_files "$repo" L8P_LIVE_EXECUTED YES) <(l8p_result_field_files "$repo" L8P_PROVISIONING PASS))
  [ -n "$both" ] || { f1_reason "F1_L8P_NOT_CLOSED (no receipt carries both L8P_LIVE_EXECUTED=YES and L8P_PROVISIONING=PASS)"; return 1; }
  [ "$(printf '%s\n' "$both" | wc -l)" = 1 ] || { f1_reason "F1_L8P_RESULT_NOT_UNIQUE"; return 1; }
  [ "${both#HEAD:}" = "$F1_L8P_CLOSEOUT_RECEIPT_REL" ] || { f1_reason "F1_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT"; return 1; }
  [ -z "$(comm -12 <(l8p_result_field_files "$repo" F1_PRODUCTION_DEPLOYED YES) <(l8p_result_field_files "$repo" F1_DETECTOR_STARTED YES))" ] \
    || { f1_reason "F1_ALREADY_DEPLOYED (an F1 result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# f1_unit_pin_gate PY TOOL PIN_SHA256 — the reviewed template renders (and passes the unit contract) to bytes whose SHA-256 equals the frozen pin.
f1_unit_pin_gate() {
  local py=${1:-} tool=${2:-} pin=${3:-} tmp out got rc=0
  [[ "$pin" =~ ^[0-9a-f]{64}$ ]] || { f1_reason "F1_UNIT_PIN_INVALID"; return 1; }
  tmp=$(mktemp -d) || { f1_reason "F1_UNIT_PIN_TMP_FAILED"; return 1; }
  out=$("$py" "$tool" render-unit --output "$tmp/unit.service" 2>&1) || rc=$?
  if [ "$rc" != 0 ]; then rm -rf "$tmp"; f1_reason "F1_UNIT_RENDER_FAILED"; return 1; fi
  "$py" "$tool" verify-unit --file "$tmp/unit.service" >/dev/null 2>&1 || { rm -rf "$tmp"; f1_reason "F1_UNIT_VERIFY_FAILED"; return 1; }
  got=$(sha256sum "$tmp/unit.service" | cut -d' ' -f1); rm -rf "$tmp"
  [ "$got" = "$pin" ] || { f1_reason "F1_UNIT_PIN_MISMATCH"; return 1; }
}

# f1_detector_absent_gate — the detector unit is ABSENT everywhere systemd looks, not loaded, and no detector process runs. Read-only.
f1_detector_absent_gate() {
  local p out
  for p in "/etc/systemd/system/$F1_DETECTOR_UNIT" "/usr/lib/systemd/system/$F1_DETECTOR_UNIT" "/lib/systemd/system/$F1_DETECTOR_UNIT" "/run/systemd/system/$F1_DETECTOR_UNIT" \
           "/etc/systemd/system/$F1_DETECTOR_UNIT.d" "/run/systemd/system/$F1_DETECTOR_UNIT.d" "/usr/lib/systemd/system/$F1_DETECTOR_UNIT.d"; do
    [ ! -e "$p" ] && [ ! -L "$p" ] || { f1_reason "F1_DETECTOR_UNIT_ALREADY_PRESENT"; return 1; }
  done
  out=$(systemctl show -p LoadState -p ActiveState -p MainPID "$F1_DETECTOR_UNIT" 2>/dev/null) || { f1_reason "F1_DETECTOR_STATE_UNREADABLE"; return 1; }
  grep -qx 'LoadState=not-found' <<< "$out" || { f1_reason "F1_DETECTOR_UNIT_ALREADY_LOADED"; return 1; }
  grep -qx 'MainPID=0' <<< "$out" || { f1_reason "F1_DETECTOR_PROCESS_RUNNING"; return 1; }
  ! pgrep -f 'aegis_soc[.]production_detector' >/dev/null 2>&1 || { f1_reason "F1_DETECTOR_PROCESS_RUNNING"; return 1; }
}

# f1_core_env_gate UID PY TOOL CORE_ACCOUNT — core.env carries exactly AEGIS_ALERT_SOURCE_UID=UID (root READ; values never echoed).
f1_core_env_gate() {
  local uid=${1:-} py=${2:-} tool=${3:-} core_uid
  core_uid=$(id -u "${4:-aegis-idea3}" 2>/dev/null) || { f1_reason "F1_CORE_ACCOUNT_UNRESOLVED"; return 1; }
  $SUDO "$py" "$tool" verify-env --uid "$uid" --core-uid "$core_uid" --file "$F1_CORE_ENV" >/dev/null 2>&1 || { f1_reason "F1_CORE_ENV_ALERT_UID_MISMATCH"; return 1; }
}

# f1_core_running_alert_uid_gate UNIT UID — the RUNNING Core process itself carries AEGIS_ALERT_SOURCE_UID=UID (root read of /proc; nothing else printed).
f1_core_running_alert_uid_gate() {
  local unit=${1:-} uid=${2:-} pid
  pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { f1_reason "F1_CORE_MAINPID_INVALID"; return 1; }
  $SUDO bash -c 'tr "\0" "\n" < "/proc/$1/environ" | grep -qx "AEGIS_ALERT_SOURCE_UID=$2"' _ "$pid" "$uid" \
    || { f1_reason "F1_CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"; return 1; }
}

# f1_alert_surface_gate CORE_ACCOUNT — the dedicated alert directory and socket have the exact owner, group, type and mode (root metadata read).
f1_alert_surface_gate() {
  local core=${1:-aegis-idea3} dir sock
  dir=$($SUDO stat -c '%F %U:%G %a' "$F1_ALERT_DIR" 2>/dev/null) || { f1_reason "F1_ALERT_DIRECTORY_MISSING"; return 1; }
  [ "$dir" = "directory $core:aegis-idea3-alert 2750" ] || { f1_reason "F1_ALERT_DIRECTORY_CONTRACT_MISMATCH"; return 1; }
  sock=$($SUDO stat -c '%F %U:%G %a' "$F1_ALERT_SOCK" 2>/dev/null) || { f1_reason "F1_ALERT_SOCKET_MISSING"; return 1; }
  [ "$sock" = "socket $core:aegis-idea3-alert 620" ] || { f1_reason "F1_ALERT_SOCKET_CONTRACT_MISMATCH"; return 1; }
}

# f1_probe_config_gate — the Recovery probe settings R2/R6/R7 are present and non-empty in core.env (root READ; only a boolean per key is reported).
f1_probe_config_gate() {
  local k
  for k in AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET AEGIS_RECOVERY_NETWORK_PROBE_TARGETS AEGIS_RECOVERY_WEB_READINESS_URL; do
    $SUDO grep -qE "^$k=.+" "$F1_CORE_ENV" 2>/dev/null || { f1_reason "F1_PROBE_CONFIG_MISSING:$k"; return 1; }
  done
}

# f1_unit_state_gate — after apply (and after rollback) the unit state is exactly what the stage claims. MODE = running | absent. Read-only.
f1_unit_state_gate() {
  local mode=${1:-} out
  out=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p UnitFileState -p Restart "$F1_DETECTOR_UNIT" 2>/dev/null) || { f1_reason "F1_DETECTOR_STATE_UNREADABLE"; return 1; }
  case "$mode" in
    running)
      grep -qx 'LoadState=loaded' <<< "$out" && grep -qx 'ActiveState=active' <<< "$out" && grep -qx 'SubState=running' <<< "$out" \
        && grep -qx 'Restart=no' <<< "$out" && ! grep -qx 'UnitFileState=enabled' <<< "$out" && ! grep -qx 'MainPID=0' <<< "$out" \
        || { f1_reason "F1_DETECTOR_NOT_RUNNING_AS_CLAIMED"; return 1; } ;;
    absent)
      grep -qx 'LoadState=not-found' <<< "$out" || { f1_reason "F1_DETECTOR_NOT_ABSENT"; return 1; } ;;
    *) f1_reason "F1_UNIT_STATE_MODE_INVALID"; return 1 ;;
  esac
}

# f1_rollback_output_gate OUTPUT — rollback printed exactly one of its fixed success lines.
f1_rollback_output_gate() {
  grep -qxE 'F1_ROLLBACK=(PASS|NOTHING_OWNED|ALREADY_ROLLED_BACK)' <<< "${1:-}" || { f1_reason "F1_ROLLBACK_OUTPUT_UNEXPECTED"; return 1; }
}
