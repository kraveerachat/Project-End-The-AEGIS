"""AEGIS IDEA3 Protocol v1 codec (PR11 Phase 4, design §4).

Pure functions only: the canonical wire grammar, field validation, the
deterministic length-prefixed signing input, HMAC verification, and key
loading. Nothing here changes Core state; the time, replay, and effect stages
belong to the inbound verifier (design §6).
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import struct
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType

PROTOCOL_VERSION = 1
PROTOCOL_LABEL = "AEGIS-IDEA3-PROTOCOL"
DOMAIN_C2D = "CORE_TO_DEVICE"
DOMAIN_D2C = "DEVICE_TO_CORE"
MAX_PAYLOAD_BYTES = 512
TIME_FLOOR = 1_789_430_400  # 2026-09-15T00:00:00Z
COMMAND_TTL_MAX_SEC = 30
SKEW_PAST_SEC = 30
SKEW_FUTURE_SEC = 2
U64_MAX = 2**64 - 1
U32_MAX = 2**32 - 1
RSSI_MIN = -127

COMMAND = "COMMAND"
HEARTBEAT = "HEARTBEAT"
ACK = "ACK"
STATUS = "STATUS"
KINDS = frozenset({COMMAND, HEARTBEAT, ACK, STATUS})

# R3: fixed enum sets; anything else is a SCHEMA rejection.
ACTIONS = frozenset({"CUT_UPLINK", "RESTORE_UPLINK"})
ACK_RESULTS = frozenset({"ACCEPTED", "REJECTED_EXPIRED", "REJECTED_SEQUENCE", "REJECTED_PERSIST"})
TIME_TRUST_STATES = frozenset({"SYNCED", "HOLDOVER", "UNTRUSTED"})
OUTPUT_STATES = frozenset({"NORMAL", "LOCKDOWN"})
STATUS_REASONS = frozenset({"BOOT", "PERIODIC", "COMMAND", "DEADMAN", "BOOT_GRACE", "SEQUENCE_REJECTED"})
CORRELATED_REASONS = frozenset({"COMMAND", "SEQUENCE_REJECTED"})

DOMAIN_BY_KIND = MappingProxyType(
    {COMMAND: DOMAIN_C2D, HEARTBEAT: DOMAIN_C2D, ACK: DOMAIN_D2C, STATUS: DOMAIN_D2C}
)
_TOPIC_SUFFIX = {COMMAND: "command", HEARTBEAT: "heartbeat", ACK: "ack", STATUS: "status"}

_LAYOUTS: dict[str, tuple[tuple[str, str], ...]] = {
    COMMAND: (("msg_id", "msgid"), ("seq", "seq"), ("issued_at", "u64"), ("expires_at", "u64"), ("action", "action")),
    HEARTBEAT: (("msg_id", "msgid"), ("issued_at", "u64")),
    ACK: (
        ("msg_id", "msgid"), ("device_time", "u64"), ("ack_for_msg_id", "msgid"), ("ack_for_seq", "seq"),
        ("result", "result"),
    ),
    STATUS: (
        ("msg_id", "msgid"), ("device_time", "u64"), ("time_trust", "time_trust"), ("output_state", "output_state"),
        ("reason", "reason"), ("cmd_msg_id", "msgid_opt"), ("cmd_seq", "u64"), ("device_seq_hwm", "u64"),
        ("rssi_dbm", "rssi"), ("heap_free", "u32"),
    ),
}
ARITY = MappingProxyType({kind: 3 + len(layout) + 1 for kind, layout in _LAYOUTS.items()})
FIELD_NAMES = MappingProxyType({kind: tuple(name for name, _ in layout) for kind, layout in _LAYOUTS.items()})

# design §4.3: '[' version *( ',' string ) ']' with printable ASCII minus '"' and '\'.
_MESSAGE_RE = re.compile(rb'\[(0|[1-9][0-9]{0,9})((?:,"[\x20\x21\x23-\x5b\x5d-\x7e]*")*)\]')
_STRING_RE = re.compile(rb',"([\x20\x21\x23-\x5b\x5d-\x7e]*)"')
_DEVICE_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,30}[a-z0-9]")
_KIND_RE = re.compile(r"[A-Z_]{1,16}")
_HEX32_RE = re.compile(r"[0-9a-f]{32}")
_HEX64_RE = re.compile(r"[0-9a-f]{64}")
_U64_RE = re.compile(r"0|[1-9][0-9]{0,19}")
_U32_RE = re.compile(r"0|[1-9][0-9]{0,9}")
_RSSI_RE = re.compile(r"0|-[1-9][0-9]{0,2}")
_ENUMS = {
    "action": ACTIONS,
    "result": ACK_RESULTS,
    "time_trust": TIME_TRUST_STATES,
    "output_state": OUTPUT_STATES,
    "reason": STATUS_REASONS,
}

# Public, well-known material that must never be accepted as a real key: the
# golden-vector TEST-ONLY keys and anything derived from the legacy demo secret.
_LEGACY_DEMO_SECRET = b"AEGIS-DEMO-SHARED-SECRET-change-me"
_FORBIDDEN_KEY_DIGESTS = frozenset(
    hashlib.sha256(candidate).digest()
    for candidate in (
        bytes(range(0x20)),
        bytes(range(0x20, 0x40)),
        hashlib.sha256(_LEGACY_DEMO_SECRET).digest(),
        _LEGACY_DEMO_SECRET[:32],
    )
)


class Stage(StrEnum):
    TRANSPORT = "TRANSPORT"
    SCHEMA = "SCHEMA"
    PAYLOAD = "PAYLOAD"
    TIME = "TIME"
    AUTH = "AUTH"
    SKEW = "SKEW"
    REPLAY = "REPLAY"
    PERSIST = "PERSIST"


class ProtocolRejected(Exception):
    """A message failed a validation stage; ``code`` is a stable reason."""

    def __init__(self, stage: Stage, code: str):
        super().__init__(f"{stage}/{code}")
        self.stage = stage
        self.code = code


class ProtocolKeyError(ValueError):
    """Key material is missing or unsafe. The message never contains key bytes."""


@dataclass(frozen=True)
class Topics:
    command: str
    heartbeat: str
    ack: str
    status: str

    def for_kind(self, kind: str) -> str:
        return getattr(self, _TOPIC_SUFFIX[kind])


@dataclass(frozen=True)
class ProtocolKeys:
    """The two independent per-device keys; never printed."""

    c2d: bytes = field(repr=False)
    d2c: bytes = field(repr=False)

    def for_kind(self, kind: str) -> bytes:
        return self.c2d if DOMAIN_BY_KIND[kind] == DOMAIN_C2D else self.d2c

    def __repr__(self) -> str:
        return "ProtocolKeys(<redacted>)"


@dataclass(frozen=True)
class Message:
    """A message that passed TRANSPORT, SCHEMA, and PAYLOAD. It is not yet authenticated."""

    kind: str
    topic: str
    device_id: str
    elements: tuple[str, ...]
    mac: str
    fields: Mapping[str, str]

    def int(self, name: str) -> int:
        return int(self.fields[name])


def valid_device_id(device_id: object) -> bool:
    return isinstance(device_id, str) and _DEVICE_RE.fullmatch(device_id) is not None


def topics(device_id: str) -> Topics:
    if not valid_device_id(device_id):
        raise ValueError("device_id does not match the Protocol v1 device grammar")
    base = f"aegis/idea3/v1/{device_id}"
    return Topics(f"{base}/command", f"{base}/heartbeat", f"{base}/ack", f"{base}/status")


def kind_for_topic(topic: str, device_id: str) -> str | None:
    device_topics = topics(device_id)
    for kind in (COMMAND, HEARTBEAT, ACK, STATUS):
        if device_topics.for_kind(kind) == topic:
            return kind
    return None


def _lp(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


def signing_input(domain: str, topic: str, elements: Sequence[str]) -> bytes:
    """design §4.5: length-prefixed label, domain, topic, and every non-MAC element."""
    parts = [_lp(PROTOCOL_LABEL.encode("ascii")), _lp(domain.encode("ascii")), _lp(topic.encode("ascii"))]
    parts.extend(_lp(element.encode("ascii")) for element in elements)
    return b"".join(parts)


def _digest(key: bytes, kind: str, topic: str, elements: Sequence[str]) -> bytes:
    return hmac.new(key, signing_input(DOMAIN_BY_KIND[kind], topic, elements), hashlib.sha256).digest()


def _valid_field(field_type: str, text: str) -> bool:
    if field_type == "msgid":
        return _HEX32_RE.fullmatch(text) is not None and text != "0" * 32
    if field_type == "msgid_opt":
        return text == "" or _valid_field("msgid", text)
    if field_type in ("u64", "seq"):
        if _U64_RE.fullmatch(text) is None or int(text) > U64_MAX:
            return False
        return field_type == "u64" or int(text) >= 1
    if field_type == "u32":
        return _U32_RE.fullmatch(text) is not None and int(text) <= U32_MAX
    if field_type == "rssi":
        return _RSSI_RE.fullmatch(text) is not None and int(text) >= RSSI_MIN
    return text in _ENUMS[field_type]


def _consistent(kind: str, fields: Mapping[str, str]) -> bool:
    if kind == COMMAND:
        issued_at, expires_at = int(fields["issued_at"]), int(fields["expires_at"])
        return issued_at >= TIME_FLOOR and issued_at < expires_at and expires_at - issued_at <= COMMAND_TTL_MAX_SEC
    if kind == HEARTBEAT:
        return int(fields["issued_at"]) >= TIME_FLOOR
    if kind == ACK:
        return int(fields["device_time"]) >= TIME_FLOOR
    device_time = int(fields["device_time"])
    if (fields["time_trust"] == "UNTRUSTED") != (device_time == 0):
        return False
    if device_time != 0 and device_time < TIME_FLOOR:
        return False
    correlated = fields["cmd_msg_id"] != ""
    if (fields["reason"] in CORRELATED_REASONS) != correlated:
        return False
    cmd_seq = int(fields["cmd_seq"])
    if correlated != (cmd_seq >= 1):
        return False
    return fields["reason"] != "SEQUENCE_REJECTED" or int(fields["device_seq_hwm"]) >= cmd_seq


def parse(raw: bytes, *, topic: str, device_id: str, accept_kinds: frozenset[str] = KINDS) -> Message:
    """Run the pre-authentication TRANSPORT, SCHEMA, and PAYLOAD stages (design §6)."""
    expected = kind_for_topic(topic, device_id)
    if expected is None or expected not in accept_kinds:
        raise ProtocolRejected(Stage.TRANSPORT, "TOPIC")
    if not raw or len(raw) > MAX_PAYLOAD_BYTES:
        raise ProtocolRejected(Stage.TRANSPORT, "SIZE")

    match = _MESSAGE_RE.fullmatch(raw)
    if match is None:
        raise ProtocolRejected(Stage.SCHEMA, "SYNTAX")
    elements = [match.group(1).decode("ascii")]
    elements.extend(text.decode("ascii") for text in _STRING_RE.findall(match.group(2)))
    if len(elements) != ARITY[expected]:
        raise ProtocolRejected(Stage.SCHEMA, "ARITY")
    layout = _LAYOUTS[expected]
    if _KIND_RE.fullmatch(elements[1]) is None or not valid_device_id(elements[2]):
        raise ProtocolRejected(Stage.SCHEMA, "FIELD")
    for (_, field_type), text in zip(layout, elements[3:-1], strict=True):
        if not _valid_field(field_type, text):
            raise ProtocolRejected(Stage.SCHEMA, "FIELD")
    if _HEX64_RE.fullmatch(elements[-1]) is None:
        raise ProtocolRejected(Stage.SCHEMA, "FIELD")

    if elements[0] != str(PROTOCOL_VERSION):
        raise ProtocolRejected(Stage.PAYLOAD, "VERSION")
    if elements[1] != expected:
        raise ProtocolRejected(Stage.PAYLOAD, "KIND")
    if elements[2] != device_id:
        raise ProtocolRejected(Stage.PAYLOAD, "DEVICE")
    fields = dict(zip((name for name, _ in layout), elements[3:-1], strict=True))
    if not _consistent(expected, fields):
        raise ProtocolRejected(Stage.PAYLOAD, "CONSISTENCY")
    return Message(expected, topic, device_id, tuple(elements[:-1]), elements[-1], MappingProxyType(fields))


def verify(message: Message, keys: ProtocolKeys) -> bool:
    """AUTH: recompute the MAC with the key fixed by the kind; constant-time compare."""
    expected = _digest(keys.for_kind(message.kind), message.kind, message.topic, message.elements)
    return hmac.compare_digest(expected, bytes.fromhex(message.mac))


def check_skew(timestamp: int, now: int) -> str | None:
    """Authenticated timestamp skew: None, 'FUTURE', or 'STALE'."""
    if timestamp > now + SKEW_FUTURE_SEC:
        return "FUTURE"
    if now - timestamp > SKEW_PAST_SEC:
        return "STALE"
    return None


def _field_text(value: object) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise TypeError("Protocol v1 fields are strings or integers")
    return str(value)


def encode(kind: str, *, device_id: str, fields: Mapping[str, object], keys: ProtocolKeys) -> tuple[str, bytes]:
    """Build and sign one message; the result is re-parsed so invalid input never leaves."""
    if kind not in _LAYOUTS:
        raise ValueError("unknown Protocol v1 kind")
    names = FIELD_NAMES[kind]
    if set(fields) != set(names):
        raise ValueError(f"{kind} fields do not match the Protocol v1 layout")
    topic = topics(device_id).for_kind(kind)
    elements = [str(PROTOCOL_VERSION), kind, device_id, *(_field_text(fields[name]) for name in names)]
    try:
        mac = _digest(keys.for_kind(kind), kind, topic, elements).hex()
        raw = ("[" + elements[0] + "".join(f',"{text}"' for text in [*elements[1:], mac]) + "]").encode("ascii")
    except UnicodeEncodeError as error:
        raise ValueError(f"{kind} fields must be printable ASCII") from error
    try:
        parse(raw, topic=topic, device_id=device_id, accept_kinds=frozenset({kind}))
    except ProtocolRejected as rejected:
        raise ValueError(f"invalid {kind} fields: {rejected.stage}/{rejected.code}") from None
    return topic, raw


def new_msg_id(rng: Callable[[int], bytes] = secrets.token_bytes) -> str:
    """A 128-bit CSPRNG message ID; an all-zero draw is never used."""
    for _ in range(4):
        value = rng(16)
        if len(value) == 16 and any(value):
            return value.hex()
    raise RuntimeError("random source did not produce a usable message id")


def _read_key(path: Path | str, label: str) -> bytes:
    try:
        text = Path(path).read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError, TypeError):
        raise ProtocolKeyError(f"{label} key file is missing or unreadable") from None
    text = text.removesuffix("\n")
    if _HEX64_RE.fullmatch(text) is None:
        raise ProtocolKeyError(f"{label} key must be exactly 64 lowercase hex characters")
    return bytes.fromhex(text)


def load_protocol_keys(c2d_path: Path | str, d2c_path: Path | str) -> ProtocolKeys:
    """Load the two per-device keys and refuse unsafe or well-known material (design §4.6)."""
    c2d = _read_key(c2d_path, "CORE_TO_DEVICE")
    d2c = _read_key(d2c_path, "DEVICE_TO_CORE")
    for label, key in (("CORE_TO_DEVICE", c2d), ("DEVICE_TO_CORE", d2c)):
        if not any(key):
            raise ProtocolKeyError(f"{label} key is all zeros")
        if hashlib.sha256(key).digest() in _FORBIDDEN_KEY_DIGESTS:
            raise ProtocolKeyError(f"{label} key is a public test or demo value")
    if hmac.compare_digest(c2d, d2c):
        raise ProtocolKeyError("the CORE_TO_DEVICE and DEVICE_TO_CORE keys must be independent")
    return ProtocolKeys(c2d=c2d, d2c=d2c)
