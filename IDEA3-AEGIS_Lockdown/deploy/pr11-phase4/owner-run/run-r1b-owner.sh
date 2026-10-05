#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1B successor real-detector acceptance LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the repository, replaces the PIN_ values, records
# the frozen file's SHA-256 and only then authorizes a run. Nothing in this repository executes it, creates an authorization or K3 record, freezes a pin, or generates the event.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-r1b-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-R1B.txt and k3-R1B.txt (FRESH same-day, stage=R1B, no extra field)
# Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> F1u -> R1I -> R1A(CLOSED_FAIL, immutable) -> R1B -> Recovery R2-R8 -> LVR -> L8 -> L9. Recovery R2-R8 stays BLOCKED until a separately reviewed R1B LIVE closeout succeeds.
# OWNER-APPROVED MODEL (fixed): R1B is a NEW successor stage after immutable R1A FAIL, never an R1A retry/replay. R1B is a MUTATING governed stage (a genuine external event may durably create ALERT_ACCEPTED, INCIDENT_BOUND and an OPEN incident); ONE attempt; NO retry; the event must be
# GENUINE and EXTERNAL. This runner OBSERVES ONLY: it generates no traffic, alert, journal line, Core write or database write. It keeps the R1I table installed. Genuine evidence is never deleted, closed,
# edited or rolled back; a failed attempt stops with the evidence preserved and the marker kept (R1B_RESULT=FAIL, R1B_RERUN_ALLOWED=NO).
# The automatic result NEVER promotes F1_REAL_DETECTOR_ACCEPTANCE or R1_VERIFIED; promotion needs a separately reviewed LIVE closeout.
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
OBSERVE_SECONDS=PIN_OBSERVE_SECONDS
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RELEASE_ID PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 CONTROL_SNAPSHOT_DIR CONTROL_MANIFEST_SHA256 VERIFIER_SNAPSHOT_DIR VERIFIER_MANIFEST_SHA256 R1I_TOOL_SHA256 AUDIT_DB DETECTOR_UID EXPECTED_SOURCE_IP OBSERVE_SECONDS; do
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
_octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
[[ "$EXPECTED_SOURCE_IP" =~ ^$_octet\.$_octet\.$_octet\.$_octet$ ]] && [[ "${EXPECTED_SOURCE_IP%%.*}" != 0 && "${EXPECTED_SOURCE_IP%%.*}" != 127 && "${EXPECTED_SOURCE_IP%%.*}" -lt 224 && "$EXPECTED_SOURCE_IP" != 169.254.* ]] \
  || { echo "STOP: EXPECTED_SOURCE_IP is not a valid external-capable IPv4 address."; exit 2; }
