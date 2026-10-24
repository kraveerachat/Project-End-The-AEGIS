#!/usr/bin/env bash
# Bring the IDEA3 Core-local live lab up: AP, dnsmasq, chrony, mosquitto (TLS) and the Core as TRANSIENT systemd units.
# Run as the operator (not root); sudo is used for the few privileged steps. Nothing is installed or enabled permanently.
# Undo everything with aegis-live-down.sh. Prints no secrets.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-live-lab.sh
. "$HERE/lib-live-lab.sh"

RENDER_ONLY=0
[[ ${1:-} != --render-only ]] || RENDER_ONLY=1   # render the configuration into <live-lab dir>/etc and stop; touches nothing else
[[ $EUID -ne 0 ]] || ll_die "run as the operator, not root (the Core runs as $CORE_USER)"
for tool in nmcli nft dnsmasq chronyd mosquitto mosquitto_passwd openssl systemd-run python3 ip ss; do
  command -v "$tool" >/dev/null || ll_die "missing tool: $tool"
done

step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }
FAILS=0
check() { # check "description" command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else printf '   FAIL %s\n' "$what"; FAILS=$((FAILS + 1)); fi
}

step "preflight"
if [[ $RENDER_ONLY -eq 0 ]]; then
  [[ -d /sys/class/net/$AP_IFACE ]] || ll_die "interface $AP_IFACE not found"
  [[ -d /sys/class/net/$INTERNET_IFACE ]] || ll_die "interface $INTERNET_IFACE not found"
  [[ -d $LL_APP_DIR/aegis_soc && -x $(ll_python) ]] || ll_die "need the app at $LL_APP_DIR and a venv at $VENV"
fi
missing=0
for f in "${LL_REQUIRED_SECRET_FILES[@]}"; do
  [[ -s $LL_SECRETS/$f ]] || { echo "   missing secret file: secrets/$f"; missing=1; }
done
[[ $missing -eq 0 ]] || ll_die "provision the files above first (see doc/Content/17_LIVE_LAB_RUNBOOK.md); their contents are never printed"
mkdir -p "$LL_ETC/mosq" "$LL_DATA/data" "$LL_LOGS" "$LL_EVID"
chmod 700 "$LL_ETC" "$LL_ETC/mosq" "$LL_SECRETS"
[[ $RENDER_ONLY -eq 1 ]] || sudo -v

step "route and DNS safety baseline"
ROUTE_BEFORE="$(ip -4 route show default)"
if [[ $RENDER_ONLY -eq 1 ]]; then ROUTE_BEFORE="render-only"; else
[[ $ROUTE_BEFORE == *"dev $INTERNET_IFACE"* ]] || ll_die "default route is not on $INTERNET_IFACE: $ROUTE_BEFORE"
[[ $ROUTE_BEFORE != *"dev $AP_IFACE"* ]] || ll_die "default route uses the AP interface"
getent hosts "$DNS_CHECK_HOST" >/dev/null || ll_die "DNS does not resolve $DNS_CHECK_HOST before bring-up"
printf '%s\n' "$ROUTE_BEFORE" > "$LL_EVID/live-up-route-before.txt"
ok "default route on $INTERNET_IFACE, DNS resolves $DNS_CHECK_HOST"
fi

