#!/usr/bin/env python3
"""L7 Core environment renderer/validator. Authority: docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md.

``render`` derives /etc/aegis-idea3/core.env from the repository example plus the two owner-frozen values (AP broker address and
device id) and the certificate DNS name; it refuses to overwrite. ``check`` proves an installed file: only allowlisted keys, the
exact production/live/no-containment values, TLS on port 8883 to the AP address only, the Core (not an ESP32) identity, and NO
secret-bearing key at all, even blank (secrets reach the service only through systemd LoadCredential=). Output never echoes secret-looking values.
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import sys
from pathlib import Path

DEVICE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}", re.ASCII)
LABEL_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", re.ASCII)
# Must mirror FORBIDDEN_ENV in stages/L7/verify.sh, which scans /proc/<MainPID>/environ by NAME: systemd EnvironmentFile= projects
# even a blank ``KEY=`` into the process environment, so these keys must be ABSENT (not merely empty) from the Production file.
FORBIDDEN = frozenset({"AEGIS_MQTT_PASS", "AEGIS_ADMIN_PIN", "AEGIS_P1_C2D_KEY_FILE", "AEGIS_P1_D2C_KEY_FILE", "AEGIS_TG_TOKEN"})
FIXED = {
    "AEGIS_APPLICATION_ROOT": "/opt/aegis-idea3/current",
    "AEGIS_DATA_DIR": "/var/lib/aegis-idea3",
    "AEGIS_CONFIG_FILE": "/etc/aegis-idea3/core.env",
    "AEGIS_DB_PATH": "/var/lib/aegis-idea3/data/core-audit.sqlite3",
    "AEGIS_CORE_DISPATCH_DB_PATH": "/var/lib/aegis-idea3/data/core-dispatch.sqlite3",
    "AEGIS_CORE_PROTOCOL_DB_PATH": "/var/lib/aegis-idea3/data/core-protocol.sqlite3",
    "AEGIS_RUNTIME_DIR": "/run/aegis-idea3",
    "AEGIS_RUNTIME_LOG_DIR": "/var/log/aegis-idea3",
    "AEGIS_LOG_PATH": "/var/log/aegis-idea3/aegis_soc.log",
    "AEGIS_RESTORE_CREDENTIAL_FILE": "/etc/aegis-idea3/credentials/restore.credential",
    "AEGIS_PROFILE": "production",
    "AEGIS_DRY_RUN": "0",
    "AEGIS_AUTO_CONTAIN": "0",
    "AEGIS_START_DETECTOR": "0",
    "AEGIS_START_GUI": "0",
    "AEGIS_VOICE_ENABLE": "0",
    "AEGIS_BROKER_PORT": "8883",
    "AEGIS_MQTT_TLS": "1",
    "AEGIS_MQTT_CA_FILE": "/etc/aegis-idea3/pki/mqtt-ca.crt",
    "AEGIS_MQTT_USER": "idea3-core",
    "AEGIS_PROTOCOL_MODE": "v1",
    "AEGIS_CORE_DISPATCH_ENABLED": "0",
    # Non-secret Recovery R2/R6/R7 targets (PR238 RecoveryCoordinator). Exact approved production values only: the reviewed
    # design has no parameterized authority for them, so any other host:port list or URL (non-HTTPS, embedded credentials,
    # query strings) is VALUE_INVALID and a missing key is REQUIRED_KEY_MISSING. Optional IDEA1/IDEA2 URLs stay unknown keys.
    "AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET": "192.168.10.10:22",
    "AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": "192.168.1.1:53,192.168.10.10:22",
    "AEGIS_RECOVERY_WEB_READINESS_URL": "https://aegis.internal/security/",
}
NUMERIC = {"AEGIS_HEALTH_INTERVAL", "AEGIS_MAX_RESTARTS", "AEGIS_RESTART_WINDOW_SEC", "AEGIS_CORE_DISPATCH_POLL_SEC"}
INERT = {"AEGIS_CORE_DISPATCH_BASE_URL", "AEGIS_CORE_DISPATCH_CA_FILE", "AEGIS_CORE_DISPATCH_CLIENT_CERT", "AEGIS_CORE_DISPATCH_CLIENT_KEY",
         "AEGIS_TG_CHAT"}
FROM_ARGS = {"AEGIS_BROKER_IP", "AEGIS_P1_DEVICE_ID", "AEGIS_MQTT_TLS_SERVER_NAME"}
ALLOWED = frozenset(FIXED) | NUMERIC | INERT | FROM_ARGS


class Refusal(Exception):
    pass


def valid_ap(value: str) -> bool:
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        return False
    return addr.version == 4 and not (addr.is_unspecified or addr.is_multicast or addr.is_loopback)


def valid_name(value: str) -> bool:
    if not value or len(value) > 253:
        return False
    try:
        ipaddress.ip_address(value)
        return False
    except ValueError:
        pass
    return all(LABEL_RE.fullmatch(label) for label in value.split("."))


def validate_args(ap: str, device: str, name: str) -> None:
    if not valid_ap(ap):
        raise Refusal("AP_ADDRESS_INVALID")
    if not DEVICE_RE.fullmatch(device):
        raise Refusal("DEVICE_ID_INVALID")
    if not valid_name(name):
        raise Refusal("SERVER_NAME_INVALID")


def render(example: Path, ap: str, device: str, name: str, output: Path) -> None:
    validate_args(ap, device, name)
    if output.exists() or output.is_symlink():
        raise Refusal("OUTPUT_EXISTS")
    values = {"AEGIS_BROKER_IP": ap, "AEGIS_P1_DEVICE_ID": device, "AEGIS_MQTT_TLS_SERVER_NAME": name}
    lines = []
    for raw in example.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            lines.append(raw)
            continue
        key, _, value = raw.partition("=")
        if key in FORBIDDEN:  # the shared example keeps a blank AEGIS_TG_TOKEN for non-production; never render it for L7
            continue
        lines.append(f"{key}={values.get(key, value)}")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def check(path: Path, ap: str, device: str, name: str) -> None:
    validate_args(ap, device, name)
    if not path.is_file() or path.is_symlink():
        raise Refusal("FILE_MISSING")
    seen: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if "=" not in raw or raw.startswith("="):
            raise Refusal("LINE_MALFORMED")
        key, _, value = raw.partition("=")
        if key in seen:
            raise Refusal("DUPLICATE_KEY")
        seen[key] = value
    for key, value in seen.items():
        if key in FORBIDDEN:
            raise Refusal("FORBIDDEN_KEY")
        if key not in ALLOWED:
            raise Refusal("UNKNOWN_KEY")
    expected = dict(FIXED)
    expected.update({"AEGIS_BROKER_IP": ap, "AEGIS_P1_DEVICE_ID": device, "AEGIS_MQTT_TLS_SERVER_NAME": name})
    for key, want in expected.items():
        if key not in seen:
            raise Refusal("REQUIRED_KEY_MISSING")
        if seen[key] != want:
            raise Refusal("VALUE_INVALID")
    for key in NUMERIC:
        if key in seen and not re.fullmatch(r"[0-9]{1,6}", seen[key]):
            raise Refusal("VALUE_INVALID")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for cmd in ("render", "check"):
        sp = sub.add_parser(cmd)
        sp.add_argument("--ap-address", required=True)
        sp.add_argument("--device-id", required=True)
        sp.add_argument("--server-name", required=True)
        if cmd == "render":
            sp.add_argument("--example", required=True)
            sp.add_argument("--output", required=True)
        else:
            sp.add_argument("--file", required=True)
    args = parser.parse_args()
    try:
        if args.command == "render":
            render(Path(args.example), args.ap_address, args.device_id, args.server_name, Path(args.output))
            print("L7_CORE_ENV_RENDER=PASS")
        else:
            check(Path(args.file), args.ap_address, args.device_id, args.server_name)
            print("L7_CORE_ENV=PASS")
    except Refusal as exc:
        print(f"L7_CORE_ENV{'_RENDER' if args.command == 'render' else ''}=FAIL reason={exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
