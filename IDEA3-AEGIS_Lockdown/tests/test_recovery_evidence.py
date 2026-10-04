"""Read-only Recovery R1-R8 evidence checker: hermetic fixtures over temporary SQLite stores and a JSON snapshot.

Nothing here opens a broker, a device, a serial port, the root containment socket or a network listener; the tests
also install tripwires that fail the run if the checker ever tries.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
from pathlib import Path

import pytest

from aegis_soc import config
from aegis_soc import recovery_evidence as ev
from aegis_soc import recovery_protocol as rp
from aegis_soc.protocol_store import ProtocolStore

SOURCE = Path(ev.__file__)
IP = "203.0.113.9"
NOW = 1_800_000_000.0
MSG = "ab" * 16
D4_SECRET = "d4-operator-secret-hunter2"
D4_HASH = "scrypt$16384$8$1$c2FsdA==$aGFzaA=="

R1, R2, R3, R4, R5, R6, R7, R8 = rp.GATES


class World:
    """A configurable fixture; the defaults are the complete, closed, fully evidenced incident."""

    def __init__(self, tmp_path: Path):
        self.dir = tmp_path
        self.ip: str | None = IP
        self.state = "CLOSED"
        self.bound: str | None = f"attacker_ip={IP} source=detector_alert action=CREATED"
        self.r3: str | None = f"result=VERIFIED ip={IP} reason=READ_BACK_CONFIRMED"
        self.r3_after_restore = False
        self.restore = True
        self.restore_rows = 1
        self.published: str | None = f"msg_id={MSG} seq=1"
        self.command: dict | None = {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "ACCEPTED", "status_correlated": 1}
        self.close_row = True
        self.close_before_restore = False
        self.extra_open = False
        self.obs: dict | None = {}  # sections to override or drop (None value drops)
        self.obs_incident = 1
        self.write_protocol = True

    # --- builders
    def audit_path(self) -> Path:
        return self.dir / "audit.sqlite3"

    def build(self) -> dict:
        audit = self.audit_path()
        for stale in (audit, self.dir / "protocol.sqlite3"):
            stale.unlink(missing_ok=True)
        conn = sqlite3.connect(audit)
        conn.executescript(
            "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT DEFAULT 'INFO',"
            " event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT);"
            "CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT, closed_at TEXT,"
            " state TEXT DEFAULT 'OPEN', attacker_ip TEXT, summary TEXT);"
        )
        closed_at = "2026-10-04 10:00:00" if self.state == "CLOSED" else None
        conn.execute("INSERT INTO incidents (opened_at, closed_at, state, attacker_ip) VALUES ('2026-10-04 09:00:00', ?, ?, ?)",
                     (closed_at, self.state, self.ip))
        if self.extra_open:
            conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-10-04 09:30:00', 'OPEN', '198.51.100.7')")

        def event(kind: str, details: str) -> None:
            conn.execute(
                "INSERT INTO audit_logs (timestamp, event_type, details, incident_id) VALUES ('2026-10-04 09:10:00', ?, ?, 1)",
                (kind, details),
            )

        if self.bound is not None:
            event("INCIDENT_BOUND", self.bound)
        if self.r3 is not None and not self.r3_after_restore:
            event("RECOVERY_R3_RESULT", self.r3)
        if self.close_row and self.close_before_restore:
            event("RECOVERY_R8_CLOSE", "summary=done")
        for _ in range(self.restore_rows if self.restore else 0):
            event("RESTORE_REQUESTED", f"credential={D4_SECRET} hash={D4_HASH} reason=owner")
        if self.r3 is not None and self.r3_after_restore:
            event("RECOVERY_R3_RESULT", self.r3)
        if self.published is not None:
            event("RESTORE_PUBLISHED", self.published)
        if self.close_row and not self.close_before_restore:
            event("RECOVERY_R8_CLOSE", "summary=done")
        conn.commit()
        conn.close()

        protocol = self.dir / "protocol.sqlite3"
        if self.write_protocol:
            store = ProtocolStore(protocol)
            store.close()
            if self.command is not None:
                row = {"msg_id": MSG, "device_id": "esp32-01", "seq": 1, "action": "RESTORE_UPLINK", "issued_at": 1, "expires_at": 2,
                       "reserved_at": 0.5, **self.command}
                conn = sqlite3.connect(protocol)
                conn.execute(
                    f"INSERT INTO protocol_commands ({','.join(row)}) VALUES ({','.join('?' * len(row))})", tuple(row.values()),
                )
                conn.commit()
                conn.close()
        observations = self.dir / "observations.json"
        observations.write_text(json.dumps(self.observation_body()))
        return {"audit_db": audit, "protocol_db": protocol, "observations": observations, "incident_id": 1}

    def observation_body(self) -> dict:
        fresh = NOW - 10
        body = {
            "v": 1, "incident_id": self.obs_incident,
            "r2": {"observed_at": fresh, "configured": True, "ok": True},
            "containment": {"observed_at": fresh, "present": True},
            "r6": {"observed_at": fresh, "configured": True, "results": [True, True]},
            "r7": {"observed_at": fresh, "checks": {name: True for name in ev.R7_CHECKS}},
            "device": {"observed_at": fresh, "state": "NORMAL", "correlated_msg_id": MSG},
        }
        for key, value in (self.obs or {}).items():
            if value is None:
                body.pop(key, None)
            else:
                body[key] = value
        return body


def run(world: World, **kwargs) -> dict:
    paths = world.build()
    if not world.write_protocol:
        paths["protocol_db"] = world.dir / "protocol.sqlite3"
    args = {**paths, **kwargs}
    return ev.evaluate(
        args["audit_db"], protocol_db=args.get("protocol_db"), observations=args.get("observations"),
        incident_id=args.get("incident_id"), now=NOW,
    )


def gate(document: dict, name: str) -> dict:
    return next(item for item in document["gates"] if item["gate"] == name)


def verdicts(document: dict) -> dict[str, str]:
    return {item["gate"]: item["verdict"] for item in document["gates"]}


@pytest.fixture
def world(tmp_path) -> World:
    return World(tmp_path)


# --------------------------------------------------------------------------- positive fixture for each gate


def test_every_gate_has_a_positive_fixture(world):
    document = run(world)
    assert verdicts(document) == {name: ev.VERIFIED for name in rp.GATES}
    assert document["overall"] == ev.VERIFIED
    assert document["incident"] == {"id": 1, "state": "CLOSED", "attacker_ip": IP}
    assert gate(document, R1)["evidence"]["detector_alert"] == ev.VERIFIED
    assert gate(document, R5)["evidence"]["executed"] == "DEVICE_REPORTED_NORMAL"
    assert gate(document, R4)["evidence"]["credential"] == "NEVER_READ"
    assert document["claims"] == {"physical_evidence": "NOT_PROVEN", "production": "NOT_PROVEN", "scope": "STORED_STATE_ONLY"}


def test_open_incident_with_complete_evidence_is_only_not_proven_at_r8(world):
    world.state = "OPEN"
    world.close_row = False
    document = run(world, incident_id=None)
    assert [verdicts(document)[name] for name in (R1, R2, R3, R4, R5, R6, R7)] == [ev.VERIFIED] * 7
    assert gate(document, R8)["verdict"] == ev.NOT_PROVEN
    assert gate(document, R8)["reason"] == "INCIDENT_NOT_CLOSED"
    assert document["overall"] == ev.NOT_PROVEN


# --------------------------------------------------------------------------- R1


@pytest.mark.parametrize("bad", ["999.1.1.1", "::1", "2001:db8::1", "127.0.0.1", "0.0.0.0", "224.0.0.1", "169.254.1.1",
                                  " 203.0.113.9", "240.0.0.1", "203.0.113.09", "not-an-ip"])
def test_r1_invalid_attacker_ip_is_blocked_and_blocks_everything_after(world, bad):
    world.ip = bad
    document = run(world)
    assert gate(document, R1)["verdict"] == ev.BLOCKED
    assert gate(document, R1)["reason"] == "ATTACKER_IP_INVALID"
    assert document["incident"] is None
    assert all(verdicts(document)[name] == ev.BLOCKED for name in rp.GATES)
    assert all(gate(document, name)["reason"] == "PREREQUISITE_NOT_VERIFIED" for name in rp.GATES[1:])


@pytest.mark.parametrize("missing", [None, ""])
def test_r1_missing_attacker_ip_is_not_proven(world, missing):
    world.ip = missing
    document = run(world)
    assert gate(document, R1)["verdict"] == ev.NOT_PROVEN
    assert gate(document, R1)["reason"] == "ATTACKER_IP_MISSING"
    assert document["overall"] == ev.NOT_PROVEN or document["overall"] == ev.BLOCKED


def test_r1_no_open_incident_without_id_is_not_proven(world):
    document = run(world, incident_id=None)  # the only incident is CLOSED
    assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.NOT_PROVEN, "NO_OPEN_INCIDENT")


def test_r1_unknown_incident_id_is_not_proven(world):
    document = run(world, incident_id=99)
    assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.NOT_PROVEN, "INCIDENT_NOT_FOUND")


def test_r1_conflicting_open_incidents_are_blocked(world):
    world.state = "OPEN"
    world.close_row = False
    world.extra_open = True
    for explicit in (None, 1):
        document = run(world, incident_id=explicit)
        assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.BLOCKED, "CONFLICTING_OPEN_INCIDENTS")


def test_r1_detector_alert_relationship_is_reported_never_fabricated(world):
    world.bound = None
    document = run(world)
    assert gate(document, R1)["verdict"] == ev.VERIFIED  # Core R1 only needs a valid bound IP
    assert gate(document, R1)["evidence"]["detector_alert"] == ev.NOT_PROVEN
    assert gate(document, R1)["reason"] == "DETECTOR_ALERT_NOT_PROVEN"


def test_r1_manual_source_is_not_a_detector_relationship(world):
    world.bound = f"attacker_ip={IP} source=manual action=CREATED"
    assert gate(run(world), R1)["evidence"]["detector_alert"] == ev.NOT_PROVEN


def test_r1_detector_alert_naming_another_address_is_blocked(world):
    world.bound = "attacker_ip=198.51.100.7 source=detector_alert action=CREATED"
    document = run(world)
    assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.BLOCKED, "DETECTOR_ALERT_IP_CONFLICT")


# --------------------------------------------------------------------------- R2


@pytest.mark.parametrize(
    "section,expected",
    [
        (None, (ev.NOT_PROVEN, "OBSERVATION_SECTION_MISSING")),
        ({"observed_at": NOW - 10, "configured": False, "ok": False}, (ev.NOT_PROVEN, "PROBE_NOT_CONFIGURED")),
        ({"observed_at": NOW - 10, "configured": True, "ok": False}, (ev.BLOCKED, "MANAGEMENT_PROBE_FAILED")),
        ({"observed_at": NOW - 10_000, "configured": True, "ok": True}, (ev.NOT_PROVEN, "OBSERVATION_STALE")),
        ({"observed_at": NOW + 10_000, "configured": True, "ok": True}, (ev.NOT_PROVEN, "OBSERVATION_FROM_THE_FUTURE")),
    ],
)
def test_r2_variants(world, section, expected):
    world.obs = {"r2": section}
    document = run(world)
    assert (gate(document, R2)["verdict"], gate(document, R2)["reason"]) == expected
    assert document["overall"] != ev.VERIFIED


def test_r2_observation_for_another_incident_is_not_proven(world):
    world.obs_incident = 2
    assert (gate(run(world), R2)["reason"]) == "OBSERVATION_INCIDENT_MISMATCH"


def test_r2_blocked_without_r1(world):
    world.ip = "127.0.0.1"
    assert gate(run(world), R2)["reason"] == "PREREQUISITE_NOT_VERIFIED"


# --------------------------------------------------------------------------- R3


@pytest.mark.parametrize(
    "r3,expected",
    [
        (None, (ev.NOT_PROVEN, "ISOLATION_NOT_REQUESTED")),
        (f"result=FAILED ip={IP} reason=HELPER_UNAVAILABLE", (ev.BLOCKED, "ISOLATION_NOT_VERIFIED")),
        ("result=VERIFIED ip=198.51.100.7 reason=READ_BACK_CONFIRMED", (ev.BLOCKED, "ISOLATION_IP_MISMATCH")),
        ("garbage", (ev.BLOCKED, "ISOLATION_RECORD_UNREADABLE")),
    ],
)
def test_r3_variants(world, r3, expected):
    world.r3 = r3
    document = run(world)
    assert (gate(document, R3)["verdict"], gate(document, R3)["reason"]) == expected
    assert document["overall"] != ev.VERIFIED


def test_r3_live_readback_absent_on_open_incident_is_blocked(world):
    world.state = "OPEN"
    world.close_row = False
    world.obs = {"containment": {"observed_at": NOW - 10, "present": False}}
    document = run(world, incident_id=None)
    assert (gate(document, R3)["verdict"], gate(document, R3)["reason"]) == (ev.BLOCKED, "NO_LONGER_CONTAINED")


def test_r3_missing_or_stale_live_readback_is_reported_not_assumed(world):
    for section in (None, {"observed_at": NOW - 10_000, "present": True}):
        w = World(world.dir / ("a" if section is None else "b"))
        w.dir.mkdir()
        w.obs = {"containment": section}
        document = run(w)
        assert gate(document, R3)["verdict"] == ev.VERIFIED
        assert gate(document, R3)["evidence"]["live_readback"] == ev.NOT_PROVEN


# --------------------------------------------------------------------------- R4


def test_r4_no_restore_request_is_not_proven_and_blocks_r5_to_r8(world):
    world.restore = False
    document = run(world)
    assert (gate(document, R4)["verdict"], gate(document, R4)["reason"]) == (ev.NOT_PROVEN, "AWAITING_D4_RESTORE_REQUEST")
    assert [verdicts(document)[name] for name in (R5, R6, R7, R8)] == [ev.BLOCKED] * 4


def test_r4_duplicate_restore_requests_are_blocked(world):
    world.restore_rows = 2
    assert gate(run(world), R4)["reason"] == "CONFLICTING_RESTORE_REQUESTS"


def test_r4_requires_a_verified_r3_row_before_the_restore_request(world):
    world.r3_after_restore = True
    document = run(world)
    assert (gate(document, R4)["verdict"], gate(document, R4)["reason"]) == (ev.BLOCKED, "R3_DID_NOT_PRECEDE_RESTORE")


def test_r4_never_exposes_the_d4_credential(world):
    text = ev.render(run(world))
    for secret in (D4_SECRET, D4_HASH, "hunter2", "scrypt"):
        assert secret not in text


# --------------------------------------------------------------------------- R5


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda w: setattr(w, "published", None), (ev.BLOCKED, "NO_PUBLICATION_EVIDENCE")),
        (lambda w: setattr(w, "published", "msg_id=not-hex"), (ev.BLOCKED, "NO_PUBLICATION_EVIDENCE")),
        (lambda w: setattr(w, "command", None), (ev.BLOCKED, "LINKED_COMMAND_NOT_IN_STORE")),
        (lambda w: setattr(w, "write_protocol", False), (ev.NOT_PROVEN, "PROTOCOL_STORE_MISSING")),
        (lambda w: setattr(w, "command", {"state": "NOT_PUBLISHED", "published_at": None, "ack_result": None, "status_correlated": 0}),
         (ev.BLOCKED, "RESTORE_NOT_PUBLISHED")),
        (lambda w: setattr(w, "command", {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "REJECTED_SEQUENCE", "status_correlated": 0}),
         (ev.BLOCKED, "DEVICE_REJECTED_RESTORE")),
        (lambda w: setattr(w, "command", {"state": "PUBLISHED", "published_at": 1.0, "ack_result": None, "status_correlated": 0}),
         (ev.NOT_PROVEN, "AWAITING_ACK_AND_FRESH_STATUS_NORMAL")),
        (lambda w: setattr(w, "command", {"state": "CLOSED", "published_at": 1.0, "ack_result": None, "status_correlated": 0}),
         (ev.BLOCKED, "OUTCOME_UNKNOWN")),
        (lambda w: setattr(w, "obs", {"device": {"observed_at": NOW - 10, "state": "LOCKDOWN", "correlated_msg_id": MSG}}),
         (ev.BLOCKED, "DEVICE_REPORTED_LOCKDOWN")),
    ],
)
def test_r5_variants(world, mutate, expected):
    mutate(world)
    document = run(world)
    assert (gate(document, R5)["verdict"], gate(document, R5)["reason"]) == expected
    assert document["overall"] != ev.VERIFIED


@pytest.mark.parametrize(
    "device",
    [
        None,
        {"observed_at": NOW - 10_000, "state": "NORMAL", "correlated_msg_id": MSG},  # stale device evidence
        {"observed_at": NOW + 10_000, "state": "NORMAL", "correlated_msg_id": MSG},
        {"observed_at": NOW - 10, "state": "NORMAL", "correlated_msg_id": "cd" * 16},  # not this RESTORE's correlation
        {"observed_at": NOW - 10, "state": "NORMAL", "correlated_msg_id": None},
    ],
)
def test_r5_status_normal_needs_fresh_correlated_device_evidence(world, device):
    world.obs = {"device": device}
    document = run(world)
    assert (gate(document, R5)["verdict"], gate(document, R5)["reason"]) == (ev.NOT_PROVEN, "AWAITING_ACK_AND_FRESH_STATUS_NORMAL")
    assert gate(document, R5)["evidence"]["executed"] == "DEVICE_STATUS_CORRELATED"
    assert [verdicts(document)[name] for name in (R6, R7, R8)] == [ev.BLOCKED] * 3


def test_r5_malformed_protocol_store_is_blocked(world):
    world.build()
    (world.dir / "protocol.sqlite3").write_bytes(b"this is not a database" * 50)
    document = ev.evaluate(world.audit_path(), protocol_db=world.dir / "protocol.sqlite3",
                           observations=world.dir / "observations.json", incident_id=1, now=NOW)
    assert (gate(document, R5)["verdict"], gate(document, R5)["reason"]) == (ev.BLOCKED, "PROTOCOL_STORE_MALFORMED")


def test_r5_protocol_store_without_the_commands_table_is_blocked(world):
    world.build()
    path = world.dir / "other.sqlite3"
    sqlite3.connect(path).execute("CREATE TABLE unrelated (x)").connection.commit()
    document = ev.evaluate(world.audit_path(), protocol_db=path, observations=world.dir / "observations.json", incident_id=1, now=NOW)
    assert gate(document, R5)["reason"] == "PROTOCOL_STORE_MALFORMED"


# --------------------------------------------------------------------------- R6 / R7 / R8


@pytest.mark.parametrize(
    "section,expected",
    [
        (None, (ev.NOT_PROVEN, "OBSERVATION_SECTION_MISSING")),
        ({"observed_at": NOW - 10, "configured": False, "results": []}, (ev.NOT_PROVEN, "PROBES_NOT_CONFIGURED")),
        ({"observed_at": NOW - 10, "configured": True, "results": []}, (ev.NOT_PROVEN, "PROBES_NOT_CONFIGURED")),
        ({"observed_at": NOW - 10, "configured": True, "results": [True, False]}, (ev.BLOCKED, "NETWORK_PROBE_FAILED")),
        ({"observed_at": NOW - 10_000, "configured": True, "results": [True]}, (ev.NOT_PROVEN, "OBSERVATION_STALE")),
    ],
)
def test_r6_variants(world, section, expected):
    world.obs = {"r6": section}
    document = run(world)
    assert (gate(document, R6)["verdict"], gate(document, R6)["reason"]) == expected
    assert [verdicts(document)[name] for name in (R7, R8)] == [ev.BLOCKED] * 2


def test_r6_blocked_when_r5_is_not_verified(world):
    world.command = {"state": "PUBLISHED", "published_at": 1.0, "ack_result": None, "status_correlated": 0}
    assert gate(run(world), R6)["reason"] == "PREREQUISITE_NOT_VERIFIED"


@pytest.mark.parametrize("name", ev.R7_CHECKS)
def test_r7_each_failing_check_blocks(world, name):
    checks = {n: True for n in ev.R7_CHECKS}
    checks[name] = False
    world.obs = {"r7": {"observed_at": NOW - 10, "checks": checks}}
    document = run(world)
    assert (gate(document, R7)["verdict"], gate(document, R7)["reason"]) == (ev.BLOCKED, "SERVICE_NOT_READY")
    assert gate(document, R7)["evidence"]["checks"][name] == "FAIL"
    assert gate(document, R8)["verdict"] == ev.BLOCKED


@pytest.mark.parametrize("name", ev.R7_CHECKS)
def test_r7_each_unproven_check_is_not_proven(world, name):
    checks = {n: True for n in ev.R7_CHECKS}
    checks[name] = None
    world.obs = {"r7": {"observed_at": NOW - 10, "checks": checks}}
    document = run(world)
    assert (gate(document, R7)["verdict"], gate(document, R7)["reason"]) == (ev.NOT_PROVEN, "READINESS_NOT_CONFIGURED")


def test_r7_missing_check_key_and_stale_snapshot_are_not_proven(world):
    world.obs = {"r7": {"observed_at": NOW - 10, "checks": {"core_db": True}}}
    assert gate(run(world), R7)["verdict"] == ev.NOT_PROVEN
    other = World(world.dir / "stale")
    other.dir.mkdir()
    other.obs = {"r7": {"observed_at": NOW - 10_000, "checks": {n: True for n in ev.R7_CHECKS}}}
    assert (gate(run(other), R7)["reason"]) == "OBSERVATION_STALE"


def test_r7_blocked_when_r6_is_not_verified(world):
    world.obs = {"r6": {"observed_at": NOW - 10, "configured": True, "results": [False]}}
    assert gate(run(world), R7)["reason"] == "PREREQUISITE_NOT_VERIFIED"


def test_r8_requires_a_core_close_record_after_the_restore_request(world):
    world.close_row = False
    document = run(world)
    assert (gate(document, R8)["verdict"], gate(document, R8)["reason"]) == (ev.BLOCKED, "NO_CORE_CLOSE_RECORD")
    assert document["overall"] == ev.BLOCKED


@pytest.mark.parametrize("gate_to_break", [R1, R2, R3, R4, R5, R6, R7])
def test_r8_blocked_by_every_unverified_prerequisite(world, gate_to_break):
    mutations = {
        R1: lambda w: setattr(w, "ip", "127.0.0.1"),
        R2: lambda w: setattr(w, "obs", {"r2": None}),
        R3: lambda w: setattr(w, "r3", None),
        R4: lambda w: setattr(w, "restore", False),
        R5: lambda w: setattr(w, "published", None),
        R6: lambda w: setattr(w, "obs", {"r6": None}),
        R7: lambda w: setattr(w, "obs", {"r7": None}),
    }
    mutations[gate_to_break](world)
    document = run(world)
    assert gate(document, gate_to_break)["verdict"] != ev.VERIFIED
    assert (gate(document, R8)["verdict"], gate(document, R8)["reason"]) == (ev.BLOCKED, "PREREQUISITE_NOT_VERIFIED")
    assert gate_to_break in gate(document, R8)["evidence"]["unverified"]
    assert document["overall"] != ev.VERIFIED


# --------------------------------------------------------------------------- malformed / missing stores


def test_missing_audit_store_fails_closed_and_is_never_created(tmp_path):
    path = tmp_path / "absent" / "audit.sqlite3"
    document = ev.evaluate(path, now=NOW)
    assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.NOT_PROVEN, "AUDIT_STORE_MISSING")
    assert all(verdicts(document)[name] != ev.VERIFIED for name in rp.GATES)
    assert document["overall"] == ev.BLOCKED  # R2-R8 are BLOCKED on the unproven R1
    assert not path.exists() and not path.parent.exists()


def test_empty_path_and_directory_are_missing(tmp_path):
    for target in ("", None, tmp_path):
        assert gate(ev.evaluate(target, now=NOW), R1)["reason"] == "AUDIT_STORE_MISSING"


@pytest.mark.parametrize("content", [b"", b"not a sqlite database at all" * 40])
def test_garbage_audit_store_is_blocked(tmp_path, content):
    path = tmp_path / "audit.sqlite3"
    path.write_bytes(content)
    before = path.read_bytes()
    document = ev.evaluate(path, now=NOW)
    assert content == b"" or (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.BLOCKED, "AUDIT_STORE_MALFORMED")
    assert all(verdicts(document)[name] != ev.VERIFIED for name in rp.GATES)
    assert path.read_bytes() == before


def test_audit_store_without_required_tables_or_columns_is_blocked(tmp_path):
    path = tmp_path / "audit.sqlite3"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE incidents (id INTEGER PRIMARY KEY, state TEXT)")
    conn.commit()
    conn.close()
    assert gate(ev.evaluate(path, now=NOW), R1)["reason"] == "AUDIT_STORE_MALFORMED"


@pytest.mark.parametrize(
    "body",
    [
        "{not json", "[]", json.dumps({"v": 2, "incident_id": 1}), json.dumps({"v": 1}),
        json.dumps({"v": 1, "incident_id": True}),
        json.dumps({"v": 1, "incident_id": 1, "extra": {}}),
        json.dumps({"v": 1, "incident_id": 1, "r2": {"observed_at": 1.0, "configured": True, "ok": "yes"}}),
        json.dumps({"v": 1, "incident_id": 1, "r2": {"observed_at": 1.0, "configured": True, "ok": True, "token": "x"}}),
        json.dumps({"v": 1, "incident_id": 1, "r6": {"observed_at": 1.0, "configured": True, "results": ["10.0.0.1:22"]}}),
        json.dumps({"v": 1, "incident_id": 1, "r7": {"observed_at": 1.0, "checks": {"surprise": True}}}),
        json.dumps({"v": 1, "incident_id": 1, "device": {"observed_at": 1.0, "state": "NORMAL", "correlated_msg_id": "short"}}),
        json.dumps({"v": 1, "incident_id": 1, "r2": {"observed_at": "now", "configured": True, "ok": True}}),
        "x" * (ev.MAX_OBSERVATION_BYTES + 1),
    ],
)
def test_malformed_observations_block_observation_gates_and_never_verify(world, body):
    paths = world.build()
    paths["observations"].write_text(body)
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert gate(document, R2)["reason"] == "OBSERVATIONS_MALFORMED"
    assert gate(document, R2)["verdict"] == ev.BLOCKED
    assert document["overall"] != ev.VERIFIED


def test_missing_observation_file_is_not_proven(world):
    paths = world.build()
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=world.dir / "nope.json", incident_id=1, now=NOW)
    assert (gate(document, R2)["verdict"], gate(document, R2)["reason"]) == (ev.NOT_PROVEN, "OBSERVATIONS_MISSING")


def test_no_observations_at_all_never_verifies_probe_gates(world):
    paths = world.build()
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], incident_id=1, now=NOW)
    assert gate(document, R2)["reason"] == "NO_OBSERVATIONS"
    assert gate(document, R5)["verdict"] == ev.NOT_PROVEN  # ACK is durable but nothing proves STATUS=NORMAL
    assert document["overall"] == ev.BLOCKED or document["overall"] == ev.NOT_PROVEN


def test_bad_arguments_are_refused(world):
    paths = world.build()
    for kwargs in ({"incident_id": "1"}, {"now": float("nan")}, {"now": -1}, {"max_age_sec": 0}):
        args = {"now": NOW, "incident_id": 1, **kwargs}
        with pytest.raises(ev.EvidenceError):
            ev.evaluate(paths["audit_db"], **args)


# --------------------------------------------------------------------------- read-only guarantees


def _snapshot(directory: Path) -> dict[str, tuple[str, int]]:
    return {
        path.name: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
        for path in sorted(directory.iterdir()) if path.is_file()
    }


def test_zero_db_writes_stores_and_directory_are_untouched(world):
    paths = world.build()
    before = _snapshot(world.dir)
    listing = sorted(os.listdir(world.dir))
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert document["overall"] == ev.VERIFIED
    assert _snapshot(world.dir) == before
    assert sorted(os.listdir(world.dir)) == listing  # no -wal/-shm/-journal sidecar appeared


def test_works_on_read_only_files_in_a_read_only_directory(world):
    paths = world.build()
    for path in world.dir.iterdir():
        path.chmod(0o444)
    world.dir.chmod(0o555)
    try:
        document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    finally:
        world.dir.chmod(0o755)
    assert document["overall"] == ev.VERIFIED


def test_store_with_pending_wal_is_not_proven_and_gets_no_sidecars(world):
    paths = world.build()
    writer = sqlite3.connect(paths["protocol_db"])
    writer.execute("PRAGMA journal_mode = WAL")
    writer.execute("INSERT INTO protocol_sequence (device_id, last_allocated_seq) VALUES ('esp32-02', 1)")
    writer.commit()
    try:
        assert Path(f"{paths['protocol_db']}-wal").stat().st_size > 0
        before = sorted(os.listdir(world.dir))
        document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
        assert (gate(document, R5)["verdict"], gate(document, R5)["reason"]) == (ev.NOT_PROVEN, "PROTOCOL_STORE_WAL_PENDING")
        assert sorted(os.listdir(world.dir)) == before
    finally:
        writer.close()


def test_store_connections_cannot_write(world):
    paths = world.build()
    conn = ev._open_ro(paths["audit_db"], {"audit_logs": ev._AUDIT_COLUMNS})
    try:
        for statement in ("INSERT INTO audit_logs (event_type) VALUES ('X')", "UPDATE incidents SET state='CLOSED'",
                          "DELETE FROM audit_logs", "CREATE TABLE t (x)"):
            with pytest.raises(sqlite3.OperationalError):
                conn.execute(statement)
    finally:
        conn.close()


@pytest.fixture
def tripwires(monkeypatch):
    """Any network, subprocess, MQTT, nft or serial attempt fails the test."""
    calls: list[str] = []

    def trip(name):
        def _raise(*args, **kwargs):
            calls.append(name)
            raise AssertionError(f"forbidden call: {name}")
        return _raise

    for attribute in ("connect", "connect_ex", "bind", "listen", "sendto", "send", "sendall"):
        monkeypatch.setattr(socket.socket, attribute, trip(f"socket.{attribute}"))
    monkeypatch.setattr(socket, "create_connection", trip("socket.create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", trip("socket.getaddrinfo"))
    monkeypatch.setattr(subprocess, "Popen", trip("subprocess.Popen"))
    monkeypatch.setattr(os, "system", trip("os.system"))
    try:
        import paho.mqtt.client as mqtt
        monkeypatch.setattr(mqtt.Client, "publish", trip("mqtt.publish"))
        monkeypatch.setattr(mqtt.Client, "connect", trip("mqtt.connect"))
    except ImportError:
        pass
    from aegis_soc import ip_containment
    monkeypatch.setattr(ip_containment.ContainmentClient, "block", trip("containment.block"))
    monkeypatch.setattr(ip_containment.ContainmentClient, "unblock", trip("containment.unblock"), raising=False)
    monkeypatch.setattr(ip_containment.ContainmentClient, "contains", trip("containment.contains"))
    monkeypatch.setattr(ProtocolStore, "reserve_command", trip("store.reserve_command"))
    return calls


def test_zero_network_mqtt_nft_serial_calls(world, tripwires):
    paths = world.build()
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    ev.render(document)
    assert document["overall"] == ev.VERIFIED
    assert tripwires == []


def test_the_checker_does_not_load_a_serial_stack():
    import sys
    assert "serial" not in sys.modules and "esptool" not in sys.modules


def test_module_source_has_no_forbidden_capability():
    tree = ast.parse(SOURCE.read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    assert imported <= {"__future__", "argparse", "json", "math", "os", "re", "sqlite3", "sys", "pathlib", "typing", "urllib", "time"}
    modules = {alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 1 for alias in node.names}
    modules |= {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module}
    assert modules <= {"local_restore", "recovery_protocol", "ip_containment", "recovery_core", "ContainmentRejected", "validate_block_target", "_PUBLISHED_RE", "_R3_RE"}
    names = {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)} | {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    }
    forbidden = {"publish", "connect_ex", "create_connection", "Popen", "system", "check_output", "check_call", "block", "unblock",
                 "contains", "ContainmentClient", "executescript", "executemany", "commit", "serial", "nft", "reserve_command",
                 "log_event", "log_event_strict", "init_db", "write_text", "write_bytes", "unlink", "mkdir", "chmod", "rename"}
    assert not (names & forbidden), names & forbidden
    sql_write = re.compile(r"^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|VACUUM|ATTACH)\b", re.I)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert not sql_write.search(node.value), node.value
    assert "mode=ro" in SOURCE.read_text() and "query_only" in SOURCE.read_text()


def test_importing_the_checker_leaves_no_log_file(tmp_path):
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "PYTHONPATH": str(SOURCE.parent.parent)}
    result = subprocess.run(
        [os.sys.executable, "-c", "import aegis_soc.recovery_evidence"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------- secret-safe, deterministic output


def test_output_is_secret_safe_deterministic_and_fixed_vocabulary(world):
    world.published = f"msg_id={MSG} seq=1 token=should-never-be-printed"
    paths = world.build()
    conn = sqlite3.connect(paths["audit_db"])
    conn.execute("UPDATE audit_logs SET details = details || ' password=hunter2' WHERE event_type != 'RESTORE_REQUESTED'")
    conn.commit()
    conn.close()
    kwargs = dict(protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    first = ev.render(ev.evaluate(paths["audit_db"], **kwargs))
    second = ev.render(ev.evaluate(paths["audit_db"], **kwargs))
    assert first == second
    for secret in (D4_SECRET, D4_HASH, "hunter2", "should-never-be-printed", "password", "scrypt"):
        assert secret not in first
    assert json.loads(first)["schema"] == ev.SCHEMA
    assert first == json.dumps(json.loads(first), sort_keys=True, indent=2) + "\n"


def test_render_refuses_credential_shaped_output():
    for leak in (D4_HASH, "-----BEGIN PRIVATE KEY-----", "password=abc", "token: abc"):
        with pytest.raises(ev.EvidenceError):
            ev.render({"leak": leak})


def test_cli_exit_codes_and_json(world, capsys):
    paths = world.build()
    base = ["--audit-db", str(paths["audit_db"]), "--protocol-db", str(paths["protocol_db"]),
            "--observations", str(paths["observations"]), "--incident-id", "1", "--now", str(NOW)]
    assert ev.main(base) == 0
    assert json.loads(capsys.readouterr().out)["overall"] == ev.VERIFIED
    assert ev.main(["--audit-db", str(paths["audit_db"]), "--incident-id", "1", "--now", str(NOW)]) == 2  # no observations: R5 onward BLOCKED
    out = json.loads(capsys.readouterr().out)
    assert out["overall"] in (ev.BLOCKED, ev.NOT_PROVEN)
    assert ev.main(["--audit-db", str(world.dir / "none.db"), "--now", str(NOW)]) in (2, 3)
    capsys.readouterr()
    assert ev.main(base[:-1] + ["-5"]) == 4
    assert "refused" in capsys.readouterr().err


# --------------------------------------------------------------------------- parity with the Core authority


class _StubSettings:
    profile = "production"
    dry_run = False


class _CoreStub:
    """Just enough supervisor for the Core's own (read-only) R1/R3/R4/R5 gate functions."""

    settings = _StubSettings()

    def __init__(self, store: ProtocolStore, physical):
        self.protocol = type("Context", (), {"store": store, "device_id": "esp32-01"})()
        self.awaiting_physical_confirmation = physical


