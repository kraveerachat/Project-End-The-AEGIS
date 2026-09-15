"""Generate ``tests/fixtures/protocol-v1-vectors.json`` from the spec reference.

Usage: ``python tests/protocol_v1_vectors_generate.py`` rewrites the fixture.
``tests/test_protocol_v1_vectors.py`` fails if the committed fixture drifts
from this output. Every key here is a public TEST-ONLY value; Core key loading
refuses these keys (design §4.6).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import protocol_v1_reference as ref

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "protocol-v1-vectors.json"
KEY_C2D = bytes(range(0x20))
KEY_D2C = bytes(range(0x20, 0x40))
DEVICE = "test-device-01"
OTHER_DEVICE = "test-device-02"
TIME_FLOOR = 1_789_430_400
T0 = TIME_FLOOR + 3_600
NOW = T0 + 10
SUFFIX = {"COMMAND": "command", "HEARTBEAT": "heartbeat", "ACK": "ack", "STATUS": "status"}
U64_MAX = "18446744073709551615"


def topic(kind: str, device: str = DEVICE) -> str:
    return f"aegis/idea3/v1/{device}/{SUFFIX[kind]}"


def mid(label: str) -> str:
    return hashlib.sha256(f"aegis-p1-vector:{label}".encode()).hexdigest()[:32]


def key_for(kind: str) -> bytes:
    return KEY_C2D if ref.DOMAIN[kind] == ref.C2D else KEY_D2C


def els(kind: str, *fields: str, kind_text: str | None = None, device: str = DEVICE, version: str = "1") -> list[str]:
    return [version, kind_text or kind, device, *fields]


def sign(kind, elements, *, key=None, domain=None, sign_topic=None, mac_override=None) -> bytes:
    mac = ref.mac(key or key_for(kind), domain or ref.DOMAIN[kind], sign_topic or topic(kind), elements)
    return ref.wire(elements[0], [*elements[1:], mac_override if mac_override is not None else mac])


def flip_mac(raw: bytes) -> bytes:
    text = raw.decode("ascii")
    last = text[-3]
    return (text[:-3] + ("0" if last != "0" else "1") + text[-2:]).encode("ascii")


# ---- valid encodings -------------------------------------------------------

CMD_CUT = els("COMMAND", mid("cmd-cut"), "1", str(T0), str(T0 + 30), "CUT_UPLINK")
CMD_RESTORE = els("COMMAND", mid("cmd-restore"), "2", str(T0), str(T0 + 30), "RESTORE_UPLINK")
CMD_SEQMAX = els("COMMAND", mid("cmd-seqmax"), U64_MAX, str(T0), str(T0 + 30), "CUT_UPLINK")
HB = els("HEARTBEAT", mid("hb"), str(T0))
ACK_OK = els("ACK", mid("ack-ok"), str(T0 + 1), mid("cmd-cut"), "1", "ACCEPTED")
ACK_SEQ = els("ACK", mid("ack-seq"), str(T0 + 1), mid("cmd-cut"), "1", "REJECTED_SEQUENCE")
ACK_EXPIRED = els("ACK", mid("ack-expired"), str(T0 + 1), mid("cmd-cut"), "1", "REJECTED_EXPIRED")
ACK_PERSIST = els("ACK", mid("ack-persist"), str(T0 + 1), mid("cmd-restore"), "2", "REJECTED_PERSIST")
ST_PERIODIC = els("STATUS", mid("st-periodic"), str(T0 + 5), "SYNCED", "NORMAL", "PERIODIC", "", "0", "2", "-67", "183456")
ST_COMMAND = els(
    "STATUS", mid("st-command"), str(T0 + 2), "HOLDOVER", "LOCKDOWN", "COMMAND", mid("cmd-cut"), "1", "1", "-48", "200000",
)
ST_UNTRUSTED = els("STATUS", mid("st-untrusted"), "0", "UNTRUSTED", "LOCKDOWN", "BOOT", "", "0", "0", "-127", "0")
ST_SEQREJ = els(
    "STATUS", mid("st-seqrej"), str(T0 + 2), "SYNCED", "NORMAL", "SEQUENCE_REJECTED", mid("cmd-cut"), "1", "7", "0", "150000",
)
ST_DEADMAN = els("STATUS", mid("st-deadman"), str(T0 + 3), "SYNCED", "LOCKDOWN", "DEADMAN", "", "0", "7", "-90", "4294967295")

VALID = {
    "V-CMD-CUT": ("COMMAND", CMD_CUT),
    "V-CMD-RESTORE": ("COMMAND", CMD_RESTORE),
    "V-CMD-SEQMAX": ("COMMAND", CMD_SEQMAX),
    "V-HB": ("HEARTBEAT", HB),
    "V-ACK-OK": ("ACK", ACK_OK),
    "V-ACK-SEQ": ("ACK", ACK_SEQ),
    "V-ACK-EXPIRED": ("ACK", ACK_EXPIRED),
    "V-ACK-PERSIST": ("ACK", ACK_PERSIST),
    "V-ST-PERIODIC": ("STATUS", ST_PERIODIC),
    "V-ST-COMMAND": ("STATUS", ST_COMMAND),
    "V-ST-UNTRUSTED": ("STATUS", ST_UNTRUSTED),
    "V-ST-SEQREJ": ("STATUS", ST_SEQREJ),
    "V-ST-DEADMAN": ("STATUS", ST_DEADMAN),
}


def replace(elements: list[str], index: int, value: str) -> list[str]:
    changed = list(elements)
    changed[index] = value
    return changed


# ---- scenarios -------------------------------------------------------------

def core_ctx(**overrides):
    base = {"now": NOW, "timeTrust": "SYNCED", "seen": []}
    base.update(overrides)
    return base


def device_ctx(**overrides):
    base = {"now": NOW, "timeTrust": "SYNCED", "hwm": "0", "lastHeartbeat": "0", "persistFails": False}
    base.update(overrides)
    return base


def outputs(*, actuate=None, ack=None, status=None, heartbeat=False, hwm="0"):
    return {"actuate": actuate, "ack": ack, "status": status, "heartbeat": heartbeat, "hwmAfter": hwm}


SCENARIOS: list[dict] = []


def add(sid, receiver, kind, raw, stage, code, *, context, mac_valid, topic_text=None, retain=False, expect=None, note=""):
    entry = {
        "id": sid,
        "receiver": receiver,
        "topic": topic_text or topic(kind),
        "retain": retain,
        "context": context,
        # MAC validity is only meaningful once a wire reaches the AUTH stage.
        "macValid": None if stage in ("TRANSPORT", "SCHEMA") else mac_valid,
        "expectStage": stage,
        "expectCode": code,
    }
    try:
        text = raw.decode("ascii")
        entry["wire"] = text if text.isprintable() else None
    except UnicodeDecodeError:
        entry["wire"] = None
    if entry["wire"] is None:
        entry["wireHex"] = raw.hex()
    if receiver == "device":
        entry["expectOutputs"] = expect or outputs(hwm=context["hwm"])
    if note:
        entry["note"] = note
    SCENARIOS.append(entry)


def core_scenarios() -> None:
    ok = ("ACCEPTED", "OK")
    add("C-ACK-OK", "core", "ACK", sign("ACK", ACK_OK), *ok, context=core_ctx(), mac_valid=True)
    add("C-ST-PERIODIC", "core", "STATUS", sign("STATUS", ST_PERIODIC), *ok, context=core_ctx(), mac_valid=True)
    add("C-ST-COMMAND", "core", "STATUS", sign("STATUS", ST_COMMAND), *ok, context=core_ctx(), mac_valid=True)
    add("C-ST-SEQREJ", "core", "STATUS", sign("STATUS", ST_SEQREJ), *ok, context=core_ctx(), mac_valid=True)
    add("C-ST-DEADMAN", "core", "STATUS", sign("STATUS", ST_DEADMAN), *ok, context=core_ctx(), mac_valid=True)
    add("C-HOLDOVER", "core", "STATUS", sign("STATUS", ST_PERIODIC), *ok, context=core_ctx(timeTrust="HOLDOVER"), mac_valid=True)

    status = sign("STATUS", ST_PERIODIC)
    add("C-TOPIC-OTHER-DEVICE", "core", "STATUS", status, "TRANSPORT", "TOPIC", context=core_ctx(), mac_valid=True,
        topic_text=topic("STATUS", OTHER_DEVICE))
    add("C-TOPIC-COMMAND", "core", "COMMAND", sign("COMMAND", CMD_CUT), "TRANSPORT", "TOPIC", context=core_ctx(), mac_valid=True)
    add("C-RETAINED", "core", "STATUS", status, "TRANSPORT", "RETAINED", context=core_ctx(), mac_valid=True, retain=True,
        note="retained command/evidence is never accepted")
    add("C-SIZE-OVER", "core", "STATUS", b"x" * 513, "TRANSPORT", "SIZE", context=core_ctx(), mac_valid=False)
    add("C-SIZE-EMPTY", "core", "STATUS", b"", "TRANSPORT", "SIZE", context=core_ctx(), mac_valid=False)

    add("C-WHITESPACE", "core", "STATUS", status.replace(b",", b", ", 1), "SCHEMA", "SYNTAX", context=core_ctx(), mac_valid=False)
    add("C-ESCAPE", "core", "STATUS", status.replace(b'"PERIODIC"', b'"PERI\\ODIC"'), "SCHEMA", "SYNTAX",
        context=core_ctx(), mac_valid=False)
    add("C-NON-ASCII", "core", "STATUS", status.replace(b'"PERIODIC"', b'"PERI\xc3\xa9"'), "SCHEMA", "SYNTAX",
        context=core_ctx(), mac_valid=False)
    add("C-NESTED", "core", "STATUS", b'[1,["STATUS"]]', "SCHEMA", "SYNTAX", context=core_ctx(), mac_valid=False)
    add("C-NUMBER-ELEMENT", "core", "STATUS", status.replace(b',"0",', b",0,", 1), "SCHEMA", "SYNTAX",
        context=core_ctx(), mac_valid=False)
    add("C-TRAILING-NEWLINE", "core", "STATUS", status + b"\n", "SCHEMA", "SYNTAX", context=core_ctx(), mac_valid=False)
    add("C-VERSION-LEADING-ZERO", "core", "STATUS", b"[01" + status[2:], "SCHEMA", "SYNTAX", context=core_ctx(), mac_valid=False)
    add("C-LEGACY-V0-STATUS", "core", "STATUS", b'{"state":"LOCKDOWN","reason":"verified","rssi":-48,"heap":200000}',
        "SCHEMA", "SYNTAX", context=core_ctx(), mac_valid=False, note="legacy v0 JSON object fails closed")
    add("C-STATELESS-OBJECT", "core", "STATUS", b'{"reason":"heartbeat","rssi":-47,"heap":199000}', "SCHEMA", "SYNTAX",
        context=core_ctx(), mac_valid=False, note="malformed STATUS never becomes NORMAL")

    add("C-EXTRA", "core", "STATUS", sign("STATUS", [*ST_PERIODIC, "extra"]), "SCHEMA", "ARITY", context=core_ctx(), mac_valid=True)
    add("C-MISSING", "core", "STATUS", sign("STATUS", ST_PERIODIC[:-1]), "SCHEMA", "ARITY", context=core_ctx(), mac_valid=True)
    add("C-STATUS-ON-ACK-TOPIC", "core", "STATUS", status, "SCHEMA", "ARITY", context=core_ctx(), mac_valid=False,
        topic_text=topic("ACK"))

    field_cases = {
        "C-UPPER-MAC": status[:-67] + status[-67:-2].upper() + status[-2:],
        "C-RSSI-PLUS": sign("STATUS", replace(ST_PERIODIC, 11, "+5")),
        "C-RSSI-NEG-ZERO": sign("STATUS", replace(ST_PERIODIC, 11, "-0")),
        "C-RSSI-128": sign("STATUS", replace(ST_PERIODIC, 11, "-128")),
        "C-RSSI-POSITIVE": sign("STATUS", replace(ST_PERIODIC, 11, "1")),
        "C-HEAP-NEGATIVE": sign("STATUS", replace(ST_PERIODIC, 12, "-1")),
        "C-HEAP-OVERFLOW": sign("STATUS", replace(ST_PERIODIC, 12, "4294967296")),
        "C-ZERO-MSGID": sign("STATUS", replace(ST_PERIODIC, 3, "0" * 32)),
        "C-UPPER-MSGID": sign("STATUS", replace(ST_PERIODIC, 3, ST_PERIODIC[3].upper())),
        "C-U64-OVERFLOW": sign("STATUS", replace(ST_PERIODIC, 10, "18446744073709551616")),
        "C-NONCANON-INT": sign("STATUS", replace(ST_PERIODIC, 10, "02")),
        "C-NEGATIVE-U64": sign("STATUS", replace(ST_PERIODIC, 10, "-2")),
        "C-ENUM-REASON": sign("STATUS", replace(ST_PERIODIC, 7, "RESTORED")),
        "C-ENUM-TRUST": sign("STATUS", replace(ST_PERIODIC, 5, "TRUSTED")),
        "C-ENUM-OUTPUT": sign("STATUS", replace(ST_PERIODIC, 6, "CUT")),
        "C-DEVICE-GRAMMAR": sign("STATUS", replace(ST_PERIODIC, 2, "Test_Device")),
        "C-KIND-GRAMMAR": sign("STATUS", replace(ST_PERIODIC, 1, "status")),
    }
    for sid, raw in field_cases.items():
        add(sid, "core", "STATUS", raw, "SCHEMA", "FIELD", context=core_ctx(), mac_valid=sid != "C-UPPER-MAC")
    add("C-ENUM-RESULT", "core", "ACK", sign("ACK", replace(ACK_OK, 7, "OK")), "SCHEMA", "FIELD", context=core_ctx(), mac_valid=True)
    add("C-ACK-SEQ-ZERO", "core", "ACK", sign("ACK", replace(ACK_OK, 6, "0")), "SCHEMA", "FIELD", context=core_ctx(), mac_valid=True)

    add("C-VERSION-2", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 0, "2")), "PAYLOAD", "VERSION",
        context=core_ctx(), mac_valid=True)
    add("C-KIND-MISMATCH", "core", "ACK", sign("ACK", replace(ACK_OK, 1, "COMMAND")), "PAYLOAD", "KIND",
        context=core_ctx(), mac_valid=True, note="wrong kind on the ack topic")
    add("C-WRONG-DEVICE", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 2, OTHER_DEVICE)), "PAYLOAD", "DEVICE",
        context=core_ctx(), mac_valid=True)
    consistency = {
        "C-ST-UNTRUSTED-TIME": replace(ST_PERIODIC, 5, "UNTRUSTED"),
        "C-ST-SYNCED-ZERO": replace(ST_PERIODIC, 4, "0"),
        "C-ST-PERIODIC-CORRELATED": replace(ST_PERIODIC, 8, mid("cmd-cut")),
        "C-ST-COMMAND-UNCORRELATED": replace(replace(ST_COMMAND, 8, ""), 9, "0"),
        "C-ST-SEQREJ-HWM": replace(ST_SEQREJ, 10, "0"),
        "C-ST-EMPTY-ID-SEQ": replace(ST_PERIODIC, 9, "3"),
        "C-ST-TIME-FLOOR": replace(ST_PERIODIC, 4, str(TIME_FLOOR - 1)),
    }
    for sid, elements in consistency.items():
        add(sid, "core", "STATUS", sign("STATUS", elements), "PAYLOAD", "CONSISTENCY", context=core_ctx(), mac_valid=True)
    add("C-ACK-TIME-FLOOR", "core", "ACK", sign("ACK", replace(ACK_OK, 4, str(TIME_FLOOR - 1))), "PAYLOAD", "CONSISTENCY",
        context=core_ctx(), mac_valid=True)

    add("C-CORE-UNTRUSTED", "core", "STATUS", status, "TIME", "LOCAL_TIME_UNTRUSTED",
        context=core_ctx(timeTrust="UNTRUSTED"), mac_valid=True)
    add("C-TIME-BEFORE-AUTH", "core", "STATUS", flip_mac(status), "TIME", "LOCAL_TIME_UNTRUSTED",
        context=core_ctx(timeTrust="UNTRUSTED"), mac_valid=False, note="local time confidence precedes HMAC")

    add("C-MAC-FLIP", "core", "STATUS", flip_mac(status), "AUTH", "MAC", context=core_ctx(), mac_valid=False)
    add("C-UNSIGNED-STATUS", "core", "STATUS", sign("STATUS", ST_PERIODIC, mac_override="0" * 64), "AUTH", "MAC",
        context=core_ctx(), mac_valid=False)
    add("C-UNSIGNED-ACK", "core", "ACK", sign("ACK", ACK_OK, mac_override="0" * 64), "AUTH", "MAC",
        context=core_ctx(), mac_valid=False)
    add("C-WRONG-KEY", "core", "STATUS", sign("STATUS", ST_PERIODIC, key=KEY_C2D), "AUTH", "MAC", context=core_ctx(),
        mac_valid=False, note="evidence signed with the command key")
    add("C-WRONG-DOMAIN", "core", "STATUS", sign("STATUS", ST_PERIODIC, domain=ref.C2D), "AUTH", "MAC",
        context=core_ctx(), mac_valid=False)
    add("C-TOPIC-BINDING", "core", "STATUS", sign("STATUS", ST_PERIODIC, sign_topic=topic("STATUS", OTHER_DEVICE)),
        "AUTH", "MAC", context=core_ctx(), mac_valid=False)
    add("C-AUTH-BEFORE-SKEW", "core", "STATUS", flip_mac(sign("STATUS", replace(ST_PERIODIC, 4, str(NOW - 31)))),
        "AUTH", "MAC", context=core_ctx(), mac_valid=False)
    add("C-AUTH-BEFORE-REPLAY", "core", "STATUS", flip_mac(status), "AUTH", "MAC",
        context=core_ctx(seen=[ST_PERIODIC[3]]), mac_valid=False)

    add("C-STALE", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 4, str(NOW - 31))), "SKEW", "STALE",
        context=core_ctx(), mac_valid=True)
    add("C-STALE-EDGE-OK", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 4, str(NOW - 30))), *ok,
        context=core_ctx(), mac_valid=True)
    add("C-FUTURE", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 4, str(NOW + 3))), "SKEW", "FUTURE",
        context=core_ctx(), mac_valid=True)
    add("C-FUTURE-EDGE-OK", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 4, str(NOW + 2))), *ok,
        context=core_ctx(), mac_valid=True)
    add("C-DEVICE-UNTRUSTED", "core", "STATUS", sign("STATUS", ST_UNTRUSTED), "SKEW", "DEVICE_TIME_UNTRUSTED",
        context=core_ctx(), mac_valid=True)
    add("C-ACK-STALE", "core", "ACK", sign("ACK", replace(ACK_OK, 4, str(NOW - 31))), "SKEW", "STALE",
        context=core_ctx(), mac_valid=True)
    add("C-SKEW-BEFORE-REPLAY", "core", "STATUS", sign("STATUS", replace(ST_PERIODIC, 4, str(NOW - 31))), "SKEW", "STALE",
        context=core_ctx(seen=[ST_PERIODIC[3]]), mac_valid=True)
    add("C-REPLAY-STATUS", "core", "STATUS", status, "REPLAY", "DUPLICATE", context=core_ctx(seen=[ST_PERIODIC[3]]),
        mac_valid=True)
    add("C-REPLAY-ACK", "core", "ACK", sign("ACK", ACK_OK), "REPLAY", "DUPLICATE", context=core_ctx(seen=[ACK_OK[3]]),
        mac_valid=True)


def device_scenarios() -> None:
    cut = sign("COMMAND", CMD_CUT)
    restore = sign("COMMAND", CMD_RESTORE)
    heartbeat = sign("HEARTBEAT", HB)
    accepted_cut = outputs(actuate="LOCKDOWN", ack="ACCEPTED", status="COMMAND", hwm="1")
    add("D-CUT-ACCEPT", "device", "COMMAND", cut, "ACCEPTED", "OK", context=device_ctx(), mac_valid=True, expect=accepted_cut)
    add("D-CUT-HOLDOVER", "device", "COMMAND", cut, "ACCEPTED", "OK", context=device_ctx(timeTrust="HOLDOVER"),
        mac_valid=True, expect=accepted_cut)
    add("D-RESTORE-ACCEPT", "device", "COMMAND", restore, "ACCEPTED", "OK", context=device_ctx(hwm="1"), mac_valid=True,
        expect=outputs(actuate="NORMAL", ack="ACCEPTED", status="COMMAND", hwm="2"))
    add("D-CUT-PERSIST-FAIL", "device", "COMMAND", cut, "ACCEPTED", "OK", context=device_ctx(persistFails=True),
        mac_valid=True, expect=outputs(actuate="LOCKDOWN", ack="ACCEPTED", status="COMMAND", hwm="0"),
        note="CUT stays fail-secure when the sequence cannot be persisted")
    add("D-SEQMAX-ACCEPT", "device", "COMMAND", sign("COMMAND", CMD_SEQMAX), "ACCEPTED", "OK",
        context=device_ctx(hwm="18446744073709551614"), mac_valid=True,
        expect=outputs(actuate="LOCKDOWN", ack="ACCEPTED", status="COMMAND", hwm=U64_MAX))
    add("D-EXPIRES-EDGE-OK", "device", "COMMAND", cut, "ACCEPTED", "OK", context=device_ctx(now=T0 + 30), mac_valid=True,
        expect=accepted_cut)
    add("D-FUTURE-EDGE-OK", "device", "COMMAND", cut, "ACCEPTED", "OK", context=device_ctx(now=T0 - 2), mac_valid=True,
        expect=accepted_cut)
    add("D-HB-ACCEPT", "device", "HEARTBEAT", heartbeat, "ACCEPTED", "OK", context=device_ctx(), mac_valid=True,
        expect=outputs(heartbeat=True))

    add("D-TOPIC-STATUS", "device", "STATUS", sign("STATUS", ST_PERIODIC), "TRANSPORT", "TOPIC", context=device_ctx(),
        mac_valid=True)
    add("D-SIZE", "device", "COMMAND", b"x" * 513, "TRANSPORT", "SIZE", context=device_ctx(), mac_valid=False)
    add("D-LEGACY-V0-COMMAND", "device", "COMMAND",
        b'{"cmd":"CUT_UPLINK","nonce":"a1b2c3d4","ts":1789434000,"sig":"' + b"0" * 64 + b'"}',
        "SCHEMA", "SYNTAX", context=device_ctx(), mac_valid=False, note="legacy v0 command fails closed")
    add("D-ARITY", "device", "COMMAND", sign("COMMAND", CMD_CUT[:-1]), "SCHEMA", "ARITY", context=device_ctx(), mac_valid=True)
    add("D-ENUM-ACTION", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 7, "REBOOT")), "SCHEMA", "FIELD",
        context=device_ctx(), mac_valid=True)
    add("D-SEQ-ZERO", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 4, "0")), "SCHEMA", "FIELD",
        context=device_ctx(), mac_valid=True)
    add("D-VERSION", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 0, "2")), "PAYLOAD", "VERSION",
        context=device_ctx(), mac_valid=True)
    add("D-KIND", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 1, "ACK")), "PAYLOAD", "KIND",
        context=device_ctx(), mac_valid=True, note="wrong kind on the command topic")
    add("D-DEVICE", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 2, OTHER_DEVICE)), "PAYLOAD", "DEVICE",
        context=device_ctx(), mac_valid=True)
    add("D-TTL31", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 6, str(T0 + 31))), "PAYLOAD", "CONSISTENCY",
        context=device_ctx(), mac_valid=True)
    add("D-EXPIRES-BEFORE", "device", "COMMAND", sign("COMMAND", replace(CMD_CUT, 6, str(T0))), "PAYLOAD", "CONSISTENCY",
        context=device_ctx(), mac_valid=True)
    add("D-TIME-FLOOR", "device", "COMMAND",
        sign("COMMAND", replace(replace(CMD_CUT, 5, str(TIME_FLOOR - 1)), 6, str(TIME_FLOOR + 20))),
        "PAYLOAD", "CONSISTENCY", context=device_ctx(), mac_valid=True)

    add("D-TIME-UNTRUSTED", "device", "COMMAND", cut, "TIME", "LOCAL_TIME_UNTRUSTED",
        context=device_ctx(timeTrust="UNTRUSTED"), mac_valid=True)
    add("D-TIME-BEFORE-AUTH", "device", "COMMAND", flip_mac(cut), "TIME", "LOCAL_TIME_UNTRUSTED",
        context=device_ctx(timeTrust="UNTRUSTED"), mac_valid=False, note="local time confidence precedes HMAC")
    add("D-MAC-FLIP", "device", "COMMAND", flip_mac(cut), "AUTH", "MAC", context=device_ctx(), mac_valid=False)
    add("D-WRONG-KEY", "device", "COMMAND", sign("COMMAND", CMD_CUT, key=KEY_D2C), "AUTH", "MAC", context=device_ctx(),
        mac_valid=False, note="command signed with the evidence key")
    add("D-UNSIGNED", "device", "COMMAND", sign("COMMAND", CMD_CUT, mac_override="0" * 64), "AUTH", "MAC",
        context=device_ctx(), mac_valid=False)
    add("D-AUTH-BEFORE-SKEW", "device", "COMMAND", flip_mac(cut), "AUTH", "MAC", context=device_ctx(now=T0 + 31),
        mac_valid=False)

    expired = outputs(ack="REJECTED_EXPIRED")
    add("D-STALE", "device", "COMMAND", cut, "SKEW", "STALE", context=device_ctx(now=T0 + 31), mac_valid=True, expect=expired)
    add("D-FUTURE", "device", "COMMAND", cut, "SKEW", "FUTURE", context=device_ctx(now=T0 - 3), mac_valid=True, expect=expired)
    add("D-SKEW-BEFORE-REPLAY", "device", "COMMAND", cut, "SKEW", "STALE", context=device_ctx(now=T0 + 31, hwm="5"),
        mac_valid=True, expect=outputs(ack="REJECTED_EXPIRED", hwm="5"))
    add("D-SEQ-EQUAL", "device", "COMMAND", cut, "REPLAY", "SEQUENCE", context=device_ctx(hwm="1"), mac_valid=True,
        expect=outputs(ack="REJECTED_SEQUENCE", status="SEQUENCE_REJECTED", hwm="1"))
    add("D-SEQ-ROLLBACK", "device", "COMMAND", restore, "REPLAY", "SEQUENCE", context=device_ctx(hwm="5"), mac_valid=True,
        expect=outputs(ack="REJECTED_SEQUENCE", status="SEQUENCE_REJECTED", hwm="5"))
    add("D-RESTORE-PERSIST-FAIL", "device", "COMMAND", restore, "PERSIST", "PERSIST",
        context=device_ctx(hwm="1", persistFails=True), mac_valid=True, expect=outputs(ack="REJECTED_PERSIST", hwm="1"))

    add("D-HB-STALE", "device", "HEARTBEAT", heartbeat, "SKEW", "STALE", context=device_ctx(now=T0 + 31), mac_valid=True)
    add("D-HB-FUTURE", "device", "HEARTBEAT", heartbeat, "SKEW", "FUTURE", context=device_ctx(now=T0 - 3), mac_valid=True)
    add("D-HB-REPLAY", "device", "HEARTBEAT", heartbeat, "REPLAY", "DUPLICATE",
        context=device_ctx(lastHeartbeat=str(T0)), mac_valid=True)
    add("D-HB-UNTRUSTED", "device", "HEARTBEAT", heartbeat, "TIME", "LOCAL_TIME_UNTRUSTED",
        context=device_ctx(timeTrust="UNTRUSTED"), mac_valid=True)
    add("D-HB-BAD-MAC", "device", "HEARTBEAT", flip_mac(heartbeat), "AUTH", "MAC", context=device_ctx(), mac_valid=False)


def build_fixture() -> dict:
    SCENARIOS.clear()
    core_scenarios()
    device_scenarios()
    valid = []
    for vid, (kind, elements) in VALID.items():
        target = topic(kind)
        mac = ref.mac(key_for(kind), ref.DOMAIN[kind], target, elements)
        valid.append({
            "id": vid,
            "kind": kind,
            "topic": target,
            "elements": elements,
            "signingInputHex": ref.signing_input(ref.DOMAIN[kind], target, elements).hex(),
            "mac": mac,
            "wire": ref.wire(elements[0], [*elements[1:], mac]).decode("ascii"),
        })
    pair = {
        "domain": ref.D2C.decode(),
        "topic": topic("STATUS"),
        "a": ["ab", "c"],
        "b": ["a", "bc"],
    }
    pair["signingInputHexA"] = ref.signing_input(ref.D2C, pair["topic"], pair["a"]).hex()
    pair["signingInputHexB"] = ref.signing_input(ref.D2C, pair["topic"], pair["b"]).hex()
    return {
        "schema": "aegis-idea3-protocol-v1-vectors/1",
        "notice": "TEST ONLY. These keys are public and are refused by Core key loading.",
        "testOnlyKeys": {"c2d": KEY_C2D.hex(), "d2c": KEY_D2C.hex()},
        "deviceId": DEVICE,
        "timeFloor": TIME_FLOOR,
        "valid": valid,
        "scenarios": list(SCENARIOS),
        "lengthPrefixPair": pair,
        "hmacPrimitive": [
            {"source": "RFC 4231 test case 1", "keyHex": "0b" * 20, "dataHex": b"Hi There".hex(),
             "mac": "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"},
            {"source": "RFC 4231 test case 2", "keyHex": b"Jefe".hex(), "dataHex": b"what do ya want for nothing?".hex(),
             "mac": "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"},
        ],
    }


def render(fixture: dict) -> str:
    return json.dumps(fixture, indent=2) + "\n"


if __name__ == "__main__":
    FIXTURE.write_text(render(build_fixture()), encoding="ascii")
    print(f"wrote {FIXTURE}")
