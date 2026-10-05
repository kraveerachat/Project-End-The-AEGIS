"""R1B predecessor-history gate: R1A is an immutable consumed FAIL; R1B is a NEW successor stage (never a retry). Hermetic: throw-away Git repositories only, no host path, no network."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "r1a"))
import test_r1a_stage as base  # noqa: E402  (shared hermetic helpers)

ROOT = base.ROOT
P4 = base.P4
LIB = P4 / "p4-r1b-run-lib.sh"
LOGS = base.LOGS
R1A_FAIL = f"{LOGS}/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
R1A_FAIL_LINES = ("R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED",
                  "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")


def fail_text(drop: str | None = None) -> str:
    return "\n".join(f"- `{x}`" for x in R1A_FAIL_LINES if x != drop) + "\n"


def repo_with(tmp_path: Path, **change: str | None) -> Path:
    return base.receipt_repo(tmp_path, **{R1A_FAIL: fail_text(), **change})


def gate(repo: Path, release: str = base.RELEASE) -> subprocess.CompletedProcess[str]:
    return base.bash(f'. "{LIB}"; r1b_receipt_gate "{repo}" {release} {base.head_of(repo)}')


def test_the_r1b_library_defines_every_helper_it_calls() -> None:
    """The predecessor gate must be able to complete: every `_r1?_only_receipt` call resolves to a function defined by the sourced libraries."""
    result = base.bash(f'. "{LIB}"; for f in $(grep -o "_r1[ab]_only_receipt" "{LIB}" | sort -u); do type -t "$f" >/dev/null || echo "UNDEFINED:$f"; done')
    assert "UNDEFINED" not in result.stdout, result.stdout


def test_a_valid_canonical_r1a_failure_closeout_lets_the_predecessor_gate_pass(tmp_path: Path) -> None:
    result = gate(repo_with(tmp_path))
    assert result.returncode == 0, result.stderr


def test_the_real_committed_r1a_failure_receipt_carries_every_required_whole_line_field() -> None:
    text = (ROOT.parent / R1A_FAIL).read_text()
    lines = {ln.strip().strip("`-* ").strip("`") for ln in text.splitlines()}
    for want in R1A_FAIL_LINES:
        assert want in lines, want


def test_a_missing_r1a_failure_receipt_fails_closed(tmp_path: Path) -> None:
    result = gate(repo_with(tmp_path, **{R1A_FAIL: None}))
    assert result.returncode == 1 and "R1B_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


@pytest.mark.parametrize("drop", R1A_FAIL_LINES)
def test_each_required_failure_field_is_load_bearing(tmp_path: Path, drop: str) -> None:
    result = gate(repo_with(tmp_path, **{R1A_FAIL: fail_text(drop)}))
    assert result.returncode == 1 and "R1B_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_duplicate_r1a_failure_receipt_is_ambiguous(tmp_path: Path) -> None:
    dup = f"{LOGS}/2026-10-06_000000_music_idea3-r1a-failure-duplicate.md"
    result = gate(repo_with(tmp_path, **{dup: fail_text()}))
    assert result.returncode == 1 and "R1B_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_an_r1a_pass_or_closed_pass_contradiction_fails_closed(tmp_path: Path) -> None:
    extra = f"{LOGS}/2026-10-06_000001_music_idea3-r1a-rewrite.md"
    result = gate(repo_with(tmp_path, **{extra: "- `R1A_LIVE=CLOSED_PASS`\n"}))
    assert result.returncode == 1 and "R1B_R1A_HISTORY_CONTRADICTS_IMMUTABLE_FAIL" in result.stderr


@pytest.mark.parametrize("claim", ["R1B_LIVE_EXECUTED=YES", "R1B_LIVE=CLOSED_PASS", "R1B_LIVE=FAIL", "R1B_ATTEMPT_CONSUMED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=YES",
                                   "RECOVERY_R1_R8_PROVEN=YES", "R1I_LIVE=FAIL", "R1I_RERUN_ALLOWED=YES"])
def test_an_existing_r1b_or_promoted_claim_blocks_a_fresh_r1b(tmp_path: Path, claim: str) -> None:
    extra = f"{LOGS}/2026-10-06_000002_music_idea3-contradiction.md"
    result = gate(repo_with(tmp_path, **{extra: f"- `{claim}`\n"}))
    assert result.returncode == 1 and "R1B_CONTRADICTORY_OR_ALREADY_RECORDED" in result.stderr


def test_the_r1a_failure_receipt_is_read_from_the_pinned_commit_not_the_work_tree(tmp_path: Path) -> None:
    repo = repo_with(tmp_path)
    (repo / R1A_FAIL).write_text(fail_text("R1A_RESULT=FAIL") + "- `R1A_RESULT=PASS`\n")  # uncommitted tampering
    assert gate(repo).returncode == 0
    base.git(repo, "add", "-A")
    base.git(repo, "commit", "-q", "-m", "tamper")
    assert gate(repo).returncode == 1  # HEAD moved off the pinned commit... and the gate pins MAIN explicitly
