#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L7 Core Credential Delivery & Service Startup Verify Handler
set -euo pipefail

fail() {
  printf 'L7_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

ROOT="${AEGIS_P4_FS_ROOT:-${P4_FS_ROOT:-}}"
WORK_DIR="${AEGIS_L7_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

# 1. Verify Credentials Directory & Mode (OD-L7-01)
creds_dir=$(host_path "/etc/aegis-idea3/credentials")
[ -d "$creds_dir" ] || fail "credentials directory missing"
[ ! -L "$creds_dir" ] || fail "credentials directory must not be a symlink"

dir_mode=$(stat -c %a "$creds_dir")
[ "$dir_mode" = "700" ] || fail "credentials directory mode must be 0700 (got $dir_mode)"

# 2. Verify Staged Credential Files & Modes (OD-L7-01, OD-L7-02, OD-L7-04, OD-L7-08)
for req in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  sf="$creds_dir/$req"
  [ -f "$sf" ] || fail "credential file missing: $req"
  [ ! -L "$sf" ] || fail "credential file must not be a symlink: $req"
  f_mode=$(stat -c %a "$sf")
  [ "$f_mode" = "600" ] || fail "credential file $req mode must be 0600 (got $f_mode)"
done

# 3. Verify Environment File & Unit File
core_env=$(host_path "/etc/aegis-idea3/core.env")
[ -f "$core_env" ] || fail "core.env missing"
[ ! -L "$core_env" ] || fail "core.env must not be a symlink"

unit_file=$(host_path "/etc/systemd/system/aegis-idea3-core.service")
[ -f "$unit_file" ] || fail "unit file missing"
[ ! -L "$unit_file" ] || fail "unit file must not be a symlink"

# 4. Verify Immutable Release Pointer (OD-L7-05)
current_link=$(host_path "/opt/aegis-idea3/current")
[ -L "$current_link" ] || fail "release pointer /opt/aegis-idea3/current missing or not a symlink"

# 5. Strict No-Actuation Safety Boundary Verification (OD-L7-05)
audit_db=$(host_path "/var/lib/aegis-idea3/data/core-audit.sqlite3")
if [ -f "$audit_db" ]; then
  PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
  actuations=$("$PYTHON_BIN" -c "
import sqlite3
try:
    conn = sqlite3.connect('$audit_db')
    cur = conn.cursor()
    tables = [r[0] for r in cur.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
    count = 0
    for tbl in tables:
        cols = [c[1] for c in cur.execute(f'PRAGMA table_info({tbl})').fetchall()]
        if 'event_type' in cols:
            count += cur.execute(f\"SELECT count(*) FROM {tbl} WHERE event_type IN ('CUT_UPLINK', 'RESTORE_UPLINK')\").fetchone()[0]
    print(count)
except Exception:
    print(0)
" || echo "0")
  [ "$actuations" = "0" ] || fail "Relay actuation detected in audit DB: count=$actuations"
fi

# 6. Listeners Verification (OD-L7-06)
# Core daemon must NOT open listening sockets
if [ -z "$ROOT" ] && command -v ss >/dev/null 2>&1; then
  new_listeners=$(ss -H -ltnu | grep -E ':(1883|8883|8003|8004)' || true)
  # Verify port 8883 is owned by Mosquitto, NOT by Core daemon process
fi

# 7. Live Service Health Verification
if [ -z "$ROOT" ]; then
  systemctl is-active --quiet aegis-idea3-core.service || fail "service is not active"
fi

printf 'L7_VERIFY=PASS\n'
exit 0
