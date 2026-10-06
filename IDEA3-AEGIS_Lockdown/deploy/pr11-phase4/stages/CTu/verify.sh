#!/usr/bin/env bash
# CTu verification reads actual Core-owned runtime evidence; it never accepts
# caller-provided success outcomes.
set -Eeuo pipefail
fail() { printf 'CTU_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_UNIT_SOURCE:?AEGIS_CTU_UNIT_SOURCE required}"
: "${AEGIS_CTU_PRE_CORE_PID:?AEGIS_CTU_PRE_CORE_PID required}"
: "${AEGIS_CTU_PRE_CORE_START:?AEGIS_CTU_PRE_CORE_START required}"
: "${AEGIS_CTU_PRE_CORE_NRESTARTS:?AEGIS_CTU_PRE_CORE_NRESTARTS required}"
: "${AEGIS_CTU_PRE_STATUS_UPDATED_AT:?AEGIS_CTU_PRE_STATUS_UPDATED_AT required}"
: "${AEGIS_CTU_DEVICE_ID:?AEGIS_CTU_DEVICE_ID required}"
: "${AEGIS_CTU_PRE_DETECTOR_PID:?AEGIS_CTU_PRE_DETECTOR_PID required}"
: "${AEGIS_CTU_PRE_DETECTOR_START:?AEGIS_CTU_PRE_DETECTOR_START required}"
: "${AEGIS_CTU_PRE_DETECTOR_INVOCATION:?AEGIS_CTU_PRE_DETECTOR_INVOCATION required}"
: "${AEGIS_CTU_PRE_DETECTOR_NRESTARTS:?AEGIS_CTU_PRE_DETECTOR_NRESTARTS required}"
: "${AEGIS_CTU_PRE_DETECTOR_MONOTONIC:?AEGIS_CTU_PRE_DETECTOR_MONOTONIC required}"
TARGET=/etc/systemd/system/aegis-idea3-core.service
cmp -s -- "$AEGIS_CTU_UNIT_SOURCE" "$TARGET" || fail INSTALLED_UNIT_MISMATCH
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || fail CORE_NOT_ACTIVE
[ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || fail CORE_NOT_RUNNING
[ "$(systemctl show -p Result --value aegis-idea3-core.service)" = success ] || fail CORE_RESULT_NOT_SUCCESS
core_nrestarts=$(systemctl show -p NRestarts --value aegis-idea3-core.service)
[ "$AEGIS_CTU_PRE_CORE_NRESTARTS" = 0 ] || fail CORE_PRE_RESTART_COUNT_INVALID
[ "$core_nrestarts" = 0 ] || fail CORE_UNEXPECTED_RESTART_COUNT
post_pid=$(systemctl show -p MainPID --value aegis-idea3-core.service)
post_start=$(systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
[[ "$post_pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_PID_INVALID
[ "$post_pid" != "$AEGIS_CTU_PRE_CORE_PID" ] || fail CORE_PID_DID_NOT_CHANGE
[ "$post_start" != "$AEGIS_CTU_PRE_CORE_START" ] || fail CORE_START_DID_NOT_CHANGE
core_post_mono=$(systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-core.service)
detector_state=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p NRestarts -p InvocationID -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic -p UnitFileState -p Restart aegis-idea3-detector.service) || fail DETECTOR_STATE_UNREADABLE
detector_pid=$(awk -F= '$1 == "MainPID" {print $2}' <<<"$detector_state")
detector_start=$(awk -F= '$1 == "ExecMainStartTimestamp" {print $2}' <<<"$detector_state")
detector_mono=$(awk -F= '$1 == "ExecMainStartTimestampMonotonic" {print $2}' <<<"$detector_state")
detector_invocation=$(awk -F= '$1 == "InvocationID" {print $2}' <<<"$detector_state")
detector_nrestarts=$(awk -F= '$1 == "NRestarts" {print $2}' <<<"$detector_state")
detector_load=$(awk -F= '$1 == "LoadState" {print $2}' <<<"$detector_state")
detector_active=$(awk -F= '$1 == "ActiveState" {print $2}' <<<"$detector_state")
detector_sub=$(awk -F= '$1 == "SubState" {print $2}' <<<"$detector_state")
detector_unit_file=$(awk -F= '$1 == "UnitFileState" {print $2}' <<<"$detector_state")
detector_restart=$(awk -F= '$1 == "Restart" {print $2}' <<<"$detector_state")
grep -qx 'LoadState=loaded' <<<"$detector_state" || fail DETECTOR_NOT_LOADED
grep -qx 'ActiveState=active' <<<"$detector_state" || fail DETECTOR_NOT_ACTIVE
grep -qx 'SubState=running' <<<"$detector_state" || fail DETECTOR_NOT_RUNNING
grep -qx 'UnitFileState=disabled' <<<"$detector_state" || fail DETECTOR_UNIT_STATE_CHANGED
grep -qx 'Restart=no' <<<"$detector_state" || fail DETECTOR_RESTART_POLICY_CHANGED
[[ "$detector_pid" =~ ^[1-9][0-9]*$ ]] || fail DETECTOR_PID_INVALID
[[ "$detector_nrestarts" =~ ^[0-9]+$ && "$AEGIS_CTU_PRE_DETECTOR_NRESTARTS" = 0 && "$detector_nrestarts" = 0 ]] || fail DETECTOR_UNEXPECTED_RESTART_COUNT
[[ "$detector_invocation" =~ ^[0-9a-f]{32}$ ]] || fail DETECTOR_INVOCATION_INVALID
[ "$detector_invocation" != "$AEGIS_CTU_PRE_DETECTOR_INVOCATION" ] || fail DETECTOR_INVOCATION_UNCHANGED
[ "$detector_pid" != "$AEGIS_CTU_PRE_DETECTOR_PID" ] || fail DETECTOR_PID_UNCHANGED
[ "$detector_start" != "$AEGIS_CTU_PRE_DETECTOR_START" ] || fail DETECTOR_START_UNCHANGED
[[ "$core_post_mono" =~ ^[0-9]+$ && "$detector_mono" =~ ^[0-9]+$ ]] || fail DETECTOR_MONOTONIC_START_UNAVAILABLE
[ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || fail DETECTOR_PROCESS_SET_UNEXPECTED
/usr/bin/python3 "$(dirname "$0")/../../p4-ctu-runtime-verify.py" --verify-detector --device-id "$AEGIS_CTU_DEVICE_ID" --core-post-monotonic "$core_post_mono" \
  --pre-detector-pid "$AEGIS_CTU_PRE_DETECTOR_PID" --pre-detector-start "$AEGIS_CTU_PRE_DETECTOR_START" --pre-detector-invocation "$AEGIS_CTU_PRE_DETECTOR_INVOCATION" --pre-detector-nrestarts "$AEGIS_CTU_PRE_DETECTOR_NRESTARTS" --pre-detector-monotonic "$AEGIS_CTU_PRE_DETECTOR_MONOTONIC" \
  --post-detector-pid "$detector_pid" --post-detector-start "$detector_start" --post-detector-invocation "$detector_invocation" --post-detector-nrestarts "$detector_nrestarts" --post-detector-monotonic "$detector_mono" \
  --post-detector-load "$detector_load" --post-detector-active "$detector_active" --post-detector-sub "$detector_sub" --post-detector-unit-file "$detector_unit_file" --post-detector-restart "$detector_restart" || fail DETECTOR_IMPLICIT_LIFECYCLE_UNPROVEN
/usr/bin/python3 "$(dirname "$0")/../../p4-ctu-runtime-verify.py" \
  --core-pid "$post_pid" --pre-updated-at "$AEGIS_CTU_PRE_STATUS_UPDATED_AT" \
  --device-id "$AEGIS_CTU_DEVICE_ID" || fail REAL_RUNTIME_PROOF_FAILED
printf 'CTU_VERIFY=PASS runtime=CORE_SANDBOX authenticated_status=PROVEN time_trust=SYNCED device=ONLINE uplink=LOCKDOWN\n'