@pytest.mark.parametrize(
    "mutate",
    [
        lambda w: None,
        lambda w: setattr(w, "ip", "127.0.0.1"),
        lambda w: setattr(w, "r3", f"result=FAILED ip={IP} reason=X"),
        lambda w: setattr(w, "r3", None),
        lambda w: setattr(w, "restore", False),
        lambda w: setattr(w, "published", None),
        lambda w: setattr(w, "command", {"state": "PUBLISHED", "published_at": 1.0, "ack_result": None, "status_correlated": 0}),
        lambda w: setattr(w, "command", {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "REJECTED_EXPIRED", "status_correlated": 0}),
        lambda w: setattr(w, "command", None),
    ],
)
def test_verified_agrees_with_the_core_gate_functions(world, monkeypatch, mutate):
    from aegis_soc import database as db
    from aegis_soc.recovery_core import CoreRecoveryService

    world.state = "OPEN"
    world.close_row = False
    mutate(world)
    paths = world.build()
    ours = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=None, now=NOW)

    core_copy = world.dir / "core-copy.sqlite3"
    shutil.copyfile(paths["audit_db"], core_copy)
    monkeypatch.setattr(config, "DB_PATH", str(core_copy))
    store = ProtocolStore(paths["protocol_db"])
    try:
        service = CoreRecoveryService(_CoreStub(store, {"nonce": MSG, "observed_state": "NORMAL"}), clock=lambda: NOW)
        incident = db.get_open_incident()
        r1 = service._incident_gate(incident)
        theirs = {
            R1: r1["status"], R3: service._isolation_gate(incident)["status"],
            R4: service._authorization_gate(incident)["status"], R5: service._restore_gate(incident)[0]["status"],
        }
    finally:
        store.close()
    for name, status in theirs.items():
        # Core R3/R5 do not require the earlier gates; ours additionally gate on prerequisites, so compare only when the
        # prerequisite chain is intact. The invariant that matters: we never VERIFY what the Core does not.
        if verdicts(ours)[name] == ev.VERIFIED:
            assert status == rp.VERIFIED, name
    if r1["status"] == rp.VERIFIED and theirs[R3] == rp.VERIFIED and theirs[R4] == rp.VERIFIED and theirs[R5] == rp.VERIFIED:
        assert verdicts(ours)[R5] == ev.VERIFIED


