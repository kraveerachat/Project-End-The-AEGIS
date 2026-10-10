#!/usr/bin/env bash
# Read-only post-upgrade checks. Detector must remain exactly inactive.
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 1
[ "$(readlink -f /opt/aegis-idea3/current)" = /opt/aegis-idea3/releases/idea3-core-728c2d9b-20261010 ] || exit 1
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || exit 1
[ "$(systemctl show -p LoadState --value aegis-idea3-detector.service)" = loaded ] || exit 1
[ "$(systemctl show -p ActiveState --value aegis-idea3-detector.service)" = inactive ] || exit 1
[ "$(systemctl show -p SubState --value aegis-idea3-detector.service)" = dead ] || exit 1
[ "$(systemctl show -p UnitFileState --value aegis-idea3-detector.service)" = disabled ] || exit 1
[ "$(systemctl show -p MainPID --value aegis-idea3-detector.service)" = 0 ] || exit 1
if pgrep -af '[a]egis_soc.production_detector'; then exit 1; fi
printf 'ICU_VERIFY=PASS\n'
