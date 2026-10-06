"""R1B predecessor-history gate: R1A is an immutable consumed FAIL; R1B is a NEW successor stage (never a retry). Hermetic: throw-away Git repositories only, no host path, no network."""

from __future__ import annotations

import re
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


R1D_CLOSEOUT = f"{LOGS}/2026-10-06_140000_music_idea3-r1d-live-closeout.md"
R1D_CLOSEOUT_LINES = ("R1D_LIVE=CLOSED_PASS", "R1D_LIVE_EXECUTED=YES", "R1D_ATTEMPT_CONSUMED=YES", "R1D_RERUN_ALLOWED=NO", "R1D_RESULT=PASS", "PREEXISTING_OPEN_INCIDENT_COUNT=0",
                      "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES", "R1B_ATTEMPT_CONSUMED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")


def r1d_text(drop: str | None = None, extra: tuple[str, ...] = ()) -> str:
    return "\n".join(f"- `{x}`" for x in (*[l for l in R1D_CLOSEOUT_LINES if l != drop], *extra)) + "\n"


def repo_with(tmp_path: Path, **change: str | None) -> Path:
    return base.receipt_repo(tmp_path, **{R1A_FAIL: fail_text(), R1D_CLOSEOUT: r1d_text(), **change})


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


# ---- R1B predecessor amendment: recognise the R1Du closeout and the new current release ONLY ----
NEW_RELEASE = "9" * 40
R1DU_RECEIPT = f"{LOGS}/2026-10-06_120000_music_idea3-r1du-live-closeout.md"
R1DU_LINES = ("R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO", f"R1DU_RELEASE_ID={NEW_RELEASE}",
              "R1DU_R1D_EXECUTED=NO", "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")


def r1du_text(drop: str | None = None) -> str:
    return "\n".join(f"- `{x}`" for x in R1DU_LINES if x != drop) + "\n"


def test_the_f1u_closeout_path_for_the_pinned_release_is_unchanged(tmp_path: Path) -> None:
    assert gate(repo_with(tmp_path)).returncode == 0  # the F1u closeout names the pinned release: the original contract still passes


