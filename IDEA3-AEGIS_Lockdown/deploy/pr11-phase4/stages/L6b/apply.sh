#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b stage-owned separate-broker apply handler (OD-L6B-01..09).
# MUTATING in live mode. The stage owns creation of /etc/aegis-idea3/mqtt, the six broker files and the systemd unit.
# Plaintext core.pass/device.pass are read transiently (by p4-broker-material.py) and are NEVER installed; only the
# hashed Mosquitto password database is. It never edits/restarts/stops legacy mosquitto.service.
# Every Production path is written to $WORK/journal.tsv BEFORE it is created so rollback.sh acts on exactly that set.
# Ownership model (live finding 2026-09-27): everything stays root-owned, but the files the broker must open AFTER it drops
# privileges to the mosquitto user are group-readable by the mosquitto group only (root:mosquitto, never group/other-writable).
set -uo pipefail

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
DEVICE_ID=aegis-relay-01   # pinned Production device identity (p4-nvs-provision.py, README, T2/T3/T7/T8 design)
MQTT_DIR=/etc/aegis-idea3/mqtt
CONFIG=$MQTT_DIR/aegis-idea3-mosquitto.conf
ACL=$MQTT_DIR/acl
PASSWD=$MQTT_DIR/passwd
CA=$MQTT_DIR/ca.crt
CERT=$MQTT_DIR/broker.crt
KEY=$MQTT_DIR/broker.key
IDEA3_ETC=/etc/aegis-idea3
LEGACY_DIR=/etc/mosquitto
LEGACY_PASSWD=/etc/mosquitto/passwd
UNIT_DEST=/etc/systemd/system/aegis-idea3-mosquitto.service

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
UNIT_SOURCE="$(cd "$HERE/../../.." && pwd)/mosquitto/aegis-idea3-mosquitto.service.example"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
BROKER_GROUP=mosquitto
# Fixture-only seams, honoured ONLY when AEGIS_P4_FS_ROOT is set (live mode always uses the real systemctl/root:mosquitto).
FIXTURE_SYSTEMCTL="${AEGIS_L6B_FIXTURE_SYSTEMCTL:-}"
FIXTURE_GROUP="${AEGIS_L6B_FIXTURE_BROKER_GROUP:-}"
WORK="${AEGIS_L6B_WORK_DIR:-}"
INPUT="${AEGIS_L6B_INPUT_DIR:-}"
JOURNAL=""
STAGE_DIR=""

fail() {
  printf 'L6B_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  # The hashed passwd staging copy never outlives the handler.
  [ -z "$STAGE_DIR" ] || rm -f -- "$STAGE_DIR/passwd" 2>/dev/null
}
trap cleanup EXIT

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}

# broker_identity_check: read-only. The group and the user must exist and the user's PRIMARY gid must equal the group's gid.
# Supplementary group membership is deliberately NOT judged, and no account/group is ever created or modified here.
broker_identity_check() {
  local group_gid user_gid
  group_gid=$(getent group "$BROKER_GROUP" | cut -d: -f3)
  [ -n "$group_gid" ] || fail BROKER_GROUP_MISSING
  getent passwd "$BROKER_GROUP" >/dev/null || fail BROKER_USER_MISSING
  user_gid=$(id -g "$BROKER_GROUP" 2>/dev/null)
  [ -n "$user_gid" ] && [ "$user_gid" = "$group_gid" ] || fail BROKER_USER_PRIMARY_GID_MISMATCH
}

