#!/bin/sh
# Reviewed CTv owner-run template. A frozen copy is produced by
# ctv_runner_freeze.py; only the listed non-circular pins are substituted.
if [ "${AEGIS_CTV_CLEAN_START:-}" != YES ]; then
  exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_CTV_CLEAN_START=YES /bin/bash --noprofile --norc "$0" "$@"
fi
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
DEVICE_ID=PIN_DEVICE_ID
CTV_IS_CTU_RETRY=NO
CTV_NEW_ONE_ATTEMPT_STAGE=YES
CTV_ONE_ATTEMPT=YES
CTV_NO_RETRY=YES
CTV_ATTEMPT_CONSUMED=NO
CTV_PRODUCTION_MUTATION=NO

usage() { printf '%s\n' 'usage: run-ctv-owner.FROZEN.sh AUTH_DIR --rehearse|--live [options]' >&2; }
AUTH_DIR=${1:-}; MODE=${2:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || { usage; exit 2; }
case "$MODE" in --rehearse|--live) ;; *) usage; exit 2 ;; esac
shift 2
WORK_DIR=${EVIDENCE_ROOT}/ctv-work
CANONICAL_DIR=/var/lib/aegis-idea3-governance
BUNDLE_DIR=${EVIDENCE_ROOT}/ctv-bundle
CONTROL_DIR=${EVIDENCE_ROOT}/ctv-control
FIXTURE_ROOT=${EVIDENCE_ROOT}/ctv-fixture
UNIT_SOURCE=$MERGED_MAIN_WORKTREE/IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
RECEIPT_RELATIVE=Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-08_000259_music_idea3-ctv-successor.md
HERMETIC=NO
FAIL_PHASE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --work-dir) [ "$HERMETIC" = YES ] || { usage; exit 2; }; WORK_DIR=$2; shift 2;; --canonical-dir) [ "$HERMETIC" = YES ] || { usage; exit 2; }; CANONICAL_DIR=$2; shift 2;;
    --bundle-dir) [ "$HERMETIC" = YES ] || { usage; exit 2; }; BUNDLE_DIR=$2; shift 2;; --control-dir) [ "$HERMETIC" = YES ] || { usage; exit 2; }; CONTROL_DIR=$2; shift 2;;
    --fixture-root) [ "$HERMETIC" = YES ] || { usage; exit 2; }; FIXTURE_ROOT=$2; shift 2;; --unit-source) [ "$HERMETIC" = YES ] || { usage; exit 2; }; UNIT_SOURCE=$2; shift 2;;
    --unit-dest) [ "$HERMETIC" = YES ] || { usage; exit 2; }; UNIT_DEST=$2; shift 2;; --receipt-relative) [ "$HERMETIC" = YES ] || { usage; exit 2; }; RECEIPT_RELATIVE=$2; shift 2;;
    --fail-phase) [ "$HERMETIC" = YES ] || { usage; exit 2; }; FAIL_PHASE=$2; shift 2;;
    --hermetic) HERMETIC=YES; shift;; *) usage; exit 2;;
  esac
done
REPO=$MERGED_MAIN_WORKTREE
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
CTV_LIB=$CONTROL_DIR/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh
[ -f "$CTV_LIB" ] || CTV_LIB=$CONTROL_DIR/p4-ctv-run-lib.sh
[ -f "$CTV_LIB" ] && [ ! -L "$CTV_LIB" ] || { echo 'STOP: CTv control snapshot is missing.' >&2; exit 1; }
. "$CTV_LIB"
# CTV_PRECONSUME_REHEARSAL=PASS is emitted only after the real rehearsal below.
CTV_CANONICAL_DIR=$CANONICAL_DIR
CTV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES
CTV_TEST_ONLY_CANONICAL_DIR=$CANONICAL_DIR
export CTV_CANONICAL_DIR CTV_TEST_ONLY_CANONICAL_DIR_ENABLED CTV_TEST_ONLY_CANONICAL_DIR
if [ "$HERMETIC" = YES ]; then CTV_SUDO=; CTV_TEST_MODE=YES; CTV_UNIT_DEST=$UNIT_DEST; CTV_CORE_RESTARTS_FILE=$WORK_DIR/core-restarts; export CTV_SUDO CTV_TEST_MODE CTV_UNIT_DEST CTV_CORE_RESTARTS_FILE; fi
CTV_FAIL_PHASE=$FAIL_PHASE
export CTV_FAIL_PHASE
RUNNER_SHA256=$(sha256sum -- "$0" | cut -d' ' -f1)
TEMPLATE_SHA256=$(ctv_git -C "$REPO" show "$EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh" | sha256sum | cut -d' ' -f1)
AUTH="$AUTH_DIR/authorization-CTv.txt"; K3="$AUTH_DIR/k3-CTv.txt"
[ -f "$AUTH" ] && [ -f "$K3" ] && [ ! -L "$AUTH" ] && [ ! -L "$K3" ] || { echo 'STOP: fresh CTv Authorization/K3 required.' >&2; exit 2; }
grep -qx 'stage=CTv' "$AUTH" && grep -qx 'stage=CTv' "$K3" || exit 2
grep -qx "expected_main=$EXPECTED_MAIN" "$AUTH" && grep -qx "expected_main=$EXPECTED_MAIN" "$K3" || exit 2
grep -qx "runner_sha256=$RUNNER_SHA256" "$AUTH" && grep -qx "runner_sha256=$RUNNER_SHA256" "$K3" || exit 2
grep -qx "runner_template_sha256=$TEMPLATE_SHA256" "$AUTH" && grep -qx "runner_template_sha256=$TEMPLATE_SHA256" "$K3" || exit 2
CTV_RUNNER_TEMPLATE_SHA256=$TEMPLATE_SHA256
CTV_FROZEN_RUNNER_SHA256=$RUNNER_SHA256
CTV_BUNDLE_MANIFEST_SHA256=$(sha256sum -- "$BUNDLE_DIR/CTV-BUNDLE-SHA256SUMS" 2>/dev/null | cut -d' ' -f1 || true)
CTV_CONTROL_MANIFEST_SHA256=$(sha256sum -- "$CONTROL_DIR/CTV-CONTROL-SHA256SUMS" 2>/dev/null | cut -d' ' -f1 || true)
export CTV_RUNNER_TEMPLATE_SHA256 CTV_FROZEN_RUNNER_SHA256 CTV_BUNDLE_MANIFEST_SHA256 CTV_CONTROL_MANIFEST_SHA256
CTV_ATTEMPT_CONSUMED=NO
if ! ctv_preconsume_rehearsal "$REPO" "$EXPECTED_MAIN" "$AUTH" "$K3" "$CANONICAL_DIR" "$BUNDLE_DIR" "$CONTROL_DIR" "$0" "$RUNNER_SHA256" "$TEMPLATE_SHA256" "$UNIT_SOURCE" "$UNIT_SHA256" "$FIXTURE_ROOT"; then
  echo 'CTV_PRECONSUME_REHEARSAL=FAIL' >&2; exit 1
