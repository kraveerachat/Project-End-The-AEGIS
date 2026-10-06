#!/usr/bin/env bash
# R1Dv "apply": READ-ONLY validation of the ALREADY COMMITTED R1D disposition. R1Dv is a successor validation stage, NOT an R1D retry: it creates no marker, opens SQLite read-only, never connects to the R1D
# channel (this handler has no caller, no socket path and no DISPOSE step), never mutates an incident and never restarts or alters anything. Two steps, selected by AEGIS_R1DV_STEP:
#   BASELINE  read-only PRE observation of the committed state (marker, attempt/disposition rows, incident, index, audit chain) written to the work directory
#   FINAL     read-only POST observation compared with the PRE observation (identical historical state, nothing forbidden appended)
# Each step is guarded by an exclusive (noclobber) step marker in the WORK directory only (never a governance marker).
set -uo pipefail
fail() { printf 'R1DV_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
STEP="${AEGIS_R1DV_STEP:-}"
WORK="${AEGIS_R1DV_WORK_DIR:-}"
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/
PY="${AEGIS_PYTHON_BIN:-python3}"
APP="${AEGIS_R1DV_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_R1DV_VERIFIER_MANIFEST_SHA256:-}"
[ "${AEGIS_R1DV_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
[ -n "$APP" ] && [ -d "$APP" ] && [ ! -L "$APP" ] && [ -f "$APP/aegis_soc/historical_validation.py" ] || fail APP_DIR_INVALID
[[ "$MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]] || fail VERIFIER_MANIFEST_PIN_INVALID
[[ "$APP" == /* ]] && [ "$(readlink -f "$APP")" = "$APP" ] || fail VERIFIER_PATH_NOT_CANONICAL
[ -z "$(find "$APP" ! -uid "$SNAPSHOT_OWNER_UID" -print -quit)" ] || fail VERIFIER_SNAPSHOT_NOT_TRUSTED_OWNER
d=$APP
while :; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$SNAPSHOT_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || fail "VERIFIER_ANCESTOR_NOT_TRUSTED"
  [ "$d" = "$SNAPSHOT_TRUST_ROOT" ] && break
  [ "$d" != / ] || fail VERIFIER_TRUST_ROOT_NOT_AN_ANCESTOR
  d=$(dirname "$d")
done
# Root must never execute mutable bytes: re-prove the snapshot IMMEDIATELY before use (manifest digest, every file digest, exact file set, no symlink, nothing writable).
MANIFEST="$APP/R1DV-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail VERIFIER_MANIFEST_DRIFT
( cd "$APP" && sha256sum -c --quiet --strict R1DV-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || fail VERIFIER_FILE_DRIFT
[ -z "$(find "$APP" -type l -print -quit)" ] || fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$APP" -perm /222 -print -quit)" ] || fail VERIFIER_SOURCE_WRITABLE
[ "$(find "$APP" -type f ! -name R1DV-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
AUDIT_DB="${AEGIS_R1DV_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
# the observer runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
# the observer runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path; its module-level logger goes to /dev/null and the configured DB path is a never-opened sentinel
R1DV_PY() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 AEGIS_LOG_PATH=/dev/null AEGIS_DB_PATH=/nonexistent/r1dv-never-opened.db "$PY" -B -s -m aegis_soc.historical_validation "$@"; }
BINDING="${AEGIS_R1DV_BINDING_SHA256:-}"
[[ "$BINDING" =~ ^[0-9a-f]{64}$ ]] || fail INPUTS_INVALID
MARKER=/var/lib/aegis-idea3-governance/R1D-GLOBAL-ATTEMPT-CONSUMED   # the governed R1D marker: READ-ONLY presence check by the observer (a literal; not an override point)
[ "${AEGIS_R1DV_TEST_ONLY_MARKER:-}" = "" ] || MARKER="$AEGIS_R1DV_TEST_ONLY_MARKER"   # hermetic tests only; the frozen runner refuses to start when this variable is set
case "$STEP" in BASELINE | FINAL) ;; *) fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$WORK/R1DV-$STEP-RAN" ) 2>/dev/null || fail "STEP_ALREADY_RAN_$STEP"
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
case "$STEP" in
  BASELINE)
    R1DV_PY baseline --audit-db "$AUDIT_DB" --original-binding-sha256 "$BINDING" --marker "$MARKER" --out "$WORK/r1dv-baseline.json" || fail BASELINE_REFUSED
    printf 'R1DV_APPLY=COMPLETE\nR1DV_STEP=BASELINE\nR1DV_MUTATION_BY_HANDLER=NO\n' ;;
  FINAL)
    [ -f "$WORK/r1dv-baseline.json" ] || fail BASELINE_MISSING
    R1DV_PY final --audit-db "$AUDIT_DB" --original-binding-sha256 "$BINDING" --marker "$MARKER" --baseline "$WORK/r1dv-baseline.json" --out "$WORK/r1dv-result.json" || fail FINAL_REFUSED
    printf 'R1DV_APPLY=COMPLETE\nR1DV_STEP=FINAL\nR1DV_MUTATION_BY_HANDLER=NO\n' ;;
esac