# --------------------------------------------------------------------------- hot journal / WAL sidecars (review B1)


def _hot_journal_snapshot(source: Path, target_dir: Path) -> Path:
    """A crash-style snapshot: the DB file with UNCOMMITTED pages spilled into it, plus the real non-empty hot journal.

    The committed state has an incident without an attacker_ip; the never-committed transaction sets a valid one.
    """
    work = target_dir / "live"
    work.mkdir()
    db_path = work / "audit.sqlite3"
    shutil.copyfile(source, db_path)
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.execute("PRAGMA cache_size = 1")
    conn.execute("BEGIN")
    conn.execute("UPDATE incidents SET attacker_ip = ? WHERE id = 1", (IP,))
    conn.executemany("INSERT INTO audit_logs (event_type, details) VALUES ('PAD', ?)", [("x" * 900,)] * 3000)
    journal = Path(f"{db_path}-journal")
    assert journal.exists() and journal.stat().st_size > 0
    snap = target_dir / "snap"
    snap.mkdir()
    shutil.copyfile(db_path, snap / "audit.sqlite3")
    shutil.copyfile(journal, snap / "audit.sqlite3-journal")
    conn.execute("ROLLBACK")
    conn.close()
    return snap / "audit.sqlite3"


def test_hot_audit_journal_is_refused_and_uncommitted_state_never_verifies(world):
    world.ip = None  # committed truth: R1 has no attacker_ip
    world.state = "OPEN"
    world.close_row = False
    paths = world.build()
    snapshot = _hot_journal_snapshot(paths["audit_db"], world.dir)
    # the reproduction is real: without the journal SQLite would hand back the uncommitted address as if committed
    raw = sqlite3.connect(f"file:{snapshot}?mode=ro&immutable=1", uri=True)
    assert raw.execute("SELECT attacker_ip FROM incidents WHERE id = 1").fetchone()[0] == IP
    raw.close()
    before = sorted(os.listdir(snapshot.parent))
    document = ev.evaluate(snapshot, protocol_db=paths["protocol_db"], observations=paths["observations"], now=NOW)
    assert (gate(document, R1)["verdict"], gate(document, R1)["reason"]) == (ev.NOT_PROVEN, "AUDIT_STORE_JOURNAL_PENDING")
    assert document["incident"] is None and document["overall"] == ev.BLOCKED
    assert all(verdicts(document)[name] != ev.VERIFIED for name in rp.GATES)
    assert sorted(os.listdir(snapshot.parent)) == before  # nothing replayed, rolled back or created


