#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L2 rollback.
# Removes only artifacts owned by L2. Designed to be idempotent.
set -uo pipefail

fail() {
  printf 'L2_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

UNIT="aegis-idea3-nftables-load.service"
NFT_DEST="/etc/aegis-idea3/aegis-idea3.nft"
SYSCTL_DEST="/etc/sysctl.d/90-aegis-idea3-forwarding.conf"
UNIT_DEST="/etc/systemd/system/aegis-idea3-nftables-load.service"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L2_WORK_DIR:-}"

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
  [ "${AEGIS_L2_LIVE_AUTHORIZED:-NO}" = YES ] \
    || fail LIVE_AUTHORIZATION_FLAG_REQUIRED

  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    systemctl stop "$UNIT" \
      || fail UNIT_STOP_FAILED
  fi

  if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
    systemctl disable "$UNIT" \
      || fail UNIT_DISABLE_FAILED
  fi

  if nft list table inet aegis_idea3 >/dev/null 2>&1; then
    nft delete table inet aegis_idea3 \
      || fail IDEA3_TABLE_DELETE_FAILED
  fi
fi

nft_dest="$(host_path "$NFT_DEST")"
sysctl_dest="$(host_path "$SYSCTL_DEST")"
unit_dest="$(host_path "$UNIT_DEST")"

rm -f -- "$nft_dest" "$sysctl_dest" "$unit_dest" \
  || fail OWNED_FILE_REMOVE_FAILED

if [ -z "$ROOT" ]; then
  systemctl daemon-reload \
    || fail DAEMON_RELOAD_FAILED

  nft list table inet aegis_idea3 >/dev/null 2>&1 \
    && fail IDEA3_TABLE_RESIDUE
fi

printf 'L2_ROLLBACK=PASS\n'
printf 'L2_ARTIFACT_RESIDUE=NO\n'
