#!/usr/bin/env bash
set -euo pipefail

runtime_root="${HOME}/.local/share/aegis/detection-engine"
if [[ "${1:-}" == "--runtime-root" && -n "${2:-}" ]]; then
  runtime_root="$2"
elif (($#)); then
  printf 'Usage: %s [--runtime-root PATH]\n' "$0" >&2
  exit 2
fi

engine_service="aegis-detection-engine.service"
tunnel_service="aegis-detection-tunnel.service"
settings="$runtime_root/install.json"

if [[ -f "$settings" ]]; then
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
fi

for service in "$engine_service" "$tunnel_service"; do
  sudo systemctl disable --now "$service" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$service"
done
sudo systemctl daemon-reload
sudo systemctl reset-failed "$engine_service" "$tunnel_service" 2>/dev/null || true

printf '%s\n' \
  'AEGIS IDEA2 Linux services were removed.' \
  "Preserved runtime: $runtime_root" \
  'The app, .env, virtual environment, models, biometric data, recordings and SSH material were not deleted.'
