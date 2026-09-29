# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L3 exact-ID rfkill helper. Sourced by stages/L3/{apply,rollback}.sh (live paths only).
#
# Why this exists: on util-linux 2.42 `rfkill --output SOFT 1` is a usage error (an identifier is valid only after a
# command, i.e. `rfkill --output SOFT list 1`). The old inline code discarded stderr, treated the empty answer as
# "not blocked" and recorded rfkill_pre_state=0, so the radio was never unblocked (L3 live attempt 2026-09-24), and its
# hard-block guard passed on an empty string. Here the state comes from ONE exact `list <id>` row, every anomaly fails
# closed, and only the exact numeric id bound to the interface through sysfs is ever blocked/unblocked.
#
# Each function returns non-zero with a stable reason in L3_RFKILL_REASON. Results are returned in globals (no
# command substitution, so the reason is never lost in a subshell).
L3_RFKILL_REASON=""
L3_RFKILL_ID=""
L3_RFKILL_SOFT=""
L3_RFKILL_HARD=""

_l3_rfkill_fail() { L3_RFKILL_REASON=$1; return 1; }

# l3_rfkill_resolve_id AP_IF [SYSFS_ROOT=/sys] [EXPECTED_ID] -> sets L3_RFKILL_ID (the numeric id bound to AP_IF)
l3_rfkill_resolve_id() {
  local ap=$1 root=${2:-/sys} expected=${3:-} d id
  local -a found=()
  L3_RFKILL_ID=""
  for d in "$root/class/net/$ap/phy80211"/rfkill*; do
    [ -f "$d/index" ] || continue
    id=$(cat "$d/index" 2>/dev/null)
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    found+=("$id")
  done
  [ "${#found[@]}" -ge 1 ] || { _l3_rfkill_fail RFKILL_ID_NOT_FOUND; return 1; }
  [ "${#found[@]}" = 1 ] || { _l3_rfkill_fail RFKILL_ID_AMBIGUOUS; return 1; }
  if [ -n "$expected" ] && [ "$expected" != "${found[0]}" ]; then
    _l3_rfkill_fail RFKILL_ID_MISMATCH; return 1
  fi
  L3_RFKILL_ID=${found[0]}
}

# l3_rfkill_state ID -> sets L3_RFKILL_SOFT/HARD from exactly one row of `rfkill list ID`, type wlan
l3_rfkill_state() {
  local id=$1 out rid rtype rsoft rhard extra
  L3_RFKILL_SOFT="" L3_RFKILL_HARD=""
  out=$(rfkill --noheadings --output ID,TYPE,SOFT,HARD list "$id" 2>/dev/null) || { _l3_rfkill_fail RFKILL_STATE_UNREADABLE; return 1; }
  [ "$(printf '%s\n' "$out" | grep -c .)" = 1 ] || { _l3_rfkill_fail RFKILL_STATE_AMBIGUOUS; return 1; }
  read -r rid rtype rsoft rhard extra <<< "$out"
  if [ -n "$extra" ] || [ "$rid" != "$id" ] || [ "$rtype" != wlan ] \
    || { [ "$rsoft" != blocked ] && [ "$rsoft" != unblocked ]; } \
    || { [ "$rhard" != blocked ] && [ "$rhard" != unblocked ]; }; then
    _l3_rfkill_fail RFKILL_STATE_INVALID; return 1
  fi
  L3_RFKILL_SOFT=$rsoft L3_RFKILL_HARD=$rhard
}

# l3_rfkill_prepare AP_IF WORK [EXPECTED_ID] [SYSFS_ROOT=/sys]
# Records rfkill_id and rfkill_pre_state (1 = target was soft-blocked) in WORK, then unblocks exactly that id.
l3_rfkill_prepare() {
  local ap=$1 work=$2 expected=${3:-} root=${4:-/sys} id
  l3_rfkill_resolve_id "$ap" "$root" "$expected" || return 1
  id=$L3_RFKILL_ID
  printf '%s\n' "$id" > "$work/rfkill_id"
  l3_rfkill_state "$id" || return 1
  [ "$L3_RFKILL_HARD" != blocked ] || { _l3_rfkill_fail RFKILL_HARD_BLOCKED; return 1; }
  if [ "$L3_RFKILL_SOFT" = blocked ]; then
    printf '1\n' > "$work/rfkill_pre_state"
    rfkill unblock "$id" || { _l3_rfkill_fail RFKILL_UNBLOCK_FAILED; return 1; }
    l3_rfkill_state "$id" || return 1
    [ "$L3_RFKILL_SOFT" = unblocked ] && [ "$L3_RFKILL_HARD" != blocked ] || { _l3_rfkill_fail RFKILL_UNBLOCK_NOT_EFFECTIVE; return 1; }
  else
    printf '0\n' > "$work/rfkill_pre_state"
  fi
}

# l3_rfkill_restore WORK -> re-blocks exactly the recorded id, only if the target was soft-blocked before apply
l3_rfkill_restore() {
  local work=$1 id
  [ -f "$work/rfkill_pre_state" ] && [ "$(cat "$work/rfkill_pre_state" 2>/dev/null)" = 1 ] || return 0
  id=$(cat "$work/rfkill_id" 2>/dev/null)
  [[ "$id" =~ ^[0-9]+$ ]] || { _l3_rfkill_fail RFKILL_ID_INVALID; return 1; }
  rfkill block "$id" || { _l3_rfkill_fail RFKILL_BLOCK_RESTORE_FAILED; return 1; }
  l3_rfkill_state "$id" || return 1
  [ "$L3_RFKILL_SOFT" = blocked ] || { _l3_rfkill_fail RFKILL_RESTORE_NOT_EFFECTIVE; return 1; }
}
