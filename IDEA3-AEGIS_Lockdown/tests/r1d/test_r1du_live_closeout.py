"""R1Du LIVE closeout check: exactly ONE canonical closeout receipt exists, the merged R1D predecessor gate accepts it for the live release, and the closeout introduced no R1D / R1B / Recovery success claim.
Read-only: it inspects the committed receipts through Git (the gate reads the pinned commit); nothing touches a host."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_r1d_stage as base  # noqa: E402

REPO = base.ROOT.parent
LIB = base.LIB
LOGS = base.LOGS
RELEASE = "ebffab6f8a6d7d98973fac7e89167352d529a87e"


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], text=True, capture_output=True, check=True).stdout.strip()


pytestmark = pytest.mark.skipif(not (REPO / ".git").exists(), reason="needs a Git checkout (the gate reads the pinned commit)")


def closeouts() -> list[str]:
    return git("ls-tree", "-r", "--name-only", "HEAD", "--", LOGS).splitlines()


def test_exactly_one_r1du_closeout_receipt_exists() -> None:
    found = [p for p in closeouts() if p.endswith("_music_idea3-r1du-live-closeout.md")]
    assert len(found) == 1, found
    text = (REPO / found[0]).read_text()
    for line in ("R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO", f"R1DU_RELEASE_ID={RELEASE}",
                 "R1DU_R1D_EXECUTED=NO", "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO",
                 "R1D_ATTEMPT_CONSUMED=NO", "R1B_ATTEMPT_CONSUMED=NO", "HISTORICAL_INCIDENT_STATE=OPEN", "PREEXISTING_OPEN_INCIDENT_COUNT=1"):
        assert f"- `{line}`" in text, line


def test_the_r1d_receipt_gate_now_refuses_because_r1d_has_run_once_and_failed_immutably() -> None:
    """Historical: this gate accepted the R1Du closeout BEFORE R1D ran. R1D has since executed once (immutable FAIL, committed disposition), so the one-shot R1D pre-gate must refuse forever."""
    head = git("rev-parse", "HEAD")
    result = base.bash(f'. "{LIB}"; r1d_receipt_gate "{REPO}" {RELEASE} {head}')
    assert result.returncode == 1 and "R1D_CONTRADICTORY_OR_ALREADY_RECORDED" in result.stderr, result.stderr


@pytest.mark.parametrize("claim", ["R1D_LIVE=CLOSED_PASS", "R1D_LIVE_EXECUTED=YES", "R1D_ATTEMPT_CONSUMED=YES", "R1B_LIVE_EXECUTED=YES", "R1B_LIVE=CLOSED_PASS", "R1B_ATTEMPT_CONSUMED=YES",
                                   "RECOVERY_R2_R8_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES"])
def test_no_r1d_r1b_or_recovery_success_claim_is_recorded_by_the_closeout(claim: str) -> None:
    field, value = claim.split("=")
    found = base.bash(f'. "{LIB}"; r1d_field_files "{REPO}" "$(git -C "{REPO}" rev-parse HEAD)" {field} {value}').stdout.split()
    # the ONLY receipt allowed to record that R1D executed and consumed its attempt is the unique immutable R1D FAILURE closeout (R1D_RESULT=FAIL_IMMUTABLE; never a PASS)
    found = [f for f in found if not (claim in ("R1D_LIVE_EXECUTED=YES", "R1D_ATTEMPT_CONSUMED=YES") and f.endswith("_music_idea3-r1d-live-failure-closeout.md"))]
    assert found == [], f"a receipt carries {claim}: {found}"
