#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L8p (ESP32 device PROVISIONING ONLY) LIVE window, ONE owner-supervised attempt. OWNER-RUN ONLY.
# REPOSITORY TEMPLATE: every value marked PIN_ is unpinned, so this file REFUSES TO RUN as committed. The owner freeze workflow copies it OUTSIDE the
# repository, replaces the PIN_ values (the merged main SHA, the reviewed artifact digests and the host-specific input locations), records the frozen
# file's SHA-256, and only then authorizes a run. Nothing in this repository executes it. The frozen values are chosen AFTER the final source set is merged.
# Design: docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md (owner decision OD-L8P-01).
# Usage (the FROZEN operator user/uid, NOT root):  bash run-l8p-owner.sh <AUTH_DIR>     AUTH_DIR holds authorization-L8p.txt and k3-L8p.txt (same-day, stage=L8p)
# Stage order: L7 -> L7u -> L8p -> Recovery R1-R8 -> LVR -> L8. L8p provisions the ESP32 only. It requires a PROVEN final L7u (receipt gate against the
# pinned commit), consumes ONE attempt (L8p-ATTEMPT-CONSUMED) and has NO automatic second attempt. This runner holds NO device logic: it never touches
# the flashing tool, the serial port, the broker protocol or the device; every device operation is the canonical L8p handler set (stages/L8p/*.sh over
# p4-l8p-device.py -> the merged L8 HardwareDevice and signed BOOT verifier). The runner NEVER retries or reflashes, never erases, never sends CUT or
# RESTORE, never opens plaintext 1883 and never performs the physical recovery (MANUAL, out-of-band). It does not repair a predecessor and does not touch
# IDEA1/IDEA2, Twingate, legacy mosquitto, the L6b broker, the Core, networking or forwarding.
# A successful run may claim only L8P_LIVE_EXECUTED=YES and L8P_PROVISIONING=PASS. It never claims Recovery R1-R8, LVR, L8 acceptance or electrical relay proof.
set -Eeuo pipefail
umask 077

# ---- frozen pins: the committed template refuses while ANY of these is unpinned ------------------------------------------------------------------
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
FIRMWARE_SHA256=PIN_FIRMWARE_SHA256
PARTITION_TABLE_SHA256=PIN_PARTITION_TABLE_SHA256
INPUT_DIR=PIN_INPUT_DIR
FIRMWARE_IMAGE=PIN_FIRMWARE_IMAGE
PARTITION_TABLE=PIN_PARTITION_TABLE
SECRETS_HEADER=PIN_SECRETS_HEADER
NVS_GENERATOR=PIN_NVS_GENERATOR
FLASH_TOOL_SCRIPT=PIN_FLASH_TOOL_SCRIPT
ESPTOOL_PYTHON=PIN_ESPTOOL_PYTHON
MQTT_CA_FILE=PIN_MQTT_CA_FILE
BROKER_CREDENTIAL_FILE=PIN_BROKER_CREDENTIAL_FILE
BROKER_ADDRESS=PIN_BROKER_ADDRESS
BROKER_TLS_NAME=PIN_BROKER_TLS_NAME
WIFI_SSID=PIN_WIFI_SSID
NTP_SERVER=PIN_NTP_SERVER
FIRMWARE_BUILD_CMD=PIN_FIRMWARE_BUILD_CMD
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID FIRMWARE_SHA256 PARTITION_TABLE_SHA256 INPUT_DIR FIRMWARE_IMAGE PARTITION_TABLE SECRETS_HEADER NVS_GENERATOR FLASH_TOOL_SCRIPT ESPTOOL_PYTHON \
           MQTT_CA_FILE BROKER_CREDENTIAL_FILE BROKER_ADDRESS BROKER_TLS_NAME WIFI_SSID NTP_SERVER FIRMWARE_BUILD_CMD; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin). Run the owner freeze workflow first."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "STOP: OPERATOR_USER is not a valid account identifier."; exit 2; }
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]*$ ]] || { echo "STOP: OPERATOR_UID is not a valid non-root uid."; exit 2; }
for pin in FIRMWARE_SHA256 PARTITION_TABLE_SHA256; do
  [[ "${!pin}" =~ ^[0-9a-f]{64}$ ]] || { echo "STOP: $pin is not a 64-hex SHA-256."; exit 2; }