step "render configuration from main's deploy/ templates (mode 0600)"
export LL_AP_IFACE=$AP_IFACE LL_AP_CHANNEL=$AP_CHANNEL LL_AP_SSID=$AP_SSID LL_AP_ADDR=$AP_ADDR LL_AP_PREFIXLEN=$AP_PREFIXLEN
export LL_AP_NETMASK=$AP_NETMASK LL_AP_SUBNET=$AP_SUBNET LL_DHCP_START=$DHCP_START LL_DHCP_END=$DHCP_END
export LL_BROKER_HOSTNAME=$BROKER_HOSTNAME LL_NTP_UPSTREAM=$NTP_UPSTREAM LL_AP_PSK_FILE=$LL_SECRETS/ap.psk
export LL_MQTT_PASSWD_FILE=$LL_ETC/mosq/passwd LL_MQTT_ACL_FILE=$LL_ETC/mosq/acl
export LL_CA_FILE=$LL_SECRETS/pki/ca.crt LL_CERT_FILE=$LL_SECRETS/pki/server.crt LL_KEY_FILE=$LL_SECRETS/pki/server.key
export LL_APP_DIR LL_DATA_DIR=$LL_DATA LL_ETC_DIR=$LL_ETC LL_LOGS_DIR=$LL_LOGS LL_SECRETS_DIR=$LL_SECRETS LL_RUNTIME_DIR=$RUNTIME_DIR
export LL_MQTT_CORE_USER=$MQTT_CORE_USER LL_DEVICE_ID=$DEVICE_ID LL_OPERATOR_UID LL_OPERATOR_GID
LL_OPERATOR_UID="$(id -u "$CORE_USER")"; LL_OPERATOR_GID="$(id -g "$CORE_USER")"
umask 077
DEPLOY="$LL_APP_DIR/deploy"
R() { python3 "$HERE/render_template.py" "$@"; }
R "$DEPLOY/network/aegis-idea3-ap.nmconnection.example" "$LL_ETC/$NM_PROFILE.nmconnection"
sed -i "s/^id=.*/id=$NM_PROFILE/" "$LL_ETC/$NM_PROFILE.nmconnection"
R "$DEPLOY/network/aegis-idea3-dnsmasq.conf.example" "$LL_ETC/dnsmasq.conf"
{ echo "dhcp-leasefile=$LL_ETC/dnsmasq.leases"; echo "log-dhcp"; echo "log-facility=$LL_EVID/dnsmasq.log"; echo "user=root"; } >> "$LL_ETC/dnsmasq.conf"
R "$DEPLOY/network/aegis-idea3-nftables.conf.example" "$LL_ETC/nftables.conf"
sed -i "s/^table inet aegis_idea3/table inet $NFT_TABLE/" "$LL_ETC/nftables.conf"
R "$DEPLOY/chrony/aegis-idea3-chrony.conf.example" "$LL_ETC/chrony.conf"
{ echo "# lab fallback: serve local time at stratum 10 if the upstream is unreachable"; echo "local stratum 10"
  echo "driftfile $LL_ETC/chrony.drift"; echo "logdir $LL_EVID"; echo "log tracking measurements"; echo "cmdport 0"; } >> "$LL_ETC/chrony.conf"
R "$DEPLOY/mosquitto/aegis-idea3-mosquitto.conf.example" "$LL_ETC/mosq/mosquitto.conf"
{ echo "log_dest file $LL_EVID/mosquitto.log"; echo "log_type all"; echo "connection_messages true"; } >> "$LL_ETC/mosq/mosquitto.conf"
sed -e "s/device-id/$DEVICE_ID/g" "$DEPLOY/mosquitto/aegis-idea3-mosquitto.acl.example" > "$LL_ETC/mosq/acl"
# NOTE: mosquitto_passwd -b takes the password as an argument, so it is briefly visible in this host's process list.
rm -f "$LL_ETC/mosq/passwd"
mosquitto_passwd -c -b "$LL_ETC/mosq/passwd" "$MQTT_CORE_USER" "$(cat "$LL_SECRETS/mqtt-core.pass")"
mosquitto_passwd -b "$LL_ETC/mosq/passwd" "$MQTT_DEV_USER" "$(cat "$LL_SECRETS/mqtt-dev.pass")"
if [[ -e $LL_ETC/core.env ]]; then
  ok "core.env kept (never overwritten)"
else
  R "$HERE/templates/core.env.template" "$LL_ETC/core.env"; ok "core.env created: add AEGIS_TG_TOKEN / AEGIS_TG_CHAT yourself if you want Telegram"
