#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L4 AP-addressing / DHCP apply handler.
# AP addressing & DHCP/Core-local DNS only. Starts from L3 PASS.
# MUTATING only when AEGIS_P4_FS_ROOT is unset and explicit live authorization
# is present. Fixture mode writes only below AEGIS_P4_FS_ROOT.
set -uo pipefail

fail() {
  printf "L4_APPLY=FAIL reason=%s\n" "$1" >&2
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
AP_CHANNEL="${AEGIS_AP_CHANNEL:-6}"
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VALUES_ONLY="${AEGIS_L4_VALUES_ONLY:-NO}"

# Owner values. Live mode (AEGIS_P4_FS_ROOT unset) never falls back to a default:
# every value must be supplied explicitly. Only fixture mode keeps the
# documentation-range fixture defaults.
if [ -z "$ROOT" ]; then
  for v in AEGIS_AP_INTERFACE AEGIS_AP_ADDRESS AEGIS_AP_SUBNET AEGIS_DHCP_START AEGIS_DHCP_END AEGIS_BROKER_HOSTNAME; do
    [ -n "${!v:-}" ] || fail "LIVE_REQUIRES_EXPLICIT_$v"
  done
  AP_ADDR="$AEGIS_AP_ADDRESS"
  AP_SUBNET="$AEGIS_AP_SUBNET"
  DHCP_START="$AEGIS_DHCP_START"
  DHCP_END="$AEGIS_DHCP_END"
  BROKER_HOSTNAME="$AEGIS_BROKER_HOSTNAME"
  LIVE_MODE=1
else
  AP_ADDR="${AEGIS_AP_ADDRESS:-192.0.2.1}"
  AP_SUBNET="${AEGIS_AP_SUBNET:-192.0.2.0/28}"
  DHCP_START="${AEGIS_DHCP_START:-192.0.2.2}"
  DHCP_END="${AEGIS_DHCP_END:-192.0.2.10}"
  BROKER_HOSTNAME="${AEGIS_BROKER_HOSTNAME:-mqtt.aegis.invalid}"
  LIVE_MODE=0
fi

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] || fail AEGIS_L4_WORK_DIR_REQUIRED
[ -n "$AP_IF" ] || fail AEGIS_AP_INTERFACE_REQUIRED
[[ "$AP_IF" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail AEGIS_AP_INTERFACE_INVALID

# Enumerate existing non-target IPv4 interface networks read-only
existing_nets=""
if [ -z "$ROOT" ]; then
  existing_nets=$(ip -4 -o addr show 2>/dev/null | awk -v ap="$AP_IF" '$2 != ap && $2 != "lo" {print $4}' | tr '\n' ' ')
  # Routed prefixes too (Twingate sdwan0, management /32 routes, Docker bridges): read-only.
  existing_nets="$existing_nets $(ip -4 route show 2>/dev/null | awk -v ap="$AP_IF" '$1 != "default" && $0 !~ (" dev " ap "( |$)") {print $1}' | tr '\n' ' ')"
fi
if [ -n "${AEGIS_NON_TARGET_NETWORKS:-}" ]; then
  existing_nets="$existing_nets $AEGIS_NON_TARGET_NETWORKS"
fi
if [ -n "${AEGIS_EXISTING_NETWORKS:-}" ]; then
  existing_nets="$existing_nets $AEGIS_EXISTING_NETWORKS"
fi

# Validate network parameters with python ipaddress
validation_out=$(python3 -c '
import ipaddress, re, sys

ap_addr_str = sys.argv[1]
ap_subnet_str = sys.argv[2]
dhcp_start_str = sys.argv[3]
dhcp_end_str = sys.argv[4]
hostname = sys.argv[5]
non_target_raw = sys.argv[6] if len(sys.argv) > 6 else ""
live = len(sys.argv) > 7 and sys.argv[7] == "1"

try:
    subnet = ipaddress.ip_network(ap_subnet_str, strict=True)
except Exception as e:
    sys.exit(f"INVALID_SUBNET:{e}")

if subnet.version != 4:
    sys.exit("AP_SUBNET_MUST_BE_IPV4")

if subnet.prefixlen > 30:
    sys.exit("SUBNET_TOO_SMALL")

if live:
    doc_nets = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")]
    if any(subnet.overlaps(n) for n in doc_nets):
        sys.exit("LIVE_DOCUMENTATION_RANGE_FORBIDDEN")
    if (not subnet.is_private or subnet.overlaps(ipaddress.ip_network("100.64.0.0/10"))
            or subnet.is_link_local or subnet.is_loopback or subnet.is_multicast):
        sys.exit("LIVE_SUBNET_NOT_PRIVATE")

# Reject overlap with any enumerated non-target interface network
non_target_nets = []
for item in non_target_raw.split():
    item = item.strip()
    if item:
        try:
            non_target_nets.append(ipaddress.ip_network(item, strict=False))
        except Exception:
            pass

for ext_net in non_target_nets:
    if subnet.overlaps(ext_net):
        sys.exit(f"MANAGEMENT_NETWORK_OVERLAP:{ext_net}")

try:
    ap_addr = ipaddress.ip_address(ap_addr_str)
    dhcp_start = ipaddress.ip_address(dhcp_start_str)
    dhcp_end = ipaddress.ip_address(dhcp_end_str)
except Exception as e:
    sys.exit(f"INVALID_IP_ADDRESS:{e}")

for name, addr in [("AP_ADDRESS", ap_addr), ("DHCP_START", dhcp_start), ("DHCP_END", dhcp_end)]:
    if addr.version != 4:
        sys.exit(f"{name}_MUST_BE_IPV4")
    if addr not in subnet:
        sys.exit(f"{name}_NOT_IN_SUBNET")
    if addr in (subnet.network_address, subnet.broadcast_address):
        sys.exit(f"{name}_IS_NETWORK_OR_BROADCAST")

if int(dhcp_start) > int(dhcp_end):
    sys.exit("DHCP_START_GREATER_THAN_END")

if int(dhcp_start) <= int(ap_addr) <= int(dhcp_end):
    sys.exit("DHCP_RANGE_CONTAINS_CORE_AP")

label = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
labels = hostname.split(".")
if len(hostname) > 253 or not all(label.match(x) for x in labels):
    sys.exit("INVALID_BROKER_HOSTNAME")
if live:
    if len(labels) < 2 or all(x.isdigit() for x in labels):
        sys.exit("INVALID_BROKER_HOSTNAME")
    if labels[-1].lower() in ("invalid", "example", "test", "localhost", "local"):
        sys.exit("LIVE_BROKER_HOSTNAME_RESERVED")

print(f"{subnet.prefixlen} {subnet.netmask}")
' "$AP_ADDR" "$AP_SUBNET" "$DHCP_START" "$DHCP_END" "$BROKER_HOSTNAME" "$existing_nets" "$LIVE_MODE" 2>&1)

if [ $? -ne 0 ]; then
  fail "$validation_out"
fi

read -r PREFIX_LEN NETMASK <<< "$validation_out"

if [ "$VALUES_ONLY" = YES ]; then
  printf 'L4_VALUES=VALID\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

umask 077
mkdir -p "$WORK"
chmod 700 "$WORK"

target_profile="$(host_path "$PROFILE_DEST")"
[ -f "$target_profile" ] || fail L3_PROFILE_MISSING

target_mode=$(stat -c %a "$target_profile" 2>/dev/null)
[ "$target_mode" = "600" ] || fail PROFILE_PERMISSIONS_INSECURE

grep -Fqx "mode=ap" "$target_profile" || fail PROFILE_MODE_NOT_AP
grep -Fqx "method=disabled" "$target_profile" || fail PROFILE_METHOD_NOT_DISABLED
! grep -Eq "shared|address[0-9]|gateway" "$target_profile" || fail PROFILE_ALREADY_HAS_ADDRESSING


check_l2_firewall_preconditions() {
  local ap_if="${1:-${AP_IF:-wlp0s20f3}}"

  # 1. table inet aegis_idea3 exists
  local idea3_rules
  if ! idea3_rules=$(nft list table inet aegis_idea3 2>/dev/null); then
    fail L2_FIREWALL_TABLE_MISSING
  fi
  [ -n "$idea3_rules" ] || fail L2_FIREWALL_TABLE_MISSING

  local clean_rules
  clean_rules=$(printf '%s\n' "$idea3_rules" | sed -E 's/^[[:space:]]*#.*$//; s/[[:space:]]+#.*$//')

  printf '%s\n' "$clean_rules" | grep -Eq '^[[:space:]]*table[[:space:]]+inet[[:space:]]+aegis_idea3[[:space:]]*\{' \
    || fail L2_FIREWALL_TABLE_MISSING

  # 2. AP-side UDP/67 permit required by DHCP exists
  printf '%s\n' "$clean_rules" | grep -Eq 'iifname[[:space:]]+"?('"wlp0s20f3"'|'"$ap_if"')"?([[:space:]]+[^;\n]*)*udp[[:space:]]+dport[[:space:]]+67([[:space:]]+[^;\n]*)*accept' \
    || fail L2_DHCP_PERMIT_MISSING

  # 3. AP-side UDP/53 permit exists
  printf '%s\n' "$clean_rules" | grep -Eq 'iifname[[:space:]]+"?('"wlp0s20f3"'|'"$ap_if"')"?([[:space:]]+[^;\n]*)*udp[[:space:]]+dport[[:space:]]+53([[:space:]]+[^;\n]*)*accept' \
    || fail L2_DNS_PERMIT_MISSING

  # 4. AP-side TCP/53 permit exists
  printf '%s\n' "$clean_rules" | grep -Eq 'iifname[[:space:]]+"?('"wlp0s20f3"'|'"$ap_if"')"?([[:space:]]+[^;\n]*)*tcp[[:space:]]+dport[[:space:]]+53([[:space:]]+[^;\n]*)*accept' \
    || fail L2_DNS_PERMIT_MISSING

  # 5. AP-side TCP/1883 explicit DROP exists
  printf '%s\n' "$clean_rules" | grep -Eq 'iifname[[:space:]]+"?('"wlp0s20f3"'|'"$ap_if"')"?([[:space:]]+[^;\n]*)*tcp[[:space:]]+dport[[:space:]]+1883([[:space:]]+[^;\n]*)*drop' \
    || fail L2_1883_DROP_MISSING

  # 6. AP forward isolation remains present
  printf '%s\n' "$clean_rules" | awk -v ap="$ap_if" '
    /chain[[:space:]]+forward[[:space:]]*\{/ { in_fwd=1 }
    in_fwd && /iifname[[:space:]]+"?([a-zA-Z0-9_.-]+)"?([[:space:]]+[^;\n]*)*drop/ { found=1 }
    in_fwd && /\}/ { in_fwd=0 }
    END { exit (found ? 0 : 1) }
  ' || fail L2_FORWARD_ISOLATION_MISSING

  # 7. No NAT/masquerade contract appears
  if printf '%s\n' "$clean_rules" | grep -Eiq '\b(nat|masquerade|snat|dnat)\b'; then
    fail UNEXPECTED_NAT_DETECTED
  fi
  local all_tables
  all_tables=$(nft list tables 2>/dev/null || true)
  if printf '%s\n' "$all_tables" | grep -Eiq '\bnat\b'; then
    fail UNEXPECTED_NAT_DETECTED
  fi
  local all_rules
  all_rules=$(nft list ruleset 2>/dev/null || true)
  if printf '%s\n' "$all_rules" | grep -Eiq '\b(masquerade|snat|dnat)\b'; then
    fail UNEXPECTED_NAT_DETECTED
  fi

  # 8. Forwarding sysctls remain zero
  local k v
  for k in \
    net.ipv4.ip_forward \
    net.ipv4.conf.all.forwarding \
    net.ipv4.conf.default.forwarding \
    "net.ipv4.conf.$ap_if.forwarding" \
    net.ipv6.conf.all.forwarding \
    net.ipv6.conf.default.forwarding \
    "net.ipv6.conf.$ap_if.forwarding"
  do
    v=$(sysctl -n "$k" 2>/dev/null || echo "1")
    [ "$v" = "0" ] || fail FORWARDING_NOT_ZERO
  done
}

if [ "${AEGIS_L4_FIREWALL_PRECONDITION_TEST:-}" = "1" ]; then
  check_l2_firewall_preconditions "$AP_IF"
  printf "L2_FIREWALL_PRECONDITIONS=PASS\n"
  exit 0
fi

if [ -z "$ROOT" ]; then
  [ "$LIVE_AUTH" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  [ "$AP_IF" = "wlp0s20f3" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3

  [ -d "/etc/aegis-idea3" ] && [ ! -L "/etc/aegis-idea3" ] || fail IDEA3_PARENT_DIR_REQUIRED

  # Live L3 must already be active, verified read-only BEFORE the L3 profile is touched: AP type, SSID AEGIS-IDEA3,
  # channel 6, no IPv4, no global IPv6, no default route via the AP, an alternate default route, and the M-14
  # channel/regulatory gate (target phy TH-or-00, approved channel unrestricted). See p4-l4-live.sh.
  # shellcheck source=../../p4-l4-live.sh
  . "$P4_HERE/p4-l4-live.sh"
  l4_precondition "$AP_IF" "$AP_CHANNEL" || fail "$L4_REASON"

  # L2 firewall verification
  check_l2_firewall_preconditions "$AP_IF"

  [ ! -e "$DNSMASQ_CONF_DEST" ] || fail DESTINATION_ALREADY_EXISTS
  [ ! -e "$DNSMASQ_UNIT_DEST" ] || fail DESTINATION_ALREADY_EXISTS
fi

# Backup original L3 profile for clean rollback
cp -p "$target_profile" "$WORK/profile.l3.orig"

# Transition profile from method=disabled to manual IPv4 addressing
python3 -c '
import sys
profile_path = sys.argv[1]
ap_addr = sys.argv[2]
prefix_len = sys.argv[3]

with open(profile_path, "r", encoding="utf-8") as f:
    text = f.read()

assert "[ipv4]" in text, "missing [ipv4] section"
assert "method=disabled" in text, "method not disabled"

old_block = "[ipv4]\nmethod=disabled"
new_block = f"[ipv4]\nmethod=manual\naddress1={ap_addr}/{prefix_len}\nnever-default=true"
text = text.replace(old_block, new_block, 1)

assert "method=shared" not in text
assert "never-default=true" in text
assert f"address1={ap_addr}/{prefix_len}" in text

with open(profile_path, "w", encoding="utf-8") as f:
    f.write(text)
' "$target_profile" "$AP_ADDR" "$PREFIX_LEN"

chmod 600 "$target_profile"

# Render and install dedicated dnsmasq configuration
dnsmasq_conf_target="$(host_path "$DNSMASQ_CONF_DEST")"
mkdir -p "$(dirname "$dnsmasq_conf_target")"
printf "# AEGIS IDEA3 AP DHCP/Core-local DNS — TEMPLATE, NOT DEPLOYED.\n# Owner network values are rendered only for an explicitly reviewed live stage.\n\ninterface=%s\nbind-interfaces\n\ndhcp-range=%s,%s,%s\n\n# ESP32 must not receive an Internet/default-gateway route.\ndhcp-option=option:router\n\n# Core-local DNS only.\ndhcp-option=option:dns-server,%s\nno-resolv\nno-hosts\naddress=/%s/%s\n" \
  "$AP_IF" "$DHCP_START" "$DHCP_END" "$NETMASK" "$AP_ADDR" "$BROKER_HOSTNAME" "$AP_ADDR" > "$WORK/dnsmasq-ap.conf.tmp"

install -D -m 0644 "$WORK/dnsmasq-ap.conf.tmp" "$dnsmasq_conf_target"
rm -f "$WORK/dnsmasq-ap.conf.tmp"

# Render and install dedicated dnsmasq systemd service
dnsmasq_unit_target="$(host_path "$DNSMASQ_UNIT_DEST")"
mkdir -p "$(dirname "$dnsmasq_unit_target")"
printf "# AEGIS IDEA3 dedicated dnsmasq instance — TEMPLATE, NOT DEPLOYED.\n\n[Unit]\nDescription=AEGIS IDEA3 private AP DHCP and Core-local DNS\nAfter=NetworkManager.service\nRequires=NetworkManager.service\n\n[Service]\nType=simple\nExecStartPre=/usr/bin/dnsmasq --test --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf\nExecStart=/usr/bin/dnsmasq --keep-in-foreground --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf --pid-file=\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n" > "$WORK/aegis-idea3-dnsmasq.service.tmp"

install -D -m 0644 "$WORK/aegis-idea3-dnsmasq.service.tmp" "$dnsmasq_unit_target"
rm -f "$WORK/aegis-idea3-dnsmasq.service.tmp"

printf "%s\n" "$AP_IF" > "$WORK/ap_if"
printf "%s\n" "$CONN_ID" > "$WORK/conn_id"
printf "%s\n" "$AP_ADDR" > "$WORK/ap_addr"
printf "%s\n" "$AP_SUBNET" > "$WORK/ap_subnet"
printf "%s\n" "$BROKER_HOSTNAME" > "$WORK/broker_hostname"

if [ -z "$ROOT" ]; then
  /usr/bin/dnsmasq --test --conf-file="$DNSMASQ_CONF_DEST" || fail DNSMASQ_CONFIG_SYNTAX_FAIL
  nmcli connection reload || fail NMCLI_RELOAD_FAILED
  # Reactivation is bound to the approved interface (`ifname`), never NetworkManager's own device choice, and the AP
  # type, channel 6 and the regulatory gate are re-verified before dnsmasq is started. On failure no DHCP is served;
  # the owner runs rollback.sh.
  l4_reactivate "$AP_IF" "$CONN_ID" "$AP_CHANNEL" || fail "$L4_REASON"
  printf 'L4_REGULATORY_POST_REACTIVATION=%s phy=%s channel=%s\n' "$L3_REG_COUNTRY" "$L3_REG_PHY" "$AP_CHANNEL"

  systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
  systemctl enable --now aegis-idea3-dnsmasq.service || fail DNSMASQ_SERVICE_START_FAILED

  ip -4 addr show dev "$AP_IF" 2>/dev/null | grep -q "inet $AP_ADDR" || fail AP_ADDRESS_NOT_ACTIVE
  [ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_HAS_DEFAULT_ROUTE
  [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ] || fail FORWARDING_NOT_ZERO
  printf "PRODUCTION_MUTATION_PERFORMED=YES\n"
else
  printf "FIXTURE_ONLY\n" > "$WORK/mode"
  printf "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY\n"
fi

printf "L4_APPLY=PASS\n"
printf "AP_INTERFACE=%s\n" "$AP_IF"
printf "AP_ADDRESS=%s/%s\n" "$AP_ADDR" "$PREFIX_LEN"
printf "DHCP_STATUS=AP_SCOPED\n"
printf "DNS_STATUS=CORE_LOCAL_ONLY\n"
printf "FORWARDING_TARGET=DISABLED\n"
