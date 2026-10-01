#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8p (ESP32 device PROVISIONING ONLY) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> Recovery R1-R8 -> LVR -> L8. L8p provisions the Protocol-v1 ESP32 and claims nothing about Recovery, LVR, L8 live
# acceptance or the electrical relay; it never sends CUT or RESTORE. Owner decision OD-L8P-01: for L8p only, an owner-attested PHYSICAL recovery
# procedure replaces "D4 live before flash"; normal L8 stays D4-only.
#
# This script contains NO device logic. Every gate that needs no device runs first and refuses without touching it; the device work is the
# canonical L8 flow (p4-l8-device.py: HardwareDevice, NVS + firmware readback, one terminal reset, signed BOOT STATUS) reached through the thin
# p4-l8p-device.py, which only supplies the L8p stage profile. The hardware backend is unreachable without AEGIS_L8P_LIVE_AUTHORIZED=YES.
set -euo pipefail

fail() {
  printf 'L8P_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  [ -n "${!1:-}" ] || fail "$1 required"
}

for var in \
  AEGIS_L8P_INPUT_DIR \
  AEGIS_L8P_WORK_DIR \
  AEGIS_L8P_EVIDENCE_DIR \
  AEGIS_L8P_PRE_EVIDENCE_DIR \
  AEGIS_L8P_PARTITION_TABLE \
  AEGIS_L8P_SECRETS_HEADER \
  AEGIS_L8P_FIRMWARE_IMAGE \
  AEGIS_L8P_FIRMWARE_BUILD_CMD \
  AEGIS_L8P_NVS_PARTITION_GEN \
  AEGIS_L8P_WIFI_SSID \
  AEGIS_L8P_NTP \
  AEGIS_L8P_RUN_ID; do
  require_env "$var"
done

INPUT_DIR="$AEGIS_L8P_INPUT_DIR"
WORK_DIR="$AEGIS_L8P_WORK_DIR"
EVIDENCE_DIR="$AEGIS_L8P_EVIDENCE_DIR"
PRE_DIR="$AEGIS_L8P_PRE_EVIDENCE_DIR"
BACKEND="${AEGIS_L8P_BACKEND:-fixture}"

