#!/usr/bin/env bash
# LVR read-only successor gate. Sourced by the frozen owner runner and tests;
# it never creates markers and never changes Production.
set -o pipefail
export LC_ALL=C

LVR_LOG_REL="Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
LVR_CLOSEOUT_GLOB='*_music_idea3-recovery-live-closeout.md'

lvr_reason() { printf '%s\n' "$1" >&2; return 1; }

lvr_git() { GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 command git "$@"; }

lvr_path_ok() {
  local p=${1:-}
  [[ "$p" == /* && "$p" != *..* && "$p" != *$'\n'* && "$p" != *$'\r'* && "$p" != *$'\t'* ]] || return 1
  [ "$(readlink -f -- "$p" 2>/dev/null)" = "$p" ] || return 1
}

lvr_required_field() {
  local text=$1 key=$2 want=$3 count
  count=$(printf '%s\n' "$text" | awk -F= -v k="$key" '$1 == k {n++} END {print n+0}')
  [ "$count" = 1 ] || return 1
  printf '%s\n' "$text" | grep -qxF "$key=$want"
}

lvr_operator_identity_gate() {
  local want_user=${1:-} want_uid=${2:-}
  [[ "$want_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
  [[ "$want_uid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  [ "$(id -u)" != 0 ] || return 1
  [ "$(id -u)" = "$want_uid" ] || return 1
  [ "$(id -un 2>/dev/null)" = "$want_user" ] || return 1
}

lvr_recovery_closeout_gate() {
  local repo=${1:-} main=${2:-} path content exec_main count paths entries mode
  [ -d "$repo/.git" ] || { lvr_reason LVR_REPO_INVALID; return 1; }
  [[ "$main" =~ ^[0-9a-f]{40}$ ]] || { lvr_reason LVR_MAIN_INVALID; return 1; }
  [ "$(lvr_git -C "$repo" rev-parse --verify "$main^{commit}" 2>/dev/null)" = "$main" ] || { lvr_reason LVR_MAIN_NOT_COMMIT; return 1; }
  [ "$(lvr_git -C "$repo" rev-parse HEAD 2>/dev/null)" = "$main" ] || { lvr_reason LVR_REPO_HEAD_MISMATCH; return 1; }
  entries=$(lvr_git -C "$repo" ls-tree -r "$main" -- "$LVR_LOG_REL" | awk -v g="$LVR_CLOSEOUT_GLOB" 'index($0,"_music_idea3-recovery-live-closeout.md") && $0 ~ /\/90-Status\/logs\// {print}')
  count=$(printf '%s\n' "$entries" | sed '/^$/d' | wc -l)
  if [ "$count" -eq 0 ]; then
    lvr_reason LVR_RECOVERY_CLOSEOUT_MISSING
    return 1
  elif [ "$count" -gt 1 ]; then
    lvr_reason LVR_RECOVERY_CLOSEOUT_NOT_UNIQUE
    return 1
  fi
  mode=$(awk '{print $1}' <<<"$entries")
  if [ "$mode" = "120000" ]; then
    lvr_reason LVR_RECOVERY_CLOSEOUT_SYMLINK
    return 1
  elif [ "$mode" != "100644" ]; then
    lvr_reason LVR_RECOVERY_CLOSEOUT_NOT_REGULAR_FILE
    return 1
  fi
  path=$(awk '{print $4}' <<<"$entries")
  [ -z "${LVR_EXPECTED_CLOSEOUT_PATH:-}" ] || [ "$path" = "$LVR_EXPECTED_CLOSEOUT_PATH" ] || { lvr_reason LVR_RECOVERY_CLOSEOUT_PATH_MISMATCH; return 1; }
  content=$(lvr_git -C "$repo" show "$main:$path" 2>/dev/null) || { lvr_reason LVR_RECOVERY_CLOSEOUT_UNREADABLE; return 1; }
  for pair in \
    "RECOVERY_LIVE=CLOSED_PASS" \
    "RECOVERY_LIVE_EXECUTED=YES" \
    "RECOVERY_RESULT=PASS" \
    "RECOVERY_R2_R8_EXECUTED=YES" \
    "RECOVERY_ATTEMPT_CONSUMED=YES" \
    "RECOVERY_RERUN_ALLOWED=NO" \
    "RECOVERY_STAGE=Recovery" \
    "LVR_PROVEN=NO" \
    "L8_ACCEPTANCE=NO" \
    "L9_PROVEN=NO"; do
    lvr_required_field "$content" "${pair%%=*}" "${pair#*=}" || { lvr_reason "LVR_RECOVERY_CLOSEOUT_FIELD_INVALID:${pair%%=*}"; return 1; }
  done
  exec_main=$(printf '%s\n' "$content" | sed -n 's/^RECOVERY_EXECUTION_MAIN=//p')
  [[ "$exec_main" =~ ^[0-9a-f]{40}$ ]] || { lvr_reason LVR_RECOVERY_EXECUTION_MAIN_INVALID; return 1; }
  printf '%s\n' "$content" | grep -qx "RECOVERY_EXPECTED_MAIN=$exec_main" || { lvr_reason LVR_RECOVERY_EXPECTED_MAIN_INVALID; return 1; }
  lvr_git -C "$repo" merge-base --is-ancestor "$exec_main" "$main" || { lvr_reason LVR_RECOVERY_MAIN_NOT_ANCESTOR; return 1; }
  [ -z "$(printf '%s\n' "$content" | grep -E '^RECOVERY_(LIVE|RESULT)=CLOSED_FAIL|^RECOVERY_RESULT=FAIL')" ] || { lvr_reason LVR_RECOVERY_CONTRADICTORY_RESULT; return 1; }
  printf 'LVR_RECOVERY_CLOSEOUT=PASS\nLVR_RECOVERY_CLOSEOUT_PATH=%s\nLVR_RECOVERY_EXECUTION_MAIN=%s\n' "$path" "$exec_main"
}

lvr_recovery_marker_gate() {
  local marker=${1:-}
  [ -L "$marker" ] && { lvr_reason LVR_RECOVERY_MARKER_MISSING_OR_SYMLINK; return 1; }
  lvr_path_ok "$marker" || { lvr_reason LVR_RECOVERY_MARKER_PATH_INVALID; return 1; }
  [ -f "$marker" ] || { lvr_reason LVR_RECOVERY_MARKER_MISSING_OR_SYMLINK; return 1; }
  [ "$(stat -c %a -- "$marker" 2>/dev/null)" = 600 ] || { lvr_reason LVR_RECOVERY_MARKER_MODE_INVALID; return 1; }
  lvr_required_field "$(cat -- "$marker")" RECOVERY_ATTEMPT_CONSUMED YES || { lvr_reason LVR_RECOVERY_MARKER_NOT_CONSUMED; return 1; }
  lvr_required_field "$(cat -- "$marker")" RECOVERY_RERUN_ALLOWED NO || { lvr_reason LVR_RECOVERY_MARKER_RERUN_ALLOWED; return 1; }
}

lvr_validate_closeout_content() {
  local content=$1
  for pair in \
    "LVR_LIVE=CLOSED_PASS" \
    "LVR_LIVE_EXECUTED=YES" \
    "LVR_RESULT=PASS" \
    "LVR_STAGE=LVR" \
    "LVR_RECOVERY_PREDECESSOR=PASS" \
    "LVR_RUNTIME_PROOF=PASS" \
    "LVR_PRE_POST_PRESERVATION=PASS" \
    "LVR_S10=PASS" \
    "LVR_PRODUCTION_MUTATION=NO" \
    "LVR_FAILURE_RESULT=NONE" \
    "L8_ACCEPTANCE=NO" \
    "L9_PROVEN=NO"; do
    lvr_required_field "$content" "${pair%%=*}" "${pair#*=}" || return 1
  done
  local exec_main expected_main runner_sha recovery_main
  exec_main=$(printf '%s\n' "$content" | sed -n 's/^LVR_EXECUTION_MAIN=//p')
  [[ "$exec_main" =~ ^[0-9a-f]{40}$ ]] || return 1
  expected_main=$(printf '%s\n' "$content" | sed -n 's/^LVR_EXPECTED_MAIN=//p')
  [ "$expected_main" = "$exec_main" ] || return 1
  runner_sha=$(printf '%s\n' "$content" | sed -n 's/^LVR_RUNNER_SHA256=//p')
  [[ "$runner_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  recovery_main=$(printf '%s\n' "$content" | sed -n 's/^LVR_RECOVERY_EXECUTION_MAIN=//p')
  [[ "$recovery_main" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ -z "$(printf '%s\n' "$content" | grep -E '^LVR_(LIVE|RESULT)=CLOSED_FAIL|^LVR_RESULT=FAIL')" ] || return 1
  return 0
}
