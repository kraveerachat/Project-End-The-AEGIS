#!/usr/bin/env bash
# AEGIS IDEA3 PR11 — K9 READ-ONLY name, SNI and server-certificate validation.
#
#   sudo bash p2-k9-name-and-cert.sh            on aegis-system (server side)
#   MODE=core bash p2-k9-name-and-cert.sh       on the Core (resolution + SNI only)
#   MODE=file CERT=<path> bash p2-k9-name-and-cert.sh   offline check of a candidate certificate
#
# READ-ONLY. It never edits DNS, never issues or installs a certificate, and
# never reads a private key. It prints certificate METADATA only.
# Hostname and certificate validation stay ON; -k is never used.
set -uo pipefail
NAME=idea3-core.aegis.internal
HUB_IP=192.168.10.10
CERTS=/opt/aegis/runtime/certs
SRV_CRT="$CERTS/$NAME.crt"
SRV_KEY="$CERTS/$NAME.key"
BROWSER_CRT="$CERTS/aegis.crt"
MODE="${MODE:-server}"
fail=0
log()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }
meta()  { openssl x509 -in "$1" -noout -subject -issuer -dates -ext subjectAltName,extendedKeyUsage,basicConstraints 2>&1; }

# ── offline mode: validate a candidate certificate file before anyone installs it
if [ "$MODE" = file ]; then
  : "${CERT:?set CERT=<candidate certificate path>}"
  log "=== offline candidate certificate: $CERT"
  meta "$CERT"
  check "SAN contains $NAME" 'openssl x509 -in "$CERT" -noout -ext subjectAltName | grep -q "DNS:$NAME"'
  check "extendedKeyUsage is serverAuth" 'openssl x509 -in "$CERT" -noout -ext extendedKeyUsage | grep -q "TLS Web Server Authentication"'
  check "not a CA certificate" '! openssl x509 -in "$CERT" -noout -ext basicConstraints | grep -q "CA:TRUE"'
  check "currently valid (not expired, already started)" 'openssl x509 -in "$CERT" -noout -checkend 0 && [ "$(date -u +%s)" -ge "$(date -u -d "$(openssl x509 -in "$CERT" -noout -startdate | cut -d= -f2)" +%s)" ]'
  check "at least 30 days of life remain" 'openssl x509 -in "$CERT" -noout -checkend 2592000'
  # NEGATIVE CONTROL: the machine name must not be added to the browser certificate.
  if [ -r "$BROWSER_CRT" ]; then
    check "NEGATIVE: the browser certificate does NOT carry $NAME" \
      '! openssl x509 -in "$BROWSER_CRT" -noout -ext subjectAltName | grep -q "DNS:$NAME"'
  fi
  [ "$fail" = 0 ] && log "K9_CANDIDATE_CERT=PASS" || log "K9_CANDIDATE_CERT=FAIL"
  exit "$fail"
fi

log "=== 1 NAME RESOLUTION (mode=$MODE)"
getent ahosts "$NAME" || echo "$NAME=NO_RESOLVE"
check "$NAME resolves" 'getent ahosts "$NAME" >/dev/null'
check "it resolves to the HUB address $HUB_IP" 'getent ahosts "$NAME" | awk "{print \$1}" | grep -qx "$HUB_IP"'
grep -n "$NAME" /etc/hosts 2>/dev/null || echo "(no /etc/hosts entry; router DNS is the other accepted source)"

log "=== 2 SERVER CERTIFICATE FILES (server mode only)"
if [ "$MODE" = server ]; then
  if [ -r "$SRV_CRT" ]; then
    meta "$SRV_CRT"
    check "SAN contains $NAME" 'openssl x509 -in "$SRV_CRT" -noout -ext subjectAltName | grep -q "DNS:$NAME"'
    check "extendedKeyUsage is serverAuth" 'openssl x509 -in "$SRV_CRT" -noout -ext extendedKeyUsage | grep -q "TLS Web Server Authentication"'
    check "certificate is current" 'openssl x509 -in "$SRV_CRT" -noout -checkend 0'
    check "private key is root-owned and 0600 (never read)" '[ "$(stat -c "%u:%g %a" "$SRV_KEY")" = "0:0 600" ]'
    check "certificate and key belong together" \
      '[ "$(openssl x509 -in "$SRV_CRT" -noout -pubkey | sha256sum)" = "$(openssl pkey -in "$SRV_KEY" -pubout | sha256sum)" ]'
    check "NEGATIVE: it is not the browser certificate reused" \
      '[ "$(openssl x509 -in "$SRV_CRT" -noout -fingerprint -sha256)" != "$(openssl x509 -in "$BROWSER_CRT" -noout -fingerprint -sha256)" ]'
  else
    log "FAIL server certificate absent: $SRV_CRT (K9 material not provisioned)"; fail=1
  fi
  log "=== 3 EXPECTED FILE CONTRACT"
  for f in "$SRV_CRT" "$SRV_KEY" "$CERTS/idea3-machine-client-ca.crt" "$CERTS/idea3-machine-client-ca.crl"; do
    printf '  %-56s %s\n' "$f" "$([ -e "$f" ] && stat -c '%F %u:%g %a' "$f" || echo ABSENT)"
  done
fi

log "=== 4 SNI BEHAVIOUR ON THE LIVE HUB (read-only TLS handshake)"
srv_sni=$(timeout 8 openssl s_client -connect "$HUB_IP:443" -servername "$NAME" </dev/null 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)
browser_sni=$(timeout 8 openssl s_client -connect "$HUB_IP:443" -servername aegis.internal </dev/null 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)
echo "  machine SNI  -> ${srv_sni:-<no certificate>}"
echo "  browser SNI  -> ${browser_sni:-<no certificate>}"
timeout 8 openssl s_client -connect "$HUB_IP:443" -servername "$NAME" </dev/null 2>&1 |
  grep -iE 'Acceptable client certificate CA names|No client certificate CA names sent' | head -2
check "the machine SNI serves a certificate for $NAME (not the browser one)" '[ -n "$srv_sni" ] && echo "$srv_sni" | grep -q "$NAME"'
check "the browser SNI still serves the browser certificate" 'echo "${browser_sni:-}" | grep -q "aegis.internal"'

if [ "$fail" = 0 ]; then log "K9=PASS"; else log "K9=FAIL/BLOCKED (see FAIL lines)"; fi
exit "$fail"
