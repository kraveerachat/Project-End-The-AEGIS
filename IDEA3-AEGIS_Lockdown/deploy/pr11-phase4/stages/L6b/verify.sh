#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b separate-broker verification handler.
# Read-only. Proves the legacy broker stayed unchanged and IDEA3 is 8883-only.
set -uo pipefail

fail() { printf 'L6B_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
CONFIG=/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf
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
[ -n "${AEGIS_AP_ADDRESS:-}" ] || fail AEGIS_AP_ADDRESS_REQUIRED
[ -n "${AEGIS_UPLINK_ADDRESS:-}" ] || fail AEGIS_UPLINK_ADDRESS_REQUIRED
[ -n "${AEGIS_AP_INTERFACE:-}" ] || fail AEGIS_AP_INTERFACE_REQUIRED

cfg=$(host_path "$CONFIG")
legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")
unit_dest=$(host_path "$UNIT_DEST")
[ -f "$cfg" ] || fail IDEA3_CONFIG_MISSING
[ -f "$unit_dest" ] || fail IDEA3_UNIT_MISSING

mapfile -t listeners < <(awk '$1 == "listener" { print $0 }' "$cfg")
[ "${#listeners[@]}" = 2 ] || fail CONFIG_LISTENER_COUNT_INVALID
[ "${listeners[0]}" = "listener 8883 127.0.0.1" ] || fail CONFIG_LOOPBACK_INVALID
[ "${listeners[1]}" = "listener 8883 $AEGIS_AP_ADDRESS" ] || fail CONFIG_AP_BIND_INVALID
! grep -Fq "$AEGIS_UPLINK_ADDRESS" "$cfg" || fail CONFIG_UPLINK_BIND_FORBIDDEN
! grep -Eq '^[[:space:]]*listener[[:space:]]+1883([[:space:]]|$)' "$cfg" || fail CONFIG_1883_FORBIDDEN

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.current"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.current" || fail LEGACY_CONFIG_TREE_CHANGED
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.current"
cmp -s "$WORK/legacy-users.txt" "$WORK/legacy-users.current" || fail LEGACY_USER_SET_CHANGED
grep -qx 'aegis' "$WORK/legacy-users.current" || fail LEGACY_AEGIS_USER_MISSING

if [ -z "$ROOT" ]; then
  systemctl is-active --quiet "$UNIT" || fail IDEA3_SERVICE_NOT_ACTIVE
  systemctl is-enabled --quiet "$UNIT" || fail IDEA3_SERVICE_NOT_ENABLED

  systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.current" || fail LEGACY_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.current" || fail LEGACY_SERVICE_CHANGED

  ss -H -ltn | awk '$4 ~ /:1883$/ { print $4 }' | LC_ALL=C sort -u > "$WORK/legacy-1883-listeners.current"
  cmp -s "$WORK/legacy-1883-listeners.txt" "$WORK/legacy-1883-listeners.current" || fail LEGACY_1883_CHANGED

  mapfile -t live8883 < <(ss -H -ltn | awk '$4 ~ /:8883$/ { print $4 }' | LC_ALL=C sort -u)
  [ "${#live8883[@]}" = 2 ] || fail LIVE_8883_LISTENER_COUNT_INVALID
  printf '%s\n' "${live8883[@]}" | grep -qx '127.0.0.1:8883' || fail LIVE_LOOPBACK_8883_MISSING
  printf '%s\n' "${live8883[@]}" | grep -qx "$AEGIS_AP_ADDRESS:8883" || fail LIVE_AP_8883_MISSING
  ! printf '%s\n' "${live8883[@]}" | grep -Eq '^(0\.0\.0\.0|\[::\]|::|\*):8883$' || fail LIVE_WILDCARD_8883
  ! printf '%s\n' "${live8883[@]}" | grep -qx "$AEGIS_UPLINK_ADDRESS:8883" || fail LIVE_UPLINK_8883

  nft list table inet aegis_idea3 > "$WORK/aegis-idea3-nft.current" 2>/dev/null || fail IDEA3_FIREWALL_TABLE_MISSING
  grep -Eq "iifname[[:space:]]+\"?$AEGIS_AP_INTERFACE\"?.*tcp dport 1883.*drop" \
    "$WORK/aegis-idea3-nft.current" || fail PF01_EXPLICIT_1883_DROP_MISSING
fi

printf 'L6B_VERIFY=PASS\n'
printf 'LEGACY_1883=UNCHANGED\n'
printf 'LEGACY_USER_AEGIS=PRESENT\n'
if [ -z "$ROOT" ]; then
  printf 'IDEA3_8883_SCOPE=LOOPBACK_PLUS_AP_ONLY\n'
  printf 'PF01_EXPLICIT_1883_DROP=PASS\n'
else
  printf 'IDEA3_8883_SCOPE=NOT_RUN_FIXTURE\n'
  printf 'PF01_EXPLICIT_1883_DROP=NOT_RUN_FIXTURE\n'
fi
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
