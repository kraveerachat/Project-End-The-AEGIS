#!/usr/bin/env bash
# shellcheck shell=bash
# Shared settings for the IDEA3 Core-local live lab scripts. Source it, do not run it.
# Every host-specific value comes from live-lab.env (see live-lab.env.example). No secret is read or printed here.

LL_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LL_APP_DIR="$(cd "$LL_SELF_DIR/../.." && pwd)"   # IDEA3-AEGIS_Lockdown

LL_DIR="${AEGIS_LIVE_DIR:-$HOME/aegis-live-lab}"
LL_ENV_FILE="${AEGIS_LIVE_ENV:-$LL_DIR/live-lab.env}"
if [[ -f $LL_ENV_FILE ]]; then
  # shellcheck disable=SC1090
  . "$LL_ENV_FILE"
fi

ll_die() { echo "ERROR: $*" >&2; exit 1; }

: "${AP_IFACE:?set AP_IFACE in $LL_ENV_FILE (the Wi-Fi interface that becomes the lab AP)}"
: "${INTERNET_IFACE:?set INTERNET_IFACE in $LL_ENV_FILE (the interface that keeps the default route, e.g. a USB tether)}"
[[ $AP_IFACE != "$INTERNET_IFACE" ]] || ll_die "AP_IFACE and INTERNET_IFACE must differ"

AP_SSID="${AP_SSID:-AEGIS-IDEA3-LAB}"
AP_CHANNEL="${AP_CHANNEL:-1}"
AP_ADDR="${AP_ADDR:-10.77.30.1}"
AP_PREFIXLEN="${AP_PREFIXLEN:-28}"
BROKER_HOSTNAME="${BROKER_HOSTNAME:-mqtt.aegis.home.arpa}"
DEVICE_ID="${DEVICE_ID:-aegis-relay-01}"
MQTT_CORE_USER="${MQTT_CORE_USER:-idea3-core}"
MQTT_DEV_USER="${MQTT_DEV_USER:-idea3-dev-$DEVICE_ID}"
NTP_UPSTREAM="${NTP_UPSTREAM:-pool.ntp.org}"
NM_PROFILE="${NM_PROFILE:-AEGIS-LIVE-AP}"
NFT_TABLE="${NFT_TABLE:-aegis_live}"
UNIT_PREFIX="${UNIT_PREFIX:-aegis-live}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/aegis-live}"
CORE_USER="${CORE_USER:-$(id -un)}"
DNS_CHECK_HOST="${DNS_CHECK_HOST:-example.com}"
STOP_UNITS="${STOP_UNITS:-}"          # space separated units that would collide (ports 53/67/123/8883); stopped, never disabled
VENV="${AEGIS_VENV:-$LL_DIR/venv}"

LL_ETC="$LL_DIR/etc"
LL_SECRETS="$LL_DIR/secrets"
LL_DATA="$LL_DIR/data"
LL_LOGS="$LL_DIR/logs"
LL_EVID="$LL_DIR/evidence"

# Derived network values (python3 ipaddress; /28 is what main's AP isolation templates assume).
eval "$(python3 - "$AP_ADDR" "$AP_PREFIXLEN" <<'PY'
import ipaddress, sys
iface = ipaddress.ip_interface(f"{sys.argv[1]}/{sys.argv[2]}")
net = iface.network
hosts = list(net.hosts())
print(f"AP_SUBNET={net}")
print(f"AP_NETMASK={net.netmask}")
print(f"DHCP_START_DEFAULT={hosts[1]}")
print(f"DHCP_END_DEFAULT={hosts[-1]}")
PY
)"
DHCP_START="${DHCP_START:-$DHCP_START_DEFAULT}"
DHCP_END="${DHCP_END:-$DHCP_END_DEFAULT}"

# Files the operator provisions beforehand. Only their presence is checked; contents are never read by these scripts
# except by the services that need them.
LL_REQUIRED_SECRET_FILES=(ap.psk k_c2d k_d2c mqtt-core.pass mqtt-dev.pass admin.pin cut.credential restore.credential
                          pki/ca.crt pki/server.crt pki/server.key)

ll_unit() { echo "${UNIT_PREFIX}-$1"; }
ll_python() { echo "$VENV/bin/python"; }
