"""Hermetic tests of the THIRD Recovery successor readiness verifier. Nothing here is Production evidence; a HERMETIC_TEST world can never
produce readiness above PARTIAL, an authorization, a marker, or any host action."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

LOCK = Path(__file__).resolve().parents[2]
REPO_ROOT = LOCK.parent
REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance"
TOOL_REL = f"{REL}/recovery_third_successor_readiness.py"
PINS_REL = f"{REL}/third-successor-pins.kv"
LIB_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh"
TOOL_SRC = (REPO_ROOT / TOOL_REL).read_text()
LIB_SRC = (REPO_ROOT / LIB_REL).read_text()
H = {c: c * 64 for c in "abcdef"} | {"u": "9" * 64}
AUTH_ID = "AUTH-3RD-0001"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def kv(d: dict[str, str]) -> str:
    return "".join(f"{k}={v}\n" for k, v in d.items())


def sh(repo: Path, *a: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *a], text=True, capture_output=True, check=True).stdout.strip()


CLOSEOUT = {
    "CTV_RESULT": "FAIL_IMMUTABLE", "CTV_LIVE": "CLOSED_FAIL", "CTV_LIVE_EXECUTED": "YES", "CTV_ATTEMPT_CONSUMED": "YES", "CTV_RERUN_ALLOWED": "NO",
    "CTV_IS_CTU_RETRY": "NO", "CTV_ROLLBACK_COMPLETE": "NO", "CTV_TARGET_UNIT_RETAINED": "YES", "CTV_ADDITIONAL_CORE_RESTART": "NO",
    "CTV_S10_HISTORICAL_COMPARE": "FAIL", "CTV_S10_PROMOTED_TO_PASS": "NO", "CTV_RECOVERY_AUTHORIZED": "NO", "CTV_JOURNAL_PHASE": "apply-verified",
    "CTV_DETECTOR_BASELINE_MODE": "INACTIVE", "CTV_TRUSTEDCLOCK_AT_DISPOSITION": "SYNCED", "CTV_FROZEN_RUNNER_SHA256": H["a"], "CTV_UNIT_SHA256": H["u"],
}
MARKER = {
    "CTV_ATTEMPT_CONSUMED": "YES", "CTV_RERUN_ALLOWED": "NO", "CTV_FROZEN_RUNNER_SHA256": H["a"],
    "CTV_RUNNER_TEMPLATE_SHA256": H["c"], "CTV_BUNDLE_MANIFEST_SHA256": H["d"],
    "CTV_CONTROL_MANIFEST_SHA256": H["e"], "work": "/var/lib/aegis-idea3-work",
}
CTU_FAIL = {"CTU_RESULT": "FAIL_IMMUTABLE", "CTU_ATTEMPT_CONSUMED": "YES", "CTU_RERUN_ALLOWED": "NO"}


class World:
    def __init__(self, tmp: Path, *, tool_text: str | None = None, lib_text: str | None = None, pins: bool | dict[str, str] = True) -> None:
        self.root = tmp / "w"
        self.root.mkdir(mode=0o700)
        os.chmod(self.root, 0o700)
        self.repo = self.root / "repo"
        self.ev = self.root / "ev"
        self.canon = self.ev / "canon"
        for d in (self.repo, self.ev, self.canon):
            d.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(d, 0o700)
        self.put(self.repo / TOOL_REL, tool_text or TOOL_SRC)
        self.put(self.repo / LIB_REL, lib_text or LIB_SRC)
        self.closeout = dict(CLOSEOUT)
        self.write_history()
        self.pin_values = {
            "CTV_CLOSEOUT_SHA256": sha((self.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").read_bytes()),
            "CTV_MARKER_SHA256": sha((self.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").read_bytes()),
            "CTV_UNIT_SHA256": H["u"], "DETECTOR_UNIT_SHA256": H["d"], "RELEASE_SUMS_SHA256": H["b"], "THIRD_SUCCESSOR_AUTHORITY_ID": AUTH_ID,
        }
        if isinstance(pins, dict):
            self.pin_values.update(pins)
        if pins:
            self.put(self.repo / PINS_REL, kv(self.pin_values))
        sh(self.repo, "init", "-q")
        sh(self.repo, "config", "user.email", "t@e.invalid")
        sh(self.repo, "config", "user.name", "t")
        sh(self.repo, "add", "-A")
        sh(self.repo, "commit", "-q", "-m", "reviewed main")
        self.main = sh(self.repo, "rev-parse", "HEAD")
        self.tool = self.repo / TOOL_REL
        self.closeout_sha = self.pin_values["CTV_CLOSEOUT_SHA256"]

    @staticmethod
    def put(path: Path, text: str, mode: int = 0o600) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            path.unlink()
        path.write_text(text)
        os.chmod(path, mode)

    def write_history(self, closeout: dict[str, str] | None = None) -> None:
        c = self.canon
        self.put(c / "CTV-GLOBAL-CLOSEOUT-FAIL", kv(closeout or self.closeout))
        self.put(c / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256", f"{sha((c / 'CTV-GLOBAL-CLOSEOUT-FAIL').read_bytes())}  CTV-GLOBAL-CLOSEOUT-FAIL\n")
        self.put(c / "CTV-GLOBAL-ATTEMPT-CONSUMED", kv(MARKER))
        self.put(c / "CTU-GLOBAL-ATTEMPT-CONSUMED", kv({
            "CTU_ATTEMPT_CONSUMED": "YES", "CTU_RERUN_ALLOWED": "NO", "CTU_DEVICE_ID": "aegis-relay-01",
            "CTU_FROZEN_RUNNER_SHA256": H["a"], "CTU_BUNDLE_MANIFEST_SHA256": H["b"],
            "CTU_CONSUMED_AT_EPOCH": "1790000000.0", "work": str(self.root / "ctu-work"),
            "CTU_PRE_PROTOCOL_SEEN_ID": "0", "CTU_PRE_AUDIT_ID": "0", "CTU_PRE_EPISODE_ID": "0",
            "CTU_PRE_OPEN_EPISODE_COUNT": "0", "CTU_PRE_OPEN_EPISODE_ID": "0",
        }))
        self.put(c / "CTU-GLOBAL-CLOSEOUT-FAIL", kv(CTU_FAIL))

    def attestation(self, **over: str) -> Path:
        p = "CTV_FAIL_SUCCESSOR_"
        d = {"STAGE": "CTv-fail-successor-attestation", "MODE": "HERMETIC_TEST", "AUTHORITY": "PASS", "EXPECTED_MAIN": self.main, "CTV_HISTORY": "IMMUTABLE_FAIL",
             "CLOSEOUT_SHA256": self.closeout_sha, "CURRENT_RUNTIME": "PASS", "CURRENT_STATE_SCOPE": "UNIT_SHA256,CORE_ACTIVE,TRUSTEDCLOCK_NOW",
             "EVIDENCE_INTEGRITY": "PASS", "HISTORICAL_S10": "FAIL", "PROMOTES_CTV_TO_PASS": "NO", "PREREQ_RECOVERY_ATTEMPT": "PASS", "PREREQ_R1I": "PASS",
             "PREREQ_R1B_AUTHORITY": "PASS", "ATTESTATION": "PARTIAL", "RECOVERY_AUTHORIZED": "NO", "READ_ONLY": "YES", "PRODUCTION_MUTATION": "NO",
             "ATTEMPT_CONSUMED": "NO", "WIRED_INTO_RECOVERY": "NO"}
        d.update(over)
        path = self.ev / "attestation.txt"
        self.put(path, kv({p + k: v for k, v in d.items() if v is not None}))
        return path

    def release(self, tamper: bool = False, **over: str) -> Path:
        p = "RECOVERY_RELEASE_PROOF_"
        d = {"STAGE": "Recovery-release-cli-proof", "MODE": "HERMETIC_TEST", "MAIN": self.main, "HOST_PROOF": "PERFORMED", "RELEASE_IDENTITY": "PASS",
             "RESTORE_CLI_PROOF": "PASS", "MANIFEST_PROOF": "PASS", "HOST_RELEASE_SUMS_SHA256": H["b"], "PASS_SCOPE": "RELEASE_AND_RESTORE_CLI_IDENTITY_ONLY",
             "RECOVERY_AUTHORIZED": "NO", "READ_ONLY": "YES", "PRODUCTION_MUTATION": "NO", "VERDICT": "PASS"}
        d.update(over)
        body = "".join(f"{p}{k}={v}\n" for k, v in d.items())
        text = body + f"{p}PROOF_SHA256={sha(body.encode())}\n"
        if tamper:
            text = text.replace("RELEASE_IDENTITY=PASS", "RELEASE_IDENTITY=PASS ")
        path = self.ev / "release.txt"
        self.put(path, text)
        return path

    def auth(self, **over: str | None) -> Path:
        d = {"AUTH_SCHEMA": "recovery-third-successor-authorization-v1", "AUTH_ID": "OWNER-AUTH-0001", "AUTH_DATE_UTC": time.strftime("%Y-%m-%d", time.gmtime()),
             "AUTH_MAIN": self.main, "AUTH_CTV_CLOSEOUT_SHA256": self.closeout_sha, "AUTH_STAGE": "RECOVERY_THIRD_SUCCESSOR", "AUTH_IS_CTV_RETRY": "NO",
             "AUTH_INHERITS_PREVIOUS_AUTHORIZATION": "NO", "AUTH_SINGLE_ATTEMPT": "YES", "AUTH_K3_BINDING_SHA256": H["c"],
             "AUTH_REVIEWED_SUCCESSOR_AUTHORITY_ID": AUTH_ID}
        d.update(over)
        path = self.ev / "auth.txt"
        self.put(path, kv({k: v for k, v in d.items() if v is not None}))
        return path

    def run(self, *, canon: bool = True, attestation: Path | None = None, release: Path | None = None, auth: Path | None = None, extra: tuple[str, ...] = (),
            env: dict[str, str] | None = None, py_flags: tuple[str, ...] = ("-I", "-B"), hermetic: bool = True, now: float | None = None) -> "Out":
        cmd = [sys.executable if False else "/usr/bin/python3", *py_flags, str(self.tool), "--repo", str(self.repo), "--main", self.main]
        if hermetic:
            cmd += ["--hermetic", "--test-root", str(self.root)]
            if now is not None:
                cmd += ["--test-now", str(now)]
        if canon:
            cmd += ["--canon", str(self.canon)]
        for flag, v in (("--attestation", attestation), ("--release-proof", release), ("--authorization", auth)):
            if v:
                cmd += [flag, str(v)]
        cmd += list(extra)
        e = {"PATH": "/usr/bin:/bin", "RECOVERY_THIRD_SUCCESSOR_TEST_ONLY": "YES", **(env or {})}
        r = subprocess.run(cmd, text=True, capture_output=True, env=e, cwd=self.root, check=False)
        return Out(r)

    def tree(self) -> dict[str, tuple[int, str]]:
        out = {}
        for p in sorted(self.root.rglob("*")):
            if p.is_file() and ".git/" not in str(p):
                st = p.lstat()
                out[str(p)] = (st.st_mode, sha(p.read_bytes()))
            elif p.is_dir():
                out[str(p)] = (p.lstat().st_mode, "dir")
        return out


class Out:
    def __init__(self, r: subprocess.CompletedProcess[str]) -> None:
        self.rc, self.stdout, self.stderr = r.returncode, r.stdout, r.stderr
        self.f = {}
        for line in r.stdout.splitlines():
            if line.startswith("THIRD_SUCCESSOR_") and "=" in line:
                k, v = line.split("=", 1)
                self.f[k.removeprefix("THIRD_SUCCESSOR_")] = v

    def __getitem__(self, k: str) -> str:
        return self.f[k]


@pytest.fixture()
def w(tmp_path: Path) -> World:
    return World(tmp_path)


def full(w: World, **kw) -> Out:
    return w.run(attestation=w.attestation(), release=w.release(), auth=w.auth(), **kw)


def assert_never_authorizes(o: Out) -> None:
    assert o.rc != 0
    assert o.f.get("RECOVERY_AUTHORIZED") == "NO"
    assert "RECOVERY_AUTHORIZED=YES" not in o.stdout
    if "RECOVERY_EXECUTED" in o.f:
        assert (o.f["RECOVERY_EXECUTED"], o.f["PRODUCTION_MUTATION"], o.f["MARKER_CREATED_OR_CONSUMED"]) == ("NO", "NO", "NO")


# ── positive facts and the authorization barrier ────────────────────────────────────────────────────────────────────────────────────────
def test_full_hermetic_world_reports_facts_but_is_never_above_partial(w):
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "VERIFIED" and o["HISTORICAL_EVIDENCE_REASON"] == "NONE"
    assert o["CURRENT_RUNTIME"] == "PARTIAL" and o["CURRENT_RUNTIME_REASON"] == "HERMETIC_TEST_IS_NEVER_PRODUCTION_EVIDENCE"
    assert o["RELEASE_CLI"] == "PARTIAL" and o["OWNER_AUTHORIZATION"] == "PRESENT_NOT_EXECUTED"
    assert o["READINESS"] == "PARTIAL" and o.rc == 3
    assert o["MODE"] == "HERMETIC_TEST"
    assert o["CTV_FAIL_PROMOTED_TO_PASS"] == "NO" and o["CTV_RERUN_ALLOWED"] == "NO"
    assert o["OWNER_AUTHORIZATION_AUTHENTICITY"] == "NOT_VERIFIED_OFFLINE" and o["OWNER_AUTHORIZATION_IS_ATTESTATION_BINDING"] == "NO"
    assert_never_authorizes(o)


def test_report_is_deterministic_and_digest_bound(w):
    a, b = full(w), full(w)
    assert a.stdout == b.stdout
    lines = a.stdout.splitlines()
    body = "\n".join(lines[:-1]) + "\n"
    assert lines[-1] == f"THIRD_SUCCESSOR_REPORT_SHA256={sha(body.encode())}"


def test_all_fifteen_requirements_are_reported_and_two_cannot_be_proven(w):
    o = full(w)
    names = [k for k in o.f if k.startswith("REQUIREMENT_") and not k.endswith("_NOTE")]
    assert len(names) == 15
    assert o["REQUIREMENT_RESTORE_CUT_RESTRICTIONS"] == "UNKNOWN"
    assert o["REQUIREMENT_FRESH_R1I_R1B_R1BV_FACTS"] == "UNKNOWN" or o["REQUIREMENT_FRESH_R1I_R1B_R1BV_FACTS"] == "PARTIAL"
    assert "RESTORE_CUT_RESTRICTIONS" in o["MISSING_OWNER_EVIDENCE"]


def test_the_real_repository_has_no_reviewed_pins_so_everything_dependent_is_unknown():
    assert not (REPO_ROOT / PINS_REL).exists(), "a pins file would be Human Owner evidence and needs its own reviewed change"


def test_without_any_evidence_the_report_is_unknown_and_nonzero(w):
    o = w.run(canon=False)
    assert (o["HISTORICAL_EVIDENCE"], o["CURRENT_RUNTIME"], o["RELEASE_CLI"], o["OWNER_AUTHORIZATION"]) == ("UNKNOWN", "NOT_VERIFIED", "UNKNOWN", "NOT_PRESENT")
    assert o["READINESS"] == "PARTIAL" and o.rc == 3
    assert_never_authorizes(o)


def test_missing_pins_keep_history_unknown_and_never_verified(tmp_path):
    w = World(tmp_path, pins=False)
    o = full(w)
    assert o["PINS_FILE"] == "ABSENT_IN_THE_PINNED_MAIN"
    assert o["HISTORICAL_EVIDENCE"] == "UNKNOWN" and o["HISTORICAL_EVIDENCE_REASON"].startswith("NO_REVIEWED_PIN")
    assert o["OWNER_AUTHORIZATION"] == "INVALID"
    assert o["PIN_DETECTOR_UNIT_SHA256"] == "UNKNOWN"
    assert_never_authorizes(o)


def test_missing_detector_pin_keeps_detector_unknown(tmp_path):
    w = World(tmp_path)
    d = dict(w.pin_values)
    del d["DETECTOR_UNIT_SHA256"]
    w.put(w.repo / PINS_REL, kv(d))
    sh(w.repo, "add", "-A"); sh(w.repo, "commit", "-qm", "p")
    w.main = sh(w.repo, "rev-parse", "HEAD")
    o = full(w)
    assert o["REQUIREMENT_DETECTOR_IDENTITY"] == "UNKNOWN" and o["PIN_DETECTOR_UNIT_SHA256"] == "UNKNOWN"


def test_missing_release_manifest_pin_never_verifies_release(tmp_path):
    w = World(tmp_path)
    d = dict(w.pin_values)
    del d["RELEASE_SUMS_SHA256"]
    w.put(w.repo / PINS_REL, kv(d))
    sh(w.repo, "add", "-A"); sh(w.repo, "commit", "-qm", "p")
    w.main = sh(w.repo, "rev-parse", "HEAD")
    o = full(w)
    assert o["RELEASE_CLI"] == "PARTIAL" and "RELEASE_SUMS" in o["RELEASE_CLI_REASON"]


# ── immutable history ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("key,value", [
    ("CTV_RESULT", "CLOSED_PASS"), ("CTV_LIVE", "CLOSED_PASS"), ("CTV_RERUN_ALLOWED", "YES"), ("CTV_S10_HISTORICAL_COMPARE", "PASS"),
    ("CTV_S10_PROMOTED_TO_PASS", "YES"), ("CTV_RECOVERY_AUTHORIZED", "YES"), ("CTV_ATTEMPT_CONSUMED", "NO"), ("CTV_ROLLBACK_COMPLETE", "YES"),
    ("CTV_IS_CTU_RETRY", "YES"), ("CTV_DETECTOR_BASELINE_MODE", "ACTIVE"), ("CTV_JOURNAL_PHASE", "rolled-back"),
])
def test_a_ctv_fail_is_never_converted_to_pass_or_reinterpreted(w, key, value):
    c = dict(CLOSEOUT); c[key] = value
    w.write_history(c)
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and o["READINESS"] == "BLOCKED" and o.rc == 2
    assert_never_authorizes(o)


def test_a_pass_closeout_alongside_the_fail_is_a_contradiction(w):
    w.put(w.canon / "CTV-GLOBAL-CLOSEOUT-PASS", "CTV_RESULT=CLOSED_PASS\n")
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and "CONTRADICT" in o["HISTORICAL_EVIDENCE_REASON"]


@pytest.mark.parametrize("extra", ["CTV-GLOBAL-CLOSEOUT-FAIL.1", "CTV-GLOBAL-CLOSEOUT-FAIL-DUP", "CTV-OTHER"])
def test_duplicate_or_stray_ctv_entries_are_rejected(w, extra):
    w.put(w.canon / extra, kv(CLOSEOUT))
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_missing_consumed_marker_is_rejected(w):
    (w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").unlink()
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


@pytest.mark.parametrize("change", [
    lambda m: {**m, "CTU_ATTEMPT_CONSUMED": "NO"},
    lambda m: {**m, "CTU_RERUN_ALLOWED": "YES"},
    lambda m: {**m, "CTU_DEVICE_ID": ""},
    lambda m: {**m, "CTU_CONSUMED_AT_EPOCH": "not-a-time"},
    lambda m: {**m, "CTU_PRE_OPEN_EPISODE_COUNT": "2"},
    lambda m: {**m, "CTU_FROZEN_RUNNER_SHA256": "bad"},
])
def test_ctu_marker_contents_are_required_not_just_the_filename(w, change):
    marker = w.canon / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    values = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in marker.read_text().splitlines()}
    w.put(marker, kv(change(values)))
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and o.rc == 2


def test_ctu_marker_with_an_unknown_key_is_rejected(w):
    marker = w.canon / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    w.put(marker, marker.read_text() + "CTU_NOTE=unexpected\n")
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and "SCHEMA_NOT_EXACT" in o["HISTORICAL_EVIDENCE_REASON"]


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "writable"])
def test_ctu_marker_file_trust_boundary_is_enforced(w, kind):
    marker = w.canon / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    if kind == "symlink":
        real = w.ev / "ctu-marker-real"
        w.put(real, marker.read_text())
        marker.unlink()
        marker.symlink_to(real)
    elif kind == "hardlink":
        os.link(marker, w.ev / "ctu-marker-hardlink")
    else:
        os.chmod(marker, 0o666)
    o = full(w)
    assert o.rc == 2 and o["HISTORICAL_EVIDENCE"] == "BLOCKED" and o["RECOVERY_AUTHORIZED"] == "NO"


def test_a_consumed_marker_that_allows_rerun_is_rejected(w):
    w.put(w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED", kv({**MARKER, "CTV_RERUN_ALLOWED": "YES"}))
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_marker_and_closeout_must_name_the_same_frozen_runner(w):
    w.put(w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED", kv({**MARKER, "CTV_FROZEN_RUNNER_SHA256": H["e"]}))
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_a_modified_closeout_with_a_stale_sidecar_is_rejected(w):
    p = w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    w.put(p, kv({**CLOSEOUT, "CTV_DEVICE_ID": "x"}))
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_a_modified_closeout_with_a_recomputed_sidecar_differs_from_the_reviewed_pin(w):
    w.write_history({**CLOSEOUT, "CTV_DEVICE_ID": "aegis-relay-02"})
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and "REVIEWED_PIN" in o["HISTORICAL_EVIDENCE_REASON"]
    assert o["REQUIREMENT_CTV_CLOSEOUT_DIGEST"] == "BLOCKED"


def test_modified_pin_value_is_rejected(tmp_path):
    w = World(tmp_path, pins={"CTV_CLOSEOUT_SHA256": H["e"]})
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


@pytest.mark.parametrize("pins", [{"CTV_CLOSEOUT_SHA256": "xyz"}, {"CTV_UNIT_SHA256": "A" * 64}, {"THIRD_SUCCESSOR_AUTHORITY_ID": "bad id"}])
def test_malformed_pins_in_main_fail_closed(tmp_path, pins):
    o = full(World(tmp_path, pins=pins))
    assert o.rc == 1 and "PINS_VALUE_INVALID" in o.stdout


def test_unknown_pin_key_fails(tmp_path):
    w = World(tmp_path)
    w.put(w.repo / PINS_REL, kv({**w.pin_values, "EXTRA": "x"}))
    sh(w.repo, "add", "-A"); sh(w.repo, "commit", "-qm", "p"); w.main = sh(w.repo, "rev-parse", "HEAD")
    assert "PINS_" in full(w).stdout


def test_a_recovery_entry_means_the_single_attempt_is_already_consumed(w):
    w.put(w.canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED", "x\n")
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and "RECOVERY_ENTRY" in o["HISTORICAL_EVIDENCE_REASON"]


def test_ctu_pass_present_contradicts_the_history(w):
    w.put(w.canon / "CTU-GLOBAL-CLOSEOUT-PASS", "CTU_RESULT=PASS\n")
    assert full(w)["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_ctu_pass_is_never_assumed_when_ctu_history_is_not_supplied(w):
    (w.canon / "CTU-GLOBAL-CLOSEOUT-FAIL").unlink()
    assert full(w)["HISTORICAL_EVIDENCE"] == "UNKNOWN"


def test_duplicate_keys_and_malformed_lines_in_the_closeout_fail(w):
    p = w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    w.put(p, kv(CLOSEOUT) + "CTV_RESULT=CLOSED_PASS\n")
    w.put(w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256", f"{sha(p.read_bytes())}  CTV-GLOBAL-CLOSEOUT-FAIL\n")
    assert full(w).rc == 1


# ── existing Recovery predecessor gate still blocks the historical failure ──────────────────────────────────────────────────────────────
def test_the_gate_anchors_are_checked_and_a_weakened_gate_blocks(tmp_path):
    w = World(tmp_path, lib_text=LIB_SRC.replace("CTV_RESULT=CLOSED_PASS", "CTV_RESULT=CLOSED_PAS"))
    o = full(w)
    assert o["RECOVERY_PREDECESSOR_GATE"].startswith("ANCHORS_MISSING") and o["HISTORICAL_EVIDENCE"] == "BLOCKED"


def test_the_real_recovery_gate_refuses_the_ctv_fail_history(tmp_path):
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    os.chmod(canon, 0o700)
    for n, c in (("CTU-GLOBAL-ATTEMPT-CONSUMED", "CTU_ATTEMPT_CONSUMED=YES\n"), ("CTU-GLOBAL-CLOSEOUT-FAIL", kv({**CTU_FAIL, "CTU_FAILURE_REASON": "APPLY"})),
                 ("CTV-GLOBAL-ATTEMPT-CONSUMED", kv(MARKER)), ("CTV-GLOBAL-CLOSEOUT-FAIL", kv(CLOSEOUT))):
        World.put(canon / n, c)
    repo = tmp_path / "r"
    repo.mkdir()
    sh(repo, "init", "-q")
    script = f'''set -Eeuo pipefail
export SUDO="" RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RECOVERY_TEST_ONLY_CANONICAL_DIR="{canon}" RECOVERY_TEST_ONLY_TRUST_ROOT="{tmp_path}"
source "{REPO_ROOT / LIB_REL}"
recovery_ctv_successor_gate "{repo}" "{'a' * 40}"
'''
    r = subprocess.run(["bash", "-c", script], text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert r.returncode != 0 and "RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT" in r.stdout + r.stderr
    assert not (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()


# ── attestation transcript (current runtime) ────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("over", [
    {"EXPECTED_MAIN": "0" * 40}, {"CLOSEOUT_SHA256": H["e"]}, {"MODE": "PRODUCTION"}, {"CTV_HISTORY": "CLOSED_PASS"}, {"CURRENT_RUNTIME": "FAIL"},
    {"PROMOTES_CTV_TO_PASS": "YES"}, {"RECOVERY_AUTHORIZED": "YES"}, {"HISTORICAL_S10": "PASS"}, {"READ_ONLY": "NO"}, {"PRODUCTION_MUTATION": "YES"},
    {"ATTEMPT_CONSUMED": "YES"}, {"WIRED_INTO_RECOVERY": "YES"}, {"ATTESTATION": "FAIL"}, {"CURRENT_STATE_SCOPE": "UNIT_SHA256"}, {"AUTHORITY": "FAIL"},
    {"EVIDENCE_INTEGRITY": "FAIL"},
])
def test_a_wrong_or_unbound_attestation_is_not_runtime_evidence(w, over):
    o = w.run(attestation=w.attestation(**over))
    assert o["CURRENT_RUNTIME"] == "NOT_VERIFIED", over
    assert o["READINESS"] != "AWAITING_APPROVAL"


def test_stale_runtime_evidence_cannot_represent_fresh_state(w):
    p = w.attestation()
    ok = w.run(attestation=p, now=time.time() + 60)
    assert ok["CURRENT_RUNTIME"] == "PARTIAL"
    stale = w.run(attestation=p, now=time.time() + 3600)
    assert stale["CURRENT_RUNTIME"] == "NOT_VERIFIED" and stale["CURRENT_RUNTIME_REASON"] == "ATTESTATION_TRANSCRIPT_STALE"
    future = w.run(attestation=p, now=time.time() - 3600)
    assert future["CURRENT_RUNTIME"] == "NOT_VERIFIED"
    assert ok["CURRENT_RUNTIME_FRESHNESS"].startswith("NOT_PROVEN_OFFLINE")


def test_a_runtime_without_a_verified_history_is_not_bound(tmp_path):
    w = World(tmp_path, pins=False)
    assert w.run(attestation=w.attestation())["CURRENT_RUNTIME"] == "NOT_VERIFIED"


def test_duplicate_key_in_a_transcript_is_refused(w):
    p = w.attestation()
    p.write_text(p.read_text() + "CTV_FAIL_SUCCESSOR_ATTESTATION=PASS\n")
    assert w.run(attestation=p)["CURRENT_RUNTIME"] == "NOT_VERIFIED"


# ── release / CLI transcript ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_tampered_release_proof_is_unknown(w):
    o = w.run(release=w.release(tamper=True))
    assert o["RELEASE_CLI"] == "UNKNOWN" and "DIGEST" in o["RELEASE_CLI_REASON"]


@pytest.mark.parametrize("over", [{"MAIN": "0" * 40}, {"RELEASE_IDENTITY": "UNKNOWN"}, {"RESTORE_CLI_PROOF": "UNKNOWN"}, {"VERDICT": "PARTIAL"}, {"HOST_PROOF": "NOT_PERFORMED"},
                                  {"RECOVERY_AUTHORIZED": "YES"}, {"MODE": "PRODUCTION"}, {"HOST_RELEASE_SUMS_SHA256": H["e"]}])
def test_release_proof_must_be_complete_and_bound(w, over):
    o = w.run(release=w.release(**over))
    assert o["RELEASE_CLI"] in ("UNKNOWN", "PARTIAL") and o["RELEASE_CLI"] != "VERIFIED"


def test_invalid_release_identity_text_is_rejected(w):
    p = w.release(RELEASE_IDENTITY="NOT-A-RELEASE")
    assert w.run(release=p)["RELEASE_CLI"] == "PARTIAL"


# ── owner authorization (structure and binding only) ────────────────────────────────────────────────────────────────────────────────────
def test_no_authorization_is_not_present(w):
    assert w.run()["OWNER_AUTHORIZATION"] == "NOT_PRESENT"


@pytest.mark.parametrize("over", [
    {"AUTH_IS_CTV_RETRY": "YES"}, {"AUTH_INHERITS_PREVIOUS_AUTHORIZATION": "YES"}, {"AUTH_SINGLE_ATTEMPT": "NO"}, {"AUTH_STAGE": "CTV"}, {"AUTH_SCHEMA": "v0"},
    {"AUTH_DATE_UTC": "2020-01-01"}, {"AUTH_MAIN": "0" * 40}, {"AUTH_CTV_CLOSEOUT_SHA256": H["e"]}, {"AUTH_K3_BINDING_SHA256": "zz"}, {"AUTH_ID": "x"},
    {"AUTH_REVIEWED_SUCCESSOR_AUTHORITY_ID": "OTHER-AUTH-9999"}, {"AUTH_CTV_CLOSEOUT_SHA256": None}, {"AUTH_K3_BINDING_SHA256": None}, {"AUTH_EXTRA": "x"},
    {"RECOVERY_AUTHORIZED": "YES"},
])
def test_each_authorization_break_is_invalid(w, over):
    o = w.run(auth=w.auth(**over))
    assert o["OWNER_AUTHORIZATION"] == "INVALID", over


def test_authorization_from_a_previous_failed_attempt_cannot_be_inherited(w):
    a = w.auth(AUTH_INHERITS_PREVIOUS_AUTHORIZATION="YES", AUTH_IS_CTV_RETRY="YES")
    assert w.run(auth=a)["OWNER_AUTHORIZATION"] == "INVALID"


def test_an_attestation_binding_or_readiness_digest_is_not_an_authorization(w):
    p = w.attestation(BINDING_SHA256=H["c"], READINESS_SHA256=H["d"])
    a = w.ev / "auth.txt"
    w.put(a, kv({"CTV_FAIL_SUCCESSOR_BINDING_SHA256": H["c"], "CTV_FAIL_SUCCESSOR_READINESS_SHA256": H["d"]}))
    o = w.run(attestation=p, auth=a)
    assert o["OWNER_AUTHORIZATION"] == "INVALID"
    assert o["OWNER_AUTHORIZATION_IS_ATTESTATION_BINDING"] == "NO"


def test_a_valid_looking_authorization_does_not_authorize_and_is_not_executed(w):
    o = full(w)
    assert o["OWNER_AUTHORIZATION"] == "PRESENT_NOT_EXECUTED"
    assert_never_authorizes(o)
    assert o["NOT_AN_AUTHORIZATION"].startswith("THIS_REPORT_IS_NOT_A_TOKEN")


# ── untrusted files, environment and tool authority ─────────────────────────────────────────────────────────────────────────────────────
def test_symlinked_evidence_is_rejected(w):
    real = w.ev / "real.txt"
    w.put(real, w.attestation().read_text())
    link = w.ev / "link.txt"
    link.symlink_to(real)
    assert w.run(attestation=link)["CURRENT_RUNTIME"] == "NOT_VERIFIED"


def test_symlinked_evidence_directory_component_is_rejected(w):
    d2 = w.root / "other"
    d2.mkdir(mode=0o700)
    w.put(d2 / "a.txt", w.attestation().read_text())
    (w.root / "lnk").symlink_to(d2)
    assert w.run(attestation=w.root / "lnk" / "a.txt")["CURRENT_RUNTIME"] == "NOT_VERIFIED"


def test_hardlinked_evidence_is_rejected(w):
    a = w.attestation()
    os.link(a, w.ev / "attest-hard.txt")
    o = w.run(attestation=a)
    assert o["CURRENT_RUNTIME"] == "NOT_VERIFIED" and "HARD_LINK" in o["CURRENT_RUNTIME_REASON"]


def test_hardlinked_authorization_is_invalid(w):
    a = w.auth()
    os.link(a, w.ev / "auth-hard.txt")
    assert w.run(auth=a)["OWNER_AUTHORIZATION"] == "INVALID"


def test_hardlinked_closeout_is_refused(w):
    os.link(w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL", w.ev / "closeout-hard")
    assert full(w).rc == 1


@pytest.mark.parametrize("mode", [0o620, 0o602, 0o666])
def test_group_or_world_writable_evidence_is_rejected(w, mode):
    a = w.attestation()
    os.chmod(a, mode)
    assert w.run(attestation=a)["CURRENT_RUNTIME"] == "NOT_VERIFIED"


def test_group_writable_directory_chain_is_rejected(w):
    a = w.attestation()
    os.chmod(w.ev, 0o770)
    o = w.run(attestation=a)
    assert o.rc == 1 and "EVIDENCE_PATH_CHAIN_UNTRUSTED" in o.stdout and "READINESS" not in o.stdout


@pytest.mark.parametrize("path", ["relative.txt", "/etc/../etc/passwd", "//etc//passwd"])
def test_non_absolute_or_traversing_evidence_paths_are_rejected(w, path):
    assert w.run(attestation=Path(path))["CURRENT_RUNTIME"] == "NOT_VERIFIED"


def test_evidence_outside_the_test_root_is_rejected(w, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside") / "a.txt"
    outside.write_text(w.attestation().read_text())
    os.chmod(outside, 0o600)
    assert w.run(attestation=outside)["CURRENT_RUNTIME"] == "NOT_VERIFIED"


@pytest.mark.parametrize("var", ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "GIT_DIR", "GIT_CONFIG", "TMPDIR"])
def test_environment_redirection_is_rejected(w, var):
    o = w.run(env={var: "/tmp/x"})
    assert o.rc == 1 and "ENVIRONMENT_OVERRIDE_SET" in o.stdout


def test_python_import_redirection_cannot_load_a_planted_module(w):
    evil = w.root / "evil"
    evil.mkdir(mode=0o700)
    marker = w.root / "executed"
    (evil / "hashlib.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    o = w.run(env={"PYTHONPATH": str(evil)})
    assert o.rc == 1 and not marker.exists()


def test_the_tool_refuses_to_run_without_isolated_python(w):
    o = w.run(py_flags=("-B",))
    assert o.rc == 1 and "PYTHON_NOT_ISOLATED" in o.stdout


def test_a_planted_module_next_to_the_tool_is_never_imported(w):
    marker = w.root / "executed"
    (w.repo / TOOL_REL).parent.joinpath("hashlib.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    w.run(extra=())
    assert not marker.exists()


def test_a_tool_that_differs_from_main_is_refused(w):
    w.tool.write_text(TOOL_SRC + "\n# tampered\n")
    assert "REPO_NOT_CLEAN" in w.run().stdout
    sh(w.repo, "update-index", "--assume-unchanged", TOOL_REL)
    o = w.run()
    assert o.rc == 1 and "TOOL_DIFFERS_FROM_THE_PINNED_MAIN" in o.stdout and "READINESS" not in o.stdout


def test_a_dirty_or_moved_head_is_refused(w):
    (w.repo / "junk").write_text("x")
    assert "REPO_NOT_CLEAN" in w.run().stdout
    os.unlink(w.repo / "junk")
    sh(w.repo, "commit", "-q", "--allow-empty", "-m", "moved")
    assert "REPO_HEAD_NOT_THE_PINNED_MAIN" in w.run().stdout


def test_replacement_objects_cannot_forge_main_content(w):
    blob = subprocess.run(["git", "-C", str(w.repo), "hash-object", "-w", "--stdin"], input="CTV_CLOSEOUT_SHA256=bad\n", text=True, capture_output=True).stdout.strip()
    sh(w.repo, "replace", sh(w.repo, "rev-parse", f"{w.main}:{PINS_REL}"), blob)
    o = full(w)
    assert o["PIN_CTV_CLOSEOUT_SHA256"] == "PINNED" and o["HISTORICAL_EVIDENCE"] == "VERIFIED"


def test_pins_cannot_be_supplied_on_the_command_line(w):
    o = w.run(extra=("--pin-ctv-closeout-sha256", H["a"]))
    assert "READINESS" not in o.stdout and o.rc != 0


def test_test_seams_are_refused_in_production_mode_and_without_the_env_flag(w):
    assert w.run(hermetic=False, extra=("--test-now", "1")).rc == 1
    o = w.run(env={"RECOVERY_THIRD_SUCCESSOR_TEST_ONLY": "NO"})
    assert o.rc == 1 and "TEST_SEAM_NOT_ENABLED" in o.stdout
    o = w.run(extra=("--test-root", str(w.root / "other")))
    assert o.rc != 0 and "READINESS" not in o.stdout


def test_production_mode_never_trusts_a_tmp_world(w):
    o = full(w, hermetic=False)
    assert o.rc == 1 and "READINESS" not in o.stdout and "AWAITING_APPROVAL" not in o.stdout
    assert "EVIDENCE_PATH_CHAIN" in o.stdout or "TOOL_" in o.stdout or "REPO_" in o.stdout, o.stdout


def test_the_test_root_must_be_private(w):
    os.chmod(w.root, 0o755)
    assert "TEST_ROOT_UNSAFE" in w.run().stdout


# ── no side effects ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_no_marker_directory_or_file_is_created_or_changed(w):
    full_args = dict(attestation=w.attestation(), release=w.release(), auth=w.auth())
    before = w.tree()
    for _ in range(3):
        w.run(**full_args)
    assert w.tree() == before
    assert not list(w.canon.glob("RECOVERY-*"))


def test_static_scan_finds_no_mutation_restore_cut_restart_firmware_or_mqtt_capability():
    src = TOOL_SRC
    assert re.search(r"^import (socket|ssl|http|urllib|ftplib|smtplib|paramiko|serial|paho)", src, re.M) is None
    for banned in ("shutil", "os.remove", "os.unlink", "os.rename", "os.replace", "os.chmod", "os.chown", "os.mkdir", "os.makedirs", "os.symlink", "os.link(", "os.system",
                   "os.exec", "os.fork", "tempfile", "systemctl", "restore", "mosquitto", "esptool", "sudo", "O_WRONLY", "O_RDWR", "O_CREAT", "write_text", "write_bytes", "\"w\"", "\"a\"", "'w'"):
        body = src.split('"""', 2)[2]
        assert banned not in body.replace("restore_cut", "").replace("RESTORE_CUT", "").replace("restore_CUT", ""), banned
    assert src.count("subprocess.run") == 1 and '"/usr/bin/git"' in src


