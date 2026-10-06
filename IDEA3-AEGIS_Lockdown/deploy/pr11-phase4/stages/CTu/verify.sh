#!/usr/bin/env bash
# CTu verification reads Core-owned runtime evidence and the root snapshot.
set -Eeuo pipefail
fail() { printf 'CTU_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_UNIT_SNAPSHOT:?AEGIS_CTU_UNIT_SNAPSHOT required}"
: "${AEGIS_CTU_UNIT_SHA256:?AEGIS_CTU_UNIT_SHA256 required}"
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
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
: "${AEGIS_CTU_RUNTIME_VERIFY:?AEGIS_CTU_RUNTIME_VERIFY required}"
: "${AEGIS_CTU_BUNDLE:?AEGIS_CTU_BUNDLE required}"
TARGET=/etc/systemd/system/aegis-idea3-core.service
[ -d "$AEGIS_CTU_BUNDLE" ] && [ ! -L "$AEGIS_CTU_BUNDLE" ] && [ "$(stat -c %u -- "$AEGIS_CTU_BUNDLE")" = 0 ] || fail CTU_BUNDLE_INVALID
[ -z "$(find "$AEGIS_CTU_BUNDLE" -type l -print -quit)" ] || fail CTU_BUNDLE_SYMLINK
( cd "$AEGIS_CTU_BUNDLE" && sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) || fail CTU_BUNDLE_DRIFT
[ -f "$AEGIS_CTU_UNIT_SNAPSHOT" ] && [ ! -L "$AEGIS_CTU_UNIT_SNAPSHOT" ] || fail UNIT_SNAPSHOT_INVALID
[ "$(stat -c %u -- "$AEGIS_CTU_UNIT_SNAPSHOT" 2>/dev/null)" = 0 ] || fail UNIT_SNAPSHOT_OWNER_INVALID
[ "$(sha256sum -- "$AEGIS_CTU_UNIT_SNAPSHOT" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || fail UNIT_SNAPSHOT_SHA256_MISMATCH
[ ! -L "$TARGET" ] || fail INSTALLED_UNIT_SYMLINK
[ "$(stat -c %u:%a -- "$TARGET" 2>/dev/null)" = "0:644" ] || fail INSTALLED_UNIT_OWNERSHIP_OR_MODE
[ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || fail INSTALLED_UNIT_MISMATCH
[ "$(systemctl show -p FragmentPath --value aegis-idea3-core.service)" = "$TARGET" ] || fail CORE_FRAGMENT_PATH_INVALID
[ -z "$(systemctl show -p DropInPaths --value aegis-idea3-core.service)" ] || fail CORE_DROPIN_PRESENT
[ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service)" = "NeedDaemonReload=no" ] || fail CORE_DAEMON_RELOAD_PENDING
protect_clock=$(systemctl show -p ProtectClock --value aegis-idea3-core.service)
case "$protect_clock" in false|no) ;; *) fail CORE_EFFECTIVE_PROTECTCLOCK_INVALID ;; esac
[ "$(systemctl show -p User --value aegis-idea3-core.service)" = aegis-idea3 ] || fail CORE_EFFECTIVE_USER_INVALID
[ "$(systemctl show -p NoNewPrivileges --value aegis-idea3-core.service)" = yes ] || fail CORE_EFFECTIVE_NNP_INVALID
[ -z "$(systemctl show -p CapabilityBoundingSet --value aegis-idea3-core.service)" ] || fail CORE_EFFECTIVE_CAPABILITY_BOUND_INVALID
[ -z "$(systemctl show -p AmbientCapabilities --value aegis-idea3-core.service)" ] || fail CORE_EFFECTIVE_AMBIENT_CAPABILITY_INVALID
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || fail CORE_NOT_ACTIVE
[ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || fail CORE_NOT_RUNNING
[ "$(systemctl show -p Result --value aegis-idea3-core.service)" = success ] || fail CORE_RESULT_NOT_SUCCESS
core_nrestarts=$(systemctl show -p NRestarts --value aegis-idea3-core.service)
[ "$AEGIS_CTU_PRE_CORE_NRESTARTS" = 0 ] || fail CORE_PRE_RESTART_COUNT_INVALID
[ "$core_nrestarts" = 0 ] || fail CORE_UNEXPECTED_RESTART_COUNT
post_pid=$(systemctl show -p MainPID --value aegis-idea3-core.service)
post_start=$(systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
core_post_mono=$(systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-core.service)
[[ "$post_pid" =~ ^[1-9][0-9]*$ ]] || fail CORE_PID_INVALID
[ "$post_pid" != "$AEGIS_CTU_PRE_CORE_PID" ] || fail CORE_PID_DID_NOT_CHANGE
[ "$post_start" != "$AEGIS_CTU_PRE_CORE_START" ] || fail CORE_START_DID_NOT_CHANGE
post_apply="$AEGIS_CTU_WORK_DIR/post-apply-runtime"
[ -f "$post_apply" ] && [ ! -L "$post_apply" ] || fail POST_APPLY_RUNTIME_MISSING
read_runtime() { awk -F= -v key="$1" '$1 == key {print substr($0, index($0, "=") + 1)}' "$post_apply"; }
apply_core_pid=$(read_runtime core_pid); apply_core_start=$(read_runtime core_start); apply_core_mono=$(read_runtime core_monotonic)
[ "$post_pid" = "$apply_core_pid" ] || fail CORE_CHANGED_AFTER_APPLY
[ "$post_start" = "$apply_core_start" ] || fail CORE_START_CHANGED_AFTER_APPLY
[ "$core_post_mono" = "$apply_core_mono" ] || fail CORE_MONOTONIC_CHANGED_AFTER_APPLY
detector_state=$(systemctl show -p LoadState -p ActiveState -p SubState -p MainPID -p Result -p NRestarts -p InvocationID -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic -p UnitFileState -p Restart aegis-idea3-detector.service) || fail DETECTOR_STATE_UNREADABLE
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
grep -qx 'Result=success' <<<"$detector_state" || fail DETECTOR_RESULT_NOT_SUCCESS
grep -qx 'UnitFileState=disabled' <<<"$detector_state" || fail DETECTOR_UNIT_STATE_CHANGED
grep -qx 'Restart=no' <<<"$detector_state" || fail DETECTOR_RESTART_POLICY_CHANGED
[[ "$detector_pid" =~ ^[1-9][0-9]*$ ]] || fail DETECTOR_PID_INVALID
[[ "$detector_nrestarts" =~ ^[0-9]+$ && "$AEGIS_CTU_PRE_DETECTOR_NRESTARTS" = 0 && "$detector_nrestarts" = 0 ]] || fail DETECTOR_UNEXPECTED_RESTART_COUNT
[[ "$detector_invocation" =~ ^[0-9a-f]{32}$ ]] || fail DETECTOR_INVOCATION_INVALID
[ "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)" = 1 ] || fail DETECTOR_PROCESS_SET_UNEXPECTED
apply_detector_pid=$(read_runtime detector_pid); apply_detector_start=$(read_runtime detector_start); apply_detector_invocation=$(read_runtime detector_invocation); apply_detector_mono=$(read_runtime detector_monotonic); apply_detector_nrestarts=$(read_runtime detector_nrestarts)
[ "$detector_pid" = "$apply_detector_pid" ] || fail DETECTOR_CHANGED_AFTER_APPLY
[ "$detector_start" = "$apply_detector_start" ] || fail DETECTOR_START_CHANGED_AFTER_APPLY
[ "$detector_invocation" = "$apply_detector_invocation" ] || fail DETECTOR_INVOCATION_CHANGED_AFTER_APPLY
[ "$detector_mono" = "$apply_detector_mono" ] || fail DETECTOR_MONOTONIC_CHANGED_AFTER_APPLY
[ "$detector_nrestarts" = "$apply_detector_nrestarts" ] || fail DETECTOR_RESTART_COUNT_CHANGED_AFTER_APPLY
[[ "$core_post_mono" =~ ^[0-9]+$ && "$detector_mono" =~ ^[0-9]+$ ]] || fail DETECTOR_MONOTONIC_START_UNAVAILABLE
/usr/bin/python3 -I "$AEGIS_CTU_RUNTIME_VERIFY" --verify-detector --device-id "$AEGIS_CTU_DEVICE_ID" --core-post-monotonic "$core_post_mono" \
  --pre-detector-pid "$AEGIS_CTU_PRE_DETECTOR_PID" --pre-detector-start "$AEGIS_CTU_PRE_DETECTOR_START" --pre-detector-invocation "$AEGIS_CTU_PRE_DETECTOR_INVOCATION" --pre-detector-nrestarts "$AEGIS_CTU_PRE_DETECTOR_NRESTARTS" --pre-detector-monotonic "$AEGIS_CTU_PRE_DETECTOR_MONOTONIC" \
  --post-detector-pid "$detector_pid" --post-detector-start "$detector_start" --post-detector-invocation "$detector_invocation" --post-detector-nrestarts "$detector_nrestarts" --post-detector-monotonic "$detector_mono" \
  --post-detector-load "$detector_load" --post-detector-active "$detector_active" --post-detector-sub "$detector_sub" --post-detector-unit-file "$detector_unit_file" --post-detector-restart "$detector_restart" || fail DETECTOR_IMPLICIT_LIFECYCLE_UNPROVEN
runtime_args=(--core-pid "$post_pid" --pre-updated-at "$AEGIS_CTU_PRE_STATUS_UPDATED_AT" --device-id "$AEGIS_CTU_DEVICE_ID" --post-core-start-timestamp "$post_start")
runtime_last=''
for attempt in $(seq 1 30); do
  if runtime_last=$(/usr/bin/python3 -I "$AEGIS_CTU_RUNTIME_VERIFY" "${runtime_args[@]}" 2>&1); then
    printf '%s\n' "$runtime_last"
    printf 'CTU_VERIFY=PASS runtime=CORE_SANDBOX authenticated_status=PROVEN time_trust=SYNCED device=ONLINE uplink=LOCKDOWN\n'
    exit 0
  fi
  sleep 2
done
printf '%s\n' "$runtime_last" >&2
fail REAL_RUNTIME_PROOF_TIMEOUT
