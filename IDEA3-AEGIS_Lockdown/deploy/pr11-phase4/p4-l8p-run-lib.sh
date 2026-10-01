#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L8p (ESP32 device provisioning ONLY) owner-run gate library (sourced by the external frozen owner runner; nothing here
# runs on its own and nothing here mutates the host or touches a device). Pure gate logic so it can be tested with stubs and fixture repositories.
# Every function returns 0 on PASS; on FAIL it prints one `reason` line to stderr and returns 1. Commands are resolved from PATH so tests can stub them;
# SUDO defaults to `sudo` (tests set SUDO=""). Read-only: only git reads, file stats and `systemctl show` are issued here.
# L8p owns its OWN one-attempt marker (L8p-ATTEMPT-CONSUMED), receipt gate and authorization records; it reuses the stage-independent L6b/L7/L7u gates
# (receipt chain, Core running baseline, disk headroom, IDEA2 §10 precondition, generic evidence secret scan) instead of copying them. It never adds
# recovery_authorization (an L8-only gate) and never claims Recovery R1-R8, LVR, L8 acceptance or electrical relay proof. It contains NO device logic.

: "${SUDO=sudo}"
_L8P_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l7u-run-lib.sh
. "$_L8P_LIB_DIR/p4-l7u-run-lib.sh"

l8p_reason() { printf '%s\n' "$1" >&2; return 1; }

# l8p_attempt_unconsumed AUTH_DIR — read-only pre-gate: this authorization directory has not yet consumed its one L8p attempt.
l8p_attempt_unconsumed() {
  local dir=${1:-}
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l8p_reason "L8P_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  [ ! -e "$dir/L8p-ATTEMPT-CONSUMED" ] || { l8p_reason "L8P_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"; return 1; }
}

# l8p_consume_attempt AUTH_DIR — one live attempt per authorization. Atomic create-if-absent (noclobber); a second invocation for the same AUTH_DIR
# fails closed even if the first attempt failed. The marker name is distinct from every other stage, so no L7u/L7 marker ever authorizes L8p.
l8p_consume_attempt() {
  local dir=${1:-} marker
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l8p_reason "L8P_ATTEMPT_AUTH_DIR_INVALID"; return 1; }
  marker="$dir/L8p-ATTEMPT-CONSUMED"
  if ( set -o noclobber; printf 'consumed_at=%s\n' "$(date -u +%FT%TZ)" > "$marker" ) 2>/dev/null; then
    return 0
  fi
  l8p_reason "L8P_ATTEMPT_ALREADY_CONSUMED (one live attempt per authorization; obtain a fresh same-day authorization)"
}

# l8p_receipt_gate REPO — predecessor ACCEPTANCE proven by receipts read from the PINNED commit, never the working tree: the L2..L6a chain, L7 AND the
# FINAL L7u live acceptance (L8p follows L7u). Nothing is invented: until a merged receipt records `L7U_LIVE_ACCEPTANCE = PROVEN` this refuses.
# It also refuses when an L8p provisioning result is already recorded (one-shot: re-provisioning needs a new owner decision).
l8p_receipt_gate() {
  local repo=${1:-}
  l6b_receipt_gate "$repo" >/dev/null || return 1
  git -C "$repo" grep -qE "L7_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l8p_reason "L8P_L7_ACCEPTANCE_RECEIPT_MISSING"; return 1; }
  git -C "$repo" grep -qE "L7U_LIVE_ACCEPTANCE ?= ?\`? ?PROVEN" HEAD -- "$L6B_LOGS_REL" \
    || { l8p_reason "L8P_L7U_ACCEPTANCE_RECEIPT_MISSING (L8p follows a PROVEN final L7u; none is recorded)"; return 1; }
  ! git -C "$repo" grep -qE "L8P_PROVISIONING ?= ?\`? ?PASS" HEAD -- "$L6B_LOGS_REL" \
    || { l8p_reason "L8P_ALREADY_PROVISIONED (an L8p result is recorded; a new live attempt needs a new owner decision)"; return 1; }
}