# use_systemd: live, or a fixture that supplies a fake systemctl. sysctl_do runs exactly that systemctl.
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() {
  if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi
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

journal() { printf '%s\t%s\n' "$1" "$2" >> "$JOURNAL" || fail JOURNAL_WRITE_FAILED; }

# plan LOGICAL MODE GROUP: record the intended ownership (non-secret) so verify/tests can prove the model.
plan() { printf '%s\t%s\troot:%s\n' "$1" "$2" "$3" >> "$WORK/ownership-plan.tsv" || fail OWNERSHIP_PLAN_WRITE_FAILED; }

# install_owned MODE SRC LOGICAL_DEST GROUP: journal, then install root-owned with an explicit group.
# GROUP is root (world-readable material) or $BROKER_GROUP (read by the privilege-dropped broker). Never group-writable.
install_owned() {
  local mode=$1 src=$2 logical=$3 group=$4 dest
  dest=$(host_path "$logical")
  journal FILE "$logical"
  plan "$logical" "${mode#0}" "$group"
  if [ -z "$ROOT" ]; then
    install -m "$mode" -o root -g "$group" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  elif [ "$group" = "$BROKER_GROUP" ] && [ -n "$FIXTURE_GROUP" ]; then
    install -m "$mode" -g "$FIXTURE_GROUP" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  else
    install -m "$mode" -- "$src" "$dest" || fail "INSTALL_FAILED:${logical}"
  fi
}

# ── 1. environment ───────────────────────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_L6B_WORK_DIR_REQUIRED
[ -n "$INPUT" ] || fail AEGIS_L6B_INPUT_DIR_REQUIRED
[ -n "${AEGIS_AP_ADDRESS:-}" ] || fail AEGIS_AP_ADDRESS_REQUIRED
[ -n "${AEGIS_UPLINK_ADDRESS:-}" ] || fail AEGIS_UPLINK_ADDRESS_REQUIRED
valid_ipv4 "$AEGIS_AP_ADDRESS" || fail AEGIS_AP_ADDRESS_INVALID
valid_ipv4 "$AEGIS_UPLINK_ADDRESS" || fail AEGIS_UPLINK_ADDRESS_INVALID
[ "$AEGIS_AP_ADDRESS" != "$AEGIS_UPLINK_ADDRESS" ] || fail AP_EQUALS_UPLINK

if [ -z "$ROOT" ]; then
  [ "${AEGIS_L6B_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi

case "$WORK" in
  /etc/*) fail WORK_DIR_INSIDE_ETC ;;
esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS

# ── 2. work dir + journal first, so any later failure is rollback-able ───────────────────────────────────────────────
umask 077
mkdir -p "$WORK" || fail WORK_DIR_CREATE_FAILED
chmod 700 "$WORK"
STAGE_DIR="$WORK/stage"
mkdir -m 700 "$STAGE_DIR" || fail STAGE_DIR_CREATE_FAILED
JOURNAL="$WORK/journal.tsv"
: > "$JOURNAL"
chmod 600 "$JOURNAL"

# ── 3. private owner input contract (never prints contents) ──────────────────────────────────────────────────────────
[ -d "$INPUT" ] && [ ! -L "$INPUT" ] || fail INPUT_DIR_INVALID
[ "$(stat -c '%a' "$INPUT")" = 700 ] || fail INPUT_DIR_MODE_NOT_0700
expect_uid="${SUDO_UID:-$(id -u)}"
[ "$(stat -c '%u' "$INPUT")" = "$expect_uid" ] || fail INPUT_DIR_OWNER_MISMATCH
[ ! -e "$INPUT/ca.key" ] && [ ! -L "$INPUT/ca.key" ] || fail CA_PRIVATE_KEY_FORBIDDEN
[ "$(ls -A "$INPUT" | LC_ALL=C sort | paste -sd,)" = "broker.crt,broker.key,ca.crt,core.pass,device.pass" ] \
  || fail INPUT_DIR_ENTRIES_NOT_EXACT
for f in broker.crt broker.key ca.crt core.pass device.pass; do
  [ -f "$INPUT/$f" ] && [ ! -L "$INPUT/$f" ] || fail "INPUT_FILE_NOT_REGULAR:${f}"
done
for f in broker.key core.pass device.pass; do
  case "$(stat -c '%a' "$INPUT/$f")" in 600 | 400) ;; *) fail "INPUT_SECRET_MODE_INVALID:${f}" ;; esac
done
for f in ca.crt broker.crt; do
  [ -z "$(find "$INPUT/$f" -perm /022)" ] || fail "INPUT_CERT_WRITABLE:${f}"
done
grep -q 'PRIVATE KEY' "$INPUT/ca.crt" 2>/dev/null && fail CA_FILE_CONTAINS_PRIVATE_KEY

# ── 4. host paths, pre-state, legacy baseline (all before the first mutation) ────────────────────────────────────────
mqtt_dir=$(host_path "$MQTT_DIR")
cfg=$(host_path "$CONFIG")
acl=$(host_path "$ACL")
passwd=$(host_path "$PASSWD")
ca=$(host_path "$CA")
cert=$(host_path "$CERT")
key=$(host_path "$KEY")
idea3_etc=$(host_path "$IDEA3_ETC")
legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")
unit_dest=$(host_path "$UNIT_DEST")

[ -d "$idea3_etc" ] && [ ! -L "$idea3_etc" ] || fail IDEA3_ETC_MISSING_OR_SYMLINK
for p in "$mqtt_dir" "$cfg" "$acl" "$passwd" "$ca" "$cert" "$key" "$unit_dest"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "PRESTATE_UNEXPECTED:${p}"
done
[ -f "$UNIT_SOURCE" ] && [ ! -L "$UNIT_SOURCE" ] || fail UNIT_SOURCE_INVALID
[ -f "$legacy_passwd" ] && [ ! -L "$legacy_passwd" ] || fail LEGACY_PASSWD_INVALID
[ -d "$legacy_dir" ] && [ ! -L "$legacy_dir" ] || fail LEGACY_CONFIG_TREE_INVALID
awk -F: '$1 == "aegis" { found=1 } END { exit !found }' "$legacy_passwd" || fail LEGACY_AEGIS_USER_MISSING

if [ -z "$ROOT" ]; then
  broker_identity_check
fi
if use_systemd; then
  [ "$(sysctl_do show -p LoadState --value "$UNIT" 2>/dev/null)" = not-found ] || fail IDEA3_UNIT_ALREADY_LOADED
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.txt" || fail LEGACY_SERVICE_SNAPSHOT_FAILED
fi
if [ -z "$ROOT" ]; then
  [ -z "$(ss -H -ltn | awk '$4 ~ /:8883$/ { print $4 }')" ] || fail PRESTATE_8883_LISTENER_EXISTS
  ss -H -ltn | awk '$4 ~ /:1883$/ { print $4 }' | LC_ALL=C sort -u > "$WORK/legacy-1883-listeners.txt"
fi
snapshot_tree "$legacy_dir" "$WORK/legacy-tree.sha256"
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.txt"

# ── 5. offline PKI validation, including the key relationship ────────────────────────────────────────────────────────
"$PY" "$P4_HERE/p4-mqtt-pki.py" validate-broker-cert \
  --ca-file "$INPUT/ca.crt" --cert-file "$INPUT/broker.crt" --key-file "$INPUT/broker.key" >/dev/null 2>&1 \
  || fail PKI_VALIDATION_FAILED

# ── 6. render material into the private stage dir (plaintext passwords used transiently, hashed DB only) ────────────
"$PY" "$P4_HERE/p4-broker-material.py" render-acl --device-id "$DEVICE_ID" --output "$STAGE_DIR/acl" >/dev/null \
  || fail ACL_RENDER_FAILED
"$PY" "$P4_HERE/p4-broker-material.py" build-password-db --device-id "$DEVICE_ID" \
  --core-password-file "$INPUT/core.pass" --device-password-file "$INPUT/device.pass" \
  --output "$STAGE_DIR/passwd" >/dev/null 2>&1 || fail PASSWORD_DB_BUILD_FAILED
mkdir -m 700 "$WORK/render" || fail RENDER_DIR_CREATE_FAILED
"$PY" "$P4_HERE/p4-broker-migration.py" render \
  --ap-address "$AEGIS_AP_ADDRESS" --uplink-address "$AEGIS_UPLINK_ADDRESS" \
  --ca-file "$CA" --cert-file "$CERT" --key-file "$KEY" --password-file "$PASSWD" --acl-file "$ACL" \
  --output-dir "$WORK/render" >/dev/null || fail CONFIG_RENDER_FAILED
rendered="$WORK/render/aegis-idea3-mosquitto.conf"
[ -f "$rendered" ] || fail RENDERED_CONFIG_MISSING

# ── 7. validate the rendered material ────────────────────────────────────────────────────────────────────────────────
mapfile -t listeners < <(awk '$1 == "listener" { print $0 }' "$rendered")
[ "${#listeners[@]}" = 2 ] || fail LISTENER_COUNT_INVALID
[ "${listeners[0]}" = "listener 8883 127.0.0.1" ] || fail LOOPBACK_LISTENER_INVALID
[ "${listeners[1]}" = "listener 8883 $AEGIS_AP_ADDRESS" ] || fail AP_LISTENER_INVALID
! grep -Eq '^[[:space:]]*listener[[:space:]]+1883([[:space:]]|$)' "$rendered" || fail PLAINTEXT_1883_FORBIDDEN
! grep -Eq '^[[:space:]]*listener[[:space:]]+8883[[:space:]]+(0\.0\.0\.0|::|\[::\]|\*)$' "$rendered" || fail WILDCARD_8883_FORBIDDEN
! grep -Fq "$AEGIS_UPLINK_ADDRESS" "$rendered" || fail UPLINK_BIND_FORBIDDEN
grep -qx 'allow_anonymous false' "$rendered" || fail ANONYMOUS_POLICY_INVALID
grep -qx 'persistence false' "$rendered" || fail PERSISTENCE_POLICY_INVALID
grep -qx 'retain_available false' "$rendered" || fail RETAIN_POLICY_INVALID
grep -qx "password_file $PASSWD" "$rendered" || fail IDEA3_PASSWORD_PATH_INVALID
grep -qx "acl_file $ACL" "$rendered" || fail IDEA3_ACL_PATH_INVALID
grep -qx "cafile $CA" "$rendered" || fail IDEA3_CA_PATH_INVALID
grep -qx "certfile $CERT" "$rendered" || fail IDEA3_CERT_PATH_INVALID
grep -qx "keyfile $KEY" "$rendered" || fail IDEA3_KEY_PATH_INVALID
! grep -Eq '^[[:space:]]*(include_dir|include)[[:space:]]' "$rendered" || fail CONFIG_INCLUDE_FORBIDDEN
! grep -Fq '/etc/mosquitto' "$rendered" || fail LEGACY_TREE_REFERENCED
! grep -Eq '^user[[:space:]]+aegis$' "$STAGE_DIR/acl" || fail LEGACY_USER_IN_IDEA3_ACL
! grep -Fq '<AEGIS_' "$rendered" || fail UNRESOLVED_PLACEHOLDER

pw_users=$(awk -F: 'NF >= 2 { print $1 }' "$STAGE_DIR/passwd" | LC_ALL=C sort | paste -sd,)
[ "$pw_users" = "idea3-core,idea3-dev-$DEVICE_ID" ] || fail IDEA3_PASSWORD_IDENTITIES_INVALID
[ -z "$(awk -F: 'NF >= 2 && $2 !~ /^\$[0-9]+\$/' "$STAGE_DIR/passwd")" ] || fail PASSWORD_DB_NOT_HASHED
for f in core.pass device.pass; do
  ! grep -qFf "$INPUT/$f" "$STAGE_DIR/passwd" || fail PASSWORD_DB_CONTAINS_PLAINTEXT
done

# ── 8. first Production mutation: stage-owned installation, journaled before every create ────────────────────────────
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
printf 'YES\n' > "$WORK/production-mutation"

printf 'path\tmode\towner\n' > "$WORK/ownership-plan.tsv" || fail OWNERSHIP_PLAN_WRITE_FAILED
journal DIR "$MQTT_DIR"
plan "$MQTT_DIR" 750 "$BROKER_GROUP"
if [ -z "$ROOT" ]; then
  install -d -m 0750 -o root -g "$BROKER_GROUP" -- "$mqtt_dir" || fail MQTT_DIR_CREATE_FAILED
elif [ -n "$FIXTURE_GROUP" ]; then
  install -d -m 0750 -g "$FIXTURE_GROUP" -- "$mqtt_dir" || fail MQTT_DIR_CREATE_FAILED
else
  install -d -m 0750 -- "$mqtt_dir" || fail MQTT_DIR_CREATE_FAILED
fi
install_owned 0640 "$rendered" "$CONFIG" "$BROKER_GROUP"
install_owned 0640 "$STAGE_DIR/acl" "$ACL" "$BROKER_GROUP"
install_owned 0640 "$STAGE_DIR/passwd" "$PASSWD" "$BROKER_GROUP"
install_owned 0644 "$INPUT/ca.crt" "$CA" root
install_owned 0644 "$INPUT/broker.crt" "$CERT" root
install_owned 0640 "$INPUT/broker.key" "$KEY" "$BROKER_GROUP"
rm -f -- "$STAGE_DIR/passwd"

journal UNIT "$UNIT_DEST"
if [ -z "$ROOT" ]; then
  install -D -m 0644 -o root -g root -- "$UNIT_SOURCE" "$unit_dest" || fail UNIT_INSTALL_FAILED
  plan "$UNIT_DEST" 644 root
  journal SERVICE "$UNIT"
  systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
  systemctl enable --now "$UNIT" || fail IDEA3_SERVICE_START_FAILED
else
  mkdir -p "$(dirname "$unit_dest")"
  install -m 0644 -- "$UNIT_SOURCE" "$unit_dest" || fail UNIT_INSTALL_FAILED
  plan "$UNIT_DEST" 644 root
  printf 'FIXTURE_ONLY\n' > "$WORK/mode"
  if use_systemd; then
    journal SERVICE "$UNIT"
    sysctl_do daemon-reload || fail DAEMON_RELOAD_FAILED
    sysctl_do enable --now "$UNIT" || fail IDEA3_SERVICE_START_FAILED
  fi
fi

# ── 9. non-secret apply manifest (digests only for non-secret material) ─────────────────────────────────────────────
{
  printf 'path\tmode\towner\tsize\tsha256\n'
  for logical in "$CONFIG" "$ACL" "$PASSWD" "$CA" "$CERT" "$KEY" "$UNIT_DEST"; do
    real=$(host_path "$logical")
    case "$logical" in
      "$PASSWD" | "$KEY") digest=SECRET_NOT_RECORDED ;;
      *) digest=$(sha256sum -- "$real" | cut -d' ' -f1) ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\n' "$logical" "$(stat -c '%a' "$real")" "$(stat -c '%U:%G' "$real")" "$(stat -c '%s' "$real")" "$digest"
  done
} > "$WORK/apply-manifest.tsv"

printf 'L6B_APPLY=PASS\n'
printf 'L6B_PLAINTEXT_PASSWORDS_INSTALLED=NO\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
