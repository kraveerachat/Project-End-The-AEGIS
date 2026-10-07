#!/usr/bin/env bash
# CTu's fixed one-attempt governance primitives. AUTH_DIR never redirects the
# stage-global marker.
set -Eeuo pipefail
CTU_CANONICAL_DIR=/var/lib/aegis-idea3-governance
CTU_GLOBAL_MARKER_NAME=CTU-GLOBAL-ATTEMPT-CONSUMED
CTU_SUDO="${CTU_SUDO-${SUDO-sudo}}"
CTU_CLOSEOUT_NAME=CTU-GLOBAL-CLOSEOUT-PASS
ctu_git() {
  HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"
}
ctu_canonical_dir() {
  if [ "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR:-}" ]; then printf '%s' "$AEGIS_CTU_TEST_ONLY_CANONICAL_DIR"; else printf '%s' "$CTU_CANONICAL_DIR"; fi
}
ctu_trusted_dir_chain() {
  local dir=${1:-} owner=0 stop=/; [ -n "$CTU_SUDO" ] || owner=$(id -u)
  if [ "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_CTU_TEST_ONLY_TRUST_ROOT:-}" ]; then stop=$AEGIS_CTU_TEST_ONLY_TRUST_ROOT; fi
  [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  while :; do
    $CTU_SUDO test -d "$dir" && ! $CTU_SUDO test -L "$dir" || return 1
    [ "$($CTU_SUDO stat -c %u "$dir" 2>/dev/null)" = "$owner" ] || return 1
    [ -z "$($CTU_SUDO find "$dir" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
    [ "$dir" = "$stop" ] && return 0
    [ "$dir" != / ] || return 1
    dir=$(dirname "$dir")
  done
}
ctu_canonical_dir_valid() {
  local dir; dir=$(ctu_canonical_dir); [[ "$dir" == /* && "$dir" != *..* ]] || return 1
  if $CTU_SUDO test -e "$dir" || $CTU_SUDO test -L "$dir"; then ctu_trusted_dir_chain "$dir"; else ctu_trusted_dir_chain "$(dirname "$dir")"; fi
}
ctu_marker_path() { printf '%s/%s' "$(ctu_canonical_dir)" "$CTU_GLOBAL_MARKER_NAME"; }
ctu_closeout_path() { printf '%s/%s' "$(ctu_canonical_dir)" "$CTU_CLOSEOUT_NAME"; }
ctu_marker_unconsumed() {
  ctu_canonical_dir_valid || { echo CTU_CANONICAL_DIR_NOT_TRUSTED >&2; return 1; }
  local marker; marker=$(ctu_marker_path)
  if $CTU_SUDO test -e "$marker" || $CTU_SUDO test -L "$marker"; then echo CTU_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
  local canon pass fail
  canon=$(ctu_canonical_dir)
  pass="$canon/CTU-GLOBAL-CLOSEOUT-PASS"
  fail="$canon/CTU-GLOBAL-CLOSEOUT-FAIL"
  if $CTU_SUDO test -e "$pass" || $CTU_SUDO test -L "$pass" || $CTU_SUDO test -e "$fail" || $CTU_SUDO test -L "$fail"; then
    echo CTU_CLOSEOUT_ALREADY_PRESENT >&2; return 1
  fi
}
ctu_fsync() { ${CTU_SUDO:-} sync -- "$1" 2>/dev/null; }
ctu_validate_core_env_device_id() {
  local env_file=${1:-/etc/aegis-idea3/core.env} expected=${2:-}
  [[ "$expected" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "CTU_DEVICE_ID_GRAMMAR_INVALID" >&2; return 1; }
  ${CTU_SUDO:-} test -f "$env_file" && ! ${CTU_SUDO:-} test -L "$env_file" || { echo "CTU_CORE_ENV_MISSING_OR_SYMLINK" >&2; return 1; }
  local out
  out=$(${CTU_SUDO:-} /usr/bin/python3 -I -B -c '
import sys, re
path, expected = sys.argv[1], sys.argv[2]
pattern = re.compile(r"^[ \t]*AEGIS_P1_DEVICE_ID[ \t]*=(.*)$")
device_re = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
matches = []
try:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped.startswith(";"):
                continue
            m = pattern.match(line)
            if m:
                val = m.group(1).strip()
                if len(val) >= 2 and ((val.startswith("\"") and val.endswith("\"")) or (val.startswith("\x27") and val.endswith("\x27"))):
                    val = val[1:-1]
                matches.append(val)
except Exception:
    sys.exit(2)
if len(matches) == 0:
    print("MISSING_DEVICE_ID")
    sys.exit(1)
if len(matches) > 1:
    print("DUPLICATE_DEVICE_ID")
    sys.exit(1)
dev = matches[0]
if not device_re.fullmatch(dev):
    print("MALFORMED_DEVICE_ID")
    sys.exit(1)
if dev != expected:
    print("DEVICE_ID_MISMATCH")
    sys.exit(1)
print("MATCH")
' "$env_file" "$expected" 2>/dev/null) || {
    echo "CTU_CORE_ENV_VALIDATION_FAILED:${out:-EXEC_ERROR}" >&2
    return 1
  }
  [ "$out" = "MATCH" ]
}
ctu_consume_attempt() {
  local work=${1:-} device=${2:-} verifier=${3:-} runner_sha=${4:-} bundle=${5:-} dir marker provenance boundary bundle_sha; [[ "$work" == /* && "$work" != *..* ]] || return 1
  [[ "$device" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && "$verifier" == /* && "$verifier" != *..* ]] || return 1
  local provenance=1
  if [ -z "$runner_sha" ] && [ -z "$bundle" ]; then provenance=0; else
    [[ "$runner_sha" =~ ^[0-9a-f]{64}$ && "$bundle" == /* && "$bundle" != *..* && -f "$bundle/CTU-BUNDLE-SHA256SUMS" ]] || return 1
    bundle_sha=$(sha256sum "$bundle/CTU-BUNDLE-SHA256SUMS" | cut -d' ' -f1)
  fi
  ctu_marker_unconsumed || return 1; dir=$(ctu_canonical_dir); marker=$(ctu_marker_path)
  if ! $CTU_SUDO test -d "$dir"; then $CTU_SUDO mkdir -m 0700 "$dir" || return 1; fi
  ctu_fsync "$(dirname "$dir")" || return 1
  if [ "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_CTU_TEST_ONLY_BOUNDARY:-}" ]; then
    boundary=$AEGIS_CTU_TEST_ONLY_BOUNDARY
  else
    boundary=$($CTU_SUDO /usr/bin/python3 -I -B "$verifier" --capture-boundary --device-id "$device") || return 1
  fi
  if [ "$provenance" = 1 ]; then
    marker_extra=$(printf 'CTU_FROZEN_RUNNER_SHA256=%s\nCTU_BUNDLE_MANIFEST_SHA256=%s\n' "$runner_sha" "$bundle_sha")
  else marker_extra=""; fi
  if ! printf 'CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_DEVICE_ID=%s\n%sCTU_CONSUMED_AT_EPOCH=%s\nwork=%s\n%s\n' "$device" "$marker_extra" "$(date -u +%s.%N)" "$work" "$boundary" | $CTU_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$marker"; then echo CTU_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
  CTU_MARKER_CREATED=1
  ctu_fsync "$marker" && ctu_fsync "$dir" || { echo CTU_MARKER_NOT_DURABLE_ATTEMPT_CONSUMED >&2; return 1; }
  if [ "$provenance" = 1 ]; then
    provenance="$dir/CTU-FROZEN-RUNNER-PROVENANCE"
    if ! printf 'CTU_FROZEN_RUNNER_SHA256=%s\nCTU_BUNDLE_MANIFEST_SHA256=%s\n' "$runner_sha" "$bundle_sha" | $CTU_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$provenance"; then
      echo CTU_HANDLER_PROVENANCE_NOT_CREATED >&2
      return 1
    fi
    $CTU_SUDO chmod 0400 "$provenance" || return 1
    ctu_fsync "$provenance" && ctu_fsync "$dir" || { echo CTU_HANDLER_PROVENANCE_NOT_DURABLE >&2; return 1; }
  fi
  $CTU_SUDO chattr +i "$marker" 2>/dev/null || true
}
ctu_prepare_work_dir() {
  local work=${1:-} owner="root:root"
  [[ "$work" == /* && "$work" != *..* ]] || return 1
  if [ -z "$CTU_SUDO" ] && [ "$(id -u)" != 0 ]; then
    owner="$(id -u):$(id -g)"
  fi
  $CTU_SUDO mkdir -p -- "$work" || return 1
  $CTU_SUDO chown "$owner" -- "$work" || return 1
  $CTU_SUDO chmod 0711 -- "$work" || return 1
  ctu_fsync "$work" || return 1
  ctu_verify_work_dir "$work"
}
ctu_verify_work_dir() {
  local work=${1:-} owner="0:0"
  [[ "$work" == /* && "$work" != *..* ]] || return 1
  if [ -z "$CTU_SUDO" ] && [ "$(id -u)" != 0 ]; then
    owner="$(id -u):$(id -g)"
  fi
  [ -d "$work" ] && [ ! -L "$work" ] || return 1
  [ "$($CTU_SUDO stat -c %u:%g -- "$work" 2>/dev/null)" = "$owner" ] || return 1
  case "$($CTU_SUDO stat -c %a -- "$work" 2>/dev/null)" in 711|0711) ;; *) return 1 ;; esac
  [ -z "$($CTU_SUDO find "$work" -maxdepth 0 -perm /022 2>/dev/null)" ] || return 1
  [ -x "$work" ] || return 1
  if [ "$(id -u)" != 0 ] && [ "$owner" = "0:0" ]; then
    [ ! -w "$work" ] || return 1
    [ ! -r "$work" ] || return 1
  fi
}
ctu_prepare_unit_snapshot() {
  local source=${1:-} snapshot=${2:-} expected=${3:-} tmp
  [ -f "$source" ] && [ ! -L "$source" ] || { echo CTU_UNIT_SOURCE_NOT_REGULAR >&2; return 1; }
  [ "$(stat -c %F -- "$source" 2>/dev/null)" = "regular file" ] || { echo CTU_UNIT_SOURCE_NOT_REGULAR >&2; return 1; }
  [[ "$snapshot" == /* && "$snapshot" != *..* && "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  tmp="$snapshot.tmp.$$.${RANDOM}"
  ctu_prepare_work_dir "$(dirname "$snapshot")" || return 1
  $CTU_SUDO install -o root -g root -m 0644 -- "$source" "$tmp" || return 1
  $CTU_SUDO mv -f -- "$tmp" "$snapshot" || return 1
  $CTU_SUDO test ! -L "$snapshot" || return 1
  [ "$($CTU_SUDO stat -c %u -- "$snapshot")" = 0 ] || return 1
  [ "$($CTU_SUDO stat -c %a -- "$snapshot")" = "644" ] || return 1
  [ "$($CTU_SUDO sha256sum -- "$snapshot" | cut -d' ' -f1)" = "$expected" ] || { echo CTU_UNIT_SNAPSHOT_SHA256_MISMATCH >&2; return 1; }
  ctu_fsync "$snapshot" && ctu_fsync "$(dirname "$snapshot")"
}
ctu_prepare_bundle() {
  local repo=${1:-} p4=${2:-} bundle=${3:-} main=${4:-} rel src dst got expected
  [[ "$repo" == /* && "$p4" == /* && "$bundle" == /* && "$bundle" != *..* && "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  local -a files=(
    p4-lib.sh p4-stage-gate.sh p4-ctu-run-lib.sh p4-l0-capture.sh p4-compare.sh p4-l7u-run-lib.sh p4-l7-run-lib.sh p4-l6b-run-lib.sh p4-ctu-runtime-verify.py
    stages/CTu/apply.sh stages/CTu/verify.sh stages/CTu/rollback.sh
    stages/CTu/allow-keys.txt stages/CTu/allow-keys-rollback.txt stages/CTu/allow-listeners.txt
    p4-iw-phy-regnorm.awk owner-run/run-ctu-owner.sh ctu-acceptance/ctu_dropin_contract.py
  )
  ctu_prepare_work_dir "$(dirname "$bundle")" || return 1
  $CTU_SUDO mkdir -p -m 0700 -- "$bundle/stages/CTu" "$bundle/owner-run" "$bundle/ctu-acceptance" || return 1
  : | $CTU_SUDO tee "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null || return 1
  for rel in "${files[@]}"; do
    src="$p4/$rel"; dst="$bundle/$rel"
    [ -f "$src" ] && [ ! -L "$src" ] || { echo "CTU_BUNDLE_SOURCE_INVALID:$rel" >&2; return 1; }
    ctu_git -C "$repo" cat-file -e "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null || return 1
    expected=$(ctu_git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1) || return 1
    got=$(sha256sum -- "$src" | cut -d' ' -f1)
    [ "$got" = "$expected" ] || { echo "CTU_BUNDLE_SOURCE_NOT_EXACT_MAIN:$rel" >&2; return 1; }
    $CTU_SUDO install -o root -g root -m 0555 -- "$src" "$dst" || return 1
    printf '%s  %s\n' "$got" "$rel" | $CTU_SUDO tee -a "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null || return 1
  done
  $CTU_SUDO chown -R root:root -- "$bundle"
  $CTU_SUDO chmod 0555 "$bundle" "$bundle/stages" "$bundle/stages/CTu" "$bundle/owner-run" "$bundle/ctu-acceptance"
  $CTU_SUDO chmod 0444 "$bundle/CTU-BUNDLE-SHA256SUMS"
  ctu_fsync "$bundle/CTU-BUNDLE-SHA256SUMS" && ctu_fsync "$bundle" || return 1
  ctu_verify_work_dir "$(dirname "$bundle")" || return 1
  ( cd "$bundle" && $CTU_SUDO sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) >/dev/null 2>&1
}
ctu_verify_bundle() {
  local bundle=${1:-}
  [[ "$bundle" == /* && "$bundle" != *..* ]] || return 1
  ctu_verify_work_dir "$(dirname "$bundle")" || return 1
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || return 1
  [ "$($CTU_SUDO stat -c %u -- "$bundle" 2>/dev/null)" = 0 ] || return 1
  [ -z "$($CTU_SUDO find "$bundle" -type l -print -quit)" ] || return 1
  ( cd "$bundle" && $CTU_SUDO sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) >/dev/null 2>&1
}
ctu_verify_unit_snapshot() {
  local snapshot=${1:-} expected=${2:-}
  [[ "$snapshot" == /* && "$snapshot" != *..* ]] || return 1
  ctu_verify_work_dir "$(dirname "$snapshot")" || return 1
  [ -f "$snapshot" ] && [ ! -L "$snapshot" ] || return 1
  [ "$($CTU_SUDO stat -c %u -- "$snapshot" 2>/dev/null)" = 0 ] || return 1
  [ "$($CTU_SUDO stat -c %a -- "$snapshot" 2>/dev/null)" = "644" ] || return 1
  [ "$($CTU_SUDO sha256sum -- "$snapshot" 2>/dev/null | cut -d' ' -f1)" = "$expected" ]
}
CTU_KEEPALIVE_PID=""
ctu_start_sudo_keepalive() {
  local parent=$$ max=3600 interval=20 waited=0
  [ -z "$CTU_KEEPALIVE_PID" ] || return 0
  (
    while kill -0 "$parent" 2>/dev/null && [ "$waited" -lt "$max" ]; do
      sleep "$interval"; waited=$((waited + interval))
      sudo -n -v >/dev/null 2>&1 </dev/null || exit 1
    done
  ) >/dev/null 2>&1 </dev/null &
  CTU_KEEPALIVE_PID=$!
}
ctu_stop_sudo_keepalive() {
  if [ -n "$CTU_KEEPALIVE_PID" ]; then
    kill "$CTU_KEEPALIVE_PID" 2>/dev/null || true
    wait "$CTU_KEEPALIVE_PID" 2>/dev/null || true
    CTU_KEEPALIVE_PID=""
  fi
}
ctu_record_success() {
  local main=${1:-} unit_sha=${2:-} evidence=${3:-} device=${4:-aegis-relay-01} detector_mode=${5:-ACTIVE} runner_sha=${6:-} evidence_manifest_sha=${7:-} marker closeout tmp fail_closeout
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$unit_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* && "$evidence" != *..* ]] || return 1
  [[ "$device" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || return 1
  [[ "$detector_mode" =~ ^(ACTIVE|INACTIVE)$ ]] || return 1
  [[ "$runner_sha" =~ ^[0-9a-f]{64}$ && "$evidence_manifest_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  marker=$(ctu_marker_path); closeout=$(ctu_closeout_path)
  fail_closeout="$(ctu_canonical_dir)/CTU-GLOBAL-CLOSEOUT-FAIL"
  if $CTU_SUDO test -e "$fail_closeout" || $CTU_SUDO test -L "$fail_closeout"; then
    echo CTU_FAIL_CLOSEOUT_ALREADY_EXISTS >&2; return 1
  fi
  $CTU_SUDO test -f "$marker" && ! $CTU_SUDO test -L "$marker" || return 1
  tmp="$closeout.tmp.$$"
  printf 'CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_EXPECTED_MAIN=%s\nCTU_EXECUTION_MAIN=%s\nCTU_RUNNER_SHA256=%s\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\nCTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=%s\nCTU_DEVICE_ID=%s\nCTU_EVIDENCE_MANIFEST_SHA256=%s\nCTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\nCTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=%s\nCTU_EVIDENCE_ROOT=%s\n' "$main" "$main" "$runner_sha" "$detector_mode" "$device" "$evidence_manifest_sha" "$unit_sha" "$evidence" | $CTU_SUDO bash -c 'umask 077; cat > "$1"' _ "$tmp" || return 1
  $CTU_SUDO chmod 0600 -- "$tmp" || return 1
  ctu_fsync "$tmp" || return 1
  $CTU_SUDO mv -n -- "$tmp" "$closeout" || return 1
  ctu_fsync "$(dirname "$closeout")" || return 1
  local host_sha; host_sha=$($CTU_SUDO sha256sum "$closeout" | cut -d' ' -f1) || return 1
  printf '%s  %s\n' "$host_sha" "$(basename "$closeout")" | $CTU_SUDO bash -c 'umask 077; cat > "$1"' _ "${closeout}.sha256" || return 1
  $CTU_SUDO chmod 0600 -- "${closeout}.sha256" || return 1
  ctu_fsync "${closeout}.sha256" && ctu_fsync "$(dirname "$closeout")"
}
ctu_record_failure() {
  local reason=${1:-UNKNOWN} marker closeout tmp
  marker=$(ctu_marker_path); closeout="$(ctu_canonical_dir)/CTU-GLOBAL-CLOSEOUT-FAIL"
  $CTU_SUDO test -e "$marker" || return 0
  tmp="$closeout.tmp.$$"
  printf 'CTU_LIVE=CLOSED_FAIL\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=FAIL_IMMUTABLE\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_FAILURE_RESULT=FAIL_IMMUTABLE\nCTU_FAILURE_REASON=%s\n' "$reason" | $CTU_SUDO bash -c 'umask 077; cat > "$1"' _ "$tmp" || return 1
  $CTU_SUDO chmod 0600 -- "$tmp" || return 1
  ctu_fsync "$tmp" || return 1
  $CTU_SUDO mv -n -- "$tmp" "$closeout" || return 1
  ctu_fsync "$(dirname "$closeout")"
}
ctu_operator_identity_gate() {
  local expected_user=${1:-} expected_uid=${2:-} actual_uid actual_user
  [[ "$expected_user" =~ ^[a-z_][a-z0-9_-]*$ && "$expected_uid" =~ ^[1-9][0-9]*$ ]] || return 1
  actual_uid=$(id -u); actual_user=$(id -un)
  [ "$actual_uid" = "$expected_uid" ] && [ "$actual_user" = "$expected_user" ] && [ "$actual_uid" != 0 ]
}
ctu_rru_successor_gate() {
  local repo=${1:-} main=${2:-} files
  [ -n "$repo" ] && [ -d "$repo/.git" ] && [[ "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  files=$(ctu_git -C "$repo" grep -l "RRU_LIVE=CLOSED_PASS" "$main" -- 'Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/' 2>/dev/null || true)
  [ -n "$files" ] || { echo "CTU_RRU_SUCCESSOR_GATE_FAILED" >&2; return 1; }
}
