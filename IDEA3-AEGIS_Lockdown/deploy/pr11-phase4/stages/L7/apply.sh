#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L7 Core Credential Delivery & Service Startup Apply Handler
# Staging and service activation. Fails closed on any constraint violation.
set -euo pipefail

fail() {
  printf 'L7_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

# 1. Environment Variable Checks
INPUT_DIR="${AEGIS_L7_INPUT_DIR:-}"
[ -n "$INPUT_DIR" ] || fail "AEGIS_L7_INPUT_DIR required"

WORK_DIR="${AEGIS_L7_WORK_DIR:-}"
[ -n "$WORK_DIR" ] || fail "AEGIS_L7_WORK_DIR required"

ROOT="${AEGIS_P4_FS_ROOT:-${P4_FS_ROOT:-}}"

# Live authorization guard (OD-L7-05 / Live Prerequisites §6)
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L7_LIVE_AUTHORIZED:-NO}" = "YES" ] || fail "LIVE_AUTHORIZATION_FLAG_REQUIRED"
  [ "$(id -u)" = 0 ] || fail "ROOT_REQUIRED"
fi

# 2. Directory Validation
[ -d "$INPUT_DIR" ] || fail "INPUT_DIR must exist and be a directory"
[ ! -L "$INPUT_DIR" ] || fail "INPUT_DIR must not be a symlink"
[ ! -L "$WORK_DIR" ] || fail "WORK_DIR must not be a symlink"

mkdir -p "$WORK_DIR"
chmod 0700 "$WORK_DIR"

# 3. Input Files Verification & Mode Checks
for req in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  [ -f "$INPUT_DIR/$req" ] || fail "INPUT_DIR missing required file: $req"
  [ ! -L "$INPUT_DIR/$req" ] || fail "INPUT_DIR file must not be a symlink: $req"
done

for req in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  sec_mode=$(stat -c %a "$INPUT_DIR/$req")
  if [ "$sec_mode" != "600" ] && [ "$sec_mode" != "400" ]; then
    fail "INPUT_DIR secret $req has invalid mode: $sec_mode (must be 0600 or 0400)"
  fi
done

# 4. Protocol Keys Validation (OD-L7-02)
c2d=$(head -n 1 "$INPUT_DIR/k_c2d" | tr -d '\r\n')
d2c=$(head -n 1 "$INPUT_DIR/k_d2c" | tr -d '\r\n')

if ! [[ "$c2d" =~ ^[0-9a-f]{64}$ ]]; then
  fail "k_c2d must be exactly 64 lowercase hex characters"
fi
if ! [[ "$d2c" =~ ^[0-9a-f]{64}$ ]]; then
  fail "k_d2c must be exactly 64 lowercase hex characters"
