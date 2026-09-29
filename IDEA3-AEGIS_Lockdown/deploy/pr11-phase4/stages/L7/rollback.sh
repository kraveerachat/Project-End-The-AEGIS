#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L7 stage-owned rollback handler (OD-L7-07). MUTATING in live mode.
# Acts ONLY on the exact paths recorded in $WORK/journal.tsv by apply.sh, and only when each is one of the fixed L7-owned paths below.
# Every journal entry and the release pointer are validated BEFORE anything is changed, so a tampered journal changes nothing.
# Service lifecycle order (only when the journal says this stage created the unit; only ever aegis-idea3-core.service):
#   stop (if active) -> disable (if enabled) -> remove unit file -> daemon-reload -> reset-failed <that unit only> -> prove state.
# reset-failed is last: a failed unit keeps LoadState=not-found/ActiveState=failed metadata after its file is removed and reloaded
# (observed live for the L6b broker unit, 2026-09-27) and only reset-failed on that exact name clears it; the end state is PROVEN with
# `systemctl show` (not-found/inactive/dead/success), not assumed.
# Runtime directories that did not exist before the stage (/var/lib, /var/log) are created by systemd at first start and would leave a
# PRE->RB path drift. They are therefore ARCHIVED into $WORK/rollback-archive (evidence, mode 0700) and then removed with a two-pass,
# symlink-refusing removal — the durable audit data is preserved as evidence, not destroyed. Directories that existed before the stage
# are never touched. No recursive shell removal is used. Idempotent. Never touches legacy mosquitto, the L6b broker, the owner input,
# IDEA1/IDEA2, NetworkManager, nftables or any predecessor stage, and never publishes RESTORE_UPLINK/CUT_UPLINK.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=l7-listener-lib.sh
source "$HERE/l7-listener-lib.sh"

fail() { printf 'L7_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

UNIT=aegis-idea3-core.service
BROKER_UNIT=aegis-idea3-mosquitto.service
LEGACY_UNIT=mosquitto.service
CREDS_DIR=/etc/aegis-idea3/credentials
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CURRENT=/opt/aegis-idea3/current
L6B_MQTT_DIR=/etc/aegis-idea3/mqtt
L6B_CA=/etc/aegis-idea3/mqtt/ca.crt
LEGACY_DIR=/etc/mosquitto
OWNED_FILES=(
  /etc/aegis-idea3/credentials/k_c2d
  /etc/aegis-idea3/credentials/k_d2c
  /etc/aegis-idea3/credentials/mqtt-core.pass
  /etc/aegis-idea3/credentials/admin.pin
  /etc/aegis-idea3/credentials/restore.credential
  /etc/aegis-idea3/core.env
  /etc/aegis-idea3/pki/mqtt-ca.crt
)
OWNED_RUNTIME=(/var/lib/aegis-idea3 /var/log/aegis-idea3 /run/aegis-idea3)
PY="${AEGIS_PYTHON_BIN:-python3}"
ROOT="${AEGIS_P4_FS_ROOT:-}"
# Fixture-only seams, honoured ONLY when AEGIS_P4_FS_ROOT is set; live mode always uses the real tools.
FIXTURE_SYSTEMCTL="${AEGIS_L7_FIXTURE_SYSTEMCTL:-}"
FIXTURE_SS="${AEGIS_L7_FIXTURE_SS:-}"
WORK="${AEGIS_L7_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi
}
use_systemd() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SYSTEMCTL" ]; }
sysctl_do() {
  if [ -z "$ROOT" ]; then systemctl "$@"; else "$FIXTURE_SYSTEMCTL" "$@"; fi
}
use_ss() { [ -z "$ROOT" ] || [ -n "$FIXTURE_SS" ]; }
ss_do() {
  if [ -z "$ROOT" ]; then ss "$@"; else "$FIXTURE_SS" "$@"; fi
}
snapshot_tree() {
  local dir=$1 out=$2
  if [ -d "$dir" ]; then
    (cd "$dir" && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$out"
  else
    : > "$out"
  fi
}
in_list() { # VALUE LIST...
  local v=$1 x
  shift
  for x in "$@"; do [ "$v" = "$x" ] && return 0; done
  return 1
}

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
for f in legacy-tree.sha256 l6b-material.txt release-dir.txt; do
  [ -f "$WORK/$f" ] || fail BASELINE_MISSING
done
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L7_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi
use_systemd && { [ -f "$WORK/legacy-service.txt" ] || fail BASELINE_MISSING; }
use_ss && { [ -f "$WORK/listeners-baseline.txt" ] || fail BASELINE_MISSING; }

# ── journal validation: only the fixed L7-owned paths are ever acted on ──────────────────────────────────────────────────
j_dir=0 j_unit=0 j_service=0 j_link=0
j_files=() j_runtime=()
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DIR) [ "$value" = "$CREDS_DIR" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_dir=1 ;;
    UNIT) [ "$value" = "$UNIT_DEST" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_unit=1 ;;
    SERVICE) [ "$value" = "$UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_service=1 ;;
    LINK) [ "$value" = "$CURRENT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_link=1 ;;
    FILE) in_list "$value" "${OWNED_FILES[@]}" || fail JOURNAL_ENTRY_NOT_OWNED; j_files+=("$value") ;;
    RUNTIME) in_list "$value" "${OWNED_RUNTIME[@]}" || fail JOURNAL_ENTRY_NOT_OWNED; j_runtime+=("$value") ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

