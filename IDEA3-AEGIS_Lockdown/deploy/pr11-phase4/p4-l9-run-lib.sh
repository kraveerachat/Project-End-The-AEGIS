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
# l9_consume_attempt WORK EVIDENCE DEVICE RUN_ID OBSERVE_TOOL MAIN RUNNER_SHA256 — consume the single global attempt, durably, BEFORE the
# observation. The marker binds the run id, exact main, frozen runner SHA, work and evidence paths and the device, and stores the PRE
# boundary taken from the Core's own sources (never a caller value outside the guarded test seam).
l9_consume_attempt() {
  local work=${1:-} evidence=${2:-} device=${3:-} run=${4:-} tool=${5:-} main=${6:-} runner=${7:-} dir marker boundary
  [[ "$work" == /* && "$work" != *..* && "$evidence" == /* && "$evidence" != *..* && "$tool" == /* && "$tool" != *..* ]] || return 1
  [[ "$device" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ && "$run" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$main" =~ ^[0-9a-f]{40}$ && "$runner" =~ ^[0-9a-f]{64}$ ]] || return 1
  l9_marker_unconsumed || return 1; dir=$(l9_canonical_dir); marker=$(l9_marker_path)
  if ! $L9_SUDO test -d "$dir"; then $L9_SUDO mkdir -m 0700 "$dir" || return 1; fi
  l9_fsync "$(dirname "$dir")" || return 1
  if [ "${AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_L9_TEST_ONLY_BOUNDARY:-}" ]; then
    boundary=$AEGIS_L9_TEST_ONLY_BOUNDARY
  else
    boundary=$($L9_SUDO /usr/bin/python3 -I "$tool" capture-boundary --device-id "$device") || return 1
  fi
  if ! printf 'L9_ATTEMPT_CONSUMED=YES\nL9_RERUN_ALLOWED=NO\nL9_DEVICE_ID=%s\nL9_RUN_ID=%s\nL9_EXPECTED_MAIN=%s\nL9_RUNNER_SHA256=%s\nL9_WORK_DIR=%s\nL9_EVIDENCE_DIR=%s\nL9_CONSUMED_AT_EPOCH=%s\n%s\n' "$device" "$run" "$main" "$runner" "$work" "$evidence" "$(date -u +%s.%N)" "$boundary" | $L9_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$marker"; then echo L9_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
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
# l9_record_success MAIN L8_MAIN BUNDLE_SHA256 EVIDENCE_ROOT RUN_ID RUNNER_SHA256 — the unique host terminal closeout. It is written only after
# VERIFY, preservation and the secret scan passed, with the EXACT ordered key set below (the same set p4-l9-closeout.py verifies and derives
# the repository receipt from), and never replaced.
l9_record_success() {
  local main=${1:-} l8=${2:-} bundle_sha=${3:-} evidence=${4:-} run=${5:-} runner=${6:-} marker closeout
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$l8" =~ ^[0-9a-f]{40}$ && "$bundle_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* && "$evidence" != *..* && "$run" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$runner" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker=$(l9_marker_path); closeout=$(l9_closeout_path)
  $L9_SUDO test -f "$marker" && ! $L9_SUDO test -L "$marker" || return 1
  if ! printf 'L9_LIVE=CLOSED_PASS\nL9_LIVE_EXECUTED=YES\nL9_RESULT=PASS\nL9_ATTEMPT_CONSUMED=YES\nL9_RERUN_ALLOWED=NO\nL9_STAGE=L9\nL9_EVIDENCE_CLASS=LIVE_CORE_OBSERVATION\nL9_AUTHENTICATED_STATUS_OBSERVED=YES\nL9_DEADMAN_ABSENT_OVER_WINDOW=YES\nL9_COMMANDS_EMITTED=0\nL9_RELAY_ACTUATION=NONE\nL9_NEGATIVE_PROBES_INJECTED_LIVE=NO\nL9_PRE_POST_PRESERVATION=PASS\nL9_SECRET_SCAN=PASS\nL9_FAILURE_RESULT=NONE\nL9_EXPECTED_MAIN=%s\nL9_RUN_ID=%s\nL9_RUNNER_SHA256=%s\nL8_EXECUTION_MAIN=%s\nL9_EVIDENCE_BUNDLE_SHA256=%s\nL9_EVIDENCE_ROOT=%s\nL9_TERMINAL_EPOCH=%s\n' "$main" "$run" "$runner" "$l8" "$bundle_sha" "$evidence" "$(date -u +%s.%N)" | $L9_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$closeout"; then return 1; fi
  l9_fsync "$closeout" && l9_fsync "$(dirname "$closeout")" || return 1
  $L9_SUDO chattr +i "$closeout" 2>/dev/null || true
}
