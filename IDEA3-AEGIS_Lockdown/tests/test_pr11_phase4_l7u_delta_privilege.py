"""AEGIS IDEA3 PR11 Phase 4 — L7u exact-value delta privilege boundary (regression for the 2026-10-02 live attempt).

The first L7u live attempt applied and verified, passed the PRE->POST compare, then failed `L7U_DELTA=FAIL reason=UNEXPECTED:PermissionError`:
the owner runner invoked `p4-l7u-upgrade.py delta` as the NORMAL user, but the root-owned (0700) `pre-root`/`post-root` capture directories that
`read_records` opens are readable by root only. The failure rolled back correctly, but it is a runner/engine boundary defect that no test covered
because the engine tests call `engine.delta(...)` on in-memory records and never drive the real runner line or the real CLI.

These tests pin: the runner runs ONLY the read-only `delta` CLI through the existing sudo boundary (never widened), the proof still runs after the
PRE->POST compare and a failure still rolls back, the CLI reports an unreadable capture as an explicit refusal (not UNEXPECTED:PermissionError),
and the fix introduces no second restart, detector start, Recovery/CUT/RESTORE or ESP32 action. The capture permissions are NOT weakened.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7u_support as s

DEPLOY = Path(__file__).resolve().parents[1] / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-l7u-owner.sh"


def _logical_lines(text: str) -> list[str]:
    """Runner text with shell line continuations joined and comment-only lines removed."""
    joined = re.sub(r"\\\n\s*", " ", text)
    return [l for l in joined.splitlines() if l.strip() and not l.lstrip().startswith("#")]


def _delta_line() -> str:
    hits = [l for l in _logical_lines(RUNNER.read_text()) if 'p4-l7u-upgrade.py" delta' in l]
    assert len(hits) == 1, hits
    return hits[0]


def test_runner_invokes_exact_value_delta_through_the_existing_sudo_boundary() -> None:
    line = _delta_line()
    assert re.search(r'(^|[;&|]\s*|"\s)sudo "\$PY" "\$P4/p4-l7u-upgrade\.py" delta ', line), line


def test_the_sudo_for_delta_is_not_widened() -> None:
    line = _delta_line()
    assert "sudo -E" not in line and "sudo -s" not in line and "sudo sh" not in line and "sudo bash" not in line and "sudo env" not in line
    assert "AEGIS_L7U_LIVE_AUTHORIZED" not in line, "delta is read-only: it must never carry the live-authorization flag"
    # every sudo use in the runner stays one of the already-reviewed forms (first word after `sudo`); no shell, no -E/-s/-i, no su
    allowed = {"-v", "env", "grep", "test", "bash", '"$PY"', "chown", "authentication"}
    seen = set()
    for l in _logical_lines(RUNNER.read_text()):
        for m in re.finditer(r"\bsudo\s+(\S+)", l):
            seen.add(m.group(1))
    assert seen <= allowed, seen - allowed
    assert "sh" not in seen and "su" not in seen and "-E" not in seen and "-s" not in seen and "-i" not in seen


def test_delta_still_runs_after_the_pre_post_compare_and_before_the_final_checks_and_a_failure_still_rolls_back() -> None:
    lines = _logical_lines(RUNNER.read_text())
    text = "\n".join(lines)
    compare = text.index('compare "$EVID/pre-root" "$EVID/post-root"')
    delta = text.index('p4-l7u-upgrade.py" delta')
    assert compare < delta < text.index("l7u_secret_scan") < text.index("s10_unchanged || rollback_flow") < text.index("trap - ERR INT TERM\necho \"L7U_LIVE_EXECUTED=YES")
    assert 'rollback_flow "exact-value delta proof failed"' in _delta_line()
    assert _delta_line().rstrip().endswith("|| rollback_flow \"exact-value delta proof failed\"")


def test_the_fix_adds_no_second_restart_detector_start_recovery_or_device_action_to_the_runner() -> None:
    text = "\n".join(_logical_lines(RUNNER.read_text()))
    assert not re.search(r"systemctl\s+(re)?start|systemctl\s+restart|systemctl\s+stop|systemctl\s+enable", text)
    assert not re.search(r"aegis-idea3-detector\S*\.service|f1-detector|recovery_client|recovery_ui|/dev/tty|serial|CUT\b.*send|RESTORE\b.*send", text.replace("L7U_STARTS_DETECTOR=NO", ""))
    assert text.count("l7u_consume_attempt") == 1 and text.count('handler apply.sh') == 1


def test_delta_cli_is_read_only_by_construction() -> None:
    text = s.ENGINE_PATH.read_text()
    body = text[text.index("def read_records"): text.index("# ── CLI")]
    assert not re.search(r"write_text|write_bytes|open\([^)]*['\"][wax+]|os\.(remove|unlink|rename|replace|chmod|chown|mkdir|makedirs)|shutil|backend\.", body)
    cli_delta = text[text.index("            pre, post = read_records"): text.index("    except Refusal as exc:")]
    assert "backend" not in cli_delta and "journal" not in cli_delta.lower()


@pytest.mark.skipif(os.geteuid() == 0, reason="an unreadable capture cannot be simulated as root")
def test_an_unreadable_root_owned_style_capture_is_an_explicit_refusal_not_unexpected_permission_error(tmp_path: Path) -> None:
    """Equivalent of the live failure: the capture directories exist but the invoking user cannot open them (live: root:root 0700)."""
    pre, post = tmp_path / "pre-root", tmp_path / "post-root"
    for d in (pre, post):
        d.mkdir()
        (d / "host.tsv").write_text("k\tv\n")
        (d / "services.tsv").write_text("k\tv\n")
        d.chmod(0o000)
    try:
        res = subprocess.run(
            [sys.executable, str(s.ENGINE_PATH), "delta", "--old-release-id", s.OLD_ID, "--new-release-id", s.NEW_ID, "--expected-main", s.MAIN,
             "--source-dir", str(tmp_path / "src"), "--work-dir", str(tmp_path / "work"), "--operator-user", s.OPERATOR, "--operator-uid", str(s.OPERATOR_UID),
             "--alert-source-uid", "948", "--pre-dir", str(pre), "--post-dir", str(post)],
            capture_output=True, text=True, check=False)
    finally:
        for d in (pre, post):
            d.chmod(0o700)
    assert res.returncode == 1
    assert "UNEXPECTED:PermissionError" not in res.stderr
    assert "L7U_DELTA=FAIL reason=DELTA_CAPTURE_UNREADABLE_ROOT_REQUIRED" in res.stderr
    assert str(tmp_path) not in res.stderr and res.stdout == ""


def test_the_cli_does_not_silently_widen_privilege_for_delta() -> None:
    """delta stays runnable unprivileged when the capture is readable (fixtures); the boundary is enforced by the OS permissions on the capture,
    never by the CLI chmod/chown-ing evidence or re-executing itself under sudo."""
    text = s.ENGINE_PATH.read_text()
    assert "sudo" not in "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")).replace("sudo/root", "")
    assert not re.search(r"os\.(setuid|seteuid|execv|execvp|execl)|chmod\(|chown\(", text[text.index("def read_records"): text.index("def _parse_alert_uid")])