[[ "$VERIFIER_SNAPSHOT_DIR" == /* ]] && [[ "$VERIFIER_SNAPSHOT_DIR" != *..* ]] && [[ "$CONTROL_SNAPSHOT_DIR" == /* ]] && [[ "$CONTROL_SNAPSHOT_DIR" != *..* ]] || { echo "STOP: VERIFIER_SNAPSHOT_DIR and CONTROL_SNAPSHOT_DIR must be absolute paths."; exit 2; }
[[ "$OBSERVE_SECONDS" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "STOP: OBSERVE_SECONDS is not a bounded positive integer."; exit 2; }
[[ "$AUDIT_DB" == /* ]] && [[ "$AUDIT_DB" != *..* ]] || { echo "STOP: AUDIT_DB must be an absolute path."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
# No environment may redirect a live run: fixture roots, handler overrides and R1B/R1I switches must all be unset.
for var in AEGIS_P4_FS_ROOT P4_FS_ROOT AEGIS_P4_HANDLER_DIR AEGIS_R1B_STEP AEGIS_R1B_WORK_DIR AEGIS_R1B_LIVE_AUTHORIZED AEGIS_R1B_APP_DIR AEGIS_R1B_AUDIT_DB AEGIS_R1B_EXPECTED_SOURCE_IP AEGIS_R1B_WINDOW_START AEGIS_R1B_WINDOW_END AEGIS_R1B_VERIFIER_MANIFEST_SHA256 R1B_TEST_ONLY_SNAPSHOT_TRUST_ENABLED R1B_TEST_ONLY_SNAPSHOT_TRUST_ROOT R1B_WINDOW_START R1B_WINDOW_END R1B_CANONICAL_DIR R1B_TEST_ONLY_CANONICAL_DIR R1B_TEST_ONLY_CANONICAL_DIR_ENABLED GLOBAL_MARKER_DIR AEGIS_R1I_LIVE_AUTHORIZED; do
  [ -z "${!var:-}" ] || { echo "STOP: environment override $var is set; refusing a live run."; exit 2; }
done
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-R1B.txt and k3-R1B.txt>"; exit 2; }

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
STG=$CTRL/stages/R1B
LIB=$CTRL/p4-r1b-run-lib.sh
GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
RELEASE_PATH=/opt/aegis-idea3/releases/$RELEASE_ID
CURRENT_LINK=/opt/aegis-idea3/current
CORE_UNIT=aegis-idea3-core.service
DETECTOR_UNIT=aegis-idea3-detector.service
BROKER_UNIT=aegis-idea3-mosquitto.service
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
AP_IF=wlp0s20f3; AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F); STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/PIN_EVIDENCE_ROOT/$TODAY-r1b-$STAMP
case "$EVID" in /PIN_*) echo "STOP: runner is not pinned (EVID). Run the owner freeze workflow first."; exit 2 ;; esac
WORK=$EVID/r1b-work; PRE=$EVID/pre-root; PRECHECK=$EVID/preconsume-root; POST=$EVID/post-root
PRECONSUME_STABILITY_SECONDS=5

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }
# Git authority reads run with replacement objects DISABLED on every invocation (a real `git replace GOOD EVIL` would otherwise keep the apparent SHA while changing the bytes Git returns). A shell function,
# so it also covers the git calls inside every library sourced later; a caller's environment cannot re-enable replacement.
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }
# control_gate — the frozen runner re-proves the control snapshot ITSELF (inline, never via sourced code): manifest digest, every file's digest, exact file set, no symlink, nothing writable. Run BEFORE the first
# source and again immediately before EVERY root execution (capture, compare, stage handlers, stage gate).
control_gate() {
  local m="$CTRL/R1B-CONTROL-SHA256SUMS" d
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
  ( cd "$CTRL" && sha256sum -c --quiet --strict R1B-CONTROL-SHA256SUMS ) >/dev/null 2>&1 || { echo "GATE_FAIL: CONTROL_FILE_DRIFT" >&2; return 1; }
  [ -z "$(find "$CTRL" -type l -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SYMLINK_PRESENT" >&2; return 1; }
  [ -z "$(find "$CTRL" -perm /222 -print -quit)" ] || { echo "GATE_FAIL: CONTROL_SOURCE_WRITABLE" >&2; return 1; }
  [ "$(find "$CTRL" -type f ! -name R1B-CONTROL-SHA256SUMS -printf '%P\n' | LC_ALL=C sort)" = "$(cut -c67- "$m" | LC_ALL=C sort)" ] || { echo "GATE_FAIL: CONTROL_FILE_SET_DRIFT" >&2; return 1; }
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
  done < "$CTRL/R1B-CONTROL-SHA256SUMS"
}
control_gate || die "the control snapshot is not the frozen immutable authority; nothing was sourced, created or touched"
control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was sourced, created or touched"
# shellcheck disable=SC1090
source "$LIB"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen R1B operator; nothing was created or touched"
echo "R1B_SYNTHETIC_EVENT_GENERATED=NO R1B_IS_R1A_RETRY=NO R1A_RESULT=FAIL_IMMUTABLE R1I_MUST_REMAIN_INSTALLED=YES RECOVERY_R2_R8_EXECUTED=NO"
sudo -v || die "sudo authentication failed"

CORE_PRE=""; DETECTOR_PRE=""
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }

# authority_gates — the complete live authority. Read-only; returns non-zero (reasons on stderr) if ANY link is not intact. Run in the pre-gates, again in the regate before the marker, and again IMMEDIATELY before FINAL.
authority_gates() {
  local rc=0
  control_gate || rc=1
  control_git_gate || rc=1
  r1b_verifier_gate "$VERIFIER_SNAPSHOT_DIR" "$VERIFIER_MANIFEST_SHA256" "$REPO" "$PRODUCTION_DETECTOR_SHA256" "$CTRL/r1b-acceptance/r1b_verifier_snapshot.py" "$EXPECTED_MAIN" || rc=1
  r1b_interpreter_gate "$PY" || rc=1
  r1b_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || rc=1
  l7u_core_running_gate "$CORE_UNIT" || rc=1
  f1u_detector_running_gate || rc=1
  r1b_digest_gate "$RELEASE_PATH/aegis_soc/production_detector.py" "$PRODUCTION_DETECTOR_SHA256" DETECTOR_SOURCE || rc=1
  r1b_digest_gate "$RELEASE_PATH/aegis_soc/recovery_core.py" "$RECOVERY_CORE_SHA256" RECOVERY_CORE || rc=1
  r1b_digest_gate "/etc/systemd/system/$DETECTOR_UNIT" "$DETECTOR_UNIT_SHA256" DETECTOR_UNIT || rc=1
  r1b_current_release_gate "$CURRENT_LINK" "$RELEASE_PATH" || rc=1
  [ -z "$CORE_PRE" ] || runtime_unchanged || { r1b_reason "R1B_CORE_OR_DETECTOR_IDENTITY_CHANGED"; rc=1; }
  return "$rc"
}

# ===== PRE-AUTH / PRE-ATTEMPT gates (all read-only; NONE consumes the attempt) ==========================================================================
pregates() {
  local f
  # 1-2. exact-main + source integrity (pinned clean worktree; r1_acceptance, R1I tool and the deployed authority files byte-exact)
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
  git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
  r1b_digest_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" "$R1I_TOOL_SHA256" R1I_TOOL || gate "the R1I validator is not the frozen source"
  # 3. runner integrity: the owner records the frozen runner SHA-256 in the authorization scope (checked below)
  # 4-5. FRESH same-day stage=R1B records (never an R1I/F1u/F1 record), exact key sets, bound to this main and this runner
  for f in authorization-R1B.txt k3-R1B.txt; do
    [ -f "$AUTH_DIR/$f" ] && [ ! -L "$AUTH_DIR/$f" ] || gate "$f missing"
    grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
    grep -qx "stage=R1B" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=R1B"
  done
  [ "$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$AUTH_DIR/authorization-R1B.txt" 2>/dev/null | sort | tr '\n' ' ')" = "authorizer date reference scope stage " ] || gate "authorization-R1B.txt carries a field other than stage/date/authorizer/scope/reference"
  [ "$(sed -n '2,$ s/^\([a-z0-9_]*\)=.*/\1/p' "$AUTH_DIR/k3-R1B.txt" 2>/dev/null | sort | tr '\n' ' ')" = "confirmation_mode confirmed_by date idea1_window_overlap reference stage " ] || gate "k3-R1B.txt key set is not the V2 self-attestation set"
  grep -qF "$EXPECTED_MAIN" "$AUTH_DIR/authorization-R1B.txt" 2>/dev/null || gate "authorization-R1B.txt does not name the pinned main"
  grep -qF "$RUNNER_SHA256" "$AUTH_DIR/authorization-R1B.txt" 2>/dev/null || gate "authorization-R1B.txt does not name this exact runner SHA-256"
  grep -qF "$EXPECTED_SOURCE_IP" "$AUTH_DIR/authorization-R1B.txt" 2>/dev/null || gate "authorization-R1B.txt does not name the expected external source IP"
  for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
  control_gate || gate "control snapshot drift before the stage gate"
  gate_out=$(TZ=Asia/Bangkok bash "$CTRL/p4-stage-gate.sh" --stage R1B --mode live --authorization "$AUTH_DIR/authorization-R1B.txt" --k3 "$AUTH_DIR/k3-R1B.txt" 2>&1) || gate "stage gate failed"
  for f in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$f" || gate "stage gate did not report $f"; done
  # 6. predecessors (pinned-commit receipt CONTENT) + 19. no R1B success already recorded + 20. attempt marker absent
  r1b_receipt_gate "$REPO" "$RELEASE_ID" "$EXPECTED_MAIN" || gate "predecessor receipt gate failed (see reason above)"
  r1b_r1a_preserved_gate || gate "immutable R1A marker/window are not preserved"
  r1b_attempt_unconsumed "$AUTH_DIR" || gate "R1B is ONE attempt TOTAL and one is already consumed (canonical stage-global or authorization marker), or the canonical marker directory is invalid"
  # 7-8. disk/headroom, operator identity (already enforced), preserved services
  l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
  l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
  l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent L6b broker gate failed (see reason above)"
  l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
  # 9-14. the live authority (immutable verifier, interpreter, R1I exact shape, Core/detector healthy, detector source/unit/recovery digests, current release): the SAME function is re-run before the marker and before FINAL
  authority_gates || gate "the live authority is not intact (see reason above)"
  # 18. trusted journal access
  r1b_journal_access_gate || gate "the journal is not readable (see reason above)"
  [ "$GATE_FAILED" = 0 ]
}
# 15-17 (no pre-existing open incident, baseline audit state, baseline runtime state) are enforced by the read-only r1_acceptance BASELINE capture, which refuses PREEXISTING_OPEN_INCIDENT.

ATTEMPT_STARTED=0
capture() { control_gate || return 1; sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$CTRL/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE — NO allowed drift for R1B: every captured generic key must be identical.
  local rc=0
  control_gate || return 1
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$CTRL/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 FINDINGS_APPROVED_CHANGE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }

clock_gate() {
  local label=${1:-CLOCK} out
  control_gate || return 1
  out=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C PYTHONDONTWRITEBYTECODE=1 "$PY" -B -s "$CTRL/p4-l5-clock.py" probe 2>&1) || {
    printf 'R1B_CLOCK_GATE=%s FAIL %s\n' "$label" "$out" >&2; return 1; }
  printf '%s\n' "$out" | grep -q 'state=SYNCED reason=OK' || {
    printf 'R1B_CLOCK_GATE=%s FAIL %s\n' "$label" "$out" >&2; return 1; }
  printf 'R1B_CLOCK_GATE=%s PASS\n' "$label"
}
capture_clock_gate() {
  local dir=${1:-}
  [ -f "$dir/time.tsv" ] && grep -qx # The handlers run as ROOT and are READ-ONLY observers. The live flag exists nowhere else, and only after every gate, the baseline and the consumed attempt.
handler() {
  control_gate || return 1   # root never executes a handler whose control snapshot drifted
  sudo env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_R1B_LIVE_AUTHORIZED=YES AEGIS_R1B_WORK_DIR="$WORK" AEGIS_R1B_STEP="$1" AEGIS_R1B_APP_DIR="$VERIFIER_SNAPSHOT_DIR" AEGIS_R1B_VERIFIER_MANIFEST_SHA256="$VERIFIER_MANIFEST_SHA256" AEGIS_R1B_AUDIT_DB="$AUDIT_DB" \
    AEGIS_R1B_EXPECTED_SOURCE_IP="$EXPECTED_SOURCE_IP" AEGIS_R1B_WINDOW_START="${R1B_WINDOW_START:-}" AEGIS_R1B_WINDOW_END="${R1B_WINDOW_END:-}" \
    AEGIS_R1B_RELEASE_ID="$RELEASE_ID" AEGIS_R1B_DETECTOR_SHA256="$PRODUCTION_DETECTOR_SHA256" AEGIS_R1B_DETECTOR_UID="$DETECTOR_UID" AEGIS_PYTHON_BIN="$PY" PYTHONDONTWRITEBYTECODE=1 \
    bash "$STG/${2:-apply.sh}"
}
runtime_unchanged() { [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ] && [ "$(snap $DETECTOR_UNIT)" = "$DETECTOR_PRE" ]; }

# ---- hooks for the attempt state machine (r1b_run_attempt owns the ordering and the marker) -------------------------------------------------------------
r1b_hook_pregates() { echo "== R1B pre-gates (read-only; nothing consumed)"; pregates; }
r1b_hook_baseline() {
  CORE_PRE=$(snap $CORE_UNIT); DETECTOR_PRE=$(snap $DETECTOR_UNIT)
  mkdir -m 700 "$EVID" && exec > >(tee -a "$EVID/owner-run.log") 2>&1
  JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
  cp "$AUTH_DIR/authorization-R1B.txt" "$AUTH_DIR/k3-R1B.txt" "$EVID/"
  { echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE_ID=$RELEASE_ID"; echo "VERIFIER_MANIFEST_SHA256=$VERIFIER_MANIFEST_SHA256"; echo "RUNNER_SHA256=$RUNNER_SHA256"; echo "CORE_PRE=$CORE_PRE"; echo "DETECTOR_PRE=$DETECTOR_PRE"; echo "EXPECTED_SOURCE_IP=$EXPECTED_SOURCE_IP"; echo "OBSERVE_SECONDS=$OBSERVE_SECONDS"; } > "$EVID/frozen-inputs.txt"
  sudo install -d -m 700 -o root -g root "$WORK" || return 1
  echo "== PRE capture and immutable R1 baseline (read-only)"
  clock_gate BASELINE_BEFORE_CAPTURE || return 1
  capture PRE "$PRE" || return 1
  sudo chown -R "$(id -u):$(id -g)" "$PRE" 2>/dev/null || true
  capture_clock_gate "$PRE" || return 1
  handler BASELINE || return 1
}
r1b_hook_preconsume() {
  echo "== R1B pre-consume stability / comparability gate (read-only; nothing consumed)"
  sleep "$PRECONSUME_STABILITY_SECONDS"
  clock_gate PRECONSUME_BEFORE_CAPTURE || return 1
  capture PRECONSUME "$PRECHECK" || return 1
  sudo chown -R "$(id -u):$(id -g)" "$PRECHECK" 2>/dev/null || true
  capture_clock_gate "$PRECHECK" || return 1
  compare "$PRE" "$PRECHECK" "$EVID/compare-pre-preconsume.txt" || return 1
  handler PRECONSUME || return 1
  runtime_unchanged || { echo "R1B_PRECONSUME_SERVICE_LIFECYCLE_DRIFT=YES"; return 1; }
  r1b_r1a_preserved_gate || return 1
  clock_gate PRECONSUME_FINAL || return 1
}
r1b_hook_regate() {
  # re-prove the whole live authority just before the one-shot boundary, and that no marker (global or local) appeared meanwhile
  authority_gates && r1b_r1a_preserved_gate && clock_gate REGATE && r1b_attempt_unconsumed "$AUTH_DIR"
}
r1b_hook_observe() {
  # OBSERVE ONLY: a bounded wait. The genuine external event is produced by the owner, outside this runner. No loop retries anything.
  local seconds=$1
  sleep "$seconds"
}
r1b_hook_final() {
  # Immediately before ANY root execution of the verifier: re-prove the complete authority (immutable verifier manifest, deployed detector/unit/recovery digests, current release, R1I, Core/detector identity).
  authority_gates || { echo "R1B_AUTHORITY_DRIFT_BEFORE_FINAL=YES"; return 1; }
  r1b_r1a_preserved_gate || return 1
  clock_gate FINAL_BEFORE_CAPTURE || return 1
  # ONE final capture + the ONE verifier run (r1_acceptance final). The generic POST capture and compare must show no unrelated drift.
  capture POST "$POST" || return 1
  sudo chown -R "$(id -u):$(id -g)" "$POST" 2>/dev/null || true
  capture_clock_gate "$POST" || return 1
  handler FINAL || return 1
  compare "$PRE" "$POST" "$EVID/compare-pre-post.txt" || return 1
  runtime_unchanged || { echo "R1B_SERVICE_LIFECYCLE_DRIFT=YES"; return 1; }
  r1b_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || return 1
}
r1b_hook_verify() {
  local out
  out=$(handler FINAL verify.sh 2>&1) || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"; grep -qx 'R1B_VERIFY=PASS' <<< "$out"
}
r1b_hook_preserve_evidence() {
  # EVIDENCE-PRESERVING: the rollback handler performs no action. Nothing real is deleted, closed, edited or restored.
  handler FINAL rollback.sh 2>/dev/null || true
  echo "R1B_EVIDENCE_ROOT=$EVID (retained; the R1B attempt marker is retained and never removed)"
  echo "R1A_RESULT=FAIL_IMMUTABLE R1A_EVIDENCE_PRESERVED=YES"
}

if r1b_run_attempt "$AUTH_DIR" "$OBSERVE_SECONDS"; then
  echo "R1B_LIVE_EXECUTED=YES R1B_VERIFIER_RESULT=PASS R1_EVIDENCE_VERIFIED=YES REAL_DETECTOR_CHAIN_VERIFIED=YES (automatic result only)"
  echo "R1A_RESULT=FAIL_IMMUTABLE R1B_IS_R1A_RETRY=NO"
  echo "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R1_R8_PROVEN=NO"
  echo "R1B_CLAIM_BOUNDARY: this is an automatic verifier result. F1_REAL_DETECTOR_ACCEPTANCE / R1_VERIFIED are promoted ONLY by a separately reviewed LIVE closeout after independent inspection of the evidence."
  exit 0
fi
exit 1
time.trustedclock.state\tSYNCED' "$dir/time.tsv" || {
    echo "R1B_CAPTURE_TRUSTEDCLOCK_NOT_SYNCED:$dir" >&2; return 1; }
}
# The handlers run as ROOT and are READ-ONLY observers. The live flag exists nowhere else, and only after every gate, the baseline and the consumed attempt.
handler() {
  control_gate || return 1   # root never executes a handler whose control snapshot drifted
  sudo env -u AEGIS_P4_FS_ROOT -u P4_FS_ROOT AEGIS_R1B_LIVE_AUTHORIZED=YES AEGIS_R1B_WORK_DIR="$WORK" AEGIS_R1B_STEP="$1" AEGIS_R1B_APP_DIR="$VERIFIER_SNAPSHOT_DIR" AEGIS_R1B_VERIFIER_MANIFEST_SHA256="$VERIFIER_MANIFEST_SHA256" AEGIS_R1B_AUDIT_DB="$AUDIT_DB" \
    AEGIS_R1B_EXPECTED_SOURCE_IP="$EXPECTED_SOURCE_IP" AEGIS_R1B_WINDOW_START="${R1B_WINDOW_START:-}" AEGIS_R1B_WINDOW_END="${R1B_WINDOW_END:-}" \
    AEGIS_R1B_RELEASE_ID="$RELEASE_ID" AEGIS_R1B_DETECTOR_SHA256="$PRODUCTION_DETECTOR_SHA256" AEGIS_R1B_DETECTOR_UID="$DETECTOR_UID" AEGIS_PYTHON_BIN="$PY" PYTHONDONTWRITEBYTECODE=1 \
    bash "$STG/${2:-apply.sh}"
}
runtime_unchanged() { [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ] && [ "$(snap $DETECTOR_UNIT)" = "$DETECTOR_PRE" ]; }

