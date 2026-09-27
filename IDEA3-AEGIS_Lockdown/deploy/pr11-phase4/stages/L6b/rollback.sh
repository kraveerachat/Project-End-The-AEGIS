#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b stage-owned rollback handler (T4 design §10, OD-L6B-01).
# MUTATING in live mode. Acts ONLY on the exact paths recorded in $WORK/journal.tsv by apply.sh, and only when each
# path is one of the fixed L6b-owned paths below. No recursive removal. Idempotent. Never touches legacy mosquitto,
# the owner JIT input, or anything outside the journal.
# Service lifecycle order (only when the journal says this stage created the unit; only ever aegis-idea3-mosquitto.service):
#   stop (if active) -> disable (if enabled) -> remove unit file -> daemon-reload -> reset-failed <that unit only> -> prove state.
# reset-failed is last on purpose: a unit that failed keeps LoadState=not-found/ActiveState=failed metadata in the manager
# after its file is removed and reloaded (observed live 2026-09-27), and only reset-failed on that exact name clears it. Running it
# earlier could be undone by a later stop/reload or an auto-restart (Restart=on-failure). The end state is then PROVEN with
# `systemctl show` (not-found/inactive/dead/success), so the pre-attempt runtime boundary is restored, not assumed.
set -uo pipefail

fail() { printf 'L6B_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
MQTT_DIR=/etc/aegis-idea3/mqtt
LEGACY_DIR=/etc/mosquitto
LEGACY_PASSWD=/etc/mosquitto/passwd
UNIT_DEST=/etc/systemd/system/aegis-idea3-mosquitto.service
OWNED_FILES=(
  /etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf
  /etc/aegis-idea3/mqtt/acl
  /etc/aegis-idea3/mqtt/passwd
  /etc/aegis-idea3/mqtt/ca.crt
  /etc/aegis-idea3/mqtt/broker.crt
  /etc/aegis-idea3/mqtt/broker.key
)
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seam, honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real systemctl.
FIXTURE_SYSTEMCTL="${AEGIS_L6B_FIXTURE_SYSTEMCTL:-}"
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() {
  if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi
}
WORK="${AEGIS_L6B_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}

snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"
  else
    : > "$out"
  fi
}

is_owned_file() {
  local p=$1 f
  for f in "${OWNED_FILES[@]}"; do [ "$p" = "$f" ] && return 0; done
  return 1
}

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ -f "$WORK/legacy-tree.sha256" ] && [ -f "$WORK/legacy-users.txt" ] || fail LEGACY_BASELINE_MISSING
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L6B_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  [ -f "$WORK/legacy-service.txt" ] && [ -f "$WORK/legacy-1883-listeners.txt" ] || fail LEGACY_BASELINE_MISSING
elif use_systemd; then
  [ -f "$WORK/legacy-service.txt" ] || fail LEGACY_BASELINE_MISSING
fi

# ── journal validation: only the fixed L6b-owned paths are ever acted on ──────────────────────────────────────────────
j_dir=0 j_unit=0 j_service=0
j_files=()
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DIR) [ "$value" = "$MQTT_DIR" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_dir=1 ;;
    UNIT) [ "$value" = "$UNIT_DEST" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_unit=1 ;;
    SERVICE) [ "$value" = "$UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_service=1 ;;
    FILE) is_owned_file "$value" || fail JOURNAL_ENTRY_NOT_OWNED; j_files+=("$value") ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

mqtt_dir=$(host_path "$MQTT_DIR")
unit_dest=$(host_path "$UNIT_DEST")
legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")

# ── 1. service: stop/disable only the separate IDEA3 unit, and only if this stage started it ─────────────────────────
if use_systemd && [ "$j_service" = 1 ]; then
  if sysctl_do is-active --quiet "$UNIT"; then
    sysctl_do stop "$UNIT" || fail IDEA3_SERVICE_STOP_FAILED
  fi
  if sysctl_do is-enabled --quiet "$UNIT" 2>/dev/null; then
    sysctl_do disable "$UNIT" || fail IDEA3_SERVICE_DISABLE_FAILED
  fi
fi

