"""AEGIS IDEA3 PR11 Phase 4 — L8p (ESP32 device provisioning ONLY) stage test suite, on the CANONICAL L8 hardware backend.

L8p sits before Recovery (L7u -> L8p -> Recovery R1-R8 -> LVR -> L8) and provisions the Protocol-v1 ESP32. Owner decision OD-L8P-01: for L8p only, an
owner-attested PHYSICAL recovery procedure replaces "D4 live before flash"; L8 stays D4-only. L8p claims nothing about Recovery, LVR, L8 live
acceptance or the electrical relay. It REUSES the merged L8 device flow (HardwareDevice, SubprocessExecutor, NVS + firmware readback, one terminal
reset, the signed BOOT STATUS verifier, the 12-field evidence); these tests prove the reuse and the L8p-only governance.

No test here opens a serial device, drives a flashing tool, flashes, erases or burns an eFuse: the fixture backend and a FAKE executor only.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_harness as harness
import test_pr11_phase4_l8_boot_verify as BV
import test_pr11_phase4_l8_handler as H
import test_pr11_phase4_l8_hardware_backend as HW

_no_real_device = HW._no_real_device  # the autouse guard of the hardware suite (any real device/tool/network access fails)

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGE = DEPLOY / "stages" / "L8p"
MODULE_PATH = DEPLOY / "p4-l8p-device.py"
CANON_PATH = DEPLOY / "p4-l8-device.py"
P4_LIB = DEPLOY / "p4-lib.sh"
HANDLER_FILES = {"apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"}

SECRETS = (H.FIXTURE_C2D, H.FIXTURE_D2C, H.FIXTURE_WIFI_PSK, H.FIXTURE_MQTT_PASS)
ACCEPTANCE_CLAIM = re.compile(r"(RECOVERY|LVR|L8|L9|D4)[A-Z0-9_]*(ACCEPTANCE|PROVEN|SUCCESS|LIVE_VERIFIED|PASS)=(YES|PASS|PROVEN)")
NVS_OFFSET, NVS_SIZE, APP_OFFSET = HW.NVS_OFFSET, HW.NVS_SIZE, HW.APP_OFFSET
FULL = ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"]

_MODULE = None


def load_module():
    global _MODULE
    if _MODULE is None:
        assert MODULE_PATH.is_file(), f"missing {MODULE_PATH}"
        spec = importlib.util.spec_from_file_location("p4_l8p_device", str(MODULE_PATH))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _MODULE = module
    return _MODULE


# ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────

ATTESTATION_DEFAULTS = {
    "stage": "L8p", "expected_mac": H.FIXTURE_MAC, "procedure_id": "owner-physical-recovery-procedure-v1",
    "procedure_class": "MANUAL_OUT_OF_BAND", "approved_on": "2026-10-02",
    **{k: "YES" for k in ("physical_serial_recovery", "rom_bootloader_recovery", "power_cycle_capable", "download_mode_entry",
                          "owner_reviewed_serial_access", "reflash_pinned_artifacts", "interrupted_write_recovery", "ack_manual_out_of_band",
                          "ack_not_d4", "ack_no_recovery_claim", "ack_no_lvr_claim", "ack_no_l8_acceptance_claim",
                          "ack_no_electrical_relay_claim")},
    **{k: "NO" for k in ("depends_on_production", "depends_on_mqtt", "depends_on_network", "automatic_rollback", "legacy_firmware_fallback",
                         "plaintext_1883", "remote_recovery")},
}


def attestation_text(support, drop=(), **over) -> str:
    fields = {**ATTESTATION_DEFAULTS,
              "firmware_sha256": hashlib.sha256(support["firmware_image"].read_bytes()).hexdigest(),
              "partition_table_sha256": hashlib.sha256(support["partition_table"].read_bytes()).hexdigest(), **over}
    for key in drop:
        fields.pop(key)
    return "AEGIS_P4_L8P_PHYSICAL_RECOVERY_ATTESTATION_V1\n" + "".join(f"{k}={v}\n" for k, v in fields.items())


def make_pre_evidence(base: Path, *, complete: bool = True, tamper: bool = False) -> Path:
    pre = base / "pre-root"
    pre.mkdir(parents=True, exist_ok=True)
    (pre / "capture.log").write_text("L0_CAPTURE=COMPLETE\n" if complete else "L0_CAPTURE=INCOMPLETE\n")
    (pre / "SHA256SUMS").write_text(f"{hashlib.sha256((pre / 'capture.log').read_bytes()).hexdigest()}  capture.log\n")
    if tamper:
        (pre / "capture.log").write_text("L0_CAPTURE=COMPLETE\nextra\n")
    return pre


def make_inputs(base: Path, support, *, port: str = H.FIXTURE_SERIAL_PORT, **pins_override: str) -> Path:
    d = base / "inputs"
    d.mkdir(parents=True, exist_ok=True)
    H.write_private(d / "device.identity", f"expected_mac={H.FIXTURE_MAC}\nserial_port={port}\n")
    pins = {"firmware_sha256": hashlib.sha256(support["firmware_image"].read_bytes()).hexdigest(),
            "partition_table_sha256": hashlib.sha256(support["partition_table"].read_bytes()).hexdigest(),
            "nvs_offset": "0xb000", "nvs_size": "0x5000", "app_offset": "0x20000", "app_size": "0x180000",
            "nvs_namespace": "aegis-p1", "nvs_schema": "1", **pins_override}
    H.write_private(d / "provisioning.pins", "".join(f"{k}={v}\n" for k, v in pins.items()))
    H.write_private(d / "physical-recovery.attestation", attestation_text(support))
    H.write_private(d / "k_c2d", H.FIXTURE_C2D + "\n")
    H.write_private(d / "k_d2c", H.FIXTURE_D2C + "\n")
    H.write_private(d / "wifi.psk", H.FIXTURE_WIFI_PSK + "\n")
    H.write_private(d / "mqtt.pass", H.FIXTURE_MQTT_PASS + "\n")
    return d


def stage_env(base: Path, *, hardware: bool = False, **overrides: str) -> dict[str, str]:
    support = H.make_support_files(base)
    inputs = make_inputs(base, support, port=HW.BOUND_PORT if hardware else H.FIXTURE_SERIAL_PORT)
    env = os.environ.copy()
    for stale in list(env):
        if stale.startswith("AEGIS_L8P_"):
            env.pop(stale)
    env.update({
        "AEGIS_L8P_INPUT_DIR": str(inputs), "AEGIS_L8P_WORK_DIR": str(base / "work"), "AEGIS_L8P_EVIDENCE_DIR": str(base / "evidence"),
        "AEGIS_L8P_PRE_EVIDENCE_DIR": str(make_pre_evidence(base)), "AEGIS_L8P_BACKEND": "hardware" if hardware else "fixture",
        "AEGIS_L8P_PARTITION_TABLE": str(support["partition_table"]), "AEGIS_L8P_SECRETS_HEADER": str(support["secrets_header"]),
        "AEGIS_L8P_FIRMWARE_IMAGE": str(support["firmware_image"]), "AEGIS_L8P_FIRMWARE_BUILD_CMD": "pio run -e esp32dev",
        "AEGIS_L8P_NVS_PARTITION_GEN": str(support["nvs_gen"]), "AEGIS_L8P_WIFI_SSID": H.FIXTURE_WIFI_SSID, "AEGIS_L8P_NTP": H.FIXTURE_NTP,
        "AEGIS_L8P_RUN_ID": "l8p-fixture-run-0001",
    })
    if not hardware:
        env["AEGIS_L8P_FIXTURE_DEVICE"] = str(support["fixture_device"])
    env.update(overrides)
    return env


def run(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(STAGE / script)], text=True, capture_output=True, check=False, env=env)


def out(res: subprocess.CompletedProcess) -> str:
    return (res.stdout or "") + (res.stderr or "")


def device_files(env: dict[str, str]) -> list[str]:
    flash = Path(env["AEGIS_L8P_WORK_DIR"]) / "fixture-flash"
    return sorted(p.name for p in flash.glob("*")) if flash.exists() else []


def bundle(env: dict[str, str]) -> dict:
    files = list(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json"))
    assert len(files) == 1, files
    assert files[0].name == f"l8p-{env['AEGIS_L8P_RUN_ID']}.json", files[0].name
    return json.loads(files[0].read_text())


def refuses_before_write(tmp_path: Path, expect: str, mutate=None, **env_over: str) -> None:
    env = stage_env(tmp_path, **env_over)
    if mutate:
        mutate(env)
    res = run("apply.sh", env)
    assert res.returncode != 0, out(res)
    assert expect.lower() in out(res).lower(), out(res)
    assert not (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").exists(), "no first-write marker before a refused gate"
    assert device_files(env) == [], "no device write before a refused gate"
    assert not list(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json")) if Path(env["AEGIS_L8P_EVIDENCE_DIR"]).exists() else True


def edit_input(env, name, fn):
    p = Path(env["AEGIS_L8P_INPUT_DIR"]) / name
    H.write_private(p, fn(p.read_text()))


# ── python-level hardware flow on the canonical backend (fake executor, injected verifier) ──────────────────────────────


def hw_args(env):
    mod = load_module()
    argv = ["provision", "--input-dir", env["AEGIS_L8P_INPUT_DIR"], "--work-dir", env["AEGIS_L8P_WORK_DIR"],
            "--evidence-dir", env["AEGIS_L8P_EVIDENCE_DIR"], "--backend", "hardware", "--partition-table", env["AEGIS_L8P_PARTITION_TABLE"],
            "--secrets-header", env["AEGIS_L8P_SECRETS_HEADER"], "--firmware-image", env["AEGIS_L8P_FIRMWARE_IMAGE"],
            "--build-command", env["AEGIS_L8P_FIRMWARE_BUILD_CMD"], "--nvs-generator", env["AEGIS_L8P_NVS_PARTITION_GEN"],
            "--wifi-ssid", env["AEGIS_L8P_WIFI_SSID"], "--ntp", env["AEGIS_L8P_NTP"], "--run-id", env["AEGIS_L8P_RUN_ID"],
            "--esptool", HW.FAKE_ESPTOOL, "--live-authorized", "YES"]
    return mod.build_parser().parse_args(argv)


class Ex(HW.FakeExecutor):
    def __init__(self, mod, *, corrupt_addr=None, fail_read_addr=None, **kw):
        super().__init__(mod, **kw)
        self.corrupt_addr, self.fail_read_addr = corrupt_addr, fail_read_addr
        self.events = None

    def run(self, argv, timeout=None):
        argv = [str(a) for a in argv]
        if self.events is not None:
            self.events.append(self.sub(argv))
        if "read_flash" in argv:
            i = argv.index("read_flash")
            addr = int(argv[i + 1], 0)
            if addr == self.fail_read_addr:
                self.calls.append(argv)
                return self.mod.ExecResult(2, HW.EXEC_CANARY, HW.EXEC_CANARY)
            result = super().run(argv, timeout)
            if addr == self.corrupt_addr:
                path = Path(argv[i + 3])
                data = path.read_bytes()
                path.write_bytes(bytes([data[0] ^ 0xFF]) + data[1:])
            return result
        return super().run(argv, timeout)


def run_hw(tmp_path, *, verifier=None, events=None, **ex_kw):
    mod = load_module()
    env = stage_env(tmp_path, hardware=True)
    ex = Ex(HW.load_mod(), work_dir=env["AEGIS_L8P_WORK_DIR"], **ex_kw)
    ex.events = events
    if verifier is None:
        verifier = (lambda: "PASS")
    try:
        rc = mod.provision(hw_args(env), executor=ex, boot_verifier=verifier)
    except mod.L8Error as exc:
        rc = ("L8Error", str(exc))
    return mod, env, ex, rc


def hard_resets(ex):
    return [c for c in ex.calls if c[c.index("--after") + 1] == "hard_reset"]


# ═════════════════════════════════════════ 1. registration, order and the stage gate ═════════════════════════════════════════


def test_stage_id_is_registered_between_l7u_and_l8_and_l7u_is_intact() -> None:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    stages = line.split('"')[1].split()
    assert stages[stages.index("L6c"):stages.index("L9") + 1] == ["L6c", "L7", "L7u", "L8p", "L8", "L9"]


def test_stage_handler_directory_is_exactly_the_reviewed_files_and_registered() -> None:
    assert {p.name for p in STAGE.iterdir() if p.is_file()} == HANDLER_FILES
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}'; p4_stage_handler_status L8p; p4_stage_known L8p && p4_stage_mutates L8p && echo MUT"],
                         text=True, capture_output=True, check=False)
    assert res.stdout.split() == ["REGISTERED", "MUT"]


def test_allow_files_carry_zero_active_entries() -> None:
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        assert [l for l in (STAGE / name).read_text().splitlines() if l.strip() and not l.startswith("#")] == []


def test_stage_owns_its_extra_field_and_l8_and_l7u_are_unchanged() -> None:
    res = subprocess.run(["bash", "-c", f". '{P4_LIB}'; echo \"L8p=[$(p4_stage_auth_extra L8p)] L8=[$(p4_stage_auth_extra L8)] L7u=[$(p4_stage_auth_extra L7u)]\""],
                         text=True, capture_output=True, check=False)
    assert res.stdout.strip() == "L8p=[physical_recovery_attestation] L8=[recovery_authorization] L7u=[]"


EXTRA_L8P = "physical_recovery_attestation=https://example.invalid/aegis-physical-recovery\n"


def _base(stage: str, **over) -> str:
    return "".join(l for l in harness.auth_record(stage, **over).splitlines(True) if not l.startswith("physical_recovery_attestation="))


def _auth(stage: str, **over) -> str:
    return _base(stage, **over) + (EXTRA_L8P if stage == "L8p" else "")


def _gate(tmp_path: Path, stage: str, auth, k3, mode: str = "live"):
    return harness.gate(tmp_path, "--stage", stage, "--mode", mode, auth=auth, k3=k3)


def test_gate_accepts_a_same_day_authorization_with_the_extra_field_and_k3(tmp_path: Path) -> None:
    res = _gate(tmp_path, "L8p", _auth("L8p"), harness.k3v2_record("L8p"))
    assert res.returncode == 0, res.stdout + res.stderr
    for line in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "K3_RECORD_VERSION=V2", "ROLLBACK_HANDLER=REGISTERED", "LIVE_STAGE_AUTHORIZED=NO"):
        assert line in res.stdout.splitlines()
    assert _gate(tmp_path, "L8p", _auth("L8p"), harness.k3_record("L8p")).returncode == 0


def test_gate_requires_k3_and_the_extra_field_and_refuses_other_stages_fields(tmp_path: Path) -> None:
    harness.gate_fail(_gate(tmp_path, "L8p", _auth("L8p"), None), "K3_MISSING")
    harness.gate_fail(_gate(tmp_path, "L8p", _base("L8p"), harness.k3v2_record("L8p")), "AUTHORIZATION_MALFORMED")
    for bad in ("physical_recovery_attestation=TODO-fill-me", "physical_recovery_attestation=x"):
        harness.gate_fail(_gate(tmp_path, "L8p", _base("L8p") + bad + "\n", harness.k3v2_record("L8p")), "AUTHORIZATION_MALFORMED")
    for field in ("recovery_authorization=https://example.invalid/r", "d6_notice=pub", "integration_review=kla"):
        harness.gate_fail(_gate(tmp_path, "L8p", _auth("L8p") + field + "\n", harness.k3v2_record("L8p")), "AUTHORIZATION_MALFORMED")


@pytest.mark.parametrize("stage", ["L1", "L2", "L7", "L7u", "L8", "L9"])
def test_the_physical_recovery_field_is_l8p_only(tmp_path: Path, stage: str) -> None:
    harness.gate_fail(_gate(tmp_path, stage, _base(stage) + EXTRA_L8P, harness.k3v2_record(stage), mode="simulate"), "AUTHORIZATION_MALFORMED")


def test_gate_rejects_stale_and_mismatched_records(tmp_path: Path) -> None:
    harness.gate_fail(_gate(tmp_path, "L8p", _auth("L8p", date=harness.today(-1)), harness.k3v2_record("L8p")), "AUTHORIZATION_STALE")
    harness.gate_fail(_gate(tmp_path, "L8p", _base("L8") + EXTRA_L8P, harness.k3v2_record("L8p")), "AUTHORIZATION_STAGE_MISMATCH")
    harness.gate_fail(_gate(tmp_path, "L8p", _auth("L8p"), harness.k3v2_record("L8")), "K3_STAGE_MISMATCH")
    harness.gate_fail(_gate(tmp_path, "L8p", _auth("L8p"), harness.k3v2_record("L8p", date=harness.today(-1))), "K3_STALE")


# ═════════════════════════════════════════ 2. canonical reuse (no second backend) ═══════════════════════════════════════════


def test_importing_and_validating_never_touches_a_device(tmp_path: Path, monkeypatch) -> None:
    def boom(*a, **k):
        raise AssertionError("a process was started")

    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    mod = load_module()
    env = stage_env(tmp_path)
    support = H.make_support_files(tmp_path / "x")
    mod.build_profile()
    mod.parse_physical_recovery_attestation(Path(env["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation")
    mod.parse_pins(Path(env["AEGIS_L8P_INPUT_DIR"]) / "provisioning.pins")
    assert support["firmware_image"].exists()


def test_l8p_module_is_thin_and_defines_no_device_backend() -> None:
    tree = ast.parse(MODULE_PATH.read_text())
    classes = {n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef)}
    assert classes == set(), f"L8p must not define classes (no second backend/executor/verifier): {classes}"
    imports = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imports |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert not imports & {"subprocess", "socket", "paho", "serial", "esptool", "os", "shutil", "ssl", "threading"}
    code = "\n".join(l for l in MODULE_PATH.read_text().splitlines() if not l.lstrip().startswith("#"))
    code = re.sub(r'""".*?"""', "", code, flags=re.DOTALL)
    for banned in ("shell=True", "write_flash", "read_flash", "erase", "esptool", "hard_reset", "no_reset", "mosquitto", "aegisctl"):
        assert banned not in code, banned


def test_the_canonical_hardware_flow_is_what_runs(tmp_path: Path, monkeypatch) -> None:
    mod = load_module()
    seen = {}
    original = mod.L8.load_backend

    def spy(*a, **k):
        device = original(*a, **k)
        seen["device"] = device
        return device

    monkeypatch.setattr(mod.L8, "load_backend", spy)
    _, _env, ex, rc = run_hw(tmp_path)
    assert rc == 0, rc
    assert type(seen["device"]) is mod.L8.HardwareDevice, "the device is the canonical HardwareDevice"
    assert mod.L8.__spec__.origin == str(CANON_PATH), "the flow is the merged p4-l8-device.py"
    assert isinstance(ex, HW.FakeExecutor), "the canonical executor seam is used (no second executor)"


def test_the_default_l8_profile_is_unchanged_and_d4_gated(tmp_path: Path) -> None:
    mod = load_module()
    p = mod.L8.L8_PROFILE
    assert p.name == "L8" and p.evidence_prefix == "l8" and p.recovery_gate is mod.L8._d4_recovery_gate
    assert p.pre_device_gate is None and p.nvs_gate is None
    env = H.l8_env(tmp_path)
    (Path(env["AEGIS_L8_INPUT_DIR"]) / "d4.attestation").unlink()
    assert H.run_apply(env).returncode != 0, "normal L8 still requires D4"


def test_a_stage_profile_must_supply_its_recovery_gate_and_hooks_fail_closed(tmp_path: Path) -> None:
    mod = load_module()
    env = stage_env(tmp_path)
    args = mod.build_parser().parse_args(["provision", "--input-dir", env["AEGIS_L8P_INPUT_DIR"], "--work-dir", env["AEGIS_L8P_WORK_DIR"],
                                          "--evidence-dir", env["AEGIS_L8P_EVIDENCE_DIR"], "--backend", "fixture", "--fixture-device",
                                          env["AEGIS_L8P_FIXTURE_DEVICE"], "--partition-table", env["AEGIS_L8P_PARTITION_TABLE"],
                                          "--secrets-header", env["AEGIS_L8P_SECRETS_HEADER"], "--firmware-image", env["AEGIS_L8P_FIRMWARE_IMAGE"],
                                          "--build-command", "pio run", "--nvs-generator", env["AEGIS_L8P_NVS_PARTITION_GEN"],
                                          "--wifi-ssid", "s", "--ntp", H.FIXTURE_NTP, "--run-id", "r1"])
    with pytest.raises(mod.L8Error):
        mod.L8.provision(args, stage_profile=None)
    with pytest.raises(mod.L8Error):
        mod.L8.provision(args, stage_profile=mod.L8.StageProfile(name="X", recovery_gate=None))

    def exploding(*a):
        raise RuntimeError("boom")

    with pytest.raises(mod.L8Error, match="failed closed"):
        mod.L8.provision(args, stage_profile=mod.L8.StageProfile(name="X", recovery_gate=exploding))
    assert not (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").exists()


# ═════════════════════════════════════════ 3. fixture happy path, evidence and scope claims ═════════════════════════════════


def test_fixture_provisioning_succeeds_with_the_canonical_12_field_evidence_named_l8p(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    res = run("apply.sh", env)
    assert res.returncode == 0, out(res)
    for line in ("L8P_FLASH_RESULT=PASS", "L8P_NVS_READBACK_MATCH=PASS", "L8P_FIRMWARE_READBACK_MATCH=PASS", "L8P_PROVISIONING_ONLY=YES",
                 "HOST_PRE_TO_RB_ZERO_DRIFT=YES", "L8P_APPLY=COMPLETE"):
        assert line in res.stdout.splitlines(), (line, out(res))
    b = bundle(env)
    assert set(b) == H.EVIDENCE_ALLOWED_FIELDS and len(b) == 12 and "stage" not in b
    assert b["failure_boundary"] == "NONE" and b["device_mac"] == H.FIXTURE_MAC and b["firmware_readback_match"] == "PASS"
    assert oct(next(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json")).stat().st_mode & 0o777) == "0o600"
    assert (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").is_file()
    assert run("verify.sh", env).returncode == 0 and len(device_files(env)) == 2


def test_no_d4_attestation_is_needed_or_read(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    assert not (Path(env["AEGIS_L8P_INPUT_DIR"]) / "d4.attestation").exists()
    assert run("apply.sh", env).returncode == 0
    for script in ("apply.sh", "verify.sh", "rollback.sh"):
        code = "\n".join(l for l in (STAGE / script).read_text().splitlines() if not l.lstrip().startswith("#"))
        assert "d4.attestation" not in code and "d4_live" not in code


def test_outputs_and_evidence_make_no_acceptance_claim_and_hold_no_secret(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    res = run("apply.sh", env)
    text = out(res) + next(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json")).read_text() + out(run("verify.sh", env))
    for secret in SECRETS:
        assert secret not in text
    assert not ACCEPTANCE_CLAIM.search(text)
    for no in ("RECOVERY_R1_R8_PROVEN=NO", "LVR_PROVEN=NO", "L8_ACCEPTANCE=NO", "L9_PROVEN=NO", "D4_LIVE_VERIFIED=NO", "ELECTRICAL_RELAY_PROOF=NO"):
        assert no in res.stdout.splitlines()
    assert "L8_FLASH_RESULT" not in res.stdout, "canonical L8_ lines are relabelled so an L8p run is never mistaken for L8"


def test_verify_fails_on_a_tampered_or_failed_bundle(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    assert run("apply.sh", env).returncode == 0
    path = next(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json"))
    good = json.loads(path.read_text())
    for field, value in (("flash_result", "FAIL"), ("nvs_readback_match", "FAIL"), ("firmware_readback_match", "FAIL"),
                         ("boot_verification_result", "NOT_PROVEN"), ("failure_boundary", "DEVICE_WRITE")):
        path.write_text(json.dumps({**good, field: value}))
        assert run("verify.sh", env).returncode != 0, field
    path.write_text(json.dumps({**good, "stage": "L8p"}))
    assert run("verify.sh", env).returncode != 0, "a 13th field is refused: the canonical schema is exactly 12 fields"
    path.write_text(json.dumps(good))
    path.rename(path.with_name("l8-x.json"))
    assert run("verify.sh", env).returncode != 0, "the file name must mark L8p"


# ═════════════════════════════════════════ 4. gates that refuse BEFORE the first write ══════════════════════════════════════


def test_hardware_is_unreachable_without_live_authorization_and_a_pinned_tool(tmp_path: Path) -> None:
    env = stage_env(tmp_path, hardware=True)
    res = run("apply.sh", env)
    assert res.returncode != 0 and "AEGIS_L8P_LIVE_AUTHORIZED" in out(res)
    assert device_files(env) == [] and not (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").exists()
    env2 = stage_env(tmp_path / "b", hardware=True, AEGIS_L8P_LIVE_AUTHORIZED="YES")
    assert "AEGIS_L8P_ESPTOOL" in out(run("apply.sh", env2))
    mod = load_module()
    env3 = stage_env(tmp_path / "c", hardware=True)
    args = hw_args(env3)
    args.live_authorized = "NO"
    with pytest.raises(mod.L8Error):
        mod.provision(args, executor=Ex(HW.load_mod()), boot_verifier=lambda: "PASS")


def test_fixture_backend_refuses_a_dev_node_and_unknown_backends(tmp_path: Path) -> None:
    assert run("apply.sh", stage_env(tmp_path, AEGIS_L8P_FIXTURE_DEVICE="/dev/ttyUSB0")).returncode != 0
    assert run("apply.sh", stage_env(tmp_path / "u", AEGIS_L8P_BACKEND="bogus")).returncode != 0


def test_missing_attestation_refuses(tmp_path: Path) -> None:
    refuses_before_write(tmp_path, "physical-recovery.attestation", lambda e: (Path(e["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation").unlink())


@pytest.mark.parametrize("name,over", [
    ("stage_not_l8p", {"stage": "L8"}), ("wrong_mac", {"expected_mac": "aa:bb:cc:dd:ee:ff"}), ("bad_class", {"procedure_class": "AUTOMATIC"}),
    ("placeholder_id", {"procedure_id": "TODO-fill-me"}), ("firmware_sha_mismatch", {"firmware_sha256": "0" * 64}),
    ("partition_sha_mismatch", {"partition_table_sha256": "1" * 64}), ("future_date", {"approved_on": "2999-01-01"}),
    ("bad_date", {"approved_on": "2026-13-45"}), ("not_d4_ack_no", {"ack_not_d4": "NO"}), ("recovery_claim_ack_no", {"ack_no_recovery_claim": "NO"}),
    ("lvr_ack_no", {"ack_no_lvr_claim": "NO"}), ("l8_ack_no", {"ack_no_l8_acceptance_claim": "NO"}), ("relay_ack_no", {"ack_no_electrical_relay_claim": "NO"}),
    ("manual_ack_no", {"ack_manual_out_of_band": "NO"}), ("no_serial_recovery", {"physical_serial_recovery": "NO"}),
    ("no_rom_recovery", {"rom_bootloader_recovery": "NO"}), ("no_power_cycle", {"power_cycle_capable": "NO"}),
    ("no_download_mode", {"download_mode_entry": "NO"}), ("no_reviewed_serial", {"owner_reviewed_serial_access": "NO"}),
    ("no_reflash", {"reflash_pinned_artifacts": "NO"}), ("no_interrupted_write", {"interrupted_write_recovery": "NO"}),
    ("depends_on_production", {"depends_on_production": "YES"}), ("depends_on_mqtt", {"depends_on_mqtt": "YES"}),
    ("depends_on_network", {"depends_on_network": "YES"}), ("auto_rollback", {"automatic_rollback": "YES"}),
    ("legacy_fallback", {"legacy_firmware_fallback": "YES"}), ("plaintext_1883", {"plaintext_1883": "YES"}), ("remote", {"remote_recovery": "YES"}),
])
def test_invalid_physical_recovery_attestation_refuses(tmp_path: Path, name: str, over: dict) -> None:
    def mutate(e):
        support = {"firmware_image": Path(e["AEGIS_L8P_FIRMWARE_IMAGE"]), "partition_table": Path(e["AEGIS_L8P_PARTITION_TABLE"])}
        H.write_private(Path(e["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation", attestation_text(support, **over))
    refuses_before_write(tmp_path, "physical-recovery", mutate)


@pytest.mark.parametrize("body", ["WRONG_MAGIC\n", "", "AEGIS_P4_L8P_PHYSICAL_RECOVERY_ATTESTATION_V1\nstage=L8p\n"])
def test_malformed_attestation_refuses(tmp_path: Path, body: str) -> None:
    refuses_before_write(tmp_path, "physical-recovery", lambda e: H.write_private(Path(e["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation", body))


def test_attestation_rejects_unknown_keys_and_secret_like_extras(tmp_path: Path) -> None:
    def mutate(e):
        p = Path(e["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation"
        H.write_private(p, p.read_text() + "wifi_psk=hunter2-secret\n")
    refuses_before_write(tmp_path, "physical-recovery", mutate)


def test_attestation_and_pins_must_be_owner_only(tmp_path: Path) -> None:
    refuses_before_write(tmp_path, "mode", lambda e: (Path(e["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation").chmod(0o644))
    refuses_before_write(tmp_path / "p", "mode", lambda e: (Path(e["AEGIS_L8P_INPUT_DIR"]) / "provisioning.pins").chmod(0o640))


def test_mac_mismatch_between_binding_and_device_aborts_before_the_first_write(tmp_path: Path) -> None:
    def mutate(e):
        d = json.loads(Path(e["AEGIS_L8P_FIXTURE_DEVICE"]).read_text())
        Path(e["AEGIS_L8P_FIXTURE_DEVICE"]).write_text(json.dumps({**d, "mac": "aa:bb:cc:dd:ee:ff"}))
    refuses_before_write(tmp_path, "mac", mutate)


@pytest.mark.parametrize("port", ["/dev/sda", "ttyUSB0", "/dev/ttyUSB0; rm -rf /", "/tmp/ttyUSB0"])
def test_serial_device_must_be_an_exact_tty_path_from_the_binding(tmp_path: Path, port: str) -> None:
    refuses_before_write(tmp_path, "serial_port", lambda e: H.write_private(
        Path(e["AEGIS_L8P_INPUT_DIR"]) / "device.identity", f"expected_mac={H.FIXTURE_MAC}\nserial_port={port}\n"))


def test_firmware_and_partition_digest_mismatch_abort(tmp_path: Path) -> None:
    refuses_before_write(tmp_path, "firmware", lambda e: Path(e["AEGIS_L8P_FIRMWARE_IMAGE"]).write_bytes(b"\xe9different-firmware-image"))
    refuses_before_write(tmp_path / "t", "partition", lambda e: Path(e["AEGIS_L8P_PARTITION_TABLE"]).write_text(H.PARTITION_TABLE + "# changed\n"))


@pytest.mark.parametrize("pin,value", [("nvs_offset", "0x9000"), ("nvs_size", "0x4000"), ("app_offset", "0x10000"), ("app_size", "0x100000")])
def test_partition_geometry_must_equal_the_pinned_geometry(tmp_path: Path, pin: str, value: str) -> None:
    refuses_before_write(tmp_path, "geometry", lambda e: edit_input(e, "provisioning.pins", lambda t: re.sub(rf"^{pin}=.*$", f"{pin}={value}", t, flags=re.MULTILINE)))


@pytest.mark.parametrize("pin,value", [("nvs_namespace", "aegis-p2"), ("nvs_schema", "2")])
def test_nvs_schema_and_namespace_are_pinned_exactly(tmp_path: Path, pin: str, value: str) -> None:
    refuses_before_write(tmp_path, "nvs", lambda e: edit_input(e, "provisioning.pins", lambda t: re.sub(rf"^{pin}=.*$", f"{pin}={value}", t, flags=re.MULTILINE)))


@pytest.mark.parametrize("line", ["", "bogus_key=1"])
def test_pins_file_is_strict(tmp_path: Path, line: str) -> None:
    refuses_before_write(tmp_path, "pins", lambda e: edit_input(e, "provisioning.pins", lambda t: t.replace("nvs_schema=1\n", "") if line == "" else t + line + "\n"))


def test_overlapping_or_misaligned_pinned_regions_refuse() -> None:
    mod = load_module()
    for nvs, app in (((0xB000, 0x5000), (0xC000, 0x180000)), ((0xB001, 0x5000), (0x20000, 0x180000)), ((0xB000, 0x5000), (0x20100, 0x180000))):
        with pytest.raises(mod.L8Error):
            mod.validate_geometry_layout(nvs=nvs, app=app)
    mod.validate_geometry_layout(nvs=(0xB000, 0x5000), app=(0x20000, 0x180000))


def test_placeholder_ca_demo_keys_and_build_verbs_are_refused_by_the_canonical_gates(tmp_path: Path) -> None:
    refuses_before_write(tmp_path, "placeholder", lambda e: Path(e["AEGIS_L8P_SECRETS_HEADER"]).write_text(
        '#define SECRET_MQTT_CA_CERT "-----BEGIN CERTIFICATE-----\\nREPLACE_WITH_REAL_CA\\n-----END CERTIFICATE-----\\n"\n'))
    demo = hashlib.sha256(b"AEGIS-DEMO-SHARED-SECRET-change-me").hexdigest()
    refuses_before_write(tmp_path / "k", "demo", lambda e: H.write_private(Path(e["AEGIS_L8P_INPUT_DIR"]) / "k_c2d", demo + "\n"))
    for i, verb in enumerate(("upload", "erase_flash", "write_flash", "write_mem", "espefuse")):
        refuses_before_write(tmp_path / f"v{i}", "forbidden verb", AEGIS_L8P_FIRMWARE_BUILD_CMD=f"pio run -e esp32dev {verb}")


def test_nvs_csv_schema_is_exact_with_no_address_field(tmp_path: Path) -> None:
    mod = load_module()
    prov = mod.L8.load_nvs_provisioner()
    base = tmp_path / "ok.csv"
    prov.render_nvs_csv({"schema": 1, "device_id": "d", "wifi_ssid": "s", "wifi_psk": "p", "broker": "b", "mqtt_user": "u", "mqtt_pass": "m",
                         "ntp": "203.0.113.9", "k_c2d": bytes(32), "k_d2c": bytes(32), "seq_hi": 0}, base)
    mod.validate_nvs_csv(base, prov, "aegis-p1", 1)
    text = base.read_text()
    for extra in ("ip", "gw", "mask", "dns", "netmask", "gateway", "static"):
        bad = tmp_path / f"bad-{extra}.csv"
        bad.write_text(text + f"{extra},data,string,10.0.0.9\n")
        with pytest.raises(mod.L8Error):
            mod.validate_nvs_csv(bad, prov, "aegis-p1", 1)
    missing = tmp_path / "missing.csv"
    missing.write_text("\n".join(l for l in text.splitlines() if not l.startswith("seq_hi")) + "\n")
    for args in ((missing, "aegis-p1", 1), (base, "aegis-p2", 1), (base, "aegis-p1", 2)):
        with pytest.raises(mod.L8Error):
            mod.validate_nvs_csv(args[0], prov, args[1], args[2])


def test_pre_evidence_must_exist_complete_and_unmodified(tmp_path: Path) -> None:
    refuses_before_write(tmp_path, "pre", lambda e: Path(e["AEGIS_L8P_PRE_EVIDENCE_DIR"]).joinpath("capture.log").write_text("L0_CAPTURE=INCOMPLETE\n"))
    refuses_before_write(tmp_path / "b", "pre", lambda e: Path(e["AEGIS_L8P_PRE_EVIDENCE_DIR"]).joinpath("SHA256SUMS").unlink())
    (tmp_path / "c").mkdir()
    env = stage_env(tmp_path / "c")
    make_pre_evidence(tmp_path / "c", tamper=True)
    res = run("apply.sh", env)
    assert res.returncode != 0 and device_files(env) == []
    for var in ("AEGIS_L8P_PRE_EVIDENCE_DIR", "AEGIS_L8P_FIRMWARE_IMAGE", "AEGIS_L8P_RUN_ID"):
        (tmp_path / var).mkdir()
        e2 = stage_env(tmp_path / var)
        e2.pop(var)
        assert run("apply.sh", e2).returncode != 0


# ═════════════════════════════════════════ 5. canonical hardware flow: readbacks, one reset, boot verifier, failure policy ═════


def test_hardware_flow_reads_back_nvs_and_firmware_and_resets_exactly_once(tmp_path: Path) -> None:
    _mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0, rc
    assert ex.subcommands() == FULL
    assert len(hard_resets(ex)) == 1 and hard_resets(ex)[0] is ex.calls[-1] and ex.sub(ex.calls[-1]) == "flash_id"
    reads = [(int(c[c.index("read_flash") + 1], 0), int(c[c.index("read_flash") + 2], 0)) for c in ex.calls if "read_flash" in c]
    image_len = len(Path(env["AEGIS_L8P_FIRMWARE_IMAGE"]).read_bytes())
    assert reads == [(NVS_OFFSET, NVS_SIZE), (APP_OFFSET, image_len)]
    b = bundle(env)
    assert b["nvs_readback_match"] == "PASS" and b["firmware_readback_match"] == "PASS" and b["flash_result"] == "PASS"
    assert b["boot_verification_result"] == "PASS" and set(b) == H.EVIDENCE_ALLOWED_FIELDS


@pytest.mark.parametrize("kw,field,boundary", [
    ({"corrupt_addr": NVS_OFFSET}, "nvs_readback_match", "NVS_READBACK"), ({"corrupt_addr": APP_OFFSET}, "firmware_readback_match", "FIRMWARE_READBACK"),
    ({"fail_read_addr": NVS_OFFSET}, "nvs_readback_match", "NVS_READBACK"), ({"fail_read_addr": APP_OFFSET}, "firmware_readback_match", "FIRMWARE_READBACK"),
])
def test_a_failed_readback_is_fail_secure_hold_with_no_reset_retry_or_reflash(tmp_path: Path, kw, field, boundary) -> None:
    _mod, env, ex, rc = run_hw(tmp_path, **kw)
    assert rc != 0
    b = bundle(env)
    assert b[field] == "FAIL" and b["failure_boundary"] == boundary
    assert hard_resets(ex) == [] and ex.subcommands().count("write_flash") == 2
    assert ex.subcommands()[-1] == "read_flash"
    res = run("rollback.sh", env)
    assert "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout and "L8P_DEVICE_ACTION_TAKEN=NONE" in res.stdout


@pytest.mark.parametrize("which", [1, 2])
def test_a_device_write_failure_still_writes_evidence_with_no_retry(tmp_path: Path, which: int) -> None:
    _mod, env, ex, rc = run_hw(tmp_path, fail_write_number=which)
    assert rc != 0
    b = bundle(env)
    assert b["flash_result"] == "FAIL" and b["failure_boundary"] == "DEVICE_WRITE"
    assert ex.subcommands().count("write_flash") == which and hard_resets(ex) == [] and "read_flash" not in ex.subcommands()


def test_first_write_marker_precedes_the_first_write_and_follows_every_gate(tmp_path: Path) -> None:
    mod, _env, ex, rc = run_hw(tmp_path)
    assert ex.marker_present_at_first_write is True
    _mod2, _env2, _ex2, rc2 = run_hw(tmp_path / "bad", corrupt_addr=None)
    assert rc == 0 and rc2 == 0
    env3 = stage_env(tmp_path / "gate", hardware=True)
    (Path(env3["AEGIS_L8P_INPUT_DIR"]) / "physical-recovery.attestation").unlink()
    ex3 = Ex(HW.load_mod(), work_dir=env3["AEGIS_L8P_WORK_DIR"])
    with pytest.raises(mod.L8Error):
        mod.provision(hw_args(env3), executor=ex3, boot_verifier=lambda: "PASS")
    assert ex3.calls == [], "a refused recovery gate happens before ANY device access"
    assert not (Path(env3["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").exists()


def test_identity_is_observed_before_any_write_and_a_wrong_mac_writes_nothing(tmp_path: Path) -> None:
    mod = load_module()
    env = stage_env(tmp_path, hardware=True)
    ex = Ex(HW.load_mod(), work_dir=env["AEGIS_L8P_WORK_DIR"], identity_text=HW.flash_id_text(mac="aa:bb:cc:dd:ee:ff"))
    with pytest.raises(mod.L8Error, match="mac"):
        mod.provision(hw_args(env), executor=ex, boot_verifier=lambda: "PASS")
    assert ex.subcommands() == ["flash_id"] and not (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").exists()


def test_the_signed_boot_verifier_is_the_canonical_one_armed_before_the_first_write(tmp_path: Path) -> None:
    bv = BV.load_bv()
    clock = BV.FakeClock()
    events: list[str] = []
    verifier = BV.make_verifier(bv, clock, [BV.status()], events=events)[0]
    _mod, env, _ex, rc = run_hw(tmp_path, verifier=verifier, events=events)
    assert rc == 0, rc
    assert events.index("flash_id") < events.index("arm") < events.index("write_flash")
    assert events.count("flash_id") == 2 and events.index("poll") > max(i for i, e in enumerate(events) if e in ("read_flash", "flash_id"))
    assert bundle(env)["boot_verification_result"] == "PASS"


@pytest.mark.parametrize("verdict", ["FAIL", "NOT_PROVEN"])
def test_a_non_pass_boot_verification_is_recorded_and_held_secure(tmp_path: Path, verdict: str) -> None:
    _mod, env, ex, rc = run_hw(tmp_path, verifier=lambda: verdict)
    assert rc != 0
    b = bundle(env)
    assert b["boot_verification_result"] == verdict and b["failure_boundary"] == "BOOT_VERIFICATION" and b["flash_result"] == "PASS"
    assert ex.subcommands() == FULL, "no retry, reflash, rollback write or restore after a boot failure"


def test_boot_pass_means_only_firmware_reported_lockdown_and_never_electrical_proof(tmp_path: Path) -> None:
    _mod, env, _ex, _rc = run_hw(tmp_path)
    res = run("verify.sh", env)
    assert "ELECTRICAL_RELAY_PROOF=NO" in res.stdout.splitlines()
    text = (STAGE / "apply.sh").read_text() + (STAGE / "verify.sh").read_text()
    assert "ELECTRICAL_RELAY_PROOF=YES" not in text and not re.search(r"RELAY_PROOF=(YES|PASS)", text)


def test_evidence_is_private_write_once_and_free_of_secret_and_firmware_bytes(tmp_path: Path, capsys) -> None:
    mod, env, _ex, _rc = run_hw(tmp_path)
    cap = capsys.readouterr()
    path = next(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json"))
    text = path.read_text() + cap.out + cap.err
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    image = Path(env["AEGIS_L8P_FIRMWARE_IMAGE"]).read_bytes()
    assert image[:24].hex() not in text and HW.EXEC_CANARY not in text
    for secret in SECRETS:
        assert secret not in text
    with pytest.raises(mod.L8Error, match="write-once"):
        mod.provision(hw_args(env), executor=Ex(HW.load_mod(), work_dir=env["AEGIS_L8P_WORK_DIR"]), boot_verifier=lambda: "PASS")


# ═════════════════════════════════════════ 6. rollback ═════════════════════════════════════════════════════════════════════


def test_rollback_before_first_write_removes_only_stage_local_artifacts(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    work = Path(env["AEGIS_L8P_WORK_DIR"])
    work.mkdir(parents=True)
    for name in ("nvs.csv", "nvs.bin"):
        (work / name).write_text("x")
    (work / "unrelated.txt").write_text("keep")
    res = run("rollback.sh", env)
    assert res.returncode == 0 and "L8P_ROLLBACK=COMPLETE" in res.stdout and "L8P_DEVICE_ACTION_TAKEN=NONE" in res.stdout
    assert sorted(p.name for p in work.iterdir()) == ["unrelated.txt"]
    assert run("rollback.sh", env).returncode == 0


def test_rollback_after_first_write_performs_zero_device_mutation(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    assert run("apply.sh", env).returncode == 0
    flash = Path(env["AEGIS_L8P_WORK_DIR"]) / "fixture-flash"
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in flash.iterdir()}
    bindir = tmp_path / "trapbin"
    bindir.mkdir()
    log = tmp_path / "tool-calls.log"
    for tool in ("esptool", "esptool.py", "pio", "python3", "python"):
        (bindir / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\nexit 97\n')
        (bindir / tool).chmod(0o755)
    env2 = {**env, "PATH": f"{bindir}:{env['PATH']}"}
    res = run("rollback.sh", env2)
    assert res.returncode == 0, out(res)
    for line in ("L8P_FIRST_HARDWARE_WRITE=STARTED", "L8P_DEVICE_ACTION_TAKEN=NONE", "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE", "L8P_EVIDENCE_PRESERVED=YES"):
        assert line in res.stdout.splitlines()
    assert not log.exists() and {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in flash.iterdir()} == before
    assert (Path(env["AEGIS_L8P_WORK_DIR"]) / "first-write.marker").is_file() and list(Path(env["AEGIS_L8P_EVIDENCE_DIR"]).glob("*.json"))
    assert run("rollback.sh", env2).returncode == 0


def test_rollback_script_never_references_a_device_tool_or_recovery_action() -> None:
    code = "\n".join(l for l in (STAGE / "rollback.sh").read_text().splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"esptool|pio |python|serial|write_flash|read_flash|erase|restore|RESTORE|CUT|1883|v0|legacy", code.replace("fixture-flash", ""))


# ═════════════════════════════════════════ 7. scope boundaries ═══════════════════════════════════════════════════════════════


def test_stage_files_never_send_cut_or_restore_or_use_plaintext_or_retry() -> None:
    for script in ("apply.sh", "verify.sh", "rollback.sh"):
        code = "\n".join(l for l in (STAGE / script).read_text().splitlines() if not l.lstrip().startswith("#"))
        assert not re.search(r"mosquitto_pub|aegisctl|systemctl|nft |rfkill|nmcli|iptables|sudo|RESTORE|\bCUT\b|1883|erase|efuse|write_mem|retry|reflash", code), script
    apply = "\n".join(l for l in (STAGE / "apply.sh").read_text().splitlines() if not l.lstrip().startswith("#"))
    assert apply.count('p4-l8p-device.py" provision') == 1 and "p4-l8-device.py" not in apply, "one entry point: the thin L8p module"


def test_the_canonical_extension_is_small_and_leaves_the_flow_unchanged() -> None:
    text = CANON_PATH.read_text()
    assert "class StageProfile(NamedTuple)" in text and "L8_PROFILE = StageProfile()" in text
    assert 'recovery_gate: Callable[[argparse.Namespace, Path, dict[str, str]], None] = _d4_recovery_gate' in text
    assert text.count("class HardwareDevice") == 1 and text.count("class SubprocessExecutor") == 1 and text.count("def validate_esptool_argv") == 1
    tree = ast.parse(text)
    docstrings = {id(n.body[0].value) for n in ast.walk(tree) if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef)) and n.body
                  and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    literals = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings]
    assert not [v for v in literals if "l8p" in v.lower()], "no L8p-specific logic or literal in the canonical module"


def test_this_file_never_reaches_real_hardware() -> None:
    text = Path(__file__).read_text()
    assert not re.search(r"^\s*(import|from)\s+(serial|esptool|platformio)\b", text, re.MULTILINE)