fi
ok "rendered to $LL_ETC"
[[ $RENDER_ONLY -eq 0 ]] || { echo; echo "render-only: done, nothing else was touched."; exit 0; }

step "stop colliding units (stop only, never disabled)"
: > "$LL_EVID/stopped-units.txt"
for u in $STOP_UNITS systemd-timesyncd.service; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    sudo systemctl stop "$u" && echo "$u" >> "$LL_EVID/stopped-units.txt" && ok "stopped $u"
  fi
done
busy="$(ss -H -lunp 2>/dev/null | grep -E ':(53|67|123)\b' | grep -E "$AP_ADDR|0\.0\.0\.0|\*" || true)"
if [[ -n $busy ]] && ! systemctl is-active --quiet "$(ll_unit dnsmasq)"; then
  echo "$busy"; ll_die "UDP 53/67/123 is already bound on the host; add the owning unit to STOP_UNITS"
fi

step "lab AP (the Wi-Fi profiles that autoconnect are switched to manual; recorded for the rollback)"
nmcli -t -f NAME,TYPE,AUTOCONNECT con show | awk -F: '$2=="802-11-wireless" && $3=="yes"{print $1}' > "$LL_EVID/wifi-autoconnect-was-yes.txt"
while IFS= read -r n; do [[ -n $n && $n != "$NM_PROFILE" ]] && nmcli connection modify "$n" connection.autoconnect no; done < "$LL_EVID/wifi-autoconnect-was-yes.txt"
sudo install -d -m 755 /run/NetworkManager/system-connections
sudo install -m 600 -o root -g root "$LL_ETC/$NM_PROFILE.nmconnection" "/run/NetworkManager/system-connections/$NM_PROFILE.nmconnection"
sudo nmcli connection reload
active="$(nmcli -t -f NAME,DEVICE con show --active | awk -F: -v d="$AP_IFACE" '$2==d{print $1}')"
[[ -z $active || $active == "$NM_PROFILE" ]] || nmcli connection down "$active" >/dev/null
nmcli connection up "$NM_PROFILE" >/dev/null
sleep 3
check "AP address $AP_ADDR/$AP_PREFIXLEN on $AP_IFACE" bash -c "ip -4 -o addr show dev '$AP_IFACE' | grep -q ' $AP_ADDR/$AP_PREFIXLEN '"
ROUTE_AFTER="$(ip -4 route show default)"
if [[ $ROUTE_AFTER != "$ROUTE_BEFORE" ]]; then
  ll_die "default route changed after the AP came up ($ROUTE_AFTER). Run aegis-live-down.sh and check the AP profile (never-default must be true)"
fi
getent hosts "$DNS_CHECK_HOST" >/dev/null || ll_die "DNS stopped resolving after the AP came up; run aegis-live-down.sh"
ok "default route and DNS unchanged"

step "firewall table inet $NFT_TABLE (AP isolation + software-containment set)"
sudo nft list table inet "$NFT_TABLE" >/dev/null 2>&1 && sudo nft delete table inet "$NFT_TABLE"
sudo nft -f "$LL_ETC/nftables.conf"
ok "loaded"

start_unit() { # start_unit short-name command...
  local name; name="$(ll_unit "$1")"; shift
  if systemctl is-active --quiet "$name"; then ok "$name already running"; return 0; fi
  sudo systemd-run --unit="$name" --collect "$@" >/dev/null
}

