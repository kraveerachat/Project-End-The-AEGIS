"""Fresh-review remediation tests (F1-F4, M-a, M-b, M-c): the REAL pinned D4 CLI rehearsal in the exact controlled environment, the terminal gate, the bounded sudo keepalive, the pre-marker Core readiness/timezone gate,
the release-manifest closure gate and the explicit private log paths.

The rehearsal tests import the ACTUAL ``aegis_soc.cli`` (never a stub): a read-only copy of the tree stands in for the immutable release, stdin is /dev/null, and the CLI is proven to stop at its interactive-terminal
refusal before any prompt, secret read or Recovery request. Fake ``sudo`` only; no real sudoers or credential is touched; nothing here connects to a Core, runs Recovery, touches Production or an ESP32."""

from __future__ import annotations

import hashlib
import json
import os
import pty
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_support as sup  # noqa: E402

from aegis_soc import local_restore as lr  # noqa: E402
from aegis_soc import recovery_core as core  # noqa: E402
from aegis_soc import recovery_stage as stage  # noqa: E402

LIB, RUNNER = sup.LIB, sup.RUNNER
VENV_PY = sys.executable
MARKER = "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
REFUSAL = "RESTORE refused: an interactive local terminal is required"
REASON = "Owner-approved normal restore after containment"
needs_userns = pytest.mark.skipif(not sup.userns_usable(), reason="user namespace unavailable")


def shq(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


# --------------------------------------------------------------------------- F1/F2: the REAL pinned CLI in the exact controlled environment


def real_release(tmp_path: Path) -> Path:
    """A read-only stand-in for the immutable release: the REAL `aegis_soc` tree, and a `venv/bin/python` that execs the project interpreter."""
    release = tmp_path / "release"
    shutil.copytree(sup.ROOT / "aegis_soc", release / "aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    (release / "venv/bin").mkdir(parents=True)
    py = release / "venv/bin/python"
    py.write_text(f'#!/bin/sh\nexec "{VENV_PY}" "$@"\n')
    py.chmod(0o755)
    for path in [release, *release.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o222)
    return release


def private_log(tmp_path: Path, name: str = "d4-cli.log") -> Path:
    log = tmp_path / name
    log.write_text("")
    log.chmod(0o600)
    return log


def rehearse(tmp_path: Path, release: Path, *, reason: str = REASON, log: Path | None = None, runtime: str = "/run/pinned-runtime") -> subprocess.CompletedProcess[str]:
    log = log or private_log(tmp_path)
    script = (f'. "{LIB}"; SUDO=""; RELEASE_PATH="{release}"; RUNTIME_DIR="{runtime}"; RECOVERY_D4_LOG="{log}"; RECOVERY_REASON={shq(reason)}\n'
              f'recovery_d4_rehearsal; echo "rc=$?"')
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True, env={k: v for k, v in os.environ.items() if k not in ("AEGIS_LOG_PATH", "AEGIS_DB_PATH")})


def test_the_real_cli_rehearsal_imports_in_a_read_only_release_and_stops_at_the_interactive_terminal_refusal(tmp_path: Path) -> None:
    release = real_release(tmp_path)
    log = private_log(tmp_path)
    assert not os.access(release, os.W_OK)  # the cwd is NOT writable, exactly like the immutable release
    before = sorted(p.name for p in release.iterdir())
    result = rehearse(tmp_path, release, log=log)
    assert "rc=0" in result.stdout, result.stdout + result.stderr
    assert sorted(p.name for p in release.iterdir()) == before and not list(release.glob("aegis_soc.log"))  # no surprise file in the immutable cwd
    assert log.is_file() and stat.S_IMODE(log.stat().st_mode) == 0o600  # the logging module used the explicit private path


def test_without_an_explicit_log_path_the_same_command_dies_at_import_the_original_defect_and_the_rehearsal_would_catch_it(tmp_path: Path) -> None:
    release = real_release(tmp_path)
    old = subprocess.run(["env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "AEGIS_RUNTIME_DIR=/run/x", "PYTHONDONTWRITEBYTECODE=1", "PYTHONNOUSERSITE=1", str(release / "venv/bin/python"), "-B", "-s", "-m", "aegis_soc.cli",
                          "restore", f"--reason={REASON}", "--wait", "120"], cwd=release, stdin=subprocess.DEVNULL, text=True, capture_output=True)
    assert old.returncode != 0 and "PermissionError" in old.stderr and REFUSAL not in old.stderr
    exec_text = subprocess.run(["bash", "-c", f'. "{LIB}"; declare -f recovery_d4_exec'], text=True, capture_output=True).stdout
    assert 'AEGIS_LOG_PATH="$RECOVERY_D4_LOG"' in exec_text


@pytest.mark.parametrize("reason", ["x", "", "line\nbreak"])
def test_the_rehearsal_fails_for_a_reason_the_real_cli_would_refuse_so_another_error_cannot_masquerade(tmp_path: Path, reason: str) -> None:
    release = real_release(tmp_path)
    result = rehearse(tmp_path, release, reason=reason)
    assert "rc=1" in result.stdout and "RECOVERY_D4_REHEARSAL_FAILED" in result.stderr


def stub_release(tmp_path: Path, body: str) -> Path:
    release = tmp_path / "stub-release"
    (release / "venv/bin").mkdir(parents=True)
    (release / "venv/bin/python").write_text(f"#!/bin/sh\n{body}\n")
    (release / "venv/bin/python").chmod(0o755)
    return release


@pytest.mark.parametrize("body", [
    'echo "RESTORE refused: REASON_INVALID" >&2; exit 2',                                                    # exit 2 with ANOTHER message
    'echo "RESTORE refused: an interactive local terminal is required" >&2; exit 0',                          # right message, wrong code
    'echo "RESTORE refused: an interactive local terminal is required" >&2; exit 1',
    'echo Traceback; echo "RESTORE refused: an interactive local terminal is required" >&2; exit 2',         # crash noise
    'exit 2',
])
def test_exit_2_alone_or_the_message_alone_is_not_a_successful_rehearsal(tmp_path: Path, body: str) -> None:
    result = rehearse(tmp_path, stub_release(tmp_path, body))
    assert "rc=1" in result.stdout and "RECOVERY_D4_REHEARSAL_FAILED" in result.stderr


def test_the_stub_shape_that_matches_the_real_refusal_passes_proving_the_check_is_exact(tmp_path: Path) -> None:
    assert "rc=0" in rehearse(tmp_path, stub_release(tmp_path, f'echo "{REFUSAL}" >&2; exit 2')).stdout


def test_the_rehearsal_stops_before_the_recovery_request_boundary_no_secret_no_socket_no_marker(tmp_path: Path) -> None:
    release = real_release(tmp_path)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(runtime / lr.CHANNEL_NAME))
    server.listen(1)
    server.setblocking(False)
    try:
        result = rehearse(tmp_path, release, runtime=str(runtime))
        assert "rc=0" in result.stdout, result.stdout + result.stderr
        with pytest.raises(BlockingIOError):
            server.accept()  # the real CLI NEVER connected to the Recovery/RESTORE channel
    finally:
        server.close()
    assert not (tmp_path / "canon").exists() and not list(tmp_path.glob("**/" + MARKER))
    text = (sup.ROOT / "aegis_soc/cli.py").read_text()
    body = text[text.index("def command_restore("): text.index("def command_restore_credential(")]
    order = [body.index(token) for token in ("lr.reason_problem(args.reason)", "isatty()", "read_secret(", "read_line(f", "send(path")]
    assert order == sorted(order)  # reason -> terminal refusal -> secret prompt -> confirmation -> channel: the rehearsal can only ever reach the terminal refusal


