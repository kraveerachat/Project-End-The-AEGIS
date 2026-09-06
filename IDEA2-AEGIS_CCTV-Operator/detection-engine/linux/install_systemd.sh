#!/usr/bin/env bash
set -euo pipefail

readonly ENGINE_SERVICE="aegis-detection-engine.service"
readonly TUNNEL_SERVICE="aegis-detection-tunnel.service"
readonly UNIT_DIR="/etc/systemd/system"

runtime_root="${HOME}/.local/share/aegis/detection-engine"
configuration_file=""
base_python="/usr/bin/python"
tunnel_host=""
identity_file=""
known_hosts_file=""
monitor_target_host="172.18.0.2"
monitor_target_port="8002"
local_forward_port="18002"
remote_bind_address="172.18.0.1"
remote_port="18077"
engine_port="8077"
skip_dependency_install="false"
start_now="false"

usage() {
  printf '%s\n' \
    'Usage: ./linux/install_systemd.sh [options]' \
    '' \
    'Required:' \
    '  --config PATH              Machine-local .env file' \
    '  --tunnel-host USER@HOST    SSH endpoint used for both forwards' \
    '  --identity-file PATH       Machine-local private key' \
    '  --known-hosts-file PATH    Verified known_hosts file' \
    '' \
    'Optional:' \
    '  --runtime-root PATH        Default: ~/.local/share/aegis/detection-engine' \
    '  --python PATH              Default: /usr/bin/python' \
    '  --monitor-target-host HOST Default: 172.18.0.2' \
    '  --monitor-target-port PORT Default: 8002' \
    '  --local-forward-port PORT  Default: 18002' \
    '  --remote-bind-address ADDR Default: 172.18.0.1' \
    '  --remote-port PORT         Default: 18077; must be unique on the server' \
    '  --engine-port PORT         Default: 8077' \
    '  --skip-dependency-install  Reuse the existing runtime virtual environment' \
    '  --start-now                Enable and start both services after installation'
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || die "Missing value for $1"
}

validate_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  (( value >= 1 && value <= 65535 )) || die "$name must be between 1 and 65535"
}

while (($#)); do
  case "$1" in
    --runtime-root) require_value "$@"; runtime_root="$2"; shift 2 ;;
    --config) require_value "$@"; configuration_file="$2"; shift 2 ;;
    --python) require_value "$@"; base_python="$2"; shift 2 ;;
    --tunnel-host) require_value "$@"; tunnel_host="$2"; shift 2 ;;
    --identity-file) require_value "$@"; identity_file="$2"; shift 2 ;;
    --known-hosts-file) require_value "$@"; known_hosts_file="$2"; shift 2 ;;
    --monitor-target-host) require_value "$@"; monitor_target_host="$2"; shift 2 ;;
    --monitor-target-port) require_value "$@"; monitor_target_port="$2"; shift 2 ;;
    --local-forward-port) require_value "$@"; local_forward_port="$2"; shift 2 ;;
    --remote-bind-address) require_value "$@"; remote_bind_address="$2"; shift 2 ;;
    --remote-port) require_value "$@"; remote_port="$2"; shift 2 ;;
    --engine-port) require_value "$@"; engine_port="$2"; shift 2 ;;
    --skip-dependency-install) skip_dependency_install="true"; shift ;;
    --start-now) start_now="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$EUID" -ne 0 ]] || die "Run as the target camera user, not root; the installer invokes sudo only for system files."
