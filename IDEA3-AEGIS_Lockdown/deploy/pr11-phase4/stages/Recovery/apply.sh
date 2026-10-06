#!/usr/bin/env bash
# Recovery handler. Root executes only the immutable verifier snapshot and the
# Core AF_UNIX client; it never runs operator-owned files from /home.
set -Eeuo pipefail
fail() { printf 'RECOVERY_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ "${AEGIS_RCVSTAGE_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
WORK=${AEGIS_RCVSTAGE_WORK_DIR:-}
APP=${AEGIS_RCVSTAGE_APP_DIR:-}
PY=${AEGIS_PYTHON_BIN:-python3}
MARKER=${AEGIS_RCVSTAGE_ATTEMPT_MARKER:-}
[ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
[ -d "$APP" ] && [ ! -L "$APP" ] || fail IMMUTABLE_VERIFIER_REQUIRED
[ -n "$MARKER" ] || fail ATTEMPT_MARKER_REQUIRED
mkdir -p "$WORK/steps"
run() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.recovery_stage "$@"; }
step=${AEGIS_RCVSTAGE_STEP:-}
case "$step" in
  PREGATE) run status --steps-dir "$WORK/steps"; run probe-pre --steps-dir "$WORK/steps" ;;
  ISOLATE) run socket-check; run consume-attempt --marker "$MARKER"
    run isolate --steps-dir "$WORK/steps"; run probe-post-isolate --steps-dir "$WORK/steps" ;;
  RESTORE_STATUS) run restore-status --steps-dir "$WORK/steps" --wait-seconds 300 ;;
  CLOSE) run probe-final --steps-dir "$WORK/steps"; run close --steps-dir "$WORK/steps" --summary 'Recovery completed through the Core normal-path closure.' ;;
  VERIFY) run final-verify --audit-db "$AEGIS_RCVSTAGE_AUDIT_DB" --protocol-db "$AEGIS_RCVSTAGE_PROTOCOL_DB" --steps-dir "$WORK/steps" --baseline "$WORK/recovery-baseline.json" --out "$WORK/recovery-result.json" ;;
  *) fail STEP_INVALID ;;
esac
printf 'RECOVERY_APPLY=COMPLETE\nRECOVERY_R2_R8_EXECUTED=YES\nR1B_RESULT=FAIL_IMMUTABLE\nR1BV_RESULT=PASS\n'
