#!/usr/bin/env bash
# Recovery root handler. Root executes ONLY the verified immutable verifier snapshot (never an operator-owned or /home file) and ONLY read-only observers: the baseline and final proofs, the firewall dumps and the
# containment delta proof. It never calls the Core Recovery socket (the Core accepts only the operator uid), never mutates the Core, SQLite, nft, MQTT or a service, and never accepts an attacker IP.
# Steps, selected by AEGIS_RCVSTAGE_STEP, each runnable ONCE per work directory (an exclusive step marker in the root work directory, never removed):
#   BASELINE       the PRE-MARKER proof that the single open incident is the genuine R1B-created one with no Recovery history (and an intact audit chain)
#   READINESS      the RUNNING Core's mandatory R2/R6/R7 settings (configured/not-configured only, no value) and its timezone equal this verifier's; proven BEFORE the marker
#   NFT_PRE/POST   one read-only `nft --stateless list table inet aegis_idea3` dump into the root work directory (the semantic input of the containment delta proof)
#   NFT_PRE_CHECK  the PRE dump is exactly the state the generic PRE capture hashed
#   FINAL          the single final proof (the Core's own durable evidence; creates the root FINAL-RAN marker, the result and its SHA-256 sidecar)
#   DELTA          proves the ONLY firewall change is the Core-derived bound attacker ADDED to blocked_ipv4 and generates the ONE exact allow-keys file for the generic comparator
set -uo pipefail
fail() { printf 'RECOVERY_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
STEP="${AEGIS_RCVSTAGE_STEP:-}"
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/
PY="${AEGIS_PYTHON_BIN:-}"
APP="${AEGIS_RCVSTAGE_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
MANIFEST_SHA="${AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256:-}"
WORK="${AEGIS_RCVSTAGE_WORK_DIR:-}"
PROVENANCE="${AEGIS_RCVSTAGE_PROVENANCE_FILE:-}"
CONTROL="${AEGIS_RCVSTAGE_CONTROL_DIR:-}"
RUNNER_SHA="${RECOVERY_FROZEN_RUNNER_SHA256:-}"
CONTROL_SHA="${AEGIS_RCVSTAGE_CONTROL_MANIFEST_SHA256:-}"
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
[ -f "$PROVENANCE" ] && [ ! -L "$PROVENANCE" ] && [ "$(stat -c %u:%a "$PROVENANCE")" = "0:400" ] || fail RECOVERY_PROVENANCE_MISSING
grep -qx "RECOVERY_FROZEN_RUNNER_SHA256=$RUNNER_SHA" "$PROVENANCE" || fail RECOVERY_PROVENANCE_RUNNER_MISMATCH
grep -qx "RECOVERY_CONTROL_MANIFEST_SHA256=$CONTROL_SHA" "$PROVENANCE" || fail RECOVERY_PROVENANCE_CONTROL_MISMATCH
[[ "$RUNNER_SHA" =~ ^[0-9a-f]{64}$ && "$CONTROL_SHA" =~ ^[0-9a-f]{64}$ ]] || fail RECOVERY_PROVENANCE_FORMAT_INVALID
[ -f "$CONTROL/owner-run/run-recovery-owner.sh" ] && [ "$(sha256sum "$CONTROL/owner-run/run-recovery-owner.sh" | cut -d' ' -f1)" = "$RUNNER_SHA" ] || fail RECOVERY_FROZEN_RUNNER_PROVENANCE_INVALID
[ -f "$CONTROL/RECOVERY-CONTROL-SHA256SUMS" ] && [ "$(sha256sum "$CONTROL/RECOVERY-CONTROL-SHA256SUMS" | cut -d' ' -f1)" = "$CONTROL_SHA" ] || fail RECOVERY_CONTROL_PROVENANCE_INVALID
[ "$(find "$APP" -type f ! -name RECOVERY-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || fail VERIFIER_FILE_SET_DRIFT
for module in recovery_stage recovery_evidence recovery_client recovery_protocol local_restore ip_containment r1_acceptance r1bv_validation historical_disposition; do
  [ -f "$APP/aegis_soc/$module.py" ] || fail "VERIFIER_CLOSURE_INCOMPLETE:$module"
done
AUDIT_DB="${AEGIS_RCVSTAGE_AUDIT_DB:-}"
[ -n "$AUDIT_DB" ] && [[ "$AUDIT_DB" == /* ]] && [ -f "$AUDIT_DB" ] || fail AUDIT_DB_REQUIRED
MARKER="${AEGIS_RCVSTAGE_ATTEMPT_MARKER:-}"
[[ "$MARKER" == /* ]] && [[ "$MARKER" != *..* ]] || fail ATTEMPT_MARKER_REQUIRED
# the verifier runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
umask 077
# an explicit root-owned private log under the root work directory: importing the Core modules opens a log file and must never fall back to a relative `aegis_soc.log`
RUN() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_LOG_PATH="$WORK/stage-root.log" PYTHONPATH="$APP" PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s -m aegis_soc.recovery_stage "$@"; }
cd "$WORK" || fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
case "$STEP" in BASELINE | READINESS | NFT_PRE | NFT_POST | NFT_PRE_CHECK | FINAL | DELTA) ;; *) fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$WORK/RECOVERY-STEP-$STEP-RAN" ) 2>/dev/null || fail "STEP_ALREADY_RAN_$STEP"
case "$STEP" in
  BASELINE)
    SRC_IP="${AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP:-}"; DET_UID="${AEGIS_RCVSTAGE_DETECTOR_UID:-}"; R1B_BASELINE="${AEGIS_RCVSTAGE_R1B_BASELINE:-}"
    [[ "$DET_UID" =~ ^[1-9][0-9]*$ ]] && [[ "$R1B_BASELINE" == /* ]] && [ -n "$SRC_IP" ] || fail BASELINE_INPUTS_INVALID
    RUN baseline-db --audit-db "$AUDIT_DB" --r1b-baseline "$R1B_BASELINE" --expected-source-ip "$SRC_IP" --detector-uid "$DET_UID" --work-dir "$WORK" || fail BASELINE_REFUSED ;;
  READINESS)
    core_pid=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin systemctl show -p MainPID --value aegis-idea3-core.service 2>/dev/null); [[ "$core_pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_PID_UNAVAILABLE
    RUN readiness --core-pid "$core_pid" || fail READINESS_NOT_PROVEN ;;
  NFT_PRE | NFT_POST)
    label=pre; [ "$STEP" = NFT_POST ] && label=post
    ( set -o noclobber; env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin nft --stateless list table inet aegis_idea3 > "$WORK/nft-$label.txt" ) 2>/dev/null || fail NFT_DUMP_FAILED ;;
  NFT_PRE_CHECK)
    RUN nft-dump-check --bundle "$WORK/pre-root" --nft "$WORK/nft-pre.txt" || fail NFT_PRE_DUMP_NOT_THE_CAPTURED_STATE ;;
  FINAL)
    PROTOCOL_DB="${AEGIS_RCVSTAGE_PROTOCOL_DB:-}"; [[ "$PROTOCOL_DB" == /* ]] && [ -f "$PROTOCOL_DB" ] || fail PROTOCOL_DB_REQUIRED
    RUN final-verify --audit-db "$AUDIT_DB" --protocol-db "$PROTOCOL_DB" --work-dir "$WORK" --attempt-marker "$MARKER"; rc=$?
    [ "$rc" = 0 ] || printf 'RECOVERY_FINAL_VERIFIER_EXIT=%s\n' "$rc" >&2
    exit "$rc" ;;
  DELTA)
    RUN containment-delta --pre-bundle "$WORK/pre-root" --post-bundle "$WORK/post-root" --pre-nft "$WORK/nft-pre.txt" --post-nft "$WORK/nft-post.txt" --work-dir "$WORK" || fail CONTAINMENT_DELTA_NOT_PROVEN ;;
esac
printf 'RECOVERY_APPLY=COMPLETE\nRECOVERY_STEP=%s\nRECOVERY_ATTACKER_IP_ACCEPTED_FROM_RUNNER=NO\n' "$STEP"
