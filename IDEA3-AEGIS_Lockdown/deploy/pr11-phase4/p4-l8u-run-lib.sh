#!/usr/bin/env bash
# AEGIS IDEA3 Phase 4 — L8u (governed READ-ONLY L8 live acceptance) owner-run library. Sourced by the FROZEN owner runner AFTER the control snapshot was re-proved (control_gate) and byte-compared with
# the pinned main (control_git_gate); nothing here runs on its own. Every gate returns 0 on PASS; on FAIL it prints one reason line to stderr and returns 1.
#
# L8u is OBSERVATION ONLY. This library never opens a serial device, never runs esptool, never resets/flashes/provisions the ESP32, never publishes MQTT, never restarts a unit and never reruns L8p
# or NTP. Its only governed writes are the root-owned stage-global one-attempt marker and the PASS/FAIL closeout in the canonical governance directory. The privilege prefix is `$SUDO`
# ("sudo -n" in the frozen runner after ONE `sudo -v`; tests set SUDO="").
#
# Functions the FROZEN RUNNER must define before using this library: control_gate (re-proves the immutable control snapshot; run immediately before EVERY root execution).
# Globals the runner sets: CTRL STG PY SUDO EVID WORK.

: "${SUDO=sudo}"
_L8U_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l7u-run-lib.sh
. "$_L8U_LIB_DIR/p4-l7u-run-lib.sh"
# shellcheck source=p4-f1u-run-lib.sh
. "$_L8U_LIB_DIR/p4-f1u-run-lib.sh"

# Every Git read that feeds an L8u trust decision runs with replacement objects DISABLED.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }

L8U_CANONICAL_DIR=/var/lib/aegis-idea3-governance
L8U_MARKER_NAME=L8U-GLOBAL-ATTEMPT-CONSUMED
L8U_CLOSEOUT_PASS_NAME=L8U-GLOBAL-CLOSEOUT-PASS
L8U_CLOSEOUT_FAIL_NAME=L8U-GLOBAL-CLOSEOUT-FAIL
L8U_RECOVERY_MARKER_NAME=RECOVERY-GLOBAL-ATTEMPT-CONSUMED
L8U_CORE_UNIT=aegis-idea3-core.service
L8U_CORE_UNIT_PATH=/etc/systemd/system/aegis-idea3-core.service
L8U_SAFE_PATH=/usr/sbin:/usr/bin:/sbin:/bin

l8u_reason() { printf '%s\n' "$1" >&2; return 1; }

# ---- environment: nothing from the caller may redirect a live run -------------------------------------------------------------------------------------------------
# The runner repeats the pre-start refusal list; this is the library-level check (tests exercise it directly).
l8u_env_gate() {
  local var
  for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PYTHONSAFEPATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH \
    AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_L8U_WORK_DIR AEGIS_L8U_LIVE_AUTHORIZED AEGIS_L8U_CONTROL AEGIS_L8_BACKEND AEGIS_L8_LIVE_AUTHORIZED AEGIS_L8_ESPTOOL AEGIS_L8P_LIVE_AUTHORIZED \
    L8U_TEST_ONLY_CANONICAL_DIR_ENABLED L8U_TEST_ONLY_CANONICAL_DIR L8U_TEST_ONLY_TRUST_ROOT L8U_TEST_ONLY_BOUNDARY L8U_TEST_ONLY_RUNNER_TRUST_ENABLED L8U_TEST_ONLY_RUNNER_TRUST_ROOT \
    L8U_TEST_ONLY_SNAPSHOT_TRUST_ENABLED L8U_TEST_ONLY_SNAPSHOT_TRUST_ROOT SUDO_ASKPASS SUDO_EDITOR; do
    [ -z "${!var:-}" ] || { l8u_reason "L8U_ENVIRONMENT_OVERRIDE:$var"; return 1; }
  done
  [ -z "$(env | sed -n 's/^GIT_[^=]*=.*/x/p')" ] || { l8u_reason "L8U_ENVIRONMENT_OVERRIDE:GIT_*"; return 1; }
  [ -z "$(env | sed -n 's/^\(SHELLOPTS\|BASHOPTS\)=.*/x/p')" ] || { l8u_reason "L8U_ENVIRONMENT_OVERRIDE:SHELLOPTS"; return 1; }
}

