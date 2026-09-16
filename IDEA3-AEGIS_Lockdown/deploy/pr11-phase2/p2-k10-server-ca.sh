#!/usr/bin/env bash
# AEGIS IDEA3 PR11 — K10 server-held dedicated machine-client CA helper.
#
# PRODUCTION EXECUTION NOT AUTHORIZED. This helper implements the K10 amendment
#   IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md
# accepted through authorized CODEOWNER review. Kla is the CA operational
# custodian who runs it. No mutating mode may run on the AEGIS Production Server
# without a separate, explicit Production authorization: a review approval or a
# merge never authorizes execution.
#
#   MODE=preflight (default)  read-only: custody, permissions, HUB mount, container mounts
#   MODE=verify               read-only: CA, key custody metadata, CRL, published copies, Core cert
#   MODE=init                 MUTATING: create the dedicated CA key (encrypted), CA cert, DB, first CRL
#   MODE=sign                 MUTATING: sign the Core CSR (CN=idea3-core, clientAuth only, <=100 days)
#   MODE=crl                  MUTATING: regenerate the CRL (bounded nextUpdate)
#   MODE=revoke               MUTATING: revoke one issued certificate, then regenerate the CRL
#   MODE=publish              MUTATING: copy ONLY the public CA certificate and the CRL to the HUB mount
#
# Custody, run by Kla (infrastructure owner) as root on the AEGIS Production Server:
#   /opt/aegis/pki/private/idea3-machine-client-ca.key   root:root 0600, passphrase-encrypted
#   /opt/aegis/pki/certs/idea3-machine-client-ca.crt     public
#   /opt/aegis/pki/crl/idea3-machine-client-ca.crl       public
#   /opt/aegis/pki/idea3-machine-client-ca/              CA database (index, serial, crlnumber), 0700
#   /opt/aegis/pki/issued/                               signed Core certificates (public)
#   /opt/aegis/runtime/certs/idea3-machine-client-ca.{crt,crl}   HUB mount: public copies only
#
# Never: the CA key in the HUB mount, a container, Git, stdout, or a log; the
# Core private key on the server; a passphrase in Git, the environment, or a
# file; a CA other than this dedicated one; serverAuth on a Core certificate.
#
# Mutating modes require AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION=YES, root, and
# an interactive terminal: OpenSSL itself prompts for the CA passphrase, so this
# script never sees, stores or forwards it.
#
# TEST-ONLY: AEGIS_K10_TEST_MODE=1 permits AEGIS_K10_PKI_ROOT,
# AEGIS_K10_HUB_CERTS and AEGIS_K10_TEST_PASSFILE, relaxes root/TTY/ownership to
# the invoking user, and refuses any path under /opt/aegis or /etc. Without it,
# every one of those variables is refused.
# shellcheck disable=SC2329  # the predicates below are invoked indirectly through check()
set -uo pipefail
MODE="${MODE:-preflight}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CNF="$HERE/idea3-machine-client-ca.cnf"

readonly PROD_PKI_ROOT=/opt/aegis/pki
readonly PROD_HUB_CERTS=/opt/aegis/runtime/certs
readonly SUBJECT_CN=idea3-core                     # must equal AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT
readonly CA_SUBJECT="/C=TH/O=AEGIS/OU=IDEA3/CN=AEGIS IDEA3 Machine Client CA"
# SHA-256 of the AEGIS Internal Root CA PEM (owner-observed). The dedicated CA must never equal it.
readonly AEGIS_ROOT_CA_PEM_SHA256=8d03ec3090de7d3dc38dce86234219f3675ed0124d44b32d721b6a4eaba10ca7
readonly CORE_DAYS_MAX=100
readonly CRL_DAYS_MAX=45
readonly CRL_DAYS_MIN=7

log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "STOP: $*"; exit 2; }
fail=0
check() { # name command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then log "PASS $name"; else log "FAIL $name"; fail=1; fi
}

