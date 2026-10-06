#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1Bv (successor READ-ONLY validation of the EXISTING failed R1B evidence) owner-run stage. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the repository, replaces the PIN_ values, records the frozen file's
# SHA-256 and only then authorizes a run. Nothing in this repository executes it or creates an authorization record.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-r1bv-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-R1Bv.txt (FRESH same-day, stage=R1Bv, no extra field; no K3: the stage is non-mutating)
# Stage order: ... -> R1I -> R1A (immutable FAIL) -> R1Du (PASS) -> R1D (immutable FAIL after a COMMITTED disposition) -> R1Dv (PASS) -> R1B (immutable FAIL at windowrecord) -> R1Bv -> Recovery R2-R8 -> LVR -> L8 -> L9.
# OWNER DECISIONS (fixed): R1Bv is a NON-MUTATING successor VALIDATION stage; R1BV_IS_R1B_RETRY=NO; R1B stays R1B_RESULT=FAIL_IMMUTABLE (attempt consumed, no rerun). It uses ONLY the existing R1B evidence: no new event, no
# incident or R1B marker mutation, no window-record creation or reconstruction. The historical bound comes from the ROOT-OWNED canonical R1B marker (primary); local records only corroborate; no widening, no grace.
# R1Bv validates the existing chain read-only (observer from the immutable verifier snapshot, SQLite opened mode=ro) between a PRE and a POST capture. It has NO observation sleep. It promotes no claim and never claims R1B PASS.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
RELEASE_ID=PIN_RELEASE_ID
PRODUCTION_DETECTOR_SHA256=PIN_PRODUCTION_DETECTOR_SHA256
DETECTOR_UNIT_SHA256=PIN_DETECTOR_UNIT_SHA256
RECOVERY_CORE_SHA256=PIN_RECOVERY_CORE_SHA256
CONTROL_SNAPSHOT_DIR=PIN_CONTROL_SNAPSHOT_DIR
CONTROL_MANIFEST_SHA256=PIN_CONTROL_MANIFEST_SHA256
VERIFIER_SNAPSHOT_DIR=PIN_VERIFIER_SNAPSHOT_DIR
VERIFIER_MANIFEST_SHA256=PIN_VERIFIER_MANIFEST_SHA256
R1I_TOOL_SHA256=PIN_R1I_TOOL_SHA256
AUDIT_DB=PIN_AUDIT_DB_PATH
DETECTOR_UID=PIN_DETECTOR_UID
EXPECTED_SOURCE_IP=PIN_EXPECTED_SOURCE_IP
R1B_EVIDENCE_DIR=PIN_R1B_EVIDENCE_DIR
R1B_AUTH_DIR=PIN_R1B_AUTH_DIR
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RELEASE_ID PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 VERIFIER_SNAPSHOT_DIR VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256 EXPECTED_SOURCE_IP R1B_EVIDENCE_DIR R1B_AUTH_DIR AUDIT_DB DETECTOR_UID; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier."; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid."; exit 2; }
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$RELEASE_ID" != *..* ]] || { echo "STOP: RELEASE_ID is not a valid release id."; exit 2; }
for pin in PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 CONTROL_MANIFEST_SHA256 VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256; do
  [[ "${!pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: $pin is not a 64-hex SHA-256."; exit 2; }
done
[[ "$DETECTOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: DETECTOR_UID is not a valid non-root uid."; exit 2; }
[[ "$VERIFIER_SNAPSHOT_DIR" == /* ]] && [[ "$VERIFIER_SNAPSHOT_DIR" != *..* ]] && [[ "$CONTROL_SNAPSHOT_DIR" == /* ]] && [[ "$CONTROL_SNAPSHOT_DIR" != *..* ]] || { echo "STOP: VERIFIER_SNAPSHOT_DIR and CONTROL_SNAPSHOT_DIR must be absolute paths."; exit 2; }
[[ "$AUDIT_DB" == /* ]] && [[ "$AUDIT_DB" != *..* ]] || { echo "STOP: AUDIT_DB must be an absolute path."; exit 2; }
[[ "$EXPECTED_SOURCE_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "STOP: EXPECTED_SOURCE_IP is not a dotted IPv4 pin."; exit 2; }
[[ "$R1B_EVIDENCE_DIR" == /* ]] && [[ "$R1B_EVIDENCE_DIR" != *..* ]] && [[ "$R1B_AUTH_DIR" == /* ]] && [[ "$R1B_AUTH_DIR" != *..* ]] || { echo "STOP: R1B_EVIDENCE_DIR and R1B_AUTH_DIR must be absolute paths."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
# No environment may redirect a live run: fixture roots, handler overrides and R1Bv/R1I switches must all be unset.
for var in AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_R1BV_STEP AEGIS_R1BV_WORK_DIR AEGIS_R1BV_LIVE_AUTHORIZED AEGIS_R1BV_APP_DIR AEGIS_R1BV_AUDIT_DB AEGIS_R1BV_EXPECTED_SOURCE_IP AEGIS_R1BV_R1B_EVIDENCE_DIR AEGIS_R1BV_R1B_AUTH_DIR AEGIS_R1BV_RELEASE_ID AEGIS_R1BV_DETECTOR_SHA256 AEGIS_R1BV_DETECTOR_UID AEGIS_R1BV_TEST_ONLY_MARKER AEGIS_R1BV_VERIFIER_MANIFEST_SHA256 R1BV_TEST_ONLY_SNAPSHOT_TRUST_ENABLED R1BV_TEST_ONLY_SNAPSHOT_TRUST_ROOT R1BV_CANONICAL_DIR R1BV_TEST_ONLY_CANONICAL_DIR R1BV_TEST_ONLY_CANONICAL_DIR_ENABLED GLOBAL_MARKER_DIR AEGIS_R1I_LIVE_AUTHORIZED; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set; refusing a live run."; exit 2; }
done
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-R1Bv.txt>"; exit 2; }

# Snapshot ownership invariant (LITERAL constants of the frozen runner, not environment): the control snapshot and EVERY ancestor up to the trusted parent are owned by this uid and not group/world writable.
# The committed template pins 0 (root) and `/`; a test copy may substitute its own values, a live freeze must not.
SNAPSHOT_OWNER_UID=0
SNAPSHOT_TRUST_ROOT=/

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH   # replaced by the freeze workflow: a worktree at EXPECTED_MAIN used ONLY to read pinned git objects (receipts, byte-equality); NO shell or Python is sourced or executed from it
case "$REPO" in */PIN_*) echo "STOP: runner is not pinned (REPO). Run the owner freeze workflow first."; exit 2 ;; esac
PY=PIN_PYTHON_BIN
case "$PY" in PIN_*) echo "STOP: runner is not pinned (PY). Run the owner freeze workflow first."; exit 2 ;; esac
# The LIVE control plane is the frozen IMMUTABLE control snapshot (the manifested copy of deploy/pr11-phase4 at EXPECTED_MAIN): every sourced library and every script root executes comes from CTRL.
CTRL=$CONTROL_SNAPSHOT_DIR
STG=$CTRL/stages/R1Bv
LIB=$CTRL/p4-r1bv-run-lib.sh
GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
RELEASE_PATH=/opt/aegis-idea3/releases/$RELEASE_ID
CURRENT_LINK=/opt/aegis-idea3/current
CORE_UNIT=aegis-idea3-core.service
DETECTOR_UNIT=aegis-idea3-detector.service
BROKER_UNIT=aegis-idea3-mosquitto.service
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
AP_IF=wlp0s20f3; AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F); STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/PIN_EVIDENCE_ROOT/$TODAY-r1bv-$STAMP
case "$EVID" in /PIN_*) echo "STOP: runner is not pinned (EVID). Run the owner freeze workflow first."; exit 2 ;; esac
WORK=$EVID/r1bv-work; PRE=$EVID/pre-root; POST=$EVID/post-root

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }
# Git authority reads run with replacement objects DISABLED on every invocation (a real `git replace GOOD EVIL` would otherwise keep the apparent SHA while changing the bytes Git returns). A shell function,
# so it also covers the git calls inside every library sourced later; a caller's environment cannot re-enable replacement.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }
# control_gate — the frozen runner re-proves the control snapshot ITSELF (inline, never via sourced code): manifest digest, every file's digest, exact file set, no symlink, nothing writable. Run BEFORE the first
# source and again immediately before EVERY root execution (capture, compare, stage handlers, stage gate).
control_gate() {
  local m="$CTRL/R1BV-CONTROL-SHA256SUMS" d
  [ -d "$CTRL" ] && [ ! -L "$CTRL" ] && [ -f "$m" ] && [ ! -L "$m" ] || { echo "GATE_FAIL: CONTROL_SNAPSHOT_INVALID" >&2; return 1; }
  # OWNERSHIP INVARIANT: canonical path; every entry owned by SNAPSHOT_OWNER_UID; every ancestor up to SNAPSHOT_TRUST_ROOT a real directory owned by it and not group/world writable. A same-uid owner could
  # otherwise chmod a read-only snapshot writable and swap bytes between this gate and a privileged execution.
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
  ( cd "$CTRL" && sha256sum -c --quiet --strict R1BV-CONTROL-SHA256SUMS ) >/dev/null 2>&1 || { echo "GATE_FAIL: CONTROL_FILE_DRIFT" >&2; return 1; }
  [ -z "$(find "$CTRL" -type l -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SYMLINK_PRESENT" >&2; return 1; }
  [ -z "$(find "$CTRL" -perm /222 -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SOURCE_WRITABLE" >&2; return 1; }
  [ "$(find "$CTRL" -type f ! -name R1BV-CONTROL-SHA256SUMS -printf '%P\n' | LC_ALL=C sort)" = "$(cut -c67- "$m" | LC_ALL=C sort)" ] || { echo "GATE_FAIL: CONTROL_FILE_SET_DRIFT" >&2; return 1; }
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
  done < "$CTRL/R1BV-CONTROL-SHA256SUMS"
}
control_gate || die "the control snapshot is not the frozen immutable authority; nothing was sourced, created or touched"
control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was sourced, created or touched"
# EVERY privileged command after the single interactive `sudo -v` below is NON-INTERACTIVE (`sudo -n`): the libraries use $SUDO, so it is fixed to `sudo -n` BEFORE they are sourced. An expired credential makes the
# command itself fail (no password prompt can stall the stage, including on the failure path).
SUDO="sudo -n"
# shellcheck disable=SC1090
source "$LIB"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen R1Bv operator; nothing was created or touched"
echo "R1BV_IS_R1B_RETRY=NO R1BV_READ_ONLY_VALIDATION_ONLY=YES R1BV_NEW_EXTERNAL_EVENT_FORBIDDEN=YES R1BV_ATTEMPT_MARKER_CREATED=NO R1BV_WINDOW_RECORD_CREATED=NO R1I_MUST_REMAIN_INSTALLED=YES RECOVERY_R2_R8_EXECUTED=NO"
sudo -v || die "sudo authentication failed"

