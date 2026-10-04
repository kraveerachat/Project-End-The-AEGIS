"""AEGIS IDEA3 PR11 Phase 4 - L8p attempt #2: the ONE-OFF, owner-approved, host-only reconciliation tool (reconcile-l8p-attempt2.py).

Hermetic fixtures only: every test builds a synthetic attempt-2 tree under pytest's tmp_path (same directory BASENAMES as the historical attempt, never its real path),
runs the real tool against it, and checks that it refuses before touching anything when any gate fails and, on success, removes exactly nvs.csv and nvs.bin and nothing else.
No test references, reads or mutates the real historical attempt-2 directories; no test opens a device, a serial port or the network.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy" / "pr11-phase4" / "reconciliation" / "reconcile-l8p-attempt2.py"

RUN_ID = "l8p-20261004-041840"
EVID_NAME = "2026-10-04-l8p-20261004-041840"
FREEZE_NAME = "2026-10-04-l8p-successor2"
FIRMWARE = "bacc694c0b208e1d6857526d233c397e704795944099f951a91db82173ed4f9a"
SECRETS = {"wifi.psk": "CANARY-wifi-psk-7d1e44a0b9", "mqtt.pass": "CANARY-mqtt-pass-3c58f2e1aa", "k_c2d": "CANARY" + "c2" * 29, "k_d2c": "CANARY" + "d2" * 29}

OWNER_LOG = """EVIDENCE_ROOT={evid} MAIN=b440b102cf35131291e330e2109adaa29c8e43c9
== PRE capture (read-only; BEFORE the attempt is consumed and before any device access)
2026-10-03T21:18:52Z L0_CAPTURE=COMPLETE evidence={evid}/pre-root
CAPTURE_PRE=COMPLETE SHA256=PASS
== L8p APPLY (once; the canonical handler)
L8P_NVS_OFFSET=0x9000
L8P_FLASH_RESULT=PASS
L8P_NVS_READBACK_MATCH=PASS
L8P_FIRMWARE_READBACK_MATCH=PASS
L8P_BOOT_VERIFICATION=PASS
L8P_FAILURE_BOUNDARY=NONE
L8P_BOOT_VERIFICATION_DETAIL=PASS_BOOT_LOCKDOWN
L8P_PROVISIONING_ONLY=YES
RECOVERY_R1_R8_PROVEN=NO
L8P_APPLY=COMPLETE
== L8p VERIFY (read-only evidence check)
L8P_VERIFY=PASS
== POST capture
CAPTURE_POST=COMPLETE SHA256=PASS
== PRE -> POST compare (Core host zero drift: the L8p allow files are empty)
FINDINGS_NEW_OR_WORSENED_DRIFT=0
PRESERVATION_S10=PASS
COMPARE_RESULT=PASS
L8P_SECRET_VALUE_SCAN_FILES=142 L8P_SECRET_VALUE_SCAN_HITS=2
== L8p ROLLBACK (reason: SECRET_OUTPUT_SCAN failed) - failure/abort path only
L8P_FIRST_HARDWARE_WRITE=STARTED
L8P_DEVICE_ACTION_TAKEN=NONE
L8P_EVIDENCE_PRESERVED=YES
L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE
CAPTURE_RB=COMPLETE SHA256=PASS
PRESERVATION_S10=PASS
COMPARE_RESULT=PASS
PRE_RB_COMPARE=PASS (Core host). L8P_PROVISIONING=NOT_PROVEN. The device holds FAIL-SECURE; physical recovery is MANUAL and out-of-band. NOT retrying. Authorization is consumed.
"""


def load_tool():
    spec = importlib.util.spec_from_file_location("reconcile_l8p_attempt2", str(TOOL))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


T = load_tool()


def write(path: Path, data, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)
    return path


def sums_for(bundle: Path) -> None:
    lines = [f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.relative_to(bundle)}" for f in sorted(bundle.rglob("*")) if f.is_file() and f.name != "SHA256SUMS"]
    write(bundle / "SHA256SUMS", "\n".join(lines) + "\n")


class Fx:
    """A synthetic attempt-2 tree. Paths use the historical BASENAMES under tmp_path only."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.evid = tmp / "evidence" / EVID_NAME
        self.freeze = tmp / "owner-run" / FREEZE_NAME
        self.inputs = tmp / "input"
        self.runner = write(self.freeze / "run-l8p-owner.FROZEN.sh", "#!/usr/bin/env bash\n# fixture runner\n", 0o500)
        self.binding = T.Binding(runner_sha256=hashlib.sha256(self.runner.read_bytes()).hexdigest())
        auth = self.freeze / "auth"
        write(auth / "authorization-L8p.txt", "AEGIS_P4_AUTHORIZATION_V1\nstage=L8p\ndate=2026-10-04\n")
        write(auth / "k3-L8p.txt", "AEGIS_P4_K3_CONFIRMATION_V2\nstage=L8p\ndate=2026-10-04\n")
        write(auth / "L8p-ATTEMPT-CONSUMED", "consumed_at=2026-10-03T21:18:52Z\n")
        self.inputs.mkdir(parents=True, mode=0o700)
        for name, value in SECRETS.items():
            write(self.inputs / name, value + "\n")
        e = self.evid
        write(e / "authorization-L8p.txt", (auth / "authorization-L8p.txt").read_bytes())
        write(e / "k3-L8p.txt", (auth / "k3-L8p.txt").read_bytes())
        write(e / "frozen-inputs.txt", f"MAIN=b440b102cf35131291e330e2109adaa29c8e43c9\nFIRMWARE_SHA256={FIRMWARE}\nPARTITION_TABLE_SHA256={'3' * 64}\nRUNNER_SHA256={self.binding.runner_sha256}\n")
        write(e / "journal_since.txt", "2026-10-03 21:18:51 UTC\n")
        write(e / "compare-pre-post.txt", "COMPARE_RESULT=PASS\n")
        write(e / "compare-pre-rb.txt", "COMPARE_RESULT=PASS\n")
        write(e / "owner-run.log", OWNER_LOG.format(evid=e))
        bundle = {"schema_version": 1, "run_id": RUN_ID, "device_mac": "b4:bf:e9:33:0c:7c", "chip_identity": "ESP32-D0WD-V3 rev v3.1", "flash_size": "4MB", "firmware_sha256": FIRMWARE,
                  "nvs_schema_version": 1, "nvs_readback_match": "PASS", "firmware_readback_match": "PASS", "flash_result": "PASS", "boot_verification_result": "PASS", "failure_boundary": "NONE"}
        write(e / "l8p-evidence" / f"l8p-{RUN_ID}.json", json.dumps(bundle))
        write(e / "l8p-work" / "first-write.marker", "backend=hardware\nnvs_offset=0x9000\n")
        write(e / "l8p-work" / "nvs.csv", "key,type,encoding,value\n" + "".join(f"{n},data,string,{v}\n" for n, v in SECRETS.items()))
        write(e / "l8p-work" / "nvs.bin", b"\0" * 64 + SECRETS["wifi.psk"].encode() + b"\0" * 32 + SECRETS["mqtt.pass"].encode() + b"\0" * 2000)
        for label in ("pre-root", "post-root", "rb-root"):
            write(e / label / "capture.log", f"2026-10-03T21:18:52Z L0_CAPTURE=COMPLETE evidence={e / label}\n")
            write(e / label / "host.tsv", f"disk.root.use_pct\t78\nlabel\t{label}\n")
            write(e / label / "raw" / "df-root.txt", "Filesystem 1K-blocks Used Available Use% Mounted\n")
            sums_for(e / label)
        for d in [e, *e.rglob("*")]:
            if d.is_dir():
                d.chmod(0o700)

    def run(self, **over):
        args = {"evidence_root": str(self.evid), "freeze_dir": str(self.freeze), "input_dir": str(self.inputs), "binding": self.binding}
        args.update(over)
        lines: list[str] = []
        rc = T.reconcile(args["evidence_root"], args["freeze_dir"], args["input_dir"], args["binding"], out=lines.append)
        return rc, lines

    def snapshot(self) -> dict[str, tuple]:
        snap = {}
        for base in (self.evid, self.freeze, self.inputs):
            for p in sorted(base.rglob("*")):
                snap[str(p)] = (p.is_dir(), oct(p.lstat().st_mode & 0o777), None if p.is_dir() else hashlib.sha256(p.read_bytes()).hexdigest())
        return snap


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return Fx(tmp_path)


