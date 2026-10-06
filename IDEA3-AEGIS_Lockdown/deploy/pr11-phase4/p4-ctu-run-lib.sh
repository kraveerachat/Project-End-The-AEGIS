#!/usr/bin/env bash
# CTu's fixed one-attempt governance primitives. AUTH_DIR never redirects the
# stage-global marker.
set -Eeuo pipefail
CTU_CANONICAL_DIR=/var/lib/aegis-idea3-governance
CTU_GLOBAL_MARKER_NAME=CTU-GLOBAL-ATTEMPT-CONSUMED
CTU_SUDO=${SUDO-sudo}
CTU_CLOSEOUT_NAME=CTU-GLOBAL-CLOSEOUT-PASS
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
}
ctu_fsync() { $CTU_SUDO sync -- "$1" 2>/dev/null; }
ctu_consume_attempt() {
  local work=${1:-} device=${2:-} verifier=${3:-} dir marker boundary; [[ "$work" == /* && "$work" != *..* ]] || return 1
  [[ "$device" =~ ^[A-Za-z0-9._-]+$ && "$verifier" == /* && "$verifier" != *..* ]] || return 1
  ctu_marker_unconsumed || return 1; dir=$(ctu_canonical_dir); marker=$(ctu_marker_path)
  if ! $CTU_SUDO test -d "$dir"; then $CTU_SUDO mkdir -m 0700 "$dir" || return 1; fi
  ctu_fsync "$(dirname "$dir")" || return 1
  if [ "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" = YES ] && [ -n "${AEGIS_CTU_TEST_ONLY_BOUNDARY:-}" ]; then
    boundary=$AEGIS_CTU_TEST_ONLY_BOUNDARY
  else
    boundary=$($CTU_SUDO /usr/bin/python3 "$verifier" --capture-boundary --device-id "$device") || return 1
  fi
  if ! printf 'CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_DEVICE_ID=%s\nCTU_CONSUMED_AT_EPOCH=%s\nwork=%s\n%s\n' "$device" "$(date -u +%s.%N)" "$work" "$boundary" | $CTU_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$marker"; then echo CTU_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
  CTU_MARKER_CREATED=1
  ctu_fsync "$marker" && ctu_fsync "$dir" || { echo CTU_MARKER_NOT_DURABLE_ATTEMPT_CONSUMED >&2; return 1; }
  $CTU_SUDO chattr +i "$marker" 2>/dev/null || true
}
ctu_prepare_unit_snapshot() {
  local source=${1:-} snapshot=${2:-} expected=${3:-} tmp
  [ -f "$source" ] && [ ! -L "$source" ] || { echo CTU_UNIT_SOURCE_NOT_REGULAR >&2; return 1; }
  [ "$(stat -c %F -- "$source" 2>/dev/null)" = "regular file" ] || { echo CTU_UNIT_SOURCE_NOT_REGULAR >&2; return 1; }
  [[ "$snapshot" == /* && "$snapshot" != *..* && "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  tmp="$snapshot.tmp.$$.${RANDOM}"
  $CTU_SUDO mkdir -p -m 0700 -- "$(dirname "$snapshot")" || return 1
  $CTU_SUDO install -o root -g root -m 0644 -- "$source" "$tmp" || return 1
  $CTU_SUDO mv -f -- "$tmp" "$snapshot" || return 1
  $CTU_SUDO test ! -L "$snapshot" || return 1
  [ "$($CTU_SUDO stat -c %u -- "$snapshot")" = 0 ] || return 1
  [ "$($CTU_SUDO sha256sum -- "$snapshot" | cut -d' ' -f1)" = "$expected" ] || { echo CTU_UNIT_SNAPSHOT_SHA256_MISMATCH >&2; return 1; }
  ctu_fsync "$snapshot" && ctu_fsync "$(dirname "$snapshot")"
}
ctu_prepare_bundle() {
  local repo=${1:-} p4=${2:-} bundle=${3:-} main=${4:-} rel src dst got expected
  [[ "$repo" == /* && "$p4" == /* && "$bundle" == /* && "$bundle" != *..* && "$main" =~ ^[0-9a-f]{40}$ ]] || return 1
  local -a files=(
    p4-lib.sh p4-l0-capture.sh p4-compare.sh p4-l7u-run-lib.sh p4-l7-run-lib.sh p4-l6b-run-lib.sh p4-ctu-runtime-verify.py
    stages/CTu/apply.sh stages/CTu/verify.sh stages/CTu/rollback.sh
    stages/CTu/allow-keys.txt stages/CTu/allow-keys-rollback.txt stages/CTu/allow-listeners.txt
  )
  $CTU_SUDO mkdir -p -m 0700 -- "$bundle/stages/CTu" || return 1
  : | $CTU_SUDO tee "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null || return 1
  for rel in "${files[@]}"; do
    src="$p4/$rel"; dst="$bundle/$rel"
    [ -f "$src" ] && [ ! -L "$src" ] || { echo "CTU_BUNDLE_SOURCE_INVALID:$rel" >&2; return 1; }
    git -C "$repo" cat-file -e "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null || return 1
    expected=$(git -C "$repo" show "$main:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/$rel" 2>/dev/null | sha256sum | cut -d' ' -f1) || return 1
    got=$(sha256sum -- "$src" | cut -d' ' -f1)
    [ "$got" = "$expected" ] || { echo "CTU_BUNDLE_SOURCE_NOT_EXACT_MAIN:$rel" >&2; return 1; }
    $CTU_SUDO install -o root -g root -m 0555 -- "$src" "$dst" || return 1
    printf '%s  %s\n' "$got" "$rel" | $CTU_SUDO tee -a "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null || return 1
  done
  $CTU_SUDO chown -R root:root -- "$bundle"
  $CTU_SUDO chmod 0555 "$bundle" "$bundle/stages" "$bundle/stages/CTu"
  ctu_fsync "$bundle/CTU-BUNDLE-SHA256SUMS" && ctu_fsync "$bundle" || return 1
  $CTU_SUDO sha256sum -c --quiet --strict "$bundle/CTU-BUNDLE-SHA256SUMS" >/dev/null 2>&1
}
ctu_record_success() {
  local main=${1:-} unit_sha=${2:-} evidence=${3:-} marker closeout
  [[ "$main" =~ ^[0-9a-f]{40}$ && "$unit_sha" =~ ^[0-9a-f]{64}$ && "$evidence" == /* && "$evidence" != *..* ]] || return 1
  marker=$(ctu_marker_path); closeout=$(ctu_closeout_path)
  $CTU_SUDO test -f "$marker" && ! $CTU_SUDO test -L "$marker" || return 1
  if ! printf 'CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_EXPECTED_MAIN=%s\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\nCTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\nCTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=%s\nCTU_EVIDENCE_ROOT=%s\n' "$main" "$unit_sha" "$evidence" | $CTU_SUDO bash -c 'set -o noclobber; cat > "$1"' _ "$closeout"; then
    return 1
  fi
  ctu_fsync "$closeout" && ctu_fsync "$(dirname "$closeout")"
}
ctu_operator_identity_gate() {
  local expected_user=${1:-} expected_uid=${2:-} actual_uid actual_user
  [[ "$expected_user" =~ ^[a-z_][a-z0-9_-]*$ && "$expected_uid" =~ ^[1-9][0-9]*$ ]] || return 1
  actual_uid=$(id -u); actual_user=$(id -un)
  [ "$actual_uid" = "$expected_uid" ] && [ "$actual_user" = "$expected_user" ] && [ "$actual_uid" != 0 ]
}