def test_hot_protocol_journal_is_refused_and_never_verifies_r5(world):
    paths = world.build()
    Path(f"{paths['protocol_db']}-journal").write_bytes(b"\x00hot journal bytes" * 8)
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert (gate(document, R5)["verdict"], gate(document, R5)["reason"]) == (ev.NOT_PROVEN, "PROTOCOL_STORE_JOURNAL_PENDING")
    assert gate(document, R5)["verdict"] != ev.VERIFIED and document["overall"] != ev.VERIFIED
    assert [verdicts(document)[name] for name in (R6, R7, R8)] == [ev.BLOCKED] * 3


def test_zero_byte_journal_and_wal_sidecars_are_allowed(world):
    paths = world.build()
    for store in (paths["audit_db"], paths["protocol_db"]):
        Path(f"{store}-journal").write_bytes(b"")
        Path(f"{store}-wal").write_bytes(b"")
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert document["overall"] == ev.VERIFIED


def test_non_empty_wal_on_the_audit_store_is_refused_distinctly_from_a_journal(world):
    paths = world.build()
    Path(f"{paths['audit_db']}-wal").write_bytes(b"wal")
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert gate(document, R1)["reason"] == "AUDIT_STORE_WAL_PENDING"
    assert gate(document, R1)["verdict"] == ev.NOT_PROVEN
    Path(f"{paths['audit_db']}-wal").unlink()
    Path(f"{paths['audit_db']}-journal").write_bytes(b"j")
    assert gate(ev.evaluate(paths["audit_db"], incident_id=1, now=NOW), R1)["reason"] == "AUDIT_STORE_JOURNAL_PENDING"
    Path(f"{paths['audit_db']}-journal").unlink()
    paths["audit_db"].write_bytes(b"garbage" * 100)
    assert gate(ev.evaluate(paths["audit_db"], incident_id=1, now=NOW), R1)["reason"] == "AUDIT_STORE_MALFORMED"


