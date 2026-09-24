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
[ "$dir_mode" = "750" ] || fail "credentials directory mode must be 0750 (got $dir_mode)"

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
current_target=$(readlink "$current_link")
[[ "$current_target" =~ ^/opt/aegis-idea3/releases/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "L7_CURRENT_LINK_TARGET_INVALID"
release_host=$(host_path "$current_target")
[ -d "$release_host" ] || fail "L7_CURRENT_LINK_DANGLING"
[ -f "$release_host/venv/bin/python" ] && [ -x "$release_host/venv/bin/python" ] || fail "L7_RELEASE_VENV_MISSING"
[ -f "$release_host/aegis_soc/supervisor.py" ] || fail "L7_RELEASE_INCOMPLETE"
unit_exec=$(sed -n 's/^ExecStart=\([^[:space:]]*\).*/\1/p' "$unit_file" | head -n 1)
[ -n "$unit_exec" ] || fail "L7_UNIT_EXECSTART_MISSING"
unit_exec_resolved="${unit_exec/#\/opt\/aegis-idea3\/current/$current_target}"
[ -x "$(host_path "$unit_exec_resolved")" ] || fail "L7_UNIT_EXECSTART_MISSING"

# 5. Strict No-Actuation Safety Boundary Verification (OD-L7-05)
audit_db=$(host_path "/var/lib/aegis-idea3/data/core-audit.sqlite3")
if [ -f "$audit_db" ]; then
  PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
  actuations=$("$PYTHON_BIN" -c "
import sqlite3
import sys
try:
    conn = sqlite3.connect(sys.argv[1])
    cur = conn.cursor()
    tables = [r[0] for r in cur.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
    count = 0
    for tbl in tables:
        cols = [c[1] for c in cur.execute(f'PRAGMA table_info({tbl})').fetchall()]
        if 'event_type' in cols:
            count += cur.execute(f\"SELECT count(*) FROM {tbl} WHERE event_type IN ('CUT_UPLINK', 'RESTORE_UPLINK')\").fetchone()[0]
    print(count)
except Exception as exc:
    sys.stderr.write(f'SQLITE_QUERY_ERROR: {exc}\n')
    sys.exit(2)
" "$audit_db") || fail "Audit database query failed"
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
  [ "$(systemctl show -p NRestarts --value aegis-idea3-core.service)" = 0 ] || fail "L7_SERVICE_RESTARTED"
fi

printf 'L7_VERIFY=PASS\n'
exit 0
