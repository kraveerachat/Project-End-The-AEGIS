"""Contract tests for the isolated production-like acceptance driver."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

DRIVER_PATH = Path(__file__).resolve().parent.parent / "deploy" / "production-like-acceptance.py"
SPEC = importlib.util.spec_from_file_location("production_like_acceptance", DRIVER_PATH)
assert SPEC is not None and SPEC.loader is not None
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


def test_driver_requires_an_explicit_data_root():
    with pytest.raises(SystemExit):
        DRIVER.build_parser().parse_args([])


def test_driver_rejects_a_data_root_inside_the_source_tree(tmp_path):
    source_root = tmp_path / "source"
    source_root.mkdir()

    with pytest.raises(ValueError, match="outside the source tree"):
        DRIVER.validate_data_root(source_root / "runtime", source_root=source_root)


def test_driver_builds_a_non_actuating_production_web_environment(tmp_path):
    source_root = tmp_path / "source"
    data_root = tmp_path / "disposable data"
    source_root.mkdir()
    data_root.mkdir()

    environment = DRIVER.build_environment(
        source_root=source_root,
        data_root=data_root,
        node_executable=tmp_path / "node",
        web_port=18003,
        control_port=18103,
        session_secret="generated-value-not-for-output",
        password_hash="$2b$12$generated-value-not-for-output",
    )

    assert environment["NODE_ENV"] == "production"
    assert environment["AEGIS_PROFILE"] == "lab"
    assert environment["AEGIS_DRY_RUN"] == "1"
    assert environment["AEGIS_START_DETECTOR"] == "0"
    assert environment["AEGIS_VOICE_ENABLE"] == "0"
    assert environment["AEGIS_BROKER_IP"] == ""
    assert environment["AEGIS_IDEA1_STATUS_URL"] == ""
    assert environment["AEGIS_IDEA2_STATUS_URL"] == ""
    assert environment["AEGIS_DATA_DIR"] == str(data_root)
    assert Path(environment["AEGIS_IDEA3_AUDIT_DB_PATH"]).is_absolute()


def test_driver_contract_covers_auth_audit_restart_logout_and_cleanup():
    assert DRIVER.ACCEPTANCE_STEPS == (
        "health",
        "readiness",
        "login",
        "snapshot",
        "service-status",
        "audit-write",
        "audit-read",
        "stop",
        "restart",
        "audit-reopen",
        "logout",
        "clean-stop",
        "process-residue",
        "owner-only-permissions",
        "residue-check",
    )


def test_driver_starts_the_service_with_an_owner_only_umask(tmp_path, monkeypatch):
    captured = {}

    class Process:
        pass

    def popen(*_args, **kwargs):
        captured.update(kwargs)
        return Process()

    monkeypatch.setattr(DRIVER.subprocess, "Popen", popen)

    DRIVER._start_service(tmp_path, {"AEGIS_DATA_DIR": str(tmp_path / "data")})

    assert captured["umask"] == 0o077


def _write_stat(proc_root, pid, ppid, starttime, comm="python3"):
    directory = proc_root / str(pid)
    directory.mkdir(parents=True, exist_ok=True)
    fields = ["S", str(ppid), str(pid), *(["0"] * 16), str(starttime), *(["0"] * 5)]
    (directory / "stat").write_text(f"{pid} ({comm}) {' '.join(fields)}\n", encoding="utf-8")


def test_process_tree_follows_parent_links_across_new_sessions(tmp_path):
    proc_root = tmp_path / "proc"
    _write_stat(proc_root, 100, 1, 5000)
    _write_stat(proc_root, 101, 100, 5001, comm="node (web) x")
    _write_stat(proc_root, 102, 101, 5002)
    _write_stat(proc_root, 200, 1, 5003)
    (proc_root / "self").mkdir()

    assert DRIVER._process_tree(100, proc_root=proc_root) == {
        100: "5000",
        101: "5001",
        102: "5002",
    }


def test_surviving_processes_ignore_exited_and_reused_pids(tmp_path):
    proc_root = tmp_path / "proc"
    _write_stat(proc_root, 101, 100, 5001)
    _write_stat(proc_root, 102, 1, 9999)

    tree = {100: "5000", 101: "5001", 102: "5002"}

    assert DRIVER._surviving(tree, proc_root=proc_root) == [101]


def test_owner_only_check_reports_group_or_world_access(tmp_path):
    root = tmp_path / "data root"
    runtime = root / "runtime"
    runtime.mkdir(parents=True)
    root.chmod(0o700)
    runtime.chmod(0o700)
    status = runtime / "service-status.json"
    status.write_text("{}\n", encoding="utf-8")
    status.chmod(0o600)

    assert DRIVER._owner_only_violations(root) == []

    status.chmod(0o644)
    runtime.chmod(0o755)

    assert DRIVER._owner_only_violations(root) == ["runtime", "runtime/service-status.json"]


def test_honest_states_must_be_measured_absent_or_unknown():
    document = {
        "idea1": "NOT_CONFIGURED",
        "idea2": "NOT_CONFIGURED",
        "mqtt": "NOT_CONFIGURED",
        "esp32": "UNKNOWN",
        "physicalEvidence": "UNKNOWN",
        "status": "READY",
    }

    assert DRIVER._require_honest_states(document) == {
        "idea1": "NOT_CONFIGURED",
        "idea2": "NOT_CONFIGURED",
        "mqtt": "NOT_CONFIGURED",
        "esp32": "UNKNOWN",
        "physicalEvidence": "UNKNOWN",
    }
    for name, value in (
        ("mqtt", "CONNECTED"),
        ("esp32", "ONLINE"),
        ("physicalEvidence", "CONFIRMED"),
        ("idea1", "UNKNOWN"),
    ):
        with pytest.raises(DRIVER.AcceptanceFailure, match=name):
            DRIVER._require_honest_states({**document, name: value})
    with pytest.raises(DRIVER.AcceptanceFailure, match="idea2"):
        DRIVER._require_honest_states({k: v for k, v in document.items() if k != "idea2"})
