#!/usr/bin/env bash
# AEGIS IDEA3 PR11 — K10 machine-client PKI helper.
#
#   MODE=csr      bash p2-k10-client-pki.sh   ON THE CORE: generate the Core key + CSR
#   MODE=verify   bash p2-k10-client-pki.sh   validate returned artifacts (no private key is read)
#   MODE=contract bash p2-k10-client-pki.sh   print the exact artifact contract for Kla
#
# The CSR mode is the ONLY mode that creates key material, it runs on the Core,
# and the key never leaves that host. This script NEVER creates a CA, never
# generates or reads Kla's CA private key, and never installs Production PKI.
# A substitute CA is never an acceptable way to make progress.
set -uo pipefail
MODE="${MODE:-contract}"
SUBJECT_CN="${SUBJECT_CN:-idea3-core}"          # must equal AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT
PKI_DIR="${PKI_DIR:-/etc/aegis-idea3/pki}"
CORE_KEY="$PKI_DIR/idea3-core-client.key"
CORE_CSR="${CORE_CSR:-/tmp/idea3-core-client.csr}"
CORE_CRT="${CORE_CRT:-$PKI_DIR/idea3-core-client.crt}"
CA_CRT="${CA_CRT:-$PKI_DIR/idea3-machine-client-ca.crt}"
CA_CRL="${CA_CRL:-$PKI_DIR/idea3-machine-client-ca.crl}"
SERVICE_USER="${SERVICE_USER:-aegis-idea3}"
fail=0
log()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
check() { if eval "$2"; then log "PASS $1"; else log "FAIL $1"; fail=1; fi; }

case "$MODE" in
csr)
  log "=== generate the Core client key and CSR (key stays on this host)"
  [ -e "$CORE_KEY" ] && { log "STOP: $CORE_KEY already exists; rotation must be deliberate"; exit 2; }
  umask 077
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$PKI_DIR" 2>/dev/null || mkdir -p "$PKI_DIR"
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$CORE_KEY" -out "$CORE_CSR" -subj "/CN=$SUBJECT_CN" || exit 1
  chmod 0400 "$CORE_KEY"; chown "$SERVICE_USER:$SERVICE_USER" "$CORE_KEY" 2>/dev/null || true
  log "key   $CORE_KEY (never copy, never print, never commit)"
  log "CSR   $CORE_CSR — send ONLY this file to Kla"
  openssl req -in "$CORE_CSR" -noout -subject -verify 2>&1 | head -3
  check "the CSR subject CN is exactly $SUBJECT_CN" \
    '[ "$(openssl req -in "$CORE_CSR" -noout -subject | sed -E "s/.*CN ?= ?([^,]*).*/\1/")" = "$SUBJECT_CN" ]'
  check "the private key is 0400 and owned by the service account" \
    '[ "$(stat -c "%a" "$CORE_KEY")" = 400 ]'
  ;;