# ---- hooks for the attempt state machine (r1b_run_attempt owns the ordering and the marker) -------------------------------------------------------------
r1b_hook_pregates() { echo "== R1B pre-gates (read-only; nothing consumed)"; pregates; }
r1b_hook_baseline() {
  CORE_PRE=$(snap $CORE_UNIT); DETECTOR_PRE=$(snap $DETECTOR_UNIT)
  mkdir -m 700 "$EVID" && exec > >(tee -a "$EVID/owner-run.log") 2>&1
  JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
  cp "$AUTH_DIR/authorization-R1B.txt" "$AUTH_DIR/k3-R1B.txt" "$EVID/"
  { echo "MAIN=$EXPECTED_MAIN"; echo "RELEASE_ID=$RELEASE_ID"; echo "VERIFIER_MANIFEST_SHA256=$VERIFIER_MANIFEST_SHA256"; echo "RUNNER_SHA256=$RUNNER_SHA256"; echo "CORE_PRE=$CORE_PRE"; echo "DETECTOR_PRE=$DETECTOR_PRE"; echo "EXPECTED_SOURCE_IP=$EXPECTED_SOURCE_IP"; echo "OBSERVE_SECONDS=$OBSERVE_SECONDS"; } > "$EVID/frozen-inputs.txt"
  sudo install -d -m 700 -o root -g root "$WORK" || return 1
  echo "== PRE capture and immutable R1 baseline (read-only)"
  capture PRE "$PRE" || return 1
  sudo chown -R "$(id -u):$(id -g)" "$PRE" 2>/dev/null || true
  handler BASELINE || return 1
}
r1b_hook_regate() {
  # re-prove the whole live authority just before the one-shot boundary, and that no marker (global or local) appeared meanwhile
  authority_gates && r1b_attempt_unconsumed "$AUTH_DIR"
}
r1b_hook_observe() {
  # OBSERVE ONLY: a bounded wait. The genuine external event is produced by the owner, outside this runner. No loop retries anything.
  local seconds=$1
  sleep "$seconds"
}
r1b_hook_final() {
  # Immediately before ANY root execution of the verifier: re-prove the complete authority (immutable verifier manifest, deployed detector/unit/recovery digests, current release, R1I, Core/detector identity).
  authority_gates || { echo "R1B_AUTHORITY_DRIFT_BEFORE_FINAL=YES"; return 1; }
  # ONE final capture + the ONE verifier run (r1_acceptance final). The generic POST capture and compare must show no unrelated drift.
  capture POST "$POST" || return 1
  sudo chown -R "$(id -u):$(id -g)" "$POST" 2>/dev/null || true
  handler FINAL || return 1
  compare "$PRE" "$POST" "$EVID/compare-pre-post.txt" || return 1
  runtime_unchanged || { echo "R1B_SERVICE_LIFECYCLE_DRIFT=YES"; return 1; }
  r1b_r1i_present_gate "$CTRL/r1i-input-instrumentation/r1i_input_instrumentation.py" || return 1
}
r1b_hook_verify() {
  local out
  out=$(handler FINAL verify.sh 2>&1) || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"; grep -qx 'R1B_VERIFY=PASS' <<< "$out"
}
r1b_hook_preserve_evidence() {
  # EVIDENCE-PRESERVING: the rollback handler performs no action. Nothing real is deleted, closed, edited or restored.
  handler FINAL rollback.sh 2>/dev/null || true
  echo "R1B_EVIDENCE_ROOT=$EVID (retained; the R1B attempt marker is retained and never removed)"
}

if r1b_run_attempt "$AUTH_DIR" "$OBSERVE_SECONDS"; then
  echo "R1B_LIVE_EXECUTED=YES R1B_VERIFIER_RESULT=PASS R1_EVIDENCE_VERIFIED=YES REAL_DETECTOR_CHAIN_VERIFIED=YES (automatic result only)"
  echo "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R1_R8_PROVEN=NO"
  echo "R1B_CLAIM_BOUNDARY: this is an automatic verifier result. F1_REAL_DETECTOR_ACCEPTANCE / R1_VERIFIED are promoted ONLY by a separately reviewed LIVE closeout after independent inspection of the evidence."
  exit 0
fi
exit 1