# l8p_input_gate DIR — the private owner input directory: owned by the operator, mode 0700, exactly the seven L8p inputs, each a regular non-symlink file
# owned by the operator. Contents are validated by the canonical handler (p4-l8p-device.py) and are NEVER read or printed here.
l8p_input_gate() {
  local dir=${1:-} f
  [ -d "$dir" ] && [ ! -L "$dir" ] || { l8p_reason "L8P_INPUT_DIR_INVALID"; return 1; }
  [ "$(stat -c %a "$dir")" = 700 ] || { l8p_reason "L8P_INPUT_DIR_MODE_NOT_0700"; return 1; }
  [ "$(stat -c %u "$dir")" = "$(id -u)" ] || { l8p_reason "L8P_INPUT_DIR_OWNER_MISMATCH"; return 1; }
  [ "$(ls -A "$dir" | LC_ALL=C sort | paste -sd,)" = "device.identity,k_c2d,k_d2c,mqtt.pass,physical-recovery.attestation,provisioning.pins,wifi.psk" ] \
    || { l8p_reason "L8P_INPUT_ENTRIES_NOT_EXACT"; return 1; }
  for f in device.identity provisioning.pins physical-recovery.attestation k_c2d k_d2c wifi.psk mqtt.pass; do
    [ -f "$dir/$f" ] && [ ! -L "$dir/$f" ] || { l8p_reason "L8P_INPUT_NOT_A_REGULAR_FILE:$f"; return 1; }
    [ "$(stat -c %u "$dir/$f")" = "$(id -u)" ] || { l8p_reason "L8P_INPUT_OWNER_MISMATCH:$f"; return 1; }
  done
}

# l8p_artifact_gate FILE EXPECTED_SHA256 LABEL — a reviewed artifact exists (regular, non-symlink) and is byte-identical to the frozen pin.
l8p_artifact_gate() {
  local file=${1:-} want=${2:-} label=${3:-ARTIFACT} got
  [ -f "$file" ] && [ ! -L "$file" ] || { l8p_reason "L8P_ARTIFACT_MISSING:$label"; return 1; }
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { l8p_reason "L8P_ARTIFACT_PIN_INVALID:$label"; return 1; }
  got=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { l8p_reason "L8P_ARTIFACT_DIGEST_MISMATCH:$label"; return 1; }
}

# l8p_file_gate FILE LABEL [exec] — a frozen support file exists (regular, non-symlink; executable when asked).
l8p_file_gate() {
  local file=${1:-} label=${2:-FILE} mode=${3:-}
  [[ "$file" == /* ]] && [ -f "$file" ] && [ ! -L "$file" ] || { l8p_reason "L8P_FILE_MISSING:$label"; return 1; }
  [ "$mode" != exec ] || [ -x "$file" ] || { l8p_reason "L8P_FILE_NOT_EXECUTABLE:$label"; return 1; }
}

# l8p_service_gate UNIT... — each unit is active/running NOW. Read-only; never repairs anything.
l8p_service_gate() {
  local u
  for u in "$@"; do
    [ "$(systemctl show -p ActiveState --value "$u" 2>/dev/null)" = active ] && [ "$(systemctl show -p SubState --value "$u" 2>/dev/null)" = running ] \
      || { l8p_reason "L8P_SERVICE_NOT_ACTIVE:$u"; return 1; }
  done
}

# l8p_rollback_output_gate FIRST_WRITE_STARTED(0|1) OUTPUT — the canonical L8p rollback handler's own report must carry its fail-secure semantics.
l8p_rollback_output_gate() {
  local started=${1:-} out=${2:-}
  grep -qx 'L8P_DEVICE_ACTION_TAKEN=NONE' <<< "$out" || { l8p_reason "L8P_ROLLBACK_DEVICE_ACTION_NOT_NONE"; return 1; }
  if [ "$started" = 1 ]; then
    grep -qx 'L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE' <<< "$out" || { l8p_reason "L8P_ROLLBACK_NOT_FAIL_SECURE_HOLD"; return 1; }
  else
    grep -qx 'L8P_ROLLBACK=COMPLETE' <<< "$out" || { l8p_reason "L8P_ROLLBACK_NOT_COMPLETE"; return 1; }
  fi
}

# l8p_secret_scan EVID_DIR INPUT_DIR PY — (1) the generic evidence scan reused from L7u (private-key block, password hash, secret core.env keys) and
# (2) none of the owner's L8p secret VALUES (wifi PSK, MQTT password, protocol keys) may appear anywhere in the evidence. Prints only counts.
l8p_secret_scan() {
  local evid=${1:-} input=${2:-} py=${3:-}
  l7u_secret_scan "$evid" "$py" >/dev/null || { l8p_reason "L8P_SECRET_SCAN_GENERIC_HIT"; return 1; }
  $SUDO "$py" - "$evid" "$input" <<'PYC'
import pathlib, sys
ev, inp = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
needles = []
for name in ("wifi.psk", "mqtt.pass", "k_c2d", "k_d2c"):
    try:
        value = (inp / name).read_bytes().strip()
    except OSError:
        sys.exit(2)
    if len(value) >= 8:
        needles.append(value)
bad = scanned = 0
for f in ev.rglob("*"):
    if not f.is_file() or f.stat().st_size >= 50_000_000:
        continue
    scanned += 1
    data = f.read_bytes()
    if any(n in data for n in needles):
        bad += 1
print(f"L8P_SECRET_VALUE_SCAN_FILES={scanned} L8P_SECRET_VALUE_SCAN_HITS={bad}")
sys.exit(1 if bad else 0)
PYC
}
