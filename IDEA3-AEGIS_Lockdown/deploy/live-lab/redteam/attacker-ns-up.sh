#!/usr/bin/env bash
# Bring up the lab's simulated attacker host: a Linux network namespace "aegis-att", connected to this machine by
# one veth pair (host side aegis-att-h, namespace side aegis-att-n). Network plumbing and a reachability guard
# ONLY -- this script contains no attack tooling (no nmap, hydra, hping3 or metasploit). Those are run BY HAND
# from inside the namespace once it is up; see review/redteam/README.md.
#   sudo ~/aegis-live-run/review/redteam/attacker-ns-up.sh   (or this copy under deploy/live-lab/redteam/)
# Undo everything: sudo .../attacker-ns-down.sh   (idempotent, safe after a failed run)
#
# WHAT THIS SCRIPT DOES: creates the namespace, gives it exactly one address (10.90.90.2/30) and exactly one
# route (10.77.30.1/32, the Core, via the host side of the veth) -- NO default route, so nothing else is
# reachable from inside the namespace by the simple fact that there is no route to it. It then proves this by
# pinging the Core (must succeed), the ESP32 at 10.77.30.10 (must fail) and 8.8.8.8 (must fail), and refuses to
# finish -- rolling everything back -- if either negative check does not hold.
#
# WHY NO FORWARDING, NAT OR FIREWALL CHANGE IS NEEDED: 10.77.30.1 is an address of THIS SAME HOST (the Core's own
# machine), just reached over a different interface (wlp0s20f3) than the veth. A packet the namespace sends to
# 10.77.30.1 arrives at the host over aegis-att-h and is delivered to the Core process LOCALLY -- the Linux
# kernel's default "weak host model" accepts a packet for any of the host's own addresses regardless of which
# interface it arrived on. It is never forwarded anywhere, so net.ipv4.ip_forward is left exactly as it is (not
# read, not set) and no nftables rule, NAT rule or sysctl is added by this script in either direction.
#
# ADDRESSING: a dedicated /30, 10.90.90.0/30, chosen because it overlaps neither the AP subnet 10.77.30.0/28 nor
# the home LAN 192.168.1.0/24, and (checked by this script) is not already assigned to any interface on the host.
#
# ATTACKER MODEL / LAB LIMITATION (read before testing): the "attacker" is a namespace on the SAME laptop as the
# Core, reached over a veth, not over the AP radio. Its traffic still arrives at the Core as ordinary IPv4 packets
# from a distinct source address and is scored, logged and (if the graduated response blocks it) dropped exactly
# like traffic from a real wireless client -- the detection, scoring, containment and relay response under test
# are unchanged. What is NOT tested this way: real RF conditions, the AP's own link-layer isolation between
# wireless clients, and Wi-Fi-specific attacks.
#
# WHAT THIS SCRIPT DOES NOT DO: enable graduated response, touch core.env, restart the Core, change any nftables
# table, run or install any attack tool, or touch the production aegis-idea3-* units/paths.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"
CORE_USER="${SUDO_USER:?run through sudo so this is traceable to an operator}"
[[ $CORE_USER != root ]] || die "SUDO_USER is root; run as the operator through sudo"

NS="aegis-att"
VH="aegis-att-h"
VN="aegis-att-n"
HOST_ADDR="10.90.90.1"
NS_ADDR="10.90.90.2"
PREFIX=30
CORE_ADDR="10.77.30.1"
ESP_ADDR="10.77.30.10"
STATE="/run/aegis-att.state"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOWN="$HERE/attacker-ns-down.sh"

setstate() { echo "$1=1" >> "$STATE"; }

STARTED=0
SUCCESS=0
on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP ERR
  if [[ $STARTED -eq 1 && $SUCCESS -ne 1 ]]; then
    echo; echo "SETUP DID NOT COMPLETE (exit $rc) -> rolling back with attacker-ns-down.sh" >&2
    if [[ -f $DOWN && ! -L $DOWN ]]; then
      "$DOWN" || echo "WARNING: the rollback reported leftovers; run attacker-ns-down.sh again by hand" >&2
    else
      echo "ERROR: $DOWN is missing or a symlink; NOT executing it. Tear down by hand (ip netns del $NS; ip link del $VH)." >&2
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "== preflight (read-only)"
for tool in ip nft ping; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
[[ ! -e $STATE && ! -L $STATE ]] || die "$STATE exists: the namespace may already be up. Run attacker-ns-down.sh first."
[[ -f $DOWN && ! -L $DOWN ]] || die "$DOWN is missing or a symlink; refusing to start without a working rollback"
ip netns list 2>/dev/null | grep -qx "$NS" && die "netns $NS already exists (not ours to touch); refusing"
ip link show "$VH" >/dev/null 2>&1 && die "interface $VH already exists; refusing"
ip link show "$VN" >/dev/null 2>&1 && die "interface $VN already exists in the host namespace; refusing"
! ip -4 -o addr show 2>/dev/null | awk '{print $4}' | grep -qE '^10\.90\.90\.[0-3]/' || die "something already uses 10.90.90.0/30 on this host; pick a different /30 and edit both scripts"
nft list table inet aegis_live >/dev/null 2>&1 || die "table inet aegis_live is missing (lab network not up; run aegis-live-up.sh first)"
systemctl is-active --quiet aegis-live-core || die "aegis-live-core is not active (bring the lab up first)"
AP_ADDRS="$(ip -4 -o addr show dev wlp0s20f3)" || die "could not read the AP interface addresses"
grep -q " $CORE_ADDR/" <<< "$AP_ADDRS" || die "$CORE_ADDR is not on wlp0s20f3; is this the right lab host?"
ROUTE_BEFORE="$(ip -4 route show default)" || die "could not read the routing table"
[[ -n $ROUTE_BEFORE ]] || die "no default route"
getent hosts example.com >/dev/null || die "DNS does not resolve before setup (unrelated to this script; check the lab host)"