done
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: bash $0 <AUTH_DIR with authorization-L8p.txt and k3-L8p.txt>"; exit 2; }

# ---- frozen inputs -------------------------------------------------------------------------------------------------------------------------------
REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L8PLIVE   # clean pinned execution worktree at merged main
PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
STG=$P4/stages/L8p
LIB=$P4/p4-l8p-run-lib.sh
AP_IF=wlp0s20f3
AP_ADDR=10.77.30.1
TODAY=$(TZ=Asia/Bangkok date +%F)
STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l8p-$STAMP
WORK=$EVID/l8p-work
OUTEV=$EVID/l8p-evidence
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

# The runner is invoked by exactly the frozen operator identity (the owner-controlled local physical recovery / serial access authority; the reused L7u
# identity gate). It runs BEFORE sudo, the evidence directory, the PRE capture, the attempt marker, any handler and any device access.
l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || die "operator identity is not the frozen L8p operator (see reason above); nothing was created or touched"

echo "RECOVERY_R1_R8_PROVEN=NO"
echo "LVR_PROVEN=NO"
echo "L8_ACCEPTANCE=NO"
echo "== L8p owner-run: pre-gates (read-only; nothing is created or changed yet, the device is NOT touched)"
sudo -v || die "sudo authentication failed"

# 1. same-day stage=L8p records, one-attempt marker, pinned main + clean worktree, handlers, stage gate (live mode)
for f in authorization-L8p.txt k3-L8p.txt; do
  [ -f "$AUTH_DIR/$f" ] || gate "$f missing"
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" 2>/dev/null || gate "$f date is not today ($TODAY Asia/Bangkok)"
  grep -qx "stage=L8p" "$AUTH_DIR/$f" 2>/dev/null || gate "$f is not stage=L8p"
done
grep -qE '^physical_recovery_attestation=.+' "$AUTH_DIR/authorization-L8p.txt" 2>/dev/null || gate "authorization-L8p.txt lacks physical_recovery_attestation"
! grep -q '^recovery_authorization=' "$AUTH_DIR/authorization-L8p.txt" 2>/dev/null || gate "authorization-L8p.txt carries the L8-only recovery_authorization"
l8p_attempt_unconsumed "$AUTH_DIR" || gate "this authorization already consumed its one live attempt"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || gate "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || gate "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] \
  || gate "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt; do [ -f "$STG/$f" ] || gate "handler file $f missing"; done
[ -f "$P4/p4-l8p-device.py" ] || gate "p4-l8p-device.py missing"
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage L8p --mode live --authorization "$AUTH_DIR/authorization-L8p.txt" --k3 "$AUTH_DIR/k3-L8p.txt" 2>&1) || gate "stage gate failed"
for l in AUTHORIZATION_RECORD=VALID K3_CONFIRMATION=VALID ROLLBACK_HANDLER=REGISTERED; do printf '%s\n' "$gate_out" | grep -qx "$l" || gate "stage gate did not report $l"; done

# 2. predecessor ACCEPTANCE from the pinned commit, including the FINAL L7u live acceptance (nothing is invented: refuses until it is merged)
l8p_receipt_gate "$REPO" || gate "predecessor receipt gate failed (see reason above)"

# 3. CURRENT runtime (read-only, never repaired): Core running, broker + legacy services untouched, IDEA2 §10, headroom, forwarding
l7u_core_running_gate "$CORE_UNIT" || gate "the Core is not in the running baseline (see reason above)"
l8p_service_gate twingate.service mosquitto.service "$BROKER_UNIT" || gate "a preserved service is not active/running (see reason above)"
l7_idea2_s10_gate "$ENGINE" "$TUNNEL" || gate "IDEA2 §10 fresh preservation precondition failed (see reason above)"
l7_disk_gate 80 / /var /opt /run || gate "disk headroom below 20% free (see reason above)"
l8p_ntp_runtime_gate || gate "the PRE-L8p NTP runtime is not true now (see reason above)"
for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv6.conf.all.forwarding; do [ "$(sysctl -n $k)" = 0 ] || gate "$k is not 0"; done

