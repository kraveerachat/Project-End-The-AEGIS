"""R1B successor contract: attempt isolation from the immutable R1A FAIL, pre-consume quiescence/TrustedClock ordering, TrustedClock from the immutable verifier snapshot, claim boundary. Hermetic: temp seams and
throw-away trees only; the real /var/lib/aegis-idea3-governance and every Production path are never read, written or deleted."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_r1b_stage as base  # noqa: E402

P4, LIB, RUNNER, ROOT = base.P4, base.LIB, base.RUNNER, base.ROOT
STG = P4 / "stages/R1B"


def code(path: Path) -> str:
    return "\n".join(base.code_lines(path))


# ---- C: attempt identity / isolation from R1A ----
def test_r1b_names_only_its_own_canonical_marker_and_window_record() -> None:
    for path in (LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh"):
        text = code(path)
        assert "R1A-GLOBAL-ATTEMPT-CONSUMED" not in text and "R1A-ATTEMPT-WINDOW" not in text and "R1A-ATTEMPT-CONSUMED" not in text, path
    assert 'R1B_GLOBAL_MARKER_NAME="R1B-GLOBAL-ATTEMPT-CONSUMED"' in LIB.read_text()


def test_a_consumed_r1a_marker_neither_consumes_nor_releases_r1b_and_is_never_touched(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    (canon / "R1A-GLOBAL-ATTEMPT-CONSUMED").write_text("consumed_at=x\n")
    (canon / "R1A-ATTEMPT-WINDOW").write_text("window_start=1\n")
    before = {p.name: p.read_bytes() for p in canon.iterdir()}
    auth = tmp_path / "auth"
    auth.mkdir()
    pre = base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1b_attempt_unconsumed "{auth}" && echo UNCONSUMED')
    assert "UNCONSUMED" in pre.stdout, pre.stderr  # R1A state does not mean R1B is consumed
    run = base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; sync() {{ :; }}; chattr() {{ :; }}; r1b_consume_attempt "{auth}" && echo CONSUMED')
    assert "CONSUMED" in run.stdout, run.stderr
    assert (canon / "R1B-GLOBAL-ATTEMPT-CONSUMED").is_file()
    assert {p.name: p.read_bytes() for p in canon.iterdir() if p.name.startswith("R1A")} == {k: v for k, v in before.items()}  # R1A records byte-identical
    again = base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1b_attempt_unconsumed "{tmp_path / "auth2"}"')
    assert again.returncode == 1


def test_no_r1b_code_path_removes_resets_or_rewrites_the_canonical_records() -> None:
    for path in (LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh"):
        for line in base.code_lines(path):
            assert not re.search(r"\brm\b[^#]*(GLOBAL|MARKER|canon|governance)", line), (path, line)
            assert not re.search(r"chattr\s+-i", line), (path, line)
            assert not re.search(r"\b(mv|truncate|shred|unlink)\b.*(R1[AB]-GLOBAL|R1[AB]-ATTEMPT|governance)", line), (path, line)


# ---- E: TrustedClock authority comes from the immutable snapshot, not a worktree / caller PYTHONPATH ----
def flat_control(tmp_path: Path) -> Path:
    """The frozen control snapshot is FLAT: p4-l5-clock.py sits in a directory whose ancestors are NOT the repository layout."""
    ctrl = tmp_path / "authority" / "control"
    ctrl.parent.mkdir()
    shutil.copytree(P4, ctrl, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return ctrl


def verifier_snapshot(tmp_path: Path) -> Path:
    snap = tmp_path / "authority2" / "verifier"
    snap.parent.mkdir()
    base.load_snapshot_tool().snapshot(ROOT, snap)
    return snap


def test_the_flattened_control_snapshot_alone_cannot_import_trusted_time(tmp_path: Path) -> None:
    ctrl = flat_control(tmp_path)
    result = subprocess.run([sys.executable, str(ctrl / "p4-l5-clock.py"), "state"], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert result.returncode != 0 and ("ModuleNotFoundError" in result.stderr or "No module named" in result.stderr), result.stderr  # the historical R1A failure, reproduced


def test_the_snapshot_pythonpath_provides_trusted_time_and_a_caller_pythonpath_cannot_override_it(tmp_path: Path) -> None:
    ctrl, snap = flat_control(tmp_path), verifier_snapshot(tmp_path)
    decoy = tmp_path / "decoy"
    (decoy / "aegis_soc").mkdir(parents=True)
    (decoy / "aegis_soc/__init__.py").write_text("")
    (decoy / "aegis_soc/trusted_time.py").write_text("raise RuntimeError('DECOY_TRUSTED_TIME_IMPORTED')\n")
    # exactly how the frozen runner invokes the capture: `sudo env PYTHONPATH=<verifier snapshot> ...` REPLACES whatever the caller exported
    result = subprocess.run(["bash", "-c", f'export PYTHONPATH="{decoy}"; env PYTHONPATH="{snap}" PYTHONDONTWRITEBYTECODE=1 {sys.executable} "{ctrl}/p4-l5-clock.py" state'],
                            capture_output=True, text=True)
    assert result.returncode in (0, 1) and re.match(r"^state=(SYNCED|UNTRUSTED|UNSYNCED|UNAVAILABLE|[A-Z_]+)\b", result.stdout), (result.stdout, result.stderr)
    assert "DECOY" not in result.stderr + result.stdout
    leaked = subprocess.run(["bash", "-c", f'export PYTHONPATH="{decoy}"; {sys.executable} "{ctrl}/p4-l5-clock.py" state'], capture_output=True, text=True)
    assert "DECOY_TRUSTED_TIME_IMPORTED" in leaked.stderr  # without the explicit override a caller's PYTHONPATH WOULD satisfy the import: that is why the runner sets it


def test_the_runner_capture_sets_the_snapshot_pythonpath_and_the_verifier_closure_carries_trusted_time(tmp_path: Path) -> None:
    capture = base.runner_function("capture") if "capture() {" in RUNNER.read_text() and "\n}\n" in RUNNER.read_text().split("capture() {", 1)[1] else RUNNER.read_text()
    assert 'PYTHONPATH="$VERIFIER_SNAPSHOT_DIR"' in capture and "PYTHONDONTWRITEBYTECODE=1" in capture
    snap = verifier_snapshot(tmp_path)
    assert (snap / "aegis_soc/trusted_time.py").is_file()
    assert (snap / "aegis_soc/trusted_time.py").read_bytes() == (ROOT / "aegis_soc/trusted_time.py").read_bytes()


# ---- F: pre-consume quiescence + TrustedClock ordering ----
def baseline_lines() -> list[str]:
    text = RUNNER.read_text()
    body = text[text.index("r1b_hook_baseline() {"):text.index("r1b_hook_regate() {")]
    return [ln.strip() for ln in body.splitlines()]


def first(lines: list[str], needle: str) -> int:
    return next(i for i, ln in enumerate(lines) if needle in ln)


def test_preconsume_ordering_is_precheck_quiet_pre_compare_clock_then_baseline_then_regate_then_marker() -> None:
    lines = baseline_lines()
    order = [first(lines, n) for n in ('capture PRECHECK', 'capture=precheck', 'sleep 5', 'capture PRE "$PRE"', 'capture=pre"', 'compare "$PRECHECK" "$PRE"', 'handler BASELINE')]
    assert order == sorted(order) and len(set(order)) == len(order)
    lib = LIB.read_text()
    machine = lib[lib.index("r1b_run_attempt() {"):lib.index("r1b_attempt_failed() {")]
    assert machine.index("pregates baseline regate") < machine.index("r1b_consume_attempt")
    assert "r1b_consume_attempt" not in baseline_text()


def baseline_text() -> str:
    return "\n".join(baseline_lines())


def clock_check_lines() -> list[str]:
    return [ln for ln in baseline_lines() if "time.trustedclock.state" in ln]


@pytest.mark.parametrize("state,ok", [("SYNCED", True), ("UNAVAILABLE", False), ("UNKNOWN", False), ("UNTRUSTED", False), ("UNSYNCED", False), ("NOT_RECORDED", False), ("SYNCEDX", False), ("synced", False)])
def test_only_an_exact_synced_state_passes_the_trustedclock_precondition(tmp_path: Path, state: str, ok: bool) -> None:
    (tmp_path / "time.tsv").write_text(f"time.trustedclock.state\t{state}\n")
    for line in clock_check_lines():
        cmd = re.search(r"(awk .*?\"\$[A-Z]+/time\.tsv\")", line).group(1).replace('"$PRECHECK/time.tsv"', f'"{tmp_path}/time.tsv"').replace('"$PRE/time.tsv"', f'"{tmp_path}/time.tsv"')
        assert (subprocess.run(["bash", "-c", cmd]).returncode == 0) is ok, (state, line)


def test_a_missing_or_duplicated_clock_record_fails_the_precondition(tmp_path: Path) -> None:
    line = clock_check_lines()[0]
    cmd = re.search(r"(awk .*?\"\$[A-Z]+/time\.tsv\")", line).group(1).replace('"$PRECHECK/time.tsv"', f'"{tmp_path}/time.tsv"')
    (tmp_path / "time.tsv").write_text("time.other\tx\n")
    assert subprocess.run(["bash", "-c", cmd]).returncode != 0
    assert subprocess.run(["bash", "-c", cmd.replace(f"{tmp_path}/time.tsv", f"{tmp_path}/absent.tsv")], stderr=subprocess.DEVNULL).returncode != 0


def test_both_clock_captures_report_not_consumed_on_failure_and_precede_any_marker() -> None:
    lines = clock_check_lines()
    assert len(lines) == 2 and all("R1B_PRECONSUME_TRUSTEDCLOCK=FAIL" in ln and "return 1" in ln for ln in lines)
    machine = LIB.read_text()
    fail_branch = machine[machine.index("R1B_PRE_ATTEMPT_FAILURE=$stage"):]
    assert "R1B_ATTEMPT_CONSUMED=NO" in fail_branch.splitlines()[0]


def test_unapproved_drift_is_not_allowlisted_for_the_preconsume_comparison() -> None:
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in RUNNER.read_text() and "FINDINGS_INCOMPARABLE=0" in RUNNER.read_text() and "FINDINGS_APPROVED_CHANGE=0" in RUNNER.read_text()
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        entries = [ln for ln in (STG / name).read_text().splitlines() if ln.strip() and not ln.startswith("#")]
        assert not any(re.search(r"desktop|gnome|kde|plasma|xdg|wayland|pipewire|chrome|firefox|steam", ln, re.I) for ln in entries), (name, entries)


# ---- J: claim boundary ----
def test_a_verifier_pass_never_promotes_and_the_runner_and_verify_say_so() -> None:
    for path in (RUNNER, STG / "verify.sh"):
        text = path.read_text()
        assert "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in text and "R1_VERIFIED=NOT_CLAIMED" in text, path
    assert "R1B_PROMOTION=NOT_AUTOMATIC" in LIB.read_text()
    for path in (RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh"):  # (the library only NAMES these claims in its contradiction blocklist)
        for line in base.code_lines(path):
            assert "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN" not in line and "R1_VERIFIED=VERIFIED" not in line and "RECOVERY_R1_R8_PROVEN=YES" not in line, (path, line)


def test_the_runner_never_references_recovery_r2_r8_execution_or_r1i_removal() -> None:
    for path in (LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh"):
        text = code(path)
        assert not re.search(r"nft\s+(delete|flush|destroy)\s+table\s+inet\s+aegis_idea3_r1i", text), path
        assert not re.search(r"RECOVERY_R2_R8_EXECUTED=YES|p4-recovery|run-recovery", text), path
