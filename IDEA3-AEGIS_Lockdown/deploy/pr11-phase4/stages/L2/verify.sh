#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L2 verification.
# Read-only against the selected root.
set -uo pipefail

fail() {
  printf 'L2_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

UNIT="aegis-idea3-nftables-load.service"
NFT_DEST="/etc/aegis-idea3/aegis-idea3.nft"
SYSCTL_DEST="/etc/sysctl.d/90-aegis-idea3-forwarding.conf"
UNIT_DEST="/etc/systemd/system/aegis-idea3-nftables-load.service"

ROOT="${AEGIS_P4_FS_ROOT:-}"
RENDER="${AEGIS_L2_RENDER_DIR:-}"
WORK="${AEGIS_L2_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

[ -n "$RENDER" ] && [ -d "$RENDER" ] \
  || fail RENDER_DIR_INVALID
[ -n "$WORK" ] && [ -d "$WORK" ] \
  || fail WORK_DIR_MISSING
[ -n "$AP_IF" ] \
  || fail AEGIS_AP_INTERFACE_REQUIRED

nft_dest="$(host_path "$NFT_DEST")"
sysctl_dest="$(host_path "$SYSCTL_DEST")"
unit_dest="$(host_path "$UNIT_DEST")"

[ -f "$nft_dest" ] || fail NFT_CONFIG_MISSING
[ -f "$sysctl_dest" ] || fail SYSCTL_CONFIG_MISSING
[ -f "$unit_dest" ] || fail UNIT_MISSING

cmp -s "$RENDER/aegis-idea3-nftables.conf" "$nft_dest" \
  || fail NFT_CONFIG_CHANGED

cmp -s "$RENDER/aegis-idea3-sysctl.conf" "$sysctl_dest" \
  || fail SYSCTL_CONFIG_CHANGED

cmp -s "$RENDER/aegis-idea3-nftables-load.service" "$unit_dest" \
  || fail UNIT_CHANGED

grep -Eq '^[[:space:]]*table[[:space:]]+inet[[:space:]]+aegis_idea3' \
  "$nft_dest" || fail IDEA3_TABLE_CONFIG_INVALID

if [ -z "$ROOT" ]; then
  systemctl is-active --quiet "$UNIT" \
    || fail FIREWALL_UNIT_NOT_ACTIVE

  systemctl is-enabled --quiet "$UNIT" \
    || fail FIREWALL_UNIT_NOT_ENABLED

  nft list table inet aegis_idea3 >/dev/null 2>&1 \
    || fail IDEA3_TABLE_NOT_LOADED

  for key in \
    net.ipv4.ip_forward \
    net.ipv4.conf.all.forwarding \
    net.ipv4.conf.default.forwarding \
    "net.ipv4.conf.$AP_IF.forwarding" \
    net.ipv6.conf.all.forwarding \
    net.ipv6.conf.default.forwarding \
    "net.ipv6.conf.$AP_IF.forwarding"
  do
    value="$(sysctl -n "$key" 2>/dev/null)" \
      || fail "SYSCTL_READ_FAILED:${key}"

    [ "$value" = 0 ] \
      || fail "FORWARDING_NOT_ZERO:${key}"
  done
fi

printf 'L2_VERIFY=PASS\n'
printf 'FORWARDING=DISABLED\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
