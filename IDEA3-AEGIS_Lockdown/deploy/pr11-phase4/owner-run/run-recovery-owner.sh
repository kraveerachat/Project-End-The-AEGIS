#!/usr/bin/env bash
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
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RELEASE_ID PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256 RELEASE_SUMS_SHA256 CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 VERIFIER_SNAPSHOT_DIR VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256 PROTOCOL_DB AUDIT_DB R1B_EVIDENCE_DIR EXPECTED_SOURCE_IP DETECTOR_UID RUNTIME_DIR; do
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
for pin in CONTROL_SNAPSHOT_DIR VERIFIER_SNAPSHOT_DIR PROTOCOL_DB AUDIT_DB R1B_EVIDENCE_DIR RUNTIME_DIR; do
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
  control_gate || rc=1
  control_git_gate || rc=1
  recovery_verifier_gate "$VERIFIER_SNAPSHOT_DIR" "$VERIFIER_MANIFEST_SHA256" "$REPO" "$CTRL/recovery-acceptance/recovery_verifier_snapshot.py" "$EXPECTED_MAIN" || rc=1
  recovery_interpreter_gate "$PY" || rc=1
  recovery_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || rc=1
  l7u_core_running_gate "$CORE_UNIT" || rc=1
  f1u_detector_running_gate || rc=1
  recovery_digest_gate "$RELEASE_PATH/aegis_soc/production_detector.py" "$PRODUCTION_DETECTOR_SHA256" DETECTOR_SOURCE || rc=1
  recovery_digest_gate "$RELEASE_PATH/aegis_soc/recovery_core.py" "$RECOVERY_CORE_SHA256" RECOVERY_CORE || rc=1
  recovery_digest_gate "/etc/systemd/system/$DETECTOR_UNIT" "$DETECTOR_UNIT_SHA256" DETECTOR_UNIT || rc=1
  recovery_current_release_gate "$CURRENT_LINK" "$RELEASE_PATH" || rc=1
  recovery_release_closure_gate "$RELEASE_ID" "$RELEASE_PATH" "$RELEASE_SUMS_SHA256" || rc=1
  recovery_cli_gate "$RELEASE_PATH" "$RESTORE_CLI_SHA256" || rc=1
  [ -z "$CORE_PRE" ] || recovery_runtime_unchanged || { recovery_reason "RECOVERY_CORE_OR_DETECTOR_IDENTITY_CHANGED"; rc=1; }
  return "$rc"
}
# recovery_handler STEP [SCRIPT] — the ROOT handlers come ONLY from the control snapshot, re-proved immediately before every root execution. Nothing derived from the operator's environment is passed except the frozen pins.
recovery_handler() {
  control_gate || return 1
  $SUDO env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_RCVSTAGE_LIVE_AUTHORIZED=YES AEGIS_RCVSTAGE_WORK_DIR="$WORK" AEGIS_RCVSTAGE_STEP="$1" AEGIS_RCVSTAGE_APP_DIR="$VERIFIER_SNAPSHOT_DIR" \
    AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256="$VERIFIER_MANIFEST_SHA256" AEGIS_RCVSTAGE_AUDIT_DB="$AUDIT_DB" AEGIS_RCVSTAGE_PROTOCOL_DB="$PROTOCOL_DB" \
    AEGIS_RCVSTAGE_ATTEMPT_MARKER="$(recovery_canonical_dir)/$RECOVERY_GLOBAL_MARKER_NAME" AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP="$EXPECTED_SOURCE_IP" AEGIS_RCVSTAGE_DETECTOR_UID="$DETECTOR_UID" \
    AEGIS_RCVSTAGE_R1B_BASELINE="$R1B_EVIDENCE_DIR/r1b-work/r1-baseline.json" AEGIS_PYTHON_BIN="$PY" PYTHONDONTWRITEBYTECODE=1 bash "$STG/${2:-apply.sh}"
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
