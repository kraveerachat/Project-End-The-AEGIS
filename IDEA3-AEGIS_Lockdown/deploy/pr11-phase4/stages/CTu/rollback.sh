#!/usr/bin/env bash
# CTu rollback restores only the exact pre-stage Core unit and restarts Core.
set -Eeuo pipefail
fail() { printf 'CTU_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -f "$AEGIS_CTU_WORK_DIR/journal" ] || fail JOURNAL_MISSING
TARGET=/etc/systemd/system/aegis-idea3-core.service
if grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal"; then
  [ -f "$AEGIS_CTU_WORK_DIR/pre-core.service" ] || fail PREIMAGE_MISSING
  install -o root -g root -m 0644 -- "$AEGIS_CTU_WORK_DIR/pre-core.service" "$TARGET.ctu-rollback"
  mv -f -- "$TARGET.ctu-rollback" "$TARGET"
else
  rm -f -- "$TARGET"
fi
systemctl daemon-reload
systemctl restart aegis-idea3-core.service
printf 'CTU_ROLLBACK=PASS\n'
