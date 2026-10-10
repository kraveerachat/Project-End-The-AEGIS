#!/usr/bin/env bash
# ICu repository template. Every PIN_ value must be replaced by the reviewed
# exact-main freeze process. The committed template refuses to run unpinned.
# This runner is deliberately closed until actual installed-unit restart
# behavior has been proven in a separate reviewed task. That proof must not be
# inferred from synthetic systemd behavior or supplied as an environment flag.
# The stage contains zero explicit Detector commands.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
readonly AUTHORITATIVE_MAIN="4ebade39a3ae2bf2c4fd75f0ebba0edb46248e17"
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
RUNNER_TEMPLATE_SHA256=PIN_TEMPLATE_SHA256
UNIT_SNAPSHOT_SHA256=PIN_UNIT_SNAPSHOT_SHA256
OLD_RELEASE_ID=954ce1c191885e9e90198a6f54a3d990bcf144fc
NEW_RELEASE_ID=idea3-core-728c2d9b-20261010
NEW_RELEASE_SOURCE_MAIN=728c2d9b56d2d8b0b5933202ca20f45e6687602b
NEW_SUMS_SHA256=0fbe8c208b49242c4ede3a097f019879dad2e0e1ab2dd7ec1a468bc289fc5749
NEW_MANIFEST_SHA256=b6dfa93168f43d7471de3d5092baefda9f0b1027cf5dba3d6b1e3f99eb5a16cf
readonly SYSTEMD_RESTART_EFFECT_PROVEN=NO

