#!/usr/bin/env bash
# Frozen post-merge CTu owner runner template. It is intentionally unpinned;
# a future exact-main authority must fill the pins after human merge.
set -Eeuo pipefail
umask 077
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
UNIT_SHA256=PIN_CORE_UNIT_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID UNIT_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$UNIT_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
AUTH_DIR=${1:-}
[ -d "$AUTH_DIR" ] || { echo 'usage: run-ctu-owner.sh <fresh auth dir>' >&2; exit 2; }
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the frozen operator, not root.' >&2; exit 2; }
[ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_TRUST_ROOT:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_BOUNDARY:-}" ] || { echo 'STOP: test-only CTu governance seam is forbidden in the live runner.' >&2; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)
REPO=PIN_MERGED_MAIN_WORKTREE
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
UNIT_SOURCE=$APP/deploy/aegis-idea3-core.service.example
AUTH=$AUTH_DIR/authorization-CTu.txt
K3=$AUTH_DIR/k3-CTu.txt
. "$P4/p4-ctu-run-lib.sh"
ctu_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || { echo CTU_OPERATOR_IDENTITY_INVALID >&2; exit 2; }
for f in "$AUTH" "$K3"; do
  [ -f "$f" ] || exit 1
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
EVID=PIN_EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-ctu-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/ctu-work; PRE=$EVID/pre-root; POST=$EVID/post-root; RB=$EVID/rb-root
mkdir -m 700 "$EVID"
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh"; }
compare() {
  sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$2" ALLOW_LISTENERS_FILE="$P4/stages/CTu/allow-listeners.txt" bash "$P4/p4-compare.sh" "$3" "$4" > "$5"
  grep -qx 'PRESERVATION_S10=PASS' "$5" && grep -qx 'COMPARE_RESULT=PASS' "$5"
}
rollback_flow() {
  local reason=$1 out
  [ "${ROLLBACK_DONE:-0}" = 0 ] || return 1
  ROLLBACK_DONE=1
  if ! out=$(sudo env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_UNIT_SOURCE="$UNIT_SOURCE" bash "$P4/stages/CTu/rollback.sh" 2>&1); then
    printf '%s\nCTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=%s\n' "$out" "$reason" >&2
    return 1
  fi
  grep -qx 'CTU_ROLLBACK=PASS' <<<"$out" || return 1
  if ! capture "$RB" ctu-rb; then echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=RB_CAPTURE' >&2; return 1; fi
  if ! compare "$PRE" "$P4/stages/CTu/allow-keys-rollback.txt" "$PRE" "$RB" "$EVID/compare-pre-rb.txt"; then echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=PRE_RB_COMPARE' >&2; return 1; fi
  printf 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_RERUN_ALLOWED=NO CTU_ROLLBACK=PASS CTU_RB_CAPTURE=COMPLETE CTU_PRE_RB_COMPARE=PASS reason=%s\n' "$reason" >&2
  return 0
}
post_fail() {
  local reason=$1
  if [ "${CONSUMED:-0}" = 1 ]; then rollback_flow "$reason" || true; fi
  echo "CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=${CONSUMED:-0} reason=$reason" >&2
  exit 1
}
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
if ! ctu_consume_attempt "$WORK" "$DEVICE_ID" "$RUNTIME_VERIFY"; then
  if [ "$CTU_MARKER_CREATED" = 1 ]; then
    CONSUMED=1; post_fail MARKER_DURABILITY
  fi
  echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING' >&2
  exit 1
fi
CONSUMED=1
if ! sudo env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_UNIT_SOURCE="$UNIT_SOURCE" bash "$P4/stages/CTu/apply.sh"; then post_fail APPLY; fi
if ! capture "$POST" ctu-post; then post_fail POST_CAPTURE; fi
if ! compare "$PRE" "$P4/stages/CTu/allow-keys.txt" "$PRE" "$POST" "$EVID/compare-pre-post.txt"; then post_fail COMPARE_S10; fi
. "$P4/p4-l7u-run-lib.sh"
if ! l7u_secret_scan "$EVID" /usr/bin/python3; then post_fail SECRET_SCAN; fi
if ! sudo env AEGIS_CTU_UNIT_SOURCE="$UNIT_SOURCE" AEGIS_CTU_PRE_CORE_PID="$CORE_PRE_PID" AEGIS_CTU_PRE_CORE_START="$CORE_PRE_START" AEGIS_CTU_PRE_CORE_NRESTARTS="$CORE_PRE_NRESTARTS" AEGIS_CTU_PRE_STATUS_UPDATED_AT="$STATUS_PRE_UPDATED_AT" AEGIS_CTU_DEVICE_ID="$DEVICE_ID" AEGIS_CTU_PRE_DETECTOR_PID="$DETECTOR_PRE_PID" AEGIS_CTU_PRE_DETECTOR_START="$DETECTOR_PRE_START" AEGIS_CTU_PRE_DETECTOR_INVOCATION="$DETECTOR_PRE_INVOCATION" AEGIS_CTU_PRE_DETECTOR_NRESTARTS="$DETECTOR_PRE_NRESTARTS" AEGIS_CTU_PRE_DETECTOR_MONOTONIC="$DETECTOR_PRE_MONOTONIC" bash "$P4/stages/CTu/verify.sh"; then post_fail VERIFY; fi
printf 'CTU_LIVE=PASS RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO\n'
