#!/usr/bin/env bash
# CTu verify is read-only. Absent runtime proof values fail closed.
set -Eeuo pipefail
fail() { printf 'CTU_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_UNIT_SOURCE:?AEGIS_CTU_UNIT_SOURCE required}"
: "${AEGIS_CTU_PRE_CORE_PID:?AEGIS_CTU_PRE_CORE_PID required}"
: "${AEGIS_CTU_PRE_CORE_START:?AEGIS_CTU_PRE_CORE_START required}"
: "${AEGIS_CTU_AUTHENTICATED_STATUS:?AEGIS_CTU_AUTHENTICATED_STATUS required}"
: "${AEGIS_CTU_TRUSTED_CLOCK:?AEGIS_CTU_TRUSTED_CLOCK required}"
: "${AEGIS_CTU_TIME_TRUST:?AEGIS_CTU_TIME_TRUST required}"
: "${AEGIS_CTU_DEVICE:?AEGIS_CTU_DEVICE required}"
: "${AEGIS_CTU_UPLINK:?AEGIS_CTU_UPLINK required}"
: "${AEGIS_CTU_BROKER:?AEGIS_CTU_BROKER required}"
: "${AEGIS_CTU_RECOVERY_MARKER:?AEGIS_CTU_RECOVERY_MARKER required}"
TARGET=/etc/systemd/system/aegis-idea3-core.service
cmp -s -- "$AEGIS_CTU_UNIT_SOURCE" "$TARGET" || fail INSTALLED_UNIT_MISMATCH
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || fail CORE_NOT_ACTIVE
[ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || fail CORE_NOT_RUNNING
[ "$(systemctl show -p Result --value aegis-idea3-core.service)" = success ] || fail CORE_RESULT_NOT_SUCCESS
post_pid=$(systemctl show -p MainPID --value aegis-idea3-core.service)
post_start=$(systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
[[ "$post_pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_PID_INVALID
[ "$post_pid" != "$AEGIS_CTU_PRE_CORE_PID" ] || fail CORE_PID_DID_NOT_CHANGE
[ "$post_start" != "$AEGIS_CTU_PRE_CORE_START" ] || fail CORE_START_DID_NOT_CHANGE
[ "$AEGIS_CTU_AUTHENTICATED_STATUS" = YES ] || fail AUTHENTICATED_STATUS_NOT_ACCEPTED
[ "$AEGIS_CTU_TRUSTED_CLOCK" = SYNCED ] || fail TRUSTED_CLOCK_NOT_SYNCED
[ "$AEGIS_CTU_TIME_TRUST" = SYNCED ] || fail CORE_TIME_TRUST_NOT_SYNCED
[ "$AEGIS_CTU_DEVICE" = ONLINE ] || fail DEVICE_NOT_ONLINE
[ "$AEGIS_CTU_UPLINK" = LOCKDOWN ] || fail UPLINK_NOT_LOCKDOWN
[ "$AEGIS_CTU_BROKER" = CONNECTED ] || fail BROKER_NOT_CONNECTED
[ "$AEGIS_CTU_RECOVERY_MARKER" = ABSENT ] || fail RECOVERY_MARKER_PRESENT
printf 'CTU_VERIFY=PASS trusted_clock=SYNCED time_trust=SYNCED device=ONLINE uplink=LOCKDOWN\n'