case "$BACKEND" in
  fixture)
    require_env AEGIS_L8P_FIXTURE_DEVICE
    case "$AEGIS_L8P_FIXTURE_DEVICE" in
      /dev/*) fail "fixture device descriptor must not be a /dev/ device node" ;;
    esac
    ;;
  hardware)
    [ "${AEGIS_L8P_LIVE_AUTHORIZED:-NO}" = YES ] ||
      fail "HARDWARE_BACKEND_LIVE_L8P_NOT_AUTHORIZED (AEGIS_L8P_LIVE_AUTHORIZED=YES required)"
    require_env AEGIS_L8P_ESPTOOL
    require_env AEGIS_L8P_BROKER_ADDRESS
    require_env AEGIS_L8P_BROKER_TLS_NAME
    require_env AEGIS_L8P_MQTT_CA_FILE
    require_env AEGIS_L8P_BROKER_CREDENTIAL_FILE
    [ -z "${AEGIS_L8P_FIXTURE_DEVICE:-}" ] ||
      fail "the hardware backend must not be combined with a fixture device descriptor"
    ;;
  *)
    fail "unknown device backend: $BACKEND"
    ;;
esac

[ -d "$INPUT_DIR" ] || fail "AEGIS_L8P_INPUT_DIR must exist and be a directory"
[ ! -L "$INPUT_DIR" ] || fail "AEGIS_L8P_INPUT_DIR must not be a symlink"
[ ! -L "$WORK_DIR" ] || fail "AEGIS_L8P_WORK_DIR must not be a symlink"
[ ! -L "$EVIDENCE_DIR" ] || fail "AEGIS_L8P_EVIDENCE_DIR must not be a symlink"
case "$WORK_DIR" in
  /etc/* | /opt/* | /dev/*) fail "AEGIS_L8P_WORK_DIR must not be a host system path" ;;
esac
case "$EVIDENCE_DIR" in
  /etc/* | /opt/* | /dev/*) fail "AEGIS_L8P_EVIDENCE_DIR must not be a host system path" ;;
esac

# Owner-supplied private inputs: regular files, owner-only mode, never symlinks. There is deliberately no d4.attestation here (OD-L8P-01).
for req in device.identity provisioning.pins physical-recovery.attestation k_c2d k_d2c wifi.psk mqtt.pass; do
  [ -e "$INPUT_DIR/$req" ] || fail "INPUT_DIR missing required file: $req"
  [ ! -L "$INPUT_DIR/$req" ] || fail "INPUT_DIR file must not be a symlink: $req"
  [ -f "$INPUT_DIR/$req" ] || fail "INPUT_DIR entry must be a regular file: $req"
  mode=$(stat -c %a "$INPUT_DIR/$req")
  if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    fail "INPUT_DIR file $req has invalid mode: $mode (owner-only 0600 or 0400 required)"
  fi
done

[ -f "$AEGIS_L8P_PARTITION_TABLE" ] || fail "reviewed partition table not found"
[ -f "$AEGIS_L8P_SECRETS_HEADER" ] || fail "MQTT CA trust anchor header not found"
[ -f "$AEGIS_L8P_FIRMWARE_IMAGE" ] || fail "compile-only firmware image not found"
[ -x "$AEGIS_L8P_NVS_PARTITION_GEN" ] || fail "nvs partition generator is not executable"

# PRE evidence must already exist, be complete and be unmodified BEFORE the first device write.
[ -d "$PRE_DIR" ] && [ ! -L "$PRE_DIR" ] || fail "PRE evidence directory missing"
[ -f "$PRE_DIR/capture.log" ] && grep -qx 'L0_CAPTURE=COMPLETE' "$PRE_DIR/capture.log" || fail "PRE evidence capture is not COMPLETE"
[ -f "$PRE_DIR/SHA256SUMS" ] && (cd "$PRE_DIR" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1) || fail "PRE evidence checksum verification failed"

mkdir -p "$WORK_DIR" "$EVIDENCE_DIR"
chmod 0700 "$WORK_DIR" "$EVIDENCE_DIR"

P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

rc=0
out=$("$PYTHON_BIN" "$P4_HERE/p4-l8p-device.py" provision \
  --input-dir "$INPUT_DIR" \
  --work-dir "$WORK_DIR" \
  --evidence-dir "$EVIDENCE_DIR" \
  --backend "$BACKEND" \
  --fixture-device "${AEGIS_L8P_FIXTURE_DEVICE:-}" \
  --esptool "${AEGIS_L8P_ESPTOOL:-}" \
  --live-authorized "${AEGIS_L8P_LIVE_AUTHORIZED:-NO}" \
  --broker-address "${AEGIS_L8P_BROKER_ADDRESS:-}" \
  --broker-tls-name "${AEGIS_L8P_BROKER_TLS_NAME:-}" \
  --broker-ca-file "${AEGIS_L8P_MQTT_CA_FILE:-}" \
  --broker-credential-file "${AEGIS_L8P_BROKER_CREDENTIAL_FILE:-}" \
  --partition-table "$AEGIS_L8P_PARTITION_TABLE" \
  --secrets-header "$AEGIS_L8P_SECRETS_HEADER" \
  --firmware-image "$AEGIS_L8P_FIRMWARE_IMAGE" \
  --build-command "$AEGIS_L8P_FIRMWARE_BUILD_CMD" \
  --nvs-generator "$AEGIS_L8P_NVS_PARTITION_GEN" \
  --wifi-ssid "$AEGIS_L8P_WIFI_SSID" \
  --ntp "$AEGIS_L8P_NTP" \
  --run-id "$AEGIS_L8P_RUN_ID") || rc=$?
# The canonical flow reports with its own L8_ prefix; relabel so an L8p run is never mistaken for L8.
[ -z "$out" ] || printf '%s\n' "$out" | sed 's/^L8_/L8P_/'

# Scope statement: this stage proves provisioning only.
printf 'L8P_PROVISIONING_ONLY=YES\n'
printf 'RECOVERY_R1_R8_PROVEN=NO\n'
printf 'LVR_PROVEN=NO\n'
printf 'L8_ACCEPTANCE=NO\n'
printf 'L9_PROVEN=NO\n'
printf 'D4_LIVE_VERIFIED=NO\n'
printf 'ELECTRICAL_RELAY_PROOF=NO\n'
[ "$rc" = 0 ] || fail "device provisioning failed (FAIL_SECURE_HOLD_AND_EVIDENCE; manual owner physical recovery only, never automatic)"
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L8P_APPLY=COMPLETE\n'
exit 0
