#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 T6 repository-only local NTP renderer."""

from __future__ import annotations

import argparse
import ipaddress
from pathlib import Path

TEMPLATE = (
    Path(__file__).resolve().parents[1]
    / "chrony"
    / "aegis-idea3-chrony.conf.example"
)
CONFIG_NAME = "aegis-idea3-chrony.conf"
CONTRACT_NAME = "aegis-idea3-t6-contract.txt"


def _validated_ap(
    parser: argparse.ArgumentParser,
    ap_address: str,
    ap_subnet: str,
) -> tuple[ipaddress.IPv4Address, ipaddress.IPv4Network]:
    try:
        address = ipaddress.IPv4Address(ap_address)
    except ipaddress.AddressValueError:
        parser.error("--ap-address must be a valid IPv4 address")

    try:
        network = ipaddress.IPv4Network(ap_subnet, strict=True)
    except (ipaddress.AddressValueError, ipaddress.NetmaskValueError):
        parser.error("--ap-subnet must be a canonical IPv4 network")

    if address.is_unspecified:
        parser.error("--ap-address must not be a wildcard address")

    if network.prefixlen == 0:
        parser.error("--ap-subnet must not be a wildcard network")

    if address not in network:
        parser.error("--ap-address must belong to --ap-subnet")

    if address in {network.network_address, network.broadcast_address}:
        parser.error("--ap-address must be a usable host address")

    return address, network


def _validated_upstream(
    parser: argparse.ArgumentParser,
    value: str,
) -> str:
    if not value or value != value.strip():
        parser.error("--trusted-upstream must be one non-empty token")

    if any(char.isspace() for char in value):
        parser.error("--trusted-upstream must not contain whitespace")

    if not all(char.isalnum() or char in ".-" for char in value):
        parser.error("--trusted-upstream contains unsafe characters")

    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        hostname = value.removesuffix(".")

        if not hostname or len(hostname) > 253:
            parser.error(
                "--trusted-upstream must be a valid hostname or IPv4 address"
            )

        for label in hostname.split("."):
            if (
                not label
                or len(label) > 63
                or label.startswith("-")
                or label.endswith("-")
                or not label.isascii()
                or not all(char.isalnum() or char == "-" for char in label)
            ):
                parser.error(
                    "--trusted-upstream must be a valid hostname or IPv4 address"
                )
    else:
        if address.is_unspecified or address.is_multicast:
            parser.error("--trusted-upstream must identify one usable source")

    return value



def _prepare_output_dir(
    parser: argparse.ArgumentParser,
    output_dir: Path,
) -> None:
    if output_dir.exists():
        if not output_dir.is_dir():
            parser.error("--output-dir exists and is not a directory")

        if any(output_dir.iterdir()):
            parser.error("--output-dir must be absent or empty")

        return

    try:
        output_dir.mkdir()
    except OSError as exc:
        parser.error(f"unable to create --output-dir: {exc}")



def _render(
    args: argparse.Namespace,
    parser: argparse.ArgumentParser,
) -> int:
    address, network = _validated_ap(
        parser,
        args.ap_address,
        args.ap_subnet,
    )
    upstream = _validated_upstream(
        parser,
        args.trusted_upstream,
    )

    template = TEMPLATE.read_text(encoding="utf-8")
    config = (
        template
        .replace("<AEGIS_TRUSTED_NTP_UPSTREAM>", upstream)
        .replace("<AEGIS_AP_ADDRESS>", str(address))
        .replace("<AEGIS_AP_SUBNET>", str(network))
    )

    if "<AEGIS_" in config:
        parser.error("rendered configuration contains unresolved placeholders")

    output_dir = args.output_dir
    _prepare_output_dir(parser, output_dir)

    (output_dir / CONFIG_NAME).write_text(
        config,
        encoding="utf-8",
    )

    contract = (
        "T6_REPOSITORY_RENDER=YES\n"
        "PRODUCTION_MUTATION=NO\n"
        "NTP_SERVER_LIVE=NO\n"
        "TIMESYNCD_HANDOFF_LIVE=NO\n"
        "L5=NOT_RUN\n"
        f"AP_ADDRESS={address}\n"
        f"AP_SUBNET={network}\n"
        f"TRUSTED_UPSTREAM={upstream}\n"
    )
    (output_dir / CONTRACT_NAME).write_text(
        contract,
        encoding="utf-8",
    )

    return 0



def _validate(
    args: argparse.Namespace,
    parser: argparse.ArgumentParser,
) -> int:
    input_dir = args.input_dir

    if not input_dir.is_dir():
        parser.error("--input-dir must be an existing directory")

    config_path = input_dir / CONFIG_NAME
    contract_path = input_dir / CONTRACT_NAME

    if not config_path.is_file() or not contract_path.is_file():
        parser.error("--input-dir is missing required T6 artifacts")

    config = config_path.read_text(encoding="utf-8")
    contract = contract_path.read_text(encoding="utf-8")

    if "<AEGIS_" in config:
        parser.error("configuration contains unresolved placeholders")

    required_contract = {
        "T6_REPOSITORY_RENDER=YES",
        "PRODUCTION_MUTATION=NO",
        "NTP_SERVER_LIVE=NO",
        "TIMESYNCD_HANDOFF_LIVE=NO",
        "L5=NOT_RUN",
    }

    if not required_contract <= set(contract.splitlines()):
        parser.error("T6 contract is missing required repository/live-state fields")

    return 0



def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render AEGIS IDEA3 T6 repository-only NTP artifacts."
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
    )

    render_parser = subparsers.add_parser(
        "render",
        help="Render repository-safe T6 NTP artifacts.",
    )
    render_parser.add_argument(
        "--ap-address",
        required=True,
    )
    render_parser.add_argument(
        "--ap-subnet",
        required=True,
    )
    render_parser.add_argument(
        "--trusted-upstream",
        required=True,
    )
    render_parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
    )

    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate repository-rendered T6 NTP artifacts.",
    )
    validate_parser.add_argument(
        "--input-dir",
        required=True,
        type=Path,
    )

    args = parser.parse_args()

    if args.command == "render":
        return _render(args, parser)

    if args.command == "validate":
        return _validate(args, parser)

    parser.error("unsupported command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
