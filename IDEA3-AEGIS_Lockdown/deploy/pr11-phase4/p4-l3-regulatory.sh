# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L3 regulatory / channel gate. Sourced by stages/L3/{apply,verify}.sh (live paths only).
#
# Why this exists: live L3 attempt 2 (2026-09-24, after the rfkill fix) proved the exact target rfkill unblock leaves the
# self-managed Intel phy0 at `country 00`, so the old "phy must report TH before activation" requirement can never
# be satisfied on this hardware. The owner country intent stays TH, but L3 cannot set it (no `iw reg set`) and the
# driver/firmware own it. The safety property L3 needs is narrower and observable: the target phy reports either the
# owner country TH or the world default 00, and the approved channel is unrestricted on that phy (enabled, no
# no-IR/passive, no radar/DFS, not indoor-only). The gate runs before the profile is installed AND again after
# activation. It only reads (`iw dev ... info`, `iw reg get`, `iw phy ... channels`) and never sets regulatory state.
#
# Each function returns non-zero with a stable reason in L3_REG_REASON; results are returned in globals.
L3_REG_REASON=""
L3_REG_PHY=""
L3_REG_COUNTRY=""

_l3_reg_fail() { L3_REG_REASON=$1; return 1; }

# l3_reg_phy AP_IF -> L3_REG_PHY (phyN behind the interface)
l3_reg_phy() {
  local n
  L3_REG_PHY=""
  n=$(iw dev "$1" info 2>/dev/null | awk '$1 == "wiphy" { print $2; exit }')
  [[ "$n" =~ ^[0-9]+$ ]] || { _l3_reg_fail REGULATORY_STATE_UNREADABLE; return 1; }
  L3_REG_PHY="phy$n"
}

# l3_reg_country PHY -> L3_REG_COUNTRY (country of exactly that phy block in `iw reg get`)
l3_reg_country() {
  local out
  L3_REG_COUNTRY=""
  out=$(iw reg get 2>/dev/null) || { _l3_reg_fail REGULATORY_STATE_UNREADABLE; return 1; }
  L3_REG_COUNTRY=$(printf '%s\n' "$out" | awk -v p="${1/phy/phy#}" '
    $1 ~ /^phy#/ { on = ($1 == p); next }
    $1 == "global" { on = 0; next }
    on && $1 == "country" { sub(":", "", $2); print $2; exit }')
  [[ "$L3_REG_COUNTRY" =~ ^[0-9A-Z]{2}$ ]] || { L3_REG_COUNTRY=""; _l3_reg_fail REGULATORY_STATE_UNREADABLE; return 1; }
}

# l3_reg_channel_ok PHY CHANNEL -> succeeds only when the channel exists on the phy and carries no restriction flag
l3_reg_channel_ok() {
  local phy=$1 ch=$2 out verdict
  [[ "$ch" =~ ^[0-9]{1,3}$ ]] || { _l3_reg_fail CHANNEL_NOT_PERMITTED; return 1; }
  out=$(iw phy "$phy" channels 2>/dev/null) || { _l3_reg_fail REGULATORY_STATE_UNREADABLE; return 1; }
  verdict=$(printf '%s\n' "$out" | awk -v ch="[$ch]" '
    /^[[:space:]]*\*[[:space:]]+[0-9]+ MHz \[/ { on = 0; for (i = 1; i <= NF; i++) if ($i == ch) on = 1; if (on) { seen = 1; if ($0 ~ /\(disabled\)/) bad = 1 } next }
    /^Band / { on = 0; next }
    on && /(No IR|Passive scan|Radar detection|Indoor only|NO-IR|DFS)/ { bad = 1 }
    END { if (!seen) print "MISSING"; else if (bad) print "RESTRICTED"; else print "OK" }')
  [ "$verdict" = OK ] || { _l3_reg_fail CHANNEL_NOT_PERMITTED; return 1; }
}

# l3_reg_gate AP_IF CHANNEL -> sets L3_REG_PHY/L3_REG_COUNTRY; target phy country must be TH or the 00 world default
l3_reg_gate() {
  l3_reg_phy "$1" || return 1
  l3_reg_country "$L3_REG_PHY" || return 1
  { [ "$L3_REG_COUNTRY" = TH ] || [ "$L3_REG_COUNTRY" = 00 ]; } || { _l3_reg_fail REGULATORY_DOMAIN_MISMATCH; return 1; }
  l3_reg_channel_ok "$L3_REG_PHY" "$2" || return 1
}

# l3_reg_verify_active AP_IF CHANNEL -> after activation: AP type on exactly the approved channel, gate still holds
l3_reg_verify_active() {
  local info
  info=$(iw dev "$1" info 2>/dev/null)
  printf '%s\n' "$info" | grep -q "type AP" || { _l3_reg_fail AP_MODE_NOT_ACTIVE; return 1; }
  printf '%s\n' "$info" | awk -v ch="$2" '$1 == "channel" && $2 == ch { ok = 1 } END { exit !ok }' \
    || { _l3_reg_fail AP_CHANNEL_MISMATCH; return 1; }
  l3_reg_gate "$1" "$2"
}
