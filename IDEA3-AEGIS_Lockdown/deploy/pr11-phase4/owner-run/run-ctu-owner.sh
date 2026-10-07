#!/usr/bin/env bash
# Frozen post-merge CTu owner runner template. It is intentionally unpinned;
# a future exact-main authority must fill the pins after human merge.
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
UNIT_SHA256=PIN_CORE_UNIT_SHA256
MERGED_MAIN_WORKTREE=PIN_MERGED_MAIN_WORKTREE
EVIDENCE_ROOT=PIN_EVIDENCE_ROOT
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID UNIT_SHA256 MERGED_MAIN_WORKTREE EVIDENCE_ROOT; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$UNIT_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
REPO=$MERGED_MAIN_WORKTREE
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] && [ "$(readlink -f -- "$AUTH_DIR")" = "$AUTH_DIR" ] || { echo 'usage: run-ctu-owner.sh <fresh auth dir>' >&2; exit 2; }
[ -n "$REPO" ] && [ "$(readlink -f -- "$REPO")" = "$REPO" ] && [ -d "$REPO/.git" ] || exit 2
[ "${EVIDENCE_ROOT#/}" != "$EVIDENCE_ROOT" ] && [[ "$EVIDENCE_ROOT" != *..* ]] && { [ ! -e "$EVIDENCE_ROOT" ] || [ ! -L "$EVIDENCE_ROOT" ] && [ "$(readlink -f -- "$EVIDENCE_ROOT")" = "$EVIDENCE_ROOT" ]; } || exit 2
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the frozen operator, not root.' >&2; exit 2; }
[ "${SUDO+x}" != x ] || { echo 'STOP: environment override SUDO is forbidden.' >&2; exit 2; }
[ -z "${GIT_DIR:-}" ] && [ -z "${GIT_WORK_TREE:-}" ] && [ -z "${GIT_INDEX_FILE:-}" ] && [ -z "$(env | sed -n 's/^GIT_[^=]*=.*/x/p')" ] || { echo 'STOP: Git environment override is forbidden.' >&2; exit 2; }
[ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_TRUST_ROOT:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_BOUNDARY:-}" ] || { echo 'STOP: test-only CTu governance seam is forbidden in the live runner.' >&2; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
UNIT_SOURCE=$APP/deploy/aegis-idea3-core.service.example
AUTH=$AUTH_DIR/authorization-CTu.txt
K3=$AUTH_DIR/k3-CTu.txt
. "$P4/p4-ctu-run-lib.sh"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
ctu_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || { echo CTU_OPERATOR_IDENTITY_INVALID >&2; exit 2; }
for f in "$AUTH" "$K3"; do
  [ -f "$f" ] && [ ! -L "$f" ] || exit 1
  grep -qx "stage=CTu" "$f" || exit 1
  grep -qx "date=$TODAY" "$f" || exit 1
  grep -qx "expected_main=$EXPECTED_MAIN" "$f" || exit 1
  grep -qx "runner_sha256=$RUNNER_SHA256" "$f" || exit 1
  grep -qx "unit_sha256=$UNIT_SHA256" "$f" || exit 1
  grep -qx "operator_user=$OPERATOR_USER" "$f" || exit 1
  grep -qx "operator_uid=$OPERATOR_UID" "$f" || exit 1
