"""L9 live-observation PROTOTYPE: a READ-ONLY reader of the running Core's protocol/audit stores.

Fixture SQLite files only (built with the real ProtocolStore/database schema). Not wired into apply.sh:
enabling the live L9 backend is a separate reviewed change.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "deploy/pr11-phase4/p4-l9-live-observe.py"
sys.path.insert(0, str(ROOT))
from aegis_soc.protocol_store import ProtocolStore  # noqa: E402

DEV = "aegis-relay-01"
NOW = 1_800_000_000
MSG = "0123456789abcdef0123456789abcdef"


def load():
    spec = importlib.util.spec_from_file_location("p4_l9_live_observe", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_db(tmp: Path, *, statuses: list[tuple[str, float]] = (), heartbeat_kind_rows: int = 0, commands: int = 0, audit: list[str] = ()) -> tuple[Path, Path]:
    pdb, adb = tmp / "core-protocol.sqlite3", tmp / "core-audit.sqlite3"
    store = ProtocolStore(pdb, wall_clock=lambda: float(NOW))
    store.close()
    con = sqlite3.connect(pdb)
    for i, (kind, at) in enumerate(statuses):
        con.execute("INSERT INTO protocol_seen_d2c (device_id, msg_id, kind, received_at) VALUES (?,?,?,?)", (DEV, f"{i:032x}", kind, at))
    for i in range(commands):
        con.execute("INSERT INTO protocol_commands (msg_id, device_id, seq, action, issued_at, expires_at, state, reserved_at) VALUES (?,?,?,?,?,?,?,?)",
                    (f"{i + 100:032x}", DEV, i + 1, "CUT_UPLINK", NOW, NOW + 10, "PUBLISHED", float(NOW)))
    con.commit(); con.close()
    a = sqlite3.connect(adb)
    a.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT)")
    for ev in audit:
        a.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('t','INFO',?,'x')", (ev,))
    a.commit(); a.close()
    return pdb, adb


def run(mod, pdb, adb, **kw):
    return mod.observe(protocol_db=pdb, audit_db=adb, device_id=DEV, now=NOW, window_sec=kw.pop("window_sec", 120), min_status=kw.pop("min_status", 1), **kw)


def test_fresh_authenticated_status_passes(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 20.0)])
    r = run(mod, pdb, adb)
    assert r["L9_LIVE_OBSERVATION"] == "PASS" and r["L9_STATUS_ACCEPTED_IN_WINDOW"] == 1 and r["L9_COMMAND_ROWS"] == 0


def test_no_status_fails(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path)
    r = run(mod, pdb, adb)
    assert r["L9_LIVE_OBSERVATION"] == "FAIL" and r["L9_FAILURE_REASON"] == "NO_STATUS_IN_WINDOW"


def test_stale_status_fails(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 3600.0)])
    r = run(mod, pdb, adb)
    assert r["L9_LIVE_OBSERVATION"] == "FAIL" and r["L9_FAILURE_REASON"] == "NO_STATUS_IN_WINDOW"


def test_future_dated_status_row_fails(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW + 3600.0)])
    assert run(mod, pdb, adb)["L9_LIVE_OBSERVATION"] == "FAIL"


def test_ack_rows_do_not_count_as_status(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("ACK", NOW - 5.0)])
    assert run(mod, pdb, adb)["L9_FAILURE_REASON"] == "NO_STATUS_IN_WINDOW"


def test_other_device_rows_do_not_count(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    r = mod.observe(protocol_db=pdb, audit_db=adb, device_id="other-device", now=NOW, window_sec=120, min_status=1)
    assert r["L9_LIVE_OBSERVATION"] == "FAIL"


def test_any_command_row_is_actuation_failure(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)], commands=1)
    r = run(mod, pdb, adb)
    assert r["L9_LIVE_OBSERVATION"] == "FAIL" and r["L9_FAILURE_REASON"] == "COMMAND_ROWS_PRESENT"


@pytest.mark.parametrize("event", ["COMMAND_SENT", "COMMAND_QUEUED", "DRY_RUN_COMMAND"])
def test_command_audit_event_fails(tmp_path, event):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)], audit=[event])
    r = run(mod, pdb, adb)
    assert r["L9_LIVE_OBSERVATION"] == "FAIL" and r["L9_FAILURE_REASON"] == "ACTUATION_AUDIT_EVENT"


def test_min_status_threshold(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    assert run(mod, pdb, adb, min_status=2)["L9_LIVE_OBSERVATION"] == "FAIL"


def test_missing_or_corrupt_or_symlinked_db_fails_closed(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    for bad in (tmp_path / "nope.sqlite3",):
        with pytest.raises(mod.L9Error):
            run(mod, bad, adb)
    corrupt = tmp_path / "corrupt.sqlite3"; corrupt.write_text("not a database")
    with pytest.raises(mod.L9Error):
        run(mod, corrupt, adb)
    link = tmp_path / "link.sqlite3"; link.symlink_to(pdb)
    with pytest.raises(mod.L9Error):
        run(mod, link, adb)


def test_databases_are_never_modified(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (pdb, adb)]
    run(mod, pdb, adb)
    assert before == [hashlib.sha256(p.read_bytes()).hexdigest() for p in (pdb, adb)]
    # WAL-mode readers may create -shm/-wal sidecars; the data files themselves are byte-identical.


def test_refuses_to_run_as_root_or_on_files_owned_by_someone_else(tmp_path, monkeypatch):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)
    with pytest.raises(mod.L9Error, match="RUN_AS_SERVICE_USER"):
        run(mod, pdb, adb)
    monkeypatch.setattr(mod.os, "geteuid", lambda: os.getuid() + 1)
    with pytest.raises(mod.L9Error, match="RUN_AS_SERVICE_USER"):
        run(mod, pdb, adb)


def test_output_contains_no_msg_id_or_mac_or_device_time(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    text = repr(run(mod, pdb, adb))
    assert f"{0:032x}" not in text and "mac" not in text.lower()


def test_heartbeat_is_reported_as_not_observable_not_as_pass(tmp_path):
    mod = load()
    pdb, adb = make_db(tmp_path, statuses=[("STATUS", NOW - 5.0)])
    assert run(mod, pdb, adb)["L9_HEARTBEAT_EVIDENCE"] == "NOT_OBSERVABLE_FROM_STORE"


def test_source_opens_sqlite_read_only_and_has_no_network_or_write_sql():
    code = "\n".join(l for l in MODULE.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert "mode=ro" in code and "query_only" in code
    for banned in ("INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "socket", "paho", "subprocess", "publish"):
        assert banned not in code, banned


def test_action_names_are_not_audit_event_types_so_only_real_event_types_are_checked():
    """The Core never writes CUT_UPLINK/RESTORE_UPLINK as an audit event_type (controller.py writes COMMAND_SENT /
    DRY_RUN_COMMAND, supervisor.py COMMAND_QUEUED); the observer must query the event types that really exist."""
    import re
    core = "\n".join((ROOT / "aegis_soc" / name).read_text() for name in ("controller.py", "supervisor.py"))
    written = set(re.findall(r'(?:_audit_log|db\.log_event)\(\s*"([A-Z_]+)"', core))
    assert {"COMMAND_SENT", "COMMAND_QUEUED", "DRY_RUN_COMMAND"} <= written
    assert "CUT_UPLINK" not in written and "RESTORE_UPLINK" not in written
    code = MODULE.read_text()
    for name in ("COMMAND_SENT", "COMMAND_QUEUED", "DRY_RUN_COMMAND"):
        assert name in code
    assert "event_type IN ('CUT_UPLINK'" not in code
