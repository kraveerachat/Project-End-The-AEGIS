#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2B — machine mTLS verification matrix, run ON THE CORE.
# Read-only against Production: every request is a GET of the only read-only
# machine endpoint. It never claims an action, posts evidence, or sends CUT or
# RESTORE. The Core private key never leaves this host and is never printed.
#
#   CORE_DECLARED=<core hostname> WIRED_IF=<vlan20 if> bash p2b-tests-core.sh
#
# Optional negative-control material, all issued by Kla and placed by the owner:
#   WRONG_CA_CERT/WRONG_CA_KEY   ephemeral throwaway pair (never trusted anywhere)
#   REVOKED_CERT/REVOKED_KEY     real-CA cert that Kla revoked, CRL already loaded
#   EXPIRED_CERT/EXPIRED_KEY     real-CA cert with past notAfter
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-portable.sh
. "$HERE/p2-portable.sh"
HUB_IP=192.168.10.10
NAME=idea3-core.aegis.internal
BASE_URL="https://$NAME/security/api/machine/v1"
PENDING="$BASE_URL/dispatch/pending"
CA=/etc/aegis-idea3/pki/hub-server-ca.crt
CERT=/etc/aegis-idea3/pki/idea3-core-client.crt
KEY=/etc/aegis-idea3/pki/idea3-core-client.key
: "${CORE_DECLARED:?}"; : "${WIRED_IF:?}"
fail=0
log()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
check() { if [ "$2" = "$3" ]; then log "PASS $1 (got $2)"; else log "FAIL $1 (want $3, got $2)"; fail=1; fi; }
# Hostname and certificate validation stay ON in every call.
req() { curl -sS -o /dev/null -m 15 --interface "$WIRED_IF" --resolve "$NAME:443:$HUB_IP" \
        --cacert "$CA" -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

log "=== preconditions"
# Exact match against the static host name; `hostname` is not required (p2-portable.sh).
CORE_ACTUAL=$(p2_host_identity) || CORE_ACTUAL=""
log "core_host_identity=${CORE_ACTUAL:-<undeterminable>}"
[ -n "$CORE_ACTUAL" ] && [ "$CORE_ACTUAL" = "$CORE_DECLARED" ] || { log "STOP: not the declared Core"; exit 2; }
getent ahosts "$NAME" | head -2
openssl s_client -connect "$HUB_IP:443" -servername "$NAME" -CAfile "$CA" \
  -verify_hostname "$NAME" </dev/null 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
log "acceptable client CA names offered by the machine block:"
openssl s_client -connect "$HUB_IP:443" -servername "$NAME" -CAfile "$CA" </dev/null 2>&1 |
  sed -n '/Acceptable client certificate CA names/,/^---/p' | head -5

log "=== T1 valid Core certificate is accepted"
check "T1 valid client certificate" "$(req --cert "$CERT" --key "$KEY" "$PENDING")" 200

log "=== T2 no client certificate is rejected at the edge"
check "T2 no client certificate" "$(req "$PENDING")" 400

log "=== T3 wrong CA is rejected"
if [ -n "${WRONG_CA_CERT:-}" ]; then
  check "T3 wrong-CA certificate" "$(req --cert "$WRONG_CA_CERT" --key "$WRONG_CA_KEY" "$PENDING")" 400
else log "SKIP T3 — no ephemeral wrong-CA pair supplied"; fi

log "=== T4 revoked certificate is rejected by the CRL"
if [ -n "${REVOKED_CERT:-}" ]; then
  check "T4 revoked certificate" "$(req --cert "$REVOKED_CERT" --key "$REVOKED_KEY" "$PENDING")" 400
else log "SKIP T4 — no Kla-revoked test certificate supplied"; fi

log "=== T5 expired certificate is rejected"
if [ -n "${EXPIRED_CERT:-}" ]; then
  check "T5 expired certificate" "$(req --cert "$EXPIRED_CERT" --key "$EXPIRED_KEY" "$PENDING")" 400
else log "SKIP T5 — no Kla-issued expired test certificate supplied"; fi

log "=== T6 spoofed identity headers are overwritten by the HUB"
check "T6a forged identity headers with a valid certificate still succeed" \
  "$(req --cert "$CERT" --key "$KEY" -H 'X-Aegis-Client-Verify: SUCCESS' -H 'X-Aegis-Client-Dn: CN=attacker' "$PENDING")" 200
check "T6b forged identity headers without a certificate are rejected" \
  "$(req -H 'X-Aegis-Client-Verify: SUCCESS' -H 'X-Aegis-Client-Dn: CN=idea3-core' "$PENDING")" 400
check "T6c browser headers are stripped, so a valid call still succeeds" \
  "$(req --cert "$CERT" --key "$KEY" -H 'Cookie: aegis.idea3.sid=x' -H 'Origin: https://evil.example' "$PENDING")" 200

log "=== T7 the machine path is not served on the browser name"
check "T7a machine path on the browser SNI" \
  "$(curl -sS -o /dev/null -m 10 --interface "$WIRED_IF" --connect-to "::$HUB_IP:443" -w '%{http_code}' \
     https://aegis.internal/security/api/machine/v1/dispatch/pending 2>/dev/null || echo 000)" 404
check "T7b browser route still serves /security/" \
  "$(curl -sS -o /dev/null -m 10 --interface "$WIRED_IF" --connect-to "::$HUB_IP:443" -w '%{http_code}' \
     https://aegis.internal/security/ 2>/dev/null || echo 000)" 200
check "T7c the machine name serves nothing outside the machine path" \
  "$(req --cert "$CERT" --key "$KEY" "https://$NAME/drive/")" 404

if [ "$fail" = 0 ]; then log "PHASE2B_CORE_TESTS=PASS"; else log "PHASE2B_CORE_TESTS=FAIL"; fi
exit "$fail"
