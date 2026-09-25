# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L4 live precondition and bound reactivation. Sourced by stages/L4/apply.sh (live path only).
#
# L4 starts from the L3 AP that is already applied and live-accepted (PR #207) and reactivates it with addressing. This
# file reuses the merged L3 helpers instead of re-implementing them:
#   p4-l3-regulatory.sh  l3_reg_gate / l3_reg_verify_active  (M-14: target phy TH-or-00 + unrestricted approved channel)
#   p4-l3-nm.sh          l3_nm_activate                      (activation bound with `ifname`, never NM's own choice)
# Read-only toward regulatory state, rfkill and the global radio: never `iw reg set`, `nmcli radio wifi on`, rfkill, NAT
# or forwarding. The M-15 owner Wi-Fi baseline stays outside L4. Reasons are returned in L4_REASON.
_P4_L4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=p4-l3-regulatory.sh
. "$_P4_L4_HERE/p4-l3-regulatory.sh"
# shellcheck source=p4-l3-nm.sh
. "$_P4_L4_HERE/p4-l3-nm.sh"

L4_REASON=""
L4_AP_SSID="AEGIS-IDEA3"
L4_AP_CHANNEL=6

_l4_fail() { L4_REASON=$1; return 1; }

# _l4_ssid_ok AP_IF -> the AP interface reports exactly the approved SSID
_l4_ssid_ok() {
  iw dev "$1" info 2>/dev/null | awk -v s="$L4_AP_SSID" '$1 == "ssid" { sub(/^[[:space:]]*ssid[[:space:]]+/, ""); if ($0 == s) ok = 1 } END { exit !ok }'
}

# l4_precondition AP_IF CHANNEL — L3 must already be active; strictly read-only, run BEFORE the L3 profile is changed
l4_precondition() {
  local ap=$1 ch=$2
  [[ "$ap" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] && [ "$ap" = wlp0s20f3 ] || { _l4_fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3; return 1; }
  [ "$ch" = "$L4_AP_CHANNEL" ] || { _l4_fail AP_CHANNEL_MUST_BE_6; return 1; }
  iw dev "$ap" info 2>/dev/null | grep -q "type AP" || { _l4_fail AP_MODE_NOT_ACTIVE; return 1; }
  _l4_ssid_ok "$ap" || { _l4_fail AP_SSID_MISMATCH; return 1; }
  iw dev "$ap" info 2>/dev/null | awk -v ch="$ch" '$1 == "channel" && $2 == ch { ok = 1 } END { exit !ok }' \
    || { _l4_fail AP_CHANNEL_MISMATCH; return 1; }
  [ -z "$(ip -4 addr show dev "$ap" 2>/dev/null | grep 'inet ')" ] || { _l4_fail AP_IF_ALREADY_HAS_IPV4_ADDRESS; return 1; }
  [ -z "$(ip -6 addr show dev "$ap" scope global 2>/dev/null | grep 'inet6 ')" ] || { _l4_fail AP_IF_HAS_IPV6_ADDRESS; return 1; }
  [ -z "$(ip route show default dev "$ap" 2>/dev/null)" ] || { _l4_fail AP_IF_HAS_DEFAULT_ROUTE; return 1; }
  [ -n "$(ip route show default 2>/dev/null | grep -v "dev $ap")" ] || { _l4_fail NO_ALTERNATE_DEFAULT_ROUTE; return 1; }
  l3_reg_gate "$ap" "$ch" || { L4_REASON=$L3_REG_REASON; return 1; }
}

# l4_reactivate AP_IF CONN_ID CHANNEL — reactivate bound to the approved interface, then re-verify AP/channel/regulatory
l4_reactivate() {
  local ap=$1 conn=$2 ch=$3
  [ "$ap" = wlp0s20f3 ] || { _l4_fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3; return 1; }
  [ "$ch" = "$L4_AP_CHANNEL" ] || { _l4_fail AP_CHANNEL_MUST_BE_6; return 1; }
  l3_nm_activate "$ap" "$conn" || { L4_REASON=$L3_NM_REASON; return 1; }
  l3_reg_verify_active "$ap" "$ch" || { L4_REASON=$L3_REG_REASON; return 1; }
  _l4_ssid_ok "$ap" || { _l4_fail AP_SSID_MISMATCH; return 1; }
}
