"""AEGIS IDEA3 PR11 Phase 4 — L6c owner-runner gate library and static runner contract tests.

Nothing here runs the runner against a host: the library gates are exercised with stubs and fixture git repositories, and
the runner template is checked statically plus by proving it refuses to run unpinned. Also proves the G-15 authorization
separation: an A-L7 or an L6b/L7 K3 can never authorize L6c (p4-stage-gate.sh's stage= field match already enforces this
structurally; no new authority is invented here), and L6c requires no D6 field.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
LIB = DEPLOY / "p4-l6c-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-l6c-owner.sh"
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"

sys.path.insert(0, str(Path(__file__).parent))
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402
from test_pr11_phase4_l7_runner import LOGS, git, make_repo  # noqa: E402

TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()


def lib(script: str, *, env: dict[str, str] | None = None, path_prefix: Path | None = None) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e["SUDO"] = ""
    if path_prefix:
        e["PATH"] = f"{path_prefix}:{e['PATH']}"
    if env:
        e.update(env)
    return subprocess.run(["bash", "-c", f"source '{LIB}'; {script}"], text=True, capture_output=True, env=e, check=False)


def stub(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    f = bin_dir / name
    f.write_text("#!/usr/bin/env bash\n" + body + "\n")
    f.chmod(0o755)


# ── 1. static runner contract ─────────────────────────────────────────────────────────────────────────────────────────────


def test_l6c_runner_files_exist_and_are_syntactically_valid() -> None:
    assert LIB.is_file() and RUNNER.is_file()
    assert stat.S_IMODE(RUNNER.stat().st_mode) & 0o111
    for f in (LIB, RUNNER):
        assert subprocess.run(["bash", "-n", str(f)]).returncode == 0, f


def test_l6c_runner_template_is_unpinned_and_refuses_to_run(tmp_path: Path) -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text and "RELEASE_ID=PIN_RELEASE_ID" in text and "EXPECTED_SOURCE_SHA=PIN_SOURCE_SHA" in text
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "not pinned" in res.stdout


@pytest.mark.parametrize("main,rel,sha", [
    ("not-a-sha", "rel-1", "a" * 40), ("a" * 40, "PIN_RELEASE_ID", "a" * 40),
    ("a" * 40, "rel-1", "PIN_SOURCE_SHA"), ("a" * 40, "rel-1", "not-a-sha"), ("a" * 40, "../evil", "a" * 40),
])
def test_l6c_runner_refuses_a_malformed_or_missing_pin(tmp_path: Path, main: str, rel: str, sha: str) -> None:
    pinned = tmp_path / "run.sh"
    text = RUNNER.read_text().replace("PIN_MAIN_SHA", main)
    text = text.replace("RELEASE_ID=PIN_RELEASE_ID", f'RELEASE_ID="{rel}"')
    text = text.replace("EXPECTED_SOURCE_SHA=PIN_SOURCE_SHA", f'EXPECTED_SOURCE_SHA="{sha}"')
    pinned.write_text(text)
    res = subprocess.run(["bash", str(pinned), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "STOP" in res.stdout


def test_l6c_runner_never_runs_as_root_and_requires_sudo_before_mutation() -> None:
    text = RUNNER.read_text()
    assert 'id -u)" != 0' in text
    assert text.index("sudo -v") < text.index("capture PRE") < text.index("l6c_consume_attempt")


def test_l6c_runner_all_gates_precede_the_one_attempt_marker() -> None:
    text = RUNNER.read_text()
    consume = text.index("l6c_consume_attempt")
    for gate in ("l6c_receipt_gate", "l7_broker_runtime_gate", "l6c_release_source_gate", "l6c_target_absent_gate",
                 "l7_disk_gate", "l7_idea2_s10_gate", "p4-stage-gate.sh"):
        assert gate in text, gate
        assert text.index(gate) < consume, gate
    assert text.index('[ "$GATE_FAILED" = 0 ] || die') < consume
    assert text.index("capture PRE") < consume, "PRE capture must complete before the authorization is consumed (issue 1, 2026-09-27)"


def test_l6c_runner_never_invokes_l7_or_creates_l7_authorization_or_credentials() -> None:
    text = "\n".join(l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#"))
    for bad in ("stages/L7", "A-L7", "authorization-L7", "k3-L7", "d6_notice", "k_c2d", "k_d2c", "mqtt-core.pass",
                "admin.pin", "restore.credential", "core.env", "esptool", "platformio", "CUT_UPLINK", "RESTORE_UPLINK",
                "systemctl enable", "systemctl start", "systemctl stop", "systemctl disable", "systemctl restart",
                "twingate stop", "twingate start", "nmcli", "IDEA1-"):
        assert bad not in text, bad


def test_l6c_runner_success_is_persistent_never_rolls_back_and_l7_not_started() -> None:
    text = RUNNER.read_text()
    tail = text[text.index("trap - ERR INT TERM\necho \"L6C_LIVE_EXECUTED"):]
    assert "rollback" not in tail.lower().replace("rollback_flow", "")
    assert "PERSISTENT" in tail and "L7_STARTED=NO" in tail and "A_L7_CREATED=NO" in tail


def test_l6c_runner_rollback_flow_is_bounded_and_never_retries() -> None:
    text = RUNNER.read_text()
    assert 'compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" &&' in text
    assert 'compare-pre-rb.txt" allow' not in text and 'compare-pre-post.txt" allow' in text
    assert "NOT retrying" in text and "S-11 HOLD" in text
    assert not re.search(r"\b(while|until)\b", "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
    assert text.count("l6c_consume_attempt") == 1


# ── 2. one attempt per authorization ─────────────────────────────────────────────────────────────────────────────────────


def test_l6c_one_attempt_marker_is_atomic_and_final(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    assert lib(f"l6c_consume_attempt '{auth}'").returncode == 0 and (auth / "L6C-ATTEMPT-CONSUMED").is_file()
    second = lib(f"l6c_consume_attempt '{auth}'")
    assert second.returncode == 1 and "L6C_ATTEMPT_ALREADY_CONSUMED" in second.stderr


def test_l6c_marker_is_distinct_from_l6b_and_l7_markers(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "L6B-ATTEMPT-CONSUMED").write_text("x")
    (auth / "L7-ATTEMPT-CONSUMED").write_text("x")
    assert lib(f"l6c_consume_attempt '{auth}'").returncode == 0


# ── 3. receipt gate: requires L6b PROVEN, never cares about L7 ──────────────────────────────────────────────────────────

L6A_RECEIPT = "2026-09-27_002532_music_idea3-pr11-l6a-live-acceptance.md"
L6A_TEXT = "# r\n\n```text\nL6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n```\n"
L6B_TEXT = "# r\n\n> `L6B_LIVE_ACCEPTANCE = PROVEN`\n"


def make_l6c_repo(tmp_path: Path, *, skip: str = "", l6b: str | None = L6B_TEXT, l7: str | None = None) -> Path:
    repo = tmp_path / "repo"
    logs = repo / LOGS
    logs.mkdir(parents=True)
    git(repo, "init", "-q")
    for n in (2, 3, 4, 5):
        if f"L{n}" != skip:
            (logs / f"2026-09-2{n}_000000_music_idea3-pr11-l{n}-live-acceptance.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
    (logs / L6A_RECEIPT).write_text(L6A_TEXT)
    if l6b is not None:
        (logs / "2026-09-27_120422_music_idea3-pr11-l6b-attempt2-live-acceptance.md").write_text(l6b)
    if l7 is not None:
        (logs / "2026-09-28_000000_music_idea3-pr11-l7-live.md").write_text(l7)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "fixture")
    return repo


def test_l6c_receipt_gate_passes_with_l2_to_l6b_accepted(tmp_path: Path) -> None:
    res = lib(f"l6c_receipt_gate '{make_l6c_repo(tmp_path)}'")
    assert res.returncode == 0, res.stderr


def test_l6c_receipt_gate_requires_l6b_acceptance(tmp_path: Path) -> None:
    res = lib(f"l6c_receipt_gate '{make_l6c_repo(tmp_path, l6b=None)}'")
    assert res.returncode == 1 and "L6C_L6B_ACCEPTANCE_RECEIPT_MISSING" in res.stderr


def test_l6c_receipt_gate_does_not_care_whether_l7_is_accepted_or_not(tmp_path: Path) -> None:
    """Unlike l7_receipt_gate (which refuses if L7 is already accepted), L6c's own gate is silent on L7 entirely."""
    res_no_l7 = lib(f"l6c_receipt_gate '{make_l6c_repo(tmp_path / 'a')}'")
    res_l7_accepted = lib(f"l6c_receipt_gate '{make_l6c_repo(tmp_path / 'b', l7='`L7_LIVE_ACCEPTANCE = PROVEN`')}'")
    assert res_no_l7.returncode == 0 and res_l7_accepted.returncode == 0


