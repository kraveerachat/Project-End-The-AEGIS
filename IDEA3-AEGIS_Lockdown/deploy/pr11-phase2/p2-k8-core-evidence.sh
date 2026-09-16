#!/usr/bin/env bash
# AEGIS IDEA3 PR11 — K8 READ-ONLY Core-to-HUB evidence, run ON THE CORE HOST.
#
#   CORE_DECLARED=<hostname the owner declares as the IDEA3 Core> \
#   WIRED_IF=<wired interface on VLAN 20> \
#   bash p2-k8-core-evidence.sh 2>&1 | tee ~/idea3-k8-core.txt
#
# K8 PASS needs Core-side evidence. A workstation reaching the HUB over
# Twingate is NOT Core evidence and never substitutes for this run.
# Read-only: no interface, route, DNS, service, file, or key is changed.
# Certificate validation stays on; -k is never used.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-portable.sh
. "$HERE/p2-portable.sh"
HUB_IP=192.168.10.10
VLAN20=192.168.20.
: "${CORE_DECLARED:?declare the Core hostname, e.g. CORE_DECLARED=aegis-idea3-core}"
: "${WIRED_IF:?declare the wired VLAN 20 interface, e.g. WIRED_IF=enp62s0}"
fail=0
log()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }

log "=== 0 CORE IDENTITY (owner-declared: $CORE_DECLARED)"
hostnamectl 2>/dev/null | grep -E 'Static hostname|Operating System|Hardware'
# Exact match against the static host name; `hostname` is not required (p2-portable.sh).
CORE_ACTUAL=$(p2_host_identity) || CORE_ACTUAL=""
echo "core_host_identity=${CORE_ACTUAL:-<undeterminable>}"
check "running on the declared Core host" '[ -n "$CORE_ACTUAL" ] && [ "$CORE_ACTUAL" = "$CORE_DECLARED" ]'
ip -br link show "$WIRED_IF"; ip -br -4 addr show "$WIRED_IF"
echo "wired_mac=$(cat "/sys/class/net/$WIRED_IF/address" 2>/dev/null)"
systemctl list-unit-files --no-pager 'aegis*' 2>/dev/null | head -10
ls -ld /etc/aegis-idea3 /var/lib/aegis-idea3 2>&1 | head -4

log "=== 1 VLAN 20 PLACEMENT"
CORE_IP=$(ip -4 -o addr show "$WIRED_IF" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
echo "core_wired_ipv4=${CORE_IP:-none}"
check "wired link has carrier" '[ "$(cat "/sys/class/net/$WIRED_IF/carrier" 2>/dev/null)" = 1 ]'
check "wired address is on VLAN 20 (${VLAN20}0/24)" '[[ "${CORE_IP:-}" == ${VLAN20}* ]]'

log "=== 2 ROUTE TO THE HUB"
echo "--- default lookup (this is the path dispatch will really use)"
ip route get "$HUB_IP" 2>&1 | tee /tmp/idea3-k8-route.$$
echo "--- lookup forced onto the wired interface"
ip route get "$HUB_IP" oif "$WIRED_IF" 2>&1 || true
command -v twingate >/dev/null && echo "twingate=$(twingate status 2>&1 | head -1)"
check "the default path to the HUB uses $WIRED_IF (not a tunnel)" 'grep -q " dev $WIRED_IF " /tmp/idea3-k8-route.$$'
check "the default path source address is the VLAN 20 address" 'grep -q " src ${CORE_IP:-none-none} " /tmp/idea3-k8-route.$$'
rm -f /tmp/idea3-k8-route.$$

log "=== 3 TCP AND HTTPS OVER THE WIRED PATH"
timeout 5 bash -c "</dev/tcp/$HUB_IP/443" 2>/dev/null && echo "tcp443=open" || { echo "tcp443=fail"; fail=1; }
# --interface pins the request to the wired link. Certificate validation is on;
# the AEGIS Internal Root CA must be trusted by the Core for this to pass.
curl -sS -o /dev/null -m 10 --interface "$WIRED_IF" --connect-to "::$HUB_IP:443" \
  -w 'browser_https=%{http_code} remote=%{remote_ip} verify=%{ssl_verify_result}\n' \
  https://aegis.internal/healthz || { echo "browser_https=failed"; fail=1; }

log "=== 4 K9 NAME RESOLUTION FROM THE CORE (machine route)"
getent ahosts idea3-core.aegis.internal || echo "idea3-core.aegis.internal=NO_RESOLVE"
grep -n 'idea3-core' /etc/hosts 2>/dev/null || echo "no /etc/hosts entry"

log "=== 5 K10 CORE CLIENT PKI (metadata only; keys are never read)"
sudo find /etc/aegis-idea3/pki -maxdepth 1 -printf '%M %u:%g %s %f\n' 2>&1 | head -20
for c in /etc/aegis-idea3/pki/idea3-core-client.crt /etc/aegis-idea3/pki/hub-server-ca.crt; do
  [ -f "$c" ] && { echo "--- $c"; sudo openssl x509 -in "$c" -noout -subject -issuer -dates -ext extendedKeyUsage 2>&1; }
done

if [ "$fail" = 0 ]; then log "K8_CORE_EVIDENCE=PASS"; else log "K8_CORE_EVIDENCE=FAIL"; fi
exit "$fail"
