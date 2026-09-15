"""Core inbound Protocol v1 verification (PR11 Phase 4, design §6.2).

The binding order is TRANSPORT -> SCHEMA -> PAYLOAD -> local Core TIME -> AUTH
-> authenticated SKEW -> durable REPLAY acceptance. Only a message that passes
every stage reaches liveness, relay state, notification, pending state, or
dispatch evidence. Rejections before AUTH only increment a bounded in-memory
counter: they never touch the replay store or the hash-chained audit.
"""

from __future__ import annotations

import hmac
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass

from . import protocol_v1 as p1

D2C_KINDS = frozenset({p1.ACK, p1.STATUS})
ACCEPTED = "ACCEPTED"


@dataclass(frozen=True)
class InboundResult:
    accepted: bool
    stage: str
    code: str
    message: p1.Message | None = None


@dataclass(frozen=True)
class ProtocolContext:
    """Everything the Core needs to speak Protocol v1 with one configured device."""

    device_id: str
    keys: p1.ProtocolKeys
    store: object
    clock: object

    @property
    def topics(self) -> p1.Topics:
        return p1.topics(self.device_id)


class InboundVerifier:
    def __init__(
        self,
        *,
        keys: p1.ProtocolKeys,
        device_id: str,
        store,
        clock,
        audit: Callable[..., None] | None = None,
        audit_level: str = "WARN",
    ) -> None:
        if hmac.compare_digest(keys.c2d, keys.d2c):
            raise ValueError("the CORE_TO_DEVICE and DEVICE_TO_CORE keys must be independent")
        self.topics = p1.topics(device_id)
        self._keys = keys
        self._device_id = device_id
        self._store = store
        self._clock = clock
        self._audit = audit
        self._audit_level = audit_level
        self.counters: Counter[tuple[str, str]] = Counter()

    def _reject(self, stage: str, code: str, *, kind: str | None = None, audited: bool = False) -> InboundResult:
        self.counters[(str(stage), code)] += 1
        if audited and self._audit is not None:
            # Stable codes only: never the payload, message id, or MAC.
            self._audit("P1_EVIDENCE_REJECTED", f"stage={stage} code={code} kind={kind}", self._audit_level)
        return InboundResult(False, str(stage), code)

    def process(self, topic: str, payload: bytes, retain: bool = False) -> InboundResult:
        kind = p1.kind_for_topic(topic, self._device_id)
        if kind not in D2C_KINDS:
            return self._reject(p1.Stage.TRANSPORT, "TOPIC")
        if retain:
            return self._reject(p1.Stage.TRANSPORT, "RETAINED")
        try:
            message = p1.parse(bytes(payload), topic=topic, device_id=self._device_id, accept_kinds=D2C_KINDS)
        except p1.ProtocolRejected as rejected:
            return self._reject(rejected.stage, rejected.code)

        now = self._clock.trusted_now()
        if now is None:
            return self._reject(p1.Stage.TIME, "LOCAL_TIME_UNTRUSTED")
        if not p1.verify(message, self._keys):
            return self._reject(p1.Stage.AUTH, "MAC")

        # Authenticated from here on: rejections are audited with stable codes.
        if message.kind == p1.STATUS and message.fields["time_trust"] == "UNTRUSTED":
            return self._reject(p1.Stage.SKEW, "DEVICE_TIME_UNTRUSTED", kind=message.kind, audited=True)
        skew = p1.check_skew(message.int("device_time"), now)
        if skew is not None:
            return self._reject(p1.Stage.SKEW, skew, kind=message.kind, audited=True)
        try:
            fresh = self._store.record_seen(self._device_id, message.fields["msg_id"], message.kind)
        except Exception:
            return self._reject(p1.Stage.REPLAY, "STORE", kind=message.kind, audited=True)
        if not fresh:
            return self._reject(p1.Stage.REPLAY, "DUPLICATE", kind=message.kind, audited=True)
        return InboundResult(True, ACCEPTED, "OK", message)
