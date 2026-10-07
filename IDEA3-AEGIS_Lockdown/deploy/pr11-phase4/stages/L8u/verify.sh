#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8u verify handler: the passive, read-only logical acceptance (p4-l8u-observe.py) of the already-provisioned production ESP32.
# Everything it reads comes from Core-owned runtime and durable Protocol-v1 evidence; nothing is written, published or commanded. It runs from the immutable control snapshot under an isolated Python.
set -Eeuo pipefail
fail() { printf 'L8U_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
for var in AEGIS_L8U_CONTROL AEGIS_L8U_DEVICE_ID AEGIS_L8U_DEVICE_MAC AEGIS_L8U_FIRMWARE_SHA256 AEGIS_L8U_L8P_EVIDENCE_FILE AEGIS_L8U_L8P_EVIDENCE_SHA256 AEGIS_L8U_EXPECTED_STATE AEGIS_L8U_OBSERVE_SECONDS AEGIS_L8U_CORE_PID AEGIS_L8U_CORE_PRE_PID AEGIS_L8U_CORE_UNIT_SHA256; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
CTRL=$AEGIS_L8U_CONTROL
[ -d "$CTRL" ] && [ ! -L "$CTRL" ] && [ "$(stat -c %u -- "$CTRL")" = 0 ] || fail CONTROL_SNAPSHOT_INVALID
TARGET=/etc/systemd/system/aegis-idea3-core.service
# The Core is the SAME process the attempt started with (no restart during the observation) and still runs the pinned CTu unit.
core_pid=$(systemctl show -p MainPID --value aegis-idea3-core.service)
[ "$core_pid" = "$AEGIS_L8U_CORE_PID" ] && [ "$core_pid" = "$AEGIS_L8U_CORE_PRE_PID" ] || fail CORE_RESTARTED_DURING_L8U
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] && [ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || fail CORE_NOT_RUNNING
[ "$(systemctl show -p NRestarts --value aegis-idea3-core.service)" = 0 ] || fail CORE_UNEXPECTED_RESTART_COUNT
[ ! -L "$TARGET" ] && [ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$AEGIS_L8U_CORE_UNIT_SHA256" ] || fail CORE_UNIT_NOT_THE_PINNED_UNIT
/usr/bin/python3 -I "$CTRL/p4-l8u-observe.py" --check-l8p-evidence --device-mac "$AEGIS_L8U_DEVICE_MAC" --firmware-sha256 "$AEGIS_L8U_FIRMWARE_SHA256" \
  --l8p-evidence-file "$AEGIS_L8U_L8P_EVIDENCE_FILE" --l8p-evidence-sha256 "$AEGIS_L8U_L8P_EVIDENCE_SHA256" || fail L8P_HISTORICAL_EVIDENCE_INVALID
out=$(/usr/bin/python3 -I "$CTRL/p4-l8u-observe.py" --verify --device-id "$AEGIS_L8U_DEVICE_ID" --core-pid "$core_pid" --expected-state "$AEGIS_L8U_EXPECTED_STATE" --observe-seconds "$AEGIS_L8U_OBSERVE_SECONDS" 2>&1) || { printf '%s\n' "$out" >&2; fail OBSERVATION_FAILED; }
printf '%s\n' "$out"
[ "$(systemctl show -p MainPID --value aegis-idea3-core.service)" = "$core_pid" ] || fail CORE_RESTARTED_DURING_L8U
printf 'L8U_VERIFY=PASS L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY ELECTRICAL_RELAY_PROOF=NO PHYSICAL_PROOF=NO\n'
