"""L8 fail-secure evidence gap (OD-L8-07): once the first-write marker exists, ANY failure in write completion, readback,
readback length validation, readback comparison or post-write verification must converge on
FAIL_SECURE_HOLD_AND_EVIDENCE: a non-zero result, the marker kept, exactly one write-once evidence bundle with
flash_result=FAIL and a stable failure_boundary, no secret, no recovery action.

Every test runs the reviewed helper in-process against the FIXTURE device with a spy that records each device call.
No serial device is opened and no flashing tool is invoked (a test below enforces that over this file).
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"

_spec = importlib.util.spec_from_file_location("l8_handler_tests", ROOT / "tests" / "test_pr11_phase4_l8_handler.py")
_h = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_h)

SECRETS = (_h.FIXTURE_C2D, _h.FIXTURE_D2C, _h.FIXTURE_WIFI_PSK, _h.FIXTURE_MQTT_PASS)
BOUNDARIES = {
    "NONE", "DEVICE_WRITE", "NVS_READBACK", "NVS_READBACK_ERROR", "NVS_READBACK_LENGTH", "POST_WRITE_VERIFICATION",
}


class Rig:
    def __init__(self, tmp_path: Path, monkeypatch, capsys):
        self.env = _h.l8_env(tmp_path)
        self.mod = _h.load_device_module()
        self.capsys = capsys
        self.calls: list[str] = []
        self.work = Path(self.env["AEGIS_L8_WORK_DIR"])
        self.evidence = Path(self.env["AEGIS_L8_EVIDENCE_DIR"])
        cls = self.mod.FixtureDevice
        real_write, real_read = cls.write_region, cls.read_region
        rig = self

        def write_region(dev, region, offset, payload):
            rig.calls.append(f"write:{region}")
            return real_write(dev, region, offset, payload)

        def read_region(dev, region, offset):
            rig.calls.append(f"read:{region}")
            return rig.read_override(dev, region, offset, real_read)

        monkeypatch.setattr(cls, "write_region", write_region)
        monkeypatch.setattr(cls, "read_region", read_region)
        self.read_override = lambda dev, region, offset, real: real(dev, region, offset)

    def argv(self) -> list[str]:
        e = self.env
        return [
            "provision", "--input-dir", e["AEGIS_L8_INPUT_DIR"], "--work-dir", e["AEGIS_L8_WORK_DIR"],
            "--evidence-dir", e["AEGIS_L8_EVIDENCE_DIR"], "--backend", "fixture",
            "--fixture-device", e["AEGIS_L8_FIXTURE_DEVICE"], "--partition-table", e["AEGIS_L8_PARTITION_TABLE"],
            "--secrets-header", e["AEGIS_L8_SECRETS_HEADER"], "--firmware-image", e["AEGIS_L8_FIRMWARE_IMAGE"],
            "--build-command", e["AEGIS_L8_FIRMWARE_BUILD_CMD"], "--nvs-generator", e["AEGIS_L8_NVS_PARTITION_GEN"],
            "--wifi-ssid", e["AEGIS_L8_WIFI_SSID"], "--ntp", e["AEGIS_L8_NTP"], "--run-id", e["AEGIS_L8_RUN_ID"],
        ]

    def run(self) -> tuple[int, str]:
        rc = self.mod.main(self.argv())
        out = self.capsys.readouterr()
        return rc, out.out + out.err

    def bundles(self) -> list[Path]:
        return sorted(self.evidence.glob("*.json")) if self.evidence.exists() else []

    def bundle(self) -> dict:
        (path,) = self.bundles()
        return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture()
def rig(tmp_path, monkeypatch, capsys):
    return Rig(tmp_path, monkeypatch, capsys)


def assert_fail_secure(rig: Rig, rc: int, out: str, boundary: str) -> dict:
    assert rc != 0
    assert (rig.work / "first-write.marker").is_file(), "the first-write marker must remain"
    bundle = rig.bundle()
    assert bundle["flash_result"] == "FAIL"
    assert bundle["failure_boundary"] == boundary
    assert set(bundle) == set(rig.mod.EVIDENCE_FIELDS), "the exact G-15 field set is authoritative"
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in out
    text = out + json.dumps(bundle)
    assert not any(secret in text for secret in SECRETS)
    # no recovery: the only device calls are the two first writes and at most the single readback
    assert rig.calls[:2] == ["write:nvs", "write:firmware"]
    assert len([c for c in rig.calls if c.startswith("write")]) == 2
    assert len([c for c in rig.calls if c.startswith("read")]) <= 1
    return bundle


# ---- 1. readback raises after the first write ----
@pytest.mark.parametrize("exc", [RuntimeError("boom"), OSError("io"), ValueError("bad"), Exception("generic")])
def test_readback_exception_after_first_write_is_fail_secure_with_evidence(rig, exc):
    def boom(dev, region, offset, real):
        raise exc
    rig.read_override = boom
    rc, out = rig.run()
    assert_fail_secure(rig, rc, out, "NVS_READBACK_ERROR")


def test_readback_l8error_after_first_write_is_fail_secure_with_evidence(rig):
    def boom(dev, region, offset, real):
        raise rig.mod.L8Error("fixture readback failed for region nvs")
    rig.read_override = boom
    rc, out = rig.run()
    assert_fail_secure(rig, rc, out, "NVS_READBACK_ERROR")


# ---- 2. wrong length ----
@pytest.mark.parametrize("data", [b"", b"short", None])
def test_readback_wrong_length_is_fail_secure_with_evidence(rig, data):
    rig.read_override = lambda dev, region, offset, real: (real(dev, region, offset) + b"x") if data is None else data
    rc, out = rig.run()
    bundle = assert_fail_secure(rig, rc, out, "NVS_READBACK_LENGTH")
    assert bundle["nvs_readback_match"] == "FAIL"


# ---- 3. same-length mismatch ----
def test_readback_mismatch_records_fail_without_secret_bytes(rig):
    def flipped(dev, region, offset, real):
        data = bytearray(real(dev, region, offset)); data[0] ^= 0xFF
        return bytes(data)
    rig.read_override = flipped
    rc, out = rig.run()
    assert rc != 0
    bundle = rig.bundle()
    assert bundle["nvs_readback_match"] == "FAIL" and bundle["failure_boundary"] == "NVS_READBACK"
    assert (rig.work / "first-write.marker").is_file()
    assert not any(secret in out + json.dumps(bundle) for secret in SECRETS)
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in out


# ---- unexpected error while finalising a readback that looked fine ----
def test_unexpected_error_in_post_write_verification_is_fail_secure(rig, monkeypatch):
    def broken(expected, actual):
        raise RuntimeError("compare exploded")
    monkeypatch.setattr(rig.mod, "compare_nvs_readback", broken)
    rc, out = rig.run()
    assert_fail_secure(rig, rc, out, "POST_WRITE_VERIFICATION")


# ---- write failure keeps its existing canonical boundary ----
def test_write_failure_keeps_device_write_boundary(rig, monkeypatch):
    cls = rig.mod.FixtureDevice
    def fail_write(dev, region, offset, payload):
        rig.calls.append(f"write:{region}")
        raise RuntimeError("write failed")
    monkeypatch.setattr(cls, "write_region", fail_write)
    rc, out = rig.run()
    assert rc != 0 and (rig.work / "first-write.marker").is_file()
    bundle = rig.bundle()
    assert bundle["flash_result"] == "FAIL" and bundle["failure_boundary"] == "DEVICE_WRITE"
    assert rig.calls == ["write:nvs"], "no second write / no retry after a failed write"
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in out


# ---- 4. evidence is write-once, including on the failure path ----
def test_failure_path_never_overwrites_an_existing_evidence_bundle(rig):
    rig.evidence.mkdir(parents=True, exist_ok=True); rig.evidence.chmod(0o700)
    existing = rig.evidence / f"l8-{rig.env['AEGIS_L8_RUN_ID']}.json"
    existing.write_text('{"sentinel": true}\n', encoding="utf-8")
    def boom(dev, region, offset, real):
        raise RuntimeError("boom")
    rig.read_override = boom
    rc, out = rig.run()
    assert rc != 0
    assert existing.read_text(encoding="utf-8") == '{"sentinel": true}\n'
    assert len(rig.bundles()) == 1
    assert "write-once" in out


def test_failure_boundaries_are_stable_codes():
    mod = _h.load_device_module()
    text = (DEPLOY / "p4-l8-device.py").read_text(encoding="utf-8")
    found = set(re.findall(r'"(NONE|DEVICE_WRITE|NVS_READBACK[A-Z_]*|POST_WRITE_[A-Z_]+)"', text))
    assert found == BOUNDARIES, found
    assert mod.EVIDENCE_FIELDS[-1] == "failure_boundary"


# ---- 5. a pre-write failure still performs NO device write and produces no marker/evidence ----
def test_pre_write_mac_mismatch_performs_no_device_call(rig):
    rig.env["AEGIS_L8_FIXTURE_DEVICE"] = str(_mismatching_descriptor(Path(rig.env["AEGIS_L8_FIXTURE_DEVICE"])))
    rc, out = rig.run()
    assert rc != 0
    assert rig.calls == []
    assert not (rig.work / "first-write.marker").exists() and rig.bundles() == []


def test_pre_write_nvs_generator_failure_performs_no_device_call(rig, tmp_path):
    bad = tmp_path / "bad-gen"; bad.write_text("#!/bin/sh\nexit 3\n"); bad.chmod(0o700)
    rig.env["AEGIS_L8_NVS_PARTITION_GEN"] = str(bad)
    rc, _ = rig.run()
    assert rc != 0 and rig.calls == []
    assert not (rig.work / "first-write.marker").exists() and rig.bundles() == []


def test_clean_run_is_unchanged(rig):
    rc, out = rig.run()
    assert rc == 0 and rig.calls == ["write:nvs", "write:firmware", "read:nvs"]
    bundle = rig.bundle()
    assert bundle["flash_result"] == "PASS" and bundle["nvs_readback_match"] == "PASS" and bundle["failure_boundary"] == "NONE"
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" not in out


# ---- 6. no forbidden recovery path is reachable ----
def test_no_recovery_or_destructive_path_exists_in_the_l8_helper():
    import ast
    tree = ast.parse((DEPLOY / "p4-l8-device.py").read_text(encoding="utf-8"))
    forbidden = ("erase", "write_mem", "efuse", "esptool", "restore", "reflash", "1883")
    denylist = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "FORBIDDEN_BUILD_VERBS")
    allowed_constants = {id(c) for c in ast.walk(denylist)}
    docstrings = {id(n.body[0].value) for n in ast.walk(tree)
                  if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef)) and n.body
                  and isinstance(n.body[0], ast.Expr) and isinstance(getattr(n.body[0], "value", None), ast.Constant)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in allowed_constants | docstrings:
            assert not any(word in node.value.lower() for word in forbidden), node.value
        if isinstance(node, ast.Call):
            name = (node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")).lower()
            assert not any(word in name for word in forbidden), name
    # the only device operations the provisioning flow can reach
    calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and isinstance(n.func.value, ast.Name) and n.func.value.id == "device"}
    assert calls <= {"identity", "write_region", "read_region"}, calls


def test_this_module_never_imports_a_serial_or_flashing_library():
    src = Path(__file__).read_text(encoding="utf-8")
    assert not re.search(r"^\s*(import|from)\s+(serial|esptool|pyserial|espefuse)\b", src, re.M)


def _mismatching_descriptor(path: Path) -> Path:
    data = json.loads(path.read_text(encoding="utf-8")); data["mac"] = "24:0a:c4:99:99:99"
    other = path.with_name("mismatch-device.json"); other.write_text(json.dumps(data), encoding="utf-8")
    return other
