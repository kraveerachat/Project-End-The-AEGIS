"""AEGIS IDEA3 PR11 Phase 4 — L9 authentication-without-actuation handler suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l9-operational-design.md
Decisions:
  OD-L9-01 through OD-L9-09 (2026-09-21).

Every test runs against FIXTURE Core/device material. No test contacts a
broker, opens a serial device, starts or stops a service, or issues a COMMAND.
The Core side is the real ``aegis_soc`` Protocol v1 verifier and store; the
device side is a model of Protocol v1 design §6.1 and is labelled as such.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from aegis_soc import mqtt_client as mqtt_module
from aegis_soc import protocol_v1 as p1
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.protocol_inbound import InboundResult, ProtocolContext
from aegis_soc.protocol_store import ProtocolStore

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L9_STAGE = STAGES / "L9"
P4_LIB = DEPLOY / "p4-lib.sh"
GATE = DEPLOY / "p4-stage-gate.sh"
L9_AUTH = DEPLOY / "p4-l9-auth.py"
FIRMWARE_MAIN = ROOT / "firmware" / "src" / "main.cpp"

REQUIRED_HANDLER_FILES = ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt")
L9_SOURCES = (L9_AUTH, L9_STAGE / "apply.sh", L9_STAGE / "verify.sh", L9_STAGE / "rollback.sh")

# Fixture-only material. None of these values is, or may become, Production.
# They are deliberately not the public golden-vector keys, which Core key
# loading refuses.
FIXTURE_C2D = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
FIXTURE_D2C = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
DEVICE = "aegis-relay-01"
OTHER_DEVICE = "aegis-relay-99"
FIXTURE_NOW = p1.TIME_FLOOR + 1_000_000
RUN_ID = "fixture-l9-run-001"

EVIDENCE_NAME = "l9-auth-evidence.json"
STORE_NAME = "fixture-protocol.sqlite3"

EVIDENCE_ALLOWED_FIELDS = {
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
}

# The design §5 probe matrix, held here independently of the helper so the
# helper cannot silently drop or weaken a probe.
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
PRE_AUTH_STAGES = {"TRANSPORT", "SCHEMA", "PAYLOAD", "TIME", "AUTH"}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load_auth_module():
    """Import p4-l9-auth.py; a missing helper is an assertion failure, not an ImportError."""
    assert L9_AUTH.is_file(), f"L9 helper missing: {L9_AUTH}"
    spec = importlib.util.spec_from_file_location("p4_l9_auth", str(L9_AUTH))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture_keys() -> p1.ProtocolKeys:
    return p1.ProtocolKeys(c2d=bytes.fromhex(FIXTURE_C2D), d2c=bytes.fromhex(FIXTURE_D2C))


def write_private(path: Path, text: str, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="ascii")
    path.chmod(mode)
    return path


def make_input_dir(base: Path, c2d: str = FIXTURE_C2D, d2c: str = FIXTURE_D2C) -> Path:
    input_dir = base / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    input_dir.chmod(0o700)
    write_private(input_dir / "k_c2d", c2d + "\n")
    write_private(input_dir / "k_d2c", d2c + "\n")
    return input_dir


def l9_env(base: Path, **overrides: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LC_ALL": "C",
        "AEGIS_PYTHON_BIN": sys.executable,
        "AEGIS_L9_INPUT_DIR": str(make_input_dir(base)),
        "AEGIS_L9_WORK_DIR": str(base / "work"),
        "AEGIS_L9_EVIDENCE_DIR": str(base / "evidence"),
        "AEGIS_L9_DEVICE_ID": DEVICE,
        "AEGIS_L9_RUN_ID": RUN_ID,
        "AEGIS_L9_FIXTURE_NOW": str(FIXTURE_NOW),
    }
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def run_stage(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(L9_STAGE / script)], env=env, capture_output=True, text=True,
                          timeout=120, check=False)


def run_helper(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(L9_AUTH), *args], capture_output=True, text=True,
                          timeout=120, check=False)


def combined(res: subprocess.CompletedProcess) -> str:
    return (res.stdout or "") + (res.stderr or "")


def applied(tmp_path: Path) -> tuple[dict[str, str], subprocess.CompletedProcess]:
    env = l9_env(tmp_path)
    res = run_stage("apply.sh", env)
    assert res.returncode == 0, combined(res)
    return env, res


def bundle(env: dict[str, str]) -> dict:
    return json.loads((Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME).read_text(encoding="utf-8"))


def code_lines(path: Path) -> list[str]:
    """Source lines without comments, so documentation cannot mask or trip a scan."""
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(line)
    return lines


def firmware_function(name: str) -> str:
    text = FIRMWARE_MAIN.read_text(encoding="utf-8")
    match = re.search(rf"void {name}\([^)]*\) \{{\n(.*?)\n\}}\n", text, re.S)
    assert match, f"{name} not found in firmware"
    return match.group(1)


def exercise(mod, tmp_path: Path, **kwargs) -> dict:
    return mod.run_exercise(keys=fixture_keys(), device_id=DEVICE, now=FIXTURE_NOW,
                            work_dir=tmp_path / "work", run_id=RUN_ID, **kwargs)


def today() -> str:
    return dt.datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()


# ---------------------------------------------------------------------------
# 1. registration and structure (OD-L9-01, design §3.2)
# ---------------------------------------------------------------------------

def test_l9_all_required_handler_files_exist() -> None:
    for name in REQUIRED_HANDLER_FILES:
        assert (L9_STAGE / name).is_file(), f"stages/L9/{name} missing"


def test_l9_handler_registration_status() -> None:
    res = subprocess.run(["bash", "-c", f'. "{P4_LIB}"; p4_stage_handler_status L9'],
                         capture_output=True, text=True, timeout=30, check=False)
    assert res.stdout.strip() == "REGISTERED", combined(res)


def test_l9_shell_scripts_pass_bash_n() -> None:
    for script in ("apply.sh", "verify.sh", "rollback.sh"):
        path = L9_STAGE / script
        assert path.is_file(), f"{script} missing"
        res = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True, check=False)
        assert res.returncode == 0, combined(res)


def test_l9_auth_helper_exists_and_compiles() -> None:
    assert L9_AUTH.is_file()
    res = subprocess.run([sys.executable, "-m", "py_compile", str(L9_AUTH)], capture_output=True, text=True,
                         check=False)
    assert res.returncode == 0, combined(res)


@pytest.mark.parametrize("name", ["allow-keys.txt", "allow-listeners.txt"])
def test_l9_allow_files_have_zero_active_entries(name: str) -> None:
    path = L9_STAGE / name
    assert path.is_file()
    active = [line for line in path.read_text(encoding="utf-8").splitlines()
              if line.strip() and not line.strip().startswith("#")]
    assert active == []


def test_l9_p4_lib_contract_is_unchanged() -> None:
    res = subprocess.run(
        ["bash", "-c", f'. "{P4_LIB}"; p4_stage_known L9 && echo KNOWN; p4_stage_mutates L9 && echo MUTATES; '
                       'echo "GAPS=$(p4_stage_gaps L9)"; echo "EXTRA=$(p4_stage_auth_extra L9)"'],
        capture_output=True, text=True, timeout=30, check=False)
    assert res.stdout.splitlines() == ["KNOWN", "MUTATES", "GAPS=none", "EXTRA="], combined(res)


def test_l9_harness_fixture_stage_l1_remains_unregistered_and_mutating() -> None:
    assert not (STAGES / "L1").exists()
    res = subprocess.run(["bash", "-c", f'. "{P4_LIB}"; p4_stage_mutates L1 && echo MUTATES; '
                                        'p4_stage_handler_status L1'],
                         capture_output=True, text=True, timeout=30, check=False)
    assert res.stdout.splitlines() == ["MUTATES", "NOT_REGISTERED"], combined(res)


def test_l9_stage_gate_simulation_sees_handler_but_never_authorizes_live(tmp_path: Path) -> None:
    auth = write_private(tmp_path / "auth.txt", (
        "AEGIS_P4_AUTHORIZATION_V1\nstage=L9\n"
        f"date={today()}\nauthorizer=music\nscope=test-only placeholder authorization record\n"
        "reference=https://example.invalid/aegis-p4-test-authorization\n"))
    k3 = write_private(tmp_path / "k3.txt", (
        "AEGIS_P4_K3_CONFIRMATION_V1\nstage=L9\n"
        f"date={today()}\nconfirmed_by=kraveerachat\nidea1_window_overlap=NONE\n"
        "reference=https://example.invalid/aegis-p4-test-k3\n"))
    for mode in ("simulate", "live"):
        res = subprocess.run(["bash", str(GATE), "--stage", "L9", "--mode", mode, "--authorization", str(auth),
                              "--k3", str(k3)], capture_output=True, text=True, timeout=30, check=False)
        assert "ROLLBACK_HANDLER=REGISTERED" in res.stdout, combined(res)
        assert "LIVE_STAGE_AUTHORIZED=NO" in res.stdout
        assert "LIVE_STAGE_AUTHORIZED=YES" not in res.stdout
        assert "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout


# ---------------------------------------------------------------------------
# 2. backend and input gates (OD-L9-01, OD-L9-05)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("var", [
    "AEGIS_L9_INPUT_DIR", "AEGIS_L9_WORK_DIR", "AEGIS_L9_EVIDENCE_DIR", "AEGIS_L9_DEVICE_ID",
    "AEGIS_L9_RUN_ID", "AEGIS_L9_FIXTURE_NOW",
])
def test_l9_apply_requires_environment(tmp_path: Path, var: str) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, **{var: None}))
    assert res.returncode != 0
    assert "L9_APPLY=FAIL" in combined(res)
    assert var in combined(res)


@pytest.mark.parametrize("authorized", ["NO", "YES"])
def test_l9_live_backend_is_refused_by_apply(tmp_path: Path, authorized: str) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, AEGIS_L9_BACKEND="live", AEGIS_L9_LIVE_AUTHORIZED=authorized))
    assert res.returncode != 0
    assert "LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY" in combined(res)
    assert "LIVE_L9=NOT_AUTHORIZED" in combined(res)
    assert not (tmp_path / "evidence" / EVIDENCE_NAME).exists()


def test_l9_live_backend_is_refused_by_the_helper_layer(tmp_path: Path) -> None:
    input_dir = make_input_dir(tmp_path)
    res = run_helper("exercise", "--input-dir", str(input_dir), "--work-dir", str(tmp_path / "work"),
                     "--evidence-dir", str(tmp_path / "evidence"), "--backend", "live", "--device-id", DEVICE,
                     "--run-id", RUN_ID, "--fixture-now", str(FIXTURE_NOW))
    assert res.returncode != 0
    assert "LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY" in combined(res)
    assert not (tmp_path / "evidence" / EVIDENCE_NAME).exists()


def test_l9_unknown_backend_is_refused(tmp_path: Path) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, AEGIS_L9_BACKEND="hardware"))
    assert res.returncode != 0
    assert "unknown backend" in combined(res)


@pytest.mark.parametrize("path", ["/etc/aegis-idea3/l9", "/opt/aegis-idea3/l9", "/var/lib/aegis-idea3/l9",
                                  "/run/aegis-idea3/l9", "/dev/shm/l9"])
@pytest.mark.parametrize("var", ["AEGIS_L9_WORK_DIR", "AEGIS_L9_EVIDENCE_DIR"])
def test_l9_apply_refuses_host_system_paths(tmp_path: Path, var: str, path: str) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, **{var: path}))
    assert res.returncode != 0
    assert "host system path" in combined(res)


def test_l9_apply_refuses_a_symlinked_input_dir(tmp_path: Path) -> None:
    env = l9_env(tmp_path)
    link = tmp_path / "input-link"
    link.symlink_to(env["AEGIS_L9_INPUT_DIR"])
    res = run_stage("apply.sh", {**env, "AEGIS_L9_INPUT_DIR": str(link)})
    assert res.returncode != 0
    assert "symlink" in combined(res)


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o604])
def test_l9_apply_refuses_a_loose_key_file(tmp_path: Path, mode: int) -> None:
    env = l9_env(tmp_path)
    (Path(env["AEGIS_L9_INPUT_DIR"]) / "k_d2c").chmod(mode)
    res = run_stage("apply.sh", env)
    assert res.returncode != 0
    assert "invalid mode" in combined(res)


def test_l9_apply_refuses_a_symlinked_key_file(tmp_path: Path) -> None:
    env = l9_env(tmp_path)
    key = Path(env["AEGIS_L9_INPUT_DIR"]) / "k_c2d"
    real = write_private(tmp_path / "elsewhere" / "k_c2d", FIXTURE_C2D + "\n")
    key.unlink()
    key.symlink_to(real)
    res = run_stage("apply.sh", env)
    assert res.returncode != 0
    assert "symlink" in combined(res)


@pytest.mark.parametrize(("c2d", "d2c"), [
    (bytes(range(0x20)).hex(), bytes(range(0x20, 0x40)).hex()),  # public golden-vector TEST-ONLY keys
    ("00" * 32, FIXTURE_D2C),
    (FIXTURE_C2D, FIXTURE_C2D),
    (FIXTURE_C2D.upper(), FIXTURE_D2C),
    (FIXTURE_C2D[:-2], FIXTURE_D2C),
])
def test_l9_refuses_unsafe_protocol_keys(tmp_path: Path, c2d: str, d2c: str) -> None:
    env = l9_env(tmp_path)
    write_private(Path(env["AEGIS_L9_INPUT_DIR"]) / "k_c2d", c2d + "\n")
    write_private(Path(env["AEGIS_L9_INPUT_DIR"]) / "k_d2c", d2c + "\n")
    res = run_stage("apply.sh", env)
    assert res.returncode != 0
    assert "L9_APPLY=FAIL" in combined(res)
    assert "key" in combined(res).lower()
    assert not (tmp_path / "evidence" / EVIDENCE_NAME).exists()
    assert c2d not in combined(res) and d2c not in combined(res)


@pytest.mark.parametrize("now", ["", "abc", "1.5", str(p1.TIME_FLOOR - 1), "-1"])
def test_l9_refuses_an_invalid_fixture_time(tmp_path: Path, now: str) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, AEGIS_L9_FIXTURE_NOW=now))
    assert res.returncode != 0
    assert "L9_APPLY=FAIL" in combined(res)


@pytest.mark.parametrize("device", ["AEGIS-RELAY", "a", "relay_01", "relay-01-", "x" * 40])
def test_l9_refuses_an_invalid_device_id(tmp_path: Path, device: str) -> None:
    res = run_stage("apply.sh", l9_env(tmp_path, AEGIS_L9_DEVICE_ID=device))
    assert res.returncode != 0
    assert "device" in combined(res).lower()


def test_l9_refuses_a_preexisting_fixture_store(tmp_path: Path) -> None:
    env = l9_env(tmp_path)
    work = Path(env["AEGIS_L9_WORK_DIR"])
    work.mkdir(mode=0o700)
    (work / STORE_NAME).write_bytes(b"")
    res = run_stage("apply.sh", env)
    assert res.returncode != 0
    assert "fixture store already exists" in combined(res)


# ---------------------------------------------------------------------------
# 3. positive authentication (OD-L9-02, OD-L9-03)
# ---------------------------------------------------------------------------

def test_l9_apply_succeeds_on_the_fixture_backend(tmp_path: Path) -> None:
    _, res = applied(tmp_path)
    assert "L9_APPLY=COMPLETE" in res.stdout
    assert "HOST_PRE_TO_RB_ZERO_DRIFT=YES" in res.stdout
    assert "L9_COMMAND_SENT=NONE" in res.stdout
    assert "LIVE_L9=NOT_AUTHORIZED" in res.stdout


def test_l9_authenticated_heartbeat_is_accepted_with_deadman_reset_only(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence = bundle(env)
    assert evidence["heartbeat_accepted"] == "PASS"
    assert evidence["heartbeat_effect"] == "DEADMAN_RESET_ONLY"


def test_l9_device_model_effect_set_is_exactly_deadman_reset() -> None:
    mod = load_auth_module()
    frames = mod.build_heartbeat_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
    model = mod.DeviceHeartbeatModel(DEVICE, fixture_keys(), mod.FixtureClock(FIXTURE_NOW))
    result = model.process(frames.positive.topic, frames.positive.payload)
    assert result.accepted
    assert model.effects == ["DEADMAN_RESET"]
    assert set(mod.DEVICE_EFFECTS) == {"DEADMAN_RESET"}


def test_l9_heartbeat_is_produced_by_the_core_codec_with_the_c2d_key() -> None:
    mod = load_auth_module()
    frames = mod.build_heartbeat_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
    message = p1.parse(frames.positive.payload, topic=frames.positive.topic, device_id=DEVICE,
                       accept_kinds=frozenset({p1.HEARTBEAT}))
    assert frames.positive.topic == p1.topics(DEVICE).heartbeat
    assert p1.verify(message, fixture_keys())
    swapped = p1.ProtocolKeys(c2d=bytes.fromhex(FIXTURE_D2C), d2c=bytes.fromhex(FIXTURE_C2D))
    assert not p1.verify(message, swapped)


def test_l9_boot_and_periodic_status_are_accepted_by_the_real_core_verifier(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence = bundle(env)
    assert evidence["status_boot_accepted"] == "PASS"
    assert evidence["status_periodic_accepted"] == "PASS"


def test_l9_status_positives_are_boot_and_periodic_only() -> None:
    mod = load_auth_module()
    frames = mod.build_status_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
    reasons = []
    for probe in frames.positives:
        message = p1.parse(probe.payload, topic=probe.topic, device_id=DEVICE, accept_kinds=frozenset({p1.STATUS}))
        reasons.append(message.fields["reason"])
        assert message.fields["cmd_msg_id"] == ""
        assert message.fields["time_trust"] == "SYNCED"
    assert reasons == ["BOOT", "PERIODIC"]


def test_l9_liveness_begins_only_after_the_first_authenticated_status(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    assert bundle(env)["liveness_before_authenticated_status"] == "NO"


def test_l9_each_accepted_status_writes_exactly_one_replay_row(tmp_path: Path) -> None:
    mod = load_auth_module()
    store = ProtocolStore(tmp_path / "store.sqlite3", wall_clock=lambda: float(FIXTURE_NOW))
    try:
        verifier = mod.build_core_verifier(fixture_keys(), DEVICE, store, mod.FixtureClock(FIXTURE_NOW))
        frames = mod.build_status_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
        for count, probe in enumerate(frames.positives, start=1):
            assert verifier.process(probe.topic, probe.payload, probe.retain).accepted
            assert mod.replay_row_count(store) == count
    finally:
        store.close()


# ---------------------------------------------------------------------------
# 4. negative probes (OD-L9-04, OD-L9-05)
# ---------------------------------------------------------------------------

def test_l9_probe_tables_match_the_design_matrix() -> None:
    mod = load_auth_module()
    assert dict(mod.HEARTBEAT_PROBES) == EXPECTED_HEARTBEAT_PROBES
    assert dict(mod.STATUS_PROBES) == EXPECTED_STATUS_PROBES


@pytest.mark.parametrize(("name", "expected"), sorted(EXPECTED_HEARTBEAT_PROBES.items()))
def test_l9_heartbeat_probe_is_rejected_at_the_expected_stage(tmp_path: Path, name: str, expected: str) -> None:
    env, _ = applied(tmp_path)
    assert bundle(env)["heartbeat_probes"][name] == expected


@pytest.mark.parametrize(("name", "expected"), sorted(EXPECTED_STATUS_PROBES.items()))
def test_l9_status_probe_is_rejected_at_the_expected_stage(tmp_path: Path, name: str, expected: str) -> None:
    env, _ = applied(tmp_path)
    assert bundle(env)["status_probes"][name] == expected


def test_l9_rejected_frames_create_no_replay_row_and_no_acceptance(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence = bundle(env)
    assert evidence["negative_probe_acceptances"] == 0
    assert evidence["replay_rows_from_rejected"] == 0


def test_l9_every_negative_status_frame_leaves_the_core_mqtt_path_without_liveness(tmp_path: Path,
                                                                                   monkeypatch) -> None:
    """The Core's real MQTT inbound path: no rejected frame produces liveness, a callback, or a notification."""
    mod = load_auth_module()
    events: list = []
    notifications: list = []
    monkeypatch.setattr(mqtt_module.db, "log_event", lambda *args, **kwargs: events.append(args))
    monkeypatch.setattr("aegis_soc.comms.send_webhook_alert", lambda *a, **k: notifications.append(a))
    store = ProtocolStore(tmp_path / "core-protocol.sqlite3", wall_clock=lambda: float(FIXTURE_NOW))
    clock = mod.FixtureClock(FIXTURE_NOW)

    class NoNetworkClient:
        def __getattr__(self, name):
            raise AssertionError(f"the L9 test client must not use {name}")

    try:
        manager = MQTTManager(protocol=ProtocolContext(DEVICE, fixture_keys(), store, clock),
                              client_factory=NoNetworkClient, protocol_mode="v1")
        statuses: list = []
        manager.status_callback = lambda *args: statuses.append(args)
        frames = mod.build_status_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
        assert {probe.name for probe in frames.negatives} == set(EXPECTED_STATUS_PROBES) - {"st_replay"}
        for probe in frames.negatives:
            clock.trusted = probe.core_time_trusted
            manager._on_v1_message(probe.topic, probe.payload, probe.retain)
            clock.trusted = True
            assert manager.last_device_msg_ts is None, probe.name
        assert statuses == [] and notifications == []
        assert mod.replay_row_count(store) == 0

        boot = frames.positives[0]
        manager._on_v1_message(boot.topic, boot.payload, boot.retain)
        assert manager.last_device_msg_ts is not None
        assert len(statuses) == 1
        seen = manager.last_device_msg_ts
        manager._on_v1_message(frames.replay.topic, frames.replay.payload, frames.replay.retain)
        assert len(statuses) == 1
        assert manager.last_device_msg_ts == seen
    finally:
        store.close()


