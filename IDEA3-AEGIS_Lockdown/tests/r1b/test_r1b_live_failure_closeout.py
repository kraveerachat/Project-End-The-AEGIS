"""R1B LIVE failure closeout: exactly ONE canonical immutable-failure receipt, no PASS/promotion claim anywhere, the one-attempt/no-retry gates now refuse any further R1B-related history, and the current-state
documentation no longer says R1B has not run. Read-only: it inspects committed files and receipts through Git/filesystem; nothing touches a host."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "r1a"))
import test_r1a_stage as base  # noqa: E402

ROOT = base.ROOT
REPO = ROOT.parent
LOGS = base.LOGS
B_LIB = base.P4 / "p4-r1b-run-lib.sh"
RELEASE = "ebffab6f8a6d7d98973fac7e89167352d529a87e"
VAULT = REPO / "Obsidian_AEGIS_Vault/AEGIS_Knowledge"
FIELDS = ("R1B_FAILURE_CLOSEOUT=YES", "R1B_LIVE=CLOSED_FAIL", "R1B_LIVE_EXECUTED=YES", "R1B_ATTEMPT_CONSUMED=YES", "R1B_RERUN_ALLOWED=NO", "R1B_RESULT=FAIL_IMMUTABLE", "R1B_FAILED_STAGE=windowrecord",
          "R1B_FAILURE_ROOT_CAUSE=POST_OBSERVATION_SUDO_AUTH_EXPIRY_DURING_WINDOW_RECORD", "R1B_GLOBAL_MARKER=PRESENT", "R1B_LOCAL_MARKER=PRESENT", "R1B_WINDOW_RECORD=ABSENT", "R1B_FINAL_CAPTURE_REACHED=NO",
          "R1B_FINAL_VERIFIER_REACHED=NO", "R1B_GENUINE_EXTERNAL_EVENT=PROVEN", "R1B_EXPECTED_SOURCE_IP=192.168.1.180", "R1B_INCIDENT_ID=2", "R1B_INCIDENT_STATE=OPEN", "R1B_NEW_INCIDENT_CREATED=YES",
          "R1B_ALERT_ACCEPTED=YES", "R1B_INCIDENT_BOUND=YES", "R1B_DETECTOR_SENT_BOUND=YES", "R1B_DETECTOR_UID=948", "R1B_DETECTOR_PID=2743706", "R1BV_REQUIRED=YES", "R1BV_AUTHORIZED=YES", "R1BV_IS_R1B_RETRY=NO",
          "R1BV_READ_ONLY_VALIDATION_ONLY=YES", "R1BV_NEW_EXTERNAL_EVENT_FORBIDDEN=YES", "R1BV_EXISTING_R1B_EVIDENCE_ONLY=YES", "R1BV_INCIDENT_MUTATION_FORBIDDEN=YES", "R1BV_R1B_MARKER_MUTATION_FORBIDDEN=YES",
          "R1BV_WINDOW_RECORD_RECONSTRUCTION_FORBIDDEN=YES", "R1BV_INTENDED_DEADLINE_DERIVATION_ALLOWED=YES", "R1BV_LIVE_EXECUTED=NO", "R1I_MUST_REMAIN_INSTALLED=YES", "RECOVERY_R2_R8_EXECUTED=NO",
          "RECOVERY_R2_R8_BLOCKED_UNTIL_R1BV_PASS=YES", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO")
pytestmark = pytest.mark.skipif(not (REPO / ".git").exists(), reason="needs a Git checkout")


def receipts() -> list[Path]:
    return sorted((REPO / LOGS).glob("*_music_idea3-r1b-live-failure-closeout.md"))


def test_exactly_one_r1b_failure_closeout_with_every_governed_field() -> None:
    found = receipts()
    assert len(found) == 1, found
    text = found[0].read_text()
    for line in FIELDS:
        assert f"- `{line}`" in text, line
    assert "2fcb6721c295c20afeabf1aef447c8d2ef8b18c3cb66a4ca8e79fe537fbcc870" in text and "1791259349.390871825" in text


def test_the_closeout_never_claims_a_pass_a_promotion_or_a_fabricated_window_record() -> None:
    whole = {ln.strip().strip("`-* ").strip("`") for ln in receipts()[0].read_text().splitlines()}
    for never in ("R1B_RESULT=PASS", "R1B_LIVE=CLOSED_PASS", "R1B_RESULT=FAIL", "R1B_WINDOW_RECORD=PRESENT", "R1B_FINAL_VERIFIER_REACHED=YES", "R1B_RERUN_ALLOWED=YES", "R1BV_LIVE_EXECUTED=YES", "R1BV_IS_R1B_RETRY=YES",
                  "RECOVERY_R2_R8_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES", "R1I_MUST_REMAIN_INSTALLED=NO"):
        assert never not in whole, never


def head() -> str:
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()


def test_the_r1b_predecessor_gate_now_refuses_every_further_r1b_history() -> None:
    """One attempt, no retry: with R1B recorded as executed and consumed, the R1B receipt gate refuses (a rerun can never be prepared from this history)."""
    result = base.bash(f'. "{B_LIB}"; r1b_receipt_gate "{REPO}" {RELEASE} {head()}')
    assert result.returncode == 1 and "R1B_CONTRADICTORY_OR_ALREADY_RECORDED" in result.stderr, result.stderr


def test_current_state_documentation_no_longer_says_r1b_has_not_run() -> None:
    moc = (VAULT / "idea3/idea3-moc.md").read_text()
    assert "R1B_LIVE_EXECUTED=NO" not in moc and "R1B_ATTEMPT_CONSUMED=NO" not in moc and "R1B` is the next governed stage and has NOT run" not in moc
    for needle in ("R1B_RESULT=FAIL_IMMUTABLE", "R1B_LIVE_EXECUTED=YES", "R1Bv", "RECOVERY_R2_R8_EXECUTED=NO", "R1B_GENUINE_EXTERNAL_EVENT=PROVEN"):
        assert needle in moc, needle
    status = (VAULT / "idea3/idea3-status.md").read_text()
    top = status[:status.index("## IDEA3 R1Dv LIVE")]
    for needle in ("R1B_RESULT=FAIL_IMMUTABLE", "R1B_FAILED_STAGE=windowrecord", "R1BV_REQUIRED=YES", "R1BV_LIVE_EXECUTED=NO", "R1B_WINDOW_RECORD=ABSENT"):
        assert needle in top, needle
    # the older R1B implementation section must be explicitly historical, not a current-state claim
    i = status.index("## IDEA3 R1B successor governed stage")
    assert "historical PRE-LIVE snapshot" in status[i:i + 400] and "NOT current" in status[i:i + 900]
    readme = (base.P4 / "README.md").read_text()
    assert "## 21. Stage R1B — LIVE outcome" in readme and "R1Bv (LIVE PASS, read-only; see section 23) -> Recovery R2-R8 (NEXT; predecessor satisfied; NOT executed)" in readme
    # an R1Bv PASS statement is legitimate ONLY once the unique R1Bv LIVE closeout receipt exists (it was a forbidden claim at the time of the R1B failure closeout)
    if re.search(r"R1Bv.{0,40}(LIVE=CLOSED_PASS|RESULT=PASS)", moc + status):
        assert len(list((REPO / LOGS).glob("*_music_idea3-r1bv-live-closeout.md"))) == 1


def test_no_authorization_artifact_is_committed_and_the_r1b_stage_stays_registered_before_r1bv() -> None:
    """History: PR #365 added no R1Bv; R1Bv has since run LIVE (its closeout is checked by tests/r1bv/test_r1bv_live_closeout.py). No Authorization file is ever committed."""
    p4 = base.P4
    assert not list(p4.glob("**/authorization-R1Bv*"))
    assert "R1B R1Bv L8" in re.search(r'readonly P4_STAGES="([^"]*)"', (p4 / "p4-lib.sh").read_text()).group(1).replace("R1Dv ", "")


