"""Hermetic tests for the READ-ONLY CTv CLOSED_FAIL successor attestation (stage CTv-fail-successor-attestation).

Nothing here touches the real host: systemctl/pgrep/nft are stubs on a test-only PATH, the canonical and work directories are temp
directories, and the exact-main git repository is a temp repo holding byte-copies of the real scripts, libraries and receipts.
The live Production proof is NOT executed by these tests.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "IDEA3-AEGIS_Lockdown"
P4 = APP / "deploy" / "pr11-phase4"
INCIDENT = P4 / "ctv-incident"
ATTEST_SRC = INCIDENT / "ctv-fail-successor-attest.sh"
LOGS = ROOT / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "90-Status" / "logs"

_spec = importlib.util.spec_from_file_location("ctv_option_b_tests", Path(__file__).with_name("test_ctv_incident_option_b.py"))
opt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(opt)

_r1i_spec = importlib.util.spec_from_file_location("r1i_tool", P4 / "r1i-input-instrumentation" / "r1i_input_instrumentation.py")
r1i = importlib.util.module_from_spec(_r1i_spec)
_r1i_spec.loader.exec_module(r1i)

R1BV_CLOSURE = ("p4-r1bv-run-lib.sh p4-f1u-run-lib.sh p4-f1i-run-lib.sh p4-f1r-run-lib.sh p4-f1-run-lib.sh p4-l6b-run-lib.sh "
                "p4-l7-run-lib.sh p4-l7u-run-lib.sh p4-l8p-run-lib.sh p4-ntp-reactivation-lib.sh").split()
ATTEST_FILES = (
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-fail-successor-attest.sh",
    *(f"IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/{lib}" for lib in R1BV_CLOSURE),
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/r1i-input-instrumentation/r1i_input_instrumentation.py",
)
LOG_FILES = tuple(f"Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/{p.name}" for p in sorted(LOGS.glob("*.md")))
CLOSEOUT_KEYS = [
    "CTV_RESULT", "CTV_LIVE", "CTV_LIVE_EXECUTED", "CTV_ATTEMPT_CONSUMED", "CTV_RERUN_ALLOWED", "CTV_IS_CTU_RETRY", "CTV_FAILURE_REASON",
    "CTV_INCIDENT_DISPOSITION", "CTV_INCIDENT_AUTHORIZATION_ID", "CTV_ROLLBACK_COMPLETE", "CTV_TARGET_UNIT_RETAINED", "CTV_ADDITIONAL_CORE_RESTART",
    "CTV_ADDITIONAL_DETECTOR_COMMANDS", "CTV_S10_HISTORICAL_COMPARE", "CTV_S10_PROMOTED_TO_PASS", "CTV_RECOVERY_AUTHORIZED", "CTV_JOURNAL_PHASE",
    "CTV_EXPECTED_MAIN", "CTV_DISPOSITION_MAIN", "CTV_UNIT_SHA256", "CTV_PREIMAGE_SHA256", "CTV_DEVICE_ID", "CTV_DETECTOR_BASELINE_MODE",
    "CTV_TRUSTEDCLOCK_AT_DISPOSITION", "CTV_CORE_MAINPID_AT_DISPOSITION", "CTV_FROZEN_RUNNER_SHA256", "CTV_EVIDENCE_PRE_SHA256SUMS_SHA256",
    "CTV_EVIDENCE_POST_SHA256SUMS_SHA256", "CTV_COMPARE_OUTPUT_SHA256", "CTV_VERIFIER_SHA256", "CTV_DISPOSITION_ACTION_SHA256", "CTV_GUARD_SHA256",
    "CTV_STATE_SHA256", "CTV_DISPOSITION_RECORDED_AT_UTC",
]
R1I_STATE = (
    f"table {r1i.FAMILY} {r1i.TABLE} {{\n\tchain input {{\n\t\ttype filter hook input priority filter - 10; policy accept;\n\t\t{r1i.RULE}\n\t}}\n}}\n"
)
NFT = '''#!/bin/bash
base="$(dirname "$(readlink -f "$0")")/.."
echo "nft $*" >> "$base/calls"
case "$*" in
  "list tables") cat "$base/nft_tables" 2>/dev/null ;;
  "--stateless list table inet aegis_idea3_r1i") cat "$base/nft_r1i" 2>/dev/null || exit 1 ;;
  *) exit 1 ;;
esac
'''


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class AttestWorld(opt.World):
    """The Option B world plus the attestation, its R1B gate closure, the R1I tool, the receipts, and a recorded CTv FAIL history."""

    def __init__(self, tmp: Path, *, logs: bool = True) -> None:
        saved = opt.REPO_FILES
        opt.REPO_FILES = (*saved, *ATTEST_FILES, *(LOG_FILES if logs else ()))
        try:
            super().__init__(tmp)
        finally:
            opt.REPO_FILES = saved
        self.attest = self.repo / ATTEST_FILES[0]
        (self.bin / "nft").write_text(NFT)
        (self.bin / "nft").chmod(0o755)
        (tmp / "nft_tables").write_text(f"table {r1i.FAMILY} {r1i.TABLE}\n")
        (tmp / "nft_r1i").write_text(R1I_STATE)
        self.write_history()

    # -- recorded CTv history
    def closeout_fields(self) -> dict[str, str]:
        pre, post, cmp_ = self.digests()
        return {
            "CTV_RESULT": "FAIL_IMMUTABLE", "CTV_LIVE": "CLOSED_FAIL", "CTV_LIVE_EXECUTED": "YES", "CTV_ATTEMPT_CONSUMED": "YES",
            "CTV_RERUN_ALLOWED": "NO", "CTV_IS_CTU_RETRY": "NO", "CTV_FAILURE_REASON": "S10_COMPARE_FAIL_ROLLBACK_INCOMPLETE_TARGET_UNIT_RETAINED",
            "CTV_INCIDENT_DISPOSITION": "OPTION_B_TARGET_UNIT_RETAINED", "CTV_INCIDENT_AUTHORIZATION_ID": "AUTH-TEST-0001",
            "CTV_ROLLBACK_COMPLETE": "NO", "CTV_TARGET_UNIT_RETAINED": "YES", "CTV_ADDITIONAL_CORE_RESTART": "NO",
            "CTV_ADDITIONAL_DETECTOR_COMMANDS": "0", "CTV_S10_HISTORICAL_COMPARE": "FAIL", "CTV_S10_PROMOTED_TO_PASS": "NO",
            "CTV_RECOVERY_AUTHORIZED": "NO", "CTV_JOURNAL_PHASE": "apply-verified", "CTV_EXPECTED_MAIN": self.main, "CTV_DISPOSITION_MAIN": self.main,
            "CTV_UNIT_SHA256": opt.PIN_UNIT, "CTV_PREIMAGE_SHA256": self.pre_sha, "CTV_DEVICE_ID": opt.DEVICE, "CTV_DETECTOR_BASELINE_MODE": "INACTIVE",
            "CTV_TRUSTEDCLOCK_AT_DISPOSITION": "SYNCED", "CTV_CORE_MAINPID_AT_DISPOSITION": "1234", "CTV_FROZEN_RUNNER_SHA256": "a" * 64,
            "CTV_EVIDENCE_PRE_SHA256SUMS_SHA256": pre, "CTV_EVIDENCE_POST_SHA256SUMS_SHA256": post, "CTV_COMPARE_OUTPUT_SHA256": cmp_,
            "CTV_VERIFIER_SHA256": "b" * 64, "CTV_DISPOSITION_ACTION_SHA256": "c" * 64, "CTV_GUARD_SHA256": "d" * 64, "CTV_STATE_SHA256": "e" * 64,
            "CTV_DISPOSITION_RECORDED_AT_UTC": "2026-10-08T11:00:00Z",
        }

    def write_history(self, *, set_: dict[str, str] | None = None, drop: tuple[str, ...] = (), extra: str = "", marker_extra: str = "",
                      marker_set: dict[str, str] | None = None, sidecar: bool = True) -> None:
        fields = self.closeout_fields()
        fields.update(set_ or {})
        body = "".join(f"{k}={v}\n" for k, v in fields.items() if k not in drop) + extra
        closeout = self.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
        for path in (closeout, Path(f"{closeout}.sha256")):
            path.unlink(missing_ok=True)
        closeout.write_text(body)
        closeout.chmod(0o600)
        self.closeout_sha = sha(closeout)
        if sidecar:
            Path(f"{closeout}.sha256").write_text(f"{self.closeout_sha}  CTV-GLOBAL-CLOSEOUT-FAIL\n")
            Path(f"{closeout}.sha256").chmod(0o444)
        marker = {
            "CTV_ATTEMPT_CONSUMED": "YES", "CTV_RERUN_ALLOWED": "NO", "CTV_FROZEN_RUNNER_SHA256": "a" * 64, "CTV_RUNNER_TEMPLATE_SHA256": "f" * 64,
            "CTV_BUNDLE_MANIFEST_SHA256": "1" * 64, "CTV_CONTROL_MANIFEST_SHA256": "2" * 64, "work": str(self.work),
        }
        marker.update(marker_set or {})
        path = self.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED"
        path.write_text("".join(f"{k}={v}\n" for k, v in marker.items()) + marker_extra)
        path.chmod(0o600)

    def run(self, *more: str, env: dict[str, str] | None = None, closeout_sha: str | None = None,
            script: Path | None = None) -> subprocess.CompletedProcess[str]:
        args = [*self.common(), "--closeout-sha256", closeout_sha or self.closeout_sha, *more]
        return subprocess.run([str(script or self.attest), *args], text=True, capture_output=True, env=env or self.env())

    def tree(self) -> dict[str, tuple[int, int, str]]:
        out = {}
        for base in (self.canon, self.work, self.unit.parent / self.unit.name):
            paths = [base] if base.is_file() else [p for p in base.rglob("*")] + [base]
            for p in paths:
                st = p.lstat()
                out[str(p)] = (st.st_mtime_ns, st.st_mode, sha(p) if p.is_file() and not p.is_symlink() else "")
        return out

    def recommit(self) -> None:
        opt.git(self.repo, "add", ".")
        opt.git(self.repo, "commit", "-qm", "mutated", "--allow-empty")
        self.main = opt.git(self.repo, "rev-parse", "HEAD")


@pytest.fixture()
def world(tmp_path: Path) -> AttestWorld:
    return AttestWorld(tmp_path)


PARTIAL_RC = 3  # sections A-C pass, but a Recovery prerequisite is BLOCKED/UNKNOWN: the verdict is PARTIAL and the exit status is non-zero


def facts(proc: subprocess.CompletedProcess[str]) -> dict[str, str]:
    return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)


def reason(proc: subprocess.CompletedProcess[str]) -> str:
    return proc.stderr.strip()


# ──────────────────────────────────────────────── valid history and read-only behaviour ────────────────────────────────────────────────
def test_valid_trusted_fail_history_is_attested_without_promoting_or_authorizing_anything(world: AttestWorld) -> None:
    proc = world.run()
    assert proc.returncode == PARTIAL_RC, proc.stderr + proc.stdout   # release/CLI is UNKNOWN, so the verdict can only be PARTIAL
    f = facts(proc)
    assert f["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PARTIAL" and f["CTV_FAIL_SUCCESSOR_HISTORY_AND_CURRENT_STATE"] == "PASS"
    assert f["CTV_FAIL_SUCCESSOR_STAGE"] == "CTv-fail-successor-attestation"
    assert f["CTV_FAIL_SUCCESSOR_CTV_HISTORY"] == "IMMUTABLE_FAIL"
    assert f["CTV_FAIL_SUCCESSOR_CLOSEOUT_SHA256"] == world.closeout_sha
    assert f["CTV_FAIL_SUCCESSOR_HISTORICAL_RESULT"] == "FAIL_IMMUTABLE"
    assert f["CTV_FAIL_SUCCESSOR_PROMOTES_CTV_TO_PASS"] == "NO"
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED"] == "NO"
    assert f["CTV_FAIL_SUCCESSOR_WIRED_INTO_RECOVERY"] == "NO"
    assert re.fullmatch(r"[0-9a-f]{64}", f["CTV_FAIL_SUCCESSOR_BINDING_SHA256"])
    # The binding digest covers stable facts only: a second run on the unchanged history yields the same value.
    assert facts(world.run())["CTV_FAIL_SUCCESSOR_BINDING_SHA256"] == f["CTV_FAIL_SUCCESSOR_BINDING_SHA256"]


def test_historical_s10_stays_fail_and_preservation_is_not_claimed(world: AttestWorld) -> None:
    f = facts(world.run())
    assert f["CTV_FAIL_SUCCESSOR_HISTORICAL_S10"] == "FAIL"
    assert f["CTV_FAIL_SUCCESSOR_PRESERVATION_PRE_TO_POST"] == "NOT_PROVEN_HISTORICAL_FAIL"
    assert f["CTV_FAIL_SUCCESSOR_FIXES_HISTORICAL_S10"] == "NO"
    assert "TRUSTEDCLOCK_NOW" in f["CTV_FAIL_SUCCESSOR_CURRENT_STATE_SCOPE"]  # the current clock proof is scoped to "now"


def test_zero_production_side_effects_and_only_read_verbs_were_used(world: AttestWorld) -> None:
    before = world.tree()
    proc = world.run()
    assert proc.returncode == PARTIAL_RC, proc.stderr
    assert world.tree() == before  # no file created, removed, rewritten, re-moded or re-timed
    calls = (world.tmp / "calls").read_text().splitlines()
    assert calls and all(c.startswith(("systemctl show", "nft list tables", "nft --stateless list table")) for c in calls)
    f = facts(proc)
    assert (f["CTV_FAIL_SUCCESSOR_READ_ONLY"], f["CTV_FAIL_SUCCESSOR_PRODUCTION_MUTATION"], f["CTV_FAIL_SUCCESSOR_ATTEMPT_CONSUMED"],
            f["CTV_FAIL_SUCCESSOR_CORE_RESTART"], f["CTV_FAIL_SUCCESSOR_DEVICE_COMMANDS"]) == ("YES", "NO", "NO", "NO", "0")
    assert not list(world.canon.glob("RECOVERY-*")) and not list(world.canon.glob("*.tmp*"))


def test_script_contains_no_mutating_verbs_consumers_or_recovery_wiring() -> None:
    text = ATTEST_SRC.read_text()
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    for forbidden in (r"systemctl\s+(restart|start|stop|reload|daemon-reload|enable|disable|kill|mask)", r"nft\s+(add|delete|flush|create|insert|replace)",
                      r"\binstall\b", r"\brm\b", r"\bmv\b", r"\bcp\b", r"\btee\b", r"\bchmod\b", r"\bchown\b", r"\bln\b", r"\bmkdir\b", r"\btouch\b",
                      r"mosquitto_pub", r"\bmqtt", r"consume_attempt", r"record_failure", r"record_success", r"ctv_apply_governed", r"ctv_rollback", r">\s*\"?\$"):
        assert not re.search(forbidden, code), forbidden
    for wired in ("recovery_ctu_successor_gate", "recovery_ctv_successor_gate", "CTV-GLOBAL-CLOSEOUT-PASS"):
        assert wired not in code.replace("# ", "") or wired == "CTV-GLOBAL-CLOSEOUT-PASS" and "FAIL_IMMUTABLE" in code
    for existing in (P4 / "p4-recovery-run-lib.sh", P4 / "owner-run" / "run-recovery-owner.sh", P4 / "recovery-acceptance" / "recovery_runner_freeze.py",
                     P4 / "p4-ctv-run-lib.sh", P4 / "owner-run" / "run-ctv-owner.sh"):
        assert "ctv-fail-successor" not in existing.read_text(), existing


def test_r1bv_gate_closure_in_the_script_is_the_complete_source_closure() -> None:
    declared = re.search(r'^R1BV_CLOSURE="([^"]+)"', ATTEST_SRC.read_text(), re.M).group(1).split()
    assert declared == R1BV_CLOSURE
    seen, todo = set(), ["p4-r1bv-run-lib.sh"]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        for match in re.finditer(r'^\s*\.\s+"?\$[A-Za-z0-9_]*DIR"?/(p4-[a-z0-9-]+\.sh)', (P4 / name).read_text(), re.M):
            todo.append(match.group(1))
    assert seen == set(declared)


# ──────────────────────────────────────────────── A. immutable history guards ────────────────────────────────────────────────
def test_tampered_closeout_bytes_do_not_match_the_pinned_digest(world: AttestWorld) -> None:
    closeout = world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    closeout.write_text(closeout.read_text().replace("CTV_RESULT=FAIL_IMMUTABLE", "CTV_RESULT=CLOSED_PASS"))
    proc = world.run()
    assert proc.returncode != 0 and "CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD" in reason(proc)


@pytest.mark.parametrize("sidecar_text", ["", f"{'0' * 64}  CTV-GLOBAL-CLOSEOUT-FAIL\n", "not-a-digest\n", "{sha}  OTHER-NAME\n", "{sha}  CTV-GLOBAL-CLOSEOUT-FAIL\n\n"])
def test_invalid_sha256_sidecar_is_rejected(world: AttestWorld, sidecar_text: str) -> None:
    sidecar = world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256"
    sidecar.chmod(0o644)
    sidecar.write_text(sidecar_text.replace("{sha}", world.closeout_sha))
    sidecar.chmod(0o444)
    proc = world.run()
    expected = "SIDECAR_UNTRUSTED" if sidecar_text == "" else "CLOSEOUT_SIDECAR_INVALID"  # stat reports an empty file as "regular empty file"
    assert proc.returncode != 0 and expected in reason(proc), reason(proc)


def test_missing_sidecar_missing_marker_and_missing_closeout_fail_closed(world: AttestWorld) -> None:
    (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").unlink()
    assert "CTV_NAMESPACE_NOT_EXACT" in reason(world.run())
    world.write_history()
    (world.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").unlink()
    assert "CTV_NAMESPACE_NOT_EXACT" in reason(world.run())
    world.write_history()
    (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").unlink()
    (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").unlink()
    assert "CTV_NAMESPACE_NOT_EXACT" in reason(world.run())


@pytest.mark.parametrize("name", ["CTV-GLOBAL-CLOSEOUT-PASS", "CTV-GLOBAL-CLOSEOUT-PASS.sha256", "CTV-GLOBAL-CLOSEOUT-FAIL.tmp.123", "CTV-EXTRA"])
def test_contradictory_pass_or_stray_ctv_entries_are_rejected(world: AttestWorld, name: str) -> None:
    (world.canon / name).write_text("CTV_RESULT=CLOSED_PASS\n")
    proc = world.run()
    assert proc.returncode != 0 and "CTV_NAMESPACE_NOT_EXACT" in reason(proc)


@pytest.mark.parametrize("change,expected", [
    ({"CTV_RESULT": "CLOSED_PASS"}, "CLOSEOUT_FIELD_INVALID_CTV_RESULT"),
    ({"CTV_LIVE": "CLOSED_PASS"}, "CLOSEOUT_FIELD_INVALID_CTV_LIVE"),
    ({"CTV_RERUN_ALLOWED": "YES"}, "CLOSEOUT_FIELD_INVALID_CTV_RERUN_ALLOWED"),
    ({"CTV_ROLLBACK_COMPLETE": "YES"}, "CLOSEOUT_FIELD_INVALID_CTV_ROLLBACK_COMPLETE"),
    ({"CTV_S10_HISTORICAL_COMPARE": "PASS"}, "CLOSEOUT_FIELD_INVALID_CTV_S10_HISTORICAL_COMPARE"),
    ({"CTV_S10_PROMOTED_TO_PASS": "YES"}, "CLOSEOUT_FIELD_INVALID_CTV_S10_PROMOTED_TO_PASS"),
    ({"CTV_RECOVERY_AUTHORIZED": "YES"}, "CLOSEOUT_FIELD_INVALID_CTV_RECOVERY_AUTHORIZED"),
    ({"CTV_ADDITIONAL_CORE_RESTART": "YES"}, "CLOSEOUT_FIELD_INVALID_CTV_ADDITIONAL_CORE_RESTART"),
    ({"CTV_UNIT_SHA256": "0" * 64}, "CLOSEOUT_FIELD_INVALID_CTV_UNIT_SHA256"),
    ({"CTV_PREIMAGE_SHA256": "0" * 64}, "CLOSEOUT_FIELD_INVALID_CTV_PREIMAGE_SHA256"),
    ({"CTV_DEVICE_ID": "other-device"}, "CLOSEOUT_FIELD_INVALID_CTV_DEVICE_ID"),
    ({"CTV_DETECTOR_BASELINE_MODE": "ACTIVE"}, "CLOSEOUT_FIELD_INVALID_CTV_DETECTOR_BASELINE_MODE"),
    ({"CTV_STATE_SHA256": "xyz"}, "CLOSEOUT_FIELD_INVALID_CTV_STATE_SHA256"),
    ({"CTV_CORE_MAINPID_AT_DISPOSITION": "0"}, "CLOSEOUT_FIELD_INVALID_CTV_CORE_MAINPID_AT_DISPOSITION"),
    ({"CTV_DISPOSITION_RECORDED_AT_UTC": "yesterday"}, "CLOSEOUT_FIELD_INVALID_CTV_DISPOSITION_RECORDED_AT_UTC"),
    ({"CTV_DISPOSITION_MAIN": "0" * 40}, "CLOSEOUT_MAIN_FIELDS_INVALID"),
    ({"CTV_EXPECTED_MAIN": "1" * 40}, "CLOSEOUT_MAIN_FIELDS_INVALID"),
])
def test_closeout_with_a_wrong_value_is_rejected_even_when_resealed_and_repinned(world: AttestWorld, change: dict[str, str], expected: str) -> None:
    world.write_history(set_=change)  # the closeout, its sidecar and the pin all agree: only the strict contract can reject it
    proc = world.run()
    assert proc.returncode != 0 and expected in reason(proc), reason(proc)


def test_disposition_main_that_is_not_an_ancestor_is_rejected(world: AttestWorld) -> None:
    other = "9" * 40
    world.write_history(set_={"CTV_DISPOSITION_MAIN": other, "CTV_EXPECTED_MAIN": other})
    proc = world.run()
    assert proc.returncode != 0 and "CLOSEOUT_MAIN_NOT_AN_ANCESTOR" in reason(proc)


@pytest.mark.parametrize("kind", ["unknown_key", "duplicate_key", "missing_key", "bad_charset", "blank_line"])
def test_closeout_schema_must_be_exact(world: AttestWorld, kind: str) -> None:
    if kind == "unknown_key":
        world.write_history(extra="CTV_RESULT_EXTRA=YES\n")
    elif kind == "duplicate_key":
        world.write_history(extra="CTV_RESULT=FAIL_IMMUTABLE\n")
    elif kind == "missing_key":
        world.write_history(drop=("CTV_STATE_SHA256",))
    elif kind == "bad_charset":
        world.write_history(set_={"CTV_FAILURE_REASON": "S10 COMPARE;rm -rf"})
    else:
        world.write_history(extra="\n")
    proc = world.run()
    assert proc.returncode != 0 and "CLOSEOUT_SCHEMA_NOT_EXACT" in reason(proc)


@pytest.mark.parametrize("marker_change,expected", [
    ({"CTV_RERUN_ALLOWED": "YES"}, "MARKER_FIELD_INVALID"), ({"CTV_ATTEMPT_CONSUMED": "NO"}, "MARKER_FIELD_INVALID"),
    ({"work": "/somewhere/else"}, "MARKER_WORK_DIR_MISMATCH"), ({"CTV_FROZEN_RUNNER_SHA256": "9" * 64}, "MARKER_CLOSEOUT_RUNNER_MISMATCH"),
    ({"CTV_BUNDLE_MANIFEST_SHA256": "short"}, "MARKER_FIELD_INVALID_CTV_BUNDLE_MANIFEST_SHA256"),
])
def test_marker_must_be_a_consumed_no_rerun_record_bound_to_the_same_runner(world: AttestWorld, marker_change: dict[str, str], expected: str) -> None:
    world.write_history(marker_set=marker_change)
    proc = world.run()
    assert proc.returncode != 0 and expected in reason(proc), reason(proc)


def test_marker_with_unexpected_fields_is_rejected(world: AttestWorld) -> None:
    world.write_history(marker_extra="CTV_NOTE=x\n")
    assert "MARKER_SCHEMA_NOT_EXACT" in reason(world.run())


@pytest.mark.parametrize("target", ["CTV-GLOBAL-CLOSEOUT-FAIL", "CTV-GLOBAL-ATTEMPT-CONSUMED", "CTV-GLOBAL-CLOSEOUT-FAIL.sha256"])
def test_symlinked_history_files_are_rejected(world: AttestWorld, target: str) -> None:
    path = world.canon / target
    real = world.tmp / "elsewhere"
    real.write_text(path.read_text())
    real.chmod(path.stat().st_mode & 0o777)
    path.unlink()
    path.symlink_to(real)
    proc = world.run()
    assert proc.returncode != 0 and re.search(r"(MARKER|CLOSEOUT|SIDECAR)_UNTRUSTED", reason(proc)), reason(proc)


@pytest.mark.parametrize("target,mode,expected", [
    ("CTV-GLOBAL-CLOSEOUT-FAIL", 0o644, "CLOSEOUT_UNTRUSTED"), ("CTV-GLOBAL-ATTEMPT-CONSUMED", 0o666, "MARKER_UNTRUSTED"),
    ("CTV-GLOBAL-CLOSEOUT-FAIL.sha256", 0o666, "SIDECAR_UNTRUSTED"), ("CTV-GLOBAL-CLOSEOUT-FAIL.sha256", 0o644, "SIDECAR_UNTRUSTED"),
])
def test_history_file_permission_violations_are_rejected(world: AttestWorld, target: str, mode: int, expected: str) -> None:
    (world.canon / target).chmod(mode)
    proc = world.run()
    assert proc.returncode != 0 and expected in reason(proc)


def test_untrusted_canonical_directory_and_executable_paths_are_rejected(world: AttestWorld) -> None:
    world.canon.chmod(0o777)
    assert "CANONICAL_DIR_NOT_TRUSTED" in reason(world.run())
    world.canon.chmod(0o755)
    world.attest.chmod(0o775)
    proc = world.run()
    assert proc.returncode != 0 and "EXEC_PATH_NOT_TRUSTED" in reason(proc)
    world.attest.chmod(0o755)
    gate_lib = world.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-f1u-run-lib.sh"
    gate_lib.chmod(0o666)
    assert "EXEC_PATH_NOT_TRUSTED" in reason(world.run())


# ──────────────────────────────────────────────── B/C. current runtime and evidence ────────────────────────────────────────────────
def test_wrong_core_unit_digest_fails(world: AttestWorld) -> None:
    world.unit.write_text(world.unit.read_text() + "# drift\n")
    proc = world.run()
    assert proc.returncode != 0 and "OPTION_B_VERIFIER_FAILED" in reason(proc) and "UNIT_IDENTITY_INVALID" in reason(proc)


def test_effective_security_or_dropin_drift_fails(world: AttestWorld) -> None:
    world.edit_state("core", ProtectClock="yes")
    assert "EFFECTIVE_SECURITY_PROPERTIES_INVALID" in reason(world.run())
    world.edit_state("core", ProtectClock="no", DropInPaths=opt.DROPINS.split()[0])
    assert "DROPINS_NOT_EXACT" in reason(world.run())
    world.edit_state("core", DropInPaths=opt.DROPINS, ActiveState="inactive", SubState="dead")
    assert "CORE_NOT_ACTIVE_RUNNING" in reason(world.run())


@pytest.mark.parametrize("detector", [{"ActiveState": "active", "SubState": "running", "MainPID": "77"}, {"UnitFileState": "enabled"}])
def test_wrong_detector_mode_fails_independently_of_old_evidence(world: AttestWorld, detector: dict[str, str]) -> None:
    world.edit_state("detector", **detector)
    (world.tmp / "pgrep_count").write_text("1")
    proc = world.run()
    assert proc.returncode != 0 and "DETECTOR_BASELINE_NOT_INACTIVE" in reason(proc)


@pytest.mark.parametrize("clock", ["unsynced:5", "none"])
def test_missing_or_unsynced_trustedclock_evidence_fails(world: AttestWorld, clock: str) -> None:
    command = [str(world.attest), *[("--clock-fixture" if a == "synced:5" else a) if a == "synced:5" else a for a in world.common()]]
    args = [clock if a == "synced:5" else a for a in world.common()]
    proc = subprocess.run([str(world.attest), *args, "--closeout-sha256", world.closeout_sha], text=True, capture_output=True, env=world.env())
    assert command and proc.returncode != 0 and re.search(r"TRUSTEDCLOCK_NOT_(OK|SYNCED)", reason(proc)), reason(proc)


def test_modified_or_missing_runtime_evidence_fails(world: AttestWorld) -> None:
    (world.work / "pre-root" / "capture.log").write_text("L0_CAPTURE=COMPLETE\n# edited\n")
    assert "EVIDENCE_INTEGRITY_FAIL" in reason(world.run())
    world.reseal()  # a consistent re-seal still changes the manifest digest the closeout recorded
    assert "EVIDENCE_DIGEST_MISMATCH" in reason(world.run())
    (world.work / "post-root" / "SHA256SUMS").unlink()
    assert "EVIDENCE_MANIFEST_MISSING" in reason(world.run())


def test_a_rewritten_compare_report_cannot_promote_s10_even_if_everything_is_resealed(world: AttestWorld) -> None:
    (world.work / "compare-pre-post.txt").write_text(opt.COMPARE_FAIL.replace("PRESERVATION_S10=FAIL", "PRESERVATION_S10=PASS").replace("COMPARE_RESULT=FAIL", "COMPARE_RESULT=PASS"))
    world.reseal()
    world.write_history()  # closeout now records the rewritten digests, so only the S10 guard can reject it
    proc = world.run()
    assert proc.returncode != 0 and re.search(r"HISTORICAL_S10_(IS_NOT_A_FAIL|FAIL_NOT_POSITIVELY_EVIDENCED)", reason(proc)), reason(proc)


def test_recovery_attempt_already_consumed_is_a_hard_failure(world: AttestWorld) -> None:
    (world.canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")
    proc = world.run()
    assert proc.returncode != 0 and "RECOVERY_AUTHORITY_PRESENT" in reason(proc)


def test_state_that_moves_during_the_run_is_rejected(world: AttestWorld) -> None:
    st = opt.json.loads(world.state.read_text())
    st["flip_after"] = 3
    world.set_state(st)
    assert world.run().returncode != 0


# ──────────────────────────────────────────────── D. recovery prerequisites ────────────────────────────────────────────────
def test_prerequisites_are_reported_separately_and_release_cli_is_unknown_not_pass(world: AttestWorld) -> None:
    f = facts(world.run())
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_RECOVERY_ATTEMPT"] == "PASS"
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1I"] == "PASS"
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY"] == "PASS"
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_RELEASE_CLI"] == "UNKNOWN"
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_RELEASE_CLI_REASON"] == "NO_TRUSTED_PIN_INPUT"
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_PREREQUISITES"] == "PARTIAL_RELEASE_CLI_UNKNOWN"


@pytest.mark.parametrize("setup,expected", [
    ("missing_table", "R1I_TABLE_MISSING"), ("wrong_shape", "R1I_TABLE_NOT_EXACT_OWNED_SHAPE"), ("no_nft", "NFT_UNAVAILABLE"),
])
def test_r1i_prerequisite_is_blocked_not_passed_when_it_cannot_be_proven(world: AttestWorld, setup: str, expected: str) -> None:
    if setup == "missing_table":
        (world.tmp / "nft_tables").write_text("")
    elif setup == "wrong_shape":
        (world.tmp / "nft_r1i").write_text(R1I_STATE.replace("policy accept", "policy drop"))
    else:
        (world.bin / "nft").unlink()
    proc = world.run()
    f = facts(proc)
    assert proc.returncode == PARTIAL_RC and f["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PARTIAL"  # B1: BLOCKED is never PASS and never exit 0
    assert f["CTV_FAIL_SUCCESSOR_HISTORY_AND_CURRENT_STATE"] == "PASS"                          # the history proof itself is unaffected
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1I"] == "BLOCKED" and f["CTV_FAIL_SUCCESSOR_PREREQ_R1I_REASON"] == expected
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_PREREQUISITES"] == "BLOCKED"
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED"] == "NO"


def test_r1b_incident_authority_is_blocked_when_the_reviewed_gate_cannot_pass(tmp_path: Path) -> None:
    world = AttestWorld(tmp_path, logs=False)  # the exact-main repository carries no R1B/R1Bv receipts
    proc = world.run()
    f = facts(proc)
    assert proc.returncode == PARTIAL_RC and f["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PARTIAL", proc.stderr
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY"] == "BLOCKED"
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY_REASON"].startswith("R1BV")
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_PREREQUISITES"] == "BLOCKED"


# ──────────────────────────────────────────────── authority, seams and trust ────────────────────────────────────────────────
def test_production_mode_accepts_no_test_seam_and_no_non_production_canonical_directory(world: AttestWorld) -> None:
    base = ["--repo", str(world.repo), "--main", world.main, "--device", opt.DEVICE]
    plain = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV")}
    for extra, expected in (
        (["--canon", str(world.canon), "--work", str(world.work)], "CANON_NOT_PRODUCTION_PATH"),
        (["--canon", opt.PROD_CANON, "--work", str(world.work), "--path-prefix", str(world.bin)], "NON_HERMETIC_OVERRIDE_REFUSED"),
        (["--canon", opt.PROD_CANON, "--work", str(world.work), "--unit-dest", str(world.unit)], "NON_HERMETIC_OVERRIDE_REFUSED"),
        (["--canon", opt.PROD_CANON, "--work", str(world.work), "--closeout-sha256", world.closeout_sha], "NON_HERMETIC_OVERRIDE_REFUSED"),
        (["--canon", opt.PROD_CANON, "--work", str(world.work), "--preimage-sha256", world.pre_sha], "NON_HERMETIC_OVERRIDE_REFUSED"),
        (["--canon", opt.PROD_CANON, "--work", str(world.work), "--clock-fixture", "synced:5"], "NON_HERMETIC_OVERRIDE_REFUSED"),
    ):
        proc = subprocess.run([str(world.attest), *base, *extra], text=True, capture_output=True, env=plain)
        assert proc.returncode != 0 and expected in reason(proc), (extra, reason(proc))


def test_hermetic_mode_needs_the_test_environment_and_never_the_real_canonical_directory(world: AttestWorld) -> None:
    no_env = {k: v for k, v in os.environ.items() if not k.startswith("CTV_OPTION_B")}
    assert "HERMETIC_REQUIRES_TEST_ONLY_ENV" in reason(world.run(env=no_env))
    real = [a if a != str(world.canon) else opt.PROD_CANON for a in world.common()]
    proc = subprocess.run([str(world.attest), *real, "--closeout-sha256", world.closeout_sha], text=True, capture_output=True, env=world.env())
    assert proc.returncode != 0 and "HERMETIC_PATH" in reason(proc)


def test_environment_cannot_override_production_authority_or_inject_a_shell_file(world: AttestWorld) -> None:
    injected = world.tmp / "inject.sh"
    injected.write_text(f"touch {world.tmp}/INJECTED\n")
    env = world.env(CTV_SUDO="/bin/false", SUDO="/bin/false", CTV_CANONICAL_DIR="/nonexistent", CTV_UNIT_DEST="/nonexistent", PATH="/nonexistent")
    assert world.run(env=env).returncode == PARTIAL_RC  # all of the above are ignored: the clean start and the guard pin them
    # Executed through its `bash -p` shebang, BASH_ENV is never processed at all.
    assert world.run(env=world.env(BASH_ENV=str(injected))).returncode == PARTIAL_RC
    assert not (world.tmp / "INJECTED").exists()
    # Run through an explicit `bash <file>` the shell has already processed BASH_ENV, so the script can only refuse (and does).
    proc = subprocess.run(["/bin/bash", str(world.attest), *world.common(), "--closeout-sha256", world.closeout_sha], text=True, capture_output=True,
                          env=world.env(BASH_ENV=str(injected)))
    assert proc.returncode != 0 and "BASH_ENV_INJECTION_REFUSED" in reason(proc)


def test_a_script_or_library_that_differs_from_exact_main_is_rejected(world: AttestWorld) -> None:
    lib = world.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-run-lib.sh"
    lib.write_text(lib.read_text() + "\n# tampered after the main commit\n")
    proc = world.run()
    assert proc.returncode != 0 and "AUTHORITY_FILE_DIFFERS_FROM_MAIN" in reason(proc)
    wrong_head = world.run(closeout_sha=world.closeout_sha, env=world.env())
    assert wrong_head.returncode != 0
    bad_main = subprocess.run([str(world.attest), *world.common(main="0" * 40), "--closeout-sha256", world.closeout_sha], text=True, capture_output=True, env=world.env())
    assert bad_main.returncode != 0 and "REPO_HEAD_NOT_EXPECTED_MAIN" in reason(bad_main)


# ──────────────────────────────────────────────── mutation tests: weakened guards must be detected ────────────────────────────────────────────────
def _weakened(world: AttestWorld, old: str, new: str) -> None:
    text = world.attest.read_text()
    assert old in text, old
    world.attest.write_text(text.replace(old, new, 1))
    world.recommit()
    world.write_history()


def _tamper_sidecar(w: AttestWorld) -> None:
    (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").chmod(0o644)
    (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").write_text("00\n")
    (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").chmod(0o444)


@pytest.mark.parametrize("own_reason,old,tamper", [
    ("CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD", '[ "$closeout_sha" = "$PIN_CLOSEOUT_SHA256" ] || fail CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD',
     lambda w: (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text((w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").read_text().replace("FAIL_IMMUTABLE", "FAIL_IMMUTABLX"))),
    ("CTV_NAMESPACE_NOT_EXACT", '|| fail CTV_NAMESPACE_NOT_EXACT', lambda w: (w.canon / "CTV-GLOBAL-CLOSEOUT-PASS").write_text("CTV_RESULT=CLOSED_PASS\n")),
    ("CLOSEOUT_SCHEMA_NOT_EXACT", 'strict_schema "$closeout_text" $CLOSEOUT_KEYS || fail CLOSEOUT_SCHEMA_NOT_EXACT', lambda w: w.write_history(extra="CTV_UNKNOWN_FIELD=1\n")),
    ("CLOSEOUT_FIELD_INVALID_CTV_RESULT", '|| fail "CLOSEOUT_FIELD_INVALID_${want%%=*}"', lambda w: w.write_history(set_={"CTV_RESULT": "CLOSED_PASS"})),
    ("CLOSEOUT_SIDECAR_INVALID", 'exact_text sidecar_raw && [ "$sidecar_raw" = "$closeout_sha  $CLOSEOUT_NAME" ] || fail CLOSEOUT_SIDECAR_INVALID', _tamper_sidecar),
    ("MARKER_FIELD_INVALID", '|| fail MARKER_FIELD_INVALID', lambda w: w.write_history(marker_set={"CTV_RERUN_ALLOWED": "YES"})),
])
def test_weakening_a_critical_guard_removes_that_guards_rejection(tmp_path: Path, own_reason: str, old: str, tamper) -> None:
    """Mutation test: the strict script rejects the tampered history for `own_reason`; with exactly that guard disabled that reason is gone,
    so the tamper tests above genuinely exercise (and would detect the removal of) each protection."""
    (tmp_path / "strict").mkdir()
    (tmp_path / "weak").mkdir()
    strict = AttestWorld(tmp_path / "strict")
    tamper(strict)
    pin = strict.closeout_sha if own_reason == "CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD" else sha(strict.canon / "CTV-GLOBAL-CLOSEOUT-FAIL")
    result = strict.run(closeout_sha=pin)
    assert result.returncode != 0 and own_reason in reason(result), reason(result)
    weak = AttestWorld(tmp_path / "weak")
    text = weak.attest.read_text()
    assert old in text, old
    start = text.index(old)
    line_start = text.rfind("\n", 0, start) + 1 if old.startswith("||") is False else text.rfind("\n", 0, start) + 1
    line_end = text.index("\n", start)
    weak.attest.write_text(text[:line_start] + ":" + text[line_end:])
    weak.recommit()
    weak.write_history()
    tamper(weak)
    pin = weak.closeout_sha if own_reason == "CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD" else sha(weak.canon / "CTV-GLOBAL-CLOSEOUT-FAIL")
    result = weak.run(closeout_sha=pin)
    assert own_reason not in reason(result), (own_reason, reason(result))


# ═════════════════════════════════════════════ B1: the verdict, the mode label and the two digests ═════════════════════════════════════════════
def _body(proc: subprocess.CompletedProcess[str]) -> str:
    return proc.stdout


def test_b1_r1i_blocked_is_never_pass_and_never_exit_zero(world: AttestWorld) -> None:
    (world.tmp / "nft_tables").write_text("")
    proc = world.run()
    assert proc.returncode != 0 and facts(proc)["CTV_FAIL_SUCCESSOR_ATTESTATION"] != "PASS"
    assert "CTV_FAIL_SUCCESSOR_ATTESTATION=PASS" not in _body(proc) and facts(proc)["CTV_FAIL_SUCCESSOR_RECOVERY_READINESS"] == "PARTIAL"


def test_b1_r1b_blocked_is_never_pass_and_never_exit_zero(tmp_path: Path) -> None:
    proc = AttestWorld(tmp_path, logs=False).run()
    assert proc.returncode != 0 and facts(proc)["CTV_FAIL_SUCCESSOR_ATTESTATION"] != "PASS" and facts(proc)["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY"] == "BLOCKED"


def test_b1_release_cli_unknown_alone_prevents_pass_even_when_everything_else_passes(world: AttestWorld) -> None:
    proc = world.run()
    f = facts(proc)
    assert (f["CTV_FAIL_SUCCESSOR_PREREQ_R1I"], f["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY"], f["CTV_FAIL_SUCCESSOR_PREREQ_RELEASE_CLI"]) == ("PASS", "PASS", "UNKNOWN")
    assert proc.returncode == PARTIAL_RC and f["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PARTIAL" and f["CTV_FAIL_SUCCESSOR_RECOVERY_READINESS"] == "PARTIAL"
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_PREREQUISITES"] == "PARTIAL_RELEASE_CLI_UNKNOWN"


def test_b1_the_execution_mode_is_labelled_and_a_hermetic_run_can_never_look_like_production(world: AttestWorld) -> None:
    f = facts(world.run())
    assert f["CTV_FAIL_SUCCESSOR_MODE"] == "HERMETIC_TEST"
    text = ATTEST_SRC.read_text()
    assert 'MODE=HERMETIC_TEST' in text and 'MODE=PRODUCTION' in text
    # the mode is part of the readiness digest, so a test-world digest can never equal a production one
    assert re.search(r"printf 'readiness_v1\\nbinding=%s\\nmode=%s", text)


def test_b1_changing_runtime_prerequisite_status_changes_readiness_but_not_the_historical_binding(world: AttestWorld) -> None:
    base = facts(world.run())
    (world.tmp / "nft_tables").write_text("")                      # R1I PASS -> BLOCKED
    blocked = facts(world.run())
    assert blocked["CTV_FAIL_SUCCESSOR_PREREQ_R1I"] == "BLOCKED"
    assert blocked["CTV_FAIL_SUCCESSOR_BINDING_SHA256"] == base["CTV_FAIL_SUCCESSOR_BINDING_SHA256"]       # stable history unchanged
    assert blocked["CTV_FAIL_SUCCESSOR_READINESS_SHA256"] != base["CTV_FAIL_SUCCESSOR_READINESS_SHA256"]   # runtime readiness is bound
    (world.tmp / "nft_r1i").write_text(R1I_STATE.replace("policy accept", "policy drop"))
    (world.tmp / "nft_tables").write_text(f"table {r1i.FAMILY} {r1i.TABLE}\n")
    shape = facts(world.run())
    assert shape["CTV_FAIL_SUCCESSOR_READINESS_SHA256"] not in {base["CTV_FAIL_SUCCESSOR_READINESS_SHA256"], blocked["CTV_FAIL_SUCCESSOR_READINESS_SHA256"]}
    assert shape["CTV_FAIL_SUCCESSOR_BINDING_SHA256"] == base["CTV_FAIL_SUCCESSOR_BINDING_SHA256"]


def test_b1_readiness_also_binds_the_current_runtime_state_the_binding_does_not(world: AttestWorld) -> None:
    before = facts(world.run())
    world.edit_state("core", InvocationID="fedcba9876543210fedcba9876543210")   # the Core was restarted: a different current runtime state
    after = facts(world.run())
    assert after["CTV_FAIL_SUCCESSOR_CURRENT_STATE_SHA256"] != before["CTV_FAIL_SUCCESSOR_CURRENT_STATE_SHA256"]
    assert after["CTV_FAIL_SUCCESSOR_READINESS_SHA256"] != before["CTV_FAIL_SUCCESSOR_READINESS_SHA256"]
    assert after["CTV_FAIL_SUCCESSOR_BINDING_SHA256"] == before["CTV_FAIL_SUCCESSOR_BINDING_SHA256"]


def test_b1_both_digests_state_that_they_are_not_a_credential_or_authorization(world: AttestWorld) -> None:
    f = facts(world.run())
    assert f["CTV_FAIL_SUCCESSOR_BINDING_SCOPE"] == "STABLE_HISTORY_ONLY_NOT_FRESH_RUNTIME_PROOF_NOT_RECOVERY_AUTHORIZATION"
    scope = f["CTV_FAIL_SUCCESSOR_READINESS_SCOPE"]
    assert "NOT_FRESHNESS" in scope and "NOT_A_CREDENTIAL" in scope and "NOT_PERMISSION" in scope
    assert f["CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED"] == "NO"
    header = ATTEST_SRC.read_text().split("set -Eeuo pipefail", 1)[0]
    assert "STABLE HISTORY ONLY" in header and "not a freshness" in header and "never authorizes Recovery" in header


def test_b1_history_and_s10_stay_unchanged_and_nothing_is_consumed_or_authorized_in_every_verdict(world: AttestWorld) -> None:
    for tweak in (lambda: None, lambda: (world.tmp / "nft_tables").write_text("")):
        tweak()
        before = world.tree()
        proc = world.run()
        f = facts(proc)
        assert world.tree() == before and not list(world.canon.glob("RECOVERY-*"))
        assert (f["CTV_FAIL_SUCCESSOR_HISTORICAL_RESULT"], f["CTV_FAIL_SUCCESSOR_PROMOTES_CTV_TO_PASS"], f["CTV_FAIL_SUCCESSOR_HISTORICAL_S10"]) == ("FAIL_IMMUTABLE", "NO", "FAIL")
        assert (f["CTV_FAIL_SUCCESSOR_ATTEMPT_CONSUMED"], f["CTV_FAIL_SUCCESSOR_PRODUCTION_MUTATION"], f["CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED"]) == ("NO", "NO", "NO")


def test_b1_a_consumer_cannot_mistake_partial_for_pass(world: AttestWorld) -> None:
    proc = world.run()
    assert proc.returncode != 0
    assert not re.search(r"^CTV_FAIL_SUCCESSOR_ATTESTATION=PASS$", proc.stdout, re.M)
    assert not re.search(r"^CTV_FAIL_SUCCESSOR_RECOVERY_READINESS=PASS$", proc.stdout, re.M)
    assert re.search(r"^CTV_FAIL_SUCCESSOR_ATTESTATION=PARTIAL$", proc.stdout, re.M)
    assert proc.stdout.rstrip().splitlines()[-1] == "CTV_FAIL_SUCCESSOR_ATTESTATION=PARTIAL"  # the verdict is the last line


def test_b1_the_only_code_path_that_prints_attestation_pass_requires_every_prerequisite() -> None:
    code = "\n".join(line for line in ATTEST_SRC.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert code.count("ATTESTATION=PASS") == 1
    guard = code[: code.index("ATTESTATION=PASS")].rsplit("\nif ", 1)[1].split("\n", 1)[0]
    assert all(term in guard for term in ('"$r1i_status" = PASS', '"$r1b_status" = PASS', '"$release_status" = PASS')), guard
    assert code.index("exit 0") > code.index("ATTESTATION=PASS") and code.count("exit 0") == 1
    assert 'release_status=UNKNOWN release_reason=NO_TRUSTED_PIN_INPUT' in code and "release_status=PASS" not in code


def _forced(world_dir: Path, replacement: str) -> AttestWorld:
    world = AttestWorld(world_dir)
    text = world.attest.read_text()
    assert "release_status=UNKNOWN release_reason=NO_TRUSTED_PIN_INPUT" in text
    world.attest.write_text(text.replace("release_status=UNKNOWN release_reason=NO_TRUSTED_PIN_INPUT", replacement, 1))
    world.recommit()
    world.write_history()
    return world


def test_b1_pass_is_reachable_only_when_all_three_prerequisites_pass_and_still_authorizes_nothing(tmp_path: Path) -> None:
    (tmp_path / "all").mkdir()
    ok = _forced(tmp_path / "all", "release_status=PASS release_reason=TEST_FORCED_TRUSTED_PIN")  # hypothetical future trusted pin
    proc = ok.run()
    f = facts(proc)
    assert proc.returncode == 0 and f["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PASS" and f["CTV_FAIL_SUCCESSOR_RECOVERY_READINESS"] == "PASS"
    assert f["CTV_FAIL_SUCCESSOR_MODE"] == "HERMETIC_TEST" and f["CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED"] == "NO"
    (tmp_path / "blocked").mkdir()
    still = _forced(tmp_path / "blocked", "release_status=PASS release_reason=TEST_FORCED_TRUSTED_PIN")
    (still.tmp / "nft_tables").write_text("")                    # the trusted pin does not rescue a BLOCKED R1I
    blocked = still.run()
    assert blocked.returncode == PARTIAL_RC and facts(blocked)["CTV_FAIL_SUCCESSOR_ATTESTATION"] == "PARTIAL"


# ═════════════════════════════════════════════ M1-M6 ═════════════════════════════════════════════
def test_m1_a_hard_linked_history_file_is_rejected(world: AttestWorld) -> None:
    for name, expected in (("CTV-GLOBAL-CLOSEOUT-FAIL", "CLOSEOUT_UNTRUSTED"), ("CTV-GLOBAL-ATTEMPT-CONSUMED", "MARKER_UNTRUSTED"), ("CTV-GLOBAL-CLOSEOUT-FAIL.sha256", "SIDECAR_UNTRUSTED")):
        world.write_history()
        link = world.tmp / f"hardlink-{name}"
        os.link(world.canon / name, link)
        proc = world.run()
        assert proc.returncode != 0 and expected in reason(proc), (name, reason(proc))
        link.unlink()


def test_m2_the_closeout_is_hashed_and_parsed_from_one_read() -> None:
    code = ATTEST_SRC.read_text()
    assert code.count('slurp closeout_raw "$closeout"') == 1
    assert 'closeout_sha=$(printf \'%s\' "$closeout_raw" | sha256sum' in code and 'closeout_sha=$(ro sha256sum' not in code
    assert 'closeout_text=$closeout_raw' in code and 'ro cat -- "$closeout")' not in code.split("# ── B + C.")[0]


def test_m3_the_guard_is_sourced_from_the_bytes_that_were_hashed_and_never_by_path() -> None:
    code = "\n".join(line for line in ATTEST_SRC.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert re.search(r'^\s*\.\s+"\$GUARD"', code, re.M) is None and "source " not in code
    assert code.index('"$GUARD_SHA" ] || fail GUARD_CHANGED_BEFORE_SOURCE') < code.index('eval "$guard_bytes"') < code.index("ob_guard_init")


def _function(name: str) -> str:
    text = ATTEST_SRC.read_text()
    return re.search(rf"^{name}\(\) \{{.*?\n(?=\S)|^{name}\(\) \{{[^\n]*\}}$", text, re.M | re.S).group(0).splitlines()[0]


def test_m4_trusted_bin_rejects_a_binary_not_owned_by_root(tmp_path: Path) -> None:
    helper = _function("trusted_bin")
    mine = tmp_path / "python3"
    mine.write_text("#!/bin/sh\n")
    mine.chmod(0o755)
    proc = subprocess.run(["bash", "-c", f"{helper}\ntrusted_bin '{mine}'; echo \"rc=$?\""], text=True, capture_output=True)
    assert "rc=1" in proc.stdout                              # owned by the (non-root) invoking user: never trusted
    assert "rc=0" not in subprocess.run(["bash", "-c", f"{helper}\ntrusted_bin '{tmp_path}/absent'; echo \"rc=$?\""], text=True, capture_output=True).stdout


@pytest.mark.skipif(not shutil.which("unshare") or subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode != 0, reason="user namespace unavailable")
def test_m4_trusted_bin_accepts_a_root_owned_non_writable_binary_and_rejects_a_writable_one(tmp_path: Path) -> None:
    helper = _function("trusted_bin")
    good, bad = tmp_path / "good", tmp_path / "bad"
    for path, mode in ((good, 0o755), (bad, 0o775)):
        path.write_text("x")
        path.chmod(mode)
    proc = subprocess.run(["unshare", "-r", "bash", "-c", f"{helper}\ntrusted_bin '{good}'; echo \"good=$?\"; trusted_bin '{bad}'; echo \"bad=$?\""], text=True, capture_output=True)
    assert "good=0" in proc.stdout and "bad=1" in proc.stdout


def test_m4_production_mode_checks_python_and_nft_trust() -> None:
    code = ATTEST_SRC.read_text()
    assert "trusted_bin /usr/bin/python3 || fail PYTHON_NOT_ROOT_TRUSTED" in code and "trusted_bin \"$nft_bin\" || fail NFT_NOT_ROOT_TRUSTED" in code


def test_m5_the_r1b_prerequisite_states_that_it_proves_committed_receipts_only(world: AttestWorld) -> None:
    f = facts(world.run())
    assert f["CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY_SCOPE"] == "COMMITTED_RECEIPTS_AT_PINNED_MAIN_NOT_LIVE_INCIDENT_OR_AUDIT_CHAIN"


def _mutating_verifier(world: AttestWorld) -> None:
    """A committed (so hash-valid) verifier that rewrites the closeout in place, after the attestation has already pinned it."""
    verifier = world.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-verify.sh"
    marker = "# ── 1. Exact merged authority"
    text = verifier.read_text()
    assert marker in text
    verifier.write_text(text.replace(marker, 'printf "# changed\\n" >> "$CANON/CTV-GLOBAL-CLOSEOUT-FAIL"\n' + marker, 1))


def test_m6a_history_that_changes_while_the_verifier_runs_is_detected(world: AttestWorld) -> None:
    _mutating_verifier(world)
    world.recommit()
    world.write_history()
    proc = world.run()
    assert proc.returncode != 0 and "HISTORY_CHANGED_DURING_ATTESTATION" in reason(proc), reason(proc)


def test_m6a_mutation_without_the_recheck_the_same_change_is_accepted(tmp_path: Path) -> None:
    (tmp_path / "weak").mkdir()
    w = AttestWorld(tmp_path / "weak")
    _mutating_verifier(w)
    text = w.attest.read_text()
    old = "fail HISTORY_CHANGED_DURING_ATTESTATION"
    assert text.count(old) == 2
    w.attest.write_text(text.replace(old, "true", 2))
    w.recommit()
    w.write_history()
    result = w.run()
    assert "HISTORY_CHANGED_DURING_ATTESTATION" not in reason(result) and result.returncode == PARTIAL_RC


def test_m6b_production_mode_requires_root() -> None:
    code = ATTEST_SRC.read_text()
    snippet = code[code.index('if [ "$HERMETIC" = YES ]; then\n  [ -z "$PATH_PREFIX" ]'):code.index("ro() {")]
    assert "fail ROOT_REQUIRED" in snippet
    if os.getuid() != 0:
        proc = subprocess.run(["bash", "-c", f'fail() {{ echo "FAILED:$1"; exit 1; }}\nHERMETIC=NO PATH_PREFIX=\n{snippet}\necho REACHED'], text=True, capture_output=True)
        assert "FAILED:ROOT_REQUIRED" in proc.stdout and "REACHED" not in proc.stdout


def test_m6c_the_s10_promoted_fact_is_checked_a_second_time_and_a_changed_verifier_fact_is_rejected(world: AttestWorld) -> None:
    code = ATTEST_SRC.read_text()
    assert "CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO" in code and "CTV_FAIL_SUCCESSOR_PROMOTES_CTV_TO_PASS=NO" in code
    verifier = world.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-verify.sh"
    text = verifier.read_text()
    assert "CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO" in text
    verifier.write_text(text.replace("CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO", "CTV_OPTION_B_S10_PROMOTED_TO_PASS=YES", 1))
    world.recommit()
    world.write_history()
    proc = world.run()
    assert proc.returncode != 0 and "VERIFIER_FACT_INVALID_CTV_OPTION_B_S10_PROMOTED_TO_PASS" in reason(proc)