def test_the_tool_is_not_registered_or_wired_into_recovery():
    for rel in ("IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh", LIB_REL, "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh"):
        assert "third_successor" not in (REPO_ROOT / rel).read_text().lower(), rel
    stages = REPO_ROOT / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages"
    assert not any("third" in n.lower() for n in os.listdir(stages))


def test_existing_authorities_are_unchanged_on_this_branch():
    r = subprocess.run(["git", "-C", str(REPO_ROOT), "diff", "--name-only", "origin/main"], text=True, capture_output=True)
    if r.returncode != 0:
        pytest.skip("origin/main unavailable")
    protected = ("owner-run/run-recovery-owner.sh", "p4-recovery-run-lib.sh", "p4-ctv-run-lib.sh", "p4-ctu-run-lib.sh", "recovery_runner_freeze.py", "ctv-incident/", "stages/")
    changed = [x for x in r.stdout.split() if any(p in x for p in protected)]
    assert changed == []


# ── the non-hermetic readiness branch (in-process; trust seams patched ONLY to test the decision logic) ─────────────────────────────────
def load_module(path: Path):
    spec = importlib.util.spec_from_file_location("trs_under_test", path)
    m = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(m)
    return m


def prod_args(w: World, **kw) -> SimpleNamespace:
    return SimpleNamespace(repo=str(w.repo), main=w.main, canon=str(w.canon), attestation=kw.get("attestation", ""), release_proof=kw.get("release", ""),
                           authorization=kw.get("auth", ""), hermetic=False, test_root="", test_now="")


