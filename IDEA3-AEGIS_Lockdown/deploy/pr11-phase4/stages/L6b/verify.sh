#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6b separate-broker verification handler.
# Read-only (client probes only). Proves: stage-owned material is exactly what apply installed, legacy broker unchanged,
# IDEA3 is TLS 8883-only on loopback + AP, PF-01 is present, and the LIVE broker passes TLS/auth/ACL/negative checks.
# Never prints passwords, key material or password hashes.
set -uo pipefail

fail() { printf 'L6B_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
DEVICE_ID=aegis-relay-01
MQTT_DIR=/etc/aegis-idea3/mqtt
CONFIG=$MQTT_DIR/aegis-idea3-mosquitto.conf
LEGACY_DIR=/etc/mosquitto
LEGACY_PASSWD=/etc/mosquitto/passwd
UNIT_DEST=/etc/systemd/system/aegis-idea3-mosquitto.service
BROKER_GROUP=mosquitto
# exact file -> mode. Files the privilege-dropped broker opens are root:mosquitto 0640; certificates are root:root 0644.
declare -A MATERIAL_MODES=(
  [aegis-idea3-mosquitto.conf]=640 [acl]=640 [passwd]=640 [ca.crt]=644 [broker.crt]=644 [broker.key]=640
)
declare -A MATERIAL_GROUPS=(
  [aegis-idea3-mosquitto.conf]=$BROKER_GROUP [acl]=$BROKER_GROUP [passwd]=$BROKER_GROUP [ca.crt]=root [broker.crt]=root [broker.key]=$BROKER_GROUP
)
HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
UNIT_SOURCE="$(cd "$HERE/../../.." && pwd)/mosquitto/aegis-idea3-mosquitto.service.example"
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seam, honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real systemctl.
FIXTURE_SYSTEMCTL="${AEGIS_L6B_FIXTURE_SYSTEMCTL:-}"
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() {
  if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi
}
WORK="${AEGIS_L6B_WORK_DIR:-}"
INPUT="${AEGIS_L6B_INPUT_DIR:-}"

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

mqtt_dir=$(host_path "$MQTT_DIR")
cfg=$(host_path "$CONFIG")
legacy_dir=$(host_path "$LEGACY_DIR")
legacy_passwd=$(host_path "$LEGACY_PASSWD")
unit_dest=$(host_path "$UNIT_DEST")
[ -f "$cfg" ] || fail IDEA3_CONFIG_MISSING
[ -f "$unit_dest" ] && [ ! -L "$unit_dest" ] || fail IDEA3_UNIT_MISSING
[ -f "$WORK/apply-manifest.tsv" ] || fail APPLY_MANIFEST_MISSING

# ── stage-owned material: exact entry set, exact modes/owner, no plaintext/CA key, digests match the apply manifest ─
[ -d "$mqtt_dir" ] && [ ! -L "$mqtt_dir" ] || fail MQTT_DIR_INVALID
[ "$(stat -c '%a' "$mqtt_dir")" = 750 ] || fail MQTT_DIR_MODE_INVALID
expected_entries=$(printf '%s\n' "${!MATERIAL_MODES[@]}" | LC_ALL=C sort | paste -sd,)
[ "$(ls -A "$mqtt_dir" | LC_ALL=C sort | paste -sd,)" = "$expected_entries" ] || fail MQTT_DIR_ENTRIES_NOT_EXACT
for name in "${!MATERIAL_MODES[@]}"; do
  f="$mqtt_dir/$name"
  [ -f "$f" ] && [ ! -L "$f" ] || fail "MATERIAL_NOT_REGULAR:${name}"
  [ "$(stat -c '%a' "$f")" = "${MATERIAL_MODES[$name]}" ] || fail "MATERIAL_MODE_INVALID:${name}"
  [ -n "$ROOT" ] || [ "$(stat -c '%U:%G' "$f")" = "root:${MATERIAL_GROUPS[$name]}" ] || fail "MATERIAL_OWNER_INVALID:${name}"
done
[ -n "$ROOT" ] || [ "$(stat -c '%U:%G' "$mqtt_dir")" = "root:$BROKER_GROUP" ] || fail MQTT_DIR_OWNER_INVALID
[ -n "$ROOT" ] || [ "$(stat -c '%U:%G' "$unit_dest")" = root:root ] || fail IDEA3_UNIT_OWNER_INVALID
[ ! -e "$mqtt_dir/ca.key" ] || fail CA_PRIVATE_KEY_FORBIDDEN
[ ! -e "$mqtt_dir/core.pass" ] && [ ! -e "$mqtt_dir/device.pass" ] || fail PLAINTEXT_PASSWORD_INSTALLED
[ -z "$(awk -F: 'NF >= 2 && $2 !~ /^\$[0-9]+\$/' "$mqtt_dir/passwd")" ] || fail PASSWORD_DB_NOT_HASHED
while IFS=$'\t' read -r path _mode _owner _size digest; do
  [ "$path" != path ] || continue
  case "$digest" in SECRET_NOT_RECORDED) continue ;; esac
  real=$(host_path "$path")
  [ "$(sha256sum -- "$real" | cut -d' ' -f1)" = "$digest" ] || fail "MATERIAL_DIGEST_CHANGED:${path}"
