#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L5 Core-local trusted NTP apply handler.
# Starts from L4 PASS. Mutates runtime ActiveState only; UnitFileState is protected.
# MUTATING only when AEGIS_P4_FS_ROOT is unset and explicit live authorization
# is present. Fixture mode writes only below AEGIS_P4_FS_ROOT.
set -uo pipefail

fail() {
  printf "L5_APPLY=FAIL reason=%s\n" "$1" >&2
  exit 1
}

CHRONY_CONF_DEST="/etc/chrony.conf"
P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L5_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-wlp0s20f3}"
AP_ADDR="${AEGIS_AP_ADDRESS:-}"
AP_SUBNET="${AEGIS_AP_SUBNET:-}"
UPSTREAM="${AEGIS_TRUSTED_NTP_UPSTREAM:-}"
RENDER="${AEGIS_L5_RENDER_DIR:-}"
LIVE_AUTH="${AEGIS_L5_LIVE_AUTHORIZED:-NO}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf "%s%s\n" "${ROOT%/}" "$1"
  else
    printf "%s\n" "$1"
  fi
}

[ -n "$WORK" ] || fail AEGIS_L5_WORK_DIR_REQUIRED
if [ -z "$ROOT" ] && [ "$LIVE_AUTH" != "YES" ]; then
  fail LIVE_AUTHORIZATION_FLAG_REQUIRED
