#!/usr/bin/env bash
# Exact-release rollback only. Never starts, stops, or restarts the Detector.
set -euo pipefail
readonly SYSTEMD_RESTART_EFFECT_PROVEN=NO
fail() { printf 'ICU_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ "${AEGIS_ICU_LIVE_AUTHORIZED:-}" = YES ] || fail FROZEN_RUNNER_AUTHORITY_REQUIRED
for v in AEGIS_ICU_JOURNAL AEGIS_ICU_JOURNAL_PHASE; do [ -n "${!v:-}" ] || fail "${v}_REQUIRED"; done
[ "$AEGIS_ICU_JOURNAL_PHASE" = forward_failed ] || fail JOURNAL_PHASE_REFUSED
[ -f "$AEGIS_ICU_JOURNAL" ] && [ ! -L "$AEGIS_ICU_JOURNAL" ] || fail JOURNAL_REQUIRED
JOURNAL_STATE=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(str(d.get(k,"")) for k in ("stage","phase","old_release_id","new_release_id","current_owned_by_attempt","forward_restart_invocations","rollback_restart_invocations")))' "$AEGIS_ICU_JOURNAL") || fail JOURNAL_UNREADABLE
read -r J_STAGE J_PHASE J_OLD J_NEW J_CURRENT_OWNED J_FORWARD_RESTARTS J_ROLLBACK_RESTARTS <<< "$JOURNAL_STATE"
[ "$J_STAGE $J_PHASE $J_OLD $J_NEW" = "ICu forward_failed 954ce1c191885e9e90198a6f54a3d990bcf144fc idea3-core-728c2d9b-20261010" ] || fail JOURNAL_OWNERSHIP_OR_PHASE_INVALID
[ "$J_ROLLBACK_RESTARTS" = 0 ] || fail ROLLBACK_RESTART_ALREADY_USED
[ -d /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc ] || fail EXACT_OLD_RELEASE_MISSING
[ "$(readlink -f /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc)" = /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc ] || fail OLD_RELEASE_PATH_UNSAFE
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python3 "$HERE/p4-icu-upgrade.py" check-release --path /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc \
  --release-id 954ce1c191885e9e90198a6f54a3d990bcf144fc \
  --sums-sha256 9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df \
  --manifest-sha256 732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18 || fail EXACT_OLD_RELEASE_PREFLIGHT_FAILED
TEMP=/opt/aegis-idea3/.current-icu-rollback
if [ "$J_CURRENT_OWNED" = True ]; then
  [ "$(readlink -f /opt/aegis-idea3/current)" = /opt/aegis-idea3/releases/idea3-core-728c2d9b-20261010 ] || fail CURRENT_NOT_OWNED_BY_ICU
  [ ! -e "$TEMP" ] && [ ! -L "$TEMP" ] || fail ROLLBACK_TEMP_EXISTS
  python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase rollback_switching_current || fail JOURNAL_ROLLBACK_SWITCHING_FAILED
  ln -s /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc "$TEMP"
  mv -Tf "$TEMP" /opt/aegis-idea3/current
  sync -f /opt/aegis-idea3
  python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase rollback_current_restored --set current_owned_by_attempt=false || fail JOURNAL_ROLLBACK_SWITCHED_FAILED
else
  [ "$(readlink -f /opt/aegis-idea3/current)" = /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc ] || fail CURRENT_CHANGED_WITHOUT_ICU_OWNERSHIP
fi
FORWARD_RESTARTS=${J_FORWARD_RESTARTS:-0}
if [ "$FORWARD_RESTARTS" = 1 ]; then
  [ "$SYSTEMD_RESTART_EFFECT_PROVEN" = YES ] || fail ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN
  python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase rollback_core_restart_started || fail JOURNAL_ROLLBACK_RESTART_STARTED_FAILED
  systemctl restart aegis-idea3-core.service
  python3 "$HERE/p4-icu-upgrade.py" journal --path "$AEGIS_ICU_JOURNAL" --phase rollback_core_restarted --set rollback_restart_invocations=1 || fail JOURNAL_ROLLBACK_RESTARTED_FAILED
fi
printf 'ICU_ROLLBACK=POINTER_RESTORED_EXACT_OLD\n'
