# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-REBOOT RUNTIME REACTIVATION gate library.
# Sourced by reactivation/l34/{apply,verify,rollback}.sh and by the external owner runner. Nothing here mutates anything:
# every function is a read-only check or a pure formatter. Commands are resolved from PATH so tests can stub them.
#
# RUNTIME_ONLY: this restores the already accepted PERSISTENT L3/L4 configuration to its accepted ACTIVE runtime state. It is not
# an L3/L4 apply, reinstall, profile rewrite or dnsmasq rewrite and never claims L3/L4 live acceptance. Each function returns 0 on
# PASS; on FAIL it prints one stable reason line to stderr and returns 1. Secret material (the Wi-Fi PSK) is never printed.

: "${SUDO=sudo}"

L34_AP_IF=wlp0s20f3
L34_CONN=aegis-idea3-ap
L34_SSID=AEGIS-IDEA3
L34_CHANNEL=6
L34_AP_ADDR=10.77.30.1
L34_AP_PREFIX=28
L34_AP_SUBNET=10.77.30.0/28
L34_DHCP_START=10.77.30.2
L34_DHCP_END=10.77.30.14
L34_DHCP_MASK=255.255.255.240
L34_BROKER_HOST=mqtt.aegis.home.arpa
L34_EXPECTED_RFKILL_ID=1
L34_UNIT=aegis-idea3-dnsmasq.service
L34_PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection
L34_DNSMASQ_CONF=/etc/aegis-idea3/dnsmasq-ap.conf
L34_DNSMASQ_UNIT=/etc/systemd/system/aegis-idea3-dnsmasq.service
L34_NFT_FILE=/etc/aegis-idea3/aegis-idea3.nft

l34_reason() { printf '%s\n' "$1" >&2; return 1; }

# ── persistent accepted configuration (read-only static checks) ─────────────────────────────────────────────────────────

# l34_profile_gate FILE — the accepted persisted AP profile, checked without ever printing its content (it holds the PSK).
l34_profile_gate() {
  local f=$1 ipv4
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_PROFILE_MISSING"; return 1; }
  [ "$(stat -c '%a' "$f")" = 600 ] || { l34_reason "L34_PROFILE_MODE_NOT_0600"; return 1; }
  [ "$(stat -c '%u:%g' "$f")" = "${L34_EXPECT_OWNER:-0:0}" ] || { l34_reason "L34_PROFILE_OWNER_NOT_ROOT"; return 1; }   # tests override the expected owner; live is root:root
  grep -qx 'mode=ap' "$f" || { l34_reason "L34_PROFILE_MODE_NOT_AP"; return 1; }
  ! grep -Eqx 'mode=(infrastructure|adhoc|mesh)' "$f" || { l34_reason "L34_PROFILE_MODE_NOT_AP"; return 1; }
  grep -qx "ssid=$L34_SSID" "$f" || { l34_reason "L34_PROFILE_SSID_MISMATCH"; return 1; }
  grep -qx 'band=bg' "$f" || { l34_reason "L34_PROFILE_BAND_MISMATCH"; return 1; }
  grep -qx "channel=$L34_CHANNEL" "$f" || { l34_reason "L34_PROFILE_CHANNEL_MISMATCH"; return 1; }
  ! grep -Eq '^interface-name=' "$f" || grep -qx "interface-name=$L34_AP_IF" "$f" || { l34_reason "L34_PROFILE_INTERFACE_MISMATCH"; return 1; }
  ipv4=$(awk '/^\[/ { on = ($0 == "[ipv4]"); next } on { print }' "$f")
  grep -qx 'method=manual' <<< "$ipv4" || { l34_reason "L34_PROFILE_IPV4_METHOD_NOT_MANUAL"; return 1; }
  ! grep -Eq 'method=(shared|auto|link-local)' <<< "$ipv4" || { l34_reason "L34_PROFILE_IPV4_METHOD_NOT_MANUAL"; return 1; }
  grep -qx "address1=$L34_AP_ADDR/$L34_AP_PREFIX" <<< "$ipv4" || { l34_reason "L34_PROFILE_ADDRESS_MISMATCH"; return 1; }
  [ "$(grep -c '^address[0-9]*=' <<< "$ipv4")" = 1 ] || { l34_reason "L34_PROFILE_ADDRESS_COUNT"; return 1; }
  grep -qx 'never-default=true' <<< "$ipv4" || { l34_reason "L34_PROFILE_NEVER_DEFAULT_MISSING"; return 1; }
  ! grep -Eq '^method=shared' "$f" || { l34_reason "L34_PROFILE_USES_SHARED_MODE"; return 1; }
}

# l34_profile_effective_gate — the values NetworkManager itself reports (secrets are not requested: no `-s`)
l34_profile_effective_gate() {
  local out want
  out=$(nmcli -g 802-11-wireless.mode,802-11-wireless.ssid,802-11-wireless.band,802-11-wireless.channel,ipv4.method,ipv4.addresses,ipv4.never-default \
    connection show "$L34_CONN" 2>/dev/null) || { l34_reason "L34_PROFILE_EFFECTIVE_UNREADABLE"; return 1; }
  want=$(printf '%s\n' ap "$L34_SSID" bg "$L34_CHANNEL" manual "$L34_AP_ADDR/$L34_AP_PREFIX" yes)
  [ "$out" = "$want" ] || { l34_reason "L34_PROFILE_EFFECTIVE_MISMATCH"; return 1; }
}

# l34_dnsmasq_conf_gate FILE — exactly the accepted L4 directive set: nothing missing, nothing extra (comments/blank ignored)
l34_dnsmasq_conf_gate() {
  local f=$1 line want
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_DNSMASQ_CONF_MISSING"; return 1; }
  [ "$(stat -c '%a' "$f")" = 644 ] || { l34_reason "L34_DNSMASQ_CONF_MODE_NOT_0644"; return 1; }
  local -a wanted=(
    "interface=$L34_AP_IF" "bind-interfaces" "except-interface=lo"
    "dhcp-range=$L34_DHCP_START,$L34_DHCP_END,$L34_DHCP_MASK"
    "dhcp-option=option:router" "dhcp-option=option:dns-server,$L34_AP_ADDR"
    "no-resolv" "no-hosts" "address=/$L34_BROKER_HOST/$L34_AP_ADDR"
  )
  for want in "${wanted[@]}"; do
    [ "$(grep -cxF -- "$want" "$f")" = 1 ] || { l34_reason "L34_DNSMASQ_DIRECTIVE_MISSING_OR_DUPLICATE:${want%%[=,]*}"; return 1; }
  done
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    for want in "${wanted[@]}"; do [ "$line" = "$want" ] && continue 2; done
    l34_reason "L34_DNSMASQ_UNEXPECTED_DIRECTIVE"; return 1
  done < "$f"
}

# l34_dnsmasq_unit_gate FILE EXAMPLE — the installed unit is byte-identical to the accepted repository unit
l34_dnsmasq_unit_gate() {
  [ -f "$1" ] && [ ! -L "$1" ] || { l34_reason "L34_DNSMASQ_UNIT_MISSING"; return 1; }
  cmp -s "$1" "$2" || { l34_reason "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY"; return 1; }
}