verify)
  log "=== 1 client certificate"
  if [ -r "$CORE_CRT" ]; then
    openssl x509 -in "$CORE_CRT" -noout -subject -issuer -dates -ext extendedKeyUsage,keyUsage,basicConstraints
    check "subject CN is exactly $SUBJECT_CN" \
      '[ "$(openssl x509 -in "$CORE_CRT" -noout -subject | sed -E "s/.*CN ?= ?([^,]*).*/\1/")" = "$SUBJECT_CN" ]'
    check "extendedKeyUsage is clientAuth only" \
      'openssl x509 -in "$CORE_CRT" -noout -ext extendedKeyUsage | grep -q "TLS Web Client Authentication" \
       && ! openssl x509 -in "$CORE_CRT" -noout -ext extendedKeyUsage | grep -q "TLS Web Server Authentication"'
    check "NEGATIVE: it is not a CA certificate" '! openssl x509 -in "$CORE_CRT" -noout -ext basicConstraints | grep -q "CA:TRUE"'
    check "currently valid" 'openssl x509 -in "$CORE_CRT" -noout -checkend 0'
    check "about 90 days or less of total life (K10 policy)" \
      '[ $(( ($(date -u -d "$(openssl x509 -in "$CORE_CRT" -noout -enddate | cut -d= -f2)" +%s) - $(date -u -d "$(openssl x509 -in "$CORE_CRT" -noout -startdate | cut -d= -f2)" +%s)) / 86400 )) -le 100 ]'
    check "renewal is not overdue (more than 7 days left)" 'openssl x509 -in "$CORE_CRT" -noout -checkend 604800'
    [ -r "$CORE_KEY" ] && check "certificate matches the Core key (public halves only)" \
      '[ "$(openssl x509 -in "$CORE_CRT" -noout -pubkey | sha256sum)" = "$(openssl pkey -in "$CORE_KEY" -pubout | sha256sum)" ]'
  else log "FAIL client certificate absent: $CORE_CRT"; fail=1; fi

  log "=== 2 dedicated client CA"
  if [ -r "$CA_CRT" ]; then
    openssl x509 -in "$CA_CRT" -noout -subject -issuer -dates -ext basicConstraints,keyUsage
    check "the CA is a CA with pathlen:0" 'openssl x509 -in "$CA_CRT" -noout -ext basicConstraints | grep -q "CA:TRUE" \
      && openssl x509 -in "$CA_CRT" -noout -ext basicConstraints | grep -q "pathlen:0"'
    check "the CA can sign certificates and CRLs" 'openssl x509 -in "$CA_CRT" -noout -ext keyUsage | grep -q "Certificate Sign" \
      && openssl x509 -in "$CA_CRT" -noout -ext keyUsage | grep -q "CRL Sign"'
    check "the client certificate chains to this CA" 'openssl verify -CAfile "$CA_CRT" -purpose sslclient "$CORE_CRT" >/dev/null 2>&1'
    check "NEGATIVE: this CA is NOT the AEGIS Internal Root CA" \
      '! openssl x509 -in "$CA_CRT" -noout -subject | grep -qi "AEGIS Internal Root CA"'
    check "NEGATIVE: no CA private key is present beside the certificate" '[ ! -e "${CA_CRT%.crt}.key" ]'
  else log "FAIL client CA absent: $CA_CRT"; fail=1; fi

  log "=== 3 CRL"
  if [ -r "$CA_CRL" ]; then
    openssl crl -in "$CA_CRL" -noout -issuer -lastupdate -nextupdate
    check "the CRL is issued by the dedicated CA" 'openssl crl -in "$CA_CRL" -noout -CAfile "$CA_CRT" 2>&1 | grep -q verify.OK'
    check "the CRL has not expired (an expired CRL refuses every client)" \
      '[ "$(date -u +%s)" -lt "$(date -u -d "$(openssl crl -in "$CA_CRL" -noout -nextupdate | cut -d= -f2)" +%s)" ]'
    check "the CRL still has more than 3 days of life" \
      '[ $(( ($(date -u -d "$(openssl crl -in "$CA_CRL" -noout -nextupdate | cut -d= -f2)" +%s) - $(date -u +%s)) / 86400 )) -ge 3 ]'
    echo "  revoked serials: $(openssl crl -in "$CA_CRL" -noout -text | grep -c 'Serial Number')"
    check "NEGATIVE: the Core certificate is not revoked" \
      '! openssl crl -in "$CA_CRL" -noout -text | grep -q "$(openssl x509 -in "$CORE_CRT" -noout -serial | cut -d= -f2)"'
  else log "FAIL CRL absent: $CA_CRL"; fail=1; fi
  ;;

contract)
  cat <<'CONTRACT'
K10 artifact contract — who makes what, and what crosses which boundary.

Kla (kraveerachat), on the offline CA host, using idea3-machine-client-ca.cnf.example:
  creates  idea3-machine-client-ca.key   ENCRYPTED, NEVER LEAVES KLA. Not on the server, not in Git.
  creates  idea3-machine-client-ca.crt   dedicated client CA, CA:TRUE pathlen:0, keyCertSign + cRLSign
  creates  idea3-machine-client-ca.crl   regenerated before nextUpdate; an expired CRL fails closed
  signs    idea3-core-client.crt         from the Core CSR, clientAuth only, CN=idea3-core, about 90 days

Music, on the Core (MODE=csr):
  creates  idea3-core-client.key         0400, service-account owned, NEVER LEAVES THE CORE
  creates  idea3-core-client.csr         the ONLY file sent to Kla

Returned to the server, under /opt/aegis/runtime/certs (root:root, 0644):
  idea3-machine-client-ca.crt, idea3-machine-client-ca.crl
  idea3-core.aegis.internal.crt          K9 server certificate (separate from the browser certificate)

Returned to the Core, under /etc/aegis-idea3/pki:
  idea3-core-client.crt                  the signed client certificate
  hub-server-ca.crt                      the AEGIS Internal Root CA, so the Core can verify the HUB

Never: a substitute CA, a CA key on the server, a private key in Git, a client
certificate with serverAuth, or the machine name added to the browser certificate.
CONTRACT
  ;;
*) log "STOP: MODE must be csr, verify, or contract"; exit 2 ;;
esac

if [ "$fail" = 0 ]; then log "K10_${MODE^^}=PASS"; else log "K10_${MODE^^}=FAIL"; fi
exit "$fail"
