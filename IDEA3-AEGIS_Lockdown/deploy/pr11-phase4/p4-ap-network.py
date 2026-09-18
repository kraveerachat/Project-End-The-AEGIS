#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 T5 repository-only AP network renderer."""

from __future__ import annotations

import argparse
import ipaddress
import re
import sys
from pathlib import Path


APPROVED_COUNTRY = "TH"
APPROVED_CHANNELS = frozenset(range(1, 14))
IFACE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,15}$")
HOST_LABEL_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)


def validate_hostname(value: str) -> str:
    if not value or len(value) > 253 or value.endswith("."):
        raise ValueError("broker hostname is invalid")

    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise ValueError("broker hostname must not be an IP literal")

    labels = value.split(".")
    if len(labels) < 2 or any(not HOST_LABEL_RE.fullmatch(label) for label in labels):
        raise ValueError("broker hostname is invalid")

    return value


def validate_inputs(args: argparse.Namespace) -> dict[str, str]:
    if not IFACE_RE.fullmatch(args.interface):
        raise ValueError("interface name is invalid")

    if not args.ssid_label or len(args.ssid_label) > 32:
        raise ValueError("SSID label must contain 1..32 characters")
    if "\n" in args.ssid_label or "\x00" in args.ssid_label:
        raise ValueError("SSID label contains an invalid character")

    if args.country != APPROVED_COUNTRY:
        raise ValueError("country must be exactly TH")

    try:
        channel = int(args.channel)
    except ValueError as exc:
        raise ValueError("channel must be an integer") from exc

    if channel not in APPROVED_CHANNELS:
        raise ValueError("channel must be in the approved range 1..13")

    try:
        subnet = ipaddress.ip_network(args.ap_subnet, strict=True)
        ap_address = ipaddress.ip_address(args.ap_address)
        dhcp_start = ipaddress.ip_address(args.dhcp_start)
        dhcp_end = ipaddress.ip_address(args.dhcp_end)
    except ValueError as exc:
        raise ValueError(f"invalid IPv4 input: {exc}") from exc

    if subnet.version != 4:
        raise ValueError("AP subnet must be IPv4")

    for name, address in (
        ("AP address", ap_address),
        ("DHCP start", dhcp_start),
        ("DHCP end", dhcp_end),
    ):
        if address.version != 4 or address not in subnet:
            raise ValueError(f"{name} must be inside the AP subnet")
        if address in (subnet.network_address, subnet.broadcast_address):
            raise ValueError(f"{name} cannot be the network or broadcast address")

    if dhcp_start == ap_address or dhcp_end == ap_address:
        raise ValueError("DHCP range cannot contain the Core AP address")

    if int(dhcp_start) > int(dhcp_end):
        raise ValueError("DHCP start must not be greater than DHCP end")

    if int(dhcp_start) <= int(ap_address) <= int(dhcp_end):
        raise ValueError("DHCP range cannot contain the Core AP address")

    broker_hostname = validate_hostname(args.broker_hostname)

    return {
        "interface": args.interface,
        "ssid_label": args.ssid_label,
        "channel": str(channel),
        "country": args.country,
        "ap_address": str(ap_address),
        "ap_subnet": str(subnet),
        "ap_prefixlen": str(subnet.prefixlen),
        "ap_netmask": str(subnet.netmask),
        "dhcp_start": str(dhcp_start),
        "dhcp_end": str(dhcp_end),
        "broker_hostname": broker_hostname,
    }



def render_nm_profile(values: dict[str, str]) -> str:
    template_path = (
        Path(__file__).resolve().parents[1]
        / "network"
        / "aegis-idea3-ap.nmconnection.example"
    )
    template = template_path.read_text(encoding="utf-8")

    replacements = {
        "<AEGIS_AP_INTERFACE>": values["interface"],
        "<AEGIS_AP_CHANNEL>": values["channel"],
        "<AEGIS_AP_SSID>": values["ssid_label"],
        "<AEGIS_AP_ADDRESS>": values["ap_address"],
        "<AEGIS_AP_PREFIXLEN>": values["ap_prefixlen"],
    }

    for placeholder, value in replacements.items():
        template = template.replace(placeholder, value)

    return template



def render_dnsmasq_config(values: dict[str, str]) -> str:
    template_path = (
        Path(__file__).resolve().parents[1]
        / "network"
        / "aegis-idea3-dnsmasq.conf.example"
    )
    template = template_path.read_text(encoding="utf-8")

    replacements = {
        "<AEGIS_AP_INTERFACE>": values["interface"],
        "<AEGIS_DHCP_START>": values["dhcp_start"],
        "<AEGIS_DHCP_END>": values["dhcp_end"],
        "<AEGIS_AP_NETMASK>": values["ap_netmask"],
        "<AEGIS_AP_ADDRESS>": values["ap_address"],
        "<AEGIS_BROKER_HOSTNAME>": values["broker_hostname"],
    }

    for placeholder, value in replacements.items():
        template = template.replace(placeholder, value)

    return template


def render_dnsmasq_service() -> str:
    template_path = (
        Path(__file__).resolve().parents[1]
        / "network"
        / "aegis-idea3-dnsmasq.service.example"
    )
    return template_path.read_text(encoding="utf-8")


def render(values: dict[str, str], output_dir: Path) -> None:
    if output_dir.exists():
        if not output_dir.is_dir():
            raise ValueError("output path exists and is not a directory")
        if any(output_dir.iterdir()):
            raise ValueError("output directory must be empty")
    else:
        output_dir.mkdir(parents=True)

    content = (
        "# AEGIS IDEA3 T5 repository-only render\n"
        f"interface={values['interface']}\n"
        f"ssid_label={values['ssid_label']}\n"
        f"channel={values['channel']}\n"
        f"country={values['country']}\n"
        f"ap_address={values['ap_address']}\n"
        f"ap_subnet={values['ap_subnet']}\n"
        f"dhcp_start={values['dhcp_start']}\n"
        f"dhcp_end={values['dhcp_end']}\n"
        f"broker_hostname={values['broker_hostname']}\n"
        "ap_psk=<AEGIS_AP_PSK>\n"
        "ipv4_method=manual\n"
        "ipv4_never_default=yes\n"
        "routing=disabled\n"
        "forwarding=disabled\n"
        "bridge=disabled\n"
    )

    (output_dir / "aegis-idea3-t5-render.txt").write_text(
        content,
        encoding="utf-8",
    )

    (output_dir / "aegis-idea3-ap.nmconnection").write_text(
        render_nm_profile(values),
        encoding="utf-8",
    )

    (output_dir / "aegis-idea3-dnsmasq.conf").write_text(
        render_dnsmasq_config(values),
        encoding="utf-8",
    )

    (output_dir / "aegis-idea3-dnsmasq.service").write_text(
        render_dnsmasq_service(),
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render repository-only IDEA3 T5 AP network material."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--interface", required=True)
    render_parser.add_argument("--ssid-label", required=True)
    render_parser.add_argument("--channel", required=True)
    render_parser.add_argument("--country", required=True)
    render_parser.add_argument("--ap-address", required=True)
    render_parser.add_argument("--ap-subnet", required=True)
    render_parser.add_argument("--dhcp-start", required=True)
    render_parser.add_argument("--dhcp-end", required=True)
    render_parser.add_argument("--broker-hostname", required=True)
    render_parser.add_argument("--output-dir", required=True, type=Path)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command != "render":
        parser.error("unsupported command")

    try:
        values = validate_inputs(args)
        render(values, args.output_dir)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