# l34_persistent_line FILE — one snapshot record: path, metadata (mode:uid:gid:size:mtime:ctime) and digest. The PSK-bearing profile gets
# metadata plus a digest of its NON-secret lines only (never a digest of secret material).
l34_persistent_line() {
  local f=$1 digest meta
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_PERSISTENT_FILE_MISSING"; return 1; }
  meta=$(stat -c '%a:%u:%g:%s:%Y:%Z' -- "$f")
  case "$f" in
    *.nmconnection) digest=$(grep -viE '^[[:space:]]*(psk|wep-key[0-9]*|leap-password|password|private-key-password|pin)[[:space:]]*=' "$f" | sha256sum | cut -d' ' -f1) ;;
    *) digest=$(sha256sum -- "$f" | cut -d' ' -f1) ;;
  esac
  printf '%s\t%s\t%s\n' "$f" "$meta" "$digest"
}

# l34_persistent_snapshot OUT FILE... — non-secret metadata + digest per accepted persistent file
l34_persistent_snapshot() {
  local out=$1 f line
  shift
  : > "$out"
  for f in "$@"; do
    line=$(l34_persistent_line "$f") || return 1
    printf '%s\n' "$line" >> "$out"
  done
}

# l34_persistent_verify SNAPSHOT — every accepted persistent file byte/metadata-identical to the snapshot
l34_persistent_verify() {
  local snap=$1 rec f cur
  [ -s "$snap" ] || { l34_reason "L34_PERSISTENT_SNAPSHOT_MISSING"; return 1; }
  while IFS= read -r rec; do
    f=${rec%%$'\t'*}
    cur=$(l34_persistent_line "$f") || return 1
    [ "$cur" = "$rec" ] || { l34_reason "L34_PERSISTENT_FILE_CHANGED:${f##*/}"; return 1; }
  done < "$snap"
}

# ── L2 runtime (fresh proof; never mutated) ────────────────────────────────────────────────────────────────────────────────

# l34_l2_text_gate AP_IF < `nft list table inet aegis_idea3`
l34_l2_text_gate() {
  local ap=$1 text
  text=$(cat)
  grep -Eq '^[[:space:]]*table[[:space:]]+inet[[:space:]]+aegis_idea3[[:space:]]*\{' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"; return 1; }
  local -a rules=(
    "udp dport 67|"
    "udp dport 53|ip saddr $L34_AP_SUBNET"
    "tcp dport 53|ip saddr $L34_AP_SUBNET"
    "udp dport 123|ip saddr $L34_AP_SUBNET"
    "tcp dport 8883|ip saddr $L34_AP_SUBNET"
  )
  local r match saddr
  for r in "${rules[@]}"; do
    match=${r%%|*} saddr=${r#*|}
    awk -v ap="$ap" -v m="$match" -v s="$saddr" '
      index($0, "iifname \"" ap "\"") && index($0, m) && (s == "" || index($0, s)) && $0 ~ /accept[[:space:]]*$/ { ok = 1 }
      END { exit !ok }' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:PERMIT_MISSING:${match}"; return 1; }
  done
  awk -v ap="$ap" 'index($0, "iifname \"" ap "\"") && index($0, "tcp dport 1883") && $0 ~ /drop[[:space:]]*$/ { ok = 1 } END { exit !ok }' <<< "$text" \
    || { l34_reason "L2_RUNTIME_NOT_READY=YES:PF01_1883_DROP_MISSING"; return 1; }
  awk -v ap="$ap" '
    /chain[[:space:]]+input[[:space:]]*\{/ { in_in = 1; next }
    in_in && /^[[:space:]]*\}/ { in_in = 0 }
    in_in && $0 ~ ("^[[:space:]]*iifname \"" ap "\"[[:space:]]+(counter[[:space:]]+)?drop[[:space:]]*$") { ok = 1 }
    END { exit !ok }' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:AP_CATCHALL_DROP_MISSING"; return 1; }
  awk -v ap="$ap" '
    /chain[[:space:]]+forward[[:space:]]*\{/ { in_fwd = 1; next }
    in_fwd && /^[[:space:]]*\}/ { in_fwd = 0 }
    in_fwd && $0 ~ ("iifname \"" ap "\"") && $0 ~ /drop[[:space:]]*$/ { ok = 1 }
    END { exit !ok }' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:FORWARD_ISOLATION_MISSING"; return 1; }
  ! grep -Eiq '\b(nat|masquerade|snat|dnat)\b' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"; return 1; }
}

# l34_no_nat_gate < `nft list ruleset` (whole ruleset, every table)
l34_no_nat_gate() {
  local text
  text=$(cat)
  ! grep -Eiq '\b(masquerade|snat|dnat)\b|type[[:space:]]+nat' <<< "$text" || { l34_reason "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"; return 1; }
}

# l34_forwarding_gate AP_IF — all seven forwarding sysctls are 0
l34_forwarding_gate() {
  local k v
  for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv4.conf.default.forwarding "net.ipv4.conf.$1.forwarding" \
    net.ipv6.conf.all.forwarding net.ipv6.conf.default.forwarding "net.ipv6.conf.$1.forwarding"; do
    v=$(sysctl -n "$k" 2>/dev/null) || { l34_reason "L34_FORWARDING_UNREADABLE:$k"; return 1; }
    [ "$v" = 0 ] || { l34_reason "L34_FORWARDING_NOT_ZERO:$k"; return 1; }
  done
}

# ── Wi-Fi / NetworkManager runtime ─────────────────────────────────────────────────────────────────────────────────────────

# l34_ap_target_gate AP_IF — the target interface exists and is currently NOT an active AP with addressing (pre-mutation)
l34_ap_pre_gate() {
  local ap=$1
  [ "$ap" = "$L34_AP_IF" ] || { l34_reason "L34_TARGET_INTERFACE_MUST_BE_WLP0S20F3"; return 1; }
  ip -o link show dev "$ap" >/dev/null 2>&1 || { l34_reason "L34_AP_INTERFACE_MISSING"; return 1; }
  ! iw dev "$ap" info 2>/dev/null | grep -q 'type AP' || { l34_reason "L34_AP_ALREADY_ACTIVE"; return 1; }
  [ -z "$(ip -4 -o addr show dev "$ap" 2>/dev/null)" ] || { l34_reason "L34_AP_INTERFACE_ALREADY_HAS_IPV4"; return 1; }
  [ -z "$(ip route show default dev "$ap" 2>/dev/null)" ] || { l34_reason "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE"; return 1; }
  [ -n "$(ip route show default 2>/dev/null | grep -v "dev $ap")" ] || { l34_reason "L34_NO_ALTERNATE_DEFAULT_ROUTE"; return 1; }
}

# l34_ap_active_gate AP_IF — after reactivation: AP type, exact SSID, exact channel, exact single IPv4, no AP default route
l34_ap_active_gate() {
  local ap=$1 info
  [ "$ap" = "$L34_AP_IF" ] || { l34_reason "L34_TARGET_INTERFACE_MUST_BE_WLP0S20F3"; return 1; }
  info=$(iw dev "$ap" info 2>/dev/null) || { l34_reason "L34_AP_STATE_UNREADABLE"; return 1; }
  [ "$(awk '$1 == "type" { print $2; exit }' <<< "$info")" = AP ] || { l34_reason "L34_AP_NOT_IN_AP_MODE"; return 1; }
  [ "$(awk '$1 == "ssid" { $1 = ""; sub(/^ /, ""); print; exit }' <<< "$info")" = "$L34_SSID" ] || { l34_reason "L34_AP_SSID_MISMATCH"; return 1; }
  [ "$(awk '$1 == "channel" { print $2; exit }' <<< "$info")" = "$L34_CHANNEL" ] || { l34_reason "L34_AP_CHANNEL_MISMATCH"; return 1; }
  [ "$(ip -4 -o addr show dev "$ap" 2>/dev/null | awk '{ print $4 }')" = "$L34_AP_ADDR/$L34_AP_PREFIX" ] || { l34_reason "L34_AP_ADDRESS_MISMATCH"; return 1; }
  [ -z "$(ip -6 -o addr show dev "$ap" scope global 2>/dev/null)" ] || { l34_reason "L34_AP_HAS_GLOBAL_IPV6"; return 1; }
  [ -z "$(ip route show default dev "$ap" 2>/dev/null)" ] || { l34_reason "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE"; return 1; }
}

# l34_rfkill_others_snapshot OUT — every rfkill row (all ids) so the run can prove nothing but the target changed
l34_rfkill_snapshot() { rfkill --noheadings --output ID,TYPE,SOFT,HARD list > "$1" 2>/dev/null || { l34_reason "L34_RFKILL_LIST_UNREADABLE"; return 1; }; }

# l34_rfkill_only_target_changed PRE_FILE TARGET_ID — rows other than TARGET_ID identical to PRE (no global unblock)
l34_rfkill_only_target_changed() {
  local pre=$1 id=$2 now
  now=$(rfkill --noheadings --output ID,TYPE,SOFT,HARD list 2>/dev/null) || { l34_reason "L34_RFKILL_LIST_UNREADABLE"; return 1; }
  [ "$(awk -v i="$id" '$1 != i' "$pre" | tr -s ' ')" = "$(awk -v i="$id" '$1 != i' <<< "$now" | tr -s ' ')" ] || { l34_reason "L34_RFKILL_NON_TARGET_CHANGED"; return 1; }
}

# ── NM global radio decision boundary (V2): topology proof that the global scope is acceptable ─────────────────────────────

# l34_no_wifi_active_gate — no Wi-Fi connection is active except (after reactivation) exactly the approved one on the target
l34_no_wifi_active_gate() {
  local out
  out=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null) || { l34_reason "L34_WIFI_ACTIVE_UNREADABLE"; return 1; }
  ! grep -q '^802-11-wireless' <<< "$out" || { l34_reason "L34_WIFI_ACTIVE_CONNECTION_PRESENT"; return 1; }
}

