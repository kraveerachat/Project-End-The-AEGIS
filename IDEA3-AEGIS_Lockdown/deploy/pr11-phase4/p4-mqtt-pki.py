#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BROKER_HOSTNAME = "mqtt.aegis.home.arpa"
CA_COMMON_NAME = "AEGIS IDEA3 MQTT CA"
CA_VALIDITY_DAYS = 1825
# Broker leaf algorithm floor (P-256/P-384/P-521 or RSA >= 2048, SHA-2 signature) and lifetime ceiling.
APPROVED_CURVES = ("prime256v1", "secp384r1", "secp521r1")
MIN_RSA_BITS = 2048
APPROVED_SIGNATURE_DIGESTS = ("sha256", "sha384", "sha512")

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


def _check_algorithms_and_lifetime(cert_file: Path, leaf_text: str) -> None:
    key_line = re.search(r"Public Key Algorithm:\s*(\S+)", leaf_text)
    algorithm = key_line.group(1) if key_line else ""
    if algorithm == "rsaEncryption":
        bits = re.search(r"Public-Key:\s*\((\d+) bit\)", leaf_text)
        if not bits or int(bits.group(1)) < MIN_RSA_BITS:
            raise RuntimeError(f"broker certificate uses a weak RSA key (minimum {MIN_RSA_BITS} bits)")
    elif algorithm == "id-ecPublicKey":
        curve = re.search(r"ASN1 OID:\s*(\S+)", leaf_text)
        if not curve or curve.group(1) not in APPROVED_CURVES:
            raise RuntimeError("broker certificate uses a weak or unsupported EC curve")
    else:
        raise RuntimeError("broker certificate uses an unsupported key algorithm (weak or unknown)")

    sig = re.search(r"Signature Algorithm:\s*(\S+)", leaf_text)
    sig_name = sig.group(1).lower() if sig else ""
    if not any(digest in sig_name for digest in APPROVED_SIGNATURE_DIGESTS):
        raise RuntimeError("broker certificate signature digest is not approved (weak or unknown)")

    dates = _run_openssl("x509", "-in", str(cert_file), "-noout", "-dates")
    found = dict(re.findall(r"(notBefore|notAfter)=(.+)", dates.stdout))
    try:
        fmt = "%b %d %H:%M:%S %Y %Z"
        start = datetime.strptime(found["notBefore"].strip(), fmt).replace(tzinfo=timezone.utc)
        end = datetime.strptime(found["notAfter"].strip(), fmt).replace(tzinfo=timezone.utc)
    except (KeyError, ValueError) as exc:
        raise RuntimeError("broker certificate validity dates could not be read") from exc
    if (end - start).days > CA_VALIDITY_DAYS:
        raise RuntimeError(f"broker certificate lifetime exceeds {CA_VALIDITY_DAYS} days")


def validate_key_matches_certificate(cert_file: Path, key_file: Path) -> None:
    if key_file.is_symlink():
        raise ValueError(f"broker key must not be a symlink: {key_file}")
    if not key_file.is_file():
        raise ValueError(f"broker key must be a regular file: {key_file}")
    mode = stat.S_IMODE(key_file.stat().st_mode)
    if mode not in (0o600, 0o400):
        raise ValueError(f"broker key file mode {oct(mode)} invalid: must be exact mode 0600 or 0400")
    from_key = _run_openssl("pkey", "-in", str(key_file), "-pubout")
    from_cert = _run_openssl("x509", "-in", str(cert_file), "-noout", "-pubkey")
    if from_key.returncode != 0 or from_cert.returncode != 0 or not from_key.stdout.strip():
        raise RuntimeError("broker key could not be parsed")
    if from_key.stdout != from_cert.stdout:
        raise RuntimeError("broker key does not match the certificate (key/cert mismatch)")
    print("MQTT_PKI_KEY_MATCH=PASS")


def validate_broker_certificate(ca_file: Path, cert_file: Path, key_file: Path | None = None) -> None:
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

    _check_algorithms_and_lifetime(cert_file, leaf_text.stdout)
    if key_file is not None:
        validate_key_matches_certificate(cert_file, key_file)

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
    validate.add_argument("--key-file", type=Path, default=None)

    args = parser.parse_args()

    try:
        if args.command == "render-broker-ext":
            render_broker_extensions(args.output)
            return 0
        if args.command == "validate-broker-cert":
            validate_broker_certificate(args.ca_file, args.cert_file, args.key_file)
            return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
