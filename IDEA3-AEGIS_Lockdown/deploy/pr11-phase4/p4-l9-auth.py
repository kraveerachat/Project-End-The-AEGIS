"""AEGIS IDEA3 PR11 Phase 4 — Stage L9 authentication helper.

Authority: docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l9-operational-design.md (OD-L9-01..OD-L9-09)

Fixture-only backend: exercises Protocol v1 authenticated HEARTBEAT and
STATUS frames without actuating relays, touching live brokers, opening serial
ports, or issuing commands.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import stat
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Ensure aegis_soc is importable
_REPO_DIR = Path(__file__).resolve().parents[2]
if str(_REPO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DIR))

from aegis_soc import protocol_v1 as p1
from aegis_soc.protocol_inbound import InboundResult, InboundVerifier
from aegis_soc.protocol_store import ProtocolStore


class L9Error(Exception):
    """Raised for any Stage L9 constraint, transport, or evidence violation."""


EVIDENCE_NAME = "l9-auth-evidence.json"
STORE_NAME = "fixture-protocol.sqlite3"

EVIDENCE_FIELDS = (
    "schema_version",
    "run_id",
    "evidence_class",
    "device_id",
    "heartbeat_accepted",
    "heartbeat_effect",
    "status_boot_accepted",
    "status_periodic_accepted",
    "liveness_before_authenticated_status",
    "heartbeat_probes",
    "status_probes",
    "negative_probe_acceptances",
    "replay_rows_from_rejected",
    "commands_emitted",
    "cut_emitted",
    "restore_emitted",
    "relay_actuation",
    "result",
    "failure_boundary",
)

DEVICE_EFFECTS = ("DEADMAN_RESET",)

EXPECTED_HEARTBEAT_PROBES = {
    "hb_replay": "REPLAY/DUPLICATE",
    "hb_older_issued_at": "REPLAY/NOT_MONOTONIC",
    "hb_wrong_key_foreign": "AUTH/MAC",
    "hb_wrong_key_cross_direction": "AUTH/MAC",
    "hb_tampered_mac": "AUTH/MAC",
    "hb_tampered_field": "AUTH/MAC",
    "hb_zero_mac": "AUTH/MAC",
    "hb_stale": "SKEW/STALE",
    "hb_future": "SKEW/FUTURE",
    "hb_malformed": "SCHEMA/SYNTAX",
    "hb_device_mismatch": "PAYLOAD/DEVICE",
    "hb_topic_mismatch": "TRANSPORT/TOPIC",
    "hb_device_time_untrusted": "TIME/LOCAL_TIME_UNTRUSTED",
}

EXPECTED_STATUS_PROBES = {
    "st_replay": "REPLAY/DUPLICATE",
    "st_wrong_key_foreign": "AUTH/MAC",
    "st_wrong_key_cross_direction": "AUTH/MAC",
    "st_tampered_mac": "AUTH/MAC",
    "st_tampered_field": "AUTH/MAC",
    "st_zero_mac": "AUTH/MAC",
    "st_stale": "SKEW/STALE",
    "st_future": "SKEW/FUTURE",
    "st_device_time_untrusted": "SKEW/DEVICE_TIME_UNTRUSTED",
    "st_malformed": "SCHEMA/SYNTAX",
    "st_legacy_v0_json": "SCHEMA/SYNTAX",
    "st_device_mismatch": "PAYLOAD/DEVICE",
    "st_topic_mismatch": "TRANSPORT/TOPIC",
    "st_c2d_kind_on_core": "TRANSPORT/TOPIC",
    "st_retained": "TRANSPORT/RETAINED",
    "st_core_time_untrusted": "TIME/LOCAL_TIME_UNTRUSTED",
}

HEARTBEAT_PROBES = dict(EXPECTED_HEARTBEAT_PROBES)
STATUS_PROBES = dict(EXPECTED_STATUS_PROBES)

PRE_AUTH_STAGES = {"TRANSPORT", "SCHEMA", "PAYLOAD", "TIME", "AUTH"}


class FixtureClock:
    """Fixture clock for inbound verification and device model processing."""

    def __init__(self, now: int, trusted: bool = True) -> None:
        self.now = int(now)
        self.trusted = bool(trusted)

    def trusted_now(self) -> int | None:
        return self.now if self.trusted else None


class DeviceHeartbeatModel:
    """Model of ESP32 Protocol v1 heartbeat reception (design §6.1)."""

    def __init__(self, device_id: str, keys: p1.ProtocolKeys, clock: Any) -> None:
        self.device_id = device_id
        self.keys = keys
        self.clock = clock
        self.effects: list[str] = []
        self.seen_msg_ids: set[str] = set()
        self.last_issued_at: int = -1

    def process(self, topic: str, payload: bytes, *, device_time_trusted: bool | None = None) -> InboundResult:
        trusted = (self.clock.trusted_now() is not None) if device_time_trusted is None else device_time_trusted
        if not trusted:
            return InboundResult(False, "TIME", "LOCAL_TIME_UNTRUSTED")

        try:
            message = p1.parse(bytes(payload), topic=topic, device_id=self.device_id, accept_kinds=frozenset({p1.HEARTBEAT}))
        except p1.ProtocolRejected as rej:
            return InboundResult(False, str(rej.stage), rej.code)

        if not p1.verify(message, self.keys):
            return InboundResult(False, "AUTH", "MAC")

        now = self.clock.now if hasattr(self.clock, "now") else (self.clock.trusted_now() or 0)
        issued_at = message.int("issued_at")
        if issued_at > now + p1.SKEW_FUTURE_SEC:
            return InboundResult(False, "SKEW", "FUTURE")
        if now - issued_at > p1.SKEW_PAST_SEC:
            return InboundResult(False, "SKEW", "STALE")

        msg_id = message.fields["msg_id"]
        if msg_id in self.seen_msg_ids:
            return InboundResult(False, "REPLAY", "DUPLICATE")
        if issued_at <= self.last_issued_at:
            return InboundResult(False, "REPLAY", "NOT_MONOTONIC")

        self.seen_msg_ids.add(msg_id)
        self.last_issued_at = issued_at
        self.effects.append("DEADMAN_RESET")
        return InboundResult(True, "ACCEPTED", "OK", message)


class RecordingTransport:
    """Mock transport that accepts only the configured device's heartbeat topic."""

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        self.heartbeat_topic = p1.topics(device_id).heartbeat
        self.frames: list[tuple[str, bytes]] = []

    def publish(self, topic: str, payload: bytes) -> None:
        if topic != self.heartbeat_topic:
            raise L9Error(f"TRANSPORT_REFUSED: topic {topic!r} is not the permitted heartbeat topic {self.heartbeat_topic!r}")
        self.frames.append((topic, bytes(payload)))


