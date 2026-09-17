#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ACL_TEMPLATE = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.acl.example"

DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")


def validate_device_id(device_id: str) -> None:
    if not DEVICE_ID_RE.fullmatch(device_id):
        raise ValueError(
            "device_id must be 3-32 chars of lowercase a-z, 0-9, or '-', "
            "and must start/end with an alphanumeric character"
        )


def render_acl(device_id: str, output: Path) -> None:
    validate_device_id(device_id)
    template = ACL_TEMPLATE.read_text(encoding="utf-8")
    rendered = template.replace("device-id", device_id)
    output.write_text(rendered, encoding="utf-8")


def read_secret(path: Path) -> str:
    metadata = path.stat()

    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("secret path must be a regular file")

    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o077:
        raise ValueError("secret file must not grant group or other permissions")

    value = path.read_text(encoding="utf-8")
    if value.endswith("\n"):
        value = value[:-1]
    if not value:
        raise ValueError("secret file must not be empty")
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError("secret file must contain exactly one non-empty line")
    return value


def build_password_db(
    device_id: str,
    core_password_file: Path,
    device_password_file: Path,
    output: Path,
) -> None:
    validate_device_id(device_id)

    core_password = read_secret(core_password_file)
    device_password = read_secret(device_password_file)

    if output.exists() or output.is_symlink():
        raise ValueError("refusing to overwrite existing password database")

    output.parent.mkdir(parents=True, exist_ok=True)

    fd, temporary_name = tempfile.mkstemp(
        prefix=".aegis-mqtt-passwd-",
        dir=output.parent,
        text=True,
    )
    temporary = Path(temporary_name)

    try:
        os.fchmod(fd, 0o600)

        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"idea3-core:{core_password}\n")
            handle.write(f"idea3-dev-{device_id}:{device_password}\n")

        result = subprocess.run(
            ["mosquitto_passwd", "-U", str(temporary)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError("mosquitto_passwd failed to hash password database")

        os.chmod(temporary, 0o600)
        os.replace(temporary, output)
        os.chmod(output, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser("render-acl")
    render.add_argument("--device-id", required=True)
    render.add_argument("--output", type=Path, required=True)

    password_db = subparsers.add_parser("build-password-db")
    password_db.add_argument("--device-id", required=True)
    password_db.add_argument("--core-password-file", type=Path, required=True)
    password_db.add_argument("--device-password-file", type=Path, required=True)
    password_db.add_argument("--output", type=Path, required=True)

    args = parser.parse_args()

    try:
        if args.command == "render-acl":
            render_acl(args.device_id, args.output)
            return 0

        if args.command == "build-password-db":
            build_password_db(
                args.device_id,
                args.core_password_file,
                args.device_password_file,
                args.output,
            )
            return 0
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
