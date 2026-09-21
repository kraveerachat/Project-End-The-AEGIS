# shellcheck shell=bash
# shellcheck disable=SC2034  # constants are consumed by the scripts that source this file
# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 shared helpers for the capture, compare,
# and stage-gate harness. Sourced, never executed. Contains no live value, no
# secret, and no Production-changing operation.
#
# Authority: IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
#   2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md (§6 G-15, §9–§12)
# Regression tests: IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py

export LC_ALL=C
readonly P4_SCHEMA=1
readonly P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# AEGIS_P4_FS_ROOT is a TEST-ONLY prefix for file reads (/etc, /proc). A real
# capture leaves it unset. When set, every capture records
# meta.evidence_class=TEST_FIXTURE, so the result can never be mistaken for
# Core evidence.
readonly P4_FS_ROOT="${AEGIS_P4_FS_ROOT:-${P4_FS_ROOT:-}}"

# The owner's window calendar day (execution document §8, §12: same-day records).
readonly P4_WINDOW_TZ=Asia/Bangkok

# ── stages (execution document §9, §12) ──────────────────────────────────────
readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L7 L8 L9"

p4_stage_known() { [[ " $P4_STAGES " == *" $1 "* ]] && [ -n "$1" ]; }

# Every stage except the read-only L0 baseline changes the Core host.
p4_stage_mutates() { [ "$1" != L0 ]; }

# Repository gaps that must be merged before the stage (§6, §9). The gate
# reports them; it cannot verify merge state and never claims to.
p4_stage_gaps() {
  case "$1" in
    L0) echo none ;;
    L1) echo G-15 ;;
    L2) echo G-06,G-15 ;;
    L3) echo G-01,G-03,G-15 ;;
    L4) echo G-02,G-04,G-15 ;;
    L5) echo G-05,G-15 ;;
    L6a) echo G-07,G-08,G-09,G-10,G-14,G-15 ;;
    L6b) echo G-07,G-15 ;;
    L7) echo G-11,G-12 ;;
    L8) echo G-04,G-11,G-16 ;;
    L9) echo none ;;
  esac
}

# Extra same-day authorization fields required per stage (§12).
p4_stage_auth_extra() {
  case "$1" in
    L1 | L7) echo d6_notice ;;
    L2) echo integration_review ;;
    L8) echo recovery_authorization ;;
  esac
}

# ── rollback handler contract (G-15; no handler is implemented in T1) ────────
#
# A future, separately reviewed task registers a stage by adding
#   stages/<STAGE>/apply.sh      the stage change (MUTATING; its own review)
#   stages/<STAGE>/verify.sh     read-only post-change verification
#   stages/<STAGE>/rollback.sh   restores the pre-stage state (MUTATING)
#   stages/<STAGE>/allow-keys.txt       exact record keys the stage may change
#   stages/<STAGE>/allow-listeners.txt  exact listener keys the stage may add
# and a stage runner must then follow, with no step skipped:
#   1. p4-stage-gate.sh --mode live           (records + registered handler)
#   2. p4-l0-capture.sh  -> PRE                (read-only)
#   3. apply.sh
#   4. p4-l0-capture.sh  -> POST; p4-compare.sh PRE POST with the stage allow files
#   5. on any FAIL: rollback.sh; p4-l0-capture.sh -> RB;
#      p4-compare.sh PRE RB with NO allow files must PASS, else S-11 hold/escalate
# rollback.sh must be idempotent, must only undo its own stage, and must never
# delete an entire firewall ruleset, send RESTORE, reopen plaintext MQTT as a
# fallback, or change IDEA1/IDEA2 state.
# AEGIS_P4_HANDLER_DIR is a TEST-ONLY override for testing missing/unregistered
# stage handler directory branches in test fixtures. A real run leaves it unset.
readonly P4_HANDLER_DIR="${AEGIS_P4_HANDLER_DIR:-$P4_HERE/stages}"
readonly P4_HANDLER_FILES="apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt"

p4_stage_handler_status() {
  local f
  for f in $P4_HANDLER_FILES; do
    [ -f "$P4_HANDLER_DIR/$1/$f" ] || { echo NOT_REGISTERED; return 1; }
  done
  echo REGISTERED
}

# ── logging ──────────────────────────────────────────────────────────────────
P4_LOG_FILE="${P4_LOG_FILE:-}"
p4_log() {
  local line
  line="$(date -u +%FT%TZ) $*"
  printf '%s\n' "$line"
  if [ -n "$P4_LOG_FILE" ]; then printf '%s\n' "$line" >> "$P4_LOG_FILE"; fi
}

# ── read-only command guard ──────────────────────────────────────────────────
# Every host inspection command goes through p4_ro. The full argv (joined by
# single spaces) must match one of these anchored patterns, or the command is
# refused with status 126 and never executed. There is deliberately no pattern
# for any change verb.
# Safe absolute filesystem path: starts with '/', allows ordinary spaces and
# standard path characters. Rejects newline, CR, tab, escape, or any control
# bytes (0x01-0x1F, 0x7F).
p4_is_safe_fs_path() {
  local p="$1"
  [ -n "$p" ] || return 1
  [[ "$p" == *$'\n'* || "$p" == *$'\r'* || "$p" == *$'\t'* || "$p" =~ [$'\x01'-$'\x1f'$'\x7f'] ]] && return 1
  [[ "$p" =~ ^/[A-Za-z0-9@._+:\ /-]+$ ]] || return 1
  return 0
}

