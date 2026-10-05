#!/usr/bin/env bash
# R1A "apply": READ-ONLY capture steps of the real-detector acceptance. R1A owns no Production mutation and generates NO event. It runs the existing,
# read-only r1_acceptance observer (the audit DB is opened mode=ro; systemctl show / journalctl only). The genuine external event is produced by someone
# else, outside this handler. Two steps, selected by AEGIS_R1A_STEP:
#   BASELINE  one PRE record (refuses if an incident is already open); can be taken once per work directory
#   FINAL     the single verifier run over the bounded window; can run ONCE per work directory (no verifier retry, ever)
# Both are guarded by an exclusive (noclobber) step marker in the work directory that is never removed.
set -uo pipefail
fail() { printf 'R1A_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
STEP="${AEGIS_R1A_STEP:-}"
WORK="${AEGIS_R1A_WORK_DIR:-}"
PY="${AEGIS_PYTHON_BIN:-python3}"
APP="${AEGIS_R1A_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_R1A_VERIFIER_MANIFEST_SHA256:-}"
[ "${AEGIS_R1A_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
[ -n "$APP" ] && [ -d "$APP" ] && [ ! -L "$APP" ] && [ -f "$APP/aegis_soc/r1_acceptance.py" ] || fail APP_DIR_INVALID
[[ "$MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]] || fail VERIFIER_MANIFEST_PIN_INVALID
# Root must never execute mutable bytes: re-prove the snapshot IMMEDIATELY before use (manifest digest, every file digest, exact file set, no symlink, nothing writable).
MANIFEST="$APP/R1A-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail VERIFIER_MANIFEST_DRIFT
( cd "$APP" && sha256sum -c --quiet --strict R1A-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || fail VERIFIER_FILE_DRIFT
[ -z "$(find "$APP" -type l -print -quit)" ] || fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$APP" -perm /222 -print -quit)" ] || fail VERIFIER_SOURCE_WRITABLE
[ "$(find "$APP" -type f ! -name R1A-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
AUDIT_DB="${AEGIS_R1A_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
# the verifier runs with a CLEAN environment, a fixed PATH (systemctl/journalctl by name) and ONLY the immutable snapshot on the import path
R1A_PY() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.r1_acceptance "$@"; }
case "$STEP" in BASELINE | FINAL) ;; *) fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$WORK/R1A-$STEP-RAN" ) 2>/dev/null || fail "STEP_ALREADY_RAN_$STEP"
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
if [ "$STEP" = BASELINE ]; then
  RELEASE_ID="${AEGIS_R1A_RELEASE_ID:-}"; DET_SHA="${AEGIS_R1A_DETECTOR_SHA256:-}"; DET_UID="${AEGIS_R1A_DETECTOR_UID:-}"
  [[ "$RELEASE_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] && [[ "$DET_SHA" =~ ^[0-9a-f]{64}$ ]] && [[ "$DET_UID" =~ ^[1-9][0-9]*$ ]] || fail BASELINE_INPUTS_INVALID
  R1A_PY baseline --audit-db "$AUDIT_DB" --release-id "$RELEASE_ID" \
    --detector-sha256 "$DET_SHA" --detector-uid "$DET_UID" --out "$WORK/r1-baseline.json" || fail BASELINE_CAPTURE_REFUSED
  printf 'R1A_APPLY=COMPLETE\nR1A_STEP=BASELINE\nR1A_EVENT_GENERATED_BY_HANDLER=NO\n'
else
  [ -f "$WORK/r1-baseline.json" ] || fail BASELINE_MISSING
  R1A_PY final --baseline "$WORK/r1-baseline.json" --audit-db "$AUDIT_DB" --out "$WORK/r1-result.json"
  rc=$?
  printf 'R1A_APPLY=COMPLETE\nR1A_STEP=FINAL\nR1A_VERIFIER_EXIT=%s\nR1A_EVENT_GENERATED_BY_HANDLER=NO\n' "$rc"
  # a failed verifier is still a COMPLETE observation: the attempt is consumed, evidence is preserved, nothing is retried or repaired here
fi
