#!/usr/bin/env bash
# Stop the IDEA3 live lab and roll the host back: transient units, firewall table, lab AP profile, Wi-Fi autoconnect,
# time service. Idempotent. Does not touch INTERNET_IFACE, the ESP32, or any secret. Nothing it stops is disabled.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-live-lab.sh
. "$HERE/lib-live-lab.sh"

[[ $EUID -ne 0 ]] || ll_die "run as the operator, not root"
sudo -v || exit 1
step() { printf '\n== %s\n' "$*"; }

step "stop lab units (${UNIT_PREFIX}-*)"
# Core first so it does not log a broker loss as an attack; then everything else with the same prefix.
sudo systemctl stop "$(ll_unit core).service" 2>/dev/null
mapfile -t units < <(systemctl list-units --all --no-legend --plain "${UNIT_PREFIX}-*" | awk '{print $1}')
for u in "${units[@]}"; do
  [[ -n $u ]] && sudo systemctl stop "$u" 2>/dev/null && echo "   stopped $u"
done
sudo systemctl reset-failed "${UNIT_PREFIX}-*" 2>/dev/null

step "firewall table inet $NFT_TABLE"
sudo nft list table inet "$NFT_TABLE" >/dev/null 2>&1 && sudo nft delete table inet "$NFT_TABLE" && echo "   deleted"

step "lab AP profile"
nmcli connection down "$NM_PROFILE" >/dev/null 2>&1 && echo "   $NM_PROFILE down"
sudo rm -f "/run/NetworkManager/system-connections/$NM_PROFILE.nmconnection" && sudo nmcli connection reload

step "Wi-Fi autoconnect restored"
if [[ -r $LL_EVID/wifi-autoconnect-was-yes.txt ]]; then
  while IFS= read -r n; do
    [[ -n $n ]] && nmcli connection modify "$n" connection.autoconnect yes && echo "   autoconnect=yes: $n"
  done < "$LL_EVID/wifi-autoconnect-was-yes.txt"
else
  echo "   no record (nothing was changed)"
fi

step "time service"
if grep -qx 'systemd-timesyncd.service' "$LL_EVID/stopped-units.txt" 2>/dev/null; then
  sudo systemctl start systemd-timesyncd.service && echo "   systemd-timesyncd started"
fi

step "host state"
printf '   default route: %s\n' "$(ip -4 route show default)"
getent hosts "$DNS_CHECK_HOST" >/dev/null && echo "   DNS ok" || echo "   DNS does NOT resolve $DNS_CHECK_HOST"
for u in "${units[@]}"; do systemctl is-active --quiet "$u" 2>/dev/null && echo "   STILL ACTIVE: $u"; done
if [[ -s $LL_EVID/stopped-units.txt ]]; then
  echo
  echo "Units stopped by aegis-live-up.sh (not restarted here). Start them again only if you want them:"
  grep -vx 'systemd-timesyncd.service' "$LL_EVID/stopped-units.txt" | sed 's/^/   sudo systemctl start /'
fi
echo
echo "The ESP32 keeps its last firmware and fails secure (LOCKDOWN) without the Core. To return it to an earlier image see"
echo "doc/Content/17_LIVE_LAB_RUNBOOK.md (rollback of the controller)."
