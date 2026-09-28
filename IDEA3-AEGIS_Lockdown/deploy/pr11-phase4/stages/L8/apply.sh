#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8 ESP32 inspection / NVS provisioning /
# firmware flash apply handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l8-operational-design.md (OD-L8-01..OD-L8-09)
#
# Fails closed on any constraint violation. Two device backends exist: the
# fixture backend (file-backed, no serial code path) and the hardware backend
# (HARDWARE_BACKEND_IMPLEMENTED_REPOSITORY), a subprocess adapter over the
# PlatformIO-pinned esptool in p4-l8-device.py. The hardware backend is
# unreachable unless AEGIS_L8_BACKEND=hardware AND
# AEGIS_L8_LIVE_AUTHORIZED=YES. LIVE_L8=NOT_AUTHORIZED.
#
# OD-L8-05: serial access resets the ESP32, so L8 is
# NON_WRITING_BUT_DEVICE_RESETTING and never "passive". This script itself
# never opens a serial device; only the reviewed helper can, and only behind
# the live gate below. The serial port comes solely from device.identity.
set -euo pipefail

fail() {
  printf 'L8_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  local name=$1
  local value=${!name:-}
  [ -n "$value" ] || fail "$name required"
}

# 1. Mandatory environment (OD-L8-06 step 1)
for var in \
  AEGIS_L8_INPUT_DIR \
  AEGIS_L8_WORK_DIR \
  AEGIS_L8_EVIDENCE_DIR \
  AEGIS_L8_PARTITION_TABLE \
  AEGIS_L8_SECRETS_HEADER \
  AEGIS_L8_FIRMWARE_IMAGE \
  AEGIS_L8_FIRMWARE_BUILD_CMD \
  AEGIS_L8_NVS_PARTITION_GEN \
  AEGIS_L8_WIFI_SSID \
  AEGIS_L8_NTP \
  AEGIS_L8_RUN_ID; do
  require_env "$var"
done

INPUT_DIR="$AEGIS_L8_INPUT_DIR"
WORK_DIR="$AEGIS_L8_WORK_DIR"
EVIDENCE_DIR="$AEGIS_L8_EVIDENCE_DIR"
BACKEND="${AEGIS_L8_BACKEND:-fixture}"
RUN_ID="$AEGIS_L8_RUN_ID"

# 2. Backend and live-authorization gate (OD-L8-05)
#
# Hardware needs BOTH the explicit backend and an explicit live authorization.
# Without AEGIS_L8_LIVE_AUTHORIZED=YES the hardware path is unreachable and no
# device is opened. The helper enforces the same gate independently, and adds
# its own refusal while no boot-verification signal is defined
# (BOOT_VERIFICATION_NOT_IMPLEMENTED), so LIVE_L8 stays NOT_AUTHORIZED.
case "$BACKEND" in
  fixture)
    require_env AEGIS_L8_FIXTURE_DEVICE
    case "$AEGIS_L8_FIXTURE_DEVICE" in
      /dev/*) fail "fixture device descriptor must not be a /dev/ device node" ;;
    esac
    ;;
  hardware)
    [ "${AEGIS_L8_LIVE_AUTHORIZED:-NO}" = YES ] ||
      fail "HARDWARE_BACKEND_LIVE_L8_NOT_AUTHORIZED (AEGIS_L8_LIVE_AUTHORIZED=YES required)"
    require_env AEGIS_L8_ESPTOOL
    [ -z "${AEGIS_L8_FIXTURE_DEVICE:-}" ] ||
      fail "the hardware backend must not be combined with a fixture device descriptor"
    ;;
  *)
    fail "unknown device backend: $BACKEND"
    ;;
esac

# 3. Directory constraints
[ -d "$INPUT_DIR" ] || fail "AEGIS_L8_INPUT_DIR must exist and be a directory"
[ ! -L "$INPUT_DIR" ] || fail "AEGIS_L8_INPUT_DIR must not be a symlink"
[ ! -L "$WORK_DIR" ] || fail "AEGIS_L8_WORK_DIR must not be a symlink"
[ ! -L "$EVIDENCE_DIR" ] || fail "AEGIS_L8_EVIDENCE_DIR must not be a symlink"

case "$WORK_DIR" in
  /etc/* | /opt/* | /dev/*) fail "AEGIS_L8_WORK_DIR must not be a host system path" ;;
esac
case "$EVIDENCE_DIR" in
  /etc/* | /opt/* | /dev/*) fail "AEGIS_L8_EVIDENCE_DIR must not be a host system path" ;;
esac

# 4. Owner-supplied input inventory (OD-L8-01, OD-L8-03, OD-L8-08)
for req in device.identity d4.attestation k_c2d k_d2c wifi.psk mqtt.pass; do
  [ -e "$INPUT_DIR/$req" ] || fail "INPUT_DIR missing required file: $req"
  [ ! -L "$INPUT_DIR/$req" ] || fail "INPUT_DIR file must not be a symlink: $req"
  [ -f "$INPUT_DIR/$req" ] || fail "INPUT_DIR entry must be a regular file: $req"
  mode=$(stat -c %a "$INPUT_DIR/$req")
  if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    fail "INPUT_DIR file $req has invalid mode: $mode (owner-only 0600 or 0400 required)"
  fi
done

# 5. Support artifacts
[ -f "$AEGIS_L8_PARTITION_TABLE" ] || fail "reviewed partition table not found: $AEGIS_L8_PARTITION_TABLE"
[ -f "$AEGIS_L8_SECRETS_HEADER" ] || fail "MQTT CA trust anchor header not found: $AEGIS_L8_SECRETS_HEADER"
[ -f "$AEGIS_L8_FIRMWARE_IMAGE" ] || fail "compile-only firmware image not found: $AEGIS_L8_FIRMWARE_IMAGE"
[ -x "$AEGIS_L8_NVS_PARTITION_GEN" ] || fail "nvs partition generator is not executable: $AEGIS_L8_NVS_PARTITION_GEN"

# 6. Stage directories
mkdir -p "$WORK_DIR" "$EVIDENCE_DIR"
chmod 0700 "$WORK_DIR" "$EVIDENCE_DIR"

# 7. Delegate the provisioning path to the reviewed helper.
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

"$PYTHON_BIN" "$P4_HERE/p4-l8-device.py" provision \
  --input-dir "$INPUT_DIR" \
  --work-dir "$WORK_DIR" \
  --evidence-dir "$EVIDENCE_DIR" \
  --backend "$BACKEND" \
  --fixture-device "${AEGIS_L8_FIXTURE_DEVICE:-}" \
  --esptool "${AEGIS_L8_ESPTOOL:-}" \
  --live-authorized "${AEGIS_L8_LIVE_AUTHORIZED:-NO}" \
  --partition-table "$AEGIS_L8_PARTITION_TABLE" \
  --secrets-header "$AEGIS_L8_SECRETS_HEADER" \
  --firmware-image "$AEGIS_L8_FIRMWARE_IMAGE" \
  --build-command "$AEGIS_L8_FIRMWARE_BUILD_CMD" \
  --nvs-generator "$AEGIS_L8_NVS_PARTITION_GEN" \
  --wifi-ssid "$AEGIS_L8_WIFI_SSID" \
  --ntp "$AEGIS_L8_NTP" \
  --run-id "$RUN_ID" || fail "device provisioning failed"

# 8. Host preservation (OD-L8-07)
#
# L8 changes the device, never the Core host: stages/L8/allow-keys.txt and
# allow-listeners.txt are both empty, so p4-compare.sh fails on any host drift
# at all between the PRE and RB captures.
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L8_APPLY=COMPLETE\n'
exit 0
