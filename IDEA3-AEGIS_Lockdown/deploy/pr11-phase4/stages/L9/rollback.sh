#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L9 rollback handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l9-operational-design.md (OD-L9-08)
#
# Removes only the stage-local fixture store files. Takes no Core action, no
# device action, and emits no command.
#
# Live rollback (OD-L9-08, Prerequisites §L9) is an owner-run stop of the Core
# service; the device fails secure through its dead-man switch (S-11 fail-secure hold).
# It never sends a restore command, never reopens plaintext MQTT, and never
# runs legacy v0.
#
# Idempotent: repeated execution exits 0 and changes nothing further.
set -euo pipefail

WORK_DIR="${AEGIS_L9_WORK_DIR:-}"
EVIDENCE_DIR="${AEGIS_L9_EVIDENCE_DIR:-}"

if [ -z "$WORK_DIR" ]; then
  printf 'L9_ROLLBACK=FAIL reason=AEGIS_L9_WORK_DIR required\n' >&2
  exit 1
fi

STORE_NAME="fixture-protocol.sqlite3"

if [ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ]; then
  rm -f "${WORK_DIR:?}/$STORE_NAME"*
fi

printf 'L9_CORE_ACTION_TAKEN=NONE\n'
printf 'L9_DEVICE_ACTION_TAKEN=NONE\n'
printf 'L9_COMMAND_SENT=NONE\n'
if [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
  printf 'L9_EVIDENCE_PRESERVED=YES\n'
else
  printf 'L9_EVIDENCE_PRESERVED=NO\n'
fi
printf 'L9_ROLLBACK=COMPLETE\n'
exit 0