# 4. owner inputs and reviewed artifacts (existence, ownership and the frozen digests only; the handler validates every content)
l8p_input_gate "$INPUT_DIR" "$OPERATOR_UID" || gate "the owner input directory contract failed (see reason above)"
l8p_artifact_gate "$FIRMWARE_IMAGE" "$FIRMWARE_SHA256" firmware || gate "reviewed firmware does not match its frozen digest (see reason above)"
l8p_artifact_gate "$PARTITION_TABLE" "$PARTITION_TABLE_SHA256" partition-table || gate "reviewed partition table does not match its frozen digest (see reason above)"
l8p_file_gate "$SECRETS_HEADER" secrets-header || gate "MQTT CA trust-anchor header missing (see reason above)"
l8p_file_gate "$NVS_GENERATOR" nvs-generator exec || gate "NVS generator missing or not executable (see reason above)"
l8p_file_gate "$FLASH_TOOL_SCRIPT" flash-tool || gate "pinned flash tool script missing (see reason above)"
l8p_esptool_python_gate "$ESPTOOL_PYTHON" "$FLASH_TOOL_SCRIPT" || gate "the pinned esptool Python cannot load the pinned esptool (see reason above)"
l8p_file_gate "$MQTT_CA_FILE" mqtt-ca || gate "MQTT CA file missing (see reason above)"
l8p_file_gate "$BROKER_CREDENTIAL_FILE" broker-credential || gate "broker credential file missing (see reason above)"
[ "$GATE_FAILED" = 0 ] || die "one or more pre-gates failed; NOTHING was created or changed on the host and the device was not touched"

# ---- evidence directory and PRE capture (read-only host effect), then the ONE attempt is consumed --------------------------------------------------
snap() { printf '%s/%s\n' "$(show "$1" MainPID)" "$(show "$1" NRestarts)"; }
ENGINE_PRE=$(snap $ENGINE); TUNNEL_PRE=$(snap $TUNNEL); TG_PRE=$(snap twingate.service); MQ_PRE=$(snap mosquitto.service); BROKER_PRE=$(snap $BROKER_UNIT)
CORE_PRE=$(snap $CORE_UNIT)

mkdir -m 700 "$EVID"; exec > >(tee -a "$EVID/owner-run.log") 2>&1
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); printf '%s\n' "$JOURNAL_SINCE" > "$EVID/journal_since.txt"
cp "$AUTH_DIR/authorization-L8p.txt" "$AUTH_DIR/k3-L8p.txt" "$EVID/"
{ echo "MAIN=$EXPECTED_MAIN"; echo "FIRMWARE_SHA256=$FIRMWARE_SHA256"; echo "PARTITION_TABLE_SHA256=$PARTITION_TABLE_SHA256"
  echo "RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)"; } > "$EVID/frozen-inputs.txt"
echo "EVIDENCE_ROOT=$EVID MAIN=$EXPECTED_MAIN"

ATTEMPTED=0; ROLLED_BACK=0
capture() { sudo env EVID_DIR="$2" CAPTURE_LABEL="${1,,}" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$P4/p4-l0-capture.sh" || return 1
  sudo grep -q 'L0_CAPTURE=COMPLETE' "$2/capture.log" || return 1; sudo bash -c "cd '$2' && sha256sum -c --quiet --strict SHA256SUMS" || return 1; echo "CAPTURE_$1=COMPLETE SHA256=PASS"; }
compare() {  # compare BEFORE AFTER OUTFILE: the L8p allow files are EMPTY, so any Core-host drift fails the comparison
  local rc=0
  sudo env DISK_THRESHOLD_PCT=90 AEGIS_AP_INTERFACE="$AP_IF" AEGIS_AP_ADDRESS="$AP_ADDR" ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$1" "$2" "$3" > "$3" 2>&1 || rc=$?
  grep -E '^(FINDING|FINDINGS_|PRESERVATION_S10|COMPARE_RESULT)' "$3" || true; [ "$rc" = 0 ] || return 1
  for l in FINDINGS_NEW_OR_WORSENED_DRIFT=0 FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0 FINDINGS_INCOMPARABLE=0 PRESERVATION_S10=PASS COMPARE_RESULT=PASS; do
    grep -qx "$l" "$3" || { echo "COMPARE_REQUIREMENT_FAILED: $l"; return 1; }; done; }