# ── 2. unit file ────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$j_unit" = 1 ] && { [ -e "$unit_dest" ] || [ -L "$unit_dest" ]; }; then
  [ -f "$unit_dest" ] && [ ! -L "$unit_dest" ] || fail UNIT_PATH_NOT_REGULAR
  rm -f -- "$unit_dest" || fail IDEA3_UNIT_REMOVE_FAILED
fi
if use_systemd && { [ "$j_unit" = 1 ] || [ "$j_service" = 1 ]; }; then
  sysctl_do daemon-reload || fail DAEMON_RELOAD_FAILED
fi
# Clear failed runtime metadata for exactly the stage-owned unit, after removal + reload. Never bare/--all, never another unit.
# A non-zero exit is tolerated only because the unit may already be unknown to systemd (second run); the proof below decides.
if use_systemd && [ "$j_service" = 1 ]; then
  sysctl_do reset-failed "$UNIT" >/dev/null 2>&1 || true
fi

# ── 3. stage-created broker material: exact journaled paths, never recursive ─────────────────────────────────────────
for logical in "${j_files[@]}"; do
  real=$(host_path "$logical")
  if [ -e "$real" ] || [ -L "$real" ]; then
    [ -f "$real" ] && [ ! -L "$real" ] || fail "MATERIAL_PATH_NOT_REGULAR:${logical}"
    rm -f -- "$real" || fail "MATERIAL_REMOVE_FAILED:${logical}"
  fi
done

# ── 4. stage-created directory: only if journaled and empty ──────────────────────────────────────────────────────────
if [ "$j_dir" = 1 ] && { [ -e "$mqtt_dir" ] || [ -L "$mqtt_dir" ]; }; then
  [ -d "$mqtt_dir" ] && [ ! -L "$mqtt_dir" ] || fail MQTT_DIR_NOT_A_DIRECTORY
  [ -z "$(ls -A "$mqtt_dir")" ] || fail MQTT_DIR_HAS_UNOWNED_ENTRIES
  rmdir -- "$mqtt_dir" || fail MQTT_DIR_REMOVE_FAILED
fi

# ── 5. proofs: no L6b residue, legacy boundary intact ────────────────────────────────────────────────────────────────
if [ "$j_dir" = 1 ] || [ "${#j_files[@]}" -gt 0 ]; then
  [ ! -e "$mqtt_dir" ] || fail MQTT_DIR_RESIDUE
fi
[ "$j_unit" = 0 ] || [ ! -e "$unit_dest" ] || fail IDEA3_UNIT_RESIDUE

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.rollback"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.rollback" || fail LEGACY_CONFIG_TREE_CHANGED
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.rollback"
cmp -s "$WORK/legacy-users.txt" "$WORK/legacy-users.rollback" || fail LEGACY_USER_SET_CHANGED
grep -qx 'aegis' "$WORK/legacy-users.rollback" || fail LEGACY_AEGIS_USER_MISSING

if use_systemd; then
  if [ "$j_service" = 1 ]; then
    idea3_state=$(sysctl_do show -p LoadState -p ActiveState -p SubState -p Result "$UNIT" 2>/dev/null | LC_ALL=C sort | paste -sd,)
    [ "$idea3_state" = "ActiveState=inactive,LoadState=not-found,Result=success,SubState=dead" ] \
      || fail IDEA3_SERVICE_RUNTIME_STATE_RESIDUE
  fi
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.rollback" || fail LEGACY_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.rollback" || fail LEGACY_SERVICE_CHANGED
fi
if [ -z "$ROOT" ]; then
  ss -H -ltn | awk '$4 ~ /:1883$/ { print $4 }' | LC_ALL=C sort -u > "$WORK/legacy-1883-listeners.rollback"
  cmp -s "$WORK/legacy-1883-listeners.txt" "$WORK/legacy-1883-listeners.rollback" || fail LEGACY_1883_CHANGED
  ! ss -H -ltn | awk '$4 ~ /:8883$/ { found=1 } END { exit !found }' || fail IDEA3_8883_RESIDUE
fi

printf 'L6B_ROLLBACK=PASS\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
printf 'IDEA3_8883_RESIDUE=NO\n'
printf 'IDEA3_MATERIAL_RESIDUE=NO\n'
if use_systemd && [ "$j_service" = 1 ]; then printf 'IDEA3_SERVICE_RUNTIME_STATE=not-found/inactive/dead/success\n'; fi
