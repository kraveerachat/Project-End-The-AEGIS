#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8p verify handler.
# Read-only post-stage verification of the stage-local evidence bundle (the canonical OD-L8-09 12-field schema, file l8p-<run_id>.json).
# Opens no device and changes nothing.
set -euo pipefail

fail() {
  printf 'L8P_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

EVIDENCE_DIR="${AEGIS_L8P_EVIDENCE_DIR:-}"
[ -n "$EVIDENCE_DIR" ] || fail "AEGIS_L8P_EVIDENCE_DIR required"
[ -d "$EVIDENCE_DIR" ] || fail "evidence directory missing"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

count=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | wc -l)
[ "$count" = 1 ] || fail "expected exactly one evidence bundle, found $count"
BUNDLE=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name 'l8p-*.json' | head -n 1)
[ -n "$BUNDLE" ] || fail "the evidence bundle must be named l8p-<run_id>.json"
[ ! -L "$BUNDLE" ] || fail "evidence bundle must not be a symlink"
[ "$(stat -c %a "$BUNDLE")" = 600 ] || fail "evidence bundle mode must be 0600"

"$PYTHON_BIN" - "$BUNDLE" <<'PY' || fail "evidence bundle failed verification"
import json
import sys

ALLOWED = {
    "schema_version", "run_id", "device_mac", "chip_identity", "flash_size", "firmware_sha256", "nvs_schema_version",
    "nvs_readback_match", "firmware_readback_match", "flash_result", "boot_verification_result", "failure_boundary",
}
bundle = json.loads(open(sys.argv[1], encoding="utf-8").read())
if not isinstance(bundle, dict) or set(bundle) != ALLOWED:
    sys.stderr.write("EVIDENCE_FIELD_SET_MISMATCH\n")
    raise SystemExit(2)
for key, value in (("flash_result", "PASS"), ("nvs_readback_match", "PASS"), ("firmware_readback_match", "PASS"), ("failure_boundary", "NONE")):
    if bundle[key] != value:
        sys.stderr.write(f"EVIDENCE_{key.upper()}_NOT_{value}\n")
        raise SystemExit(2)
if bundle["boot_verification_result"] not in ("PASS", "NOT_APPLICABLE_FIXTURE_BACKEND"):
    sys.stderr.write("BOOT_VERIFICATION_NOT_ACCEPTED\n")
    raise SystemExit(2)
PY

printf 'L8P_VERIFY=PASS\n'
printf 'L8P_PROVISIONING_ONLY=YES\n'
printf 'ELECTRICAL_RELAY_PROOF=NO\n'
exit 0