CORE_PRE=""; DETECTOR_PRE=""
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }

# authority_gates — the complete live authority. Read-only; returns non-zero (reasons on stderr) if ANY link is not intact. Run in the pre-gates, again in the regate before the marker, and again IMMEDIATELY before FINAL.
authority_gates() {
  local rc=0
  control_gate || rc=1
  control_git_gate || rc=1
  r1bv_verifier_gate "$VERIFIER_SNAPSHOT_DIR" "$VERIFIER_MANIFEST_SHA256" "$REPO" "$PRODUCTION_DETECTOR_SHA256" "$CTRL/r1bv-acceptance/r1bv_verifier_snapshot.py" "$EXPECTED_MAIN" || rc=1
  r1bv_interpreter_gate "$PY" || rc=1
  r1bv_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || rc=1
  l7u_core_running_gate "$CORE_UNIT" || rc=1
  f1u_detector_running_gate || rc=1
  r1bv_digest_gate "$RELEASE_PATH/aegis_soc/production_detector.py" "$PRODUCTION_DETECTOR_SHA256" DETECTOR_SOURCE || rc=1
  r1bv_digest_gate "$RELEASE_PATH/aegis_soc/recovery_core.py" "$RECOVERY_CORE_SHA256" RECOVERY_CORE || rc=1
  r1bv_digest_gate "/etc/systemd/system/$DETECTOR_UNIT" "$DETECTOR_UNIT_SHA256" DETECTOR_UNIT || rc=1
  r1bv_current_release_gate "$CURRENT_LINK" "$RELEASE_PATH" || rc=1
  [ -z "$CORE_PRE" ] || runtime_unchanged || { r1bv_reason "R1BV_CORE_OR_DETECTOR_IDENTITY_CHANGED"; rc=1; }
  return "$rc"
}