LAST_TRANSPORT: RecordingTransport | None = None


def foreign_key(key: bytes) -> bytes:
    """Deterministically derive a foreign key by flipping one bit."""
    b = bytearray(key)
    b[0] ^= 1
    return bytes(b)


def replay_row_count(store: ProtocolStore) -> int:
    """Return the number of seen D2C rows in the protocol store."""
    with store._lock:
        row = store._db.execute("SELECT COUNT(*) FROM protocol_seen_d2c").fetchone()
        return int(row[0]) if row else 0


def build_core_verifier(
    keys: p1.ProtocolKeys,
    device_id: str,
    store: ProtocolStore,
    clock: Any,
    audit: Callable[..., None] | None = None,
) -> InboundVerifier:
    return InboundVerifier(keys=keys, device_id=device_id, store=store, clock=clock, audit=audit)


class HeartbeatProbe:
    def __init__(self, name: str, topic: str, payload: bytes, device_time_trusted: bool = True) -> None:
        self.name = name
        self.topic = topic
        self.payload = payload
        self.device_time_trusted = device_time_trusted


class HeartbeatFrames:
    def __init__(self, positive: HeartbeatProbe, negatives: list[HeartbeatProbe], replay: HeartbeatProbe) -> None:
        self.positive = positive
        self.negatives = negatives
        self.replay = replay


class StatusProbe:
    def __init__(self, name: str, topic: str, payload: bytes, retain: bool = False, core_time_trusted: bool = True) -> None:
        self.name = name
        self.topic = topic
        self.payload = payload
        self.retain = retain
        self.core_time_trusted = core_time_trusted


