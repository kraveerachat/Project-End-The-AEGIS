"""SIMULATED IDEA3 relay device for OFFLINE Core acceptance. Nothing here is hardware evidence.

It mirrors the documented device rules in ``firmware/src/main.cpp`` (``onMqttMessage`` / ``handleCommand`` / ``handleHeartbeat``) and
uses ONLY the Core's own codec (``aegis_soc.protocol_v1``) for parsing, MAC verification, skew and signing: no security logic is
re-implemented here. ``test_offline_core_acceptance.py`` pins the firmware rule order so this model cannot silently drift.

A ``LOCKDOWN`` reported by this model is *simulated* output state. It proves the Core's wire/ledger behaviour only; it is never a
relay, GPIO, or physical acceptance.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from aegis_soc import protocol_v1 as p1

EVIDENCE_CLASS = "SIMULATED_OFFLINE"


@dataclass
class SimulatedDevice:
    device_id: str
    keys: p1.ProtocolKeys
    now: Callable[[], int]
    time_trust: str = "SYNCED"
    persist_ok: bool = True
    highest_sequence: int = 0
    locked_down: bool = False
    heartbeat_seen: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)

    @property
    def topics(self) -> p1.Topics:
        return p1.topics(self.device_id)

    # -- inbound (Core -> device) -------------------------------------------------------------------------------
    def receive(self, topic: str, payload: bytes, *, retain: bool = False) -> list[tuple[str, bytes]]:
        """Returns the signed frames the device would publish in response (possibly none)."""
        if self.time_trust == "UNTRUSTED":
            self.log.append("ignored:time-untrusted")
            return []
        if retain:
            self.log.append("ignored:retained")
            return []
        try:
            message = p1.parse(
                payload, topic=topic, device_id=self.device_id, accept_kinds=frozenset({p1.COMMAND, p1.HEARTBEAT}),
            )
        except p1.ProtocolRejected as rejected:
            self.log.append(f"dropped:{rejected.stage}/{rejected.code}")
            return []
        if message.kind == p1.COMMAND:
            return self._command(message)
        self._heartbeat(message)
        return []

    def _command(self, message: p1.Message) -> list[tuple[str, bytes]]:
        if not p1.verify(message, self.keys):
            self.log.append("dropped:AUTH/MAC")
            return []
        fields = message.fields
        msg_id, seq = fields["msg_id"], message.int("seq")
        if p1.check_skew(message.int("issued_at"), self.now()) is not None or self.now() > message.int("expires_at"):
            self.log.append("rejected:EXPIRED")
            return [self._ack(msg_id, seq, "REJECTED_EXPIRED")]
        if seq <= self.highest_sequence:
            self.log.append("rejected:SEQUENCE")
            return [self._ack(msg_id, seq, "REJECTED_SEQUENCE"), self._status("SEQUENCE_REJECTED", msg_id, seq)]
        if not self.persist_ok:
            self.log.append("rejected:PERSIST")
            return [self._ack(msg_id, seq, "REJECTED_PERSIST")]
        self.highest_sequence = seq
        self.locked_down = fields["action"] == "CUT_UPLINK"
        self.log.append(f"applied:{fields['action']}")
        return [self._ack(msg_id, seq, "ACCEPTED"), self._status("COMMAND", msg_id, seq)]

    def _heartbeat(self, message: p1.Message) -> None:
        if not p1.verify(message, self.keys):
            self.log.append("dropped:AUTH/MAC")
            return
        msg_id = message.fields["msg_id"]
        if p1.check_skew(message.int("issued_at"), self.now()) is not None or msg_id in self.heartbeat_seen:
            self.log.append("dropped:heartbeat-skew-or-replay")
            return
        self.heartbeat_seen.append(msg_id)
        self.log.append("heartbeat:accepted")

    # -- outbound (device -> Core), signed with the DEVICE_TO_CORE key -------------------------------------------
    def _ack(self, msg_id: str, seq: int, result: str) -> tuple[str, bytes]:
        return p1.encode(
            p1.ACK, device_id=self.device_id, keys=self.keys,
            fields={"msg_id": p1.new_msg_id(), "device_time": self.now(), "ack_for_msg_id": msg_id, "ack_for_seq": seq, "result": result},
        )

    def _status(self, reason: str, cmd_msg_id: str = "", cmd_seq: int = 0) -> tuple[str, bytes]:
        return p1.encode(
            p1.STATUS, device_id=self.device_id, keys=self.keys,
            fields={
                "msg_id": p1.new_msg_id(), "device_time": self.now(), "time_trust": self.time_trust,
                "output_state": "LOCKDOWN" if self.locked_down else "NORMAL", "reason": reason, "cmd_msg_id": cmd_msg_id,
                "cmd_seq": cmd_seq, "device_seq_hwm": self.highest_sequence, "rssi_dbm": -55, "heap_free": 100_000,
            },
        )

    def periodic_status(self) -> tuple[str, bytes]:
        return self._status("PERIODIC")