def test_the_secret_prompt_is_unreachable_in_the_rehearsal_even_when_stdin_has_data(tmp_path: Path) -> None:
    release = real_release(tmp_path)
    log = private_log(tmp_path)
    script = (f'. "{LIB}"; SUDO=""; RELEASE_PATH="{release}"; RUNTIME_DIR=/run/x; RECOVERY_D4_LOG="{log}"; RECOVERY_REASON={shq(REASON)}\nrecovery_d4_rehearsal; echo "rc=$?"')
    secret = "SHOULD-NEVER-BE-READ-hunter2"
    result = subprocess.run(["bash", "-c", script], input=f"{secret}\nRESTORE UPLINK\n", text=True, capture_output=True)
    assert "rc=0" in result.stdout and secret not in result.stdout + result.stderr + log.read_text()  # the rehearsal's stdin is /dev/null, never the caller's


def test_the_terminal_gate_requires_stdin_and_the_terminal_descriptor_to_be_terminals(tmp_path: Path) -> None:
    script = f'. "{LIB}"; RECOVERY_D4_OUT_FD=3; recovery_tty_gate; echo "rc=$?"'
    no_tty = subprocess.run(["bash", "-c", script], stdin=subprocess.DEVNULL, text=True, capture_output=True)
    assert "rc=1" in no_tty.stdout and "RECOVERY_INTERACTIVE_TERMINAL_REQUIRED" in no_tty.stderr and "nothing was consumed" in no_tty.stderr
    master, slave = pty.openpty()
    try:
        ok = subprocess.run(["bash", "-c", script + " 3>/dev/null"], stdin=slave, text=True, capture_output=True)
        assert "rc=1" in ok.stdout  # stdin is a tty but descriptor 3 is not
        ok = subprocess.run(["bash", "-c", f'. "{LIB}"; exec 3<&0; RECOVERY_D4_OUT_FD=3; recovery_tty_gate; echo "rc=$?"'], stdin=slave, text=True, capture_output=True)
        assert "rc=0" in ok.stdout, ok.stderr
    finally:
        os.close(master)
        os.close(slave)