def fail_reason(lines: list[str]) -> str:
    return next((l for l in lines if l.startswith("L8P_ATTEMPT2_RECONCILIATION=FAIL")), "")


def assert_refused_untouched(fx: Fx, lines, rc, needle: str, before) -> None:
    assert rc == 1, lines
    assert needle in fail_reason(lines), lines
    assert "L8P_PROVISIONING=PASS" not in lines and "L8P_LIVE_EXECUTED=YES" not in lines and "L8P_ATTEMPT2_RECONCILIATION=PASS" not in lines
    assert fx.snapshot() == before, "a refused reconciliation must change nothing"
    assert not any(v in "\n".join(lines) for v in SECRETS.values())


# ── 1. the exact historical-shape fixture reconciles ───────────────────────────────────────────────────────────────────────────────────────

def test_the_exact_historical_fixture_reconciles_and_emits_the_narrow_result(fx: Fx) -> None:
    rc, lines = fx.run()
    assert rc == 0, lines
    for line in ("L8P_RECONCILIATION_PRE_CLEANUP_GATES=PASS", "NVS_CSV_PRESENT=NO", "NVS_BIN_PRESENT=NO", "FIRST_WRITE_MARKER_PRESENT=YES", "JSON_EVIDENCE_PRESENT=YES",
                 "OTHER_EVIDENCE_CHANGED=NO", "SECRET_VALUE_SCAN_HITS=0", "L8P_ATTEMPT2_RECONCILIATION=PASS", "L8P_RECONCILIATION_DEVICE_ACTION=NONE",
                 "L8P_RECONCILIATION_SECRET_WORK_REMOVED=YES", "L8P_RECONCILIATION_SECRET_SCAN=PASS", "L8P_RECONCILIATION_EVIDENCE_PRESERVED=YES",
                 "L8P_LIVE_EXECUTED=YES", "L8P_PROVISIONING=PASS", "ORIGINAL_RUNNER_FULL_SUCCESS_LINE=NO"):
        assert line in lines, (line, lines)
    assert lines.index("L8P_RECONCILIATION_PRE_CLEANUP_GATES=PASS") < lines.index("SECRET_VALUE_SCAN_HITS=0") < lines.index("L8P_ATTEMPT2_RECONCILIATION=PASS")


