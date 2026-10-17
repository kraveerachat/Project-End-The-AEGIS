"""Contracts for the nonprivileged, read-only Core status projection publisher (synthetic TEST_ONLY data)."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import threading
from pathlib import Path

import pytest

from aegis_soc import observer
from tools import local_status_bridge
from tools import status_projection_publisher as publisher

NOW = 1_700_000_100.0


def _core_status(**changes):
    value = {
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False,
        "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY",
        "dispatch": "DISABLED", "time_trust": "SYNCED", "updated_at": NOW - 5, "components": {"detector": "RUNNING"},
        "pid": 4242, "detail": "token=SHOULD-NOT-LEAK /etc/aegis-idea3/credentials/k_c2d", "secret": "hunter2",
    }
    value.update(changes)
    return value


@pytest.fixture
def paths(tmp_path):
    source_dir = tmp_path / "core"
    source_dir.mkdir(mode=0o700)
    dest = tmp_path / "out"
    dest.mkdir(mode=0o700)
    return source_dir / "status.json", dest


def _write(path, document):
    path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")


def _forbid_subprocess(monkeypatch):
    def spawn(*_a, **_k):
        raise AssertionError("the publisher must not start a subprocess")

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, spawn)
    monkeypatch.setattr(os, "system", spawn)


def test_valid_projection_is_published_allowlisted_and_keeps_core_timestamp(paths, monkeypatch):
    source, dest = paths
    _write(source, _core_status())
    _forbid_subprocess(monkeypatch)

    result = publisher.publish_once(source, dest, now=NOW)

    assert result.published, result
    text = (dest / publisher.OUTPUT_NAME).read_text(encoding="utf-8")
    document = json.loads(text)
    assert document["projection_schema"] == "aegis.idea3.status-projection"
    assert document["projection_version"] == 1
    assert document["updated_at"] == NOW - 5
    assert document["provenance"]["source_updated_at"] == NOW - 5
    assert document["provenance"]["freshness_basis"] == "source_updated_at"
    assert document["provenance"]["published_at"] == NOW
    assert document["provenance"]["physical_verification"] == "NOT_VERIFIED"
    assert document["web_projection"]["generatedAt"].startswith("2023-11-14T")
    for leaked in ("SHOULD-NOT-LEAK", "hunter2", "4242", "k_c2d", "credentials", "pid", "detail", "secret"):
        assert leaked not in text


def test_published_file_is_accepted_by_the_desktop_reader_and_web_bridge_consistently(paths):
    source, dest = paths
    _write(source, _core_status())
    assert publisher.publish_once(source, dest, now=NOW).published
    output = dest / publisher.OUTPUT_NAME

    desktop = observer.read_observer_status(output, now=NOW)
    original = observer.read_observer_status(source, now=NOW)
    web = local_status_bridge.projection_for(output)
    web_from_source = local_status_bridge.projection_for(source)

    assert desktop.valid and original.valid
    for field in ("runtime_state", "profile", "broker", "device", "uplink", "armed", "dispatch", "trusted_time",
                  "evidence_timestamp", "dry_run", "auto_contain"):
        assert getattr(desktop, field) == getattr(original, field), field
    assert web == web_from_source
    assert web == json.loads(output.read_text())["web_projection"]


def test_uplink_lockdown_projects_degraded_for_both_consumers(paths):
    source, dest = paths
    _write(source, _core_status(state="LOCKDOWN", uplink="LOCKDOWN"))
    assert publisher.publish_once(source, dest, now=NOW).published
    output = dest / publisher.OUTPUT_NAME
    assert observer.read_observer_status(output, now=NOW).uplink == "LOCKDOWN"
    assert local_status_bridge.projection_for(output)["status"] == "DEGRADED"


def test_unknown_stays_unknown_and_no_physical_inference(paths):
    source, dest = paths
    _write(source, _core_status(broker="UNKNOWN", device="UNKNOWN", uplink="UNKNOWN"))
    assert publisher.publish_once(source, dest, now=NOW).published
    web = json.loads((dest / publisher.OUTPUT_NAME).read_text())["web_projection"]
    assert web["status"] == "UNKNOWN"
    assert web["components"]["broker"] == web["components"]["device"] == web["components"]["uplink"] == "UNKNOWN"
    text = (dest / publisher.OUTPUT_NAME).read_text().lower()
    for inferred in ("relay", "ack", "heartbeat"):
        assert f'"{inferred}' not in text


@pytest.mark.parametrize(
    "document,reason",
    [
        (None, "MISSING"),
        ("{not json", "INVALID"),
        (json.dumps([1, 2]), "INVALID"),
        (json.dumps({"state": "RUNNING"}), "INVALID"),
        (json.dumps(_core_status(updated_at=NOW - 3600)), "STALE"),
        (json.dumps(_core_status(updated_at=NOW + 3600)), "INVALID"),
        (json.dumps(_core_status(state="LOCKDOWN", uplink="NORMAL")), "CONTRADICTORY"),
        (json.dumps(_core_status(profile="production", dry_run=True)), "CONTRADICTORY"),
        (json.dumps(_core_status(broker="MAYBE")), "INVALID"),
        (json.dumps(_core_status(updated_at=True)), "INVALID"),
        (json.dumps({**_core_status(), "pad": "x" * (128 * 1024)}), "INVALID"),
    ],
)
def test_bad_source_publishes_nothing_and_keeps_the_previous_output_untouched(paths, document, reason):
    source, dest = paths
    output = dest / publisher.OUTPUT_NAME
    output.write_text("previous", encoding="utf-8")
    if document is not None:
        _write(source, document)

    result = publisher.publish_once(source, dest, now=NOW)

    assert result.outcome == publisher.SOURCE_REFUSED
    assert reason in result.reason
    assert output.read_text() == "previous"
    assert [p.name for p in dest.iterdir()] == [publisher.OUTPUT_NAME]


def test_permission_denied_source_is_refused_without_a_subprocess(paths, monkeypatch):
    if os.geteuid() == 0:
        pytest.skip("root bypasses file permissions")
    source, dest = paths
    _write(source, _core_status())
    source.chmod(0)
    _forbid_subprocess(monkeypatch)
    try:
        result = publisher.publish_once(source, dest, now=NOW)
    finally:
        source.chmod(0o600)
    assert result.outcome == publisher.SOURCE_REFUSED and "UNAVAILABLE" in result.reason
    assert not (dest / publisher.OUTPUT_NAME).exists()


def test_symlinked_source_is_refused(paths, tmp_path):
    source, dest = paths
    real = tmp_path / "real.json"
    _write(real, _core_status())
    source.symlink_to(real)
    assert publisher.publish_once(source, dest, now=NOW).outcome == publisher.SOURCE_REFUSED
    assert not (dest / publisher.OUTPUT_NAME).exists()


def test_relative_source_is_refused(paths):
    _source, dest = paths
    assert publisher.publish_once(Path("status.json"), dest, now=NOW).outcome == publisher.SOURCE_REFUSED


def test_output_replacement_is_atomic_and_leaves_no_temporary_files(paths):
    source, dest = paths
    _write(source, _core_status())
    assert publisher.publish_once(source, dest, now=NOW).published
    first = (dest / publisher.OUTPUT_NAME).read_text()
    _write(source, _core_status(updated_at=NOW - 1, broker="DISCONNECTED"))
    assert publisher.publish_once(source, dest, now=NOW + 1).published
    second = (dest / publisher.OUTPUT_NAME).read_text()
    assert first != second and json.loads(second)["broker"] == "DISCONNECTED"
    assert [p.name for p in dest.iterdir()] == [publisher.OUTPUT_NAME]


def test_readers_never_see_a_partial_document_during_concurrent_replacement(paths):
    source, dest = paths
    _write(source, _core_status())
    assert publisher.publish_once(source, dest, now=NOW).published
    output = dest / publisher.OUTPUT_NAME
    stop = threading.Event()
    failures = []

    def reader():
        while not stop.is_set():
            try:
                json.loads(output.read_text(encoding="utf-8"))
            except FileNotFoundError:
                failures.append("missing")
            except ValueError:
                failures.append("partial")

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for index in range(150):
            _write(source, _core_status(updated_at=NOW - 1 + index / 1000))
            assert publisher.publish_once(source, dest, now=NOW + 1).published
    finally:
        stop.set()
        thread.join(5)
    assert failures == []


def test_file_mode_is_private_by_default_and_never_chmods_the_directory(paths):
    source, dest = paths
    _write(source, _core_status())
    before = stat.S_IMODE(dest.stat().st_mode)
    assert publisher.publish_once(source, dest, now=NOW).published
    assert stat.S_IMODE((dest / publisher.OUTPUT_NAME).stat().st_mode) == 0o600
    assert stat.S_IMODE(dest.stat().st_mode) == before


def test_group_accessible_destination_needs_an_explicit_owner_decision(paths):
    source, dest = paths
    _write(source, _core_status())
    dest.chmod(0o750)
    refused = publisher.publish_once(source, dest, now=NOW)
    assert refused.outcome == publisher.DESTINATION_REFUSED and "allow-group-readable" in refused.reason
    allowed = publisher.publish_once(source, dest, now=NOW, allow_group_readable=True)
    assert allowed.published
    assert stat.S_IMODE((dest / publisher.OUTPUT_NAME).stat().st_mode) == 0o640
    assert stat.S_IMODE(dest.stat().st_mode) == 0o750


@pytest.mark.parametrize("mode", [0o770, 0o775, 0o777, 0o705, 0o701, 0o720])
def test_writable_or_world_accessible_destinations_are_always_refused(paths, mode):
    source, dest = paths
    _write(source, _core_status())
    dest.chmod(mode)
    try:
        result = publisher.publish_once(source, dest, now=NOW, allow_group_readable=True)
    finally:
        dest.chmod(0o700)
    assert result.outcome == publisher.DESTINATION_REFUSED
    assert not (dest / publisher.OUTPUT_NAME).exists()


def test_unsafe_destinations_are_refused(paths, tmp_path):
    source, dest = paths
    _write(source, _core_status())
    link = tmp_path / "link"
    link.symlink_to(dest, target_is_directory=True)
    regular = tmp_path / "file"
    regular.write_text("x")
    for bad in (
        link, regular, tmp_path / "missing", Path("relative"), dest / ".." / "out",
        source.parent,
        Path("/run/aegis-idea3"), Path("/etc/aegis-idea3"), Path("/opt/aegis-idea3/current"), Path("/var/lib/aegis-idea3"),
    ):
        result = publisher.publish_once(source, bad, now=NOW)
        assert result.outcome == publisher.DESTINATION_REFUSED, bad


def test_destination_owned_by_someone_else_is_refused(paths, monkeypatch):
    source, dest = paths
    _write(source, _core_status())
    monkeypatch.setattr(os, "geteuid", lambda: os.stat(dest).st_uid + 1)
    assert publisher.publish_once(source, dest, now=NOW).outcome == publisher.DESTINATION_REFUSED


def test_preexisting_output_symlink_is_replaced_not_followed(paths, tmp_path):
    source, dest = paths
    _write(source, _core_status())
    victim = tmp_path / "victim.txt"
    victim.write_text("keep", encoding="utf-8")
    (dest / publisher.OUTPUT_NAME).symlink_to(victim)
    assert publisher.publish_once(source, dest, now=NOW).published
    assert victim.read_text() == "keep"
    assert not (dest / publisher.OUTPUT_NAME).is_symlink()


def test_write_failure_is_reported_and_leaves_no_partial_file(paths, monkeypatch):
    source, dest = paths
    _write(source, _core_status())

    def broken(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "fsync", broken)
    result = publisher.publish_once(source, dest, now=NOW)
    assert result.outcome == publisher.WRITE_FAILED
    assert list(dest.iterdir()) == []


def test_oversized_projection_is_refused(paths, monkeypatch):
    source, dest = paths
    _write(source, _core_status())
    monkeypatch.setattr(publisher, "MAX_OUTPUT_BYTES", 10)
    assert publisher.publish_once(source, dest, now=NOW).outcome == publisher.SOURCE_REFUSED
    assert list(dest.iterdir()) == []


def test_publisher_source_has_no_privilege_network_or_hardware_surface():
    source = Path(publisher.__file__).read_text(encoding="utf-8")
    lowered = source.lower()
    for forbidden in ("import subprocess", "subprocess.", "sudo ", "os.system", "os.chmod", "os.chown", "os.fchown",
                      "import socket", "http.server", "paho", "import sqlite3", "import serial", "gpio", "shell=true",
                      "os.popen", "os.exec"):
        assert forbidden not in lowered, forbidden


def test_cli_once_publishes_and_refuses_with_distinct_exit_codes(paths, capsys):
    source, dest = paths
    _write(source, _core_status(updated_at=__import__("time").time()))
    assert publisher.main(["--source", str(source), "--dest-dir", str(dest), "--once"]) == 0
    _write(source, "{bad")
    assert publisher.main(["--source", str(source), "--dest-dir", str(dest), "--once"]) == 1
    assert publisher.main(["--source", str(source), "--dest-dir", "/etc", "--once"]) == 2
    assert publisher.main(["--source", str(source), "--dest-dir", str(dest), "--interval", "0"]) == 2


def test_run_loop_stops_on_event_and_survives_a_bad_cycle(paths):
    source, dest = paths
    stop = threading.Event()
    calls = []
    original = publisher.publish_once

    def counting(*args, **kwargs):
        calls.append(1)
        if len(calls) == 3:
            stop.set()
        return original(*args, **kwargs)

    publisher.publish_once = counting
    try:
        assert publisher.run(source, dest, interval=0.01, stop=stop) == 0
    finally:
        publisher.publish_once = original
    assert len(calls) == 3


def test_run_loop_ends_when_destination_is_refused(paths, tmp_path):
    source, _dest = paths
    assert publisher.run(source, tmp_path / "missing", interval=0.01, stop=threading.Event()) == 2