for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID RUNNER_TEMPLATE_SHA256 UNIT_SNAPSHOT_SHA256; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not frozen ($pin)."; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[ "$EXPECTED_MAIN" = "$AUTHORITATIVE_MAIN" ] || { echo "STOP: main pin is not the authoritative PR #430 merge"; exit 2; }
[[ "$OPERATOR_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || exit 2
[[ "$OPERATOR_UID" =~ ^[1-9][0-9]{0,9}$ ]] || exit 2
[[ "$RUNNER_TEMPLATE_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$UNIT_SNAPSHOT_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
[ "$(id -u)" != 0 ] || { echo "Run as the frozen non-root operator."; exit 2; }
[ "$(id -un)" = "$OPERATOR_USER" ] && [ "$(id -u)" = "$OPERATOR_UID" ] || exit 2

REPO=PIN_EXECUTION_REPO_PATH
[[ "$REPO" = /* ]] || { echo "STOP: execution checkout path is not pinned."; exit 2; }
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
STG=$P4/stages/ICu
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] || { echo "usage: $0 <fresh ICu AUTH_DIR>"; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)

for f in authorization-ICu.txt k3-ICu.txt; do
  [ -f "$AUTH_DIR/$f" ] || { echo "STOP: $f missing"; exit 2; }
  grep -qx "date=$TODAY" "$AUTH_DIR/$f" || { echo "STOP: stale ICu authority"; exit 2; }
done
ICU_RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
[ "$(sha256sum "$P4/owner-run/run-icu-owner.sh" | cut -d' ' -f1)" = "$RUNNER_TEMPLATE_SHA256" ] || { echo "STOP: runner template digest mismatch"; exit 2; }
for f in \
  "expected_main=$EXPECTED_MAIN" \
  "frozen_runner_sha256=$ICU_RUNNER_SHA256" \
  "runner_template_sha256=$RUNNER_TEMPLATE_SHA256" \
  "unit_snapshot_sha256=$UNIT_SNAPSHOT_SHA256" \
  "operator_user=$OPERATOR_USER" \
  "operator_uid=$OPERATOR_UID" \
  "old_release_id=$OLD_RELEASE_ID" \
  "new_release_id=$NEW_RELEASE_ID" \
  "new_release_source_main=$NEW_RELEASE_SOURCE_MAIN" \
  "new_sums_sha256=$NEW_SUMS_SHA256" \
  "new_manifest_sha256=$NEW_MANIFEST_SHA256"; do
  grep -qx "$f" "$AUTH_DIR/authorization-ICu.txt" || { echo "STOP: Authorization pin mismatch"; exit 2; }
  grep -qx "$f" "$AUTH_DIR/k3-ICu.txt" || { echo "STOP: K3 pin mismatch"; exit 2; }
done
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || { echo "STOP: exact main mismatch"; exit 2; }
[ -z "$(git -C "$REPO" status --porcelain)" ] || { echo "STOP: execution checkout is dirty"; exit 2; }
git -C "$REPO" fetch -q origin main 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || { echo "STOP: origin/main mismatch"; exit 2; }

gate=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage ICu --mode live \
  --authorization "$AUTH_DIR/authorization-ICu.txt" --k3 "$AUTH_DIR/k3-ICu.txt") || { printf '%s\n' "$gate"; exit 2; }
printf '%s\n' "$gate" | grep -qx 'AUTHORIZATION_RECORD=VALID' || exit 2
printf '%s\n' "$gate" | grep -qx 'K3_CONFIRMATION=VALID' || exit 2
printf '%s\n' "$gate" | grep -qx 'ROLLBACK_HANDLER=REGISTERED' || exit 2

# Read-only host preflight: exact old pointer/release, reusable existing NEW
# release bytes (or fail if the prebuilt source artifact is absent), unit/drop-in
# snapshot, and the inactive Detector baseline. This does not rebuild NEW.
SOURCE_DIR=/home/kittipat/Workspace/idea3-p4-evidence/2026-10-10-core-release-candidate-728c2d9b/$NEW_RELEASE_ID
OLD_RELEASE_PATH=/opt/aegis-idea3/releases/$OLD_RELEASE_ID
[ "$(readlink /opt/aegis-idea3/current)" = "$OLD_RELEASE_PATH" ] || { echo "STOP: current is not exact OLD"; exit 2; }
python3 "$P4/p4-icu-upgrade.py" check-release --path "$OLD_RELEASE_PATH" --release-id "$OLD_RELEASE_ID" \
  --sums-sha256 9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df \
  --manifest-sha256 732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18 || { echo "STOP: OLD release guard failed"; exit 2; }
python3 "$P4/p4-icu-upgrade.py" check-release --path "$SOURCE_DIR" --release-id "$NEW_RELEASE_ID" --source-main "$NEW_RELEASE_SOURCE_MAIN" \
  --sums-sha256 "$NEW_SUMS_SHA256" --manifest-sha256 "$NEW_MANIFEST_SHA256" || { echo "STOP: prebuilt NEW release pin failed; it is never rebuilt here"; exit 2; }
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || { echo "STOP: Core is not active"; exit 2; }
[ "$(systemctl show -p LoadState --value aegis-idea3-detector.service)" = loaded ] || { echo "STOP: Detector is not loaded"; exit 2; }
[ "$(systemctl show -p ActiveState --value aegis-idea3-detector.service)" = inactive ] || { echo "STOP: Detector is not inactive"; exit 2; }
[ "$(systemctl show -p SubState --value aegis-idea3-detector.service)" = dead ] || { echo "STOP: Detector is not dead"; exit 2; }
[ "$(systemctl show -p UnitFileState --value aegis-idea3-detector.service)" = disabled ] || { echo "STOP: Detector is not disabled"; exit 2; }
[ "$(systemctl show -p MainPID --value aegis-idea3-detector.service)" = 0 ] || { echo "STOP: Detector PID is nonzero"; exit 2; }
[ "$(systemctl show -p Restart --value aegis-idea3-detector.service)" = no ] || { echo "STOP: Detector restart policy differs"; exit 2; }
[[ " $(systemctl show -p Requires --value aegis-idea3-detector.service) " == *" aegis-idea3-core.service "* ]] || { echo "STOP: Detector Core requirement differs"; exit 2; }
[[ " $(systemctl show -p After --value aegis-idea3-detector.service) " == *" aegis-idea3-core.service "* ]] || { echo "STOP: Detector Core ordering differs"; exit 2; }
[ -z "$(pgrep -af '[a]egis_soc.production_detector' || true)" ] || { echo "STOP: Detector process exists"; exit 2; }
UNIT_SNAPSHOT_SEEN=$(python3 "$P4/p4-icu-upgrade.py" unit-snapshot | sed -n 's/^ICU_UNIT_SNAPSHOT_SHA256=//p')
[ "$UNIT_SNAPSHOT_SEEN" = "$UNIT_SNAPSHOT_SHA256" ] || { echo "STOP: installed unit/drop-in snapshot changed"; exit 2; }

ATTEMPT_DIR=/var/lib/aegis-idea3/attempts
ATTEMPT_MARKER=$ATTEMPT_DIR/ICU-GLOBAL-ATTEMPT-CONSUMED
JOURNAL=$ATTEMPT_DIR/ICU-journal.json
[ -d "$ATTEMPT_DIR" ] && [ "$(stat -c '%u:%a' "$ATTEMPT_DIR")" = 0:700 ] || { echo "STOP: canonical ICu attempt directory is not root:0700"; exit 2; }
[ ! -e "$ATTEMPT_MARKER" ] && [ ! -L "$ATTEMPT_MARKER" ] || { echo "STOP: the one ICu attempt is already consumed"; exit 2; }
[ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || { echo "STOP: the one ICu journal already exists"; exit 2; }

# Fresh full L0 PRE is read-only and required before the attempt marker. Its
# checksum binds the evidence used by the later PRE/POST preservation compare.
TODAY_STAMP=$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-icu-$TODAY_STAMP
PRE=$EVID/pre-root
mkdir -m 700 "$EVID" || { echo "STOP: evidence directory could not be created"; exit 2; }
sudo -v || { echo "STOP: sudo authentication failed; no attempt consumed"; exit 2; }
sudo env EVID_DIR="$PRE" CAPTURE_LABEL=pre bash "$P4/p4-l0-capture.sh" || { echo "STOP: fresh PRE capture failed"; exit 2; }
sudo bash -c "cd '$PRE' && sha256sum -c --quiet --strict SHA256SUMS" || { echo "STOP: PRE checksum failed"; exit 2; }
CORE_PRE=$(systemctl show -p MainPID --value aegis-idea3-core.service)/$(systemctl show -p NRestarts --value aegis-idea3-core.service)
DETECTOR_PRE=$(systemctl show -p MainPID --value aegis-idea3-detector.service)/$(systemctl show -p ActiveState --value aegis-idea3-detector.service)/$(systemctl show -p SubState --value aegis-idea3-detector.service)

# The existing offline readiness evaluator is the source of exact release,
# Detector, authority, history, preservation and effect checks. A host-bound
# evidence package must be generated from fresh read-only captures here before
# marker consumption. It is not supplied by this repository task.
if [ "$SYSTEMD_RESTART_EFFECT_PROVEN" != YES ]; then
  echo "ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN"
  echo "ICU_ATTEMPT_CONSUMED=NO ICU_LIVE_EXECUTED=NO PRODUCTION_MUTATION_PERFORMED=NO"
  echo "READY_FOR_LIVE=NO RECOVERY_AUTHORIZED=NO"
  exit 3
fi

# The branch below is intentionally unreachable in this task. Enabling it
# requires a reviewed source update after actual installed-unit evidence.
sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase attempt_marker_pending || exit 2
sudo python3 "$P4/p4-icu-upgrade.py" consume-marker --path "$ATTEMPT_MARKER" || exit 2
sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase attempt_consumed || exit 2

ATTEMPTED=1
rollback_flow() {
  local reason=$1
  trap - ERR INT TERM
  echo "== ICu exact-release rollback (reason: $reason)"
  sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase forward_failed || {
    echo "ICU_JOURNAL=FAIL ESCALATE; do not retry; inspect $EVID"; exit 3;
  }
  sudo env AEGIS_ICU_LIVE_AUTHORIZED=YES AEGIS_ICU_JOURNAL="$JOURNAL" \
    AEGIS_ICU_JOURNAL_PHASE=forward_failed bash "$STG/rollback.sh" || {
      echo "ICU_ROLLBACK=FAIL ESCALATE; do not retry; inspect $EVID"; exit 3;
    }
  local rb="$EVID/rb-root"
  sudo env EVID_DIR="$rb" CAPTURE_LABEL=rollback bash "$P4/p4-l0-capture.sh" || exit 3
  sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE=/dev/null ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
    bash "$P4/p4-compare.sh" "$PRE" "$rb" > "$EVID/compare-pre-rb.txt" || exit 3
  echo "ICU_ROLLBACK=PASS EXACT_RELEASE=$OLD_RELEASE_ID ICU_ATTEMPT_CONSUMED=YES ICU_RERUN_ALLOWED=NO"
  exit 1
}
trap 'rollback_flow "unexpected error at line $LINENO"' ERR
trap 'rollback_flow "interrupted after marker"' INT TERM

sudo env AEGIS_ICU_LIVE_AUTHORIZED=YES AEGIS_ICU_WORK_DIR="$EVID" AEGIS_ICU_SOURCE_DIR="$SOURCE_DIR" \
  AEGIS_ICU_JOURNAL="$JOURNAL" AEGIS_ICU_OLD_RELEASE_ID="$OLD_RELEASE_ID" AEGIS_ICU_NEW_RELEASE_ID="$NEW_RELEASE_ID" \
  bash "$STG/apply.sh" || rollback_flow "release installation or current switch failed"
sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase core_restart_started --set forward_restart_invocations=1 || rollback_flow "write-ahead restart record failed"
sudo systemctl restart aegis-idea3-core.service || rollback_flow "plain Core restart failed"
sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase core_restarted || rollback_flow "post-restart journal write failed"
sudo bash "$STG/verify.sh" || rollback_flow "Core or inactive Detector verification failed"
[ "$(systemctl show -p MainPID --value aegis-idea3-core.service)/$(systemctl show -p NRestarts --value aegis-idea3-core.service)" != "$CORE_PRE" ] || rollback_flow "Core identity did not change exactly once"
[ "$(systemctl show -p MainPID --value aegis-idea3-detector.service)/$(systemctl show -p ActiveState --value aegis-idea3-detector.service)/$(systemctl show -p SubState --value aegis-idea3-detector.service)" = "$DETECTOR_PRE" ] || rollback_flow "inactive Detector state changed"
sudo env EVID_DIR="$EVID/post-root" CAPTURE_LABEL=post bash "$P4/p4-l0-capture.sh" || rollback_flow "POST capture failed"
sudo env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$STG/allow-keys.txt" ALLOW_LISTENERS_FILE="$STG/allow-listeners.txt" \
  bash "$P4/p4-compare.sh" "$PRE" "$EVID/post-root" > "$EVID/compare-pre-post.txt" || rollback_flow "service preservation compare failed"
sudo python3 "$P4/p4-icu-upgrade.py" journal --path "$JOURNAL" --phase complete || rollback_flow "final journal write failed"
trap - ERR INT TERM
echo "ICU_RESULT=PASS ICU_LIVE_EXECUTED=YES PRODUCTION_MUTATION_PERFORMED=YES RELEASE_ID=$NEW_RELEASE_ID"
echo "CORE_RESTART_INVOCATIONS=1 DETECTOR_COMMANDS=0 DETECTOR_STATE_UNCHANGED=YES RECOVERY_AUTHORIZED=NO"