# l34_wifi_topology_gate AP_IF SYSFS_ROOT — wlp0s20f3 is the ONLY Wi-Fi device (NetworkManager, sysfs) and the ONLY wlan rfkill, so the
# global NM radio flag can affect nothing but the target. Read-only.
l34_wifi_topology_gate() {
  local ap=$1 sysfs=$2 nm n_nm n_sys n_rf
  nm=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null) || { l34_reason "L34_WIFI_TOPOLOGY_UNREADABLE"; return 1; }
  n_nm=$(awk -F: '$2 == "wifi" { n++ } END { print n + 0 }' <<< "$nm")
  [ "$n_nm" = 1 ] && [ "$(awk -F: '$2 == "wifi" { print $1 }' <<< "$nm")" = "$ap" ] || { l34_reason "L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE"; return 1; }
  n_sys=$(find -L "$sysfs/class/net" -mindepth 2 -maxdepth 2 -name phy80211 2>/dev/null | wc -l)
  [ "$n_sys" = 1 ] || { l34_reason "L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE"; return 1; }
  n_rf=$(rfkill --noheadings --output ID,TYPE,SOFT,HARD list 2>/dev/null | awk '$2 == "wlan" { n++ } END { print n + 0 }')
  [ "$n_rf" = 1 ] || { l34_reason "L34_WIFI_TOPOLOGY_RFKILL_WLAN_COUNT"; return 1; }
}

# l34_device_autoconnect AP_IF — prints the runtime (non-persistent) NetworkManager device autoconnect value: yes|no
l34_device_autoconnect() {
  local v
  v=$(nmcli -g GENERAL.AUTOCONNECT device show "$1" 2>/dev/null) || return 1
  case "$v" in yes | no) printf '%s\n' "$v" ;; *) return 1 ;; esac
}

# ── V3 baselines: the two proven, safe starting states ───────────────────────────────────────────────────────────────────

# The P2P inventory is NEVER inferred from an empty typed query: every NetworkManager device that is a Wi-Fi P2P device by TYPE, or that carries the
# p2p pseudo-device name prefix with ANY type, is listed (rows `name:type:state`), so a wrong-typed same-name device or an extra/differently named
# P2P device cannot slip through as "absent".
# l34_nm_status_snapshot — one atomic `nmcli` read (device:type:state rows); everything below derives from the same snapshot text
l34_nm_status_snapshot() { nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null; }
# l34_p2p_inventory < snapshot   — sorted rows of every P2P-related device
l34_p2p_inventory() { awk -F: '$2 == "wifi-p2p" || $1 ~ /^p2p-dev-/ { print }' | LC_ALL=C sort; }
# l34_wifi_devices < snapshot    — names of every TYPE=wifi device
l34_wifi_devices() { awk -F: '$2 == "wifi" { print $1 }' | LC_ALL=C sort; }

L34_P2P_RESIDUAL_ROW="p2p-dev-wlp0s20f3:wifi-p2p:unavailable"
L34_P2P_POST_ROW="p2p-dev-wlp0s20f3:wifi-p2p:disconnected"

# l34_baseline_classify COUNTRY RADIO TARGET_STATE P2P_INVENTORY WIFI_DEVICES < `systemctl show wpa_supplicant.service …`
# Prints FRESH or RESIDUAL, fails on anything else (mixed or unrecognized states are never guessed at). Read-only.
#   FRESH    (post-reboot, before NetworkManager initialized Wi-Fi): phy 00, ZERO P2P-related devices, wpa_supplicant inactive/dead/PID 0
#   RESIDUAL (proven safe-equivalent state left by live attempt 2): phy TH, EXACTLY the row p2p-dev-wlp0s20f3:wifi-p2p:unavailable,
#            wpa_supplicant active/running/PID>0
# Both: wlp0s20f3 is the SOLE TYPE=wifi device, NM radio disabled, target unavailable, wpa_supplicant unit disabled, NRestarts 0, Result success.
l34_baseline_classify() {
  local country=$1 radio=$2 target=$3 p2p=$4 wifidevs=$5 wpa
  wpa=$(cat)
  [ "$wifidevs" = wlp0s20f3 ] || { l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED:WIFI_DEVICE_INVENTORY"; return 1; }
  [ "$radio" = disabled ] || { l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED:NM_RADIO_NOT_DISABLED"; return 1; }
  [ "$target" = unavailable ] || { l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED:TARGET_NOT_UNAVAILABLE"; return 1; }
  for kv in LoadState=loaded UnitFileState=disabled Result=success NRestarts=0; do
    grep -qx "$kv" <<< "$wpa" || { l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED:WPA_${kv%%=*}"; return 1; }
  done
  if [ "$country" = 00 ] && [ -z "$p2p" ] && grep -qx 'ActiveState=inactive' <<< "$wpa" && grep -qx 'SubState=dead' <<< "$wpa" && grep -qx 'MainPID=0' <<< "$wpa"; then
    printf 'FRESH\n'
  elif [ "$country" = TH ] && [ "$p2p" = "$L34_P2P_RESIDUAL_ROW" ] && grep -qx 'ActiveState=active' <<< "$wpa" && grep -qx 'SubState=running' <<< "$wpa" \
    && grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$wpa"; then
    printf 'RESIDUAL\n'
  elif [ -n "$p2p" ] && [ "$p2p" != "$L34_P2P_RESIDUAL_ROW" ]; then
    l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED:P2P_INVENTORY"; return 1
  else
    l34_reason "L34_BASELINE_MIXED_OR_UNRECOGNIZED"; return 1
  fi
}

# l34_wpa_safe_state BASELINE < `systemctl show -p ActiveState -p SubState -p MainPID wpa_supplicant.service`
# The ONLY safe rollback states: FRESH -> exact PRE (inactive/dead/PID 0) or the proven residual (active/running/PID>0); RESIDUAL -> active/running/PID>0.
# failed, activating, deactivating, exited and everything else are unsafe. Never stops or restarts wpa_supplicant.
l34_wpa_safe_state() {
  local baseline=$1 wpa running=0 pre=0
  wpa=$(cat)
  grep -qx 'ActiveState=active' <<< "$wpa" && grep -qx 'SubState=running' <<< "$wpa" && grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$wpa" && running=1
  grep -qx 'ActiveState=inactive' <<< "$wpa" && grep -qx 'SubState=dead' <<< "$wpa" && grep -qx 'MainPID=0' <<< "$wpa" && pre=1
  case "$baseline" in
    FRESH) [ "$running" = 1 ] || [ "$pre" = 1 ] ;;
    RESIDUAL) [ "$running" = 1 ] ;;
    *) false ;;
  esac || { l34_reason "L34_V3_ROLLBACK_WPA_STATE"; return 1; }
}

# l34_p2p_rollback_safe BASELINE P2P_INVENTORY — FRESH: no P2P device OR exactly the unavailable row; RESIDUAL: exactly the unavailable row
l34_p2p_rollback_safe() {
  local baseline=$1 inv=$2
  case "$baseline" in
    FRESH) [ -z "$inv" ] || [ "$inv" = "$L34_P2P_RESIDUAL_ROW" ] ;;
    RESIDUAL) [ "$inv" = "$L34_P2P_RESIDUAL_ROW" ] ;;
    *) false ;;
  esac || { l34_reason "L34_V3_ROLLBACK_P2P_DEVICE_STATE"; return 1; }
}

