"""AEGIS IDEA3 PR11 Phase 4 L8 — firmware readback and the single terminal reset (hardening of the real-hardware backend).

Two findings against the hardware flow, fixed here:

1. Only the NVS region was read back and compared. The application (firmware) region is now read back as well, compared entirely in memory,
   and recorded as the boolean ``firmware_readback_match`` only (the evidence bundle grows from eleven to twelve fields: OD-L8-09 amended).
2. ``read_region`` used ``--after hard_reset`` on every read, so reading both regions would reset the device twice. Reads now NEVER reset. The
   device is reset exactly once, by ``reset_into_new_image()``, which runs the read-only ``flash_id`` verb with ``--after hard_reset``, and only
   after BOTH regions were written and BOTH readbacks were obtained and compared equal.

Sequence (hardware): flash_id(no_reset) -> arm verifier -> write nvs -> write firmware -> read nvs -> compare -> read firmware -> compare
-> flash_id(hard_reset) [the one terminal reset] -> verify signed BOOT STATUS. Every test here uses a fake executor: no device, no serial port.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l8_handler as H
import test_pr11_phase4_l8_hardware_backend as HW
import test_pr11_phase4_l8_boot_verify as BV

_no_real_device = HW._no_real_device  # autouse guard from the hardware suite

NVS_OFFSET, NVS_SIZE, APP_OFFSET = HW.NVS_OFFSET, HW.NVS_SIZE, HW.APP_OFFSET
FULL = ["flash_id", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id"]


class Ex(HW.FakeExecutor):
    """FakeExecutor with per-address read faults."""

    def __init__(self, mod, *, corrupt_addr=None, fail_read_addr=None, **kw):
        super().__init__(mod, **kw)
        self.corrupt_addr, self.fail_read_addr = corrupt_addr, fail_read_addr

    def run(self, argv, timeout=None):
        argv = [str(a) for a in argv]
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


def run_hw2(tmp_path, **executor_kw):
    mod = HW.load_mod()
    env = HW.hw_env(tmp_path)
    ex = Ex(mod, work_dir=env["AEGIS_L8_WORK_DIR"], **executor_kw)
    args = HW.hw_args(mod, env)
    try:
        rc = mod.provision(args, executor=ex, boot_verifier=lambda: "PASS")
    except mod.L8Error as exc:
        rc = ("L8Error", str(exc))
    return mod, env, ex, rc


def after_of(argv):
    return argv[argv.index("--after") + 1]


def hard_resets(ex):
    return [c for c in ex.calls if after_of(c) == "hard_reset"]


# ── 1. firmware readback ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_firmware_readback_succeeds_and_is_recorded_as_a_boolean(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path)
    assert rc == 0, rc
    _, bundle = HW.evidence(env)
    assert bundle["firmware_readback_match"] == "PASS" and bundle["nvs_readback_match"] == "PASS"
    assert bundle["failure_boundary"] == "NONE" and bundle["flash_result"] == "PASS"
    assert set(bundle) == H.EVIDENCE_ALLOWED_FIELDS and len(bundle) == 12 and "firmware_readback_match" in bundle


def test_readbacks_cover_exactly_the_written_application_and_nvs_regions(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path)
    assert rc == 0
    reads = []
    for argv in ex.calls:
        if "read_flash" in argv:
            i = argv.index("read_flash")
            reads.append((int(argv[i + 1], 0), int(argv[i + 2], 0)))
    image_len = len(Path(env["AEGIS_L8_FIRMWARE_IMAGE"]).read_bytes())
    assert reads == [(NVS_OFFSET, NVS_SIZE), (APP_OFFSET, image_len)]


def test_firmware_readback_mismatch_is_fail_secure_hold_with_no_second_write_or_reset(tmp_path, capsys) -> None:
    mod, env, ex, rc = run_hw2(tmp_path, corrupt_addr=APP_OFFSET)
    assert rc != 0
    _, bundle = HW.evidence(env)
    assert bundle["firmware_readback_match"] == "FAIL" and bundle["nvs_readback_match"] == "PASS"
    assert bundle["failure_boundary"] == "FIRMWARE_READBACK"
    assert bundle["boot_verification_result"] != "PASS"
    assert ex.subcommands().count("write_flash") == 2, "a retry or reflash happened"
    assert ex.subcommands() == FULL[:5], "nothing may follow a failed readback (no reset, retry, reflash or restore)"
    assert hard_resets(ex) == []
    res = H.run_stage("rollback.sh", env)
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout and "L8_DEVICE_ACTION_TAKEN=NONE" in res.stdout


def test_firmware_readback_tool_failure_is_contained_as_evidence(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path, fail_read_addr=APP_OFFSET)
    assert rc != 0
    _, bundle = HW.evidence(env)
    assert bundle["firmware_readback_match"] == "FAIL" and bundle["failure_boundary"] == "FIRMWARE_READBACK"
    assert ex.subcommands() == FULL[:5] and hard_resets(ex) == []
    assert (Path(env["AEGIS_L8_WORK_DIR"]) / "first-write.marker").is_file()


def test_nvs_mismatch_stops_before_the_firmware_read_and_before_any_reset(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path, corrupt_addr=NVS_OFFSET)
    assert rc != 0
    _, bundle = HW.evidence(env)
    assert bundle["nvs_readback_match"] == "FAIL" and bundle["failure_boundary"] == "NVS_READBACK"
    assert bundle["firmware_readback_match"] == "FAIL", "unverified is never reported as a pass"
    assert ex.subcommands() == FULL[:4] and hard_resets(ex) == []


def test_evidence_holds_the_boolean_only_never_firmware_or_nvs_bytes(tmp_path, capsys) -> None:
    mod, env, ex, rc = run_hw2(tmp_path)
    out = capsys.readouterr()
    path, bundle = HW.evidence(env)
    text = path.read_text() + out.out + out.err
    image = Path(env["AEGIS_L8_FIRMWARE_IMAGE"]).read_bytes()
    nvs = ex.flash[NVS_OFFSET]
    assert bundle["firmware_readback_match"] in ("PASS", "FAIL")
    assert bundle["firmware_sha256"] == hashlib.sha256(image).hexdigest()
    for blob in (image, nvs):
        assert blob[:24].hex() not in text and blob[:24].decode("latin-1") not in text
    assert HW.EXEC_CANARY not in text
    for secret in H.FORBIDDEN_EVIDENCE_VALUES:
        assert secret not in text


def test_the_device_cannot_read_an_arbitrary_flash_range(tmp_path) -> None:
    mod = HW.load_mod()
    ex = Ex(mod)
    dev = mod.HardwareDevice(serial_port=HW.BOUND_PORT, work_dir=tmp_path, executor=ex, esptool_script=HW.FAKE_ESPTOOL, live_authorized=True)
    dev.bind_regions({"nvs": (NVS_OFFSET, NVS_SIZE), "firmware": (APP_OFFSET, 0x180000)})
    with pytest.raises(mod.L8Error):
        dev.read_region("firmware", APP_OFFSET)  # not written yet: nothing to read back
    dev.write_region("nvs", NVS_OFFSET, b"\x01" * 32)
    dev.write_region("firmware", APP_OFFSET, b"\xe9" * 64)
    with pytest.raises(mod.L8Error):
        dev.read_region("firmware", APP_OFFSET + 0x1000)  # an offset that was not written
    scratch = tmp_path / "hw-firmware-0x20000.bin"
    for size in (65, 63, 0x180000):
        with pytest.raises(mod.L8Error):  # wrong length through the structural allowlist
            dev._invoke(dev.build_argv("read_flash", hex(APP_OFFSET), hex(size), str(scratch), after="no_reset"), 1)
    assert dev.read_region("firmware", APP_OFFSET) == b"\xe9" * 64  # the exact written length is allowed


# ── 2. one terminal reset ────────────────────────────────────────────────────────────────────────────────────────────────


def test_a_full_run_issues_the_exact_sequence_with_exactly_one_terminal_reset(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path)
    assert rc == 0
    assert ex.subcommands() == FULL
    resets = hard_resets(ex)
    assert len(resets) == 1 and resets[0] is ex.calls[-1] and ex.sub(resets[0]) == "flash_id"
    for argv in ex.calls[:-1]:
        assert after_of(argv) == "no_reset", argv
    reads = [i for i, c in enumerate(ex.calls) if "read_flash" in c]
    assert max(reads) < len(ex.calls) - 1, "the reset follows BOTH readbacks"


def test_reads_never_reset_and_the_reset_uses_only_the_read_only_identity_verb(tmp_path) -> None:
    mod, env, ex, rc = run_hw2(tmp_path)
    for argv in ex.calls:
        if "read_flash" in argv or "write_flash" in argv:
            assert after_of(argv) == "no_reset"
    assert set(ex.subcommands()) == {"flash_id", "write_flash", "read_flash"}, "no new tool verb was introduced"


def test_the_device_refuses_to_reset_before_everything_was_written_and_read_back(tmp_path) -> None:
    mod = HW.load_mod()
    dev = mod.HardwareDevice(serial_port=HW.BOUND_PORT, work_dir=tmp_path, executor=Ex(mod), esptool_script=HW.FAKE_ESPTOOL, live_authorized=True)
    dev.bind_regions({"nvs": (NVS_OFFSET, NVS_SIZE), "firmware": (APP_OFFSET, 0x180000)})
    with pytest.raises(mod.L8Error):
        dev.reset_into_new_image()  # nothing written
    dev.write_region("nvs", NVS_OFFSET, b"\x01" * 32)
    dev.write_region("firmware", APP_OFFSET, b"\xe9" * 64)
    with pytest.raises(mod.L8Error):
        dev.reset_into_new_image()  # written but not read back
    dev.read_region("nvs", NVS_OFFSET)
    with pytest.raises(mod.L8Error):
        dev.reset_into_new_image()  # only one region read back
    dev.read_region("firmware", APP_OFFSET)
    dev.reset_into_new_image()


def test_at_most_one_reset_and_no_device_access_afterwards(tmp_path) -> None:
    mod = HW.load_mod()
    ex = Ex(mod)
    dev = mod.HardwareDevice(serial_port=HW.BOUND_PORT, work_dir=tmp_path, executor=ex, esptool_script=HW.FAKE_ESPTOOL, live_authorized=True)
    dev.bind_regions({"nvs": (NVS_OFFSET, NVS_SIZE), "firmware": (APP_OFFSET, 0x180000)})
    dev.write_region("nvs", NVS_OFFSET, b"\x01" * 32)
    dev.write_region("firmware", APP_OFFSET, b"\xe9" * 64)
    dev.read_region("nvs", NVS_OFFSET)
    dev.read_region("firmware", APP_OFFSET)
    dev.reset_into_new_image()
    calls = len(ex.calls)
    for action in (dev.reset_into_new_image, dev.identity, lambda: dev.read_region("nvs", NVS_OFFSET),
                   lambda: dev.write_region("nvs", NVS_OFFSET, b"\x01" * 32)):
        with pytest.raises(mod.L8Error):
            action()
    assert len(ex.calls) == calls and len(hard_resets(ex)) == 1


def test_boot_verification_before_the_reset_is_not_proven(tmp_path) -> None:
    mod = HW.load_mod()
    dev = mod.HardwareDevice(serial_port=HW.BOUND_PORT, work_dir=tmp_path, executor=Ex(mod), esptool_script=HW.FAKE_ESPTOOL, live_authorized=True,
                             boot_verifier=lambda: "PASS")
    assert dev.verify_boot() == "NOT_PROVEN"


@pytest.mark.parametrize("kw", [{"corrupt_addr": NVS_OFFSET}, {"corrupt_addr": APP_OFFSET}, {"fail_read_addr": NVS_OFFSET},
                                {"fail_read_addr": APP_OFFSET}])
def test_no_reset_ever_precedes_a_failed_readback(tmp_path, kw) -> None:
    mod, env, ex, rc = run_hw2(tmp_path, **kw)
    assert rc != 0 and hard_resets(ex) == []


def test_verifier_arms_before_the_first_write_and_the_verdict_follows_the_one_reset(tmp_path) -> None:
    mod, env, ex, verifier, events, rc = BV.run_provision(tmp_path, BV._boot_ok)
    assert rc == 0, rc
    assert events == ["flash_id", "arm", "write_flash", "write_flash", "read_flash", "read_flash", "flash_id", "poll"] or (
        events.index("flash_id") < events.index("arm") < events.index("write_flash")
        and events.count("flash_id") == 2 and events.index("poll") > max(i for i, e in enumerate(events) if e == "flash_id")
        and events.index("poll") > max(i for i, e in enumerate(events) if e == "read_flash")), events
    assert len(hard_resets(ex)) == 1, "no extra reboot is introduced before the L9 hand-off"


# ── 3. fixture backend and verify.sh ─────────────────────────────────────────────────────────────────────────────────────


def test_fixture_flow_reads_the_firmware_back_too_and_records_the_boolean(tmp_path) -> None:
    env = H.l8_env(tmp_path)
    res = H.run_apply(env)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L8_FIRMWARE_READBACK_MATCH=PASS" in res.stdout.splitlines()
    bundle = json.loads(next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")).read_text())
    assert bundle["firmware_readback_match"] == "PASS" and len(bundle) == 12
    assert H.run_stage("verify.sh", env).returncode == 0


def test_fixture_firmware_mismatch_fails_secure_with_evidence(tmp_path, monkeypatch) -> None:
    mod = HW.load_mod()
    original = mod.FixtureDevice.read_region

    def tampered(self, region, offset, *a, **k):
        data = original(self, region, offset)
        return data[:-1] + bytes([data[-1] ^ 1]) if region == "firmware" else data

    monkeypatch.setattr(mod.FixtureDevice, "read_region", tampered)
    env = H.l8_env(tmp_path)
    args = mod.build_parser().parse_args(H.provision_args(mod, env))
    assert mod.provision(args) != 0
    bundle = json.loads(next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")).read_text())
    assert bundle["firmware_readback_match"] == "FAIL" and bundle["failure_boundary"] == "FIRMWARE_READBACK"


@pytest.mark.parametrize("field,value", [("firmware_readback_match", "FAIL"), ("firmware_readback_match", None)])
def test_verify_requires_the_firmware_readback_to_pass(tmp_path, field, value) -> None:
    env = H.l8_env(tmp_path)
    assert H.run_apply(env).returncode == 0
    path = next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    bundle = json.loads(path.read_text())
    if value is None:
        del bundle[field]
    else:
        bundle[field] = value
    path.write_text(json.dumps(bundle))
    assert H.run_stage("verify.sh", env).returncode != 0