fi
if [ "$c2d" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
  fail "k_c2d is all zeros"
fi
if [ "$d2c" = "0000000000000000000000000000000000000000000000000000000000000000" ]; then
  fail "k_d2c is all zeros"
fi
if [ "$c2d" = "$d2c" ]; then
  fail "k_c2d and k_d2c must be independent"
fi

P4_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"

"$PYTHON_BIN" -c "
import sys
from pathlib import Path
sys.path.insert(0, str(Path('$P4_HERE').resolve().parents[1]))
from aegis_soc.protocol_v1 import load_protocol_keys
load_protocol_keys(Path('$INPUT_DIR/k_c2d'), Path('$INPUT_DIR/k_d2c'))
" || fail "Protocol key canonical validation failed"

# 5. Admin PIN Validation (OD-L7-04)
admin_pin=$(head -n 1 "$INPUT_DIR/admin.pin" | tr -d '\r\n')
[ -n "$admin_pin" ] || fail "admin.pin cannot be empty"
[ "$admin_pin" != "1234" ] || fail "admin.pin cannot be default 1234"
if [[ "$admin_pin" =~ [[:space:]] ]]; then
  fail "admin.pin cannot contain whitespace"
fi

# 6. MQTT Password Validation (OD-L7-04)
mqtt_pass=$(head -n 1 "$INPUT_DIR/mqtt-core.pass" | tr -d '\r\n')
[ -n "$mqtt_pass" ] || fail "mqtt-core.pass cannot be empty"

# 7. D4 Local Restore Credential Prerequisite (OD-L7-08)
"$PYTHON_BIN" -c "
import sys
from pathlib import Path
sys.path.insert(0, str(Path('$P4_HERE').resolve().parents[1]))
from aegis_soc.local_restore import RestoreCredential
RestoreCredential.load(Path('$INPUT_DIR/restore.credential'))
" || fail "restore.credential format validation failed"

# 8. Path Helper
host_path() {
  if [ -n "$ROOT" ]; then
    printf '%s%s\n' "${ROOT%/}" "$1"
  else
    printf '%s\n' "$1"
  fi
}

# 9. Prestate Capture (OD-L7-07)
PRESTATE="$WORK_DIR/prestate.manifest"
: > "$PRESTATE"

creds_dir=$(host_path "/etc/aegis-idea3/credentials")
if [ -d "$creds_dir" ]; then
  printf 'creds_dir_existed=1\n' >> "$PRESTATE"
else
  printf 'creds_dir_existed=0\n' >> "$PRESTATE"
fi

for f in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  if [ -f "$creds_dir/$f" ]; then
    printf 'cred_existed_%s=1\n' "$f" >> "$PRESTATE"
  else
    printf 'cred_existed_%s=0\n' "$f" >> "$PRESTATE"
  fi
done

core_env=$(host_path "/etc/aegis-idea3/core.env")
if [ -f "$core_env" ]; then
  printf 'core_env_existed=1\n' >> "$PRESTATE"
  cp "$core_env" "$WORK_DIR/core.env.bak"
else
  printf 'core_env_existed=0\n' >> "$PRESTATE"
fi

unit_file=$(host_path "/etc/systemd/system/aegis-idea3-core.service")
if [ -f "$unit_file" ]; then
  printf 'unit_file_existed=1\n' >> "$PRESTATE"
else
  printf 'unit_file_existed=0\n' >> "$PRESTATE"
fi

current_link=$(host_path "/opt/aegis-idea3/current")
if [ -L "$current_link" ]; then
  old_target=$(readlink "$current_link")
  printf 'current_link_target=%s\n' "$old_target" >> "$PRESTATE"
else
  printf 'current_link_target=none\n' >> "$PRESTATE"
fi

# 10. File Staging (OD-L7-01, OD-L7-05, OD-L7-06)
mkdir -p "$creds_dir"
chmod 0700 "$creds_dir"

for f in k_c2d k_d2c mqtt-core.pass admin.pin restore.credential; do
  cp "$INPUT_DIR/$f" "$creds_dir/$f"
  chmod 0600 "$creds_dir/$f"
done

mkdir -p "$(dirname "$core_env")"
if [ ! -f "$core_env" ]; then
  cat > "$core_env" <<'EOF'
AEGIS_AUTO_CONTAIN=0
AEGIS_CORE_PROFILE=production
AEGIS_LOG_LEVEL=INFO
EOF
  chmod 0600 "$core_env"
fi

mkdir -p "$(dirname "$unit_file")"
if [ ! -f "$unit_file" ]; then
  UNIT_EXAMPLE="$(cd "$P4_HERE/../.." && pwd)/deploy/aegis-idea3-core.service.example"
  if [ -f "$UNIT_EXAMPLE" ]; then
    cp "$UNIT_EXAMPLE" "$unit_file"
    chmod 0644 "$unit_file"
  fi
fi

mkdir -p "$(dirname "$current_link")"
rel_dir="${AEGIS_L7_RELEASE_DIR:-/opt/aegis-idea3/releases/v1.0.0}"
if [ ! -e "$current_link" ] && [ ! -L "$current_link" ]; then
  ln -s "$rel_dir" "$current_link"
fi

mkdir -p "$(host_path /var/lib/aegis-idea3/data)"
mkdir -p "$(host_path /run/aegis-idea3)"
mkdir -p "$(host_path /var/log/aegis-idea3)"

# 11. Service Activation (Live execution only)
if [ -z "$ROOT" ]; then
  systemctl daemon-reload
  systemctl start aegis-idea3-core.service
fi

printf 'L7_APPLY=COMPLETE\n'
exit 0