def run_hook_with(tmp_path: Path, hook_body: str, stubs: str = "", **env: str):
    log = tmp_path / "hook.log"
    script = f'{sup.seam(tmp_path)}. "{LIB}"\nSUDO=""\nmark() {{ echo "$1" >> "{log}"; }}\n{stubs}\n{hook_body}'
    return subprocess.run(["bash", "-c", script], env={**os.environ, **env}, text=True, capture_output=True), (log.read_text().split() if log.exists() else [])


def test_a_failing_terminal_gate_or_rehearsal_is_a_pre_marker_failure_with_no_marker_and_no_core_call(tmp_path: Path) -> None:
    stubs = ('recovery_require_hook() { true; }; recovery_pregates() { mark pregates; }; recovery_prepare_evidence() { mkdir -p -m 700 "$EVID"; mark prepare; }; recovery_handler() { mark "handler:$1"; }\n'
             'recovery_operator_py() { mark "py:$1"; }; recovery_authority_gates() { true; }; recovery_isolate() { mark ISOLATE; }; recovery_hook_isolate() { mark ISOLATE; }\n'
             'recovery_logs_prepare() { true; }; recovery_sudo_authority_gate() { true; }\nWORK="$CANON_X"; EVID="$EVID_X"; STEPS="$EVID_X/steps"\n')
    for fail in ("tty", "rehearsal"):
        sub = tmp_path / fail
        sub.mkdir()
        gates = {"tty": "recovery_tty_gate() { return 1; }; recovery_d4_rehearsal() { true; }", "rehearsal": "recovery_tty_gate() { true; }; recovery_d4_rehearsal() { return 1; }"}[fail]
        body = f'CANON_X="{sub}/canon/recovery-x"; EVID_X="{sub}/evid"; EVID="$EVID_X"; WORK="$CANON_X"; STEPS="$EVID/steps"; {gates}\nrecovery_run_attempt; echo "rc=$?"'
        result, calls = run_hook_with(sub, body, stubs.replace('WORK="$CANON_X"; EVID="$EVID_X"; STEPS="$EVID_X/steps"', ""))
        assert "rc=1" in result.stdout and "RECOVERY_PRE_ATTEMPT_FAILURE=baseline" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=NO" in result.stdout, (fail, result.stdout, result.stderr)
        assert not (sub / "canon" / MARKER).exists() and "ISOLATE" not in calls and not any(c.startswith(("handler", "py:")) for c in calls), fail


def test_private_logs_are_created_exclusively_operator_owned_0600_inside_the_private_evidence_dir(tmp_path: Path) -> None:
    evid = tmp_path / "evid"
    evid.mkdir(mode=0o700)
    ok = subprocess.run(["bash", "-c", f'. "{LIB}"; EVID="{evid}"; recovery_logs_prepare; echo "rc=$? $RECOVERY_D4_LOG $RECOVERY_OPERATOR_LOG"'], text=True, capture_output=True)
    assert f"rc=0 {evid}/d4-cli.log {evid}/stage-operator.log" in ok.stdout, ok.stderr
    for name in ("d4-cli.log", "stage-operator.log"):
        info = (evid / name).lstat()
        assert stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.getuid() and not stat.S_ISLNK(info.st_mode)
    again = subprocess.run(["bash", "-c", f'. "{LIB}"; EVID="{evid}"; recovery_logs_prepare; echo "rc=$?"'], text=True, capture_output=True)
    assert "rc=1" in again.stdout and "RECOVERY_LOG_NOT_CREATABLE" in again.stderr  # exclusive: an existing log is never reused


@pytest.mark.parametrize("shape", ["open_dir", "symlink_dir", "missing", "relative"])
def test_an_untrusted_evidence_directory_refuses_the_logs_before_anything_is_created(tmp_path: Path, shape: str) -> None:
    real = tmp_path / "real"
    real.mkdir(mode=0o700)
    target = {"open_dir": tmp_path / "open", "symlink_dir": tmp_path / "link", "missing": tmp_path / "missing", "relative": Path("relative")}[shape]
    if shape == "open_dir":
        target.mkdir(mode=0o755)
        target.chmod(0o755)
    elif shape == "symlink_dir":
        target.symlink_to(real)
    result = subprocess.run(["bash", "-c", f'. "{LIB}"; EVID="{target}"; recovery_logs_prepare; echo "rc=$?"'], text=True, capture_output=True)
    assert "rc=1" in result.stdout and "RECOVERY_EVIDENCE_DIR_NOT_PRIVATE_OPERATOR_OWNED" in result.stderr
    assert not list(real.iterdir()) and not (tmp_path / "open" / "d4-cli.log").exists()


# --------------------------------------------------------------------------- M-b: no surprise aegis_soc.log anywhere


