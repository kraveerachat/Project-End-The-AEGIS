#!/usr/bin/env bash
# Reverses setup-g3-target.sh completely. Idempotent: safe to run twice, after a failed setup, or with nothing set up.
#   sudo ~/aegis-live-run/review/teardown-g3-target.sh
# Touches only what setup created: the aegis-g3-target-sshd unit, the account aegis-g3-sshd, 10.90.90.5/29 on
# aegis-att-h, /run/aegis-g3-target, and review/redteam/g3-target/ (the operator's generated keypair). Nothing
# else -- not /etc/ssh, not any other account, not core.env, not any nftables table or route, not aegis-att-h
# itself (only the one address added to it). Prints no secrets.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "ERROR: run with sudo" >&2; exit 1; }
CORE_USER="${SUDO_USER:-}"
if [[ -z $CORE_USER || $CORE_USER == root ]]; then CORE_USER="$(logname 2>/dev/null || true)"; fi
[[ -n $CORE_USER && $CORE_USER != root ]] && getent passwd "$CORE_USER" >/dev/null || { echo "ERROR: cannot determine the operator account (run through sudo)" >&2; exit 1; }
WORK="$(getent passwd "$CORE_USER" | cut -d: -f6)/aegis-live-run"
KEYDIR="$WORK/review/redteam/g3-target"

VH="aegis-att-h"
TARGET_ADDR="10.90.90.5"
PREFIX=29
TARGET_USER="aegis-g3-sshd"
RUNDIR="/run/aegis-g3-target"
UNIT="aegis-g3-target-sshd"
STATE="/run/aegis-g3-target.state"

STATE_OK=0
if [[ -e $STATE || -L $STATE ]]; then
  if [[ -f $STATE && ! -L $STATE && $(stat -c '%U:%G:%a' "$STATE") == root:root:600 ]]; then
    STATE_OK=1
  else
    echo "NOTE: $STATE is not a root-owned 0600 regular file; ignored (not read, not removed)"
  fi
fi

echo "== 1/5 stop the target sshd"
systemctl stop "$UNIT.service" 2>/dev/null && echo "   stopped $UNIT"
systemctl reset-failed "$UNIT.service" 2>/dev/null

echo "== 2/5 remove the account $TARGET_USER (locked password, no home, so nothing of the operator's is in it)"
if getent passwd "$TARGET_USER" >/dev/null 2>&1; then
  userdel "$TARGET_USER" 2>/dev/null && echo "   removed $TARGET_USER" || echo "   WARNING: could not remove $TARGET_USER; remove it by hand"
else
  echo "   $TARGET_USER does not exist; nothing to do"
fi

echo "== 3/5 remove the address $TARGET_ADDR/$PREFIX from $VH (the interface itself is attacker-ns-up.sh's; left alone)"
if ip link show "$VH" >/dev/null 2>&1; then
  ip addr del "$TARGET_ADDR/$PREFIX" dev "$VH" 2>/dev/null && echo "   removed $TARGET_ADDR/$PREFIX from $VH" || echo "   $TARGET_ADDR/$PREFIX was not on $VH"
else
  echo "   $VH does not exist; nothing to do"
fi

echo "== 4/5 remove runtime files"
rm -rf -- "$RUNDIR" 2>/dev/null && echo "   removed $RUNDIR"

echo "== 5/5 remove the operator's generated keypair ($KEYDIR)"
if [[ -d $KEYDIR && ! -L $KEYDIR ]]; then
  rm -rf -- "$KEYDIR" && echo "   removed $KEYDIR"
else
  [[ -e $KEYDIR ]] && echo "   NOTE: $KEYDIR is not a plain directory; left alone, check it by hand" || echo "   $KEYDIR does not exist; nothing to do"
fi

[[ $STATE_OK -eq 1 ]] && rm -f "$STATE"

echo
echo "== verification"
bad=0
systemctl is-active --quiet "$UNIT.service" 2>/dev/null && { echo "   $UNIT.service is still active"; bad=1; }
getent passwd "$TARGET_USER" >/dev/null 2>&1 && { echo "   account $TARGET_USER still exists"; bad=1; }
if ip link show "$VH" >/dev/null 2>&1; then
  ip -4 -o addr show dev "$VH" | awk '{print $4}' | grep -qx "$TARGET_ADDR/$PREFIX" && { echo "   $TARGET_ADDR/$PREFIX is still on $VH"; bad=1; }
fi
[[ -e $RUNDIR ]] && { echo "   $RUNDIR still present"; bad=1; }
[[ -e $KEYDIR ]] && { echo "   $KEYDIR still present"; bad=1; }
[[ $STATE_OK -eq 1 && -e $STATE ]] && { echo "   state file still present"; bad=1; }
if [[ $bad -eq 0 ]]; then
  echo "   OK: G3 target fully torn down"
  exit 0
else
  echo "   teardown incomplete; see above"
  exit 1
fi