done < "$WORK/apply-manifest.tsv"
cmp -s "$UNIT_SOURCE" "$unit_dest" || fail IDEA3_UNIT_CONTENT_CHANGED

# ── rendered config scope ────────────────────────────────────────────────────────────────────────────────────────────
mapfile -t listeners < <(awk '$1 == "listener" { print $0 }' "$cfg")
[ "${#listeners[@]}" = 2 ] || fail CONFIG_LISTENER_COUNT_INVALID
[ "${listeners[0]}" = "listener 8883 127.0.0.1" ] || fail CONFIG_LOOPBACK_INVALID
[ "${listeners[1]}" = "listener 8883 $AEGIS_AP_ADDRESS" ] || fail CONFIG_AP_BIND_INVALID
! grep -Fq "$AEGIS_UPLINK_ADDRESS" "$cfg" || fail CONFIG_UPLINK_BIND_FORBIDDEN
! grep -Eq '^[[:space:]]*listener[[:space:]]+1883([[:space:]]|$)' "$cfg" || fail CONFIG_1883_FORBIDDEN
grep -qx 'allow_anonymous false' "$cfg" || fail CONFIG_ANONYMOUS_POLICY_INVALID
grep -qx 'persistence false' "$cfg" || fail CONFIG_PERSISTENCE_POLICY_INVALID
grep -qx 'retain_available false' "$cfg" || fail CONFIG_RETAIN_POLICY_INVALID

# ── legacy boundary ──────────────────────────────────────────────────────────────────────────────────────────────────
snapshot_tree "$legacy_dir" "$WORK/legacy-tree.current"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.current" || fail LEGACY_CONFIG_TREE_CHANGED
awk -F: 'NF >= 2 { print $1 }' "$legacy_passwd" | LC_ALL=C sort -u > "$WORK/legacy-users.current"
cmp -s "$WORK/legacy-users.txt" "$WORK/legacy-users.current" || fail LEGACY_USER_SET_CHANGED
grep -qx 'aegis' "$WORK/legacy-users.current" || fail LEGACY_AEGIS_USER_MISSING

live_probe=NOT_RUN_FIXTURE
if use_systemd; then
  sysctl_do is-active --quiet "$UNIT" || fail IDEA3_SERVICE_NOT_ACTIVE
  sysctl_do is-enabled --quiet "$UNIT" || fail IDEA3_SERVICE_NOT_ENABLED
  [ "$(sysctl_do show -p SubState --value "$UNIT")" = running ] || fail IDEA3_SERVICE_NOT_RUNNING
  [ "$(sysctl_do show -p NRestarts --value "$UNIT")" = 0 ] || fail IDEA3_SERVICE_RESTARTED

  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" > "$WORK/legacy-service.current" || fail LEGACY_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.current" || fail LEGACY_SERVICE_CHANGED