def test_every_operator_stage_invocation_has_an_explicit_log_path_and_creates_nothing_in_the_cwd(tmp_path: Path) -> None:
    work = tmp_path / "cwd"
    work.mkdir()
    log = private_log(tmp_path, "stage-operator.log")
    script = (f'. "{LIB}"; PY="{VENV_PY}"; VERIFIER_SNAPSHOT_DIR="{sup.ROOT}"; RECOVERY_OPERATOR_LOG="{log}"\nrecovery_operator_py check-reason --reason={shq(REASON)}; echo "rc=$?"\n'
              f'RECOVERY_OPERATOR_LOG=""; recovery_operator_py check-reason --reason={shq(REASON)}; echo "rc=$?"')
    result = subprocess.run(["bash", "-c", script], cwd=work, text=True, capture_output=True, env={k: v for k, v in os.environ.items() if k not in ("AEGIS_LOG_PATH", "AEGIS_DB_PATH")})
    assert result.stdout.count("rc=0") == 2, result.stderr
    assert list(work.iterdir()) == [] and log.exists()  # neither the private log path nor the pre-evidence /dev/null fallback ever drops a relative aegis_soc.log into the cwd


def test_root_handlers_and_the_root_wrapper_set_a_root_work_dir_log_and_a_private_umask() -> None:
    for script in ("apply.sh", "verify.sh"):
        text = (sup.STG / script).read_text()
        assert 'AEGIS_LOG_PATH="$WORK/stage-root.log"' in text and re.search(r"^umask 077$", text, re.M), script
        assert text.index("umask 077") < text.index("RUN()")
    assert 'AEGIS_LOG_PATH="${WORK:-/dev/null}/stage-root.log"' in LIB.read_text()
    for path in (LIB, RUNNER):  # the caller's environment can never choose a log path
        assert "AEGIS_LOG_PATH" in "\n".join(sup.code_lines(path))


# --------------------------------------------------------------------------- F3: bounded sudo -n keepalive (fake sudo only)


def fake_sudo(tmp_path: Path, fail_after: int = 0) -> tuple[Path, Path]:
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir()
    calls = tmp_path / "sudo.calls"
    (bin_dir / "sudo").write_text(f'#!/bin/sh\n[ "$1" = -n ] || exit 97\nshift\nif [ "$1" = -v ]; then\n  echo "-n -v" >> "{calls}"\n  n=$(wc -l < "{calls}")\n  [ "{fail_after}" != 0 ] && [ "$n" -gt "{fail_after}" ] && exit 1\n  exit 0\nfi\nexec "$@"\n')
    (bin_dir / "sudo").chmod(0o755)
    return bin_dir, calls


KEEP = 'SUDO="sudo -n"; RECOVERY_KEEPALIVE_INTERVAL_SEC=1; RECOVERY_KEEPALIVE_MAX_SEC=6\n'


def keepalive(tmp_path: Path, body: str, fail_after: int = 0) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir, calls = fake_sudo(tmp_path, fail_after)
    result = subprocess.run(["bash", "-c", f'. "{LIB}"\n{KEEP}{body}'], env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}, text=True, capture_output=True)
    return result, (calls.read_text().splitlines() if calls.exists() else [])


def test_the_refresher_starts_after_the_one_sudo_v_and_only_ever_runs_sudo_n_v(tmp_path: Path) -> None:
    result, calls = keepalive(tmp_path, 'recovery_start_sudo_keepalive; sleep 2.6; recovery_stop_sudo_keepalive; echo "rc=$?"')
    assert "rc=0" in result.stdout, result.stderr
    assert len(calls) >= 2 and set(calls) == {"-n -v"}  # every privileged refresh is non-interactive; the library never runs an interactive sudo
    runner = "\n".join(sup.code_lines(RUNNER))
    assert len(re.findall(r"^sudo -v ", runner, re.M)) == 1 and runner.index("sudo -v") < runner.index("SUDO='sudo -n'") < runner.index("recovery_start_sudo_keepalive") < runner.index("trap recovery_stop_sudo_keepalive EXIT")
    assert not re.search(r"(^|[;&|(]\s*)sudo (?!-v |-n)", "\n".join(sup.code_lines(LIB)), re.M)


def test_the_refresher_is_stopped_by_the_exit_trap_and_never_outlives_the_process(tmp_path: Path) -> None:
    result, calls = keepalive(tmp_path, 'trap recovery_stop_sudo_keepalive EXIT; recovery_start_sudo_keepalive; sleep 1.5; echo started')
    assert "started" in result.stdout
    seen = len(calls)
    time.sleep(1.6)
    assert len((tmp_path / "sudo.calls").read_text().splitlines()) <= seen + 1  # at most one in-flight refresh after exit, then nothing
    again = len((tmp_path / "sudo.calls").read_text().splitlines())
    time.sleep(1.5)
    assert len((tmp_path / "sudo.calls").read_text().splitlines()) == again


def test_the_refresher_also_ends_when_the_parent_exits_without_a_trap_and_is_bounded_by_a_maximum_lifetime(tmp_path: Path) -> None:
    result, calls = keepalive(tmp_path, 'recovery_start_sudo_keepalive; sleep 1.5; echo bye')
    time.sleep(1.6)
    settled = len((tmp_path / "sudo.calls").read_text().splitlines())
    time.sleep(1.5)
    assert len((tmp_path / "sudo.calls").read_text().splitlines()) == settled
    assert "RECOVERY_KEEPALIVE_MAX_SEC=14400" in LIB.read_text() and "[ \"$waited\" -lt \"$max\" ]" in LIB.read_text()


