#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L9 verify handler.
# Read-only post-stage verification. Opens no device and changes nothing.
# AEGIS_L9_BACKEND=live selects the live-observation bundle (l9-live-evidence.json, class
# LIVE_CORE_OBSERVATION); anything else selects the fixture bundle. A bundle of the other class,
# or under the other name, never verifies.
set -euo pipefail

fail() {
  printf 'L9_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

WORK_DIR="${AEGIS_L9_WORK_DIR:-}"
EVIDENCE_DIR="${AEGIS_L9_EVIDENCE_DIR:-}"
INPUT_DIR="${AEGIS_L9_INPUT_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L9_WORK_DIR required"
[ -n "$EVIDENCE_DIR" ] || fail "AEGIS_L9_EVIDENCE_DIR required"
[ -d "$EVIDENCE_DIR" ] || fail "evidence directory missing"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

# 0. Live backend: recompute the pass criteria from the bundle and reconcile it with the Core's own durable rows.
if [ "${AEGIS_L9_BACKEND:-fixture}" = live ]; then
  live_count=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | wc -l)
  [ "$live_count" = "1" ] || fail "expected exactly one evidence bundle, found $live_count"
  [ -f "$EVIDENCE_DIR/l9-live-evidence.json" ] && [ ! -L "$EVIDENCE_DIR/l9-live-evidence.json" ] || fail "live evidence bundle missing or not named l9-live-evidence.json"
  P4_LIVE="$(cd "$HERE/../.." && pwd)"
  "$PYTHON_BIN" "$P4_LIVE/p4-l9-live-observe.py" verify --evidence-dir "$EVIDENCE_DIR" || fail "live evidence bundle verification failed"
  for allow in allow-keys.txt allow-listeners.txt; do
    active=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/$allow" || true)
    [ "$active" = "0" ] || fail "$allow must have zero active entries (found $active)"
  done
  printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
  printf 'L9_VERIFY=PASS\n'
  exit 0
fi

# 1. Exactly one stage-local evidence bundle (OD-L9-07)
bundle_count=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | wc -l)
[ "$bundle_count" = "1" ] || fail "expected exactly one evidence bundle, found $bundle_count"
BUNDLE=$(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name '*.json' | head -n 1)
[ "$(basename "$BUNDLE")" = "l9-auth-evidence.json" ] || fail "unexpected bundle filename: $(basename "$BUNDLE")"

# 2. Bundle privacy
bundle_mode=$(stat -c %a "$BUNDLE")
[ "$bundle_mode" = "600" ] || fail "evidence bundle mode must be 0600 (got $bundle_mode)"
[ ! -L "$BUNDLE" ] || fail "evidence bundle must not be a symlink"

# 3. Delegate bundle verification to the helper
P4_HERE="$(cd "$HERE/../.." && pwd)"
if ! "$PYTHON_BIN" "$P4_HERE/p4-l9-auth.py" verify \
  --evidence-dir "$EVIDENCE_DIR" \
  ${INPUT_DIR:+--input-dir "$INPUT_DIR"}; then
  fail "evidence bundle verification failed"
fi

# 4. Host preservation contract: both allow files carry zero active entries.
for allow in allow-keys.txt allow-listeners.txt; do
  active=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/$allow" || true)
  [ "$active" = "0" ] || fail "$allow must have zero active entries (found $active)"
done

printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L9_VERIFY=PASS\n'
exit 0
