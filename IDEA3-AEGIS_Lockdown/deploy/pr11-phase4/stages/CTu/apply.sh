#!/usr/bin/env bash
# CTu apply: install only the reviewed Core unit, daemon-reload when required,
# then perform one normal Core restart. The detector is never addressed.
set -Eeuo pipefail
fail() { printf 'CTU_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
: "${AEGIS_CTU_UNIT_SNAPSHOT:?AEGIS_CTU_UNIT_SNAPSHOT required}"
: "${AEGIS_CTU_UNIT_SHA256:?AEGIS_CTU_UNIT_SHA256 required}"
: "${AEGIS_CTU_BUNDLE:?AEGIS_CTU_BUNDLE required}"
: "${AEGIS_CTU_JOURNAL_SINCE:?AEGIS_CTU_JOURNAL_SINCE required}"
: "${AEGIS_CTU_DETECTOR_PRE_MODE:?AEGIS_CTU_DETECTOR_PRE_MODE required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$AEGIS_CTU_BUNDLE" ] && [ ! -L "$AEGIS_CTU_BUNDLE" ] && [ "$(stat -c %u -- "$AEGIS_CTU_BUNDLE")" = 0 ] || fail CTU_BUNDLE_INVALID
[ -z "$(find "$AEGIS_CTU_BUNDLE" -type l -print -quit)" ] || fail CTU_BUNDLE_SYMLINK
( cd "$AEGIS_CTU_BUNDLE" && sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) || fail CTU_BUNDLE_DRIFT
MARKER=/var/lib/aegis-idea3-governance/CTU-GLOBAL-ATTEMPT-CONSUMED
[ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(stat -c %u:%a "$MARKER")" = "0:600" ] || fail CTU_PROVENANCE_MISSING
marker_runner=$(awk -F= '$1 == "CTU_FROZEN_RUNNER_SHA256" {print $2}' "$MARKER")
marker_bundle=$(awk -F= '$1 == "CTU_BUNDLE_MANIFEST_SHA256" {print $2}' "$MARKER")
[[ "$marker_runner" =~ ^[0-9a-f]{64}$ ]] && [ "$marker_runner" = "$(sha256sum "$AEGIS_CTU_BUNDLE/owner-run/run-ctu-owner.sh" | cut -d' ' -f1)" ] || fail CTU_FROZEN_RUNNER_PROVENANCE_INVALID
[[ "$marker_bundle" =~ ^[0-9a-f]{64}$ ]] && [ "$marker_bundle" = "$(sha256sum "$AEGIS_CTU_BUNDLE/CTU-BUNDLE-SHA256SUMS" | cut -d' ' -f1)" ] || fail CTU_BUNDLE_PROVENANCE_INVALID
PROVENANCE=/var/lib/aegis-idea3-governance/CTU-FROZEN-RUNNER-PROVENANCE
[ -f "$PROVENANCE" ] && [ ! -L "$PROVENANCE" ] && [ "$(stat -c %u:%a "$PROVENANCE")" = "0:400" ] || fail CTU_HANDLER_PROVENANCE_MISSING
grep -qx "CTU_FROZEN_RUNNER_SHA256=$marker_runner" "$PROVENANCE" || fail CTU_HANDLER_PROVENANCE_RUNNER_MISMATCH
grep -qx "CTU_BUNDLE_MANIFEST_SHA256=$marker_bundle" "$PROVENANCE" || fail CTU_HANDLER_PROVENANCE_BUNDLE_MISMATCH
rm -f -- "$PROVENANCE" || fail CTU_HANDLER_PROVENANCE_CONSUME_FAILED
sync -- "$(dirname "$PROVENANCE")" || fail CTU_HANDLER_PROVENANCE_NOT_DURABLE
[ -f "$AEGIS_CTU_UNIT_SNAPSHOT" ] && [ ! -L "$AEGIS_CTU_UNIT_SNAPSHOT" ] || fail UNIT_SNAPSHOT_INVALID
[ "$(stat -c %u -- "$AEGIS_CTU_UNIT_SNAPSHOT" 2>/dev/null)" = 0 ] || fail UNIT_SNAPSHOT_OWNER_INVALID
[ "$(sha256sum -- "$AEGIS_CTU_UNIT_SNAPSHOT" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || fail UNIT_SNAPSHOT_SHA256_MISMATCH
TARGET=/etc/systemd/system/aegis-idea3-core.service
mkdir -p -- "$AEGIS_CTU_WORK_DIR"
if [ -L "$TARGET" ]; then fail UNIT_TARGET_SYMLINK; fi
if [ -e "$TARGET" ]; then
  [ -f "$TARGET" ] || fail UNIT_TARGET_NOT_REGULAR
  [ "$(stat -c %u:%a -- "$TARGET")" = "0:644" ] || fail UNIT_TARGET_OWNERSHIP_OR_MODE
  install -o root -g root -m 0644 -- "$TARGET" "$AEGIS_CTU_WORK_DIR/pre-core.service.tmp"
  mv -f -- "$AEGIS_CTU_WORK_DIR/pre-core.service.tmp" "$AEGIS_CTU_WORK_DIR/pre-core.service"
  printf 'pre_unit=present\npre_sha=%s\n' "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" > "$AEGIS_CTU_WORK_DIR/journal"
else
  printf 'pre_unit=absent\npre_sha=ABSENT\n' > "$AEGIS_CTU_WORK_DIR/journal"
fi
printf 'phase=before-install\n' >> "$AEGIS_CTU_WORK_DIR/journal"
install -o root -g root -m 0644 -- "$AEGIS_CTU_UNIT_SNAPSHOT" "$TARGET.ctu-new"
mv -f -- "$TARGET.ctu-new" "$TARGET"
printf 'phase=unit-installed\n' >> "$AEGIS_CTU_WORK_DIR/journal"
[ "$(stat -c %u:%a -- "$TARGET")" = "0:644" ] || fail UNIT_TARGET_OWNERSHIP_OR_MODE
[ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || fail INSTALLED_UNIT_MISMATCH
printf 'installed_sha=%s\n' "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" >> "$AEGIS_CTU_WORK_DIR/journal"
printf 'phase=after-install\n' >> "$AEGIS_CTU_WORK_DIR/journal"
fragment=$(systemctl show -p FragmentPath --value aegis-idea3-core.service) || fail CORE_UNIT_SHOW_FAILED
[ "$fragment" = "$TARGET" ] || fail CORE_FRAGMENT_PATH_INVALID
[ -z "$(systemctl show -p DropInPaths --value aegis-idea3-core.service)" ] || fail CORE_DROPIN_PRESENT
if [ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service 2>/dev/null || true)" = yes ]; then
  printf 'phase=before-daemon-reload\n' >> "$AEGIS_CTU_WORK_DIR/journal"
  systemctl daemon-reload
fi
[ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service 2>/dev/null || true)" = no ] || fail CORE_DAEMON_RELOAD_PENDING
for property in ProtectClock=false User=aegis-idea3 NoNewPrivileges=true CapabilityBoundingSet= AmbientCapabilities=; do
  key=${property%%=*}; value=${property#*=}
  actual=$(systemctl show -p "$key" --value aegis-idea3-core.service)
  if [ "$key" = ProtectClock ]; then case "$actual" in false|no) ;; *) fail CORE_EFFECTIVE_PROTECTCLOCK_INVALID ;; esac; else [ "$actual" = "$value" ] || fail "CORE_EFFECTIVE_${key}_INVALID"; fi
done
printf 'phase=after-daemon-reload\n' >> "$AEGIS_CTU_WORK_DIR/journal"
printf 'phase=before-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
systemctl restart aegis-idea3-core.service
printf 'phase=after-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
{
  printf 'core_pid=%s\n' "$(systemctl show -p MainPID --value aegis-idea3-core.service)"
  printf 'core_start=%s\n' "$(systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)"
  printf 'core_monotonic=%s\n' "$(systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-core.service)"
  printf 'detector_pid=%s\n' "$(systemctl show -p MainPID --value aegis-idea3-detector.service)"
  printf 'detector_start=%s\n' "$(systemctl show -p ExecMainStartTimestamp --value aegis-idea3-detector.service)"
  printf 'detector_invocation=%s\n' "$(systemctl show -p InvocationID --value aegis-idea3-detector.service)"
  printf 'detector_monotonic=%s\n' "$(systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-detector.service)"
  printf 'detector_nrestarts=%s\n' "$(systemctl show -p NRestarts --value aegis-idea3-detector.service)"
  printf 'detector_load=%s\n' "$(systemctl show -p LoadState --value aegis-idea3-detector.service)"
  printf 'detector_active=%s\n' "$(systemctl show -p ActiveState --value aegis-idea3-detector.service)"
  printf 'detector_sub=%s\n' "$(systemctl show -p SubState --value aegis-idea3-detector.service)"
  printf 'detector_unit_file=%s\n' "$(systemctl show -p UnitFileState --value aegis-idea3-detector.service)"
  printf 'detector_restart=%s\n' "$(systemctl show -p Restart --value aegis-idea3-detector.service)"
  printf 'detector_result=%s\n' "$(systemctl show -p Result --value aegis-idea3-detector.service)"
  printf 'detector_process_count=%s\n' "$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)"
  journal_raw=$(journalctl -u aegis-idea3-detector.service --since "$AEGIS_CTU_JOURNAL_SINCE" --no-pager -o cat 2>/dev/null) || fail DETECTOR_LIFECYCLE_EVIDENCE_UNAVAILABLE
  lifecycle_events=$(printf '%s\n' "$journal_raw" | grep -E '^(Starting|Started|Stopping|Stopped|Deactivated|Failed to start)' | wc -l)
  [ "$AEGIS_CTU_DETECTOR_PRE_MODE" != INACTIVE ] || [ "$lifecycle_events" = 0 ] || fail DETECTOR_INACTIVE_LIFECYCLE_EVENT
  printf 'detector_lifecycle_events=%s\n' "$lifecycle_events"
} > "$AEGIS_CTU_WORK_DIR/post-apply-runtime.tmp"
mv -f -- "$AEGIS_CTU_WORK_DIR/post-apply-runtime.tmp" "$AEGIS_CTU_WORK_DIR/post-apply-runtime"
printf 'CTU_APPLY=PASS\n'