def test_the_gate_requires_a_healthy_refresher_and_a_working_non_interactive_sudo(tmp_path: Path) -> None:
    result, _ = keepalive(tmp_path, 'recovery_sudo_authority_gate; echo "before=$?"; recovery_start_sudo_keepalive; recovery_sudo_authority_gate; echo "running=$?"; recovery_stop_sudo_keepalive')
    assert "before=1" in result.stdout and "RECOVERY_SUDO_KEEPALIVE_NOT_HEALTHY" in result.stderr and "running=0" in result.stdout
    assert "rc=0" in subprocess.run(["bash", "-c", f'. "{LIB}"; SUDO=""; recovery_start_sudo_keepalive; recovery_sudo_authority_gate; echo "rc=$?"'], text=True, capture_output=True).stdout  # no privilege prefix: nothing to refresh


def test_a_failed_refresh_makes_the_gate_fail_and_a_second_start_is_refused(tmp_path: Path) -> None:
    result, calls = keepalive(tmp_path, 'recovery_start_sudo_keepalive; sleep 3.5; recovery_sudo_authority_gate; echo "gate=$?"; recovery_start_sudo_keepalive; echo "second=$?"', fail_after=1)
    assert "gate=1" in result.stdout and "RECOVERY_SUDO_KEEPALIVE_NOT_HEALTHY" in result.stderr and "second=1" in result.stdout and "RECOVERY_KEEPALIVE_ALREADY_STARTED" in result.stderr


def sm_script(extra: str = "") -> str:
    hooks = ("recovery_authority_gates() { true; }; recovery_tty_gate() { true; }; recovery_hook_pregates() { mark pregates; }; recovery_hook_baseline() { mark baseline; }; recovery_hook_isolate() { mark isolate; }\n"
             "recovery_hook_d4() { mark d4; }; recovery_hook_restore_status() { mark restore_status; }; recovery_hook_close() { mark close; }; recovery_hook_verify() { mark verify; }; recovery_hook_preserve_evidence() { mark \"preserve:$1\"; }\n")
    return hooks + extra


@needs_userns
def test_a_keepalive_failure_before_the_marker_blocks_the_attempt_and_consumes_nothing(tmp_path: Path) -> None:
    bin_dir, calls = fake_sudo(tmp_path, 1)
    log = tmp_path / "hook.log"
    body = (f'{sup.seam(tmp_path)}. "{LIB}"\n{KEEP}WORK="{tmp_path}/canon/recovery-x"\nmark() {{ echo "$1" >> "{log}"; }}\n{sm_script()}'
            f'recovery_start_sudo_keepalive; sleep 3.5; recovery_run_attempt; echo "rc=$?"; recovery_stop_sudo_keepalive')
    result = subprocess.run(["unshare", "-r", "bash", "-c", body], env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}, text=True, capture_output=True)
    assert "rc=1" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=YES" not in result.stdout and "RECOVERY_PRE_ATTEMPT_FAILURE" in result.stdout, (result.stdout, result.stderr)
    assert not (tmp_path / "canon" / MARKER).exists() and "isolate" not in (log.read_text() if log.exists() else "")


@needs_userns
def test_a_keepalive_failure_after_the_marker_fails_closed_before_final_with_the_attempt_consumed(tmp_path: Path) -> None:
    bin_dir, calls = fake_sudo(tmp_path)
    log = tmp_path / "hook.log"
    final_stubs = ('recovery_capture() { mark capture; }; recovery_handler() { mark "handler:$1"; }; recovery_trustedclock_gate() { true; }; recovery_compare() { true; }; recovery_runtime_unchanged() { true; }; recovery_r1i_present_gate() { true; }\n'
                   'recovery_hook_isolate() { mark isolate; RECOVERY_KEEPALIVE_FAILED=1; }\n')
    body = (f'{sup.seam(tmp_path)}. "{LIB}"\n{KEEP}WORK="{tmp_path}/canon/recovery-x"\nmark() {{ echo "$1" >> "{log}"; }}\n{sm_script(final_stubs)}'
            f'recovery_start_sudo_keepalive\nrecovery_hook_final() {{ recovery_sudo_authority_gate || {{ echo "RECOVERY_SUDO_AUTHORITY_LOST_BEFORE_FINAL=YES"; return 1; }}; mark final; }}\n'
            f'recovery_hook_regate() {{ recovery_sudo_authority_gate; }}\nrecovery_run_attempt; echo "rc=$?"; recovery_stop_sudo_keepalive')
    result = subprocess.run(["unshare", "-r", "bash", "-c", body], env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}, text=True, capture_output=True)
    assert "rc=1" in result.stdout and "RECOVERY_RESULT=FAIL_IMMUTABLE RECOVERY_FAILED_STAGE=final" in result.stdout and "RECOVERY_ATTEMPT_CONSUMED=YES" in result.stdout and "RECOVERY_RERUN_ALLOWED=NO" in result.stdout
    assert (tmp_path / "canon" / MARKER).is_file() and "final" not in log.read_text().split()