def prod_run(w: World, drop: str = "", **over) -> tuple[Out, int]:
    m = load_module(w.tool)
    orig = m.trusted_read
    m.trusted_read = lambda path, stop: orig(path, w.root)
    m.check_environment = lambda: None
    m.verify_self = lambda repo, main: "0" * 64
    att = w.attestation(MODE="PRODUCTION")
    rel = w.release(MODE="PRODUCTION")
    auth = w.auth()
    paths = {"attestation": att, "release": rel, "auth": auth}
    if drop:
        paths.pop(drop)
    rep, code = m.run(prod_args(w, **{k: str(v) for k, v in paths.items()}))
    o = Out(subprocess.CompletedProcess([], code, "\n".join(rep.lines()) + "\n", ""))
    return o, code


def test_partial_runtime_is_never_misrepresented_as_awaiting_approval(w):
    o, code = prod_run(w)
    assert o["MODE"] == "PRODUCTION" and o["RELEASE_CLI"] == "VERIFIED" and o["CURRENT_RUNTIME"] == "PARTIAL"
    assert o["READINESS"] == "PARTIAL" and code == 3
    assert o["RECOVERY_AUTHORIZED"] == "NO" and o["RECOVERY_EXECUTED"] == "NO" and o["PRODUCTION_MUTATION"] == "NO"
    assert o["REQUIREMENT_RESTORE_CUT_RESTRICTIONS"] == "UNKNOWN"


