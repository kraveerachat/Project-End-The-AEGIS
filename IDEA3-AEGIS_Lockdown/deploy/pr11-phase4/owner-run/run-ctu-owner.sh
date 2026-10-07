#!/bin/sh
# The executable entry point is a POSIX launcher so Bash startup files and
# caller-selected PATH entries cannot run before the governed runner starts.
# The clean re-exec deliberately carries no caller environment.  A caller who
# supplies the guard still reaches this line under /bin/sh and is refused
# before any Bash-only runner code can execute.
if [ "${AEGIS_CTU_CLEAN_START:-}" != YES ]; then
  exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C AEGIS_CTU_CLEAN_START=YES /bin/bash --noprofile --norc "$0" "$@"
fi
[ -n "${BASH_VERSION:-}" ] || { echo 'STOP: CTu runner clean Bash boundary was not established.' >&2; exit 2; }
# Frozen post-merge CTu owner runner template. It is intentionally unpinned;
# a future exact-main authority must fill the pins after human merge.
set -Eeuo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C
# Restart contract: PRECONSUME_CORE_RESTARTS=0; success uses one explicit
# restart; a post-consume failure may use one additional rollback restart;
# POST_CONSUME_FAILURE_MAX_CORE_RESTARTS=2 and ROLLBACK_CORE_RESTARTS_MAX=1.
git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
UNIT_SHA256=PIN_CORE_UNIT_SHA256
MERGED_MAIN_WORKTREE=PIN_MERGED_MAIN_WORKTREE
EVIDENCE_ROOT=PIN_EVIDENCE_ROOT
DEVICE_ID=PIN_DEVICE_ID
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID UNIT_SHA256 MERGED_MAIN_WORKTREE EVIDENCE_ROOT DEVICE_ID; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)." >&2; exit 2 ;; esac
done
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$UNIT_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
[[ "$DEVICE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || exit 2
REPO=$MERGED_MAIN_WORKTREE
AUTH_DIR=${1:-}
[ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] && [ "$(readlink -f -- "$AUTH_DIR")" = "$AUTH_DIR" ] || { echo 'usage: run-ctu-owner.sh <fresh auth dir>' >&2; exit 2; }
[ -n "$REPO" ] && [ "$(readlink -f -- "$REPO")" = "$REPO" ] && [ -d "$REPO/.git" ] || exit 2
[ "${EVIDENCE_ROOT#/}" != "$EVIDENCE_ROOT" ] && [[ "$EVIDENCE_ROOT" != *..* ]] && { [ ! -e "$EVIDENCE_ROOT" ] || [ ! -L "$EVIDENCE_ROOT" ] && [ "$(readlink -f -- "$EVIDENCE_ROOT")" = "$EVIDENCE_ROOT" ]; } || exit 2
[ "$(id -u)" != 0 ] || { echo 'STOP: run as the frozen operator, not root.' >&2; exit 2; }
[ "${SUDO+x}" != x ] || { echo 'STOP: environment override SUDO is forbidden.' >&2; exit 2; }
[ -z "${GIT_DIR:-}" ] && [ -z "${GIT_WORK_TREE:-}" ] && [ -z "${GIT_INDEX_FILE:-}" ] && [ -z "$(env | sed -n 's/^GIT_[^=]*=.*/x/p')" ] || { echo 'STOP: Git environment override is forbidden.' >&2; exit 2; }
[ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_CANONICAL_DIR:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_TRUST_ROOT:-}" ] && [ -z "${AEGIS_CTU_TEST_ONLY_BOUNDARY:-}" ] || { echo 'STOP: test-only CTu governance seam is forbidden in the live runner.' >&2; exit 2; }
TODAY=$(TZ=Asia/Bangkok date +%F)
APP=$REPO/IDEA3-AEGIS_Lockdown
P4=$APP/deploy/pr11-phase4
UNIT_SOURCE=$APP/deploy/aegis-idea3-core.service.example
AUTH=$AUTH_DIR/authorization-CTu.txt
K3=$AUTH_DIR/k3-CTu.txt
eval "$(git -C "$REPO" show "$EXPECTED_MAIN:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh")"
RUNNER_SHA256=$(sha256sum "$0" | cut -d' ' -f1)
ctu_operator_identity_gate "$OPERATOR_USER" "$OPERATOR_UID" || { echo CTU_OPERATOR_IDENTITY_INVALID >&2; exit 2; }
for f in "$AUTH" "$K3"; do
  [ -f "$f" ] && [ ! -L "$f" ] || exit 1
  grep -qx "stage=CTu" "$f" || exit 1
  grep -qx "date=$TODAY" "$f" || exit 1
  grep -qx "expected_main=$EXPECTED_MAIN" "$f" || exit 1
  grep -qx "runner_sha256=$RUNNER_SHA256" "$f" || exit 1
  grep -qx "unit_sha256=$UNIT_SHA256" "$f" || exit 1
  grep -qx "operator_user=$OPERATOR_USER" "$f" || exit 1
  grep -qx "operator_uid=$OPERATOR_UID" "$f" || exit 1
  grep -qx "device_id=$DEVICE_ID" "$f" || exit 1
done
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || exit 1
[ -z "$(git -C "$REPO" status --porcelain)" ] || exit 1
[ "$(sha256sum "$UNIT_SOURCE" | cut -d' ' -f1)" = "$UNIT_SHA256" ] || exit 1
ctu_marker_unconsumed || exit 1
gov_dir=$(ctu_canonical_dir)
[ ! -e "$gov_dir/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] || { echo "STOP: Recovery marker is present; CTu cannot run after Recovery." >&2; exit 1; }
[ ! -e "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-PASS" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-PASS" ] || { echo "STOP: Recovery closeout is present." >&2; exit 1; }
[ ! -e "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-FAIL" ] && [ ! -L "$gov_dir/RECOVERY-GLOBAL-CLOSEOUT-FAIL" ] || { echo "STOP: Recovery closeout is present." >&2; exit 1; }
ctu_rru_successor_gate "$REPO" "$EXPECTED_MAIN" || { echo "STOP: valid RRu PASS closeout missing." >&2; exit 1; }
for f in apply.sh verify.sh rollback.sh allow-keys.txt allow-listeners.txt allow-keys-rollback.txt; do [ -f "$P4/stages/CTu/$f" ] || exit 1; done
gate_out=$(TZ=Asia/Bangkok bash "$P4/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || exit 1
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || exit 1
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || exit 1
grep -qx 'ROLLBACK_HANDLER=REGISTERED' <<<"$gate_out" || exit 1
ORIGIN_MAIN=$(git -C "$REPO" ls-remote origin refs/heads/main | awk '{print $1}')
[ "$ORIGIN_MAIN" = "$EXPECTED_MAIN" ] || exit 1
sudo -v || { echo 'STOP: sudo authentication failed before CTu.' >&2; exit 1; }
ctu_start_sudo_keepalive || { echo 'STOP: could not start sudo keepalive.' >&2; exit 1; }
sudo -n systemctl is-active --quiet aegis-idea3-mosquitto.service || sudo -n systemctl is-active --quiet mosquitto.service || { echo 'STOP: broker is not active.' >&2; exit 1; }
timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q 'yes' || sudo -n systemctl is-active --quiet chronyd.service || sudo -n systemctl is-active --quiet systemd-timesyncd.service || { echo 'STOP: NTP runtime is not ready.' >&2; exit 1; }
CORE_PRE_LOAD=$(sudo -n systemctl show -p LoadState --value aegis-idea3-core.service)
CORE_PRE_ACTIVE=$(sudo -n systemctl show -p ActiveState --value aegis-idea3-core.service)
CORE_PRE_SUB=$(sudo -n systemctl show -p SubState --value aegis-idea3-core.service)
CORE_PRE_RESULT=$(sudo -n systemctl show -p Result --value aegis-idea3-core.service)
CORE_PRE_PID=$(sudo -n systemctl show -p MainPID --value aegis-idea3-core.service)
CORE_PRE_START=$(sudo -n systemctl show -p ExecMainStartTimestamp --value aegis-idea3-core.service)
CORE_PRE_NRESTARTS=$(sudo -n systemctl show -p NRestarts --value aegis-idea3-core.service)
[ "$CORE_PRE_LOAD" = "loaded" ] && [ "$CORE_PRE_ACTIVE" = "active" ] && [ "$CORE_PRE_SUB" = "running" ] && [ "$CORE_PRE_RESULT" = "success" ] && [ "$CORE_PRE_NRESTARTS" = 0 ] && [[ "$CORE_PRE_PID" =~ ^[1-9][0-9]*$ ]] || { echo 'STOP: Core is not in active running state before CTu.' >&2; exit 1; }
ctu_validate_core_env_device_id /etc/aegis-idea3/core.env "$DEVICE_ID" || { echo 'STOP: core.env AEGIS_P1_DEVICE_ID does not match frozen DEVICE_ID or is invalid.' >&2; exit 1; }
CORE_ENV_PRE_SHA=$(sudo -n sha256sum /etc/aegis-idea3/core.env | cut -d' ' -f1)
STATUS_PRE_UPDATED_AT=$(sudo -n /usr/bin/python3 -I -B -c 'import json; print(float(json.load(open("/run/aegis-idea3/status.json"))["updated_at"]))') || exit 1
DETECTOR_PRE_LOAD=$(sudo -n systemctl show -p LoadState --value aegis-idea3-detector.service)
DETECTOR_PRE_ACTIVE=$(sudo -n systemctl show -p ActiveState --value aegis-idea3-detector.service)
DETECTOR_PRE_SUB=$(sudo -n systemctl show -p SubState --value aegis-idea3-detector.service)
DETECTOR_PRE_UNIT_FILE=$(sudo -n systemctl show -p UnitFileState --value aegis-idea3-detector.service)
DETECTOR_PRE_RESTART=$(sudo -n systemctl show -p Restart --value aegis-idea3-detector.service)
DETECTOR_PRE_RESULT=$(sudo -n systemctl show -p Result --value aegis-idea3-detector.service)
DETECTOR_PRE_STATE=$(sudo -n systemctl show -p MainPID -p ExecMainStartTimestamp -p InvocationID -p NRestarts aegis-idea3-detector.service)
DETECTOR_PRE_PID=$(awk -F= '$1 == "MainPID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_START=$(awk -F= '$1 == "ExecMainStartTimestamp" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_INVOCATION=$(awk -F= '$1 == "InvocationID" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_NRESTARTS=$(awk -F= '$1 == "NRestarts" {print $2}' <<<"$DETECTOR_PRE_STATE")
DETECTOR_PRE_MONOTONIC=$(sudo -n systemctl show -p ExecMainStartTimestampMonotonic --value aegis-idea3-detector.service)
DETECTOR_PRE_PROC_COUNT=$(pgrep -fc 'aegis_soc[.]production_detector' 2>/dev/null || true)
DETECTOR_PRE_MODE=""
if [ "$DETECTOR_PRE_LOAD" = "loaded" ] && [ "$DETECTOR_PRE_ACTIVE" = "active" ] && [ "$DETECTOR_PRE_SUB" = "running" ] && \
   [ "$DETECTOR_PRE_UNIT_FILE" = "disabled" ] && [ "$DETECTOR_PRE_RESTART" = "no" ] && [ "$DETECTOR_PRE_RESULT" = "success" ] && \
   [ "$DETECTOR_PRE_NRESTARTS" = 0 ] && [[ "$DETECTOR_PRE_PID" =~ ^[1-9][0-9]*$ ]] && \
   [[ "$DETECTOR_PRE_INVOCATION" =~ ^[0-9a-f]{32}$ ]] && [[ "$DETECTOR_PRE_MONOTONIC" =~ ^[0-9]+$ ]] && \
   [ "$DETECTOR_PRE_PROC_COUNT" = 1 ]; then
  DETECTOR_PRE_MODE="ACTIVE"
elif [ "$DETECTOR_PRE_LOAD" = "loaded" ] && [ "$DETECTOR_PRE_ACTIVE" = "inactive" ] && [ "$DETECTOR_PRE_SUB" = "dead" ] && \
     [ "$DETECTOR_PRE_UNIT_FILE" = "disabled" ] && [ "$DETECTOR_PRE_RESTART" = "no" ] && \
     [ "$DETECTOR_PRE_NRESTARTS" = 0 ] && [ "$DETECTOR_PRE_PID" = "0" ] && \
     [ -z "$DETECTOR_PRE_INVOCATION" ] && [ "$DETECTOR_PRE_MONOTONIC" = "0" ] && \
     [ "$DETECTOR_PRE_PROC_COUNT" = 0 ]; then
  DETECTOR_PRE_MODE="INACTIVE"
else
  echo 'STOP: Detector is neither in valid ACTIVE nor valid INACTIVE state before CTu.' >&2
  exit 1
fi
INSTALLED_CORE_UNIT="/etc/systemd/system/aegis-idea3-core.service"
PRE_UNIT_SHA=""
if [ -f "$INSTALLED_CORE_UNIT" ] && [ ! -L "$INSTALLED_CORE_UNIT" ]; then
  PRE_UNIT_SHA=$(sudo -n sha256sum "$INSTALLED_CORE_UNIT" | cut -d' ' -f1)
fi
avail_pct=$(df -P "$EVIDENCE_ROOT" | awk 'NR==2 {print 100 - int($5)}')
[ "$avail_pct" -ge 10 ] || { echo "STOP: evidence root disk capacity too low ($avail_pct% free)." >&2; exit 1; }
EVID=$EVIDENCE_ROOT/$(TZ=Asia/Bangkok date +%F)-ctu-$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)
WORK=$EVID/ctu-work; PRE=$EVID/pre-root; POST=$EVID/post-root; RB=$EVID/rb-root
mkdir -m 700 "$EVID" || exit 1
BUNDLE=$WORK/bundle
UNIT_SNAPSHOT=$WORK/core.service.snapshot
JOURNAL_SINCE=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
capture() { sudo -n env EVID_DIR="$1" CAPTURE_LABEL="$2" JOURNAL_SINCE="$JOURNAL_SINCE" bash "$BUNDLE/p4-l0-capture.sh"; }
compare() {
  sudo -n env DISK_THRESHOLD_PCT=90 ALLOW_KEYS_FILE="$BUNDLE/$2" ALLOW_LISTENERS_FILE="$BUNDLE/stages/CTu/allow-listeners.txt" bash "$BUNDLE/p4-compare.sh" "$3" "$4" > "$5"
  grep -qx 'PRESERVATION_S10=PASS' "$5" && grep -qx 'COMPARE_RESULT=PASS' "$5"
}
ctu_validate_dropins_root() {
  local raw path
  local -a paths=() args=()
  raw=$(systemctl show -p DropInPaths --value aegis-idea3-core.service) || return 1
  read -r -a paths <<< "$raw"
  for path in "${paths[@]}"; do args+=(--drop-in-path "$path"); done
  /usr/bin/python3 -I -B "$AEGIS_CTU_BUNDLE/ctu-acceptance/ctu_dropin_contract.py" \
    --repo "$AEGIS_CTU_REPO" --main "$AEGIS_CTU_EXPECTED_MAIN" --root / "${args[@]}"
}
rollback_flow() {
  local reason=$1 out
  [ "${ROLLBACK_DONE:-0}" = 0 ] || return 1
  ROLLBACK_DONE=1
  if ! out=$(sudo -n env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_REPO="$REPO" AEGIS_CTU_EXPECTED_MAIN="$EXPECTED_MAIN" bash -c "$(declare -f ctu_validate_dropins_root ctu_rollback_fail ctu_rollback_governed); ctu_rollback_governed" 2>&1); then
    l7u_secret_scan "$EVID" /usr/bin/python3 || true
    printf '%s\nCTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=%s\n' "$out" "$reason" >&2
    return 1
  fi
  grep -q '^CTU_ROLLBACK=PASS' <<<"$out" || { l7u_secret_scan "$EVID" /usr/bin/python3 || true; return 1; }
  if ! capture "$RB" ctu-rb; then l7u_secret_scan "$EVID" /usr/bin/python3 || true; echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=RB_CAPTURE' >&2; return 1; fi
  if ! compare "$PRE" "stages/CTu/allow-keys-rollback.txt" "$PRE" "$RB" "$EVID/compare-pre-rb.txt"; then l7u_secret_scan "$EVID" /usr/bin/python3 || true; echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=PRE_RB_COMPARE' >&2; return 1; fi
  if ! l7u_secret_scan "$EVID" /usr/bin/python3; then echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_ROLLBACK=INCOMPLETE reason=RB_SECRET_SCAN' >&2; return 1; fi
  printf 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=YES CTU_RERUN_ALLOWED=NO CTU_ROLLBACK=PASS CTU_RB_CAPTURE=COMPLETE CTU_PRE_RB_COMPARE=PASS reason=%s\n' "$reason" >&2
  return 0
}

ctu_apply_fail() { printf 'CTU_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
ctu_apply_governed() {

: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
: "${AEGIS_CTU_UNIT_SNAPSHOT:?AEGIS_CTU_UNIT_SNAPSHOT required}"
: "${AEGIS_CTU_UNIT_SHA256:?AEGIS_CTU_UNIT_SHA256 required}"
: "${AEGIS_CTU_BUNDLE:?AEGIS_CTU_BUNDLE required}"
: "${AEGIS_CTU_JOURNAL_SINCE:?AEGIS_CTU_JOURNAL_SINCE required}"
: "${AEGIS_CTU_DETECTOR_PRE_MODE:?AEGIS_CTU_DETECTOR_PRE_MODE required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || ctu_apply_fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || ctu_apply_fail ROOT_REQUIRED
[ -d "$AEGIS_CTU_BUNDLE" ] && [ ! -L "$AEGIS_CTU_BUNDLE" ] && [ "$(stat -c %u -- "$AEGIS_CTU_BUNDLE")" = 0 ] || ctu_apply_fail CTU_BUNDLE_INVALID
[ -z "$(find "$AEGIS_CTU_BUNDLE" -type l -print -quit)" ] || ctu_apply_fail CTU_BUNDLE_SYMLINK
( cd "$AEGIS_CTU_BUNDLE" && sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) || ctu_apply_fail CTU_BUNDLE_DRIFT
MARKER=/var/lib/aegis-idea3-governance/CTU-GLOBAL-ATTEMPT-CONSUMED
[ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(stat -c %u:%a "$MARKER")" = "0:600" ] || ctu_apply_fail CTU_PROVENANCE_MISSING
marker_runner=$(awk -F= '$1 == "CTU_FROZEN_RUNNER_SHA256" {print $2}' "$MARKER")
marker_bundle=$(awk -F= '$1 == "CTU_BUNDLE_MANIFEST_SHA256" {print $2}' "$MARKER")
[[ "$marker_runner" =~ ^[0-9a-f]{64}$ ]] && [ "$marker_runner" = "$(sha256sum "$AEGIS_CTU_BUNDLE/owner-run/run-ctu-owner.sh" | cut -d' ' -f1)" ] || ctu_apply_fail CTU_FROZEN_RUNNER_PROVENANCE_INVALID
[[ "$marker_bundle" =~ ^[0-9a-f]{64}$ ]] && [ "$marker_bundle" = "$(sha256sum "$AEGIS_CTU_BUNDLE/CTU-BUNDLE-SHA256SUMS" | cut -d' ' -f1)" ] || ctu_apply_fail CTU_BUNDLE_PROVENANCE_INVALID
PROVENANCE=/var/lib/aegis-idea3-governance/CTU-FROZEN-RUNNER-PROVENANCE
[ -f "$PROVENANCE" ] && [ ! -L "$PROVENANCE" ] && [ "$(stat -c %u:%a "$PROVENANCE")" = "0:400" ] || ctu_apply_fail CTU_HANDLER_PROVENANCE_MISSING
grep -qx "CTU_FROZEN_RUNNER_SHA256=$marker_runner" "$PROVENANCE" || ctu_apply_fail CTU_HANDLER_PROVENANCE_RUNNER_MISMATCH
grep -qx "CTU_BUNDLE_MANIFEST_SHA256=$marker_bundle" "$PROVENANCE" || ctu_apply_fail CTU_HANDLER_PROVENANCE_BUNDLE_MISMATCH
rm -f -- "$PROVENANCE" || ctu_apply_fail CTU_HANDLER_PROVENANCE_CONSUME_FAILED
sync -- "$(dirname "$PROVENANCE")" || ctu_apply_fail CTU_HANDLER_PROVENANCE_NOT_DURABLE
[ -f "$AEGIS_CTU_UNIT_SNAPSHOT" ] && [ ! -L "$AEGIS_CTU_UNIT_SNAPSHOT" ] || ctu_apply_fail UNIT_SNAPSHOT_INVALID
[ "$(stat -c %u -- "$AEGIS_CTU_UNIT_SNAPSHOT" 2>/dev/null)" = 0 ] || ctu_apply_fail UNIT_SNAPSHOT_OWNER_INVALID
[ "$(sha256sum -- "$AEGIS_CTU_UNIT_SNAPSHOT" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || ctu_apply_fail UNIT_SNAPSHOT_SHA256_MISMATCH
TARGET=/etc/systemd/system/aegis-idea3-core.service
mkdir -p -- "$AEGIS_CTU_WORK_DIR"
if [ -L "$TARGET" ]; then ctu_apply_fail UNIT_TARGET_SYMLINK; fi
if [ -e "$TARGET" ]; then
  [ -f "$TARGET" ] || ctu_apply_fail UNIT_TARGET_NOT_REGULAR
  [ "$(stat -c %u:%a -- "$TARGET")" = "0:644" ] || ctu_apply_fail UNIT_TARGET_OWNERSHIP_OR_MODE
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
[ "$(stat -c %u:%a -- "$TARGET")" = "0:644" ] || ctu_apply_fail UNIT_TARGET_OWNERSHIP_OR_MODE
[ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$AEGIS_CTU_UNIT_SHA256" ] || ctu_apply_fail INSTALLED_UNIT_MISMATCH
printf 'installed_sha=%s\n' "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" >> "$AEGIS_CTU_WORK_DIR/journal"
printf 'phase=after-install\n' >> "$AEGIS_CTU_WORK_DIR/journal"
fragment=$(systemctl show -p FragmentPath --value aegis-idea3-core.service) || ctu_apply_fail CORE_UNIT_SHOW_FAILED
[ "$fragment" = "$TARGET" ] || ctu_apply_fail CORE_FRAGMENT_PATH_INVALID
ctu_validate_dropins_root || ctu_apply_fail CORE_DROPIN_CONTRACT_INVALID_AFTER_INSTALL
if [ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service 2>/dev/null || true)" = yes ]; then
  printf 'phase=before-daemon-reload\n' >> "$AEGIS_CTU_WORK_DIR/journal"
  systemctl daemon-reload
fi
[ "$(systemctl show -p NeedDaemonReload --value aegis-idea3-core.service 2>/dev/null || true)" = no ] || ctu_apply_fail CORE_DAEMON_RELOAD_PENDING
ctu_validate_dropins_root || ctu_apply_fail CORE_DROPIN_CONTRACT_INVALID_AFTER_RELOAD
for property in ProtectClock=false User=aegis-idea3 NoNewPrivileges=true CapabilityBoundingSet= AmbientCapabilities=; do
  key=${property%%=*}; value=${property#*=}
  actual=$(systemctl show -p "$key" --value aegis-idea3-core.service)
  if [ "$key" = ProtectClock ]; then case "$actual" in false|no) ;; *) ctu_apply_fail CORE_EFFECTIVE_PROTECTCLOCK_INVALID ;; esac; else [ "$actual" = "$value" ] || ctu_apply_fail "CORE_EFFECTIVE_${key}_INVALID"; fi
done
printf 'phase=after-daemon-reload\n' >> "$AEGIS_CTU_WORK_DIR/journal"
printf 'phase=before-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
systemctl restart aegis-idea3-core.service
printf 'phase=after-core-restart\n' >> "$AEGIS_CTU_WORK_DIR/journal"
ctu_validate_dropins_root || ctu_apply_fail CORE_DROPIN_CONTRACT_INVALID_AFTER_RESTART
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
  journal_raw=$(journalctl -u aegis-idea3-detector.service --since "$AEGIS_CTU_JOURNAL_SINCE" --no-pager -o cat 2>/dev/null) || ctu_apply_fail DETECTOR_LIFECYCLE_EVIDENCE_UNAVAILABLE
  lifecycle_events=$(printf '%s\n' "$journal_raw" | grep -E '^(Starting|Started|Stopping|Stopped|Deactivated|Failed to start)' | wc -l)
  [ "$AEGIS_CTU_DETECTOR_PRE_MODE" != INACTIVE ] || [ "$lifecycle_events" = 0 ] || ctu_apply_fail DETECTOR_INACTIVE_LIFECYCLE_EVENT
  printf 'detector_lifecycle_events=%s\n' "$lifecycle_events"
} > "$AEGIS_CTU_WORK_DIR/post-apply-runtime.tmp"
mv -f -- "$AEGIS_CTU_WORK_DIR/post-apply-runtime.tmp" "$AEGIS_CTU_WORK_DIR/post-apply-runtime"
printf 'CTU_APPLY=PASS\n'
}

ctu_rollback_fail() { printf 'CTU_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }
ctu_rollback_governed() {
: "${AEGIS_CTU_WORK_DIR:?AEGIS_CTU_WORK_DIR required}"
: "${AEGIS_CTU_BUNDLE:?AEGIS_CTU_BUNDLE required}"
[ "${AEGIS_CTU_LIVE_AUTHORIZED:-}" = YES ] || ctu_rollback_fail AEGIS_CTU_LIVE_AUTHORIZED_REQUIRED
[ "$(id -u)" = 0 ] || ctu_rollback_fail ROOT_REQUIRED
[ -d "$AEGIS_CTU_BUNDLE" ] && [ ! -L "$AEGIS_CTU_BUNDLE" ] && [ "$(stat -c %u -- "$AEGIS_CTU_BUNDLE")" = 0 ] || ctu_rollback_fail CTU_BUNDLE_INVALID
[ -z "$(find "$AEGIS_CTU_BUNDLE" -type l -print -quit)" ] || ctu_rollback_fail CTU_BUNDLE_SYMLINK
( cd "$AEGIS_CTU_BUNDLE" && sha256sum -c --quiet --strict CTU-BUNDLE-SHA256SUMS ) || ctu_rollback_fail CTU_BUNDLE_DRIFT
ctu_validate_dropins_root || ctu_rollback_fail CORE_DROPIN_CONTRACT_INVALID_BEFORE_ROLLBACK
[ -f "$AEGIS_CTU_WORK_DIR/journal" ] || ctu_rollback_fail JOURNAL_MISSING
TARGET=/etc/systemd/system/aegis-idea3-core.service
if [ -L "$TARGET" ]; then ctu_rollback_fail UNIT_TARGET_SYMLINK; fi
phase=$(awk -F= '$1 == "phase" {value=$2} END {print value}' "$AEGIS_CTU_WORK_DIR/journal")
case "$phase" in before-install|"") printf 'CTU_ROLLBACK=PASS phase=NO_MUTATION\n'; exit 0 ;; esac
grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal" && [ "$(stat -c %u -- "$AEGIS_CTU_WORK_DIR/pre-core.service" 2>/dev/null)" = 0 ] || true
if grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal"; then
  [ -f "$AEGIS_CTU_WORK_DIR/pre-core.service" ] || ctu_rollback_fail PREIMAGE_MISSING
  [ ! -L "$AEGIS_CTU_WORK_DIR/pre-core.service" ] || ctu_rollback_fail PREIMAGE_SYMLINK
  [ "$(stat -c %u:%a -- "$AEGIS_CTU_WORK_DIR/pre-core.service")" = "0:644" ] || ctu_rollback_fail PREIMAGE_OWNERSHIP_OR_MODE
  pre_sha=$(awk -F= '$1 == "pre_sha" {print $2}' "$AEGIS_CTU_WORK_DIR/journal")
  [[ "$pre_sha" =~ ^[0-9a-f]{64}$ ]] || ctu_rollback_fail PREIMAGE_SHA_MISSING
  [ "$(sha256sum -- "$AEGIS_CTU_WORK_DIR/pre-core.service" | cut -d' ' -f1)" = "$pre_sha" ] || ctu_rollback_fail PREIMAGE_SHA_MISMATCH
  install -o root -g root -m 0644 -- "$AEGIS_CTU_WORK_DIR/pre-core.service" "$TARGET.ctu-rollback"
  mv -f -- "$TARGET.ctu-rollback" "$TARGET"
else
  [ "$phase" = unit-installed ] || [ "$phase" = after-install ] || [ "$phase" = after-daemon-reload ] || [ "$phase" = before-core-restart ] || [ "$phase" = after-core-restart ] || ctu_rollback_fail JOURNAL_PHASE_INVALID
  rm -f -- "$TARGET"
fi
if [ "$phase" != before-install ]; then
  systemctl daemon-reload
  systemctl restart aegis-idea3-core.service
fi
ctu_validate_dropins_root || ctu_rollback_fail CORE_DROPIN_CONTRACT_INVALID_AFTER_ROLLBACK
[ "$(systemctl show -p ActiveState --value aegis-idea3-core.service)" = active ] || ctu_rollback_fail CORE_NOT_ACTIVE_AFTER_ROLLBACK
[ "$(systemctl show -p SubState --value aegis-idea3-core.service)" = running ] || ctu_rollback_fail CORE_NOT_RUNNING_AFTER_ROLLBACK
[ "$(systemctl show -p Result --value aegis-idea3-core.service)" = success ] || ctu_rollback_fail CORE_RESULT_NOT_SUCCESS_AFTER_ROLLBACK
if grep -qx 'pre_unit=present' "$AEGIS_CTU_WORK_DIR/journal"; then
  cmp -s -- "$AEGIS_CTU_WORK_DIR/pre-core.service" "$TARGET" || ctu_rollback_fail PRE_UNIT_MISMATCH
  [ "$(sha256sum -- "$TARGET" | cut -d' ' -f1)" = "$pre_sha" ] || ctu_rollback_fail PRE_UNIT_SHA_MISMATCH
else
  [ ! -e "$TARGET" ] || ctu_rollback_fail ABSENT_PRE_UNIT_MISMATCH
fi
printf 'CTU_ROLLBACK=PASS\n'
}
IN_POST_FAIL=0
post_fail() {
  local reason=${1:-UNKNOWN}
  [ "${IN_POST_FAIL:-0}" = 0 ] || return 0
  IN_POST_FAIL=1
  TERMINAL=1
  trap '' INT TERM HUP EXIT
  trap - ERR
  local consumed=NO
  if ctu_marker_path >/dev/null 2>&1 && sudo -n test -e "$(ctu_marker_path)" && ! sudo -n test -L "$(ctu_marker_path)"; then
    consumed=YES
    rollback_flow "$reason" || true
    ctu_record_failure "$reason" || true
  fi
  ctu_stop_sudo_keepalive 2>/dev/null || true
  printf 'CTU_RESULT=FAIL_IMMUTABLE\nCTU_ATTEMPT_CONSUMED=%s\nCTU_RERUN_ALLOWED=NO\nCTU_FAILURE_REASON=%s\n' "$consumed" "$reason" > "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
  sync -- "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
  mv -f -- "$EVID/terminal-result.tmp.$$" "$EVID/terminal-result" 2>/dev/null || true
  sync -- "$EVID/terminal-result" "$EVID" 2>/dev/null || true
  echo "CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=$consumed CTU_RERUN_ALLOWED=NO reason=$reason" >&2
  exit 1
}
handle_signal() { local signal=$1; post_fail "SIGNAL_$signal"; }
exit_handler() { local rc=$?; [ "${TERMINAL:-0}" = 1 ] || [ "$rc" = 0 ] || post_fail "EXIT_$rc"; }
CONSUMED=0; CTU_MARKER_CREATED=0; ROLLBACK_DONE=0
trap 'exit_handler' EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal HUP' HUP
if ! ctu_prepare_bundle "$REPO" "$P4" "$BUNDLE" "$EXPECTED_MAIN"; then post_fail CTU_BUNDLE; fi
if ! ctu_prepare_unit_snapshot "$UNIT_SOURCE" "$UNIT_SNAPSHOT" "$UNIT_SHA256"; then post_fail UNIT_SNAPSHOT; fi
if ! ctu_verify_bundle "$BUNDLE"; then post_fail BUNDLE_VERIFY; fi
if ! ctu_verify_unit_snapshot "$UNIT_SNAPSHOT" "$UNIT_SHA256"; then post_fail UNIT_SNAPSHOT_VERIFY; fi
source "$BUNDLE/p4-ctu-run-lib.sh"
source "$BUNDLE/p4-l7u-run-lib.sh"
capture "$PRE" ctu-pre || post_fail PRE_CAPTURE
ctu_marker_unconsumed || post_fail PRE_MARKER
gate_out=$(TZ=Asia/Bangkok bash "$BUNDLE/p4-stage-gate.sh" --stage CTu --mode live --authorization "$AUTH" --k3 "$K3") || post_fail PRE_REGATE
grep -qx 'AUTHORIZATION_RECORD=VALID' <<<"$gate_out" || post_fail PRE_AUTH
grep -qx 'K3_CONFIRMATION=VALID' <<<"$gate_out" || post_fail PRE_K3
if ! ctu_validate_core_env_device_id /etc/aegis-idea3/core.env "$DEVICE_ID"; then
  post_fail CORE_ENV_DEVICE_MISMATCH
fi
DROPIN_PATHS=$(sudo -n systemctl show -p DropInPaths --value aegis-idea3-core.service) || post_fail PRE_DROPIN_READ
read -r -a DROPIN_PATH_ARGS <<< "$DROPIN_PATHS"
DROPIN_VERIFY_ARGS=()
for dropin_path in "${DROPIN_PATH_ARGS[@]}"; do DROPIN_VERIFY_ARGS+=(--drop-in-path "$dropin_path"); done
sudo -n /usr/bin/python3 -I -B "$BUNDLE/ctu-acceptance/ctu_dropin_contract.py" \
  --repo "$REPO" --main "$EXPECTED_MAIN" --root / "${DROPIN_VERIFY_ARGS[@]}" || post_fail PRE_DROPIN_CONTRACT
if ! ctu_consume_attempt "$WORK" "$DEVICE_ID" "$BUNDLE/p4-ctu-runtime-verify.py" "$RUNNER_SHA256" "$BUNDLE"; then
  if [ "${CTU_MARKER_CREATED:-0}" = 1 ]; then
    CONSUMED=1; post_fail MARKER_DURABILITY
  fi
  echo 'CTU_RESULT=FAIL_IMMUTABLE CTU_ATTEMPT_CONSUMED=UNKNOWN reason=MARKER_RACE_OR_PREEXISTING' >&2
  exit 1
fi
CONSUMED=1
if ! sudo -n env AEGIS_CTU_LIVE_AUTHORIZED=YES AEGIS_CTU_REPO="$REPO" AEGIS_CTU_EXPECTED_MAIN="$EXPECTED_MAIN" AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" AEGIS_CTU_JOURNAL_SINCE="$JOURNAL_SINCE" AEGIS_CTU_DETECTOR_PRE_MODE="$DETECTOR_PRE_MODE" bash -c "$(declare -f ctu_validate_dropins_root ctu_apply_fail ctu_apply_governed); ctu_apply_governed"; then post_fail APPLY; fi
if ! capture "$POST" ctu-post; then post_fail POST_CAPTURE; fi
if ! compare "$PRE" "stages/CTu/allow-keys.txt" "$PRE" "$POST" "$EVID/compare-pre-post.txt"; then post_fail COMPARE_S10; fi
if ! l7u_secret_scan "$EVID" /usr/bin/python3; then post_fail SECRET_SCAN; fi
if ! sudo -n env AEGIS_CTU_REPO="$REPO" AEGIS_CTU_EXPECTED_MAIN="$EXPECTED_MAIN" AEGIS_CTU_BUNDLE="$BUNDLE" AEGIS_CTU_UNIT_SNAPSHOT="$UNIT_SNAPSHOT" AEGIS_CTU_UNIT_SHA256="$UNIT_SHA256" AEGIS_CTU_WORK_DIR="$WORK" AEGIS_CTU_RUNTIME_VERIFY="$BUNDLE/p4-ctu-runtime-verify.py" AEGIS_CTU_PRE_CORE_PID="$CORE_PRE_PID" AEGIS_CTU_PRE_CORE_START="$CORE_PRE_START" AEGIS_CTU_PRE_CORE_NRESTARTS="$CORE_PRE_NRESTARTS" AEGIS_CTU_PRE_STATUS_UPDATED_AT="$STATUS_PRE_UPDATED_AT" AEGIS_CTU_PRE_CORE_ENV_SHA="$CORE_ENV_PRE_SHA" AEGIS_CTU_DEVICE_ID="$DEVICE_ID" AEGIS_CTU_DETECTOR_PRE_MODE="$DETECTOR_PRE_MODE" AEGIS_CTU_PRE_DETECTOR_PID="$DETECTOR_PRE_PID" AEGIS_CTU_PRE_DETECTOR_START="$DETECTOR_PRE_START" AEGIS_CTU_PRE_DETECTOR_INVOCATION="$DETECTOR_PRE_INVOCATION" AEGIS_CTU_PRE_DETECTOR_NRESTARTS="$DETECTOR_PRE_NRESTARTS" AEGIS_CTU_PRE_DETECTOR_MONOTONIC="$DETECTOR_PRE_MONOTONIC" bash "$BUNDLE/stages/CTu/verify.sh"; then post_fail VERIFY; fi
EVIDENCE_MANIFEST="$EVID/CTU-EVIDENCE-SHA256SUMS"
( cd "$EVID" && find . -type f ! -name "$(basename "$EVIDENCE_MANIFEST")" ! -name 'terminal-result*' -print0 | sort -z | xargs -0 sha256sum ) > "$EVIDENCE_MANIFEST.tmp" || post_fail EVIDENCE_MANIFEST
mv -f -- "$EVIDENCE_MANIFEST.tmp" "$EVIDENCE_MANIFEST" || post_fail EVIDENCE_MANIFEST
EVIDENCE_MANIFEST_SHA=$(sha256sum "$EVIDENCE_MANIFEST" | cut -d' ' -f1)
if ! ctu_record_success "$EXPECTED_MAIN" "$UNIT_SHA256" "$EVID" "$DEVICE_ID" "$DETECTOR_PRE_MODE" "$RUNNER_SHA256" "$EVIDENCE_MANIFEST_SHA"; then post_fail CTU_CLOSEOUT; fi
ctu_stop_sudo_keepalive 2>/dev/null || true
TERMINAL=1
printf 'CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_EXPECTED_MAIN=%s\nCTU_EXECUTION_MAIN=%s\nCTU_RUNNER_SHA256=%s\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\nCTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=%s\nCTU_DEVICE_ID=%s\nCTU_EVIDENCE_MANIFEST_SHA256=%s\nCTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\nCTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=%s\nCTU_EVIDENCE_ROOT=%s\n' "$EXPECTED_MAIN" "$EXPECTED_MAIN" "$RUNNER_SHA256" "$DETECTOR_PRE_MODE" "$DEVICE_ID" "$EVIDENCE_MANIFEST_SHA" "$UNIT_SHA256" "$EVID" > "$EVID/terminal-result.tmp.$$"
sync -- "$EVID/terminal-result.tmp.$$" 2>/dev/null || true
mv -f -- "$EVID/terminal-result.tmp.$$" "$EVID/terminal-result" 2>/dev/null || true
sync -- "$EVID/terminal-result" "$EVID"
printf 'CTU_LIVE=PASS RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO\n'
