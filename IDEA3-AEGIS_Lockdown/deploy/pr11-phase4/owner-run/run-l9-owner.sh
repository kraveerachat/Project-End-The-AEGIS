#!/usr/bin/env bash
# Frozen post-merge L9 owner runner TEMPLATE (LIVE-CAPABLE, READ-ONLY OBSERVATION).
# It is intentionally unpinned and refuses to run as committed. A frozen copy is produced ONLY by
# deploy/pr11-phase4/p4-l9-freeze.py from the exact reviewed template of the exact merged main, with
# the pins below as the only differences. L9 mutates nothing: it observes the running Core's own
# authenticated evidence for a bounded window (p4-l9-live-observe.py) after the canonical L8 PASS.
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
DEVICE_ID=PIN_DEVICE_ID
WINDOW_SECONDS=PIN_WINDOW_SECONDS
MERGED_MAIN_WORKTREE=PIN_MERGED_MAIN_WORKTREE
EVIDENCE_ROOT=PIN_EVIDENCE_ROOT
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID DEVICE_ID WINDOW_SECONDS MERGED_MAIN_WORKTREE EVIDENCE_ROOT; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$DEVICE_ID" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ ]] || exit 2
[[ "$WINDOW_SECONDS" =~ ^[0-9]{3}$ ]] && [ "$WINDOW_SECONDS" -ge 120 ] && [ "$WINDOW_SECONDS" -le 900 ] || exit 2
REPO=$MERGED_MAIN_WORKTREE
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] && [ "$(readlink -f -- "$AUTH_DIR")" = "$AUTH_DIR" ] || { echo 'usage: run-l9-owner.sh <fresh auth dir>' >&2; exit 2; }
[ -n "$REPO" ] && [ "$(readlink -f -- "$REPO")" = "$REPO" ] && [ -d "$REPO/.git" ] || exit 2
[ "${EVIDENCE_ROOT#/}" != "$EVIDENCE_ROOT" ] && [[ "$EVIDENCE_ROOT" != *..* ]] && { [ ! -e "$EVIDENCE_ROOT" ] || [ ! -L "$EVIDENCE_ROOT" ] && [ "$(readlink -f -- "$EVIDENCE_ROOT")" = "$EVIDENCE_ROOT" ]; } || exit 2
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the frozen operator, not root.' >&2; exit 2; }
[ "${SUDO+x}" != x ] || { echo 'STOP: environment override SUDO is forbidden.' >&2; exit 2; }
[ -z "$(env | sed -n 's/^GIT_[^=]*=.*/x/p')" ] || { echo 'STOP: Git environment override is forbidden.' >&2; exit 2; }
[ -z "$(env | sed -n 's/^\(AEGIS_L9_TEST_ONLY_\|RECOVERY_TEST_ONLY_\|AEGIS_L9_\)[A-Z_]*=.*/x/p')" ] || { echo 'STOP: test-only or caller-supplied L9 governance variables are forbidden in the live runner.' >&2; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
AUTH=$AUTH_DIR/authorization-L9.txt
K3=$AUTH_DIR/k3-L9.txt
RUNNER_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
RUNNER_SHA256=$(sha256sum -- "$RUNNER_PATH" | cut -d' ' -f1)
. "$P4/p4-l9-run-lib.sh"
l9_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || { echo L9_OPERATOR_IDENTITY_INVALID >&2; exit 2; }
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || exit 1
[ -z "$(git -C "$REPO" status --porcelain)" ] || exit 1
ORIGIN_MAIN=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
[ "$ORIGIN_MAIN" = "$EXPECTED_MAIN" ] || exit 1
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$P4/stages/L9/$f" ] || exit 1; done
# 1. exact frozen runner + canonical L8 PASS predecessor, both from exact-main Git objects (the freeze tool proves ownership too)
freeze_out=$(/usr/bin/python3 -I "$P4/p4-l9-freeze.py" verify --repo "$REPO" --main "$EXPECTED_MAIN" --runner "$RUNNER_PATH") || { echo L9_FROZEN_RUNNER_NOT_PROVEN >&2; exit 1; }
for line in RUNNER_TEMPLATE_AUTHORITY=PASS RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS RUNNER_ROOT_OWNED=PASS RUNNER_NONWRITABLE=PASS L8_PREDECESSOR=PASS "RUNNER_SHA256=$RUNNER_SHA256"; do
  grep -qx "$line" <<<"$freeze_out" || { echo "L9_FROZEN_RUNNER_NOT_PROVEN ($line)" >&2; exit 1; }
done
L8_MAIN=$(sed -n 's/^L8_EXECUTION_MAIN=\([0-9a-f]\{40\}\)$/\1/p' <<<"$freeze_out")
[[ "$L8_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 1
gate8=$(/usr/bin/python3 -I "$P4/p4-l9-gates.py" l8-predecessor --repo "$REPO" --main "$EXPECTED_MAIN") || { echo L9_L8_PREDECESSOR_REFUSED >&2; exit 1; }
grep -qx "L8_EXECUTION_MAIN=$L8_MAIN" <<<"$gate8" && grep -qx 'L9_GATE=PASS' <<<"$gate8" || exit 1
# 2. fresh, exact Authorization / K3 (no extra field of any other stage; bound to main, this runner and the L8 predecessor)
[ -f "$K3" ] && [ ! -L "$K3" ] || exit 1
grep -qx 'stage=L9' "$K3" && grep -qx "date=$TODAY" "$K3" || exit 1
l9_authorization_gate "$AUTH" "$EXPECTED_MAIN" "$RUNNER_SHA256" "$L8_MAIN" "$TODAY" || exit 1
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L9 --mode live --authorization "$AUTH" --k3 "$K3") || exit 1
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || exit 1
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || exit 1
grep -qx 'ROLLBACK_HANDLER=REGISTERED' <<<"$gate_out" || exit 1
# 3. one-shot, not consumed, privileged phases cannot stall on a password prompt
l9_marker_unconsumed || exit 1
sudo -n true 2>/dev/null || { echo L9_SUDO_CREDENTIAL_NOT_ACTIVE >&2; exit 1; }
EVID=$EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-l9-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/l9-work; EVIDENCE=$EVID/l9-evidence; PRE=$EVID/pre-root; POST=$EVID/post-root
RUN_ID=l9-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
mkdir -m 700 "$EVID" || exit 1
BUNDLE=$WORK/bundle
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$BUNDLE/p4-l0-capture.sh"; }
compare() {
  sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$BUNDLE/stages/L9/allow-keys.txt" ALLOW_LISTENERS_FILE="$BUNDLE/stages/L9/allow-listeners.txt" bash "$BUNDLE/p4-compare.sh" "$1" "$2" > "$3"
  grep -qx 'PRESERVATION_S10=PASS' "$3" && grep -qx 'COMPARE_RESULT=PASS' "$3"
}
post_fail() {
  local reason=$1 consumed=NO
  trap - ERR INT TERM HUP
  TERMINAL=1
  if sudo test -e "$(l9_marker_path)" && ! sudo test -L "$(l9_marker_path)"; then consumed=YES; fi
  # L9 observed and changed nothing, so there is nothing to roll back: the stage rollback is the idempotent no-op (never stops the Core).
  if [ -d "$BUNDLE" ]; then sudo env AEGIS_L9_BACKEND=live AEGIS_L9_WORK_DIR="$WORK" AEGIS_L9_EVIDENCE_DIR="$EVIDENCE" bash "$BUNDLE/stages/L9/rollback.sh" >/dev/null 2>&1 || true; fi
  if [ -d "$BUNDLE" ]; then source "$BUNDLE/p4-l7u-run-lib.sh"; l7u_secret_scan "$EVID" /usr/bin/python3 >/dev/null 2>&1 || true; fi
  printf 'L9_RESULT=FAIL_IMMUTABLE\nL9_ATTEMPT_CONSUMED=%s\nL9_RERUN_ALLOWED=NO\nL9_FAILURE_REASON=%s\nL9_ROLLBACK=NOT_REQUIRED_NO_MUTATION\n' "$consumed" "$reason" > "$EVID/terminal-result" 2>/dev/null || true
  sudo sync -- "$EVID/terminal-result" "$EVID" 2>/dev/null || true
  echo "L9_RESULT=FAIL_IMMUTABLE L9_ATTEMPT_CONSUMED=$consumed L9_RERUN_ALLOWED=NO reason=$reason" >&2
  exit 1
}
handle_signal() { post_fail "SIGNAL_$1"; }
exit_handler() { local rc=$?; [ "${TERMINAL:-0}" = 1 ] || [ "$rc" = 0 ] || post_fail "EXIT_$rc"; }
CONSUMED=0; L9_MARKER_CREATED=0; TERMINAL=0
trap 'exit_handler' EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal HUP' HUP
if ! l9_prepare_bundle "$REPO" "$P4" "$BUNDLE" "$EXPECTED_MAIN"; then post_fail L9_BUNDLE; fi
source "$BUNDLE/p4-l7u-run-lib.sh"
if ! capture "$PRE" l9-pre; then post_fail PRE_CAPTURE; fi
l9_marker_unconsumed || post_fail MARKER_PRECHECK
if ! l9_consume_attempt "$WORK" "$DEVICE_ID" "$RUN_ID" "$BUNDLE/p4-l9-live-observe.py"; then
  if [ "$L9_MARKER_CREATED" = 1 ]; then CONSUMED=1; post_fail MARKER_DURABILITY; fi
  echo 'L9_RESULT=FAIL_IMMUTABLE L9_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING' >&2
  TERMINAL=1; exit 1
fi
CONSUMED=1
if ! sudo env AEGIS_L9_BACKEND=live AEGIS_L9_LIVE_AUTHORIZED=YES AEGIS_L9_WORK_DIR="$WORK" AEGIS_L9_EVIDENCE_DIR="$EVIDENCE" AEGIS_L9_DEVICE_ID="$DEVICE_ID" AEGIS_L9_RUN_ID="$RUN_ID" AEGIS_L9_WINDOW_SECONDS="$WINDOW_SECONDS" AEGIS_L9_MARKER="$(l9_marker_path)" bash "$BUNDLE/stages/L9/apply.sh"; then post_fail APPLY_OBSERVATION; fi
if ! capture "$POST" l9-post; then post_fail POST_CAPTURE; fi
if ! compare "$PRE" "$POST" "$EVID/compare-pre-post.txt"; then post_fail COMPARE_S10; fi
if ! l7u_secret_scan "$EVID" /usr/bin/python3; then post_fail SECRET_SCAN; fi
if ! sudo env AEGIS_L9_BACKEND=live AEGIS_L9_WORK_DIR="$WORK" AEGIS_L9_EVIDENCE_DIR="$EVIDENCE" bash "$BUNDLE/stages/L9/verify.sh"; then post_fail VERIFY; fi
BUNDLE_SHA256=$(sudo sha256sum -- "$EVIDENCE/l9-live-evidence.json" | cut -d' ' -f1)
[[ "$BUNDLE_SHA256" =~ ^[0-9a-f]{64}$ ]] || post_fail EVIDENCE_DIGEST
if ! l9_record_success "$EXPECTED_MAIN" "$L8_MAIN" "$BUNDLE_SHA256" "$EVID"; then post_fail L9_CLOSEOUT; fi
TERMINAL=1
printf 'L9_LIVE=CLOSED_PASS\nL9_LIVE_EXECUTED=YES\nL9_RESULT=PASS\nL9_ATTEMPT_CONSUMED=YES\nL9_RERUN_ALLOWED=NO\nL9_EXPECTED_MAIN=%s\nL8_EXECUTION_MAIN=%s\nL9_EVIDENCE_BUNDLE_SHA256=%s\nL9_EVIDENCE_ROOT=%s\nL9_FAILURE_RESULT=NONE\n' "$EXPECTED_MAIN" "$L8_MAIN" "$BUNDLE_SHA256" "$EVID" > "$EVID/terminal-result"
sync -- "$EVID/terminal-result" "$EVID"
printf 'L9_LIVE=PASS L9_COMMANDS_EMITTED=0 L9_RELAY_ACTUATION=NONE\n'
