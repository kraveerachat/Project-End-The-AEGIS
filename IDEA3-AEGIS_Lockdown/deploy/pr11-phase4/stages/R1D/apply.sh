#!/usr/bin/env bash
# R1D "apply": the ONLY Production effect of the R1D stage is ONE Core-mediated historical-incident disposition. Steps, selected by AEGIS_R1D_STEP:
#   BASELINE  read-only PRE record: the preserved historical incident is the single eligible one and its binding equals the owner-authorized digest (never an operator-supplied incident id or address)
#   WINDOW    read-only: the incident's durable times are compatible with the preserved immutable R1A window (root-readable canonical record)
#   DISPOSE   the ONE Core call (dedicated local socket, kernel-verified uid 0): the Core re-derives the target, re-checks everything and commits ONE atomic transaction; no retry, ever
#   FINAL     read-only POST proof: only the expected transition happened
# Every step is guarded by an exclusive (noclobber) step marker in the work directory that is never removed. This handler never writes the audit DB, never opens SQLite read-write, never generates an
# event, never runs Recovery R2-R8 and never touches R1I, nftables, a unit, a release, MQTT or ESP32.
set -uo pipefail
fail() { printf 'R1D_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
STEP="${AEGIS_R1D_STEP:-}"
WORK="${AEGIS_R1D_WORK_DIR:-}"
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/
PY="${AEGIS_PYTHON_BIN:-python3}"
APP="${AEGIS_R1D_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_R1D_VERIFIER_MANIFEST_SHA256:-}"
[ "${AEGIS_R1D_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
[ -n "$APP" ] && [ -d "$APP" ] && [ ! -L "$APP" ] && [ -f "$APP/aegis_soc/historical_disposition.py" ] || fail APP_DIR_INVALID
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
MANIFEST="$APP/R1D-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail VERIFIER_MANIFEST_DRIFT
( cd "$APP" && sha256sum -c --quiet --strict R1D-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || fail VERIFIER_FILE_DRIFT
[ -z "$(find "$APP" -type l -print -quit)" ] || fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$APP" -perm /222 -print -quit)" ] || fail VERIFIER_SOURCE_WRITABLE
[ "$(find "$APP" -type f ! -name R1D-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
AUDIT_DB="${AEGIS_R1D_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
# the observer runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
# importing the (read-only) observer imports `database`, whose module-level logger would create a log file in the cwd: the log goes to /dev/null and the configured DB path is a never-opened sentinel
R1D_PY() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 AEGIS_LOG_PATH=/dev/null AEGIS_DB_PATH=/nonexistent/r1d-never-opened.db "$PY" -B -s -m aegis_soc.historical_disposition "$@"; }
BINDING="${AEGIS_R1D_BINDING_SHA256:-}"; DET_UID="${AEGIS_R1D_DETECTOR_UID:-}"
[[ "$BINDING" =~ ^[0-9a-f]{64}$ ]] && [[ "$DET_UID" =~ ^[1-9][0-9]*$ ]] || fail INPUTS_INVALID
case "$STEP" in BASELINE | WINDOW | DISPOSE | FINAL) ;; *) fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$WORK/R1D-$STEP-RAN" ) 2>/dev/null || fail "STEP_ALREADY_RAN_$STEP"
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
case "$STEP" in
  BASELINE)
    R1D_PY baseline --audit-db "$AUDIT_DB" --detector-uid "$DET_UID" --binding-sha256 "$BINDING" --out "$WORK/r1d-baseline.json" || fail BASELINE_REFUSED
    printf 'R1D_APPLY=COMPLETE\nR1D_STEP=BASELINE\nR1D_EVENT_GENERATED_BY_HANDLER=NO\n' ;;
  WINDOW)
    CANON="${AEGIS_R1D_CANONICAL_DIR:-/var/lib/aegis-idea3-governance}"
    [ "$CANON" = /var/lib/aegis-idea3-governance ] || [ "${AEGIS_R1D_TEST_ONLY_CANONICAL:-}" = YES ] || fail CANONICAL_DIR_OVERRIDE_REFUSED
    [ -f "$CANON/R1A-ATTEMPT-WINDOW" ] && [ ! -L "$CANON/R1A-ATTEMPT-WINDOW" ] || fail R1A_WINDOW_RECORD_MISSING
    R1D_PY window-check --audit-db "$AUDIT_DB" --detector-uid "$DET_UID" --window-record "$CANON/R1A-ATTEMPT-WINDOW" || fail R1A_WINDOW_INCOMPATIBLE
    printf 'R1D_APPLY=COMPLETE\nR1D_STEP=WINDOW\nR1A_WINDOW_COMPATIBLE=YES\n' ;;
  DISPOSE)
    [ -f "$WORK/r1d-baseline.json" ] || fail BASELINE_MISSING
    CALLER="${AEGIS_R1D_CALLER:-}"; SOCK="${AEGIS_R1D_SOCKET:-}"
    [ -n "$CALLER" ] && [ -f "$CALLER" ] && [ ! -L "$CALLER" ] && [ "$(basename "$CALLER")" = r1d_dispose_call.py ] || fail CALLER_INVALID
    [ "$SOCK" = /run/aegis-idea3/historical-disposition.sock ] || [ "${AEGIS_R1D_TEST_ONLY_SOCKET:-}" = YES ] || fail SOCKET_PATH_REFUSED
    out=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONDONTWRITEBYTECODE=1 "$PY" -I -B "$CALLER" "$SOCK" "$BINDING" 2>&1) ; rc=$?
    printf '%s\n' "$out"
    [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q '^R1D_DISPOSITION=DISPOSED ' || fail DISPOSE_NOT_CONFIRMED
    printf 'R1D_APPLY=COMPLETE\nR1D_STEP=DISPOSE\nR1D_EVENT_GENERATED_BY_HANDLER=NO\n' ;;
  FINAL)
    [ -f "$WORK/r1d-baseline.json" ] || fail BASELINE_MISSING
    R1D_PY final --baseline "$WORK/r1d-baseline.json" --audit-db "$AUDIT_DB" --binding-sha256 "$BINDING" --out "$WORK/r1d-result.json" || fail FINAL_REFUSED
    printf 'R1D_APPLY=COMPLETE\nR1D_STEP=FINAL\nR1D_EVENT_GENERATED_BY_HANDLER=NO\n' ;;
esac
