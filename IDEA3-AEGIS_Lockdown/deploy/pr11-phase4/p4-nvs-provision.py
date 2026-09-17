#!/usr/bin/env python3

import argparse
import csv
import hashlib
import io
import os
import re
import stat
from pathlib import Path

"""Repository-safe IDEA3 NVS provisioning material tool."""

NVS_NAMESPACE = "aegis-p1"
NVS_SCHEMA_VERSION = 1

DEVICE_ID = "aegis-relay-01"
BROKER_HOST = "mqtt.aegis.home.arpa"
MQTT_USER = "idea3-dev-aegis-relay-01"
SEQ_HI_INITIAL = 0

NVS_KEYS = (
    "schema",
    "device_id",
    "wifi_ssid",
    "wifi_psk",
    "broker",
    "mqtt_user",
    "mqtt_pass",
    "ntp",
    "k_c2d",
    "k_d2c",
    "seq_hi",
)


def validate_profile(wifi_ssid: str, ntp: str) -> dict[str, object]:
    wifi_ssid = wifi_ssid.strip()
    ntp = ntp.strip()

    if not wifi_ssid:
        raise ValueError("wifi_ssid is required")
    if not ntp:
        raise ValueError("ntp is required")

    return {
        "schema": NVS_SCHEMA_VERSION,
        "device_id": DEVICE_ID,
        "wifi_ssid": wifi_ssid,
        "broker": BROKER_HOST,
        "mqtt_user": MQTT_USER,
        "ntp": ntp,
        "seq_hi": SEQ_HI_INITIAL,
    }


def read_secret_file(path: Path) -> str:
    path = Path(path)
    metadata = path.lstat()

    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("secret must be a regular file")

    if metadata.st_mode & 0o077:
        raise ValueError("secret file permissions must not allow group or other access")

    value = path.read_text(encoding="utf-8")
    if value.endswith("\n"):
        value = value[:-1]

    if not value:
        raise ValueError("secret file is empty")

    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError("secret must contain exactly one line")

    return value


LEGACY_DEMO_SECRET = b"AEGIS-DEMO-SHARED-SECRET-change-me"

FORBIDDEN_PROTOCOL_KEYS = {
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    hashlib.sha256(LEGACY_DEMO_SECRET).hexdigest(),
    LEGACY_DEMO_SECRET[:32].hex(),
}


def validate_protocol_keys(c2d_hex: str, d2c_hex: str) -> tuple[bytes, bytes]:
    pattern = re.compile(r"[0-9a-f]{64}")

    for name, value in (("k_c2d", c2d_hex), ("k_d2c", d2c_hex)):
        if pattern.fullmatch(value) is None:
            raise ValueError(f"{name} must be exactly 64 lowercase hex characters")
        if value in FORBIDDEN_PROTOCOL_KEYS:
            raise ValueError(f"{name} must not use unsafe demo/test key material")

    c2d = bytes.fromhex(c2d_hex)
    d2c = bytes.fromhex(d2c_hex)

    if not any(c2d) or not any(d2c):
        raise ValueError("protocol keys must be non-zero")

    if c2d == d2c:
        raise ValueError("protocol keys must be independent")

    return c2d, d2c


def render_nvs_csv(rows: dict[str, object], output: Path) -> None:
    output = Path(output)

    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")

    writer.writerow(["key", "type", "encoding", "value"])
    writer.writerow([NVS_NAMESPACE, "namespace", "", ""])

    encodings = {
        "schema": "u32",
        "device_id": "string",
        "wifi_ssid": "string",
        "wifi_psk": "string",
        "broker": "string",
        "mqtt_user": "string",
        "mqtt_pass": "string",
        "ntp": "string",
        "k_c2d": "hex2bin",
        "k_d2c": "hex2bin",
        "seq_hi": "u64",
    }

    for key in NVS_KEYS:
        value = rows[key]
        encoding = encodings[key]

        if isinstance(value, bytes):
            value = value.hex()

        writer.writerow([key, "data", encoding, value])

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    fd = os.open(output, flags, 0o600)

    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(buffer.getvalue())
    except Exception:
        try:
            output.unlink()
        except FileNotFoundError:
            pass
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Render repository-safe IDEA3 ESP32 NVS provisioning CSV."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser("render")
    render.add_argument("--wifi-ssid", required=True)
    render.add_argument("--ntp", required=True)
    render.add_argument("--wifi-psk-file", type=Path, required=True)
    render.add_argument("--mqtt-password-file", type=Path, required=True)
    render.add_argument("--k-c2d-file", type=Path, required=True)
    render.add_argument("--k-d2c-file", type=Path, required=True)
    render.add_argument("--output", type=Path, required=True)

    return parser


def main() -> int:
    args = build_parser().parse_args()

    if args.command != "render":
        raise ValueError("unsupported command")

    profile = validate_profile(args.wifi_ssid, args.ntp)

    wifi_psk = read_secret_file(args.wifi_psk_file)
    mqtt_password = read_secret_file(args.mqtt_password_file)
    k_c2d_hex = read_secret_file(args.k_c2d_file)
    k_d2c_hex = read_secret_file(args.k_d2c_file)

    k_c2d, k_d2c = validate_protocol_keys(k_c2d_hex, k_d2c_hex)

    rows = dict(profile)
    rows["wifi_psk"] = wifi_psk
    rows["mqtt_pass"] = mqtt_password
    rows["k_c2d"] = k_c2d
    rows["k_d2c"] = k_d2c

    render_nvs_csv(rows, args.output)
    print(f"NVS_CSV_WRITTEN={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
