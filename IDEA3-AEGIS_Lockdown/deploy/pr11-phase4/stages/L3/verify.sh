#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3 verification.
# Read-only verification against the selected root.
set -uo pipefail

fail() {
  printf 'L3_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

PROFILE_DEST="/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L3_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] \
  || fail WORK_DIR_MISSING

[ -n "$AP_IF" ] \
  || fail AEGIS_AP_INTERFACE_REQUIRED

target_profile="$(host_path "$PROFILE_DEST")"

[ -f "$target_profile" ] \
  || fail PROFILE_CONFIG_MISSING

mode=$(stat -c %a "$target_profile" 2>/dev/null)
[ "$mode" = "600" ] \
  || fail PROFILE_PERMISSIONS_INSECURE

# Profile content verification
grep -Fqx "mode=ap" "$target_profile" \
  || fail PROFILE_MODE_NOT_AP

grep -Fqx "band=bg" "$target_profile" \
  || fail PROFILE_BAND_NOT_BG

grep -Fqx "method=disabled" "$target_profile" \
  || fail PROFILE_METHOD_NOT_DISABLED

! grep -Eq 'shared|address[0-9]|gateway|dns|bridge|masq' "$target_profile" \
  || fail PROFILE_CONTAINS_FORBIDDEN_SETTINGS

if [ -z "$ROOT" ]; then
  iw dev "$AP_IF" info 2>/dev/null | grep -q "type AP" \
    || fail AP_MODE_NOT_ACTIVE

  [ -z "$(ip -4 addr show dev "$AP_IF" 2>/dev/null | grep 'inet ')" ] \
    || fail AP_IF_HAS_IPV4_ADDRESS

  [ -z "$(ip -6 addr show dev "$AP_IF" scope global 2>/dev/null | grep 'inet6 ')" ] \
    || fail AP_IF_HAS_IPV6_ADDRESS

  [ -z "$(ip route show dev "$AP_IF" 2>/dev/null)" ] \
    || fail ROUTE_VIA_AP_IF_EXISTS

  [ -n "$(ip route show default 2>/dev/null | grep -v "dev $AP_IF")" ] \
    || fail NO_ALTERNATE_DEFAULT_ROUTE

  [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ] \
    || fail FORWARDING_NOT_ZERO

  [ "$(sysctl -n net.ipv4.conf.all.forwarding 2>/dev/null)" = "0" ] \
    || fail FORWARDING_NOT_ZERO

  [ "$(sysctl -n net.ipv4.conf."$AP_IF".forwarding 2>/dev/null)" = "0" ] \
    || fail FORWARDING_NOT_ZERO
fi

printf 'L3_VERIFY=PASS\n'
printf 'AP_MODE=RADIO_ONLY_NO_ADDRESSING\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