# ── 2-12. every pre-cleanup gate refuses BEFORE deleting anything ──────────────────────────────────────────────────────────────────────────

def test_a_wrong_run_id_binding_is_refused(fx: Fx) -> None:
    j = fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json"
    d = json.loads(j.read_text()); d["run_id"] = "l8p-20261004-999999"; j.write_text(json.dumps(d))
    rc, lines = fx.run()
    assert rc == 1 and "run_id" in fail_reason(lines) and (fx.evid / "l8p-work" / "nvs.csv").exists() and (fx.evid / "l8p-work" / "nvs.bin").exists()


def test_a_wrong_evidence_directory_name_is_refused_so_another_attempt_cannot_be_targeted(fx: Fx, tmp_path: Path) -> None:
    other = tmp_path / "evidence" / "2026-10-04-l8p-20261004-030730"
    shutil.copytree(fx.evid, other, symlinks=True)
    before = fx.snapshot()
    rc, lines = fx.run(evidence_root=str(other))
    assert rc == 1 and "not the attempt-2 evidence directory" in fail_reason(lines) and (other / "l8p-work" / "nvs.csv").exists()
    assert fx.snapshot() == before


def test_a_wrong_freeze_directory_name_is_refused(fx: Fx, tmp_path: Path) -> None:
    other = tmp_path / "owner-run" / "2026-10-04-l8p-19pin"
    shutil.copytree(fx.freeze, other, symlinks=True)
    rc, lines = fx.run(freeze_dir=str(other))
    assert rc == 1 and "not the attempt-2 freeze directory" in fail_reason(lines) and (fx.evid / "l8p-work" / "nvs.csv").exists()


def test_a_wrong_frozen_runner_hash_is_refused(fx: Fx) -> None:
    before = fx.snapshot()
    fx.runner.chmod(0o700); fx.runner.write_text("tampered\n"); fx.runner.chmod(0o500)
    before[str(fx.runner)] = (False, "0o500", hashlib.sha256(fx.runner.read_bytes()).hexdigest())
    rc, lines = fx.run()
    assert rc == 1 and "frozen runner SHA-256 mismatch" in fail_reason(lines) and fx.snapshot() == before


def test_the_default_binding_is_the_real_attempt_2_runner_digest() -> None:
    assert T.BINDING.runner_sha256 == "f4804bb62d804ddcc6f469a2be22a49c580b7cc015f288d92401ebd6b405dfe8"
    assert T.BINDING.run_id == "l8p-20261004-041840" and T.BINDING.firmware_sha256 == FIRMWARE


def test_a_missing_consumed_marker_is_refused(fx: Fx) -> None:
    (fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED").unlink()
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "L8p-ATTEMPT-CONSUMED missing", before)


@pytest.mark.parametrize("name", ["authorization-L8p.txt", "k3-L8p.txt"])
def test_a_missing_or_altered_authorization_or_k3_is_refused(fx: Fx, name: str) -> None:
    (fx.evid / name).write_text("altered copy\n")
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "differs from the consumed Authorization/K3", before)
    (fx.freeze / "auth" / name).unlink()
    rc2, lines2 = fx.run()
    assert rc2 == 1 and f"auth/{name} missing" in fail_reason(lines2)


@pytest.mark.parametrize("field,value", [("flash_result", "FAIL"), ("nvs_readback_match", "FAIL"), ("firmware_readback_match", "FAIL"), ("boot_verification_result", "NOT_PROVEN"),
                                         ("failure_boundary", "FIRMWARE_READBACK")])
def test_a_json_field_mismatch_is_refused(fx: Fx, field: str, value: str) -> None:
    j = fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json"
    d = json.loads(j.read_text()); d[field] = value; j.write_text(json.dumps(d))
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, field, before)


def test_json_schema_extra_missing_wrong_mode_or_second_bundle_is_refused(fx: Fx) -> None:
    j = fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json"
    original = j.read_text()
    d = json.loads(original); d["extra"] = 1; j.write_text(json.dumps(d))
    assert "12-field" in fail_reason(fx.run()[1])
    d = json.loads(original); d.pop("chip_identity"); j.write_text(json.dumps(d))
    assert "12-field" in fail_reason(fx.run()[1])
    j.write_text(original); j.chmod(0o644)
    assert "mode is not 0600" in fail_reason(fx.run()[1])
    j.chmod(0o600)
    write(fx.evid / "l8p-evidence" / "l8p-other.json", "{}")
    assert "exactly the one attempt-2 JSON bundle" in fail_reason(fx.run()[1])
    assert (fx.evid / "l8p-work" / "nvs.csv").exists()


def test_a_firmware_digest_mismatch_is_refused(fx: Fx) -> None:
    j = fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json"
    d = json.loads(j.read_text()); d["firmware_sha256"] = "0" * 64; j.write_text(json.dumps(d))
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "firmware_sha256", before)
    frozen = fx.evid / "frozen-inputs.txt"
    d["firmware_sha256"] = FIRMWARE; j.write_text(json.dumps(d))
    frozen.write_text(frozen.read_text().replace(FIRMWARE, "1" * 64))
    assert "pinned firmware digest" in fail_reason(fx.run()[1])


