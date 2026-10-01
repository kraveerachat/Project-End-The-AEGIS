#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8p rollback handler.
#
# Behaviour splits at the first device write (the first-write marker):
#
#   before the marker  -> remove only this stage's local artifacts; the Core host stays at zero drift.
#   at or after it     -> perform NO device action at all and hold fail-secure. Physical recovery is a MANUAL, out-of-band owner action
#                         (OD-L8P-01), never part of this automated rollback.
#
# Forbidden here without exception and deliberately not implemented: any device tool, reflash, rollback write, erase, any uplink restore, and any
# fallback transport. This script starts no process other than coreutils and never reads the device.
#
# Idempotent: repeated execution exits 0 and changes nothing further.
set -euo pipefail

WORK_DIR="${AEGIS_L8P_WORK_DIR:-}"
EVIDENCE_DIR="${AEGIS_L8P_EVIDENCE_DIR:-}"

if [ -z "$WORK_DIR" ]; then
  printf 'L8P_ROLLBACK=FAIL reason=AEGIS_L8P_WORK_DIR required\n' >&2
  exit 1
fi

MARKER="$WORK_DIR/first-write.marker"

if [ -f "$MARKER" ]; then
  printf 'L8P_FIRST_HARDWARE_WRITE=STARTED\n'
  printf 'HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE\n'
  printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
  printf 'L8P_DEVICE_ACTION_TAKEN=NONE\n'
  if [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
    printf 'L8P_EVIDENCE_PRESERVED=YES\n'
  else
    printf 'L8P_EVIDENCE_PRESERVED=NO_EVIDENCE_DIRECTORY\n'
  fi
  printf 'L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE\n'
  exit 0
fi

if [ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ]; then
  for artifact in nvs.csv nvs.bin; do
    rm -f "${WORK_DIR:?}/$artifact"
  done
  if [ -d "$WORK_DIR/fixture-flash" ]; then
    rm -rf "${WORK_DIR:?}/fixture-flash"
  fi
fi

printf 'L8P_FIRST_HARDWARE_WRITE=NOT_STARTED\n'
printf 'HARDWARE_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L8P_DEVICE_ACTION_TAKEN=NONE\n'
printf 'L8P_ROLLBACK=COMPLETE\n'
exit 0
