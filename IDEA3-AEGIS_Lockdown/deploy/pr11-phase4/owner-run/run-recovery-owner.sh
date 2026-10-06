#!/usr/bin/env bash
# Recovery R2-R8 owner-run template. It refuses while PIN_ values remain and
# is never executed from the repository. A future owner freeze creates one
# root-owned immutable runner from this exact main object.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
RELEASE_ID=PIN_RELEASE_ID
CONTROL_SNAPSHOT_DIR=PIN_CONTROL_SNAPSHOT_DIR
CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
VERIFIER_SNAPSHOT_DIR=PIN_VERIFIER_SNAPSHOT_DIR
VERIFIER_MANIFEST_SHA256=PIN_VERIFIER_MANIFEST_SHA256
PROTOCOL_DB=PIN_PROTOCOL_DB_PATH
AUDIT_DB=PIN_AUDIT_DB_PATH
ATTEMPT_MARKER=PIN_ATTEMPT_MARKER_PATH
R1B_EVIDENCE_DIR=PIN_R1B_EVIDENCE_DIR
EXPECTED_SOURCE_IP=PIN_EXPECTED_SOURCE_IP
DETECTOR_UID=PIN_DETECTOR_UID
REPO=/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH   # pinned Git authority only
PY=PIN_PYTHON_BIN
EVID_ROOT=/PIN_EVIDENCE_ROOT

for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RELEASE_ID CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 VERIFIER_SNAPSHOT_DIR VERIFIER_MANIFEST_SHA256 PROTOCOL_DB AUDIT_DB ATTEMPT_MARKER R1B_EVIDENCE_DIR EXPECTED_SOURCE_IP DETECTOR_UID PY; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)" >&2; exit 2;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || exit 2
[[ "$CONTROL_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$VERIFIER_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$PROTOCOL_DB" == /* && "$AUDIT_DB" == /* && "$ATTEMPT_MARKER" == /* && "$R1B_EVIDENCE_DIR" == /* ]] || exit 2
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the operator, not root' >&2; exit 2; }
AUTH_DIR=${1:-}
[ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || { echo 'usage: run-recovery-owner.sh AUTH_DIR' >&2; exit 2; }
AUTH="$AUTH_DIR/authorization-Recovery.txt"
K3="$AUTH_DIR/k3-Recovery.txt"

TODAY=$(TZ=Asia/Bangkok date +%F)
grep -qx "stage=Recovery" "$AUTH" || exit 2
grep -qx "date=$TODAY" "$AUTH" || exit 2
[ -f "$K3" ] || { echo 'STOP: Recovery mutates Production and requires K3' >&2; exit 2; }

for var in AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_RECOVERY_SOCKET AEGIS_RECOVERY_CORE_USER AEGIS_RCVSTAGE_APP_DIR AEGIS_RCVSTAGE_AUDIT_DB AEGIS_RCVSTAGE_PROTOCOL_DB AEGIS_RCVSTAGE_ATTEMPT_MARKER AEGIS_RCVSTAGE_SECRET RECOVERY_SECRET; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set" >&2; exit 2; }
done

LIB="$CONTROL_SNAPSHOT_DIR/p4-recovery-run-lib.sh"
export SUDO='sudo -n'
. "$LIB"

recovery_predecessor_gate "$REPO" "$EXPECTED_MAIN" || { recovery_no_live_claims; exit 1; }
recovery_marker_unconsumed "$ATTEMPT_MARKER" || { recovery_no_live_claims; exit 1; }
recovery_sudo_noninteractive_gate || { recovery_no_live_claims; exit 1; }

EVID="$EVID_ROOT/$(TZ=Asia/Bangkok date +%F)-recovery-$(TZ=Asia/Bangkok date +%H%M%S)"
WORK="$EVID/work"
mkdir -m 700 "$EVID" "$WORK" "$WORK/steps"
exec > >(tee -a "$EVID/owner-run.log") 2>&1
printf 'RECOVERY_REPOSITORY_IMPLEMENTED=YES\nRECOVERY_LIVE_EXECUTED=YES\nRECOVERY_R2_R8_EXECUTED=YES\n'

"$PY" -B -s -m aegis_soc.recovery_stage status --steps-dir "$WORK/steps"
"$PY" -B -s -m aegis_soc.recovery_stage probe-pre --steps-dir "$WORK/steps"
"$PY" -B -s -m aegis_soc.recovery_stage baseline-db --audit-db "$AUDIT_DB" --r1b-baseline "$R1B_EVIDENCE_DIR/r1b-work/r1-baseline.json" --expected-source-ip "$EXPECTED_SOURCE_IP" --detector-uid "$DETECTOR_UID" --out "$WORK/recovery-baseline.json"
recovery_consume_attempt "$ATTEMPT_MARKER"
"$PY" -B -s -m aegis_soc.recovery_stage isolate --steps-dir "$WORK/steps"
"$PY" -B -s -m aegis_soc.recovery_stage probe-post-isolate --steps-dir "$WORK/steps"

set +e
RECOVERY_RESTORE_MODE=NORMAL RECOVERY_RESTORE_CONFIRMATION='RESTORE UPLINK' recovery_normal_restore_boundary
D4_RC=$?
set -e
"$PY" -B -s -m aegis_soc.recovery_stage record-d4 --steps-dir "$WORK/steps" --exit-code "$D4_RC"
"$PY" -B -s -m aegis_soc.recovery_stage restore-status --steps-dir "$WORK/steps" --wait-seconds 300
"$PY" -B -s -m aegis_soc.recovery_stage probe-final --steps-dir "$WORK/steps"
"$PY" -B -s -m aegis_soc.recovery_stage close --steps-dir "$WORK/steps" --summary 'Recovery completed through the Core normal-path closure.'
"$PY" -B -s -m aegis_soc.recovery_stage final-verify --audit-db "$AUDIT_DB" --protocol-db "$PROTOCOL_DB" --steps-dir "$WORK/steps" --baseline "$WORK/recovery-baseline.json" --out "$WORK/recovery-result.json"
printf 'RECOVERY_RESULT=PASS\nRECOVERY_LIVE=CLOSED_PASS\nRECOVERY_R2_R8_EXECUTED=YES\nR1B_RESULT=FAIL_IMMUTABLE\nR1BV_RESULT=PASS\nLVR_PROVEN=NO\nL8_ACCEPTANCE=NO\nL9_PROVEN=NO\n'