# l34_nm_devices_listing — sorted `device:type` list of every NetworkManager device (for the "no other new device" envelope check)
l34_nm_devices_listing() { nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null | awk -F: '{ print $1 ":" $2 }' | LC_ALL=C sort; }

# ── dnsmasq service identity ─────────────────────────────────────────────────────────────────────────────────────────────

# l34_service_pre_gate < `systemctl show -p LoadState,ActiveState,SubState,UnitFileState,Result,MainPID …` (KEY=VALUE lines)
# The accepted reactivation input is exactly the observed post-reboot condition: loaded, enabled, failed / start-limit-hit.
l34_service_pre_gate() {
  local text
  text=$(cat)
  for kv in LoadState=loaded ActiveState=failed SubState=failed UnitFileState=enabled Result=start-limit-hit MainPID=0; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_DNSMASQ_PRESTATE_UNEXPECTED:${kv%%=*}"; return 1; }
  done
}

# l34_service_active_gate < `systemctl show …` — POST: active/running with the persistent identity unchanged
l34_service_active_gate() {
  local text
  text=$(cat)
  for kv in LoadState=loaded ActiveState=active SubState=running UnitFileState=enabled Result=success; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_DNSMASQ_NOT_ACTIVE_RUNNING:${kv%%=*}"; return 1; }
  done
  ! grep -qx 'MainPID=0' <<< "$text" || { l34_reason "L34_DNSMASQ_NO_MAINPID"; return 1; }
}

# l34_listener_scope_gate < `ss -H -lnu` + `ss -H -lnt` local addresses — the dnsmasq listener delta is exactly the approved scope
# Input lines: "<proto> <local-address:port>". PRE listeners must be removed by the caller (pass only NEW listeners).
l34_listener_scope_gate() {
  local -a want=("tcp $L34_AP_ADDR:53" "udp $L34_AP_ADDR:53" "udp 0.0.0.0%$L34_AP_IF:67")
  local got expected
  got=$(LC_ALL=C sort -u)
  expected=$(printf '%s\n' "${want[@]}" | LC_ALL=C sort -u)
  [ "$got" = "$expected" ] || { l34_reason "L34_LISTENER_SCOPE_NOT_EXACT"; return 1; }
}

