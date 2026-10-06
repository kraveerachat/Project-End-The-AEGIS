#!/usr/bin/env bash
# R1Bv "apply": READ-ONLY validation of the EXISTING failed R1B attempt's evidence. R1Bv is a successor validation stage, NOT an R1B retry: it creates no marker and no R1B window record, opens SQLite read-only,
# never connects to any socket, never mutates an incident, never generates an event and never restarts or alters anything. Two steps, selected by AEGIS_R1BV_STEP:
#   BASELINE  the first read-only validation of the existing chain inside the historical bound derived from the root-owned canonical R1B marker, plus a no-mutation fingerprint (work directory only)
#   FINAL     the second read-only validation, which must reproduce the first result and an UNCHANGED fingerprint (nothing changed anywhere during the stage window)
# Each step is guarded by an exclusive (noclobber) step marker in the WORK directory only (never a governance marker).
set -uo pipefail
fail() { printf 'R1BV_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
STEP="${AEGIS_R1BV_STEP:-}"
WORK="${AEGIS_R1BV_WORK_DIR:-}"
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/
PY="${AEGIS_PYTHON_BIN:-python3}"
APP="${AEGIS_R1BV_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_R1BV_VERIFIER_MANIFEST_SHA256:-}"
[ "${AEGIS_R1BV_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
[ -n "$APP" ] && [ -d "$APP" ] && [ ! -L "$APP" ] && [ -f "$APP/aegis_soc/r1bv_validation.py" ] || fail APP_DIR_INVALID
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
MANIFEST="$APP/R1BV-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail VERIFIER_MANIFEST_DRIFT
( cd "$APP" && sha256sum -c --quiet --strict R1BV-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || fail VERIFIER_FILE_DRIFT
[ -z "$(find "$APP" -type l -print -quit)" ] || fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$APP" -perm /222 -print -quit)" ] || fail VERIFIER_SOURCE_WRITABLE
[ "$(find "$APP" -type f ! -name R1BV-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
AUDIT_DB="${AEGIS_R1BV_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
SRC_IP="${AEGIS_R1BV_EXPECTED_SOURCE_IP:-}"; R1B_EVID="${AEGIS_R1BV_R1B_EVIDENCE_DIR:-}"; R1B_AUTH="${AEGIS_R1BV_R1B_AUTH_DIR:-}"
EXP_REL="${AEGIS_R1BV_RELEASE_ID:-}"; EXP_DET_SHA="${AEGIS_R1BV_DETECTOR_SHA256:-}"; EXP_DET_UID="${AEGIS_R1BV_DETECTOR_UID:-}"
[[ "$EXP_REL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$EXP_DET_SHA" =~ ^[0-9a-f]{64}$ ]] && [[ "$EXP_DET_UID" =~ ^[1-9][0-9]*$ ]] || fail EXPECTED_IDENTITY_INVALID
[[ "$SRC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail EXPECTED_SOURCE_INVALID
for d in "$R1B_EVID" "$R1B_AUTH"; do [[ "$d" == /* ]] && [[ "$d" != *..* ]] && [ -d "$d" ] && [ ! -L "$d" ] || fail R1B_INPUT_DIR_INVALID; done
# the observer runs with a CLEAN environment, a fixed PATH (systemctl/journalctl by name) and ONLY the immutable snapshot on the import path; its module-level logger goes to /dev/null and the configured DB path is a never-opened sentinel
R1BV_PY() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 AEGIS_LOG_PATH=/dev/null AEGIS_DB_PATH=/nonexistent/r1bv-never-opened.db "$PY" -B -s -P -m aegis_soc.r1bv_validation "$@"; }
case "$STEP" in BASELINE | FINAL) ;; *) fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$WORK/R1BV-$STEP-RAN" ) 2>/dev/null || fail "STEP_ALREADY_RAN_$STEP"
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
COMMON=(--audit-db "$AUDIT_DB" --r1b-baseline "$R1B_EVID/r1b-work/r1-baseline.json" --expected-source-ip "$SRC_IP" --expected-release-id "$EXP_REL" --expected-detector-sha256 "$EXP_DET_SHA" --expected-detector-uid "$EXP_DET_UID" --local-marker "$R1B_AUTH/R1B-ATTEMPT-CONSUMED" --runner-log "$R1B_EVID/owner-run.log")
case "$STEP" in
  BASELINE)
    R1BV_PY baseline "${COMMON[@]}" --out "$WORK/r1bv-baseline.json" || fail BASELINE_REFUSED
    printf 'R1BV_APPLY=COMPLETE\nR1BV_STEP=BASELINE\nR1BV_MUTATION_BY_HANDLER=NO\nR1BV_EVENT_GENERATED_BY_HANDLER=NO\n' ;;
  FINAL)
    [ -f "$WORK/r1bv-baseline.json" ] || fail BASELINE_MISSING
    R1BV_PY final "${COMMON[@]}" --baseline "$WORK/r1bv-baseline.json" --out "$WORK/r1bv-result.json" || fail FINAL_REFUSED
    printf 'R1BV_APPLY=COMPLETE\nR1BV_STEP=FINAL\nR1BV_MUTATION_BY_HANDLER=NO\nR1BV_EVENT_GENERATED_BY_HANDLER=NO\n' ;;
esac
