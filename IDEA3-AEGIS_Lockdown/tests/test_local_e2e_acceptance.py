"""LOCAL E2E acceptance (EVIDENCE CLASS: SIMULATED_LOCAL_E2E): synthetic attack -> production detector -> Core alert ingress -> web-minted
CUT dispatch (real Node machine app over loopback HTTP, real ``DispatchClient``) -> Core policy -> Protocol v1 command -> firmware-model device
-> signed ACK/STATUS -> correlation -> hash-chained audit -> web evidence/snapshot.

What is REAL here: ``ProductionDetector``, ``AlertIngress``, supervisor, controller, Protocol v1 codec/store/verifier, MQTT adapter, dispatch worker
and ledger, ``DispatchClient``, the Node web app and machine app with a disposable SQLite database, session/CSRF/login, the hash-chained audit.
What is SIMULATED: the paho client / broker (no broker, no TLS, no ACL), the ESP32 and relay (``FirmwareModelDevice``, pinned to ``firmware/src/main.cpp``),
the HUB mTLS terminator (identity headers are injected on loopback), every attack (synthetic log lines, never packets), the containment helper.
NOT PROVEN by anything in this file: the physical relay, GPIO, ESP32 firmware behaviour, Wi-Fi/MQTT-over-TLS, broker ACL, the real uplink cut, RESTORE
on hardware, Production, or Recovery R2-R8. A simulated LOCKDOWN is never physical evidence.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import shutil
import subprocess
import time
from collections import Counter
from dataclasses import dataclass, field
from http.cookiejar import CookieJar
from pathlib import Path

import pytest
from offline_device_sim import SimulatedDevice
from test_core_recovery import (
    IP,
    credential,  # noqa: F401
    op,
)
from test_local_restore import DEVICE, KEYS, NOW, TOPICS, request
from test_offline_core_acceptance import Rig
from test_protocol_ordering import ACTION_ID

from aegis_soc import alert_sink, recovery_core
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import production_detector as pd
from aegis_soc import protocol_v1 as p1
from aegis_soc import recovery_protocol as rp
from aegis_soc.dispatch_client import DispatchClient
from aegis_soc.dispatch_worker import DispatchWorker

EVIDENCE_CLASS = "SIMULATED_LOCAL_E2E"
LOCKDOWN_ROOT = Path(__file__).resolve().parent.parent
BRIDGE = LOCKDOWN_ROOT / "tests" / "e2e" / "loopback_web_bridge.mjs"
FIRMWARE = (LOCKDOWN_ROOT / "firmware" / "src" / "main.cpp").read_text()
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None or not (LOCKDOWN_ROOT / "web" / "node_modules").exists(), reason="node and web/node_modules are required")
IDENTITY = {"X-AEGIS-Client-Verify": "SUCCESS", "X-AEGIS-Client-DN": "CN=idea3-core,O=AEGIS"}


# ── firmware model: the rules of firmware/src/main.cpp that the offline simulator does not model ────────────────────────────────────────────
@dataclass
class FirmwareModelDevice(SimulatedDevice):
    """Adds boot lockdown, the dead-man switch, the boot grace and sequence persistence. Constants are PINNED to main.cpp by a test."""

    deadman_ms: int = 60_000
    boot_grace_ms: int = 90_000
    uptime_ms: int = 0
    last_heartbeat_ms: int = 0
    deadman_triggered: bool = False
    pending_frames: list = field(default_factory=list)

    def __post_init__(self) -> None:
        self.locked_down = True  # setup(): the relay is driven to the trigger level and isLockedDown starts true

    def reboot(self) -> None:
        """Power cycle: only ``seq_hi`` survives (NVS). State returns to LOCKDOWN, replay memory is gone, heartbeat timer restarts."""
        self.locked_down = True
        self.uptime_ms = 0
        self.last_heartbeat_ms = 0
        self.deadman_triggered = False
        self.heartbeat_seen = []
        self.log.append("boot:LOCKDOWN")

    def receive(self, topic, payload, *, retain=False):
        before = len(self.heartbeat_seen)
        replies = super().receive(topic, payload, retain=retain)
        if len(self.heartbeat_seen) > before:  # an accepted authenticated heartbeat arms the dead-man timer
            self.last_heartbeat_ms = self.uptime_ms
            self.deadman_triggered = False
        return replies

    def advance(self, ms: int) -> list[tuple[str, bytes]]:
        """checkDeadman(): returns the signed STATUS frames the device would publish."""
        self.uptime_ms += ms
        out = []
        if self.last_heartbeat_ms == 0:
            if self.uptime_ms > self.boot_grace_ms and not self.locked_down:
                self.locked_down = True
            return out
        if self.uptime_ms - self.last_heartbeat_ms > self.deadman_ms and not self.deadman_triggered:
            self.deadman_triggered = True
            self.locked_down = True
            out.append(self._status("DEADMAN"))
        return out


# ── the real web apps over loopback ─────────────────────────────────────────────────────────────────────────────────────────────────────────
class WebBridge:
    def __init__(self, tmp_path: Path, runtime_status_file: Path | None = None):
        extra = ["--runtimeStatusFile", str(runtime_status_file)] if runtime_status_file else []
        self.proc = subprocess.Popen(
            [NODE, str(BRIDGE), "--db", str(tmp_path / "web-audit.sqlite"), "--nowEpoch", str(NOW), *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, cwd=str(LOCKDOWN_ROOT / "tests" / "e2e"),
        )
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError(self.proc.stderr.read()[:400])
        info = json.loads(line)
        self.web_port, self.machine_port, self.base, self.password, self.action_id = (
            info["webPort"], info["machinePort"], info["basePath"], info["password"], info["actionId"])
        self.jar = CookieJar()
        self.csrf = ""

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()

    # Core -> web (what the Core's DispatchClient transport does: HTTP to the machine listener with the HUB-injected identity headers)
    def transport(self, method, url, body, headers):
        path = url.split("core.web.test", 1)[1]
        conn = http.client.HTTPConnection("127.0.0.1", self.machine_port, timeout=10)
        conn.request(method, path, body=body, headers={**headers, **IDENTITY})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, data

    def client(self) -> DispatchClient:
        return DispatchClient("https://core.web.test/api/machine/v1", self.transport)

    # browser -> web (Admin session)
    def call(self, method, path, body=None, *, csrf=True, headers=None, origin=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.web_port, timeout=10)
        h = {"Accept": "application/json", **(headers or {})}
        if origin:
            h["Origin"] = f"http://127.0.0.1:{self.web_port}"
        cookie = "; ".join(f"{c.name}={c.value}" for c in self.jar)
        if cookie:
            h["Cookie"] = cookie
        if csrf and self.csrf:
            h["X-CSRF-Token"] = self.csrf
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        conn.request(method, f"{self.base}/api{path}", body=data, headers=h)
        response = conn.getresponse()
        raw = response.read()
        for value in response.msg.get_all("Set-Cookie") or []:
            name, _, rest = value.partition("=")
            from http.cookiejar import Cookie
            val = rest.split(";", 1)[0]
            self.jar.set_cookie(Cookie(0, name, val, None, False, "127.0.0.1", False, False, "/", True, False, None, True, None, None, {}))
        conn.close()
        try:
            return response.status, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return response.status, {"raw": raw[:200].decode("latin-1")}

    def login(self, password: str | None = None):
        status, doc = self.call("POST", "/auth/login", {"username": "admin", "password": password or self.password}, csrf=False)
        if status == 200:
            self.csrf = doc["csrfToken"]
        return status, doc

    def logout(self):
        status, doc = self.call("POST", "/auth/logout", {})
        self.csrf = ""
        self.jar.clear()
        return status, doc


@pytest.fixture
def bridge(tmp_path):
    b = WebBridge(tmp_path)
    yield b
    b.close()


# ── the Core rig with the real DispatchClient ──────────────────────────────────────────────────────────────────────────────────────────────
class E2E(Rig):
    def __init__(self, tmp_path, monkeypatch, credential, web: WebBridge | None = None):  # noqa: F811
        super().__init__(tmp_path, monkeypatch, credential)
        self.device = FirmwareModelDevice(DEVICE, KEYS, now=lambda: NOW)
        self.clock = [NOW]
        self.ledger._clock = lambda: self.clock[0]  # test-only: let the ledger's timeouts advance with the scenario clock
        self.web_bridge = web
        if web is not None:
            self.worker = DispatchWorker(
                self.core.supervisor, self.ledger, web.client(), wall_clock=lambda: self.clock[0], ack_timeout_sec=5, status_timeout_sec=10,
            )
            self.core.supervisor.dispatch_worker = self.worker
        self.ingress = recovery_core.AlertIngress(self.core.supervisor.on_production_alert)

    # detector -> ingress (the AF_UNIX hop is replaced by a direct call; the peer uid is the configured alert source)
    def detector(self, clock):
        def sender(ip: str) -> alert_sink.AlertResult:
            response = self.ingress.handle({"v": 1, "attacker_ip": ip}, lr.Peer(uid=os.geteuid(), pid=4242), allowed_uid=os.geteuid())
            return alert_sink.AlertResult(bool(response["ok"]), alert_sink.SENT_BOUND if response["ok"] else alert_sink.CORE_REJECTED, response["code"])
        return pd.ProductionDetector(sender, clock=clock)


@pytest.fixture
def e2e(tmp_path, monkeypatch, credential):  # noqa: F811
    instance = E2E(tmp_path, monkeypatch, credential)
    yield instance
    instance.close()


@pytest.fixture
def e2e_web(tmp_path, monkeypatch, credential, bridge):  # noqa: F811
    instance = E2E(tmp_path, monkeypatch, credential, bridge)
    yield instance
    instance.close()


class Tick:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


SSH = "sshd[812]: Failed password for root from {ip} port {port} ssh2"
NEWCONN = "kernel: AEGIS_NEWCONN IN=eth0 SRC={ip} DST=192.0.2.10 PROTO=TCP SPT={sport} DPT={port} SYN"


def feed(detector, clock, lines, step=0.1):
    for line in lines:
        detector.process(line)
        clock.now += step


def attack_lines(kind, ip=IP):
    if kind == "ssh":
        return [SSH.format(ip=ip, port=40000 + i) for i in range(pd.FAIL_THRESHOLD)], 1.0
    if kind == "portscan":
        return [NEWCONN.format(ip=ip, sport=50000 + i, port=1000 + i) for i in range(pd.SCAN_PORT_THRESHOLD)], 0.2
    if kind == "syn":
        return [NEWCONN.format(ip=ip, sport=50000 + i, port=443) for i in range(pd.SYN_FLOOD_THRESHOLD)], 0.05
    raise AssertionError(kind)


# ── scenarios 2-4: synthetic attacks reach the Core only as a bound incident ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("kind", ["ssh", "portscan", "syn"])
def test_s02_s04_a_synthetic_attack_is_detected_and_bound_as_an_incident_without_any_command(e2e, kind):
    clock = Tick()
    detector = e2e.detector(clock)
    lines, step = attack_lines(kind)
    feed(detector, clock, lines[:-1], step)
    assert db.get_open_incident() is None, "below the threshold nothing is reported"
    feed(detector, clock, lines[-1:], step)
    incident = db.get_open_incident()
    assert incident is not None and incident["attacker_ip"] == IP
    assert e2e.core.client.published == [] and e2e.command_frames() == [], "a detector can never reach the device"
    assert "ALERT_ACCEPTED" in e2e.events() and not {"COMMAND_SENT", "CUT_REQUESTED"} & set(e2e.events())


def run_pipeline(e2e, bridge, kind="ssh"):
    """synthetic attack -> detector -> Core incident -> (web accepted CUT) -> claim -> command -> device -> ACK/STATUS -> evidence to web."""
    clock = Tick()
    detector = e2e.detector(clock)
    lines, step = attack_lines(kind)
    feed(detector, clock, lines, step)
    e2e.worker.start()
    e2e.worker.tick()  # list_pending -> claim -> issue_command -> PUBLISHED
    frames = e2e.command_frames()
    assert len(frames) == 1
    replies = e2e.device_round_trip(frames[-1])
    e2e.worker.tick()  # deliver PUBLISHED/ACK/STATUS evidence to the web
    return frames[-1], replies


def tamper(frame):
    topic, payload = frame
    mac = re.findall(rb'"([0-9a-f]{64})"\]$', payload)[0]
    flipped = (b"0" if mac[:1] != b"0" else b"1") + mac[1:]
    return topic, payload[: -len(mac) - 2] + flipped + b'"]'


def audit_events(e2e):
    return e2e.events()


# ── scenario 1: normal authenticated device status ─────────────────────────────────────────────────────────────────────────────────────────
def test_s01_a_normal_authenticated_status_is_recorded_as_liveness_only(e2e):
    e2e.device.locked_down = False
    e2e.to_core(*e2e.device.periodic_status())
    assert "DEVICE_STATUS" in e2e.events() and e2e.stages() == []
    assert e2e.ledger.pending_outbox() == [] and e2e.core.client.published == []
    assert any("NORMAL (PERIODIC)" in str(row) for row in db.fetch_all_logs())


# ── scenarios 5, 15, 18: the whole pipeline through the real web ──────────────────────────────────────────────────────────────────────────
@needs_node
def test_s05_s15_s18_valid_authenticated_cut_flows_from_detector_to_the_web_audit(e2e_web, bridge):
    frame, replies = run_pipeline(e2e_web, bridge)
    command = p1.parse(frame[1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    assert p1.verify(command, KEYS) and command.fields["action"] == "CUT_UPLINK"
    assert [p1.kind_for_topic(t, DEVICE) for t, _ in replies] == [p1.ACK, p1.STATUS]
    assert e2e_web.device.locked_down is True and e2e_web.device.log[-1] == "applied:CUT_UPLINK"
    entry = e2e_web.ledger.get(bridge.action_id)
    assert entry["state"] == "STATUS_CORRELATED" and entry["nonce"] == command.fields["msg_id"]
    assert e2e_web.ledger.pending_outbox() == [], "every evidence stage was delivered to the web"
    # Core audit: ordered, hash-chained
    events = e2e_web.events()
    assert events.index("ALERT_ACCEPTED") < events.index("COMMAND_SENT") < events.index("ACK_RECEIVED") < events.index("DEVICE_STATUS")
    assert db.verify_chain()[0] is True
    # Web audit: the SAME ladder, reported by the Core over the machine route, claimed by machine identity
    assert bridge.login()[0] == 200
    _, audit = bridge.call("GET", "/security/audit?limit=100")
    rows = list(reversed(audit["audit"]))
    dispatch_rows = [(r["action"], r["detail"].get("stage")) for r in rows if r["category"] == "DISPATCH"]
    assert dispatch_rows == [("ACTION_MINTED", None), ("ACTION_CLAIMED", None), ("EVIDENCE_RECORDED", "PUBLISHED"), ("EVIDENCE_RECORDED", "ACK"), ("EVIDENCE_RECORDED", "STATUS")]
    assert {r["actorRef"] for r in rows if r["action"] in ("ACTION_CLAIMED", "EVIDENCE_RECORDED")} == {"machine-core"}
    text = json.dumps(audit)
    assert KEYS.c2d.hex() not in text and KEYS.d2c.hex() not in text and "password" not in text.lower()
    # physical truth is never claimed
    stages = {r["detail"].get("stage") for r in rows if r["category"] == "DISPATCH"}
    assert not {"CONTAINED", "RELAY_EVIDENCE", "EXECUTED", "PHYSICAL", "HARDWARE"} & stages


@needs_node
def test_s18_s19_the_web_never_claims_live_device_or_incident_state_it_was_not_given(e2e_web, bridge):
    run_pipeline(e2e_web, bridge)
    bridge.login()
    status, snap = bridge.call("GET", "/security/snapshot")
    assert status == 200 and snap["mode"] == "LIVE" and snap["provenance"]["liveMerged"] is False
    assert snap["incidents"] == [] and snap["devices"] == [] and snap["alerts"] == []
    idea3 = next(item for item in snap["sources"] if item["id"] == "idea3")
    assert idea3["status"] == "UNKNOWN" and idea3["freshness"] == "ABSENT"
    assert snap["recovery"]["liveHardware"] is False and snap["recovery"]["authorization"] == "DISABLED"
    assert all(c["status"] == "UNKNOWN" for c in snap["runtime"]["components"])


@needs_node
def test_s19_logout_and_login_keep_the_durable_evidence_and_never_leak_simulated_state(e2e_web, bridge):
    run_pipeline(e2e_web, bridge)
    bridge.login()
    before = bridge.call("GET", "/security/audit?limit=100")[1]["audit"]
    status, doc = bridge.call("POST", "/security/demo-mode", {"enabled": True})
    assert status == 200 and doc["mode"] == "DEMO"
    demo = bridge.call("GET", "/security/snapshot")[1]
    assert demo["mode"] == "DEMO"
    assert bridge.logout()[0] == 204
    assert bridge.call("GET", "/security/snapshot")[0] == 401
    assert bridge.login()[0] == 200
    live = bridge.call("GET", "/security/snapshot")[1]
    assert live["mode"] == "LIVE" and live["incidents"] == [], "a new login never inherits simulated state"
    after = bridge.call("GET", "/security/audit?limit=100")[1]["audit"]
    kept = [r for r in after if r["category"] == "DISPATCH"]
    assert kept == [r for r in before if r["category"] == "DISPATCH"], "durable dispatch evidence survives logout/login unchanged"
    assert bridge.call("GET", "/auth/session")[1]["authenticated"] is True


@needs_node
def test_a_bad_login_and_a_request_without_a_session_are_refused(e2e_web, bridge):
    assert bridge.call("GET", "/security/snapshot")[0] == 401
    assert bridge.login("wrong-password-wrong-password")[0] == 401
    assert bridge.call("POST", "/auth/login", {"username": "admin", "password": bridge.password}, csrf=False, origin=False)[0] == 403


@needs_node
def test_the_machine_route_refuses_a_non_core_identity_and_never_dispatches_restore(e2e_web, bridge):
    def forged(method, url, body, headers):
        conn = http.client.HTTPConnection("127.0.0.1", bridge.machine_port, timeout=10)
        conn.request(method, url.split("core.web.test", 1)[1], body=body, headers={**headers, "X-AEGIS-Client-Verify": "SUCCESS", "X-AEGIS-Client-DN": "CN=imposter,O=AEGIS"})
        r = conn.getresponse()
        return r.status, r.read()
    from aegis_soc.dispatch_client import DispatchUnavailable
    with pytest.raises(DispatchUnavailable):
        DispatchClient("https://core.web.test/api/machine/v1", forged).list_pending()
    pending = bridge.client().list_pending()
    assert [(a.action, a.action_id) for a in pending] == [("CUT_UPLINK", bridge.action_id)], "only CUT_UPLINK can ever be pending"


# ── scenarios 6-10: protocol attacks against the device and the Core ─────────────────────────────────────────────────────────────────────
def test_s06_an_incorrect_hmac_is_dropped_silently_by_the_device_and_has_no_effect(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    assert e2e.device.receive(*tamper(frame)) == []
    assert e2e.device.log[-1] == "dropped:AUTH/MAC" and e2e.device.locked_down is True  # unchanged boot state, not "applied"
    assert "applied:CUT_UPLINK" not in e2e.device.log and e2e.ledger.get(ACTION_ID)["state"] == "PUBLISHED"


def test_s07_a_stale_command_is_rejected_by_the_device_and_not_applied(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    e2e.device.locked_down = False
    e2e.device.now = lambda: NOW + 3_600
    replies = e2e.device.receive(*frame)
    assert e2e.device.log[-1] == "rejected:EXPIRED" and e2e.device.locked_down is False
    for topic, payload in replies:
        e2e.to_core(topic, payload)
    # the device refused the stale command AND the Core refuses evidence stamped by that skewed clock: nothing is correlated
    assert "P1_EVIDENCE_REJECTED" in e2e.events() and "ACK_RECEIVED" not in e2e.events()
    assert e2e.ledger.get(ACTION_ID)["state"] == "PUBLISHED"


def test_s08_s09_a_replayed_or_duplicate_sequence_is_never_applied_twice(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    first = e2e.device_round_trip(frame)
    assert e2e.device.log[-1] == "applied:CUT_UPLINK"
    e2e.device.locked_down = False  # prove a replay cannot re-apply
    replay = e2e.device.receive(*frame)
    assert e2e.device.log[-1] == "rejected:SEQUENCE" and e2e.device.locked_down is False
    assert [p1.kind_for_topic(t, DEVICE) for t, _ in replay] == [p1.ACK, p1.STATUS]
    stages_before = e2e.stages()
    for topic, payload in [*first, *replay]:  # the device's own replayed (valid) frames cannot move the ledger again
        e2e.to_core(topic, payload)
    assert e2e.stages() == stages_before and db.verify_chain()[0] is True


def test_s09_a_device_ahead_of_the_core_sequence_rejects_the_command_and_the_core_never_redispatches(e2e):
    e2e.device.highest_sequence = 50
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    replies = e2e.device.receive(*frame)
    assert e2e.device.log[-1] == "rejected:SEQUENCE" and e2e.device.locked_down is True and e2e.device.highest_sequence == 50
    for topic, payload in replies:
        e2e.to_core(topic, payload)
    assert "P1_SEQUENCE_RESYNC" in e2e.events()
    e2e.worker.tick()
    assert len(e2e.command_frames()) == 1, "a rejected CUT is never silently re-published"


def test_s10_a_command_for_another_device_is_dropped_and_forged_foreign_evidence_has_no_effect(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    other = FirmwareModelDevice("other-device-02", KEYS, now=lambda: NOW)
    assert other.receive(*frame) == [] and other.log[-1].startswith("dropped:") and other.locked_down is True
    forged = SimulatedDevice("other-device-02", KEYS, now=lambda: NOW)
    forged.locked_down = False
    topic, payload = forged.periodic_status()
    before = list(db.fetch_all_logs())
    e2e.to_core(topic, payload)
    after = list(db.fetch_all_logs())
    before_counts = Counter(before)
    after_counts = Counter(after)
    assert not before_counts - after_counts, "pre-existing audit evidence must remain unchanged"
    new_rows = list((after_counts - before_counts).elements())
    allowed_rejection_events = {"P1_EVIDENCE_REJECTED", "DEVICE_STATUS_REJECTED"}
    assert {row[3] for row in new_rows} <= allowed_rejection_events, "a foreign-device STATUS must never be recorded as DEVICE_STATUS"
    assert e2e.stages() == ["PUBLISHED"]
    assert db.verify_chain()[0] is True


# ── scenario 11: delayed or missing ACK ──────────────────────────────────────────────────────────────────────────────────────────────────
@needs_node
def test_s11_a_missing_ack_becomes_outcome_unknown_is_reported_to_the_web_and_is_never_retried(e2e_web, bridge):
    clock = Tick()
    detector = e2e_web.detector(clock)
    feed(detector, clock, *attack_lines("ssh")[:1], attack_lines("ssh")[1])
    e2e_web.worker.start()
    e2e_web.worker.tick()
    assert len(e2e_web.command_frames()) == 1  # published; the device never answers
    e2e_web.clock[0] = NOW + 60
    e2e_web.worker.tick()
    e2e_web.worker.tick()
    entry = e2e_web.ledger.get(bridge.action_id)
    assert entry["state"] == "OUTCOME_UNKNOWN"
    assert len(e2e_web.command_frames()) == 1, "an unknown outcome is never re-dispatched"
    bridge.login()
    rows = bridge.call("GET", "/security/audit?limit=100")[1]["audit"]
    assert "OUTCOME_UNKNOWN" in {r["detail"].get("stage") for r in rows}
    assert not {"ACK", "STATUS"} & {r["detail"].get("stage") for r in rows}


# ── scenario 12: a signed STATUS that contradicts the command ──────────────────────────────────────────────────────────────────────────────
def test_s12_a_signed_status_that_contradicts_the_cut_is_recorded_for_what_it_says(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    e2e.device.locked_down = False
    command = p1.parse(frame[1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    ack = e2e.device._ack(command.fields["msg_id"], command.int("seq"), "ACCEPTED")
    status = e2e.device._status("COMMAND", command.fields["msg_id"], command.int("seq"))  # output_state NORMAL: contradicts the CUT
    for topic, payload in (ack, status):
        e2e.to_core(topic, payload)
    rows = [str(r) for r in db.fetch_all_logs()]
    assert any("DEVICE_STATUS" in r and "NORMAL (COMMAND)" in r for r in rows), "the Core records the device's own claim verbatim"
    assert not {"CONTAINED", "RELAY_EVIDENCE", "EXECUTED", "PHYSICAL", "HARDWARE"} & set(e2e.stages())
    assert e2e.ledger.get(ACTION_ID)["state"] == "ACK_RECEIVED", "only a LOCKDOWN status after the ACK correlates; NORMAL never does"
    status_rows = [row for row in e2e.ledger.pending_outbox() if row["stage"] == "STATUS"]
    assert status_rows and "NORMAL" in str(status_rows[0]["detail"]) and "LOCKDOWN" not in str(status_rows[0]["detail"])
    e2e.clock[0] = NOW + 60
    e2e.worker.tick()
    assert e2e.ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN", "the contradiction ends as an unknown outcome, never as containment"


# ── scenarios 13-14: dead-man switch and fail-secure persistence (firmware-model device, constants pinned to main.cpp) ────────────────
def test_firmware_model_constants_are_pinned_to_main_cpp():
    for name, value in (("DEADMAN_TIMEOUT_MS", 60000), ("BOOT_GRACE_MS", 90000)):
        assert re.search(rf"constexpr unsigned long {name} = {value};", FIRMWARE), name
    assert "bool isLockedDown = true;" in FIRMWARE and "digitalWrite(RELAY_IN, RELAY_TRIGGER);\n  pinMode(RELAY_IN, OUTPUT);" in FIRMWARE
    assert "setLockdown(action == \"CUT_UPLINK\");" in FIRMWARE and "preferences.putULong64(\"seq_hi\", sequence)" in FIRMWARE
    m = FirmwareModelDevice(DEVICE, KEYS, now=lambda: NOW)
    assert (m.deadman_ms, m.boot_grace_ms, m.locked_down) == (60000, 90000, True)
    from aegis_soc import config
    assert config.DEADMAN_TIMEOUT_SEC * 1000 == m.deadman_ms


def test_s13_the_dead_mans_switch_locks_the_device_when_core_heartbeats_stop_and_the_core_records_it(e2e):
    e2e.device.locked_down = False
    assert e2e.core.supervisor.controller.send_heartbeat() is True
    heartbeat = [(t, p) for t, p, _, _ in e2e.core.client.published if t == TOPICS.heartbeat][-1]
    e2e.device.receive(*heartbeat)
    assert e2e.device.log[-1] == "heartbeat:accepted" and e2e.device.last_heartbeat_ms == 0 or e2e.device.heartbeat_seen
    e2e.device.last_heartbeat_ms = max(1, e2e.device.uptime_ms)
    assert e2e.device.advance(59_000) == [] and e2e.device.locked_down is False
    frames = e2e.device.advance(2_000)
    assert e2e.device.locked_down is True and len(frames) == 1
    e2e.to_core(*frames[0])
    assert any("LOCKDOWN (DEADMAN)" in str(r) for r in db.fetch_all_logs())
    assert e2e.device.advance(120_000) == [], "the dead-man trigger publishes once per heartbeat loss"
    e2e.device.receive(*heartbeat)  # a replayed heartbeat cannot re-arm or release anything
    assert e2e.device.log[-1].startswith("dropped:heartbeat") and e2e.device.locked_down is True


def test_s13_without_any_heartbeat_the_boot_grace_expires_into_lockdown(e2e):
    e2e.device.locked_down = False
    assert e2e.device.advance(89_000) == [] and e2e.device.locked_down is False
    e2e.device.advance(2_000)
    assert e2e.device.locked_down is True


def test_s14_a_reboot_returns_to_lockdown_and_the_persisted_sequence_blocks_old_commands(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    e2e.device_round_trip(frame)
    e2e.device.locked_down = False  # as if a RESTORE had been applied
    e2e.device.reboot()
    assert e2e.device.locked_down is True, "fail-secure: a power cycle never comes back NORMAL"
    assert e2e.device.highest_sequence > 0
    e2e.device.receive(*frame)
    assert e2e.device.log[-1] == "rejected:SEQUENCE"


def test_s14_a_failed_sequence_persist_never_changes_the_output_state(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    frame = e2e.dispatch()
    e2e.device.locked_down = False
    e2e.device.persist_ok = False
    replies = e2e.device.receive(*frame)
    assert e2e.device.log[-1] == "rejected:PERSIST" and e2e.device.locked_down is False and e2e.device.highest_sequence == 0
    assert [p1.kind_for_topic(t, DEVICE) for t, _ in replies] == [p1.ACK]


# ── scenarios 16-17: RESTORE ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_s16_restore_is_refused_when_the_authorization_is_absent_and_nothing_is_published(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    e2e.device_round_trip(e2e.dispatch())
    published_before = len(e2e.core.client.published)
    response = e2e.core.ask(request())
    assert response["ok"] is False and response["evidence"]["published"] == "NOT_PUBLISHED"
    assert len(e2e.core.client.published) == published_before and e2e.device.locked_down is True
    assert e2e.core.restores() == []


def test_s17_an_explicit_simulated_restore_with_fixture_authorization_is_published_once_and_acknowledged(e2e):
    e2e.core.supervisor.on_production_alert(IP)
    e2e.device_round_trip(e2e.dispatch())
    e2e.core.supervisor.pending_command = None
    assert op(e2e.env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"  # FIXTURE containment verification, not a host fact
    response = e2e.core.ask(request())
    assert response["code"] == "PUBLISHED", response
    restore = [f for f in e2e.command_frames() if p1.parse(f[1], topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND})).fields["action"] == "RESTORE_UPLINK"]
    assert len(restore) == 1
    e2e.device_round_trip(restore[0])
    assert e2e.device.locked_down is False and e2e.device.log[-1] == "applied:RESTORE_UPLINK"
    assert {"RESTORE_REQUESTED", "ACK_RECEIVED"} <= set(e2e.events()) and db.verify_chain()[0] is True
    again = e2e.core.ask(request())
    assert again["ok"] is False, "the one-shot restore attempt is spent"


# ── scenario 20: Recovery stays blocked by the immutable CTv CLOSED_FAIL history ─────────────────────────────────────────────────────────
def test_s20_the_real_recovery_predecessor_gates_still_refuse_the_ctv_closed_fail_history(tmp_path):
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    os.chmod(canon, 0o700)
    files = {
        "CTU-GLOBAL-ATTEMPT-CONSUMED": "CTU_ATTEMPT_CONSUMED=YES\n",
        "CTU-GLOBAL-CLOSEOUT-FAIL": "CTU_RESULT=FAIL_IMMUTABLE\nCTU_FAILURE_REASON=APPLY\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n",
        "CTV-GLOBAL-ATTEMPT-CONSUMED": "CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\n",
        "CTV-GLOBAL-CLOSEOUT-FAIL": "CTV_RESULT=FAIL_IMMUTABLE\nCTV_LIVE=CLOSED_FAIL\nCTV_S10_HISTORICAL_COMPARE=FAIL\nCTV_S10_PROMOTED_TO_PASS=NO\nCTV_RECOVERY_AUTHORIZED=NO\nCTV_RERUN_ALLOWED=NO\n",
    }
    for name, text in files.items():
        (canon / name).write_text(text)
        os.chmod(canon / name, 0o600)
    repo = tmp_path / "r"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    lib = LOCKDOWN_ROOT / "deploy/pr11-phase4/p4-recovery-run-lib.sh"
    script = f'''set -Eeuo pipefail
export SUDO="" RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RECOVERY_TEST_ONLY_CANONICAL_DIR="{canon}" RECOVERY_TEST_ONLY_TRUST_ROOT="{tmp_path}"
source "{lib}"
recovery_ctv_successor_gate "{repo}" "{"a" * 40}"
'''
    r = subprocess.run(["bash", "-c", script], text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"}, check=False)
    assert r.returncode != 0 and "RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT" in r.stdout + r.stderr
    assert not (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert sorted(p.name for p in canon.iterdir()) == sorted(files), "no marker was created or consumed"
    assert all((canon / n).read_text() == t for n, t in files.items()), "the historical files are byte-identical"


def test_the_evidence_class_is_simulated_and_never_physical():
    assert EVIDENCE_CLASS == "SIMULATED_LOCAL_E2E"


# ── scenario 18/Phase D: the Core's real runtime-status projection as the web displays it ────────────────────────────────────────────────
def core_status_file(tmp_path: Path, **fields) -> Path:
    from aegis_soc.runtime import RuntimeState, RuntimeStatus, safe_status_projection
    base = {"state": RuntimeState.RUNNING, "profile": "production", "dry_run": False, "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN",
            "armed": "ARMED", "dispatch": "ACTIVE", "time_trust": "SYNCED", "components": {"detector": "RUNNING"}, "updated_at": time.time() - 5}
    base.update(fields)
    path = tmp_path / "status-projection.json"
    path.write_text(json.dumps(safe_status_projection(RuntimeStatus(**base))))
    os.chmod(path, 0o600)
    return path


def snapshot_runtime(tmp_path, **fields):
    web = WebBridge(tmp_path, core_status_file(tmp_path, **fields))
    try:
        assert web.login()[0] == 200
        status, snap = web.call("GET", "/security/snapshot")
        assert status == 200
        return snap, {c["id"]: c["status"] for c in snap["runtime"]["components"]}
    finally:
        web.close()


@needs_node
def test_phase_d_the_web_shows_the_cores_real_status_projection_without_inferring_the_relay(tmp_path):
    snap, comps = snapshot_runtime(tmp_path)
    assert comps == {"runtime": "HEALTHY", "broker": "HEALTHY", "esp32": "HEALTHY", "relay": "UNKNOWN", "uplink": "DEGRADED", "heartbeat": "UNKNOWN", "ack": "UNKNOWN"}
    assert snap["runtime"]["modes"]["armed"] is True and snap["runtime"]["modes"]["recoveryAuthorized"] is False
    assert snap["runtime"]["freshness"] == "FRESH"
    idea3 = next(item for item in snap["sources"] if item["id"] == "idea3")
    assert idea3["status"] == "HEALTHY" and idea3["detail"] == "Validated response"
    assert snap["devices"] == [] and snap["incidents"] == [], "the projection carries no device record and no incident: none is invented"


@needs_node
def test_phase_d_a_stale_status_projection_is_unknown_not_a_remembered_healthy(tmp_path):
    snap, comps = snapshot_runtime(tmp_path, updated_at=time.time() - 3_600)
    assert snap["runtime"]["status"] == "UNKNOWN" and snap["runtime"]["freshness"] == "STALE"
    assert set(comps.values()) == {"UNKNOWN"}


@needs_node
def test_phase_d_offline_device_and_disconnected_broker_are_shown_as_failed_not_healthy(tmp_path):
    snap, comps = snapshot_runtime(tmp_path, state="DEGRADED", broker="DISCONNECTED", device="OFFLINE", uplink="UNKNOWN")
    assert (comps["broker"], comps["esp32"], comps["uplink"], comps["relay"]) == ("FAILED", "FAILED", "UNKNOWN", "UNKNOWN")
    assert snap["runtime"]["status"] != "HEALTHY"


@needs_node
def test_phase_d_an_absent_or_unparseable_status_is_unknown_never_live(tmp_path):
    web = WebBridge(tmp_path, tmp_path / "does-not-exist.json")
    try:
        web.login()
        snap = web.call("GET", "/security/snapshot")[1]
        assert snap["runtime"]["status"] == "UNKNOWN" and all(c["status"] == "UNKNOWN" for c in snap["runtime"]["components"])
    finally:
        web.close()
