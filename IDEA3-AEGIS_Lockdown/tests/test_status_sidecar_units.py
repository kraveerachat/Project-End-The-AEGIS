"""Static review of the two sidecar unit templates (nothing is installed, enabled or started; no systemd call is made)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
UNITS = {"publisher": DEPLOY / "aegis-idea3-status-publisher.service.example", "push": DEPLOY / "aegis-idea3-status-push.service.example"}
SIDECAR = "/opt/aegis-idea3-status/current"


def parse(path: Path) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    section = ""
    text = re.sub(r"\\\n\s*", " ", path.read_text(encoding="utf-8"))
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line
            continue
        key, _, value = line.partition("=")
        values.setdefault(f"{section}{key}", []).append(value)
    return values


@pytest.fixture(params=sorted(UNITS))
def unit(request):
    return request.param, parse(UNITS[request.param]), UNITS[request.param].read_text(encoding="utf-8")


def one(values, key):
    assert len(values[key]) == 1, key
    return values[key][0]


def test_no_install_section_so_nothing_can_be_enabled_at_boot(unit) -> None:
    _, values, text = unit
    assert not any(key.startswith("[Install]") for key in values)
    assert "[Install]" not in re.sub(r"^#.*$", "", text, flags=re.MULTILINE)
    assert "NOT INSTALLED" in text


def test_runs_from_the_sidecar_with_isolated_python_never_from_the_core_release(unit) -> None:
    _, values, text = unit
    assert one(values, "[Service]WorkingDirectory") == SIDECAR
    exec_start = one(values, "[Service]ExecStart")
    assert exec_start.startswith("/usr/bin/python3 -E -s -B -m tools.")
    assert "/opt/aegis-idea3/" not in "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    assert "venv" not in exec_start


def test_unprivileged_with_no_capabilities_and_a_locked_down_sandbox(unit) -> None:
    _, values, _ = unit
    assert one(values, "[Service]User") == "aegis-idea3" and one(values, "[Service]User") != "root"
    assert one(values, "[Service]NoNewPrivileges") == "true"
    assert one(values, "[Service]CapabilityBoundingSet") == ""
    for key in ("PrivateTmp", "ProtectSystem", "ProtectHome", "LockPersonality", "MemoryDenyWriteExecute", "RestrictNamespaces",
                "PrivateDevices", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectControlGroups",
                "RestrictRealtime", "RestrictSUIDSGID", "ProtectClock", "ProtectHostname"):
        assert one(values, f"[Service]{key}") in {"true", "strict"}, key
    assert one(values, "[Service]ProtectSystem") == "strict"
    assert one(values, "[Service]SystemCallFilter") == "@system-service"
    assert one(values, "[Service]SystemCallArchitectures") == "native" and one(values, "[Service]UMask") == "0077"


def test_core_status_is_read_only_and_the_sidecar_tree_is_read_only(unit) -> None:
    _, values, _ = unit
    read_only = " ".join(values["[Service]ReadOnlyPaths"]).split()
    assert "/run/aegis-idea3" in read_only and "/opt/aegis-idea3-status" in read_only
    writable = " ".join(values.get("[Service]ReadWritePaths", [])).split()
    assert "/run/aegis-idea3" not in writable and "/opt" not in " ".join(writable)


def test_publisher_writes_only_its_own_runtime_directory_and_has_no_network() -> None:
    values = parse(UNITS["publisher"])
    assert one(values, "[Service]RuntimeDirectory") == "aegis-idea3-status" and one(values, "[Service]RuntimeDirectoryMode") == "0750"
    assert one(values, "[Service]ReadWritePaths") == "/run/aegis-idea3-status"
    assert one(values, "[Service]RestrictAddressFamilies") == "AF_UNIX" and one(values, "[Service]IPAddressDeny") == "any"
    assert one(values, "[Service]Group") == "<AEGIS_STATUS_GROUP>", "the dedicated group is an owner decision and stays a placeholder"
    assert "--dest-dir /run/aegis-idea3-status" in one(values, "[Service]ExecStart")


def test_pusher_has_network_only_for_ip_families_no_write_path_and_reads_credentials_by_path() -> None:
    values = parse(UNITS["push"])
    assert one(values, "[Service]RestrictAddressFamilies") == "AF_INET AF_INET6"
    assert "[Service]ReadWritePaths" not in values and "[Service]RuntimeDirectory" not in values
    assert one(values, "[Service]EnvironmentFile") == "/etc/aegis-idea3/status-push.env"
    assert "/etc/aegis-idea3/pki" in " ".join(values["[Service]ReadOnlyPaths"]).split()
    assert "KEY" not in "\n".join(UNITS["push"].read_text().splitlines()).replace("AEGIS_CORE_STATUS_PUSH_CLIENT_KEY", "")


def test_units_can_fail_independently_of_the_core_service(unit) -> None:
    _, values, text = unit
    for key in ("Requires", "BindsTo", "PartOf", "Requisite", "Upholds", "OnFailure", "Conflicts"):
        assert f"[Unit]{key}" not in values, key
    assert not any("aegis-idea3-core" in v for v in values.get("[Unit]Wants", []))
    assert "aegis-idea3-core.service" in " ".join(values["[Unit]After"])
    body = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    for word in ("systemctl", "ExecStop", "ExecStartPost", "ExecStartPre", "ExecReload", "BindsTo"):
        assert word not in body, word


def test_restart_behaviour_is_bounded_and_shutdown_is_prompt(unit) -> None:
    _, values, _ = unit
    assert one(values, "[Service]Restart") == "on-failure"
    assert int(one(values, "[Service]RestartSec")) >= 5
    assert int(one(values, "[Unit]StartLimitBurst")) <= 5 and int(one(values, "[Unit]StartLimitIntervalSec")) >= 300
    assert int(one(values, "[Service]TimeoutStopSec")) <= 10
    assert one(values, "[Service]Type") == "simple"


def test_both_programs_exit_cleanly_on_sigterm() -> None:
    root = Path(__file__).resolve().parents[1] / "tools"
    for name in ("status_projection_publisher.py", "status_push_client.py"):
        text = (root / name).read_text()
        assert "signal.SIGTERM" in text, name


def test_no_unit_or_installer_script_enables_or_starts_anything() -> None:
    for path in [*UNITS.values(), DEPLOY / "status-sidecar" / "install-status-sidecar.py", DEPLOY / "status-sidecar" / "build-status-sidecar.py"]:
        code = "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))
        for word in ("systemctl enable", "systemctl start", "systemctl restart", "daemon-reload", "WantedBy"):
            assert word not in code, (path.name, word)