creds_dir=$(host_path "$CREDS_DIR")
unit_dest=$(host_path "$UNIT_DEST")
current=$(host_path "$CURRENT")
legacy_dir=$(host_path "$LEGACY_DIR")
l6b_dir=$(host_path "$L6B_MQTT_DIR")
l6b_ca=$(host_path "$L6B_CA")

# the release pointer is validated BEFORE any mutation: only the stage's own link is ever removed
if [ "$j_link" = 1 ] && { [ -e "$current" ] || [ -L "$current" ]; }; then
  [ -L "$current" ] && [ "$(readlink "$current")" = "$(head -n 1 "$WORK/release-dir.txt")" ] || fail CURRENT_LINK_CHANGED
fi

# ── 1. service: stop/disable only the Core unit, and only if this stage started it ───────────────────────────────────────
if use_systemd && [ "$j_service" = 1 ]; then
  if sysctl_do is-active --quiet "$UNIT"; then
    sysctl_do stop "$UNIT" || fail CORE_SERVICE_STOP_FAILED
  fi
  if sysctl_do is-enabled --quiet "$UNIT" 2>/dev/null; then
    sysctl_do disable "$UNIT" || fail CORE_SERVICE_DISABLE_FAILED
  fi
fi

# ── 2. unit file, reload, then clear failed runtime metadata for exactly the Core unit ──────────────────────────────────
if [ "$j_unit" = 1 ] && { [ -e "$unit_dest" ] || [ -L "$unit_dest" ]; }; then
  [ -f "$unit_dest" ] && [ ! -L "$unit_dest" ] || fail UNIT_PATH_NOT_REGULAR
  rm -f -- "$unit_dest" || fail CORE_UNIT_REMOVE_FAILED
fi
if use_systemd && { [ "$j_unit" = 1 ] || [ "$j_service" = 1 ]; }; then
  sysctl_do daemon-reload || fail DAEMON_RELOAD_FAILED
fi
# Never bare/--all, never another unit. A non-zero exit is tolerated only because the unit may already be unknown to systemd
# (second run); the state proof below decides.
if use_systemd && [ "$j_service" = 1 ]; then
  sysctl_do reset-failed "$UNIT" >/dev/null 2>&1 || true
fi

# ── 3. runtime directories the stage caused: archive as evidence, then remove (two-pass, symlink-refusing) ───────────────
for logical in "${j_runtime[@]}"; do
  real=$(host_path "$logical")
  { [ -e "$real" ] || [ -L "$real" ]; } || continue
  [ -d "$real" ] && [ ! -L "$real" ] || fail RUNTIME_PATH_INVALID
  if [ "$logical" != /run/aegis-idea3 ]; then
    slug=$(printf '%s' "${logical#/}" | tr '/' '-')
    mkdir -p -m 700 "$WORK/rollback-archive/$slug" || fail RUNTIME_ARCHIVE_FAILED
    chmod 700 "$WORK/rollback-archive"
    cp -a -- "$real/." "$WORK/rollback-archive/$slug/" || fail RUNTIME_ARCHIVE_FAILED
  fi
  "$PY" - "$real" <<'PYC' || fail RUNTIME_REMOVE_FAILED