fi
[ "$MODE" = --rehearse ] && { printf 'CTV_LIVE_EXECUTED=NO\nCTV_ATTEMPT_CONSUMED=NO\nPRODUCTION_MUTATION_PERFORMED=NO\n'; exit 0; }
ctv_marker_unconsumed || exit 1
ctv_prepare_work_dir "$WORK_DIR"
ctv_prepare_no_mutation_journal "$WORK_DIR/journal"
ctv_capture_state "$WORK_DIR/pre" "$FIXTURE_ROOT" PRE || exit 1
ctv_live_abort() {
  local rc=$?
  trap - EXIT
  if [ -e "$CANONICAL_DIR/CTV-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -e "$CANONICAL_DIR/CTV-GLOBAL-CLOSEOUT-PASS" ] && [ ! -e "$CANONICAL_DIR/CTV-GLOBAL-CLOSEOUT-FAIL" ]; then
    ctv_rollback_governed "$WORK_DIR/journal" || true
    ctv_record_failure APPLY YES || true
  fi
  exit "$rc"
}
trap ctv_live_abort EXIT
ctv_consume_attempt "$WORK_DIR" "$RUNNER_SHA256" "$TEMPLATE_SHA256" "$CTV_BUNDLE_MANIFEST_SHA256" "$CTV_CONTROL_MANIFEST_SHA256"
CTV_ATTEMPT_CONSUMED=YES
ctv_failpoint after-marker || exit 1
ctv_establish_consumed_no_mutation_journal "$WORK_DIR/journal"
ctv_failpoint consumed-journal || exit 1
export CTV_LIVE_AUTHORIZED=YES
if ! ctv_apply_governed "$WORK_DIR/journal" "$UNIT_SOURCE" "$UNIT_DEST" "$UNIT_SHA256"; then
  exit 1
fi
ctv_journal_phase "$WORK_DIR/journal" apply-verified
ctv_failpoint post-runtime-verify || exit 1
ctv_capture_state "$WORK_DIR/post" "$FIXTURE_ROOT" POST || exit 1
ctv_failpoint post-capture || exit 1
ctv_compare_preservation "$WORK_DIR/pre" "$WORK_DIR/post" || exit 1
ctv_failpoint preservation-compare || exit 1
ctv_runtime_verify "$FIXTURE_ROOT" || exit 1
ctv_failpoint detector-preservation || exit 1
ctv_evidence_manifest "$WORK_DIR" || exit 1
ctv_failpoint evidence-manifest || exit 1
ctv_failpoint pass-closeout || exit 1
ctv_record_success "$EXPECTED_MAIN" "$UNIT_SHA256" "$RECEIPT_RELATIVE" "$RUNNER_SHA256" "$TEMPLATE_SHA256" "$CTV_BUNDLE_MANIFEST_SHA256" "$CTV_CONTROL_MANIFEST_SHA256"
trap - EXIT
printf 'CTV_RESULT=CLOSED_PASS\nCTV_LIVE_EXECUTED=YES\nCTV_ATTEMPT_CONSUMED=YES\nCTV_PRODUCTION_RUNTIME_MUTATION_OCCURRED=YES\n'
