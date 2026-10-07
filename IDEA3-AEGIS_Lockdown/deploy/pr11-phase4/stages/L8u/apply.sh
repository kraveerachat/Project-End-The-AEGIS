#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8u (governed READ-ONLY L8 live acceptance) apply handler.
#
# L8u mutates NOTHING on the Core host and NOTHING on the device. This handler only records that the observation window has started: it opens no serial device, runs no esptool, resets and
# flashes nothing, publishes no MQTT, touches no unit and restarts no service. The only governed write of the whole stage is the owner runner's stage-global one-attempt marker.
# allow-keys.txt and allow-listeners.txt are EMPTY: any Core-host drift between the PRE and POST captures fails the stage.
set -Eeuo pipefail
fail() { printf 'L8U_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_L8U_WORK_DIR:?AEGIS_L8U_WORK_DIR required}"
[ "${AEGIS_L8U_LIVE_AUTHORIZED:-}" = YES ] || fail AEGIS_L8U_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$AEGIS_L8U_WORK_DIR" ] && [ ! -L "$AEGIS_L8U_WORK_DIR" ] || fail WORK_DIR_INVALID
printf 'phase=observation-started\n' > "$AEGIS_L8U_WORK_DIR/l8u-journal"
printf 'L8U_APPLY=OBSERVE_ONLY\nL8P_EXECUTED=NO\nESP32_TOUCHED=NO\nSERIAL_ACCESSED=NO\nMQTT_PUBLISHED=NO\nHOST_PRE_TO_POST_ZERO_DRIFT_REQUIRED=YES\n'