class StatusFrames:
    def __init__(self, positives: list[StatusProbe], negatives: list[StatusProbe], replay: StatusProbe) -> None:
        self.positives = positives
        self.negatives = negatives
        self.replay = replay


def build_heartbeat_frames(keys: p1.ProtocolKeys, device_id: str, now: int) -> HeartbeatFrames:
    topic, pos_payload = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "1" * 32, "issued_at": now},
        keys=keys,
    )
    positive = HeartbeatProbe("positive", topic, pos_payload)
    replay = HeartbeatProbe("hb_replay", topic, pos_payload)

    _, pl_older = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "2" * 32, "issued_at": now - 5},
        keys=keys,
    )
    fk = foreign_key(keys.c2d)
    _, pl_foreign = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "3" * 32, "issued_at": now},
        keys=p1.ProtocolKeys(c2d=fk, d2c=keys.d2c),
    )
    _, pl_cross = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "4" * 32, "issued_at": now},
        keys=p1.ProtocolKeys(c2d=keys.d2c, d2c=keys.c2d),
    )
    tampered_mac = bytearray(pos_payload)
    idx = tampered_mac.rfind(b'"')
    tampered_mac[idx - 1] = ord(b"1") if tampered_mac[idx - 1] == ord(b"0") else ord(b"0")

    tampered_field = pos_payload.replace(b'"1111', b'"2111', 1)
    zero_mac = re.sub(rb'"[0-9a-f]{64}"\]$', rb'"' + b"0" * 64 + rb'"]', pos_payload)

    _, pl_stale = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "5" * 32, "issued_at": now - 31},
        keys=keys,
    )
    _, pl_future = p1.encode(
        p1.HEARTBEAT,
        device_id=device_id,
        fields={"msg_id": "6" * 32, "issued_at": now + 3},
        keys=keys,
    )
    pl_malformed = b"[not-json]"
    _, pl_dev_mismatch = p1.encode(
        p1.HEARTBEAT,
        device_id="aegis-relay-99",
        fields={"msg_id": "7" * 32, "issued_at": now},
        keys=keys,
    )
    other_topic = p1.topics("aegis-relay-99").heartbeat

    negatives = [
        HeartbeatProbe("hb_older_issued_at", topic, pl_older),
        HeartbeatProbe("hb_wrong_key_foreign", topic, pl_foreign),
        HeartbeatProbe("hb_wrong_key_cross_direction", topic, pl_cross),
        HeartbeatProbe("hb_tampered_mac", topic, bytes(tampered_mac)),
        HeartbeatProbe("hb_tampered_field", topic, tampered_field),
        HeartbeatProbe("hb_zero_mac", topic, zero_mac),
        HeartbeatProbe("hb_stale", topic, pl_stale),
        HeartbeatProbe("hb_future", topic, pl_future),
        HeartbeatProbe("hb_malformed", topic, pl_malformed),
        HeartbeatProbe("hb_device_mismatch", topic, pl_dev_mismatch),
        HeartbeatProbe("hb_topic_mismatch", other_topic, pos_payload),
        HeartbeatProbe("hb_device_time_untrusted", topic, pos_payload, device_time_trusted=False),
    ]
    return HeartbeatFrames(positive=positive, negatives=negatives, replay=replay)


