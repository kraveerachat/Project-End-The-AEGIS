"""RRu LIVE closeout contract checks."""

from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[3]
LOGS = REPO / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
P4 = REPO / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
LIB = P4 / "p4-r1bv-run-lib.sh"

RELEASE = "954ce1c191885e9e90198a6f54a3d990bcf144fc"

REQUIRED = {
    "RRU_LIVE=CLOSED_PASS",
    "RRU_LIVE_EXECUTED=YES",
    "RRU_RESULT=PASS",
    "RRU_PRODUCTION_DEPLOYED=YES",
    "RRU_ATTEMPT_CONSUMED=YES",
    "RRU_RERUN_ALLOWED=NO",
    "RECOVERY_RUNTIME_RELEASE_READY=YES",
    f"RRU_RELEASE_ID={RELEASE}",
    "RECOVERY_ATTEMPT_CONSUMED=NO",
    "RECOVERY_LIVE_EXECUTED=NO",
    "RECOVERY_R2_R8_EXECUTED=NO",
    "R1B_RESULT=FAIL_IMMUTABLE",
    "R1BV_RESULT=PASS",
}


def lines(text: str) -> set[str]:
    return {
        x.strip().strip("- ").strip("`")
        for x in text.splitlines()
    }


def test_exactly_one_canonical_rru_live_closeout() -> None:
    found = sorted(LOGS.glob("*_music_idea3-rru-live-closeout.md"))
    assert len(found) == 1, [p.name for p in found]
    assert REQUIRED <= lines(found[0].read_text())


def test_rru_closeout_does_not_promote_recovery_or_rewrite_history() -> None:
    text = next(LOGS.glob("*_music_idea3-rru-live-closeout.md")).read_text()
    got = lines(text)
    forbidden = {
        "RECOVERY_ATTEMPT_CONSUMED=YES",
        "RECOVERY_LIVE_EXECUTED=YES",
        "RECOVERY_R2_R8_EXECUTED=YES",
        "RECOVERY_RESULT=PASS",
        "R1B_RESULT=PASS",
        "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN",
        "R1_VERIFIED=VERIFIED",
        "LVR_PROVEN=YES",
        "L8_ACCEPTANCE=YES",
        "L9_PROVEN=YES",
    }
    assert not (got & forbidden)


def test_recovery_successor_gate_accepts_committed_rru_closeout() -> None:
    head = subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    cmd = (
        f'. "{LIB}"; '
        f'rru_recovery_successor_gate "{REPO}" "{head}" "{RELEASE}"'
    )

    result = subprocess.run(
        ["bash", "-lc", cmd],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_current_docs_record_rru_pass_and_recovery_not_run() -> None:
    status = (
        REPO
        / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md"
    ).read_text()

    moc = (
        REPO
        / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md"
    ).read_text()

    readme = (P4 / "README.md").read_text()

    for text in (status, moc, readme):
        assert "RRU_RESULT=PASS" in text
        assert "RECOVERY_RUNTIME_RELEASE_READY=YES" in text
        assert "RECOVERY_R2_R8_EXECUTED=NO" in text

    assert "## 25. Stage RRu — LIVE outcome: PASS" in readme