def test_l9_pre_auth_rejections_write_no_audit_row(tmp_path: Path) -> None:
    mod = load_auth_module()
    audit: list = []
    store = ProtocolStore(tmp_path / "store.sqlite3", wall_clock=lambda: float(FIXTURE_NOW))
    clock = mod.FixtureClock(FIXTURE_NOW)
    try:
        verifier = mod.build_core_verifier(fixture_keys(), DEVICE, store, clock,
                                           audit=lambda *args: audit.append(args))
        frames = mod.build_status_frames(fixture_keys(), DEVICE, FIXTURE_NOW)
        for probe in frames.negatives:
            if EXPECTED_STATUS_PROBES[probe.name].split("/")[0] not in PRE_AUTH_STAGES:
                continue
            clock.trusted = probe.core_time_trusted
            result = verifier.process(probe.topic, probe.payload, probe.retain)
            clock.trusted = True
            assert not result.accepted
        assert audit == []
    finally:
        store.close()


def test_l9_wrong_key_probes_use_no_generated_key() -> None:
    mod = load_auth_module()
    key = bytes.fromhex(FIXTURE_D2C)
    foreign = mod.foreign_key(key)
    assert foreign != key and len(foreign) == len(key)
    assert sum(bin(a ^ b).count("1") for a, b in zip(foreign, key, strict=True)) == 1
    assert mod.foreign_key(key) == foreign  # deterministic: derived, never drawn from a random source


