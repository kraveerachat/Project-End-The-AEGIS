"""AEGIS IDEA3 PR11 Phase 4 — L9 live observer: continuity, authenticated-protocol-only, marker binding, single use, SQLite, stage gating.

Repository-only. Core sources are synthetic (``l9_support.World``); the SQLite tests use real, temporary WAL databases. Nothing here contacts a
broker or device, starts or stops a service, or touches the real governance directory.
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from l9_support import (DEPLOY, DEVICE, EVIDENCE, L9_STAGE, MAIN, RUN, RUNNER_SHA, START, WORK, Clock, Claim, World, code_only, combined, good_world,
                        marker_text, observe, pre_boundary, run_observe)

# ============================================================================================ A. window-edge continuity


def test_a_continuous_authenticated_window_passes_and_records_the_edges() -> None:
    w, b = good_world()
    data = run_observe(w, b)
    assert data["result"] == "PASS", data["failure_boundary"]
    assert data["status_rows_observed"] == data["periodic_rows_observed"] == 4 and data["rows_outside_window"] == 0 and data["audit_only_status_rows"] == 0
    assert data["first_status_offset_seconds"] == 30 and data["last_status_to_end_seconds"] <= 45 and data["max_status_gap_seconds"] <= 45
    assert data["evidence_class"] == "LIVE_CORE_OBSERVATION" and data["schema_version"] == "l9-live-evidence-v2" and set(data) == set(observe.EVIDENCE_FIELDS)


def test_an_early_burst_followed_by_silence_fails_at_the_end_of_the_window() -> None:
    w = World()
    b = pre_boundary(w)
    w.periodic(START + 10.0, 4, gap=10.0)  # four rows in the first 40 s of a 120 s window
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] == "LAST_STATUS_TOO_EARLY"


def test_a_late_first_frame_fails_at_the_start_of_the_window() -> None:
    w = World()
    b = pre_boundary(w)
    w.periodic(START + 70.0, 3, gap=30.0)  # silence for the first 70 s
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b, window=150)
    assert data["result"] == "FAIL" and data["failure_boundary"] == "FIRST_STATUS_TOO_LATE"


def test_an_internal_gap_larger_than_the_status_cadence_fails() -> None:
    w = World()
    b = pre_boundary(w)
    for t in (30, 60, 130, 160):
        w.add_status(START + t)
    w.doc["updated_at"] = START + 100
    assert run_observe(w, b, window=160)["failure_boundary"] == "STATUS_GAP_TOO_LARGE"


def test_rows_stamped_before_the_window_are_stale_history_not_evidence() -> None:
    w, b = good_world()
    w.add_status(START - 500.0)  # rowid after the boundary, received_at long before it
    data = run_observe(w, b)
    assert data["failure_boundary"] == "AUTH_ROWS_OUTSIDE_WINDOW" and data["rows_outside_window"] == 1


def test_rows_stamped_in_the_future_fail() -> None:
    w, b = good_world()
    w.add_status(START + 900.0)
    w.now = START + 2000  # the row exists in the store; its stamp is far past the window end
    w.rows[-1] = (w.rows[-1][0], START + 900.0, DEVICE)
    clock_now = START + 121
    data = run_observe_with_late_visibility(w, b, clock_now)
    assert data["failure_boundary"] == "AUTH_ROWS_OUTSIDE_WINDOW"


def run_observe_with_late_visibility(w: World, b: dict[str, str], now: float) -> dict:
    """A store that already holds a row stamped beyond the evaluation time (clock skew / forged stamp)."""
    clock = Clock(START + 1.0)

    def tick(seconds):
        clock.sleep(seconds)
        w.now = clock.now + 10_000  # rows are visible regardless of their stamp

    return observe.observe(w, marker_text(b), DEVICE, RUN, 120, expected_main=MAIN, runner_sha256=RUNNER_SHA, work_dir=WORK, evidence_dir=EVIDENCE,
                           claim=Claim(), clock=clock, sleep=tick)


def test_pre_window_history_alone_never_creates_evidence() -> None:
    w = World()
    w.periodic(START - 400.0, 6, gap=30.0)  # a perfectly healthy HISTORY, all before the boundary
    b = pre_boundary(w)
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["status_rows_observed"] == 0 and data["failure_boundary"] in {"PERIODIC_ROWS_INSUFFICIENT", "FIRST_STATUS_TOO_LATE"}
    assert data["result"] == "FAIL"


def test_the_minimum_count_is_still_required() -> None:
    w = World()
    b = pre_boundary(w)
    w.periodic(START + 40.0, 2, gap=40.0)
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] in {"PERIODIC_ROWS_INSUFFICIENT", "LAST_STATUS_TOO_EARLY"}


def test_the_window_is_bounded_from_below_and_above() -> None:
    w, b = good_world()
    for bad in (119, 901):
        with pytest.raises(observe.ObserveError, match="WINDOW_OUT_OF_BOUNDS"):
            run_observe(w, b, window=bad)


# ============================================================================================ B. authenticated protocol rows only


def test_protocol_rows_with_matching_audit_rows_are_accepted() -> None:
    w, b = good_world()
    assert run_observe(w, b)["result"] == "PASS"


def test_audit_only_legacy_status_rows_fail() -> None:
    w, b = good_world()
    w.add_audit("DEVICE_STATUS", "NORMAL (PERIODIC)", START + 50.0)  # a legacy unsigned STATUS: an audit row but NO protocol row
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] == "AUDIT_ONLY_STATUS_PRESENT" and data["audit_only_status_rows"] == 1


def test_audit_rows_alone_can_never_prove_l9() -> None:
    w = World()
    b = pre_boundary(w)
    for t in (30, 60, 90, 120):
        w.add_audit("DEVICE_STATUS", "NORMAL (PERIODIC)", START + t)
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["status_rows_observed"] == 0 and data["failure_boundary"] == "AUDIT_ONLY_STATUS_PRESENT"


def test_unrelated_audit_growth_is_irrelevant() -> None:
    w, b = good_world()
    for i in range(40):
        w.add_audit("GUI_LOGIN", f"user {i}", START + 40.0 + i)
        w.add_audit("DISPATCH", "x", START + 41.0 + i)
    assert run_observe(w, b)["result"] == "PASS"


def test_a_row_of_the_wrong_device_is_not_evidence() -> None:
    w = World()
    b = pre_boundary(w)
    w.periodic(START + 30.0, 4, gap=30.0, device="aegis-relay-99")
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["status_rows_observed"] == 0


def test_a_row_of_the_wrong_message_kind_is_not_evidence() -> None:
    w = World()
    b = pre_boundary(w)
    w.periodic(START + 30.0, 4, gap=30.0, kind="ACK")
    w.doc["updated_at"] = START + 100
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["status_rows_observed"] == 0


def test_an_audit_row_that_does_not_correlate_in_time_with_its_protocol_row_fails() -> None:
    w, b = good_world()
    w.audit[1] = (w.audit[1][0], w.audit[1][1], w.audit[1][2], START + 400.0)
    assert run_observe(w, b)["failure_boundary"] == "AUDIT_PROTOCOL_UNCORRELATED"


def test_a_confirmed_protocol_row_without_an_audit_row_fails_but_a_fresh_tail_row_may_lack_it() -> None:
    w, b = good_world()
    del w.audit[1]
    assert run_observe(w, b)["failure_boundary"] in {"PROTOCOL_ROW_WITHOUT_AUDIT", "AUDIT_PROTOCOL_UNCORRELATED"}
    w2, b2 = good_world()
    del w2.audit[-1]  # the newest row (t = end) has not been audited yet: allowed
    assert run_observe(w2, b2)["result"] == "PASS"


def test_an_unparseable_status_audit_row_fails() -> None:
    w, b = good_world()
    w.add_audit("DEVICE_STATUS", "garbage", START + 60.0)
    assert run_observe(w, b)["failure_boundary"] == "AUDIT_STATUS_UNPARSEABLE"


@pytest.mark.parametrize("reason,boundary", [("DEADMAN", "DEADMAN_OBSERVED"), ("BOOT", "DEVICE_REBOOTED_DURING_OBSERVATION"),
                                             ("BOOT_GRACE", "DEVICE_REBOOTED_DURING_OBSERVATION"), ("COMMAND", "UNEXPECTED_STATUS_REASON"),
                                             ("SEQUENCE_REJECTED", "UNEXPECTED_STATUS_REASON")])
def test_non_periodic_reasons_fail_closed(reason: str, boundary: str) -> None:
    w, b = good_world(count=3)
    w.add_status(START + 120.0, reason=reason)
    assert run_observe(w, b)["failure_boundary"] == boundary


# ---- the Core / state invariants (unchanged by the hardening)

MUTATIONS = {
    "CORE_NOT_ACTIVE_RUNNING": lambda w: w.core.update(ActiveState="failed"),
    "CORE_PID_CHANGED": lambda w: (w.core.update(MainPID="101"), w.doc.update(pid=101)),
    "CORE_RESTARTED": lambda w: w.core.update(NRestarts="1"),
    "DETECTOR_NOT_ACTIVE_RUNNING": lambda w: w.detector.update(SubState="dead"),
    "DETECTOR_CHANGED": lambda w: w.detector.update(InvocationID="d" * 32),
    "CORE_STATUS_PID_MISMATCH": lambda w: w.doc.update(pid=999),
    "CORE_STATUS_NOT_REFRESHED": lambda w: w.doc.update(updated_at=START - 10.0),
    "TIME_TRUST_NOT_SYNCED": lambda w: w.doc.update(time_trust="HOLDOVER"),
    "BROKER_NOT_CONNECTED": lambda w: w.doc.update(broker="DISCONNECTED"),
    "DEVICE_NOT_ONLINE": lambda w: w.doc.update(device="OFFLINE"),
    "UPLINK_CHANGED": lambda w: w.doc.update(uplink="LOCKDOWN"),
    "COMMAND_ISSUED": lambda w: w.m.update(command_rows=1),
    "INCIDENT_STATE_CHANGED": lambda w: w.m.update(open_incidents=1),
}


@pytest.mark.parametrize("failure", sorted(MUTATIONS))
def test_every_core_and_state_invariant_fails_closed(failure: str) -> None:
    w, b = good_world()
    MUTATIONS[failure](w)
    data = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] == failure


def test_a_command_sent_audit_row_or_a_moved_allocator_fails_closed() -> None:
    w, b = good_world()
    w.add_audit("COMMAND_SENT", "x", START + 60.0)
    assert run_observe(w, b)["failure_boundary"] == "COMMAND_ISSUED"
    w2, b2 = good_world()
    w2.m["last_allocated_seq"] = 3
    assert run_observe(w2, b2)["failure_boundary"] == "COMMAND_ISSUED"


def test_correlation_anomalies_and_an_unknown_uplink_fail_closed() -> None:
    w, b = good_world()
    w.add_audit("P1_SEQUENCE_RESYNC", "x", START + 60.0)
    assert run_observe(w, b)["failure_boundary"] == "STATUS_CORRELATION_ANOMALY"
    w2 = World()
    w2.doc["uplink"] = "UNKNOWN"
    b2 = pre_boundary(w2)
    w2.periodic(START + 30.0, 4)
    w2.doc["updated_at"] = START + 100
    assert run_observe(w2, b2)["result"] == "FAIL"


# ============================================================================================ C/D. marker binding, staleness, single use


def test_the_correct_marker_binds_and_is_claimed_exactly_once_before_any_observation() -> None:
    w, b = good_world()
    claim = Claim()
    assert run_observe(w, b, claim=claim)["result"] == "PASS"
    assert claim.calls == [(RUN, START + 1.0)]


@pytest.mark.parametrize("kwargs,key", [({"run": "l9-other"}, "L9_RUN_ID"), ({"main": "e" * 40}, "L9_EXPECTED_MAIN"), ({"runner": "d" * 64}, "L9_RUNNER_SHA256"),
                                        ({"work": "/srv/other/work"}, "L9_WORK_DIR"), ({"evidence": "/srv/other/evidence"}, "L9_EVIDENCE_DIR")])
def test_any_identity_mismatch_against_the_canonical_marker_fails_before_the_claim(kwargs: dict, key: str) -> None:
    w, b = good_world()
    claim = Claim()
    with pytest.raises(observe.ObserveError, match=f"MARKER_BINDING_MISMATCH:{key}"):
        run_observe(w, b, claim=claim, **kwargs)
    assert claim.calls == []


def test_a_copied_marker_for_another_run_cannot_authorize_this_one() -> None:
    w, b = good_world()
    copied = marker_text(b, run="l9-original-run")
    with pytest.raises(observe.ObserveError, match="MARKER_BINDING_MISMATCH:L9_RUN_ID"):
        run_observe(w, b, marker=copied)


def test_a_stale_marker_is_refused_so_history_cannot_become_a_new_pass() -> None:
    w, b = good_world()
    old = marker_text(b, consumed_at=START - 3600.0)  # consumed an hour before the invocation
    with pytest.raises(observe.ObserveError, match="MARKER_BOUNDARY_NOT_AT_CONSUMPTION"):
        run_observe(w, b, marker=old)
    # boundary and consumption agree, but the whole record is old: the invocation clock is hours later
    with pytest.raises(observe.ObserveError, match="MARKER_STALE"):
        run_observe(w, b, clock_start=START + 3600.0)
    with pytest.raises(observe.ObserveError, match="MARKER_STALE"):
        run_observe(w, b, clock_start=START + observe.MAX_START_DELAY_SECONDS + 5)
    assert run_observe(w, b, clock_start=START + observe.MAX_START_DELAY_SECONDS - 5)["result"] in {"PASS", "FAIL"}  # inside the budget: allowed


def test_a_marker_from_the_future_is_refused() -> None:
    w, b = good_world()
    with pytest.raises(observe.ObserveError, match="MARKER_FROM_THE_FUTURE"):
        run_observe(w, b, clock_start=START - 100.0, marker=marker_text(b, consumed_at=START + 10.0))


def test_marker_fields_are_mandatory_and_unique() -> None:
    w, b = good_world()
    for key in ("L9_RUN_ID", "L9_WORK_DIR", "L9_EVIDENCE_DIR", "L9_EXPECTED_MAIN", "L9_RUNNER_SHA256", "L9_CONSUMED_AT_EPOCH"):
        with pytest.raises(observe.ObserveError, match=f"MARKER_FIELD_MISSING:{key}"):
            observe.parse_marker(marker_text(b, drop=(key,)), DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_DUPLICATE_KEY"):
        observe.parse_marker(marker_text(b) + "L9_RUN_ID=x\n", DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_CONSUMED"):
        observe.parse_marker(marker_text(b, consumed="NO"), DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_CONSUMED"):
        observe.parse_marker(marker_text(b, rerun="YES"), DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_DEVICE_MISMATCH"):
        observe.parse_marker(marker_text(b, device="other-device"), DEVICE)


def test_a_failing_claim_aborts_before_any_core_source_is_read() -> None:
    w, b = good_world()
    reads = []
    original = w.systemd
    w.systemd = lambda unit: (reads.append(unit), original(unit))[1]

    def refuse(run_id, now):
        raise observe.ObserveError("MARKER_ALREADY_OBSERVED")

    with pytest.raises(observe.ObserveError, match="MARKER_ALREADY_OBSERVED"):
        run_observe(w, b, claim=refuse)
    assert reads == []


def test_the_use_claim_is_exclusive_durable_and_never_follows_a_symlink(tmp_path: Path) -> None:
    used = tmp_path / observe.USED_NAME
    observe.claim_marker_use(used, RUN, "/e", "/w", 1.0)
    assert stat.S_IMODE(used.stat().st_mode) == 0o600 and f"L9_RUN_ID={RUN}" in used.read_text()
    with pytest.raises(observe.ObserveError, match="MARKER_ALREADY_OBSERVED"):
        observe.claim_marker_use(used, RUN, "/e", "/w", 2.0)
    with pytest.raises(observe.ObserveError, match="MARKER_ALREADY_OBSERVED"):
        observe.claim_marker_use(used, "l9-other", "/other", "/w2", 3.0)
    assert f"L9_RUN_ID={RUN}" in used.read_text()
    other = tmp_path / "second-used"
    other.symlink_to(tmp_path / "target")
    with pytest.raises(observe.ObserveError):
        observe.claim_marker_use(other, RUN, "/e", "/w", 1.0)
    assert not (tmp_path / "target").exists()


# ---- the CLI end to end through the governed path (canonical marker, seam allowed only in a user namespace)


def cli_setup(tmp_path: Path, monkeypatch, world_fn=good_world):
    w, b = world_fn()
    gov, ev, work = tmp_path / "gov", tmp_path / "ev", tmp_path / "work"
    for d, mode in ((gov, 0o700), (ev, 0o700), (work, 0o700)):
        d.mkdir(mode=mode)
    marker = gov / observe.MARKER_NAME
    marker.write_text(marker_text(b, work=str(work), evidence=str(ev)))
    marker.chmod(0o600)
    monkeypatch.setenv(observe.SEAM_ENABLED, "YES")
    monkeypatch.setenv(observe.SEAM_DIR, str(gov))
    monkeypatch.setattr(observe, "_initial_user_namespace", lambda: False)
    monkeypatch.setattr(observe, "RealSources", lambda: w)
    clock = Clock(START + 1.0)
    real = observe.observe

    def governed(*args, **kwargs):
        def tick(seconds):
            clock.sleep(seconds)
            w.now = clock.now

        w.now = clock.now
        return real(*args, clock=clock, sleep=tick, **kwargs)

    monkeypatch.setattr(observe, "observe", governed)
    argv = ["--marker", str(marker), "--evidence-dir", str(ev), "--work-dir", str(work), "--device-id", DEVICE, "--run-id", RUN, "--expected-main", MAIN,
            "--runner-sha256", RUNNER_SHA]
    return w, gov, ev, work, argv


def test_the_governed_path_reaches_the_observer_and_writes_the_bound_bundle(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 0
    bundle = ev / observe.EVIDENCE_NAME
    data = json.loads(bundle.read_text())
    assert data["result"] == "PASS" and data["run_id"] == RUN and data["expected_main"] == MAIN and data["runner_sha256"] == RUNNER_SHA
    assert (gov / observe.USED_NAME).is_file() and stat.S_IMODE(bundle.stat().st_mode) == 0o600
    assert observe.main(["verify", *argv]) == 0 and "L9_LIVE_VERIFY=PASS" in capsys.readouterr().out


def test_a_second_apply_with_the_same_marker_is_refused_and_writes_nothing(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 0
    before = (ev / observe.EVIDENCE_NAME).read_bytes()
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 1
    assert "MARKER_ALREADY_OBSERVED" in capsys.readouterr().err
    assert (ev / observe.EVIDENCE_NAME).read_bytes() == before


def test_the_same_marker_with_a_different_evidence_directory_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    other = tmp_path / "ev2"
    other.mkdir(mode=0o700)
    argv[argv.index("--evidence-dir") + 1] = str(other)
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 1
    assert "MARKER_BINDING_MISMATCH:L9_EVIDENCE_DIR" in capsys.readouterr().err
    assert not list(other.iterdir()) and not (gov / observe.USED_NAME).exists()


def test_a_different_run_id_or_work_dir_on_the_cli_is_refused(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    bad = list(argv)
    bad[bad.index("--run-id") + 1] = "l9-forged"
    assert observe.main(["observe", *bad, "--window-seconds", "120"]) == 1 and "MARKER_BINDING_MISMATCH:L9_RUN_ID" in capsys.readouterr().err
    bad = list(argv)
    bad[bad.index("--work-dir") + 1] = str(tmp_path / "elsewhere")
    assert observe.main(["observe", *bad, "--window-seconds", "120"]) == 1 and "MARKER_BINDING_MISMATCH:L9_WORK_DIR" in capsys.readouterr().err
    assert not (ev / observe.EVIDENCE_NAME).exists() and not (gov / observe.USED_NAME).exists()


def test_verify_requires_the_marker_bound_bundle_and_the_use_claim(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 0
    (gov / observe.USED_NAME).unlink()
    assert observe.main(["verify", *argv]) == 1 and "MARKER_USE_CLAIM_MISSING" in capsys.readouterr().err
    (gov / observe.USED_NAME).write_text(f"L9_RUN_ID=l9-other\nL9_EVIDENCE_DIR={ev}\nL9_WORK_DIR={work}\n")
    assert observe.main(["verify", *argv]) == 1 and "EVIDENCE_USE_CLAIM_MISMATCH" in capsys.readouterr().err


def test_verify_rejects_a_tampered_bundle_even_if_it_still_parses(tmp_path: Path, monkeypatch, capsys) -> None:
    w, gov, ev, work, argv = cli_setup(tmp_path, monkeypatch)
    assert observe.main(["observe", *argv, "--window-seconds", "120"]) == 0
    bundle = ev / observe.EVIDENCE_NAME
    for field, value in (("run_id", "l9-forged"), ("expected_main", "f" * 40), ("runner_sha256", "9" * 64), ("periodic_rows_observed", 2), ("deadman_rows_observed", 1),
                         ("last_status_to_end_seconds", 90), ("first_status_offset_seconds", 90), ("rows_outside_window", 1), ("audit_only_status_rows", 1)):
        original = bundle.read_text()
        data = json.loads(original)
        data[field] = value
        bundle.write_text(json.dumps(data))
        assert observe.main(["verify", *argv]) == 1, field
        bundle.write_text(original)
    assert observe.main(["verify", *argv]) == 0


# ============================================================================================ J. SQLite is only ever read


def make_dbs(tmp_path: Path):
    audit, proto = tmp_path / "audit.sqlite3", tmp_path / "protocol.sqlite3"
    a = sqlite3.connect(audit)
    a.execute("PRAGMA journal_mode=WAL")
    a.execute("PRAGMA wal_autocheckpoint=0")
    a.executescript("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT);"
                    "CREATE TABLE incidents (id INTEGER PRIMARY KEY, state TEXT);"
                    "CREATE TABLE lockdown_episodes (id INTEGER PRIMARY KEY, device_id TEXT, closed_at TEXT);")
    p = sqlite3.connect(proto)
    p.execute("PRAGMA journal_mode=WAL")
    p.execute("PRAGMA wal_autocheckpoint=0")
    p.executescript("CREATE TABLE protocol_seen_d2c (device_id TEXT NOT NULL, msg_id TEXT NOT NULL, kind TEXT NOT NULL, received_at REAL NOT NULL, PRIMARY KEY (device_id, msg_id));"
                    "CREATE TABLE protocol_commands (msg_id TEXT PRIMARY KEY, device_id TEXT, seq INTEGER);"
                    "CREATE TABLE protocol_sequence (device_id TEXT PRIMARY KEY, last_allocated_seq INTEGER);")
    return audit, proto, a, p


def dump(path: Path) -> list[str]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return list(conn.iterdump())
    finally:
        conn.close()


def test_real_sources_read_uncheckpointed_wal_rows_and_change_nothing(tmp_path: Path, monkeypatch) -> None:
    audit, proto, a, p = make_dbs(tmp_path)
    p.execute("INSERT INTO protocol_seen_d2c VALUES (?, 'm1', 'STATUS', 100.0)", (DEVICE,))
    p.execute("INSERT INTO protocol_seen_d2c VALUES (?, 'm2', 'ACK', 101.0)", (DEVICE,))
    p.execute("INSERT INTO protocol_seen_d2c VALUES ('other-device', 'm3', 'STATUS', 102.0)")
    p.commit()
    a.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('2026-10-07 10:00:00', 'INFO', 'DEVICE_STATUS', 'NORMAL (PERIODIC)')")
    a.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES ('2026-10-07 10:00:30', 'INFO', 'GUI', 'x')")
    a.commit()
    assert (tmp_path / "protocol.sqlite3-wal").stat().st_size > 0  # the rows live ONLY in the WAL: immutable mode would hide them
    before = (dump(audit), dump(proto))
    monkeypatch.setattr(observe, "AUDIT_DB", audit)
    monkeypatch.setattr(observe, "PROTOCOL_DB", proto)
    src = observe.RealSources()
    assert src.status_rows(DEVICE, 0, None) == [(1, 100.0)]
    rows = src.audit_rows(0, None)
    assert [r[1] for r in rows] == ["DEVICE_STATUS", "GUI"] and rows[0][3] is not None
    assert src.metrics(DEVICE) == {"protocol_seen_rowid": 1, "command_rows": 0, "last_allocated_seq": 0, "audit_id": 2, "open_incidents": 0, "open_episodes": 0}
    assert (dump(audit), dump(proto)) == before  # logical content identical
    a.close()
    p.close()


def test_every_sqlite_handle_is_read_only_and_only_select_is_executed(tmp_path: Path, monkeypatch) -> None:
    audit, proto, a, p = make_dbs(tmp_path)
    a.commit()
    p.commit()
    seen: list[tuple] = []
    uris: list[str] = []
    real_connect = sqlite3.connect

    def spy(target, *args, **kwargs):
        uris.append(str(target))
        conn = real_connect(target, *args, **kwargs)

        def authorizer(action, arg1, arg2, db, source):
            seen.append((action, arg1))
            return sqlite3.SQLITE_OK

        conn.set_authorizer(authorizer)
        return conn

    monkeypatch.setattr(observe.sqlite3, "connect", spy)
    monkeypatch.setattr(observe, "AUDIT_DB", audit)
    monkeypatch.setattr(observe, "PROTOCOL_DB", proto)
    src = observe.RealSources()
    src.metrics(DEVICE)
    src.status_rows(DEVICE, 0, 5)
    src.audit_rows(0, 5)
    assert uris and all(u.startswith("file:") and u.endswith("?mode=ro") for u in uris)
    allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
    odd = [(act, arg) for act, arg in seen if act not in allowed]
    assert all(act == sqlite3.SQLITE_PRAGMA and arg == "query_only" for act, arg in odd), odd
    for forbidden in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_ALTER_TABLE,
                      sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_TRANSACTION):
        assert all(act != forbidden for act, _ in seen)
    a.close()
    p.close()


def test_the_observer_connection_cannot_write_even_if_asked(tmp_path: Path, monkeypatch) -> None:
    audit, proto, a, p = make_dbs(tmp_path)
    a.commit()
    p.commit()
    monkeypatch.setattr(observe, "PROTOCOL_DB", proto)
    conn = observe._connect(proto)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("INSERT INTO protocol_seen_d2c VALUES ('x', 'y', 'STATUS', 1.0)")
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("CREATE TABLE t (x)")
    conn.close()
    a.close()
    p.close()


def test_an_unreadable_database_fails_closed_and_the_source_documents_the_sqlite_semantics() -> None:
    with pytest.raises(observe.ObserveError, match="DB_UNREADABLE"):
        observe._connect(Path("/nonexistent/dir/db.sqlite3"))
    doc = observe.__doc__
    assert "immutable=1" in doc and "LOGICAL" in doc and "byte-for-byte" in doc and "WAL/SHM" in doc
    assert "immutable=1" not in code_only(DEPLOY / "p4-l9-live-observe.py")


def test_the_only_external_command_is_systemctl_show_with_a_fixed_unit(monkeypatch) -> None:
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="ActiveState=active\nSubState=running\nMainPID=1\nNRestarts=0\nInvocationID=x\nResult=success\n", stderr="")

    monkeypatch.setattr(observe.subprocess, "run", fake_run)
    src = observe.RealSources()
    src.systemd(observe.CORE_UNIT)
    src.systemd(observe.DETECTOR_UNIT)
    assert [c[:2] for c in calls] == [[observe.SYSTEMCTL, "show"]] * 2 and [c[-1] for c in calls] == [observe.CORE_UNIT, observe.DETECTOR_UNIT]
    assert all(arg in {"-p", "show", observe.SYSTEMCTL, observe.CORE_UNIT, observe.DETECTOR_UNIT, "ActiveState", "SubState", "MainPID", "NRestarts", "InvocationID", "Result"}
               for c in calls for arg in c)


def test_the_observer_cli_has_no_override_or_success_flags() -> None:
    def flags(*cmd):
        res = subprocess.run([sys.executable, "-I", str(DEPLOY / "p4-l9-live-observe.py"), *cmd, "--help"], capture_output=True, text=True, check=False)
        return set(__import__("re").findall(r"--[a-z0-9-]+", res.stdout)) - {"--help"}

    identity = {"--marker", "--evidence-dir", "--work-dir", "--device-id", "--run-id", "--expected-main", "--runner-sha256"}
    assert flags("observe") == identity | {"--window-seconds"}
    assert flags("verify") == identity
    assert flags("capture-boundary") == {"--device-id"}


def test_the_observer_source_has_no_network_serial_command_key_or_mutating_sql_path() -> None:
    import re
    text = code_only(DEPLOY / "p4-l9-live-observe.py")
    for forbidden in ("socket", "paho", "mqtt", "publish", "serial", "esptool", "reserve_command", "send_command", "local_restore", "protocol_v1", "p1.encode", "urandom",
                      "token_bytes", "token_hex", "openssl", "INSERT ", "UPDATE ", "DELETE ", "DROP ", "CREATE ", "ALTER ", "1883", "setLockdown", "executescript", "commit("):
        assert forbidden not in text, forbidden
    assert re.findall(r"'(start|stop|restart|kill|mask|enable|disable|reload|daemon-reload|reset-failed)'", text) == []
    assert text.count("'show'") == 1 and "mode=ro" in text and "query_only" in text.replace(" ", "")


# ============================================================================================ marker file / seam


def test_the_marker_must_be_the_canonical_root_owned_private_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(observe.SEAM_ENABLED, "YES")
    monkeypatch.setenv(observe.SEAM_DIR, str(tmp_path))
    monkeypatch.setattr(observe, "_initial_user_namespace", lambda: False)
    marker, other = tmp_path / observe.MARKER_NAME, tmp_path / "other"
    other.write_text("x")
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_THE_CANONICAL_PATH"):
        observe.check_marker_file(other)
    with pytest.raises(observe.ObserveError, match="MARKER_MISSING"):
        observe.check_marker_file(marker)
    marker.write_text("x")
    marker.chmod(0o666)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_ROOT_OWNED_PRIVATE"):
        observe.check_marker_file(marker)
    marker.chmod(0o600)
    observe.check_marker_file(marker)
    marker.unlink()
    marker.symlink_to(other)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_A_REGULAR_FILE"):
        observe.check_marker_file(marker)


def test_the_marker_test_seam_is_refused_in_the_real_root_namespace(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(observe.SEAM_ENABLED, "YES")
    monkeypatch.setenv(observe.SEAM_DIR, str(tmp_path))
    monkeypatch.setattr(observe, "_initial_user_namespace", lambda: True)
    with pytest.raises(observe.ObserveError, match="REFUSED_IN_THE_REAL_ROOT_NAMESPACE"):
        observe.check_marker_file(tmp_path / observe.MARKER_NAME)
    monkeypatch.delenv(observe.SEAM_DIR)
    with pytest.raises(observe.ObserveError, match="TEST_SEAM_INCOMPLETE"):
        observe.check_marker_file(tmp_path / observe.MARKER_NAME)


# ============================================================================================ L. stage handlers: the replacement property


def stage_env(tmp_path: Path, **over) -> dict[str, str]:
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "AEGIS_L9_WORK_DIR": str(tmp_path / "work"), "AEGIS_L9_EVIDENCE_DIR": str(tmp_path / "evidence"),
           "AEGIS_L9_DEVICE_ID": DEVICE, "AEGIS_L9_RUN_ID": RUN, "AEGIS_L9_WINDOW_SECONDS": "120", "AEGIS_L9_MARKER": str(tmp_path / "marker"),
           "AEGIS_L9_EXPECTED_MAIN": MAIN, "AEGIS_L9_RUNNER_SHA256": RUNNER_SHA, "AEGIS_L9_BACKEND": "live", "AEGIS_L9_LIVE_AUTHORIZED": "YES"}
    for key, value in over.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def run_stage(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(L9_STAGE / script)], env=env, capture_output=True, text=True, timeout=60, check=False)


def test_unauthorized_live_is_refused_before_anything_is_created(tmp_path: Path) -> None:
    for value in (None, "NO", "yes", ""):
        res = run_stage("apply.sh", stage_env(tmp_path, AEGIS_L9_LIVE_AUTHORIZED=value))
        assert res.returncode != 0 and "LIVE_L9_NOT_AUTHORIZED" in combined(res)
    assert not (tmp_path / "evidence").exists() and not (tmp_path / "work").exists()


def test_the_fixture_environment_cannot_enable_live(tmp_path: Path) -> None:
    for var, value in (("AEGIS_L9_INPUT_DIR", str(tmp_path)), ("AEGIS_L9_FIXTURE_NOW", "1700000001")):
        res = run_stage("apply.sh", stage_env(tmp_path, **{var: value}))
        assert res.returncode != 0 and "LIVE_L9_FIXTURE_INPUT_COMBINATION_REFUSED" in combined(res)


@pytest.mark.parametrize("var", ["AEGIS_L9_WORK_DIR", "AEGIS_L9_EVIDENCE_DIR", "AEGIS_L9_DEVICE_ID", "AEGIS_L9_RUN_ID", "AEGIS_L9_WINDOW_SECONDS", "AEGIS_L9_MARKER",
                                 "AEGIS_L9_EXPECTED_MAIN", "AEGIS_L9_RUNNER_SHA256"])
def test_every_live_input_is_mandatory(tmp_path: Path, var: str) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path, **{var: None}))
    assert res.returncode != 0 and var in combined(res)


@pytest.mark.parametrize("var,value", [("AEGIS_L9_DEVICE_ID", "BAD ID"), ("AEGIS_L9_WINDOW_SECONDS", "12"), ("AEGIS_L9_WINDOW_SECONDS", "abc"),
                                       ("AEGIS_L9_EVIDENCE_DIR", "/run/aegis-idea3/ev"), ("AEGIS_L9_EVIDENCE_DIR", "/etc/ev"), ("AEGIS_L9_EXPECTED_MAIN", "xyz"),
                                       ("AEGIS_L9_RUNNER_SHA256", "short")])
def test_malformed_live_inputs_are_refused(tmp_path: Path, var: str, value: str) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path, **{var: value}))
    assert res.returncode != 0 and "L9_APPLY=FAIL" in combined(res)


def test_authorized_live_without_the_canonical_marker_fails_closed_and_never_reaches_the_fixture_path(tmp_path: Path) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path))
    assert res.returncode != 0 and "live observation failed" in combined(res) and "MARKER_NOT_THE_CANONICAL_PATH" in combined(res)
    assert not list((tmp_path / "evidence").glob("*.json")) and not (tmp_path / "work" / "fixture-protocol.sqlite3").exists()
    assert "L9_APPLY=COMPLETE" not in res.stdout


def test_the_live_branch_cannot_fall_through_to_the_fixture_code() -> None:
    text = (L9_STAGE / "apply.sh").read_text()
    live = text[text.index("# 0. Live backend"):text.index("# 1. Mandatory environment")]
    assert live.rstrip().endswith("fi") and "exit 0" in live and "p4-l9-auth.py" not in live and "k_c2d" not in live and "k_d2c" not in live
    assert "L9_COMMAND_SENT=NONE" in live and "L9_LIVE_OBSERVATION=COMPLETE" in live


def test_live_apply_ignores_a_caller_selected_python_and_pythonpath(tmp_path: Path) -> None:
    sentinel = tmp_path / "sentinel"
    evil_bin = tmp_path / "evil-python"
    evil_bin.write_text(f"#!/bin/sh\ntouch {sentinel}\nexit 0\n")
    evil_bin.chmod(0o755)
    evil = tmp_path / "evil"
    evil.mkdir()
    (evil / "sqlite3.py").write_text(f"open({str(sentinel)!r}, 'w').write('x')\n")
    env = stage_env(tmp_path, AEGIS_PYTHON_BIN=str(evil_bin), PYTHONPATH=str(evil), PYTHONHOME=str(evil))
    res = run_stage("apply.sh", env)
    assert res.returncode != 0 and not sentinel.exists(), combined(res)
    # control: the same poisoned PYTHONPATH DOES hijack a non-isolated interpreter, so the assertion above has teeth
    control = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-live-observe.py"), "capture-boundary", "--device-id", DEVICE],
                             env={**os.environ, "PYTHONPATH": str(evil)}, capture_output=True, text=True, check=False)
    assert sentinel.exists() and control.returncode != 0
    sentinel.unlink()
    isolated = subprocess.run([sys.executable, "-I", str(DEPLOY / "p4-l9-live-observe.py"), "capture-boundary", "--device-id", DEVICE],
                              env={**os.environ, "PYTHONPATH": str(evil)}, capture_output=True, text=True, check=False)
    assert not sentinel.exists() and isolated.returncode == 1


def test_live_verify_fails_closed_without_exactly_one_correctly_named_live_bundle(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    (tmp_path / "evidence").mkdir()
    assert run_stage("verify.sh", env).returncode != 0
    live = tmp_path / "evidence" / "l9-live-evidence.json"
    live.write_text("{}")
    live.chmod(0o600)
    res = run_stage("verify.sh", env)
    assert res.returncode != 0 and "L9_VERIFY=PASS" not in res.stdout
    fixture_named = tmp_path / "evidence" / "l9-auth-evidence.json"
    fixture_named.write_text("{}")
    assert "expected exactly one evidence bundle" in combined(run_stage("verify.sh", env))
    live.unlink()
    assert "live evidence bundle missing" in combined(run_stage("verify.sh", env))


def test_live_verify_requires_the_marker_identity_inputs(tmp_path: Path) -> None:
    (tmp_path / "evidence").mkdir()
    live = tmp_path / "evidence" / "l9-live-evidence.json"
    live.write_text("{}")
    live.chmod(0o600)
    res = run_stage("verify.sh", stage_env(tmp_path, AEGIS_L9_RUNNER_SHA256=None))
    assert res.returncode != 0 and "AEGIS_L9_RUNNER_SHA256 required" in combined(res)


def test_fixture_verify_still_refuses_a_live_named_bundle(tmp_path: Path) -> None:
    env = stage_env(tmp_path, AEGIS_L9_BACKEND=None, AEGIS_L9_LIVE_AUTHORIZED=None)
    (tmp_path / "evidence").mkdir()
    live = tmp_path / "evidence" / "l9-live-evidence.json"
    live.write_text("{}")
    live.chmod(0o600)
    res = run_stage("verify.sh", env)
    assert res.returncode != 0 and "unexpected bundle filename" in combined(res)


def test_live_rollback_is_a_no_op_that_preserves_evidence_and_never_stops_the_core(tmp_path: Path) -> None:
    (tmp_path / "evidence").mkdir()
    (tmp_path / "work").mkdir()
    (tmp_path / "evidence" / "l9-live-evidence.json").write_text("{}")
    res = run_stage("rollback.sh", stage_env(tmp_path))
    assert res.returncode == 0
    for marker in ("L9_CORE_ACTION_TAKEN=NONE", "L9_DEVICE_ACTION_TAKEN=NONE", "L9_COMMAND_SENT=NONE", "L9_EVIDENCE_PRESERVED=YES",
                   "L9_LIVE_OBSERVATION_MUTATED_NOTHING=YES", "L9_ROLLBACK=COMPLETE"):
        assert marker in res.stdout
    assert (tmp_path / "evidence" / "l9-live-evidence.json").is_file()


def test_the_stage_still_has_zero_host_drift_allowances() -> None:
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        assert [line for line in (L9_STAGE / name).read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")] == []


def test_the_stage_gate_still_never_authorizes_live_and_reports_the_registered_handler(tmp_path: Path) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")
    auth = tmp_path / "a"
    auth.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L9\ndate={today}\nauthorizer=music\nscope=test only\nreference=https://example.invalid/a1\n")
    k3 = tmp_path / "k"
    k3.write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L9\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=https://example.invalid/k1\n")
    res = subprocess.run(["bash", str(DEPLOY / "p4-stage-gate.sh"), "--stage", "L9", "--mode", "live", "--authorization", str(auth), "--k3", str(k3)], capture_output=True, text=True, check=False)
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout and "K3_CONFIRMATION=VALID" in res.stdout and "ROLLBACK_HANDLER=REGISTERED" in res.stdout
    assert "LIVE_STAGE_AUTHORIZED=NO" in res.stdout
