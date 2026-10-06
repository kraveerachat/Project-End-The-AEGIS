#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — RRu (governed Recovery-PREPARATION release deployment) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the repository, replaces the PIN_ values (the merged main SHA, the
# operator identity, the exact OLD and NEW release ids, the NEW release source SHA, the reviewed production_detector.py digest, the reviewed detector unit digest, the reviewed recovery_core.py digest and the reviewed
# aegis_soc/cli.py digest), records the frozen file's SHA-256, and only then authorizes a run. Nothing in this repository executes it, creates an authorization or K3 record, or freezes a pin.
# Usage (the FROZEN operator user/uid, NOT root):  bash run-rru-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-RRu.txt and k3-RRu.txt (FRESH same-day, stage=RRu; never an F1i/F1r/F1u/R1Du/Recovery record)
# Stage order: ... -> R1Du -> R1D (immutable FAIL) -> R1Dv -> R1B (immutable FAIL) -> R1Bv (PASS) -> RRu -> Recovery R2-R8 -> LVR -> L8 -> L9. RRu is a NEW governed stage, never a retry or replay of F1i/F1r/F1u/R1Du (consumed forever).
# RRu owns ONLY: install ONE new immutable release that also carries aegis_soc/cli.py (reviewed installer, once) and atomically switch /opt/aegis-idea3/current from the exact OLD target to the exact NEW target.
# It restarts NOTHING: no Core restart, no detector command, no daemon-reload, no core.env edit. The NEW release is machine-proved to be OLD plus exactly cli.py, so the running Core (from OLD) stays correct.
# RRu mutates NO incident, database, R1I, R1B/R1Bv evidence or Recovery marker, runs NO ISOLATE/RESTORE/CLOSE, injects NO alert and never touches the ESP32. It proves RECOVERY_RUNTIME_RELEASE_READY only and leaves
# RECOVERY_ATTEMPT_CONSUMED=NO. Consumes ONE attempt (RRU-ATTEMPT-CONSUMED); there is NO automatic second attempt and NO retry after rollback.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
OLD_RELEASE_ID=PIN_OLD_RELEASE_ID
NEW_RELEASE_ID=PIN_NEW_RELEASE_ID
NEW_RELEASE_SOURCE_SHA=PIN_NEW_RELEASE_SOURCE_SHA
PRODUCTION_DETECTOR_SHA256=PIN_PRODUCTION_DETECTOR_SHA256
DETECTOR_UNIT_SHA256=PIN_DETECTOR_UNIT_SHA256
RECOVERY_CORE_SHA256=PIN_RECOVERY_CORE_SHA256
RESTORE_CLI_SHA256=PIN_RESTORE_CLI_SHA256
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID OLD_RELEASE_ID NEW_RELEASE_ID NEW_RELEASE_SOURCE_SHA PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256; do
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
for pin in PRODUCTION_DETECTOR_SHA256 DETECTOR_UNIT_SHA256 RECOVERY_CORE_SHA256 RESTORE_CLI_SHA256; do
  [[ "${!pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: $pin is not a 64-hex SHA-256."; exit 2; }
done
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-RRu.txt and k3-RRu.txt>"; exit 2; }

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-RRULIVE   # clean pinned execution worktree at merged main (contains RRu)
SOURCE_DIR=/home/kittipat/Workspace/idea3-p4-evidence/rru-owner-source/$NEW_RELEASE_ID    # completed builder output (user-owned), built by the reviewed builder from the pinned main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/RRu
LIB=$P4/p4-rru-run-lib.sh
RRU_TOOL=$P4/p4-rru-upgrade.py
OLD_RELEASE_PATH=/opt/aegis-idea3/releases/$OLD_RELEASE_ID
NEW_RELEASE_PATH=/opt/aegis-idea3/releases/$NEW_RELEASE_ID
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-rru-$STAMP
WORK=$EVID/rru-work
PRE=$EVID/pre-root
ENGINE=aegis-detection-engine.service; TUNNEL=aegis-detection-tunnel.service
CORE_UNIT=aegis-idea3-core.service
DETECTOR_UNIT=aegis-idea3-detector.service
BROKER_UNIT=aegis-idea3-mosquitto.service

die() { echo "STOP: $*" >&2; exit 1; }
GATE_FAILED=0; gate() { echo "GATE_FAIL: $*" >&2; GATE_FAILED=1; }
show() { systemctl show -p "$2" --value "$1"; }

[ -f "$LIB" ] || die "gate library missing: $LIB (is $REPO at the pinned main?)"
# shellcheck disable=SC1090
source "$LIB"

# The runner is invoked by exactly the frozen operator identity (the reused L7u identity gate). It runs BEFORE sudo, the evidence directory, the PRE capture, the attempt marker and any handler.
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen RRu operator (see reason above); nothing was created or touched"

echo "RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_LIVE_EXECUTED=NO RECOVERY_R2_R8_EXECUTED=NO INCIDENT_MUTATED=NO"
echo "== RRu owner-run: pre-gates (read-only; nothing is created or changed yet)"
sudo -v || die "sudo authentication failed"

# 1. FRESH same-day stage=RRu records (never a consumed F1/F1i/F1r/F1u/R1Du/Recovery record), one-attempt marker, pinned main + clean worktree, handlers, stage gate (live mode)
for f in authorization-RRu.txt k3-RRu.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=RRu" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=RRu"
done
rru_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-keys-rollback.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$RRU_TOOL" ] || gate "p4-rru-upgrade.py missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage RRu --mode live --authorization "$AUTH_DIR/authorization-RRu.txt" --k3 "$AUTH_DIR/k3-RRu.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessors (receipt CONTENT of the pinned commit): R1B immutable FAIL + R1Bv PASS (reused gate), the R1Du closeout naming the OLD release; the Recovery marker must be ABSENT; RRu must not already be recorded
rru_receipt_gate "$REPO" "$EXPECTED_MAIN" "$OLD_RELEASE_ID" || gate "predecessor receipt gate failed (see reason above)"
rru_recovery_marker_absent || gate "the Recovery attempt marker is not absent (see reason above)"
# the frozen digests must be exactly the REVIEWED, merged source bytes of the pinned commit; the release must carry exactly the merged runtime, including cli.py
rru_runtime_source_gate "$REPO" "$PRODUCTION_DETECTOR_SHA256" "$RECOVERY_CORE_SHA256" "$RESTORE_CLI_SHA256" || gate "a frozen digest is not the reviewed source at the pinned main (see reason above)"
rru_release_content_gate "$REPO" "$SOURCE_DIR" || gate "the built release is not exactly the pinned main's runtime (see reason above)"

# 3. CURRENT runtime (read-only, never repaired): Core and detector running, preserved services, IDEA2 §10, headroom
l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not in the running baseline (see reason above)"
rru_detector_running_gate || gate "the detector is not the running baseline unit (see reason above)"
l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
l7_broker_runtime_gate "$BROKER_UNIT" "$AP_ADDR" || gate "the persistent L6b broker gate failed (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"

# 4. RRu specifics (the reviewed tool's read-only check, with root read authority; creates no alert and opens no attempt of any other stage)
rru_preflight_gate "$PY" "$RRU_TOOL" "$OLD_RELEASE_ID" "$NEW_RELEASE_ID" "$SOURCE_DIR" "$NEW_RELEASE_SOURCE_SHA" "$PRODUCTION_DETECTOR_SHA256" "$RECOVERY_CORE_SHA256" "$DETECTOR_UNIT_SHA256" "$RESTORE_CLI_SHA256" \
  || gate "RRu preflight failed (see reason above)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host"

# ---- evidence directory and PRE capture (read-only host effect), then the ONE attempt is consumed ----------------------------------------------------
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
CORE_PRE=$(snap $CORE_UNIT); DETECTOR_PRE=$(snap $DETECTOR_UNIT)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
{ echo "stage RRu"; echo "release_id $NEW_RELEASE_ID"; } > "$EVID/allow-release.txt"   # the RELATIONAL one-release catalog allowance for the forward comparison only
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-RRu.txt" "$AUTH_DIR/k3-RRu.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "OLD_RELEASE_ID=$OLD_RELEASE_ID"; echo "NEW_RELEASE_ID=$NEW_RELEASE_ID"; echo "NEW_RELEASE_SOURCE_SHA=$NEW_RELEASE_SOURCE_SHA"
  echo "PRODUCTION_DETECTOR_SHA256=$PRODUCTION_DETECTOR_SHA256"; echo "DETECTOR_UNIT_SHA256=$DETECTOR_UNIT_SHA256"; echo "RECOVERY_CORE_SHA256=$RECOVERY_CORE_SHA256"; echo "RESTORE_CLI_SHA256=$RESTORE_CLI_SHA256"
  echo "CORE_PRE=$CORE_PRE"; echo "DETECTOR_PRE=$DETECTOR_PRE"; echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN OLD=$OLD_RELEASE_ID NEW=$NEW_RELEASE_ID"

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
# The canonical handlers run as ROOT. The live flag exists nowhere else, and only after every gate above, the PRE capture and the consumed attempt.
handler() {
  sudo env AEGIS_RRU_LIVE_AUTHORIZED=YES AEGIS_RRU_WORK_DIR="$WORK" AEGIS_RRU_OLD_RELEASE_ID="$OLD_RELEASE_ID" AEGIS_RRU_NEW_RELEASE_ID="$NEW_RELEASE_ID" \
    AEGIS_RRU_SOURCE_DIR="$SOURCE_DIR" AEGIS_RRU_NEW_SOURCE_SHA="$NEW_RELEASE_SOURCE_SHA" AEGIS_RRU_DETECTOR_SHA256="$PRODUCTION_DETECTOR_SHA256" \
    AEGIS_RRU_RECOVERY_CORE_SHA256="$RECOVERY_CORE_SHA256" AEGIS_RRU_DETECTOR_UNIT_SHA256="$DETECTOR_UNIT_SHA256" AEGIS_RRU_RESTORE_CLI_SHA256="$RESTORE_CLI_SHA256" AEGIS_PYTHON_BIN="$PY" \
    PYTHONDONTWRITEBYTECODE=1 bash "$STG/$1"
}
own_pre() { sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || true; }
# S10, the preserved services AND (unlike R1Du) the Core and the detector are unchanged: RRu restarts nothing.
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ]; }
processes_unchanged() { rru_unit_snapshot_gate "$CORE_UNIT" "$CORE_PRE" && rru_unit_snapshot_gate "$DETECTOR_UNIT" "$DETECTOR_PRE" && l7u_core_running_gate "$CORE_UNIT" && rru_detector_running_gate; }
# Failure/abort path ONLY. One rollback of what this attempt owns; never a retry, never a restart or a detector action of any kind.
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== RRu ROLLBACK (reason: $1) — failure/abort path only"
  local out
  out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; echo "RRU_ROLLBACK=FAIL (owner decision) — ESCALATE; do NOT retry; do NOT command the Core or the detector; inspect $EVID"; exit 3; }
  printf '%s\n' "$out"
  rru_rollback_output_gate "$out" || { echo "RRU_ROLLBACK_SEMANTICS=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  { ! sudo test -e "$NEW_RELEASE_PATH" && [ "$(sudo readlink /opt/aegis-idea3/current)" = "$OLD_RELEASE_PATH" ]; } \
    || { echo "RRU_ROLLBACK_STATE=FAIL (the NEW release is still present or current is not the OLD target) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  processes_unchanged || { echo "RRU_ROLLBACK_PROCESSES=FAIL (the Core or the detector is not exactly the PRE process; neither is repaired automatically) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  own_pre "$EVID/rb-root"
  rru_runtime_unchanged_gate "$PRE" "$EVID/rb-root" "$OLD_RELEASE_PATH" || { echo "RRU_RB_RUNTIME_UNCHANGED=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  compare "$PRE" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" "$STG/allow-keys-rollback.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  echo "PRE_RB_COMPARE=PASS (ZERO allowance: class EXACT_PROCESS, nothing was ever restarted). RRU_PRODUCTION_DEPLOYED=NO (rolled back). NOT retrying. Authorization is consumed."; exit 1; }
fail_after_attempt() { [ "$ATTEMPTED" = 1 ] && rollback_flow "$1" || { echo "STOP before the attempt was consumed: $1"; exit 1; }; }
trap 'fail_after_attempt "unexpected error at line $LINENO"' ERR
trap 'fail_after_attempt "interrupted"' INT TERM

echo "== PRE capture (read-only; BEFORE the attempt is consumed and before any mutation)"
capture PRE "$PRE" || die "PRE capture failed; nothing changed and nothing consumed"
own_pre "$PRE"
( cd "$PRE" && sha256sum -c --quiet --strict SHA256SUMS ) || die "PRE checksum verification failed; nothing changed and nothing consumed"
# The PRE capture ran just now: re-prove everything BEFORE the one-shot boundary.
rru_recovery_marker_absent || die "the Recovery marker appeared during the PRE capture; the attempt was NOT consumed"
rru_preflight_gate "$PY" "$RRU_TOOL" "$OLD_RELEASE_ID" "$NEW_RELEASE_ID" "$SOURCE_DIR" "$NEW_RELEASE_SOURCE_SHA" "$PRODUCTION_DETECTOR_SHA256" "$RECOVERY_CORE_SHA256" "$DETECTOR_UNIT_SHA256" "$RESTORE_CLI_SHA256" \
  || die "RRu preflight no longer holds after the PRE capture (see reason above); the attempt was NOT consumed"
processes_unchanged || die "the Core or the detector drifted during the PRE capture (see reason above); the attempt was NOT consumed"

sudo install -d -m 700 -o root -g root "$WORK" || die "could not create the private root work directory"
# one attempt: from this point a second invocation for this AUTH_DIR is refused, even after a failure
rru_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"
ATTEMPTED=1

echo "== RRu APPLY (once; journal before each owned step: install the release once, switch current once; NO restart; then the unchanged-process proofs)"
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'RRU_APPLY=COMPLETE'; } || rollback_flow "RRU_APPLY failed (rc=$apply_rc)"
echo "== RRu VERIFY (read-only evidence check)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'RRU_VERIFY=PASS' && printf '%s\n' "$ver_out" | grep -qx 'RECOVERY_RUNTIME_RELEASE_READY=YES'; } || rollback_flow "RRU_VERIFY failed"
[ "$(sudo readlink /opt/aegis-idea3/current)" = "$NEW_RELEASE_PATH" ] || rollback_flow "independent current-target check failed"
processes_unchanged || rollback_flow "the Core or the detector is not exactly the PRE process (PID/NRestarts/state/contract)"
rru_recovery_marker_absent || rollback_flow "the Recovery marker is not absent after the apply"
sudo cat "$WORK/rru-journal.json" > "$EVID/rru-journal.json" 2>/dev/null || true   # non-secret: release ids, targets, PIDs, tree digests, state snapshots, material METADATA
TREE_DIGEST=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_tree_digest"])' "$EVID/rru-journal.json" 2>/dev/null) || rollback_flow "the journaled release tree digest is unreadable"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
own_pre "$EVID/post-root"
rru_runtime_unchanged_gate "$PRE" "$EVID/post-root" "$OLD_RELEASE_PATH" || rollback_flow "the captured running Core/detector release changed (RRu restarts nothing)"
rru_current_transition_gate "$PRE" "$EVID/post-root" "$OLD_RELEASE_PATH" "$NEW_RELEASE_PATH" || rollback_flow "the captured current-target transition is not exactly OLD -> NEW"
rru_catalog_transition_gate "$PRE" "$EVID/post-root" "$NEW_RELEASE_ID" "$TREE_DIGEST" || rollback_flow "the captured release catalog is not exactly PRE plus the one journaled release"
echo "== PRE -> POST compare (approved drift: ONLY the exact current key and the one-release catalog addition; every other captured record — Core/detector process identity, core.env, credentials, units, sockets, listeners — must be unchanged)"
compare "$PRE" "$EVID/post-root" "$EVID/compare-pre-post.txt" "$STG/allow-keys.txt" "$EVID/allow-release.txt" || rollback_flow "PRE->POST compare failed"
l7u_secret_scan "$EVID" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker preservation failed"
trap - ERR INT TERM
echo "RRU_LIVE_EXECUTED=YES RRU_PRODUCTION_DEPLOYED=YES RRU_RELEASE_ID=$NEW_RELEASE_ID RRU_APPLY=PASS RRU_VERIFY=PASS RRU_POST_CAPTURE=COMPLETE RRU_PRE_POST_COMPARE=PASS"
echo "RECOVERY_RUNTIME_RELEASE_READY=YES CORE_RESTART_INVOCATIONS=0 CORE_PROCESS_UNCHANGED=YES DETECTOR_PROCESS_UNCHANGED=YES EXPLICIT_DETECTOR_COMMANDS=0 NEW_RELEASE_IS_OLD_PLUS_CLI_ONLY=YES ALERT_INJECTED=NO"
echo "RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_LIVE_EXECUTED=NO RECOVERY_R2_R8_EXECUTED=NO F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN R1_VERIFIED=NOT_CLAIMED RECOVERY_R1_R8_PROVEN=NO LVR_PROVEN=NO L8_ACCEPTANCE=NO L9_PROVEN=NO"
echo "RRU_CLAIM_BOUNDARY: RRu proves DEPLOYMENT of the Recovery-capable release only (current now points at a release that manifests aegis_soc/cli.py). Recovery R2-R8 has NOT run; its marker is untouched; a NEW exact-main Recovery authority bound to the merged main must be created before Recovery."
echo "Evidence: $EVID"