def build_status_frames(keys: p1.ProtocolKeys, device_id: str, now: int) -> StatusFrames:
    def fields(msg_id: str, dev_time: int = now, time_trust: str = "SYNCED", reason: str = "BOOT") -> dict[str, object]:
        return {
            "msg_id": msg_id,
            "device_time": dev_time,
            "time_trust": time_trust,
            "output_state": "LOCKDOWN",
            "reason": reason,
            "cmd_msg_id": "",
            "cmd_seq": 0,
            "device_seq_hwm": 0,
            "rssi_dbm": -60,
            "heap_free": 120000,
        }

    def enc(f: dict[str, object], k: p1.ProtocolKeys = keys, dev: str = device_id) -> tuple[str, bytes]:
        return p1.encode(p1.STATUS, device_id=dev, fields=f, keys=k)

    topic, boot_payload = enc(fields("1" * 32, reason="BOOT"))
    _, periodic_payload = enc(fields("2" * 32, reason="PERIODIC"))

    positives = [
        StatusProbe("st_boot", topic, boot_payload, retain=False),
        StatusProbe("st_periodic", topic, periodic_payload, retain=False),
    ]
    replay = StatusProbe("st_replay", topic, boot_payload, retain=False)

    fk = foreign_key(keys.d2c)
    _, pl_foreign = enc(fields("3" * 32), k=p1.ProtocolKeys(c2d=keys.c2d, d2c=fk))
    _, pl_cross = enc(fields("4" * 32), k=p1.ProtocolKeys(c2d=keys.d2c, d2c=keys.c2d))

    tampered_mac = bytearray(boot_payload)
    idx = tampered_mac.rfind(b'"')
    tampered_mac[idx - 1] = ord(b"1") if tampered_mac[idx - 1] == ord(b"0") else ord(b"0")

    tampered_field = boot_payload.replace(b'"120000"', b'"120001"', 1)
    zero_mac = re.sub(rb'"[0-9a-f]{64}"\]$', rb'"' + b"0" * 64 + rb'"]', boot_payload)

    _, pl_stale = enc(fields("5" * 32, dev_time=now - 31))
    _, pl_future = enc(fields("6" * 32, dev_time=now + 3))
    _, pl_untrusted = enc(fields("7" * 32, dev_time=0, time_trust="UNTRUSTED"))

    pl_malformed = b"[not-json]"
    pl_v0 = b'{"state":"CUT"}'
    _, pl_dev_mismatch = enc(fields("8" * 32), dev="aegis-relay-99")
    other_topic = p1.topics("aegis-relay-99").status
    hb_topic = p1.topics(device_id).heartbeat

    negatives = [
        StatusProbe("st_wrong_key_foreign", topic, pl_foreign, retain=False),
        StatusProbe("st_wrong_key_cross_direction", topic, pl_cross, retain=False),
        StatusProbe("st_tampered_mac", topic, bytes(tampered_mac), retain=False),
        StatusProbe("st_tampered_field", topic, tampered_field, retain=False),
        StatusProbe("st_zero_mac", topic, zero_mac, retain=False),
        StatusProbe("st_stale", topic, pl_stale, retain=False),
        StatusProbe("st_future", topic, pl_future, retain=False),
        StatusProbe("st_device_time_untrusted", topic, pl_untrusted, retain=False),
        StatusProbe("st_malformed", topic, pl_malformed, retain=False),
        StatusProbe("st_legacy_v0_json", topic, pl_v0, retain=False),
        StatusProbe("st_device_mismatch", topic, pl_dev_mismatch, retain=False),
        StatusProbe("st_topic_mismatch", other_topic, boot_payload, retain=False),
        StatusProbe("st_c2d_kind_on_core", hb_topic, boot_payload, retain=False),
        StatusProbe("st_retained", topic, boot_payload, retain=True),
        StatusProbe("st_core_time_untrusted", topic, boot_payload, retain=False, core_time_trusted=False),
    ]
    return StatusFrames(positives=positives, negatives=negatives, replay=replay)