# ---- canonical governance directory + one-attempt marker (root-owned; test seam only when explicitly enabled; the frozen runner refuses the seam) -------------------
l8u_canonical_dir() {
  if [ "${L8U_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${L8U_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$L8U_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$L8U_CANONICAL_DIR"; fi
}
l8u_trusted_dir_chain() {
  local dir=${1:-} owner=0 stop=/
  [ -n "$SUDO" ] || owner=$(id -u)
  if [ "${L8U_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${L8U_TEST_ONLY_TRUST_ROOT:-}" ]; then stop=$L8U_TEST_ONLY_TRUST_ROOT; fi
  [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  while :; do
    $SUDO test -d "$dir" && ! $SUDO test -L "$dir" || return 1
    [ "$($SUDO stat -c %u "$dir" 2>/dev/null)" = "$owner" ] || return 1
    [ -z "$($SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    [ "$dir" = "$stop" ] && return 0
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
l8u_canonical_dir_valid() {
  local dir; dir=$(l8u_canonical_dir); [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  if $SUDO test -e "$dir" || $SUDO test -L "$dir"; then l8u_trusted_dir_chain "$dir"; else l8u_trusted_dir_chain "$(dirname "$dir")"; fi
}
l8u_path() { printf '%s/%s' "$(l8u_canonical_dir)" "$1"; }
l8u_present() { $SUDO test -e "$1" || $SUDO test -L "$1"; }
l8u_fsync() { $SUDO sync -- "$1" 2>/dev/null; }

# l8u_marker_unconsumed — the canonical directory is trusted and NEITHER the L8u marker NOR any L8u closeout exists (one attempt TOTAL; no retry model).
l8u_marker_unconsumed() {
  l8u_canonical_dir_valid || { l8u_reason L8U_CANONICAL_DIR_NOT_TRUSTED; return 1; }
  local name
  for name in "$L8U_MARKER_NAME" "$L8U_CLOSEOUT_PASS_NAME" "$L8U_CLOSEOUT_FAIL_NAME"; do
    if l8u_present "$(l8u_path "$name")"; then l8u_reason "L8U_ATTEMPT_ALREADY_CONSUMED:$name"; return 1; fi
  done
}
# l8u_recovery_marker_gate — the Recovery attempt marker EXISTS as a root-owned regular file (the governed Recovery ran; LVR PASS is judged separately by the receipt gate). Read-only; never created.
l8u_recovery_marker_gate() {
  local marker; marker=$(l8u_path "$L8U_RECOVERY_MARKER_NAME")
  l8u_canonical_dir_valid || { l8u_reason L8U_CANONICAL_DIR_NOT_TRUSTED; return 1; }
  $SUDO test -f "$marker" && ! $SUDO test -L "$marker" || { l8u_reason L8U_RECOVERY_MARKER_MISSING; return 1; }
}
# l8u_consume_attempt WORK DEVICE_ID — capture the evidence boundary, create the marker exclusively (noclobber), make it durable, best-effort immutable. Sets L8U_MARKER_CREATED=1 once the marker EXISTS.
l8u_consume_attempt() {
  local work=${1:-} device=${2:-} dir marker boundary
  [[ "$work" == /* && "$work" != *..* && "$device" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || return 1
  l8u_marker_unconsumed || return 1
  dir=$(l8u_canonical_dir); marker=$(l8u_path "$L8U_MARKER_NAME")
  if ! $SUDO test -d "$dir"; then $SUDO mkdir -m 0700 "$dir" || return 1; fi
  l8u_fsync "$(dirname "$dir")" || return 1
  if [ "${L8U_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${L8U_TEST_ONLY_BOUNDARY:-}" ]; then
    boundary=$L8U_TEST_ONLY_BOUNDARY
  else
    control_gate || return 1
    boundary=$($SUDO /usr/bin/python3 -I "$CTRL/p4-l8u-observe.py" --capture-boundary --device-id "$device") || return 1
  fi
  if ! printf 'L8U_ATTEMPT_CONSUMED=YES\nL8U_RERUN_ALLOWED=NO\nL8U_DEVICE_ID=%s\nL8U_CONSUMED_AT_EPOCH=%s\nwork=%s\n%s\n' "$device" "$(date -u +%s.%N)" "$work" "$boundary" \
      | $SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$marker"; then l8u_reason L8U_ATTEMPT_ALREADY_CONSUMED; return 1; fi
  L8U_MARKER_CREATED=1
  l8u_fsync "$marker" && l8u_fsync "$dir" || { l8u_reason L8U_MARKER_NOT_DURABLE_ATTEMPT_CONSUMED; return 1; }
  $SUDO chattr +i "$marker" 2>/dev/null || true
}
# l8u_write_closeout NAME CONTENT — exclusive (never overwrites), written to a temp name then linked into place, durable file + directory. The PASS closeout additionally refuses while a FAIL closeout exists.
l8u_write_closeout() {
  local name=${1:-} content=${2:-} dir final tmp
  dir=$(l8u_canonical_dir); final=$(l8u_path "$name"); tmp="$final.tmp.$$"
  [ "$name" = "$L8U_CLOSEOUT_PASS_NAME" ] || [ "$name" = "$L8U_CLOSEOUT_FAIL_NAME" ] || return 1
  l8u_canonical_dir_valid || return 1
  if [ "$name" = "$L8U_CLOSEOUT_PASS_NAME" ] && l8u_present "$(l8u_path "$L8U_CLOSEOUT_FAIL_NAME")"; then l8u_reason L8U_FAIL_CLOSEOUT_EXISTS; return 1; fi
  printf '%s\n' "$content" | $SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$tmp" || return 1
  l8u_fsync "$tmp" || { $SUDO rm -f -- "$tmp"; return 1; }
  if ! $SUDO ln -- "$tmp" "$final"; then $SUDO rm -f -- "$tmp"; return 1; fi
  $SUDO rm -f -- "$tmp"
  l8u_fsync "$final" && l8u_fsync "$dir"
}
l8u_pass_content() { # MAIN RUNNER_SHA256 EVIDENCE_ROOT
  printf 'L8U_LIVE=CLOSED_PASS\nL8U_LIVE_EXECUTED=YES\nL8U_RESULT=PASS\nL8U_ATTEMPT_CONSUMED=YES\nL8U_RERUN_ALLOWED=NO\nL8U_STAGE=L8u\nL8U_EXPECTED_MAIN=%s\nL8U_RUNNER_SHA256=%s\nL8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY\nL8U_LOGICAL_ACCEPTANCE=PASS\nL8_ACCEPTANCE=NOT_PROMOTED_UNTIL_A_REVIEWED_CLOSEOUT\nL8P_EXECUTED=NO\nESP32_REFLASH_PERFORMED=NO\nNTP_RERUN=NO\nELECTRICAL_RELAY_PROOF=NO\nL9_PROVEN=NO\nL8U_EVIDENCE_ROOT=%s' "$1" "$2" "$3"
}
l8u_fail_content() { # MAIN REASON EVIDENCE_ROOT
  printf 'L8U_LIVE=CLOSED_FAIL\nL8U_LIVE_EXECUTED=YES\nL8U_RESULT=FAIL_IMMUTABLE\nL8U_ATTEMPT_CONSUMED=YES\nL8U_RERUN_ALLOWED=NO\nL8U_STAGE=L8u\nL8U_EXPECTED_MAIN=%s\nL8U_FAILURE_REASON=%s\nL8_ACCEPTANCE=NO\nL8P_EXECUTED=NO\nESP32_REFLASH_PERFORMED=NO\nL8U_EVIDENCE_ROOT=%s' "$1" "$2" "$3"
}

# ---- sudo authority: ONE interactive `sudo -v`, then non-interactive `sudo -n` with a bounded keepalive (an expired credential must never stall an attempt after its marker) ----------------------
L8U_KEEPALIVE_PID=""
l8u_start_sudo_keepalive() {
  [ -n "$SUDO" ] || return 0
  # its own output never reaches the run log; TERM stops it AND its pending `sleep`, so nothing outlives the run
  ( sp=""; trap '[ -z "$sp" ] || kill "$sp" 2>/dev/null; exit 0' TERM; while :; do sleep 60 & sp=$!; wait "$sp"; $SUDO -v 2>/dev/null || exit 1; done ) >/dev/null 2>&1 &
  L8U_KEEPALIVE_PID=$!
}
l8u_stop_sudo_keepalive() { [ -z "${L8U_KEEPALIVE_PID:-}" ] || kill "$L8U_KEEPALIVE_PID" 2>/dev/null || true; L8U_KEEPALIVE_PID=""; }
l8u_sudo_authority_gate() {
  [ -n "$SUDO" ] || return 0
  $SUDO true 2>/dev/null || { l8u_reason L8U_SUDO_CREDENTIAL_NOT_ACTIVE; return 1; }
  { [ -n "${L8U_KEEPALIVE_PID:-}" ] && kill -0 "$L8U_KEEPALIVE_PID" 2>/dev/null; } || { l8u_reason L8U_SUDO_KEEPALIVE_NOT_RUNNING; return 1; }
}

# ---- Authorization / K3 ------------------------------------------------------------------------------------------------------------------------------------
# l8u_records_gate AUTH_DIR TODAY MAIN RUNNER_SHA DEVICE_MAC FIRMWARE_SHA LVR_CLOSEOUT_SHA — fresh same-day stage=L8u records, EXACT key sets (so a record minted for another stage, or one carrying an
# extra field such as recovery_authorization, never validates), the authorization names this main, this exact runner SHA-256, the pinned device MAC, firmware digest and LVR closeout digest.
l8u_records_gate() {
  local dir=${1:-} today=${2:-} main=${3:-} runner=${4:-} mac=${5:-} fw=${6:-} lvr=${7:-} f keys
  for f in authorization-L8u.txt k3-L8u.txt; do
    [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || { l8u_reason "L8U_RECORD_MISSING:$f"; return 1; }
    grep -qx "stage=L8u" "$dir/$f" || { l8u_reason "L8U_RECORD_NOT_STAGE_L8U:$f"; return 1; }
    grep -qx "date=$today" "$dir/$f" || { l8u_reason "L8U_RECORD_NOT_TODAY:$f"; return 1; }
  done
  keys=$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$dir/authorization-L8u.txt" | sort | tr '\n' ' ')
  [ "$keys" = "authorizer date reference scope stage " ] || { l8u_reason L8U_AUTHORIZATION_KEY_SET_INVALID; return 1; }
  keys=$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$dir/k3-L8u.txt" | sort | tr '\n' ' ')
  [ "$keys" = "confirmation_mode confirmed_by date idea1_window_overlap reference stage " ] || { l8u_reason L8U_K3_KEY_SET_INVALID; return 1; }
  for f in "$main" "$runner" "$mac" "$fw" "$lvr"; do
    grep -qF "$f" "$dir/authorization-L8u.txt" || { l8u_reason "L8U_AUTHORIZATION_DOES_NOT_NAME_A_FROZEN_BINDING"; return 1; }
  done
  grep -qF "$main" "$dir/k3-L8u.txt" || { l8u_reason L8U_K3_DOES_NOT_NAME_THE_PINNED_MAIN; return 1; }
}

# ---- predecessors (LVR PASS -> L8u; L8p historical read-only) ---------------------------------------------------------------------------------------------
# l8u_predecessor_gate REPO MAIN LVR_CLOSEOUT_SHA256 — HEAD is the pinned main, and the ONE predecessor authority (l8u_predecessors.py, also used by the freeze tool) accepts it.
l8u_predecessor_gate() {
  local repo=${1:-} main=${2:-} lvr=${3:-}
  [ "$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$main" ] || { l8u_reason L8U_HEAD_NOT_THE_PINNED_MAIN; return 1; }
  "$PY" -I "$CTRL/l8u-acceptance/l8u_predecessors.py" --repo "$repo" --main "$main" --lvr-closeout-sha256 "$lvr" >/dev/null || { l8u_reason L8U_PREDECESSOR_GATE_FAILED; return 1; }
}
# l8u_historical_evidence_gate — the historical L8p evidence bundle (pinned bytes, twelve fields, all PASS) matches the pinned device and firmware. Root read; nothing is rerun.
l8u_historical_evidence_gate() {
  control_gate || return 1
  $SUDO /usr/bin/python3 -I "$CTRL/p4-l8u-observe.py" --check-l8p-evidence --device-mac "$1" --firmware-sha256 "$2" --l8p-evidence-file "$3" --l8p-evidence-sha256 "$4" >/dev/null \
    || { l8u_reason L8U_L8P_HISTORICAL_EVIDENCE_INVALID; return 1; }
}

# ---- host gates (read-only) ---------------------------------------------------------------------------------------------------------------------------------
l8u_service_gate() {
  local u
  for u in "$@"; do
    [ "$(systemctl show -p ActiveState --value "$u" 2>/dev/null)" = active ] && [ "$(systemctl show -p SubState --value "$u" 2>/dev/null)" = running ] || { l8u_reason "L8U_SERVICE_NOT_ACTIVE:$u"; return 1; }
  done
}
# l8u_core_unit_gate PIN — the installed Core unit is exactly the pinned (CTu) unit, a root-owned regular file, with no drop-in and the effective ProtectClock off.
l8u_core_unit_gate() {
  local pin=${1:-}
  [[ "$pin" =~ ^[0-9a-f]{64}$ ]] || { l8u_reason L8U_CORE_UNIT_PIN_INVALID; return 1; }
  $SUDO test -f "$L8U_CORE_UNIT_PATH" && ! $SUDO test -L "$L8U_CORE_UNIT_PATH" || { l8u_reason L8U_CORE_UNIT_NOT_A_REGULAR_FILE; return 1; }
  [ "$($SUDO sha256sum -- "$L8U_CORE_UNIT_PATH" | cut -d' ' -f1)" = "$pin" ] || { l8u_reason L8U_CORE_UNIT_NOT_THE_PINNED_UNIT; return 1; }
  [ -z "$(systemctl show -p DropInPaths --value "$L8U_CORE_UNIT" 2>/dev/null)" ] || { l8u_reason L8U_CORE_UNIT_DROPIN_PRESENT; return 1; }
  [ "$(systemctl show -p NeedDaemonReload --value "$L8U_CORE_UNIT" 2>/dev/null)" = no ] || { l8u_reason L8U_CORE_UNIT_RELOAD_PENDING; return 1; }
  case "$(systemctl show -p ProtectClock --value "$L8U_CORE_UNIT" 2>/dev/null)" in no | false) ;; *) l8u_reason L8U_CORE_PROTECTCLOCK_NOT_OFF; return 1 ;; esac
}
l8u_runtime_preflight() { # CORE_PID EXPECTED_STATE — the Core already reports the pinned state, SYNCED, CONNECTED, ONLINE (read-only; nothing is started or repaired)
  control_gate || return 1
  $SUDO /usr/bin/python3 -I "$CTRL/p4-l8u-observe.py" --preflight --core-pid "$1" --expected-state "$2" >/dev/null || { l8u_reason L8U_RUNTIME_PREFLIGHT_FAILED; return 1; }
}