@pytest.mark.parametrize("bundle", ["pre-root", "post-root", "rb-root"])
def test_a_capture_checksum_failure_is_refused(fx: Fx, bundle: str) -> None:
    (fx.evid / bundle / "host.tsv").write_text("tampered\n")
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "checksum failure", before)


def test_a_missing_capture_bundle_checksum_file_or_listed_file_is_refused(fx: Fx) -> None:
    (fx.evid / "post-root" / "SHA256SUMS").unlink()
    assert "SHA256SUMS missing" in fail_reason(fx.run()[1])
    sums_for(fx.evid / "post-root")
    (fx.evid / "post-root" / "host.tsv").unlink()
    assert "listed file missing" in fail_reason(fx.run()[1])
    assert (fx.evid / "l8p-work" / "nvs.csv").exists()


@pytest.mark.parametrize("missing", ["L8P_FLASH_RESULT=PASS", "L8P_NVS_READBACK_MATCH=PASS", "L8P_FIRMWARE_READBACK_MATCH=PASS", "L8P_BOOT_VERIFICATION=PASS",
                                     "L8P_BOOT_VERIFICATION_DETAIL=PASS_BOOT_LOCKDOWN", "L8P_FAILURE_BOUNDARY=NONE", "L8P_APPLY=COMPLETE", "L8P_VERIFY=PASS",
                                     "CAPTURE_PRE=COMPLETE SHA256=PASS", "CAPTURE_POST=COMPLETE SHA256=PASS", "CAPTURE_RB=COMPLETE SHA256=PASS",
                                     "L8P_FIRST_HARDWARE_WRITE=STARTED", "L8P_DEVICE_ACTION_TAKEN=NONE", "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE"])
def test_an_owner_run_required_proof_missing_is_refused(fx: Fx, missing: str) -> None:
    log = fx.evid / "owner-run.log"
    log.write_text("\n".join(l for l in log.read_text().splitlines() if l != missing) + "\n")
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, missing, before)


def test_owner_run_log_other_required_shapes_are_enforced(fx: Fx) -> None:
    log = fx.evid / "owner-run.log"
    original = log.read_text()
    log.write_text(original.replace("L8P_SECRET_VALUE_SCAN_HITS=2", "L8P_SECRET_VALUE_SCAN_HITS=0"))
    assert "2-hit secret scan" in fail_reason(fx.run()[1])
    log.write_text(original.replace("L8P_PROVISIONING=NOT_PROVEN", "L8P_PROVISIONING=UNKNOWN"))
    assert "NOT_PROVEN" in fail_reason(fx.run()[1])
    log.write_text(original.replace("COMPARE_RESULT=PASS", "COMPARE_RESULT=FAIL", 1))
    assert "compare" in fail_reason(fx.run()[1]).lower()
    log.write_text(original.replace("PRESERVATION_S10=PASS\n", "", 1))
    assert "compare/S10" in fail_reason(fx.run()[1])
    assert (fx.evid / "l8p-work" / "nvs.csv").exists()


@pytest.mark.parametrize("extra", ["L8P_LIVE_EXECUTED=YES L8P_PROVISIONING=PASS L8P_APPLY=PASS L8P_VERIFY=PASS", "L8P_LIVE_EXECUTED=YES", "x L8P_PROVISIONING=PASS"])
def test_the_original_full_success_line_unexpectedly_present_is_refused(fx: Fx, extra: str) -> None:
    log = fx.evid / "owner-run.log"
    log.write_text(log.read_text() + extra + "\n")
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "unexpectedly carries", before)


def test_the_first_write_marker_must_exist_and_be_private(fx: Fx) -> None:
    marker = fx.evid / "l8p-work" / "first-write.marker"
    marker.chmod(0o644)
    assert "mode is not 0600" in fail_reason(fx.run()[1])
    marker.chmod(0o600); marker.unlink()
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "first-write marker", before)


# ── secret classification gates ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_an_expected_nvs_csv_hit_missing_is_refused(fx: Fx) -> None:
    (fx.evid / "l8p-work" / "nvs.csv").write_text("no secrets here\n")
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "not exactly the two expected work artifacts", before)


def test_an_expected_nvs_bin_hit_missing_is_refused(fx: Fx) -> None:
    (fx.evid / "l8p-work" / "nvs.bin").write_bytes(b"\0" * 2048)
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "not exactly the two expected work artifacts", before)


def test_a_missing_secret_class_inside_an_expected_hit_file_is_refused(fx: Fx) -> None:
    (fx.evid / "l8p-work" / "nvs.bin").write_bytes(b"\0" * 64 + SECRETS["wifi.psk"].encode() + b"\0" * 64)   # mqtt.pass absent
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "secret classes in l8p-work/nvs.bin are not the expected ones", before)


