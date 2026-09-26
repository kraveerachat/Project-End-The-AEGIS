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