def test_a_new_release_is_recognised_only_through_the_unique_complete_r1du_closeout(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    assert gate(repo_with(tmp_path / "a", **{R1DU_RECEIPT: r1du_text()}), NEW_RELEASE).returncode == 0
    (tmp_path / "b").mkdir()
    no_closeout = gate(repo_with(tmp_path / "b"), NEW_RELEASE)
    assert no_closeout.returncode == 1 and "R1B_F1U_CLOSEOUT_DOES_NOT_CARRY_THE_PINNED_RELEASE" in no_closeout.stderr  # neither closeout names the new release


@pytest.mark.parametrize("drop", R1DU_LINES)
def test_each_r1du_closeout_field_is_load_bearing_for_r1b(tmp_path: Path, drop: str) -> None:
    result = gate(repo_with(tmp_path, **{R1DU_RECEIPT: r1du_text(drop)}), NEW_RELEASE)
    assert result.returncode == 1 and "R1B_F1U_CLOSEOUT_DOES_NOT_CARRY_THE_PINNED_RELEASE" in result.stderr


def test_a_duplicate_or_misnamed_r1du_closeout_does_not_satisfy_r1b(tmp_path: Path) -> None:
    dup = f"{LOGS}/2026-10-06_130000_music_idea3-r1du-live-closeout.md"
    assert gate(repo_with(tmp_path, **{R1DU_RECEIPT: r1du_text(), dup: r1du_text()}), NEW_RELEASE).returncode == 1
    (tmp_path / "m").mkdir()
    misnamed = f"{LOGS}/2026-10-06_120000_music_idea3-something.md"
    assert gate(repo_with(tmp_path / "m", **{misnamed: r1du_text()}), NEW_RELEASE).returncode == 1


def test_the_r1b_acceptance_semantics_and_baseline_are_not_weakened_by_the_amendment() -> None:
    lib = LIB.read_text()
    gate_body = lib[lib.index("r1b_receipt_gate() {"):lib.index("# ---- host gates")]
    assert "R1B_R1A_HISTORY_CONTRADICTS_IMMUTABLE_FAIL" in gate_body and "R1B_R1A_FAILURE_CLOSEOUT_MISSING_OR_AMBIGUOUS" in gate_body and "R1B_CONTRADICTORY_OR_ALREADY_RECORDED" in gate_body
    acceptance = (ROOT / "aegis_soc/r1_acceptance.py").read_text()
    assert 'raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")' in acceptance and 'groups() != (ip, "detector_alert", "CREATED")' in acceptance


# ---- IMPORTANT: R1B requires the unique R1D LIVE PASS closeout (the governed stage-order proof) ----
def test_r1b_requires_the_unique_r1d_live_pass_closeout(tmp_path: Path) -> None:
    missing = gate(repo_with(tmp_path, **{R1D_CLOSEOUT: None}))
    assert missing.returncode == 1 and "R1B_R1D_CLOSEOUT_MISSING_OR_AMBIGUOUS" in missing.stderr


@pytest.mark.parametrize("drop", R1D_CLOSEOUT_LINES)
def test_each_required_r1d_closeout_field_is_load_bearing(tmp_path: Path, drop: str) -> None:
    result = gate(repo_with(tmp_path, **{R1D_CLOSEOUT: r1d_text(drop)}))
    assert result.returncode == 1 and "R1B_R1D_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_duplicate_misnamed_or_failed_r1d_closeout_does_not_satisfy_r1b(tmp_path: Path) -> None:
    dup = f"{LOGS}/2026-10-06_150000_music_idea3-r1d-live-closeout.md"
    assert gate(repo_with(tmp_path, **{dup: r1d_text()})).returncode == 1  # two closeouts: ambiguous
    (tmp_path / "m").mkdir()
    misnamed = f"{LOGS}/2026-10-06_140000_music_idea3-something.md"
    assert gate(repo_with(tmp_path / "m", **{R1D_CLOSEOUT: None, misnamed: r1d_text()})).returncode == 1  # must be the R1D closeout by name
    (tmp_path / "f").mkdir()
    failed = gate(repo_with(tmp_path / "f", **{R1D_CLOSEOUT: r1d_text("R1D_RESULT=PASS", ("R1D_RESULT=FAIL",))}))
    assert failed.returncode == 1  # a FAIL result is never a PASS closeout
    (tmp_path / "p").mkdir()
    fail_only = f"{LOGS}/2026-10-06_150000_music_idea3-r1d-failure.md"
    result = gate(repo_with(tmp_path / "p", **{fail_only: "- `R1D_RESULT=FAIL`\n"}))
    assert result.returncode == 1 and "R1B_R1D_HISTORY_CONTRADICTORY" in result.stderr  # a bare FAIL beside a PASS closeout is contradictory, never accepted


@pytest.mark.parametrize("malformed", ["R1D_LIVE = CLOSED_PASS extra", "R1D_RESULT=PASS maybe", "prose: R1D_LIVE=CLOSED_PASS one day"])
def test_a_malformed_r1d_closeout_line_is_never_a_whole_line_match(tmp_path: Path, malformed: str) -> None:
    key = re.search(r"[A-Z0-9_]+", malformed.replace("prose:", "")).group(0)
    text = "\n".join(f"- `{x}`" for x in R1D_CLOSEOUT_LINES if x.split("=")[0] != key) + "\n" + malformed + "\n"
    assert gate(repo_with(tmp_path, **{R1D_CLOSEOUT: text})).returncode == 1


def test_the_r1d_requirement_does_not_touch_the_r1b_acceptance_baseline() -> None:
    acceptance = (ROOT / "aegis_soc/r1_acceptance.py").read_text()
    assert 'raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")' in acceptance and 'groups() != (ip, "detector_alert", "CREATED")' in acceptance


# ---------------------------------------------------------------- PATH B: immutable R1D FAIL + unique R1Dv LIVE PASS
R1D_FAIL_CLOSEOUT = f"{LOGS}/2026-10-06_073302_music_idea3-r1d-live-failure-closeout.md"
R1DV_CLOSEOUT = f"{LOGS}/2026-10-07_100000_music_idea3-r1dv-live-closeout.md"
R1DV_LINES = ("R1DV_LIVE=CLOSED_PASS", "R1DV_LIVE_EXECUTED=YES", "R1DV_RESULT=PASS", "R1DV_IS_R1D_RETRY=NO", "R1DV_READ_ONLY_VALIDATION_ONLY=YES", "R1DV_R1D_SOCKET_CONNECTED=NO",
              "R1DV_INCIDENT_MUTATED=NO", "R1DV_DISPOSITION_CREATED=NO", "R1DV_R1D_ATTEMPT_AUDIT_COUNT=1", "R1DV_R1D_DISPOSITION_AUDIT_COUNT=1", "R1DV_RECOVERY_R8_CLOSE_COUNT=0",
              "R1DV_HISTORICAL_INCIDENT_STATE=CLOSED", "PREEXISTING_OPEN_INCIDENT_COUNT=0", "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES", "R1DV_ONE_SHOT_INDEX=PASS", "R1DV_AUDIT_INTEGRITY=PASS",
              "R1DV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES", "R1DV_PRESERVATION_S10=PASS", "R1DV_COMPARE_RESULT=PASS", "R1B_ATTEMPT_CONSUMED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN",
              "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO", "RECOVERY_R2_R8_EXECUTED=NO")


def r1dv_text(drop: str | None = None, extra: tuple[str, ...] = ()) -> str:
    return "\n".join(f"- `{x}`" for x in (*[l for l in R1DV_LINES if l != drop], *extra)) + "\n"


def path_b(tmp_path: Path, **change: str | None) -> Path:
    real = (ROOT.parent / R1D_FAIL_CLOSEOUT).read_text()  # the REAL shipped failure closeout is the fixture
    return repo_with(tmp_path, **{R1D_CLOSEOUT: None, R1D_FAIL_CLOSEOUT: real, R1DV_CLOSEOUT: r1dv_text(), **change})


def test_path_a_still_passes_with_the_unique_legacy_r1d_pass_closeout(tmp_path: Path) -> None:
    assert gate(repo_with(tmp_path)).returncode == 0


def test_path_b_passes_with_the_unique_r1d_failure_closeout_and_the_unique_r1dv_pass_closeout(tmp_path: Path) -> None:
    result = gate(path_b(tmp_path))
    assert result.returncode == 0, result.stderr


def test_the_r1d_failure_closeout_alone_does_not_unblock_r1b(tmp_path: Path) -> None:
    result = gate(path_b(tmp_path, **{R1DV_CLOSEOUT: None}))
    assert result.returncode == 1 and "R1B_R1DV_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_an_r1dv_pass_without_the_exact_r1d_failure_closeout_does_not_unblock_r1b(tmp_path: Path) -> None:
    assert gate(path_b(tmp_path, **{R1D_FAIL_CLOSEOUT: None})).returncode == 1
    (tmp_path / "x").mkdir()
    assert gate(repo_with(tmp_path / "x", **{R1D_CLOSEOUT: None, R1DV_CLOSEOUT: r1dv_text()})).returncode == 1


def test_an_r1d_pass_and_an_r1d_failure_together_are_contradictory(tmp_path: Path) -> None:
    result = gate(path_b(tmp_path, **{R1D_CLOSEOUT: r1d_text()}))
    assert result.returncode == 1 and "R1B_R1D_HISTORY_CONTRADICTORY" in result.stderr


def test_path_a_refuses_any_r1dv_receipt(tmp_path: Path) -> None:
    assert gate(repo_with(tmp_path, **{R1DV_CLOSEOUT: r1dv_text()})).returncode == 1


def test_r1d_failure_plus_r1dv_failure_or_duplicate_r1dv_fails_closed(tmp_path: Path) -> None:
    failed = r1dv_text("R1DV_LIVE=CLOSED_PASS").replace("R1DV_RESULT=PASS", "R1DV_RESULT=FAIL")
    assert gate(path_b(tmp_path, **{R1DV_CLOSEOUT: failed})).returncode == 1
    (tmp_path / "d").mkdir()
    dup = f"{LOGS}/2026-10-07_110000_music_idea3-r1dv-live-closeout.md"
    assert gate(path_b(tmp_path / "d", **{dup: r1dv_text()})).returncode == 1
    (tmp_path / "e").mkdir()
    dupfail = f"{LOGS}/2026-10-06_000000_music_idea3-r1d-live-failure-closeout.md"
    assert gate(path_b(tmp_path / "e", **{dupfail: (ROOT.parent / R1D_FAIL_CLOSEOUT).read_text()})).returncode == 1


@pytest.mark.parametrize("drop", R1DV_LINES)
def test_each_r1dv_pass_closeout_field_is_load_bearing(tmp_path: Path, drop: str) -> None:
    assert gate(path_b(tmp_path, **{R1DV_CLOSEOUT: r1dv_text(drop)})).returncode == 1


@pytest.mark.parametrize("claim", ["R1DV_INCIDENT_MUTATED=YES", "R1DV_R1D_SOCKET_CONNECTED=YES", "R1DV_DISPOSITION_CREATED=YES", "R1DV_IS_R1D_RETRY=YES", "R1DV_READ_ONLY_VALIDATION_ONLY=NO"])
def test_an_r1dv_mutation_socket_disposition_or_retry_claim_fails_closed(tmp_path: Path, claim: str) -> None:
    other = f"{LOGS}/2026-10-07_120000_music_idea3-other.md"
    result = gate(path_b(tmp_path, **{other: f"- `{claim}`\n"}))
    assert result.returncode == 1 and "R1B_R1DV_FORBIDDEN_CLAIM" in result.stderr


def test_missing_s10_compare_audit_integrity_or_clock_evidence_in_the_r1dv_closeout_fails(tmp_path: Path) -> None:
    for i, key in enumerate(("R1DV_PRESERVATION_S10=PASS", "R1DV_COMPARE_RESULT=PASS", "R1DV_AUDIT_INTEGRITY=PASS", "R1DV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES")):
        (tmp_path / str(i)).mkdir()
        assert gate(path_b(tmp_path / str(i), **{R1DV_CLOSEOUT: r1dv_text(key)})).returncode == 1, key


def test_a_generic_r1d_fail_receipt_or_a_forged_failure_closeout_never_opens_path_b(tmp_path: Path) -> None:
    forged = f"{LOGS}/2026-10-06_073302_music_idea3-r1d-live-failure-closeout.md"
    thin = "- `R1D_RESULT=FAIL`\n- `R1D_FAILURE_CLOSEOUT=YES`\n"
    assert gate(path_b(tmp_path, **{forged: thin})).returncode == 1
    (tmp_path / "g").mkdir()
    generic = f"{LOGS}/2026-10-06_090000_music_idea3-r1d-anything.md"
    assert gate(path_b(tmp_path / "g", **{R1D_FAIL_CLOSEOUT: None, generic: (ROOT.parent / R1D_FAIL_CLOSEOUT).read_text()})).returncode == 1  # wrong name


def test_r1b_acceptance_semantics_are_unchanged_by_the_two_paths() -> None:
    acceptance = (ROOT / "aegis_soc/r1_acceptance.py").read_text()
    assert 'raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")' in acceptance and 'groups() != (ip, "detector_alert", "CREATED")' in acceptance
