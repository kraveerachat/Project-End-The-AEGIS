#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b separate-broker apply handler.
# MUTATING in live mode. It never edits/restarts/stops legacy mosquitto.service.
set -uo pipefail

fail() { printf 'L6B_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
CONFIG=/etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf
ACL=/etc/aegis-idea3/mqtt/acl
PASSWD=/etc/aegis-idea3/mqtt/passwd
CA=/etc/aegis-idea3/mqtt/ca.crt
CERT=/etc/aegis-idea3/mqtt/broker.crt
KEY=/etc/aegis-idea3/mqtt/broker.key
LEGACY_DIR=/etc/mosquitto
LEGACY_PASSWD=/etc/mosquitto/passwd
UNIT_DEST=/etc/systemd/system/aegis-idea3-mosquitto.service

HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT_SOURCE="$(cd "$HERE/../../.." && pwd)/mosquitto/aegis-idea3-mosquitto.service.example"
ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L6B_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}

valid_ipv4() {
  /usr/bin/python3 - "$1" <<'PY'
import ipaddress, sys
try:
    a = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if a.version == 4 and not (a.is_unspecified or a.is_multicast or a.is_loopback) else 1)
PY
}

snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"
  else
    : > "$out"
  fi
}

[ -n "$WORK" ] || fail AEGIS_L6B_WORK_DIR_REQUIRED
[ -n "${AEGIS_AP_ADDRESS:-}" ] || fail AEGIS_AP_ADDRESS_REQUIRED
[ -n "${AEGIS_UPLINK_ADDRESS:-}" ] || fail AEGIS_UPLINK_ADDRESS_REQUIRED
valid_ipv4 "$AEGIS_AP_ADDRESS" || fail AEGIS_AP_ADDRESS_INVALID
valid_ipv4 "$AEGIS_UPLINK_ADDRESS" || fail AEGIS_UPLINK_ADDRESS_INVALID
[ "$AEGIS_AP_ADDRESS" != "$AEGIS_UPLINK_ADDRESS" ] || fail AP_EQUALS_UPLINK

if [ -z "$ROOT" ]; then
  [ "${AEGIS_L6B_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi

[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS
umask 077
mkdir -p "$WORK"
chmod 700 "$WORK"

cfg=$(host_path "$CONFIG")
acl=$(host_path "$ACL")
passwd=$(host_path "$PASSWD")
ca=$(host_path "$CA")
cert=$(host_path "$CERT")
key=$(host_path "$KEY")
legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")
unit_dest=$(host_path "$UNIT_DEST")

for f in "$cfg" "$acl" "$passwd" "$ca" "$cert" "$key" "$legacy_passwd" "$UNIT_SOURCE"; do
  [ -f "$f" ] && [ ! -L "$f" ] || fail "REQUIRED_FILE_INVALID:${f}"
done
[ -d "$legacy_dir" ] && [ ! -L "$legacy_dir" ] || fail LEGACY_CONFIG_TREE_INVALID
[ ! -e "$unit_dest" ] && [ ! -L "$unit_dest" ] || fail IDEA3_UNIT_ALREADY_EXISTS

mapfile -t listeners < <(awk '$1 == "listener" { print $0 }' "$cfg")
[ "${#listeners[@]}" = 2 ] || fail LISTENER_COUNT_INVALID
[ "${listeners[0]}" = "listener 8883 127.0.0.1" ] || fail LOOPBACK_LISTENER_INVALID
[ "${listeners[1]}" = "listener 8883 $AEGIS_AP_ADDRESS" ] || fail AP_LISTENER_INVALID
! grep -Eq '^[[:space:]]*listener[[:space:]]+1883([[:space:]]|$)' "$cfg" || fail PLAINTEXT_1883_FORBIDDEN
! grep -Eq '^[[:space:]]*listener[[:space:]]+8883[[:space:]]+(0\.0\.0\.0|::|\[::\]|\*)$' "$cfg" || fail WILDCARD_8883_FORBIDDEN
! grep -Fq "$AEGIS_UPLINK_ADDRESS" "$cfg" || fail UPLINK_BIND_FORBIDDEN
grep -qx 'allow_anonymous false' "$cfg" || fail ANONYMOUS_POLICY_INVALID
grep -qx 'persistence false' "$cfg" || fail PERSISTENCE_POLICY_INVALID
grep -qx 'retain_available false' "$cfg" || fail RETAIN_POLICY_INVALID
grep -qx "password_file $PASSWD" "$cfg" || fail IDEA3_PASSWORD_PATH_INVALID
grep -qx "acl_file $ACL" "$cfg" || fail IDEA3_ACL_PATH_INVALID
grep -qx "cafile $CA" "$cfg" || fail IDEA3_CA_PATH_INVALID
grep -qx "certfile $CERT" "$cfg" || fail IDEA3_CERT_PATH_INVALID
grep -qx "keyfile $KEY" "$cfg" || fail IDEA3_KEY_PATH_INVALID
! grep -Eq '^user[[:space:]]+aegis$' "$acl" || fail LEGACY_USER_IN_IDEA3_ACL
! awk -F: '$1 == "aegis" { found=1 } END { exit !found }' "$passwd" || fail LEGACY_USER_IN_IDEA3_PASSWORD_DB
awk -F: '$1 == "idea3-core" { found=1 } END { exit !found }' "$passwd" || fail IDEA3_CORE_IDENTITY_MISSING
awk -F: '$1 ~ /^idea3-dev-/ { found=1 } END { exit !found }' "$passwd" || fail IDEA3_DEVICE_IDENTITY_MISSING
awk -F: '$1 == "aegis" { found=1 } END { exit !found }' "$legacy_passwd" || fail LEGACY_AEGIS_USER_MISSING

for secret in "$passwd" "$key"; do
  mode=$(stat -c '%a' "$secret") || fail SECRET_MODE_UNREADABLE
  perm=$((8#$mode))
  (( (perm & 077) == 0 )) || fail "SECRET_MODE_TOO_OPEN:${secret}"
done

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.sha256"
cp -a "$legacy_dir" "$WORK/legacy-mosquitto-backup"
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.txt"

if [ -z "$ROOT" ]; then
  systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.txt" || fail LEGACY_SERVICE_SNAPSHOT_FAILED
  ss -H -ltn | awk '$4 ~ /:1883$/ { print $4 }' | LC_ALL=C sort -u > "$WORK/legacy-1883-listeners.txt"

  install -D -m 0644 "$UNIT_SOURCE" "$unit_dest" || fail UNIT_INSTALL_FAILED
  systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
  systemctl enable --now "$UNIT" || fail IDEA3_SERVICE_START_FAILED
else
  mkdir -p "$(dirname "$unit_dest")"
  cp "$UNIT_SOURCE" "$unit_dest"
  chmod 0644 "$unit_dest"
  printf 'FIXTURE_ONLY\n' > "$WORK/mode"
fi

printf 'L6B_APPLY=PASS\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
printf 'PRODUCTION_MUTATION_PERFORMED=%s\n' "$([ -z "$ROOT" ] && echo YES || echo FIXTURE_ONLY)"
