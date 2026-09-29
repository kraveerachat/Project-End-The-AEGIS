#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L4 rollback handler.
# Restores exact L3 PASS state (AP radio only; no addressing, no DHCP/DNS).
# Removes only artifacts owned by L4. Idempotent.
set -uo pipefail

fail() {
  printf "L4_ROLLBACK=FAIL reason=%s\n" "$1" >&2
  exit 1
}

PROFILE_DEST="/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"
DNSMASQ_CONF_DEST="/etc/aegis-idea3/dnsmasq-ap.conf"
DNSMASQ_UNIT_DEST="/etc/systemd/system/aegis-idea3-dnsmasq.service"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L4_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
CONN_ID="${AEGIS_L4_CONNECTION_ID:-aegis-idea3-ap}"
LIVE_AUTH="${AEGIS_L4_LIVE_AUTHORIZED:-NO}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING

if [ -z "$ROOT" ]; then
  [ "$LIVE_AUTH" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  # Stop and disable dedicated dnsmasq service
  if systemctl is-active aegis-idea3-dnsmasq.service >/dev/null 2>&1; then
    systemctl stop aegis-idea3-dnsmasq.service 2>/dev/null || true
  fi
  if systemctl is-enabled aegis-idea3-dnsmasq.service >/dev/null 2>&1; then
    systemctl disable aegis-idea3-dnsmasq.service 2>/dev/null || true
  fi
fi

# Remove dedicated dnsmasq artifacts
dnsmasq_conf="$(host_path "$DNSMASQ_CONF_DEST")"
rm -f -- "$dnsmasq_conf"

dnsmasq_unit="$(host_path "$DNSMASQ_UNIT_DEST")"
rm -f -- "$dnsmasq_unit"

# Restore NetworkManager profile to exact L3 radio-only state
target_profile="$(host_path "$PROFILE_DEST")"
if [ -f "$WORK/profile.l3.orig" ]; then
  cp -p "$WORK/profile.l3.orig" "$target_profile"
  chmod 600 "$target_profile"
elif [ -f "$target_profile" ]; then
  python3 -c '
import re, sys
profile_path = sys.argv[1]
with open(profile_path, "r", encoding="utf-8") as f:
    text = f.read()

# Replace manual IPv4 with disabled
text = re.sub(
    r"\[ipv4\]\nmethod=manual(?:\naddress1=[^\n]+)?(?:\nnever-default=true)?",
    "[ipv4]\nmethod=disabled",
    text,
)
with open(profile_path, "w", encoding="utf-8") as f:
    f.write(text)
' "$target_profile"
  chmod 600 "$target_profile"
fi

if [ -z "$ROOT" ]; then
  systemctl daemon-reload 2>/dev/null || true
  nmcli connection reload 2>/dev/null || true
  nmcli connection up "$CONN_ID" ifname "$AP_IF" 2>/dev/null || true

  # Ensure IP address is removed
  if [ -n "$AP_IF" ]; then
    if ip -4 addr show dev "$AP_IF" 2>/dev/null | grep -q "inet "; then
      fail AP_IF_STILL_HAS_IPV4_ADDRESS
    fi
  fi
fi

printf "L4_ROLLBACK=PASS\n"
printf "L4_ARTIFACT_RESIDUE=NO\n"
