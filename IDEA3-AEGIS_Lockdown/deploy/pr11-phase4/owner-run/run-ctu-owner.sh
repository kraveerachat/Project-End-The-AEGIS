#!/usr/bin/env bash
# CTu is a NEW successor, not an L7/F1u/R1Du/RRu retry. This repository
# template refuses until a post-merge owner freeze fills every PIN_* value.
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
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the frozen operator, not root.' >&2; exit 2; }
AUTH_DIR=${1:-}
[ -d "$AUTH_DIR" ] || { echo 'usage: run-ctu-owner.sh <fresh auth dir>' >&2; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)
REPO=PIN_MERGED_MAIN_WORKTREE
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
UNIT_SOURCE=$APP/deploy/aegis-idea3-core.service.example
AUTH=$AUTH_DIR/authorization-CTu.txt
K3=$AUTH_DIR/k3-CTu.txt
ATTEMPT_MARKER=$AUTH_DIR/CTU-GLOBAL-ATTEMPT-CONSUMED
for f in "$AUTH" "$K3"; do
  [ -f "$f" ] || exit 1
  grep -qx "stage=CTu" "$f" || exit 1
  grep -qx "date=$TODAY" "$f" || exit 1
done
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || exit 1
[ -z "$(git -C "$REPO" status --porcelain)" ] || exit 1
[ "$(sha256sum "$UNIT_SOURCE" | cut -d' ' -f1)" = "$UNIT_SHA256" ] || exit 1
[ ! -e "$ATTEMPT_MARKER" ] || exit 1
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$P4/stages/CTu/$f" ] || exit 1; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || exit 1
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || exit 1
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || exit 1
grep -qx 'ROLLBACK_HANDLER=REGISTERED' <<<"$gate_out" || exit 1
ORIGIN_MAIN=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
[ "$ORIGIN_MAIN" = "$EXPECTED_MAIN" ] || exit 1
EVID=PIN_EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-ctu-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/ctu-work
PRE=$EVID/pre-root
POST=$EVID/post-root
mkdir -m 700 "$EVID"
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh"; }
compare() { sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$P4/stages/CTu/allow-keys.txt" ALLOW_LISTENERS_FILE="$P4/stages/CTu/allow-listeners.txt" bash "$P4/p4-compare.sh" "$1" "$2" > "$3"; grep -qx 'PRESERVATION_S10=PASS' "$3"; grep -qx 'COMPARE_RESULT=PASS' "$3"; }
capture "$PRE" ctu-pre
# Consume the unique marker immediately before the first Production mutation.
mkdir "$ATTEMPT_MARKER"
printf 'stage=CTu\nmain=%s\nconsumed_at=%s\n' "$EXPECTED_MAIN" "$(date -u +%FT%TZ)" > "$ATTEMPT_MARKER/record"
sudo env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_UNIT_SOURCE="$UNIT_SOURCE" bash "$P4/stages/CTu/apply.sh"
capture "$POST" ctu-post
compare "$PRE" "$POST" "$EVID/compare-pre-post.txt"
source "$P4/p4-l7u-run-lib.sh"
l7u_secret_scan "$EVID" /usr/bin/python3
sudo env AEGIS_CTU_UNIT_SOURCE="$UNIT_SOURCE" AEGIS_CTU_PRE_CORE_PID=PIN_PRE_CORE_PID AEGIS_CTU_PRE_CORE_START=PIN_PRE_CORE_START \
  AEGIS_CTU_AUTHENTICATED_STATUS=PIN_AUTHENTICATED_STATUS AEGIS_CTU_TRUSTED_CLOCK=PIN_TRUSTED_CLOCK \
  AEGIS_CTU_TIME_TRUST=PIN_TIME_TRUST AEGIS_CTU_DEVICE=PIN_DEVICE AEGIS_CTU_UPLINK=PIN_UPLINK \
  AEGIS_CTU_BROKER=PIN_BROKER AEGIS_CTU_RECOVERY_MARKER=ABSENT bash "$P4/stages/CTu/verify.sh"
printf 'CTU_LIVE=PASS RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO\n'
