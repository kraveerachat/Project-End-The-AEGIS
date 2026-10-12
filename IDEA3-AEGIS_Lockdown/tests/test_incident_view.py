"""Read-only incident view over the Core-attested Recovery STATUS operation: validation, freshness, fail-closed, STATUS only."""

from __future__ import annotations

import ast
import json
import os
import socket
import tempfile
import threading
from pathlib import Path

import pytest

from aegis_soc import incident_view as iv
from aegis_soc import recovery_client as rc
from aegis_soc import recovery_protocol as rp

NOW = 1_800_000_000.0
SRC_IP = "192.0.2.10"
ERRORS = (rc.RecoveryUnavailable, rc.RecoveryOutcomeUnknown)
MY_UID = os.geteuid()


def gate(name, status="PENDING", checked=NOW - 10, summary="s", detail="d"):
    return {"gate": name, "status": status, "summary": summary, "detail": detail, "checked_at": checked}


def all_gates(**overrides):
    out = []
    for name, _ in iv.GATES:
        out.append(overrides.get(name, gate(name)))
    return out


def payload(*, incident="default", gates="default", **extra):
    data = {
        "incident": {"id": 2, "state": "OPEN", "opened_at": "2026-10-06 11:07:17", "attacker_ip": SRC_IP}
        if incident == "default" else incident,
        "gates": all_gates() if gates == "default" else gates,
        "restore": None,
    }
    data.update(extra)
    return {"v": 1, "ok": True, "code": "STATUS", "detail": "Core-attested recovery state", "data": data}


def states(snapshot):
    return {g.gate: g.state for g in snapshot.gates}


# ---- valid answers ---------------------------------------------------------------------------------------------------------
def test_a_valid_status_shows_incident_source_and_every_gate_with_authority_and_time():
    shot = iv.parse_status(payload(gates=all_gates(
        R1_INCIDENT_CONTEXT=gate("R1_INCIDENT_CONTEXT", "VERIFIED", NOW - 5, "Bound to incident #2"),
        R3_ATTACKER_ISOLATION=gate("R3_ATTACKER_ISOLATION", "PENDING", NOW - 5, "Isolation has not been requested"),
    )), now=NOW)
    assert shot.available and shot.incident == iv.IncidentView("2", "OPEN", "2026-10-06 11:07:17", SRC_IP)
    assert [g.gate for g in shot.gates] == [name for name, _ in iv.GATES]
    assert states(shot)["R1_INCIDENT_CONTEXT"] == "VERIFIED" and states(shot)["R3_ATTACKER_ISOLATION"] == "PENDING"
    first = shot.gates[0]
    assert first.authority == iv.AUTHORITY and first.summary == "Bound to incident #2"
    assert "local" in first.checked_at_text and first.age_seconds == pytest.approx(5)
    assert "read-only" in shot.authority.lower() and "not physical evidence" in shot.not_physical.lower()


def test_no_open_incident_is_a_valid_answer_not_an_error():
    shot = iv.parse_status(payload(incident=None), now=NOW)
    assert shot.available and shot.incident is None


# ---- freshness, missing and unknown fields ---------------------------------------------------------------------------------
def test_an_old_verified_check_is_stale_but_an_old_pending_is_still_pending():
    old = NOW - iv.STALE_AFTER_SEC - 1
    shot = iv.parse_status(payload(gates=all_gates(
        R2_SAFE_ACCESS=gate("R2_SAFE_ACCESS", "VERIFIED", old),
        R4_RESTORE_AUTHORIZATION=gate("R4_RESTORE_AUTHORIZATION", "PENDING", old),
    )), now=NOW)
    assert states(shot)["R2_SAFE_ACCESS"] == "STALE" and states(shot)["R4_RESTORE_AUTHORIZATION"] == "PENDING"
    fresh = iv.parse_status(payload(gates=all_gates(R2_SAFE_ACCESS=gate("R2_SAFE_ACCESS", "VERIFIED", NOW - 60))), now=NOW)
    assert states(fresh)["R2_SAFE_ACCESS"] == "VERIFIED"


@pytest.mark.parametrize("checked", [None, 0, -5, "yesterday", float("nan"), float("inf"), True])
def test_a_verified_claim_without_a_usable_timestamp_is_not_trusted(checked):
    shot = iv.parse_status(payload(gates=all_gates(R1_INCIDENT_CONTEXT=gate("R1_INCIDENT_CONTEXT", "VERIFIED", checked))), now=NOW)
    assert states(shot)["R1_INCIDENT_CONTEXT"] == "UNKNOWN"


def test_a_timestamp_in_the_future_is_unknown_not_fresh():
    shot = iv.parse_status(payload(gates=all_gates(R1_INCIDENT_CONTEXT=gate("R1_INCIDENT_CONTEXT", "VERIFIED", NOW + 3600))), now=NOW)
    assert states(shot)["R1_INCIDENT_CONTEXT"] == "UNKNOWN"


