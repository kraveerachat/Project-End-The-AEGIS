#!/usr/bin/env bash
set -u

runtime_root="${HOME}/.local/share/aegis/detection-engine"
if [[ "${1:-}" == "--runtime-root" && -n "${2:-}" ]]; then
  runtime_root="$2"
elif (($#)); then
  printf 'Usage: %s [--runtime-root PATH]\n' "$0" >&2
  exit 2
fi

settings="$runtime_root/install.json"
if [[ ! -f "$settings" ]]; then
  printf 'INSTALL_STATE=MISSING\nRUNTIME_ROOT=%s\n' "$runtime_root"
  exit 1
fi

read_setting() {
  /usr/bin/python - "$settings" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle).get(sys.argv[2], "")
print(value)
PY
}

engine_service=$(read_setting engineService)
tunnel_service=$(read_setting tunnelService)
engine_port=$(read_setting enginePort)
local_forward_port=$(read_setting localForwardPort)
remote_port=$(read_setting remotePort)
identity_name=$(read_setting identityFileName)
identity_file="$runtime_root/ssh/$identity_name"

port_open() {
  timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null
}

engine_enabled=$(systemctl is-enabled "$engine_service" 2>/dev/null || true)
engine_active=$(systemctl is-active "$engine_service" 2>/dev/null || true)
tunnel_enabled=$(systemctl is-enabled "$tunnel_service" 2>/dev/null || true)
tunnel_active=$(systemctl is-active "$tunnel_service" 2>/dev/null || true)

key_exists="false"
key_owner_ok="false"
key_mode_ok="false"
if [[ -f "$identity_file" ]]; then
  key_exists="true"
  [[ "$(stat -c '%U' "$identity_file" 2>/dev/null)" == "$(id -un)" ]] && key_owner_ok="true"
  [[ "$(stat -c '%a' "$identity_file" 2>/dev/null)" == "600" ]] && key_mode_ok="true"
fi

engine_listening="false"
monitor_forward_listening="false"
port_open "$engine_port" && engine_listening="true"
port_open "$local_forward_port" && monitor_forward_listening="true"

engine_health="unreachable"
if response=$(curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:${engine_port}/health" 2>/dev/null); then
  engine_health="$response"
fi

monitor_health="unreachable"
if response=$(curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:${local_forward_port}/healthz" 2>/dev/null); then
  monitor_health="$response"
fi

printf '%s\n' \
  "RUNTIME_ROOT=$runtime_root" \
  "ENGINE_SERVICE=$engine_service" \
  "ENGINE_ENABLED=$engine_enabled" \
  "ENGINE_ACTIVE=$engine_active" \
  "TUNNEL_SERVICE=$tunnel_service" \
  "TUNNEL_ENABLED=$tunnel_enabled" \
  "TUNNEL_ACTIVE=$tunnel_active" \
  "PRIVATE_KEY_EXISTS=$key_exists" \
  "PRIVATE_KEY_OWNER_OK=$key_owner_ok" \
  "PRIVATE_KEY_MODE_600=$key_mode_ok" \
  "ENGINE_PORT_${engine_port}=$engine_listening" \
  "MONITOR_FORWARD_${local_forward_port}=$monitor_forward_listening" \
  "REMOTE_FORWARD_PORT=$remote_port" \
  "ENGINE_HEALTH=$engine_health" \
  "MONITOR_HEALTH=$monitor_health"

printf '%s\n' '=== RECENT ENGINE LOG ==='
journalctl -u "$engine_service" -n 30 --no-pager 2>/dev/null || true
printf '%s\n' '=== RECENT TUNNEL LOG ==='
journalctl -u "$tunnel_service" -n 30 --no-pager 2>/dev/null || true
