#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1 (governed F1 production detector unit install + ONE start) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces the PIN_ values (the merged main SHA, the operator identity, the frozen alert source uid and the reviewed unit SHA-256), records
# the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository executes it.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-f1-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-F1.txt and k3-F1.txt (same-day, stage=F1)
# Stage order: L7 -> L7u -> L8p -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9. F1 requires the L8p closeout result (L8P_LIVE_EXECUTED=YES + L8P_PROVISIONING=PASS in the
# canonical closeout receipt of the pinned commit), consumes ONE attempt (F1-ATTEMPT-CONSUMED) and has NO automatic second attempt.
# F1 installs the exact pinned detector unit (root:root 0644, atomic, never overwriting), daemon-reloads, starts the detector EXACTLY once through the reviewed
# p4-f1-alert-source.py ordered gate, verifies the detector runtime, and on failure rolls back ONLY what this attempt journalled. It NEVER restarts the Core,
# edits core.env, users or groups, enables the unit, injects an alert, fabricates R1, runs Recovery, sends CUT/RESTORE, or touches the ESP32 or a serial port.
# A successful run may claim only F1_PRODUCTION_DEPLOYED=YES and F1_DETECTOR_STARTED=YES. It never claims F1_REAL_DETECTOR_ACCEPTANCE, Recovery R1-R8 or R1_VERIFIED, and it never claims that no real alert occurred (the detector follows NEW journal lines once started):
# those need a later, separately governed REAL validated detector alert reaching the Core.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
ALERT_SOURCE_UID=PIN_ALERT_SOURCE_UID
UNIT_SHA256=PIN_UNIT_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID ALERT_SOURCE_UID UNIT_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier."; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid."; exit 2; }
[[ "$ALERT_SOURCE_UID" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "STOP: ALERT_SOURCE_UID is not a valid non-root uid."; exit 2; }
[[ "$UNIT_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: UNIT_SHA256 is not a 64-hex SHA-256."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-F1.txt and k3-F1.txt>"; exit 2; }

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-F1LIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/F1
LIB=$P4/p4-f1-run-lib.sh
F1_TOOL=$P4/p4-f1-alert-source.py
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-f1-$STAMP
WORK=$EVID/f1-work
PRE=$EVID/pre-root
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
CORE_UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

# The runner is invoked by exactly the frozen operator identity (the reused L7u identity gate). It runs BEFORE sudo, the evidence directory, the PRE capture,
# the attempt marker and any handler.
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen F1 operator (see reason above); nothing was created or touched"

echo "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN"
echo "RECOVERY_R1_R8_PROVEN=NO"
echo "== F1 owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. same-day stage=F1 records, one-attempt marker, pinned main + clean worktree, handlers, stage gate (live mode)
for f in authorization-F1.txt k3-F1.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=F1" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=F1"
done
f1_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$P4/p4-f1-deploy.py" ] && [ -f "$F1_TOOL" ] || gate "p4-f1-deploy.py or p4-f1-alert-source.py missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage F1 --mode live --authorization "$AUTH_DIR/authorization-F1.txt" --k3 "$AUTH_DIR/k3-F1.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor: the L8p closeout result from the pinned commit; F1 itself must not already be recorded
f1_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. CURRENT runtime (read-only, never repaired): Core running, preserved services, IDEA2 §10, headroom
l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not in the running baseline (see reason above)"
l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"

# 4. F1 specifics: exact account/uid, core.env uid, the RUNNING Core's uid, alert surface, probe config, pinned unit, detector absent
l7u_alert_identity_gate aegis-idea3-detector "$ALERT_SOURCE_UID" aegis-idea3 "$OPERATOR_UID" || gate "detector account / uid contract failed (see reason above)"
f1_core_env_gate "$ALERT_SOURCE_UID" "$PY" "$F1_TOOL" aegis-idea3 || gate "core.env alert uid contract failed (see reason above)"
f1_core_running_alert_uid_gate "$CORE_UNIT" "$ALERT_SOURCE_UID" || gate "the running Core does not carry the alert uid (see reason above)"
f1_alert_surface_gate aegis-idea3 || gate "alert directory/socket contract failed (see reason above)"
f1_probe_config_gate || gate "R2/R6/R7 probe configuration missing (see reason above)"
f1_unit_pin_gate "$PY" "$F1_TOOL" "$UNIT_SHA256" || gate "the reviewed unit does not match its frozen digest (see reason above)"
f1_detector_absent_gate || gate "the detector unit/process is not absent (see reason above)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host"

# ---- evidence directory and PRE capture (read-only host effect), then the ONE attempt is consumed ----------------------------------------------------
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
CORE_PRE=$(snap $CORE_UNIT)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-F1.txt" "$AUTH_DIR/k3-F1.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "UNIT_SHA256=$UNIT_SHA256"; echo "ALERT_SOURCE_UID=$ALERT_SOURCE_UID"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN"

ATTEMPTED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE: the F1 allow files are EMPTY, so any captured Core-host drift fails. p4-compare.sh takes EXACTLY two positional arguments.
  local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
# The canonical handlers run as ROOT (install into /etc/systemd/system, systemctl). AEGIS_F1_LIVE_AUTHORIZED=YES exists nowhere else, and only after every gate
# above, the PRE capture and the consumed attempt.
handler() {
  sudo env AEGIS_F1_LIVE_AUTHORIZED=YES AEGIS_F1_WORK_DIR="$WORK" AEGIS_F1_ALERT_SOURCE_UID="$ALERT_SOURCE_UID" AEGIS_F1_UNIT_SHA256="$UNIT_SHA256" \
    AEGIS_PYTHON_BIN="$PY" PYTHONDONTWRITEBYTECODE=1 bash "$STG/$1"
}
own_pre() { sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] && [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ]; }
# Failure/abort path ONLY. One rollback of what this attempt journalled; never a retry, never a Core restart, never an enable.
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== F1 ROLLBACK (reason: $1) — failure/abort path only"
  local out
  out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; echo "F1_ROLLBACK=FAIL (owner decision) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  printf '%s\n' "$out"
  f1_rollback_output_gate "$out" || { echo "F1_ROLLBACK_SEMANTICS=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  f1_unit_state_gate absent || { echo "F1_ROLLBACK_STATE=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  own_pre "$EVID/rb-root"
  compare "$PRE" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS. F1_PRODUCTION_DEPLOYED=NO F1_DETECTOR_STARTED=NO(rolled back). NOT retrying. Authorization is consumed."; exit 1; }
fail_after_attempt() { [ "$ATTEMPTED" = 1 ] && rollback_flow "$1" || { echo "STOP before the attempt was consumed: $1"; exit 1; }; }
trap 'fail_after_attempt "unexpected error at line $LINENO"' ERR
trap 'fail_after_attempt "interrupted"' INT TERM

echo "== PRE capture (read-only; BEFORE the attempt is consumed and before any mutation)"
capture PRE "$PRE" || die "PRE capture failed; nothing changed and nothing consumed"
own_pre "$PRE"
( cd "$PRE" && sha256sum -c --quiet --strict SHA256SUMS ) || die "PRE checksum verification failed; nothing changed and nothing consumed"
# The PRE capture ran just now: re-prove the detector is still absent BEFORE the one attempt is consumed.
f1_detector_absent_gate || die "the detector unit/process is not absent after the PRE capture (see reason above); the attempt was NOT consumed"

sudo install -d -m 700 -o root -g root "$WORK" || die "could not create the private root work directory"
# one attempt: from this point a second invocation for this AUTH_DIR is refused, even after a failure
f1_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"
ATTEMPTED=1

echo "== F1 APPLY (once; install the pinned unit, daemon-reload, ONE start through the reviewed ordered gate, settle, verify)"
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'F1_APPLY=COMPLETE'; } || rollback_flow "F1_APPLY failed (rc=$apply_rc)"
echo "== F1 VERIFY (read-only evidence check)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'F1_VERIFY=PASS'; } || rollback_flow "F1_VERIFY failed"
f1_unit_state_gate running || rollback_flow "independent unit state check failed"
sudo cat "$WORK/f1-journal.json" > "$EVID/f1-journal.json" 2>/dev/null || true   # non-secret: digests, inode, PIDs
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
own_pre "$EVID/post-root"
echo "== PRE -> POST compare (captured Core host zero drift: the F1 allow files are empty)"; compare "$PRE" "$EVID/post-root" "$EVID/compare-pre-post.txt" || rollback_flow "PRE->POST compare failed"
l7u_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker/Core preservation failed (the Core PID/restart count must be unchanged)"
trap - ERR INT TERM
echo "F1_LIVE_EXECUTED=YES F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES F1_APPLY=PASS F1_VERIFY=PASS F1_POST_CAPTURE=COMPLETE F1_PRE_POST_COMPARE=PASS"
echo "F1_START_COUNT=ONE F1_UNIT_ENABLED=NO CORE_RESTARTED=NO F1_STAGE_ALERT_INJECTED=NO"
echo "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN RECOVERY_R1_R8_PROVEN=NO R1_VERIFIED=NOT_CLAIMED"
echo "F1_CLAIM_BOUNDARY: the detector follows NEW journal lines once started, so a naturally occurring REAL validated alert during the window is an external production event. F1 neither injects, fabricates, accepts nor rolls back such an alert or incident; it is NOT accepted or proven by this stage merely because the detector was running (a separate governed step does that)."
echo "Evidence: $EVID"