fi
[ -n "$AP_IF" ] || fail AEGIS_AP_INTERFACE_REQUIRED
[[ "$AP_IF" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail AEGIS_AP_INTERFACE_INVALID
[ -n "$AP_ADDR" ] || fail AP_ADDRESS_REQUIRED
[ -n "$AP_SUBNET" ] || fail AP_SUBNET_REQUIRED
[ -n "$UPSTREAM" ] || fail TRUSTED_UPSTREAM_REQUIRED
[ -n "$RENDER" ] && [ -d "$RENDER" ] || fail T6_ARTIFACTS_MISSING

# 1. Validate T6 artifacts
chrony_src="$RENDER/aegis-idea3-chrony.conf"
contract_src="$RENDER/aegis-idea3-t6-contract.txt"
[ -f "$chrony_src" ] && [ -f "$contract_src" ] || fail T6_ARTIFACTS_MISSING

python3 "$P4_HERE/p4-ntp.py" validate --input-dir "$RENDER" >/dev/null 2>&1 || fail T6_VALIDATE_FAILED

grep -Fqx "AP_ADDRESS=$AP_ADDR" "$contract_src" || fail T6_CONTRACT_AP_ADDRESS_MISMATCH
grep -Fqx "AP_SUBNET=$AP_SUBNET" "$contract_src" || fail T6_CONTRACT_AP_SUBNET_MISMATCH
grep -Fqx "TRUSTED_UPSTREAM=$UPSTREAM" "$contract_src" || fail T6_CONTRACT_UPSTREAM_MISMATCH

# 2. Check L4 and L2 prerequisites
l4_profile="$(host_path /etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection)"
[ -f "$l4_profile" ] || fail L4_PREREQUISITE_MISSING
grep -Fqx "mode=ap" "$l4_profile" || fail L4_PROFILE_NOT_AP
grep -Fqx "method=manual" "$l4_profile" || fail L4_PROFILE_NOT_MANUAL
grep -Eq "^address1=${AP_ADDR}/" "$l4_profile" || fail L4_PROFILE_ADDRESS_MISMATCH

l4_dnsmasq="$(host_path /etc/aegis-idea3/dnsmasq-ap.conf)"
[ -f "$l4_dnsmasq" ] || fail L4_DNSMASQ_CONF_MISSING

l2_nft="$(host_path /etc/aegis-idea3/aegis-idea3.nft)"
[ -f "$l2_nft" ] || fail L2_FIREWALL_CONF_MISSING
grep -Eq 'table[[:space:]]+inet[[:space:]]+aegis_idea3' "$l2_nft" || fail L2_FIREWALL_TABLE_MISSING
grep -Eq 'iifname[[:space:]]+"?('"wlp0s20f3"'|'"$AP_IF"')"?([[:space:]]+[^;\n]*)*udp[[:space:]]+dport[[:space:]]+123([[:space:]]+[^;\n]*)*accept' "$l2_nft" \
  || grep -Eq 'udp[[:space:]]+dport[[:space:]]+123([[:space:]]+[^;\n]*)*accept' "$l2_nft" \
  || fail L2_UDP123_ACCEPT_RULE_MISSING

# 3. Read-only config-path inspection for chronyd.service
check_chronyd_unit_config_path() {
  local unit_path=""
  if [ -n "$ROOT" ]; then
    for candidate in \
      "$ROOT/etc/systemd/system/chronyd.service" \
      "$ROOT/usr/lib/systemd/system/chronyd.service" \
      "$ROOT/lib/systemd/system/chronyd.service"; do
      if [ -f "$candidate" ]; then
        unit_path="$candidate"
        break
      fi
    done
    [ -n "$unit_path" ] || fail CHRONYD_UNIT_ABSENT

    local unit_text
    unit_text="$(cat "$unit_path")"

    # Check for drop-in overrides
    local dropin_dir="$ROOT/etc/systemd/system/chronyd.service.d"
    if [ -d "$dropin_dir" ]; then
      for dropin in "$dropin_dir"/*.conf; do
        if [ -f "$dropin" ]; then
          unit_text="$unit_text"$'\n'"$(cat "$dropin")"
        fi
      done
    fi

    # Inspect ExecStart directives
    while IFS= read -r line; do
      if [[ "$line" =~ ^ExecStart=(.*)$ ]]; then
        local cmd="${BASH_REMATCH[1]}"
        if [[ "$cmd" =~ -f[[:space:]]+([^[:space:]]+) ]]; then
          local custom_path="${BASH_REMATCH[1]}"
          if [ "$custom_path" != "/etc/chrony.conf" ]; then
            fail CONFIG_PATH_AUTHORITY_MISMATCH
          fi
        elif [[ "$cmd" =~ [[:space:]]-f$ ]]; then
          fail CONFIG_PATH_AUTHORITY_MISMATCH
        fi
      fi
    done <<< "$unit_text"
  else
    local load_state
    load_state="$(systemctl show -p LoadState chronyd.service 2>/dev/null || echo "")"
    [ "$load_state" = "LoadState=loaded" ] || fail CHRONYD_UNIT_ABSENT

    local exec_start
    exec_start="$(systemctl show -p ExecStart chronyd.service 2>/dev/null || echo "")"
    if [[ "$exec_start" =~ -f[[:space:]]+([^[:space:]]+) ]]; then
      local custom_path="${BASH_REMATCH[1]}"
      if [ "$custom_path" != "/etc/chrony.conf" ]; then
        fail CONFIG_PATH_AUTHORITY_MISMATCH
      fi
    fi
  fi
}
check_chronyd_unit_config_path

# 4. Mandatory live entry preconditions & fixture equivalents
if [ -z "$ROOT" ]; then
  [ "$LIVE_AUTH" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  [ "$AP_IF" = "wlp0s20f3" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3

  # Active IP on AP interface
  ip -4 addr show dev "$AP_IF" 2>/dev/null | grep -q "inet $AP_ADDR" || fail AP_ADDRESS_NOT_ACTIVE
  [ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_HAS_DEFAULT_ROUTE

  # Forwarding is 0
  [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ] || fail FORWARDING_NOT_ZERO

  # No NAT
  all_tables=$(nft list tables 2>/dev/null || true)
  if printf '%s\n' "$all_tables" | grep -Eiq '\bnat\b'; then fail UNEXPECTED_NAT_DETECTED; fi
  all_rules=$(nft list ruleset 2>/dev/null || true)
  if printf '%s\n' "$all_rules" | grep -Eiq '\b(masquerade|snat|dnat)\b'; then fail UNEXPECTED_NAT_DETECTED; fi

  # systemd-timesyncd active & running
  systemctl is-active systemd-timesyncd.service >/dev/null 2>&1 || fail TIMESYNCD_NOT_ACTIVE
  local substate
  substate="$(systemctl show -p SubState systemd-timesyncd.service 2>/dev/null || echo "")"
  [ "$substate" = "SubState=running" ] || fail TIMESYNCD_NOT_RUNNING

  # Core TrustedClock evaluates to SYNCED with maxerror <= 1,000,000 us
  tc_eval="$(python3 -c "
import sys
sys.path.insert(0, '$P4_HERE/../../IDEA3-AEGIS_Lockdown')
from aegis_soc.trusted_time import TrustedClock, adjtimex_probe
tc = TrustedClock()
probe = adjtimex_probe()
if probe is None or not probe.synced:
    sys.exit('PROBE_UNSYNCED')
state = tc.state()
if state != 'SYNCED':
    sys.exit(f'STATE_{state}')
if probe.maxerror_us > 1000000:
    sys.exit('MAXERROR_EXCEEDED')
print(f'{state}:{probe.maxerror_us}')
" 2>/dev/null || echo "FAIL")"

  [[ "$tc_eval" =~ ^SYNCED: ]] || fail TRUSTEDCLOCK_PRE_HANDOFF_NOT_SYNCED
else
  # Fixture checks
  fixture_dir="$ROOT/run/aegis-idea3-fixture"
  if [ -d "$fixture_dir" ]; then
    if [ -f "$fixture_dir/forwarding" ]; then
      [ "$(cat "$fixture_dir/forwarding")" = "0" ] || fail FORWARDING_NOT_ZERO
    fi
    if [ -f "$fixture_dir/nat_detected" ]; then
      [ "$(cat "$fixture_dir/nat_detected")" = "NO" ] || fail UNEXPECTED_NAT_DETECTED
    fi
    if [ -f "$fixture_dir/ap_ip" ]; then
      [ "$(cat "$fixture_dir/ap_ip")" = "$AP_ADDR" ] || fail AP_ADDRESS_MISMATCH
    fi
    if [ -f "$fixture_dir/timesyncd_active" ]; then
      [ "$(cat "$fixture_dir/timesyncd_active")" = "active" ] || fail TIMESYNCD_NOT_ACTIVE
    fi
    if [ -f "$fixture_dir/trusted_clock_state" ]; then
      tc_state="$(cat "$fixture_dir/trusted_clock_state")"
      [ "$tc_state" = "SYNCED" ] || fail TRUSTEDCLOCK_PRE_HANDOFF_NOT_SYNCED
    fi
    if [ -f "$fixture_dir/max_error_us" ]; then
      max_err="$(cat "$fixture_dir/max_error_us")"
      [ "$max_err" -le 1000000 ] || fail MAX_ERROR_EXCEEDED
    fi
  fi
fi

# 5. Type safety checks on /etc/chrony.conf & Snapshot pre-L5 state
target_conf="$(host_path "$CHRONY_CONF_DEST")"

if [ -L "$target_conf" ]; then
  fail CHRONY_CONF_IS_SYMLINK
fi
if [ -e "$target_conf" ] && [ ! -f "$target_conf" ]; then
  fail CHRONY_CONF_NOT_REGULAR_FILE
fi
if [ "${AEGIS_CHRONY_CONF_UNSUPPORTED_ATTRS:-0}" = "1" ]; then
  fail CHRONY_CONF_UNSUPPORTED_ATTRIBUTES
fi

umask 077
mkdir -p "$WORK"
chmod 700 "$WORK"

printf "%s\n" "$AP_IF" > "$WORK/ap_if"
printf "%s\n" "$AP_ADDR" > "$WORK/ap_addr"
printf "%s\n" "$AP_SUBNET" > "$WORK/ap_subnet"
printf "%s\n" "$UPSTREAM" > "$WORK/upstream"
printf "%s\n" "$RENDER" > "$WORK/render_dir"
printf "NO\n" > "$WORK/chronyd_started"

if [ -f "$target_conf" ]; then
  cp -p "$target_conf" "$WORK/chrony.conf.orig"
  stat -c "%a:%u:%g:%s:%Y" "$target_conf" > "$WORK/chrony.conf.meta.orig" 2>/dev/null || true
  printf "YES\n" > "$WORK/pre_chrony_conf_exists"
else
  printf "NO\n" > "$WORK/pre_chrony_conf_exists"
fi

# Record timesyncd pre-apply ActiveState
if [ -z "$ROOT" ]; then
  ts_state="$(systemctl is-active systemd-timesyncd.service 2>/dev/null || echo "inactive")"
  printf "%s\n" "$ts_state" > "$WORK/timesyncd_pre_active"
else
  printf "active\n" > "$WORK/timesyncd_pre_active"
fi

# 6. Atomic placement of rendered configuration
target_dir="$(dirname "$target_conf")"
mkdir -p "$target_dir"

tmp_conf="$(mktemp "${target_conf}.tmp.XXXXXX")"
cp -f "$chrony_src" "$tmp_conf"
chmod 0640 "$tmp_conf"
chown 0:0 "$tmp_conf" 2>/dev/null || true

# Validate temporary file content before moving into place
active_lines="$(grep -v '^[[:space:]]*#' "$tmp_conf" | grep -v '^[[:space:]]*$' || true)"
expected_server="server $UPSTREAM iburst"
expected_bind="bindaddress $AP_ADDR"
expected_allow="allow $AP_SUBNET"

if ! printf '%s\n' "$active_lines" | grep -Fqx "$expected_server" || \
   ! printf '%s\n' "$active_lines" | grep -Fqx "$expected_bind" || \
   ! printf '%s\n' "$active_lines" | grep -Fqx "$expected_allow" || \
   [ "$(printf '%s\n' "$active_lines" | wc -l)" -ne 3 ]; then
  rm -f "$tmp_conf"
  fail RENDERED_CONFIG_INVALID
fi

# Sync write durability then atomic rename
sync "$tmp_conf" 2>/dev/null || true
mv -f "$tmp_conf" "$target_conf"
chmod 0640 "$target_conf"

# 7. Service Handoff Sequencing
if [ "${AEGIS_L5_INJECT_FAIL_BEFORE_CHRONYD_START:-0}" = "1" ]; then
  fail INJECTED_FAIL_BEFORE_CHRONYD_START
fi

printf "stop systemd-timesyncd.service\n" >> "$WORK/service_events"
if [ -z "$ROOT" ]; then
  systemctl stop systemd-timesyncd.service || fail TIMESYNCD_STOP_FAILED
else
  if [ -d "$fixture_dir" ]; then
    printf "inactive\n" > "$fixture_dir/timesyncd_active"
    printf "dead\n" > "$fixture_dir/timesyncd_substate"
  fi
fi

if [ "${AEGIS_L5_INJECT_FAIL_CHRONYD_START:-0}" = "1" ]; then
  fail INJECTED_FAIL_CHRONYD_START
fi

printf "start chronyd.service\n" >> "$WORK/service_events"
if [ -z "$ROOT" ]; then
  systemctl start chronyd.service || fail CHRONYD_START_FAILED
  printf "YES\n" > "$WORK/chronyd_started"

  # Bounded HOLDOVER check for chronyd sync (HOLDOVER_SEC <= 300)
  synced=0
  for ((i=0; i<30; i++)); do
    if chronyc -n tracking >/dev/null 2>&1; then
      leap="$(chronyc -n tracking 2>/dev/null | awk -F' : ' '$1 ~ /^Leap status/ { print $2 }')"
      if [ "$leap" = "Normal" ]; then
        synced=1
        break
      fi
    fi
    sleep 1
  done
  [ "$synced" = 1 ] || fail CHRONYD_SYNC_TIMEOUT
else
  printf "YES\n" > "$WORK/chronyd_started"
  if [ -d "$fixture_dir" ]; then
    printf "active\n" > "$fixture_dir/chronyd_active"
    printf "running\n" > "$fixture_dir/chronyd_substate"
    printf "udp %s:123\nudp 127.0.0.1:323\n" "$AP_ADDR" > "$fixture_dir/listeners"
  fi
fi

if [ -z "$ROOT" ]; then
  printf "PRODUCTION_MUTATION_PERFORMED=YES\n"
else
  printf "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY\n"
fi

printf "L5_APPLY=PASS\n"
printf "CHRONYD_STATUS=ACTIVE\n"
printf "TIMESYNCD_STATUS=INACTIVE\n"
printf "NTP_LISTENER_ADDRESS=%s:123\n" "$AP_ADDR"
