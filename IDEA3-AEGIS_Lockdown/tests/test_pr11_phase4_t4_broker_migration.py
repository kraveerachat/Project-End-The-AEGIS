from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy/pr11-phase4/p4-broker-migration.py"
UNIT = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.service.example"
ACL = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.acl.example"

AP = "10.77.0.1"
UPLINK = "192.0.2.10"
CA = "/etc/aegis-idea3/mqtt/ca.crt"
CERT = "/etc/aegis-idea3/mqtt/broker.crt"
KEY = "/etc/aegis-idea3/mqtt/broker.key"
PASSWD = "/etc/aegis-idea3/mqtt/passwd"
ACL_PATH = "/etc/aegis-idea3/mqtt/acl"


def run_render(tmp_path: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render",
            "--ap-address",
            AP,
            "--uplink-address",
            UPLINK,
            "--ca-file",
            CA,
            "--cert-file",
            CERT,
            "--key-file",
            KEY,
            "--password-file",
            PASSWD,
            "--acl-file",
            ACL_PATH,
            "--output-dir",
            str(tmp_path),
            *extra,
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def test_t4_separate_instance_artifacts_exist() -> None:
    assert SCRIPT.is_file()
    assert UNIT.is_file()


def test_t4_example_unit_directly_launches_only_idea3_mosquitto() -> None:
    text = UNIT.read_text(encoding="utf-8")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    exec_start = [line for line in lines if line.startswith("ExecStart=")]
    assert len(exec_start) == 1
    assert "mosquitto" in exec_start[0]
    assert "-c" in exec_start[0]
    assert "aegis-idea3" in exec_start[0]
    assert not any("systemctl" in line for line in lines)
    assert not any(
        line.startswith(("Requires=", "Wants=", "PartOf="))
        and "mosquitto.service" in line
        for line in lines
    )


def test_t4_render_is_deterministic_and_8883_only(tmp_path: Path) -> None:
    one = tmp_path / "one"
    two = tmp_path / "two"
    one.mkdir()
    two.mkdir()

    first = run_render(one)
    second = run_render(two)
    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr

    conf1 = (one / "aegis-idea3-mosquitto.conf").read_text(encoding="utf-8")
    conf2 = (two / "aegis-idea3-mosquitto.conf").read_text(encoding="utf-8")
    contract1 = (one / "aegis-idea3-t4-contract.txt").read_text(encoding="utf-8")
    contract2 = (two / "aegis-idea3-t4-contract.txt").read_text(encoding="utf-8")

    assert conf1 == conf2
    assert contract1 == contract2
    assert f"listener 8883 127.0.0.1" in conf1
    assert f"listener 8883 {AP}" in conf1
    assert "listener 1883" not in conf1
    assert "listener 8883 0.0.0.0" not in conf1
    assert "listener 8883 ::" not in conf1
    assert UPLINK not in conf1
    assert "/etc/mosquitto/passwd" not in conf1
    assert "<AEGIS_" not in conf1
    assert "PRODUCTION_MUTATION=NO" in contract1
    assert "L6A=NOT RUN" in contract1
    assert "L6B=NOT RUN" in contract1
    assert "LEGACY_1883=UNCHANGED" in contract1


def test_t4_rejects_wildcard_ap_bind(tmp_path: Path) -> None:
    assert SCRIPT.is_file()
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render",
            "--ap-address",
            "0.0.0.0",
            "--uplink-address",
            UPLINK,
            "--ca-file",
            CA,
            "--cert-file",
            CERT,
            "--key-file",
            KEY,
            "--password-file",
            PASSWD,
            "--acl-file",
            ACL_PATH,
            "--output-dir",
            str(tmp_path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0


def test_t4_rejects_ap_equal_to_uplink(tmp_path: Path) -> None:
    assert SCRIPT.is_file()
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render",
            "--ap-address",
            UPLINK,
            "--uplink-address",
            UPLINK,
            "--ca-file",
            CA,
            "--cert-file",
            CERT,
            "--key-file",
            KEY,
            "--password-file",
            PASSWD,
            "--acl-file",
            ACL_PATH,
            "--output-dir",
            str(tmp_path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0


def test_t4_rejects_legacy_password_database(tmp_path: Path) -> None:
    assert SCRIPT.is_file()
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "render",
            "--ap-address",
            AP,
            "--uplink-address",
            UPLINK,
            "--ca-file",
            CA,
            "--cert-file",
            CERT,
            "--key-file",
            KEY,
            "--password-file",
            "/etc/mosquitto/passwd",
            "--acl-file",
            ACL_PATH,
            "--output-dir",
            str(tmp_path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0


def test_t4_idea3_acl_has_no_legacy_aegis_identity() -> None:
    users = [
        line.split(maxsplit=1)[1]
        for line in ACL.read_text(encoding="utf-8").splitlines()
        if line.startswith("user ")
    ]
    assert "aegis" not in users
    assert "idea3-core" in users
    assert any(user.startswith("idea3-dev-") for user in users)


def test_t4_renderer_contains_no_live_mutation_commands() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    forbidden = (
        "systemctl",
        "pacman ",
        "apt ",
        "dnf ",
        "nft ",
        "nmcli ",
        "rfkill ",
        "timedatectl ",
    )
    assert not any(token in text for token in forbidden)
