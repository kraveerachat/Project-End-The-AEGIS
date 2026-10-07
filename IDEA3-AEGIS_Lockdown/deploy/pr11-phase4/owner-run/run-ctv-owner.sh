#!/bin/sh
# CTv successor template. A future root-trusted freeze substitutes only the
# listed pins. This template is never a CTu retry and is inert while pinned.
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
CTV_FROZEN_RUNNER_SHA256=PIN_FROZEN_RUNNER_SHA256
CTV_RUNNER_TEMPLATE_SHA256=PIN_RUNNER_TEMPLATE_SHA256
CTV_BUNDLE_MANIFEST_SHA256=PIN_BUNDLE_MANIFEST_SHA256
CTV_CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
CTV_IS_CTU_RETRY=NO
CTV_NEW_ONE_ATTEMPT_STAGE=YES
CTV_ONE_ATTEMPT=YES
CTV_NO_RETRY=YES
CTV_ATTEMPT_CONSUMED=NO
CTV_PRODUCTION_MUTATION=NO
REPO=$MERGED_MAIN_WORKTREE
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || exit 2
[ -f "$AUTH_DIR/authorization-CTv.txt" ] && [ -f "$AUTH_DIR/k3-CTv.txt" ] || { echo 'STOP: fresh CTv Authorization/K3 required.' >&2; exit 2; }
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
. "$P4/p4-ctv-run-lib.sh"
# CTV_PRECONSUME_REHEARSAL=PASS is emitted by the complete read-only path.
ctv_preconsume_rehearsal
printf 'CTV_FROZEN_RUNNER_SHA256=%s\nCTV_RUNNER_TEMPLATE_SHA256=%s\nCTV_BUNDLE_MANIFEST_SHA256=%s\nCTV_CONTROL_MANIFEST_SHA256=%s\n' \
  "$CTV_FROZEN_RUNNER_SHA256" "$CTV_RUNNER_TEMPLATE_SHA256" "$CTV_BUNDLE_MANIFEST_SHA256" "$CTV_CONTROL_MANIFEST_SHA256"
# This boundary is after the complete read-only rehearsal and durable journal
# preflight. It is unreachable in the unpinned repository template.
if [ "${CTV_LIVE_AUTHORIZED:-NO}" != YES ]; then
  printf 'CTV_LIVE_EXECUTED=NO\nCTV_ATTEMPT_CONSUMED=NO\nPRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi
ctv_consume_attempt "${CTV_WORK_DIR:?}" "$CTV_FROZEN_RUNNER_SHA256" "$CTV_RUNNER_TEMPLATE_SHA256" "$CTV_BUNDLE_MANIFEST_SHA256" "$CTV_CONTROL_MANIFEST_SHA256"
ctv_establish_consumed_no_mutation_journal "$CTV_WORK_DIR/journal"
printf 'CTV_ATTEMPT_CONSUMED=YES\n'
