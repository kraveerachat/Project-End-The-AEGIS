"""R1Bv LIVE closeout checks (read-only, committed files and Git only): exactly ONE canonical LIVE PASS closeout that carries every Recovery-predecessor field, no promotion or contradiction, governed results kept apart from owner-run
metadata, the current-state documentation no longer says R1Bv has not run, the earlier repository-only sections are explicitly historical, and a duplicate/ambiguous closeout would be refused."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_r1bv_contract as c  # noqa: E402  (shared hermetic builders and the contract field list)

REPO, LOGS, LIB, P4, base = c.REPO, c.LOGS, c.LIB, c.P4, c.base
VAULT = REPO / "Obsidian_AEGIS_Vault/AEGIS_Knowledge"
CLOSEOUT_NAME = "2026-10-06_154016_music_idea3-r1bv-live-closeout.md"
pytestmark = pytest.mark.skipif(not (REPO / ".git").exists(), reason="needs a Git checkout (the gates read the pinned commit)")


def closeouts() -> list[Path]:
    return sorted((REPO / LOGS).glob("*_music_idea3-r1bv-live-closeout.md"))


def real_text() -> str:
    return (REPO / LOGS / CLOSEOUT_NAME).read_text()


def whole_lines(text: str) -> set[str]:
    return {ln.strip().strip("`-* ").strip("`") for ln in text.splitlines()}


def head() -> str:
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()


def test_exactly_one_canonical_r1bv_live_pass_closeout_with_every_recovery_predecessor_field() -> None:
    found = closeouts()
    assert [p.name for p in found] == [CLOSEOUT_NAME]
    lines = whole_lines(found[0].read_text())
    for field in c.R1BV_LIVE_FIELDS:
        assert field in lines, field
    text = found[0].read_text()
    assert "25269e302fe6d8cf7f9e067c537dba7e963d01acc5fb7f4d4f0bbc05e8caaf8e" in text and "2026-10-06-r1bv-20261006-154002" in text


def test_the_receipt_keeps_r1b_immutable_and_makes_no_promotion_rewrite_execution_or_mutation_claim() -> None:
    lines = whole_lines(real_text())
    for never in ("R1B_RESULT=PASS", "R1B_LIVE=CLOSED_PASS", "R1B_RESULT_REWRITTEN=YES", "R1B_RERUN_ALLOWED=YES", "R1B_WINDOW_RECORD=PRESENT", "RECOVERY_R2_R8_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN",
                  "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES", "R1BV_NEW_EXTERNAL_EVENT_GENERATED=YES", "R1BV_INCIDENT_MUTATED=YES", "R1BV_R1B_MARKER_MUTATED=YES", "R1BV_WINDOW_RECORD_CREATED=YES",
                  "R1BV_WINDOW_RECORD_RECONSTRUCTED=YES", "R1BV_IS_R1B_RETRY=YES", "R1BV_READ_ONLY_VALIDATION_ONLY=NO", "R1BV_RESULT=FAIL", "R1BV_LIVE=CLOSED_FAIL"):
        assert never not in lines, never
    assert {"R1B_RESULT=FAIL_IMMUTABLE", "R1B_RESULT_REWRITTEN=NO", "RECOVERY_R2_R8_EXECUTED=NO"} <= lines


def test_governed_results_are_kept_apart_from_owner_run_metadata_and_no_secret_or_private_detail_is_published() -> None:
    text = real_text()
    governed = text[text.index("## Governed result"):text.index("## Informational")]
    informational = text[text.index("## Informational"):text.index("## Verification evidence")]
    assert re.search(r"^- `R1BV_RESULT=PASS`$", governed, re.M)
    assert not re.search(r"^- `[A-Z0-9_]+=[^`]*`$", informational, re.M)  # no governed whole-line field inside the informational section
    for private in ("192.168.", "core.env", "password", "token", "BEGIN PRIVATE"):
        assert private not in text, private
    assert "owner-reported" in informational and "NOT R1Bv LIVE failures" not in informational and "not R1Bv LIVE failures" in informational
    assert "proves the R1Bv validation environment ONLY" in governed  # the current clock is not presented as historical evidence


def test_the_recovery_predecessor_gate_accepts_the_real_committed_history() -> None:
    result = base.bash(f'. "{LIB}"; r1bv_recovery_predecessor_gate "{REPO}" {head()}')
    assert result.returncode == 0, result.stderr


def test_the_recovery_gate_accepts_the_real_closeout_with_the_real_receipts_and_refuses_a_duplicate_or_an_extra_claim(tmp_path: Path) -> None:
    real = real_text()
    assert c.recovery_gate(c.world(tmp_path, closeout=real)).returncode == 0
    (tmp_path / "d").mkdir()
    dup = f"{LOGS}/2026-10-08_000000_music_idea3-r1bv-live-closeout.md"
    assert c.recovery_gate(c.world(tmp_path / "d", closeout=real, **{dup: real})).returncode == 1  # a second canonical-name closeout is ambiguous
    (tmp_path / "e").mkdir()
    assert c.recovery_gate(c.world(tmp_path / "e", closeout=real, **{f"{LOGS}/2026-10-08_000001_music_notes.md": "- `R1BV_VERIFY=PASS`\n"})).returncode == 1  # an extra bare positive claim
    (tmp_path / "f").mkdir()
    assert c.recovery_gate(c.world(tmp_path / "f", closeout=real.replace("- `R1BV_AUDIT_INTEGRITY=PASS`\n", ""))).returncode == 1  # a missing required field


def test_a_second_live_run_is_not_preparable_on_top_of_the_recorded_pass() -> None:
    result = base.bash(f'. "{LIB}"; r1bv_receipt_gate "{REPO}" {c.RELEASE} {head()}')
    assert result.returncode == 1 and "ALREADY_RECORDED" in result.stderr, result.stderr


def sections(path: Path):
    out, head_, buf = [], "", []
    for line in path.read_text().split("\n"):
        if line.startswith("## "):
            out.append((head_, "\n".join(buf)))
            head_, buf = line, []
        else:
            buf.append(line)
    out.append((head_, "\n".join(buf)))
    return out


def test_current_state_documentation_no_longer_says_r1bv_live_has_not_run() -> None:
    status = (VAULT / "idea3/idea3-status.md").read_text()
    top = status[:status.index("## IDEA3 R1Bv — repository implementation")]
    for needle in ("R1BV_LIVE=CLOSED_PASS", "R1BV_RESULT=PASS", "R1B_RESULT=FAIL_IMMUTABLE", "RECOVERY_R2_R8_EXECUTED=NO", "Recovery predecessor: SATISFIED", "NEXT governed work"):
        assert needle in top, needle
    assert "R1BV_LIVE_EXECUTED=NO" not in top and "LIVE NOT RUN" not in top.split("\n", 3)[0]
    # the repository-only R1Bv section is explicitly historical / superseded
    for head_, body in sections(VAULT / "idea3/idea3-status.md"):
        if head_.startswith("## IDEA3 R1Bv — repository implementation"):
            assert "historical" in head_.lower() and "SUPERSEDED" in body[:900]
    moc = (VAULT / "idea3/idea3-moc.md").read_text()
    assert "R1BV_LIVE=CLOSED_PASS" in moc and "RECOVERY_R2_R8_EXECUTED=NO" in moc and "has NOT run live" not in moc and "R1BV_LIVE_EXECUTED=NO" not in moc
    readme = (P4 / "README.md").read_text()
    assert "## 23. Stage R1Bv — LIVE outcome: PASS" in readme and "Recovery R2-R8 (NEXT; predecessor satisfied; NOT executed)" in readme
    sec22 = readme[readme.index("## 22. Stage R1Bv"):readme.index("## 23. Stage R1Bv")]
    assert "Historical (repository implementation as merged)" in sec22 and "SUPERSEDED by section 23" in sec22


def test_stale_r1bv_not_run_claims_survive_only_in_sections_marked_historical() -> None:
    stale = re.compile(r"R1BV_LIVE_EXECUTED=NO|R1Bv[^.\n]{0,60}LIVE NOT RUN|R1Bv[^.\n]{0,40}has NOT run live|Recovery R2[^.\n]{0,40}blocked until[^.\n]{0,30}R1Bv")
    bad = []
    for path in (VAULT / "idea3/idea3-status.md", VAULT / "idea3/idea3-moc.md", P4 / "README.md"):
        for head_, body in sections(path):
            text = head_ + "\n" + body
            if not stale.search(text):
                continue
            opening = (head_ + "\n" + body[:1200]).lower()
            if not ("historical" in opening or "superseded" in opening):
                bad.append((path.name, head_[:90]))
    assert not bad, bad
