#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6a verification handler.
set -euo pipefail

fail() {
  printf "L6A_VERIFY=FAIL reason=%s\n" "$1" >&2
  exit 1
}

WORK_DIR="${AEGIS_L6A_WORK_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L6A_WORK_DIR required"
[ -d "$WORK_DIR" ] || fail "AEGIS_L6A_WORK_DIR must exist"

EVIDENCE_FILE="$WORK_DIR/validation-evidence.tsv"
[ -f "$EVIDENCE_FILE" ] || fail "validation-evidence.tsv missing"

# Verify exact 20 schema keys in exact order
EXPECTED_KEYS=(
  schema
  stage
  result
  listener_address
  listener_port
  pki_profile
  pki_chain
  pki_hostname
  tls_runtime_version
  core_auth
  device_auth
  anonymous_rejected
  wrong_core_password_rejected
  wrong_device_password_rejected
  acl_matrix
  retained_rejected
  broker_residue
  secret_output_scan
  started_at
  finished_at
)

SEEN_KEYS=()
declare -A VALUES

while IFS=$'\t' read -r k v || [ -n "$k" ]; do
  [ -n "$k" ] || continue
  [ -n "$v" ] || fail "Empty value for key $k"
  SEEN_KEYS+=("$k")
  VALUES["$k"]="$v"
done < "$EVIDENCE_FILE"

if [ "${#SEEN_KEYS[@]}" -ne 20 ]; then
  fail "Invalid key count: ${#SEEN_KEYS[@]} (expected 20)"
fi

for idx in "${!EXPECTED_KEYS[@]}"; do
  exp="${EXPECTED_KEYS[$idx]}"
  seen="${SEEN_KEYS[$idx]}"
  if [ "$exp" != "$seen" ]; then
    fail "Key mismatch at index $idx: expected $exp, got $seen"
  fi
done

[ "${VALUES[schema]}" = "1" ] || fail "schema must be 1"
[ "${VALUES[stage]}" = "L6a" ] || fail "stage must be L6a"
[ "${VALUES[result]}" = "PASS" ] || fail "result must be PASS"
[ "${VALUES[listener_address]}" = "127.0.0.1" ] || fail "listener_address must be 127.0.0.1"
[ "${VALUES[pki_profile]}" = "PASS" ] || fail "pki_profile must be PASS"
[ "${VALUES[pki_chain]}" = "PASS" ] || fail "pki_chain must be PASS"
[ "${VALUES[pki_hostname]}" = "PASS" ] || fail "pki_hostname must be PASS"
[ "${VALUES[tls_runtime_version]}" = "PASS" ] || fail "tls_runtime_version must be PASS"
[ "${VALUES[core_auth]}" = "PASS" ] || fail "core_auth must be PASS"
[ "${VALUES[device_auth]}" = "PASS" ] || fail "device_auth must be PASS"
[ "${VALUES[anonymous_rejected]}" = "PASS" ] || fail "anonymous_rejected must be PASS"
[ "${VALUES[wrong_core_password_rejected]}" = "PASS" ] || fail "wrong_core_password_rejected must be PASS"
[ "${VALUES[wrong_device_password_rejected]}" = "PASS" ] || fail "wrong_device_password_rejected must be PASS"
[ "${VALUES[acl_matrix]}" = "PASS" ] || fail "acl_matrix must be PASS"
[ "${VALUES[retained_rejected]}" = "PASS" ] || fail "retained_rejected must be PASS"
[ "${VALUES[broker_residue]}" = "NO" ] || fail "broker_residue must be NO"
[ "${VALUES[secret_output_scan]}" = "PASS" ] || fail "secret_output_scan must be PASS"

# Check for residual listener on port
PORT="${VALUES[listener_port]}"
if command -v ss >/dev/null 2>&1; then
  if ss -H -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
    fail "Residual listener detected on 127.0.0.1:$PORT"
  fi
fi

# Offline PKI check if input dir is provided
INPUT_DIR="${AEGIS_L6A_INPUT_DIR:-}"
if [ -n "$INPUT_DIR" ] && [ -d "$INPUT_DIR" ]; then
  P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
  "$PYTHON_BIN" "$P4_HERE/p4-mqtt-pki.py" validate-broker-cert \
    --ca-file "$INPUT_DIR/ca.crt" \
    --cert-file "$INPUT_DIR/broker.crt" >/dev/null
fi

printf "L6A_VERIFY=PASS\n"
exit 0
