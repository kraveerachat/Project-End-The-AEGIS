"""R1D predecessor/history gates: R1A is an immutable consumed FAIL, R1Du (the Core upgrade carrying the R1D authority) is closed, R1B has NOT begun. Hermetic: throw-away Git repositories and a temporary
canonical-directory seam only; no host path, no network."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_r1d_stage as base  # noqa: E402  (shared hermetic helpers)

ROOT, P4, LIB, LOGS, RELEASE = base.ROOT, base.P4, base.LIB, base.LOGS, base.RELEASE
R1DU = base.R1DU_RECEIPT
R1DU_LINES = ("R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO", f"R1DU_RELEASE_ID={RELEASE}",
              "R1DU_R1D_EXECUTED=NO", "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")
R1A_LINES = ("R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN",
             "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")


def text_of(lines, drop=None) -> str:
    return "\n".join(f"- `{x}`" for x in lines if x != drop) + "\n"


def gate(repo: Path, release: str = RELEASE) -> subprocess.CompletedProcess[str]:
    return base.bash(f'. "{LIB}"; r1d_receipt_gate "{repo}" {release} {base.head_of(repo)}')


def test_the_complete_canonical_predecessor_state_passes(tmp_path: Path) -> None:
    result = gate(base.receipt_repo(tmp_path))
    assert result.returncode == 0, result.stderr


def test_the_real_committed_r1a_and_r1du_predecessor_receipts_satisfy_the_field_contract() -> None:
    real = (ROOT.parent / base.R1A_FAIL_RECEIPT).read_text()
    have = {ln.strip().strip("`-* ").strip("`") for ln in real.splitlines()}
    for want in R1A_LINES:
        assert want in have, want


@pytest.mark.parametrize("drop", R1DU_LINES)
def test_each_required_r1du_closeout_field_is_load_bearing(tmp_path: Path, drop: str) -> None:
    result = gate(base.receipt_repo(tmp_path, **{R1DU: text_of(R1DU_LINES, drop)}))
    assert result.returncode == 1 and "R1D_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_the_r1du_closeout_must_name_the_pinned_release(tmp_path: Path) -> None:
    result = gate(base.receipt_repo(tmp_path), release="a" * 40)
    assert result.returncode == 1 and "R1D_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_duplicate_or_misnamed_r1du_closeout_is_ambiguous(tmp_path: Path) -> None:
    dup = f"{LOGS}/2026-10-06_130000_music_idea3-r1du-live-closeout.md"
    assert gate(base.receipt_repo(tmp_path, **{dup: text_of(R1DU_LINES)})).returncode == 1
    moved = f"{LOGS}/2026-10-06_120000_music_idea3-something-else.md"
    (tmp_path / "m").mkdir()
    assert gate(base.receipt_repo(tmp_path / "m", **{R1DU: None, moved: text_of(R1DU_LINES)})).returncode == 1  # the closeout must be the R1Du closeout by name


@pytest.mark.parametrize("drop", R1A_LINES)
def test_each_required_r1a_failure_field_is_load_bearing(tmp_path: Path, drop: str) -> None:
    result = gate(base.receipt_repo(tmp_path, **{base.R1A_FAIL_RECEIPT: text_of(R1A_LINES, drop)}))
    assert result.returncode == 1 and "R1D_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_missing_or_duplicate_r1a_failure_receipt_fails_closed(tmp_path: Path) -> None:
    assert gate(base.receipt_repo(tmp_path, **{base.R1A_FAIL_RECEIPT: None})).returncode == 1
    dup = f"{LOGS}/2026-10-06_000000_music_idea3-r1a-failure-duplicate.md"
    (tmp_path / "d").mkdir()
    assert gate(base.receipt_repo(tmp_path / "d", **{dup: text_of(R1A_LINES)})).returncode == 1


@pytest.mark.parametrize("claim", ["R1A_LIVE=CLOSED_PASS", "R1D_LIVE_EXECUTED=YES", "R1D_LIVE=CLOSED_PASS", "R1D_LIVE=FAIL", "R1D_ATTEMPT_CONSUMED=YES", "R1B_LIVE_EXECUTED=YES",
                                   "R1B_LIVE=CLOSED_PASS", "R1B_ATTEMPT_CONSUMED=YES", "RECOVERY_R2_R8_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=YES", "RECOVERY_R1_R8_PROVEN=YES"])
def test_an_r1a_rewrite_an_existing_r1d_or_r1b_or_recovery_or_promoted_claim_blocks_r1d(tmp_path: Path, claim: str) -> None:
    extra = f"{LOGS}/2026-10-06_000002_music_idea3-contradiction.md"
    result = gate(base.receipt_repo(tmp_path, **{extra: f"- `{claim}`\n"}))
    assert result.returncode == 1 and ("R1D_CONTRADICTORY_OR_ALREADY_RECORDED" in result.stderr or "R1D_R1A_HISTORY_CONTRADICTS_IMMUTABLE_FAIL" in result.stderr), result.stderr


def test_the_receipts_are_read_from_the_pinned_commit_not_the_work_tree(tmp_path: Path) -> None:
    repo = base.receipt_repo(tmp_path)
    (repo / base.R1A_FAIL_RECEIPT).write_text(text_of(R1A_LINES, "R1A_RESULT=FAIL") + "- `R1A_RESULT=PASS`\n")  # uncommitted tampering
    assert gate(repo).returncode == 0


# ---- the canonical governance history ----
def history(tmp_path: Path, *, r1a=("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW"), r1b=()) -> subprocess.CompletedProcess[str]:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700, exist_ok=True)
    for name in (*r1a, *r1b):
        (canon / name).write_text("x\n")
    return base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1d_history_gate')


def test_the_history_gate_passes_with_the_consumed_r1a_records_and_no_r1b_records(tmp_path: Path) -> None:
    assert history(tmp_path).returncode == 0


@pytest.mark.parametrize("missing", ["R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW"])
def test_a_missing_r1a_record_fails(tmp_path: Path, missing: str) -> None:
    present = tuple(n for n in ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW") if n != missing)
    result = history(tmp_path, r1a=present)
    assert result.returncode == 1 and f"R1D_R1A_RECORD_MISSING:{missing}" in result.stderr


@pytest.mark.parametrize("name", ["R1B-GLOBAL-ATTEMPT-CONSUMED", "R1B-ATTEMPT-WINDOW"])
def test_an_existing_r1b_record_means_r1d_is_too_late(tmp_path: Path, name: str) -> None:
    result = history(tmp_path, r1b=(name,))
    assert result.returncode == 1 and "R1D_R1B_ALREADY_BEGUN" in result.stderr


def test_a_missing_canonical_directory_or_a_symlinked_record_fails(tmp_path: Path) -> None:
    missing = base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1d_history_gate')
    assert missing.returncode == 1 and "R1D_CANONICAL_DIR_MISSING" in missing.stderr
    canon = tmp_path / "c2" / "canon"
    canon.parent.mkdir()
    canon.mkdir(mode=0o700)
    (canon / "real").write_text("x\n")
    (canon / "R1A-GLOBAL-ATTEMPT-CONSUMED").symlink_to(canon / "real")
    (canon / "R1A-ATTEMPT-WINDOW").write_text("x\n")
    result = base.bash(f'{base.seam(tmp_path / "c2")}. "{LIB}"; SUDO=""; r1d_history_gate')
    assert result.returncode == 1 and "R1D_R1A_RECORD_MISSING" in result.stderr


def test_r1d_never_consumes_or_touches_the_r1a_or_r1b_markers(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    for name in ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW"):
        (canon / name).write_text("immutable\n")
    before = {p.name: p.read_bytes() for p in canon.iterdir()}
    auth = tmp_path / "auth"
    auth.mkdir()
    run = base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; sync() {{ :; }}; chattr() {{ :; }}; r1d_consume_attempt "{auth}" && echo CONSUMED')
    assert "CONSUMED" in run.stdout, run.stderr
    assert (canon / "R1D-GLOBAL-ATTEMPT-CONSUMED").is_file() and not (canon / "R1B-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert {n: b for n, b in ((p.name, p.read_bytes()) for p in canon.iterdir()) if n.startswith("R1A")} == before
