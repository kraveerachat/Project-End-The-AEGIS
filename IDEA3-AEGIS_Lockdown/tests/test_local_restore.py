"""D4 Core-local RESTORE: authenticated, confirmed, reasoned, audited, local, never automatic.

The gate runs inside the supervisor, the Core's single command owner. These
tests join a real supervisor, controller, Protocol v1 store, and MQTT adapter;
only the paho client and the operator terminal are fakes. Nothing here touches
a broker, a device, GPIO, or a relay.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import stat
import tempfile
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from aegis_soc import cli, config
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import protocol_v1 as p1
from aegis_soc.controller import RESTORE_UPLINK, AegisCommandController
from aegis_soc.dispatch_worker import ACTIVE, PAUSED_CREDENTIAL
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore
from aegis_soc.runtime import RuntimeSettings
from aegis_soc.supervisor import AegisSupervisor

ROOT = Path(__file__).resolve().parent.parent
DEVICE = "test-device-01"
# Public TEST-ONLY golden-vector keys; Core key loading refuses them.
KEYS = p1.ProtocolKeys(c2d=bytes(range(0x20)), d2c=bytes(range(0x20, 0x40)))
NOW = p1.TIME_FLOOR + 3_600
TOPICS = p1.topics(DEVICE)
SECRET = "correct horse battery staple"
CONFIRM = "RESTORE UPLINK"
REASON = "planned maintenance closed; relay inspected on site"
DROP = object()


class Clock:
    def __init__(self, state="SYNCED"):
        self.current = state

    def state(self):
        return self.current

    def trusted_now(self):
        return NOW if self.current in {"SYNCED", "HOLDOVER"} else None


class FakePahoClient:
    def __init__(self):
        self.published = []
        self.publish_rc = 0

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return SimpleNamespace(rc=self.publish_rc)


class Audit:
    """Stands in for the hash-chained Core audit; the strict writer can be made to fail."""

    def __init__(self, client):
        self.client = client
        self.events = []
        self.strict = []
        self.fail_strict = False

    def log(self, event_type, details, level="INFO", *_args, **_kwargs):
        self.events.append((event_type, details, level))

    def append(self, event_type, details, level="INFO", *_args, **_kwargs):
        if self.fail_strict:
            raise OSError("audit disk full")
        # How many frames were already published when the durable row committed.
        self.strict.append((event_type, details, level, len(self.client.published)))

    def refusals(self):
        return [details for event, details, _ in self.events if event == "RESTORE_REFUSED"]


class FakeWorker:
    """A dispatch worker whose credential state can flap (certificate expiry and recovery)."""

    def __init__(self):
        self.status = ACTIVE

    def tick(self):
        pass

    def on_ack(self, *_args):
        pass

    def on_status(self, *_args):
        pass


class Core:
    def __init__(self, tmp_path, *, credential, clock=None, profile="development", store_path=None):
        self.clock = clock or Clock()
        self.store = ProtocolStore(store_path or tmp_path / "data" / "core-protocol.sqlite3", wall_clock=lambda: NOW)
        self.context = ProtocolContext(DEVICE, KEYS, self.store, self.clock)
        self.client = FakePahoClient()
        self.mqtt = MQTTManager(protocol=self.context, client_factory=lambda: self.client, protocol_mode="v1")
        self.mqtt.is_connected = True
        base = RuntimeSettings.from_profile(profile, dry_run=False, start_detector=False, start_gui=False)
        # AF_UNIX paths are short; pytest's tmp_path can exceed the 108-byte limit.
        self.runtime_dir = Path(tempfile.mkdtemp(prefix="aegis-d4-"))
        self.settings = replace(base, runtime_dir=self.runtime_dir, log_dir=tmp_path / "logs")
        self.now = [1000.0]
        self.supervisor = AegisSupervisor(
            self.settings,
            mqtt_manager=self.mqtt,
            protocol=self.context,
            dispatch_worker=None,
            monotonic=lambda: self.now[0],
            restore_credential=credential,
        )
        self.supervisor.bind_callbacks()
        self.supervisor.status.uplink = "LOCKDOWN"
        self.audit = Audit(self.client)
        self.gate = (
            lr.LocalRestoreGate(
                self.supervisor,
                credential,
                allowed_uid=os.geteuid(),
                audit=self.audit.log,
                audit_strict=self.audit.append,
                monotonic=lambda: self.now[0],
            )
            if credential is not None
            else None
        )
        self.peer = lr.Peer(uid=os.geteuid(), pid=4242)

    @property
    def channel_path(self):
        return self.runtime_dir / lr.CHANNEL_NAME

    def ask(self, request):
        return self.gate.handle(request, self.peer)

    def frames(self, kind):
        return [payload for topic, payload, _, _ in self.client.published if topic == TOPICS.for_kind(kind)]

    def commands(self):
        return [
            p1.parse(raw, topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
            for raw in self.frames(p1.COMMAND)
        ]

    def restores(self):
        return [command for command in self.commands() if command.fields["action"] == RESTORE_UPLINK]

    def deliver(self, kind, **fields):
        base = {"msg_id": p1.new_msg_id(), "device_time": NOW - 1}
        if kind == p1.STATUS:
            base.update(time_trust="SYNCED", output_state="LOCKDOWN", reason="PERIODIC", cmd_msg_id="", cmd_seq=0,
                        device_seq_hwm=0, rssi_dbm=-55, heap_free=100000)
        base.update(fields)
        topic, raw = p1.encode(kind, device_id=DEVICE, fields=base, keys=KEYS)
        self.mqtt._on_message(None, None, SimpleNamespace(topic=topic, payload=raw, retain=False))

    def close(self):
        self.supervisor.stop_local_restore()
        self.store.close()
        shutil.rmtree(self.runtime_dir, ignore_errors=True)


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


@pytest.fixture
def core(tmp_path, credential):
    instance = Core(tmp_path, credential=credential)
    yield instance
    instance.close()


def request(**changes):
    body = lr.restore_request(SECRET, CONFIRM, REASON)
    for key, value in changes.items():
        if value is DROP:
            body.pop(key)
        else:
            body[key] = value
    return body


def assert_refused(core, response, code):
    assert response["ok"] is False
    assert response["code"] == code
    assert response["msg_id"] is None
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert response["evidence"]["physical_evidence"] == "NOT_PROVEN"
    assert core.commands() == []
    assert core.audit.strict == []
    assert core.store.last_allocated_seq(DEVICE) == 0
    assert any(f"code={code}" in details for details in core.audit.refusals())
    assert SECRET not in json.dumps([core.audit.events, response])


# --------------------------------------------------------------------------- credential


def test_a_hashed_credential_verifies_only_its_own_secret(credential):
    assert credential.verify(SECRET) is True
    assert credential.verify(SECRET + " ") is False
    assert credential.verify("") is False


def test_hashing_refuses_a_short_secret():
    with pytest.raises(ValueError):
        lr.hash_secret("short", n=lr.SCRYPT_MIN_N)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "plain-sha256-hex",
        "scrypt$1024$8$1$" + "00" * 16 + "$" + "00" * 32,  # n below the floor
        "scrypt$16385$8$1$" + "00" * 16 + "$" + "00" * 32,  # n not a power of two
        "scrypt$16384$8$1$" + "00" * 4 + "$" + "00" * 32,  # salt too short
        "scrypt$16384$8$1$" + "00" * 16 + "$" + "00" * 8,  # digest too short
        "pbkdf2$16384$8$1$" + "00" * 16 + "$" + "00" * 32,
    ],
)
def test_malformed_or_weak_credentials_are_refused(text):
    with pytest.raises(lr.CredentialError):
        lr.RestoreCredential.parse(text)


def test_the_credential_file_must_be_private(tmp_path):
    path = tmp_path / "restore.credential"
    path.write_text(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N) + "\n", encoding="ascii")
    path.chmod(0o644)
    with pytest.raises(lr.CredentialError):
        lr.RestoreCredential.load(path)
    path.chmod(0o600)
    assert lr.RestoreCredential.load(path).verify(SECRET) is True


def test_a_symlinked_credential_file_is_refused(tmp_path):
    target = tmp_path / "real.credential"
    target.write_text(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N) + "\n", encoding="ascii")
    target.chmod(0o600)
    link = tmp_path / "restore.credential"
    link.symlink_to(target)
    with pytest.raises(lr.CredentialError):
        lr.RestoreCredential.load(link)


def test_credential_provisioning_completes_short_os_writes(tmp_path, monkeypatch):
    path = tmp_path / "private" / "restore.credential"
    write = lr.os.write
    monkeypatch.setattr(lr.os, "write", lambda descriptor, data: write(descriptor, data[:7]))

    lr.write_credential(path, SECRET)

    assert lr.RestoreCredential.load(path).verify(SECRET) is True


def test_credential_provisioning_fsyncs_file_and_parent_directory(tmp_path, monkeypatch):
    path = tmp_path / "private" / "restore.credential"
    fsync = lr.os.fsync
    synced = []

    def record(descriptor):
        synced.append(stat.S_IFMT(os.fstat(descriptor).st_mode))
        fsync(descriptor)

    monkeypatch.setattr(lr.os, "fsync", record)
    lr.write_credential(path, SECRET)

    assert synced == [stat.S_IFREG, stat.S_IFDIR]


# --------------------------------------------------------------------------- reason


@pytest.mark.parametrize("reason", [None, "", "   ", "\t\n", 42])
def test_a_missing_or_blank_reason_is_required(reason):
    assert lr.reason_problem(reason) == "REASON_REQUIRED"


@pytest.mark.parametrize(
    "reason",
    [
        "short",
        "x" * (lr.REASON_MAX_CHARS + 1),
        "line one\nline two injected",
        "colour \x1b[31mred\x1b[0m escape",
        "bidi override \u202e txt.exe",
        "null byte \x00 inside reason",
    ],
)
def test_an_overlong_or_unsafe_reason_is_invalid(reason):
    assert lr.reason_problem(reason) == "REASON_INVALID"


def test_a_unicode_surrogate_reason_is_invalid_instead_of_raising():
    reason = "valid maintenance reason " + chr(0xD800) + " rejected"
    assert lr.reason_problem(reason) == "REASON_INVALID"


@pytest.mark.parametrize("reason", [REASON, "ปิดงานบำรุงรักษาแล้ว ตรวจรีเลย์หน้างาน", "  padded but valid reason  "])
def test_a_printable_bounded_reason_is_accepted(reason):
    assert lr.reason_problem(reason) is None


# --------------------------------------------------------------------------- gate refusals


@pytest.mark.parametrize("secret", [DROP, "", None, 1234])
def test_missing_authentication_is_refused(core, secret):
    assert_refused(core, core.ask(request(secret=secret)), "AUTH_REQUIRED")


def test_invalid_authentication_is_refused(core):
    assert_refused(core, core.ask(request(secret="not the operator secret")), "AUTH_FAILED")


def test_repeated_authentication_failures_lock_the_gate_out(core):
    for _ in range(lr.MAX_AUTH_FAILURES):
        assert core.ask(request(secret="guess guess guess"))["code"] == "AUTH_FAILED"
    assert core.ask(request())["code"] == "AUTH_LOCKED_OUT"
    assert any(event == "RESTORE_AUTH_LOCKOUT" for event, _, _ in core.audit.events)
    assert core.commands() == []

    core.now[0] += lr.AUTH_LOCKOUT_SEC + 1
    assert core.ask(request())["code"] == "PUBLISHED"


@pytest.mark.parametrize("confirmation", [DROP, "", None])
def test_missing_confirmation_is_refused(core, confirmation):
    assert_refused(core, core.ask(request(confirmation=confirmation)), "CONFIRMATION_REQUIRED")


@pytest.mark.parametrize("confirmation", ["restore uplink", "RESTORE", "yes", "CONFIRM", "RESTORE UPLINK "])
def test_wrong_confirmation_is_refused(core, confirmation):
    assert_refused(core, core.ask(request(confirmation=confirmation)), "CONFIRMATION_MISMATCH")


@pytest.mark.parametrize("reason", [DROP, "", "     "])
def test_missing_reason_is_refused(core, reason):
    assert_refused(core, core.ask(request(reason=reason)), "REASON_REQUIRED")


@pytest.mark.parametrize("reason", ["x" * 500, "ok reason\nwith newline", "reason \x1b[2J clears screen"])
def test_overlong_or_unsafe_reason_is_refused(core, reason):
    assert_refused(core, core.ask(request(reason=reason)), "REASON_INVALID")


@pytest.mark.parametrize(
    "origin", [DROP, "web", "browser", "server-dispatch", "telegram", "gui", "recovery-wizard", "aegisctl-local", ""],
)
def test_a_non_local_or_unknown_origin_is_refused(core, origin):
    assert_refused(core, core.ask(request(origin=origin)), "ORIGIN_REFUSED")


def test_a_peer_that_is_not_the_core_account_is_refused(core):
    response = core.gate.handle(request(), lr.Peer(uid=os.geteuid() + 1, pid=1))
    assert_refused(core, response, "PEER_REFUSED")


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        "RESTORE_UPLINK",
        {"op": "RESTORE_UPLINK"},
        request(v=2),
        request(op="CUT_UPLINK"),
        request(op="restore"),
        request(extra="field"),
    ],
)
def test_a_malformed_request_is_refused(core, body):
    assert_refused(core, core.ask(body), "MALFORMED_REQUEST")


@pytest.mark.parametrize("uplink", ["NORMAL", "UNKNOWN"])
def test_restore_needs_an_observed_lockdown(core, uplink):
    core.supervisor.status.uplink = uplink
    assert_refused(core, core.ask(request()), "UPLINK_NOT_LOCKDOWN")


def test_restore_is_refused_while_a_cut_awaits_its_ack(core):
    cut = core.supervisor.issue_command("CUT_UPLINK", "operator cut", critical=True, origin="gui")
    assert cut.sent is True
    response = core.ask(request())
    assert (response["ok"], response["code"]) == (False, "COMMAND_PENDING")
    assert core.restores() == []
    assert core.audit.strict == []


# --------------------------------------------------------------------------- actuation boundary


def test_an_authorized_local_restore_publishes_one_signed_command_after_a_durable_audit(core):
    response = core.ask(request())

    assert (response["ok"], response["code"]) == (True, "PUBLISHED")
    [command] = core.commands()
    assert command.fields["action"] == RESTORE_UPLINK
    assert p1.verify(command, KEYS) is True
    assert response["msg_id"] == command.fields["msg_id"]
    assert response["seq"] == command.int("seq")
    # The durable audit row committed while nothing had been published.
    [(event, details, level, published_before)] = core.audit.strict
    assert (event, level, published_before) == ("RESTORE_REQUESTED", "CRITICAL", 0)
    assert REASON in details and f"uid={os.geteuid()}" in details and "pid=4242" in details
    assert SECRET not in json.dumps([core.audit.events, core.audit.strict, response])


def test_success_reports_the_evidence_ladder_without_promotion(core):
    evidence = core.ask(request())["evidence"]
    assert evidence == {
        "requested": "ACCEPTED",
        "published": "PUBLISHED",
        "ack": "PENDING",
        "executed": "NOT_OBSERVED",
        "relay_confirmation": "NOT_AVAILABLE",
        "physical_evidence": "NOT_PROVEN",
    }


def test_an_audit_failure_fails_closed_before_any_actuation(core):
    core.audit.fail_strict = True
    response = core.ask(request())
    assert (response["ok"], response["code"]) == (False, "AUDIT_UNAVAILABLE")
    assert core.client.published == []
    assert core.store.last_allocated_seq(DEVICE) == 0
    assert response["evidence"]["published"] == "NOT_PUBLISHED"


def test_a_transport_failure_never_claims_success_and_is_not_retried(core):
    core.client.publish_rc = 4
    response = core.ask(request())
    assert (response["ok"], response["code"]) == (False, "MQTT_UNAVAILABLE")
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert response["evidence"]["ack"] == "NOT_APPLICABLE"
    # Exactly one attempt reached the client; the gate never re-publishes on its own.
    assert len(core.frames(p1.COMMAND)) == 1
    [attempt] = core.commands()
    assert core.store.command(attempt.fields["msg_id"])["state"] == "NOT_PUBLISHED"
    assert core.supervisor.pending_command is None


def test_a_post_publish_store_failure_remains_outcome_unknown(core, monkeypatch):
    def fail_after_publish(_msg_id):
        raise OSError("protocol disk full")

    monkeypatch.setattr(core.store, "mark_published", fail_after_publish)
    published = core.ask(request())
    assert (published["ok"], published["code"]) == (True, "PUBLISHED")
    assert len(core.restores()) == 1

    evidence = core.ask(lr.evidence_request(published["msg_id"]))["evidence"]
    assert evidence["published"] == "OUTCOME_UNKNOWN"
    assert evidence["ack"] == "OUTCOME_UNKNOWN"
    assert evidence["physical_evidence"] == "NOT_PROVEN"


def test_a_disconnected_broker_is_reported_as_not_published(core):
    core.mqtt.is_connected = False
    response = core.ask(request())
    assert response["ok"] is False
    assert response["evidence"]["published"] == "NOT_PUBLISHED"


def test_untrusted_core_time_publishes_nothing(tmp_path, credential):
    core = Core(tmp_path, credential=credential, clock=Clock("UNTRUSTED"))
    try:
        response = core.ask(request())
        assert (response["ok"], response["code"]) == (False, "CORE_TIME_UNTRUSTED")
        assert core.client.published == []
    finally:
        core.close()


def test_dry_run_is_never_reported_as_published(tmp_path, credential):
    core = Core(tmp_path, credential=credential)
    try:
        core.supervisor.controller.dry_run = True
        response = core.ask(request())
        assert (response["ok"], response["code"]) == (False, "DRY_RUN")
        assert response["evidence"]["published"] == "DRY_RUN"
        assert core.client.published == []
    finally:
        core.close()


def test_duplicate_invocations_are_deterministic_and_audited(core):
    first = core.ask(request())
    assert first["code"] == "PUBLISHED"
    msg_id, seq = first["msg_id"], first["seq"]

    assert core.ask(request())["code"] == "COMMAND_PENDING"
    core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    assert core.ask(request())["code"] == "RESTORE_ALREADY_PENDING"
    core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq,
                 device_seq_hwm=seq)
    assert core.ask(request())["code"] == "UPLINK_NOT_LOCKDOWN"

    assert len(core.restores()) == 1
    assert [event for event, *_ in core.audit.strict] == ["RESTORE_REQUESTED"]
    codes = core.audit.refusals()
    assert [c.split()[0] for c in codes] == [
        "code=COMMAND_PENDING", "code=RESTORE_ALREADY_PENDING", "code=UPLINK_NOT_LOCKDOWN",
    ]


def test_a_concurrent_cut_cannot_cross_the_local_restore_actuation_boundary(core):
    audit_entered = threading.Event()
    release_audit = threading.Event()
    original_audit = core.gate.audit_strict
    results = {}

    def blocked_audit(*args, **kwargs):
        audit_entered.set()
        assert release_audit.wait(2)
        original_audit(*args, **kwargs)

    core.gate.audit_strict = blocked_audit
    restore_thread = threading.Thread(target=lambda: results.setdefault("restore", core.ask(request())))
    restore_thread.start()
    assert audit_entered.wait(1)

    cut_thread = threading.Thread(
        target=lambda: results.setdefault(
            "cut",
            core.supervisor.issue_command(
                "CUT_UPLINK",
                "concurrent detector containment",
                critical=True,
                origin="supervisor-detector",
            ),
        )
    )
    cut_thread.start()
    assert core.supervisor._containment_pending.wait(1)
    release_audit.set()
    restore_thread.join(2)
    cut_thread.join(2)

    assert results["restore"]["code"] == "CONTAINMENT_PENDING"
    assert results["cut"].sent is True
    assert [command.fields["action"] for command in core.commands()] == ["CUT_UPLINK"]


def test_detector_cut_queues_behind_a_restore_that_already_crossed_publish(core):
    restore = core.ask(request())
    queued = core.supervisor.issue_command(
        "CUT_UPLINK",
        "detector containment after restore publish",
        critical=True,
        origin="supervisor-detector",
    )

    assert (queued.ok, queued.sent, queued.reason_code) == (True, False, "CUT_QUEUED")
    assert [command.fields["action"] for command in core.commands()] == [RESTORE_UPLINK]

    core.deliver(
        p1.ACK,
        ack_for_msg_id=restore["msg_id"],
        ack_for_seq=restore["seq"],
        result="ACCEPTED",
    )
    assert [command.fields["action"] for command in core.commands()] == [RESTORE_UPLINK, "CUT_UPLINK"]


def test_after_an_ack_timeout_only_a_new_explicit_request_can_restore(core):
    first = core.ask(request())
    core.now[0] += config.ACK_TIMEOUT_SEC + 1
    core.supervisor.evaluate_state()
    assert core.supervisor.pending_command is None
    assert len(core.restores()) == 1  # nothing was re-sent by the timeout

    second = core.ask(request())
    assert second["code"] == "PUBLISHED"
    assert second["seq"] == first["seq"] + 1
    assert [event for event, *_ in core.audit.strict] == ["RESTORE_REQUESTED", "RESTORE_REQUESTED"]


def test_the_evidence_query_follows_the_ladder_one_rung_at_a_time(core):
    published = core.ask(request())
    msg_id, seq = published["msg_id"], published["seq"]

    def ladder():
        response = core.ask(lr.evidence_request(msg_id))
        assert (response["ok"], response["code"]) == (True, "EVIDENCE")
        return response["evidence"]

    assert ladder()["ack"] == "PENDING"
    core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    assert (ladder()["ack"], ladder()["executed"]) == ("ACCEPTED", "NOT_OBSERVED")
    core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq,
                 device_seq_hwm=seq)
    final = ladder()
    assert final["executed"] == "DEVICE_REPORTED_NORMAL"
    # Device protocol evidence never becomes relay or physical evidence.
    assert final["relay_confirmation"] == "NOT_AVAILABLE"
    assert final["physical_evidence"] == "NOT_PROVEN"
    assert len(core.commands()) == 1


def test_a_contradicting_device_report_is_shown_not_hidden(core):
    published = core.ask(request())
    msg_id, seq = published["msg_id"], published["seq"]
    core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="REJECTED_EXPIRED")
    evidence = core.ask(lr.evidence_request(msg_id))["evidence"]
    assert evidence["ack"] == "REJECTED_EXPIRED"
    assert evidence["physical_evidence"] == "NOT_PROVEN"


def test_a_correlated_lockdown_status_is_never_labeled_as_executed_restore(core):
    published = core.ask(request())
    msg_id, seq = published["msg_id"], published["seq"]
    core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    core.deliver(
        p1.STATUS,
        output_state="LOCKDOWN",
        reason="COMMAND",
        cmd_msg_id=msg_id,
        cmd_seq=seq,
        device_seq_hwm=seq,
    )

    evidence = core.ask(lr.evidence_request(msg_id))["evidence"]
    assert evidence["executed"] == "DEVICE_REPORTED_LOCKDOWN"
    assert evidence["relay_confirmation"] == "NOT_AVAILABLE"
    assert evidence["physical_evidence"] == "NOT_PROVEN"


def test_the_evidence_query_is_read_only_and_restore_scoped(core):
    cut = core.supervisor.issue_command("CUT_UPLINK", "operator cut", critical=True, origin="gui")
    for msg_id in (cut.nonce, "ab" * 16, "not-hex", None):
        response = core.ask(lr.evidence_request(msg_id))
        assert response["ok"] is False
        assert response["code"] in {"UNKNOWN_COMMAND", "MALFORMED_REQUEST"}
    refused = core.gate.handle(lr.evidence_request("ab" * 16), lr.Peer(uid=os.geteuid() + 1, pid=1))
    assert refused["code"] == "PEER_REFUSED"
    assert core.restores() == []


# --------------------------------------------------------------------------- authority wiring


def test_without_a_credential_the_core_has_no_restore_authority_and_no_channel(tmp_path):
    core = Core(tmp_path, credential=None)
    try:
        assert core.supervisor.controller.restore_origins == frozenset()
        core.supervisor.start_local_restore()
        assert not core.channel_path.exists()
        assert core.supervisor.local_restore is None
    finally:
        core.close()


def test_an_unsafe_configured_credential_fails_controlled_preflight_not_construction(tmp_path, monkeypatch):
    unsafe = tmp_path / "restore.credential"
    unsafe.write_text("not-a-credential\n", encoding="ascii")
    unsafe.chmod(0o600)
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", str(unsafe))
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "audit" / "audit.sqlite3"))
    monkeypatch.setattr(config, "LOG_PATH", str(tmp_path / "logs" / "core.log"))
    settings = replace(
        RuntimeSettings.from_profile("development", dry_run=True, start_detector=False, start_gui=False),
        runtime_dir=tmp_path / "runtime",
        log_dir=tmp_path / "logs",
    )
    mqtt = SimpleNamespace(stop=lambda: None)

    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt, protocol=None, dispatch_worker=None)
    assert supervisor.restore_credential is None
    assert supervisor.run() == 2
    status = json.loads(settings.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "FAILED"
    assert "credential is unsafe" in status["detail"]


def test_an_unsupported_platform_leaves_restore_unavailable(tmp_path, credential, monkeypatch):
    monkeypatch.setattr(lr, "local_restore_supported", lambda platform=None: False)
    core = Core(tmp_path, credential=credential)
    try:
        assert core.supervisor.controller.restore_origins == frozenset()
        core.supervisor.start_local_restore()
        assert not core.channel_path.exists()
    finally:
        core.close()


@pytest.mark.parametrize(
    "origin",
    ["web", "browser", "server-dispatch", "telegram", "gui", "recovery-wizard", "supervisor-detector",
     "unknown", "aegisctl", "mqtt-reconnect", "startup"],
)
def test_with_d4_enabled_no_other_origin_holds_restore_authority(core, origin):
    assert core.supervisor.controller.restore_origins == frozenset({lr.CONTROLLER_ORIGIN})
    result = core.supervisor.issue_command(RESTORE_UPLINK, "not D4", critical=True, origin=origin,
                                           authorize_restore=True)
    assert (result.sent, result.reason_code) == (False, "RESTORE_ORIGIN_REFUSED")
    assert core.restores() == []


def test_production_holds_only_the_d4_origin_and_still_refuses_caller_origins(tmp_path, credential):
    core = Core(tmp_path, credential=credential, profile="production")
    try:
        assert core.supervisor.controller.restore_origins == frozenset({lr.CONTROLLER_ORIGIN})
        with pytest.raises(ValueError):
            AegisSupervisor(core.settings, mqtt_manager=core.mqtt, protocol=core.context, dispatch_worker=None,
                            restore_origins=frozenset({"gui"}), restore_credential=credential)
    finally:
        core.close()


def test_telegram_can_never_join_the_restore_allowlist_even_with_d4():
    with pytest.raises(ValueError):
        AegisCommandController(object(), restore_origins=frozenset({lr.CONTROLLER_ORIGIN, "telegram"}))


def test_no_lifecycle_or_evidence_event_ever_restores_with_d4_enabled(tmp_path, credential):
    core = Core(tmp_path, credential=credential, clock=Clock("UNTRUSTED"))
    sup = core.supervisor
    sup.dispatch_worker = FakeWorker()
    try:
        sup.start_local_restore()  # the channel is open and waiting
        sup._on_connection(False)  # MQTT disconnect
        sup._on_connection(True)  # MQTT reconnect
        assert sup.controller.send_heartbeat() is False  # untrusted time: no heartbeat
        core.clock.current = "SYNCED"  # time recovery
        assert sup.controller.send_heartbeat() is True  # heartbeat
        sup.dispatch_worker.status = PAUSED_CREDENTIAL  # certificate expiry
        sup._tick_dispatch()
        sup.dispatch_worker.status = ACTIVE  # certificate recovery
        sup._tick_dispatch()
        core.deliver(p1.STATUS, output_state="LOCKDOWN", reason="BOOT")  # ESP32 restart
        core.deliver(p1.STATUS, output_state="LOCKDOWN", reason="PERIODIC")  # heartbeat-era status
        core.deliver(p1.ACK, ack_for_msg_id=p1.new_msg_id(), ack_for_seq=7, result="ACCEPTED")  # stray ACK
        cut = sup.issue_command("CUT_UPLINK", "operator cut", critical=True, origin="gui")
        core.deliver(p1.ACK, ack_for_msg_id=cut.nonce, ack_for_seq=cut.seq, result="ACCEPTED")
        core.deliver(p1.STATUS, output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=cut.nonce,
                     cmd_seq=cut.seq, device_seq_hwm=cut.seq)
        sup.evaluate_state()
        sup.recover_protocol_state()  # Core restart recovery
        sup.stop_local_restore()  # process shutdown
        restarted = AegisSupervisor(core.settings, mqtt_manager=core.mqtt, protocol=core.context,
                                    dispatch_worker=None, restore_credential=credential)
        restarted.recover_protocol_state()  # Core startup
        restarted.start_local_restore()
        restarted.stop_local_restore()

        assert core.restores() == []
        assert all(b"RESTORE_UPLINK" not in payload for _, payload, _, _ in core.client.published)
        assert [command.fields["action"] for command in core.commands()] == ["CUT_UPLINK"]
    finally:
        core.close()


def test_supervisor_run_opens_and_closes_the_channel_without_restoring(tmp_path, credential, monkeypatch):
    core = Core(tmp_path, credential=credential)
    sup = core.supervisor
    seen = []
    original = sup.start_local_restore

    def start_and_stop():
        original()
        seen.append(core.channel_path.exists())
        sup._request_stop()

    monkeypatch.setattr(sup, "start_local_restore", start_and_stop)
    monkeypatch.setattr(sup.mqtt, "start", lambda: None)
    monkeypatch.setattr(sup.mqtt, "stop", lambda: None)
    try:
        sup.run()
        assert seen == [True]
        assert not core.channel_path.exists()
        assert core.restores() == []
    finally:
        core.close()


# --------------------------------------------------------------------------- local channel


def _start(core):
    db.init_db()
    core.supervisor.start_local_restore()
    assert core.supervisor.local_restore is not None
    return core.channel_path


def test_the_channel_is_a_private_unix_socket_with_a_durable_audit_before_publish(core):
    path = _start(core)
    mode = path.stat().st_mode
    assert stat.S_ISSOCK(mode) and stat.S_IMODE(mode) == 0o600
    assert core.supervisor.local_restore.family == socket.AF_UNIX

    response = lr.send_request(path, request())
    assert response["code"] == "PUBLISHED"
    assert [command.fields["action"] for command in core.commands()] == [RESTORE_UPLINK]

    rows = db.fetch_all_logs()  # newest first
    requested = next(row for row in rows if row[3] == "RESTORE_REQUESTED")
    sent = next(row for row in rows if row[3] == "COMMAND_SENT" and "aegisctl-local" in row[4])
    assert requested[0] < sent[0]
    assert all(SECRET not in str(row) for row in rows)
    assert db.verify_chain()[0] is True

    evidence = lr.send_request(path, lr.evidence_request(response["msg_id"]))
    assert evidence["evidence"]["ack"] == "PENDING"


def test_the_channel_refuses_a_peer_outside_the_core_account(core, credential):
    path = core.runtime_dir / "other.sock"
    gate = lr.LocalRestoreGate(core.supervisor, credential, allowed_uid=os.geteuid() + 1,
                               audit=core.audit.log, audit_strict=core.audit.append)
    server = lr.LocalRestoreServer(path, gate)
    server.start()
    try:
        assert lr.send_request(path, request())["code"] == "PEER_REFUSED"
        assert core.commands() == []
    finally:
        server.close()


@pytest.mark.parametrize("raw", [b"x" * (lr.MAX_MESSAGE_BYTES + 10) + b"\n", b"{not json}\n", b"[1, 2]\n"])
def test_the_channel_refuses_oversized_or_malformed_messages(core, raw):
    path = _start(core)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(raw)
        reply = client.makefile("rb").readline()
    assert json.loads(reply)["code"] == "MALFORMED_REQUEST"
    assert core.commands() == []


def test_the_channel_refuses_a_surrogate_reason_and_remains_available(core):
    path = _start(core)
    hostile = request(reason="valid maintenance reason " + chr(0xD800) + " rejected")
    raw = json.dumps(hostile, ensure_ascii=True).encode("ascii") + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(raw)
        reply = client.makefile("rb").readline()

    assert json.loads(reply)["code"] == "REASON_INVALID"
    assert lr.send_request(path, lr.evidence_request("ab" * 16))["code"] == "UNKNOWN_COMMAND"
    assert core.commands() == []


def test_the_channel_contains_an_unexpected_handler_error_and_remains_available(core):
    path = _start(core)
    server_gate = core.supervisor.local_restore.gate
    original = server_gate.handle
    calls = [0]

    def fail_once(body, peer):
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("unexpected gate failure")
        return original(body, peer)

    server_gate.handle = fail_once
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall(json.dumps(request()).encode("utf-8") + b"\n")
        reply = client.makefile("rb").readline()

    failure = json.loads(reply)
    assert failure["code"] == "OUTCOME_UNKNOWN"
    assert failure["evidence"]["published"] == "OUTCOME_UNKNOWN"
    assert failure["evidence"]["ack"] == "OUTCOME_UNKNOWN"
    assert lr.send_request(path, lr.evidence_request("ab" * 16))["code"] == "UNKNOWN_COMMAND"
    assert core.commands() == []


def test_the_channel_never_replaces_a_non_socket_file(core, credential):
    path = core.runtime_dir / "occupied.sock"
    path.write_text("operator data", encoding="utf-8")
    server = lr.LocalRestoreServer(path, core.gate)
    with pytest.raises(lr.LocalRestoreError):
        server.start()
    assert path.read_text(encoding="utf-8") == "operator data"


def test_the_channel_rejects_a_group_or_world_writable_runtime_directory(core):
    path = core.runtime_dir / "unsafe.sock"
    core.runtime_dir.chmod(0o777)
    server = lr.LocalRestoreServer(path, core.gate)
    try:
        with pytest.raises(lr.LocalRestoreError, match="runtime directory"):
            server.start()
    finally:
        core.runtime_dir.chmod(0o700)


def test_the_channel_rejects_a_runtime_directory_not_owned_by_core(core, monkeypatch):
    path = core.runtime_dir / "wrong-owner.sock"
    current_uid = os.geteuid()
    monkeypatch.setattr(lr.os, "geteuid", lambda: current_uid + 1)
    server = lr.LocalRestoreServer(path, core.gate)
    with pytest.raises(lr.LocalRestoreError, match="runtime directory"):
        server.start()


def test_the_channel_replaces_only_a_stale_socket(core):
    path = core.runtime_dir / "stale.sock"
    stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stale.bind(str(path))
    stale.close()
    server = lr.LocalRestoreServer(path, core.gate)
    server.start()
    try:
        assert lr.send_request(path, lr.evidence_request("ab" * 16))["code"] == "UNKNOWN_COMMAND"
    finally:
        server.close()
    assert not path.exists()


def test_the_client_reports_an_unreachable_channel_as_not_sent(tmp_path):
    with pytest.raises(lr.ChannelUnavailable):
        lr.send_request(Path(tempfile.gettempdir()) / "aegis-d4-missing.sock", request())


def test_the_client_reports_a_lost_answer_as_outcome_unknown():
    directory = Path(tempfile.mkdtemp(prefix="aegis-d4-"))
    path = directory / "silent.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)

    def swallow():
        connection, _ = listener.accept()
        connection.recv(65536)
        connection.close()

    thread = threading.Thread(target=swallow, daemon=True)
    thread.start()
    try:
        with pytest.raises(lr.OutcomeUnknown):
            lr.send_request(path, request(), timeout=5)
    finally:
        thread.join(5)
        listener.close()
        shutil.rmtree(directory, ignore_errors=True)


def test_the_client_authenticates_the_core_uid_before_sending_the_secret(monkeypatch):
    directory = Path(tempfile.mkdtemp(prefix="aegis-d4-"))
    path = directory / "impostor.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)
    received = []

    def capture():
        connection, _ = listener.accept()
        received.append(connection.recv(65536))
        connection.close()

    thread = threading.Thread(target=capture, daemon=True)
    thread.start()
    monkeypatch.setattr(lr, "_peer_from", lambda _socket: lr.Peer(uid=os.geteuid() + 1, pid=999))
    try:
        with pytest.raises(lr.ChannelUnavailable, match="Core account"):
            lr.send_request(path, request(), timeout=5)
    finally:
        thread.join(5)
        listener.close()
        shutil.rmtree(directory, ignore_errors=True)
    assert received == [b""]


def test_closing_the_channel_cancels_an_incomplete_client_before_returning(core):
    path = _start(core)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(path))
    client.sendall(b'{"v":1')
    closed = threading.Event()

    thread = threading.Thread(target=lambda: (core.supervisor.stop_local_restore(), closed.set()), daemon=True)
    thread.start()
    try:
        assert closed.wait(1), "channel shutdown left an accepted request handler running"
        assert core.restores() == []
    finally:
        client.close()
        thread.join(6)


# --------------------------------------------------------------------------- aegisctl


class FakeChannel:
    def __init__(self, *responses):
        self.calls = []
        self.responses = list(responses)

    def __call__(self, path, body, *, timeout=None):
        self.calls.append((Path(path), body))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _ladder(**changes):
    evidence = {
        "requested": "ACCEPTED", "published": "PUBLISHED", "ack": "PENDING", "executed": "NOT_OBSERVED",
        "relay_confirmation": "NOT_AVAILABLE", "physical_evidence": "NOT_PROVEN",
    }
    evidence.update(changes)
    return evidence


def _published(**changes):
    return {"v": 1, "ok": True, "code": "PUBLISHED", "detail": "published", "msg_id": "ab" * 16, "seq": 3,
            "evidence": _ladder(**changes)}


def _evidence(**changes):
    return {"v": 1, "ok": True, "code": "EVIDENCE", "detail": "", "msg_id": "ab" * 16, "seq": 3,
            "evidence": _ladder(**changes)}


class Terminal:
    def __init__(self, *, tty=True, secret=SECRET, typed=CONFIRM):
        self.tty = tty
        self.secrets = [secret] if isinstance(secret, str) else list(secret)
        self.typed = typed
        self.clock = [0.0]

    def isatty(self):
        return self.tty

    def read_secret(self, _prompt=""):
        return self.secrets.pop(0)

    def read_line(self, _prompt=""):
        return self.typed

    def sleep(self, seconds):
        self.clock[0] += seconds

    def monotonic(self):
        return self.clock[0]


def run_restore(argv, terminal, channel):
    args = cli.build_parser().parse_args(["restore", *argv])
    return cli.command_restore(
        args,
        isatty=terminal.isatty,
        read_secret=terminal.read_secret,
        read_line=terminal.read_line,
        send=channel,
        sleep=terminal.sleep,
        monotonic=terminal.monotonic,
    )


def test_aegisctl_restore_publishes_and_prints_the_whole_ladder(monkeypatch, capsys):
    runtime = Path(tempfile.gettempdir()) / "aegis-d4-cli-runtime"
    monkeypatch.setenv("AEGIS_RUNTIME_DIR", str(runtime))
    channel = FakeChannel(_published())
    assert run_restore(["--reason", REASON, "--wait", "0"], Terminal(), channel) == 0

    [(path, body)] = channel.calls
    assert path == runtime / lr.CHANNEL_NAME
    assert body == lr.restore_request(SECRET, CONFIRM, REASON)
    output = capsys.readouterr().out
    for rung in ("requested", "published", "ack", "executed", "relay_confirmation", "physical_evidence"):
        assert rung in output
    assert "NOT_PROVEN" in output
    assert "not physical evidence" in output.lower()
    assert SECRET not in output


def test_aegisctl_restore_refuses_a_non_interactive_invocation():
    channel = FakeChannel()
    assert run_restore(["--reason", REASON], Terminal(tty=False), channel) == 2
    assert channel.calls == []


@pytest.mark.parametrize("argv", [[], ["--reason", ""], ["--reason", "   "], ["--reason", "bad\x1b[2Jreason"]])
def test_aegisctl_restore_requires_a_valid_reason_before_asking_anything(argv):
    channel = FakeChannel()
    assert run_restore(argv, Terminal(), channel) == 2
    assert channel.calls == []


def test_aegisctl_restore_requires_a_secret():
    channel = FakeChannel()
    assert run_restore(["--reason", REASON], Terminal(secret=""), channel) == 2
    assert channel.calls == []


@pytest.mark.parametrize("typed", ["", "yes", "restore uplink", "RESTORE"])
def test_aegisctl_restore_requires_the_typed_confirmation(typed):
    channel = FakeChannel()
    assert run_restore(["--reason", REASON], Terminal(typed=typed), channel) == 2
    assert channel.calls == []


def test_aegisctl_restore_has_no_bypass_flags():
    parser = cli.build_parser()
    for flag in ("--yes", "--force", "--secret", "--confirm", "--no-confirm"):
        with pytest.raises(SystemExit):
            parser.parse_args(["restore", "--reason", REASON, flag, "x"])


def test_aegisctl_restore_reports_a_refusal_without_claiming_anything(capsys):
    refused = {"v": 1, "ok": False, "code": "AUTH_FAILED", "detail": "authentication failed", "msg_id": None,
               "seq": None, "evidence": _ladder(requested="REFUSED", published="NOT_PUBLISHED",
                                                ack="NOT_APPLICABLE", executed="NOT_APPLICABLE")}
    assert run_restore(["--reason", REASON], Terminal(), FakeChannel(refused)) == 2
    output = capsys.readouterr().out
    assert "AUTH_FAILED" in output and "NOT_PUBLISHED" in output


def test_aegisctl_restore_reports_an_unreachable_channel_as_not_sent(capsys):
    channel = FakeChannel(lr.ChannelUnavailable("no supervisor"))
    assert run_restore(["--reason", REASON], Terminal(), channel) == 1
    assert len(channel.calls) == 1
    assert "nothing was sent" in capsys.readouterr().err.lower()


def test_aegisctl_restore_never_retries_an_unknown_outcome(capsys):
    channel = FakeChannel(lr.OutcomeUnknown("answer lost"))
    assert run_restore(["--reason", REASON], Terminal(), channel) == 4
    assert len(channel.calls) == 1
    err = capsys.readouterr().err
    assert "OUTCOME_UNKNOWN" in err and "do not re-run" in err.lower()


def test_aegisctl_restore_never_retries_an_unknown_outcome_response(capsys):
    response = {
        "v": 1,
        "ok": False,
        "code": "OUTCOME_UNKNOWN",
        "detail": "the handler failed after accepting the request",
        "msg_id": None,
        "seq": None,
        "evidence": _ladder(
            requested="ACCEPTED",
            published="OUTCOME_UNKNOWN",
            ack="OUTCOME_UNKNOWN",
            executed="OUTCOME_UNKNOWN",
        ),
    }
    channel = FakeChannel(response)
    assert run_restore(["--reason", REASON], Terminal(), channel) == 4
    assert len(channel.calls) == 1
    assert "do not re-run" in capsys.readouterr().err.lower()


def test_aegisctl_restore_waits_with_read_only_evidence_queries(capsys):
    channel = FakeChannel(
        _published(),
        _evidence(),
        _evidence(ack="ACCEPTED"),
        _evidence(ack="ACCEPTED", executed="DEVICE_REPORTED_NORMAL"),
    )
    assert run_restore(["--reason", REASON, "--wait", "30"], Terminal(), channel) == 0
    ops = [body["op"] for _, body in channel.calls]
    assert ops == ["RESTORE_UPLINK", "RESTORE_EVIDENCE", "RESTORE_EVIDENCE", "RESTORE_EVIDENCE"]
    output = capsys.readouterr().out
    assert "DEVICE_REPORTED_NORMAL" in output and "NOT_PROVEN" in output


def test_aegisctl_restore_exits_nonzero_when_the_device_rejects(capsys):
    channel = FakeChannel(_published(), _evidence(ack="REJECTED_SEQUENCE"))
    assert run_restore(["--reason", REASON, "--wait", "30"], Terminal(), channel) == 3
    assert [body["op"] for _, body in channel.calls].count("RESTORE_UPLINK") == 1


@pytest.mark.parametrize("executed", ["DEVICE_REPORTED_LOCKDOWN", "DEVICE_STATUS_CORRELATED"])
def test_aegisctl_restore_exits_nonzero_for_non_normal_device_evidence(executed):
    channel = FakeChannel(_published(), _evidence(ack="ACCEPTED", executed=executed))
    assert run_restore(["--reason", REASON, "--wait", "30"], Terminal(), channel) == 3
    assert [body["op"] for _, body in channel.calls].count("RESTORE_UPLINK") == 1


def test_aegisctl_restore_stops_waiting_nonzero_at_the_deadline_without_resending(capsys):
    channel = FakeChannel(_published(), *[_evidence() for _ in range(20)])
    assert run_restore(["--reason", REASON, "--wait", "3"], Terminal(), channel) == 3
    ops = [body["op"] for _, body in channel.calls]
    assert ops.count("RESTORE_UPLINK") == 1 and 1 <= ops.count("RESTORE_EVIDENCE") <= 4
    assert "PENDING" in capsys.readouterr().err


def run_credential(argv, terminal):
    args = cli.build_parser().parse_args(["restore-credential", *argv])
    return cli.command_restore_credential(args, isatty=terminal.isatty, read_secret=terminal.read_secret)


def test_restore_credential_writes_a_private_verifiable_file(tmp_path):
    path = tmp_path / "restore.credential"
    assert run_credential(["--output", str(path)], Terminal(secret=[SECRET, SECRET])) == 0
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert SECRET not in path.read_text(encoding="ascii")
    assert lr.RestoreCredential.load(path).verify(SECRET) is True


@pytest.mark.parametrize(
    "terminal",
    [Terminal(tty=False, secret=[SECRET, SECRET]), Terminal(secret=[SECRET, SECRET + "x"]),
     Terminal(secret=["short", "short"])],
)
def test_restore_credential_refuses_unsafe_provisioning(tmp_path, terminal):
    path = tmp_path / "restore.credential"
    assert run_credential(["--output", str(path)], terminal) == 2
    assert not path.exists()


def test_restore_credential_never_overwrites(tmp_path):
    path = tmp_path / "restore.credential"
    path.write_text("existing", encoding="utf-8")
    assert run_credential(["--output", str(path)], Terminal(secret=[SECRET, SECRET])) == 2
    assert path.read_text(encoding="utf-8") == "existing"


# --------------------------------------------------------------------------- preflight


def test_preflight_warns_that_restore_is_unavailable_without_a_credential(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", "")
    settings = replace(RuntimeSettings.from_profile("development"), runtime_dir=tmp_path / "r", log_dir=tmp_path / "l")
    errors, warnings = settings.preflight()
    assert not any("D4" in error for error in errors)
    assert any("D4" in warning and "unavailable" in warning for warning in warnings)


def test_preflight_fails_on_an_unsafe_configured_credential(tmp_path, monkeypatch):
    path = tmp_path / "restore.credential"
    path.write_text(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N) + "\n", encoding="ascii")
    path.chmod(0o644)
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", str(path))
    settings = replace(RuntimeSettings.from_profile("development"), runtime_dir=tmp_path / "r", log_dir=tmp_path / "l")
    errors, _ = settings.preflight()
    assert any("D4" in error for error in errors)
    path.chmod(0o600)
    errors, _ = settings.preflight()
    assert not any("D4" in error for error in errors)


def test_an_injected_live_protocol_context_still_needs_a_durable_store(tmp_path):
    runtime_dir = tmp_path / "runtime"
    store = ProtocolStore(runtime_dir / "core-protocol.sqlite3", wall_clock=lambda: NOW)
    context = ProtocolContext(DEVICE, KEYS, store, Clock())
    settings = replace(
        RuntimeSettings.from_profile("development", dry_run=False, start_detector=False, start_gui=False),
        runtime_dir=runtime_dir,
        log_dir=tmp_path / "logs",
    )
    try:
        errors, _ = settings.preflight(protocol_configured=context)
        assert any("runtime directory" in error for error in errors)
    finally:
        store.close()


# --------------------------------------------------------------------------- static boundaries


def _sources(*globs):
    for pattern in globs:
        yield from sorted(ROOT.glob(pattern))


def test_the_d4_origin_label_lives_only_in_the_local_restore_boundary():
    literal = [path.name for path in _sources("aegis_soc/*.py") if '"aegisctl-local"' in path.read_text("utf-8")]
    assert literal == ["local_restore.py"]
    users = {path.name for path in _sources("aegis_soc/*.py") if "CONTROLLER_ORIGIN" in path.read_text("utf-8")}
    assert users == {"local_restore.py", "supervisor.py"}


def test_web_telegram_and_dispatch_code_never_reach_the_local_channel():
    for path in _sources("aegis_soc/gui.py", "aegis_soc/telegram_control.py", "aegis_soc/dispatch_worker.py",
                         "aegis_soc/dispatch_client.py", "aegis_soc/mqtt_client.py", "aegis_soc/wizard.py"):
        text = path.read_text("utf-8")
        assert "local_restore" not in text and lr.CHANNEL_NAME not in text, path.name
    for path in _sources("web/server/**/*.js", "web/src/**/*.js", "web/src/**/*.jsx"):
        text = path.read_text("utf-8")
        assert lr.CHANNEL_NAME not in text and "aegisctl-local" not in text, path.name
    dispatch = (ROOT / "web/server/domain/dispatch.js").read_text("utf-8")
    assert "DISPATCH_ACTIONS = Object.freeze(['CUT_UPLINK'])" in dispatch


def test_the_local_channel_opens_no_network_listener():
    source = (ROOT / "aegis_soc/local_restore.py").read_text("utf-8")
    assert "AF_INET" not in source and "AF_INET6" not in source
    assert "socket.AF_UNIX" in source
