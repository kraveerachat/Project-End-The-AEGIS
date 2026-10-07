"""L8u predecessor gate: LVR PASS is mechanically required before L8u, from the Git objects of the pinned main; the closeout merge moves main (strict-ancestor rule); L8p is read-only history."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

import l8u_support as s

pred = s.load(s.PRED, "l8u_predecessors")


def check(repo, main, pin=None):
    return pred.check(repo, main, pin)


def reason(repo, main, pin=None) -> str:
    with pytest.raises(pred.PredecessorError) as err:
        check(repo, main, pin)
    return str(err.value)


def test_a_valid_descendant_lvr_pass_with_the_historical_l8p_closeout_is_accepted(tmp_path: Path) -> None:
    repo, execution, main = s.world(tmp_path)
    result = check(repo, main)
    assert result["LVR_PREDECESSOR"] == "PASS" and result["L8P_PREDECESSOR"] == "PASS" and result["LVR_EXECUTION_MAIN"] == execution
    assert result["LVR_CLOSEOUT_SHA256"] == hashlib.sha256((tmp_path / "repo" / s.LVR_REL).read_bytes()).hexdigest()
    assert check(repo, main, result["LVR_CLOSEOUT_SHA256"])["LVR_PREDECESSOR"] == "PASS"  # the frozen closeout digest pin


def test_a_closeout_merge_that_moves_main_again_is_still_valid_but_only_for_the_pinned_main(tmp_path: Path) -> None:
    repo, execution, main = s.world(tmp_path)
    later = s.commit(repo, {"README-later.txt": "x"}, "later unrelated main")
    assert check(repo, later)["LVR_EXECUTION_MAIN"] == execution  # descendant of the execution main, closeout present in the descendant
    assert check(repo, main)["LVR_EXECUTION_MAIN"] == execution


def test_no_lvr_closeout_refuses(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    main = s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT}, "only L8p")
    assert reason(repo, main) == "LVR_PASS_CLOSEOUT_MISSING"


@pytest.mark.parametrize("override", [{"LVR_RESULT": "FAIL"}, {"LVR_LIVE": "CLOSED_FAIL"}, {"LVR_RESULT": "FAIL_IMMUTABLE"}])
def test_a_recorded_lvr_failure_refuses(tmp_path: Path, override: dict) -> None:
    repo, _, main = s.world(tmp_path, lvr=override)
    assert reason(repo, main) == "LVR_FAILURE_RECORDED"


def test_a_failure_receipt_next_to_a_pass_receipt_refuses(tmp_path: Path) -> None:
    repo, execution, main = s.world(tmp_path, extra={f"{s.LOGS}/2026-10-21_000000_music_idea3-lvr-attempt2.md": "LVR_RESULT=FAIL\n"})
    assert reason(repo, main) == "LVR_FAILURE_RECORDED"


def test_duplicate_or_split_lvr_evidence_refuses(tmp_path: Path) -> None:
    repo, execution, main = s.world(tmp_path, extra={f"{s.LOGS}/2026-10-21_000000_music_idea3-lvr-note.md": "LVR_PROVEN=YES\n"})
    assert reason(repo, main) == "LVR_EVIDENCE_DUPLICATE_OR_SPLIT"
    repo2, _, main2 = s.world(tmp_path / "b", extra={f"{s.LOGS}/2026-10-21_000000_music_idea3-lvr-split.md": "LVR_RESULT=PASS\n"})
    assert reason(repo2, main2) == "LVR_EVIDENCE_DUPLICATE_OR_SPLIT"


def test_the_lvr_result_in_a_receipt_with_the_wrong_name_refuses(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    execution = s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT}, "exec")
    main = s.commit(repo, {f"{s.LOGS}/2026-10-20_120000_music_idea3-something-else.md": s.lvr_receipt(execution)}, "wrong name")
    assert reason(repo, main) == "LVR_RESULT_NOT_IN_THE_CANONICAL_CLOSEOUT_RECEIPT"


@pytest.mark.parametrize("field", ["LVR_LIVE", "LVR_LIVE_EXECUTED", "LVR_RESULT", "LVR_PROVEN", "LVR_ATTEMPT_CONSUMED", "LVR_RERUN_ALLOWED", "RECOVERY_R2_R8_EXECUTED", "RECOVERY_RESULT", "L8_ACCEPTANCE", "L9_PROVEN"])
def test_every_required_lvr_field_must_be_present(tmp_path: Path, field: str) -> None:
    repo, _, main = s.world(tmp_path, lvr={field: None})
    assert reason(repo, main) in {f"LVR_FIELD_MISSING_OR_DUPLICATE:{field}", "LVR_PASS_CLOSEOUT_MISSING"}  # a receipt that lost its only result marker is "no closeout"


def test_a_repository_only_lvr_receipt_refuses(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path, lvr={"LVR_LIVE_EXECUTED": "NO"})
    assert reason(repo, main).startswith("LVR_FIELD_VALUE_INVALID:LVR_LIVE_EXECUTED")
    repo2, _, main2 = s.world(tmp_path / "b", lvr={"LVR_RERUN_ALLOWED": "YES"})
    assert reason(repo2, main2).startswith("LVR_FIELD_VALUE_INVALID:LVR_RERUN_ALLOWED")


def test_an_lvr_receipt_that_already_claims_l8_acceptance_refuses(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path, lvr={"L8_ACCEPTANCE": "YES"})
    assert reason(repo, main) == "L8_OR_L8U_ALREADY_RECORDED"


def test_an_existing_l8u_result_makes_l8u_one_shot(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path, extra={f"{s.LOGS}/2026-10-22_000000_music_idea3-l8u-live-closeout.md": "L8U_LIVE_EXECUTED=YES\n"})
    assert reason(repo, main) == "L8_OR_L8U_ALREADY_RECORDED"


def test_a_stale_lvr_whose_execution_main_is_not_an_ancestor_refuses(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT}, "base")
    s.git(repo, "checkout", "-q", "-b", "other")
    other = s.commit(repo, {"other.txt": "o"}, "unrelated branch")
    s.git(repo, "checkout", "-q", "-")
    main = s.commit(repo, {s.LVR_REL: s.lvr_receipt(other)}, "closeout naming a commit from another history")
    assert reason(repo, main) == "LVR_EXECUTION_MAIN_NOT_AN_ANCESTOR_OF_L8U_MAIN"


def test_an_lvr_execution_main_equal_to_the_l8u_main_refuses(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT}, "base")
    head = s.git(repo, "rev-parse", "HEAD")
    main = s.commit(repo, {s.LVR_REL: s.lvr_receipt(head)}, "closeout")
    assert check(repo, main)["LVR_EXECUTION_MAIN"] == head
    # now claim the closeout's OWN commit as the execution main: impossible to reference, so use main itself
    path = repo / s.LVR_REL
    path.write_text(s.lvr_receipt(main))
    s.git(repo, "add", "-A")
    s.git(repo, "commit", "-q", "-m", "self reference")
    new_main = s.git(repo, "rev-parse", "HEAD")
    assert reason(repo, new_main) in {"LVR_EXECUTION_MAIN_NOT_AN_ANCESTOR_OF_L8U_MAIN", "LVR_CLOSEOUT_ALREADY_EXISTED_AT_EXECUTION_MAIN"}


def test_a_closeout_that_already_existed_at_the_execution_main_refuses(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    placeholder = s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT, s.LVR_REL: "placeholder\n"}, "closeout path exists early")
    main = s.commit(repo, {s.LVR_REL: s.lvr_receipt(placeholder)}, "closeout rewritten later")
    assert reason(repo, main) == "LVR_CLOSEOUT_ALREADY_EXISTED_AT_EXECUTION_MAIN"


def test_missing_historical_l8p_refuses_and_is_never_a_request_to_rerun_it(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path, with_l8p=False)
    assert reason(repo, main) == "L8P_HISTORICAL_CLOSEOUT_MISSING_OR_NOT_CANONICAL"


def test_l8p_history_must_precede_the_lvr_execution_main(tmp_path: Path) -> None:
    repo = s.new_repo(tmp_path)
    execution = s.commit(repo, {"base.txt": "b"}, "execution main without L8p")
    main = s.commit(repo, {s.L8P_REL: s.L8P_RECEIPT, s.LVR_REL: s.lvr_receipt(execution)}, "L8p and LVR arrive together")
    assert reason(repo, main) == "L8P_CLOSEOUT_NOT_IN_LVR_EXECUTION_HISTORY"


def test_a_second_l8p_result_receipt_refuses(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path, extra={f"{s.LOGS}/2026-10-05_000000_music_idea3-l8p-second.md": "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n"})
    assert reason(repo, main) == "L8P_HISTORICAL_CLOSEOUT_NOT_UNIQUE_OR_NOT_CANONICAL"


def test_a_wrong_closeout_digest_pin_refuses(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    assert reason(repo, main, s.SHA["a"]) == "LVR_CLOSEOUT_SHA256_PIN_MISMATCH"


def test_a_malformed_or_unknown_main_refuses(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    assert reason(repo, "not-a-sha") == "COMMIT_MALFORMED"
    assert reason(repo, "f" * 40) == "COMMIT_NOT_A_COMMIT_OBJECT"


def test_working_tree_edits_are_never_authority(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    (repo / s.LVR_REL).write_text("LVR_RESULT=FAIL\n")  # uncommitted: the Git object at main is what counts
    assert check(repo, main)["LVR_PREDECESSOR"] == "PASS"
    (repo / "extra-untracked.md").write_text("LVR_PROVEN=YES\n")
    assert check(repo, main)["LVR_PREDECESSOR"] == "PASS"


def test_git_environment_cannot_redirect_the_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo, _, main = s.world(tmp_path)
    other = s.new_repo(tmp_path / "other")
    monkeypatch.setenv("GIT_DIR", str(other / ".git"))
    assert check(repo, main)["LVR_PREDECESSOR"] == "PASS"


def test_the_cli_prints_only_reasons_and_exit_codes(tmp_path: Path) -> None:
    repo, _, main = s.world(tmp_path)
    ok = s.bash(f'python3 -I "{s.PRED}" --repo "{repo}" --main {main}')
    assert ok.returncode == 0 and "LVR_PREDECESSOR=PASS" in ok.stdout
    bad = s.bash(f'python3 -I "{s.PRED}" --repo "{repo}" --main {"e" * 40}')
    assert bad.returncode == 1 and "L8U_PREDECESSOR=FAIL" in bad.stderr