readonly P4_P='[A-Za-z0-9@._-]+'
P4_RO_ALLOW=(
  "^ip -br (addr|link) show$"
  "^ip -[46] (route|rule) show$"
  "^sysctl -n net\.ipv[46]\.[a-z0-9_.]+$"
  "^rfkill --noheadings --output ID,TYPE,SOFT,HARD$"
  "^iw (reg get|dev|phy)$"
  "^nmcli -t -f [A-Z,-]+ (general status|connection show --active|device status)$"
  "^nft (list tables|--stateless list ruleset|--stateless list table [a-z0-9]+ [A-Za-z0-9_-]+)$"
  "^timedatectl (show|show-timesync)( -p [A-Za-z]+)+$"
  "^chronyc -n tracking$"
  "^ss -H (-ltnu|-tn state established)$"
  "^systemctl show( -p [A-Za-z]+)+ ${P4_P}\.service$"
  "^journalctl -u ${P4_P}\.service --since [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC --no-pager -o cat$"
  "^df -P -k /[a-z]*$"
  "^hostnamectl --static$"
  "^uname -r$"
  "^twingate status$"
)

p4_ro_allowed() {
  case "${1:-}" in
    stat)
      [ $# -eq 5 ] || return 1
      [ "$2" = "-c" ] || return 1
      [ "$3" = "%a:%u:%g:%s:%Y" ] || return 1
      [ "$4" = "--" ] || return 1
      p4_is_safe_fs_path "$5" || return 1
      return 0
      ;;
    sha256sum)
      [ $# -eq 3 ] || return 1
      [ "$2" = "--" ] || return 1
      p4_is_safe_fs_path "$3" || return 1
      return 0
      ;;
    readlink)
      if [ $# -eq 3 ]; then
        [ "$2" = "--" ] || return 1
        p4_is_safe_fs_path "$3" || return 1
        return 0
      elif [ $# -eq 4 ]; then
        [ "$2" = "-f" ] || return 1
        [ "$3" = "--" ] || return 1
        p4_is_safe_fs_path "$4" || return 1
        return 0
      fi
      return 1
      ;;
    find)
      [ $# -eq 5 ] || return 1
      p4_is_safe_fs_path "$2" || return 1
      [ "$3" = "-xdev" ] || return 1
      [ "$4" = "-type" ] || return 1
      [ "$5" = "f" ] || return 1
      return 0
      ;;
  esac

  local argv="$*" re
  for re in "${P4_RO_ALLOW[@]}"; do
    [[ "$argv" =~ $re ]] && return 0
  done
  return 1
}

p4_ro() {
  if ! p4_ro_allowed "$@"; then
    # Only the command name is printed; arguments could carry values.
    p4_log "REFUSED non-read-only command: ${1:-<empty>}" >&2
    return 126
  fi
  if command -v timeout >/dev/null 2>&1; then
    AEGIS_P4_RO=1 timeout 20 "$@"
  else
    AEGIS_P4_RO=1 "$@"
  fi
}

p4_have() { command -v "$1" >/dev/null 2>&1; }

# ── records ──────────────────────────────────────────────────────────────────
# One record = key<TAB>value on one line. Values never contain a tab or newline.
# p4_clean_var NAME: in place, tabs/CR/LF -> space, squeeze spaces, trim (no fork).
p4_clean_var() {
  local -n _p4_v=$1
  _p4_v=${_p4_v//[$'\t\r\n']/ }
  while [[ "$_p4_v" == *"  "* ]]; do _p4_v=${_p4_v//  / }; done
  _p4_v=${_p4_v# }
  _p4_v=${_p4_v% }
}

p4_rec() { # file key value...
  local file=$1 key=$2 value
  shift 2
  value="$*"
  p4_clean_var key
  p4_clean_var value
  printf '%s\t%s\n' "${key// /_}" "$value" >> "$file"
}

p4_sort_records() { # file: sort by key (byte order), keep the first value per key
  local file=$1 sorted
  sorted=$(LC_ALL=C sort -t "$(printf '\t')" -k1,1 -s "$file" | awk -F '\t' '!seen[$1]++')
  if [ -n "$sorted" ]; then printf '%s\n' "$sorted" > "$file"; else : > "$file"; fi
}

p4_fs() { printf '%s%s' "$P4_FS_ROOT" "$1"; }

# Strip the TEST-ONLY prefix again so recorded paths are host paths.
p4_hostpath() { local p=$1; printf '%s' "${p#"$P4_FS_ROOT"}"; }

p4_sha256() { # path -> 64-hex, or UNREADABLE
  local out
  if out=$(p4_ro sha256sum -- "$1" 2>/dev/null) && [[ "${out%% *}" =~ ^[0-9a-f]{64}$ ]]; then
    printf '%s' "${out%% *}"
  else
    printf 'UNREADABLE'
  fi
}

p4_meta() { # path -> mode=.. uid=.. gid=.. size=.. mtime=..
  local out m u g s t
  if out=$(p4_ro stat -c %a:%u:%g:%s:%Y -- "$1" 2>/dev/null); then
    IFS=: read -r m u g s t <<< "$out"
    printf 'mode=%s uid=%s gid=%s size=%s mtime=%s' "$m" "$u" "$g" "$s" "$t"
  else
    printf 'UNREADABLE'
  fi
}

# Secret-bearing files are recorded by metadata only: never content, never a
# digest (a digest of a low-entropy PIN or PSK file could be brute-forced).
p4_is_secret_file() {
  local base=${1##*/}
  case "$base" in
    *.key | *.p12 | *.pfx | *.env | .env | *.nmconnection | *psk* | *pin* | *PIN* | *secret* | *token* | \
      *credential* | *password* | k_c2d | k_d2c | *.keys | id_*) return 0 ;;
  esac
  [ -r "$1" ] && grep -q -- 'PRIVATE KEY' "$1" 2>/dev/null && return 0
  return 1
}
