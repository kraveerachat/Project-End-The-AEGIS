#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L4 verification.
# Read-only verification against the selected root.
set -uo pipefail

fail() {
  printf "L4_VERIFY=FAIL reason=%s\n" "$1" >&2
  exit 1
}

PROFILE_DEST="/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"
DNSMASQ_CONF_DEST="/etc/aegis-idea3/dnsmasq-ap.conf"
DNSMASQ_UNIT_DEST="/etc/systemd/system/aegis-idea3-dnsmasq.service"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L4_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
if [ -z "$ROOT" ]; then
  [ -n "${AEGIS_AP_ADDRESS:-}" ] || fail LIVE_REQUIRES_EXPLICIT_AEGIS_AP_ADDRESS
  AP_ADDR="$AEGIS_AP_ADDRESS"
else
  AP_ADDR="${AEGIS_AP_ADDRESS:-192.0.2.1}"
fi

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING
[ -n "$AP_IF" ] || fail AEGIS_AP_INTERFACE_REQUIRED

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

target_profile="$(host_path "$PROFILE_DEST")"
[ -f "$target_profile" ] || fail PROFILE_CONFIG_MISSING

profile_mode=$(stat -c %a "$target_profile" 2>/dev/null)
[ "$profile_mode" = "600" ] || fail PROFILE_PERMISSIONS_INSECURE

grep -Fqx "mode=ap" "$target_profile" || fail PROFILE_MODE_NOT_AP
grep -Fqx "method=manual" "$target_profile" || fail PROFILE_METHOD_NOT_MANUAL
grep -Fqx "never-default=true" "$target_profile" || fail PROFILE_NEVER_DEFAULT_MISSING
grep -Eq "^address1=${AP_ADDR}/" "$target_profile" || fail PROFILE_ADDRESS_MISMATCH
! grep -Fq "method=shared" "$target_profile" || fail PROFILE_USES_SHARED_MODE

dnsmasq_conf="$(host_path "$DNSMASQ_CONF_DEST")"
[ -f "$dnsmasq_conf" ] || fail DNSMASQ_CONF_MISSING

conf_mode=$(stat -c %a "$dnsmasq_conf" 2>/dev/null)
[ "$conf_mode" = "644" ] || fail DNSMASQ_CONF_PERMISSIONS_INSECURE

grep -Fqx "interface=$AP_IF" "$dnsmasq_conf" || fail DNSMASQ_INTERFACE_MISMATCH
grep -Fqx "bind-interfaces" "$dnsmasq_conf" || fail DNSMASQ_BIND_INTERFACES_MISSING
grep -Fqx "except-interface=lo" "$dnsmasq_conf" || fail DNSMASQ_EXCEPT_INTERFACE_LO_MISSING
grep -Fqx "dhcp-option=option:router" "$dnsmasq_conf" || fail DNSMASQ_EMPTY_ROUTER_OPTION_MISSING
grep -Fqx "dhcp-option=option:dns-server,$AP_ADDR" "$dnsmasq_conf" || fail DNSMASQ_DNS_SERVER_OPTION_MISSING
grep -Fqx "no-resolv" "$dnsmasq_conf" || fail DNSMASQ_NO_RESOLV_MISSING
grep -Fqx "no-hosts" "$dnsmasq_conf" || fail DNSMASQ_NO_HOSTS_MISSING
! grep -Fq "enp62s0" "$dnsmasq_conf" || fail DNSMASQ_TARGETS_WIRED_UPLINK
! grep -Eq "listen-address|12h|bogus-priv|domain-needed" "$dnsmasq_conf" || fail DNSMASQ_UNAPPROVED_DIRECTIVE

dnsmasq_unit="$(host_path "$DNSMASQ_UNIT_DEST")"
[ -f "$dnsmasq_unit" ] || fail DNSMASQ_UNIT_MISSING

unit_mode=$(stat -c %a "$dnsmasq_unit" 2>/dev/null)
[ "$unit_mode" = "644" ] || fail DNSMASQ_UNIT_PERMISSIONS_INSECURE

grep -Fq -e "--conf-file=/etc/aegis-idea3/dnsmasq-ap.conf" "$dnsmasq_unit" || fail DNSMASQ_UNIT_CONF_MISMATCH
! grep -Eq "start dnsmasq\.service|restart dnsmasq\.service" "$dnsmasq_unit" || fail DNSMASQ_UNIT_MUTATES_GENERIC_SERVICE
! grep -Eq "User=|Group=" "$dnsmasq_unit" || fail DNSMASQ_UNIT_UNAPPROVED_DIRECTIVE

if [ -z "$ROOT" ]; then
  ip -4 addr show dev "$AP_IF" 2>/dev/null | grep -q "inet $AP_ADDR" || fail AP_ADDRESS_NOT_ACTIVE
  [ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_HAS_DEFAULT_ROUTE

  check_l2_firewall_preconditions "$AP_IF"

  systemctl is-active aegis-idea3-dnsmasq.service >/dev/null 2>&1 || fail DNSMASQ_SERVICE_NOT_ACTIVE
fi

printf "L4_VERIFY=PASS\n"
printf "AP_INTERFACE=%s\n" "$AP_IF"
printf "AP_ADDRESS=%s\n" "$AP_ADDR"
printf "PRODUCTION_MUTATION_PERFORMED=NO\n"
