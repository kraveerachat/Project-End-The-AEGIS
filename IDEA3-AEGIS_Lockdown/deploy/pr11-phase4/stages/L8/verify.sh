#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8 verify handler.
# Read-only post-stage verification. Opens no device and changes nothing.
set -euo pipefail

fail() {
  printf 'L8_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

WORK_DIR="${AEGIS_L8_WORK_DIR:-}"
EVIDENCE_DIR="${AEGIS_L8_EVIDENCE_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L8_WORK_DIR required"
[ -n "$EVIDENCE_DIR" ] || fail "AEGIS_L8_EVIDENCE_DIR required"
[ -d "$EVIDENCE_DIR" ] || fail "evidence directory missing"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

# 1. Exactly one stage-local evidence bundle (OD-L8-09)
bundle_count=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | wc -l)
[ "$bundle_count" = "1" ] || fail "expected exactly one evidence bundle, found $bundle_count"
BUNDLE=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | head -n 1)

# 2. Bundle privacy
bundle_mode=$(stat -c %a "$BUNDLE")
[ "$bundle_mode" = "600" ] || fail "evidence bundle mode must be 0600 (got $bundle_mode)"
[ ! -L "$BUNDLE" ] || fail "evidence bundle must not be a symlink"

# 3. Exact allowlist and recorded outcomes (OD-L8-07, OD-L8-09)
"$PYTHON_BIN" - "$BUNDLE" <<'PY' || fail "evidence bundle failed verification"
import json
import sys

ALLOWED = {
    "schema_version",
    "run_id",
    "device_mac",
    "chip_identity",
    "flash_size",
    "firmware_sha256",
    "nvs_schema_version",
    "nvs_readback_match",
    "flash_result",
    "boot_verification_result",
    "failure_boundary",
}

try:
    bundle = json.loads(open(sys.argv[1], encoding="utf-8").read())
except Exception as exc:
    sys.stderr.write(f"EVIDENCE_UNREADABLE: {exc}\n")
    raise SystemExit(2)

if not isinstance(bundle, dict) or set(bundle) != ALLOWED:
    sys.stderr.write("EVIDENCE_FIELD_SET_MISMATCH\n")
    raise SystemExit(2)

if bundle["nvs_readback_match"] != "PASS":
    sys.stderr.write("NVS_READBACK_NOT_PASS\n")
    raise SystemExit(2)

if bundle["flash_result"] != "PASS":
    sys.stderr.write("FLASH_RESULT_NOT_PASS\n")
    raise SystemExit(2)

if bundle["boot_verification_result"] not in ("PASS", "NOT_APPLICABLE_FIXTURE_BACKEND"):
    sys.stderr.write("BOOT_VERIFICATION_NOT_ACCEPTED\n")
    raise SystemExit(2)

if bundle["failure_boundary"] != "NONE":
    sys.stderr.write("FAILURE_BOUNDARY_NOT_NONE\n")
    raise SystemExit(2)
PY

# 4. Stage artifacts stayed private (OD-L8-03)
for artifact in nvs.csv nvs.bin; do
  path="$WORK_DIR/$artifact"
  [ -f "$path" ] || fail "stage artifact missing: $artifact"
  mode=$(stat -c %a "$path")
  [ "$mode" = "600" ] || fail "stage artifact $artifact mode must be 0600 (got $mode)"
done

# 5. Host preservation contract: both allow files carry zero active entries.
for allow in allow-keys.txt allow-listeners.txt; do
  active=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/$allow" || true)
  [ "$active" = "0" ] || fail "$allow must have zero active entries (found $active)"
done

printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L8_VERIFY=PASS\n'
exit 0