done
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || exit 1
[ -z "$(git -C "$REPO" status --porcelain)" ] || exit 1
[ "$(sha256sum "$UNIT_SOURCE" | cut -d' ' -f1)" = "$UNIT_SHA256" ] || exit 1
ctu_marker_unconsumed || exit 1
gov_dir=$(ctu_canonical_dir)
[ ! -e "$gov_dir/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] || { echo "STOP: Recovery marker is present; CTu cannot run after Recovery." >&2; exit 1; }
[ ! -e "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-PASS" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-PASS" ] || { echo "STOP: Recovery closeout is present." >&2; exit 1; }
[ ! -e "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-FAIL" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-FAIL" ] || { echo "STOP: Recovery closeout is present." >&2; exit 1; }
ctu_rru_successor_gate "$REPO" "$EXPECTED_MAIN" || { echo "STOP: valid RRu PASS closeout missing." >&2; exit 1; }
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt allow-keys-rollback.txt; do [ -f "$P4/stages/CTu/$f" ] || exit 1; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || exit 1
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || exit 1
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || exit 1
grep -qx 'ROLLBACK_HANDLER=REGISTERED' <<<"$gate_out" || exit 1
ORIGIN_MAIN=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
[ "$ORIGIN_MAIN" = "$EXPECTED_MAIN" ] || exit 1
sudo -v || { echo 'STOP: sudo authentication failed before CTu.' >&2; exit 1; }
ctu_start_sudo_keepalive || { echo 'STOP: could not start sudo keepalive.' >&2; exit 1; }
sudo -n systemctl is-active --quiet aegis-idea3-mosquitto.service || sudo -n systemctl is-active --quiet mosquitto.service || { echo 'STOP: broker is not active.' >&2; exit 1; }
timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q 'yes' || sudo -n systemctl is-active --quiet chronyd.service || sudo -n systemctl is-active --quiet systemd-timesyncd.service || { echo 'STOP: NTP runtime is not ready.' >&2; exit 1; }
CORE_PRE_LOAD=$(sudo -n systemctl show -p LoadState --value aegis-idea3-core.service)
CORE_PRE_ACTIVE=$(sudo -n systemctl show -p ActiveState --value aegis-idea3-core.service)
CORE_PRE_SUB=$(sudo -n systemctl show -p SubState --value aegis-idea3-core.service)
CORE_PRE_RESULT=$(sudo -n systemctl show -p Result --value aegis-idea3-core.service)
CORE_PRE_PID=$(sudo -n systemctl show -p MainPID --value aegis-idea3-core.service)
CORE_PRE_START=$(sudo -n systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
CORE_PRE_NRESTARTS=$(sudo -n systemctl show -p NRestarts --value aegis-idea3-core.service)
[ "$CORE_PRE_LOAD" = "loaded" ] && [ "$CORE_PRE_ACTIVE" = "active" ] && [ "$CORE_PRE_SUB" = "running" ] && [ "$CORE_PRE_RESULT" = "success" ] && [ "$CORE_PRE_NRESTARTS" = 0 ] && [[ "$CORE_PRE_PID" =~ ^[1-9][0-9]*$ ]] || { echo 'STOP: Core is not in active running state before CTu.' >&2; exit 1; }
DEVICE_ID=esp32-01
STATUS_PRE_UPDATED_AT=$(sudo -n /usr/bin/python3 -c 'import json; print(float(json.load(open("/run/aegis-idea3/status.json"))["updated_at"]))') || exit 1
DETECTOR_PRE_LOAD=$(sudo -n systemctl show -p LoadState --value aegis-idea3-detector.service)
DETECTOR_PRE_ACTIVE=$(sudo -n systemctl show -p ActiveState --value aegis-idea3-detector.service)
DETECTOR_PRE_SUB=$(sudo -n systemctl show -p SubState --value aegis-idea3-detector.service)
DETECTOR_PRE_RESULT=$(sudo -n systemctl show -p Result --value aegis-idea3-detector.service)
DETECTOR_PRE_STATE=$(sudo -n systemctl show -p MainPID -p ExecMainStartTimestamp -p InvocationID -p NRestarts aegis-idea3-detector.service)
DETECTOR_PRE_PID=$(awk -F= '$1 == "MainPID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_START=$(awk -F= '$1 == "ExecMainStartTimestamp" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_INVOCATION=$(awk -F= '$1 == "InvocationID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_NRESTARTS=$(awk -F= '$1 == "NRestarts" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_MONOTONIC=$(sudo -n systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-detector.service)
[ "$DETECTOR_PRE_LOAD" = "loaded" ] && [ "$DETECTOR_PRE_ACTIVE" = "active" ] && [ "$DETECTOR_PRE_SUB" = "running" ] && [ "$DETECTOR_PRE_RESULT" = "success" ] && [ "$DETECTOR_PRE_NRESTARTS" = 0 ] && [[ "$DETECTOR_PRE_PID" =~ ^[1-9][0-9]*$ ]] && [[ "$DETECTOR_PRE_INVOCATION" =~ ^[0-9a-f]{32}$ ]] && [[ "$DETECTOR_PRE_MONOTONIC" =~ ^[0-9]+$ ]] || { echo 'STOP: Detector is not in active running state before CTu.' >&2; exit 1; }
INSTALLED_CORE_UNIT="/etc/systemd/system/aegis-idea3-core.service"
PRE_UNIT_SHA=""
if [ -f "$INSTALLED_CORE_UNIT" ] && [ ! -L "$INSTALLED_CORE_UNIT" ]; then
  PRE_UNIT_SHA=$(sudo -n sha256sum "$INSTALLED_CORE_UNIT" | cut -d' ' -f1)
fi
avail_pct=$(df -P "$EVIDENCE_ROOT" | awk 'NR==2 {print 100 - int($5)}')
[ "$avail_pct" -ge 10 ] || { echo "STOP: evidence root disk capacity too low ($avail_pct% free)." >&2; exit 1; }
EVID=$EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-ctu-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/ctu-work; PRE=$EVID/pre-root; POST=$EVID/post-root; RB=$EVID/rb-root
mkdir -m 700 "$EVID" || exit 1
BUNDLE=$WORK/bundle
UNIT_SNAPSHOT=$WORK/core.service.snapshot
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo -n env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$BUNDLE/p4-l0-capture.sh"; }
compare() {
  sudo -n env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$BUNDLE/$2" ALLOW_LISTENERS_FILE="$BUNDLE/stages/CTu/allow-listeners.txt" bash "$BUNDLE/p4-compare.sh" "$3" "$4" > "$5"
  grep -qx 'PRESERVATION_S10=PASS' "$5" && grep -qx 'COMPARE_RESULT=PASS' "$5"
}
rollback_flow() {
  local reason=$1 out
  [ "${ROLLBACK_DONE:-0}" = 0 ] || return 1
  ROLLBACK_DONE=1
  if ! out=$(sudo -n env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" bash "$BUNDLE/stages/CTu/rollback.sh" 2>&1); then
    l7u_secret_scan "$EVID" /usr/bin/python3 || true
    printf '%s\nCTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=%s\n' "$out" "$reason" >&2
    return 1
  fi
  grep -q '^CTU_ROLLBACK=PASS' <<<"$out" || { l7u_secret_scan "$EVID" /usr/bin/python3 || true; return 1; }
  if ! capture "$RB" ctu-rb; then l7u_secret_scan "$EVID" /usr/bin/python3 || true; echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=RB_CAPTURE' >&2; return 1; fi
  if ! compare "$PRE" "stages/CTu/allow-keys-rollback.txt" "$PRE" "$RB" "$EVID/compare-pre-rb.txt"; then l7u_secret_scan "$EVID" /usr/bin/python3 || true; echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=PRE_RB_COMPARE' >&2; return 1; fi
  if ! l7u_secret_scan "$EVID" /usr/bin/python3; then echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=RB_SECRET_SCAN' >&2; return 1; fi
  printf 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_RERUN_ALLOWED=NO CTU_ROLLBACK=PASS CTU_RB_CAPTURE=COMPLETE CTU_PRE_RB_COMPARE=PASS reason=%s\n' "$reason" >&2
  return 0
}
IN_POST_FAIL=0
post_fail() {
  local reason=${1:-UNKNOWN}
  [ "${IN_POST_FAIL:-0}" = 0 ] || return 0
  IN_POST_FAIL=1
  TERMINAL=1
  trap '' INT TERM HUP EXIT
  trap - ERR
  local consumed=NO
  if ctu_marker_path >/dev/null 2>&1 && sudo -n test -e "$(ctu_marker_path)" && ! sudo -n test -L "$(ctu_marker_path)"; then
    consumed=YES
    rollback_flow "$reason" || true
    ctu_record_failure "$reason" || true
  fi
  ctu_stop_sudo_keepalive 2>/dev/null || true
  printf 'CTU_RESULT=FAIL_IMMUTABLE\nCTU_ATTEMPT_CONSUMED=%s\nCTU_RERUN_ALLOWED=NO\nCTU_FAILURE_REASON=%s\n' "$consumed" "$reason" > "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
  sync -- "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
  mv -f -- "$EVID/terminal-result.tmp.$$" "$EVID/terminal-result" 2>/dev/null || true
  sync -- "$EVID/terminal-result" "$EVID" 2>/dev/null || true
  echo "CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=$consumed CTU_RERUN_ALLOWED=NO reason=$reason" >&2
  exit 1
}
handle_signal() { local signal=$1; post_fail "SIGNAL_$signal"; }
exit_handler() { local rc=$?; [ "${TERMINAL:-0}" = 1 ] || [ "$rc" = 0 ] || post_fail "EXIT_$rc"; }
CONSUMED=0; CTU_MARKER_CREATED=0; ROLLBACK_DONE=0
trap 'exit_handler' EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal HUP' HUP
if ! ctu_prepare_bundle "$REPO" "$P4" "$BUNDLE" "$EXPECTED_MAIN"; then post_fail CTU_BUNDLE; fi
if ! ctu_prepare_unit_snapshot "$UNIT_SOURCE" "$UNIT_SNAPSHOT" "$UNIT_SHA256"; then post_fail UNIT_SNAPSHOT; fi
if ! ctu_verify_bundle "$BUNDLE"; then post_fail BUNDLE_VERIFY; fi
if ! ctu_verify_unit_snapshot "$UNIT_SNAPSHOT" "$UNIT_SHA256"; then post_fail UNIT_SNAPSHOT_VERIFY; fi
source "$BUNDLE/p4-ctu-run-lib.sh"
source "$BUNDLE/p4-l7u-run-lib.sh"
capture "$PRE" ctu-pre || post_fail PRE_CAPTURE
ctu_marker_unconsumed || post_fail PRE_MARKER
gate_out=$(TZ=Asia/Bangkok bash "$BUNDLE/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || post_fail PRE_REGATE
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || post_fail PRE_AUTH
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || post_fail PRE_K3
if ! ctu_consume_attempt "$WORK" "$DEVICE_ID" "$BUNDLE/p4-ctu-runtime-verify.py"; then
  if [ "${CTU_MARKER_CREATED:-0}" = 1 ]; then
    CONSUMED=1; post_fail MARKER_DURABILITY
  fi
  echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING' >&2
  exit 1
fi
CONSUMED=1
if ! sudo -n env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" bash "$BUNDLE/stages/CTu/apply.sh"; then post_fail APPLY; fi
if ! capture "$POST" ctu-post; then post_fail POST_CAPTURE; fi
if ! compare "$PRE" "stages/CTu/allow-keys.txt" "$PRE" "$POST" "$EVID/compare-pre-post.txt"; then post_fail COMPARE_S10; fi
if ! l7u_secret_scan "$EVID" /usr/bin/python3; then post_fail SECRET_SCAN; fi
if ! sudo -n env AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_RUNTIME_VERIFY="$BUNDLE/p4-ctu-runtime-verify.py" AEGIS_CTU_PRE_CORE_PID="$CORE_PRE_PID" AEGIS_CTU_PRE_CORE_START="$CORE_PRE_START" AEGIS_CTU_PRE_CORE_NRESTARTS="$CORE_PRE_NRESTARTS" AEGIS_CTU_PRE_STATUS_UPDATED_AT="$STATUS_PRE_UPDATED_AT" AEGIS_CTU_DEVICE_ID="$DEVICE_ID" AEGIS_CTU_PRE_DETECTOR_PID="$DETECTOR_PRE_PID" AEGIS_CTU_PRE_DETECTOR_START="$DETECTOR_PRE_START" AEGIS_CTU_PRE_DETECTOR_INVOCATION="$DETECTOR_PRE_INVOCATION" AEGIS_CTU_PRE_DETECTOR_NRESTARTS="$DETECTOR_PRE_NRESTARTS" AEGIS_CTU_PRE_DETECTOR_MONOTONIC="$DETECTOR_PRE_MONOTONIC" bash "$BUNDLE/stages/CTu/verify.sh"; then post_fail VERIFY; fi
if ! ctu_record_success "$EXPECTED_MAIN" "$UNIT_SHA256" "$EVID"; then post_fail CTU_CLOSEOUT; fi
ctu_stop_sudo_keepalive 2>/dev/null || true
TERMINAL=1
printf 'CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_EXPECTED_MAIN=%s\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\nCTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\nCTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=%s\nCTU_EVIDENCE_ROOT=%s\n' "$EXPECTED_MAIN" "$UNIT_SHA256" "$EVID" > "$EVID/terminal-result.tmp.$$"
sync -- "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
mv -f -- "$EVID/terminal-result.tmp.$$" "$EVID/terminal-result" 2>/dev/null || true
sync -- "$EVID/terminal-result" "$EVID"
printf 'CTU_LIVE=PASS RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO\n'