@pytest.mark.parametrize("drop", ["attestation", "release", "auth"])
def test_dropping_any_prerequisite_prevents_awaiting_approval(w, drop):
    o, code = prod_run(w, drop=drop)
    assert o["READINESS"] == "PARTIAL" and code == 3


def test_a_missing_reviewed_pin_prevents_awaiting_approval(tmp_path):
    for key in ("DETECTOR_UNIT_SHA256", "THIRD_SUCCESSOR_AUTHORITY_ID", "RELEASE_SUMS_SHA256"):
        w = World(tmp_path / key[:4], pins=True) if (tmp_path / key[:4]).mkdir() is None else None
        d = dict(w.pin_values); del d[key]
        w.put(w.repo / PINS_REL, kv(d)); sh(w.repo, "add", "-A"); sh(w.repo, "commit", "-qm", "p"); w.main = sh(w.repo, "rev-parse", "HEAD")
        o, code = prod_run(w)
        assert o["READINESS"] != "AWAITING_APPROVAL" and code in (2, 3), key


def test_a_blocked_history_always_blocks_even_with_everything_else_present(w):
    w.write_history({**CLOSEOUT, "CTV_RESULT": "CLOSED_PASS"})
    o, code = prod_run(w)
    assert o["READINESS"] == "BLOCKED" and code == 2


