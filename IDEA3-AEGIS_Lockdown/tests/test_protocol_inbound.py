"""Core inbound ACK/STATUS verification in the binding order (design §6.2)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from aegis_soc import protocol_v1 as p1
from aegis_soc.protocol_inbound import InboundVerifier
from aegis_soc.protocol_store import ProtocolStore

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "protocol-v1-vectors.json").read_text("ascii"))
DEVICE = FIXTURE["deviceId"]
KEYS = p1.ProtocolKeys(
    c2d=bytes.fromhex(FIXTURE["testOnlyKeys"]["c2d"]),
    d2c=bytes.fromhex(FIXTURE["testOnlyKeys"]["d2c"]),
)
CORE_SCENARIOS = [scenario for scenario in FIXTURE["scenarios"] if scenario["receiver"] == "core"]
PRE_AUTH = {"TRANSPORT", "SCHEMA", "PAYLOAD", "TIME", "AUTH"}


def _wire(entry: dict) -> bytes:
    return bytes.fromhex(entry["wireHex"]) if entry.get("wireHex") else entry["wire"].encode("ascii")


class ScenarioClock:
    def __init__(self, context):
        self.context = context

    def trusted_now(self):
        return self.context["now"] if self.context["timeTrust"] in {"SYNCED", "HOLDOVER"} else None


class SpyStore:
    """Delegates to a real store and records every call the verifier makes."""

    def __init__(self, store):
        self.store = store
        self.calls = []

    def record_seen(self, *args):
        self.calls.append(("record_seen", args))
        return self.store.record_seen(*args)


def _seen_rows(path):
    with sqlite3.connect(path) as raw:
        return raw.execute("SELECT device_id, msg_id FROM protocol_seen_d2c ORDER BY msg_id").fetchall()


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "data" / "core-protocol.sqlite3"


@pytest.mark.parametrize("scenario", CORE_SCENARIOS, ids=lambda scenario: scenario["id"])
def test_core_scenarios_follow_the_binding_validation_order(scenario, db_path):
    store = ProtocolStore(db_path, wall_clock=lambda: scenario["context"]["now"])
    for msg_id in scenario["context"]["seen"]:
        assert store.record_seen(DEVICE, msg_id, "STATUS") is True
    before = _seen_rows(db_path)
    audit = []
    spy = SpyStore(store)
    verifier = InboundVerifier(
        keys=KEYS, device_id=DEVICE, store=spy, clock=ScenarioClock(scenario["context"]),
        audit=lambda *args: audit.append(args),
    )

    result = verifier.process(scenario["topic"], _wire(scenario), retain=scenario["retain"])

    assert (result.stage, result.code) == (scenario["expectStage"], scenario["expectCode"]), scenario["id"]
    assert result.accepted is (scenario["expectStage"] == "ACCEPTED")
    if scenario["expectStage"] in PRE_AUTH:
        # Nothing before AUTH touches the replay store or the audit hash chain.
        assert spy.calls == []
        assert audit == []
        assert _seen_rows(db_path) == before
        assert result.message is None
        assert verifier.counters[(scenario["expectStage"], scenario["expectCode"])] == 1
    elif scenario["expectStage"] == "SKEW":
        assert spy.calls == []
        assert _seen_rows(db_path) == before
        assert len(audit) == 1
    elif scenario["expectStage"] == "REPLAY":
        assert _seen_rows(db_path) == before
        assert len(audit) == 1
    else:
        assert result.message is not None and result.message.kind in {"ACK", "STATUS"}
        assert len(_seen_rows(db_path)) == len(before) + 1
        assert audit == []
    store.close()


def test_post_auth_audit_contains_codes_only_never_payload_or_mac(db_path):
    scenario = next(item for item in CORE_SCENARIOS if item["id"] == "C-STALE")
    store = ProtocolStore(db_path, wall_clock=lambda: scenario["context"]["now"])
    audit = []
    verifier = InboundVerifier(
        keys=KEYS, device_id=DEVICE, store=store, clock=ScenarioClock(scenario["context"]),
        audit=lambda *args: audit.append(args),
    )
    raw = _wire(scenario)
    verifier.process(scenario["topic"], raw, retain=False)
    event, detail, *_ = audit[0]
    assert event == "P1_EVIDENCE_REJECTED"
    assert "stage=SKEW" in detail and "code=STALE" in detail
    message = p1.parse(raw, topic=scenario["topic"], device_id=DEVICE, accept_kinds=frozenset({"STATUS"}))
    assert message.mac not in detail
    assert message.fields["msg_id"] not in detail
    store.close()


def test_a_failing_replay_store_rejects_fail_closed(db_path):
    scenario = next(item for item in CORE_SCENARIOS if item["id"] == "C-ST-PERIODIC")

    class BrokenStore:
        def record_seen(self, *_args):
            raise sqlite3.OperationalError("disk I/O error")

    audit = []
    verifier = InboundVerifier(
        keys=KEYS, device_id=DEVICE, store=BrokenStore(), clock=ScenarioClock(scenario["context"]),
        audit=lambda *args: audit.append(args),
    )
    result = verifier.process(scenario["topic"], _wire(scenario), retain=False)
    assert (result.accepted, result.stage, result.code) == (False, "REPLAY", "STORE")
    assert len(audit) == 1


def test_the_verifier_refuses_to_run_with_the_same_key_for_both_directions(db_path):
    store = ProtocolStore(db_path)
    shared = p1.ProtocolKeys(c2d=KEYS.d2c, d2c=KEYS.d2c)
    with pytest.raises(ValueError):
        InboundVerifier(keys=shared, device_id=DEVICE, store=store, clock=ScenarioClock({"now": 0, "timeTrust": "SYNCED"}))
    store.close()


def test_counters_are_bounded_to_stage_and_code_keys(db_path):
    store = ProtocolStore(db_path)
    verifier = InboundVerifier(
        keys=KEYS, device_id=DEVICE, store=store, clock=ScenarioClock({"now": 0, "timeTrust": "UNTRUSTED"}),
    )
    for index in range(50):
        verifier.process(p1.topics(DEVICE).status, f"garbage-{index}".encode(), retain=False)
    assert dict(verifier.counters) == {("SCHEMA", "SYNTAX"): 50}
    store.close()
