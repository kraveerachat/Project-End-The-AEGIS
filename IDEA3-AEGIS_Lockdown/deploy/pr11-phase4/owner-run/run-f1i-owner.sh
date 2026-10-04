#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — F1i (governed POST-L7 install of ONE repaired immutable release) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the repository, replaces the PIN_
# values (the merged main SHA, the operator identity, the exact EXPECTED CURRENT release id, the exact release id to install, its source SHA and its production_detector.py digest),
# records the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository executes it.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-f1i-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-F1i.txt and k3-F1i.txt (same-day, stage=F1i)
# Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9. F1i exists because the historical L6c verifier is intentionally PRE-L7 (it requires the L7
# credentials/core.env absent and the Core unit not-found): a maintenance reuse of L6c failed closed exactly there and its authorization is consumed forever. L6c is NOT changed.
# F1i requires the L8p closeout result (canonical receipt of the pinned commit), consumes ONE attempt (F1I-ATTEMPT-CONSUMED) and has NO automatic second attempt.
# F1i owns ONLY the creation of /opt/aegis-idea3/releases/<RELEASE_ID> through the reviewed installer. It treats the post-L7 material (credentials, core.env), the Core unit and
# every other Production surface as PRESERVED state. It NEVER creates /opt/aegis-idea3 or its releases directory, switches `current`, restarts/starts/stops/reloads anything,
# installs or starts the detector, edits core.env, runs Recovery, or touches IDEA1/IDEA2 or a device. A successful run proves only the install; F1r (the switch) and F1 are separate.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
EXPECTED_CURRENT_RELEASE_ID=PIN_CURRENT_RELEASE_ID
RELEASE_ID=PIN_RELEASE_ID
EXPECTED_SOURCE_SHA=PIN_SOURCE_SHA
EXPECTED_PRODUCTION_DETECTOR_SHA256=PIN_PRODUCTION_DETECTOR_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID EXPECTED_CURRENT_RELEASE_ID RELEASE_ID EXPECTED_SOURCE_SHA EXPECTED_PRODUCTION_DETECTOR_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier."; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid."; exit 2; }
for pin in EXPECTED_CURRENT_RELEASE_ID RELEASE_ID; do
  [[ "${!pin}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "${!pin}" != *..* ]] || { echo "STOP: $pin is not a valid release id."; exit 2; }
done
[ "$EXPECTED_CURRENT_RELEASE_ID" != "$RELEASE_ID" ] || { echo "STOP: EXPECTED_CURRENT_RELEASE_ID and RELEASE_ID must differ."; exit 2; }
[[ "$EXPECTED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_SOURCE_SHA is not a 40-hex SHA."; exit 2; }
[[ "$EXPECTED_PRODUCTION_DETECTOR_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: EXPECTED_PRODUCTION_DETECTOR_SHA256 is not a 64-hex SHA-256."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-F1i.txt and k3-F1i.txt>"; exit 2; }

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-F1ILIVE   # clean pinned execution worktree at merged main
SOURCE_DIR=/home/kittipat/Workspace/idea3-p4-evidence/f1i-owner-source/$RELEASE_ID        # completed builder output (user-owned); built by the reviewed builder from the pinned main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/F1i
LIB=$P4/p4-f1i-run-lib.sh
F1I_TOOL=$P4/p4-f1i-install.py
CURRENT_RELEASE_PATH=/opt/aegis-idea3/releases/$EXPECTED_CURRENT_RELEASE_ID
TARGET_PATH=/opt/aegis-idea3/releases/$RELEASE_ID
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-f1i-$STAMP
WORK=$EVID/f1i-work
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

# The runner is invoked by exactly the frozen operator identity (the reused L7u identity gate). It runs BEFORE sudo, the evidence directory, the PRE capture, the attempt marker and any handler.
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen F1i operator (see reason above); nothing was created or touched"

echo "F1R_LIVE_EXECUTED=NO"
echo "F1_ATTEMPT_2_PERFORMED=NO"
echo "== F1i owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. same-day stage=F1i records, one-attempt marker, pinned main + clean worktree, handlers, stage gate (live mode)
for f in authorization-F1i.txt k3-F1i.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=F1i" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=F1i"
done
f1i_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$F1I_TOOL" ] || gate "p4-f1i-install.py missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage F1i --mode live --authorization "$AUTH_DIR/authorization-F1i.txt" --k3 "$AUTH_DIR/k3-F1i.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor: the L8p closeout result from the pinned commit; F1i itself must not already be recorded
f1i_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"
# the frozen detector digest must be exactly the REVIEWED, merged source bytes (not merely a text that looks repaired)
f1r_detector_source_gate "$REPO" "$EXPECTED_PRODUCTION_DETECTOR_SHA256" || gate "the frozen detector digest is not the reviewed source at the pinned main (see reason above)"

# 3. CURRENT runtime (read-only, never repaired): Core running, preserved services, broker, IDEA2 §10, headroom
l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not in the running baseline (see reason above)"
l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent L6b broker gate failed (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"

# 4. F1i specifics (the reviewed tool's read-only check, with root read authority): parents exist; `current` is exactly the expected release; the TARGET release is absent; the builder
# output passes the release guard with the exact id/source SHA/clean tree/detector digest; the detector is absent on both surfaces; the Core is running; the L7 material exists.
f1i_preflight_gate "$PY" "$F1I_TOOL" "$EXPECTED_CURRENT_RELEASE_ID" "$RELEASE_ID" "$SOURCE_DIR" "$EXPECTED_SOURCE_SHA" "$EXPECTED_PRODUCTION_DETECTOR_SHA256" \
  || gate "F1i preflight failed (see reason above)"
f1_detector_absent_gate || gate "the detector unit/process is not absent (see reason above)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host"

# ---- evidence directory and PRE capture (read-only host effect), then the ONE attempt is consumed ----------------------------------------------------
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
CORE_PRE=$(snap $CORE_UNIT)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
: > "$EVID/empty-allow.txt"   # zero allowances: the PRE->RB comparison must show NO drift at all
{ echo "stage F1i"; echo "release_id $RELEASE_ID"; } > "$EVID/allow-release.txt"   # the RELATIONAL one-release catalog allowance for the forward comparison only
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-F1i.txt" "$AUTH_DIR/k3-F1i.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "EXPECTED_CURRENT_RELEASE_ID=$EXPECTED_CURRENT_RELEASE_ID"; echo "RELEASE_ID=$RELEASE_ID"; echo "EXPECTED_SOURCE_SHA=$EXPECTED_SOURCE_SHA"
  echo "EXPECTED_PRODUCTION_DETECTOR_SHA256=$EXPECTED_PRODUCTION_DETECTOR_SHA256"; echo "CORE_PRE=$CORE_PRE"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN CURRENT=$EXPECTED_CURRENT_RELEASE_ID RELEASE=$RELEASE_ID"

ATTEMPTED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE ALLOW_KEYS [RELEASE_ALLOW_FILE]: p4-compare.sh takes EXACTLY two positional arguments; the allowances are passed through the environment.
  local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$4" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    ${5:+ALLOW_L6C_RELEASE_FILE="$5"} bash "$P4/p4-compare.sh" "$1" "$2" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
# The canonical handlers run as ROOT (they create one directory under /opt/aegis-idea3/releases through the reviewed installer). The live flag exists nowhere else, and only after every
# gate above, the PRE capture and the consumed attempt.
handler() {
  sudo env AEGIS_F1I_LIVE_AUTHORIZED=YES AEGIS_F1I_WORK_DIR="$WORK" AEGIS_F1I_CURRENT_RELEASE_ID="$EXPECTED_CURRENT_RELEASE_ID" AEGIS_F1I_RELEASE_ID="$RELEASE_ID" \
    AEGIS_F1I_SOURCE_DIR="$SOURCE_DIR" AEGIS_F1I_SOURCE_SHA="$EXPECTED_SOURCE_SHA" AEGIS_F1I_DETECTOR_SHA256="$EXPECTED_PRODUCTION_DETECTOR_SHA256" AEGIS_PYTHON_BIN="$PY" \
    PYTHONDONTWRITEBYTECODE=1 bash "$STG/$1"
}
own_pre() { sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] && [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ]; }
# Failure/abort path ONLY. One rollback of what this attempt created; never a retry, never a Core restart, never a service action of any kind.
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== F1i ROLLBACK (reason: $1) — failure/abort path only"
  local out
  out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; echo "F1I_ROLLBACK=FAIL (owner decision) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  printf '%s\n' "$out"
  f1i_rollback_output_gate "$out" || { echo "F1I_ROLLBACK_SEMANTICS=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  { ! sudo test -e "$TARGET_PATH" && [ "$(sudo readlink /opt/aegis-idea3/current)" = "$CURRENT_RELEASE_PATH" ]; } \
    || { echo "F1I_ROLLBACK_STATE=FAIL (target still present or current changed) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  f1r_core_snapshot_gate "$CORE_PRE" || { echo "F1I_ROLLBACK_CORE=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  own_pre "$EVID/rb-root"
  compare "$PRE" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" "$EVID/empty-allow.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS (zero drift). F1I_RELEASE_INSTALLED=NO (rolled back). NOT retrying. Authorization is consumed."; exit 1; }
fail_after_attempt() { [ "$ATTEMPTED" = 1 ] && rollback_flow "$1" || { echo "STOP before the attempt was consumed: $1"; exit 1; }; }
trap 'fail_after_attempt "unexpected error at line $LINENO"' ERR
trap 'fail_after_attempt "interrupted"' INT TERM

echo "== PRE capture (read-only; BEFORE the attempt is consumed and before any mutation)"
capture PRE "$PRE" || die "PRE capture failed; nothing changed and nothing consumed"
own_pre "$PRE"
( cd "$PRE" && sha256sum -c --quiet --strict SHA256SUMS ) || die "PRE checksum verification failed; nothing changed and nothing consumed"
# The PRE capture ran just now: re-prove target absence, the exact current release, the source, COMPLETE detector absence and the Core snapshot BEFORE the one-shot boundary.
f1i_preflight_gate "$PY" "$F1I_TOOL" "$EXPECTED_CURRENT_RELEASE_ID" "$RELEASE_ID" "$SOURCE_DIR" "$EXPECTED_SOURCE_SHA" "$EXPECTED_PRODUCTION_DETECTOR_SHA256" \
  || die "F1i preflight no longer holds after the PRE capture (see reason above); the attempt was NOT consumed"
f1_detector_absent_gate || die "the detector unit/process is not absent after the PRE capture (see reason above); the attempt was NOT consumed"
f1r_core_snapshot_gate "$CORE_PRE" || die "the Core drifted during the PRE capture (see reason above); the attempt was NOT consumed"

sudo install -d -m 700 -o root -g root "$WORK" || die "could not create the private root work directory"
# one attempt: from this point a second invocation for this AUTH_DIR is refused, even after a failure
f1i_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"
ATTEMPTED=1

echo "== F1i APPLY (once; journal prestate, re-prove target/current/Core, reviewed installer exactly once, preservation proofs)"
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'F1I_APPLY=COMPLETE'; } || rollback_flow "F1I_APPLY failed (rc=$apply_rc)"
echo "== F1i VERIFY (read-only post-L7 preservation check)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'F1I_VERIFY=PASS'; } || rollback_flow "F1I_VERIFY failed"
sudo test -d "$TARGET_PATH" || rollback_flow "independent target-release check failed"
[ "$(sudo readlink /opt/aegis-idea3/current)" = "$CURRENT_RELEASE_PATH" ] || rollback_flow "independent current-target check failed (current must be unchanged)"
f1r_core_snapshot_gate "$CORE_PRE" || rollback_flow "the Core is not the same running process (PID/NRestarts drift)"
sudo cat "$WORK/f1i-journal.json" > "$EVID/f1i-journal.json" 2>/dev/null || true   # non-secret: release ids, targets, PIDs, restart counts, tree digest, material METADATA
TREE_DIGEST=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_tree_digest"])' "$EVID/f1i-journal.json" 2>/dev/null) || rollback_flow "the journaled release tree digest is unreadable"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
own_pre "$EVID/post-root"
f1i_catalog_transition_gate "$PRE" "$EVID/post-root" "$RELEASE_ID" "$TREE_DIGEST" || rollback_flow "the captured release catalog is not exactly PRE plus the one journaled release"
echo "== PRE -> POST compare (the ONLY approved drift is the one-release catalog addition; every other captured record, the current target and every listener must be unchanged)"
compare "$PRE" "$EVID/post-root" "$EVID/compare-pre-post.txt" "$STG/allow-keys.txt" "$EVID/allow-release.txt" || rollback_flow "PRE->POST compare failed"
l7u_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker/Core preservation failed (the Core PID/restart count must be unchanged)"
trap - ERR INT TERM
echo "F1I_LIVE_EXECUTED=YES F1I_RELEASE_INSTALLED=YES F1I_RELEASE_ID=$RELEASE_ID F1I_APPLY=PASS F1I_VERIFY=PASS F1I_POST_CAPTURE=COMPLETE F1I_PRE_POST_COMPARE=PASS"
echo "CURRENT_SYMLINK_CHANGED=NO CORE_RESTARTED=NO F1R_LIVE_EXECUTED=NO F1_ATTEMPT_2_PERFORMED=NO F1_DETECTOR_STARTED=NO"
echo "F1I_CLAIM_BOUNDARY: only the immutable release directory $TARGET_PATH was created; 'current' still points at $CURRENT_RELEASE_PATH and the running Core is untouched. Activating the release is the separate F1r stage."
echo "Evidence: $EVID"
