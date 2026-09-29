#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8 rollback handler.
#
# OD-L8-08, OD-14: L8_RECOVERY_POLICY=D4_ONLY and
# INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED.
#
# Behaviour splits at the first hardware write:
#
#   before the first write  -> remove only this stage's local artifacts; the
#                              Core host is left at zero drift.
#   at or after that write  -> perform NO device action at all and hold
#                              fail-secure. The relay keeps its boot CUT
#                              output until a D4 RESTORE.
#
# Forbidden here without exception, and deliberately not implemented:
# automatic restore of the uplink, automatic RESTORE after reboot or MQTT
# reconnect, reflash of the previous firmware, any legacy v0 image, and any
# plaintext MQTT fallback. Recovery is D4 only.
#
# Idempotent: repeated execution exits 0 and changes nothing further.
set -euo pipefail

WORK_DIR="${AEGIS_L8_WORK_DIR:-}"
EVIDENCE_DIR="${AEGIS_L8_EVIDENCE_DIR:-}"

if [ -z "$WORK_DIR" ]; then
  printf 'L8_ROLLBACK=FAIL reason=AEGIS_L8_WORK_DIR required\n' >&2
  exit 1
fi

MARKER="$WORK_DIR/first-write.marker"

if [ -f "$MARKER" ]; then
  # A device write has already begun. Hold state, keep evidence, escalate.
  printf 'L8_FIRST_HARDWARE_WRITE=STARTED\n'
  printf 'HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE\n'
  printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
  printf 'L8_DEVICE_ACTION_TAKEN=NONE\n'
  printf 'L8_RECOVERY_POLICY=D4_ONLY\n'
  if [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
    printf 'L8_EVIDENCE_PRESERVED=YES\n'
  else
    printf 'L8_EVIDENCE_PRESERVED=NO_EVIDENCE_DIRECTORY\n'
  fi
  printf 'L8_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE\n'
  exit 0
fi

# No device write happened. Remove only this stage's own local artifacts.
if [ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ]; then
  for artifact in nvs.csv nvs.bin first-write.marker; do
    rm -f "${WORK_DIR:?}/$artifact"
  done
  if [ -d "$WORK_DIR/fixture-flash" ]; then
    rm -rf "${WORK_DIR:?}/fixture-flash"
  fi
fi

printf 'L8_FIRST_HARDWARE_WRITE=NOT_STARTED\n'
printf 'HARDWARE_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L8_DEVICE_ACTION_TAKEN=NONE\n'
printf 'L8_ROLLBACK=COMPLETE\n'
exit 0
