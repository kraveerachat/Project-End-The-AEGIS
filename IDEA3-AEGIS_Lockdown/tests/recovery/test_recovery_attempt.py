"""Hermetic tests of the Recovery ONE-ATTEMPT state machine, the single canonical durable marker, the pre-marker owner-reason gate and the pinned normal-path D4 boundary.

The library is sourced with an EMPTY privilege prefix; the canonical governance directory is a TEST-ONLY seam under a temporary directory; every hook is a recording stub or the real function driven against
stub programs. Nothing here runs Recovery, touches Production, nft, MQTT, a service, a socket or an ESP32."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import recovery_support as sup  # noqa: E402

LIB, RUNNER = sup.LIB, sup.RUNNER
MARKER = "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
REAL = {name: shutil.which(name) for name in ("sync", "chattr", "bash", "date")}
VENV_PY = sys.executable

HOOKS = """
LOGF="$1"
CANON="$2"
WORK="$3"
mark() { echo "$1" >> "$LOGF"; }
has_marker() { [ -e "$CANON/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" ] && echo yes || echo no; }
recovery_hook_pregates() { mark "pregates:marker=$(has_marker)"; [ "${FAIL_AT:-}" != pregates ]; }
recovery_hook_baseline() { mark "baseline:marker=$(has_marker)"; [ "${FAIL_AT:-}" != baseline ]; }
recovery_hook_regate() { mark "regate:marker=$(has_marker)"; [ "${FAIL_AT:-}" != regate ]; }
recovery_hook_isolate() { mark "isolate:marker=$(has_marker)"; [ "${FAIL_AT:-}" != isolate ]; }
recovery_hook_d4() { mark "d4:marker=$(has_marker)"; [ "${FAIL_AT:-}" != d4 ]; }
recovery_hook_restore_status() { mark "restore_status"; [ "${FAIL_AT:-}" != restore_status ]; }
recovery_hook_close() { mark "close"; [ "${FAIL_AT:-}" != close ]; }
recovery_hook_final() { mark "final"; [ "${FAIL_AT:-}" != final ]; }
recovery_hook_verify() { mark "verify"; [ "${FAIL_AT:-}" != verify ]; }
recovery_hook_preserve_evidence() { mark "preserve:$1"; }
"""


def attempt(tmp_path: Path, fail_at: str = "", *, hooks: str = HOOKS, pre: str = "", second: bool = False, env: dict[str, str] | None = None):
    canon = tmp_path / "canon"
    log = tmp_path / "hooks.log"
    body = 'recovery_run_attempt; echo "rc=$?"\n' + ('recovery_run_attempt; echo "rerun_rc=$?"\n' if second else "")
    script = f'{sup.seam(tmp_path)}{pre}. "{LIB}"\nSUDO=""\n{hooks}\n{body}'
    result = subprocess.run([REAL["bash"], "-c", script, "x", str(log), str(canon), str(canon / "recovery-x")], env={**os.environ, "FAIL_AT": fail_at, **(env or {})}, text=True, capture_output=True)
    return result, (log.read_text().split() if log.exists() else [])


# --------------------------------------------------------------------------- the ordered state machine and its claim lines


def test_success_orders_every_pre_gate_before_the_marker_and_the_marker_immediately_before_isolate(tmp_path: Path) -> None:
    result, calls = attempt(tmp_path)
    assert "rc=0" in result.stdout, result.stderr
    assert calls == ["pregates:marker=no", "baseline:marker=no", "regate:marker=no", "isolate:marker=yes", "d4:marker=yes", "restore_status", "close", "final", "verify"]
    out = result.stdout
    assert out.index("RECOVERY_ATTEMPT_CONSUMED=NO") < out.index("RECOVERY_LIVE_EXECUTED=YES RECOVERY_ATTEMPT_CONSUMED=YES RECOVERY_RERUN_ALLOWED=NO") < out.index("RECOVERY_RESULT=PASS")
    marker = (tmp_path / "canon" / MARKER).read_text()
    assert "RECOVERY_ATTEMPT_CONSUMED=YES" in marker and "RECOVERY_RERUN_ALLOWED=NO" in marker and f"work={tmp_path}/canon/recovery-x" in marker and re.search(r"consumed_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", marker)


def test_no_live_or_executed_claim_is_printed_before_the_marker_and_no_closed_pass_is_ever_printed(tmp_path: Path) -> None:
    result, _ = attempt(tmp_path)
    before_marker = result.stdout.split("RECOVERY_LIVE_EXECUTED=YES", 1)[0]
    assert "RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO" in before_marker
    assert "RECOVERY_R2_R8_EXECUTED=YES" not in before_marker
    assert "RECOVERY_R2_R8_EXECUTED=YES" in result.stdout and "RECOVERY_PROMOTION=NOT_AUTOMATIC" in result.stdout
    assert "CLOSED_PASS" not in result.stdout + result.stderr
    for path in sup.RECOVERY_FILES:
        assert "CLOSED_PASS" not in "\n".join(sup.code_lines(path)), path  # the canonical live closeout token is reserved for a reviewed closeout receipt
    assert "LVR_PROVEN=NO" in "\n".join(sup.code_lines(LIB)) and "L8_ACCEPTANCE=NO" in "\n".join(sup.code_lines(LIB)) and "R1B_RESULT=FAIL_IMMUTABLE" in "\n".join(sup.code_lines(LIB))


@pytest.mark.parametrize("stage", ["pregates", "baseline", "regate"])
def test_pre_attempt_failures_do_not_consume_the_marker_or_mutate_anything(tmp_path: Path, stage: str) -> None:
    result, calls = attempt(tmp_path, fail_at=stage)
    assert "rc=1" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=NO" in result.stdout and "RECOVERY_LIVE_EXECUTED=YES" not in result.stdout
    assert not (tmp_path / "canon" / MARKER).exists()
    assert not any(c.startswith(("isolate", "d4", "restore_status", "close", "final", "verify")) for c in calls)  # no mutation hook ran


@pytest.mark.parametrize("stage", ["isolate", "d4", "restore_status", "close", "final", "verify"])
def test_any_post_marker_failure_is_consumed_immutable_preserved_and_never_retried(tmp_path: Path, stage: str) -> None:
    result, calls = attempt(tmp_path, fail_at=stage)
    assert "rc=1" in result.stdout
    assert f"RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE={stage} RECOVERY_LIVE_EXECUTED=YES RECOVERY_ATTEMPT_CONSUMED=YES RECOVERY_RERUN_ALLOWED=NO" in result.stdout
    assert "RECOVERY_RESULT=PASS" not in result.stdout and "RECOVERY_R2_R8_EXECUTED=YES" not in result.stdout
    assert calls[-1] == f"preserve:{stage}" and (tmp_path / "canon" / MARKER).is_file()
    for hook in ("isolate", "d4", "restore_status", "close", "final", "verify"):  # every hook ran at most once: there is no retry loop anywhere
        assert sum(c.split(":")[0] == hook for c in calls) <= 1
    order = ["isolate", "d4", "restore_status", "close", "final", "verify"]
    assert not any(c.split(":")[0] in order[order.index(stage) + 1:] for c in calls)  # nothing after the failing stage runs


def test_a_second_attempt_on_a_consumed_marker_is_refused_before_any_hook(tmp_path: Path) -> None:
    attempt(tmp_path, fail_at="close")
    (tmp_path / "hooks.log").unlink()
    result, calls = attempt(tmp_path)
    assert "rc=1" in result.stdout and "RECOVERY_ATTEMPT_ALREADY_CONSUMED" in result.stderr and calls == []
    assert "RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_R2_R8_EXECUTED=NO (refused before any hook)" in result.stdout


@pytest.mark.parametrize("kind", ["file", "symlink", "dangling"])
def test_an_existing_marker_of_any_kind_refuses_and_is_never_altered(tmp_path: Path, kind: str) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    marker = canon / MARKER
    if kind == "file":
        marker.write_text("owner-kept\n")
    elif kind == "symlink":
        (canon / "elsewhere").write_text("x")
        marker.symlink_to(canon / "elsewhere")
    else:
        marker.symlink_to(canon / "nowhere")
    before = os.lstat(marker).st_ino
    result, calls = attempt(tmp_path)
    assert "rc=1" in result.stdout and "RECOVERY_ATTEMPT_ALREADY_CONSUMED" in result.stderr and calls == []
    assert os.lstat(marker).st_ino == before and (kind != "file" or marker.read_text() == "owner-kept\n")


def test_the_exclusive_create_is_the_ultimate_authority_when_a_marker_appears_after_the_check(tmp_path: Path) -> None:
    hooks = HOOKS.replace('recovery_hook_regate() { mark "regate:marker=$(has_marker)"; [ "${FAIL_AT:-}" != regate ]; }',
                          'recovery_hook_regate() { mark "regate:marker=$(has_marker)"; mkdir -p -m 700 "$CANON"; printf "raced\\n" > "$CANON/RECOVERY-GLOBAL-ATTEMPT-CONSUMED"; }')
    result, calls = attempt(tmp_path, hooks=hooks)
    assert "rc=1" in result.stdout and "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=marker" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=YES" in result.stdout
    assert (tmp_path / "canon" / MARKER).read_text() == "raced\n"  # never overwritten
    assert not any(c.startswith("isolate") for c in calls)


def test_there_is_exactly_one_marker_implementation_and_no_code_removes_or_rewrites_it() -> None:
    lib = "\n".join(sup.code_lines(LIB))
    assert lib.count("RECOVERY-GLOBAL-ATTEMPT-CONSUMED") == 1 and lib.count('set -o noclobber; printf "RECOVERY_ATTEMPT_CONSUMED=YES') == 1
    stage_py = (sup.ROOT / "aegis_soc/recovery_stage.py").read_text()
    assert "def consume_attempt" not in stage_py and "recovery-attempt/1" not in stage_py and "RECOVERY-GLOBAL-ATTEMPT-CONSUMED" not in stage_py  # the Python side only READS the marker
    runner = "\n".join(sup.code_lines(RUNNER))
    assert "recovery_consume_attempt" not in runner  # Recovery attempt consumption remains exclusively in the reviewed library.
    assert "RECOVERY-GLOBAL-ATTEMPT-CONSUMED" not in runner or "AEGIS_RCVSTAGE_ATTEMPT_MARKER" in runner
    for path in sup.RECOVERY_FILES:
        assert not re.search(r"\brm\b|unlink|truncate|\bshred\b|chattr -i|\bmv\b", "\n".join(sup.code_lines(path))), path
    assert not re.search(r"RECOVERY-GLOBAL-ATTEMPT-CONSUMED", "\n".join(sup.code_lines(sup.STG / "apply.sh")))  # no handler creates a second marker
    assert re.search(r"^\s*RECOVERY_CANONICAL_DIR=/var/lib/aegis-idea3-governance$", LIB.read_text(), re.M)


def test_the_canonical_location_cannot_be_substituted_by_env_config_or_a_successor_runner(tmp_path: Path) -> None:
    other = tmp_path / "elsewhere"
    result = subprocess.run(["bash", "-c", f'export RECOVERY_CANONICAL_DIR="{other}"; . "{LIB}"; recovery_canonical_dir'], text=True, capture_output=True)
    assert result.stdout == "/var/lib/aegis-idea3-governance"  # the readonly constant overrides the environment
    half = subprocess.run(["bash", "-c", f'export RECOVERY_TEST_ONLY_CANONICAL_DIR="{other}"; . "{LIB}"; recovery_canonical_dir'], text=True, capture_output=True)
    assert half.stdout == "/var/lib/aegis-idea3-governance"  # a half-set seam is ignored
    assert subprocess.run(["bash", "-c", f'. "{LIB}"; RECOVERY_CANONICAL_DIR=/x'], text=True, capture_output=True).returncode != 0  # readonly


def test_the_canonical_directory_must_be_a_private_real_trusted_directory(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o770)
    canon.chmod(0o770)
    result, calls = attempt(tmp_path)
    assert "rc=1" in result.stdout and "RECOVERY_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED" in result.stderr and calls == []
    canon.chmod(0o700)
    other = tmp_path / "real"
    other.mkdir(mode=0o700)
    canon.rmdir()
    canon.symlink_to(other)
    result, calls = attempt(tmp_path)
    assert "rc=1" in result.stdout and "RECOVERY_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED" in result.stderr and calls == []
    canon.unlink()
    (tmp_path / "evil-parent").mkdir(mode=0o777)
    (tmp_path / "evil-parent").chmod(0o777)
    script = f'export RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RECOVERY_TEST_ONLY_CANONICAL_DIR="{tmp_path}/evil-parent/canon" RECOVERY_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; recovery_canonical_dir_valid'
    bad = subprocess.run(["bash", "-c", script], text=True, capture_output=True)
    assert bad.returncode == 1 and "RECOVERY_CANONICAL_DIR_PARENT_NOT_TRUSTED" in bad.stderr  # a group/world-writable parent of a not-yet-existing directory


# --------------------------------------------------------------------------- durability: parent barrier on EVERY invocation, then marker file, then directory; chattr only after durability


def shims(tmp_path: Path) -> tuple[Path, Path]:
    shim = tmp_path / "shim"
    shim.mkdir()
    oplog = tmp_path / "ops.log"
    (shim / "sync").write_text(
        f'#!/bin/sh\nn=$(grep -c "^SYNC " "{oplog}" 2>/dev/null); n=$((n + 1)); eval "path=\\${{$#}}"\nprintf "SYNC %s %s\\n" "$n" "$path" >> "{oplog}"\n[ "$n" = "${{FAIL_SYNC_N:-0}}" ] && exit 1\nexec {REAL["sync"]} "$@"\n')
    (shim / "chattr").write_text(f'#!/bin/sh\nprintf "CHATTR\\n" >> "{oplog}"\nexit 0\n')
    (shim / "bash").write_text(f'#!/bin/sh\ncase "$*" in *{MARKER}*) printf "MARKER_CREATE\\n" >> "{oplog}";; esac\nexec {REAL["bash"]} "$@"\n')
    for name in ("sync", "chattr", "bash"):
        (shim / name).chmod(0o755)
    return shim, oplog


def kinds(ops: list[str]) -> list[str]:
    out = []
    for line in ops:
        if line.startswith("SYNC "):
            name = line.split(" ", 2)[2].rsplit("/", 1)[-1]
            out.append("SYNC_MARKER" if name == MARKER else "SYNC_DIR" if name == "canon" else "SYNC_PARENT")
        elif line in ("MARKER_CREATE", "CHATTR"):
            out.append(line)
    return out


HOOKS_LOGGING_TO_OPS = HOOKS.replace('mark "isolate:marker=$(has_marker)"', 'echo ISOLATE >> "$OPLOG"; mark "isolate:marker=$(has_marker)"')


def durable_attempt(tmp_path: Path, *, fail_sync_n: int = 0, precreate: bool = True, second: bool = False):
    shim, oplog = shims(tmp_path)
    if precreate:
        (tmp_path / "canon").mkdir(mode=0o700)
    result, calls = attempt(tmp_path, hooks=HOOKS_LOGGING_TO_OPS, pre=f'export OPLOG="{oplog}"\n', second=second, env={"PATH": f"{shim}:{os.environ['PATH']}", "FAIL_SYNC_N": str(fail_sync_n)})
    return result, calls, (oplog.read_text().split("\n") if oplog.exists() else [])


def test_the_durable_order_is_parent_marker_create_marker_file_directory_chattr_then_isolate(tmp_path: Path) -> None:
    result, calls, ops = durable_attempt(tmp_path)
    assert "rc=0" in result.stdout, result.stderr
    assert kinds(ops) == ["SYNC_PARENT", "MARKER_CREATE", "SYNC_MARKER", "SYNC_DIR", "CHATTR"]
    assert ops.index("ISOLATE") > max(i for i, line in enumerate(ops) if line in ("CHATTR",) or line.startswith("SYNC"))  # ISOLATE only after every barrier and the immutability step
    syncs = [line for line in ops if line.startswith("SYNC ")]
    assert syncs[0].endswith(str(tmp_path)) and syncs[2].endswith(str(tmp_path / "canon"))  # the parent barrier first; the directory barrier follows the file barrier


@pytest.mark.parametrize("fail_n,label", [(2, "marker file"), (3, "marker directory")])
def test_a_marker_durability_failure_is_a_consumed_fail_with_no_isolate_and_no_retry(tmp_path: Path, fail_n: int, label: str) -> None:
    result, calls, ops = durable_attempt(tmp_path, fail_sync_n=fail_n, second=True)
    assert "rc=1" in result.stdout and "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=marker" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=YES" in result.stdout and "RECOVERY_RERUN_ALLOWED=NO" in result.stdout
    assert "ISOLATE" not in ops and "CHATTR" not in ops and not any(c.startswith("isolate") for c in calls)
    assert "RECOVERY_MARKER_NOT_DURABLE" in result.stderr and (tmp_path / "canon" / MARKER).is_file()  # never deleted
    assert "rerun_rc=1" in result.stdout and "RECOVERY_ATTEMPT_ALREADY_CONSUMED" in result.stderr and ops.count("MARKER_CREATE") == 1  # no retry


def test_a_failed_parent_barrier_is_unconsumed_and_the_retry_syncs_the_parent_again_before_the_marker(tmp_path: Path) -> None:
    result, calls, ops = durable_attempt(tmp_path, fail_sync_n=1, precreate=False, second=True)
    assert result.stdout.count("rc=1") == 1 and "RECOVERY_CANONICAL_DIR_ENTRY_NOT_DURABLE" in result.stderr and "rerun_rc=0" in result.stdout
    got = kinds(ops)
    assert got[:3] == ["SYNC_PARENT", "SYNC_PARENT", "MARKER_CREATE"] and got.count("MARKER_CREATE") == 1  # the retry (existing directory) performed the parent barrier AGAIN
    first_run = result.stdout.split("rerun_rc=")[0]
    assert "RECOVERY_PRE_ATTEMPT_FAILURE=marker RECOVERY_LIVE_EXECUTED=NO RECOVERY_ATTEMPT_CONSUMED=NO" in first_run  # nothing consumed, truthfully


def test_a_parent_barrier_failure_on_an_existing_directory_leaves_no_marker_and_no_isolate(tmp_path: Path) -> None:
    result, calls, ops = durable_attempt(tmp_path, fail_sync_n=1)
    assert "rc=1" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=YES" not in result.stdout and not (tmp_path / "canon" / MARKER).exists()
    assert kinds(ops) == ["SYNC_PARENT"] and "ISOLATE" not in ops and "MARKER_CREATE" not in ops


# --------------------------------------------------------------------------- the owner reason (C1): validated BEFORE the marker with the real validator, then passed unchanged to D4


def reason_hooks(reason_expr: str) -> str:
    return HOOKS.replace('recovery_hook_pregates() { mark "pregates:marker=$(has_marker)"; [ "${FAIL_AT:-}" != pregates ]; }',
                         f'recovery_hook_pregates() {{ mark "pregates:marker=$(has_marker)"; recovery_reason_gate {reason_expr}; }}')


def reason_attempt(tmp_path: Path, reason: str | None):
    expr = '"$RECOVERY_REASON"' if reason is not None else ""
    pre = f'export PY="{VENV_PY}" VERIFIER_SNAPSHOT_DIR="{sup.ROOT}"\n' + (f"RECOVERY_REASON={shell_quote(reason)}\n" if reason is not None else "")
    return attempt(tmp_path, hooks=reason_hooks(expr), pre=pre)


def shell_quote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


@pytest.mark.parametrize("reason", [None, "", "   ", "x", "a" * 241, "contains $(touch HACKED) subshell", "back`tick`", "slash\\x", "line\nbreak"])
def test_a_missing_or_invalid_reason_fails_before_the_marker_and_before_any_mutation(tmp_path: Path, reason) -> None:
    result, calls = reason_attempt(tmp_path, reason)
    assert "rc=1" in result.stdout and "RECOVERY_PRE_ATTEMPT_FAILURE=pregates" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=NO" in result.stdout
    assert not (tmp_path / "canon" / MARKER).exists() and calls == ["pregates:marker=no"]
    assert not (Path.cwd() / "HACKED").exists() and not (tmp_path / "HACKED").exists()  # no evaluation of the reason


def test_a_valid_reason_reaches_the_marker_stage_and_a_leading_dash_is_not_an_option(tmp_path: Path) -> None:
    for reason in ("Owner-approved normal restore after containment", "-leading dash is just text for the validator"):
        sub = tmp_path / reason[:4].strip("-").lower()
        sub.mkdir()
        result, calls = reason_attempt(sub, reason)
        assert "rc=0" in result.stdout, result.stderr
        assert (sub / "canon" / MARKER).is_file()


def test_the_frozen_runner_requires_the_reason_argument_before_anything_runs_and_validates_it_in_the_pregates(tmp_path: Path) -> None:
    frozen = sup.pinned_copy(tmp_path)
    clean = "env -u AEGIS_LOG_PATH -u AEGIS_DB_PATH"
    assert sup.bash(f'{clean} bash "{frozen}" "{tmp_path}"').returncode == 2 and "owner reason" in sup.bash(f'{clean} bash "{frozen}" "{tmp_path}"').stderr
    assert not (tmp_path / "evidence").exists()
    pregates = sup.runner_function("recovery_pregates")
    assert 'recovery_reason_gate "$RECOVERY_REASON"' in pregates and pregates.index("recovery_reason_gate") > pregates.index("recovery_authority_gates")  # after the verifier snapshot is proven
    assert "recovery_attempt_unconsumed" in pregates


# --------------------------------------------------------------------------- D4: the pinned normal-path program, ONE invocation, no secret anywhere


def fake_release(tmp_path: Path, exit_code: int = 0) -> Path:
    release = tmp_path / "release"
    (release / "venv/bin").mkdir(parents=True)
    (release / "aegis_soc").mkdir()
    py = release / "venv/bin/python"
    py.write_text(f'#!/bin/sh\n{{ echo "ARGV:$*"; echo "CWD:$(pwd)"; env | sort | sed "s/^/ENV:/"; echo "STDIN:$(head -n1)"; }} >> "{tmp_path / "d4.rec"}"\necho "TERMINAL-OUTPUT-PROMPT"\necho "TERMINAL-ERR" >&2\nexit {exit_code}\n')
    py.chmod(0o755)
    return release


D4_ENV = 'RELEASE_PATH="{release}"; RUNTIME_DIR=/run/pinned-runtime; RECOVERY_D4_LOG="{log}"; RECOVERY_REASON={reason}; RECOVERY_D4_OUT_FD=3; RECOVERY_D4_ERR_FD=4'


def d4(tmp_path: Path, *, exit_code: int = 0, stdin: str = "", hostile_env: dict[str, str] | None = None):
    release = fake_release(tmp_path, exit_code)
    term_out, term_err = tmp_path / "tty.out", tmp_path / "tty.err"
    script = f'. "{LIB}"; SUDO=""; {D4_ENV.format(release=release, log=tmp_path / 'd4-cli.log', reason=shell_quote("Owner-approved normal restore"))}\nrecovery_d4_run 3>"{term_out}" 4>"{term_err}"; echo "rc=$?"'
    result = subprocess.run(["bash", "-c", script], input=stdin, env={**os.environ, **(hostile_env or {})}, text=True, capture_output=True)
    rec = (tmp_path / "d4.rec").read_text() if (tmp_path / "d4.rec").exists() else ""
    return result, rec, term_out, term_err


def test_d4_runs_the_pinned_release_program_once_with_the_exact_reason_and_normal_path_arguments(tmp_path: Path) -> None:
    result, rec, term_out, term_err = d4(tmp_path)
    assert "rc=0" in result.stdout
    assert rec.count("ARGV:") == 1
    assert f"ARGV:-B -s -m aegis_soc.cli restore --reason=Owner-approved normal restore --wait {sup.bash('. ' + str(LIB) + '; echo $RECOVERY_D4_WAIT_SECONDS').stdout.strip()}" in rec
    assert f"CWD:{tmp_path / 'release'}" in rec
    assert "--break-glass" not in rec and "break" not in rec.split("ENV:")[0].lower()


def test_d4_output_goes_to_the_terminal_descriptors_never_to_the_run_log(tmp_path: Path) -> None:
    result, _, term_out, term_err = d4(tmp_path)
    assert "TERMINAL-OUTPUT-PROMPT" in term_out.read_text() and "TERMINAL-ERR" in term_err.read_text()
    assert "TERMINAL-OUTPUT-PROMPT" not in result.stdout and "TERMINAL-ERR" not in result.stderr  # a tee'd log would never see the secret prompt


def test_d4_receives_stdin_untouched_the_secret_is_never_captured_logged_or_placed_in_argv_or_env(tmp_path: Path) -> None:
    secret = "D4-OWNER-SECRET-hunter2"
    result, rec, term_out, term_err = d4(tmp_path, stdin=f"{secret}\nRESTORE UPLINK\n")
    assert f"STDIN:{secret}" in rec  # the program reads the terminal stdin directly (passed through, not re-fed)
    argv_and_env = "\n".join(line for line in rec.splitlines() if line.startswith(("ARGV:", "ENV:")))
    assert secret not in argv_and_env and secret not in result.stdout and secret not in result.stderr and secret not in term_out.read_text()
    code = "\n".join(sup.code_lines(LIB) + sup.code_lines(RUNNER))
    assert "RESTORE UPLINK" not in code and not re.search(r"RECOVERY_RESTORE_CONFIRMATION=", code)  # no self-proving confirmation variable: the real program's own interactive prompt is authoritative
    assert 'exec 3>&1 4>&2' in code and code.index("exec 3>&1 4>&2") < code.index("tee -a")  # the terminal descriptors are saved BEFORE the run log tee is installed


def test_d4_environment_is_clean_pinned_and_immune_to_interpreter_and_path_redirection(tmp_path: Path) -> None:
    hostile = {"PYTHON": "/tmp/evil", "PYTHONPATH": "/tmp/evil", "PYTHONHOME": "/tmp/evil", "PYTHONSTARTUP": "/tmp/evil.py", "LD_PRELOAD": "/tmp/evil.so", "AEGIS_RUNTIME_DIR": "/tmp/attacker-runtime", "BASH_ENV": "/tmp/evil.sh"}
    result, rec, _, _ = d4(tmp_path, hostile_env=hostile)
    env_lines = [line[4:] for line in rec.splitlines() if line.startswith("ENV:")]
    names = {line.split("=", 1)[0] for line in env_lines}
    assert names <= {"PATH", "HOME", "TERM", "LANG", "AEGIS_RUNTIME_DIR", "AEGIS_LOG_PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "PWD", "SHLVL", "_", "OLDPWD", "LC_CTYPE"}, names
    assert "AEGIS_RUNTIME_DIR=/run/pinned-runtime" in env_lines and "PATH=/usr/sbin:/usr/bin:/sbin:/bin" in env_lines  # the PINNED runtime dir and a FIXED path
    assert not any(name in names for name in hostile if name != "AEGIS_RUNTIME_DIR")


@pytest.mark.parametrize("var", ["PYTHON", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "AEGIS_P4_FS_ROOT", "AEGIS_RECOVERY_SOCKET", "RECOVERY_SECRET", "AEGIS_RCVSTAGE_SECRET",
                                 "RECOVERY_RESTORE_CONFIRMATION", "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED", "RECOVERY_TEST_ONLY_TRUST_ROOT", "AEGIS_LOG_PATH", "AEGIS_DB_PATH"])
def test_the_environment_gate_refuses_every_redirection_variable(tmp_path: Path, var: str) -> None:
    base = {k: v for k, v in os.environ.items() if k not in ("AEGIS_LOG_PATH", "AEGIS_DB_PATH")}  # the pytest conftest sets these two; the live gate refuses them
    result = subprocess.run(["bash", "-c", f'. "{LIB}"; recovery_env_gate'], env={**base, var: "x"}, text=True, capture_output=True)
    assert result.returncode == 1 and f"RECOVERY_ENVIRONMENT_OVERRIDE_SET:{var}" in result.stderr
    assert subprocess.run(["bash", "-c", f'. "{LIB}"; recovery_env_gate'], text=True, capture_output=True, env={k: v for k, v in base.items() if k != var}).returncode == 0


@pytest.mark.parametrize("code", [1, 2, 4, 7])
def test_d4_exit_1_2_4_and_unexpected_are_terminal_d4_is_invoked_exactly_once_and_nothing_resends(tmp_path: Path, code: int) -> None:
    import recovery_ladder as helper

    steps = helper.steps_to_post_isolate(tmp_path)
    release = fake_release(tmp_path, code)
    hooks = HOOKS.replace('recovery_hook_d4() { mark "d4:marker=$(has_marker)"; [ "${FAIL_AT:-}" != d4 ]; }', f'RECOVERY_D4_LOG="{tmp_path}/d4-cli.log"')  # the REAL d4 hook, driven with the REAL record-d4 command
    pre = (f'export PY="{VENV_PY}" VERIFIER_SNAPSHOT_DIR="{sup.ROOT}"; STEPS="{steps}"; RELEASE_PATH="{release}"; RUNTIME_DIR=/run/x; RECOVERY_REASON="Owner-approved normal restore"\n'
           'recovery_hook_isolate() { mark isolate; }\n')
    result, calls = attempt(tmp_path, hooks=hooks, pre=pre)
    assert "rc=1" in result.stdout and "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=d4" in result.stdout
    assert (tmp_path / "d4.rec").read_text().count("ARGV:") == 1  # D4 invoked exactly once, never retried
    assert "restore_status" not in calls and "close" not in calls and "final" not in calls  # a terminal D4 stops the whole ladder


@pytest.mark.parametrize("code", [0, 3])
def test_d4_exit_0_and_3_continue_into_read_only_reconciliation_without_a_resend(tmp_path: Path, code: int) -> None:
    import recovery_ladder as helper

    steps = helper.steps_to_post_isolate(tmp_path)
    release = fake_release(tmp_path, code)
    hooks = HOOKS.replace('recovery_hook_d4() { mark "d4:marker=$(has_marker)"; [ "${FAIL_AT:-}" != d4 ]; }', f'RECOVERY_D4_LOG="{tmp_path}/d4-cli.log"')
    pre = (f'export PY="{VENV_PY}" VERIFIER_SNAPSHOT_DIR="{sup.ROOT}"; STEPS="{steps}"; RELEASE_PATH="{release}"; RUNTIME_DIR=/run/x; RECOVERY_REASON="Owner-approved normal restore"\n'
           'recovery_hook_isolate() { mark isolate; }\n')
    result, calls = attempt(tmp_path, hooks=hooks, pre=pre)
    assert "rc=0" in result.stdout, result.stderr
    assert calls.count("restore_status") == 1 and (tmp_path / "d4.rec").read_text().count("ARGV:") == 1
    import json

    assert json.loads((Path(steps) / "05-d4.json").read_text())["exit_code"] == code


# --------------------------------------------------------------------------- the pinned program gates (release CLI + interpreter), the interpreter gate and the predecessor gate


def release_tree(tmp_path: Path) -> tuple[Path, str]:
    import hashlib

    release = tmp_path / "rel"
    (release / "aegis_soc").mkdir(parents=True)
    (release / "venv/bin").mkdir(parents=True)
    cli = release / "aegis_soc/cli.py"
    cli.write_text("# cli\n")
    cli.chmod(0o444)
    py = release / "venv/bin/python"
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    for d in (release, release / "aegis_soc"):
        d.chmod(0o755)
    return release, hashlib.sha256(cli.read_bytes()).hexdigest()


def cli_gate(release: Path, sha: str, *, userns: bool = True):
    script = f'. "{LIB}"; recovery_cli_gate "{release}" {sha}'
    return sup.userns_bash(script) if userns else sup.bash(script)


@pytest.mark.skipif(not sup.userns_usable(), reason="user namespace unavailable")
def test_the_pinned_cli_gate_accepts_only_the_exact_root_owned_release_cli(tmp_path: Path) -> None:
    release, sha = release_tree(tmp_path)
    assert cli_gate(release, sha).returncode == 0
    assert cli_gate(release, "0" * 64).returncode == 1  # digest drift
    assert "RECOVERY_CLI_NOT_ROOT_OWNED_OR_WRITABLE" in cli_gate(release, sha, userns=False).stderr  # not root-owned (the test user is not root)
    (release / "aegis_soc/cli.py").chmod(0o666)
    assert "RECOVERY_CLI_NOT_ROOT_OWNED_OR_WRITABLE" in cli_gate(release, sha).stderr  # group/world writable
    (release / "aegis_soc/cli.py").chmod(0o444)
    (release / "aegis_soc/link.py").symlink_to("cli.py")
    assert "RECOVERY_CLI_TREE_SYMLINK_OR_WRITABLE" in cli_gate(release, sha).stderr
    (release / "aegis_soc/link.py").unlink()
    release.chmod(0o775)
    assert "RECOVERY_CLI_NOT_ROOT_OWNED_OR_WRITABLE" in cli_gate(release, sha).stderr
    release.chmod(0o755)
    (release / "aegis_soc/cli.py").chmod(0o644)
    (release / "aegis_soc/cli.py").unlink()
    (release / "aegis_soc/cli.py").symlink_to(release / "venv/bin/python")
    assert cli_gate(release, sha).returncode == 1  # a symlinked cli.py
    assert cli_gate(tmp_path / "missing", sha).returncode == 1 and cli_gate(Path("relative"), sha).returncode == 1


@pytest.mark.skipif(not sup.userns_usable(), reason="user namespace unavailable")
def test_the_interpreter_gate_requires_an_absolute_root_owned_not_writable_regular_file(tmp_path: Path) -> None:
    py = tmp_path / "py"
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    assert sup.userns_bash(f'. "{LIB}"; recovery_interpreter_gate "{py}"').returncode == 0
    py.chmod(0o775)
    assert "RECOVERY_INTERPRETER_NOT_ROOT_OWNED" in sup.userns_bash(f'. "{LIB}"; recovery_interpreter_gate "{py}"').stderr
    py.chmod(0o755)
    assert "RECOVERY_INTERPRETER_NOT_ROOT_OWNED" in sup.bash(f'. "{LIB}"; recovery_interpreter_gate "{py}"').stderr  # owned by the test user, not root
    assert sup.bash(f'. "{LIB}"; recovery_interpreter_gate python3').returncode == 1 and sup.bash(f'. "{LIB}"; recovery_interpreter_gate /nonexistent/python').returncode == 1  # PATH lookup is never accepted
    real = shutil.which("python3")
    expected_ok = Path(real).resolve().stat().st_uid == 0 and not Path(real).resolve().stat().st_mode & 0o022
    assert (sup.bash(f'. "{LIB}"; recovery_interpreter_gate "{real}"').returncode == 0) is expected_ok


def test_the_predecessor_gate_is_the_existing_r1bv_gate_not_a_copy_and_a_failure_is_load_bearing(tmp_path: Path) -> None:
    lib = LIB.read_text()
    assert "recovery_predecessor_gate() { r1bv_recovery_predecessor_gate" in lib and "R1BV_RECOVERY_FORBIDDEN_CLAIM" not in lib and "R1BV_LIVE=CLOSED_PASS" not in lib
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    head = sup.commit_all(repo)  # a pinned commit with NO R1B failure and NO R1Bv PASS receipts
    result = sup.bash(f'. "{LIB}"; recovery_predecessor_gate "{repo}" {head}')
    assert result.returncode == 1 and "R1BV" in result.stderr
    pregates = sup.runner_function("recovery_pregates")
    assert 'recovery_predecessor_gate "$REPO" "$EXPECTED_MAIN" || gate' in pregates
    hooks = HOOKS.replace('recovery_hook_pregates() { mark "pregates:marker=$(has_marker)"; [ "${FAIL_AT:-}" != pregates ]; }', f'recovery_hook_pregates() {{ recovery_predecessor_gate "{repo}" {head}; }}')
    outcome, calls = attempt(tmp_path / "sm", hooks=hooks) if (tmp_path / "sm").mkdir() is None else (None, [])
    assert "RECOVERY_PRE_ATTEMPT_FAILURE=pregates" in outcome.stdout and not (tmp_path / "sm/canon" / MARKER).exists()  # a failing predecessor stops everything before the marker
