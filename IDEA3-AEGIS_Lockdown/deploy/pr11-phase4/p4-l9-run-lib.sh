#!/usr/bin/env bash
# L9 owner-run governance primitives. Sourced by the FROZEN owner runner; nothing here runs on its own.
# L9 live is a READ-ONLY observation: these primitives consume ONE attempt marker, bind the exact
# Authorization, build a byte-exact root-owned bundle and record a unique closeout. They never start,
# stop or restart a service and never talk to the broker or the device.
set -Eeuo pipefail
L9_CANONICAL_DIR=/var/lib/aegis-idea3-governance
L9_MARKER_NAME=L9-GLOBAL-ATTEMPT-CONSUMED
L9_CLOSEOUT_NAME=L9-GLOBAL-CLOSEOUT-PASS
L9_SUDO=${SUDO-sudo}

l9_canonical_dir() {
  if [ "${AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_L9_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$AEGIS_L9_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$L9_CANONICAL_DIR"; fi
}
l9_trusted_dir_chain() {
  local dir=${1:-} owner=0 stop=/; [ -n "$L9_SUDO" ] || owner=$(id -u)
  if [ "${AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_L9_TEST_ONLY_TRUST_ROOT:-}" ]; then stop=$AEGIS_L9_TEST_ONLY_TRUST_ROOT; fi
  [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  while :; do
    $L9_SUDO test -d "$dir" && ! $L9_SUDO test -L "$dir" || return 1
    [ "$($L9_SUDO stat -c %u "$dir" 2>/dev/null)" = "$owner" ] || return 1
    [ -z "$($L9_SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    [ "$dir" = "$stop" ] && return 0
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
l9_canonical_dir_valid() {
  local dir; dir=$(l9_canonical_dir); [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  if $L9_SUDO test -e "$dir" || $L9_SUDO test -L "$dir"; then l9_trusted_dir_chain "$dir"; else l9_trusted_dir_chain "$(dirname "$dir")"; fi
}
l9_marker_path() { printf '%s/%s' "$(l9_canonical_dir)" "$L9_MARKER_NAME"; }
l9_closeout_path() { printf '%s/%s' "$(l9_canonical_dir)" "$L9_CLOSEOUT_NAME"; }
l9_marker_unconsumed() {
  l9_canonical_dir_valid || { echo L9_CANONICAL_DIR_NOT_TRUSTED >&2; return 1; }
  local marker closeout; marker=$(l9_marker_path); closeout=$(l9_closeout_path)
  if $L9_SUDO test -e "$marker" || $L9_SUDO test -L "$marker" || $L9_SUDO test -e "$closeout" || $L9_SUDO test -L "$closeout"; then echo L9_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
}
l9_fsync() { $L9_SUDO sync -- "$1" 2>/dev/null; }
# l9_consume_attempt WORK DEVICE RUN_ID OBSERVE_TOOL — consume the single global attempt, durably, BEFORE the observation, and
# store the PRE boundary taken from the Core's own sources (never a caller value outside the guarded test seam).
l9_consume_attempt() {
  local work=${1:-} device=${2:-} run=${3:-} tool=${4:-} dir marker boundary
  [[ "$work" == /* && "$work" != *..* && "$tool" == /* && "$tool" != *..* ]] || return 1
  [[ "$device" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ && "$run" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || return 1
  l9_marker_unconsumed || return 1; dir=$(l9_canonical_dir); marker=$(l9_marker_path)
  if ! $L9_SUDO test -d "$dir"; then $L9_SUDO mkdir -m 0700 "$dir" || return 1; fi
  l9_fsync "$(dirname "$dir")" || return 1
  if [ "${AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_L9_TEST_ONLY_BOUNDARY:-}" ]; then
    boundary=$AEGIS_L9_TEST_ONLY_BOUNDARY
  else
    boundary=$($L9_SUDO /usr/bin/python3 "$tool" capture-boundary --device-id "$device") || return 1
  fi
  if ! printf 'L9_ATTEMPT_CONSUMED=YES\nL9_RERUN_ALLOWED=NO\nL9_DEVICE_ID=%s\nL9_RUN_ID=%s\nL9_CONSUMED_AT_EPOCH=%s\nwork=%s\n%s\n' "$device" "$run" "$(date -u +%s.%N)" "$work" "$boundary" | $L9_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$marker"; then echo L9_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
  L9_MARKER_CREATED=1
  l9_fsync "$marker" && l9_fsync "$dir" || { echo L9_MARKER_NOT_DURABLE_ATTEMPT_CONSUMED >&2; return 1; }
  $L9_SUDO chattr +i "$marker" 2>/dev/null || true
}
l9_operator_identity_gate() {
  local expected_user=${1:-} expected_uid=${2:-} actual_uid actual_user
  [[ "$expected_user" =~ ^[a-z_][a-z0-9_-]*$ && "$expected_uid" =~ ^[1-9][0-9]*$ ]] || return 1
  actual_uid=$(id -u); actual_user=$(id -un)
  [ "$actual_uid" = "$expected_uid" ] && [ "$actual_user" = "$expected_user" ] && [ "$actual_uid" != 0 ]
}
# l9_authorization_gate AUTH MAIN RUNNER_SHA256 L8_MAIN TODAY — the L9 Authorization carries EXACTLY the five base fields
# (no d6_notice/integration_review/recovery_authorization or any other stage's extra field), names this stage, today, the
# owner, and binds, as whole tokens of its scope, the exact main, the exact frozen runner and the L8 predecessor main.
l9_authorization_gate() {
  local auth=${1:-} main=${2:-} runner=${3:-} l8=${4:-} today=${5:-} keys line key value count
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$runner" =~ ^[0-9a-f]{64}$ && "$l8" =~ ^[0-9a-f]{40}$ && "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  [ -f "$auth" ] && [ ! -L "$auth" ] || return 1
  [ "$(head -n 1 "$auth")" = AEGIS_P4_AUTHORIZATION_V1 ] || return 1
  keys=$(tail -n +2 "$auth" | awk -F= 'NF >= 2 {print $1}' | sort | tr '\n' ' ')
  [ "$keys" = "authorizer date reference scope stage " ] || { echo L9_AUTHORIZATION_FIELD_SET_INVALID >&2; return 1; }
  [ "$(tail -n +2 "$auth" | grep -c .)" = 5 ] || return 1
  grep -qx 'stage=L9' "$auth" || { echo L9_AUTHORIZATION_STAGE_MISMATCH >&2; return 1; }
  grep -qx "date=$today" "$auth" || { echo L9_AUTHORIZATION_STALE >&2; return 1; }
  grep -qx 'authorizer=music' "$auth" || return 1
  line=$(grep '^scope=' "$auth"); value=${line#scope=}
  count=0
  for tok in "main=$main" "runner=$runner" "l8=$l8"; do
    case " $value " in *" $tok "*) count=$((count + 1)) ;; esac
  done
  [ "$count" = 3 ] || { echo L9_AUTHORIZATION_NOT_BOUND_TO_MAIN_RUNNER_L8 >&2; return 1; }
  # no other main/runner/l8 token may be present (a second, conflicting binding is a refusal)
  [ "$(grep -oE '(^| )(main|runner|l8)=' <<<" $value" | wc -l)" = 3 ] || { echo L9_AUTHORIZATION_AMBIGUOUS_BINDING >&2; return 1; }
}
# l9_prepare_bundle REPO P4 BUNDLE MAIN — a root-owned, read-only copy of exactly the reviewed files, each byte-identical to its object at MAIN.
l9_prepare_bundle() {
  local repo=${1:-} p4=${2:-} bundle=${3:-} main=${4:-} rel src dst got expected
  [[ "$repo" == /* && "$p4" == /* && "$bundle" == /* && "$bundle" != *..* && "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  local -a files=(
    p4-lib.sh p4-l0-capture.sh p4-compare.sh p4-l7u-run-lib.sh p4-l7-run-lib.sh p4-l6b-run-lib.sh
    p4-l9-live-observe.py p4-l9-gates.py p4-l9-auth.py
    stages/L9/apply.sh stages/L9/verify.sh stages/L9/rollback.sh stages/L9/allow-keys.txt stages/L9/allow-listeners.txt
  )
  # 1. verify EVERY source against the exact-main object BEFORE anything is created (no partial bundle on a mismatch)
  for rel in "${files[@]}"; do
    src="$p4/$rel"
    [ -f "$src" ] && [ ! -L "$src" ] || { echo "L9_BUNDLE_SOURCE_INVALID:$rel" >&2; return 1; }
    expected=$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1) || return 1
    got=$(sha256sum -- "$src" | cut -d' ' -f1)
    [ "$got" = "$expected" ] && [ "$expected" != e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ] || { echo "L9_BUNDLE_SOURCE_NOT_EXACT_MAIN:$rel" >&2; return 1; }
  done
  # 2. install the verified bytes root-owned and read-only, with a digest manifest
  $L9_SUDO mkdir -p -m 0700 -- "$bundle/stages/L9" || return 1
  : | $L9_SUDO tee "$bundle/L9-BUNDLE-SHA256SUMS" >/dev/null || return 1
  for rel in "${files[@]}"; do
    src="$p4/$rel"; dst="$bundle/$rel"
    got=$(sha256sum -- "$src" | cut -d' ' -f1)
    $L9_SUDO install -o root -g root -m 0555 -- "$src" "$dst" || return 1
    printf '%s  %s\n' "$got" "$rel" | $L9_SUDO tee -a "$bundle/L9-BUNDLE-SHA256SUMS" >/dev/null || return 1
  done
  $L9_SUDO chown -R root:root -- "$bundle"
  $L9_SUDO chmod 0555 "$bundle" "$bundle/stages" "$bundle/stages/L9"
  l9_fsync "$bundle/L9-BUNDLE-SHA256SUMS" && l9_fsync "$bundle" || return 1
  $L9_SUDO sha256sum -c --quiet --strict "$bundle/L9-BUNDLE-SHA256SUMS" >/dev/null 2>&1
}
# l9_record_success MAIN L8_MAIN BUNDLE_SHA256 EVIDENCE_ROOT — the unique host closeout. It is written only after VERIFY, preservation
# and the secret scan passed, with the EXACT key set below, and never replaced.
l9_record_success() {
  local main=${1:-} l8=${2:-} bundle_sha=${3:-} evidence=${4:-} marker closeout
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$l8" =~ ^[0-9a-f]{40}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* && "$evidence" != *..* ]] || return 1
  marker=$(l9_marker_path); closeout=$(l9_closeout_path)
  $L9_SUDO test -f "$marker" && ! $L9_SUDO test -L "$marker" || return 1
  if ! printf 'L9_LIVE=CLOSED_PASS\nL9_LIVE_EXECUTED=YES\nL9_RESULT=PASS\nL9_ATTEMPT_CONSUMED=YES\nL9_RERUN_ALLOWED=NO\nL9_STAGE=L9\nL9_EVIDENCE_CLASS=LIVE_CORE_OBSERVATION\nL9_EXPECTED_MAIN=%s\nL8_EXECUTION_MAIN=%s\nL9_EVIDENCE_BUNDLE_SHA256=%s\nL9_EVIDENCE_ROOT=%s\nL9_AUTHENTICATED_STATUS_OBSERVED=YES\nL9_DEADMAN_ABSENT_OVER_WINDOW=YES\nL9_COMMANDS_EMITTED=0\nL9_RELAY_ACTUATION=NONE\nL9_NEGATIVE_PROBES_INJECTED_LIVE=NO\nL9_PRE_POST_PRESERVATION=PASS\nL9_SECRET_SCAN=PASS\nL9_FAILURE_RESULT=NONE\n' "$main" "$l8" "$bundle_sha" "$evidence" | $L9_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$closeout"; then return 1; fi
  l9_fsync "$closeout" && l9_fsync "$(dirname "$closeout")" || return 1
  $L9_SUDO chattr +i "$closeout" 2>/dev/null || true
}
