#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 READ-ONLY L0 capture (owner-run on the
# Core). Changes nothing on the host: every host command goes through the p4_ro
# read-only guard, and the only writes are new evidence files under $EVID_DIR.
#
#   sudo EVID_DIR=~/idea3-p4-evidence/<window>/pre CAPTURE_LABEL=pre \
#        JOURNAL_SINCE='YYYY-MM-DD HH:MM:SS UTC' bash p4-l0-capture.sh
#
# Use the same JOURNAL_SINCE for the before and after captures of one stage, so
# the IDEA2 journal failure-class counts cover comparable windows.
#
# Records are normalized key<TAB>value files, sorted by key, plus SHA256SUMS.
# Secret-bearing files are recorded by metadata only. Journal content is
# reduced to failure-class counts. No password, key, PSK, PIN, token, or
# environment value is written or printed.
#
# Exit 0 = L0_CAPTURE=COMPLETE, 3 = L0_CAPTURE=PARTIAL (a required read was
# unavailable; the evidence is incomparable), 1 = STOP (invalid input).
# shellcheck disable=SC2086  # address lists are split into words on purpose
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p4-lib.sh
. "$HERE/p4-lib.sh"

stop() { printf 'STOP: %s\n' "$*"; exit 1; }

EVID_DIR="${EVID_DIR:-}"
CAPTURE_LABEL="${CAPTURE_LABEL:-}"
JOURNAL_SINCE="${JOURNAL_SINCE:-}"
[ -n "$EVID_DIR" ] || stop "EVID_DIR is required"
[[ "$CAPTURE_LABEL" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || stop "CAPTURE_LABEL must match ^[a-z0-9][a-z0-9-]{0,31}\$"
[[ "$JOURNAL_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\ UTC$ ]] \
  || stop "JOURNAL_SINCE must be 'YYYY-MM-DD HH:MM:SS UTC'"
if [ -e "$EVID_DIR" ]; then
  [ -d "$EVID_DIR" ] || stop "EVID_DIR exists and is not a directory"
  shopt -s nullglob dotglob
  existing=("$EVID_DIR"/*)
  shopt -u nullglob dotglob
  [ "${#existing[@]}" = 0 ] || stop "EVID_DIR is not empty; evidence is never overwritten"
fi

umask 077
mkdir -p "$EVID_DIR/raw" || stop "cannot create EVID_DIR"
P4_LOG_FILE="$EVID_DIR/capture.log"
: > "$P4_LOG_FILE"

REQUIRED_TOOLS="ip sysctl nft ss systemctl journalctl df timedatectl nmcli iw rfkill"
OPTIONAL_TOOLS="chronyc twingate hostnamectl"
SERVICE_UNITS="NetworkManager.service systemd-networkd.service systemd-resolved.service systemd-timesyncd.service
chronyd.service nftables.service mosquitto.service aegis-idea3-mosquitto.service dnsmasq.service hostapd.service wpa_supplicant.service
twingate.service aegis-idea3-core.service aegis-idea3.service aegis-idea3-nftables-load.service aegis-idea3-dnsmasq.service
aegis-idea3-containment.socket aegis-idea3-containment.service"
UNIT_PROPS="LoadState ActiveState SubState UnitFileState MainPID NRestarts Result ExecMainStartTimestamp"
IDEA2_ENGINE_UNIT=aegis-detection-engine.service
IDEA2_TUNNEL_UNIT=aegis-detection-tunnel.service

META="$EVID_DIR/meta.tsv" CAPS="$EVID_DIR/capabilities.tsv" NET="$EVID_DIR/network.tsv"
WIFI="$EVID_DIR/wifi.tsv" FW="$EVID_DIR/firewall.tsv" TIME="$EVID_DIR/time.tsv" MQTT="$EVID_DIR/mqtt.tsv"
IDEA2="$EVID_DIR/idea2.tsv" SVC="$EVID_DIR/services.tsv" LISTEN="$EVID_DIR/listeners.tsv" HOST="$EVID_DIR/host.tsv"
for f in "$META" "$CAPS" "$NET" "$WIFI" "$FW" "$TIME" "$MQTT" "$IDEA2" "$SVC" "$LISTEN" "$HOST"; do : > "$f"; done

partial=0
P4_OUT=""
p4_log "L0 capture start label=$CAPTURE_LABEL evidence=$EVID_DIR (read-only)"

# run_ro REQUIRED RAWNAME cmd...: run a guarded read into P4_OUT. RAWNAME "-"
# keeps no raw copy (used for journal content, which is never stored).
run_ro() {
  local req=$1 raw=$2 out
  shift 2
  P4_OUT=""
  if ! p4_have "$1"; then
    [ "$req" = 1 ] && partial=1
    return 1
  fi
  if out=$(p4_ro "$@" 2>/dev/null); then
    P4_OUT=$out
    [ "$raw" = - ] || printf '%s\n' "$out" > "$EVID_DIR/raw/$raw.txt"
    return 0
  fi
  [ "$req" = 1 ] && partial=1
  return 1
}

text_sha() { printf '%s\n' "$1" | sha256sum | cut -d' ' -f1; }
join_sorted() { printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort | awk 'NR>1{printf ";"} {printf "%s", $0}'; }

# tree_files DIR: host files under DIR (sorted, full paths incl. the test prefix)
tree_files() {
  local d
  d=$(p4_fs "$1")
  [ -d "$d" ] || return 0
  p4_ro find "$d" -xdev -type f 2>/dev/null | LC_ALL=C sort
}

# rec_file TSV PREFIX FULLPATH [meta]: config files get a digest; secret-bearing
# files (or every file when "meta" is given) get metadata only.
rec_file() {
  local tsv=$1 prefix=$2 full=$3 mode=${4:-auto} hp sha meta
  hp=$(p4_hostpath "$full")
  if [ "$mode" = meta ] || p4_is_secret_file "$full"; then
    p4_rec "$tsv" "$prefix.$hp.class" secret-metadata-only
  else
    p4_rec "$tsv" "$prefix.$hp.class" config
    sha=$(p4_sha256 "$full")
    [ "$sha" = UNREADABLE ] && partial=1
    p4_rec "$tsv" "$prefix.$hp.sha256" "$sha"
  fi
  meta=$(p4_meta "$full")
  [ "$meta" = UNREADABLE ] && partial=1
  p4_rec "$tsv" "$prefix.$hp.meta" "$meta"
}

rec_tree() { # TSV PREFIX DIR [meta]
  local f
  while IFS= read -r f; do
    [ -n "$f" ] && rec_file "$1" "$2" "$f" "${4:-auto}"
  done < <(tree_files "$3")
}

# unit_props TSV PREFIX UNIT
unit_props() {
  local tsv=$1 prefix=$2 unit=$3 args=() p v
  for p in $UNIT_PROPS; do args+=(-p "$p"); done
  if run_ro 1 "unit-$unit" systemctl show "${args[@]}" "$unit"; then
    local -A props=()
    while IFS='=' read -r p v; do
      [ -n "$p" ] && [ -z "${props[$p]+set}" ] && props[$p]=$v
    done <<< "$P4_OUT"
    for p in $UNIT_PROPS; do p4_rec "$tsv" "$prefix.$p" "${props[$p]-}"; done
  else
    for p in $UNIT_PROPS; do p4_rec "$tsv" "$prefix.$p" UNAVAILABLE; done
  fi
}

# ── capabilities ─────────────────────────────────────────────────────────────
for t in $REQUIRED_TOOLS $OPTIONAL_TOOLS; do
  if p4_have "$t"; then p4_rec "$CAPS" "cap.$t" available; else p4_rec "$CAPS" "cap.$t" missing; fi
done
for t in $REQUIRED_TOOLS; do p4_have "$t" || partial=1; done

# ── network ──────────────────────────────────────────────────────────────────
IFACE_LIST=""
if run_ro 1 ip-br-addr ip -br addr show; then
  while read -r ifname _ addrs; do
    [ -n "$ifname" ] || continue
    IFACE_LIST="$IFACE_LIST $ifname"
    sorted=$(printf '%s\n' $addrs | sed '/^$/d' | LC_ALL=C sort | tr '\n' ' ')
    p4_rec "$NET" "net.addr.$ifname" "${sorted:-none}"
  done <<< "$P4_OUT"
else
  p4_rec "$NET" net.addr UNAVAILABLE
fi
if run_ro 1 ip-br-link ip -br link show; then
  while read -r ifname state _; do
    [ -n "$ifname" ] || continue
    IFACE_LIST="$IFACE_LIST $ifname"
    p4_rec "$NET" "net.link.$ifname" "$state"
  done <<< "$P4_OUT"
else
  p4_rec "$NET" net.link UNAVAILABLE
fi
for fam in 4 6; do
  if run_ro 1 "ip-$fam-route" ip "-$fam" route show; then
    routes=$(printf '%s\n' "$P4_OUT" | sed -E 's/ expires [0-9]+sec//')
    default=$(join_sorted "$(printf '%s\n' "$routes" | grep '^default' || true)")
    p4_rec "$NET" "net.route$fam.default" "${default:-none}"
    p4_rec "$NET" "net.route$fam.sha256" "$(text_sha "$(printf '%s\n' "$routes" | LC_ALL=C sort)")"
    all_ifaces=$(printf '%s\n' $IFACE_LIST $(printf '%s\n' "$routes" | grep -oE '\bdev [^ ]+' | awk '{print $2}') | sed '/^$/d' | LC_ALL=C sort -u)
    for ifn in $all_ifaces; do
      [ -n "$ifn" ] || continue
      ifroutes=$(printf '%s\n' "$routes" | grep -v '^default' | grep -E "(^|[[:space:]])dev $ifn([[:space:]]|$)" || true)
      if [ -n "$ifroutes" ]; then
        sorted_ifroutes=$(join_sorted "$ifroutes")
        p4_rec "$NET" "net.route$fam.iface.$ifn" "$sorted_ifroutes"
      else
        p4_rec "$NET" "net.route$fam.iface.$ifn" none
      fi
    done
    unscoped=$(printf '%s\n' "$routes" | sed '/^[[:space:]]*$/d' | grep -v '^default' | awk '
      /^(blackhole|unreachable|prohibit|throw)([[:space:]]|$)/ { print; next }
      !/(^|[[:space:]])dev[[:space:]]+[^[:space:]]+/ { print; next }
    ')
    if [ -n "$unscoped" ]; then
      sorted_unscoped=$(join_sorted "$unscoped")
      p4_rec "$NET" "net.route$fam.unscoped" "$sorted_unscoped"
    else
      p4_rec "$NET" "net.route$fam.unscoped" none
    fi
  else
    p4_rec "$NET" "net.route$fam.default" UNAVAILABLE
    p4_rec "$NET" "net.route$fam.sha256" UNAVAILABLE
    p4_rec "$NET" "net.route$fam.unscoped" UNAVAILABLE
  fi
  if run_ro 1 "ip-$fam-rule" ip "-$fam" rule show; then
    p4_rec "$NET" "net.rule$fam.sha256" "$(text_sha "$P4_OUT")"
  else
    p4_rec "$NET" "net.rule$fam.sha256" UNAVAILABLE
  fi
done
for k in net.ipv4.ip_forward net.ipv4.conf.all.forwarding net.ipv6.conf.all.forwarding \
  net.ipv6.conf.default.forwarding; do
  if run_ro 1 "sysctl-$k" sysctl -n "$k" && [[ "$P4_OUT" =~ ^[0-9]+$ ]]; then
    p4_rec "$NET" "sysctl.$k" "$P4_OUT"
  else
    partial=1
    p4_rec "$NET" "sysctl.$k" UNAVAILABLE
  fi
done
[ -f "$(p4_fs /etc/aegis-idea3/dnsmasq-ap.conf)" ] && rec_file "$NET" net.idea3_dnsmasq_conf "$(p4_fs /etc/aegis-idea3/dnsmasq-ap.conf)"
[ -f "$(p4_fs /etc/sysctl.conf)" ] && rec_file "$NET" net.sysctl_conf "$(p4_fs /etc/sysctl.conf)"
rec_tree "$NET" net.sysctl_conf /etc/sysctl.d
resolv_conf="$(p4_fs /etc/resolv.conf)"
if [ -f "$resolv_conf" ] || [ -L "$resolv_conf" ]; then
  rec_file "$NET" net.dns "$resolv_conf"
  ns=$(grep -E '^[[:space:]]*nameserver[[:space:]]+' "$resolv_conf" 2>/dev/null | awk '{print $2}')
  p4_rec "$NET" "net.dns.nameservers" "$(join_sorted "$ns")"
fi

# ── Wi-Fi / AP prerequisites ─────────────────────────────────────────────────
declare -A wifi_ifaces=()
if run_ro 1 iw-dev iw dev; then
  while IFS=$'\t' read -r iface field value; do
    [ -n "$iface" ] && wifi_ifaces["$iface"]=1
    p4_rec "$WIFI" "wifi.iface.$iface.$field" "$value"
  done < <(printf '%s\n' "$P4_OUT" | awk '$1 == "Interface" { i = $2 }
    $1 == "type" && i != "" { print i "\ttype\t" $2 }
    $1 == "channel" && i != "" { print i "\tchannel\t" $2 " " $3 " " $4 }
    $1 == "ssid" && i != "" { print i "\tssid\t" $2 }')
else
  p4_rec "$WIFI" wifi.iface UNAVAILABLE
fi

declare -A iface_rfk_seen=()
sys_net="$(p4_fs /sys/class/net)"
if [ -d "$sys_net" ]; then
  for iface_dir in "$sys_net"/*; do
    [ -d "$iface_dir" ] || continue
    iface="${iface_dir##*/}"
    for rfk in "$iface_dir"/phy80211/rfkill* "$iface_dir"/rfkill*; do
      [ -d "$rfk" ] || continue
      id=$(cat "$rfk/index" 2>/dev/null || true)
      soft_raw=$(cat "$rfk/soft" 2>/dev/null || true)
      hard_raw=$(cat "$rfk/hard" 2>/dev/null || true)
      [ -n "$id" ] || continue
      soft="unblocked"
      [ "$soft_raw" = "1" ] || [ "$soft_raw" = "blocked" ] && soft="blocked"
      hard="unblocked"
      [ "$hard_raw" = "1" ] || [ "$hard_raw" = "blocked" ] && hard="blocked"
      p4_rec "$WIFI" "wifi.rfkill.iface.$iface.id" "$id"
      p4_rec "$WIFI" "wifi.rfkill.iface.$iface.soft" "$soft"
      p4_rec "$WIFI" "wifi.rfkill.iface.$iface.hard" "$hard"
      iface_rfk_seen["$iface"]=1
    done
  done
fi

if run_ro 1 rfkill rfkill --noheadings --output ID,TYPE,SOFT,HARD; then
  if [ "${#iface_rfk_seen[@]}" = 0 ]; then
    while read -r r_id r_type r_soft r_hard; do
      [ -n "$r_id" ] && [ "$r_type" = "wlan" ] || continue
      for iface in "${!wifi_ifaces[@]}"; do
        p4_rec "$WIFI" "wifi.rfkill.iface.$iface.id" "$r_id"
        p4_rec "$WIFI" "wifi.rfkill.iface.$iface.soft" "$r_soft"
        p4_rec "$WIFI" "wifi.rfkill.iface.$iface.hard" "$r_hard"
        iface_rfk_seen["$iface"]=1
      done
    done <<< "$P4_OUT"
  fi
else
  [ "${#iface_rfk_seen[@]}" -gt 0 ] || p4_rec "$WIFI" wifi.rfkill UNAVAILABLE
fi

if run_ro 1 iw-reg iw reg get; then
  global=$(printf '%s\n' "$P4_OUT" | awk '/^global/ { g = 1 } /^country/ && g { sub(":", "", $2); print $2; exit }')
  p4_rec "$WIFI" wifi.reg.global "${global:-none}"
  while IFS=$'\t' read -r phy country; do
    p4_rec "$WIFI" "wifi.reg.$phy" "$country"
  done < <(printf '%s\n' "$P4_OUT" | awk '/^global/ { p = "" } /^phy#/ { p = $1; sub("#", "", p) }
    /^country/ && p != "" { sub(":", "", $2); print p "\t" $2 }')
  p4_rec "$WIFI" wifi.reg.sha256 "$(text_sha "$P4_OUT")"
else
  p4_rec "$WIFI" wifi.reg.global UNAVAILABLE
fi
if run_ro 1 iw-phy iw phy; then
  if printf '%s\n' "$P4_OUT" | grep -qE '^[[:space:]]+\* AP$'; then ap=supported; else ap=not-listed; fi
  p4_rec "$WIFI" wifi.phy.ap_mode "$ap"
  p4_rec "$WIFI" wifi.phy.sha256 "$(text_sha "$P4_OUT")"
else
  p4_rec "$WIFI" wifi.phy.ap_mode UNAVAILABLE
fi
# nmcli is never asked for secrets; connection profiles are metadata only.
if run_ro 1 nmcli-general nmcli -t -f STATE,CONNECTIVITY,WIFI-HW,WIFI general status; then
  p4_rec "$WIFI" nm.general "$(join_sorted "$P4_OUT")"
else
  p4_rec "$WIFI" nm.general UNAVAILABLE
fi

declare -A known_devs=()
if run_ro 1 nmcli-devices nmcli -t -f DEVICE,TYPE,STATE device status; then
  while IFS=':' read -r dev type state; do
    [ -n "$dev" ] || continue
    known_devs["$dev"]=1
    p4_rec "$WIFI" "nm.device.$dev.type" "${type:-unknown}"
    p4_rec "$WIFI" "nm.device.$dev.state" "${state:-unknown}"
  done <<< "$P4_OUT"
else
  p4_rec "$WIFI" nm.device UNAVAILABLE
fi

if run_ro 1 nmcli-active nmcli -t -f NAME,TYPE,DEVICE connection show --active; then
  declare -A active_devs=()
  while IFS=':' read -r name type dev; do
    [ -n "$dev" ] || continue
    active_devs["$dev"]="${name}:${type}"
  done <<< "$P4_OUT"
  for d in $(printf '%s\n' "${!known_devs[@]}" "${!active_devs[@]}" | LC_ALL=C sort -u); do
    [ -n "$d" ] || continue
    p4_rec "$WIFI" "nm.active.device.$d" "${active_devs[$d]:-none}"
  done
else
  p4_rec "$WIFI" nm.active UNAVAILABLE
fi
rec_tree "$WIFI" nm.profile /etc/NetworkManager/system-connections meta

# ── firewall ─────────────────────────────────────────────────────────────────
nft_normalize() { sed -E -e 's/counter packets [0-9]+ bytes [0-9]+/counter/g' -e 's/ # handle [0-9]+//'; }
if run_ro 1 nft-tables nft list tables; then
  tables=$(join_sorted "$P4_OUT")
  p4_rec "$FW" fw.nft.tables "${tables:-none}"
  while read -r word fam name; do
    [ "$word" = table ] || continue
    if [[ "$fam" =~ ^[a-z0-9]+$ ]] && [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] \
      && run_ro 1 "nft-table-$fam-$name" nft --stateless list table "$fam" "$name"; then
      p4_rec "$FW" "fw.nft.table.$fam.$name.sha256" "$(text_sha "$(printf '%s\n' "$P4_OUT" | nft_normalize)")"
    else
      partial=1
      p4_rec "$FW" "fw.nft.table.$fam.$name.sha256" UNAVAILABLE
    fi
  done <<< "$P4_OUT"
else
  p4_rec "$FW" fw.nft.tables UNAVAILABLE
fi
if run_ro 1 nft-ruleset nft --stateless list ruleset; then
  p4_rec "$FW" fw.nft.ruleset.sha256 "$(text_sha "$(printf '%s\n' "$P4_OUT" | nft_normalize)")"
else
  p4_rec "$FW" fw.nft.ruleset.sha256 UNAVAILABLE
fi
if [ -f "$(p4_fs /etc/nftables.conf)" ]; then
  rec_file "$FW" fw.nftables_conf "$(p4_fs /etc/nftables.conf)"
else
  p4_rec "$FW" fw.nftables_conf./etc/nftables.conf absent
fi
rec_tree "$FW" fw.nftables_d /etc/nftables.d
[ -f "$(p4_fs /etc/aegis-idea3/aegis-idea3.nft)" ] && rec_file "$FW" fw.idea3_nft "$(p4_fs /etc/aegis-idea3/aegis-idea3.nft)"

# ── time ─────────────────────────────────────────────────────────────────────
if run_ro 1 timedatectl timedatectl show -p NTP -p NTPSynchronized -p CanNTP -p Timezone; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^(NTP|NTPSynchronized|CanNTP|Timezone)$ ]] && p4_rec "$TIME" "time.$k" "$v"
  done <<< "$P4_OUT"
else
  p4_rec "$TIME" time.NTPSynchronized UNAVAILABLE
fi
if run_ro 0 timesync timedatectl show-timesync -p ServerName -p SystemNTPServers; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^(ServerName|SystemNTPServers)$ ]] && p4_rec "$TIME" "time.timesyncd.$k" "$v"
  done <<< "$P4_OUT"
else
  p4_rec "$TIME" time.timesyncd.ServerName UNAVAILABLE
fi
if p4_have chronyc; then
  if run_ro 0 chronyc-tracking chronyc -n tracking; then
    leap=$(printf '%s\n' "$P4_OUT" | awk -F' : ' '$1 ~ /^Leap status/ { print $2 }')
    p4_rec "$TIME" time.chrony.leap "${leap:-UNAVAILABLE}"
  else
    p4_rec "$TIME" time.chrony.leap UNAVAILABLE
  fi
else
  p4_rec "$TIME" time.chrony.leap not-installed
fi
[ -f "$(p4_fs /etc/systemd/timesyncd.conf)" ] && rec_file "$TIME" time.file "$(p4_fs /etc/systemd/timesyncd.conf)"
rec_tree "$TIME" time.file /etc/systemd/timesyncd.conf.d
[ -f "$(p4_fs /etc/chrony.conf)" ] && rec_file "$TIME" time.file "$(p4_fs /etc/chrony.conf)"
[ -f "$(p4_fs /etc/chrony.keys)" ] && rec_file "$TIME" time.file "$(p4_fs /etc/chrony.keys)" meta

# ── listeners and MQTT ───────────────────────────────────────────────────────
listeners=""
if run_ro 1 ss-listen ss -H -ltnu; then
  listeners=$(printf '%s\n' "$P4_OUT" | awk 'NF >= 5 { print $1 "\t" $5 }' | LC_ALL=C sort -u)
  while IFS=$'\t' read -r netid local; do
    [ -n "$netid" ] && p4_rec "$LISTEN" "listen.$netid.$local" present
  done <<< "$listeners"
  p4_rec "$LISTEN" listen.inventory recorded
else
  p4_rec "$LISTEN" listen.inventory UNAVAILABLE
fi
if run_ro 1 ss-established ss -H -tn state established; then
  read -r c1883 c8883 < <(printf '%s\n' "$P4_OUT" | awk 'NF >= 2 { n = split($(NF-1), a, ":"); p = a[n]
    if (p == "1883") c1++; if (p == "8883") c2++ } END { print c1 + 0, c2 + 0 }')
  p4_rec "$MQTT" mqtt.established.1883.count "$c1883"
  p4_rec "$MQTT" mqtt.established.8883.count "$c8883"
else
  p4_rec "$MQTT" mqtt.established.1883.count UNAVAILABLE
  p4_rec "$MQTT" mqtt.established.8883.count UNAVAILABLE
fi

# Only an allowlist of non-secret directives is extracted; values like bridge
# passwords are never read out. Referenced files are classified like the tree.
MQTT_DIRECTIVES='^(listener|port|bind_address|socket_domain|protocol|allow_anonymous|per_listener_settings|persistence|retain_available|password_file|acl_file|include_dir|cafile|capath|certfile|keyfile|require_certificate|tls_version)$'
conf_files=$(tree_files /etc/mosquitto)
directives=""
if [ -n "$conf_files" ]; then
  while IFS= read -r f; do
    case "$f" in
      *.conf) directives+=$(awk -v re="$MQTT_DIRECTIVES" '$1 ~ re { print $1, $2, $3 }' "$f" 2>/dev/null)$'\n' ;;
    esac
  done <<< "$conf_files"
  p4_rec "$MQTT" mqtt.conf.directives "$(join_sorted "$directives")"