[[ -n "$configuration_file" ]] || die "--config is required"
[[ -n "$tunnel_host" ]] || die "--tunnel-host is required"
[[ -n "$identity_file" ]] || die "--identity-file is required"
[[ -n "$known_hosts_file" ]] || die "--known-hosts-file is required"
[[ "$tunnel_host" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]] || die "--tunnel-host must use user@host"
[[ "$monitor_target_host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid --monitor-target-host"
[[ "$remote_bind_address" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid --remote-bind-address"
[[ "$runtime_root" != *[[:space:]]* ]] || die "--runtime-root must not contain whitespace"

validate_port --monitor-target-port "$monitor_target_port"
validate_port --local-forward-port "$local_forward_port"
validate_port --remote-port "$remote_port"
validate_port --engine-port "$engine_port"

for command in sudo systemctl ssh curl tar install stat; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done
[[ -x "$base_python" ]] || die "Python executable not found: $base_python"
[[ -f "$configuration_file" ]] || die "Configuration file not found"
[[ -f "$identity_file" ]] || die "Identity file not found"
[[ -f "$known_hosts_file" ]] || die "known_hosts file not found"

source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime_root=$(mkdir -p "$runtime_root" && cd "$runtime_root" && pwd -P)
runtime_app="$runtime_root/app"
runtime_venv="$runtime_root/.venv"
runtime_python="$runtime_venv/bin/python"
runtime_env="$runtime_app/.env"
runtime_ssh="$runtime_root/ssh"
runtime_identity="$runtime_ssh/$(basename "$identity_file")"
runtime_known_hosts="$runtime_ssh/known_hosts"
settings_path="$runtime_root/install.json"

mkdir -p "$runtime_app" "$runtime_ssh" "$runtime_root/logs" \
  "$runtime_root/segments" "$runtime_root/snapshots" "$runtime_root/models" \
  "$runtime_root/identity"
chmod 700 "$runtime_root" "$runtime_ssh"

identity_mode=$(stat -c '%a' "$identity_file")
(( (8#$identity_mode & 077) == 0 )) || die "Private key must not grant group or other permissions"

tunnel_server=${tunnel_host#*@}
ssh-keygen -F "$tunnel_server" -f "$known_hosts_file" >/dev/null 2>&1 || \
  die "Verified known_hosts file has no entry for the tunnel server"

for port in "$local_forward_port" "$engine_port"; do
  if timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    die "Local port already in use: $port"
  fi
done

# Copy durable source only. Runtime state, secrets, biometric material and local
# virtual environments never flow from the checkout into the managed app copy.
# A repair invoked from the managed copy itself skips this no-op self-copy.
if [[ "$source_root" != "$runtime_app" ]]; then
  tar -C "$source_root" \
    --exclude='./.git' \
    --exclude='./.env' \
    --exclude='./.venv' \
    --exclude='./venv' \
    --exclude='./segments' \
    --exclude='./snapshots' \
    --exclude='./models' \
    --exclude='./identity' \
    --exclude='./__pycache__' \
    --exclude='./.pytest_cache' \
    -cf - . | tar -C "$runtime_app" -xf -
fi

install -m 600 "$configuration_file" "$runtime_env"
if [[ "$identity_file" != "$runtime_identity" ]]; then
  install -m 600 "$identity_file" "$runtime_identity"
else
  chmod 600 "$runtime_identity"
fi
if [[ "$known_hosts_file" != "$runtime_known_hosts" ]]; then
  install -m 600 "$known_hosts_file" "$runtime_known_hosts"
else
  chmod 600 "$runtime_known_hosts"
fi

for required_key in AEGIS_MONITOR_API_BASE AEGIS_DETECTION_ENGINE_API_KEY AEGIS_STREAM_PUBLIC_URL; do
  if ! "$base_python" - "$runtime_env" "$required_key" <<'PY'
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
wanted = sys.argv[2]
found = False
for raw in env_path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() == wanted and value.strip():
        found = True
        break
raise SystemExit(0 if found else 1)
PY
  then
    die "Runtime .env is missing required integration settings; values were not printed"
  fi
done

if [[ ! -x "$runtime_python" ]]; then
  "$base_python" -m venv "$runtime_venv"
fi

if [[ "$skip_dependency_install" != "true" ]]; then
  "$runtime_python" -m pip install --disable-pip-version-check \
    --requirement "$runtime_app/requirements.txt"
fi

pushd "$runtime_app" >/dev/null
recognizer_backend=$(
  AEGIS_ENV_FILE="$runtime_env" "$runtime_python" - "$runtime_env" <<'PY'
import os
import sys
from dotenv import load_dotenv

load_dotenv(sys.argv[1], override=True)
from aegis_engine.config import EngineConfig
print(EngineConfig.from_env().validate().recognizer_backend)
PY
)
if [[ "$recognizer_backend" == "yolo-sface-admin" && "$skip_dependency_install" != "true" ]]; then
  "$runtime_python" -m pip install --disable-pip-version-check \
    --requirement "$runtime_app/requirements-ai.txt"
fi
"$runtime_python" - "$runtime_env" <<'PY'
import sys
from dotenv import load_dotenv

load_dotenv(sys.argv[1], override=True)
from aegis_engine.config import EngineConfig
from aegis_engine.yolo_sface_admin_recognizer import build_configured_recognizer

config = EngineConfig.from_env().validate()
build_configured_recognizer(config)
print("AEGIS Linux preflight passed")
PY
popd >/dev/null

# Prove the exact key, host trust and both forwards before registering anything
# persistent. The reverse target need not be listening for SSH to bind the port.
probe_socket="$runtime_ssh/install-probe-$$.sock"
cleanup_probe() {
  ssh -S "$probe_socket" -O exit "$tunnel_host" >/dev/null 2>&1 || true
  rm -f "$probe_socket"
}
trap cleanup_probe EXIT INT TERM

ssh -M -S "$probe_socket" -fNT \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$runtime_known_hosts" \
  -o ExitOnForwardFailure=yes \
  -i "$runtime_identity" \
  -L "127.0.0.1:${local_forward_port}:${monitor_target_host}:${monitor_target_port}" \
  -R "${remote_bind_address}:${remote_port}:127.0.0.1:${engine_port}" \
  "$tunnel_host"
curl --fail --silent --show-error --max-time 10 \
  "http://127.0.0.1:${local_forward_port}/healthz" >/dev/null
cleanup_probe
trap - EXIT INT TERM

target_user=$(id -un)
target_group=$(id -gn)
if getent group video >/dev/null 2>&1 && ! id -nG | tr ' ' '\n' | grep -Fxq video; then
  sudo usermod -aG video "$target_user"
fi

engine_unit="$runtime_root/${ENGINE_SERVICE}"
tunnel_unit="$runtime_root/${TUNNEL_SERVICE}"

cat >"$engine_unit" <<EOF
[Unit]
Description=AEGIS IDEA2 Detection Engine
Wants=network-online.target ${TUNNEL_SERVICE}
After=network-online.target ${TUNNEL_SERVICE}

[Service]
Type=simple
User=${target_user}
Group=${target_group}
SupplementaryGroups=video
WorkingDirectory=${runtime_app}
Environment=HOME=${HOME}
Environment=PYTHONUNBUFFERED=1
ExecStart=${runtime_python} ${runtime_app}/run.py
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

cat >"$tunnel_unit" <<EOF
[Unit]
Description=AEGIS IDEA2 Detection Tunnel
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${target_user}
Group=${target_group}
Environment=HOME=${HOME}
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${runtime_known_hosts} -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -i ${runtime_identity} -L 127.0.0.1:${local_forward_port}:${monitor_target_host}:${monitor_target_port} -R ${remote_bind_address}:${remote_port}:127.0.0.1:${engine_port} ${tunnel_host}
Restart=always
RestartSec=5
TimeoutStopSec=15
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF

install -m 600 /dev/null "$settings_path"
identity_file_name=$(basename "$runtime_identity")
"$base_python" - "$settings_path" <<PY
import json
import pathlib

path = pathlib.Path(${settings_path@Q})
data = {
    "schemaVersion": 1,
    "installerVersion": "linux-systemd-v1",
    "runtimeRoot": ${runtime_root@Q},
    "engineService": ${ENGINE_SERVICE@Q},
    "tunnelService": ${TUNNEL_SERVICE@Q},
    "tunnelHost": ${tunnel_host@Q},
    "identityFileName": ${identity_file_name@Q},
    "monitorTargetHost": ${monitor_target_host@Q},
    "monitorTargetPort": int(${monitor_target_port@Q}),
    "localForwardPort": int(${local_forward_port@Q}),
    "remoteBindAddress": ${remote_bind_address@Q},
    "remotePort": int(${remote_port@Q}),
    "enginePort": int(${engine_port@Q}),
}
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

sudo install -o root -g root -m 644 "$engine_unit" "$UNIT_DIR/$ENGINE_SERVICE"
sudo install -o root -g root -m 644 "$tunnel_unit" "$UNIT_DIR/$TUNNEL_SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable "$TUNNEL_SERVICE" "$ENGINE_SERVICE"

if [[ "$start_now" == "true" ]]; then
  sudo systemctl restart "$TUNNEL_SERVICE"
  sudo systemctl restart "$ENGINE_SERVICE"
fi

printf '%s\n' \
  'AEGIS IDEA2 Arch/Linux installation completed.' \
  "Runtime: $runtime_root" \
  "Engine service: $ENGINE_SERVICE" \
  "Tunnel service: $TUNNEL_SERVICE" \
  'No private-key or .env value was printed or written to Git.'
