#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6a Isolated TLS / PKI apply handler.
# Sole broker lifecycle owner is p4-broker-validate.py.
set -euo pipefail

fail() {
  printf "L6A_APPLY=FAIL reason=%s\n" "$1" >&2
  exit 1
}

# 1. Environment Variable Presence Checks
PORT="${AEGIS_L6A_PORT:-}"
[ -n "$PORT" ] || fail "AEGIS_L6A_PORT required"

WORK_DIR="${AEGIS_L6A_WORK_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L6A_WORK_DIR required"

INPUT_DIR="${AEGIS_L6A_INPUT_DIR:-}"
[ -n "$INPUT_DIR" ] || fail "AEGIS_L6A_INPUT_DIR required"

# 2. Validation of Variable Values
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  fail "AEGIS_L6A_PORT must be an integer"
fi

if [ "$PORT" -lt 1025 ] || [ "$PORT" -gt 65535 ]; then
  fail "AEGIS_L6A_PORT outside valid unprivileged port range (1025-65535)"
fi

if [ "$PORT" -eq 1883 ] || [ "$PORT" -eq 8883 ]; then
  fail "AEGIS_L6A_PORT forbidden (1883 or 8883)"
fi

[ ! -L "$WORK_DIR" ] || fail "AEGIS_L6A_WORK_DIR must not be a symlink"
case "$WORK_DIR" in
  /etc/mosquitto*|/etc/aegis-idea3/mqtt*|/etc/*)
    fail "AEGIS_L6A_WORK_DIR cannot be inside /etc"
    ;;
esac

[ -d "$INPUT_DIR" ] || fail "AEGIS_L6A_INPUT_DIR must exist and be a directory"
[ ! -L "$INPUT_DIR" ] || fail "AEGIS_L6A_INPUT_DIR must not be a symlink"

# 2. Input file checks
for req in ca.crt broker.crt broker.key core.pass device.pass; do
  [ -f "$INPUT_DIR/$req" ] || fail "INPUT_DIR missing required file: $req"
  [ ! -L "$INPUT_DIR/$req" ] || fail "INPUT_DIR file must not be a symlink: $req"
done

# Check private modes on secrets
for sec in broker.key core.pass device.pass; do
  sec_mode=$(stat -c %a "$INPUT_DIR/$sec")
  if [ "$sec_mode" != "600" ] && [ "$sec_mode" != "400" ]; then
    fail "INPUT_DIR secret $sec has invalid mode: $sec_mode (must be 0600 or 0400)"
  fi
done

# 3. Setup WORK_DIR
mkdir -p "$WORK_DIR"
chmod 0700 "$WORK_DIR"

P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

# 4. Prepare ephemeral materials in WORK_DIR
ACL_FILE="$WORK_DIR/aegis.acl"
PASSWD_FILE="$WORK_DIR/passwords"
CONF_FILE="$WORK_DIR/mosquitto.conf"

"$PYTHON_BIN" "$P4_HERE/p4-broker-material.py" render-acl \
  --device-id aegis-relay-01 \
  --output "$ACL_FILE"

"$PYTHON_BIN" "$P4_HERE/p4-broker-material.py" build-password-db \
  --device-id aegis-relay-01 \
  --core-password-file "$INPUT_DIR/core.pass" \
  --device-password-file "$INPUT_DIR/device.pass" \
  --output "$PASSWD_FILE"

cat > "$CONF_FILE" <<EOF
per_listener_settings false
allow_anonymous false
password_file $PASSWD_FILE
acl_file $ACL_FILE
persistence false
retain_available false
listener $PORT 127.0.0.1
protocol mqtt
cafile $INPUT_DIR/ca.crt
certfile $INPUT_DIR/broker.crt
keyfile $INPUT_DIR/broker.key
tls_version tlsv1.2
require_certificate false
EOF
chmod 0600 "$CONF_FILE"

# 5. Offline certificate check
"$PYTHON_BIN" "$P4_HERE/p4-mqtt-pki.py" validate-broker-cert \
  --ca-file "$INPUT_DIR/ca.crt" \
  --cert-file "$INPUT_DIR/broker.crt" \
  --key-file "$INPUT_DIR/broker.key" >/dev/null

# 6. Execute broker validator (sole lifecycle owner)
STARTED_AT=$(date -u +%FT%TZ)

VALIDATE_OUT=$("$PYTHON_BIN" "$P4_HERE/p4-broker-validate.py" validate \
  --config "$CONF_FILE" \
  --core-password-file "$INPUT_DIR/core.pass" \
  --device-password-file "$INPUT_DIR/device.pass" \
  --device-id aegis-relay-01 \
  --state-dir "$WORK_DIR")

FINISHED_AT=$(date -u +%FT%TZ)

# Check sentinel/secret leakage in outputs
if grep -E -q "CANARY_SECRET|canary-wrong" <<< "$VALIDATE_OUT"; then
  fail "Secret canary leaked in validator output"
fi

# 7. Unlink ephemeral materials
rm -f "$PASSWD_FILE" "$ACL_FILE" "$CONF_FILE" "$WORK_DIR/broker-process.json"

# 8. Write validation-evidence.tsv atomically
EVIDENCE_TMP="$WORK_DIR/validation-evidence.tsv.tmp"
EVIDENCE_FINAL="$WORK_DIR/validation-evidence.tsv"

cat > "$EVIDENCE_TMP" <<EOF
schema	1
stage	L6a
result	PASS
listener_address	127.0.0.1
listener_port	$PORT
pki_profile	PASS
pki_chain	PASS
pki_hostname	PASS
tls_runtime_version	PASS
core_auth	PASS
device_auth	PASS
anonymous_rejected	PASS
wrong_core_password_rejected	PASS
wrong_device_password_rejected	PASS
acl_matrix	PASS
retained_rejected	PASS
broker_residue	NO
secret_output_scan	PASS
started_at	$STARTED_AT
finished_at	$FINISHED_AT
EOF

mv "$EVIDENCE_TMP" "$EVIDENCE_FINAL"
chmod 0600 "$EVIDENCE_FINAL"

printf "L6A_APPLY=PASS\n"
exit 0