def test_l9_no_key_material_reaches_the_stage_directories(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    forbidden = {FIXTURE_C2D, FIXTURE_D2C}
    forbidden |= {bytes.fromhex(k).hex() for k in (FIXTURE_C2D, FIXTURE_D2C)}
    mod = load_auth_module()
    forbidden |= {mod.foreign_key(bytes.fromhex(k)).hex() for k in (FIXTURE_C2D, FIXTURE_D2C)}
    for directory in (env["AEGIS_L9_WORK_DIR"], env["AEGIS_L9_EVIDENCE_DIR"]):
        for path in Path(directory).rglob("*"):
            if path.is_file():
                data = path.read_bytes()
                for value in forbidden:
                    assert value.encode() not in data, path.name
                    assert bytes.fromhex(value) not in data, path.name


# ---------------------------------------------------------------------------
# 5. zero COMMAND / zero actuation (OD-L9-06)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("suffix", ["command", "status", "ack"])
def test_l9_recording_transport_refuses_every_non_heartbeat_topic(suffix: str) -> None:
    mod = load_auth_module()
    transport = mod.RecordingTransport(DEVICE)
    with pytest.raises(mod.L9Error, match="TRANSPORT_REFUSED"):
        transport.publish(f"aegis/idea3/v1/{DEVICE}/{suffix}", b"[1]")
    with pytest.raises(mod.L9Error, match="TRANSPORT_REFUSED"):
        transport.publish(p1.topics(OTHER_DEVICE).heartbeat, b"[1]")
    assert transport.frames == []


def test_l9_run_publishes_only_heartbeat_frames(tmp_path: Path) -> None:
    mod = load_auth_module()
    evidence = exercise(mod, tmp_path)
    assert evidence["result"] == "PASS", evidence["failure_boundary"]
    transport = mod.LAST_TRANSPORT
    assert transport.frames, "the run published nothing"
    for topic, payload in transport.frames:
        assert topic == p1.topics(DEVICE).heartbeat
        assert p1.parse(payload, topic=topic, device_id=DEVICE, accept_kinds=frozenset({p1.HEARTBEAT}))


def test_l9_fixture_store_holds_zero_command_rows_after_the_run(tmp_path: Path) -> None:
    applied(tmp_path)
    with sqlite3.Connection(tmp_path / "work" / STORE_NAME) as db:
        assert db.execute("SELECT COUNT(*) FROM protocol_commands").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM protocol_sequence").fetchone()[0] == 0


def test_l9_evidence_records_zero_command_cut_restore_and_no_relay_actuation(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence = bundle(env)
    assert evidence["commands_emitted"] == 0
    assert evidence["cut_emitted"] == 0
    assert evidence["restore_emitted"] == 0
    assert evidence["relay_actuation"] == "NONE"


@pytest.mark.parametrize("token", [
    "reserve_command", "mark_published", "send_command", "local_restore", "p1.COMMAND", "systemctl",
    "mosquitto_pub", "paho", "/dev/tty", "esptool", "token_bytes", "token_hex", "urandom", "openssl rand",
    "1883", "setLockdown", "IDEA1", "IDEA2",
])
def test_l9_sources_contain_no_actuation_network_or_key_generation_path(token: str) -> None:
    for path in L9_SOURCES:
        assert path.is_file(), f"{path.name} missing"
        hits = [line for line in code_lines(path) if token in line]
        assert hits == [], f"{path.name}: {hits}"


def test_l9_firmware_heartbeat_authenticates_before_its_only_effect() -> None:
    body = firmware_function("handleHeartbeat")
    lines = [line.strip() for line in body.splitlines()]
    assert lines[0] == "if (!aegis::p1::verify(parsed, keyC2D)) return;"
    for forbidden in ("setLockdown", "sendAck", "publishStatus", "digitalWrite", "preferences"):
        assert forbidden not in body, forbidden
    assert "lastHeartbeatMs = millis();" in body


def test_l9_firmware_drops_every_frame_while_device_time_is_untrusted() -> None:
    body = firmware_function("onMqttMessage")
    assert body.splitlines()[0].strip() == "if (timeTrust() == TimeTrust::UNTRUSTED) return;"


def test_l9_find_l9_01_firmware_heartbeat_replay_is_a_msg_id_ring_only() -> None:
    """FIND-L9-01 pin: firmware lacks the design §6.1 strictly-increasing issued_at rule.

    If the firmware gains the rule, this test fails on purpose so the design
    note and OD-L9-04 are updated together with it.
    """
    body = firmware_function("handleHeartbeat")
    assert "heartbeatSeen(messageId)" in body
    assert "lastHeartbeatIssuedAt" not in body and "issuedAt >" not in body


def test_l9_core_subscribes_only_to_device_status_and_ack_topics(tmp_path: Path) -> None:
    store = ProtocolStore(tmp_path / "s.sqlite3", wall_clock=lambda: float(FIXTURE_NOW))

    class Client:
        pass

    try:
        manager = MQTTManager(protocol=ProtocolContext(DEVICE, fixture_keys(), store, object()),
                              client_factory=Client, protocol_mode="v1")
        topics = {topic for topic, _ in manager._subscriptions()}
        assert topics == {p1.topics(DEVICE).ack, p1.topics(DEVICE).status}
    finally:
        store.close()


# ---------------------------------------------------------------------------
# 6. evidence bundle (OD-L9-07)
# ---------------------------------------------------------------------------

def test_l9_evidence_bundle_uses_the_exact_allowlist(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    assert set(bundle(env)) == EVIDENCE_ALLOWED_FIELDS


def test_l9_evidence_bundle_is_private_and_single(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence_dir = Path(env["AEGIS_L9_EVIDENCE_DIR"])
    files = [p for p in evidence_dir.iterdir() if p.is_file()]
    assert [p.name for p in files] == [EVIDENCE_NAME]
    assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
    assert not files[0].is_symlink()


def test_l9_evidence_class_is_repository_fixture(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    evidence = bundle(env)
    assert evidence["evidence_class"] == "REPOSITORY_FIXTURE"
    assert evidence["run_id"] == RUN_ID
    assert evidence["device_id"] == DEVICE
    assert evidence["result"] == "PASS"
    assert evidence["failure_boundary"] == "NONE"


def test_l9_evidence_bundle_is_write_once(tmp_path: Path) -> None:
    mod = load_auth_module()
    path = tmp_path / EVIDENCE_NAME
    fields = {name: "x" for name in mod.EVIDENCE_FIELDS}
    mod.write_evidence(path, fields)
    with pytest.raises(mod.L9Error, match="write-once"):
        mod.write_evidence(path, fields)


def test_l9_evidence_writer_rejects_extra_and_missing_fields(tmp_path: Path) -> None:
    mod = load_auth_module()
    fields = {name: "x" for name in mod.EVIDENCE_FIELDS}
    with pytest.raises(mod.L9Error, match="allowlist"):
        mod.write_evidence(tmp_path / "a.json", {**fields, "k_d2c": "x"})
    missing = dict(fields)
    missing.pop("result")
    with pytest.raises(mod.L9Error, match="missing"):
        mod.write_evidence(tmp_path / "b.json", missing)
    assert not (tmp_path / "a.json").exists() and not (tmp_path / "b.json").exists()


def test_l9_evidence_bundle_carries_no_mac_msg_id_or_key(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    text = (Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME).read_text(encoding="utf-8")
    assert re.search(r"[0-9a-f]{32}", text) is None
    assert FIXTURE_C2D not in text and FIXTURE_D2C not in text


def test_l9_apply_output_never_prints_key_mac_or_msg_id(tmp_path: Path) -> None:
    _, res = applied(tmp_path)
    assert re.search(r"[0-9a-f]{32}", combined(res)) is None


# ---------------------------------------------------------------------------
# 7. failure semantics (OD-L9-08)
# ---------------------------------------------------------------------------

def test_l9_an_accepted_negative_probe_fails_with_evidence(tmp_path: Path) -> None:
    mod = load_auth_module()

    class AcceptEverything:
        def __init__(self, **kwargs):
            pass

        def process(self, topic, payload, retain=False):
            return InboundResult(True, "ACCEPTED", "OK", None)

    evidence = exercise(mod, tmp_path, verifier_factory=AcceptEverything)
    assert evidence["result"] == "FAIL"
    assert evidence["failure_boundary"].startswith("PROBE_ACCEPTED:st_")
    assert evidence["negative_probe_acceptances"] > 0


def test_l9_a_command_row_in_the_store_fails_as_actuation(tmp_path: Path) -> None:
    mod = load_auth_module()

    def dirty_store(path):
        store = ProtocolStore(path, wall_clock=lambda: float(FIXTURE_NOW))
        store.reserve_command(DEVICE, sorted(p1.ACTIONS)[0], FIXTURE_NOW, FIXTURE_NOW + 10)
        return store

    evidence = exercise(mod, tmp_path, store_factory=dirty_store)
    assert evidence["result"] == "FAIL"
    assert evidence["failure_boundary"] == "ACTUATION_DETECTED"
    assert evidence["commands_emitted"] == 1


def test_l9_failure_still_writes_evidence_and_exits_non_zero(tmp_path: Path, monkeypatch) -> None:
    mod = load_auth_module()
    monkeypatch.setattr(mod, "STATUS_PROBES", {**mod.STATUS_PROBES, "st_tampered_mac": "SKEW/STALE"})
    input_dir = make_input_dir(tmp_path)
    code = mod.main(["exercise", "--input-dir", str(input_dir), "--work-dir", str(tmp_path / "work"),
                     "--evidence-dir", str(tmp_path / "evidence"), "--backend", "fixture", "--device-id", DEVICE,
                     "--run-id", RUN_ID, "--fixture-now", str(FIXTURE_NOW)])
    assert code != 0
    evidence = json.loads((tmp_path / "evidence" / EVIDENCE_NAME).read_text(encoding="utf-8"))
    assert evidence["result"] == "FAIL"
    assert evidence["failure_boundary"] == "PROBE_UNEXPECTED:st_tampered_mac"


# ---------------------------------------------------------------------------
# 8. verify.sh
# ---------------------------------------------------------------------------

def test_l9_verify_passes_after_a_clean_apply(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    res = run_stage("verify.sh", env)
    assert res.returncode == 0, combined(res)
    assert "L9_VERIFY=PASS" in res.stdout


def test_l9_verify_fails_closed_without_evidence(tmp_path: Path) -> None:
    env = l9_env(tmp_path)
    Path(env["AEGIS_L9_EVIDENCE_DIR"]).mkdir()
    res = run_stage("verify.sh", env)
    assert res.returncode != 0
    assert "L9_VERIFY=FAIL" in combined(res)


@pytest.mark.parametrize(("field", "value"), [
    ("result", "FAIL"),
    ("commands_emitted", 1),
    ("cut_emitted", 1),
    ("restore_emitted", 1),
    ("relay_actuation", "CUT"),
    ("negative_probe_acceptances", 1),
    ("replay_rows_from_rejected", 1),
    ("liveness_before_authenticated_status", "YES"),
    ("heartbeat_accepted", "FAIL"),
    ("heartbeat_effect", "OUTPUT_CHANGED"),
    ("evidence_class", "LIVE"),
    ("failure_boundary", "PROBE_ACCEPTED:st_zero_mac"),
])
def test_l9_verify_fails_closed_on_a_bad_evidence_value(tmp_path: Path, field: str, value) -> None:
    env, _ = applied(tmp_path)
    path = Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME
    data = json.loads(path.read_text(encoding="utf-8"))
    data[field] = value
    path.write_text(json.dumps(data), encoding="utf-8")
    res = run_stage("verify.sh", env)
    assert res.returncode != 0, field
    assert "L9_VERIFY=FAIL" in combined(res)


def test_l9_verify_fails_closed_on_a_changed_probe_result(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    path = Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME
    data = json.loads(path.read_text(encoding="utf-8"))
    data["status_probes"]["st_wrong_key_foreign"] = "ACCEPTED"
    path.write_text(json.dumps(data), encoding="utf-8")
    assert run_stage("verify.sh", env).returncode != 0


def test_l9_verify_fails_closed_when_the_bundle_carries_key_material(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    path = Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME
    data = json.loads(path.read_text(encoding="utf-8"))
    data["run_id"] = FIXTURE_D2C
    path.write_text(json.dumps(data), encoding="utf-8")
    res = run_stage("verify.sh", env)
    assert res.returncode != 0
    assert FIXTURE_D2C not in combined(res)


def test_l9_verify_fails_closed_on_a_loose_or_duplicate_bundle(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    path = Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME
    path.chmod(0o644)
    assert run_stage("verify.sh", env).returncode != 0
    path.chmod(0o600)
    extra = Path(env["AEGIS_L9_EVIDENCE_DIR"]) / "second.json"
    extra.write_text("{}", encoding="utf-8")
    extra.chmod(0o600)
    assert run_stage("verify.sh", env).returncode != 0


# ---------------------------------------------------------------------------
# 9. rollback (OD-L9-08)
# ---------------------------------------------------------------------------

def test_l9_rollback_removes_only_the_fixture_store_and_keeps_evidence(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    work = Path(env["AEGIS_L9_WORK_DIR"])
    assert (work / STORE_NAME).exists()
    res = run_stage("rollback.sh", env)
    assert res.returncode == 0, combined(res)
    assert not any(work.glob(STORE_NAME + "*"))
    assert (Path(env["AEGIS_L9_EVIDENCE_DIR"]) / EVIDENCE_NAME).is_file()
    for marker in ("L9_CORE_ACTION_TAKEN=NONE", "L9_DEVICE_ACTION_TAKEN=NONE", "L9_COMMAND_SENT=NONE",
                   "L9_EVIDENCE_PRESERVED=YES", "L9_ROLLBACK=COMPLETE"):
        assert marker in res.stdout


def test_l9_rollback_is_idempotent(tmp_path: Path) -> None:
    env, _ = applied(tmp_path)
    first = run_stage("rollback.sh", env)
    second = run_stage("rollback.sh", env)
    assert first.returncode == 0 and second.returncode == 0, combined(second)
    assert "L9_ROLLBACK=COMPLETE" in second.stdout


def test_l9_rollback_requires_its_work_dir(tmp_path: Path) -> None:
    res = run_stage("rollback.sh", l9_env(tmp_path, AEGIS_L9_WORK_DIR=None))
    assert res.returncode != 0
    assert "AEGIS_L9_WORK_DIR" in combined(res)


def test_l9_rollback_documents_the_live_fail_secure_hold() -> None:
    text = (L9_STAGE / "rollback.sh").read_text(encoding="utf-8")
    assert "S-11" in text
    assert "fail-secure" in text


# ---------------------------------------------------------------------------
# 10. containment of the repository run
# ---------------------------------------------------------------------------

def test_l9_apply_writes_nothing_outside_its_stage_directories(tmp_path: Path) -> None:
    env = l9_env(tmp_path)
    before = {p for p in tmp_path.rglob("*")}
    res = run_stage("apply.sh", env)
    assert res.returncode == 0, combined(res)
    after = {p for p in tmp_path.rglob("*")}
    allowed = (Path(env["AEGIS_L9_WORK_DIR"]), Path(env["AEGIS_L9_EVIDENCE_DIR"]))
    for path in after - before:
        assert any(path == root or root in path.parents for root in allowed), path


def test_l9_tests_never_open_a_network_or_serial_path() -> None:
    imports = re.compile(r"^\s*(?:import|from)\s+(?:serial|socket|esptool|ssl)\b")
    calls = re.compile(r"\.(?:connect|connect_async|loop_start|loop_forever)\(")
    for line in Path(__file__).read_text(encoding="utf-8").splitlines():
        assert imports.search(line) is None, line
        assert calls.search(line) is None, line
