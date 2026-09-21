#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ipaddress
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.conf.example"

OUTPUT_CONFIG = "aegis-idea3-mosquitto.conf"
OUTPUT_CONTRACT = "aegis-idea3-t4-contract.txt"

IDEA3_ETC_ROOT = Path("/etc/aegis-idea3")
LEGACY_PASSWORD_FILE = Path("/etc/mosquitto/passwd")


def validate_ipv4(value: str, label: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be a valid IPv4 address") from exc

    if address.version != 4:
        raise ValueError(f"{label} must be IPv4")

    if address.is_unspecified or address.is_multicast or address.is_loopback:
        raise ValueError(f"{label} must be a concrete non-loopback IPv4 address")

    return str(address)


def validate_idea3_path(value: str, label: str) -> str:
    path = Path(value)

    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path")

    normalized = Path(os.path.normpath(str(path)))
    try:
        normalized.relative_to(IDEA3_ETC_ROOT)
    except ValueError as exc:
        raise ValueError(
            f"{label} must be inside /etc/aegis-idea3"
        ) from exc

    if normalized == IDEA3_ETC_ROOT:
        raise ValueError(f"{label} must name a file below /etc/aegis-idea3")

    return str(normalized)


def render_config(
    *,
    ap_address: str,
    uplink_address: str,
    ca_file: str,
    cert_file: str,
    key_file: str,
    password_file: str,
    acl_file: str,
) -> str:
    ap = validate_ipv4(ap_address, "ap-address")
    uplink = validate_ipv4(uplink_address, "uplink-address")

    if ap == uplink:
        raise ValueError("AP address must differ from uplink address")

    ca = validate_idea3_path(ca_file, "ca-file")
    cert = validate_idea3_path(cert_file, "cert-file")
    key = validate_idea3_path(key_file, "key-file")
    password = validate_idea3_path(password_file, "password-file")
    acl = validate_idea3_path(acl_file, "acl-file")

    if Path(password) == LEGACY_PASSWORD_FILE:
        raise ValueError("legacy Mosquitto password database is forbidden")

    template = TEMPLATE.read_text(encoding="utf-8")
    rendered = (
        template.replace("<AEGIS_AP_ADDRESS>", ap)
        .replace("<AEGIS_MQTT_CA_FILE>", ca)
        .replace("<AEGIS_MQTT_CERT_FILE>", cert)
        .replace("<AEGIS_MQTT_KEY_FILE>", key)
        .replace("<AEGIS_MQTT_PASSWORD_FILE>", password)
        .replace("<AEGIS_MQTT_ACL_FILE>", acl)
    )

    validate_rendered_config(rendered, ap=ap, uplink=uplink)
    return rendered


def validate_rendered_config(text: str, *, ap: str, uplink: str) -> None:
    active = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    listeners = [line for line in active if line.startswith("listener ")]
    expected = [
        "listener 8883 127.0.0.1",
        f"listener 8883 {ap}",
    ]

    if listeners != expected:
        raise ValueError("IDEA3 broker must expose exactly loopback + AP TLS listeners")

    if any("listener 1883" in line for line in active):
        raise ValueError("IDEA3 broker must not expose plaintext MQTT")

    if any(
        line in {"listener 8883 0.0.0.0", "listener 8883 ::"}
        for line in active
    ):
        raise ValueError("wildcard TLS listener is forbidden")

    if uplink in text:
        raise ValueError("uplink address must not appear in IDEA3 broker config")

    required = {
        "allow_anonymous false",
        "persistence false",
        "retain_available false",
        "tls_version tlsv1.2",
    }
    if not required.issubset(set(active)):
        raise ValueError("required IDEA3 broker security directives are missing")

    if "<AEGIS_" in text:
        raise ValueError("unresolved broker placeholder")


def render_contract(ap_address: str) -> str:
    return "\n".join(
        (
            "AEGIS_IDEA3_T4_BROKER_MIGRATION_V1",
            "SERVICE=aegis-idea3-mosquitto.service",
            "BROKER_MODE=SEPARATE_TLS_ONLY",
            "LISTEN_LOOPBACK=127.0.0.1:8883",
            f"LISTEN_AP={ap_address}:8883",
            "LEGACY_SERVICE=mosquitto.service",
            "LEGACY_1883=UNCHANGED",
            "LEGACY_USER_AEGIS=UNCHANGED",
            "PRODUCTION_MUTATION=NO",
            "L6A=NOT RUN",
            "L6B=NOT RUN",
            "",
        )
    )


def write_new(path: Path, content: str) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError(f"refusing to overwrite existing artifact: {path.name}")

    path.write_text(content, encoding="utf-8")


def render(args: argparse.Namespace) -> None:
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    if not output_dir.is_dir() or output_dir.is_symlink():
        raise ValueError("output-dir must be a real directory")

    config = render_config(
        ap_address=args.ap_address,
        uplink_address=args.uplink_address,
        ca_file=args.ca_file,
        cert_file=args.cert_file,
        key_file=args.key_file,
        password_file=args.password_file,
        acl_file=args.acl_file,
    )

    ap = validate_ipv4(args.ap_address, "ap-address")
    contract = render_contract(ap)

    write_new(output_dir / OUTPUT_CONFIG, config)
    write_new(output_dir / OUTPUT_CONTRACT, contract)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="AEGIS IDEA3 PR11 T4 separate MQTT broker renderer"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--ap-address", required=True)
    render_parser.add_argument("--uplink-address", required=True)
    render_parser.add_argument("--ca-file", required=True)
    render_parser.add_argument("--cert-file", required=True)
    render_parser.add_argument("--key-file", required=True)
    render_parser.add_argument("--password-file", required=True)
    render_parser.add_argument("--acl-file", required=True)
    render_parser.add_argument("--output-dir", type=Path, required=True)

    args = parser.parse_args()

    try:
        if args.command == "render":
            render(args)
            return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
