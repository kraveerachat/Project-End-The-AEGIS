#!/usr/bin/env bash
# Recovery verify: READ-ONLY re-proof of the stored final result. A hand-written JSON file can NEVER satisfy it: it requires the canonical root-owned attempt marker, the root-created FINAL-RAN marker for THIS marker
# and baseline, the root-owned result matching its SHA-256 sidecar, the exact claim constants, the same incident, an intact audit hash chain and an incident closed by the Core (RECOVERY_R8_CLOSE + INCIDENT_CLOSED).
# It never promotes a project claim and never prints the canonical live closed-pass token: that is reserved for a separately reviewed LIVE closeout receipt.
set -uo pipefail
fail() { printf 'RECOVERY_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/
PY="${AEGIS_PYTHON_BIN:-}"
APP="${AEGIS_RCVSTAGE_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256:-}"
WORK="${AEGIS_RCVSTAGE_WORK_DIR:-}"
[ "${AEGIS_RCVSTAGE_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
# trusted_chain DIR LABEL — DIR is canonical and DIR and EVERY ancestor to the trusted parent are real directories owned by SNAPSHOT_OWNER_UID and not group/world writable.
trusted_chain() {
  local d=$1 label=$2
  [[ "$d" == /* ]] && [ "$(readlink -f "$d")" = "$d" ] || fail "${label}_PATH_NOT_CANONICAL"
  while :; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$SNAPSHOT_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || fail "${label}_ANCESTOR_NOT_TRUSTED"
    [ "$d" = "$SNAPSHOT_TRUST_ROOT" ] && break
    [ "$d" != / ] || fail "${label}_TRUST_ROOT_NOT_AN_ANCESTOR"
    d=$(dirname "$d")
  done
}
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_REQUIRED
trusted_chain "$WORK" WORK
[ -z "$(find "$WORK" -maxdepth 0 -perm /077)" ] || fail WORK_DIR_NOT_PRIVATE
# the interpreter root executes: an absolute path that resolves to a regular file owned by root and not group/world writable
[[ "$PY" == /* ]] && PY_RESOLVED=$(readlink -f "$PY" 2>/dev/null) && [ -f "$PY_RESOLVED" ] || fail INTERPRETER_UNRESOLVABLE
[ "$(stat -c %U "$PY_RESOLVED")" = root ] && [ -z "$(find "$PY_RESOLVED" -maxdepth 0 -perm /022)" ] || fail INTERPRETER_NOT_ROOT_OWNED
[ -n "$APP" ] && [ -d "$APP" ] && [ ! -L "$APP" ] && [ -f "$APP/aegis_soc/recovery_stage.py" ] || fail APP_DIR_INVALID
[[ "$MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]] || fail VERIFIER_MANIFEST_PIN_INVALID
[[ "$APP" == /* ]] && [ "$(readlink -f "$APP")" = "$APP" ] || fail VERIFIER_PATH_NOT_CANONICAL
[ -z "$(find "$APP" ! -uid "$SNAPSHOT_OWNER_UID" -print -quit)" ] || fail VERIFIER_SNAPSHOT_NOT_TRUSTED_OWNER
trusted_chain "$APP" VERIFIER
# Root must never execute mutable bytes: re-prove the snapshot IMMEDIATELY before use (manifest digest, every file digest, exact file set, no symlink, nothing writable).
MANIFEST="$APP/RECOVERY-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || fail VERIFIER_MANIFEST_DRIFT
( cd "$APP" && sha256sum -c --quiet --strict RECOVERY-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || fail VERIFIER_FILE_DRIFT
[ -z "$(find "$APP" -type l -print -quit)" ] || fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$APP" -perm /222 -print -quit)" ] || fail VERIFIER_SOURCE_WRITABLE
[ "$(find "$APP" -type f ! -name RECOVERY-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
for module in recovery_stage recovery_evidence recovery_client recovery_protocol local_restore ip_containment r1_acceptance r1bv_validation historical_disposition; do
  [ -f "$APP/aegis_soc/$module.py" ] || fail "VERIFIER_CLOSURE_INCOMPLETE:$module"
done
AUDIT_DB="${AEGIS_RCVSTAGE_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [[ "$AUDIT_DB" == /* ]] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
MARKER="${AEGIS_RCVSTAGE_ATTEMPT_MARKER:-}"
[[ "$MARKER" == /* ]] && [[ "$MARKER" != *..* ]] || fail ATTEMPT_MARKER_REQUIRED
# the verifier runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
RUN() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.recovery_stage "$@"; }
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
RUN verify-result --audit-db "$AUDIT_DB" --work-dir "$WORK" --attempt-marker "$MARKER" || fail RESULT_NOT_BOUND_TO_THE_ATTEMPT
printf 'RECOVERY_VERIFY=PASS\nRECOVERY_RESULT_BOUND_TO_ATTEMPT=YES\nRECOVERY_PROMOTION=NOT_AUTOMATIC\n'
printf 'R1B_RESULT=FAIL_IMMUTABLE\nR1BV_RESULT=PASS\nLVR_PROVEN=NO\nL8_ACCEPTANCE=NO\nL9_PROVEN=NO\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\n'
