#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 rollback handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-08)
#   2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md (D3)
#
# Removes ONLY the stage-owned package delta (chrony). Preserves pre-existing
# packages (dnsmasq, nftables, etc.). Idempotent: repeated execution exits 0
# and changes nothing further. Live-mode rollback additionally requires
# explicit live-authorization environment variables and never uses recursive
# or cascade removal (D3).
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
BACKEND="${AEGIS_L1_BACKEND:-fixture}"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"

LIVE_AUTH_TOKEN_REQUIRED="AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"

case "$BACKEND" in
  fixture)
    ;;
  live)
    if [ "${AEGIS_L1_LIVE_AUTHORIZATION_TOKEN:-}" != "$LIVE_AUTH_TOKEN_REQUIRED" ] \
      || [ "${AEGIS_L1_LIVE_K3_CONFIRMED:-}" != "YES" ]; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    ;;
  *)
    fail "unknown backend: $BACKEND"
    ;;
esac

# Delegate stage rollback to helper (OD-L1-08, D3)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" rollback \
  --backend "$BACKEND" \
  ${WORK_DIR:+--work-dir "$WORK_DIR"} \
  --fs-root "$FS_ROOT"; then
  fail "package rollback failed"
fi

printf 'L1_SERVICES_LEFT_ACTIVE=NONE\n'
printf 'L1_SERVICES_LEFT_ENABLED=NONE\n'
printf 'L1_ROLLBACK=COMPLETE\n'
exit 0