def write_evidence(path: Path | str, fields: Mapping[str, object]) -> None:
    """Write evidence bundle write-once at mode 0600 with strict allowlist."""
    path = Path(path)
    extra = set(fields) - set(EVIDENCE_FIELDS)
    if extra:
        raise L9Error(f"allowlist violation: unexpected extra fields {sorted(extra)}")
    missing = set(EVIDENCE_FIELDS) - set(fields)
    if missing:
        raise L9Error(f"missing required fields {sorted(missing)}")

    data = json.dumps(dict(fields), indent=2).encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags, 0o600)
    except FileExistsError:
        raise L9Error(f"write-once evidence file already exists: {path}") from None
    except OSError as err:
        raise L9Error(f"failed to create evidence file: {err}") from err
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def run_exercise(
    keys: p1.ProtocolKeys,
    device_id: str,
    now: int,
    work_dir: Path,
    run_id: str,
    verifier_factory: Callable[..., Any] | None = None,
    store_factory: Callable[[Path], ProtocolStore] | None = None,
) -> dict[str, Any]:
    """Execute the Stage L9 authentication exercise on the fixture backend."""
    global LAST_TRANSPORT
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    store_path = work_dir / STORE_NAME

    if store_factory is not None:
        store = store_factory(store_path)
    else:
        store = ProtocolStore(store_path, wall_clock=lambda: float(now))

    clock = FixtureClock(now)
    if verifier_factory is not None:
        verifier = verifier_factory(keys=keys, device_id=device_id, store=store, clock=clock)
    else:
        verifier = build_core_verifier(keys, device_id, store, clock)

    transport = RecordingTransport(device_id)
    LAST_TRANSPORT = transport

    model = DeviceHeartbeatModel(device_id, keys, clock)
    hb_frames = build_heartbeat_frames(keys, device_id, now)

    # 1. Positive heartbeat
    hb_res = model.process(hb_frames.positive.topic, hb_frames.positive.payload)
    if hb_res.accepted:
        transport.publish(hb_frames.positive.topic, hb_frames.positive.payload)
        heartbeat_accepted = "PASS"
        heartbeat_effect = "DEADMAN_RESET_ONLY" if model.effects == ["DEADMAN_RESET"] else "OUTPUT_CHANGED"
    else:
        heartbeat_accepted = "FAIL"
        heartbeat_effect = "NONE"

    # 2. Negative heartbeat probes
    heartbeat_probes: dict[str, str] = {}
    negative_probe_acceptances = 0
    failure_boundary = "NONE"

    hb_replay_res = model.process(hb_frames.replay.topic, hb_frames.replay.payload)
    heartbeat_probes["hb_replay"] = f"{hb_replay_res.stage}/{hb_replay_res.code}"
    if hb_replay_res.accepted:
        negative_probe_acceptances += 1
        if failure_boundary == "NONE":
            failure_boundary = "PROBE_ACCEPTED:hb_replay"

    for probe in hb_frames.negatives:
        res = model.process(probe.topic, probe.payload, device_time_trusted=probe.device_time_trusted)
        heartbeat_probes[probe.name] = f"{res.stage}/{res.code}"
        if res.accepted:
            negative_probe_acceptances += 1
            if failure_boundary == "NONE":
                failure_boundary = f"PROBE_ACCEPTED:{probe.name}"

    # 3. Negative status probes (run before any positive to prove no liveness/replay before auth)
    status_frames = build_status_frames(keys, device_id, now)
    status_probes: dict[str, str] = {}
    rows_before = replay_row_count(store)

    for probe in status_frames.negatives:
        clock.trusted = probe.core_time_trusted
        res = verifier.process(probe.topic, probe.payload, retain=probe.retain)
        clock.trusted = True
        status_probes[probe.name] = f"{res.stage}/{res.code}"
        if res.accepted:
            negative_probe_acceptances += 1
            if failure_boundary == "NONE":
                failure_boundary = f"PROBE_ACCEPTED:{probe.name}"

    rows_after_negatives = replay_row_count(store)
    replay_rows_from_rejected = rows_after_negatives - rows_before
    liveness_before = "NO"

    # 4. Positive status frames
    boot_res = verifier.process(status_frames.positives[0].topic, status_frames.positives[0].payload, retain=status_frames.positives[0].retain)
    status_boot_accepted = "PASS" if boot_res.accepted else "FAIL"

    periodic_res = verifier.process(status_frames.positives[1].topic, status_frames.positives[1].payload, retain=status_frames.positives[1].retain)
    status_periodic_accepted = "PASS" if periodic_res.accepted else "FAIL"

    # 5. Status replay
    st_replay_res = verifier.process(status_frames.replay.topic, status_frames.replay.payload, retain=status_frames.replay.retain)
    status_probes["st_replay"] = f"{st_replay_res.stage}/{st_replay_res.code}"
    if st_replay_res.accepted:
        negative_probe_acceptances += 1
        if failure_boundary == "NONE":
            failure_boundary = "PROBE_ACCEPTED:st_replay"

    # 6. Check store commands
    commands_emitted = 0
    with sqlite3.connect(store_path) as db:
        commands_emitted = int(db.execute("SELECT COUNT(*) FROM protocol_commands").fetchone()[0])
    store.close()

    cut_emitted = 0
    restore_emitted = 0
    relay_actuation = "NONE"

    result = "PASS"
    if commands_emitted > 0:
        result = "FAIL"
        failure_boundary = "ACTUATION_DETECTED"
    elif heartbeat_accepted != "PASS":
        result = "FAIL"
        if failure_boundary == "NONE":
            failure_boundary = "HEARTBEAT_NOT_ACCEPTED"
    elif status_boot_accepted != "PASS" or status_periodic_accepted != "PASS":
        result = "FAIL"
        if failure_boundary == "NONE":
            failure_boundary = "STATUS_NOT_ACCEPTED"
    elif negative_probe_acceptances > 0:
        result = "FAIL"
    elif replay_rows_from_rejected > 0:
        result = "FAIL"
        if failure_boundary == "NONE":
            failure_boundary = "REPLAY_ROW_FROM_REJECTED"
    else:
        for name, expected in HEARTBEAT_PROBES.items():
            if heartbeat_probes.get(name) != expected:
                result = "FAIL"
                if failure_boundary == "NONE":
                    failure_boundary = f"PROBE_UNEXPECTED:{name}"
                break
        if result == "PASS":
            for name, expected in STATUS_PROBES.items():
                if status_probes.get(name) != expected:
                    result = "FAIL"
                    if failure_boundary == "NONE":
                        failure_boundary = f"PROBE_UNEXPECTED:{name}"
                    break

    evidence = {
        "schema_version": 1,
        "run_id": run_id,
        "evidence_class": "REPOSITORY_FIXTURE",
        "device_id": device_id,
        "heartbeat_accepted": heartbeat_accepted,
        "heartbeat_effect": heartbeat_effect,
        "status_boot_accepted": status_boot_accepted,
        "status_periodic_accepted": status_periodic_accepted,
        "liveness_before_authenticated_status": liveness_before,
        "heartbeat_probes": heartbeat_probes,
        "status_probes": status_probes,
        "negative_probe_acceptances": negative_probe_acceptances,
        "replay_rows_from_rejected": replay_rows_from_rejected,
        "commands_emitted": commands_emitted,
        "cut_emitted": cut_emitted,
        "restore_emitted": restore_emitted,
        "relay_actuation": relay_actuation,
        "result": result,
        "failure_boundary": failure_boundary,
    }
    return evidence


