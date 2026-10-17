"""Fail-closed contracts for the read-only Python Desktop observer."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from aegis_soc.observer import (
    UNKNOWN,
    ObserverEvidence,
    read_observer_status,
)


def _status(**changes):
    value = {
        "state": "LOCKDOWN",
        "profile": "production",
        "dry_run": False,
        "auto_contain": True,
        "broker": "CONNECTED",
        "device": "ONLINE",
        "uplink": "LOCKDOWN",
        "armed": "ARMED",
        "dispatch": "ACTIVE",
        "time_trust": "SYNCED",
        "updated_at": 1_700_000_000.0,
        "components": {"detector": "RUNNING", "gui": "STOPPED"},
    }
    value.update(changes)
    return value


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def test_fresh_status_projects_only_allowlisted_core_evidence(tmp_path):
    path = tmp_path / "status.json"
    _write(path, _status(secret="must not escape"))

    evidence = read_observer_status(path, now=1_700_000_030.0)

    assert isinstance(evidence, ObserverEvidence)
    assert evidence.valid is True
    assert evidence.freshness == "FRESH"
    assert evidence.runtime_state == "LOCKDOWN"
    assert evidence.broker == "CONNECTED"
    assert evidence.device == "ONLINE"
    assert evidence.uplink == "LOCKDOWN"
    assert evidence.trusted_time == "SYNCED"
    assert evidence.dispatch == "ACTIVE"
    assert evidence.allowlisted == {"state", "profile", "dry_run", "auto_contain", "broker", "device", "uplink", "armed", "dispatch", "time_trust", "updated_at", "components"}
    assert "secret" not in evidence.__dict__


def test_missing_status_fails_closed(tmp_path):
    evidence = read_observer_status(tmp_path / "missing.json", now=1_700_000_030.0)

    assert evidence.valid is False
    assert evidence.freshness == "MISSING"
    assert evidence.runtime_state == UNKNOWN
    assert evidence.broker == UNKNOWN
    assert evidence.uplink == UNKNOWN
    assert evidence.physical_verification == "NOT_VERIFIED"


def _forbid_subprocess(monkeypatch):
    """Any process spawn from the status reader is a failure."""
    import os

    def spawn(*_args, **_kwargs):
        raise AssertionError("the status reader must not start a subprocess")

    for owner, name in (
        (subprocess, "run"), (subprocess, "Popen"), (subprocess, "call"),
        (subprocess, "check_call"), (subprocess, "check_output"),
        (os, "system"), (os, "popen"), (os, "execv"), (os, "execvp"),
    ):
        monkeypatch.setattr(owner, name, spawn)


def test_permission_denied_never_starts_sudo_or_any_subprocess(monkeypatch):
    from aegis_soc import observer

    _forbid_subprocess(monkeypatch)

    def denied(*_args, **_kwargs):
        raise PermissionError("status directory is not traversable")

    monkeypatch.setattr(Path, "open", denied)
    monkeypatch.setattr(Path, "read_text", denied)
    monkeypatch.setattr("os.open", denied)

    evidence = observer.read_observer_status(observer.STATUS_PATH, now=1_700_000_030.0)

    assert evidence.valid is False
    assert evidence.freshness == "UNAVAILABLE"
    assert "permission" in evidence.reason.lower()
    assert evidence.runtime_state == UNKNOWN
    assert evidence.broker == UNKNOWN and evidence.uplink == UNKNOWN


def test_observer_module_has_no_subprocess_dependency():
    from aegis_soc import observer

    assert not hasattr(observer, "subprocess")
    source = Path(observer.__file__).read_text(encoding="utf-8")
    assert "sudo" not in source.replace("no sudo", "").lower().replace("passwordless", "")
    assert "import subprocess" not in source


def test_real_unreadable_file_is_unavailable_without_a_subprocess(tmp_path, monkeypatch):
    import os

    if os.geteuid() == 0:
        return
    path = tmp_path / "status.json"
    path.write_text(json.dumps(_status()), encoding="utf-8")
    path.chmod(0)
    _forbid_subprocess(monkeypatch)
    try:
        evidence = read_observer_status(path, now=1_700_000_030.0)
    finally:
        path.chmod(0o600)
    assert evidence.valid is False
    assert evidence.freshness == "UNAVAILABLE"


def test_unreadable_default_path_is_handled_without_a_subprocess(monkeypatch):
    from aegis_soc import observer

    _forbid_subprocess(monkeypatch)
    evidence = observer.read_observer_status(observer.STATUS_PATH, now=1_700_000_030.0)
    assert evidence.valid is False
    assert evidence.freshness in {"UNAVAILABLE", "MISSING"}


def test_invalid_custom_paths_are_handled_safely(tmp_path, monkeypatch):
    _forbid_subprocess(monkeypatch)
    directory = tmp_path / "dir"
    directory.mkdir()
    fifo = tmp_path / "fifo"
    import os

    os.mkfifo(fifo)
    for candidate in (directory, fifo, tmp_path / "missing" / "status.json", Path("")):
        evidence = read_observer_status(candidate, now=1_700_000_030.0)
        assert evidence.valid is False
        assert evidence.runtime_state == UNKNOWN


def test_symlinked_status_file_is_refused(tmp_path):
    real = tmp_path / "real.json"
    real.write_text(json.dumps(_status()), encoding="utf-8")
    link = tmp_path / "status.json"
    link.symlink_to(real)
    evidence = read_observer_status(link, now=1_700_000_030.0)
    assert evidence.valid is False
    assert evidence.freshness == "INVALID"


def test_oversized_status_file_is_invalid(tmp_path):
    path = tmp_path / "status.json"
    path.write_text(json.dumps({**_status(), "pad": "x" * (128 * 1024)}), encoding="utf-8")
    evidence = read_observer_status(path, now=1_700_000_030.0)
    assert evidence.valid is False
    assert evidence.freshness == "INVALID"


def test_valid_status_file_still_reads_without_a_subprocess(tmp_path, monkeypatch):
    path = tmp_path / "status.json"
    path.write_text(json.dumps(_status()), encoding="utf-8")
    _forbid_subprocess(monkeypatch)
    assert read_observer_status(path, now=1_700_000_030.0).valid is True


def test_stale_status_does_not_display_historical_operational_values(tmp_path):
    path = tmp_path / "status.json"
    _write(path, _status())

    evidence = read_observer_status(path, now=1_700_000_030.0, max_age_seconds=10)

    assert evidence.valid is False
    assert evidence.freshness == "STALE"
    assert evidence.runtime_state == UNKNOWN
    assert evidence.broker == UNKNOWN
    assert evidence.device == UNKNOWN
    assert evidence.trusted_time == UNKNOWN


def test_invalid_and_contradictory_status_fail_closed(tmp_path):
    invalid = tmp_path / "invalid.json"
    invalid.write_text("{not-json", encoding="utf-8")
    assert read_observer_status(invalid, now=1_700_000_030.0).freshness == "INVALID"

    contradictory = tmp_path / "contradictory.json"
    _write(contradictory, _status(state="LOCKDOWN", uplink="NORMAL"))
    evidence = read_observer_status(contradictory, now=1_700_000_030.0)
    assert evidence.valid is False
    assert evidence.freshness == "CONTRADICTORY"
    assert evidence.runtime_state == UNKNOWN


def test_operator_cable_observation_is_never_reported_as_python_verified(tmp_path):
    path = tmp_path / "status.json"
    _write(path, _status())

    evidence = read_observer_status(path, now=1_700_000_030.0)

    assert evidence.physical_source == "OPERATOR_OBSERVED_ONLY"
    assert evidence.physical_verification == "NOT_VERIFIED"
    assert "Pin 2 open" in evidence.physical_observation