# l34_psk_leak_scan PROFILE EVID — the profile's PSK value must not appear anywhere in the evidence (runs through $SUDO; prints counts)
l34_psk_leak_scan() {
  local profile=$1 evid=$2 py=${3:-python3}
  $SUDO "$py" - "$profile" "$evid" <<'PYC'
import pathlib, re, sys
prof, ev = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
vals = []
for line in prof.read_text(errors="ignore").splitlines():
    m = re.match(r"^\s*(psk|password|wep-key\d*|leap-password)\s*=\s*(.+?)\s*$", line)
    if m and len(m.group(2)) >= 6:
        vals.append(m.group(2))
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    t = f.read_text(errors="ignore")
    if any(v in t for v in vals) or re.search(r"^\s*psk\s*=", t, re.M):
        bad += 1
print(f"PSK_SCAN_FILES={scanned} PSK_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}

# l34_consume_attempt AUTH_DIR — one bounded reactivation attempt per authorization (atomic create-if-absent)
l34_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l34_reason "L34_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L34-REACTIVATION-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then return 0; fi
  l34_reason "L34_ATTEMPT_ALREADY_CONSUMED (one bounded attempt per authorization; obtain a fresh same-day authorization)"
}

# l34_receipt_gate REPO — L3 and L4 historical acceptance receipts from the PINNED commit (never the working tree)
l34_receipt_gate() {
  local repo=${1:-} n logs=Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null || { l34_reason "L34_RECEIPT_GATE_NO_HEAD"; return 1; }
  for n in 3 4; do
    git -C "$repo" grep -qE "L${n}_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$logs" || { l34_reason "L34_PREDECESSOR_RECEIPT_MISSING:L${n}"; return 1; }
  done
}

# ── V4 (POST-L6b/L6c) reactivation: radio/rfkill already ready, exactly one bound NM_UP, L6b broker + dnsmasq already active and
# preserved untouched. Distinct from FRESH/RESIDUAL (l34_baseline_classify): V4 never turns the radio on or off, so it must never
# reuse that classifier — a host that is neither FRESH nor RESIDUAL nor this exact V4 baseline is UNRECOGNIZED and refused. ────────

# l34_v4_baseline_gate RADIO TARGET_STATE WIFI_DEVICES P2P_INVENTORY < `systemctl show -p LoadState,ActiveState,SubState,
#   UnitFileState,Result,MainPID wpa_supplicant.service` (KEY=VALUE lines) — the ONE supported V4 precondition.
l34_v4_baseline_gate() {
  local radio=$1 target=$2 wifidevs=$3 p2p=$4 wpa kv
  wpa=$(cat)
  [ "$wifidevs" = "$L34_AP_IF" ] || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:WIFI_DEVICE_INVENTORY"; return 1; }
  [ "$radio" = enabled ] || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:NM_RADIO_NOT_ENABLED"; return 1; }
  [ "$target" = disconnected ] || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:TARGET_NOT_DISCONNECTED"; return 1; }
  [ -z "$p2p" ] || [ "$p2p" = "$L34_P2P_POST_ROW" ] || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:P2P_INVENTORY"; return 1; }
  for kv in LoadState=loaded UnitFileState=disabled Result=success ActiveState=active SubState=running; do
    grep -qx "$kv" <<< "$wpa" || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:WPA_${kv%%=*}"; return 1; }
  done
  grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$wpa" || { l34_reason "L34_V4_BASELINE_UNRECOGNIZED:WPA_MainPID"; return 1; }
}

# l34_v4_rfkill_ready_gate — the target wlan rfkill row is already unblocked (V4 never mutates rfkill)
l34_v4_rfkill_ready_gate() {
  local row
  row=$(rfkill --noheadings --output ID,TYPE,SOFT,HARD list "$L34_EXPECTED_RFKILL_ID" 2>/dev/null) || { l34_reason "L34_RFKILL_LIST_UNREADABLE"; return 1; }
  [[ "$row" =~ unblocked[[:space:]]+unblocked$ ]] || { l34_reason "L34_V4_RFKILL_NOT_READY"; return 1; }
}

# l34_v4_service_active_gate UNIT < `systemctl show -p LoadState,ActiveState,SubState,UnitFileState,Result,MainPID UNIT` — generic
# "already healthy, already running" gate. Reused for BOTH the L6b broker and dnsmasq: V4 must never start/stop/restart either.
l34_v4_service_active_gate() {
  local unit=$1 text kv
  text=$(cat)
  for kv in LoadState=loaded ActiveState=active SubState=running UnitFileState=enabled Result=success; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_V4_SERVICE_NOT_READY:$unit:${kv%%=*}"; return 1; }
  done
  grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$text" || { l34_reason "L34_V4_SERVICE_NOT_READY:$unit:MainPID"; return 1; }
}

# l34_v4_identity_snapshot UNIT OUT — MainPID + NRestarts only, for an exact later preservation proof
l34_v4_identity_snapshot() {
  systemctl show -p MainPID -p NRestarts "$1" > "$2" 2>/dev/null || { l34_reason "L34_V4_IDENTITY_UNREADABLE:$1"; return 1; }
}

# l34_v4_identity_unchanged UNIT SNAPSHOT_FILE — MainPID/NRestarts byte-identical to the snapshot (never restarted)
l34_v4_identity_unchanged() {
  local unit=$1 pre=$2 now
  now=$(systemctl show -p MainPID -p NRestarts "$unit" 2>/dev/null) || { l34_reason "L34_V4_IDENTITY_UNREADABLE:$unit"; return 1; }
  [ "$(cat "$pre")" = "$now" ] || { l34_reason "L34_V4_IDENTITY_CHANGED:$unit"; return 1; }
}

# l34_v4_broker_listeners_gate AP_ADDR — exactly the two approved 8883 listeners are present (never created by V4, only verified)
l34_v4_broker_listeners_gate() {
  local ap=$1 got
  got=$(ss -H -ltn "sport = :8883" 2>/dev/null | awk '{ print $4 }' | LC_ALL=C sort -u | paste -sd,)
  [ "$got" = "$ap:8883,127.0.0.1:8883" ] || [ "$got" = "127.0.0.1:8883,$ap:8883" ] || { l34_reason "L34_V4_BROKER_LISTENERS_INVALID"; return 1; }
}

# l34_v4_dnsmasq_listeners_gate AP_IF AP_ADDR — the exact three approved dnsmasq listeners are present (never created by V4)
l34_v4_dnsmasq_listeners_gate() {
  local ap=$1 addr=$2 tcp udp
  tcp=$(ss -H -lnt 2>/dev/null | awk '{ print $4 }')
  udp=$(ss -H -lnu 2>/dev/null | awk '{ print $4 }')
  grep -qx "$addr:53" <<< "$tcp" || { l34_reason "L34_V4_DNSMASQ_LISTENERS_INVALID:TCP53"; return 1; }
  grep -qx "$addr:53" <<< "$udp" || { l34_reason "L34_V4_DNSMASQ_LISTENERS_INVALID:UDP53"; return 1; }
  grep -qx "0.0.0.0%$ap:67" <<< "$udp" || { l34_reason "L34_V4_DNSMASQ_LISTENERS_INVALID:UDP67"; return 1; }
}

# l34_v4_ap_profile_autoconnect — the persisted profile's OWN connection.autoconnect value (never modified by V4, only read)
l34_v4_ap_profile_autoconnect() {
  nmcli -g connection.autoconnect connection show "$L34_CONN" 2>/dev/null
}

# l34_v4_autoconnect_pre_gate DEVICE_VALUE AP_PROFILE_VALUE — the ONE supported PRE autoconnect state
l34_v4_autoconnect_pre_gate() {
  [ "$1" = yes ] || { l34_reason "L34_V4_AUTOCONNECT_UNEXPECTED:DEVICE=$1"; return 1; }
  [ "$2" = no ] || { l34_reason "L34_V4_AUTOCONNECT_UNEXPECTED:AP_PROFILE=$2"; return 1; }
}

# ── V5 (POST-L6b/L6c DEGRADED post-reboot) reactivation: SAME wifi/rfkill/radio/wpa topology as V4
# (l34_v4_baseline_gate is reused verbatim — V5 never duplicates it), but dnsmasq is in the exact V3
# post-reboot failed/start-limit-hit precondition (l34_service_pre_gate, reused verbatim from V3) AND the
# L6b broker is crash-looping (auto-restarting) because its AP-facing listener cannot bind while the AP
# address is absent. Neither V3 (requires NM radio disabled) nor V4 (requires dnsmasq AND the broker
# already active/running) accepts this host state; V5 is a new, narrowly-scoped sibling that recovers
# dnsmasq the exact V3 way (reset-failed + start, once) and then only WAITS, bounded, for the broker to
# recover through its own already-configured systemd auto-restart once the AP address exists — it never
# issues start/stop/restart/reset-failed against the broker unit. ─────────────────────────────────────────

L34_V5_BROKER_CONF=/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf

# l34_v5_broker_crashloop_gate JOURNAL_TAIL_FILE < `systemctl show -p LoadState -p ActiveState -p SubState
#   -p UnitFileState -p Result -p MainPID aegis-idea3-mosquitto.service` — the ONE supported V5 broker
# PRE-state: enabled, most recent run ended in a plain non-zero exit (not signal-killed, not OOM-killed, not
# timed out, not a start-limit-hit permanent failure), currently between auto-restart attempts (MainPID=0).
# systemd's own unit state CANNOT by itself distinguish "crash-looping because its AP-facing bind address is
# absent" from an unrelated broker failure (a bad TLS cert, an ACL/passwd permission error, a malformed
# config) — those produce the IDENTICAL LoadState/ActiveState/SubState/UnitFileState/Result/MainPID tuple.
# JOURNAL_TAIL_FILE (a bounded, read-only `journalctl -u aegis-idea3-mosquitto.service -n <N> --no-pager`
# capture produced by the caller; this function only inspects it, never invokes journalctl itself) must
# contain the broker's own exact bind-failure signature, the one piece of evidence that actually narrows the
# cause to the intended baseline.
l34_v5_broker_crashloop_gate() {
  local journal=${1:-} text kv
  [ -n "$journal" ] && [ -r "$journal" ] || { l34_reason "L34_V5_BROKER_JOURNAL_UNREADABLE"; return 1; }
  text=$(cat)
  for kv in LoadState=loaded ActiveState=activating SubState=auto-restart UnitFileState=enabled Result=exit-code; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_V5_BROKER_PRESTATE_UNEXPECTED:${kv%%=*}"; return 1; }
  done
  grep -qx 'MainPID=0' <<< "$text" || { l34_reason "L34_V5_BROKER_PRESTATE_UNEXPECTED:MainPID"; return 1; }
  grep -qF 'Error: Cannot assign requested address' "$journal" \
    || { l34_reason "L34_V5_BROKER_JOURNAL_SIGNATURE_MISSING"; return 1; }
}

# l34_v5_broker_autorestart_evidence UNIT PRE_IDENTITY_FILE — the real, positive evidence backing V5's claim
# that the broker recovered through its OWN systemd auto-restart: NRestarts strictly increased from the PRE
# snapshot (l34_v4_identity_snapshot, reused verbatim). systemd increments NRestarts only for an automatic
# restart the service manager performs under the unit's own Restart= setting; a manual `systemctl
# start`/`restart` does NOT increment it. This proves at least one genuine automatic restart occurred in the
# window — it does NOT, and cannot, prove that no external actor also issued a command during that same
# window, so callers must not claim more than that.
l34_v5_broker_autorestart_evidence() {
  local unit=$1 pre=$2 pre_n now_n
  [ -f "$pre" ] || { l34_reason "L34_V5_BROKER_IDENTITY_PRE_MISSING"; return 1; }
  pre_n=$(awk -F= '$1 == "NRestarts" { print $2 }' "$pre")
  now_n=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null) || { l34_reason "L34_V5_BROKER_IDENTITY_UNREADABLE:$unit"; return 1; }
  [[ "$pre_n" =~ ^[0-9]+$ ]] && [[ "$now_n" =~ ^[0-9]+$ ]] || { l34_reason "L34_V5_BROKER_NRESTARTS_UNREADABLE"; return 1; }
  [ "$now_n" -gt "$pre_n" ] || { l34_reason "L34_V5_BROKER_NRESTARTS_DID_NOT_INCREASE"; return 1; }
}