# ── test-mode and path resolution ──────────────────────────────────────────
TEST_MODE="${AEGIS_K10_TEST_MODE:-0}"
if [ "$TEST_MODE" = 1 ]; then
  PKI_ROOT="${AEGIS_K10_PKI_ROOT:?TEST MODE requires AEGIS_K10_PKI_ROOT}"
  HUB_CERTS="${AEGIS_K10_HUB_CERTS:?TEST MODE requires AEGIS_K10_HUB_CERTS}"
  for p in "$PKI_ROOT" "$HUB_CERTS"; do
    case "$(realpath -m "$p")/" in
      /opt/aegis/*|/etc/*|/) die "TEST MODE refuses the Production-like path $p" ;;
    esac
  done
  EXPECT_OWNER="$(id -u):$(id -g)"
else
  for v in AEGIS_K10_PKI_ROOT AEGIS_K10_HUB_CERTS AEGIS_K10_TEST_PASSFILE; do
    [ -z "${!v:-}" ] || die "$v is TEST-ONLY; refusing it without AEGIS_K10_TEST_MODE=1"
  done
  PKI_ROOT=$PROD_PKI_ROOT
  HUB_CERTS=$PROD_HUB_CERTS
  EXPECT_OWNER=0:0
fi
PRIV_DIR="$PKI_ROOT/private"
CA_DIR="$PKI_ROOT/idea3-machine-client-ca"
ISSUED_DIR="$PKI_ROOT/issued"
CA_KEY="$PRIV_DIR/idea3-machine-client-ca.key"
CA_CRT="$PKI_ROOT/certs/idea3-machine-client-ca.crt"
CA_CRL="$PKI_ROOT/crl/idea3-machine-client-ca.crl"
HUB_CA_CRT="$HUB_CERTS/idea3-machine-client-ca.crt"
HUB_CA_CRL="$HUB_CERTS/idea3-machine-client-ca.crl"
export K10_CA_DIR="$CA_DIR" K10_CA_KEY="$CA_KEY" K10_CA_CRT="$CA_CRT" K10_CA_CRL="$CA_CRL"

# Passphrase handling: Production passes nothing, so OpenSSL prompts on the
# terminal. Tests pass a throwaway fixture passphrase file.
PASSIN=(); PASSOUT=()
if [ -n "${AEGIS_K10_TEST_PASSFILE:-}" ]; then
  PASSIN=(-passin "file:$AEGIS_K10_TEST_PASSFILE"); PASSOUT=(-pass "file:$AEGIS_K10_TEST_PASSFILE")
fi

# ── small read-only predicates (none prints key material) ──────────────────
meta()        { stat -c '%F %u:%g %a' "$1" 2>/dev/null; }
is_encrypted_key() { head -n1 "$1" 2>/dev/null | grep -qx -- '-----BEGIN ENCRYPTED PRIVATE KEY-----'; }
has_private_key_block() { grep -q -- 'PRIVATE KEY-----' "$1" 2>/dev/null; }
inside() { case "$(realpath -m "$1")/" in "$(realpath -m "$2")"/*) return 0 ;; *) return 1 ;; esac; }
days_between() { echo $(( ($(date -u -d "$2" +%s) - $(date -u -d "$1" +%s)) / 86400 )); }
x509_field() { openssl x509 -in "$1" -noout "-$2" | cut -d= -f2-; }
crl_field()  { openssl crl -in "$1" -noout "-$2" | cut -d= -f2-; }
ext_body()   { openssl x509 -in "$1" -noout -ext "$2" 2>/dev/null | sed 1d | tr -d ' '; }
ext_head()   { openssl x509 -in "$1" -noout -ext "$2" 2>/dev/null | head -n1; }
rfc_subject() { openssl "$1" -in "$2" -noout -subject -nameopt RFC2253 | sed 's/^subject=//'; }

ca_is_pathlen0_critical() { [ "$(ext_body "$1" basicConstraints)" = "CA:TRUE,pathlen:0" ] && ext_head "$1" basicConstraints | grep -q critical; }
ca_keyusage_ok()          { [ "$(ext_body "$1" keyUsage)" = "CertificateSign,CRLSign" ] && ext_head "$1" keyUsage | grep -q critical; }
ca_self_signed()          { openssl verify -CAfile "$1" -check_ss_sig "$1"; }
ca_not_root_subject()     { ! openssl x509 -in "$1" -noout -subject | grep -qi 'AEGIS Internal Root CA'; }
ca_not_root_bytes()       { [ "$(sha256sum "$1" | cut -d' ' -f1)" != "$AEGIS_ROOT_CA_PEM_SHA256" ]; }
ca_not_root_pubkey()      { # only when an owner supplies the public Root CA certificate
  [ -z "${AEGIS_ROOT_CA_CRT:-}" ] && return 0
  [ "$(openssl x509 -in "$1" -noout -pubkey | sha256sum)" != "$(openssl x509 -in "$AEGIS_ROOT_CA_CRT" -noout -pubkey | sha256sum)" ]
}
key_custody_ok() { [ "$(meta "$CA_KEY")" = "regular file $EXPECT_OWNER 600" ]; }
priv_dir_ok()    { [ "$(meta "$PRIV_DIR")" = "directory $EXPECT_OWNER 700" ]; }
crl_signed_by_ca() { openssl crl -in "$CA_CRL" -noout -CAfile "$CA_CRT" 2>&1 | grep -q 'verify OK'; }
crl_not_expired()  { [ "$(date -u +%s)" -lt "$(date -u -d "$(crl_field "$CA_CRL" nextupdate)" +%s)" ]; }
crl_3_days_left()  { [ "$(days_between "$(date -u)" "$(crl_field "$CA_CRL" nextupdate)")" -ge 3 ]; }
crl_bounded()      { [ "$(days_between "$(crl_field "$CA_CRL" lastupdate)" "$(crl_field "$CA_CRL" nextupdate)")" -le "$CRL_DAYS_MAX" ]; }
hub_has_no_ca_key() { ! compgen -G "$HUB_CERTS/idea3-machine-client-ca*.key" >/dev/null; }
pki_outside_hub_mount()     { ! inside "$PKI_ROOT" "$HUB_CERTS"; }
pki_outside_runtime_tree()  { ! inside "$PKI_ROOT" "$(dirname "$HUB_CERTS")"; }
ca_key_outside_hub_mount()  { ! inside "$CA_KEY" "$HUB_CERTS"; }
no_container_mounts_pki()   { ! printf '%s\n' "$1" | grep -q "^$PKI_ROOT"; }
hub_copies_public_only() {
  local f; for f in "$HUB_CA_CRT" "$HUB_CA_CRL"; do [ ! -e "$f" ] || ! has_private_key_block "$f" || return 1; done
}

leaf_cn_exact()        { [ "$(rfc_subject x509 "$1")" = "CN=$SUBJECT_CN" ]; }
leaf_not_ca()          { [ "$(ext_body "$1" basicConstraints)" = "CA:FALSE" ]; }
leaf_client_auth_only(){ [ "$(ext_body "$1" extendedKeyUsage)" = "TLSWebClientAuthentication" ]; }
leaf_no_server_auth()  { ! openssl x509 -in "$1" -noout -ext extendedKeyUsage | grep -q 'Server Authentication'; }
leaf_keyusage_ok()     { [ "$(ext_body "$1" keyUsage)" = "DigitalSignature" ]; }
leaf_lifetime_ok()     { [ "$(days_between "$(x509_field "$1" startdate)" "$(x509_field "$1" enddate)")" -le "$CORE_DAYS_MAX" ]; }
leaf_currently_valid() { openssl x509 -in "$1" -noout -checkend 0; }
leaf_sslclient_crl()   { openssl verify -CAfile "$CA_CRT" -CRLfile "$CA_CRL" -crl_check -purpose sslclient "$1"; }

check_ca() {
  check "the dedicated CA is CA:TRUE pathlen:0 (critical)" ca_is_pathlen0_critical "$CA_CRT"
  check "the CA keyUsage is exactly keyCertSign + cRLSign (critical)" ca_keyusage_ok "$CA_CRT"
  check "the CA certificate is self-signed and verifies" ca_self_signed "$CA_CRT"
  check "NEGATIVE: the CA subject is not the AEGIS Internal Root CA" ca_not_root_subject "$CA_CRT"
  check "NEGATIVE: the CA certificate is not the AEGIS Internal Root CA PEM" ca_not_root_bytes "$CA_CRT"
  check "NEGATIVE: the CA public key is not the AEGIS Internal Root CA key" ca_not_root_pubkey "$CA_CRT"
}
check_leaf() {
  check "Core certificate subject is exactly CN=$SUBJECT_CN" leaf_cn_exact "$1"
  check "Core certificate is CA:FALSE" leaf_not_ca "$1"
  check "Core certificate extendedKeyUsage is clientAuth only" leaf_client_auth_only "$1"
  check "NEGATIVE: Core certificate has no serverAuth" leaf_no_server_auth "$1"
  check "Core certificate keyUsage is digitalSignature only" leaf_keyusage_ok "$1"
  check "Core certificate total life is <= $CORE_DAYS_MAX days" leaf_lifetime_ok "$1"
  check "Core certificate is currently valid" leaf_currently_valid "$1"
  check "Core certificate verifies as sslclient against the CA and CRL (not revoked)" leaf_sslclient_crl "$1"
}

require_mutation_gate() {
  [ "${AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION:-}" = YES ] \
    || die "MODE=$MODE mutates CA state; AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION=YES is required"
  [ -r "$CNF" ] || die "CA configuration missing: $CNF"
  if [ "$TEST_MODE" != 1 ]; then
    [ "$(id -u)" = 0 ] || die "run as root on the AEGIS Production Server"
    [ -t 0 ] || die "an interactive terminal is required: OpenSSL prompts for the CA passphrase"
  fi
}
require_ca() {
  [ -f "$CA_KEY" ] && [ -f "$CA_CRT" ] && [ -f "$CA_DIR/index.txt" ] || die "the dedicated CA is not initialised"
  key_custody_ok || die "CA key custody is not regular file $EXPECT_OWNER 0600"
  is_encrypted_key "$CA_KEY" || die "the CA key is not passphrase-encrypted"
}
gencrl() { # days
  local tmp="$CA_CRL.tmp.$$"
  openssl ca -config "$CNF" -gencrl -crldays "$1" "${PASSIN[@]}" -out "$tmp" || { rm -f "$tmp"; die "CRL generation failed"; }
  openssl crl -in "$tmp" -noout -CAfile "$CA_CRT" 2>&1 | grep -q 'verify OK' || { rm -f "$tmp"; die "the new CRL does not verify"; }
  if ! { chmod 0644 "$tmp" && mv -f "$tmp" "$CA_CRL"; }; then die "could not place the CRL"; fi
  log "CRL $CA_CRL nextUpdate=$(crl_field "$CA_CRL" nextupdate)"
}
newest_issued() { find "$ISSUED_DIR" -maxdepth 1 -name 'idea3-core-client-*.crt' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n1 | cut -d' ' -f2-; }

log "K10 server CA helper MODE=$MODE test_mode=$TEST_MODE pki_root=$PKI_ROOT hub_certs=$HUB_CERTS"

case "$MODE" in
preflight)
  log "=== read-only preflight (nothing is created, changed, or printed from key material)"
  log "INFO $(openssl version)"
  log "INFO running as uid $(id -u)"
  check "NEGATIVE: the PKI root is not inside the HUB certificate mount" pki_outside_hub_mount
  check "NEGATIVE: the PKI root is not inside the runtime tree" pki_outside_runtime_tree
  check "NEGATIVE: no CA private key file exists in the HUB certificate mount" hub_has_no_ca_key
  check "NEGATIVE: HUB copies of the CA certificate/CRL carry no private key" hub_copies_public_only
  if [ -e "$CA_KEY" ]; then
    log "INFO CA key present: $(meta "$CA_KEY")"
    check "CA key custody is regular file $EXPECT_OWNER 0600" key_custody_ok
    check "the private directory is $EXPECT_OWNER 0700" priv_dir_ok
    check "the CA key is passphrase-encrypted (header only inspected)" is_encrypted_key "$CA_KEY"
  else
    log "INFO CA key absent — K10_CA_STATE=NOT_INITIALISED"
  fi
  if [ -e "$CA_CRT" ]; then log "INFO CA certificate present"; else log "INFO CA certificate absent"; fi
  if [ -e "$CA_CRL" ]; then log "INFO CRL present"; else log "INFO CRL absent"; fi
  if [ "$TEST_MODE" != 1 ]; then
    if command -v docker >/dev/null 2>&1 && docker ps -q >/dev/null 2>&1; then
      # shellcheck disable=SC2046
      mounts=$(docker inspect $(docker ps -q) --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null | sed '/^$/d')
      check "NEGATIVE: no running container mounts the PKI root" no_container_mounts_pki "$mounts"
    else
      log "INFO container mounts NOT CHECKED (docker unavailable to this user)"
    fi
  fi
  ;;

verify)
  log "=== 1 dedicated CA"
  if [ -r "$CA_CRT" ]; then check_ca; else log "FAIL CA certificate absent: $CA_CRT"; fail=1; fi
  log "=== 2 CA key custody (metadata and header only)"
  if [ -e "$CA_KEY" ]; then
    check "CA key custody is regular file $EXPECT_OWNER 0600" key_custody_ok
    check "the private directory is $EXPECT_OWNER 0700" priv_dir_ok
    check "the CA key is passphrase-encrypted" is_encrypted_key "$CA_KEY"
    check "NEGATIVE: the CA key is not inside the HUB certificate mount" ca_key_outside_hub_mount
  else log "FAIL CA key absent: $CA_KEY"; fail=1; fi
  log "=== 3 CRL"
  if [ -r "$CA_CRL" ] && [ -r "$CA_CRT" ]; then
    check "the CRL is signed by the dedicated CA" crl_signed_by_ca
    check "the CRL has not expired (an expired CRL refuses every client)" crl_not_expired
    check "the CRL has at least 3 days of life left" crl_3_days_left
    check "the CRL validity window is <= $CRL_DAYS_MAX days" crl_bounded
  else log "FAIL CRL absent: $CA_CRL"; fail=1; fi
  log "=== 4 HUB certificate mount (public copies only)"
  check "NEGATIVE: no CA private key file exists in the HUB certificate mount" hub_has_no_ca_key
  check "NEGATIVE: HUB copies carry no private key" hub_copies_public_only
  for pair in "$CA_CRT:$HUB_CA_CRT" "$CA_CRL:$HUB_CA_CRL"; do
    if [ -e "${pair#*:}" ]; then check "HUB copy ${pair#*:} is identical to the canonical file" cmp -s "${pair%%:*}" "${pair#*:}"
    else log "INFO not yet published: ${pair#*:}"; fi
  done
  log "=== 5 Core client certificate"
  core="${CORE_CRT:-$(newest_issued)}"
  if [ -n "$core" ] && [ -r "$core" ]; then check_leaf "$core"
  elif [ -n "${CORE_CRT:-}" ]; then log "FAIL Core certificate absent: $CORE_CRT"; fail=1
  else log "INFO K10_CORE_CERT=NOT_ISSUED"; fi
  ;;

init)
  require_mutation_gate
  for f in "$CA_KEY" "$CA_CRT" "$CA_DIR/index.txt"; do
    [ ! -e "$f" ] || die "$f already exists; the dedicated CA is never overwritten"
  done
  CA_DAYS="${CA_DAYS:-1095}"
  [[ "$CA_DAYS" =~ ^[0-9]+$ ]] && [ "$CA_DAYS" -ge 365 ] && [ "$CA_DAYS" -le 1826 ] || die "CA_DAYS must be 365..1826"
  umask 077
  if [ "$TEST_MODE" = 1 ]; then own=(); else own=(-o root -g root); fi
  install -d -m 0755 "${own[@]}" "$PKI_ROOT" "$PKI_ROOT/certs" "$PKI_ROOT/crl" "$ISSUED_DIR" || die "cannot create $PKI_ROOT"
  install -d -m 0700 "${own[@]}" "$PRIV_DIR" "$CA_DIR" "$CA_DIR/newcerts" || die "cannot create private directories"
  if ! { : > "$CA_DIR/index.txt" && openssl rand -hex 16 > "$CA_DIR/serial" && echo 1000 > "$CA_DIR/crlnumber"; }; then
    die "cannot create the CA database"
  fi
  log "=== generate the encrypted CA key (OpenSSL prompts for a new passphrase)"
  tmpkey="$CA_KEY.tmp.$$"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-384 -aes-256-cbc "${PASSOUT[@]}" -out "$tmpkey" \
    || { rm -f "$tmpkey"; die "CA key generation failed"; }
  if ! { chmod 0600 "$tmpkey" && mv "$tmpkey" "$CA_KEY"; }; then die "cannot place the CA key"; fi
  is_encrypted_key "$CA_KEY" || die "the generated CA key is not encrypted"
  log "=== self-sign the dedicated CA certificate"
  openssl req -new -x509 -config "$CNF" -extensions idea3_ca_root -key "$CA_KEY" "${PASSIN[@]}" \
    -subj "$CA_SUBJECT" -days "$CA_DAYS" -sha384 -out "$CA_CRT" || die "CA certificate creation failed"
  chmod 0644 "$CA_CRT"
  gencrl 30
  check_ca
  check "CA key custody is regular file $EXPECT_OWNER 0600" key_custody_ok
  log "INFO CA certificate SHA-256 $(sha256sum "$CA_CRT" | cut -d' ' -f1)"
  log "INFO nothing was published; run MODE=publish only in the authorized Phase 2B preparation"
  ;;

sign)
  require_mutation_gate
  require_ca
  CSR="${CSR:?MODE=sign requires CSR=<path to the Core CSR>}"
  CSR_SHA256="${CSR_SHA256:?MODE=sign requires CSR_SHA256 recorded by the Core owner}"
  CORE_DAYS="${CORE_DAYS:-90}"
  [[ "$CORE_DAYS" =~ ^[0-9]+$ ]] && [ "$CORE_DAYS" -ge 1 ] && [ "$CORE_DAYS" -le "$CORE_DAYS_MAX" ] \
    || die "CORE_DAYS must be 1..$CORE_DAYS_MAX"
  [ -r "$CSR" ] || die "CSR not readable: $CSR"
  ! has_private_key_block "$CSR" || die "the CSR file contains a private key; refuse and treat that key as exposed"
  [ "$(sha256sum "$CSR" | cut -d' ' -f1)" = "$CSR_SHA256" ] || die "CSR SHA-256 does not match the value recorded on the Core"
  openssl req -in "$CSR" -noout -verify >/dev/null 2>&1 || die "the CSR self-signature does not verify"
  subj="$(rfc_subject req "$CSR")"
  [ "$subj" = "CN=$SUBJECT_CN" ] || die "CSR subject must be exactly CN=$SUBJECT_CN (got: $subj)"
  openssl req -in "$CSR" -noout -text | grep -q 'ASN1 OID: prime256v1' || die "the Core key must be EC P-256"
  mkdir -p "$ISSUED_DIR" || die "cannot create $ISSUED_DIR"
  out="$ISSUED_DIR/idea3-core-client-$(date -u +%Y%m%dT%H%M%SZ).crt"
  [ ! -e "$out" ] || die "$out already exists"
  log "=== sign the Core CSR (OpenSSL prompts for the CA passphrase)"
  openssl ca -batch -notext -config "$CNF" -extensions idea3_client -days "$CORE_DAYS" \
    "${PASSIN[@]}" -in "$CSR" -out "$out" || { rm -f "$out"; die "signing failed"; }
  chmod 0644 "$out"
  check_leaf "$out"
  log "INFO issued $out serial=$(x509_field "$out" serial) notAfter=$(x509_field "$out" enddate)"
  log "INFO return ONLY this certificate to the Core; the Core key never comes here"
  ;;

revoke)
  require_mutation_gate
  require_ca
  CERT="${CERT:?MODE=revoke requires CERT=<issued certificate>}"
  REASON="${REVOKE_REASON:-superseded}"
  case "$REASON" in keyCompromise|superseded|cessationOfOperation|affiliationChanged) ;; *) die "unsupported REVOKE_REASON" ;; esac
  openssl verify -CAfile "$CA_CRT" -purpose sslclient "$CERT" >/dev/null 2>&1 || die "$CERT is not issued by the dedicated CA"
  openssl ca -config "$CNF" -revoke "$CERT" -crl_reason "$REASON" "${PASSIN[@]}" || die "revocation failed"
  gencrl "${CRL_DAYS:-30}"
  log "INFO revoked serial=$(x509_field "$CERT" serial); publish the CRL and reload the HUB in an authorized window"
  ;;

crl)
  require_mutation_gate
  require_ca
  CRL_DAYS="${CRL_DAYS:-30}"
  [[ "$CRL_DAYS" =~ ^[0-9]+$ ]] && [ "$CRL_DAYS" -ge "$CRL_DAYS_MIN" ] && [ "$CRL_DAYS" -le "$CRL_DAYS_MAX" ] \
    || die "CRL_DAYS must be $CRL_DAYS_MIN..$CRL_DAYS_MAX"
  gencrl "$CRL_DAYS"
  check "the CRL is signed by the dedicated CA" crl_signed_by_ca
  check "the CRL validity window is <= $CRL_DAYS_MAX days" crl_bounded
  ;;

publish)
  require_mutation_gate
  [ -r "$CA_CRT" ] && [ -r "$CA_CRL" ] || die "canonical CA certificate or CRL missing"
  for f in "$CA_CRT" "$CA_CRL"; do ! has_private_key_block "$f" || die "$f contains a private key; refusing to publish"; done
  if ! { crl_signed_by_ca && crl_not_expired; }; then die "the canonical CRL is invalid or expired"; fi
  [ -d "$HUB_CERTS" ] || die "HUB certificate mount absent: $HUB_CERTS"
  for pair in "$CA_CRT:$HUB_CA_CRT" "$CA_CRL:$HUB_CA_CRL"; do
    src=${pair%%:*}; dst=${pair#*:}
    if [ "$TEST_MODE" = 1 ]; then install -m 0644 "$src" "$dst.tmp.$$" || die "copy failed"
    else install -m 0644 -o root -g root "$src" "$dst.tmp.$$" || die "copy failed"; fi
    mv -f "$dst.tmp.$$" "$dst" || die "cannot place $dst"
    check "published $dst is identical to the canonical file" cmp -s "$src" "$dst"
  done
  check "NEGATIVE: no CA private key file exists in the HUB certificate mount" hub_has_no_ca_key
  check "NEGATIVE: HUB copies carry no private key" hub_copies_public_only
  log "INFO NGINX is not reloaded here; that belongs to the authorized Phase 2B window"
  ;;

*) die "MODE must be preflight, verify, init, sign, crl, revoke, or publish" ;;
esac

if [ "$fail" = 0 ]; then log "K10_SERVER_${MODE^^}=PASS"; else log "K10_SERVER_${MODE^^}=FAIL"; fi
exit "$fail"