# ── mutation tests: removing a protection must make an attack succeed (so the corresponding test above is load-bearing) ──────────────────
def mutant(tmp_path: Path, old: str, new: str, *more: str) -> World:
    text = TOOL_SRC
    pairs = [(old, new), *zip(more[0::2], more[1::2])]
    for a, b in pairs:
        assert text.count(a) >= 1, a
        text = text.replace(a, b, 1)
    return World(tmp_path, tool_text=text)


def test_mutation_closeout_field_check_removed_lets_a_pass_closeout_through(tmp_path):
    w = mutant(tmp_path, "        if closeout.get(k) != v:\n            return \"BLOCKED\", f\"CLOSEOUT_FIELD_NOT_THE_IMMUTABLE_FAIL:{k}\", {}", "        if False:\n            pass")
    w.write_history({**CLOSEOUT, "CTV_RERUN_ALLOWED": "YES"})
    w.put(w.repo / PINS_REL, kv({**w.pin_values, "CTV_CLOSEOUT_SHA256": sha((w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").read_bytes())}))
    sh(w.repo, "add", "-A"); sh(w.repo, "commit", "-qm", "m"); w.main = sh(w.repo, "rev-parse", "HEAD"); w.closeout_sha = sha((w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").read_bytes())
    assert full(w)["HISTORICAL_EVIDENCE"] == "VERIFIED", "mutant must be detectable: the unmutated tool BLOCKS this"


def test_mutation_pin_comparison_removed_accepts_a_modified_closeout(tmp_path):
    w = mutant(tmp_path, "cs != pins[\"CTV_CLOSEOUT_SHA256\"] or ", "False or ")
    w.write_history({**CLOSEOUT, "CTV_DEVICE_ID": "aegis-relay-02"})
    assert full(w)["HISTORICAL_EVIDENCE"] == "VERIFIED"


def test_mutation_sidecar_check_removed_accepts_a_stale_sidecar(tmp_path):
    w = mutant(tmp_path, "if sidecar_raw != f\"{cs}  CTV-GLOBAL-CLOSEOUT-FAIL\\n\".encode():", "if False:")
    w.put(w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256", f"{H['e']}  CTV-GLOBAL-CLOSEOUT-FAIL\n")
    assert full(w)["HISTORICAL_EVIDENCE"] == "VERIFIED"


def test_mutation_pass_contradiction_removed_is_still_caught_by_the_exact_namespace_layer(tmp_path):
    w = mutant(tmp_path, "    if \"CTV-GLOBAL-CLOSEOUT-PASS\" in ctv:\n        return \"BLOCKED\", \"CTV_PASS_AND_FAIL_HISTORIES_CONTRADICT\", {}\n", "")
    w.put(w.canon / "CTV-GLOBAL-CLOSEOUT-PASS", "x\n")
    o = full(w)
    assert o["HISTORICAL_EVIDENCE"] == "BLOCKED" and o["HISTORICAL_EVIDENCE_REASON"].startswith("CTV_NAMESPACE")


def test_mutation_pass_contradiction_and_namespace_both_removed_accepts_a_pass_beside_the_fail(tmp_path):
    w = mutant(tmp_path, "    if \"CTV-GLOBAL-CLOSEOUT-PASS\" in ctv:\n        return \"BLOCKED\", \"CTV_PASS_AND_FAIL_HISTORIES_CONTRADICT\", {}\n", "",
               "    if ctv != want:", "    if False:")
    w.put(w.canon / "CTV-GLOBAL-CLOSEOUT-PASS", "x\n")
    assert full(w)["HISTORICAL_EVIDENCE"] == "VERIFIED"


def test_mutation_hardlink_check_removed_accepts_a_hardlinked_transcript(tmp_path):
    w = mutant(tmp_path, "    if st.st_nlink != 1:\n        raise Refuse(\"EVIDENCE_HAS_MULTIPLE_HARD_LINKS\")\n", "",
               "if (st2.st_ino, st2.st_dev, st2.st_nlink) != (st.st_ino, st.st_dev, 1):", "if False:")
    a = w.attestation()
    os.link(a, w.ev / "h.txt")
    assert w.run(attestation=a)["CURRENT_RUNTIME"] == "PARTIAL"


def test_mutation_symlink_chain_check_removed_accepts_a_symlinked_directory(tmp_path):
    w = mutant(tmp_path, "if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):", "if not stat.S_ISDIR(st.st_mode) and False:",
               "if st.st_uid not in (0, me) or st.st_mode & 0o022:\n            raise Refuse(\"EVIDENCE_PATH_CHAIN_UNTRUSTED\")", "pass")
    d2 = w.root / "other"; d2.mkdir(mode=0o700)
    w.put(d2 / "a.txt", w.attestation().read_text())
    (w.root / "lnk").symlink_to(d2)
    assert w.run(attestation=w.root / "lnk" / "a.txt")["CURRENT_RUNTIME"] == "PARTIAL"


def test_mutation_staleness_check_removed_accepts_stale_evidence(tmp_path):
    w = mutant(tmp_path, "if age < 0 or age > TRANSCRIPT_MAX_AGE_SECONDS:\n        return \"NOT_VERIFIED\"", "if False:\n        return \"NOT_VERIFIED\"")
    assert w.run(attestation=w.attestation(), now=time.time() + 86400)["CURRENT_RUNTIME"] == "PARTIAL"


def test_mutation_hermetic_cap_removed_lets_a_test_world_reach_verified_release(tmp_path):
    w = mutant(tmp_path, "    if hermetic:\n        return \"PARTIAL\", \"HERMETIC_TEST_IS_NEVER_PRODUCTION_EVIDENCE\"\n", "")
    assert full(w)["RELEASE_CLI"] == "VERIFIED"


def test_mutation_same_day_check_removed_accepts_an_old_authorization(tmp_path):
    w = mutant(tmp_path, "a[\"AUTH_DATE_UTC\"] != today", "False")
    assert w.run(auth=w.auth(AUTH_DATE_UTC="2020-01-01"))["OWNER_AUTHORIZATION"] == "PRESENT_NOT_EXECUTED"


def test_mutation_authorization_binding_removed_accepts_an_unbound_authorization(tmp_path):
    w = mutant(tmp_path, "a[\"AUTH_CTV_CLOSEOUT_SHA256\"] != closeout_sha", "False")
    assert w.run(auth=w.auth(AUTH_CTV_CLOSEOUT_SHA256=H["e"]))["OWNER_AUTHORIZATION"] == "PRESENT_NOT_EXECUTED"


def test_mutation_inheritance_flag_check_removed_accepts_an_inherited_authorization(tmp_path):
    w = mutant(tmp_path, "    \"AUTH_INHERITS_PREVIOUS_AUTHORIZATION\": \"NO\", \"AUTH_SINGLE_ATTEMPT\": \"YES\",", "    \"AUTH_SINGLE_ATTEMPT\": \"YES\",")
    assert w.run(auth=w.auth(AUTH_INHERITS_PREVIOUS_AUTHORIZATION="YES"))["OWNER_AUTHORIZATION"] == "PRESENT_NOT_EXECUTED"


def test_mutation_environment_check_removed_runs_with_pythonpath(tmp_path):
    w = mutant(tmp_path, "        if os.environ.get(name):\n            raise Refuse(f\"ENVIRONMENT_OVERRIDE_SET:{name}\")", "        pass",
               "        if name.startswith((\"PYTHON\", \"LD_\"))", "        if False")
    o = w.run(env={"LD_PRELOAD": "/nonexistent"})
    assert "ENVIRONMENT_OVERRIDE_SET:LD_PRELOAD" not in o.stdout


def test_mutation_gate_anchor_check_removed_lets_a_weakened_gate_pass(tmp_path):
    w = mutant(tmp_path, "    return all(a in lib for a in anchors)", "    return True")
    w2 = World(tmp_path / "x", tool_text=w.tool.read_text(), lib_text=LIB_SRC.replace("CTV_RESULT=CLOSED_PASS", "CTV_RESULT=ANY")) if (tmp_path / "x").mkdir() is None else None
    assert full(w2)["RECOVERY_PREDECESSOR_GATE"].startswith("STILL_REQUIRES")


# ── compatibility with the merged PR #402 attestation (its printed keys are exactly what this verifier requires) ────────────────────────────
ATTEST = REPO_ROOT / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-fail-successor-attest.sh"


@pytest.mark.skipif(not ATTEST.exists(), reason="PR #402 attestation not in this tree")
def test_every_attestation_key_the_verifier_requires_is_printed_by_the_merged_attestation_script():
    src = ATTEST.read_text()
    required = ["MODE", "AUTHORITY", "EXPECTED_MAIN", "CTV_HISTORY", "CLOSEOUT_SHA256", "CURRENT_RUNTIME", "CURRENT_STATE_SCOPE", "EVIDENCE_INTEGRITY", "HISTORICAL_S10",
                "PROMOTES_CTV_TO_PASS", "PREREQ_RECOVERY_ATTEMPT", "PREREQ_R1I", "PREREQ_R1B_AUTHORITY", "ATTESTATION", "RECOVERY_AUTHORIZED", "READ_ONLY",
                "PRODUCTION_MUTATION", "ATTEMPT_CONSUMED", "WIRED_INTO_RECOVERY"]
    for key in required:
        assert f"CTV_FAIL_SUCCESSOR_{key}" in src, key
    assert "TRUSTEDCLOCK_NOW" in src
