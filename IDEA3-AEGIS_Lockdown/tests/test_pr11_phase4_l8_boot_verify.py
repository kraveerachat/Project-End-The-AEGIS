"""AEGIS IDEA3 PR11 Phase 4 — L8 signed-BOOT-STATUS boot verification suite.

Owner-approved contract (2026-09-29):
  L8_BOOT_SIGNAL=SIGNED_BOOT_STATUS
  L8_BOOT_PASS_SEMANTICS=AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN
  ELECTRICAL_RELAY_PROOF=OUTSIDE_BOOT_VERIFIER
  BOOT_VERIFICATION_DEADLINE_SEC=180, L9_REUSES_L8_BOOT_EVENT=YES

Every test uses a FAKE MQTT client, a FAKE hardware executor and a fake clock.
Nothing here opens a serial port, runs esptool, or touches a network or broker.
The autouse guard imported from the hardware suite turns any such attempt into a
failure, and `test_boot_verify_tests_never_reach_a_device_or_network` guards this
file's source.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import socket
import ssl
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
BOOT_VERIFY = DEPLOY / "p4-l8-boot-verify.py"
L8_DEVICE = DEPLOY / "p4-l8-device.py"
L8_STAGE = DEPLOY / "stages" / "L8"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from aegis_soc import protocol_v1 as p1  # noqa: E402  (pure module: no config/database import)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    assert spec is not None and spec.loader is not None, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HW = _load("l8_hw_tests_for_boot", Path(__file__).with_name("test_pr11_phase4_l8_hardware_backend.py"))
H = HW.H
_no_real_device = HW._no_real_device  # autouse guard (registered by import into this module)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    def refuse(*a, **kw):
        raise AssertionError("test attempted a real network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


# test-only CA certificate (public, throwaway; its private key was never stored)
TEST_CA_PEM = """-----BEGIN CERTIFICATE-----
MIIBpTCCAUugAwIBAgIUYDQ0sWTrzmejFgTwMKUwcLvf59MwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcQUVHSVMgTDggYm9vdC12ZXJpZnkgVEVTVCBDQTAgFw0yNjA5
MjgyMzI0MjNaGA8yMTI2MDkwNDIzMjQyM1owJzElMCMGA1UEAwwcQUVHSVMgTDgg
Ym9vdC12ZXJpZnkgVEVTVCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABO1u
atz40q/AJy0DkcAn0375pKxiTILo5qIHeAsqKp44R3HmPMsdO4jyiFkDkDa2RM/X
YSZrX/eLiGUqkVltywqjUzBRMB0GA1UdDgQWBBRBEz9VjmzAOyEhwCp9FB8gzIj5
xDAfBgNVHSMEGDAWgBRBEz9VjmzAOyEhwCp9FB8gzIj5xDAPBgNVHRMBAf8EBTAD
AQH/MAoGCCqGSM49BAMCA0gAMEUCIQDkeU1X9EzfiQQDeZqvutqaDaZEF1qPw/C/
UOksR+LZ2gIgQX3emtAmbv6pC0vC9n46C77rB/vlFX2YAvi0tF4IjP8=
-----END CERTIFICATE-----
"""

DEVICE = "aegis-relay-01"
NOW = 1_800_000_000
STATUS_TOPIC = f"aegis/idea3/v1/{DEVICE}/status"
KEYS = p1.ProtocolKeys(c2d=bytes.fromhex(H.FIXTURE_C2D), d2c=bytes.fromhex(H.FIXTURE_D2C))
BROKER_ADDRESS = "192.168.50.1"
BROKER_TLS_NAME = "mqtt.aegis.home.arpa"
BROKER_PASSWORD = "fixture-core-broker-credential-5c1e"


def load_bv():
    return _load("p4_l8_boot_verify", BOOT_VERIFY)


class FakeClock:
    def __init__(self, now=NOW, trusted=True):
        self.now = now
        self.mono = 1000.0
        self.trusted = trusted

    def trusted_now(self):
        return self.now if self.trusted else None

    def monotonic(self):
        return self.mono

    def advance(self, seconds):
        self.mono += seconds
        self.now += int(seconds)


class FakeSource:
    """Scripted stand-in for the subscribe-only MQTT source."""

    def __init__(self, clock, frames=(), arm_error=None, events=None):
        self.clock = clock
        self.frames = list(frames)
        self.arm_error = arm_error
        self.events = events if events is not None else []
        self.armed = False
        self.closed = False

    def arm(self):
        self.events.append("arm")
        if self.arm_error:
            raise self.arm_error
        self.armed = True

    def next_message(self, timeout):
        self.events.append("poll")
        if self.frames:
            return self.frames.pop(0)
        self.clock.advance(timeout)
        return None

    def close(self):
        self.closed = True


_counter = [0]


def status(*, keys=KEYS, device=DEVICE, device_time=NOW, time_trust="SYNCED", output="LOCKDOWN",
           reason="BOOT", seq_hwm=0, retain=False, tamper=False):
    _counter[0] += 1
    fields = {
        "msg_id": f"{_counter[0]:032x}", "device_time": device_time, "time_trust": time_trust,
        "output_state": output, "reason": reason, "cmd_msg_id": "", "cmd_seq": 0,
        "device_seq_hwm": seq_hwm, "rssi_dbm": -60, "heap_free": 120000,
    }
    topic, payload = p1.encode(p1.STATUS, device_id=device, fields=fields, keys=keys)
    if tamper:
        payload = payload[:-3] + (b"0" if payload[-3:-2] != b"0" else b"1") + payload[-2:]
    return (topic, payload, retain)


def make_verifier(bv, clock, frames=(), *, arm_error=None, seq=0, preseed=(), events=None):
    source = FakeSource(clock, frames, arm_error, events)
    verifier = bv.BootVerifier(
        source, keys=KEYS, device_id=DEVICE, expected_seq_hi=seq,
        clock=clock, monotonic=clock.monotonic,
    )
    for msg_id in preseed:
        verifier._seen.record_seen(DEVICE, msg_id, p1.STATUS)
    return verifier, source


def run_unit(frames, **kw):
    bv = load_bv()
    clock = FakeClock()
    verifier, source = make_verifier(bv, clock, frames, **kw)
    verifier.arm()
    return verifier.collect(), verifier, source, clock


# ===========================================================================
# 1. contract constants and structure
# ===========================================================================

def test_contract_constants_match_the_owner_decision():
    bv = load_bv()
    assert bv.BOOT_DEADLINE_SEC == 180
    assert bv.BROKER_PORT == 8883
    assert bv.BROKER_USER == "idea3-core"  # the staged Core broker identity; no new user
    assert bv.SKEW_LOWER_BOUND_SEC == 2


def test_module_import_has_no_side_effects_and_avoids_core_runtime_modules():
    body = BOOT_VERIFY.read_text(encoding="utf-8")
    imports = [l for l in body.splitlines() if re.match(r"\s*(import|from)\s", l)]
    for line in imports:
        for forbidden in ("mqtt_client", "database", "protocol_store", "sqlite3", "config"):
            assert forbidden not in line, f"verifier must not import the Core runtime/replay store: {line}"
    for forbidden in ("ProtocolStore", "sqlite3"):
        assert forbidden not in body, forbidden
    # paho is imported lazily, never at module import time
    assert not re.search(r"^(import|from)\s+paho", body, re.M)


def test_verifier_source_has_no_publish_or_actuation_path():
    body = BOOT_VERIFY.read_text(encoding="utf-8")
    assert ".publish(" not in body
    for token in ("/command", "/heartbeat", "CUT_UPLINK", "RESTORE_UPLINK", "esptool", "subprocess"):
        assert token not in body, token


def test_source_wrapper_exposes_no_publish_api():
    bv = load_bv()
    src = bv.SubscribeOnlySource(
        client_factory=lambda client_id: FakePaho(), context_factory=lambda *a: object(),
        address=BROKER_ADDRESS, tls_name=BROKER_TLS_NAME, ca_file="/unused", username=bv.BROKER_USER,
        password=BROKER_PASSWORD, topic=STATUS_TOPIC, client_id="aegis-l8-boot-t",
    )
    for name in dir(src):
        assert "publish" not in name.lower() and "send" not in name.lower(), name
    for banned in ("client", "_client"):
        assert not hasattr(src, banned) or banned.startswith("_")


# ===========================================================================
# 2. PASS contract
# ===========================================================================

def test_authenticated_fresh_boot_lockdown_frame_passes():
    verdict, verifier, source, _ = run_unit([status()])
    assert verdict == "PASS"
    assert verifier.detail == "PASS_BOOT_LOCKDOWN"
    assert source.closed is True


def test_the_verifier_is_callable_as_the_device_boot_verifier():
    bv = load_bv()
    clock = FakeClock()
    verifier, _ = make_verifier(bv, clock, [status()])
    verifier.arm()
    assert verifier() == "PASS"


def test_bad_frames_before_a_good_one_do_not_prevent_pass():
    frames = [status(tamper=True), status(device="other-device-01"), status(reason="PERIODIC"), status()]
    assert run_unit(frames)[0] == "PASS"


# ===========================================================================
# 3. NOT_PROVEN cases (never PASS)
# ===========================================================================

WRONG_KEY = p1.ProtocolKeys(c2d=KEYS.c2d, d2c=bytes.fromhex("ab" * 32))
CROSS_KEY = p1.ProtocolKeys(c2d=KEYS.c2d, d2c=KEYS.c2d)


@pytest.mark.parametrize(
    "frame",
    [
        pytest.param(lambda: status(keys=WRONG_KEY), id="foreign-key"),
        pytest.param(lambda: status(keys=CROSS_KEY), id="cross-direction-key"),
        pytest.param(lambda: status(tamper=True), id="tampered-mac"),
        pytest.param(lambda: status(device="other-device-01"), id="other-device-topic"),
        pytest.param(lambda: status(reason="PERIODIC"), id="periodic-not-boot"),
        pytest.param(lambda: status(reason="DEADMAN"), id="deadman-not-boot"),
        pytest.param(lambda: status(time_trust="HOLDOVER"), id="holdover"),
        pytest.param(lambda: status(time_trust="UNTRUSTED", device_time=0), id="untrusted"),
        pytest.param(lambda: status(retain=True), id="retained"),
        pytest.param(lambda: status(device_time=NOW - 1000), id="stale"),
        pytest.param(lambda: status(device_time=NOW + 1000), id="future"),
        pytest.param(lambda: status(device_time=NOW - 20), id="before-T0-but-inside-skew"),
        pytest.param(lambda: status(seq_hwm=7), id="wrong-seq-hwm"),
    ],
)
def test_unacceptable_frames_yield_not_proven(frame):
    verdict, verifier, _, _ = run_unit([frame()])
    assert verdict == "NOT_PROVEN"
    assert verifier.detail == "NO_VALID_FRAME_BEFORE_DEADLINE"


def test_a_replayed_msg_id_is_not_accepted():
    frame = status()
    msg_id = p1.parse(frame[1], topic=frame[0], device_id=DEVICE,
                      accept_kinds=frozenset({p1.STATUS})).fields["msg_id"]
    assert run_unit([frame], preseed=[msg_id])[0] == "NOT_PROVEN"


def test_identical_frame_twice_is_accepted_once_only():
    frame = status(seq_hwm=7)  # authenticated but wrong seq: consumed, not a pass
    verdict, *_ = run_unit([frame, frame, status(seq_hwm=7)])
    assert verdict == "NOT_PROVEN"


def test_frame_from_before_T0_cannot_pass():
    bv = load_bv()
    clock = FakeClock()
    verifier, _ = make_verifier(bv, clock, [])
    verifier.arm()  # T0 = NOW
    old = status(device_time=NOW - 10)  # authenticated, inside the 30 s skew, but before T0 - 2
    verifier._source.frames.append(old)
    assert verifier.collect() == "NOT_PROVEN"


def test_frame_just_inside_the_T0_tolerance_passes():
    assert run_unit([status(device_time=NOW - 2)])[0] == "PASS"


def test_untrusted_core_clock_never_passes():
    bv = load_bv()
    clock = FakeClock()
    verifier, _ = make_verifier(bv, clock, [status()])
    verifier.arm()
    clock.trusted = False
    assert verifier.collect() == "NOT_PROVEN"


def test_deadline_is_180_seconds_of_waiting():
    verdict, verifier, source, clock = run_unit([])
    assert verdict == "NOT_PROVEN"
    assert 180 <= clock.mono - 1000.0 < 182
    assert verifier.detail == "NO_VALID_FRAME_BEFORE_DEADLINE"


def test_a_valid_frame_arriving_after_the_deadline_is_not_used():
    bv = load_bv()
    clock = FakeClock()
    verifier, source = make_verifier(bv, clock, [])
    verifier.arm()
    late = status()
    clock.advance(181)
    source.frames.append(late)
    assert verifier.collect() == "NOT_PROVEN"


# ===========================================================================
# 4. FAIL: authenticated contradictory state
# ===========================================================================

@pytest.mark.parametrize("reason", ["BOOT", "PERIODIC"])
def test_authenticated_normal_output_state_is_fail(reason):
    verdict, verifier, _, _ = run_unit([status(output="NORMAL", reason=reason)])
    assert verdict == "FAIL"
    assert verifier.detail == "CONTRADICTORY_OUTPUT_STATE"


def test_unauthenticated_normal_frame_cannot_force_fail():
    verdict, *_ = run_unit([status(output="NORMAL", keys=WRONG_KEY), status(output="NORMAL", tamper=True)])
    assert verdict == "NOT_PROVEN"


def test_normal_frame_from_before_T0_is_not_a_verdict():
    assert run_unit([status(output="NORMAL", device_time=NOW - 10)])[0] == "NOT_PROVEN"


# ===========================================================================
# 5. Core replay store is never touched; state is ephemeral
# ===========================================================================

def test_verification_state_is_in_memory_and_writes_no_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    before = set(tmp_path.rglob("*"))
    assert run_unit([status()])[0] == "PASS"
    assert set(tmp_path.rglob("*")) == before


def test_ephemeral_store_accepts_each_msg_id_once():
    bv = load_bv()
    store = bv.EphemeralSeenStore()
    assert store.record_seen(DEVICE, "a" * 32, p1.STATUS) is True
    assert store.record_seen(DEVICE, "a" * 32, p1.STATUS) is False
    assert store.record_seen(DEVICE, "b" * 32, p1.STATUS) is True


# ===========================================================================
# 6. subscribe-only paho wrapper
# ===========================================================================

class FakePaho:
    def __init__(self, *, connect_rc=0, suback=0, frames=()):
        self.connect_rc = connect_rc
        self.suback = suback
        self.frames = list(frames)
        self.calls = []
        self.published = []
        self.on_connect = self.on_message = self.on_subscribe = None

    def tls_set_context(self, context):
        self.calls.append(("tls_set_context", context))

    def username_pw_set(self, user, password):
        self.calls.append(("username_pw_set", user))
        self.password = password

    def connect(self, host, port, keepalive=60):
        self.calls.append(("connect", host, port))

    def loop_start(self):
        self.calls.append(("loop_start",))
        self.on_connect(self, None, {}, self.connect_rc, None)

    def subscribe(self, topics):
        self.calls.append(("subscribe", tuple(topics) if not isinstance(topics, str) else topics))
        self.on_subscribe(self, None, 1, [self.suback], None)
        for topic, payload, retain in self.frames:
            self.on_message(self, None, SimpleNamespace(topic=topic, payload=payload, retain=retain))

    def loop_stop(self):
        self.calls.append(("loop_stop",))

    def disconnect(self):
        self.calls.append(("disconnect",))

    def publish(self, *a, **kw):  # must never be reached
        self.published.append((a, kw))


def make_source(bv, fake, **overrides):
    kw = dict(
        client_factory=lambda client_id: fake, context_factory=lambda ca, name: SimpleNamespace(ca=ca, name=name),
        address=BROKER_ADDRESS, tls_name=BROKER_TLS_NAME, ca_file="/pinned/ca.crt",
        username=bv.BROKER_USER, password=BROKER_PASSWORD, topic=STATUS_TOPIC, client_id="aegis-l8-boot-t",
    )
    kw.update(overrides)
    return bv.SubscribeOnlySource(**kw)


def test_source_arm_connects_tls_8883_and_subscribes_only_to_the_exact_topic():
    bv = load_bv()
    fake = FakePaho()
    src = make_source(bv, fake)
    src.arm()
    calls = {c[0]: c for c in fake.calls}
    assert calls["connect"][1:] == (BROKER_ADDRESS, 8883)
    assert calls["username_pw_set"][1] == "idea3-core"
    assert calls["tls_set_context"][1].name == BROKER_TLS_NAME
    subs = [c for c in fake.calls if c[0] == "subscribe"]
    assert subs == [("subscribe", ((STATUS_TOPIC, 0),))] or subs == [("subscribe", [(STATUS_TOPIC, 0)])]
    assert fake.published == []
    src.close()
    assert ("loop_stop",) in fake.calls and ("disconnect",) in fake.calls


@pytest.mark.parametrize("topic", ["aegis/idea3/v1/+/status", "aegis/idea3/v1/#", "#",
                                   f"aegis/idea3/v1/{DEVICE}/command", f"aegis/idea3/v1/{DEVICE}/heartbeat",
                                   f"aegis/idea3/v1/{DEVICE}/ack", ""])
def test_source_refuses_any_topic_but_a_device_status_topic(topic):
    bv = load_bv()
    with pytest.raises(bv.BootVerifyError):
        make_source(bv, FakePaho(), topic=topic)


def test_source_refuses_a_non_8883_port_and_missing_material():
    bv = load_bv()
    with pytest.raises(bv.BootVerifyError):
        make_source(bv, FakePaho(), port=1 * 1000 + 883)
    for missing in ("address", "tls_name", "ca_file", "password", "username"):
        with pytest.raises(bv.BootVerifyError):
            make_source(bv, FakePaho(), **{missing: ""})


def test_source_client_id_never_collides_with_the_core_client():
    bv = load_bv()
    ids = []
    src = make_source(bv, FakePaho(), client_factory=lambda cid: (ids.append(cid), FakePaho())[1])
    src.arm()
    assert ids and ids[0].startswith("aegis-l8-boot-")


def test_source_arm_fails_on_connect_refusal_and_on_subscription_refusal():
    bv = load_bv()
    for fake in (FakePaho(connect_rc=5), FakePaho(suback=0x80)):
        src = make_source(bv, fake)
        with pytest.raises(bv.BootVerifyError) as err:
            src.arm()
        assert BROKER_PASSWORD not in str(err.value)
        assert fake.published == []


def test_source_discards_frames_from_any_other_topic():
    bv = load_bv()
    ok = status()
    other = status(device="other-device-01")
    fake = FakePaho(frames=[other, ok])
    src = make_source(bv, fake)
    src.arm()
    first = src.next_message(0.01)
    assert first is not None and first[0] == STATUS_TOPIC
    assert src.next_message(0.01) is None


def test_source_returns_none_on_timeout_without_blocking_forever():
    bv = load_bv()
    src = make_source(bv, FakePaho())
    src.arm()
    assert src.next_message(0.01) is None


def test_tls_context_is_verifying_and_pinned(tmp_path):
    bv = load_bv()
    ca = tmp_path / "ca.crt"
    ca.write_text(TEST_CA_PEM, encoding="ascii")
    ctx = bv.build_tls_context(str(ca), BROKER_TLS_NAME)
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True
    assert ctx.minimum_version >= ssl.TLSVersion.TLSv1_2
    with pytest.raises(bv.BootVerifyError):
        bv.build_tls_context(str(tmp_path / "missing.crt"), BROKER_TLS_NAME)
    with pytest.raises(bv.BootVerifyError):
        bv.build_tls_context(str(ca), "192.168.50.1")  # IP literal is not a DNS name


# ===========================================================================
# 7. live verifier construction (private inputs, real Protocol v1 keys)
# ===========================================================================

def live_inputs(tmp_path, *, credential_mode=0o600):
    env = HW.hw_env(tmp_path)
    ca = tmp_path / "ca.crt"
    ca.write_text(TEST_CA_PEM, encoding="ascii")
    cred = H.write_private(tmp_path / "broker.cred", BROKER_PASSWORD + "\n", credential_mode)
    return env, ca, cred


def build_live(bv, env, ca, cred, fake, clock):
    return bv.build_live_boot_verifier(
        input_dir=Path(env["AEGIS_L8_INPUT_DIR"]), device_id=DEVICE, expected_seq_hi=0,
        broker_address=BROKER_ADDRESS, tls_name=BROKER_TLS_NAME, ca_file=str(ca),
        credential_file=cred, run_id="l8-fixture-run-0001",
        client_factory=lambda client_id: fake, clock=clock,
    )


def test_live_builder_reads_real_keys_and_private_credential_without_io(tmp_path):
    bv = load_bv()
    env, ca, cred = live_inputs(tmp_path)
    fake = FakePaho()
    verifier = build_live(bv, env, ca, cred, fake, FakeClock())
    assert fake.calls == [], "construction must not touch the network"
    assert verifier.expected_seq_hi == 0


@pytest.mark.parametrize("mode", [0o644, 0o660, 0o604])
def test_live_builder_refuses_a_loose_credential_file(tmp_path, mode):
    bv = load_bv()
    env, ca, cred = live_inputs(tmp_path, credential_mode=mode)
    with pytest.raises(Exception):
        build_live(bv, env, ca, cred, FakePaho(), FakeClock())


def test_live_builder_refuses_a_symlinked_or_missing_credential(tmp_path):
    bv = load_bv()
    env, ca, cred = live_inputs(tmp_path)
    link = tmp_path / "link.cred"
    link.symlink_to(cred)
    for bad in (link, tmp_path / "missing.cred"):
        with pytest.raises(Exception):
            build_live(bv, env, ca, bad, FakePaho(), FakeClock())


def test_live_builder_refuses_demo_or_identical_protocol_keys(tmp_path):
    bv = load_bv()
    env, ca, cred = live_inputs(tmp_path)
    H.write_private(Path(env["AEGIS_L8_INPUT_DIR"]) / "k_d2c", H.FIXTURE_C2D + "\n")  # equals k_c2d
    with pytest.raises(Exception):
        build_live(bv, env, ca, cred, FakePaho(), FakeClock())


# ===========================================================================
# 8. provision integration (fake executor, fake verifier source)
# ===========================================================================

def run_provision(tmp_path, verifier_factory, *, executor_kw=None, args_extra=None):
    mod = HW.load_mod()
    env = HW.hw_env(tmp_path)
    events = []
    ex = HW.FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"], **(executor_kw or {}))
    real_run = ex.run

    def logging_run(argv, timeout=None):
        events.append(ex.sub(argv))
        return real_run(argv, timeout)

    ex.run = logging_run
    bv = load_bv()
    clock = FakeClock()
    verifier = verifier_factory(bv, clock, events)
    args = HW.hw_args(mod, env)
    try:
        rc = mod.provision(args, executor=ex, boot_verifier=verifier)
    except mod.L8Error as exc:
        rc = ("L8Error", str(exc))
    return mod, env, ex, verifier, events, rc


def _boot_ok(bv, clock, events):
    return make_verifier(bv, clock, [status()], events=events)[0]


def test_boot_pass_end_to_end_records_pass(tmp_path):
    mod, env, ex, verifier, events, rc = run_provision(tmp_path, _boot_ok)
    assert rc == 0, rc
    _, bundle = HW.evidence(env)
    assert bundle["boot_verification_result"] == "PASS"
    assert bundle["failure_boundary"] == "NONE"
    assert set(bundle) == H.EVIDENCE_ALLOWED_FIELDS and len(bundle) == 12


def test_verifier_is_armed_after_identity_and_before_the_first_write(tmp_path):
    *_, events, rc = run_provision(tmp_path, _boot_ok)
    assert rc == 0
    assert events.index("flash_id") < events.index("arm") < events.index("write_flash")
    assert events.index("read_flash") < events.index("poll"), "verdict must be sought after the reboot boundary"


def test_l8_does_not_reboot_the_device_to_manufacture_a_boot_event(tmp_path):
    mod, env, ex, *_ = run_provision(tmp_path, _boot_ok)
    resets = [c for c in ex.calls if "--after" in c and c[c.index("--after") + 1] == "hard_reset"]
    assert len(resets) == 1, "exactly one reset: the one that boots the freshly flashed image"
    assert ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"]


def test_contradictory_boot_state_is_fail_and_holds_without_recovery(tmp_path):
    def factory(bv, clock, events):
        return make_verifier(bv, clock, [status(output="NORMAL")], events=events)[0]

    mod, env, ex, verifier, events, rc = run_provision(tmp_path, factory)
    assert rc != 0
    _, bundle = HW.evidence(env)
    assert bundle["boot_verification_result"] == "FAIL"
    assert bundle["failure_boundary"] == "BOOT_VERIFICATION"
    assert bundle["flash_result"] == "PASS" and bundle["nvs_readback_match"] == "PASS"
    assert ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"], "no retry/reflash/restore"
    res = H.run_stage("rollback.sh", env)
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout and "L8_DEVICE_ACTION_TAKEN=NONE" in res.stdout


def test_no_valid_proof_before_the_deadline_is_not_proven(tmp_path):
    def factory(bv, clock, events):
        return make_verifier(bv, clock, [status(tamper=True)], events=events)[0]

    mod, env, ex, verifier, events, rc = run_provision(tmp_path, factory)
    assert rc != 0
    _, bundle = HW.evidence(env)
    assert bundle["boot_verification_result"] == "NOT_PROVEN"
    assert bundle["failure_boundary"] == "BOOT_VERIFICATION"
    assert ex.subcommands().count("write_flash") == 2 and ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"], "only the one read-only terminal reset follows"


def test_arm_failure_aborts_before_any_device_write(tmp_path):
    def factory(bv, clock, events):
        return make_verifier(bv, clock, [], arm_error=bv.BootVerifyError("broker unreachable"), events=events)[0]

    mod, env, ex, verifier, events, rc = run_provision(tmp_path, factory)
    assert isinstance(rc, tuple)
    assert "write_flash" not in ex.subcommands()
    assert ex.subcommands() == ["flash_id"]
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()
    assert not list(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))


def test_the_seq_hi_binding_uses_the_value_written_into_the_new_nvs(tmp_path):
    mod = HW.load_mod()
    provisioner = mod.load_nvs_provisioner()

    def factory(bv, clock, events):
        return make_verifier(bv, clock, [status(seq_hwm=provisioner.SEQ_HI_INITIAL)],
                             seq=provisioner.SEQ_HI_INITIAL, events=events)[0]

    *_, rc = run_provision(tmp_path, factory)
    assert rc == 0


def test_no_boot_verifier_configuration_refuses_before_any_device_access(tmp_path):
    mod = HW.load_mod()
    env = HW.hw_env(tmp_path)
    ex = HW.FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(mod.L8Error) as err:
        mod.provision(HW.hw_args(mod, env), executor=ex)  # no verifier, no broker inputs
    assert "BOOT_VERIFICATION_NOT_CONFIGURED" in str(err.value)
    assert ex.calls == []
    assert "BOOT_VERIFICATION_NOT_IMPLEMENTED" not in L8_DEVICE.read_text(encoding="utf-8")


def test_live_verifier_is_built_from_broker_inputs_and_passes_with_a_fake_client(tmp_path):
    mod = HW.load_mod()
    env, ca, cred = live_inputs(tmp_path)
    ex = HW.FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    fake = FakePaho(frames=[status()])
    args = HW.hw_args(mod, env)
    args.broker_address, args.broker_tls_name = BROKER_ADDRESS, BROKER_TLS_NAME
    args.broker_ca_file, args.broker_credential_file = str(ca), str(cred)
    rc = mod.provision(args, executor=ex, boot_client_factory=lambda cid: fake, boot_clock=FakeClock())
    assert rc == 0
    _, bundle = HW.evidence(env)
    assert bundle["boot_verification_result"] == "PASS"
    assert fake.published == [], "the verifier must never publish"
    assert ("connect", BROKER_ADDRESS, 8883) in fake.calls
    assert ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"]


def test_credential_and_frames_never_reach_output_or_evidence(tmp_path, capsys):
    mod = HW.load_mod()
    env, ca, cred = live_inputs(tmp_path)
    ex = HW.FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    frame = status()
    fake = FakePaho(frames=[frame])
    args = HW.hw_args(mod, env)
    args.broker_address, args.broker_tls_name = BROKER_ADDRESS, BROKER_TLS_NAME
    args.broker_ca_file, args.broker_credential_file = str(ca), str(cred)
    mod.provision(args, executor=ex, boot_client_factory=lambda cid: fake, boot_clock=FakeClock())
    out = capsys.readouterr()
    _, bundle = HW.evidence(env)
    for text in (out.out, out.err, json.dumps(bundle)):
        assert BROKER_PASSWORD not in text
        assert frame[1].decode("ascii") not in text
        for secret in H.FORBIDDEN_EVIDENCE_VALUES:
            assert secret not in text


# ===========================================================================
# 9. apply.sh wiring
# ===========================================================================

@pytest.mark.parametrize("missing", ["AEGIS_L8_BROKER_ADDRESS", "AEGIS_L8_BROKER_TLS_NAME",
                                     "AEGIS_L8_MQTT_CA_FILE", "AEGIS_L8_BROKER_CREDENTIAL_FILE"])
def test_apply_hardware_requires_every_boot_verifier_input(tmp_path, missing):
    env = HW.hw_env(tmp_path, AEGIS_L8_LIVE_AUTHORIZED="YES", AEGIS_L8_ESPTOOL=HW.FAKE_ESPTOOL)
    full = {
        "AEGIS_L8_BROKER_ADDRESS": BROKER_ADDRESS, "AEGIS_L8_BROKER_TLS_NAME": BROKER_TLS_NAME,
        "AEGIS_L8_MQTT_CA_FILE": str(tmp_path / "ca.crt"),
        "AEGIS_L8_BROKER_CREDENTIAL_FILE": str(tmp_path / "broker.cred"),
    }
    full.pop(missing)
    env.update(full)
    res = H.run_apply(env)
    assert res.returncode != 0
    assert missing in H.combined(res)
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


def test_apply_fixture_mode_does_not_require_broker_inputs(tmp_path):
    env = H.l8_env(tmp_path)
    assert H.run_apply(env).returncode == 0


# ===========================================================================
# 10. guard: this file never reaches a device or network
# ===========================================================================

def test_boot_verify_tests_never_reach_a_device_or_network():
    body = Path(__file__).read_text(encoding="utf-8")
    assert not re.search(r"^\s*import\s+(serial|esptool)\b", body, re.M)
    assert not re.search(r"^\s*from\s+(serial|esptool)\b", body, re.M)
    assert ("import " + "paho") not in body and ("from " + "paho") not in body
    assert "serial" + ".Serial" not in body
    assert "Subprocess" + "Executor(" not in body