# The canonical handlers run UNPRIVILEGED as the operator (serial access via the operator's own groups). The hardware backend is reachable ONLY here,
# after every gate above and the PRE capture and the consumed attempt: AEGIS_L8P_BACKEND=hardware + AEGIS_L8P_LIVE_AUTHORIZED=YES exist nowhere else.
handler() {
  env AEGIS_L8P_INPUT_DIR="$INPUT_DIR" AEGIS_L8P_WORK_DIR="$WORK" AEGIS_L8P_EVIDENCE_DIR="$OUTEV" AEGIS_L8P_PRE_EVIDENCE_DIR="$PRE" \
    AEGIS_L8P_BACKEND=hardware AEGIS_L8P_LIVE_AUTHORIZED=YES AEGIS_L8P_ESPTOOL="$FLASH_TOOL_SCRIPT" AEGIS_L8P_ESPTOOL_PYTHON="$ESPTOOL_PYTHON" \
    AEGIS_L8P_BROKER_ADDRESS="$BROKER_ADDRESS" AEGIS_L8P_BROKER_TLS_NAME="$BROKER_TLS_NAME" AEGIS_L8P_MQTT_CA_FILE="$MQTT_CA_FILE" \
    AEGIS_L8P_BROKER_CREDENTIAL_FILE="$BROKER_CREDENTIAL_FILE" AEGIS_L8P_PARTITION_TABLE="$PARTITION_TABLE" AEGIS_L8P_SECRETS_HEADER="$SECRETS_HEADER" \
    AEGIS_L8P_FIRMWARE_IMAGE="$FIRMWARE_IMAGE" AEGIS_L8P_FIRMWARE_BUILD_CMD="$FIRMWARE_BUILD_CMD" AEGIS_L8P_NVS_PARTITION_GEN="$NVS_GENERATOR" \
    AEGIS_L8P_WIFI_SSID="$WIFI_SSID" AEGIS_L8P_NTP="$NTP_SERVER" AEGIS_L8P_RUN_ID="l8p-$STAMP" AEGIS_PYTHON_BIN="$PY" bash "$STG/$1"; }
own_pre() { sudo chown -R "$(id -u):$(id -g)" "$1" 2>/dev/null || true; }
s10_unchanged() { [ "$(snap $ENGINE)" = "$ENGINE_PRE" ] && [ "$(snap $TUNNEL)" = "$TUNNEL_PRE" ] && [ "$(snap twingate.service)" = "$TG_PRE" ] \
  && [ "$(snap mosquitto.service)" = "$MQ_PRE" ] && [ "$(snap $BROKER_UNIT)" = "$BROKER_PRE" ] && [ "$(snap $CORE_UNIT)" = "$CORE_PRE" ]; }
