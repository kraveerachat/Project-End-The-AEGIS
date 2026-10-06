#!/usr/bin/env bash
# CTu's fixed one-attempt governance primitives. AUTH_DIR never redirects the
# stage-global marker.
set -Eeuo pipefail
CTU_CANONICAL_DIR=/var/lib/aegis-idea3-governance
CTU_GLOBAL_MARKER_NAME=CTU-GLOBAL-ATTEMPT-CONSUMED
CTU_SUDO=${SUDO-sudo}
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
ctu_marker_unconsumed() {
  ctu_canonical_dir_valid || { echo CTU_CANONICAL_DIR_NOT_TRUSTED >&2; return 1; }
  local marker; marker=$(ctu_marker_path)
  if $CTU_SUDO test -e "$marker" || $CTU_SUDO test -L "$marker"; then echo CTU_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
}
ctu_fsync() { $CTU_SUDO sync -- "$1" 2>/dev/null; }
ctu_consume_attempt() {
  local work=${1:-} dir marker; [[ "$work" == /* && "$work" != *..* ]] || return 1
  ctu_marker_unconsumed || return 1; dir=$(ctu_canonical_dir); marker=$(ctu_marker_path)
  if ! $CTU_SUDO test -d "$dir"; then $CTU_SUDO mkdir -m 0700 "$dir" || return 1; fi
  ctu_fsync "$(dirname "$dir")" || return 1
  if ! $CTU_SUDO bash -c 'set -o noclobber; printf "CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nconsumed_at=%s\nwork=%s\n" "$(date -u +%FT%TZ)" "$2" > "$1"' _ "$marker" "$work"; then echo CTU_ATTEMPT_ALREADY_CONSUMED >&2; return 1; fi
  CTU_MARKER_CREATED=1
  ctu_fsync "$marker" && ctu_fsync "$dir" || { echo CTU_MARKER_NOT_DURABLE_ATTEMPT_CONSUMED >&2; return 1; }
  $CTU_SUDO chattr +i "$marker" 2>/dev/null || true
}
ctu_operator_identity_gate() {
  local expected_user=${1:-} expected_uid=${2:-} actual_uid actual_user
  [[ "$expected_user" =~ ^[a-z_][a-z0-9_-]*$ && "$expected_uid" =~ ^[1-9][0-9]*$ ]] || return 1
  actual_uid=$(id -u); actual_user=$(id -un)
  [ "$actual_uid" = "$expected_uid" ] && [ "$actual_user" = "$expected_user" ] && [ "$actual_uid" != 0 ]
}