import os, stat, sys
root = sys.argv[1]
entries = []
def scan(path):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
    if stat.S_ISDIR(info.st_mode):
        for name in sorted(os.listdir(path)):
            scan(os.path.join(path, name))
    elif not (stat.S_ISREG(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
        raise SystemExit(1)
    entries.append((path, stat.S_ISDIR(info.st_mode)))
scan(root)  # pass 1: nothing is removed unless EVERY entry is a plain file, socket or directory
for path, is_dir in entries:  # children are listed before their parent
    os.rmdir(path) if is_dir else os.unlink(path)
PYC
done

# ── 4. stage-created files: exact journaled paths, never recursive ───────────────────────────────────────────────────────
for logical in "${j_files[@]}"; do
  real=$(host_path "$logical")
  if [ -e "$real" ] || [ -L "$real" ]; then
    [ -f "$real" ] && [ ! -L "$real" ] || fail "MATERIAL_PATH_NOT_REGULAR:${logical##*/}"
    rm -f -- "$real" || fail "MATERIAL_REMOVE_FAILED:${logical##*/}"
  fi
done
if [ "$j_link" = 1 ] && [ -L "$current" ]; then
  rm -f -- "$current" || fail CURRENT_LINK_REMOVE_FAILED
fi
if [ "$j_dir" = 1 ] && { [ -e "$creds_dir" ] || [ -L "$creds_dir" ]; }; then
  [ -d "$creds_dir" ] && [ ! -L "$creds_dir" ] || fail CREDENTIALS_DIR_NOT_A_DIRECTORY
  [ -z "$(ls -A "$creds_dir")" ] || fail CREDENTIALS_DIR_HAS_UNOWNED_ENTRIES
  rmdir -- "$creds_dir" || fail CREDENTIALS_DIR_REMOVE_FAILED
fi

# ── 5. proofs: no L7 residue, predecessor and legacy boundary intact ─────────────────────────────────────────────────────
[ "$j_dir" = 0 ] || [ ! -e "$creds_dir" ] || fail CREDENTIALS_DIR_RESIDUE
for logical in "${j_files[@]}"; do
  [ ! -e "$(host_path "$logical")" ] || fail "MATERIAL_RESIDUE:${logical##*/}"
done
[ "$j_unit" = 0 ] || [ ! -e "$unit_dest" ] || fail CORE_UNIT_RESIDUE
[ "$j_link" = 0 ] || [ ! -L "$current" ] || fail CURRENT_LINK_RESIDUE
for logical in "${j_runtime[@]}"; do
  [ ! -e "$(host_path "$logical")" ] || fail "RUNTIME_DIR_RESIDUE:${logical}"
done

snapshot_tree "$legacy_dir" "$WORK/legacy-tree.rollback"
cmp -s "$WORK/legacy-tree.sha256" "$WORK/legacy-tree.rollback" || fail LEGACY_CONFIG_TREE_CHANGED
{
  (cd "$l6b_dir" && find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 -r stat -c '%n %a %U:%G %s %Y')
  printf 'ca.crt.sha256 %s\n' "$(sha256sum -- "$l6b_ca" | cut -d' ' -f1)"
} > "$WORK/l6b-material.rollback"
cmp -s "$WORK/l6b-material.txt" "$WORK/l6b-material.rollback" || fail L6B_MATERIAL_CHANGED

runtime_state=NOT_APPLICABLE
if use_systemd; then
  if [ "$j_service" = 1 ]; then
    core_state=$(sysctl_do show -p LoadState -p ActiveState -p SubState -p Result "$UNIT" 2>/dev/null | LC_ALL=C sort | paste -sd,)
    [ "$core_state" = "ActiveState=inactive,LoadState=not-found,Result=success,SubState=dead" ] || fail CORE_SERVICE_RUNTIME_STATE_RESIDUE
    runtime_state=not-found/inactive/dead/success
  fi
  sysctl_do show -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p NRestarts -p ExecMainStartTimestamp \
    "$LEGACY_UNIT" "$BROKER_UNIT" > "$WORK/legacy-service.rollback" || fail PREDECESSOR_SERVICE_READ_FAILED
  cmp -s "$WORK/legacy-service.txt" "$WORK/legacy-service.rollback" || fail PREDECESSOR_SERVICE_CHANGED
fi
if use_ss; then
  l7_listener_snapshot "$(host_path /proc/sys/net/ipv4/ip_local_port_range)" ss_do -H -ltnu > "$WORK/listeners.rollback"
  cmp -s "$WORK/listeners-baseline.txt" "$WORK/listeners.rollback" || fail LISTENER_CHANGED
fi

printf 'L7_ROLLBACK=PASS\n'
printf 'LEGACY_SERVICE_MUTATED=NO\n'
printf 'L7_MATERIAL_RESIDUE=NO\n'
printf 'L7_SERVICE_RUNTIME_STATE=%s\n' "$runtime_state"