@pytest.mark.parametrize("where", ["owner-run.log", "l8p-evidence/extra.txt", "pre-root/leak.txt", "post-root/leak.txt", "rb-root/leak.txt", "unrelated.txt", "l8p-work/other.txt", "compare-pre-post.txt"])
@pytest.mark.parametrize("secret", ["wifi.psk", "mqtt.pass", "k_c2d", "k_d2c"])
def test_a_third_secret_hit_file_is_refused_and_never_printed(fx: Fx, where: str, secret: str) -> None:
    target = fx.evid / where
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(SECRETS[secret] + "\n")
    target.chmod(0o600)
    before = fx.snapshot()
    rc, lines = fx.run()
    assert rc == 1, lines
    # a leak into a checksummed bundle/JSON dir may trip an earlier integrity gate; either way nothing changes and no secret is ever printed
    assert fx.snapshot() == before and (fx.evid / "l8p-work" / "nvs.csv").exists() and (fx.evid / "l8p-work" / "nvs.bin").exists()
    assert not any(v in "\n".join(lines) for v in SECRETS.values())
    assert "L8P_PROVISIONING=PASS" not in lines


def test_a_third_secret_hit_file_in_an_unchecksummed_location_is_refused_by_the_classification_gate(fx: Fx) -> None:
    write(fx.evid / "unrelated.txt", SECRETS["mqtt.pass"] + "\n")
    rc, lines = fx.run()
    assert rc == 1 and "not exactly the two expected work artifacts" in fail_reason(lines)
    assert any(l.startswith("L8P_RECONCILIATION_SECRET_HIT path=unrelated.txt") for l in lines)


def test_secret_values_are_never_printed_on_success_or_failure(fx: Fx) -> None:
    rc, lines = fx.run()
    text = "\n".join(lines)
    assert rc == 0 and not any(v in text for v in SECRETS.values())
    hit_lines = [l for l in lines if l.startswith("L8P_RECONCILIATION_SECRET_HIT")]
    assert len(hit_lines) == 2 and all(re.fullmatch(r"L8P_RECONCILIATION_SECRET_HIT path=\S+ size=\d+ classes=[a-z0-9_.,]+", l) for l in hit_lines)


def test_the_secret_input_files_may_be_short_only_with_a_closed_gate(fx: Fx) -> None:
    (fx.inputs / "mqtt.pass").write_text("short\n")
    rc, lines = fx.run()
    assert rc == 1 and "shorter than 8 bytes" in fail_reason(lines)


# ── symlink / path safety ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["nvs.csv", "nvs.bin"])
def test_a_symlinked_artifact_is_refused_and_the_outside_target_is_untouched(fx: Fx, tmp_path: Path, name: str) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("must survive\n" + "".join(v + "\n" for v in SECRETS.values()))
    art = fx.evid / "l8p-work" / name
    art.unlink()
    art.symlink_to(outside)
    rc, lines = fx.run()
    assert rc == 1 and "symlink" in fail_reason(lines), lines
    assert outside.read_text().startswith("must survive") and art.is_symlink() and (fx.evid / "l8p-work" / ("nvs.bin" if name == "nvs.csv" else "nvs.csv")).exists()


def test_a_symlinked_evidence_root_or_work_dir_or_parent_is_refused(fx: Fx, tmp_path: Path) -> None:
    link = tmp_path / "evidence" / "link-to-evid"
    link.symlink_to(fx.evid)
    assert "real directory" in fail_reason(fx.run(evidence_root=str(link))[1])
    parent_link = tmp_path / "parentlink"
    parent_link.symlink_to(fx.evid.parent)
    rc, lines = fx.run(evidence_root=str(parent_link / EVID_NAME))
    assert rc == 1 and "canonical" in fail_reason(lines)
    work = fx.evid / "l8p-work"
    moved = fx.evid / "real-work"
    work.rename(moved)
    work.symlink_to(moved)
    rc, lines = fx.run()
    assert rc == 1 and (moved / "nvs.csv").exists() and (moved / "nvs.bin").exists()
    fl = tmp_path / "freezelink"
    fl.symlink_to(fx.freeze)
    assert "real directory" in fail_reason(fx.run(freeze_dir=str(fl))[1])


@pytest.mark.parametrize("bad", ["relative/evidence", "", "/tmp/../tmp/x", "/tmp//x", "/tmp/./x"])
def test_unsafe_path_arguments_are_refused(fx: Fx, bad: str) -> None:
    rc, lines = fx.run(evidence_root=bad)
    assert rc == 1 and "evidence root" in fail_reason(lines) and (fx.evid / "l8p-work" / "nvs.csv").exists()


def test_a_symlink_anywhere_inside_the_evidence_tree_is_refused(fx: Fx, tmp_path: Path) -> None:
    (fx.evid / "sneaky").symlink_to(tmp_path)
    rc, lines = fx.run()
    assert rc == 1 and "symlink" in fail_reason(lines) and (fx.evid / "l8p-work" / "nvs.csv").exists()


# ── cleanup scope, preservation, post-cleanup proofs ─────────────────────────────────────────────────────────────────────────────────────