def test_missing_gates_are_unknown_and_all_eight_are_always_present():
    shot = iv.parse_status(payload(gates=[gate("R1_INCIDENT_CONTEXT", "VERIFIED")]), now=NOW)
    assert len(shot.gates) == 8 and states(shot)["R3_ATTACKER_ISOLATION"] == "UNKNOWN"
    empty = iv.parse_status(payload(gates=[]), now=NOW)
    assert all(g.state == "UNKNOWN" for g in empty.gates)


def test_unknown_gate_names_and_duplicates_are_ignored_and_bad_status_is_unknown():
    gates = [gate("R9_MADE_UP", "VERIFIED"), gate("R1_INCIDENT_CONTEXT", "PENDING"), gate("R1_INCIDENT_CONTEXT", "VERIFIED"),
             gate("R2_SAFE_ACCESS", "PWNED"), gate("R3_ATTACKER_ISOLATION", "NOT_CONFIGURED"), "junk", None, 7]
    shot = iv.parse_status(payload(gates=gates), now=NOW)
    assert states(shot)["R1_INCIDENT_CONTEXT"] == "PENDING"  # the first record wins
    assert states(shot)["R2_SAFE_ACCESS"] == "UNKNOWN" and states(shot)["R3_ATTACKER_ISOLATION"] == "NOT_AVAILABLE"
    assert "R9_MADE_UP" not in states(shot)


def test_missing_or_hostile_incident_fields_become_unknown():
    shot = iv.parse_status(payload(incident={"id": True, "state": "EXPLODED", "attacker_ip": "999.1.1.1; rm -rf /"}), now=NOW)
    assert shot.incident == iv.IncidentView("UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN")
    assert iv.parse_status(payload(incident={"id": 3}), now=NOW).incident.source_ip == "UNKNOWN"
    assert iv.parse_status(payload(incident={"id": 3, "attacker_ip": "2001:db8::1"}), now=NOW).incident.source_ip == "2001:db8::1"


@pytest.mark.parametrize("bad", [
    None, [], "STATUS", 7, {}, {"v": 2, "ok": True, "code": "STATUS", "data": {}},
    {"v": 1, "ok": False, "code": "STATUS", "data": {"gates": []}}, {"v": 1, "ok": True, "code": "ISOLATE", "data": {"gates": []}},
    {"v": 1, "ok": True, "code": "STATUS"}, {"v": 1, "ok": True, "code": "STATUS", "data": []},
    {"v": 1, "ok": True, "code": "STATUS", "data": {"incident": None}},
    {"v": 1, "ok": True, "code": "STATUS", "data": {"gates": "x"}},
    {"v": 1, "ok": True, "code": "STATUS", "data": {"gates": [], "incident": "nope"}},
])
def test_a_malformed_answer_is_not_available_and_keeps_no_values(bad):
    shot = iv.parse_status(bad, now=NOW)
    assert not shot.available and shot.incident is None
    assert all(g.state == "NOT_AVAILABLE" and g.summary == "" for g in shot.gates)


def test_core_supplied_text_is_sanitized_and_bounded():
    nasty = "ok‮ evil\x00\x1b[31m" + "x" * 5000
    shot = iv.parse_status(payload(gates=all_gates(R1_INCIDENT_CONTEXT=gate("R1_INCIDENT_CONTEXT", "PENDING", summary=nasty, detail=42))), now=NOW)
    first = shot.gates[0]
    assert len(first.summary) <= iv.MAX_TEXT and "‮" not in first.summary and "\x1b" not in first.summary and "\x00" not in first.summary
    assert first.detail == "UNKNOWN"
    assert iv.safe_text("   ") == "UNKNOWN" and iv.safe_text(None) == "UNKNOWN"


# ---- STATUS only, fail closed ----------------------------------------------------------------------------------------------
def test_fetch_requests_exactly_one_status_and_nothing_else():
    calls = []

    def request(*args, **kwargs):
        calls.append((args, kwargs))
        return payload()

    shot = iv.fetch(request, ERRORS, now=NOW)
    assert shot.available and calls == [(("STATUS",), {})]
    assert iv.OP_STATUS == "STATUS" and "op" not in iv.fetch.__code__.co_varnames[: iv.fetch.__code__.co_argcount]


def test_a_failed_read_discards_everything_and_names_the_reason():
    def boom(_op):
        raise rc.RecoveryUnavailable("the Core Recovery channel is unavailable")

    shot = iv.fetch(boom, ERRORS, now=NOW)
    assert not shot.available and "unavailable" in shot.reason and shot.incident is None
    assert all(g.state == "NOT_AVAILABLE" for g in shot.gates)


