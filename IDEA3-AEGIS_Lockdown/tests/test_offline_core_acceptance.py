"""OFFLINE Core acceptance: detection event -> Core policy -> authenticated command -> MQTT contract -> simulated device ACK/STATUS
-> correlation -> audit/incident evidence.

EVIDENCE CLASS: SIMULATED_OFFLINE. Real Core components (supervisor, controller, Protocol v1 codec/store/inbound verifier, MQTT adapter,
dispatch worker and ledger, alert ingress, hash-chained audit database) run against a fake paho client, a fake web dispatch client and the
simulated device in ``offline_device_sim.py``. No broker, Production host, ESP32, relay, cut or RESTORE happens. A simulated LOCKDOWN is
never physical, hardware or Production acceptance.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from offline_device_sim import EVIDENCE_CLASS, SimulatedDevice
from test_core_recovery import IP, make_env
from test_local_restore import DEVICE, KEYS, NOW, TOPICS, request
from test_protocol_ordering import ACTION_ID, FakeDispatchClient

from aegis_soc import config
from aegis_soc import database as db
from aegis_soc import protocol_v1 as p1
from aegis_soc.dispatch_ledger import DispatchLedger
from aegis_soc.dispatch_worker import DispatchWorker

from test_core_recovery import credential  # noqa: F401  (module-scoped D4 credential fixture)

MAIN_SRC = Path(__file__).resolve().parent.parent / "firmware" / "src" / "main.cpp"


class Rig:
    """One production-profile Core (real audit DB) + dispatch worker/ledger + the simulated device."""

    def __init__(self, tmp_path, monkeypatch, credential):
        self.env = make_env(tmp_path, monkeypatch, credential)
        self.core = self.env.core
        self.ledger = DispatchLedger(tmp_path / "data" / "core-dispatch.sqlite3", wall_clock=lambda: NOW)
        self.web = FakeDispatchClient()
        self.worker = DispatchWorker(self.core.supervisor, self.ledger, self.web, wall_clock=lambda: NOW)
        self.core.supervisor.dispatch_worker = self.worker
        self.device = SimulatedDevice(DEVICE, KEYS, now=lambda: NOW)
        self.wire_log: list[str] = []

    # -- helpers ------------------------------------------------------------------------------------------------
    def command_frames(self):
        return [(t, p) for t, p, _, _ in self.core.client.published if t == TOPICS.command]

    def dispatch(self):
        self.worker.start()
        self.worker.tick()
        return self.command_frames()[-1]

    def to_core(self, topic, payload, *, retain=False):
        self.core.mqtt._on_message(None, None, SimpleNamespace(topic=topic, payload=payload, retain=retain))

    def device_round_trip(self, frame):
        """Core command -> simulated device -> its signed frames -> Core inbound. Returns the device's reply frames."""
        replies = self.device.receive(*frame)
        for topic, payload in replies:
            self.to_core(topic, payload)
        return replies

    def stages(self):
        return [entry["stage"] for entry in self.ledger.pending_outbox()]

    def events(self):
        return [row[3] for row in reversed(db.fetch_all_logs())]  # fetch_all_logs is newest-first

    def close(self):
        self.ledger.close()
        self.core.close()


@pytest.fixture
def rig(tmp_path, monkeypatch, credential):
    instance = Rig(tmp_path, monkeypatch, credential)
    yield instance
    instance.close()


def _alert(rig):
    return rig.env.service.bind_incident(IP)


