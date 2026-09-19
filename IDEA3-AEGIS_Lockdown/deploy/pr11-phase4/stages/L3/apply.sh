#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3 AP-radio apply handler.
# AP radio only: NO addressing, NO services, NO clients.
# MUTATING only when AEGIS_P4_FS_ROOT is unset and explicit live authorization
# is present. Fixture mode writes only below AEGIS_P4_FS_ROOT.
set -uo pipefail

fail() {
  printf 'L3_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

PROFILE_DEST="/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L3_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-}"
CONN_ID="${AEGIS_L3_CONNECTION_ID:-aegis-idea3-ap}"
AP_SSID="${AEGIS_AP_SSID:-AEGIS_LOCKDOWN}"
AP_CHANNEL="${AEGIS_AP_CHANNEL:-6}"
AP_COUNTRY="${AEGIS_AP_COUNTRY:-TH}"
PSK_FILE="${AEGIS_AP_PSK_FILE:-}"
RFKILL_ID_ENV="${AEGIS_L3_RFKILL_ID:-}"
LIVE_AUTH="${AEGIS_L3_LIVE_AUTHORIZED:-NO}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

[ -n "$WORK" ] || fail AEGIS_L3_WORK_DIR_REQUIRED
[ -n "$AP_IF" ] || fail AEGIS_AP_INTERFACE_REQUIRED
[[ "$AP_IF" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail AEGIS_AP_INTERFACE_INVALID

[[ "$AP_CHANNEL" =~ ^[0-9]+$ ]] && [ "$AP_CHANNEL" -ge 1 ] && [ "$AP_CHANNEL" -le 13 ] \
  || fail AP_CHANNEL_INVALID

[ -n "$AP_SSID" ] && [ "${#AP_SSID}" -le 32 ] \
  || fail AP_SSID_INVALID

# Secret handling: PSK is NEVER passed via CLI arguments or logged.
AP_PSK=""
if [ -n "$PSK_FILE" ]; then
  [ -f "$PSK_FILE" ] && [ ! -L "$PSK_FILE" ] \
    || fail PSK_FILE_INVALID

  mode=$(stat -c %a "$PSK_FILE" 2>/dev/null)
  [ "$mode" = "600" ] || [ "$mode" = "400" ] \
    || fail PSK_FILE_PERMISSIONS_INSECURE

  AP_PSK=$(head -n 1 "$PSK_FILE" | tr -d '\r\n')
  [ "${#AP_PSK}" -ge 8 ] && [ "${#AP_PSK}" -le 63 ] \
    || fail PSK_LENGTH_INVALID
else
  if [ -z "$ROOT" ]; then
    fail AEGIS_AP_PSK_FILE_REQUIRED
  else
    AP_PSK="fixture-secret-psk-material-test"
  fi
fi

[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

umask 077
mkdir -p "$WORK"
chmod 700 "$WORK"

target_profile="$(host_path "$PROFILE_DEST")"

if [ -z "$ROOT" ]; then
  [ "$LIVE_AUTH" = YES ] \
    || fail LIVE_AUTHORIZATION_FLAG_REQUIRED

  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED

  [ "$AP_IF" = "wlp0s20f3" ] \
    || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3

  [ -d "/etc/NetworkManager/system-connections" ] && [ ! -L "/etc/NetworkManager/system-connections" ] \
    || fail NM_PARENT_DIR_REQUIRED

  [ ! -e "$PROFILE_DEST" ] \
    || fail DESTINATION_ALREADY_EXISTS

  iw reg get 2>/dev/null | grep -Eq "country (TH|$AP_COUNTRY):" \
    || fail REGULATORY_DOMAIN_MISMATCH

  # Management path fail-closed checks
  [ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] \
    || fail AP_IF_HAS_DEFAULT_ROUTE

  [ -n "$(ip route show default 2>/dev/null | grep -v "dev $AP_IF")" ] \
    || fail NO_ALTERNATE_DEFAULT_ROUTE

  [ -z "$(ip -4 addr show dev "$AP_IF" 2>/dev/null | grep 'inet ')" ] \
    || fail AP_IF_HAS_IPV4_ADDRESS

  [ -z "$(ip -6 addr show dev "$AP_IF" scope global 2>/dev/null | grep 'inet6 ')" ] \
    || fail AP_IF_HAS_IPV6_ADDRESS

  nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep -q "^${AP_IF}:connected" \
    && fail AP_IF_ALREADY_CONNECTED

  # Target rfkill isolation: resolve specific radio ID, fail closed on hard block
  rfkill_id=""
  if [ -n "$RFKILL_ID_ENV" ]; then
    rfkill_id="$RFKILL_ID_ENV"
  elif [ -d "/sys/class/net/$AP_IF/phy80211" ]; then
    for idx in /sys/class/net/"$AP_IF"/phy80211/rfkill*/index; do
      if [ -f "$idx" ]; then
        rfkill_id=$(cat "$idx" 2>/dev/null)
        break
      fi
    done
  fi
  if [ -z "$rfkill_id" ]; then
    rfkill_id=$(rfkill --noheadings --output ID,TYPE,DEVICE 2>/dev/null | awk -v dev="$AP_IF" '$3 == dev && $2 == "wlan" {print $1; exit}')
  fi
  if [ -z "$rfkill_id" ]; then
    rfkill_id=$(rfkill --noheadings --output ID,TYPE 2>/dev/null | awk '$2 == "wlan" {print $1; exit}')
  fi
  [ -n "$rfkill_id" ] || fail RFKILL_ID_NOT_FOUND
  printf '%s\n' "$rfkill_id" > "$WORK/rfkill_id"

  hard_state=$(rfkill --noheadings --output HARD "$rfkill_id" 2>/dev/null | tr -d ' ')
  [ "$hard_state" != "blocked" ] && [ "$hard_state" != "1" ] \
    || fail RFKILL_HARD_BLOCKED

  soft_state=$(rfkill --noheadings --output SOFT "$rfkill_id" 2>/dev/null | tr -d ' ')
  if [ "$soft_state" = "blocked" ] || [ "$soft_state" = "1" ]; then
    printf '1\n' > "$WORK/rfkill_pre_state"
    rfkill unblock "$rfkill_id" || fail RFKILL_UNBLOCK_FAILED
  else
    printf '0\n' > "$WORK/rfkill_pre_state"
  fi
fi

# UUID generation
UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || printf '%s' "$RANDOM$RANDOM$RANDOM")

cat <<EOF > "$WORK/profile.tmp"
[connection]
id=$CONN_ID
uuid=$UUID
type=wifi
interface-name=$AP_IF
autoconnect=false

[wifi]
mode=ap
band=bg
channel=$AP_CHANNEL
ssid=$AP_SSID

[wifi-security]
key-mgmt=wpa-psk
psk=$AP_PSK

[ipv4]
method=disabled

[ipv6]
method=disabled
EOF

# Strict safety verification of generated profile before installation
grep -Fqx "mode=ap" "$WORK/profile.tmp" || fail PROFILE_MODE_NOT_AP
grep -Fqx "band=bg" "$WORK/profile.tmp" || fail PROFILE_BAND_NOT_BG
grep -Fqx "method=disabled" "$WORK/profile.tmp" || fail PROFILE_METHOD_NOT_DISABLED
! grep -Eq 'shared|address[0-9]|gateway|dns|bridge|masq' "$WORK/profile.tmp" \
  || fail PROFILE_CONTAINS_FORBIDDEN_SETTINGS

mkdir -p "$(dirname "$target_profile")"
install -D -m 0600 "$WORK/profile.tmp" "$target_profile" \
  || fail PROFILE_INSTALL_FAILED
rm -f "$WORK/profile.tmp"

printf '%s\n' "$CONN_ID" > "$WORK/conn_id"
printf '%s\n' "$UUID" > "$WORK/uuid"

if [ -z "$ROOT" ]; then
  nmcli connection reload || fail NMCLI_RELOAD_FAILED
  nmcli connection up "$CONN_ID" || fail NMCLI_UP_FAILED

  iw dev "$AP_IF" info 2>/dev/null | grep -q "type AP" \
    || fail AP_MODE_NOT_ACTIVE

  [ -z "$(ip -4 addr show dev "$AP_IF" 2>/dev/null | grep 'inet ')" ] \
    || fail AP_IF_ACQUIRED_IP

  [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ] \
    || fail FORWARDING_NOT_ZERO
else
  printf 'FIXTURE_ONLY\n' > "$WORK/mode"
fi

printf 'L3_APPLY=PASS\n'
printf 'AP_INTERFACE=%s\n' "$AP_IF"
printf 'AP_MODE=RADIO_ONLY_NO_ADDRESSING\n'
printf 'FORWARDING_TARGET=DISABLED\n'

if [ -z "$ROOT" ]; then
  printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
else
  printf 'PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY\n'
fi
