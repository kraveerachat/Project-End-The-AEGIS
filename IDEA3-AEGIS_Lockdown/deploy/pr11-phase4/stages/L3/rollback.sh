#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3 rollback handler.
# Removes only artifacts owned by L3. Designed to be idempotent.
set -uo pipefail

fail() {
  printf 'L3_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

PROFILE_DEST="/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L3_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-}"
CONN_ID="${AEGIS_L3_CONNECTION_ID:-aegis-idea3-ap}"
LIVE_AUTH="${AEGIS_L3_LIVE_AUTHORIZED:-NO}"

P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] \
  || fail WORK_DIR_MISSING

if [ -z "$ROOT" ]; then
  [ "$LIVE_AUTH" = YES ] \
    || fail LIVE_AUTHORIZATION_FLAG_REQUIRED

  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  # Down connection if active
  if nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$CONN_ID"; then
    nmcli connection down "$CONN_ID" 2>/dev/null || true
  fi

  # Delete connection from NetworkManager runtime
  if nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$CONN_ID"; then
    nmcli connection delete "$CONN_ID" 2>/dev/null || true
  fi

  # Restore RFKILL soft-block if it was blocked before L3 apply (exact recorded id only)
  # shellcheck source=../../p4-l3-rfkill.sh
  . "$P4_HERE/p4-l3-rfkill.sh"
  l3_rfkill_restore "$WORK" || fail "$L3_RFKILL_REASON"

  nmcli connection reload 2>/dev/null || true

  if [ -n "$AP_IF" ]; then
    if iw dev "$AP_IF" info 2>/dev/null | grep -q "type AP"; then
      fail AP_MODE_STILL_ACTIVE
    fi
  fi
fi

target_profile="$(host_path "$PROFILE_DEST")"
rm -f -- "$target_profile" \
  || fail PROFILE_REMOVE_FAILED

printf 'L3_ROLLBACK=PASS\n'
printf 'L3_ARTIFACT_RESIDUE=NO\n'
