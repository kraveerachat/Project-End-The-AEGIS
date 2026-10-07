#!/bin/sh
# The executable entry point is a POSIX launcher.  It establishes a clean
# fixed-interpreter boundary before the Recovery Bash body can read startup
# files, imported functions, PATH lookups, or caller environment.  A caller
# that supplies the guard still reaches this check under /bin/sh and is
# refused before any Bash-only runner code can execute.
if [ "${AEGIS_RECOVERY_CLEAN_START:-}" != YES ]; then
  exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_RECOVERY_CLEAN_START=YES /bin/bash --noprofile --norc "$0" "$@"
fi
[ -n "${BASH_VERSION:-}" ] || { echo 'STOP: Recovery runner clean Bash boundary was not established.' >&2; exit 2; }
# AEGIS IDEA3 PR11 Phase 4 — Recovery R2-R8 LIVE stage, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow (recovery_runner_freeze.py) derives ONE root-owned frozen runner from this exact
# template (the EXPECTED_MAIN Git object, replacement objects disabled) plus ONLY the approved pin substitutions, records its SHA-256 and only then authorizes a run. Nothing in this repository executes it, creates
# an authorization or K3 record, or freezes a pin.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-recovery-owner.sh <AUTH_DIR> "<non-secret owner reason>"
#   AUTH_DIR holds authorization-Recovery.txt and k3-Recovery.txt (FRESH same-day, stage=Recovery, no extra field). The reason is the bounded NON-SECRET text of the owner's RESTORE (validated by the production RESTORE-reason
#   validator BEFORE the attempt marker, then passed unchanged as one quoted argv element to the pinned normal-path RESTORE command).
# Stage order: ... R1Bv -> Recovery -> LVR -> L8 -> L9. MUTATING governed stage; ONE attempt TOTAL; NO retry. The Core owns every Recovery mutation and every piece of evidence; this runner never accepts an attacker IP,
# never writes SQLite, never publishes MQTT, never calls nft with a mutation, never uses break-glass and never receives the RESTORE secret (the owner types it into the pinned `aegis_soc.cli restore` prompt).
# The automatic result NEVER promotes anything and NEVER prints the canonical live closed-pass token: that is reserved for a separately reviewed LIVE closeout. R1B stays FAIL_IMMUTABLE; R1Bv stays PASS.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin   # fixed: no program is ever selected through the caller's PATH

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
RELEASE_ID=PIN_RELEASE_ID
PRODUCTION_DETECTOR_SHA256=PIN_PRODUCTION_DETECTOR_SHA256
DETECTOR_UNIT_SHA256=PIN_DETECTOR_UNIT_SHA256
RECOVERY_CORE_SHA256=PIN_RECOVERY_CORE_SHA256
RESTORE_CLI_SHA256=PIN_RESTORE_CLI_SHA256
RELEASE_SUMS_SHA256=PIN_RELEASE_SUMS_SHA256
CONTROL_SNAPSHOT_DIR=PIN_CONTROL_SNAPSHOT_DIR
CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
VERIFIER_SNAPSHOT_DIR=PIN_VERIFIER_SNAPSHOT_DIR
VERIFIER_MANIFEST_SHA256=PIN_VERIFIER_MANIFEST_SHA256
R1I_TOOL_SHA256=PIN_R1I_TOOL_SHA256
PROTOCOL_DB=PIN_PROTOCOL_DB_PATH
AUDIT_DB=PIN_AUDIT_DB_PATH
R1B_EVIDENCE_DIR=PIN_R1B_EVIDENCE_DIR
EXPECTED_SOURCE_IP=PIN_EXPECTED_SOURCE_IP
DETECTOR_UID=PIN_DETECTOR_UID
RUNTIME_DIR=PIN_RUNTIME_DIR
CTU_LIVE_RECEIPT_RELATIVE=PIN_CTU_LIVE_RECEIPT_RELATIVE
CTU_REPO_RECEIPT_SHA256=PIN_CTU_REPO_RECEIPT_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RELEASE_ID PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256 RELEASE_SUMS_SHA256 CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 VERIFIER_SNAPSHOT_DIR VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256 PROTOCOL_DB AUDIT_DB R1B_EVIDENCE_DIR EXPECTED_SOURCE_IP DETECTOR_UID RUNTIME_DIR CTU_LIVE_RECEIPT_RELATIVE CTU_REPO_RECEIPT_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA." >&2; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier." >&2; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid." >&2; exit 2; }
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$RELEASE_ID" != *..* ]] || { echo "STOP: RELEASE_ID is not a valid release id." >&2; exit 2; }
for pin in PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256 RELEASE_SUMS_SHA256 CONTROL_MANIFEST_SHA256 VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256; do
  [[ "${!pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: $pin is not a 64-hex SHA-256." >&2; exit 2; }
done
[[ "$DETECTOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: DETECTOR_UID is not a valid non-root uid." >&2; exit 2; }
_octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
[[ "$EXPECTED_SOURCE_IP" =~ ^$_octet\.$_octet\.$_octet\.$_octet$ ]] && [[ "${EXPECTED_SOURCE_IP%%.*}" != 0 && "${EXPECTED_SOURCE_IP%%.*}" != 127 && "${EXPECTED_SOURCE_IP%%.*}" -lt 224 && "$EXPECTED_SOURCE_IP" != 169.254.* ]] \
  || { echo "STOP: EXPECTED_SOURCE_IP is not a valid external-capable IPv4 address." >&2; exit 2; }
for pin in CONTROL_SNAPSHOT_DIR VERIFIER_SNAPSHOT_DIR PROTOCOL_DB AUDIT_DB R1B_EVIDENCE_DIR RUNTIME_DIR CTU_LIVE_RECEIPT_RELATIVE; do
  [[ "${!pin}" == /* ]] && [[ "${!pin}" != *..* ]] || { echo "STOP: $pin must be an absolute path." >&2; exit 2; }
done
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root." >&2; exit 2; }
# No environment may redirect a live run: interpreter/loader/module overrides, fixture roots, handler overrides, Recovery/RESTORE targets and test seams must all be unset (the library repeats and extends this).
for var in PYTHON PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV AEGIS_RUNTIME_DIR AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_RECOVERY_SOCKET AEGIS_RECOVERY_CORE_USER \
    AEGIS_RCVSTAGE_APP_DIR AEGIS_RCVSTAGE_AUDIT_DB AEGIS_RCVSTAGE_PROTOCOL_DB AEGIS_RCVSTAGE_WORK_DIR AEGIS_RCVSTAGE_STEP AEGIS_RCVSTAGE_LIVE_AUTHORIZED AEGIS_RCVSTAGE_SECRET RECOVERY_SECRET RECOVERY_RESTORE_CONFIRMATION \
    RECOVERY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED RECOVERY_TEST_ONLY_TRUST_ROOT RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT GLOBAL_MARKER_DIR AEGIS_LOG_PATH AEGIS_DB_PATH; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set; refusing a live run." >&2; exit 2; }
done
AUTH_DIR=${1:-}
RECOVERY_REASON=${2-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-Recovery.txt and k3-Recovery.txt> \"<non-secret owner reason>\"" >&2; exit 2; }
[ -n "$RECOVERY_REASON" ] || { echo "STOP: the bounded non-secret owner reason (argument 2) is required before anything runs." >&2; exit 2; }

# Snapshot ownership invariant (LITERAL constants of the frozen runner, not environment): the control snapshot and EVERY ancestor up to the trusted parent are owned by this uid and not group/world writable.
# The committed template pins 0 (root) and `/`; a test copy may substitute its own values, a live freeze must not.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH   # replaced by the freeze workflow: a worktree at EXPECTED_MAIN used ONLY to read pinned git objects (receipts, byte-equality); NO shell or Python is sourced or executed from it
case "$REPO" in */PIN_*) echo "STOP: runner is not pinned (REPO). Run the owner freeze workflow first." >&2; exit 2 ;; esac
PY=PIN_PYTHON_BIN
case "$PY" in PIN_*) echo "STOP: runner is not pinned (PY). Run the owner freeze workflow first." >&2; exit 2 ;; esac
EVID_ROOT=/PIN_EVIDENCE_ROOT
case "$EVID_ROOT" in /PIN_*) echo "STOP: runner is not pinned (EVID_ROOT). Run the owner freeze workflow first." >&2; exit 2 ;; esac
# The LIVE control plane is the frozen IMMUTABLE control snapshot (the manifested copy of deploy/pr11-phase4 at EXPECTED_MAIN): every sourced library and every script root executes comes from CTRL.
CTRL=$CONTROL_SNAPSHOT_DIR
STG=$CTRL/stages/Recovery
LIB=$CTRL/p4-recovery-run-lib.sh
GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
RELEASE_PATH=/opt/aegis-idea3/releases/$RELEASE_ID
CURRENT_LINK=/opt/aegis-idea3/current
CORE_UNIT=aegis-idea3-core.service
DETECTOR_UNIT=aegis-idea3-detector.service
BROKER_UNIT=aegis-idea3-mosquitto.service
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
AP_IF=wlp0s20f3; AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F); STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
# Git authority reads run with replacement objects DISABLED on every invocation (a real `git replace GOOD EVIL` would otherwise keep the apparent SHA while changing the bytes Git returns). A shell function,
# so it also covers the git calls inside every library sourced later; a caller's environment cannot re-enable replacement.
export HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }
# control_gate — the frozen runner re-proves the control snapshot ITSELF (inline, never via sourced code): canonical path, root-owned entries and trusted ancestors to the trust root, manifest digest, every file's digest,
# exact file set, no symlink, nothing writable. Run BEFORE the first source and again immediately before EVERY root execution (capture, compare, stage handlers, stage gate).
control_gate() {
  local m="$CTRL/RECOVERY-CONTROL-SHA256SUMS" d
  [ -d "$CTRL" ] && [ ! -L "$CTRL" ] && [ -f "$m" ] && [ ! -L "$m" ] || { echo "GATE_FAIL: CONTROL_SNAPSHOT_INVALID" >&2; return 1; }
  [[ "$CTRL" == /* ]] && [ "$(readlink -f "$CTRL")" = "$CTRL" ] || { echo "GATE_FAIL: CONTROL_PATH_NOT_CANONICAL" >&2; return 1; }
  [ -z "$(find "$CTRL" ! -uid "$SNAPSHOT_OWNER_UID" -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SNAPSHOT_NOT_TRUSTED_OWNER" >&2; return 1; }
  d=$CTRL
  while :; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$SNAPSHOT_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || { echo "GATE_FAIL: CONTROL_ANCESTOR_NOT_TRUSTED:$d" >&2; return 1; }
    [ "$d" = "$SNAPSHOT_TRUST_ROOT" ] && break
    [ "$d" != / ] || { echo "GATE_FAIL: CONTROL_TRUST_ROOT_NOT_AN_ANCESTOR" >&2; return 1; }
    d=$(dirname "$d")
  done
  [ "$(sha256sum "$m" | cut -d' ' -f1)" = "$CONTROL_MANIFEST_SHA256" ] || { echo "GATE_FAIL: CONTROL_MANIFEST_DRIFT" >&2; return 1; }
  ( cd "$CTRL" && sha256sum -c --quiet --strict RECOVERY-CONTROL-SHA256SUMS ) >/dev/null 2>&1 || { echo "GATE_FAIL: CONTROL_FILE_DRIFT" >&2; return 1; }
  [ -z "$(find "$CTRL" -type l -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SYMLINK_PRESENT" >&2; return 1; }
  [ -z "$(find "$CTRL" -perm /222 -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SOURCE_WRITABLE" >&2; return 1; }
  [ "$(find "$CTRL" -type f ! -name RECOVERY-CONTROL-SHA256SUMS -printf '%P\n' | LC_ALL=C sort)" = "$(cut -c67- "$m" | LC_ALL=C sort)" ] || { echo "GATE_FAIL: CONTROL_FILE_SET_DRIFT" >&2; return 1; }
}
# control_git_gate — every control snapshot file is byte-identical to its pinned-main git object (the snapshot is exactly the reviewed source).
control_git_gate() {
  local sha rel got
  # the pinned commit must be a REAL commit object (replacement objects disabled by the git wrapper above) and HEAD must be exactly it; the reviewed bytes are read as EXPECTED_MAIN:path, never HEAD:path
  [ "$(git -C "$REPO" rev-parse --verify "$EXPECTED_MAIN^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_PINNED_COMMIT_NOT_A_COMMIT_OBJECT" >&2; return 1; }
  [ "$(git -C "$REPO" rev-parse --verify "HEAD^{commit}" 2>/dev/null)" = "$EXPECTED_MAIN" ] || { echo "GATE_FAIL: CONTROL_REPO_HEAD_NOT_PINNED_MAIN" >&2; return 1; }
  while read -r sha rel; do
    got=$(git -C "$REPO" show "$EXPECTED_MAIN:$GIT_P4_REL/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { echo "GATE_FAIL: CONTROL_FILE_NOT_THE_PINNED_MAIN_SOURCE:$rel" >&2; return 1; }
  done < "$CTRL/RECOVERY-CONTROL-SHA256SUMS"
}
# The library is sourced ONLY after A (control_gate) AND B (control_git_gate) pass.
control_gate || die "the control snapshot is not the frozen immutable authority; nothing was sourced, created or touched"
control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was sourced, created or touched"
# shellcheck disable=SC1090
source "$LIB"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
recovery_env_gate || die "the environment redirects an interpreter, loader, module path, fixture root or Recovery target; nothing was created or touched"
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen Recovery operator; nothing was created or touched"
recovery_no_live_claims
sudo -v || die "sudo authentication failed"   # the ONLY interactive sudo establishment; every privileged command below uses `sudo -n`
SUDO='sudo -n'
recovery_start_sudo_keepalive || die "the bounded sudo keepalive could not start; nothing was created"
trap recovery_stop_sudo_keepalive EXIT   # nothing outlives this owner-run process

EVID=$EVID_ROOT/$TODAY-recovery-$STAMP
STEPS=$EVID/steps
WORK=$(recovery_canonical_dir)/recovery-$STAMP   # ROOT-OWNED work directory under the canonical governance directory (created by root; never operator-writable)
CORE_PRE=""; DETECTOR_PRE=""
RECOVERY_D4_OUT_FD=3; RECOVERY_D4_ERR_FD=4
exec 3>&1 4>&2   # the terminal descriptors the interactive D4 command writes to (never the tee'd run log)
show() { systemctl show -p "$2" --value "$1"; }
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }

# recovery_authority_gates — the complete live authority. Read-only; returns non-zero (reasons on stderr) if ANY link is not intact. Run in the pre-gates, again in the regate before the marker, and again IMMEDIATELY before FINAL.
recovery_authority_gates() {
  local rc=0
  # ACTIVE mode still delegates to the reviewed f1u_detector_running_gate;
  # INACTIVE mode is reconciled by recovery_ctu_detector_mode_gate.
  control_gate || rc=1
  control_git_gate || rc=1
  rru_recovery_successor_gate "$REPO" "$EXPECTED_MAIN" "$RELEASE_ID" || rc=1
  recovery_verifier_gate "$VERIFIER_SNAPSHOT_DIR" "$VERIFIER_MANIFEST_SHA256" "$REPO" "$CTRL/recovery-acceptance/recovery_verifier_snapshot.py" "$EXPECTED_MAIN" || rc=1
  recovery_interpreter_gate "$PY" || rc=1
  recovery_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || rc=1
  l7u_core_running_gate "$CORE_UNIT" || rc=1
  recovery_ctu_detector_mode_gate || rc=1
  recovery_digest_gate "$RELEASE_PATH/aegis_soc/production_detector.py" "$PRODUCTION_DETECTOR_SHA256" DETECTOR_SOURCE || rc=1
  recovery_digest_gate "$RELEASE_PATH/aegis_soc/recovery_core.py" "$RECOVERY_CORE_SHA256" RECOVERY_CORE || rc=1
  recovery_digest_gate "/etc/systemd/system/$DETECTOR_UNIT" "$DETECTOR_UNIT_SHA256" DETECTOR_UNIT || rc=1
  recovery_current_release_gate "$CURRENT_LINK" "$RELEASE_PATH" || rc=1
  recovery_release_closure_gate "$RELEASE_ID" "$RELEASE_PATH" "$RELEASE_SUMS_SHA256" || rc=1
  recovery_cli_gate "$RELEASE_PATH" "$RESTORE_CLI_SHA256" || rc=1
  [ -z "$CORE_PRE" ] || recovery_runtime_unchanged || { recovery_reason "RECOVERY_CORE_OR_DETECTOR_IDENTITY_CHANGED"; rc=1; }
  return "$rc"
}

recovery_handler_fail() { printf 'RECOVERY_HANDLER=FAIL reason=%s\n' "$1" >&2; exit 1; }
recovery_apply_governed() {

STEP="${AEGIS_RCVSTAGE_STEP:-}"
# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
RCV_OWNER_UID=0
RCV_TRUST_ROOT=/
RCV_PY="${AEGIS_PYTHON_BIN:-}"
RCV_APP="${AEGIS_RCVSTAGE_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
RCV_MANIFEST_SHA="${AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256:-}"
RCV_WORK="${AEGIS_RCVSTAGE_WORK_DIR:-}"
RCV_PROVENANCE="${AEGIS_RCVSTAGE_PROVENANCE_FILE:-}"
RCV_CONTROL="${AEGIS_RCVSTAGE_CONTROL_DIR:-}"
RCV_RUNNER_SHA="${RECOVERY_FROZEN_RUNNER_SHA256:-}"
RCV_CONTROL_SHA="${AEGIS_RCVSTAGE_CONTROL_MANIFEST_SHA256:-}"
[ "${AEGIS_RCVSTAGE_LIVE_AUTHORIZED:-NO}" = YES ] || recovery_handler_fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || recovery_handler_fail ROOT_REQUIRED
# trusted_chain DIR LABEL — DIR is canonical and DIR and EVERY ancestor to the trusted parent are real directories owned by RCV_OWNER_UID and not group/world writable.
trusted_chain() {
  local d=$1 label=$2
  [[ "$d" == /* ]] && [ "$(readlink -f "$d")" = "$d" ] || recovery_handler_fail "${label}_PATH_NOT_CANONICAL"
  while :; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$RCV_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || recovery_handler_fail "${label}_ANCESTOR_NOT_TRUSTED"
    [ "$d" = "$RCV_TRUST_ROOT" ] && break
    [ "$d" != / ] || recovery_handler_fail "${label}_TRUST_ROOT_NOT_AN_ANCESTOR"
    d=$(dirname "$d")
  done
}
[ -n "$RCV_WORK" ] && [ -d "$RCV_WORK" ] && [ ! -L "$RCV_WORK" ] || recovery_handler_fail WORK_DIR_REQUIRED
trusted_chain "$RCV_WORK" RCV_WORK
[ -z "$(find "$RCV_WORK" -maxdepth 0 -perm /077)" ] || recovery_handler_fail WORK_DIR_NOT_PRIVATE
# the interpreter root executes: an absolute path that resolves to a regular file owned by root and not group/world writable
[[ "$RCV_PY" == /* ]] && PY_RESOLVED=$(readlink -f "$RCV_PY" 2>/dev/null) && [ -f "$PY_RESOLVED" ] || recovery_handler_fail INTERPRETER_UNRESOLVABLE
[ "$(stat -c %U "$PY_RESOLVED")" = root ] && [ -z "$(find "$PY_RESOLVED" -maxdepth 0 -perm /022)" ] || recovery_handler_fail INTERPRETER_NOT_ROOT_OWNED
[ -n "$RCV_APP" ] && [ -d "$RCV_APP" ] && [ ! -L "$RCV_APP" ] && [ -f "$RCV_APP/aegis_soc/recovery_stage.py" ] || recovery_handler_fail APP_DIR_INVALID
[[ "$RCV_MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]] || recovery_handler_fail VERIFIER_MANIFEST_PIN_INVALID
[[ "$RCV_APP" == /* ]] && [ "$(readlink -f "$RCV_APP")" = "$RCV_APP" ] || recovery_handler_fail VERIFIER_PATH_NOT_CANONICAL
[ -z "$(find "$RCV_APP" ! -uid "$RCV_OWNER_UID" -print -quit)" ] || recovery_handler_fail VERIFIER_SNAPSHOT_NOT_TRUSTED_OWNER
trusted_chain "$RCV_APP" VERIFIER
# Root must never execute mutable bytes: re-prove the snapshot IMMEDIATELY before use (manifest digest, every file digest, exact file set, no symlink, nothing writable).
MANIFEST="$RCV_APP/RECOVERY-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$RCV_MANIFEST_SHA" ] || recovery_handler_fail VERIFIER_MANIFEST_DRIFT
( cd "$RCV_APP" && sha256sum -c --quiet --strict RECOVERY-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || recovery_handler_fail VERIFIER_FILE_DRIFT
[ -z "$(find "$RCV_APP" -type l -print -quit)" ] || recovery_handler_fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$RCV_APP" -perm /222 -print -quit)" ] || recovery_handler_fail VERIFIER_SOURCE_WRITABLE
[ -f "$RCV_PROVENANCE" ] && [ ! -L "$RCV_PROVENANCE" ] && [ "$(stat -c %u:%a "$RCV_PROVENANCE")" = "0:400" ] || recovery_handler_fail RECOVERY_PROVENANCE_MISSING
grep -qx "RECOVERY_FROZEN_RUNNER_SHA256=$RCV_RUNNER_SHA" "$RCV_PROVENANCE" || recovery_handler_fail RECOVERY_PROVENANCE_RUNNER_MISMATCH
grep -qx "RECOVERY_CONTROL_MANIFEST_SHA256=$RCV_CONTROL_SHA" "$RCV_PROVENANCE" || recovery_handler_fail RECOVERY_PROVENANCE_CONTROL_MISMATCH
[[ "$RCV_RUNNER_SHA" =~ ^[0-9a-f]{64}$ && "$RCV_CONTROL_SHA" =~ ^[0-9a-f]{64}$ ]] || recovery_handler_fail RECOVERY_PROVENANCE_FORMAT_INVALID
[ -f "$RCV_CONTROL/owner-run/run-recovery-owner.sh" ] && [ "$(sha256sum "$RCV_CONTROL/owner-run/run-recovery-owner.sh" | cut -d' ' -f1)" = "$RCV_RUNNER_SHA" ] || recovery_handler_fail RECOVERY_FROZEN_RUNNER_PROVENANCE_INVALID
[ -f "$RCV_CONTROL/RECOVERY-RCV_CONTROL-SHA256SUMS" ] && [ "$(sha256sum "$RCV_CONTROL/RECOVERY-RCV_CONTROL-SHA256SUMS" | cut -d' ' -f1)" = "$RCV_CONTROL_SHA" ] || recovery_handler_fail RECOVERY_CONTROL_PROVENANCE_INVALID
[ "$(find "$RCV_APP" -type f ! -name RECOVERY-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || recovery_handler_fail VERIFIER_FILE_SET_DRIFT
for module in recovery_stage recovery_evidence recovery_client recovery_protocol local_restore ip_containment r1_acceptance r1bv_validation historical_disposition; do
  [ -f "$RCV_APP/aegis_soc/$module.py" ] || recovery_handler_fail "VERIFIER_CLOSURE_INCOMPLETE:$module"
done
RCV_AUDIT_DB="${AEGIS_RCVSTAGE_AUDIT_DB:-}"
[ -n "$RCV_AUDIT_DB" ] && [[ "$RCV_AUDIT_DB" == /* ]] && [ -f "$RCV_AUDIT_DB" ] || recovery_handler_fail AUDIT_DB_REQUIRED
RCV_MARKER="${AEGIS_RCVSTAGE_ATTEMPT_MARKER:-}"
[[ "$RCV_MARKER" == /* ]] && [[ "$RCV_MARKER" != *..* ]] || recovery_handler_fail ATTEMPT_MARKER_REQUIRED
# the verifier runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
umask 077
# an explicit root-owned private log under the root work directory: importing the Core modules opens a log file and must never fall back to a relative `aegis_soc.log`
RUN() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_LOG_PATH="$RCV_WORK/stage-root.log" PYTHONDONTWRITEBYTECODE=1 "$RCV_PY" -I -B -c 'import runpy,sys; sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[1:]; runpy.run_module("aegis_soc.recovery_stage",run_name="__main__")' "$RCV_APP" "$@"; }
cd "$RCV_WORK" || recovery_handler_fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
case "$STEP" in BASELINE | READINESS | NFT_PRE | NFT_POST | NFT_PRE_CHECK | FINAL | DELTA) ;; *) recovery_handler_fail STEP_INVALID ;; esac
( set -o noclobber; printf 'step=%s\nat=%s\n' "$STEP" "$(date -u +%FT%TZ)" > "$RCV_WORK/RECOVERY-STEP-$STEP-RAN" ) 2>/dev/null || recovery_handler_fail "STEP_ALREADY_RAN_$STEP"
case "$STEP" in
  BASELINE)
    SRC_IP="${AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP:-}"; DET_UID="${AEGIS_RCVSTAGE_DETECTOR_UID:-}"; R1B_BASELINE="${AEGIS_RCVSTAGE_R1B_BASELINE:-}"
    [[ "$DET_UID" =~ ^[1-9][0-9]*$ ]] && [[ "$R1B_BASELINE" == /* ]] && [ -n "$SRC_IP" ] || recovery_handler_fail BASELINE_INPUTS_INVALID
    RUN baseline-db --audit-db "$RCV_AUDIT_DB" --r1b-baseline "$R1B_BASELINE" --expected-source-ip "$SRC_IP" --detector-uid "$DET_UID" --work-dir "$RCV_WORK" || recovery_handler_fail BASELINE_REFUSED ;;
  READINESS)
    core_pid=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin systemctl show -p MainPID --value aegis-idea3-core.service 2>/dev/null); [[ "$core_pid" =~ ^[1-9][0-9]*$ ]] || recovery_handler_fail CORE_PID_UNAVAILABLE
    RUN readiness --core-pid "$core_pid" || recovery_handler_fail READINESS_NOT_PROVEN ;;
  NFT_PRE | NFT_POST)
    label=pre; [ "$STEP" = NFT_POST ] && label=post
    ( set -o noclobber; env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin nft --stateless list table inet aegis_idea3 > "$RCV_WORK/nft-$label.txt" ) 2>/dev/null || recovery_handler_fail NFT_DUMP_FAILED ;;
  NFT_PRE_CHECK)
    RUN nft-dump-check --bundle "$RCV_WORK/pre-root" --nft "$RCV_WORK/nft-pre.txt" || recovery_handler_fail NFT_PRE_DUMP_NOT_THE_CAPTURED_STATE ;;
  FINAL)
    RCV_PROTOCOL_DB="${AEGIS_RCVSTAGE_PROTOCOL_DB:-}"; [[ "$RCV_PROTOCOL_DB" == /* ]] && [ -f "$RCV_PROTOCOL_DB" ] || recovery_handler_fail PROTOCOL_DB_REQUIRED
    RUN final-verify --audit-db "$RCV_AUDIT_DB" --protocol-db "$RCV_PROTOCOL_DB" --work-dir "$RCV_WORK" --attempt-marker "$RCV_MARKER"; rc=$?
    [ "$rc" = 0 ] || printf 'RECOVERY_FINAL_VERIFIER_EXIT=%s\n' "$rc" >&2
    exit "$rc" ;;
  DELTA)
    RUN containment-delta --pre-bundle "$RCV_WORK/pre-root" --post-bundle "$RCV_WORK/post-root" --pre-nft "$RCV_WORK/nft-pre.txt" --post-nft "$RCV_WORK/nft-post.txt" --work-dir "$RCV_WORK" || recovery_handler_fail CONTAINMENT_DELTA_NOT_PROVEN ;;
esac
printf 'RECOVERY_APPLY=COMPLETE\nRECOVERY_STEP=%s\nRECOVERY_ATTACKER_IP_ACCEPTED_FROM_RUNNER=NO\n' "$STEP"
}
recovery_verify_governed() {

# Snapshot ownership invariant (LITERAL constants, never environment): the verifier snapshot and EVERY ancestor up to the trusted parent are owned by root and not group/world writable. A same-uid owner could
# otherwise chmod a read-only snapshot writable and replace bytes between this check and the Python start below. A test copy may substitute its own values; production keeps 0 and `/`.
RCV_OWNER_UID=0
RCV_TRUST_ROOT=/
RCV_PY="${AEGIS_PYTHON_BIN:-}"
RCV_APP="${AEGIS_RCVSTAGE_APP_DIR:-}"            # the frozen IMMUTABLE verifier snapshot (never a mutable worktree)
RCV_MANIFEST_SHA="${AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256:-}"
RCV_WORK="${AEGIS_RCVSTAGE_WORK_DIR:-}"
RCV_PROVENANCE="${AEGIS_RCVSTAGE_PROVENANCE_FILE:-}"; RCV_CONTROL="${AEGIS_RCVSTAGE_CONTROL_DIR:-}"; RCV_RUNNER_SHA="${RECOVERY_FROZEN_RUNNER_SHA256:-}"; RCV_CONTROL_SHA="${AEGIS_RCVSTAGE_CONTROL_MANIFEST_SHA256:-}"
[ "${AEGIS_RCVSTAGE_LIVE_AUTHORIZED:-NO}" = YES ] || recovery_handler_fail LIVE_AUTHORIZATION_REQUIRED
[ "$(id -u)" = 0 ] || recovery_handler_fail ROOT_REQUIRED
# trusted_chain DIR LABEL — DIR is canonical and DIR and EVERY ancestor to the trusted parent are real directories owned by RCV_OWNER_UID and not group/world writable.
trusted_chain() {
  local d=$1 label=$2
  [[ "$d" == /* ]] && [ "$(readlink -f "$d")" = "$d" ] || recovery_handler_fail "${label}_PATH_NOT_CANONICAL"
  while :; do
    [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$RCV_OWNER_UID" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ] || recovery_handler_fail "${label}_ANCESTOR_NOT_TRUSTED"
    [ "$d" = "$RCV_TRUST_ROOT" ] && break
    [ "$d" != / ] || recovery_handler_fail "${label}_TRUST_ROOT_NOT_AN_ANCESTOR"
    d=$(dirname "$d")
  done
}
[ -n "$RCV_WORK" ] && [ -d "$RCV_WORK" ] && [ ! -L "$RCV_WORK" ] || recovery_handler_fail WORK_DIR_REQUIRED
trusted_chain "$RCV_WORK" RCV_WORK
[ -z "$(find "$RCV_WORK" -maxdepth 0 -perm /077)" ] || recovery_handler_fail WORK_DIR_NOT_PRIVATE
# the interpreter root executes: an absolute path that resolves to a regular file owned by root and not group/world writable
[[ "$RCV_PY" == /* ]] && PY_RESOLVED=$(readlink -f "$RCV_PY" 2>/dev/null) && [ -f "$PY_RESOLVED" ] || recovery_handler_fail INTERPRETER_UNRESOLVABLE
[ "$(stat -c %U "$PY_RESOLVED")" = root ] && [ -z "$(find "$PY_RESOLVED" -maxdepth 0 -perm /022)" ] || recovery_handler_fail INTERPRETER_NOT_ROOT_OWNED
[ -n "$RCV_APP" ] && [ -d "$RCV_APP" ] && [ ! -L "$RCV_APP" ] && [ -f "$RCV_APP/aegis_soc/recovery_stage.py" ] || recovery_handler_fail APP_DIR_INVALID
[[ "$RCV_MANIFEST_SHA" =~ ^[0-9a-f]{64}$ ]] || recovery_handler_fail VERIFIER_MANIFEST_PIN_INVALID
[[ "$RCV_APP" == /* ]] && [ "$(readlink -f "$RCV_APP")" = "$RCV_APP" ] || recovery_handler_fail VERIFIER_PATH_NOT_CANONICAL
[ -z "$(find "$RCV_APP" ! -uid "$RCV_OWNER_UID" -print -quit)" ] || recovery_handler_fail VERIFIER_SNAPSHOT_NOT_TRUSTED_OWNER
trusted_chain "$RCV_APP" VERIFIER
# Root must never execute mutable bytes: re-prove the snapshot IMMEDIATELY before use (manifest digest, every file digest, exact file set, no symlink, nothing writable).
MANIFEST="$RCV_APP/RECOVERY-VERIFIER-SHA256SUMS"
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && [ "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" = "$RCV_MANIFEST_SHA" ] || recovery_handler_fail VERIFIER_MANIFEST_DRIFT
( cd "$RCV_APP" && sha256sum -c --quiet --strict RECOVERY-VERIFIER-SHA256SUMS ) >/dev/null 2>&1 || recovery_handler_fail VERIFIER_FILE_DRIFT
[ -z "$(find "$RCV_APP" -type l -print -quit)" ] || recovery_handler_fail VERIFIER_SYMLINK_PRESENT
[ -z "$(find "$RCV_APP" -perm /222 -print -quit)" ] || recovery_handler_fail VERIFIER_SOURCE_WRITABLE
[ -f "$RCV_PROVENANCE" ] && [ ! -L "$RCV_PROVENANCE" ] && [ "$(stat -c %u:%a "$RCV_PROVENANCE")" = "0:400" ] || recovery_handler_fail RECOVERY_PROVENANCE_MISSING
grep -qx "RECOVERY_FROZEN_RUNNER_SHA256=$RCV_RUNNER_SHA" "$RCV_PROVENANCE" || recovery_handler_fail RECOVERY_PROVENANCE_RUNNER_MISMATCH
grep -qx "RECOVERY_CONTROL_MANIFEST_SHA256=$RCV_CONTROL_SHA" "$RCV_PROVENANCE" || recovery_handler_fail RECOVERY_PROVENANCE_CONTROL_MISMATCH
[[ "$RCV_RUNNER_SHA" =~ ^[0-9a-f]{64}$ && "$RCV_CONTROL_SHA" =~ ^[0-9a-f]{64}$ ]] || recovery_handler_fail RECOVERY_PROVENANCE_FORMAT_INVALID
[ -f "$RCV_CONTROL/owner-run/run-recovery-owner.sh" ] && [ "$(sha256sum "$RCV_CONTROL/owner-run/run-recovery-owner.sh" | cut -d' ' -f1)" = "$RCV_RUNNER_SHA" ] || recovery_handler_fail RECOVERY_FROZEN_RUNNER_PROVENANCE_INVALID
[ -f "$RCV_CONTROL/RECOVERY-RCV_CONTROL-SHA256SUMS" ] && [ "$(sha256sum "$RCV_CONTROL/RECOVERY-RCV_CONTROL-SHA256SUMS" | cut -d' ' -f1)" = "$RCV_CONTROL_SHA" ] || recovery_handler_fail RECOVERY_CONTROL_PROVENANCE_INVALID
[ "$(find "$RCV_APP" -type f ! -name RECOVERY-VERIFIER-SHA256SUMS | wc -l)" = "$(wc -l < "$MANIFEST")" ] || recovery_handler_fail VERIFIER_FILE_SET_DRIFT
for module in recovery_stage recovery_evidence recovery_client recovery_protocol local_restore ip_containment r1_acceptance r1bv_validation historical_disposition; do
  [ -f "$RCV_APP/aegis_soc/$module.py" ] || recovery_handler_fail "VERIFIER_CLOSURE_INCOMPLETE:$module"
done
RCV_AUDIT_DB="${AEGIS_RCVSTAGE_AUDIT_DB:-}"
[ -n "$RCV_AUDIT_DB" ] && [[ "$RCV_AUDIT_DB" == /* ]] && [ -f "$RCV_AUDIT_DB" ] || recovery_handler_fail AUDIT_DB_REQUIRED
RCV_MARKER="${AEGIS_RCVSTAGE_ATTEMPT_MARKER:-}"
[[ "$RCV_MARKER" == /* ]] && [[ "$RCV_MARKER" != *..* ]] || recovery_handler_fail ATTEMPT_MARKER_REQUIRED
# the verifier runs with a CLEAN environment, a fixed PATH and ONLY the immutable snapshot on the import path
umask 077
RUN() { env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_LOG_PATH="$RCV_WORK/stage-root.log" PYTHONDONTWRITEBYTECODE=1 "$RCV_PY" -I -B -c 'import runpy,sys; sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[1:]; runpy.run_module("aegis_soc.recovery_stage",run_name="__main__")' "$RCV_APP" "$@"; }
cd "$RCV_WORK" || recovery_handler_fail WORK_DIR_REQUIRED   # a neutral cwd: nothing in the working directory can shadow a module
RUN verify-result --audit-db "$RCV_AUDIT_DB" --work-dir "$RCV_WORK" --attempt-marker "$RCV_MARKER" || recovery_handler_fail RESULT_NOT_BOUND_TO_THE_ATTEMPT
printf 'RECOVERY_VERIFY=PASS\nRECOVERY_RESULT_BOUND_TO_ATTEMPT=YES\nRECOVERY_PROMOTION=NOT_AUTOMATIC\n'
printf 'R1B_RESULT=FAIL_IMMUTABLE\nR1BV_RESULT=PASS\nLVR_PROVEN=NO\nL8_ACCEPTANCE=NO\nL9_PROVEN=NO\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\n'
}
# recovery_handler STEP [SCRIPT] — the ROOT handlers come ONLY from the control snapshot, re-proved immediately before every root execution. Nothing derived from the operator's environment is passed except the frozen pins.
recovery_handler() {
  control_gate || return 1
  $SUDO env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_RCVSTAGE_LIVE_AUTHORIZED=YES AEGIS_RCVSTAGE_WORK_DIR="$WORK" AEGIS_RCVSTAGE_STEP="$1" AEGIS_RCVSTAGE_APP_DIR="$VERIFIER_SNAPSHOT_DIR" \
    AEGIS_RCVSTAGE_PROVENANCE_FILE="$WORK/RECOVERY-FROZEN-RUNNER-PROVENANCE" RECOVERY_FROZEN_RUNNER_SHA256="$RUNNER_SHA256" AEGIS_RCVSTAGE_CONTROL_DIR="$CTRL" AEGIS_RCVSTAGE_CONTROL_MANIFEST_SHA256="$CONTROL_MANIFEST_SHA256" \
    AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256="$VERIFIER_MANIFEST_SHA256" AEGIS_RCVSTAGE_AUDIT_DB="$AUDIT_DB" AEGIS_RCVSTAGE_PROTOCOL_DB="$PROTOCOL_DB" \
    AEGIS_RCVSTAGE_ATTEMPT_MARKER="$(recovery_canonical_dir)/$RECOVERY_GLOBAL_MARKER_NAME" AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP="$EXPECTED_SOURCE_IP" AEGIS_RCVSTAGE_DETECTOR_UID="$DETECTOR_UID" \
    AEGIS_RCVSTAGE_R1B_BASELINE="$R1B_EVIDENCE_DIR/r1b-work/r1-baseline.json" AEGIS_PYTHON_BIN="$PY" bash -c "$(declare -f recovery_handler_fail recovery_apply_governed recovery_verify_governed); if [ \"$2\" = verify.sh ]; then recovery_verify_governed; else recovery_apply_governed; fi"
}

# ===== PRE-AUTH / PRE-ATTEMPT gates (all read-only; NONE consumes the attempt) ==========================================================================
recovery_pregates() {
  local f gate_out
  # 1. exact-main + source integrity (pinned clean worktree; the deployed authority files byte-exact)
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
  git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
  recovery_digest_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" "$R1I_TOOL_SHA256" R1I_TOOL || gate "the R1I validator is not the frozen source"
  # 2. FRESH same-day stage=Recovery records (never an R1I/F1u/F1/R1B record), exact key sets, bound to this main, this runner, this release and this source. NO secret in either record.
  for f in authorization-Recovery.txt k3-Recovery.txt; do
    [ -f "$AUTH_DIR/$f" ] && [ ! -L "$AUTH_DIR/$f" ] || gate "$f missing"
    grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
    grep -qx "stage=Recovery" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=Recovery"
  done
  [ "$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$AUTH_DIR/authorization-Recovery.txt" 2>/dev/null | sort | tr '\n' ' ')" = "authorizer date reference scope stage " ] || gate "authorization-Recovery.txt carries a field other than stage/date/authorizer/scope/reference"
  [ "$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$AUTH_DIR/k3-Recovery.txt" 2>/dev/null | sort | tr '\n' ' ')" = "confirmation_mode confirmed_by date idea1_window_overlap reference stage " ] || gate "k3-Recovery.txt key set is not the V2 self-attestation set"
  grep -qF "$EXPECTED_MAIN" "$AUTH_DIR/authorization-Recovery.txt" 2>/dev/null || gate "authorization-Recovery.txt does not name the pinned main"
  grep -qF "$RUNNER_SHA256" "$AUTH_DIR/authorization-Recovery.txt" 2>/dev/null || gate "authorization-Recovery.txt does not name this exact runner SHA-256"
  grep -qF "$EXPECTED_SOURCE_IP" "$AUTH_DIR/authorization-Recovery.txt" 2>/dev/null || gate "authorization-Recovery.txt does not name the expected external source IP"
  grep -qF "$RELEASE_ID" "$AUTH_DIR/authorization-Recovery.txt" 2>/dev/null || gate "authorization-Recovery.txt does not name the pinned release"
  for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
  control_gate || gate "control snapshot drift before the stage gate"
  # 3. the REAL stage gate from the immutable control snapshot (never a grep/file-exists substitute)
  gate_out=$(TZ=Asia/Bangkok bash "$CTRL/p4-stage-gate.sh" --stage Recovery --mode live --authorization "$AUTH_DIR/authorization-Recovery.txt" --k3 "$AUTH_DIR/k3-Recovery.txt" 2>&1) || gate "stage gate failed"
  for f in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$f" || gate "stage gate did not report $f"; done
  # 4. the existing reviewed R1B-failure + R1Bv-PASS predecessor gate (pinned-commit receipt CONTENT), and the attempt authority
  recovery_predecessor_gate "$REPO" "$EXPECTED_MAIN" || gate "predecessor gate failed (see reason above)"
  recovery_ctu_successor_gate "$REPO" "$EXPECTED_MAIN" || recovery_ctv_successor_gate "$REPO" "$EXPECTED_MAIN" || gate "neither historical CTu PASS nor reviewed CTv PASS successor closeout is present"
  rru_recovery_successor_gate "$REPO" "$EXPECTED_MAIN" "$RELEASE_ID" || gate "RRu Recovery-runtime successor gate failed (see reason above)"
  recovery_attempt_unconsumed || gate "Recovery is ONE attempt TOTAL and one is already consumed, or the canonical marker directory is invalid"
  recovery_sudo_authority_gate || gate "the sudo keepalive is not healthy or the credential is not active (the runner establishes it once with sudo -v)"
  # 5. disk/headroom, preserved services, broker, IDEA2 S10
  l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
  l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
  l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent L6b broker gate failed (see reason above)"
  l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
  # 6. the live authority (immutable verifier, interpreter, R1I exact shape, Core/detector healthy, digests, current release, pinned restore CLI): the SAME function is re-run before the marker and before FINAL
  recovery_authority_gates || gate "the live authority is not intact (see reason above)"
  # 7. the Recovery socket is the Core surface; the bounded owner reason passes the production validator BEFORE any mutation (the SAME reason is later passed unchanged to D4)
  recovery_operator_py socket-check || gate "the Recovery socket is not the trusted Core surface"
  recovery_reason_gate "$RECOVERY_REASON" || gate "the owner reason is missing or invalid (nothing was consumed)"
  [ "$GATE_FAILED" = 0 ]
}
# recovery_prepare_evidence — the operator-side evidence directory + the tee'd run log (the D4 command bypasses it through fds 3/4). Created only after every pre-gate passed.
recovery_prepare_evidence() {
  mkdir -m 700 -- "$EVID" || return 1
  exec > >(tee -a "$EVID/owner-run.log") 2>&1
  JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
  CORE_PRE=$(snap "$CORE_UNIT"); DETECTOR_PRE=$(snap "$DETECTOR_UNIT")
  cp "$AUTH_DIR/authorization-Recovery.txt" "$AUTH_DIR/k3-Recovery.txt" "$EVID/"
  { echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE_ID=$RELEASE_ID"; echo "VERIFIER_MANIFEST_SHA256=$VERIFIER_MANIFEST_SHA256"; echo "RUNNER_SHA256=$RUNNER_SHA256"; echo "CORE_PRE=$CORE_PRE"; echo "DETECTOR_PRE=$DETECTOR_PRE"
    echo "EXPECTED_SOURCE_IP=$EXPECTED_SOURCE_IP"; printf 'REASON_SHA256=%s\n' "$(printf '%s' "$RECOVERY_REASON" | sha256sum | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
}

if recovery_run_attempt; then
  echo "RECOVERY_AUTOMATIC_RESULT_ONLY=YES"
  echo "RECOVERY_CLAIM_BOUNDARY: this is an automatic result. The canonical live closed-pass closeout, LVR, L8 and L9 are promoted ONLY by separately reviewed LIVE closeouts after independent inspection of the evidence. R1B stays FAIL_IMMUTABLE; R1Bv stays PASS."
  exit 0
fi
exit 1
