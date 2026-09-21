#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

BROKER_HOSTNAME = "mqtt.aegis.home.arpa"
CA_COMMON_NAME = "AEGIS IDEA3 MQTT CA"
CA_VALIDITY_DAYS = 1825

BROKER_EXTENSIONS = "\n".join(
    [
        f"subjectAltName=DNS:{BROKER_HOSTNAME}",
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
    ]
)


def _require_regular_file(path: Path, label: str) -> None:
    if path.is_symlink():
        raise ValueError(f"{label} must not be a symlink: {path}")
    if not path.is_file():
        raise ValueError(f"{label} must be a regular file: {path}")


def _run_openssl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["openssl", *args],
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        check=False,
    )


def render_broker_extensions(output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError("refusing to overwrite broker extension profile")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(BROKER_EXTENSIONS, encoding="utf-8")
    print("MQTT_PKI_EXTENSION_PROFILE=PASS")


def validate_broker_certificate(ca_file: Path, cert_file: Path) -> None:
    _require_regular_file(ca_file, "CA certificate")
    _require_regular_file(cert_file, "broker certificate")

    ca_subject = _run_openssl("x509", "-in", str(ca_file), "-noout", "-subject")
    if ca_subject.returncode != 0 or CA_COMMON_NAME not in ca_subject.stdout:
        raise RuntimeError("CA certificate subject does not match the approved IDEA3 MQTT CA profile")

    ca_text = _run_openssl("x509", "-in", str(ca_file), "-noout", "-text")
    if ca_text.returncode != 0 or "CA:TRUE" not in ca_text.stdout:
        raise RuntimeError("CA certificate is not a CA certificate")

    verify = _run_openssl(
        "verify",
        "-CAfile",
        str(ca_file),
        "-verify_hostname",
        BROKER_HOSTNAME,
        str(cert_file),
    )
    if verify.returncode != 0:
        raise RuntimeError("broker certificate chain or hostname verification failed")

    validity = _run_openssl("x509", "-in", str(cert_file), "-noout", "-checkend", "0")
    if validity.returncode != 0:
        raise RuntimeError("broker certificate is not currently valid")

    leaf_text = _run_openssl("x509", "-in", str(cert_file), "-noout", "-text")
    if leaf_text.returncode != 0:
        raise RuntimeError("broker certificate could not be inspected")
    if "CA:TRUE" in leaf_text.stdout or "CA:FALSE" not in leaf_text.stdout:
        raise RuntimeError("broker certificate must be a non-CA leaf")
    if "TLS Web Server Authentication" not in leaf_text.stdout:
        raise RuntimeError("broker certificate is missing serverAuth EKU")
    if f"DNS:{BROKER_HOSTNAME}" not in leaf_text.stdout:
        raise RuntimeError("broker certificate SAN does not match the approved hostname")

    san_out = _run_openssl("x509", "-in", str(cert_file), "-noout", "-ext", "subjectAltName")
    if san_out.returncode != 0:
        raise RuntimeError("broker certificate SAN extension missing or invalid")
    san_lines = [
        line.strip()
        for line in san_out.stdout.splitlines()
        if line.strip() and not line.strip().startswith("X509v3")
    ]
    san_entries = [entry.strip() for line in san_lines for entry in line.split(",") if entry.strip()]
    if any(entry.startswith("IP Address:") or entry.startswith("IP:") for entry in san_entries):
        raise RuntimeError("broker certificate profile violation: extra IP SAN detected")
    if san_entries != [f"DNS:{BROKER_HOSTNAME}"]:
        raise RuntimeError(
            f"broker certificate profile violation: expected exactly [DNS:{BROKER_HOSTNAME}], got {san_entries}"
        )

    print("MQTT_PKI_CHAIN=PASS")
    print("MQTT_PKI_HOSTNAME=PASS")
    print("MQTT_PKI_PROFILE=PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description="AEGIS IDEA3 PR11 MQTT PKI profile helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser("render-broker-ext")
    render.add_argument("--output", type=Path, required=True)

    validate = subparsers.add_parser("validate-broker-cert")
    validate.add_argument("--ca-file", type=Path, required=True)
    validate.add_argument("--cert-file", type=Path, required=True)

    args = parser.parse_args()

    try:
        if args.command == "render-broker-ext":
            render_broker_extensions(args.output)
            return 0
        if args.command == "validate-broker-cert":
            validate_broker_certificate(args.ca_file, args.cert_file)
            return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
