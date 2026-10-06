#!/usr/bin/env bash
# CTu verification reads actual Core-owned runtime evidence; it never accepts
# caller-provided success outcomes.
set -Eeuo pipefail
fail() { printf 'CTU_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_UNIT_SOURCE:?AEGIS_CTU_UNIT_SOURCE required}"
: "${AEGIS_CTU_PRE_CORE_PID:?AEGIS_CTU_PRE_CORE_PID required}"
: "${AEGIS_CTU_PRE_CORE_START:?AEGIS_CTU_PRE_CORE_START required}"
: "${AEGIS_CTU_PRE_STATUS_UPDATED_AT:?AEGIS_CTU_PRE_STATUS_UPDATED_AT required}"
: "${AEGIS_CTU_DEVICE_ID:?AEGIS_CTU_DEVICE_ID required}"
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
/usr/bin/python3 "$(dirname "$0")/../../p4-ctu-runtime-verify.py" \
  --core-pid "$post_pid" --pre-updated-at "$AEGIS_CTU_PRE_STATUS_UPDATED_AT" \
  --device-id "$AEGIS_CTU_DEVICE_ID" || fail REAL_RUNTIME_PROOF_FAILED
printf 'CTU_VERIFY=PASS runtime=CORE_SANDBOX authenticated_status=PROVEN time_trust=SYNCED device=ONLINE uplink=LOCKDOWN\n'