def test_an_unexpected_exception_also_fails_closed_without_leaking_its_message():
    def boom(_op):
        raise ValueError("secret-token-123")

    shot = iv.fetch(boom, ERRORS, now=NOW)
    assert not shot.available and "secret-token-123" not in shot.reason and "ValueError" in shot.reason


def test_nothing_in_the_view_claims_relay_esp32_broker_or_uplink_state():
    shot = iv.parse_status(payload(), now=NOW)
    assert set(iv.NOT_PROVIDED) == {"Core runtime", "Broker connection", "ESP32 presence", "Uplink / relay state"}
    blob = repr(shot).lower()
    for claim in ("relay connected", "relay open", "esp32 online", "uplink normal", "broker connected", "cut confirmed"):
        assert claim not in blob


def _code_without_docstrings(path):
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef)) and node.body \
                and isinstance(node.body[0], ast.Expr) and isinstance(getattr(node.body[0], "value", None), ast.Constant) \
                and isinstance(node.body[0].value.value, str):
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def test_the_view_model_can_only_reach_status_and_imports_nothing_operational():
    tree = ast.parse(_code_without_docstrings(iv.__file__))
    literals = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    forbidden_ops = {"ISOLATE", "PROBE", "RESTORE_STATUS", "CLOSE", "CUT_UPLINK", "RESTORE_UPLINK", "OP_ISOLATE", "OP_PROBE",
                     "OP_CLOSE", "OP_RESTORE_STATUS"}
    assert not (forbidden_ops & (literals | names)), forbidden_ops & (literals | names)
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert imported <= {"__future__", "ipaddress", "math", "time", "unicodedata", "collections", "dataclasses", "typing"}, imported
    assert literals & {"STATUS"} == {"STATUS"}


# ---- real transport: the existing recovery_client, a real AF_UNIX socket ---------------------------------------------------
class Server:
    def __init__(self, reply):
        self.dir = tempfile.mkdtemp(prefix="iv-")
        self.path = os.path.join(self.dir, "r.sock")
        self.requests = []
        self.reply = reply
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(self.path)
        self.listener.listen(4)
        self.listener.settimeout(0.2)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except (TimeoutError, OSError):
                continue
            with conn:
                conn.settimeout(2)
                try:
                    line = conn.makefile("rb").readline(rp.MAX_MESSAGE_BYTES + 1)
                    self.requests.append(json.loads(line))
                    if self.reply is not None:
                        conn.sendall(self.reply if isinstance(self.reply, bytes) else json.dumps(self.reply).encode() + b"\n")
                except (OSError, ValueError):
                    pass

    def close(self):
        self.stop.set()
        self.thread.join()
        self.listener.close()


@pytest.fixture
def server_factory():
    made = []

    def build(reply):
        server = Server(reply)
        made.append(server)
        return server

    yield build
    for server in made:
        server.close()
        for name in os.listdir(server.dir):
            os.unlink(os.path.join(server.dir, name))
        os.rmdir(server.dir)


def real_fetch(server, *, uid=MY_UID):
    def request(op):
        return rc.request(op, path=server.path, expected_uid=uid, timeout=2.0)
    return iv.fetch(request, ERRORS)


def test_over_a_real_socket_a_valid_status_is_shown_and_only_status_is_sent(server_factory):
    server = server_factory(payload(gates=all_gates(R1_INCIDENT_CONTEXT=gate("R1_INCIDENT_CONTEXT", "VERIFIED", __import__("time").time() - 3))))
    shot = real_fetch(server)
    assert shot.available and shot.incident.source_ip == SRC_IP and states(shot)["R1_INCIDENT_CONTEXT"] == "VERIFIED"
    assert server.requests == [{"v": 1, "op": "STATUS"}]  # one request, no summary, no other operation


def test_a_server_that_is_not_the_core_account_is_refused_before_any_request(server_factory):
    server = server_factory(payload())
    shot = real_fetch(server, uid=MY_UID + 1)
    assert not shot.available and "not the Core account" in shot.reason
    assert server.requests == []  # the peer check happens before anything is sent


def test_an_unavailable_socket_is_not_available(tmp_path):
    def request(op):
        return rc.request(op, path=str(tmp_path / "absent.sock"), expected_uid=MY_UID)

    shot = iv.fetch(request, ERRORS)
    assert not shot.available and "unavailable" in shot.reason.lower()


@pytest.mark.parametrize("reply", [b"not json\n", b"[1,2]\n", b"\n", None, {"v": 9, "ok": True}, {"v": 1, "ok": False, "code": "REFUSED", "detail": "no", "data": {}}])
def test_malformed_or_refusing_replies_over_a_real_socket_are_not_available(server_factory, reply):
    shot = real_fetch(server_factory(reply))
    assert not shot.available and shot.incident is None


def test_an_oversized_reply_is_rejected(server_factory):
    shot = real_fetch(server_factory(b"x" * (rp.MAX_MESSAGE_BYTES + 100) + b"\n"))
    assert not shot.available