# ===== PRE-AUTH / PRE-ATTEMPT gates (all read-only; NONE consumes the attempt) ==========================================================================
pregates() {
  local f
  # 1-2. exact-main + source integrity (pinned clean worktree; R1I tool and the deployed authority files byte-exact)
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
  git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
  r1bv_digest_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" "$R1I_TOOL_SHA256" R1I_TOOL || gate "the R1I validator is not the frozen source"
  # 3-4. the FRESH same-day stage=R1Bv Authorization (exact key set; NO K3: the stage is non-mutating), bound to this main and this exact runner SHA-256 (which embeds every pin)
  f=authorization-R1Bv.txt
  [ -f "$AUTH_DIR/$f" ] && [ ! -L "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=R1Bv" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=R1Bv"
  [ "$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$AUTH_DIR/$f" 2>/dev/null | sort | tr '\n' ' ')" = "authorizer date reference scope stage " ] || gate "$f carries a field other than stage/date/authorizer/scope/reference"
  grep -qF "$EXPECTED_MAIN" "$AUTH_DIR/$f" 2>/dev/null || gate "$f does not name the pinned main"
  grep -qF "$RUNNER_SHA256" "$AUTH_DIR/$f" 2>/dev/null || gate "$f does not name this exact runner SHA-256"
  [ ! -e "$AUTH_DIR/k3-R1Bv.txt" ] || gate "a K3 record is not part of the non-mutating R1Bv workflow"
  for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
  control_gate || gate "control snapshot drift before the stage gate"
  gate_out=$(TZ=Asia/Bangkok bash "$CTRL/p4-stage-gate.sh" --stage R1Bv --mode live --authorization "$AUTH_DIR/authorization-R1Bv.txt" 2>&1) || gate "stage gate failed"
  for f in AUTHORIZATION_RECORD=VALID STAGE_MUTATES_PRODUCTION=NO READ_ONLY_CAPTURE_ALLOWED=YES; do printf '%s\n' "$gate_out" | grep -qx "$f" || gate "stage gate did not report $f"; done
  # 5. predecessors (pinned-commit receipt CONTENT incl. the unique immutable R1B failure closeout and the unique R1Dv LIVE PASS closeout) and the canonical governance history (R1A and R1D present, R1B marker PRESENT, R1B window record ABSENT)
  r1bv_receipt_gate "$REPO" "$RELEASE_ID" "$EXPECTED_MAIN" || gate "predecessor receipt gate failed (see reason above)"
  r1bv_history_gate || gate "the canonical R1A/R1D/R1B governance history is not as R1Bv requires (see reason above)"
  r1bv_corroboration_gate "$R1B_AUTH_DIR" "$R1B_EVIDENCE_DIR" || gate "a preserved R1B artifact the observer needs is absent (never invented; see reason above)"
  # 6-7. disk/headroom, preserved services
  l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
  l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
  l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent L6b broker gate failed (see reason above)"
  l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
  # 8-13. the live authority (immutable verifier, interpreter, R1I exact shape, Core/detector healthy, detector source/unit/recovery digests, current release)
  authority_gates || gate "the live authority is not intact (see reason above)"
  r1bv_journal_access_gate || gate "the journal is not readable (see reason above)"
  [ "$GATE_FAILED" = 0 ]
}


capture() { control_gate || return 1; sudo -n env PYTHONPATH="$VERIFIER_SNAPSHOT_DIR" PYTHONDONTWRITEBYTECODE=1 EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$CTRL/p4-l0-capture.sh" || return 1
  sudo -n grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo -n bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE — NO allowed drift for R1Bv: every captured generic key must be identical.
  local rc=0
  control_gate || return 1
  sudo -n env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$CTRL/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 FINDINGS_APPROVED_CHANGE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
# TrustedClock evidence must be AVAILABLE (a probe that cannot run records UNAVAILABLE, which the comparator correctly refuses as INCOMPARABLE): exactly one record whose value is a real state, in BOTH captures.
# Evidence is AVAILABLE only when exactly ONE record carries an actually evaluated state. UNKNOWN (p4-l5-clock.py: PROBE_UNAVAILABLE), UNAVAILABLE, NOT_RECORDED, empty, missing, duplicate and any other value are refused.
clock_available() { awk -F'\t' '$1=="time.trustedclock.state" {n++; v=$2} END{exit (n==1 && (v=="SYNCED" || v=="HOLDOVER" || v=="UNTRUSTED")) ? 0 : 1}' "$1/time.tsv"; }
# The handlers run as ROOT and are READ-ONLY observers (BASELINE, FINAL). They have no marker, no socket, no caller and no DISPOSE step.
handler() {
  control_gate || return 1   # root never executes a handler whose control snapshot drifted
  sudo -n env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_R1BV_LIVE_AUTHORIZED=YES AEGIS_R1BV_WORK_DIR="$WORK" AEGIS_R1BV_STEP="$1" AEGIS_R1BV_APP_DIR="$VERIFIER_SNAPSHOT_DIR" AEGIS_R1BV_VERIFIER_MANIFEST_SHA256="$VERIFIER_MANIFEST_SHA256" \
    AEGIS_R1BV_AUDIT_DB="$AUDIT_DB" AEGIS_R1BV_EXPECTED_SOURCE_IP="$EXPECTED_SOURCE_IP" AEGIS_R1BV_R1B_EVIDENCE_DIR="$R1B_EVIDENCE_DIR" AEGIS_R1BV_R1B_AUTH_DIR="$R1B_AUTH_DIR" AEGIS_R1BV_RELEASE_ID="$RELEASE_ID" AEGIS_R1BV_DETECTOR_SHA256="$PRODUCTION_DETECTOR_SHA256" AEGIS_R1BV_DETECTOR_UID="$DETECTOR_UID" AEGIS_PYTHON_BIN="$PY" PYTHONDONTWRITEBYTECODE=1 \
    bash "$STG/${2:-apply.sh}"
}
runtime_unchanged() { [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ] && [ "$(snap $DETECTOR_UNIT)" = "$DETECTOR_PRE" ]; }

# ---- the R1Bv sequence (no attempt state machine, no marker, no window record, no sleep: the stage is read-only and owns no one-shot) ---------------------------------------------------------------------------
# Every privileged phase is preceded by a NON-INTERACTIVE sudo credential check (a lapsed credential fails HERE with a reason, never as an ambiguous late-stage failure like the R1B windowrecord failure).
r1bv_fail() { echo "R1BV_RESULT=FAIL R1BV_FAILED_STAGE=$1 R1BV_IS_R1B_RETRY=NO R1BV_MUTATION_PERFORMED=NO (read-only; R1Bv owns NOTHING to roll back, so the failure path invokes NO privileged command and cannot prompt; R1B stays R1B_RESULT=FAIL_IMMUTABLE; evidence kept at $EVID)"; exit 1; }
echo "== R1Bv pre-gates (read-only)"
pregates || die "one or more pre-gates failed; NOTHING was created or changed on the host"
CORE_PRE=$(snap $CORE_UNIT); DETECTOR_PRE=$(snap $DETECTOR_UNIT)
mkdir -m 700 "$EVID" && exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-R1Bv.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE_ID=$RELEASE_ID"; echo "VERIFIER_MANIFEST_SHA256=$VERIFIER_MANIFEST_SHA256"; echo "RUNNER_SHA256=$RUNNER_SHA256"; echo "CORE_PRE=$CORE_PRE"; echo "DETECTOR_PRE=$DETECTOR_PRE"; } > "$EVID/frozen-inputs.txt"
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_workdir
sudo -n install -d -m 700 -o root -g root "$WORK" || r1bv_fail workdir
echo "== PRE capture (read-only)"
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_pre_capture
capture PRE "$PRE" || r1bv_fail pre_capture
sudo -n chown -R "$(id -u):$(id -g)" "$PRE" 2>/dev/null || true
clock_available "$PRE" || { echo "R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=NO capture=pre"; r1bv_fail trustedclock_pre; }
echo "== R1Bv BASELINE validation of the existing R1B evidence (read-only; the bound comes from the root-owned canonical R1B marker)"
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_baseline
handler BASELINE || r1bv_fail baseline
echo "== POST capture and PRE -> POST comparison (read-only)"
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_post_capture
capture POST "$POST" || r1bv_fail post_capture
sudo -n chown -R "$(id -u):$(id -g)" "$POST" 2>/dev/null || true
clock_available "$POST" || { echo "R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=NO capture=post"; r1bv_fail trustedclock_post; }
echo "R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES (the CURRENT clock; this is NOT evidence of the historical R1B clock state)"
compare "$PRE" "$POST" "$EVID/compare-pre-post.txt" || r1bv_fail compare
# The FINAL observation is the LAST substantive host-state validation: the fresh authority/lifecycle/R1I gates run immediately BEFORE it, and FINAL (which must reproduce BASELINE with an unchanged fingerprint) covers the whole window.
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_authority
authority_gates || r1bv_fail authority_before_final
echo "R1BV_R1I_STATE=PASS"
echo "== R1Bv FINAL observation (read-only; last host-state validation before verify)"
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_final
handler FINAL || r1bv_fail final
r1bv_sudo_noninteractive_gate || r1bv_fail sudo_credential_verify
out=$(handler FINAL verify.sh 2>&1) || { printf '%s\n' "$out"; r1bv_fail verify; }
printf '%s\n' "$out"; grep -qx 'R1BV_VERIFY=PASS' <<< "$out" || r1bv_fail verify
echo "R1BV_RESULT=PASS R1BV_LIVE_EXECUTED=YES R1BV_IS_R1B_RETRY=NO R1BV_READ_ONLY_VALIDATION_ONLY=YES R1BV_PRESERVATION_S10=PASS R1BV_COMPARE_RESULT=PASS (automatic result only)"
echo "R1BV_CLAIM_BOUNDARY: R1Bv validates the EXISTING R1B evidence only. R1B stays R1B_RESULT=FAIL_IMMUTABLE (R1B_RESULT_REWRITTEN=NO). F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R1_R8_PROVEN=NO RECOVERY_R2_R8_EXECUTED=NO"
exit 0
