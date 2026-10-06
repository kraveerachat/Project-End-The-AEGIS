#!/usr/bin/env bash
# CTu apply: install only the reviewed Core unit, daemon-reload when required,
# then perform one normal Core restart. The detector is never addressed.
set -Eeuo pipefail
fail() { printf 'CTU_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
: "${AEGIS_CTU_UNIT_SOURCE:?AEGIS_CTU_UNIT_SOURCE required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -f "$AEGIS_CTU_UNIT_SOURCE" ] || fail UNIT_SOURCE_MISSING
TARGET=/etc/systemd/system/aegis-idea3-core.service
mkdir -p -- "$AEGIS_CTU_WORK_DIR"
if [ -e "$TARGET" ]; then
  cp -a -- "$TARGET" "$AEGIS_CTU_WORK_DIR/pre-core.service"
  printf 'pre_unit=present\n' > "$AEGIS_CTU_WORK_DIR/journal"
else
  printf 'pre_unit=absent\n' > "$AEGIS_CTU_WORK_DIR/journal"
fi
printf 'phase=before-install\n' >> "$AEGIS_CTU_WORK_DIR/journal"
install -o root -g root -m 0644 -- "$AEGIS_CTU_UNIT_SOURCE" "$TARGET.ctu-new"
mv -f -- "$TARGET.ctu-new" "$TARGET"
cmp -s -- "$AEGIS_CTU_UNIT_SOURCE" "$TARGET" || fail INSTALLED_UNIT_MISMATCH
printf 'phase=after-install\n' >> "$AEGIS_CTU_WORK_DIR/journal"
if [ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service 2>/dev/null || true)" = yes ]; then
  printf 'phase=before-daemon-reload\n' >> "$AEGIS_CTU_WORK_DIR/journal"
  systemctl daemon-reload
fi
printf 'phase=before-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
systemctl restart aegis-idea3-core.service
printf 'phase=after-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
printf 'CTU_APPLY=PASS\n'