# Failure/abort path ONLY. Never retries, reflashes, erases, restores or sends CUT; the physical recovery is a MANUAL owner action outside this runner.
rollback_flow() { trap - ERR INT TERM; [ "$ROLLED_BACK" = 0 ] || return 0; ROLLED_BACK=1; echo "== L8p ROLLBACK (reason: $1) — failure/abort path only"
  local started=0 out; [ -f "$WORK/first-write.marker" ] && started=1
  out=$(handler rollback.sh 2>&1) || { printf '%s\n' "$out"; echo "L8P_ROLLBACK=FAIL (S-11 HOLD) — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  printf '%s\n' "$out"
  l8p_rollback_output_gate "$started" "$out" || { echo "L8P_ROLLBACK_SEMANTICS=FAIL — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  capture RB "$EVID/rb-root" || { echo "RB capture FAILED — ESCALATE; do NOT retry; inspect $EVID"; exit 3; }
  own_pre "$EVID/rb-root"
  compare "$PRE" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" && s10_unchanged || { echo "PRE_RB_COMPARE=FAIL — ESCALATE; do NOT retry"; exit 3; }
  if [ "$started" = 1 ]; then echo "HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE (the first device write started; the device was intentionally changed)"; fi
  echo "PRE_RB_COMPARE=PASS (Core host). L8P_PROVISIONING=NOT_PROVEN. The device holds FAIL-SECURE; physical recovery is MANUAL and out-of-band. NOT retrying. Authorization is consumed."; exit 1; }
fail_after_attempt() { [ "$ATTEMPTED" = 1 ] && rollback_flow "$1" || { echo "STOP before the attempt was consumed: $1"; exit 1; }; }
trap 'fail_after_attempt "unexpected error at line $LINENO"' ERR
trap 'fail_after_attempt "interrupted"' INT TERM

echo "== PRE capture (read-only; BEFORE the attempt is consumed and before any device access)"
capture PRE "$PRE" || die "PRE capture failed; nothing changed and nothing consumed"
own_pre "$PRE"
( cd "$PRE" && sha256sum -c --quiet --strict SHA256SUMS ) || die "PRE checksum verification failed; nothing changed and nothing consumed"
# The PRE capture ran just now: prove the NTP runtime is STILL true after it and BEFORE the one attempt is consumed (no serial access, reset, write or marker has happened).
l8p_ntp_runtime_gate || die "the PRE-L8p NTP runtime is not true after the PRE capture (see reason above); the attempt was NOT consumed and the device was NOT touched"

# one attempt: from this point a second invocation for this AUTH_DIR is refused, even after a failure
l8p_consume_attempt "$AUTH_DIR" || die "could not consume the one-attempt marker"
ATTEMPTED=1

echo "== L8p APPLY (once; the canonical handler: gates, FIRST_WRITE, NVS + firmware write, readbacks, ONE terminal reset, signed BOOT verification)"
apply_rc=0; apply_out=$(handler apply.sh 2>&1) || apply_rc=$?; printf '%s\n' "$apply_out"
{ [ "$apply_rc" = 0 ] && printf '%s\n' "$apply_out" | grep -qx 'L8P_APPLY=COMPLETE'; } || rollback_flow "L8P_APPLY failed (rc=$apply_rc)"
echo "== L8p VERIFY (read-only evidence check)"
ver_rc=0; ver_out=$(handler verify.sh 2>&1) || ver_rc=$?; printf '%s\n' "$ver_out"
{ [ "$ver_rc" = 0 ] && printf '%s\n' "$ver_out" | grep -qx 'L8P_VERIFY=PASS'; } || rollback_flow "L8P_VERIFY failed"
echo "== POST capture"; capture POST "$EVID/post-root" || rollback_flow "POST capture failed"
own_pre "$EVID/post-root"
echo "== PRE -> POST compare (Core host zero drift: the L8p allow files are empty)"; compare "$PRE" "$EVID/post-root" "$EVID/compare-pre-post.txt" || rollback_flow "PRE->POST compare failed"
l8p_secret_scan "$EVID" "$INPUT_DIR" "$PY" || rollback_flow "SECRET_OUTPUT_SCAN failed"
s10_unchanged || rollback_flow "S10/legacy mosquitto/Twingate/L6b broker/Core preservation failed"
trap - ERR INT TERM
echo "L8P_LIVE_EXECUTED=YES L8P_PROVISIONING=PASS L8P_APPLY=PASS L8P_VERIFY=PASS L8P_POST_CAPTURE=COMPLETE L8P_PRE_POST_COMPARE=PASS"
echo "L8P_BOOT_NOTE=the signed BOOT LOCKDOWN is authenticated FIRMWARE-REPORTED state, not electrical relay proof."
echo "RECOVERY_R1_R8_PROVEN=NO LVR_PROVEN=NO L8_ACCEPTANCE=NO ELECTRICAL_RELAY_PROOF=NO L8_STARTED=NO RECOVERY_LIVE_EXECUTED=NO CORE_RESTARTED=NO"
echo "Evidence: $EVID"
