#!/usr/bin/env bash
# CTu rollback restores only the exact pre-stage Core unit and restarts Core.
set -Eeuo pipefail
fail() { printf 'CTU_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
: "${AEGIS_CTU_BUNDLE:?AEGIS_CTU_BUNDLE required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -d "$AEGIS_CTU_BUNDLE" ] && [ ! -L "$AEGIS_CTU_BUNDLE" ] && [ "$(stat -c %u -- "$AEGIS_CTU_BUNDLE")" = 0 ] || fail CTU_BUNDLE_INVALID
[ -z "$(find "$AEGIS_CTU_BUNDLE" -type l -print -quit)" ] || fail CTU_BUNDLE_SYMLINK
( cd "$AEGIS_CTU_BUNDLE" && sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) || fail CTU_BUNDLE_DRIFT
[ -f "$AEGIS_CTU_WORK_DIR/journal" ] || fail JOURNAL_MISSING
TARGET=/etc/systemd/system/aegis-idea3-core.service
if [ -L "$TARGET" ]; then fail UNIT_TARGET_SYMLINK; fi
phase=$(awk -F= '$1 == "phase" {value=$2} END {print value}' "$AEGIS_CTU_WORK_DIR/journal")
case "$phase" in before-install|"") printf 'CTU_ROLLBACK=PASS phase=NO_MUTATION\n'; exit 0 ;; esac
grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal" && [ "$(stat -c %u -- "$AEGIS_CTU_WORK_DIR/pre-core.service" 2>/dev/null)" = 0 ] || true
if grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal"; then
  [ -f "$AEGIS_CTU_WORK_DIR/pre-core.service" ] || fail PREIMAGE_MISSING
  [ ! -L "$AEGIS_CTU_WORK_DIR/pre-core.service" ] || fail PREIMAGE_SYMLINK
  [ "$(stat -c %u:%a -- "$AEGIS_CTU_WORK_DIR/pre-core.service")" = "0:644" ] || fail PREIMAGE_OWNERSHIP_OR_MODE
  pre_sha=$(awk -F= '$1 == "pre_sha" {print $2}' "$AEGIS_CTU_WORK_DIR/journal")
  [[ "$pre_sha" =~ ^[0-9a-f]{64}$ ]] || fail PREIMAGE_SHA_MISSING
  [ "$(sha256sum -- "$AEGIS_CTU_WORK_DIR/pre-core.service" | cut -d' ' -f1)" = "$pre_sha" ] || fail PREIMAGE_SHA_MISMATCH
  install -o root -g root -m 0644 -- "$AEGIS_CTU_WORK_DIR/pre-core.service" "$TARGET.ctu-rollback"
  mv -f -- "$TARGET.ctu-rollback" "$TARGET"
else
  [ "$phase" = unit-installed ] || [ "$phase" = after-install ] || [ "$phase" = after-daemon-reload ] || [ "$phase" = before-core-restart ] || [ "$phase" = after-core-restart ] || fail JOURNAL_PHASE_INVALID
  rm -f -- "$TARGET"
fi
if [ "$phase" != before-install ]; then
  systemctl daemon-reload
  systemctl restart aegis-idea3-core.service
fi
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || fail CORE_NOT_ACTIVE_AFTER_ROLLBACK
[ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || fail CORE_NOT_RUNNING_AFTER_ROLLBACK
[ "$(systemctl show -p Result --value aegis-idea3-core.service)" = success ] || fail CORE_RESULT_NOT_SUCCESS_AFTER_ROLLBACK
if grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal"; then
  cmp -s -- "$AEGIS_CTU_WORK_DIR/pre-core.service" "$TARGET" || fail PRE_UNIT_MISMATCH
  [ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$pre_sha" ] || fail PRE_UNIT_SHA_MISMATCH
else
  [ ! -e "$TARGET" ] || fail ABSENT_PRE_UNIT_MISMATCH
fi
printf 'CTU_ROLLBACK=PASS\n'
