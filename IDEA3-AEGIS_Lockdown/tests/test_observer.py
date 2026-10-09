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


def test_permission_denied_uses_only_exact_fixed_file_sudo_n_read(monkeypatch):
    from aegis_soc import observer

    calls = []
    payload = json.dumps(_status()).encode()

    def denied(_self, **_kwargs):
        raise PermissionError("status directory is not traversable")

    def sudo_read(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=payload.decode(), stderr="")

    monkeypatch.setattr(Path, "read_text", denied)
    monkeypatch.setattr(observer.subprocess, "run", sudo_read)

    evidence = observer.read_observer_status(observer.STATUS_PATH, now=1_700_000_030.0)

    assert evidence.valid is True
    assert calls == [(
        ["sudo", "-n", "cat", str(observer.STATUS_PATH)],
        {"capture_output": True, "text": True, "check": False, "timeout": 2.0},
    )]


def test_permission_denied_without_authorized_read_is_explicitly_unavailable(monkeypatch):
    from aegis_soc import observer

    monkeypatch.setattr(Path, "read_text", lambda *_args, **_kwargs: (_ for _ in ()).throw(PermissionError("denied")))
    monkeypatch.setattr(
        observer.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(["sudo"], 1, stdout="", stderr="not authorized"),
    )

    evidence = observer.read_observer_status(observer.STATUS_PATH, now=1_700_000_030.0)

    assert evidence.valid is False
    assert evidence.freshness == "UNAVAILABLE"
    assert "permission" in evidence.reason.lower()


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
