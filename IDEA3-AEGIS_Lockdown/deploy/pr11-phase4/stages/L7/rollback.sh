#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L7 Core Credential Delivery & Service Startup Rollback Handler
# Reverts changes introduced by apply.sh to restore pre-stage state.
# Idempotent: multiple executions must exit 0 cleanly.
set -euo pipefail

ROOT="${AEGIS_P4_FS_ROOT:-${P4_FS_ROOT:-}}"
WORK_DIR="${AEGIS_L7_WORK_DIR:-}"

host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

PRESTATE=""
if [ -n "$WORK_DIR" ] && [ -f "$WORK_DIR/prestate.manifest" ]; then
  PRESTATE="$WORK_DIR/prestate.manifest"
fi

get_prestate() {
  local key="$1"
  local def="$2"
  if [ -n "$PRESTATE" ] && [ -f "$PRESTATE" ]; then
    local val
    val=$(grep "^${key}=" "$PRESTATE" 2>/dev/null | cut -d= -f2- || true)
    if [ -n "$val" ]; then
      printf '%s\n' "$val"
      return 0
    fi
  fi
  printf '%s\n' "$def"
}

# 1. Stop service in live mode
if [ -z "$ROOT" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet aegis-idea3-core.service 2>/dev/null; then
      systemctl stop aegis-idea3-core.service || true
    fi
  fi
fi

# 2. Revert systemd unit file
unit_existed=$(get_prestate "unit_file_existed" "0")
unit_file=$(host_path "/etc/systemd/system/aegis-idea3-core.service")
if [ "$unit_existed" = "0" ] && [ -f "$unit_file" ]; then
  rm -f "$unit_file"
  if [ -z "$ROOT" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
  fi
fi

# 3. Revert core.env
env_existed=$(get_prestate "core_env_existed" "0")
core_env=$(host_path "/etc/aegis-idea3/core.env")
if [ "$env_existed" = "0" ]; then
  rm -f "$core_env"
elif [ -n "$WORK_DIR" ] && [ -f "$WORK_DIR/core.env.bak" ]; then
  cp "$WORK_DIR/core.env.bak" "$core_env"
  chmod 0600 "$core_env"
fi

# 4. Revert credentials
creds_dir=$(host_path "/etc/aegis-idea3/credentials")
for f in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  f_key="cred_existed_${f}"
  f_existed=$(get_prestate "$f_key" "0")
  if [ "$f_existed" = "0" ]; then
    rm -f "$creds_dir/$f"
  fi
done

# If credentials directory did not exist before apply, remove it if empty
dir_existed=$(get_prestate "creds_dir_existed" "0")
if [ "$dir_existed" = "0" ] && [ -d "$creds_dir" ]; then
  rmdir "$creds_dir" 2>/dev/null || true
fi

# 5. Revert current release symlink
link_target=$(get_prestate "current_link_target" "none")
current_link=$(host_path "/opt/aegis-idea3/current")
if [ "$link_target" = "none" ]; then
  if [ -L "$current_link" ]; then
    rm -f "$current_link"
  fi
elif [ -n "$link_target" ]; then
  rm -f "$current_link"
  ln -s "$link_target" "$current_link"
fi

# 6. Ephemeral runtime directory cleanup
run_dir=$(host_path "/run/aegis-idea3")
if [ -d "$run_dir" ]; then
  rm -rf "${run_dir:?}"/* 2>/dev/null || true
  rmdir "$run_dir" 2>/dev/null || true
fi

# 7. Safety invariant: Never touch durable audit database or log directories
# /var/lib/aegis-idea3/data/core-audit.sqlite3 MUST BE PRESERVED

printf 'L7_ROLLBACK=COMPLETE\n'
exit 0
