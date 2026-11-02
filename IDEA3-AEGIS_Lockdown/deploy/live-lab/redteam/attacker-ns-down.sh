#!/usr/bin/env bash
# Reverse attacker-ns-up.sh completely. Idempotent: safe to run twice, after a failed setup, or with nothing set up.
#   sudo ~/aegis-live-run/review/redteam/attacker-ns-down.sh   (or this copy under deploy/live-lab/redteam/)
# Touches only what attacker-ns-up.sh created: the "aegis-att" namespace, the aegis-att-h / aegis-att-n veth pair,
# and /run/aegis-att.state. The running lab (AP, dnsmasq, mosquitto, the Core, graduated response) is never touched.
# No firewall rule, NAT or sysctl is changed by this pair of scripts in either direction, so there is nothing of
# that kind to undo here.
#
# State: /run/aegis-att.state is used only if it is a regular, non-symlink file owned root:root with mode 0600, and
# is read with exact-line matches (grep -qx). It is never sourced or executed.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "ERROR: run with sudo" >&2; exit 1; }

NS="aegis-att"
VH="aegis-att-h"
VN="aegis-att-n"
STATE="/run/aegis-att.state"

STATE_OK=0
if [[ -e $STATE || -L $STATE ]]; then
  if [[ -f $STATE && ! -L $STATE && $(stat -c '%U:%G:%a' "$STATE") == root:root:600 ]]; then
    STATE_OK=1
  else
    echo "NOTE: $STATE is not a root-owned 0600 regular file; ignored (not read, not removed)"
  fi
fi
state_has() { [[ $STATE_OK -eq 1 ]] && grep -qx "$1=1" "$STATE"; }

echo "== 1/2 namespace and veth"
if ip netns list 2>/dev/null | grep -qx "$NS"; then
  if [[ $STATE_OK -eq 0 ]] && ! state_has ST_NS; then
    echo "   NOTE: netns $NS exists but the state file does not say this script created it; removing it anyway (the name is ours)"
  fi
  ip netns del "$NS" && echo "   removed namespace $NS"
else
  echo "   namespace $NS not present"
fi
# The host-side veth end is deleted with the namespace end automatically when either end goes away, but the host
# side can be left behind if the namespace delete above failed partway (e.g. interrupted) or the namespace was
# never entered; remove it explicitly either way.
if ip link show "$VH" >/dev/null 2>&1; then
  ip link del "$VH" && echo "   removed $VH"
else
  echo "   $VH not present"
fi

echo "== 2/2 state file"
[[ $STATE_OK -eq 1 ]] && rm -f "$STATE"

echo "== verify"
bad=0
ip netns list 2>/dev/null | grep -qx "$NS" && { echo "   STILL PRESENT: netns $NS"; bad=1; }
ip link show "$VH" >/dev/null 2>&1 && { echo "   STILL PRESENT: $VH"; bad=1; }
ip link show "$VN" >/dev/null 2>&1 && { echo "   STILL PRESENT: $VN (host namespace)"; bad=1; }
[[ $STATE_OK -eq 1 && -e $STATE ]] && { echo "   state file still present"; bad=1; }
echo "   lab core (untouched by this pair of scripts): $(systemctl is-active aegis-live-core 2>/dev/null || echo unknown)"
if [[ $bad -eq 0 ]]; then echo "Teardown complete."; else echo "Teardown finished with leftovers listed above." >&2; exit 1; fi