def test_open_ro_closes_the_connection_when_schema_validation_fails(world, monkeypatch):
    paths = world.build()
    opened = []
    real = sqlite3.connect

    def spy(*args, **kwargs):
        conn = real(*args, **kwargs)
        opened.append(conn)
        return conn

    monkeypatch.setattr(ev.sqlite3, "connect", spy)
    with pytest.raises(ev.StoreProblem):
        ev._open_ro(paths["audit_db"], {"nonexistent_table": {"x"}})
    assert len(opened) == 1
    with pytest.raises(sqlite3.ProgrammingError):  # "Cannot operate on a closed database."
        opened[0].execute("SELECT 1")


# --------------------------------------------------------------------------- pinned properties


def _traced_statements(monkeypatch) -> list[str]:
    statements: list[str] = []
    real = sqlite3.connect

    def traced(*args, **kwargs):
        conn = real(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(ev.sqlite3, "connect", traced)
    return statements


def test_r4_select_never_reads_the_details_column(world, monkeypatch):
    paths = world.build()
    statements = _traced_statements(monkeypatch)  # installed after the fixture so only the checker's SQL is captured
    document = ev.evaluate(paths["audit_db"], protocol_db=paths["protocol_db"], observations=paths["observations"], incident_id=1, now=NOW)
    assert gate(document, R4)["verdict"] == ev.VERIFIED
    restore_selects = [text for text in statements if "RESTORE_REQUESTED" in text]
    assert restore_selects, "the R4 query must have run"
    for text in restore_selects:
        assert re.fullmatch(r"\s*SELECT id, timestamp FROM audit_logs WHERE event_type = 'RESTORE_REQUESTED' AND incident_id = \d+ ORDER BY id\s*", text), text
        assert "details" not in text
    # and no statement anywhere asks for details of a RESTORE_REQUESTED row via a wildcard
    assert not any("SELECT *" in text and "audit_logs" in text for text in statements)


def test_r8_close_row_before_the_restore_request_is_blocked(world):
    world.close_before_restore = True
    document = run(world)
    assert (gate(document, R8)["verdict"], gate(document, R8)["reason"]) == (ev.BLOCKED, "CLOSE_PRECEDES_RESTORE")
    assert [verdicts(document)[name] for name in (R1, R2, R3, R4, R5, R6, R7)] == [ev.VERIFIED] * 7
    assert document["overall"] == ev.BLOCKED


def test_query_only_is_on_for_every_opened_store(world, monkeypatch):
    statements = _traced_statements(monkeypatch)
    paths = world.build()
    for store, required in ((paths["audit_db"], {"audit_logs": ev._AUDIT_COLUMNS}), (paths["protocol_db"], {"protocol_commands": ev._PROTOCOL_COLUMNS})):
        conn = ev._open_ro(store, required)
        try:
            assert conn.execute("PRAGMA query_only").fetchone()[0] == 1
        finally:
            conn.close()
    assert sum(1 for text in statements if text.strip().upper() == "PRAGMA QUERY_ONLY = ON") == 2
