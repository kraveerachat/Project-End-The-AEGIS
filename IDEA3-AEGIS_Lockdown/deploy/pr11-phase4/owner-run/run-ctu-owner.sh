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
ctu_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || { echo CTU_OPERATOR_IDENTITY_INVALID >&2; exit 2; }
for f in "$AUTH" "$K3"; do
  [ -f "$f" ] && [ ! -L "$f" ] || exit 1
  grep -qx "stage=CTu" "$f" || exit 1
  grep -qx "date=$TODAY" "$f" || exit 1
done
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || exit 1
[ -z "$(git -C "$REPO" status --porcelain)" ] || exit 1
[ "$(sha256sum "$UNIT_SOURCE" | cut -d' ' -f1)" = "$UNIT_SHA256" ] || exit 1
ctu_marker_unconsumed || exit 1
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt allow-keys-rollback.txt; do [ -f "$P4/stages/CTu/$f" ] || exit 1; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || exit 1
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || exit 1
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || exit 1
grep -qx 'ROLLBACK_HANDLER=REGISTERED' <<<"$gate_out" || exit 1
ORIGIN_MAIN=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
[ "$ORIGIN_MAIN" = "$EXPECTED_MAIN" ] || exit 1
EVID=$EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-ctu-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/ctu-work; PRE=$EVID/pre-root; POST=$EVID/post-root; RB=$EVID/rb-root
mkdir -m 700 "$EVID" || exit 1
WORK="$WORK"; BUNDLE=$WORK/bundle
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$BUNDLE/p4-l0-capture.sh"; }
compare() {
  sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$BUNDLE/$2" ALLOW_LISTENERS_FILE="$BUNDLE/stages/CTu/allow-listeners.txt" bash "$BUNDLE/p4-compare.sh" "$3" "$4" > "$5"
  grep -qx 'PRESERVATION_S10=PASS' "$5" && grep -qx 'COMPARE_RESULT=PASS' "$5"
}
rollback_flow() {
  local reason=$1 out
  [ "${ROLLBACK_DONE:-0}" = 0 ] || return 1
  ROLLBACK_DONE=1
  if ! out=$(sudo env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" bash "$BUNDLE/stages/CTu/rollback.sh" 2>&1); then
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
post_fail() {
  local reason=$1
  trap - ERR INT TERM HUP
  TERMINAL=1
  local consumed=NO
  if ctu_marker_path >/dev/null 2>&1 && sudo test -e "$(ctu_marker_path)" && ! sudo test -L "$(ctu_marker_path)"; then consumed=YES; rollback_flow "$reason" || true; fi
  printf 'CTU_RESULT=FAIL_IMMUTABLE\nCTU_ATTEMPT_CONSUMED=%s\nCTU_RERUN_ALLOWED=NO\nCTU_FAILURE_REASON=%s\n' "$consumed" "$reason" > "$EVID/terminal-result" 2>/dev/null || true
  sudo sync -- "$EVID/terminal-result" "$EVID" 2>/dev/null || true
  echo "CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=$consumed CTU_RERUN_ALLOWED=NO reason=$reason" >&2
  exit 1
}
handle_signal() { local signal=$1; post_fail "SIGNAL_$signal"; }
exit_handler() { local rc=$?; [ "${TERMINAL:-0}" = 1 ] || [ "$rc" = 0 ] || post_fail "EXIT_$rc"; }
CORE_PRE_PID=$(sudo systemctl show -p MainPID --value aegis-idea3-core.service)
CORE_PRE_START=$(sudo systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
CORE_PRE_NRESTARTS=$(sudo systemctl show -p NRestarts --value aegis-idea3-core.service)
DEVICE_ID=esp32-01
STATUS_PRE_UPDATED_AT=$(sudo /usr/bin/python3 -c 'import json; print(float(json.load(open("/run/aegis-idea3/status.json"))["updated_at"]))') || exit 1
DETECTOR_PRE_STATE=$(sudo systemctl show -p MainPID -p ExecMainStartTimestamp -p InvocationID -p NRestarts aegis-idea3-detector.service)
DETECTOR_PRE_PID=$(awk -F= '$1 == "MainPID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_START=$(awk -F= '$1 == "ExecMainStartTimestamp" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_INVOCATION=$(awk -F= '$1 == "InvocationID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_NRESTARTS=$(awk -F= '$1 == "NRestarts" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_MONOTONIC=$(sudo systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-detector.service)
[ "$CORE_PRE_NRESTARTS" = 0 ] || exit 1
[[ "$DETECTOR_PRE_PID" =~ ^[1-9][0-9]*$ && "$DETECTOR_PRE_NRESTARTS" = 0 && "$DETECTOR_PRE_INVOCATION" =~ ^[0-9a-f]{32}$ && "$DETECTOR_PRE_MONOTONIC" =~ ^[0-9]+$ ]] || exit 1
capture "$PRE" ctu-pre || exit 1
ctu_marker_unconsumed || exit 1
CONSUMED=0; CTU_MARKER_CREATED=0; ROLLBACK_DONE=0
RUNTIME_VERIFY="$P4/p4-ctu-runtime-verify.py"
UNIT_SNAPSHOT="$WORK/core.service.snapshot"
trap 'exit_handler' EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal HUP' HUP
if ! ctu_prepare_unit_snapshot "$UNIT_SOURCE" "$UNIT_SNAPSHOT" "$UNIT_SHA256"; then post_fail UNIT_SNAPSHOT; fi
if ! ctu_prepare_bundle "$REPO" "$P4" "$BUNDLE" "$EXPECTED_MAIN"; then post_fail CTU_BUNDLE; fi
source "$BUNDLE/p4-l7u-run-lib.sh"
if ! ctu_consume_attempt "$WORK" "$DEVICE_ID" "$RUNTIME_VERIFY"; then
  if [ "$CTU_MARKER_CREATED" = 1 ]; then
    CONSUMED=1; post_fail MARKER_DURABILITY
  fi
  echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING' >&2
  exit 1
fi
CONSUMED=1
if ! sudo env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" bash "$BUNDLE/stages/CTu/apply.sh"; then post_fail APPLY; fi
if ! capture "$POST" ctu-post; then post_fail POST_CAPTURE; fi
if ! compare "$PRE" "stages/CTu/allow-keys.txt" "$PRE" "$POST" "$EVID/compare-pre-post.txt"; then post_fail COMPARE_S10; fi
if ! l7u_secret_scan "$EVID" /usr/bin/python3; then post_fail SECRET_SCAN; fi
if ! sudo env AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_RUNTIME_VERIFY="$BUNDLE/p4-ctu-runtime-verify.py" AEGIS_CTU_PRE_CORE_PID="$CORE_PRE_PID" AEGIS_CTU_PRE_CORE_START="$CORE_PRE_START" AEGIS_CTU_PRE_CORE_NRESTARTS="$CORE_PRE_NRESTARTS" AEGIS_CTU_PRE_STATUS_UPDATED_AT="$STATUS_PRE_UPDATED_AT" AEGIS_CTU_DEVICE_ID="$DEVICE_ID" AEGIS_CTU_PRE_DETECTOR_PID="$DETECTOR_PRE_PID" AEGIS_CTU_PRE_DETECTOR_START="$DETECTOR_PRE_START" AEGIS_CTU_PRE_DETECTOR_INVOCATION="$DETECTOR_PRE_INVOCATION" AEGIS_CTU_PRE_DETECTOR_NRESTARTS="$DETECTOR_PRE_NRESTARTS" AEGIS_CTU_PRE_DETECTOR_MONOTONIC="$DETECTOR_PRE_MONOTONIC" bash "$BUNDLE/stages/CTu/verify.sh"; then post_fail VERIFY; fi
if ! ctu_record_success "$EXPECTED_MAIN" "$UNIT_SHA256" "$EVID"; then post_fail CTU_CLOSEOUT; fi
TERMINAL=1
printf 'CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_EXPECTED_MAIN=%s\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\nCTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\nCTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=%s\nCTU_EVIDENCE_ROOT=%s\n' "$EXPECTED_MAIN" "$UNIT_SHA256" "$EVID" > "$EVID/terminal-result"
sync -- "$EVID/terminal-result" "$EVID"
printf 'CTU_LIVE=PASS RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO\n'