( set -C; umask 077; : > "$STATE" ) 2>/dev/null || die "could not create $STATE exclusively"
[[ -f $STATE && ! -L $STATE ]] || die "$STATE is not a regular file"
chown root:root "$STATE"; chmod 600 "$STATE"
[[ $(stat -c '%U:%G:%a' "$STATE") == root:root:600 ]] || die "$STATE is not root:root 0600"
STARTED=1

echo "== 1/3 namespace $NS and veth pair ($VH host side / $VN namespace side)"
setstate ST_NS
ip netns add "$NS"
setstate ST_VETH
ip link add "$VH" type veth peer name "$VN"
ip link set "$VN" netns "$NS"

echo "== 2/3 addressing: host $HOST_ADDR/$PREFIX, namespace $NS_ADDR/$PREFIX; ONE route in the namespace, no default route"
ip addr add "$HOST_ADDR/$PREFIX" dev "$VH"
ip link set "$VH" up
ip netns exec "$NS" ip addr add "$NS_ADDR/$PREFIX" dev "$VN"
ip netns exec "$NS" ip link set "$VN" up
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip route add "$CORE_ADDR/32" via "$HOST_ADDR" dev "$VN"
ROUTES_IN_NS="$(ip netns exec "$NS" ip -4 route show)"
[[ $(wc -l <<< "$ROUTES_IN_NS") -eq 1 ]] || die "the namespace has more than one route after setup: $ROUTES_IN_NS"

echo "== 3/3 reachability guard (the script refuses to finish, and rolls back, unless every line below holds)"
ip netns exec "$NS" ping -c1 -W2 "$CORE_ADDR" >/dev/null 2>&1 \
  || die "the namespace cannot reach the Core ($CORE_ADDR); aborting and rolling back"
echo "   OK: $CORE_ADDR (Core) is reachable from the namespace"
if ip netns exec "$NS" ping -c1 -W1 "$ESP_ADDR" >/dev/null 2>&1; then
  die "the namespace CAN reach the ESP32 ($ESP_ADDR); this must never happen. Aborting and rolling back."
fi
echo "   OK: $ESP_ADDR (ESP32) is NOT reachable from the namespace"
if ip netns exec "$NS" ping -c1 -W1 8.8.8.8 >/dev/null 2>&1; then
  die "the namespace CAN reach the Internet (8.8.8.8); this must never happen. Aborting and rolling back."
fi
echo "   OK: 8.8.8.8 (Internet) is NOT reachable from the namespace"
if ip netns exec "$NS" timeout 2 bash -c 'echo > /dev/tcp/8.8.8.8/80' 2>/dev/null; then
  die "the namespace opened a TCP connection outside the Core; aborting and rolling back"
fi
echo "   OK: no TCP route out of the namespace besides the Core"

[[ $(ip -4 route show default) == "$ROUTE_BEFORE" ]] || die "the host's default route changed; aborting"
echo "   host default route: unchanged"
getent hosts example.com >/dev/null || die "DNS stopped resolving on the host after setup; aborting"
echo "   host DNS: unchanged"

ATT_IP="$(ip netns exec "$NS" ip -4 -o addr show dev "$VN" | awk '{print $4}' | cut -d/ -f1)"
echo
echo "   attacker source IP, as the Core will see it in its logs and decisions: $ATT_IP"
echo "   enter the namespace to run a tool by hand:   sudo ip netns exec $NS -- <command>"
echo "   (nmap/hydra/hping3 need no extra flag for this; see review/redteam/README.md for the exact commands and bounds)"
echo
echo "OK. Namespace is up and isolated to $CORE_ADDR only. Teardown: sudo $DOWN"
SUCCESS=1
