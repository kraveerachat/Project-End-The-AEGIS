#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L5 verification handler.
# Read-only verification against the selected root.
set -uo pipefail

fail() {
  printf "L5_VERIFY=FAIL reason=%s\n" "$1" >&2
  exit 1
}

CHRONY_CONF_DEST="/etc/chrony.conf"
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L5_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
AP_ADDR="${AEGIS_AP_ADDRESS:-192.0.2.1}"
AP_SUBNET="${AEGIS_AP_SUBNET:-192.0.2.0/28}"
UPSTREAM="${AEGIS_TRUSTED_NTP_UPSTREAM:-198.51.100.123}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING

if [ -f "$WORK/ap_if" ]; then AP_IF="$(cat "$WORK/ap_if")"; fi
if [ -f "$WORK/ap_addr" ]; then AP_ADDR="$(cat "$WORK/ap_addr")"; fi
if [ -f "$WORK/ap_subnet" ]; then AP_SUBNET="$(cat "$WORK/ap_subnet")"; fi
if [ -f "$WORK/upstream" ]; then UPSTREAM="$(cat "$WORK/upstream")"; fi

# 1. Verify /etc/chrony.conf
target_conf="$(host_path "$CHRONY_CONF_DEST")"
[ -f "$target_conf" ] && [ ! -L "$target_conf" ] || fail CHRONY_CONF_MISSING

conf_mode="$(stat -c %a "$target_conf" 2>/dev/null || echo "")"
[ "$conf_mode" = "640" ] || fail CHRONY_CONF_PERMISSIONS_INSECURE

active_lines="$(grep -v '^[[:space:]]*#' "$target_conf" | grep -v '^[[:space:]]*$' || true)"
expected_server="server $UPSTREAM iburst"
expected_bind="bindaddress $AP_ADDR"
expected_allow="allow $AP_SUBNET"

printf '%s\n' "$active_lines" | grep -Fqx "$expected_server" || fail CHRONY_CONF_UPSTREAM_MISMATCH
printf '%s\n' "$active_lines" | grep -Fqx "$expected_bind" || fail CHRONY_CONF_BIND_MISMATCH
printf '%s\n' "$active_lines" | grep -Fqx "$expected_allow" || fail CHRONY_CONF_ALLOW_MISMATCH
printf '%s\n' "$active_lines" | grep -Fqx "rtcsync" || fail CHRONY_CONF_RTCSYNC_MISSING
[ "$(printf '%s\n' "$active_lines" | wc -l)" -eq 4 ] || fail CHRONY_CONF_UNAPPROVED_DIRECTIVES

# 2. Verify Services State
if [ -z "$ROOT" ]; then
  systemctl is-active chronyd.service >/dev/null 2>&1 || fail CHRONYD_NOT_ACTIVE
  if systemctl is-active systemd-timesyncd.service >/dev/null 2>&1; then
    fail CONCURRENT_TIME_DAEMONS_ACTIVE
  fi
else
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -d "$fixture_dir" ]; then
    chronyd_act="$(cat "$fixture_dir/chronyd_active" 2>/dev/null || echo "active")"
    [ "$chronyd_act" = "active" ] || fail CHRONYD_NOT_ACTIVE

    timesyncd_act="$(cat "$fixture_dir/timesyncd_active" 2>/dev/null || echo "inactive")"
    [ "$timesyncd_act" = "inactive" ] || fail CONCURRENT_TIME_DAEMONS_ACTIVE
  fi
fi

# 3. Verify Final TrustedClock
if [ -z "$ROOT" ]; then
  tc_eval="$(python3 "$P4_HERE/p4-l5-clock.py" probe 2>&1 || true)"
  printf '%s\n' "$tc_eval" > "$WORK/verify-clock.txt"
  tc_reason="$(printf '%s\n' "$tc_eval" | sed -n 's/.*reason=\([A-Z_]*\).*/\1/p' | tail -1)"
  [ "$tc_reason" = OK ] || fail "FINAL_TRUSTED_CLOCK_NOT_SYNCED:${tc_reason:-PROBE_UNAVAILABLE}"
else
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -d "$fixture_dir" ]; then
    if [ -f "$fixture_dir/trusted_clock_state" ]; then
      tc_state="$(cat "$fixture_dir/trusted_clock_state")"
      if [ "$tc_state" = "HOLDOVER" ]; then
        fail FINAL_TRUSTED_CLOCK_HOLDOVER_NOT_PERMITTED
      fi
      [ "$tc_state" = "SYNCED" ] || fail FINAL_TRUSTED_CLOCK_NOT_SYNCED
    fi
    if [ -f "$fixture_dir/max_error_us" ]; then
      max_err="$(cat "$fixture_dir/max_error_us")"
      [ "$max_err" -le 1000000 ] || fail MAX_ERROR_EXCEEDED
    fi
  fi