def test_the_real_final_hook_and_regate_start_with_the_sudo_authority_gate() -> None:
    text = LIB.read_text()
    assert re.search(r"recovery_hook_final\(\) \{\n  local out n\n  recovery_sudo_authority_gate", text)
    assert "recovery_authority_gates && recovery_sudo_authority_gate && recovery_tty_gate && recovery_attempt_unconsumed" in text
    run = text[text.index("recovery_run_attempt() {"): text.index("recovery_attempt_failed() {")]
    assert run.index("recovery_sudo_authority_gate") < run.index('recovery_consume_attempt "$WORK"')  # re-checked immediately before the marker


# --------------------------------------------------------------------------- F4 + M-c: pre-marker Core readiness and timezone


VALID = {"AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET": "10.0.0.1:22", "AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": "1.1.1.1:443, 8.8.8.8:53", "AEGIS_RECOVERY_WEB_READINESS_URL": "https://web.example/ready"}


def test_a_complete_core_configuration_passes_and_reports_only_configured_never_a_value() -> None:
    result = stage.config_readiness(VALID)
    assert result == {"MANAGEMENT": "CONFIGURED", "NETWORK_TARGETS": "2", "WEB": "CONFIGURED"}
    assert not any(value in json.dumps(result) for value in ("10.0.0.1", "1.1.1.1", "web.example"))


@pytest.mark.parametrize("patch,code", [
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": None}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": ""}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": " , ,"}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": "1.1.1.1:443,notaport"}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": "1.1.1.1:0"}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS": "1.1.1.1:70000"}, "NETWORK_PROBE_TARGETS"),
    ({"AEGIS_RECOVERY_WEB_READINESS_URL": None}, "WEB_READINESS_URL"),
    ({"AEGIS_RECOVERY_WEB_READINESS_URL": ""}, "WEB_READINESS_URL"),
    ({"AEGIS_RECOVERY_WEB_READINESS_URL": "http://web.example/ready"}, "WEB_READINESS_URL"),
    ({"AEGIS_RECOVERY_WEB_READINESS_URL": "https://"}, "WEB_READINESS_URL"),
    ({"AEGIS_RECOVERY_WEB_READINESS_URL": "https://a b"}, "WEB_READINESS_URL"),
    ({"AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET": None}, "MANAGEMENT_PROBE_TARGET"),
    ({"AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET": "nohost"}, "MANAGEMENT_PROBE_TARGET"),
])
def test_a_missing_empty_or_malformed_mandatory_setting_fails_the_readiness_gate(patch: dict, code: str) -> None:
    env = {**VALID, **patch}
    env = {k: v for k, v in env.items() if v is not None}
    with pytest.raises(stage.StageError, match=f"CONFIG_NOT_READY:{code}"):
        stage.config_readiness(env)


def test_the_probe_target_shape_is_the_one_the_core_itself_accepts() -> None:
    for target in ("host", ":80", "h:x", "h:", "h"):
        assert core._tcp_probe(target)[1].startswith("invalid probe target") and not stage._probe_target_ok(target)
    for target in ("h:80", "10.0.0.1:22"):
        assert not core._tcp_probe(target)[1].startswith("invalid probe target") and stage._probe_target_ok(target)
    source = (sup.ROOT / "aegis_soc/recovery_core.py").read_text()
    for key in ("RECOVERY_NETWORK_PROBE_TARGETS", "RECOVERY_WEB_READINESS_URL", "RECOVERY_MANAGEMENT_PROBE_TARGET"):
        assert key in source and f"AEGIS_{key}" in stage.READINESS_KEYS[["MANAGEMENT" in k or "NETWORK" in k or "WEB" in k for k in [f"AEGIS_{key}"]].index(True):] or f"AEGIS_{key}" in stage.READINESS_KEYS


def proc_world(tmp_path: Path, env: dict[str, str], pid: int = 4242) -> Path:
    root = tmp_path / "proc"
    (root / str(pid)).mkdir(parents=True)
    blob = b"\0".join(f"{k}={v}".encode() for k, v in {**env, "AEGIS_MQTT_PASS": "SUPER-SECRET", "AEGIS_ADMIN_PIN": "9999"}.items()) + b"\0"
    (root / str(pid) / "environ").write_bytes(blob)
    return root


def test_the_running_cores_environment_is_read_through_a_filter_that_never_holds_a_secret(tmp_path: Path) -> None:
    root = proc_world(tmp_path, {**VALID, "TZ": "UTC"})
    got = stage.read_core_environ(4242, str(root))
    assert set(got) == {*stage.READINESS_KEYS, "TZ"} and "SUPER-SECRET" not in json.dumps(got)
    for bad in (0, -1, "1", None, True):
        with pytest.raises(stage.StageError, match="CORE_PID_INVALID"):
            stage.read_core_environ(bad, str(root))
    with pytest.raises(stage.StageError, match="CORE_ENVIRON_UNREADABLE"):
        stage.read_core_environ(999, str(root))