def verify_evidence(evidence_path: Path, input_dir: Path | None = None) -> None:
    """Verify that an evidence bundle is complete, well-formed, and strictly passes."""
    if not evidence_path.is_file() or evidence_path.is_symlink():
        raise L9Error(f"evidence file missing or symlink: {evidence_path}")
    mode = stat.S_IMODE(evidence_path.stat().st_mode)
    if mode != 0o600:
        raise L9Error(f"evidence file mode must be 0600 (got {oct(mode)})")

    try:
        raw_text = evidence_path.read_text(encoding="utf-8")
        data = json.loads(raw_text)
    except Exception as exc:
        raise L9Error(f"failed to parse evidence json: {exc}") from exc

    if not isinstance(data, dict):
        raise L9Error("evidence root is not a dictionary")

    if set(data) != set(EVIDENCE_FIELDS):
        raise L9Error("evidence field set does not match allowlist")

    if data["result"] != "PASS":
        raise L9Error(f"evidence result is not PASS: {data['result']}")
    if data["evidence_class"] != "REPOSITORY_FIXTURE":
        raise L9Error(f"evidence_class is not REPOSITORY_FIXTURE: {data['evidence_class']}")
    if data["heartbeat_accepted"] != "PASS":
        raise L9Error("heartbeat_accepted is not PASS")
    if data["heartbeat_effect"] != "DEADMAN_RESET_ONLY":
        raise L9Error(f"heartbeat_effect is not DEADMAN_RESET_ONLY: {data['heartbeat_effect']}")
    if data["status_boot_accepted"] != "PASS":
        raise L9Error("status_boot_accepted is not PASS")
    if data["status_periodic_accepted"] != "PASS":
        raise L9Error("status_periodic_accepted is not PASS")
    if data["liveness_before_authenticated_status"] != "NO":
        raise L9Error("liveness_before_authenticated_status is not NO")
    if data["negative_probe_acceptances"] != 0:
        raise L9Error(f"negative_probe_acceptances is not 0: {data['negative_probe_acceptances']}")
    if data["replay_rows_from_rejected"] != 0:
        raise L9Error(f"replay_rows_from_rejected is not 0: {data['replay_rows_from_rejected']}")
    if data["commands_emitted"] != 0:
        raise L9Error(f"commands_emitted is not 0: {data['commands_emitted']}")
    if data["cut_emitted"] != 0:
        raise L9Error(f"cut_emitted is not 0: {data['cut_emitted']}")
    if data["restore_emitted"] != 0:
        raise L9Error(f"restore_emitted is not 0: {data['restore_emitted']}")
    if data["relay_actuation"] != "NONE":
        raise L9Error(f"relay_actuation is not NONE: {data['relay_actuation']}")
    if data["failure_boundary"] != "NONE":
        raise L9Error(f"failure_boundary is not NONE: {data['failure_boundary']}")

    if dict(data.get("heartbeat_probes", {})) != EXPECTED_HEARTBEAT_PROBES:
        raise L9Error("heartbeat_probes mismatch against design expectation")
    if dict(data.get("status_probes", {})) != EXPECTED_STATUS_PROBES:
        raise L9Error("status_probes mismatch against design expectation")

    # Key material exclusion check
    if input_dir is not None and Path(input_dir).is_dir():
        for key_file in ("k_c2d", "k_d2c"):
            kp = Path(input_dir) / key_file
            if kp.is_file():
                k_text = kp.read_text(encoding="ascii").strip().lower()
                if k_text and k_text in raw_text.lower():
                    raise L9Error("key material detected in evidence bundle")


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    parser = argparse.ArgumentParser(description="AEGIS Stage L9 authentication helper")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    p_exercise = subparsers.add_parser("exercise")
    p_exercise.add_argument("--input-dir", required=True)
    p_exercise.add_argument("--work-dir", required=True)
    p_exercise.add_argument("--evidence-dir", required=True)
    p_exercise.add_argument("--backend", required=True)
    p_exercise.add_argument("--device-id", required=True)
    p_exercise.add_argument("--run-id", required=True)
    p_exercise.add_argument("--fixture-now", required=True)

    p_verify = subparsers.add_parser("verify")
    p_verify.add_argument("--evidence-dir", required=True)
    p_verify.add_argument("--input-dir", default=None)

    args = parser.parse_args(argv)

    if args.subcommand == "exercise":
        if args.backend == "live":
            sys.stderr.write("L9_APPLY=FAIL reason=LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY (LIVE_L9=NOT_AUTHORIZED)\n")
            return 1
        if args.backend != "fixture":
            sys.stderr.write(f"L9_APPLY=FAIL reason=unknown backend: {args.backend}\n")
            return 1

        input_dir = Path(args.input_dir)
        try:
            keys = p1.load_protocol_keys(input_dir / "k_c2d", input_dir / "k_d2c")
        except p1.ProtocolKeyError as exc:
            sys.stderr.write(f"L9_APPLY=FAIL reason=invalid protocol key: {exc}\n")
            return 1
        except Exception as exc:
            sys.stderr.write(f"L9_APPLY=FAIL reason=failed to read key files: {exc}\n")
            return 1

        try:
            now = int(args.fixture_now)
        except ValueError:
            sys.stderr.write("L9_APPLY=FAIL reason=invalid fixture-now\n")
            return 1

        work_dir = Path(args.work_dir)
        evidence_dir = Path(args.evidence_dir)
        evidence_dir.mkdir(parents=True, exist_ok=True)
        evidence_path = evidence_dir / EVIDENCE_NAME

        evidence = run_exercise(
            keys=keys,
            device_id=args.device_id,
            now=now,
            work_dir=work_dir,
            run_id=args.run_id,
        )

        try:
            write_evidence(evidence_path, evidence)
        except L9Error as exc:
            sys.stderr.write(f"L9_APPLY=FAIL reason={exc}\n")
            return 1

        if evidence["result"] != "PASS":
            sys.stderr.write(f"L9_APPLY=FAIL reason={evidence['failure_boundary']}\n")
            return 1

        return 0

    if args.subcommand == "verify":
        evidence_dir = Path(args.evidence_dir)
        evidence_path = evidence_dir / EVIDENCE_NAME
        try:
            verify_evidence(evidence_path, Path(args.input_dir) if args.input_dir else None)
        except L9Error as exc:
            sys.stderr.write(f"L9_VERIFY=FAIL reason={exc}\n")
            return 1
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