fi
if [ -z "$ROOT" ]; then
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

  probe_port=8883
  probe_addresses=(127.0.0.1 "$AEGIS_AP_ADDRESS")
else
  probe_port="${AEGIS_L6B_PROBE_PORT:-}"   # fixture-only override; live always probes 8883
  # shellcheck disable=SC2206
  probe_addresses=(${AEGIS_L6B_PROBE_ADDRESSES:-})
fi

# ── live TLS / auth / ACL / negative proof against the actual broker (probes only; passwords never printed) ─────────
if [ -z "$ROOT" ] || [ -n "$probe_port" ]; then
  [ -n "$INPUT" ] && [ -d "$INPUT" ] || fail AEGIS_L6B_INPUT_DIR_REQUIRED_FOR_LIVE_PROBE
  addr_args=()
  for a in "${probe_addresses[@]}"; do addr_args+=(--address "$a"); done
  probe_out=$("$PY" "$P4_HERE/p4-broker-validate.py" validate-live \
    --ca-file "$mqtt_dir/ca.crt" --cert-file "$mqtt_dir/broker.crt" \
    --core-password-file "$INPUT/core.pass" --device-password-file "$INPUT/device.pass" \
    --device-id "$DEVICE_ID" --port "$probe_port" "${addr_args[@]}" 2>&1) || {
    printf '%s\n' "$probe_out" | grep '^ERROR:' | head -n 3 >&2   # validator errors never contain secrets
    fail LIVE_TLS_AUTH_ACL_FAILED
  }
  n=${#probe_addresses[@]}
  for marker in TLS_RUNTIME_VERSION=PASS; do
    printf '%s\n' "$probe_out" | grep -qx "$marker" || fail "LIVE_MARKER_MISSING:${marker}"
  done
  for marker in CORE_AUTH=PASS DEVICE_AUTH=PASS ACL_MATRIX=PASS NEGATIVE_SECURITY=PASS \
    WRONG_CORE_PASSWORD_REJECTED=PASS WRONG_DEVICE_PASSWORD_REJECTED=PASS; do
    [ "$(printf '%s\n' "$probe_out" | grep -cx "$marker")" = "$n" ] || fail "LIVE_MARKER_COUNT_INVALID:${marker}"
  done
  printf '%s\n' "$probe_out" | grep -qx "LIVE_VALIDATION=PASS addresses=$n" || fail LIVE_VALIDATION_MARKER_MISSING
  # the probe must not have echoed any secret
  for f in core.pass device.pass; do
    ! printf '%s\n' "$probe_out" | grep -qFf "$INPUT/$f" || fail LIVE_PROBE_OUTPUT_LEAKED_SECRET
  done
  live_probe=PASS
fi

# ── non-secret validation evidence ───────────────────────────────────────────────────────────────────────────────────
umask 077
{
  printf 'schema\t1\n'
  printf 'stage\tL6b\n'
  printf 'result\tPASS\n'
  printf 'listener_loopback\t127.0.0.1:8883\n'
  printf 'listener_ap\t%s:8883\n' "$AEGIS_AP_ADDRESS"
  printf 'live_tls_auth_acl\t%s\n' "$live_probe"
  printf 'material_exact\tPASS\n'
  printf 'plaintext_passwords_installed\tNO\n'
  printf 'legacy_unchanged\tPASS\n'
  printf 'pf01_explicit_1883_drop\t%s\n' "$([ -z "$ROOT" ] && echo PASS || echo NOT_RUN_FIXTURE)"
} > "$WORK/validation-evidence.tsv"

printf 'L6B_VERIFY=PASS\n'
printf 'L6B_LIVE_TLS_AUTH_ACL=%s\n' "$live_probe"
printf 'L6B_MATERIAL_EXACT=PASS\n'
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
