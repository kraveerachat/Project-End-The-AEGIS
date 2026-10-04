#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1r (governed current-release activation, NO Core restart) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces the PIN_ values (the merged main SHA, the operator identity, the exact OLD and NEW release ids, the NEW release source SHA and the
# NEW production_detector.py digest), records the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository executes it.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-f1r-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-F1r.txt and k3-F1r.txt (same-day, stage=F1r)
# Stage order: L7 -> L7u -> L8p -> L6c (fresh install-only run for the repaired release) -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9. The L6c step is a NEW
# install-only maintenance run of the already-reviewed L6c mechanism (new release id, new same-day authorization), never a replay of a consumed authorization.
# F1r requires the L8p closeout result (canonical receipt of the pinned commit), consumes ONE attempt (F1R-ATTEMPT-CONSUMED) and has NO automatic second attempt.
# F1r owns ONLY the atomic switch of /opt/aegis-idea3/current from the exact OLD release to the exact, ALREADY-INSTALLED NEW release. It installs no release, and
# it NEVER restarts, starts, stops or reloads the Core or any service: the running Core keeps its MainPID and NRestarts (both must be unchanged), and changing
# `current` does NOT move the running Core to the new release. It never starts or installs the detector, edits core.env, injects an alert, runs Recovery,
# or touches IDEA1/IDEA2 or any device.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
OLD_RELEASE_ID=PIN_OLD_RELEASE_ID
NEW_RELEASE_ID=PIN_NEW_RELEASE_ID
NEW_RELEASE_SOURCE_SHA=PIN_NEW_RELEASE_SOURCE_SHA
NEW_PRODUCTION_DETECTOR_SHA256=PIN_NEW_DETECTOR_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID OLD_RELEASE_ID NEW_RELEASE_ID NEW_RELEASE_SOURCE_SHA NEW_PRODUCTION_DETECTOR_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier."; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid."; exit 2; }
for pin in OLD_RELEASE_ID NEW_RELEASE_ID; do
  [[ "${!pin}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "${!pin}" != *..* ]] || { echo "STOP: $pin is not a valid release id."; exit 2; }
done
[ "$OLD_RELEASE_ID" != "$NEW_RELEASE_ID" ] || { echo "STOP: OLD_RELEASE_ID and NEW_RELEASE_ID must differ."; exit 2; }
[[ "$NEW_RELEASE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: NEW_RELEASE_SOURCE_SHA is not a 40-hex SHA."; exit 2; }
[[ "$NEW_PRODUCTION_DETECTOR_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: NEW_PRODUCTION_DETECTOR_SHA256 is not a 64-hex SHA-256."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-F1r.txt and k3-F1r.txt>"; exit 2; }

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-F1RLIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/F1r
LIB=$P4/p4-f1r-run-lib.sh
F1R_TOOL=$P4/p4-f1r-switch.py
OLD_RELEASE_PATH=/opt/aegis-idea3/releases/$OLD_RELEASE_ID
NEW_RELEASE_PATH=/opt/aegis-idea3/releases/$NEW_RELEASE_ID
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-f1r-$STAMP
WORK=$EVID/f1r-work
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
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen F1r operator (see reason above); nothing was created or touched"

echo "F1_ATTEMPT_2_PERFORMED=NO"
echo "F1_DETECTOR_STARTED=NO"
echo "== F1r owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. same-day stage=F1r records, one-attempt marker, pinned main + clean worktree, handlers, stage gate (live mode)
for f in authorization-F1r.txt k3-F1r.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=F1r" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=F1r"
done
f1r_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$F1R_TOOL" ] || gate "p4-f1r-switch.py missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage F1r --mode live --authorization "$AUTH_DIR/authorization-F1r.txt" --k3 "$AUTH_DIR/k3-F1r.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor: the L8p closeout result from the pinned commit; F1r itself must not already be recorded
f1r_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"
# the frozen detector digest must be exactly the REVIEWED, merged source bytes (not merely a text that looks repaired)
f1r_detector_source_gate "$REPO" "$NEW_PRODUCTION_DETECTOR_SHA256" || gate "the frozen detector digest is not the reviewed source at the pinned main (see reason above)"

# 3. CURRENT runtime (read-only, never repaired): Core running, preserved services, IDEA2 §10, headroom
l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not in the running baseline (see reason above)"
l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"

# 4. F1r specifics (the reviewed tool's read-only check): `current` is exactly the OLD target; OLD and NEW pass the release guard at --expect-owner root;
# the NEW release id, source SHA, clean tree and detector digest are exact; the detector unit/process is absent; the Core is running.
f1r_preflight_gate "$PY" "$F1R_TOOL" "$OLD_RELEASE_ID" "$NEW_RELEASE_ID" "$NEW_RELEASE_SOURCE_SHA" "$NEW_PRODUCTION_DETECTOR_SHA256" \
  || gate "F1r preflight failed (see reason above)"
f1_detector_absent_gate || gate "the detector unit/process is not absent (see reason above)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host"

# ---- evidence directory and PRE capture (read-only host effect), then the ONE attempt is consumed ----------------------------------------------------
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
CORE_PRE=$(snap $CORE_UNIT)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
: > "$EVID/empty-allow.txt"   # zero allowances: the PRE->RB comparison must show NO drift at all
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-F1r.txt" "$AUTH_DIR/k3-F1r.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "OLD_RELEASE_ID=$OLD_RELEASE_ID"; echo "NEW_RELEASE_ID=$NEW_RELEASE_ID"; echo "NEW_RELEASE_SOURCE_SHA=$NEW_RELEASE_SOURCE_SHA"
  echo "NEW_PRODUCTION_DETECTOR_SHA256=$NEW_PRODUCTION_DETECTOR_SHA256"; echo "CORE_PRE=$CORE_PRE"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN OLD=$OLD_RELEASE_ID NEW=$NEW_RELEASE_ID"

ATTEMPTED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE ALLOW_KEYS: p4-compare.sh takes EXACTLY two positional arguments; the allow files are passed through the environment.
  local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$4" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
# The canonical handlers run as ROOT (they replace a symlink under /opt/aegis-idea3). The live flag exists nowhere else, and only after every gate above, the PRE
# capture and the consumed attempt.
handler() {
  sudo env AEGIS_F1R_LIVE_AUTHORIZED=YES AEGIS_F1R_WORK_DIR="$WORK" AEGIS_F1R_OLD_RELEASE_ID="$OLD_RELEASE_ID" AEGIS_F1R_NEW_RELEASE_ID="$NEW_RELEASE_ID" \
    AEGIS_F1R_NEW_SOURCE_SHA="$NEW_RELEASE_SOURCE_SHA" AEGIS_F1R_NEW_DETECTOR_SHA256="$NEW_PRODUCTION_DETECTOR_SHA256" AEGIS_PYTHON_BIN="$PY" \
    PYTHONDONTWRITEBYTECODE=1 bash "$STG/$1"
}
own_pre() { sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] && [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ]; }
# Failure/abort path ONLY. One rollback of what this attempt journalled; never a retry, never a Core restart, never a service action of any kind.
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== F1r ROLLBACK (reason: $1) — failure/abort path only"
  local out
  out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; echo "F1R_ROLLBACK=FAIL (owner decision) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  printf '%s\n' "$out"
  f1r_rollback_output_gate "$out" || { echo "F1R_ROLLBACK_SEMANTICS=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  [ "$(sudo readlink /opt/aegis-idea3/current)" = "$OLD_RELEASE_PATH" ] || { echo "F1R_ROLLBACK_STATE=FAIL (current is not the OLD target) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  f1r_core_snapshot_gate "$CORE_PRE" || { echo "F1R_ROLLBACK_CORE=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  own_pre "$EVID/rb-root"
  compare "$PRE" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" "$EVID/empty-allow.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS (zero drift). F1R_CURRENT_SWITCHED=NO (restored to the OLD target). NOT retrying. Authorization is consumed."; exit 1; }
fail_after_attempt() { [ "$ATTEMPTED" = 1 ] && rollback_flow "$1" || { echo "STOP before the attempt was consumed: $1"; exit 1; }; }
trap 'fail_after_attempt "unexpected error at line $LINENO"' ERR
trap 'fail_after_attempt "interrupted"' INT TERM

echo "== PRE capture (read-only; BEFORE the attempt is consumed and before any mutation)"
capture PRE "$PRE" || die "PRE capture failed; nothing changed and nothing consumed"
own_pre "$PRE"
( cd "$PRE" && sha256sum -c --quiet --strict SHA256SUMS ) || die "PRE checksum verification failed; nothing changed and nothing consumed"
# The PRE capture ran just now: re-prove the exact OLD target, the releases, COMPLETE detector absence (the tool covers the unit surface AND any standalone
# aegis_soc.production_detector process; the shell gate re-checks independently) and the Core snapshot BEFORE the one-shot boundary.
f1r_preflight_gate "$PY" "$F1R_TOOL" "$OLD_RELEASE_ID" "$NEW_RELEASE_ID" "$NEW_RELEASE_SOURCE_SHA" "$NEW_PRODUCTION_DETECTOR_SHA256" \
  || die "F1r preflight no longer holds after the PRE capture (see reason above); the attempt was NOT consumed"
f1_detector_absent_gate || die "the detector unit/process is not absent after the PRE capture (see reason above); the attempt was NOT consumed"
f1r_core_snapshot_gate "$CORE_PRE" || die "the Core drifted during the PRE capture (see reason above); the attempt was NOT consumed"

sudo install -d -m 700 -o root -g root "$WORK" || die "could not create the private root work directory"
# one attempt: from this point a second invocation for this AUTH_DIR is refused, even after a failure
f1r_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"
ATTEMPTED=1

echo "== F1r APPLY (once; journal OLD, re-read current, temp symlink + atomic rename, exact post-switch check)"
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'F1R_APPLY=COMPLETE'; } || rollback_flow "F1R_APPLY failed (rc=$apply_rc)"
echo "== F1r VERIFY (read-only evidence check)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'F1R_VERIFY=PASS'; } || rollback_flow "F1R_VERIFY failed"
[ "$(sudo readlink /opt/aegis-idea3/current)" = "$NEW_RELEASE_PATH" ] || rollback_flow "independent current-target check failed"
f1r_core_snapshot_gate "$CORE_PRE" || rollback_flow "the Core is not the same running process (PID/NRestarts drift)"
sudo cat "$WORK/f1r-journal.json" > "$EVID/f1r-journal.json" 2>/dev/null || true   # non-secret: release ids, targets, PIDs, restart counts
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
own_pre "$EVID/post-root"
f1r_current_transition_gate "$PRE" "$EVID/post-root" "$OLD_RELEASE_PATH" "$NEW_RELEASE_PATH" || rollback_flow "the captured current-target transition is not exactly OLD -> NEW"
echo "== PRE -> POST compare (the ONLY approved drift is the exact current-target key; every other captured record must be unchanged)"
compare "$PRE" "$EVID/post-root" "$EVID/compare-pre-post.txt" "$STG/allow-keys.txt" || rollback_flow "PRE->POST compare failed"
l7u_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker/Core preservation failed (the Core PID/restart count must be unchanged)"
trap - ERR INT TERM
echo "F1R_LIVE_EXECUTED=YES F1R_CURRENT_SWITCHED=YES F1R_APPLY=PASS F1R_VERIFY=PASS F1R_POST_CAPTURE=COMPLETE F1R_PRE_POST_COMPARE=PASS"
echo "CORE_RESTARTED=NO CORE_MOVED_TO_NEW_RELEASE=NO F1_DETECTOR_STARTED=NO F1_ATTEMPT_2_PERFORMED=NO"
echo "F1R_CLAIM_BOUNDARY: only the 'current' pointer changed; the running Core is the pre-existing process and still runs from its old working directory until a separately authorized restart. F1r installed no release and started nothing."
echo "Evidence: $EVID"
