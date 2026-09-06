#!/usr/bin/env bash
set -euo pipefail

runtime_root="${HOME}/.local/share/aegis/detection-engine"
start_now="false"

while (($#)); do
  case "$1" in
    --runtime-root)
      [[ -n "${2:-}" ]] || { echo 'Missing --runtime-root value' >&2; exit 2; }
      runtime_root="$2"
      shift 2
      ;;
    --start-now) start_now="true"; shift ;;
    --help|-h)
      echo "Usage: $0 [--runtime-root PATH] [--start-now]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

settings="$runtime_root/install.json"
[[ -f "$settings" ]] || { echo "Installer settings not found: $settings" >&2; exit 1; }

read_setting() {
  /usr/bin/python - "$settings" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle).get(sys.argv[2], "")
print(value)
PY
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
identity_name=$(read_setting identityFileName)
engine_service=$(read_setting engineService)
tunnel_service=$(read_setting tunnelService)
args=(
  --runtime-root "$runtime_root"
  --config "$runtime_root/app/.env"
  --python /usr/bin/python
  --tunnel-host "$(read_setting tunnelHost)"
  --identity-file "$runtime_root/ssh/$identity_name"
  --known-hosts-file "$runtime_root/ssh/known_hosts"
  --monitor-target-host "$(read_setting monitorTargetHost)"
  --monitor-target-port "$(read_setting monitorTargetPort)"
  --local-forward-port "$(read_setting localForwardPort)"
  --remote-bind-address "$(read_setting remoteBindAddress)"
  --remote-port "$(read_setting remotePort)"
  --engine-port "$(read_setting enginePort)"
)

engine_was_active="false"
tunnel_was_active="false"
systemctl is-active --quiet "$engine_service" && engine_was_active="true"
systemctl is-active --quiet "$tunnel_service" && tunnel_was_active="true"

sudo systemctl stop "$engine_service" "$tunnel_service"

restore_previous_state() {
  [[ "$tunnel_was_active" == "true" ]] && sudo systemctl start "$tunnel_service" || true
  [[ "$engine_was_active" == "true" ]] && sudo systemctl start "$engine_service" || true
}

if ! "$script_dir/install_systemd.sh" "${args[@]}"; then
  echo "Repair failed; restoring the previously active services." >&2
  restore_previous_state
  exit 1
fi

if [[ "$start_now" == "true" || "$tunnel_was_active" == "true" ]]; then
  sudo systemctl restart "$tunnel_service"
fi
if [[ "$start_now" == "true" || "$engine_was_active" == "true" ]]; then
  sudo systemctl restart "$engine_service"
fi

echo "AEGIS IDEA2 Linux repair completed."
