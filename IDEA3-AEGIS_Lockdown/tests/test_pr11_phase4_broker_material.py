from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy/pr11-phase4/p4-broker-material.py"
ACL_TEMPLATE = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.acl.example"


def test_render_acl_materializes_exact_device_identity(tmp_path: Path) -> None:
    output = tmp_path / "aegis-idea3.acl"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render-acl",
            "--device-id",
            "aegis-relay-01",
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr

    expected = ACL_TEMPLATE.read_text(encoding="utf-8").replace(
        "device-id",
        "aegis-relay-01",
    )
    rendered = output.read_text(encoding="utf-8")

    assert rendered == expected
    assert "device-id" not in rendered
    assert "user idea3-dev-aegis-relay-01" in rendered
    assert "aegis/idea3/v1/aegis-relay-01/command" in rendered


def test_render_acl_rejects_invalid_device_id_without_writing(tmp_path: Path) -> None:
    output = tmp_path / "aegis-idea3.acl"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render-acl",
            "--device-id",
            "BAD_DEVICE!",
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert not output.exists()


def test_build_password_db_reads_secrets_from_files_without_leaking(tmp_path: Path) -> None:
    import os
    import stat

    core_secret = "core-test-secret-do-not-leak"
    device_secret = "device-test-secret-do-not-leak"

    core_file = tmp_path / "core.pass"
    device_file = tmp_path / "device.pass"
    output = tmp_path / "passwords"

    core_file.write_text(core_secret + "\n", encoding="utf-8")
    device_file.write_text(device_secret + "\n", encoding="utf-8")
    os.chmod(core_file, 0o600)
    os.chmod(device_file, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_file),
            "--device-password-file",
            str(device_file),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert output.exists()

    database = output.read_text(encoding="utf-8")
    assert "idea3-core:" in database
    assert "idea3-dev-aegis-relay-01:" in database

    assert core_secret not in database
    assert device_secret not in database
    assert core_secret not in result.stdout
    assert core_secret not in result.stderr
    assert device_secret not in result.stdout
    assert device_secret not in result.stderr

    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def test_build_password_db_rejects_group_readable_secret_file(tmp_path: Path) -> None:
    import os

    core_file = tmp_path / "core.pass"
    device_file = tmp_path / "device.pass"
    output = tmp_path / "passwords"

    core_file.write_text("core-test-secret\n", encoding="utf-8")
    device_file.write_text("device-test-secret\n", encoding="utf-8")

    os.chmod(core_file, 0o640)
    os.chmod(device_file, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_file),
            "--device-password-file",
            str(device_file),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert not output.exists()


def test_build_password_db_refuses_to_overwrite_existing_output(tmp_path: Path) -> None:
    import os

    core_file = tmp_path / "core.pass"
    device_file = tmp_path / "device.pass"
    output = tmp_path / "passwords"

    core_file.write_text("core-test-secret\n", encoding="utf-8")
    device_file.write_text("device-test-secret\n", encoding="utf-8")
    os.chmod(core_file, 0o600)
    os.chmod(device_file, 0o600)

    sentinel = "DO-NOT-OVERWRITE\n"
    output.write_text(sentinel, encoding="utf-8")
    os.chmod(output, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_file),
            "--device-password-file",
            str(device_file),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert output.read_text(encoding="utf-8") == sentinel
