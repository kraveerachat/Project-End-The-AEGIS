#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 rollback handler.
#
# Authority: docs/superpowers/specs/
#   2026-09-21-idea3-pr11-phase4-l1-operational-design.md (OD-L1-08)
#   2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md (D3)
#
# Removes ONLY the stage-owned package delta (chrony). Preserves pre-existing
# packages (dnsmasq, nftables, etc.). Idempotent: repeated execution exits 0
# and changes nothing further. Live-mode rollback re-invokes the CANONICAL
# p4-stage-gate.sh with real record files and never uses recursive or
# cascade removal (D3). AEGIS_P4_FS_ROOT is a TEST-ONLY fixture prefix
# (p4-lib.sh); live mode never touches it and fails closed if it is set.
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

WORK_DIR="${AEGIS_L1_WORK_DIR:-}"
BACKEND="${AEGIS_L1_BACKEND:-fixture}"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
FS_ROOT=""

case "$BACKEND" in
  fixture)
    require_env AEGIS_P4_FS_ROOT
    FS_ROOT="$AEGIS_P4_FS_ROOT"
    ;;
  live)
    if [ -n "${AEGIS_P4_FS_ROOT:-}" ]; then
      fail "LIVE_MODE_FS_ROOT_REFUSED (AEGIS_P4_FS_ROOT is TEST-ONLY and must be unset in live mode)"
    fi
    AUTH_FILE="${AEGIS_L1_LIVE_AUTHORIZATION_FILE:-}"
    K3_FILE="${AEGIS_L1_LIVE_K3_FILE:-}"
    if [ -z "$AUTH_FILE" ] || [ -z "$K3_FILE" ] || [ ! -f "$AUTH_FILE" ] || [ ! -f "$K3_FILE" ]; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    set +e
    GATE_OUT=$(bash "$P4_HERE/p4-stage-gate.sh" --stage L1 --mode live \
      --authorization "$AUTH_FILE" --k3 "$K3_FILE" 2>&1)
    GATE_RC=$?
    set -e
    if [ "$GATE_RC" -ne 0 ] \
      || ! printf '%s\n' "$GATE_OUT" | grep -q '^AUTHORIZATION_RECORD=VALID$' \
      || ! printf '%s\n' "$GATE_OUT" | grep -q '^K3_CONFIRMATION=VALID$'; then
      fail "LIVE_AUTHORIZATION_MISSING (LIVE_L1=NOT_AUTHORIZED)"
    fi
    ;;
  *)
    fail "unknown backend: $BACKEND"
    ;;
esac

# Delegate stage rollback to helper (OD-L1-08, D3). Live mode passes no
# --fs-root: it never touches the TEST-ONLY fixture prefix.
if [ "$BACKEND" = "fixture" ]; then
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" rollback \
    --backend "$BACKEND" \
    ${WORK_DIR:+--work-dir "$WORK_DIR"} \
    --fs-root "$FS_ROOT"; then
    fail "package rollback failed"
  fi
else
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" rollback \
    --backend "$BACKEND" \
    ${WORK_DIR:+--work-dir "$WORK_DIR"}; then
    fail "package rollback failed"
  fi
fi

printf 'L1_SERVICES_LEFT_ACTIVE=NONE\n'
printf 'L1_SERVICES_LEFT_ENABLED=NONE\n'
printf 'L1_ROLLBACK=COMPLETE\n'
exit 0