def test_cleanup_deletes_exactly_two_files_and_every_other_file_is_unchanged(fx: Fx) -> None:
    before_files = {str(p.relative_to(fx.evid)): (oct(p.lstat().st_mode & 0o777), hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(fx.evid.rglob("*")) if p.is_file()}
    before_dirs = sorted(str(p.relative_to(fx.evid)) for p in fx.evid.rglob("*") if p.is_dir())
    outside_before = {k: v for k, v in fx.snapshot().items() if not k.startswith(str(fx.evid))}
    rc, lines = fx.run()
    assert rc == 0, lines
    after_files = {str(p.relative_to(fx.evid)): (oct(p.lstat().st_mode & 0o777), hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(fx.evid.rglob("*")) if p.is_file()}
    removed = set(before_files) - set(after_files)
    assert removed == {"l8p-work/nvs.csv", "l8p-work/nvs.bin"}
    assert {k: v for k, v in before_files.items() if k not in removed} == after_files
    assert sorted(str(p.relative_to(fx.evid)) for p in fx.evid.rglob("*") if p.is_dir()) == before_dirs
    assert {k: v for k, v in fx.snapshot().items() if not k.startswith(str(fx.evid))} == outside_before, "freeze dir, auth files, consumed marker and inputs are untouched"


def test_the_marker_json_consumed_marker_and_runner_log_remain(fx: Fx) -> None:
    log_before = (fx.evid / "owner-run.log").read_bytes()
    assert fx.run()[0] == 0
    assert (fx.evid / "l8p-work" / "first-write.marker").is_file() and (fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json").is_file()
    assert (fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED").is_file() and (fx.evid / "owner-run.log").read_bytes() == log_before


def test_post_cleanup_the_strict_full_tree_scan_has_zero_hits(fx: Fx) -> None:
    assert fx.run()[0] == 0
    needles = T.read_needles(fx.inputs)
    assert T.scan_tree(fx.evid, needles) == {}
    assert not any(v.encode() in p.read_bytes() for p in fx.evid.rglob("*") if p.is_file() for v in SECRETS.values())


def test_a_late_failure_after_cleanup_reports_fail_without_authoritative_fields(fx: Fx, monkeypatch) -> None:
    real = T.manifest
    calls = {"n": 0}

    def drifting(evid):
        calls["n"] += 1
        result = real(evid)
        if calls["n"] == 2:
            result = dict(result); result["owner-run.log"] = ("file", 0o600, 1, "0" * 64)
        return result
    monkeypatch.setattr(T, "manifest", drifting)
    rc, lines = fx.run()
    assert rc == 1 and "preserved evidence changed" in fail_reason(lines)
    assert "L8P_PROVISIONING=PASS" not in lines and "L8P_LIVE_EXECUTED=YES" not in lines and "L8P_ATTEMPT2_RECONCILIATION=PASS" not in lines


def test_a_second_run_on_the_already_reconciled_tree_fails_closed(fx: Fx) -> None:
    assert fx.run()[0] == 0
    after_first = fx.snapshot()
    rc, lines = fx.run()
    assert rc == 1 and "not exactly the two expected work artifacts" in fail_reason(lines)
    assert "L8P_PROVISIONING=PASS" not in lines and fx.snapshot() == after_first


# ── the consumed marker: real location and real shape (review finding 1) ─────────────────────────────────────────────────────────────────

def test_the_real_shape_consumed_marker_is_the_regular_0600_auth_file_with_consumed_at(fx: Fx) -> None:
    marker = fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED"
    assert marker.is_file() and not marker.is_symlink() and oct(marker.stat().st_mode & 0o777) == "0o600" and len(marker.read_bytes()) == 33
    assert re.fullmatch(rb"consumed_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n", marker.read_bytes())
    rc, lines = fx.run()
    assert rc == 0 and "ATTEMPT2_CONSUMED_MARKER_PRESENT=YES" in lines and "ATTEMPT2_CONSUMPTION_PROOF=CONSUMED_MARKER" in lines


@pytest.mark.parametrize("content,mode,needle", [
    ("consumed_at=not-a-timestamp\n", 0o600, "shape"), ("hello\n", 0o600, "shape"), ("consumed_at=2026-10-03T21:18:52Z", 0o600, "shape"),
    ("consumed_at=2026-10-03T21:18:52Z\n", 0o644, "mode is not 0600"), ("", 0o600, "shape")])
def test_a_consumed_marker_in_the_wrong_shape_or_mode_is_refused_and_never_repaired(fx: Fx, content: str, mode: int, needle: str) -> None:
    marker = fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED"
    marker.write_text(content); marker.chmod(mode)
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, needle, before)
    assert marker.read_text() == content, "the marker is never rewritten"


def test_a_symlinked_consumed_marker_is_refused_and_there_is_no_fallback_for_its_absence(fx: Fx, tmp_path: Path) -> None:
    marker = fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED"
    real = tmp_path / "elsewhere-marker"
    real.write_text(marker.read_text()); real.chmod(0o600)
    marker.unlink(); marker.symlink_to(real)
    assert "missing or not a regular file" in fail_reason(fx.run()[1])
    marker.unlink()
    before = fx.snapshot()
    rc, lines = fx.run()
    assert_refused_untouched(fx, lines, rc, "missing or not a regular file", before)
    assert not marker.exists(), "the tool never creates the marker, even though the historical execution evidence is complete"
    assert "ATTEMPT2_CONSUMPTION_PROOF=HISTORICAL_EXECUTION_EVIDENCE" not in lines and "L8P_PROVISIONING=PASS" not in lines


# ── cleanup errors fail closed and are reported as mutations, not refusals (review finding 3) ────────────────────────────────────────────────

NO_AUTHORITATIVE = ("L8P_ATTEMPT2_RECONCILIATION=PASS", "L8P_LIVE_EXECUTED=YES", "L8P_PROVISIONING=PASS", "L8P_RECONCILIATION_SECRET_WORK_REMOVED=YES", "L8P_RECONCILIATION_SECRET_SCAN=PASS",
                    "L8P_RECONCILIATION_EVIDENCE_PRESERVED=YES", "ORIGINAL_RUNNER_FULL_SUCCESS_LINE=NO")


def inject_unlink_failure(monkeypatch, fail_on: str):
    real = os.unlink

    def flaky(path, *a, **k):
        if Path(path).name == fail_on:
            raise PermissionError(13, "Permission denied (injected)", str(path))
        return real(path, *a, **k)
    monkeypatch.setattr(T.os, "unlink", flaky)


@pytest.mark.parametrize("fail_on,removed_state,remaining", [("nvs.bin", "PARTIAL_REMOVED=nvs.csv", {"nvs.bin"}), ("nvs.csv", "NONE_REMOVED", {"nvs.csv", "nvs.bin"})])
def test_an_injected_deletion_error_fails_closed_without_any_authoritative_field(fx: Fx, monkeypatch, fail_on: str, removed_state: str, remaining: set) -> None:
    inject_unlink_failure(monkeypatch, fail_on)
    rc, lines = fx.run()
    text = "\n".join(lines)
    assert rc == 1, lines
    assert any(l.startswith("L8P_ATTEMPT2_RECONCILIATION=FAIL phase=CLEANUP reason=removal of " + fail_on + " failed (PermissionError)") for l in lines), lines
    assert f"L8P_RECONCILIATION_MUTATION_STATE={removed_state}" in lines
    assert not any(a in lines for a in NO_AUTHORITATIVE), lines
    assert not any(v in text for v in SECRETS.values()), "no secret value in the failure output"
    work = fx.evid / "l8p-work"
    assert {n for n in ("nvs.csv", "nvs.bin") if (work / n).exists()} == remaining
    assert (work / "first-write.marker").is_file() and (fx.evid / "l8p-evidence" / f"l8p-{RUN_ID}.json").is_file() and (fx.freeze / "auth" / "L8p-ATTEMPT-CONSUMED").is_file()
    expected_mutation = "PARTIAL_OR_COMPLETE" if removed_state.startswith("PARTIAL") else "NO"
    assert f"L8P_RECONCILIATION_MUTATION_PERFORMED={expected_mutation}" in lines


def test_a_deletion_failure_is_not_reported_as_a_pre_cleanup_refusal(fx: Fx, monkeypatch) -> None:
    inject_unlink_failure(monkeypatch, "nvs.bin")
    _rc, lines = fx.run()
    assert "L8P_RECONCILIATION_PRE_CLEANUP_GATES=PASS" in lines, "the pre-cleanup gates had passed"
    assert not any("phase=PRE_CLEANUP" in l for l in lines)


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory write permission")
def test_an_unwritable_work_dir_is_refused_before_the_first_removal(fx: Fx) -> None:
    work = fx.evid / "l8p-work"
    work.chmod(0o500)
    try:
        rc, lines = fx.run()
    finally:
        work.chmod(0o700)
    assert rc == 1 and any("not writable; nothing was removed" in l for l in lines), lines
    assert "L8P_RECONCILIATION_MUTATION_STATE=NONE_REMOVED" in lines and "L8P_RECONCILIATION_MUTATION_PERFORMED=NO" in lines
    assert (work / "nvs.csv").exists() and (work / "nvs.bin").exists() and not any(a in lines for a in NO_AUTHORITATIVE)


def test_a_filesystem_error_after_cleanup_is_a_controlled_post_cleanup_failure(fx: Fx, monkeypatch) -> None:
    real_scan = T.scan_tree
    calls = {"n": 0}

    def scan_then_fail(evid, needles):
        calls["n"] += 1
        if calls["n"] == 2:
            raise PermissionError(13, "Permission denied (injected)", "x")
        return real_scan(evid, needles)
    monkeypatch.setattr(T, "scan_tree", scan_then_fail)
    rc, lines = fx.run()
    assert rc == 1 and any(l.startswith("L8P_ATTEMPT2_RECONCILIATION=FAIL phase=POST_CLEANUP reason=filesystem error (PermissionError)") for l in lines), lines
    assert "L8P_RECONCILIATION_MUTATION_PERFORMED=PARTIAL_OR_COMPLETE" in lines and not any(a in lines for a in NO_AUTHORITATIVE)
    assert not (fx.evid / "l8p-work" / "nvs.csv").exists(), "the failure report is honest: the files were already removed"


def test_an_unexpected_filesystem_error_before_cleanup_is_a_controlled_pre_cleanup_refusal(fx: Fx, monkeypatch) -> None:
    def boom(*a, **k):
        raise PermissionError(13, "Permission denied (injected)", "x")
    monkeypatch.setattr(T, "verify_capture_bundles", boom)
    before = fx.snapshot()
    rc, lines = fx.run()
    assert rc == 1 and any(l.startswith("L8P_ATTEMPT2_RECONCILIATION=FAIL phase=PRE_CLEANUP reason=filesystem error (PermissionError)") for l in lines)
    assert fx.snapshot() == before and not any(a in lines for a in NO_AUTHORITATIVE)


def test_no_failure_path_ever_prints_an_authoritative_field(fx: Fx, monkeypatch) -> None:
    inject_unlink_failure(monkeypatch, "nvs.csv")
    _rc, lines = fx.run()
    assert not any(l.startswith(("L8P_LIVE_EXECUTED=", "L8P_PROVISIONING=", "L8P_ATTEMPT2_RECONCILIATION=PASS", "ORIGINAL_RUNNER_FULL_SUCCESS_LINE=")) for l in lines)


# ── the canonical note must carry real receipt paths, never shell placeholders (review finding 2) ──────────────────────────────────────────

def test_the_canonical_idea3_note_has_no_shell_placeholders_and_links_the_real_receipts() -> None:
    note = (ROOT.parent / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "idea3" / "idea3-status.md").read_text()
    logs = ROOT.parent / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "90-Status" / "logs"
    assert "$(basename" not in note and not re.search(r"90-Status/logs/\$", note), "an unexpanded shell placeholder leaked into the canonical note"
    for receipt in ("2026-10-04_064914_music_idea3-l8p-attempt2-reconciliation-contract.md", "2026-10-04_043853_music_idea3-l8p-attempt2-forensic-and-secret-staging-lifecycle.md"):
        assert f"90-Status/logs/{receipt}" in note, receipt
        assert (logs / receipt).is_file(), receipt


# ── command line ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def run_cli(*args: str):
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, check=False, env={"PATH": os.environ.get("PATH", ""), "HOME": "/nonexistent"})


def test_the_cli_requires_the_three_arguments_and_offers_no_override(fx: Fx) -> None:
    assert run_cli().returncode == 2
    assert run_cli("--evidence-root", str(fx.evid), "--freeze-dir", str(fx.freeze)).returncode == 2
    for flag in ("--run-id", "--binding", "--runner-sha256", "--device", "--port", "--extra"):
        res = run_cli("--evidence-root", str(fx.evid), "--freeze-dir", str(fx.freeze), "--input-dir", str(fx.inputs), flag, "x")
        assert res.returncode == 2
    assert (fx.evid / "l8p-work" / "nvs.csv").exists(), "a rejected command line changes nothing"


def test_the_cli_uses_the_real_attempt_2_binding_so_the_fixture_runner_hash_is_refused(fx: Fx) -> None:
    res = run_cli("--evidence-root", str(fx.evid), "--freeze-dir", str(fx.freeze), "--input-dir", str(fx.inputs))
    assert res.returncode == 1 and "frozen runner SHA-256 mismatch" in res.stdout, res.stdout + res.stderr
    assert (fx.evid / "l8p-work" / "nvs.csv").exists() and not any(v in res.stdout + res.stderr for v in SECRETS.values())


# ── static: no device capability, one-off, no real-path references ───────────────────────────────────────────────────────────────────────

def code_of(path: Path) -> str:
    text = re.sub(r'"""[\s\S]*?"""', "", path.read_text())
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def test_the_tool_has_no_device_serial_mqtt_service_or_network_capability() -> None:
    import ast
    tree = ast.parse(TOOL.read_text())
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert imported <= {"__future__", "argparse", "hashlib", "json", "os", "re", "stat", "sys", "dataclasses", "pathlib"}, imported
    code = code_of(TOOL)
    for banned in ("subprocess", "socket", "serial", "esptool", "paho", "mosquitto", "systemctl", "sudo", "nmcli", "write_flash", "read_flash", "erase_flash", "flash_id",
                   "/dev/", "os.system", "popen", "shutil", "rmtree", "os.remove(", "os.rmdir"):
        assert banned not in code, banned
    assert not re.search(r"\bCUT\b|\bRESTORE\b", code), "no CUT / RESTORE behaviour"
    assert code.count("os.unlink(") == 1 and "for name in CLEANUP_ARTIFACTS:\n        try:\n            os.unlink(work / name)" in code, "exactly one deletion site, over the two fixed names"
    assert 'CLEANUP_ARTIFACTS = ("nvs.csv", "nvs.bin")' in code


def test_the_tool_is_one_off_and_hard_bound_to_attempt_2() -> None:
    text = TOOL.read_text()
    for needle in ("l8p-20261004-041840", "2026-10-04-l8p-20261004-041840", "2026-10-04-l8p-successor2", "f4804bb62d804ddcc6f469a2be22a49c580b7cc015f288d92401ebd6b405dfe8", FIRMWARE):
        assert needle in text, needle
    main_src = text[text.index("def main("):]
    assert "BINDING" in main_src and "binding=" not in main_src.replace("BINDING)", ""), "main always uses the real binding"


def test_these_tests_never_reference_or_mutate_the_real_historical_paths() -> None:
    src = Path(__file__).read_text()
    body = src[: src.index("def test_these_tests_never_reference")]   # excludes this function, whose own literals would match
    for real in ("/home/", "idea3-p4-owner-run", "idea3-p4-evidence", "aegis-owner-private", "Workspace"):
        assert real not in body, real
    assert "Path.home" not in body and "expanduser" not in body and "tmp_path" in body
