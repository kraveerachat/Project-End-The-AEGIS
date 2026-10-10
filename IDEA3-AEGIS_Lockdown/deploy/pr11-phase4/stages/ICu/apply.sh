#!/usr/bin/env bash
# The owner runner must consume ICu's global attempt and write the exact
# preflight journal before invoking this handler. This handler only installs
# the already-built, digest-pinned release and atomically switches `current`.
set -euo pipefail
fail() { printf 'ICU_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ "${AEGIS_ICU_LIVE_AUTHORIZED:-}" = YES ] || fail FROZEN_RUNNER_AUTHORITY_REQUIRED
for v in AEGIS_ICU_WORK_DIR AEGIS_ICU_SOURCE_DIR AEGIS_ICU_JOURNAL; do [ -n "${!v:-}" ] || fail "${v}_REQUIRED"; done
[ -e /var/lib/aegis-idea3/attempts/ICU-GLOBAL-ATTEMPT-CONSUMED ] || fail ATTEMPT_MARKER_REQUIRED
[ -f "$AEGIS_ICU_JOURNAL" ] && [ ! -L "$AEGIS_ICU_JOURNAL" ] || fail JOURNAL_REQUIRED
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 "$HERE/p4-icu-upgrade.py" assert-journal --path "$AEGIS_ICU_JOURNAL" --phase attempt_consumed || fail JOURNAL_PHASE_INVALID
[ "$AEGIS_ICU_NEW_RELEASE_ID" = idea3-core-728c2d9b-20261010 ] || fail NEW_RELEASE_PIN_MISMATCH
[ "$AEGIS_ICU_OLD_RELEASE_ID" = 954ce1c191885e9e90198a6f54a3d990bcf144fc ] || fail OLD_RELEASE_PIN_MISMATCH
[ -d "$AEGIS_ICU_SOURCE_DIR" ] || fail PREBUILT_RELEASE_SOURCE_MISSING
TARGET=/opt/aegis-idea3/releases/idea3-core-728c2d9b-20261010
[ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || fail NEW_RELEASE_ALREADY_EXISTS
python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase installing || fail JOURNAL_INSTALLING_FAILED
python3 "$HERE/p4-l7-install-release.py" install --release-id idea3-core-728c2d9b-20261010 \
  --source "$AEGIS_ICU_SOURCE_DIR" --logical-path "$TARGET" --evidence "$AEGIS_ICU_WORK_DIR/install-evidence.tsv" || fail RELEASE_INSTALL_FAILED
python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase installed --set release_owned_by_attempt=true || fail JOURNAL_INSTALLED_FAILED
TEMP=/opt/aegis-idea3/.current-icu-next
[ ! -e "$TEMP" ] && [ ! -L "$TEMP" ] || fail SWITCH_TEMP_EXISTS
python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase switching_current || fail JOURNAL_SWITCHING_FAILED
ln -s "$TARGET" "$TEMP"
mv -Tf "$TEMP" /opt/aegis-idea3/current
sync -f /opt/aegis-idea3
python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase current_switched --set current_owned_by_attempt=true || fail JOURNAL_SWITCHED_FAILED
printf 'ICU_APPLY=COMPLETE\n'
