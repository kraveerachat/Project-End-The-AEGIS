#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L9 authentication without actuation
# apply handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l9-operational-design.md (OD-L9-01..OD-L9-09)
#
# Fails closed on any constraint violation. The only implemented device
# backend is the fixture backend; the live backend is refused because no live
# probe mechanism exists in this repository. LIVE_L9=NOT_AUTHORIZED.
set -euo pipefail

fail() {
  printf 'L9_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  local name=$1
  local value=${!name:-}
  [ -n "$value" ] || fail "$name required"
}

# 1. Mandatory environment (OD-L9-01, design §2)
for var in \
  AEGIS_L9_INPUT_DIR \
  AEGIS_L9_WORK_DIR \
  AEGIS_L9_EVIDENCE_DIR \
  AEGIS_L9_DEVICE_ID \
  AEGIS_L9_RUN_ID \
  AEGIS_L9_FIXTURE_NOW; do
  require_env "$var"
done

INPUT_DIR="$AEGIS_L9_INPUT_DIR"
WORK_DIR="$AEGIS_L9_WORK_DIR"
EVIDENCE_DIR="$AEGIS_L9_EVIDENCE_DIR"
BACKEND="${AEGIS_L9_BACKEND:-fixture}"
RUN_ID="$AEGIS_L9_RUN_ID"
DEVICE_ID="$AEGIS_L9_DEVICE_ID"
FIXTURE_NOW="$AEGIS_L9_FIXTURE_NOW"

# 2. Backend and live-authorization gate (OD-L9-01)
case "$BACKEND" in
  fixture)
    ;;
  live)
    fail "LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY (LIVE_L9=NOT_AUTHORIZED)"
    ;;
  *)
    fail "unknown backend: $BACKEND"
    ;;
esac

# 3. Directory constraints and host path refusals
[ -d "$INPUT_DIR" ] || fail "AEGIS_L9_INPUT_DIR must exist and be a directory"
[ ! -L "$INPUT_DIR" ] || fail "AEGIS_L9_INPUT_DIR must not be a symlink"
[ ! -L "$WORK_DIR" ] || fail "AEGIS_L9_WORK_DIR must not be a symlink"
[ ! -L "$EVIDENCE_DIR" ] || fail "AEGIS_L9_EVIDENCE_DIR must not be a symlink"

case "$WORK_DIR" in
  /etc/* | /opt/* | /var/* | /run/* | /dev/*) fail "AEGIS_L9_WORK_DIR must not be a host system path" ;;
esac
case "$EVIDENCE_DIR" in
  /etc/* | /opt/* | /var/* | /run/* | /dev/*) fail "AEGIS_L9_EVIDENCE_DIR must not be a host system path" ;;
esac

# 4. Key file inventory and permission checks
for req in k_c2d k_d2c; do
  [ -e "$INPUT_DIR/$req" ] || fail "INPUT_DIR missing required file: $req"
  [ ! -L "$INPUT_DIR/$req" ] || fail "INPUT_DIR file must not be a symlink: $req"
  [ -f "$INPUT_DIR/$req" ] || fail "INPUT_DIR entry must be a regular file: $req"
  mode=$(stat -c %a "$INPUT_DIR/$req")
  if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
    fail "INPUT_DIR file $req has invalid mode: $mode (owner-only 0600 or 0400 required)"
  fi
done

# 5. Device ID and fixture time syntax gates
if [[ ! "$DEVICE_ID" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ ]]; then
  fail "invalid device id: $DEVICE_ID"
fi

if [[ ! "$FIXTURE_NOW" =~ ^[0-9]+$ ]] || [ "$FIXTURE_NOW" -lt 1700000000 ]; then
  fail "invalid fixture now (must be integer >= 1700000000)"
fi

# 6. Preexisting fixture store refusal
STORE_NAME="fixture-protocol.sqlite3"
if [ -f "$WORK_DIR/$STORE_NAME" ]; then
  fail "fixture store already exists: $WORK_DIR/$STORE_NAME"
fi

# 7. Stage directories
mkdir -p "$WORK_DIR" "$EVIDENCE_DIR"
chmod 0700 "$WORK_DIR" "$EVIDENCE_DIR"

# 8. Delegate authentication exercise to the reviewed helper
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

if ! "$PYTHON_BIN" "$P4_HERE/p4-l9-auth.py" exercise \
  --input-dir "$INPUT_DIR" \
  --work-dir "$WORK_DIR" \
  --evidence-dir "$EVIDENCE_DIR" \
  --backend "$BACKEND" \
  --device-id "$DEVICE_ID" \
  --run-id "$RUN_ID" \
  --fixture-now "$FIXTURE_NOW"; then
  fail "authentication exercise failed"
fi

# 9. Output markers
printf 'L9_COMMAND_SENT=NONE\n'
printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'LIVE_L9=NOT_AUTHORIZED\n'
printf 'L9_APPLY=COMPLETE\n'
exit 0
