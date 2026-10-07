"""L8u passive observer: logical acceptance from Core-owned runtime + durable Protocol-v1 evidence. Hermetic SQLite/status fixtures; the observer opens databases mode=ro and nothing else."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

import l8u_support as s

obs = s.load(s.OBSERVE, "p4_l8u_observe")
PID = 4242
FW = "f" * 64


class World:
    def __init__(self, tmp: Path, *, state: str = "LOCKDOWN", consumed_at: float | None = None) -> None:
        self.tmp = tmp
        self.consumed_at = consumed_at if consumed_at is not None else time.time() - 30
        self.audit, self.protocol = tmp / "audit.sqlite3", tmp / "protocol.sqlite3"
        with sqlite3.connect(self.audit) as db:
            db.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT, details TEXT)")
            db.execute("INSERT INTO audit_logs(event_type, details) VALUES ('DEVICE_STATUS', 'LOCKDOWN (old)')")
        with sqlite3.connect(self.protocol) as db:
            db.execute("CREATE TABLE protocol_seen_d2c (device_id TEXT NOT NULL, msg_id TEXT NOT NULL, kind TEXT NOT NULL, received_at REAL NOT NULL, PRIMARY KEY (device_id, msg_id))")
            db.execute("CREATE TABLE protocol_commands (msg_id TEXT PRIMARY KEY, device_id TEXT, action TEXT)")
            db.execute("INSERT INTO protocol_seen_d2c VALUES ('esp32-01', 'old', 'STATUS', ?)", (self.consumed_at - 100,))
        self.status_path = tmp / "status.json"
        self.marker = tmp / "marker"
        self.write_marker()
        self.write_status(state)

    def write_marker(self, **override: str) -> None:
        values = {"L8U_ATTEMPT_CONSUMED": "YES", "L8U_RERUN_ALLOWED": "NO", "L8U_DEVICE_ID": "esp32-01", "L8U_CONSUMED_AT_EPOCH": f"{self.consumed_at:.6f}", "L8U_PRE_PROTOCOL_SEEN_ID": "1", "L8U_PRE_AUDIT_ID": "1", "L8U_PRE_COMMAND_ROWID": "0", **override}
        self.marker.write_text("".join(f"{k}={v}\n" for k, v in values.items()))

    def write_status(self, state: str = "LOCKDOWN", **override) -> None:
        doc = {"pid": PID, "updated_at": time.time(), "state": state, "uplink": state, "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", **override}
        self.status_path.write_text(json.dumps(doc))

    def add_status(self, state: str = "LOCKDOWN", msg: str = "new", at: float | None = None) -> None:
        with sqlite3.connect(self.protocol) as db:
            db.execute("INSERT INTO protocol_seen_d2c VALUES ('esp32-01', ?, 'STATUS', ?)", (msg, at if at is not None else time.time()))
        with sqlite3.connect(self.audit) as db:
            db.execute("INSERT INTO audit_logs(event_type, details) VALUES ('DEVICE_STATUS', ?)", (f"{state} (observed)",))

    def verify(self, expected: str = "LOCKDOWN") -> None:
        obs.verify_once(core_pid=PID, device_id="esp32-01", expected_state=expected, marker=self.marker, audit_db=self.audit, protocol_db=self.protocol, status_path=self.status_path)


def fails(world: World, reason: str, expected: str = "LOCKDOWN") -> None:
    with pytest.raises(obs.ObserveError, match=reason):
        world.verify(expected)


def test_a_valid_observation_passes(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    w.verify()


def test_normal_state_acceptance_is_supported_when_pinned(tmp_path: Path) -> None:
    w = World(tmp_path, state="NORMAL")
    w.add_status("NORMAL")
    w.verify("NORMAL")
    fails(w, "STATUS_STATE_NOT_EXPECTED", "LOCKDOWN")


def test_no_authenticated_status_after_the_attempt_fails(tmp_path: Path) -> None:
    w = World(tmp_path)
    with sqlite3.connect(w.audit) as db:
        db.execute("INSERT INTO audit_logs(event_type, details) VALUES ('DEVICE_STATUS', 'LOCKDOWN (x)')")
    fails(w, "AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT")  # an audit row alone proves nothing without the protocol row


def test_a_status_received_before_the_attempt_does_not_count(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status(at=w.consumed_at - 1)
    fails(w, "AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT")


def test_a_protocol_status_without_the_audit_row_fails(tmp_path: Path) -> None:
    w = World(tmp_path)
    with sqlite3.connect(w.protocol) as db:
        db.execute("INSERT INTO protocol_seen_d2c VALUES ('esp32-01', 'only-proto', 'STATUS', ?)", (time.time(),))
    fails(w, "DEVICE_STATUS_AUDIT_NOT_OBSERVED_AFTER_THE_ATTEMPT")


def test_a_status_from_another_device_does_not_count(tmp_path: Path) -> None:
    w = World(tmp_path)
    with sqlite3.connect(w.protocol) as db:
        db.execute("INSERT INTO protocol_seen_d2c VALUES ('other-device', 'x', 'STATUS', ?)", (time.time(),))
    with sqlite3.connect(w.audit) as db:
        db.execute("INSERT INTO audit_logs(event_type, details) VALUES ('DEVICE_STATUS', 'LOCKDOWN (x)')")
    fails(w, "AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT")


def test_an_ack_or_other_kind_is_not_a_status(tmp_path: Path) -> None:
    w = World(tmp_path)
    with sqlite3.connect(w.protocol) as db:
        db.execute("INSERT INTO protocol_seen_d2c VALUES ('esp32-01', 'ack1', 'ACK', ?)", (time.time(),))
    with sqlite3.connect(w.audit) as db:
        db.execute("INSERT INTO audit_logs(event_type, details) VALUES ('DEVICE_STATUS', 'LOCKDOWN (x)')")
    fails(w, "AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT")


@pytest.mark.parametrize("key,value,reason", [
    ("time_trust", "UNSYNCED", "STATUS_TIME_TRUST_NOT_EXPECTED"), ("broker", "DISCONNECTED", "STATUS_BROKER_NOT_EXPECTED"), ("device", "OFFLINE", "STATUS_DEVICE_NOT_EXPECTED"),
    ("state", "NORMAL", "STATUS_STATE_NOT_EXPECTED"), ("uplink", "NORMAL", "STATUS_UPLINK_NOT_EXPECTED"), ("pid", 1, "STATUS_PID_MISMATCH"),
])
def test_a_runtime_status_mismatch_fails(tmp_path: Path, key: str, value, reason: str) -> None:
    w = World(tmp_path)
    w.add_status()
    w.write_status(**{key: value})
    fails(w, reason)


def test_a_status_document_older_than_the_attempt_fails(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    w.write_status(updated_at=w.consumed_at - 5)
    fails(w, "STATUS_NOT_REFRESHED_AFTER_THE_ATTEMPT")


def test_a_missing_or_malformed_status_document_fails(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    w.status_path.write_text("not json")
    fails(w, "STATUS_UNREADABLE")
    w.status_path.unlink()
    fails(w, "STATUS_UNREADABLE")
    w.status_path.write_text("[]")
    fails(w, "STATUS_PID_MISMATCH")


def test_a_command_issued_during_the_window_fails(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    with sqlite3.connect(w.protocol) as db:
        db.execute("INSERT INTO protocol_commands VALUES ('cmd1', 'esp32-01', 'CUT_UPLINK')")
    fails(w, "COMMAND_ISSUED_DURING_OBSERVATION")


@pytest.mark.parametrize("event", ["COMMAND_QUEUED", "COMMAND_REJECTED", "ACK_RECEIVED", "RECOVERY_STEP", "RECOVERY_R3_REQUESTED", "MODE_CHANGE", "INCIDENT_CLOSED"])
def test_an_actuation_event_in_the_audit_log_fails(tmp_path: Path, event: str) -> None:
    w = World(tmp_path)
    w.add_status()
    with sqlite3.connect(w.audit) as db:
        db.execute("INSERT INTO audit_logs(event_type, details) VALUES (?, 'x')", (event,))
    fails(w, "ACTUATION_EVENT_DURING_OBSERVATION")


def test_marker_problems_fail(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    w.write_marker(L8U_DEVICE_ID="other")
    fails(w, "L8U_MARKER_NOT_THIS_ATTEMPT")
    w.write_marker(L8U_RERUN_ALLOWED="YES")
    fails(w, "L8U_MARKER_NOT_THIS_ATTEMPT")
    w.write_marker(L8U_PRE_AUDIT_ID="x")
    fails(w, "L8U_MARKER_BOUNDARY_INVALID")
    w.marker.unlink()
    fails(w, "L8U_MARKER_UNREADABLE")
    link = tmp_path / "link"
    w.write_marker()
    link.symlink_to(w.marker)
    w.marker = link
    fails(w, "L8U_MARKER_NOT_A_REGULAR_FILE")


def test_the_bounded_poll_succeeds_when_evidence_arrives_and_otherwise_times_out(tmp_path: Path) -> None:
    w = World(tmp_path)
    kwargs = dict(core_pid=PID, device_id="esp32-01", expected_state="LOCKDOWN", marker=w.marker, audit_db=w.audit, protocol_db=w.protocol, status_path=w.status_path)
    started = time.monotonic()
    with pytest.raises(obs.ObserveError, match="OBSERVATION_DEADLINE:AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT"):
        obs.verify(1, interval=0.2, **kwargs)
    assert time.monotonic() - started < 5
    w.add_status()
    obs.verify(1, interval=0.2, **kwargs)


def test_the_observer_never_writes_sqlite(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    before = (hashlib.sha256(w.audit.read_bytes()).hexdigest(), hashlib.sha256(w.protocol.read_bytes()).hexdigest())
    w.verify()
    assert (hashlib.sha256(w.audit.read_bytes()).hexdigest(), hashlib.sha256(w.protocol.read_bytes()).hexdigest()) == before
    con = obs._connect(w.audit)
    with pytest.raises(sqlite3.OperationalError):
        con.execute("INSERT INTO audit_logs(event_type, details) VALUES ('X', 'y')")
    con.close()


def test_capture_boundary_reports_high_water_marks(tmp_path: Path) -> None:
    w = World(tmp_path)
    w.add_status()
    boundary = obs.capture_boundary(w.audit, w.protocol, "esp32-01")
    assert boundary == {"L8U_PRE_PROTOCOL_SEEN_ID": 2, "L8U_PRE_AUDIT_ID": 2, "L8U_PRE_COMMAND_ROWID": 0}
    with pytest.raises(obs.ObserveError, match="DEVICE_ID_INVALID"):
        obs.capture_boundary(w.audit, w.protocol, "bad id")


def test_the_preflight_requires_the_pinned_runtime_state_before_the_attempt_is_consumed(tmp_path: Path) -> None:
    w = World(tmp_path)
    obs.preflight(PID, "LOCKDOWN", w.status_path)
    with pytest.raises(obs.ObserveError, match="PREFLIGHT_STATUS_STATE_NOT_EXPECTED"):
        obs.preflight(PID, "NORMAL", w.status_path)
    w.write_status(time_trust="UNSYNCED")
    with pytest.raises(obs.ObserveError, match="PREFLIGHT_STATUS_TIME_TRUST_NOT_EXPECTED"):
        obs.preflight(PID, "LOCKDOWN", w.status_path)
    with pytest.raises(obs.ObserveError, match="EXPECTED_STATE_INVALID"):
        obs.preflight(PID, "ANY", w.status_path)


# ---- historical L8p evidence (read-only predecessor proof) --------------------------------------------------------------------------------------


def bundle(tmp: Path, **override) -> tuple[Path, str]:
    doc = {"schema_version": 1, "run_id": "l8p-20261004-041840", "device_mac": s.MAC, "chip_identity": "ESP32", "flash_size": "4MB", "firmware_sha256": FW, "nvs_schema_version": 1,
           "nvs_readback_match": "PASS", "firmware_readback_match": "PASS", "flash_result": "PASS", "boot_verification_result": "PASS", "failure_boundary": "NONE", **override}
    path = tmp / "l8p-run.json"
    path.write_text(json.dumps(doc, indent=2, sort_keys=True))
    path.chmod(0o600)
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_historical_l8p_bundle_matching_the_pins_is_accepted(tmp_path: Path) -> None:
    path, sha = bundle(tmp_path)
    obs.check_l8p_evidence(path, sha, s.MAC.upper(), FW)  # MAC comparison is case-insensitive


@pytest.mark.parametrize("override,reason", [
    ({"device_mac": "aa:bb:cc:dd:ee:99"}, "L8P_EVIDENCE_DEVICE_MAC_MISMATCH"), ({"firmware_sha256": "e" * 64}, "L8P_EVIDENCE_FIRMWARE_MISMATCH"), ({"nvs_readback_match": "FAIL"}, "L8P_EVIDENCE_NVS_READBACK_MATCH_NOT_PASS"),
    ({"firmware_readback_match": "FAIL"}, "L8P_EVIDENCE_FIRMWARE_READBACK_MATCH_NOT_PASS"), ({"flash_result": "FAIL"}, "L8P_EVIDENCE_FLASH_RESULT_NOT_PASS"),
    ({"boot_verification_result": "NOT_PROVEN"}, "L8P_EVIDENCE_BOOT_VERIFICATION_RESULT_NOT_PASS"), ({"failure_boundary": "DEVICE_WRITE"}, "L8P_EVIDENCE_FAILURE_BOUNDARY_NOT_NONE"),
    ({"schema_version": 2}, "L8P_EVIDENCE_SCHEMA_INVALID"), ({"wifi_psk": "secret"}, "L8P_EVIDENCE_FIELD_SET_INVALID"),
])
def test_a_historical_bundle_that_does_not_match_the_pins_is_refused(tmp_path: Path, override: dict, reason: str) -> None:
    path, sha = bundle(tmp_path, **override)
    with pytest.raises(obs.ObserveError, match=reason):
        obs.check_l8p_evidence(path, sha, s.MAC, FW)


def test_a_historical_bundle_with_the_wrong_bytes_mode_or_type_is_refused(tmp_path: Path) -> None:
    path, sha = bundle(tmp_path)
    with pytest.raises(obs.ObserveError, match="L8P_EVIDENCE_SHA256_MISMATCH"):
        obs.check_l8p_evidence(path, "0" * 64, s.MAC, FW)
    with pytest.raises(obs.ObserveError, match="L8P_EVIDENCE_PIN_INVALID"):
        obs.check_l8p_evidence(path, "abc", s.MAC, FW)
    path.chmod(0o644)
    with pytest.raises(obs.ObserveError, match="L8P_EVIDENCE_NOT_A_PRIVATE_REGULAR_FILE"):
        obs.check_l8p_evidence(path, sha, s.MAC, FW)
    path.chmod(0o600)
    link = tmp_path / "link.json"
    link.symlink_to(path)
    with pytest.raises(obs.ObserveError, match="L8P_EVIDENCE_NOT_A_PRIVATE_REGULAR_FILE"):
        obs.check_l8p_evidence(link, sha, s.MAC, FW)
    with pytest.raises(obs.ObserveError, match="L8P_EVIDENCE_UNREADABLE"):
        obs.check_l8p_evidence(tmp_path / "missing.json", sha, s.MAC, FW)


def test_the_cli_refuses_invalid_arguments_and_never_needs_a_device(tmp_path: Path) -> None:
    run = s.bash(f'python3 -I "{s.OBSERVE}" --verify --device-id esp32-01 --core-pid 0 --expected-state LOCKDOWN --observe-seconds 30')
    assert run.returncode == 1 and "L8U_OBSERVE=FAIL reason=INVALID_ARGUMENTS" in run.stderr
    run = s.bash(f'python3 -I "{s.OBSERVE}" --verify --device-id esp32-01 --core-pid 5 --expected-state LOCKDOWN --observe-seconds 3')
    assert run.returncode == 1 and "INVALID_ARGUMENTS" in run.stderr
    run = s.bash(f'python3 -I "{s.OBSERVE}" --capture-boundary --device-id "bad id"')
    assert run.returncode == 1 and "DEVICE_ID_INVALID" in run.stderr
