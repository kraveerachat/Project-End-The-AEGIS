"""M2: the canonical one-attempt records are made DURABLE (file, then containing directory) before the state machine proceeds, and a failed barrier is a consumed, fail-closed outcome.

Every test points the TEST-ONLY canonical seam at a temporary directory and intercepts `date`, `sync`, `chattr` and `sudo` through PATH shims that LOG each call in sequence. Nothing is ever created or synced
under the real /var/lib/aegis-idea3-governance path, and nothing deletes or resets canonical state."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import test_r1a_stage as base

LIB = base.LIB
REAL = {name: shutil.which(name) for name in ("date", "sync", "chattr")}


def make_shims(tmp_path: Path) -> tuple[Path, Path]:
    shim = tmp_path / "shim"
    shim.mkdir()
    oplog = tmp_path / "ops.log"
    (shim / "date").write_text(f'#!/bin/sh\nprintf "DATE %s\\n" "$*" >> "{oplog}"\nexec {REAL["date"]} "$@"\n')
    (shim / "sync").write_text(
        f'#!/bin/sh\nn=$(grep -c "^SYNC " "{oplog}" 2>/dev/null); n=$((n + 1)); eval "path=\\${{$#}}"\n'
        f'printf "SYNC %s %s\\n" "$n" "$path" >> "{oplog}"\n[ "$n" = "${{FAIL_SYNC_N:-0}}" ] && exit 1\nexec {REAL["sync"]} "$@"\n')
    (shim / "chattr").write_text(f'#!/bin/sh\nprintf "CHATTR\\n" >> "{oplog}"\nexit 0\n')
    real_bash = shutil.which("bash")  # the creation commands run as `bash -c '... noclobber ... > "$1"' _ <path>`: a PATH shim for `bash` logs the exclusive creates (SUDO stays empty: the test user owns the seam dir)
    (shim / "bash").write_text(
        f'#!/bin/sh\ncase "$*" in *R1A-GLOBAL-ATTEMPT-CONSUMED*) printf "MARKER_CREATE\\n" >> "{oplog}";; *R1A-ATTEMPT-WINDOW*) printf "WINDOW_CREATE\\n" >> "{oplog}";; esac\nexec {real_bash} "$@"\n')
    for name in ("date", "sync", "chattr", "bash"):
        (shim / name).chmod(0o755)
    return shim, oplog


def run_attempt(tmp_path: Path, *, fail_sync_n: int = 0, precreate_canon: bool = True, second_run: bool = True) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    shim, oplog = make_shims(tmp_path)
    (tmp_path / "auth").mkdir()
    if precreate_canon:
        (tmp_path / "canon").mkdir(mode=0o700)
    script = f'''AUTH="{tmp_path / "auth"}"; {base.seam(tmp_path)}. "{LIB}"; SUDO=""; OPLOG="{oplog}"
r1a_hook_pregates() {{ true; }}; r1a_hook_baseline() {{ true; }}; r1a_hook_regate() {{ true; }}
r1a_hook_observe() {{ printf "OBSERVE_ENTER\\n" >> "$OPLOG"; }}
r1a_hook_final() {{ printf "FINAL_CALLED\\n" >> "$OPLOG"; }}; r1a_hook_verify() {{ printf "VERIFY_CALLED\\n" >> "$OPLOG"; }}
r1a_hook_preserve_evidence() {{ printf "PRESERVE:%s\\n" "$1" >> "$OPLOG"; }}
r1a_run_attempt "$AUTH" 30; echo "rc=$?"
{'r1a_run_attempt "$AUTH" 30; echo "rerun_rc=$?"' if second_run else ''}'''
    result = subprocess.run([shutil.which("bash"), "-c", script], env={**os.environ, "PATH": f"{shim}:{os.environ['PATH']}", "FAIL_SYNC_N": str(fail_sync_n)}, text=True, capture_output=True)
    return result, oplog.read_text().split("\n") if oplog.exists() else []


def kinds(ops: list[str]) -> list[str]:
    """The ordered, comparable event kinds (SYNC lines name the synced path's role)."""
    out = []
    epochs = 0
    for line in ops:
        if line.startswith("SYNC "):
            path = line.split(" ", 2)[2]
            out.append("SYNC_MARKER" if path.endswith("R1A-GLOBAL-ATTEMPT-CONSUMED") else "SYNC_WINDOW" if path.endswith("R1A-ATTEMPT-WINDOW") else "SYNC_DIR")
        elif line == "DATE +%s.%N":
            out.append("WINDOW_START_SAMPLE" if epochs == 0 else "WINDOW_END_SAMPLE")
            epochs += 1
        elif line in ("MARKER_CREATE", "WINDOW_CREATE", "CHATTR", "OBSERVE_ENTER", "FINAL_CALLED", "VERIFY_CALLED") or line.startswith("PRESERVE:"):
            out.append(line)
    return out


def test_the_successful_path_orders_create_durability_then_start_sample_then_observation_then_window_durability_then_final(tmp_path: Path) -> None:
    result, ops = run_attempt(tmp_path, second_run=False)
    assert "rc=0" in result.stdout and "R1A_RESULT=PASS" in result.stdout, result.stderr
    assert kinds(ops) == ["MARKER_CREATE", "SYNC_MARKER", "SYNC_DIR", "CHATTR", "WINDOW_START_SAMPLE", "OBSERVE_ENTER", "WINDOW_END_SAMPLE", "WINDOW_CREATE", "SYNC_WINDOW", "SYNC_DIR", "FINAL_CALLED", "VERIFY_CALLED"], kinds(ops)
    syncs = [line for line in ops if line.startswith("SYNC ")]
    assert syncs[1].endswith(str(tmp_path / "canon")) and syncs[3].endswith(str(tmp_path / "canon"))  # the DIRECTORY barrier follows each FILE barrier
    assert (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file() and (tmp_path / "canon/R1A-ATTEMPT-WINDOW").is_file()


@pytest.mark.parametrize("fail_n,label", [(1, "marker file"), (2, "marker parent directory")])
def test_a_marker_durability_failure_is_a_consumed_fail_with_no_window_observation_or_retry(tmp_path: Path, fail_n: int, label: str) -> None:
    result, ops = run_attempt(tmp_path, fail_sync_n=fail_n)
    assert "rc=1" in result.stdout, label
    assert "R1A_ATTEMPT_CONSUMED=YES" in result.stdout and "R1A_RERUN_ALLOWED=NO" in result.stdout and "R1A_ATTEMPT_CONSUMED=NO" not in result.stdout
    assert "R1A_EVENT_WINDOW_OPEN=YES" not in result.stdout and "R1A_MARKER_NOT_DURABLE" in result.stderr
    got = kinds(ops)
    assert "WINDOW_START_SAMPLE" not in got and "CHATTR" not in got and "OBSERVE_ENTER" not in got  # nothing past the barrier ran: no start sample, no observation
    assert got[0] == "MARKER_CREATE" and got.index("MARKER_CREATE") < got.index("SYNC_MARKER" if fail_n == 1 else "SYNC_DIR")
    assert (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file()  # never deleted, reset or rewritten
    assert "rerun_rc=1" in result.stdout and "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr  # no retry
    assert got.count("MARKER_CREATE") == 1


@pytest.mark.parametrize("fail_n,label", [(3, "window record file"), (4, "window record parent directory")])
def test_a_window_record_durability_failure_never_runs_final_or_verify(tmp_path: Path, fail_n: int, label: str) -> None:
    result, ops = run_attempt(tmp_path, fail_sync_n=fail_n)
    assert "rc=1" in result.stdout, label
    assert "R1A_RESULT=FAIL" in result.stdout and "R1A_ATTEMPT_CONSUMED=YES" in result.stdout and "R1A_RERUN_ALLOWED=NO" in result.stdout and "R1A_RESULT=PASS" not in result.stdout
    got = kinds(ops)
    assert "FINAL_CALLED" not in got and "VERIFY_CALLED" not in got and "PRESERVE:windowrecord" in got  # evidence preserved, verifier never ran
    assert got.index("WINDOW_CREATE") < got.index("SYNC_WINDOW")  # the record is written BEFORE its barrier
    assert (tmp_path / "canon/R1A-GLOBAL-ATTEMPT-CONSUMED").is_file() and (tmp_path / "canon/R1A-ATTEMPT-WINDOW").is_file()  # nothing deleted
    assert "rerun_rc=1" in result.stdout and "R1A_ATTEMPT_ALREADY_CONSUMED" in result.stderr and got.count("MARKER_CREATE") == 1  # no retry


def test_a_missing_canonical_directory_is_created_once_and_its_parent_entry_is_made_durable_before_any_marker(tmp_path: Path) -> None:
    result, ops = run_attempt(tmp_path, precreate_canon=False, second_run=False)
    assert "rc=0" in result.stdout, result.stderr
    got = kinds(ops)
    assert got[:2] == ["SYNC_DIR", "MARKER_CREATE"]  # the new directory's parent barrier precedes the exclusive marker creation
    assert ops[[i for i, line in enumerate(ops) if line.startswith("SYNC ")][0]].endswith(str(tmp_path))  # that first barrier is on the PARENT of the canonical directory
    failed, ops2 = run_attempt(tmp_path / "second", fail_sync_n=1, precreate_canon=False, second_run=False) if (tmp_path / "second").mkdir() is None else (None, [])
    assert "R1A_ATTEMPT_CONSUMED=NO" in failed.stdout and "R1A_CANONICAL_DIR_ENTRY_NOT_DURABLE" in failed.stderr  # nothing consumed yet: no marker exists
    assert "MARKER_CREATE" not in kinds(ops2) and not (tmp_path / "second/canon/R1A-GLOBAL-ATTEMPT-CONSUMED").exists()


def test_the_durability_helper_is_a_real_sync_never_a_sleep_and_nothing_deletes_canonical_state() -> None:
    lib = LIB.read_text()
    start = lib.index("r1a_fsync() {")
    helper = lib[start:lib.index("# r1a_attempt_unconsumed AUTH_DIR")]
    assert "sync --" in helper and "sleep" not in helper and "|| true" not in helper and "R1A_DURABILITY_BARRIER_FAILED" in helper
    code = "\n".join(base.code_lines(LIB))
    assert not re.search(r"\b(rm|unlink|truncate|mv|shred)\b", code) and "chattr -i" not in code
    assert re.search(r'^\s*R1A_CANONICAL_DIR=/var/lib/aegis-idea3-governance$', lib, re.M)  # canonical path unchanged
    assert not Path("/var/lib/aegis-idea3-governance").exists()  # the tests never created anything under the real path


def test_the_seam_is_the_only_way_tests_reach_the_marker_and_the_real_path_is_never_used(tmp_path: Path) -> None:
    result, ops = run_attempt(tmp_path, second_run=False)
    synced = [line.split(" ", 2)[2] for line in ops if line.startswith("SYNC ")]
    assert synced and all(path.startswith(str(tmp_path)) for path in synced)  # every barrier targeted the temp seam, never /var/lib