fi

# 4. Verify Listeners
check_listeners() {
  local listeners_text="$1"
  local ap_found=0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local proto addr port
    read -r proto addr_port <<< "$line"
    addr="${addr_port%:*}"
    port="${addr_port##*:}"

    if [ "$port" = "123" ]; then
      if [ "$proto" != "udp" ]; then
        fail TCP_NTP_LISTENER_FORBIDDEN
      fi
      if [[ "$addr" =~ ^(0\.0\.0\.0|\[::\]|::|\*)$ ]]; then
        fail WILDCARD_NTP_LISTENER_FORBIDDEN
      fi
      if [ "$addr" = "$AP_ADDR" ]; then
        ap_found=1
      else
        fail NON_AP_NTP_LISTENER_FORBIDDEN
      fi
    elif [ "$port" = "323" ]; then
      if [ "$proto" != "udp" ]; then
        fail TCP_COMMAND_LISTENER_FORBIDDEN
      fi
      if [[ "$addr" =~ ^(0\.0\.0\.0|\[::\]|::|\*)$ ]]; then
        fail NON_LOOPBACK_CONTROL_LISTENER_FORBIDDEN
      fi
      if [[ "$addr" != "127.0.0.1" && "$addr" != "[::1]" && "$addr" != "::1" ]]; then
        fail NON_LOOPBACK_CONTROL_LISTENER_FORBIDDEN
      fi
    fi
  done <<< "$listeners_text"

  [ "$ap_found" = 1 ] || fail AP_NTP_LISTENER_MISSING
}

if [ -z "$ROOT" ]; then
  raw_listeners="$(ss -H -ltnu 2>/dev/null | awk 'NF >= 5 { print $1 " " $5 }' || true)"
  check_listeners "$raw_listeners"
else
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -f "$fixture_dir/listeners" ]; then
    check_listeners "$(cat "$fixture_dir/listeners")"
  fi
fi

# 5. Verify Network and L4/L2 Preservation
l4_profile="$(host_path /etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection)"
[ -f "$l4_profile" ] || fail L4_PREREQUISITE_MISSING
grep -Fqx "method=manual" "$l4_profile" || fail L4_PROFILE_NOT_MANUAL
grep -Eq "^address1=${AP_ADDR}/" "$l4_profile" || fail L4_PROFILE_ADDRESS_MISMATCH

l4_dnsmasq="$(host_path /etc/aegis-idea3/dnsmasq-ap.conf)"
[ -f "$l4_dnsmasq" ] || fail L4_DNSMASQ_CONF_MISSING

l2_nft="$(host_path /etc/aegis-idea3/aegis-idea3.nft)"
[ -f "$l2_nft" ] || fail L2_FIREWALL_CONF_MISSING
grep -Eq 'table[[:space:]]+inet[[:space:]]+aegis_idea3' "$l2_nft" || fail L2_FIREWALL_TABLE_MISSING

if [ -z "$ROOT" ]; then
  [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ] || fail FORWARDING_NOT_ZERO
  all_tables=$(nft list tables 2>/dev/null || true)
  if printf '%s\n' "$all_tables" | grep -Eiq '\bnat\b'; then fail UNEXPECTED_NAT_DETECTED; fi
  all_rules=$(nft list ruleset 2>/dev/null || true)
  if printf '%s\n' "$all_rules" | grep -Eiq '\b(masquerade|snat|dnat)\b'; then fail UNEXPECTED_NAT_DETECTED; fi
else
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -d "$fixture_dir" ]; then
    if [ -f "$fixture_dir/forwarding" ]; then
      [ "$(cat "$fixture_dir/forwarding")" = "0" ] || fail FORWARDING_NOT_ZERO
    fi
    if [ -f "$fixture_dir/nat_detected" ]; then
      [ "$(cat "$fixture_dir/nat_detected")" = "NO" ] || fail UNEXPECTED_NAT_DETECTED
    fi
  fi
fi

printf "L5_VERIFY=PASS\n"
printf "CHRONYD_ACTIVE=YES\n"
printf "TIMESYNCD_INACTIVE=YES\n"
printf "TRUSTED_CLOCK_STATE=SYNCED\n"
printf "PRODUCTION_MUTATION_PERFORMED=NO\n"