step "DHCP/DNS, time, broker"
start_unit dnsmasq dnsmasq --keep-in-foreground --conf-file="$LL_ETC/dnsmasq.conf" --pid-file=
start_unit chrony chronyd -d -f "$LL_ETC/chrony.conf"
start_unit mosquitto -p User="$CORE_USER" mosquitto -c "$LL_ETC/mosq/mosquitto.conf"
sleep 5
for s in dnsmasq chrony mosquitto; do check "$(ll_unit $s) active" systemctl is-active --quiet "$(ll_unit $s)"; done
check "broker listening on $AP_ADDR:8883" bash -c "ss -H -ltn | grep -q '$AP_ADDR:8883'"
check "TLS verifies against the lab CA for $BROKER_HOSTNAME" bash -c "echo | openssl s_client -connect '$AP_ADDR:8883' -servername '$BROKER_HOSTNAME' -CAfile '$LL_SECRETS/pki/ca.crt' -verify_hostname '$BROKER_HOSTNAME' 2>&1 | grep -q 'Verify return code: 0'"
for _ in $(seq 1 30); do [[ $(timedatectl show -p NTPSynchronized --value) == yes ]] && break; sleep 2; done
check "kernel clock synchronised (the Core's trusted time needs it)" bash -c "[[ \$(timedatectl show -p NTPSynchronized --value) == yes ]]"

step "Core (transient unit, credentials passed as systemd credentials)"
CORE_PROPS=(-p User="$CORE_USER" -p WorkingDirectory="$LL_APP_DIR" -p EnvironmentFile="$LL_ETC/core.env"
  -p LoadCredential=k_c2d:"$LL_SECRETS/k_c2d" -p LoadCredential=k_d2c:"$LL_SECRETS/k_d2c"
  -p LoadCredential=mqtt-core.pass:"$LL_SECRETS/mqtt-core.pass" -p LoadCredential=admin.pin:"$LL_SECRETS/admin.pin")
CORE_ARGS=(-m aegis_soc.cli doctor --profile lab --live --headless --no-detector --no-voice)
if ! systemctl is-active --quiet "$(ll_unit core)"; then
  # /run is a tmpfs wiped at every reboot and the Core runs unprivileged, so the runtime directory must exist before it starts.
  sudo install -d -o "$CORE_USER" -g "$(id -gn "$CORE_USER")" -m 750 "$RUNTIME_DIR"
  sudo systemd-run --unit="$(ll_unit core-doctor)" --collect --wait "${CORE_PROPS[@]}" "$(ll_python)" -I "${CORE_ARGS[@]}" >/dev/null 2>&1 \
    && ok "doctor passed" || { journalctl -u "$(ll_unit core-doctor)" -n 15 --no-pager -o cat 2>/dev/null | tail -15; ll_die "Core doctor failed"; }
  sudo systemd-run --unit="$(ll_unit core)" --collect "${CORE_PROPS[@]}" "$(ll_python)" -m aegis_soc.supervisor \
    --profile lab --live --headless --no-detector --no-voice >/dev/null
else
  ok "$(ll_unit core) already running"
fi
for _ in $(seq 1 30); do [[ -r $RUNTIME_DIR/status.json ]] && break; sleep 1; done

step "health summary"
for u in dnsmasq chrony mosquitto core; do printf '   %-26s %s\n' "$(ll_unit $u)" "$(systemctl is-active "$(ll_unit $u)")"; done
printf '   default route: %s\n' "$(ip -4 route show default)"
if [[ -r $RUNTIME_DIR/status.json ]]; then
  python3 - "$RUNTIME_DIR/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("   Core:", {k: d.get(k) for k in ("state", "device", "uplink", "time_trust", "broker")})
PY
else
  echo "   Core status.json not readable yet"
fi
echo "   Telegram config: $(grep -Eq '^AEGIS_TG_TOKEN=.+' "$LL_ETC/core.env" && grep -Eq '^AEGIS_TG_CHAT=.+' "$LL_ETC/core.env" && echo set || echo unset)"
echo "   The ESP32 reports LOCKDOWN until the first RESTORE (owner-restore.sh or the control Desktop)."
if [[ $FAILS -gt 0 ]]; then echo; echo "$FAILS check(s) FAILED. Fix or run aegis-live-down.sh." >&2; exit 1; fi
echo; echo "Lab is up."