STALE = re.compile(r"R1B_LIVE_EXECUTED=NO|R1B_ATTEMPT_CONSUMED=NO|R1B has NOT run|R1B has not run", re.I)


def sections(path: Path) -> list[tuple[str, str]]:
    out, head, buf = [], "", []
    for line in path.read_text().split("\n"):
        if line.startswith("## "):
            out.append((head, "\n".join(buf)))
            head, buf = line, []
        else:
            buf.append(line)
    out.append((head, "\n".join(buf)))
    return out


@pytest.mark.parametrize("path", [VAULT / "idea3/idea3-status.md", VAULT / "idea3/idea3-moc.md", base.P4 / "README.md"], ids=lambda p: p.name)
def test_no_section_presents_r1b_has_not_run_as_current_state(path: Path) -> None:
    """A section may carry the pre-run R1B execution-state values only when it is explicitly historical/superseded (heading or opening note); the R1B LIVE / R1D LIVE failure sections state the current truth."""
    bad = []
    for head, body in sections(path):
        text = head + "\n" + body
        if not STALE.search(text):
            continue
        opening = (head + "\n" + body[:900]).lower()
        section_marked = "historical" in opening or "superseded" in opening or "live outcome" in head.lower()
        for m in STALE.finditer(text):
            around = text[max(0, m.start() - 220):m.end() + 220].lower()
            local = any(w in around for w in ("historical", "superseded", "at that time", "at that merge", "have since", "has since", "before the stage ran", "before it ran", "closeout", "pre-marker failure"))  # the last: a conditional design rule of the stage, not a state claim
            if not (section_marked and local):
                bad.append((head[:80], around[:120]))
    assert not bad, bad


def test_the_r1dv_live_section_is_explicitly_historical_and_points_to_the_current_r1b_state() -> None:
    status = (VAULT / "idea3/idea3-status.md").read_text()
    i = status.index("## IDEA3 R1Dv LIVE")
    j = status.index("\n## ", i + 5)
    section = status[i:j]
    heading = section.split("\n", 1)[0]
    assert "historical" in heading.lower() and "R1B has since run once and failed immutably" in heading
    assert "SUPERSEDED" in section and "R1B_RESULT=FAIL_IMMUTABLE" in section and "R1B_LIVE_EXECUTED=YES" in section
    # the stale values may appear only inside a sentence that is itself labelled as historical/superseded
    for m in STALE.finditer(section):
        around = section[max(0, m.start() - 160):m.end() + 160].lower()
        assert "at that time" in around or "superseded" in around or "were true only then" in around, around
    assert "R1Dv itself remains PASS" in section and "`R1DV_RESULT=PASS`" in section  # R1Dv is not rewritten