# ── V6 (STALE-BROKER / AP-DOWN) reactivation: the L6b broker is ALREADY active/running and stable, holding the exact stale 8883 pair
# (127.0.0.1:8883 and 10.77.30.1:8883, the latter bound before the AP address disappeared), while the AP address is absent and
# aegis-idea3-dnsmasq.service is cleanly inactive/dead (NOT failed, so no reset-failed on the normal path). V6 brings the AP up and
# starts dnsmasq, proves the broker TLS path with ONE handshake-only probe, and NEVER issues any command against the broker: it
# only proves, before and after, that the broker's (MainPID, NRestarts, InvocationID) tuple is exactly the PRE tuple. V1–V5 functions
# above are unchanged; nothing in this section is reachable from a V1–V5 handler. ─────────────────────────────────────────────────

L34_V6_BROKER_UNIT="aegis-idea3-mosquitto.service"
L34_V6_BROKER_CONF=$L34_V5_BROKER_CONF
L34_V6_CA_FILE=/etc/aegis-idea3/mqtt/ca.crt
L34_V6_STABLE_SAMPLES=3
L34_V6_SOAK_SAMPLES=6
L34_V6_PROBE_CMD=""

# l34_v6_unit_props UNIT — the KEY=VALUE tuple every service gate consumes
l34_v6_unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }

# l34_v6_dnsmasq_pre_gate < `systemctl show …` — the ONE supported V6 dnsmasq state (also the exact state rollback must restore)
l34_v6_dnsmasq_pre_gate() {
  local text kv
  text=$(cat)
  for kv in LoadState=loaded UnitFileState=enabled ActiveState=inactive SubState=dead Result=success MainPID=0; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:${kv%%=*}"; return 1; }
  done
}

# l34_v6_broker_tuple UNIT — three KEY=VALUE lines, always in this order: MainPID, NRestarts, InvocationID (read-only)
l34_v6_broker_tuple() {
  local unit=$1 k v
  for k in MainPID NRestarts InvocationID; do
    v=$(systemctl show -p "$k" --value "$unit" 2>/dev/null) || { l34_reason "L34_V6_BROKER_TUPLE_UNREADABLE:$k"; return 1; }
    [ -n "$v" ] || { l34_reason "L34_V6_BROKER_TUPLE_UNREADABLE:$k"; return 1; }
    printf '%s=%s\n' "$k" "$v"
  done
}

# l34_v6_broker_tuple_wellformed FILE — a live broker has a real PID, a numeric restart count and a 32-hex systemd invocation id
l34_v6_broker_tuple_wellformed() {
  grep -Eqx 'MainPID=[1-9][0-9]*' "$1" && grep -Eqx 'NRestarts=[0-9]+' "$1" && grep -Eqx 'InvocationID=[0-9a-f]{32}' "$1" \
    || { l34_reason "L34_V6_BROKER_TUPLE_MALFORMED"; return 1; }
}

# l34_v6_broker_stable_gate UNIT OUT SAMPLES INTERVAL — SAMPLES reads INTERVAL seconds apart, all identical and well-formed; the first is
# written to OUT and is the PRE tuple everything later is compared to.
l34_v6_broker_stable_gate() {
  local unit=$1 out=$2 n=$3 interval=$4 i cur
  for ((i = 1; i <= n; i++)); do
    cur=$(l34_v6_broker_tuple "$unit") || return 1
    if [ "$i" = 1 ]; then
      printf '%s\n' "$cur" > "$out"
      l34_v6_broker_tuple_wellformed "$out" || return 1
    else
      [ "$cur" = "$(cat "$out")" ] || { l34_reason "L34_V6_BROKER_TUPLE_UNSTABLE:sample=$i"; return 1; }
    fi
    [ "$i" -lt "$n" ] && sleep "$interval"
  done
  return 0
}

# l34_v6_broker_tuple_equal UNIT PRE_FILE — the broker tuple is exactly the PRE tuple (never restarted, replaced or re-invoked)
l34_v6_broker_tuple_equal() {
  local now
  [ -s "$2" ] || { l34_reason "L34_V6_BROKER_TUPLE_PRE_MISSING"; return 1; }
  now=$(l34_v6_broker_tuple "$1") || return 1
  [ "$now" = "$(cat "$2")" ] || { l34_reason "L34_V6_BROKER_TUPLE_CHANGED"; return 1; }
}

# l34_v6_broker_preserved_gate UNIT PRE_FILE AP_ADDR — the complete broker-preservation proof used after every mutation and by rollback:
# active/running/success/enabled, tuple == PRE, exact stale/live 8883 pair. Read-only; it can only report, never repair.
l34_v6_broker_preserved_gate() {
  local unit=$1 pre=$2 addr=$3
  l34_v6_unit_props "$unit" | l34_v4_service_active_gate "$unit" || return 1
  l34_v6_broker_tuple_equal "$unit" "$pre" || return 1
  l34_v4_broker_listeners_gate "$addr" || return 1
}

# l34_v6_ap_address_absent_gate — the AP address is on NO interface and no route is bound to the AP interface
l34_v6_ap_address_absent_gate() {
  local ap=$1 addr=$2 rows
  rows=$(ip -4 -o addr show 2>/dev/null) || { l34_reason "L34_V6_ADDRESS_LIST_UNREADABLE"; return 1; }
  ! awk '{ print $4 }' <<< "$rows" | grep -q "^${addr//./\\.}/" || { l34_reason "L34_V6_AP_ADDRESS_PRESENT"; return 1; }
  [ -z "$(ip route show dev "$ap" 2>/dev/null)" ] || { l34_reason "L34_V6_AP_ROUTE_PRESENT"; return 1; }
}