# ── 4. release-source gate ───────────────────────────────────────────────────────────────────────────────────────────────


def test_l6c_release_source_gate_accepts_a_valid_source_on_the_pinned_main(tmp_path: Path) -> None:
    repo = make_l6c_repo(tmp_path)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    source = build_release(tmp_path / "staging", release_id="rel-1", sha=head)
    res = lib(f"l6c_release_source_gate '{source}' rel-1 '{head}' '{sys.executable}' '{DEPLOY}' '{repo}'")
    assert res.returncode == 0, res.stderr
    assert f"L6C_SOURCE_SHA={head}" in res.stdout


def test_l6c_release_source_gate_rejects_a_source_not_built_from_the_pinned_main(tmp_path: Path) -> None:
    repo = make_l6c_repo(tmp_path)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    source = build_release(tmp_path / "staging", release_id="rel-1", sha="b" * 40)
    res = lib(f"l6c_release_source_gate '{source}' rel-1 '{head}' '{sys.executable}' '{DEPLOY}' '{repo}'")
    assert res.returncode == 1 and "L6C_SOURCE_SHA_NOT_ON_MAIN" in res.stderr


def test_l6c_release_source_gate_rejects_a_tampered_source(tmp_path: Path) -> None:
    repo = make_l6c_repo(tmp_path)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    source = build_release(tmp_path / "staging", release_id="rel-1", sha=head)
    (source / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    res = lib(f"l6c_release_source_gate '{source}' rel-1 '{head}' '{sys.executable}' '{DEPLOY}' '{repo}'")
    assert res.returncode == 1 and "L6C_SOURCE_GUARD_FAILED:CHECKSUM_MISMATCH" in res.stderr


def test_l6c_release_source_gate_is_read_only(tmp_path: Path) -> None:
    repo = make_l6c_repo(tmp_path)
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    source = build_release(tmp_path / "staging", release_id="rel-1", sha=head)
    before = {p.relative_to(source).as_posix(): p.stat().st_mtime_ns for p in source.rglob("*")}
    lib(f"l6c_release_source_gate '{source}' rel-1 '{head}' '{sys.executable}' '{DEPLOY}' '{repo}'")
    after = {p.relative_to(source).as_posix(): p.stat().st_mtime_ns for p in source.rglob("*")}
    assert before == after


# ── 5. target-absent gate ────────────────────────────────────────────────────────────────────────────────────────────────


def test_l6c_target_absent_gate_accepts_an_absent_target(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    root.mkdir()
    assert lib(f"l6c_target_absent_gate rel-1 '{root}'").returncode == 0


def test_l6c_target_absent_gate_rejects_an_existing_target(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases/rel-1").mkdir(parents=True)
    res = lib(f"l6c_target_absent_gate rel-1 '{root}'")
    assert res.returncode == 1 and "L6C_TARGET_ALREADY_EXISTS" in res.stderr


# ── 6. secret scan ───────────────────────────────────────────────────────────────────────────────────────────────────────


def test_l6c_secret_scan_detects_a_leaked_private_key(tmp_path: Path) -> None:
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "x.txt").write_text("-----BEGIN EC PRIVATE KEY-----\nMHc\n-----END EC PRIVATE KEY-----\n")
    res = lib(f"l6c_secret_scan '{evid}' '{sys.executable}'")
    assert res.returncode == 1


def test_l6c_secret_scan_clean_evidence_passes(tmp_path: Path) -> None:
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "x.txt").write_text("L6C_APPLY=PASS release_id=rel-1\n")
    res = lib(f"l6c_secret_scan '{evid}' '{sys.executable}'")
    assert res.returncode == 0


# ── 7. G-15 authorization separation (real p4-stage-gate.sh) ────────────────────────────────────────────────────────────


def stage_gate_record(stage: str, *, extra: str = "") -> tuple[str, str]:
    records = f"stage={stage}\ndate={TODAY}\nauthorizer=music\nscope=sim\nreference=sim/ref\n"
    auth = f"AEGIS_P4_AUTHORIZATION_V1\n{records}{extra}"
    k3 = f"AEGIS_P4_K3_CONFIRMATION_V2\nstage={stage}\ndate={TODAY}\nreference=sim/ref\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\n"
    return auth, k3


def run_stage_gate(tmp_path: Path, stage: str, auth_text: str, k3_text: str) -> subprocess.CompletedProcess[str]:
    auth = tmp_path / "a.txt"
    auth.write_text(auth_text)
    k3 = tmp_path / "k.txt"
    k3.write_text(k3_text)
    return subprocess.run(["bash", str(STAGE_GATE), "--stage", stage, "--mode", "live", "--authorization", str(auth), "--k3", str(k3)],
                          text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"))


def test_l6c_is_registered_as_a_mutating_stage_requiring_k3_and_no_extra_field() -> None:
    res = subprocess.run(["bash", "-c", f". '{DEPLOY / 'p4-lib.sh'}' && p4_stage_known L6c && p4_stage_mutates L6c && p4_stage_auth_extra L6c; p4_stage_gaps L6c"],
                         text=True, capture_output=True)
    assert res.returncode == 0
    assert res.stdout.strip() == "none"  # p4_stage_auth_extra prints nothing (empty line consumed) then p4_stage_gaps prints "none"


def test_l6c_stage_order_is_between_l6b_and_l7() -> None:
    text = (DEPLOY / "p4-lib.sh").read_text()
    stages_line = next(l for l in text.splitlines() if l.strip().startswith('readonly P4_STAGES='))
    stages = stages_line.split('"')[1].split()
    assert stages.index("L6b") < stages.index("L6c") < stages.index("L7")


def test_l6c_authorization_and_k3_with_real_l6c_records_pass() -> None:
    auth, k3 = stage_gate_record("L6c")
    res = run_stage_gate(Path("/tmp"), "L6c", auth, k3)
    assert res.returncode == 0, res.stdout
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout.splitlines() and "K3_CONFIRMATION=VALID" in res.stdout.splitlines()


def test_l6c_rejects_a_malformed_or_stale_authorization(tmp_path: Path) -> None:
    auth, k3 = stage_gate_record("L6c")
    bad = auth.replace(f"date={TODAY}", "date=2000-01-01")
    res = run_stage_gate(tmp_path, "L6c", bad, k3)
    assert res.returncode == 1 and "AUTHORIZATION_STALE" in res.stdout


def test_a_l7_authorization_cannot_authorize_l6c(tmp_path: Path) -> None:
    """An A-L7 record names stage=L7; the stage-mismatch check refuses it outright for an L6c run."""
    auth_l7, _ = stage_gate_record("L7", extra="d6_notice=pub\n")
    _, k3_l6c = stage_gate_record("L6c")
    res = run_stage_gate(tmp_path, "L6c", auth_l7, k3_l6c)
    assert res.returncode == 1 and "AUTHORIZATION_STAGE_MISMATCH" in res.stdout


@pytest.mark.parametrize("k3_stage", ["L6b", "L7"])
def test_l6b_or_l7_k3_cannot_authorize_l6c(tmp_path: Path, k3_stage: str) -> None:
    auth_l6c, _ = stage_gate_record("L6c")
    _, k3_other = stage_gate_record(k3_stage)
    res = run_stage_gate(tmp_path, "L6c", auth_l6c, k3_other)
    assert res.returncode == 1 and "K3_STAGE_MISMATCH" in res.stdout


def test_l6c_requires_no_d6_field() -> None:
    auth, k3 = stage_gate_record("L6c")
    assert "d6_notice" not in auth
    res = run_stage_gate(Path("/tmp"), "L6c", auth, k3)
    assert res.returncode == 0, res.stdout