# ---------------------------------------------------------------------------------------------------------------------
# 1. The whole pipeline, once, end to end
# ---------------------------------------------------------------------------------------------------------------------
def test_offline_pipeline_detection_to_audit_evidence(rig):
    # Detection event: the production alert ingress may only BIND an incident. It cannot reach the device or the dispatch path.
    result = rig.core.supervisor.on_production_alert(IP)
    assert result["action"] == "CREATED"
    assert db.get_open_incident()["attacker_ip"] == IP
    assert rig.core.client.published == [] and rig.command_frames() == []
    assert rig.ledger.get(ACTION_ID) is None and rig.core.supervisor.pending_command is None

    # Core policy/dispatch: only the approved (claimed) CUT_UPLINK action produces one authenticated command.
    frame = rig.dispatch()
    assert len(rig.command_frames()) == 1
    command = p1.parse(frame[1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    assert p1.verify(command, KEYS) is True and command.fields["action"] == "CUT_UPLINK"
    assert rig.ledger.get(ACTION_ID)["nonce"] == command.fields["msg_id"]

    # Simulated device validates the command by the firmware rules and answers ACK then STATUS (signed DEVICE_TO_CORE).
    replies = rig.device_round_trip(frame)
    assert [p1.kind_for_topic(t, DEVICE) for t, _ in replies] == [p1.ACK, p1.STATUS]
    assert rig.device.locked_down is True and rig.device.log[-1] == "applied:CUT_UPLINK"

    # Correlation: the ACK and the STATUS are tied to exactly this command (msg_id nonce + sequence).
    assert rig.stages() == ["PUBLISHED", "ACK", "STATUS"]
    assert rig.ledger.get(ACTION_ID)["state"] == "STATUS_CORRELATED"
    stored = rig.core.store.command(command.fields["msg_id"])
    assert stored["status_correlated"] == 1 and stored["seq"] == command.int("seq")

    # Audit / incident evidence: ordered, hash-chained, and free of payload/MAC material.
    events = rig.events()
    for needed in ("INCIDENT_BOUND", "COMMAND_SENT", "ACK_RECEIVED", "DEVICE_STATUS"):
        assert needed in events, needed
    assert events.index("COMMAND_SENT") < events.index("ACK_RECEIVED") < events.index("DEVICE_STATUS")
    assert db.verify_chain()[0] is True
    blob = " ".join(str(row) for row in db.fetch_all_logs())
    macs = [re.findall(rb'"([0-9a-f]{64})"\]$', raw)[0].decode() for raw in (frame[1], *[payload for _, payload in replies])]
    assert len(macs) == 3 and not any(mac in blob for mac in macs)
    assert KEYS.c2d.hex() not in blob and KEYS.d2c.hex() not in blob

    # Physical-truth separation: the ledger can only say what authenticated frames prove.
    assert not {"CONTAINED", "RELAY_EVIDENCE", "EXECUTED", "PHYSICAL", "HARDWARE"} & set(rig.stages())
    assert EVIDENCE_CLASS == "SIMULATED_OFFLINE"


def test_audit_chain_detects_tampering(rig):
    rig.core.supervisor.on_production_alert(IP)
    rig.device_round_trip(rig.dispatch())
    assert db.verify_chain()[0] is True
    connection = sqlite3.connect(config.DB_PATH)
    try:
        connection.execute("UPDATE audit_logs SET details = details || ' tampered' WHERE event_type = 'COMMAND_SENT'")
        connection.commit()
    finally:
        connection.close()
    valid, message = db.verify_chain()
    assert valid is False and "COMMAND_SENT" in message


# ---------------------------------------------------------------------------------------------------------------------
# 2. Core -> device direction: HMAC, nonce, timestamp, replay, sequence (validated by the simulated device)
# ---------------------------------------------------------------------------------------------------------------------
def test_each_command_has_a_fresh_nonce_and_a_strictly_increasing_sequence(rig):
    first = rig.dispatch()
    rig.device_round_trip(first)
    a = p1.parse(first[1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    # The same single command owner issues the next command once nothing is awaiting an ACK.
    rig.core.supervisor.pending_command = None
    second = rig.core.supervisor.issue_command("CUT_UPLINK", "second containment", origin="test")
    assert second.sent is True
    b = p1.parse(rig.command_frames()[1][1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    assert a.fields["msg_id"] != b.fields["msg_id"] and b.int("seq") == a.int("seq") + 1
    assert rig.device.receive(*rig.command_frames()[1])  # accepted: strictly greater than the device high-water mark
    assert rig.device.highest_sequence == b.int("seq")


@pytest.mark.parametrize(
    "tamper",
    ["flip-mac", "wrong-domain-key", "wrong-device-topic", "legacy-v0-json", "empty"],
)
def test_device_silently_drops_unauthenticated_commands(rig, tamper):
    topic, payload = rig.dispatch()
    if tamper == "flip-mac":
        payload = payload[:-3] + (b"0" if payload[-3:-2] != b"0" else b"1") + payload[-2:]
    elif tamper == "wrong-domain-key":
        command = p1.parse(payload, topic=topic, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
        swapped = p1.ProtocolKeys(c2d=KEYS.d2c, d2c=KEYS.d2c)  # MAC made with the DEVICE_TO_CORE key
        _, payload = p1.encode(p1.COMMAND, device_id=DEVICE, keys=swapped, fields={
            name: command.fields[name] for name in p1.FIELD_NAMES[p1.COMMAND]})
    elif tamper == "wrong-device-topic":
        topic = p1.topics("other-device-02").command
    elif tamper == "legacy-v0-json":
        payload = b'{"action":"CUT_UPLINK"}'
    else:
        payload = b""
    assert rig.device.receive(topic, payload) == []
    assert rig.device.locked_down is False and rig.device.highest_sequence == 0


def test_replayed_command_is_rejected_by_sequence_and_never_re_applies(rig):
    frame = rig.dispatch()
    first = rig.device.receive(*frame)
    assert [p1.kind_for_topic(t, DEVICE) for t, _ in first] == [p1.ACK, p1.STATUS]
    again = rig.device.receive(*frame)
    parsed = [p1.parse(payload, topic=t, device_id=DEVICE, accept_kinds=frozenset({p1.ACK, p1.STATUS})) for t, payload in again]
    assert parsed[0].fields["result"] == "REJECTED_SEQUENCE"
    assert parsed[1].fields["reason"] == "SEQUENCE_REJECTED"
    assert rig.device.locked_down is True and rig.device.highest_sequence == 1  # state unchanged by the replay


def test_expired_stale_and_untrusted_time_commands_are_not_executed(rig):
    frame = rig.dispatch()
    late = SimulatedDevice(DEVICE, KEYS, now=lambda: NOW + p1.COMMAND_TTL_MAX_SEC + 1)
    reply = late.receive(*frame)
    ack = p1.parse(reply[0][1], topic=reply[0][0], device_id=DEVICE, accept_kinds=frozenset({p1.ACK}))
    assert ack.fields["result"] == "REJECTED_EXPIRED" and late.locked_down is False
    untrusted = SimulatedDevice(DEVICE, KEYS, now=lambda: NOW, time_trust="UNTRUSTED")
    assert untrusted.receive(*frame) == [] and untrusted.locked_down is False
    broken_flash = SimulatedDevice(DEVICE, KEYS, now=lambda: NOW, persist_ok=False)
    persist = broken_flash.receive(*frame)
    assert p1.parse(persist[0][1], topic=persist[0][0], device_id=DEVICE, accept_kinds=frozenset({p1.ACK})).fields["result"] == "REJECTED_PERSIST"
    assert broken_flash.locked_down is False


def test_core_resolves_every_device_rejection_to_outcome_unknown_and_never_redispatches(rig):
    frame = rig.dispatch()
    later = NOW + p1.COMMAND_TTL_MAX_SEC + 1
    late = SimulatedDevice(DEVICE, KEYS, now=lambda: later)
    rig.core.clock.trusted_now = lambda: later  # real time passed for both ends; the command's 30 s lifetime is over
    for topic, payload in late.receive(*frame):
        rig.to_core(topic, payload)
    rig.worker.tick()
    assert rig.ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert len(rig.command_frames()) == 1


# ---------------------------------------------------------------------------------------------------------------------
# 3. Device -> Core direction: HMAC, timestamp, replay, correlation (integration level: effects on ledger + audit)
# ---------------------------------------------------------------------------------------------------------------------
def _device_frames(rig):
    frame = rig.dispatch()
    return frame, rig.device.receive(*frame)


def _flip(payload: bytes) -> bytes:
    return payload[:-3] + (b"0" if payload[-3:-2] != b"0" else b"1") + payload[-2:]


@pytest.mark.parametrize("attack", ["bad-mac", "wrong-domain-c2d-key", "stale", "future", "retained", "other-device", "untrusted-core-time"])
def test_forged_stale_or_misrouted_device_evidence_has_no_effect_on_ledger_or_state(rig, attack):
    _frame, replies = _device_frames(rig)
    (ack_topic, ack_raw), (status_topic, status_raw) = replies
    ack = p1.parse(ack_raw, topic=ack_topic, device_id=DEVICE, accept_kinds=frozenset({p1.ACK}))
    fields = {name: ack.fields[name] for name in p1.FIELD_NAMES[p1.ACK]}
    retain = False
    if attack == "bad-mac":
        topic, raw = ack_topic, _flip(ack_raw)
    elif attack == "wrong-domain-c2d-key":
        topic, raw = p1.encode(p1.ACK, device_id=DEVICE, keys=p1.ProtocolKeys(c2d=KEYS.c2d, d2c=KEYS.c2d), fields=fields)
    elif attack == "stale":
        topic, raw = p1.encode(p1.ACK, device_id=DEVICE, keys=KEYS, fields=dict(fields, device_time=NOW - 31))
    elif attack == "future":
        topic, raw = p1.encode(p1.ACK, device_id=DEVICE, keys=KEYS, fields=dict(fields, device_time=NOW + 3))
    elif attack == "retained":
        topic, raw, retain = ack_topic, ack_raw, True
    elif attack == "other-device":
        topic, raw = p1.encode(p1.ACK, device_id="other-device-02", keys=KEYS, fields=fields)
    else:
        topic, raw = ack_topic, ack_raw
        rig.core.clock.current = "UNTRUSTED"
    rig.to_core(topic, raw, retain=retain)
    assert rig.stages() == ["PUBLISHED"]
    assert rig.ledger.get(ACTION_ID)["state"] == "PUBLISHED"
    assert "ACK_RECEIVED" not in rig.events()
    assert rig.core.supervisor.awaiting_physical_confirmation["acknowledged_at"] is None


def test_replayed_valid_ack_and_status_are_recorded_exactly_once(rig):
    _frame, replies = _device_frames(rig)
    for topic, payload in replies:
        rig.to_core(topic, payload)
    assert rig.stages() == ["PUBLISHED", "ACK", "STATUS"]
    before = (list(rig.stages()), rig.events().count("ACK_RECEIVED"), rig.events().count("DEVICE_STATUS"))
    for topic, payload in replies * 3:  # verbatim replay of the very same signed frames
        rig.to_core(topic, payload)
    assert (list(rig.stages()), rig.events().count("ACK_RECEIVED"), rig.events().count("DEVICE_STATUS")) == before
    rejected = [row for row in db.fetch_all_logs() if row[3] == "P1_EVIDENCE_REJECTED"]
    assert rejected and all("code=DUPLICATE" in row[4] for row in rejected)
    assert all(re.fullmatch(r"stage=\w+ code=\w+ kind=\w+", row[4]) for row in rejected)  # stable codes only, never payload/MAC


def test_status_for_a_different_command_never_correlates_or_promotes_evidence(rig):
    _frame, replies = _device_frames(rig)
    _ack, (status_topic, status_raw) = replies
    status = p1.parse(status_raw, topic=status_topic, device_id=DEVICE, accept_kinds=frozenset({p1.STATUS}))
    fields = {name: status.fields[name] for name in p1.FIELD_NAMES[p1.STATUS]}
    topic, raw = p1.encode(p1.STATUS, device_id=DEVICE, keys=KEYS, fields=dict(fields, cmd_msg_id="d" * 32, cmd_seq=9))
    rig.to_core(topic, raw)
    assert rig.stages() == ["PUBLISHED"]
    assert "P1_STATUS_UNCORRELATED" in rig.events()
    assert rig.ledger.get(ACTION_ID)["state"] == "PUBLISHED"


def test_a_periodic_lockdown_status_is_liveness_only_and_never_command_evidence(rig):
    rig.dispatch()
    rig.to_core(*rig.device.periodic_status())
    assert rig.stages() == ["PUBLISHED"] and rig.ledger.get(ACTION_ID)["state"] == "PUBLISHED"


# ---------------------------------------------------------------------------------------------------------------------
# 4. Detector events cannot bypass Core policy; RESTORE stays blocked
# ---------------------------------------------------------------------------------------------------------------------
def test_detector_alerts_never_publish_cut_or_restore_and_never_open_the_dispatch_path(rig):
    handled = [rig.core.supervisor.on_production_alert(IP) for _ in range(3)]
    assert [item["action"] for item in handled] == ["CREATED", "EXISTING", "EXISTING"]
    assert rig.core.client.published == [] and rig.env.containment.calls == []
    assert rig.web.calls == [] and rig.ledger.pending_outbox() == []
    assert not set(rig.events()) & {"COMMAND_SENT", "CUT_REQUESTED", "RESTORE_REQUESTED"}


@pytest.mark.parametrize("origin", ["dispatch", "detector", "telegram", "gui", "aegisctl", "unknown"])
def test_restore_is_blocked_without_the_verified_recovery_policy_for_every_origin(rig, origin):
    rig.device_round_trip(rig.dispatch())  # the device is now (simulated) LOCKDOWN
    rig.core.supervisor.pending_command = None
    result = rig.core.supervisor.issue_command("RESTORE_UPLINK", "attempted restore", critical=True, origin=origin, authorize_restore=True)
    assert result.sent is False and result.reason_code == "RESTORE_POLICY_REQUIRED"
    assert rig.device.locked_down is True
    assert all(c.fields["action"] != "RESTORE_UPLINK" for c in rig.core.commands())


def test_restore_via_the_local_gate_is_refused_until_isolation_is_verified_and_publishes_nothing(rig):
    rig.core.supervisor.on_production_alert(IP)
    rig.device_round_trip(rig.dispatch())
    response = rig.core.ask(request())
    assert response["ok"] is False and response["evidence"]["published"] == "NOT_PUBLISHED"
    assert rig.core.restores() == [] and rig.device.locked_down is True


# ---------------------------------------------------------------------------------------------------------------------
# 5. The simulated device model stays pinned to the real firmware rules
# ---------------------------------------------------------------------------------------------------------------------
def test_simulated_device_rule_order_matches_the_firmware_source():
    source = MAIN_SRC.read_text()
    body = source[source.index("void handleCommand"):source.index("void handleHeartbeat")]
    order = [body.index(token) for token in ("verify(parsed, keyC2D)", "checkAuthenticatedSkew(issuedAt)", "REJECTED_EXPIRED",
                                             "acceptedSequence(sequence)", "REJECTED_SEQUENCE", "putULong64", "REJECTED_PERSIST",
                                             "setLockdown(action", 'sendAck(commandId, sequence, "ACCEPTED")', 'publishStatus("COMMAND"')]
    assert order == sorted(order)
    assert "timeTrust() == TimeTrust::UNTRUSTED) return;" in source
    assert "timestamp <= now + 2 && now <= timestamp + 30" in source
    assert (p1.SKEW_FUTURE_SEC, p1.SKEW_PAST_SEC) == (2, 30)


def test_offline_evidence_is_labelled_simulated_and_never_physical():
    assert EVIDENCE_CLASS == "SIMULATED_OFFLINE"
    assert "physical" not in "".join(getattr(p1, "STATUS_REASONS", ())).lower()
