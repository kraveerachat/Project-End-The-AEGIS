"""R1Dv LIVE closeout check: exactly ONE canonical closeout receipt exists with every whole-line field of the merged contract, the R1B predecessor gate accepts the complete Path B history at HEAD, and the closeout
claims nothing it must not (no R1D PASS rewrite, no R1B / Recovery / F1 / R1 promotion). Read-only: it inspects committed receipts through Git; nothing touches a host."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_r1dv_stage as base  # noqa: E402

REPO = base.ROOT.parent
LOGS = base.LOGS
B_LIB = base.P4 / "p4-r1b-run-lib.sh"
RELEASE = "ebffab6f8a6d7d98973fac7e89167352d529a87e"
FIELDS = ("R1DV_LIVE=CLOSED_PASS", "R1DV_LIVE_EXECUTED=YES", "R1DV_RESULT=PASS", "R1DV_IS_R1D_RETRY=NO", "R1DV_READ_ONLY_VALIDATION_ONLY=YES", "R1DV_R1D_SOCKET_CONNECTED=NO", "R1DV_INCIDENT_MUTATED=NO",
          "R1DV_DISPOSITION_CREATED=NO", "R1DV_R1D_ATTEMPT_AUDIT_COUNT=1", "R1DV_R1D_DISPOSITION_AUDIT_COUNT=1", "R1DV_RECOVERY_R8_CLOSE_COUNT=0", "R1DV_HISTORICAL_INCIDENT_STATE=CLOSED",
          "PREEXISTING_OPEN_INCIDENT_COUNT=0", "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES", "R1DV_ONE_SHOT_INDEX=PASS", "R1DV_AUDIT_INTEGRITY=PASS", "R1DV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES",
          "R1DV_PRESERVATION_S10=PASS", "R1DV_COMPARE_RESULT=PASS", "R1B_ATTEMPT_CONSUMED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO",
          "RECOVERY_R2_R8_EXECUTED=NO", "R1D_RESULT=FAIL_IMMUTABLE", "R1D_RESULT_REWRITTEN=NO", "R1B_LIVE_EXECUTED=NO")
pytestmark = pytest.mark.skipif(not (REPO / ".git").exists(), reason="needs a Git checkout (the gate reads the pinned commit)")


def closeouts() -> list[Path]:
    return sorted((REPO / LOGS).glob("*_music_idea3-r1dv-live-closeout.md"))


def test_exactly_one_r1dv_live_closeout_exists_with_every_contract_field() -> None:
    found = closeouts()
    assert len(found) == 1, found
    text = found[0].read_text()
    for line in FIELDS:
        assert f"- `{line}`" in text, line
    assert "4403ffeb43f11f7936ed2ad76c306363a49655cf2191b761442ce3012c16b8c4" in text and "2026-10-06-r1dv-20261006-095051" in text


def test_the_closeout_never_promotes_or_rewrites_anything() -> None:
    text = closeouts()[0].read_text()
    whole = {ln.strip().strip("`-* ").strip("`") for ln in text.splitlines()}
    for never in ("R1D_RESULT=PASS", "R1D_LIVE=CLOSED_PASS", "R1DV_RESULT=FAIL", "R1DV_LIVE=CLOSED_FAIL", "R1B_ATTEMPT_CONSUMED=YES", "R1B_LIVE_EXECUTED=YES", "R1B_LIVE=CLOSED_PASS", "RECOVERY_R2_R8_EXECUTED=YES",
                  "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES", "R1DV_INCIDENT_MUTATED=YES", "R1DV_R1D_SOCKET_CONNECTED=YES", "R1DV_DISPOSITION_CREATED=YES", "R1DV_IS_R1D_RETRY=YES"):
        assert never not in whole, never


def test_the_r1b_predecessor_gate_accepts_the_complete_path_b_history_at_head() -> None:
    head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    result = base.bash(f'. "{B_LIB}"; r1b_receipt_gate "{REPO}" {RELEASE} {head}')
    assert result.returncode == 0, result.stderr


def test_the_r1dv_gate_for_a_second_run_now_refuses_because_a_closeout_exists() -> None:
    head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    result = base.bash(f'. "{base.LIB}"; r1dv_receipt_gate "{REPO}" {RELEASE} {head}')
    assert result.returncode == 1 and "R1DV_CONTRADICTORY_OR_ALREADY_RECORDED" in result.stderr, result.stderr