else
  p4_rec "$MQTT" mqtt.conf.directives absent
fi
pwfiles=$(printf '%s\n' "$directives" | awk '$1 == "password_file" { print $2 }' | LC_ALL=C sort -u)
rec_pwfile() {
  local full=$1 hp users sha meta
  hp=$(p4_hostpath "$full")
  if [ -r "$full" ]; then
    users=$(awk -F: 'NF >= 2 && $1 ~ /^[A-Za-z0-9._@-]{1,64}$/ { print $1 }' "$full" | LC_ALL=C sort -u | paste_csv)
    p4_rec "$MQTT" "mqtt.passwd.$hp.users" "${users:-none}"
  else
    p4_rec "$MQTT" "mqtt.passwd.$hp.users" UNREADABLE
    partial=1
  fi
  sha=$(p4_sha256 "$full")
  [ "$sha" = UNREADABLE ] && partial=1
  p4_rec "$MQTT" "mqtt.passwd.$hp.sha256" "$sha"
  meta=$(p4_meta "$full")
  [ "$meta" = UNREADABLE ] && partial=1
  p4_rec "$MQTT" "mqtt.passwd.$hp.meta" "$meta"
}
paste_csv() { awk 'NR > 1 { printf "," } { printf "%s", $0 }'; }
is_pwfile() {
  local hp base
  hp=$(p4_hostpath "$1")
  base=${hp##*/}
  [[ "$base" =~ ^(passwd|pwfile|.*\.passwd|.*\.pwfile)$ ]] && return 0
  printf '%s\n' "$pwfiles" | grep -qxF -- "$hp"
}
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if is_pwfile "$f"; then rec_pwfile "$f"; else rec_file "$MQTT" mqtt.file "$f"; fi
done <<< "$conf_files"
while read -r directive path; do
  [ -n "$path" ] || continue
  case "$path" in /etc/mosquitto/*) continue ;; esac
  full=$(p4_fs "$path")
  if [ ! -e "$full" ]; then p4_rec "$MQTT" "mqtt.ref.$path" absent; continue; fi
  case "$directive" in
    password_file) rec_pwfile "$full" ;;
    keyfile) rec_file "$MQTT" mqtt.ref "$full" meta ;;
    include_dir) rec_tree "$MQTT" mqtt.ref "$path" ;;
    *) [ -f "$full" ] && rec_file "$MQTT" mqtt.ref "$full" ;;
  esac
done < <(printf '%s\n' "$directives" | awk '$1 ~ /^(password_file|acl_file|cafile|certfile|keyfile|include_dir)$/ { print $1, $2 }' | LC_ALL=C sort -u)

# ── IDEA2 preservation (recorded separately; never one health boolean) ───────
TUNNEL_CLASSES="timeout refused auth hostkey forward dns unreachable unit_failed restart_scheduled"
ENGINE_CLASSES="heartbeat_failed refused timeout exception unit_failed restart_scheduled"
journal_classes() { # ROLE UNIT
  local role=$1 unit=$2 combined classes c access=ok counts
  if [ "$role" = tunnel ]; then classes=$TUNNEL_CLASSES; else classes=$ENGINE_CLASSES; fi
  if ! p4_have journalctl; then
    for c in $classes; do p4_rec "$IDEA2" "idea2.$role.journal.$c" UNAVAILABLE; done
    return
  fi
  # stdout lines are prefixed O:, stderr lines E:; only counts leave this function.
  combined=$( { { p4_ro journalctl -u "$unit" --since "$JOURNAL_SINCE" --no-pager -o cat | sed 's/^/O:/'; } \
    2>&1 1>&3 | sed 's/^/E:/'; } 3>&1)
  if printf '%s\n' "$combined" | grep -qiE '^E:.*(not seeing messages|insufficient permissions|no journal files|REFUSED)'; then
    access=limited
  fi
  counts=$(printf '%s\n' "$combined" | awk -v role="$role" '
    /^O:/ { l = tolower(substr($0, 3))
      if (role == "tunnel") {
        if (l ~ /timed out/) n["timeout"]++
        if (l ~ /connection refused/) n["refused"]++
        if (l ~ /permission denied|authentication failed|too many authentication failures/) n["auth"]++
        if (l ~ /host key verification failed|remote host identification has changed/) n["hostkey"]++
        if (l ~ /forwarding failed|cannot listen to port|address already in use/) n["forward"]++
        if (l ~ /could not resolve hostname/) n["dns"]++
        if (l ~ /no route to host|network is unreachable/) n["unreachable"]++
      } else {
        if (l ~ /heartbeat/ && l ~ /fail|error|refused|timed out|timeout/) n["heartbeat_failed"]++
        if (l ~ /connection refused/) n["refused"]++
        if (l ~ /timed out/) n["timeout"]++
        if (l ~ /traceback/) n["exception"]++
      }
      if (l ~ /failed with result/) n["unit_failed"]++
      if (l ~ /scheduled restart job/) n["restart_scheduled"]++
    }
    END { for (c in n) print c "\t" n[c] }')
  for c in $classes; do
    if [ "$access" != ok ]; then
      partial=1
      p4_rec "$IDEA2" "idea2.$role.journal.$c" UNREADABLE
    else
      v=$(printf '%s\n' "$counts" | awk -F '\t' -v c="$c" '$1 == c { print $2 }')
      p4_rec "$IDEA2" "idea2.$role.journal.$c" "${v:-0}"
    fi
  done
}

unit_props "$IDEA2" idea2.engine "$IDEA2_ENGINE_UNIT"
unit_props "$IDEA2" idea2.tunnel "$IDEA2_TUNNEL_UNIT"
journal_classes engine "$IDEA2_ENGINE_UNIT"
journal_classes tunnel "$IDEA2_TUNNEL_UNIT"
p4_rec "$IDEA2" idea2.journal_since "$JOURNAL_SINCE"
listen_state() { # PORT
  if [ -z "$listeners" ]; then echo UNAVAILABLE
  elif printf '%s\n' "$listeners" | awk -F '\t' -v p=":$1" '$1 == "tcp" && substr($2, length($2) - length(p) + 1) == p { f = 1 }
    END { exit !f }'; then echo present
  else echo absent; fi
}
l8077=$(listen_state 8077)
l18002=$(listen_state 18002)
p4_rec "$IDEA2" idea2.listen.8077 "$l8077"
p4_rec "$IDEA2" idea2.listen.18002 "$l18002"
# A heartbeat probe would send an IDEA2 request, so L0 never sends one; the
# result is judged from the listener and the Engine journal instead.
p4_rec "$IDEA2" idea2.heartbeat.probe NOT_PROBED_READ_ONLY

get() { awk -F '\t' -v k="$1" '$1 == k { print $2 }' "$IDEA2"; }
sum_classes() { # ROLE CLASSES -> total, or UNKNOWN
  local total=0 c v
  for c in $2; do
    [ "$c" = restart_scheduled ] && [ "$1" = engine ] && continue
    v=$(get "idea2.$1.journal.$c")
    [[ "$v" =~ ^[0-9]+$ ]] || { echo UNKNOWN; return; }
    total=$((total + v))
  done
  echo "$total"
}
e_active=$(get idea2.engine.ActiveState) t_active=$(get idea2.tunnel.ActiveState)
t_restarts=$(get idea2.tunnel.NRestarts) t_fail=$(sum_classes tunnel "$TUNNEL_CLASSES")
e_hb=$(get idea2.engine.journal.heartbeat_failed) e_refused=$(get idea2.engine.journal.refused)
if [ "$e_active" = UNAVAILABLE ] || [ "$t_active" = UNAVAILABLE ]; then process=UNKNOWN
elif [ "$e_active" = active ] && [ "$t_active" = active ]; then process=YES
else process=NO; fi
if [ "$t_active" = UNAVAILABLE ] || [ "$t_fail" = UNKNOWN ] || [ "$l18002" = UNAVAILABLE ]; then tunnel=UNKNOWN
elif [ "$t_active" != active ] || [ "$t_restarts" != 0 ] || [ "$l18002" != present ] || [ "$t_fail" != 0 ]; then tunnel=NO
else tunnel=NO_FAILURE_OBSERVED; fi
# The runtime verdict is never better than NOT_PROVEN: L0 does not probe a heartbeat.
if [ "$tunnel" = NO ] || { [ "$e_active" != active ] && [ "$e_active" != UNAVAILABLE ]; } || [ "$l8077" = absent ] \
  || [[ "$e_hb" =~ ^[1-9] ]] || [[ "$e_refused" =~ ^[1-9] ]]; then runtime=NO
elif [ "$tunnel" = UNKNOWN ] || [ "$e_active" = UNAVAILABLE ] || [ "$l8077" = UNAVAILABLE ] \
  || ! [[ "$e_hb" =~ ^[0-9]+$ ]]; then runtime=UNKNOWN
else runtime=NOT_PROVEN; fi
p4_rec "$IDEA2" idea2.verdict.process_active "$process"
p4_rec "$IDEA2" idea2.verdict.tunnel_healthy "$tunnel"
p4_rec "$IDEA2" idea2.verdict.runtime_healthy "$runtime"
p4_log "IDEA2 process_active=$process tunnel_healthy=$tunnel runtime_healthy=$runtime (separate verdicts)"

# ── services ─────────────────────────────────────────────────────────────────
for u in $SERVICE_UNITS; do unit_props "$SVC" "svc.$u" "$u"; done

# ── disk / host ──────────────────────────────────────────────────────────────
for path in / /var /opt; do
  name=${path#/}
  name=${name:-root}
  if run_ro 1 "df-$name" df -P -k "$path"; then
    read -r pct avail mountpoint < <(printf '%s\n' "$P4_OUT" | awk 'NR == 2 { sub("%", "", $5); print $5, $4, $6 }')
    p4_rec "$HOST" "disk.$name.use_pct" "${pct:-UNAVAILABLE}"
    p4_rec "$HOST" "disk.$name.avail_kb" "${avail:-UNAVAILABLE}"
    p4_rec "$HOST" "disk.$name.mountpoint" "${mountpoint:-UNAVAILABLE}"
  else
    p4_rec "$HOST" "disk.$name.use_pct" UNAVAILABLE
  fi
done
identity=""
if run_ro 0 hostnamectl hostnamectl --static; then identity=$P4_OUT; fi
if [ -z "$identity" ] && [ -r "$(p4_fs /etc/hostname)" ]; then
  identity=$(grep -vE '^[[:space:]]*(#|$)' "$(p4_fs /etc/hostname)" | head -n 1 | tr -d '[:space:]')
fi
[[ "$identity" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || identity=UNAVAILABLE
p4_rec "$HOST" host.identity "$identity"
if run_ro 0 uname uname -r; then p4_rec "$HOST" host.kernel "$P4_OUT"; else p4_rec "$HOST" host.kernel UNAVAILABLE; fi
boot_id=UNAVAILABLE
if [ -r "$(p4_fs /proc/sys/kernel/random/boot_id)" ]; then
  read -r boot_id < "$(p4_fs /proc/sys/kernel/random/boot_id)" || boot_id=UNAVAILABLE
fi
p4_rec "$HOST" host.boot_id "$boot_id"
if run_ro 0 twingate twingate status; then
  p4_rec "$HOST" host.twingate.status "$(printf '%s\n' "$P4_OUT" | head -n 1)"
else
  p4_rec "$HOST" host.twingate.status UNAVAILABLE
fi
for p in /etc/aegis-idea3 /etc/aegis-idea3/pki /opt/aegis-idea3/current /var/lib/aegis-idea3 /run/aegis-idea3 \
  /var/log/aegis-idea3; do
  if [ -e "$(p4_fs "$p")" ]; then p4_rec "$HOST" "host.path.$p" present; else p4_rec "$HOST" "host.path.$p" absent; fi
done
if [ -L "$(p4_fs /opt/aegis-idea3/current)" ]; then
  if run_ro 0 readlink-current readlink -- "$(p4_fs /opt/aegis-idea3/current)"; then
    p4_rec "$HOST" host.symlink./opt/aegis-idea3/current.target "$P4_OUT"
  else
    p4_rec "$HOST" host.symlink./opt/aegis-idea3/current.target UNAVAILABLE
  fi
else
  p4_rec "$HOST" host.symlink./opt/aegis-idea3/current.target absent
fi
if [ -f "$(p4_fs /etc/systemd/system/aegis-idea3-core.service)" ]; then
  rec_file "$HOST" host.unit_file "$(p4_fs /etc/systemd/system/aegis-idea3-core.service)"
fi
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$(p4_hostpath "$f")" = "/etc/aegis-idea3/aegis-idea3.nft" ] && continue
  [ "$(p4_hostpath "$f")" = "/etc/aegis-idea3/dnsmasq-ap.conf" ] && continue
  rec_file "$HOST" host.aegis_idea3.file "$f" meta
done < <(tree_files /etc/aegis-idea3)

# ── meta, ordering, checksums ────────────────────────────────────────────────
if [ "$partial" = 0 ]; then status=COMPLETE; else status=PARTIAL; fi
p4_rec "$META" meta.schema "$P4_SCHEMA"
p4_rec "$META" meta.label "$CAPTURE_LABEL"
p4_rec "$META" meta.captured_at "$(date -u +%FT%TZ)"
p4_rec "$META" meta.journal_since "$JOURNAL_SINCE"
p4_rec "$META" meta.run_uid "$(id -u)"
p4_rec "$META" meta.capture_status "$status"
p4_rec "$META" meta.production_mutation NO
if [ -n "$P4_FS_ROOT" ]; then
  p4_rec "$META" meta.evidence_class TEST_FIXTURE
  p4_rec "$META" meta.fs_root "$P4_FS_ROOT"
else
  p4_rec "$META" meta.evidence_class CORE_HOST_READ_ONLY
  p4_rec "$META" meta.fs_root none
fi
for f in "$META" "$CAPS" "$NET" "$WIFI" "$FW" "$TIME" "$MQTT" "$IDEA2" "$SVC" "$LISTEN" "$HOST"; do
  p4_sort_records "$f"
done
p4_log "L0_CAPTURE=$status evidence=$EVID_DIR"
(
  cd "$EVID_DIR" || exit 1
  for f in *.tsv capture.log raw/*.txt; do
    [ -f "$f" ] && sha256sum "$f"
  done > SHA256SUMS
)
if [ "$status" = COMPLETE ]; then exit 0; else exit 3; fi
