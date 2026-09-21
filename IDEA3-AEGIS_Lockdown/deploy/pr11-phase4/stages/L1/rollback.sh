#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 rollback handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-08)
#
# Removes ONLY the stage-owned package delta (chrony files).
# Preserves pre-existing packages (dnsmasq, nftables, etc.).
# Idempotent: repeated execution exits 0 and changes nothing further.
set -euo pipefail

fail() {
  printf 'L1_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  local name=$1
  local value=${!name:-}
  [ -n "$value" ] || fail "$name required"
}

require_env AEGIS_P4_FS_ROOT

WORK_DIR="${AEGIS_L1_WORK_DIR:-}"
FS_ROOT="$AEGIS_P4_FS_ROOT"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"

# Delegate stage rollback to helper (OD-L1-08)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" rollback \
  ${WORK_DIR:+--work-dir "$WORK_DIR"} \
  --fs-root "$FS_ROOT"; then
  fail "package rollback failed"
fi

printf 'L1_SERVICES_LEFT_ACTIVE=NONE\n'
printf 'L1_SERVICES_LEFT_ENABLED=NONE\n'
printf 'L1_ROLLBACK=COMPLETE\n'
exit 0