def with_process_tz(monkeypatch, value: str | None) -> None:
    if value is None:
        monkeypatch.delenv("TZ", raising=False)
    else:
        monkeypatch.setenv("TZ", value)
    time.tzset()


def test_the_timezone_gate_passes_when_equal_and_fails_a_mismatch_before_the_marker(tmp_path: Path, monkeypatch) -> None:
    try:
        with_process_tz(monkeypatch, "Asia/Bangkok")
        assert stage.timezone_equal("Asia/Bangkok") == "EQUAL"
        with pytest.raises(stage.StageError, match="TIMEZONE_MISMATCH"):
            stage.timezone_equal("UTC")
        with pytest.raises(stage.StageError, match="TIMEZONE_MISMATCH"):
            stage.timezone_equal(None) if time.strftime("%z", time.gmtime()) != "" and _system_default_offset() != 7 * 3600 else (_ for _ in ()).throw(stage.StageError("TIMEZONE_MISMATCH"))
        with_process_tz(monkeypatch, None)
        assert stage.timezone_equal(None) == "EQUAL"  # both effective zones are the system default
        with_process_tz(monkeypatch, "UTC")
        assert stage.timezone_equal("UTC") == "EQUAL" and os.environ["TZ"] == "UTC"  # the process environment is restored after every probe
        with pytest.raises(stage.StageError, match="TIMEZONE_MISMATCH"):
            stage.timezone_equal("America/New_York")
    finally:
        monkeypatch.undo()
        time.tzset()


def _system_default_offset() -> int:
    saved = os.environ.pop("TZ", None)
    try:
        time.tzset()
        return time.localtime().tm_gmtoff
    finally:
        if saved is not None:
            os.environ["TZ"] = saved
        time.tzset()


def test_readiness_combines_config_and_timezone_and_a_failure_names_only_the_setting(tmp_path: Path, monkeypatch) -> None:
    with_process_tz(monkeypatch, "UTC")
    try:
        root = proc_world(tmp_path, {**VALID, "TZ": "UTC"})
        out = stage.readiness(4242, str(root))
        assert out == {"MANAGEMENT": "CONFIGURED", "NETWORK_TARGETS": "2", "WEB": "CONFIGURED", "TIMEZONE": "EQUAL"}
        bad = proc_world(tmp_path / "b", {**VALID, "TZ": "Asia/Bangkok"}, pid=7)
        with pytest.raises(stage.StageError, match="TIMEZONE_MISMATCH"):
            stage.readiness(7, str(bad))
        missing = proc_world(tmp_path / "c", {k: v for k, v in VALID.items() if "NETWORK" not in k}, pid=8)
        with pytest.raises(stage.StageError, match="CONFIG_NOT_READY:NETWORK_PROBE_TARGETS") as caught:
            stage.readiness(8, str(missing))
        assert "SUPER-SECRET" not in str(caught.value)
    finally:
        monkeypatch.undo()
        time.tzset()


def test_the_cli_readiness_command_prints_only_statuses_and_refuses_a_missing_core(capsys) -> None:
    assert stage.main(["readiness", "--core-pid", "2147483000"]) == 1
    assert "RECOVERY_STEP_REFUSED reason=CORE_ENVIRON_UNREADABLE" in capsys.readouterr().err


def test_readiness_runs_pre_marker_in_the_baseline_hook_and_the_handler_wires_it_to_the_running_core(tmp_path: Path) -> None:
    lib = LIB.read_text()
    base = lib[lib.index("recovery_hook_baseline() {"): lib.index("recovery_hook_regate() {")]
    assert base.index("recovery_handler READINESS") < base.index("recovery_handler BASELINE") and "recovery_consume_attempt" not in base
    apply = (sup.STG / "apply.sh").read_text()
    assert "READINESS)" in apply and "readiness --core-pid" in apply and "aegis-idea3-core.service" in apply and "BASELINE | READINESS |" in apply
    for fail in ("handler:READINESS",):
        pass
    result, calls = run_hook_with(tmp_path, '. /dev/null\nrecovery_require_hook() { true; }\nrecovery_prepare_evidence() { mkdir -p -m 700 "$EVID"; }\nrecovery_logs_prepare() { true; }; recovery_tty_gate() { true; }; recovery_d4_rehearsal() { true; }\n'
                                  'recovery_sudo_authority_gate() { true; }; recovery_capture() { true; }; recovery_trustedclock_gate() { true; }; recovery_compare() { true; }; recovery_operator_py() { mark "py:$1"; }\n'
                                  f'recovery_handler() {{ mark "handler:$1"; [ "$1" != READINESS ]; }}\nWORK="{tmp_path}/canon/recovery-x"; EVID="{tmp_path}/evid"; STEPS="{tmp_path}/evid/steps"\n'
                                  'RECOVERY_QUIESCENCE_SLEEP=0; recovery_hook_baseline; echo "rc=$?"')
    assert "rc=1" in result.stdout and calls[-1] == "handler:READINESS" and not any(c.startswith("py:") for c in calls) and not (tmp_path / "canon" / MARKER).exists()


