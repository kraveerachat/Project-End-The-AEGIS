#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8p SECRET-WORK cleanup handler (HOST ONLY).
#
# The canonical device flow stages two TEMPORARY, SECRET-BEARING files in the stage WORK_DIR: nvs.csv (all provisioned secrets in plaintext) and nvs.bin (the encoded
# Wi-Fi/MQTT values). They are work artifacts, NOT evidence: formal evidence is the checksummed host captures, the compare reports, the Authorization/K3 copies, the frozen-input
# metadata, first-write.marker and the canonical 12-field l8p JSON. The owner runner calls this handler after apply and verify have both passed, so the final full-EVID secret scan
# (which has NO exclusions) can prove the whole evidence tree holds no secret value. The post-first-write rollback applies the same confidentiality cleanup (rollback.sh).
#
# It removes EXACTLY nvs.csv and nvs.bin inside the EXACT stage WORK_DIR and nothing else: never first-write.marker, never the l8p JSON evidence, never a directory tree, never anything
# outside WORK_DIR. It starts no process other than coreutils: no device, no esptool, no MQTT, no CUT/RESTORE, no service. Idempotent.
set -euo pipefail

fail() {
  printf 'L8P_SECRET_WORK_CLEANUP=FAIL reason=%s\n' "$1" >&2
  exit 1
}

WORK_DIR="${AEGIS_L8P_WORK_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L8P_WORK_DIR required"
case "$WORK_DIR" in
  /*) ;;
  *) fail "AEGIS_L8P_WORK_DIR must be an absolute path" ;;
esac
case "$WORK_DIR/" in
  */../* | */./* | *//*) fail "AEGIS_L8P_WORK_DIR must not contain empty, . or .. components" ;;
esac
[ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ] || fail "AEGIS_L8P_WORK_DIR must be a real directory, not a symlink"
[ "$(cd "$WORK_DIR" && pwd -P)" = "$WORK_DIR" ] || fail "AEGIS_L8P_WORK_DIR must be its own canonical path (no symlinked component)"

# Fail closed on anything unexpected BEFORE removing anything: each artifact is either absent or a regular non-symlink file.
for artifact in nvs.csv nvs.bin; do
  path="$WORK_DIR/$artifact"
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
    fail "$artifact is not a regular file (symlink or directory); refusing to remove it"
  fi
done

for artifact in nvs.csv nvs.bin; do
  rm -f -- "${WORK_DIR:?}/$artifact"
done

for artifact in nvs.csv nvs.bin; do
  if [ -e "$WORK_DIR/$artifact" ] || [ -L "$WORK_DIR/$artifact" ]; then
    fail "$artifact is still present after removal"
  fi
done

printf 'NVS_CSV_PRESENT=NO\n'
printf 'NVS_BIN_PRESENT=NO\n'
if [ -f "$WORK_DIR/first-write.marker" ]; then
  printf 'FIRST_WRITE_MARKER_PRESENT=YES\n'
else
  printf 'FIRST_WRITE_MARKER_PRESENT=NO\n'
fi
printf 'L8P_DEVICE_ACTION_TAKEN=NONE\n'
printf 'L8P_SECRET_WORK_CLEANUP=PASS\n'
exit 0
