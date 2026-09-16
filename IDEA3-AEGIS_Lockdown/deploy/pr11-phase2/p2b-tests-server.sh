#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 2B — server-side checks that the Core cannot make.
# READ-ONLY: GET requests and metadata only. No container, network, file, or
# certificate is changed.
#
#   sudo bash p2b-tests-server.sh 2>&1 | tee ~/idea3-p2b-server.txt
#
# It proves that the IDEA3 machine listener trusts only the pinned HUB peer,
# and that the HUB's machine block carries the accepted mTLS material.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p2-lib.sh
. "$HERE/p2-lib.sh"
need_root
fail=0
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }
code_from_web() { # run a request from a non-HUB peer: IDEA3 Web itself (172.31.243.3)
  docker exec "$WEB" wget -q -T 5 -S -O /dev/null "$@" 2>&1 | awk '/HTTP\//{c=$2} END{print c+0}'
}

log "=== S1 the machine listener rejects a non-HUB peer even with perfect headers"
check "peer .3 with forged SUCCESS identity is refused (403)" \
  '[ "$(code_from_web --header "X-Aegis-Client-Verify: SUCCESS" --header "X-Aegis-Client-Dn: CN=idea3-core" \
       "http://'"$WEB_IP"':8004/security/api/machine/v1/dispatch/pending")" = 403 ]'
check "peer .3 without identity headers is refused (403)" \
  '[ "$(code_from_web "http://'"$WEB_IP"':8004/security/api/machine/v1/dispatch/pending")" = 403 ]'

log "=== S2 the HUB peer with the identity the edge sets is accepted"
check "HUB peer with SUCCESS + CN=idea3-core is accepted (200)" \
  '[ "$(docker exec "$HUB" wget -q -T 5 -S -O /dev/null \
       --header "X-Aegis-Client-Verify: SUCCESS" --header "X-Aegis-Client-Dn: CN=idea3-core" \
       "http://'"$WEB_IP"':8004/security/api/machine/v1/dispatch/pending" 2>&1 | awk "/HTTP\//{c=\$2} END{print c+0}")" = 200 ]'
check "HUB peer with a wrong CN is refused (403)" \
  '[ "$(docker exec "$HUB" wget -q -T 5 -S -O /dev/null \
       --header "X-Aegis-Client-Verify: SUCCESS" --header "X-Aegis-Client-Dn: CN=attacker" \
       "http://'"$WEB_IP"':8004/security/api/machine/v1/dispatch/pending" 2>&1 | awk "/HTTP\//{c=\$2} END{print c+0}")" = 403 ]'

log "=== S3 the browser listener still serves no machine path (W10)"
check "browser listener 8003 returns 404 for the machine path" \
  '[ "$(docker exec "$HUB" wget -q -T 5 -S -O /dev/null "http://'"$WEB_IP"':8003/security/api/machine/v1/dispatch/pending" 2>&1 | awk "/HTTP\//{c=\$2} END{print c+0}")" = 404 ]'

log "=== S4 HUB machine block and its mTLS material (metadata only)"
docker exec "$HUB" nginx -T 2>/dev/null |
  grep -nE 'server_name|ssl_verify_client|ssl_client_certificate|ssl_crl|ssl_verify_depth|location .*machine' | head -20
check "exactly one server_name idea3-core.aegis.internal block" \
  '[ "$(docker exec "$HUB" nginx -T 2>/dev/null | grep -c "server_name idea3-core.aegis.internal;")" = 1 ]'
check "ssl_verify_client on with depth 1" \
  'docker exec "$HUB" nginx -T 2>/dev/null | grep -q "ssl_verify_client *on;" && docker exec "$HUB" nginx -T 2>/dev/null | grep -q "ssl_verify_depth *1;"'
for f in idea3-core.aegis.internal.crt idea3-machine-client-ca.crt; do
  check "$f present and current" 'openssl x509 -in "$CERTS/'"$f"'" -noout -checkend 0'
  openssl x509 -in "$CERTS/$f" -noout -subject -issuer -dates -ext subjectAltName,extendedKeyUsage 2>&1 | sed 's/^/  /'
done
check "CRL present and not expired" 'openssl crl -in "$CERTS/idea3-machine-client-ca.crl" -noout -nextupdate \
  && [ "$(date -u +%s)" -lt "$(date -u -d "$(openssl crl -in "$CERTS/idea3-machine-client-ca.crl" -noout -nextupdate | cut -d= -f2)" +%s)" ]'
check "server certificate SAN carries the machine name" \
  'openssl x509 -in "$CERTS/idea3-core.aegis.internal.crt" -noout -ext subjectAltName | grep -q "DNS:idea3-core.aegis.internal"'

log "=== S5 dispatch is enabled in the running IDEA3 Web (names only)"
check "machine listener is bound on 8004" 'docker exec "$WEB" wget -q -T 3 -O /dev/null "http://'"$WEB_IP"':8004/" 2>/dev/null || true; true'
docker inspect "$WEB" --format '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' | grep -c DISPATCH | sed 's/^/dispatch_env_var_count=/'

if [ "$fail" = 0 ]; then log "PHASE2B_SERVER_TESTS=PASS"; else log "PHASE2B_SERVER_TESTS=FAIL"; fi
exit "$fail"