# l34_v6_no_ap_dns_dhcp_gate AP_IF AP_ADDR — no DNS/DHCP listener exists on the AP address/interface (no DHCP server anywhere)
l34_v6_no_ap_dns_dhcp_gate() {
  local ap=$1 addr=$2 tcp udp rows
  tcp=$(ss -H -lnt 2>/dev/null) && udp=$(ss -H -lnu 2>/dev/null) || { l34_reason "L34_V6_LISTENERS_UNREADABLE"; return 1; }
  rows=$(printf '%s\n%s\n' "$tcp" "$udp" | awk 'NF { print $4 }')
  if grep -Eq "^${addr//./\\.}:(53|67)\$|%${ap}:(53|67)\$|:67\$|^(0\\.0\\.0\\.0|\\*|\\[::\\]):53\$" <<< "$rows"; then
    l34_reason "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"; return 1
  fi
}

# l34_v6_legacy_1883_rows — every plaintext :1883 TCP listener as "<state> <backlog> <local-address>", sorted, on stdout. An EMPTY result is
# legal (legacy mosquitto may be absent); a listener on the AP address is never legal.
l34_v6_legacy_1883_rows() {
  local rows out
  rows=$(ss -H -lnt 2>/dev/null) || { l34_reason "L34_V6_LISTENERS_UNREADABLE"; return 1; }
  out=$(awk '$4 ~ /:1883$/ { print $1, $3, $4 }' <<< "$rows" | LC_ALL=C sort)
  ! grep -q " ${L34_AP_ADDR//./\\.}:1883\$" <<< "$out" || { l34_reason "L34_V6_PLAINTEXT_1883_ON_AP"; return 1; }
  [ -z "$out" ] || printf '%s\n' "$out"
}

# l34_v6_legacy_1883_snapshot OUT — record the PRE rows (possibly none) in OUT
l34_v6_legacy_1883_snapshot() {
  local rows
  rows=$(l34_v6_legacy_1883_rows) || return 1
  if [ -n "$rows" ]; then printf '%s\n' "$rows" > "$1"; else : > "$1"; fi
}

# l34_v6_legacy_1883_unchanged PRE_FILE — identical to the PRE snapshot: nothing removed, changed or added (V6 never controls legacy mosquitto)
l34_v6_legacy_1883_unchanged() {
  local now
  now=$(l34_v6_legacy_1883_rows) || return 1
  [ "$now" = "$(cat "$1")" ] || { l34_reason "L34_V6_LEGACY_1883_CHANGED"; return 1; }
}

# l34_v6_tls_probe PYTHON P4_DIR REPO_ROOT TIMEOUT — exactly ONE handshake-only probe to the AP broker address through the UNCHANGED
# p4-l7-broker-probe.py (chain + hostname + TLS>=1.2, no MQTT bytes, no credential read). L34_V6_PROBE_CMD replaces the interpreter+script
# and is set only by the fixture-mode handlers; live handlers force it empty. Prints the probe PASS line on success.
l34_v6_tls_probe() {
  local py=$1 p4=$2 repo=$3 tmo=$4 out rc
  local -a cmd
  if [ -n "$L34_V6_PROBE_CMD" ]; then cmd=("$L34_V6_PROBE_CMD"); else cmd=("$py" "$p4/p4-l7-broker-probe.py"); fi
  out=$(env AEGIS_LOG_PATH=/dev/null timeout "$tmo" "${cmd[@]}" tls --address "$L34_AP_ADDR" --port 8883 --server-name "$L34_BROKER_HOST" \
    --ca-file "$L34_V6_CA_FILE" --repo-root "$repo" 2>&1)
  rc=$?
  [ "$rc" != 124 ] || { l34_reason "L34_V6_TLS_PROBE_TIMEOUT"; return 1; }
  if [ "$rc" != 0 ]; then
    l34_reason "L34_V6_TLS_PROBE_FAILED:$(sed -n 's/.*reason=//p' <<< "$out" | head -n 1)"; return 1
  fi
  grep -Eqx 'L7_BROKER_TLS_PROBE=PASS tls=TLSv1\.[23]' <<< "$out" || { l34_reason "L34_V6_TLS_PROBE_NOT_PASS"; return 1; }
  grep -Ex 'L7_BROKER_TLS_PROBE=PASS tls=TLSv1\.[23]' <<< "$out"
}

# l34_v6_soak_sample AP_IF ROUTE_PRE_FILE BROKER_PRE_FILE — one full soak sample (read-only)
l34_v6_soak_sample() {
  local ap=$1 route=$2 pre=$3
  l34_ap_active_gate "$ap" || return 1
  [ "$(ip route show default)" = "$(cat "$route")" ] || { l34_reason "L34_DEFAULT_ROUTE_CHANGED"; return 1; }
  l34_v6_unit_props "$L34_UNIT" | l34_service_active_gate || return 1
  l34_v4_dnsmasq_listeners_gate "$ap" "$L34_AP_ADDR" || return 1
  l34_v6_broker_preserved_gate "$L34_V6_BROKER_UNIT" "$pre" "$L34_AP_ADDR" || return 1
}

# l34_v6_soak AP_IF ROUTE_PRE_FILE BROKER_PRE_FILE SAMPLES INTERVAL — SAMPLES consecutive samples INTERVAL seconds apart; first failure stops it
l34_v6_soak() {
  local ap=$1 route=$2 pre=$3 n=$4 interval=$5 i why
  for ((i = 1; i <= n; i++)); do
    why=$(l34_v6_soak_sample "$ap" "$route" "$pre" 2>&1 >/dev/null) || { l34_reason "L34_V6_SOAK_FAILED:sample=$i:$(head -n 1 <<< "$why")"; return 1; }
    printf 'L34_V6_SOAK_SAMPLE=%s PASS\n' "$i"
    [ "$i" -lt "$n" ] && sleep "$interval"
  done
  return 0
}

# ── V7 (RADIO-DISABLED + BROKER-CHURN) reactivation: the target phy is soft-blocked, the NetworkManager Wi-Fi radio is disabled, wlp0s20f3 is
# unavailable, dnsmasq is failed/start-limit-hit and the L6b broker is crash-looping through its OWN systemd Restart=on-failure because the AP
# address 10.77.30.1 does not exist. V1–V3 own the rfkill/radio head (their owner runner also demands the broker inactive); V4–V6 demand the radio
# already enabled. V7 reuses the V3 head (exact-ID rfkill unblock, autoconnect guard, ONE radio enable, bounded ready-wait, ifname-bound activation)
# and the V5 tail (dnsmasq reset-failed+start, then a READ-ONLY wait for the broker's own auto-restart), under a stricter broker-churn contract.
# Broker churn is NOT a bypass: it is accepted only when every one of the facts below holds together. V1–V6 functions above are unchanged and
# nothing in this section is reachable from a V1–V6 handler. ─────────────────────────────────────────────────────────────────────────────────

L34_V7_BROKER_UNIT="aegis-idea3-mosquitto.service"
L34_V7_CORE_UNIT="aegis-idea3-core.service"
L34_V7_BROKER_CONF=$L34_V5_BROKER_CONF
L34_V7_STABLE_SAMPLES=4
L34_V7_RESTART_USEC=5s
L34_V7_PROBE_CMD=""
L34_V7_BIND_SIGNATURE='Error: Cannot assign requested address'