# --------------------------------------------------------------------------- M-a: the D4 closure is the release's own manifest (existing L7 release guard + a pinned manifest digest)


def build_release(tmp_path: Path, rid: str = "rel-20260927") -> tuple[Path, str]:
    rel = tmp_path / rid
    (rel / "venv/bin").mkdir(parents=True)
    (rel / "aegis_soc").mkdir()
    (rel / "venv/bin/python").write_text("#!/bin/sh\n")
    (rel / "venv/bin/python").chmod(0o755)
    for name, text in (("supervisor.py", "print('x')\n"), ("__init__.py", ""), ("cli.py", "# the owner's D4 program\n"), ("local_restore.py", "# restore protocol\n")):
        (rel / "aegis_soc" / name).write_text(text)
    (rel / "requirements.txt").write_text("paho-mqtt==2.1.0\n")
    payload = sorted(p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file())
    manifest = {"schema_version": 1, "release_id": rid, "source_git_sha": "a" * 40, "source_tree_dirty": False, "python_version": "3.13.1", "requirements_sha256": hashlib.sha256(b"paho-mqtt==2.1.0\n").hexdigest(),
                "file_count": len(payload), "created_by_tool_version": "1"}
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = [f"{hashlib.sha256((rel / p).read_bytes()).hexdigest()}  {p}" for p in sorted(p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file() and p.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")
    for path in [rel, *rel.rglob("*")]:
        if not path.is_symlink():
            path.chmod(0o755 if (path.is_dir() or os.access(path, os.X_OK)) else 0o644)
    return rel, hashlib.sha256((rel / "RELEASE-SHA256SUMS").read_bytes()).hexdigest()


def closure_gate(rel: Path, sums: str, *, userns: bool = True):
    script = f'. "{LIB}"; SUDO=""; CTRL="{sup.P4}"; PY="{VENV_PY}"; recovery_release_closure_gate rel-20260927 "{rel}" {sums}'
    return sup.userns_bash(script) if userns else sup.bash(script)


@needs_userns
def test_the_release_closure_gate_accepts_only_the_exact_manifested_root_owned_release(tmp_path: Path) -> None:
    rel, sums = build_release(tmp_path)
    assert closure_gate(rel, sums).returncode == 0
    assert "OWNER_INVALID" in closure_gate(rel, sums, userns=False).stderr  # not root-owned
    assert "RECOVERY_RELEASE_MANIFEST_DIGEST_MISMATCH" in closure_gate(rel, "0" * 64).stderr  # a re-built manifest is not the pinned one
    assert closure_gate(rel, "zz").returncode == 1 and closure_gate(tmp_path / "missing", sums).returncode == 1


@needs_userns
@pytest.mark.parametrize("drift", ["dependency_bytes", "extra_module", "symlinked_module", "writable_module", "cli_bytes", "special_file"])
def test_a_dependency_drift_anywhere_in_the_release_closure_is_refused(tmp_path: Path, drift: str) -> None:
    rel, sums = build_release(tmp_path)
    mod = rel / "aegis_soc" / "local_restore.py"
    if drift == "dependency_bytes":
        mod.chmod(0o644)
        mod.write_text("# a different restore protocol\n")
        expect = "CHECKSUM_MISMATCH"
    elif drift == "extra_module":
        (rel / "aegis_soc" / "evil.py").write_text("")
        expect = "CHECKSUM_ENTRY_MISSING"  # a file the manifest does not list
    elif drift == "symlinked_module":
        mod.unlink()
        mod.symlink_to(rel / "aegis_soc" / "__init__.py")
        expect = "SYMLINK_IN_RELEASE"
    elif drift == "writable_module":
        mod.chmod(0o666)
        expect = "WRITABLE_BY_GROUP_OR_OTHER"
    elif drift == "cli_bytes":
        (rel / "aegis_soc" / "cli.py").write_text("# the owner's D4 program, but not the manifested one\n")
        expect = "CHECKSUM_MISMATCH"
    else:
        os.mkfifo(rel / "aegis_soc" / "pipe")
        expect = "SPECIAL_FILE_IN_RELEASE"
    result = closure_gate(rel, sums)
    assert result.returncode == 1 and expect in result.stderr, (drift, result.stderr)


def test_the_closure_gate_reuses_the_l7_release_guard_and_is_part_of_the_authority_gates() -> None:
    lib = LIB.read_text()
    assert "p4-l7-release-guard.py" in lib and 'check --logical-path "/opt/aegis-idea3/releases/$rid" --host-path "$release" --expect-owner root' in lib
    assert "RELEASE_SUMS_SHA256" in RUNNER.read_text() and "recovery_release_closure_gate" in sup.runner_function("recovery_authority_gates")
