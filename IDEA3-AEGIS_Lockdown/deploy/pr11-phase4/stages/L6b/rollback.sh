#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b rollback handler.
# MUTATING in live mode. Removes only the separate IDEA3 unit installed by L6b.
set -uo pipefail

fail() { printf 'L6B_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
LEGACY_DIR=/etc/mosquitto
LEGACY_PASSWD=/etc/mosquitto/passwd
UNIT_DEST=/etc/systemd/system/aegis-idea3-mosquitto.service
ROOT="${AEGIS_P4_FS_ROOT:-}"
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

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_MISSING
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L6B_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi

legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")
unit_dest=$(host_path "$UNIT_DEST")

if [ -z "$ROOT" ]; then
  if systemctl is-active --quiet "$UNIT"; then
    systemctl stop "$UNIT" || fail IDEA3_SERVICE_STOP_FAILED
  fi
  if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
    systemctl disable "$UNIT" || fail IDEA3_SERVICE_DISABLE_FAILED
  fi
  if [ -e "$unit_dest" ]; then
    rm -f -- "$unit_dest" || fail IDEA3_UNIT_REMOVE_FAILED
  fi
  systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
else
  [ ! -e "$unit_dest" ] || rm -f -- "$unit_dest" || fail FIXTURE_UNIT_REMOVE_FAILED
fi

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.rollback"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.rollback" || fail LEGACY_CONFIG_TREE_CHANGED
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.rollback"
cmp -s "$WORK/legacy-users.txt" "$WORK/legacy-users.rollback" || fail LEGACY_USER_SET_CHANGED
grep -qx 'aegis' "$WORK/legacy-users.rollback" || fail LEGACY_AEGIS_USER_MISSING

if [ -z "$ROOT" ]; then
  systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.rollback" || fail LEGACY_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.rollback" || fail LEGACY_SERVICE_CHANGED

  ss -H -ltn | awk '$4 ~ /:1883$/ { print $4 }' | LC_ALL=C sort -u > "$WORK/legacy-1883-listeners.rollback"
  cmp -s "$WORK/legacy-1883-listeners.txt" "$WORK/legacy-1883-listeners.rollback" || fail LEGACY_1883_CHANGED
  ! ss -H -ltn | awk '$4 ~ /:8883$/ { found=1 } END { exit !found }' || fail IDEA3_8883_RESIDUE
fi

printf 'L6B_ROLLBACK=PASS\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
printf 'IDEA3_8883_RESIDUE=NO\n'