# l34_v7_broker_show UNIT — the KEY=VALUE tuple the churn contract consumes (read-only)
l34_v7_broker_show() {
  systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts -p ExecMainStatus -p Restart -p RestartUSec -p InvocationID "$1"
}

# l34_v7_broker_journal_capture UNIT SHOW_FILE OUT — bounded, READ-ONLY journal tail bound to the CURRENT boot and to the failed broker's own systemd
# InvocationID (taken from the SAME `l34_v7_broker_show` capture the churn gate reads, so both see one identity). The first line of OUT records that
# binding; l34_v7_broker_churn_gate refuses any journal whose binding line does not match. Anything from a previous boot or an earlier invocation is
# excluded by journalctl itself (-b plus the _SYSTEMD_INVOCATION_ID field match), never by text heuristics.
l34_v7_broker_journal_capture() {
  local unit=$1 show=$2 out=$3 inv
  inv=$(sed -n 's/^InvocationID=//p' "$show")
  [[ "$inv" =~ ^[0-9a-f]{32}$ ]] || { l34_reason "L34_V7_BROKER_INVOCATION_ID_INVALID"; return 1; }
  { printf '# AEGIS-V7-CORRELATION boot=current unit=%s invocation=%s\n' "$unit" "$inv"
    journalctl -u "$unit" -b "_SYSTEMD_INVOCATION_ID=$inv" -n 30 --no-pager 2>&1; } > "$out" \
    || { l34_reason "L34_V7_BROKER_JOURNAL_UNREADABLE"; return 1; }
}

# l34_v7_broker_conf_gate FILE — the broker configuration is the proven listener pair and nothing wider: among the ACTIVE directives exactly
# `listener 8883 127.0.0.1` and `listener 8883 10.77.30.1`, no other listener, and no global port/bind_address. It is only READ; V7 never edits it.
l34_v7_broker_conf_gate() {
  local f=$1 active
  [ -f "$f" ] && [ ! -L "$f" ] || { l34_reason "L34_V7_BROKER_CONF_MISSING"; return 1; }
  active=$(grep -Ev '^[[:space:]]*(#|$)' "$f" | awk '{ $1 = $1; print }' | grep -E '^(listener|listeners|port|bind_address)( |$)' | LC_ALL=C sort)
  [ "$active" = "$(printf '%s\n' "listener 8883 $L34_AP_ADDR" "listener 8883 127.0.0.1" | LC_ALL=C sort)" ] \
    || { l34_reason "L34_V7_BROKER_CONF_LISTENERS_NOT_EXPECTED"; return 1; }
}

# l34_v7_broker_churn_gate JOURNAL_TAIL_FILE < `l34_v7_broker_show UNIT` — the ONE supported broker PRE-state. systemd state alone cannot tell "crash-looping
# because 10.77.30.1 is absent" from any other crash loop, so ALL of these must hold together: loaded+enabled unit, Restart=on-failure with the expected
# RestartUSec, a non-empty valid InvocationID whose current-boot journal (l34_v7_broker_journal_capture) is the only evidence considered, currently
# between automatic restarts (activating/auto-restart, MainPID=0), last run ended in a plain exit status 1 (Result=exit-code;
# not a signal, OOM, timeout or start-limit-hit), a numeric restart counter, the broker's own bind-failure signature in the bounded journal tail, and
# NO other `Error:` line in that tail (a second, unrelated failure signature refuses the baseline).
l34_v7_broker_churn_gate() {
  local journal=${1:-} text kv inv
  [ -n "$journal" ] && [ -r "$journal" ] || { l34_reason "L34_V7_BROKER_JOURNAL_UNREADABLE"; return 1; }
  text=$(cat)
  inv=$(sed -n 's/^InvocationID=//p' <<< "$text")
  [[ "$inv" =~ ^[0-9a-f]{32}$ ]] || { l34_reason "L34_V7_BROKER_INVOCATION_ID_INVALID"; return 1; }
  [ "$(head -n 1 "$journal")" = "# AEGIS-V7-CORRELATION boot=current unit=$L34_V7_BROKER_UNIT invocation=$inv" ] \
    || { l34_reason "L34_V7_BROKER_JOURNAL_NOT_CORRELATED"; return 1; }
  for kv in LoadState=loaded ActiveState=activating SubState=auto-restart UnitFileState=enabled Result=exit-code MainPID=0 ExecMainStatus=1 \
    Restart=on-failure "RestartUSec=$L34_V7_RESTART_USEC"; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_V7_BROKER_PRESTATE_UNEXPECTED:${kv%%=*}"; return 1; }
  done
  grep -Eqx 'NRestarts=[0-9]+' <<< "$text" || { l34_reason "L34_V7_BROKER_PRESTATE_UNEXPECTED:NRestarts"; return 1; }
  grep -qF "$L34_V7_BIND_SIGNATURE" "$journal" || { l34_reason "L34_V7_BROKER_JOURNAL_SIGNATURE_MISSING"; return 1; }
  ! grep -F 'Error:' "$journal" | grep -vqF "$L34_V7_BIND_SIGNATURE" || { l34_reason "L34_V7_BROKER_JOURNAL_OTHER_ERROR"; return 1; }
}

# l34_v7_no_8883_listener_gate — no TLS listener of any kind exists (the churning broker cannot have bound one, and nothing else may hold 8883)
l34_v7_no_8883_listener_gate() {
  local rows
  rows=$(ss -H -ltn "sport = :8883" 2>/dev/null) || { l34_reason "L34_V7_LISTENERS_UNREADABLE"; return 1; }
  [ -z "$rows" ] || { l34_reason "L34_V7_UNEXPECTED_8883_LISTENER"; return 1; }
}

# l34_v7_core_gate < `systemctl show -p LoadState,ActiveState,SubState,Result,MainPID UNIT` — Core is active/running with a real PID
l34_v7_core_gate() {
  local text kv
  text=$(cat)
  for kv in LoadState=loaded ActiveState=active SubState=running Result=success; do
    grep -qx "$kv" <<< "$text" || { l34_reason "L34_V7_CORE_NOT_HEALTHY:${kv%%=*}"; return 1; }
  done
  grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$text" || { l34_reason "L34_V7_CORE_NOT_HEALTHY:MainPID"; return 1; }
}

# l34_v7_core_unchanged UNIT PRE_FILE — Core's (MainPID, NRestarts, InvocationID) tuple is exactly the PRE tuple (never restarted or re-invoked)
l34_v7_core_unchanged() {
  local now
  [ -s "$2" ] || { l34_reason "L34_V7_CORE_TUPLE_PRE_MISSING"; return 1; }
  now=$(l34_v6_broker_tuple "$1" 2>/dev/null) || { l34_reason "L34_V7_CORE_CHANGED:UNREADABLE"; return 1; }
  [ "$now" = "$(cat "$2")" ] || { l34_reason "L34_V7_CORE_CHANGED"; return 1; }
}

# l34_v7_broker_stable_gate UNIT OUT SAMPLES INTERVAL — after the broker recovered on its own: SAMPLES identical, well-formed (MainPID, NRestarts,
# InvocationID) reads INTERVAL seconds apart. A broker that keeps restarting changes the tuple and is refused. Read-only.
l34_v7_broker_stable_gate() {
  local why
  why=$(l34_v6_broker_stable_gate "$@" 2>&1 >/dev/null) || { l34_reason "L34_V7_BROKER_NOT_STABLE:$(head -n 1 <<< "$why")"; return 1; }
}
