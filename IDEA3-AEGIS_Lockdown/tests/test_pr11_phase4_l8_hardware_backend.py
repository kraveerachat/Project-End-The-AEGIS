"""AEGIS IDEA3 PR11 Phase 4 — L8 real-hardware backend test suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l8-operational-design.md
Capability under test:
  HARDWARE_BACKEND_IMPLEMENTED_REPOSITORY / LIVE_L8_NOT_AUTHORIZED

EVERY test here drives the hardware backend through a FAKE executor. No test
opens a serial device, runs esptool/pio/platformio/arduino-cli, or touches
/dev. The autouse fixture below turns any such attempt into a test failure,
and `test_hardware_tests_never_reach_a_real_device` guards this file's source.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L8_STAGE = DEPLOY / "stages" / "L8"
L8_DEVICE = DEPLOY / "p4-l8-device.py"

# Reuse the fixture-material builders of the handler suite; they are inert.
_HANDLER_TESTS = Path(__file__).with_name("test_pr11_phase4_l8_handler.py")
_spec = importlib.util.spec_from_file_location("l8_handler_tests", str(_HANDLER_TESTS))
assert _spec is not None and _spec.loader is not None
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

# A port that is NOT the ttyUSB0 default anywhere in the repository, so a
# hardcoded or auto-selected port cannot satisfy the binding tests.
BOUND_PORT = "/dev/ttyUSB7"
FAKE_ESPTOOL = "/nonexistent/pinned/tool-esptoolpy/esptool.py"
EXEC_CANARY = "CANARY-EXECUTOR-OUTPUT-DO-NOT-ECHO"

NVS_OFFSET = 0xB000
NVS_SIZE = 0x5000
APP_OFFSET = 0x20000


# ---------------------------------------------------------------------------
# safety net: no test may reach a real device or a flashing tool
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _no_real_device(monkeypatch):
    real_run = subprocess.run
    real_popen = subprocess.Popen
    real_os_open = os.open
    banned = ("esptool", "pio", "platformio", "arduino-cli", "screen", "minicom", "picocom")

    def guard_argv(argv):
        flat = [str(a) for a in (argv if isinstance(argv, (list, tuple)) else [argv])]
        for token in flat:
            if token.startswith("/dev/tty"):
                raise AssertionError(f"test reached a serial device: {token}")
            if Path(token).name.split(".")[0] in banned:
                raise AssertionError(f"test invoked a flashing tool: {token}")

    def safe_run(argv, *a, **kw):
        guard_argv(argv)
        return real_run(argv, *a, **kw)

    def safe_popen(argv, *a, **kw):
        guard_argv(argv)
        return real_popen(argv, *a, **kw)

    def safe_os_open(path, *a, **kw):
        if str(path).startswith("/dev/tty"):
            raise AssertionError(f"test opened a serial device: {path}")
        return real_os_open(path, *a, **kw)

    monkeypatch.setattr(subprocess, "run", safe_run)
    monkeypatch.setattr(subprocess, "Popen", safe_popen)
    monkeypatch.setattr(os, "open", safe_os_open)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load_mod():
    return H.load_device_module()


def flash_id_text(mac=H.FIXTURE_MAC, chip="ESP32-D0WD-V3", size="4MB", port=BOUND_PORT) -> str:
    return (
        "esptool.py v4.11.0\n"
        f"Serial port {port}\n"
        "Connecting....\n"
        "Detecting chip type... ESP32\n"
        f"Chip is {chip} (revision v3.1)\n"
        "Features: WiFi, BT, Dual Core, 240MHz\n"
        "Crystal is 40MHz\n"
        f"MAC: {mac}\n"
        "Uploading stub...\nRunning stub...\nStub running...\n"
        "Manufacturer: 20\nDevice: 4016\n"
        f"Detected flash size: {size}\n"
        "Hard resetting via RTS pin...\n"
    )


class FakeExecutor:
    """Stand-in for the single hardware command executor. Touches no device."""

    def __init__(self, mod, *, identity_text=None, corrupt_readback=False,
                 fail_write_number=None, raise_on=None, work_dir=None):
        self.mod = mod
        self.calls: list[list[str]] = []
        self.flash: dict[int, bytes] = {}
        self.identity_text = identity_text if identity_text is not None else flash_id_text()
        self.corrupt_readback = corrupt_readback
        self.fail_write_number = fail_write_number
        self.raise_on = raise_on
        self.work_dir = work_dir
        self.writes = 0
        self.marker_present_at_first_write = None

    def sub(self, argv):
        for name in ("flash_id", "write_flash", "read_flash"):
            if name in argv:
                return name
        return "unknown"

    def run(self, argv, timeout=None):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        sub = self.sub(argv)
        if self.raise_on == sub:
            raise OSError("fake executor exploded")
        if sub == "flash_id":
            return self.mod.ExecResult(0, self.identity_text, "")
        if sub == "write_flash":
            self.writes += 1
            if self.marker_present_at_first_write is None and self.work_dir is not None:
                self.marker_present_at_first_write = (
                    Path(self.work_dir) / "first-write.marker"
                ).is_file()
            if self.fail_write_number == self.writes:
                return self.mod.ExecResult(2, EXEC_CANARY, EXEC_CANARY)
            i = argv.index("write_flash")
            addr, path = int(argv[i + 1], 0), argv[i + 2]
            self.flash[addr] = Path(path).read_bytes()
            return self.mod.ExecResult(0, EXEC_CANARY, "")
        if sub == "read_flash":
            i = argv.index("read_flash")
            addr, size, path = int(argv[i + 1], 0), int(argv[i + 2], 0), argv[i + 3]
            data = self.flash.get(addr, b"\x00" * size)[:size]
            if self.corrupt_readback:
                data = bytes([data[0] ^ 0xFF]) + data[1:]
            Path(path).write_bytes(data)
            return self.mod.ExecResult(0, EXEC_CANARY, "")
        return self.mod.ExecResult(1, "", "")

    def subcommands(self):
        return [self.sub(c) for c in self.calls]


def hw_env(base: Path, **overrides):
    """Handler env, retargeted at the hardware backend with a bound port."""
    env = H.l8_env(base, AEGIS_L8_BACKEND="hardware", **overrides)
    env.pop("AEGIS_L8_FIXTURE_DEVICE", None)
    H.write_private(
        Path(env["AEGIS_L8_INPUT_DIR"]) / "device.identity",
        f"expected_mac={H.FIXTURE_MAC}\nserial_port={BOUND_PORT}\n",
    )
    return env


def hw_args(mod, env, *, live="YES"):
    argv = H.provision_args(mod, {**env, "AEGIS_L8_FIXTURE_DEVICE": ""})
    # drop the empty fixture descriptor pair
    i = argv.index("--fixture-device")
    del argv[i:i + 2]
    argv += ["--esptool", FAKE_ESPTOOL, "--live-authorized", live]
    return mod.build_parser().parse_args(argv)


def run_hw(tmp_path, *, executor_kw=None, verifier=lambda: "PASS", live="YES",
           env_overrides=None):
    mod = load_mod()
    env = hw_env(tmp_path, **(env_overrides or {}))
    executor = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"], **(executor_kw or {}))
    args = hw_args(mod, env, live=live)
    try:
        rc = mod.provision(args, executor=executor, boot_verifier=verifier)
    except mod.L8Error as exc:
        rc = ("L8Error", str(exc))
    return mod, env, executor, rc


def evidence(env):
    files = list(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    assert len(files) == 1, files
    return files[0], json.loads(files[0].read_text(encoding="utf-8"))


# ===========================================================================
# A. live authorization gate
# ===========================================================================

def test_hardware_backend_inaccessible_without_live_authorization(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path, live="NO")
    assert rc != 0
    assert ex.calls == [], "the executor was invoked without live authorization"
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


def test_load_backend_refuses_hardware_without_authorization(tmp_path):
    mod = load_mod()
    ex = FakeExecutor(mod)
    with pytest.raises(mod.L8Error) as err:
        mod.load_backend(
            "hardware", None, tmp_path / "flash",
            binding={"expected_mac": H.FIXTURE_MAC, "serial_port": BOUND_PORT},
            live_authorized=False, executor=ex, esptool_script=FAKE_ESPTOOL,
            work_dir=tmp_path / "work",
        )
    assert "NOT_AUTHORIZED" in str(err.value)
    assert ex.calls == []


def test_apply_hardware_without_live_flag_is_refused(tmp_path):
    env = hw_env(tmp_path)
    env["AEGIS_L8_ESPTOOL"] = FAKE_ESPTOOL
    res = H.run_apply(env)
    assert res.returncode != 0
    assert "NOT_AUTHORIZED" in H.combined(res)
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


def test_apply_hardware_flag_yes_is_not_enough_without_a_pinned_esptool(tmp_path):
    env = hw_env(tmp_path, AEGIS_L8_LIVE_AUTHORIZED="YES")
    res = H.run_apply(env)  # no AEGIS_L8_ESPTOOL
    assert res.returncode != 0
    assert "ESPTOOL" in H.combined(res).upper()

    env["AEGIS_L8_ESPTOOL"] = str(tmp_path / "missing" / "esptool.py")
    res = H.run_apply(env)
    assert res.returncode != 0

    unpinned = tmp_path / "unpinned" / "esptool.py"
    unpinned.parent.mkdir()
    unpinned.write_text("# not the pinned toolchain\n", encoding="utf-8")
    env["AEGIS_L8_ESPTOOL"] = str(unpinned)
    res = H.run_apply(env)
    assert res.returncode != 0
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


def test_apply_hardware_rejects_a_fixture_descriptor(tmp_path):
    env = hw_env(tmp_path, AEGIS_L8_LIVE_AUTHORIZED="YES", AEGIS_L8_ESPTOOL=FAKE_ESPTOOL)
    env["AEGIS_L8_FIXTURE_DEVICE"] = str(tmp_path / "support" / "fixture-device.json")
    res = H.run_apply(env)
    assert res.returncode != 0


def test_apply_fixture_mode_never_accepts_a_dev_path(tmp_path):
    env = H.l8_env(tmp_path, AEGIS_L8_FIXTURE_DEVICE=BOUND_PORT)
    res = H.run_apply(env)
    assert res.returncode != 0


def test_esptool_resolution_requires_the_pinned_package(tmp_path):
    mod = load_mod()
    pkg = tmp_path / "tool-esptoolpy"
    pkg.mkdir()
    script = pkg / "esptool.py"
    script.write_text("# fake\n", encoding="utf-8")
    with pytest.raises(mod.L8Error):
        mod.resolve_pinned_esptool(str(script))  # no package.json
    (pkg / "package.json").write_text(
        json.dumps({"name": "tool-esptoolpy", "version": "9.9.9"}), encoding="utf-8"
    )
    with pytest.raises(mod.L8Error):
        mod.resolve_pinned_esptool(str(script))  # wrong version
    (pkg / "package.json").write_text(
        json.dumps({"name": "tool-esptoolpy", "version": mod.PINNED_ESPTOOL_PACKAGE[1]}),
        encoding="utf-8",
    )
    assert Path(mod.resolve_pinned_esptool(str(script))) == script


def test_pinned_toolchain_constants_match_platformio_ini():
    mod = load_mod()
    ini = (ROOT / "firmware" / "platformio.ini").read_text(encoding="utf-8")
    assert f"upload_speed = {mod.HARDWARE_BAUD}" in ini
    assert "platform = espressif32@7.0.1" in ini
    assert mod.PINNED_ESPTOOL_PACKAGE == ("tool-esptoolpy", "2.41100.0")


# ===========================================================================
# B. no side effect from import / construction / parsing / validation
# ===========================================================================

def test_import_and_construction_perform_no_tool_invocation(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("subprocess used at import/construction time")

    monkeypatch.setattr(subprocess, "run", boom)
    monkeypatch.setattr(subprocess, "Popen", boom)
    mod = load_mod()
    ex = FakeExecutor(mod)
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path / "work", executor=ex,
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    assert dev.name == "hardware"
    assert ex.calls == []
    mod.parse_esptool_identity(flash_id_text(), BOUND_PORT)
    assert ex.calls == []


# ===========================================================================
# C. wrong MAC aborts before write
# ===========================================================================

def test_wrong_observed_mac_aborts_before_any_write(tmp_path):
    mod, env, ex, rc = run_hw(
        tmp_path, executor_kw={"identity_text": flash_id_text(mac="aa:bb:cc:dd:ee:ff")}
    )
    assert rc != 0
    assert "write_flash" not in ex.subcommands()
    work = Path(env["AEGIS_L8_WORK_DIR"])
    assert not (work / "first-write.marker").exists()
    assert not list(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))


# ===========================================================================
# D. exact serial-port binding
# ===========================================================================

def test_every_tool_call_uses_exactly_the_bound_port(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0, rc
    assert ex.calls
    for argv in ex.calls:
        assert argv.count("--port") == 1
        assert argv[argv.index("--port") + 1] == BOUND_PORT
        assert not any(a.startswith("/dev/") and a != BOUND_PORT for a in argv)


def test_guard_rejects_a_different_port(tmp_path):
    mod = load_mod()
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=FakeExecutor(mod),
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    good = dev.build_argv("flash_id", after="no_reset")
    swapped = [("/dev/ttyUSB0" if a == BOUND_PORT else a) for a in good]
    with pytest.raises(mod.L8Error):
        mod.validate_esptool_argv(swapped, dev.argv_prefix, {}, {}, tmp_path)


def test_hardware_device_rejects_a_non_serial_port(tmp_path):
    mod = load_mod()
    for bad in ("/dev/sda", "/dev/ttyS0", "COM3", "/tmp/x", ""):
        with pytest.raises(mod.L8Error):
            mod.HardwareDevice(
                serial_port=bad, work_dir=tmp_path, executor=FakeExecutor(mod),
                esptool_script=FAKE_ESPTOOL, live_authorized=True,
            )


# ===========================================================================
# E. identity parsing fails closed
# ===========================================================================

def test_identity_parsing_accepts_the_reference_output():
    mod = load_mod()
    assert mod.parse_esptool_identity(flash_id_text(), BOUND_PORT) == {
        "mac": H.FIXTURE_MAC,
        "chip_identity": "ESP32-D0WD-V3",
        "flash_size": "4MB",
    }


@pytest.mark.parametrize(
    "text",
    [
        "",
        "garbage\n",
        flash_id_text().replace(f"MAC: {H.FIXTURE_MAC}\n", ""),
        flash_id_text() + f"MAC: {H.FIXTURE_MAC}\n",
        flash_id_text(mac="24:0a:c4:11:22"),
        flash_id_text(mac="zz:0a:c4:11:22:33"),
        flash_id_text().replace("Chip is ESP32-D0WD-V3 (revision v3.1)\n", ""),
        flash_id_text(chip="ESP8266EX"),
        flash_id_text(chip="ESP32-S3"),
        flash_id_text().replace("Detected flash size: 4MB\n", ""),
        flash_id_text() + "Detected flash size: 8MB\n",
        flash_id_text(size="unknown"),
        flash_id_text(port="/dev/ttyUSB0"),
    ],
)
def test_malformed_or_ambiguous_identity_output_fails_closed(text):
    mod = load_mod()
    with pytest.raises(mod.L8Error):
        mod.parse_esptool_identity(text, BOUND_PORT)


def test_nonzero_identity_command_fails_closed(tmp_path):
    mod = load_mod()
    ex = FakeExecutor(mod)
    ex.run = lambda argv, timeout=None: mod.ExecResult(1, flash_id_text(), EXEC_CANARY)
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=ex,
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    with pytest.raises(mod.L8Error) as err:
        dev.identity()
    assert EXEC_CANARY not in str(err.value)


# ===========================================================================
# F/G/H. exact offsets, no fallback
# ===========================================================================

def _writes(ex):
    out = {}
    for argv in ex.calls:
        if "write_flash" in argv:
            i = argv.index("write_flash")
            out[int(argv[i + 1], 0)] = argv[i + 2]
    return out


def test_nvs_and_firmware_are_written_at_the_derived_offsets(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0, rc
    assert set(ex.flash) == {NVS_OFFSET, APP_OFFSET}, {hex(k) for k in ex.flash}
    assert ex.flash[APP_OFFSET] == Path(env["AEGIS_L8_FIRMWARE_IMAGE"]).read_bytes()
    assert ex.flash[NVS_OFFSET] == (Path(env["AEGIS_L8_WORK_DIR"]) / "nvs.bin").read_bytes()
    assert len(ex.flash[NVS_OFFSET]) == NVS_SIZE


def test_a_table_without_an_nvs_entry_leaves_the_device_untouched(tmp_path):
    mod = load_mod()
    env = hw_env(tmp_path)
    Path(env["AEGIS_L8_PARTITION_TABLE"]).write_text(
        "app0, app, ota_0, 0x20000, 0x180000,\n", encoding="utf-8"
    )
    ex = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(mod.L8Error):
        mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS")
    assert ex.calls == [], "the device was touched with no derivable NVS offset"


def test_device_refuses_unbound_and_default_offsets(tmp_path):
    mod = load_mod()
    ex = FakeExecutor(mod)
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=ex,
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    with pytest.raises(mod.L8Error):
        dev.write_region("nvs", 0x1234, b"x")  # regions not bound yet
    dev.bind_regions({"nvs": (NVS_OFFSET, NVS_SIZE), "firmware": (APP_OFFSET, 0x180000)})
    for region, offset in (("nvs", 0x9000), ("nvs", 0x10000), ("firmware", 0x10000),
                           ("firmware", NVS_OFFSET), ("bootloader", 0x1000), ("nvs", 0)):
        with pytest.raises(mod.L8Error):
            dev.write_region(region, offset, b"x")
    with pytest.raises(mod.L8Error):
        dev.write_region("nvs", NVS_OFFSET, b"x" * (NVS_SIZE + 1))  # overruns the partition
    assert "write_flash" not in ex.subcommands()


def test_geometry_beyond_the_observed_flash_aborts_before_write(tmp_path):
    mod = load_mod()
    env = hw_env(tmp_path)
    Path(env["AEGIS_L8_PARTITION_TABLE"]).write_text(
        "nvs, data, nvs, 0x500000, 0x5000,\napp0, app, ota_0, 0x20000, 0x180000,\n",
        encoding="utf-8",
    )
    ex = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(mod.L8Error):
        mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS")
    assert "write_flash" not in ex.subcommands()
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


@pytest.mark.parametrize("gate", ["d4", "ca", "ntp", "firmware_missing", "table_missing"])
def test_offline_gates_fail_before_the_device_is_touched(tmp_path, gate):
    mod = load_mod()
    env = hw_env(tmp_path)
    inputs = Path(env["AEGIS_L8_INPUT_DIR"])
    if gate == "d4":
        (inputs / "d4.attestation").unlink()
    elif gate == "ca":
        Path(env["AEGIS_L8_SECRETS_HEADER"]).write_text(
            '#define SECRET_MQTT_CA_CERT "-----BEGIN CERTIFICATE-----\\nREPLACE_WITH_CA\\n-----END CERTIFICATE-----"\n',
            encoding="utf-8",
        )
    elif gate == "ntp":
        env["AEGIS_L8_NTP"] = "192.0.2.1"
    elif gate == "firmware_missing":
        Path(env["AEGIS_L8_FIRMWARE_IMAGE"]).unlink()
    elif gate == "table_missing":
        Path(env["AEGIS_L8_PARTITION_TABLE"]).unlink()
    ex = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(mod.L8Error):
        mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS")
    assert ex.calls == [], f"device touched despite failed {gate} gate"


def test_a_demo_key_is_refused_after_identity_but_before_any_write(tmp_path):
    mod = load_mod()
    env = hw_env(tmp_path)
    H.write_private(Path(env["AEGIS_L8_INPUT_DIR"]) / "k_c2d", "00" * 32 + "\n")
    ex = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(ValueError):
        mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS")
    assert ex.subcommands() == ["flash_id"], "only identity may precede the key gate"
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()
    assert not list(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))


# ===========================================================================
# I/J. private NVS readback
# ===========================================================================

def test_readback_reads_exactly_the_written_nvs_region_and_passes(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0, rc
    reads = [c for c in ex.calls if "read_flash" in c]
    assert len(reads) == 1
    i = reads[0].index("read_flash")
    assert int(reads[0][i + 1], 0) == NVS_OFFSET
    assert int(reads[0][i + 2], 0) == NVS_SIZE
    _, bundle = evidence(env)
    assert bundle["nvs_readback_match"] == "PASS"
    assert bundle["flash_result"] == "PASS"
    assert bundle["failure_boundary"] == "NONE"


def test_mismatched_readback_fails_without_retry_or_recovery(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path, executor_kw={"corrupt_readback": True})
    assert rc != 0
    _, bundle = evidence(env)
    assert bundle["nvs_readback_match"] == "FAIL"
    assert bundle["failure_boundary"] == "NVS_READBACK"
    assert ex.subcommands().count("write_flash") == 2, "a retry or reflash happened"
    assert ex.subcommands().count("read_flash") == 1, "readback was retried"
    assert ex.subcommands()[-1] == "read_flash", "a recovery action followed the failure"


def test_readback_exception_after_first_write_still_records_evidence(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path, executor_kw={"raise_on": "read_flash"})
    assert rc != 0
    _, bundle = evidence(env)
    assert bundle["nvs_readback_match"] == "FAIL"
    assert bundle["failure_boundary"] == "NVS_READBACK"
    assert (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").is_file()


# ===========================================================================
# K. no raw NVS / secret / executor output anywhere
# ===========================================================================

@pytest.mark.parametrize("kw", [{}, {"corrupt_readback": True}, {"fail_write_number": 2}])
def test_no_secret_or_raw_nvs_or_tool_output_is_emitted(tmp_path, capsys, kw):
    mod, env, ex, rc = run_hw(tmp_path, executor_kw=kw)
    out = capsys.readouterr()
    _, bundle = evidence(env)
    body = json.dumps(bundle)
    raw_nvs = ex.flash.get(NVS_OFFSET, b"")
    for text in (out.out, out.err, body):
        for secret in H.FORBIDDEN_EVIDENCE_VALUES:
            assert secret not in text
        assert EXEC_CANARY not in text
        if raw_nvs:
            assert raw_nvs[:32].hex() not in text
    assert set(bundle) == H.EVIDENCE_ALLOWED_FIELDS, "the 11-field schema must not grow"


def test_scratch_payload_files_do_not_outlive_the_run(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0
    leftovers = [p.name for p in Path(env["AEGIS_L8_WORK_DIR"]).glob("hw-*")]
    assert leftovers == [], leftovers


def test_scratch_payload_files_are_private(tmp_path):
    mod = load_mod()
    seen = {}

    class Spy(FakeExecutor):
        def run(self, argv, timeout=None):
            if "write_flash" in argv:
                path = argv[argv.index("write_flash") + 2]
                seen[path] = stat.S_IMODE(os.stat(path).st_mode)
            return super().run(argv, timeout)

    env = hw_env(tmp_path)
    ex = Spy(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    assert mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS") == 0
    assert seen and all(mode == 0o600 for mode in seen.values()), seen


# ===========================================================================
# L. forbidden operations unreachable
# ===========================================================================

@pytest.mark.parametrize(
    "extra",
    [
        ["erase_flash"], ["erase-flash"], ["erase_region", "0x0", "0x1000"],
        ["write_mem", "0x0", "0x0"], ["read_mem", "0x0"], ["load_ram", "x.bin"],
        ["run"], ["espefuse.py", "burn_efuse"], ["burn_efuse", "X"], ["chip_id"],
        ["read_mac"], ["verify_flash", "0x0", "x"], ["elf2image"],
    ],
)
def test_forbidden_esptool_subcommands_are_rejected(tmp_path, extra):
    mod = load_mod()
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=FakeExecutor(mod),
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    argv = dev.build_argv("flash_id", after="no_reset")[:-1] + extra
    with pytest.raises(mod.L8Error):
        mod.validate_esptool_argv(argv, dev.argv_prefix, {}, {}, tmp_path)


def test_write_flash_shape_is_strictly_validated(tmp_path):
    mod = load_mod()
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=FakeExecutor(mod),
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    scratch = tmp_path / "hw-nvs.bin"
    base = dev.build_argv("write_flash", after="no_reset")
    permitted = {NVS_OFFSET: NVS_SIZE}
    ok = base + [hex(NVS_OFFSET), str(scratch)]
    mod.validate_esptool_argv(ok, dev.argv_prefix, permitted, {}, tmp_path)
    bad_shapes = [
        base + [hex(0x9000), str(scratch)],                       # unbound offset
        base + [hex(NVS_OFFSET), str(scratch), hex(0x0), "y"],    # extra address pair
        base + ["--erase-all", hex(NVS_OFFSET), str(scratch)],   # option smuggling
        base + [hex(NVS_OFFSET), "/etc/passwd"],                  # file outside scratch dir
        base + [hex(NVS_OFFSET)],                                 # missing file
    ]
    for argv in bad_shapes:
        with pytest.raises(mod.L8Error):
            mod.validate_esptool_argv(argv, dev.argv_prefix, permitted, {}, tmp_path)


def test_a_full_run_only_ever_uses_the_three_allowed_subcommands(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0
    assert set(ex.subcommands()) <= {"flash_id", "write_flash", "read_flash"}
    assert ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash"]
    for argv in ex.calls:
        # Path tokens (tmp dirs, the tool path) are data; check the verbs/options.
        text = " ".join(a for a in argv if not a.startswith("/")).lower()
        for banned in ("erase", "write_mem", "efuse", "platformio", "pio", "upload"):
            assert banned not in text, banned


def test_hardware_device_exposes_no_actuation_or_erase_surface(tmp_path):
    mod = load_mod()
    dev = mod.HardwareDevice(
        serial_port=BOUND_PORT, work_dir=tmp_path, executor=FakeExecutor(mod),
        esptool_script=FAKE_ESPTOOL, live_authorized=True,
    )
    for name in dir(dev):
        lowered = name.lower()
        for banned in ("erase", "efuse", "cut", "restore", "actuate", "upload", "mqtt", "1883"):
            assert banned not in lowered, name


def test_subprocess_executor_refuses_anything_but_the_pinned_tool(tmp_path, monkeypatch):
    mod = load_mod()

    def must_not_spawn(*a, **kw):
        raise AssertionError("SubprocessExecutor spawned a process for a refused argv")

    monkeypatch.setattr(subprocess, "run", must_not_spawn)
    monkeypatch.setattr(subprocess, "Popen", must_not_spawn)
    ex = mod.SubprocessExecutor(["/usr/bin/python3", FAKE_ESPTOOL])
    for argv in (["/bin/echo", "x"], ["/usr/bin/python3", FAKE_ESPTOOL, "erase_flash"],
                 ["/usr/bin/python3", "other.py", "flash_id"], []):
        with pytest.raises(mod.L8Error):
            ex.run(argv, timeout=1)


def test_forbidden_verbs_appear_in_device_source_only_in_denylists():
    body = L8_DEVICE.read_text(encoding="utf-8")
    for verb in ("erase_flash", "erase-flash", "write_mem", "espefuse", "burn_efuse"):
        for line in body.splitlines():
            if verb in line:
                lowered = line.strip().lower()
                assert lowered.startswith("#") or "denylist" in lowered or "forbidden" in lowered, line
    assert "1883" not in body.replace("# ", "#") or all(
        l.strip().startswith("#") or "forbidden" in l.lower()
        for l in body.splitlines() if "1883" in l
    )


# ===========================================================================
# M/N. post-first-write behaviour, marker ordering
# ===========================================================================

def test_first_write_marker_exists_before_the_first_write_call(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert ex.marker_present_at_first_write is True


def test_no_marker_before_identity_is_observed(tmp_path):
    mod = load_mod()
    env = hw_env(tmp_path)
    marker = Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker"
    present_at_identity = []

    class Spy(FakeExecutor):
        def run(self, argv, timeout=None):
            if "flash_id" in argv:
                present_at_identity.append(marker.exists())
            return super().run(argv, timeout)

    ex = Spy(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    mod.provision(hw_args(mod, env), executor=ex, boot_verifier=lambda: "PASS")
    assert present_at_identity == [False]


@pytest.mark.parametrize("failing_write", [1, 2])
def test_failed_write_holds_fail_secure_with_evidence_and_no_recovery(tmp_path, failing_write):
    mod, env, ex, rc = run_hw(tmp_path, executor_kw={"fail_write_number": failing_write})
    assert rc != 0
    _, bundle = evidence(env)
    assert bundle["flash_result"] == "FAIL"
    assert bundle["nvs_readback_match"] == "FAIL"
    assert bundle["failure_boundary"] == "DEVICE_WRITE"
    # nothing follows the failed write: no retry, no reflash, no readback
    assert ex.subcommands()[-1] == "write_flash"
    assert ex.subcommands().count("write_flash") == failing_write

    res = H.run_stage("rollback.sh", env)
    assert res.returncode == 0
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout
    assert "L8_DEVICE_ACTION_TAKEN=NONE" in res.stdout


def test_executor_exception_during_write_is_contained_as_evidence(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path, executor_kw={"raise_on": "write_flash"})
    assert rc != 0
    _, bundle = evidence(env)
    assert bundle["failure_boundary"] == "DEVICE_WRITE"
    assert ex.subcommands().count("write_flash") == 1


def test_rollback_after_a_hardware_write_performs_zero_device_action(tmp_path, monkeypatch):
    mod, env, ex, rc = run_hw(tmp_path)
    calls_before = len(ex.calls)
    res = H.run_stage("rollback.sh", env)
    assert res.returncode == 0
    assert "L8_DEVICE_ACTION_TAKEN=NONE" in res.stdout
    assert len(ex.calls) == calls_before
    body = (L8_STAGE / "rollback.sh").read_text(encoding="utf-8")
    assert "esptool" not in body and "p4-l8-device" not in body


# ===========================================================================
# O. evidence schema, and the boot-verification design gap
# ===========================================================================

def test_hardware_evidence_is_the_exact_private_eleven_field_bundle(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    path, bundle = evidence(env)
    assert set(bundle) == H.EVIDENCE_ALLOWED_FIELDS and len(bundle) == 11
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert bundle["device_mac"] == H.FIXTURE_MAC
    assert bundle["chip_identity"] == "ESP32-D0WD-V3"
    assert bundle["flash_size"] == "4MB"
    assert bundle["boot_verification_result"] == "PASS"


def test_hardware_evidence_is_write_once(tmp_path):
    mod, env, ex, rc = run_hw(tmp_path)
    assert rc == 0
    ex2 = FakeExecutor(mod, work_dir=env["AEGIS_L8_WORK_DIR"])
    with pytest.raises(mod.L8Error):
        mod.provision(hw_args(mod, env), executor=ex2, boot_verifier=lambda: "PASS")


def test_without_a_boot_verifier_the_hardware_path_refuses_before_any_write(tmp_path):
    """BLOCKED_DESIGN_GAP: no trustworthy boot signal is defined, so none is invented."""
    mod, env, ex, rc = run_hw(tmp_path, verifier=None)
    assert isinstance(rc, tuple) or rc != 0
    assert "BOOT_VERIFICATION_NOT_IMPLEMENTED" in str(rc)
    assert "write_flash" not in ex.subcommands()
    assert not (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").exists()


def test_cli_hardware_path_cannot_supply_a_boot_verifier():
    mod = load_mod()
    assert mod.build_parser().get_default("boot_verifier") is None
    body = L8_DEVICE.read_text(encoding="utf-8")
    assert "BOOT_VERIFICATION_NOT_IMPLEMENTED" in body


@pytest.mark.parametrize("verdict,boundary", [("FAIL", "BOOT_VERIFICATION"),
                                             ("NOT_PROVEN", "BOOT_VERIFICATION")])
def test_non_pass_boot_verification_is_recorded_and_fails_secure(tmp_path, verdict, boundary):
    mod, env, ex, rc = run_hw(tmp_path, verifier=lambda: verdict)
    assert rc != 0
    _, bundle = evidence(env)
    assert bundle["boot_verification_result"] == verdict
    assert bundle["failure_boundary"] == boundary
    assert bundle["flash_result"] == "PASS"
    assert ex.subcommands() == ["flash_id", "write_flash", "write_flash", "read_flash"]


def test_a_raising_or_bogus_boot_verifier_is_not_proven(tmp_path):
    def boom():
        raise RuntimeError("verifier exploded")

    for verifier in (boom, lambda: "MAYBE", lambda: True):
        sub = tmp_path / f"v{id(verifier)}"
        sub.mkdir()
        mod, env, ex, rc = run_hw(sub, verifier=verifier)
        assert rc != 0
        _, bundle = evidence(env)
        assert bundle["boot_verification_result"] == "NOT_PROVEN"
        assert bundle["failure_boundary"] == "BOOT_VERIFICATION"


# ===========================================================================
# P. fixture backend unchanged
# ===========================================================================

def test_fixture_backend_still_works_through_the_new_loader(tmp_path):
    mod = load_mod()
    support = H.make_support_files(tmp_path)
    dev = mod.load_backend("fixture", support["fixture_device"], tmp_path / "flash")
    assert dev.name == "fixture"
    assert dev.identity()["mac"] == H.FIXTURE_MAC
    assert dev.verify_boot() == "NOT_APPLICABLE_FIXTURE_BACKEND"


def test_fixture_provisioning_records_the_fixture_boot_marker(tmp_path):
    env = H.l8_env(tmp_path)
    assert H.run_apply(env).returncode == 0
    _, bundle = evidence(env)
    assert bundle["boot_verification_result"] == "NOT_APPLICABLE_FIXTURE_BACKEND"


# ===========================================================================
# R. this file can never reach a device
# ===========================================================================

def test_hardware_tests_never_reach_a_real_device():
    body = Path(__file__).read_text(encoding="utf-8")
    assert not re.search(r"^\s*import\s+(serial|esptool)\b", body, re.M)
    assert not re.search(r"^\s*from\s+(serial|esptool)\b", body, re.M)
    assert "serial" + ".Serial" not in body
    assert "subprocess.run([\"" + "esptool" not in body
    # The only executor these tests construct for hardware is the fake one.
    assert "Subprocess" + "Executor(" not in body.replace('mod.SubprocessExecutor(["/usr/bin', "")
