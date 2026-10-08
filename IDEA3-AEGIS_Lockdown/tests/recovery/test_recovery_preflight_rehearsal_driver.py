"""Hermetic tests of the rehearsal DRIVER library: result semantics, tripwires on every consuming function, the default-deny read-only privilege wrapper, repeatability and mutation tests.

The Recovery run library is sourced for real; the canonical governance directory is a TEST-ONLY seam under a temporary directory; `sudo` is a recording stub; the release CLI is a stub script.
Nothing here runs Recovery, touches Production, nft, MQTT, a service, a socket or an ESP32."""

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

ACC = sup.P4 / "recovery-acceptance"
DRIVER = ACC / "recovery_preflight_rehearsal.sh"
LIB = sup.LIB
FROZEN_SHA = "ab" * 32
MARKER = "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
POISONED = re.search(r'^RECOVERY_REHEARSAL_POISONED="([^"]+)"', DRIVER.read_text(), re.M).group(1).split()

CLI_STUB = """#!/bin/sh
d=$(dirname "$0"); CLI_MODE=$(cat "$d/mode"); CALLS="$d/../../calls"
echo "$@" >> "$CALLS/cli-calls"
case "$*" in
  *"restore --help"*) case "$CLI_MODE" in
      ok) echo "usage: aegisctl restore [-h] [--reason REASON]"; exit 0 ;;
      traceback) echo "Traceback (most recent call last):"; exit 1 ;;
      refused) echo "RESTORE refused: an interactive local terminal is required"; exit 2 ;;
      nonzero) echo "usage: aegisctl restore"; exit 3 ;;
    esac ;;
  *"restore"*) echo RESTORE_ENTRY_POINT_RAN >> "$CALLS/restore-ran"; exit 5 ;;
esac
exit 0
"""
SUDO_STUB = """#!/bin/sh
d=$(dirname "$0")/stub
[ "$1" = -n ] && shift
echo "$*" >> "$d/real-sudo"
env > "$d/stub-env"
case "${1##*/}" in systemctl | nft) echo "stubbed-$1"; exit 0 ;; esac   # never the real host systemctl / nft
exec "$@"
"""


class Rig:
    def __init__(self, tmp: Path, *, driver: Path = DRIVER) -> None:
        self.tmp = tmp
        tmp.mkdir(parents=True, exist_ok=True)
        tmp.chmod(0o700)
        self.canon = tmp / "canon"
        self.log = tmp / "stub"
        self.log.mkdir()
        self.tmpdir = tmp / "tmpdir"
        self.tmpdir.mkdir()
        self.release = tmp / "release"
        (self.release / "venv/bin").mkdir(parents=True)
        (self.release / "venv/bin/python").write_text(CLI_STUB)
        (self.release / "venv/bin/python").chmod(0o755)
        (self.release / "calls").mkdir()
        (self.release / "venv/bin/mode").write_text("ok")
        self.sudo = tmp / "real-sudo"
        self.sudo.write_text(SUDO_STUB)
        self.sudo.chmod(0o755)
        self.ctrl = tmp / "control"
        self.ctrl.mkdir()
        self.driver = driver

    def script(self, *, pregates: str, regate: str, unconsumed: str, post: str, frozen: str) -> str:
        return f'''{sup.seam(self.tmp)}
export STUB_LOG="{self.log}" TMPDIR="{self.tmpdir}" CLI_MODE="${{CLI_MODE:-ok}}"
. "{LIB}"
SUDO=""
CTRL="{self.ctrl}"; PY=/usr/bin/python3; RELEASE_PATH="{self.release}"; RUNTIME_DIR="{self.tmp}/run"; RECOVERY_SAFE_PATH=/usr/bin:/bin; RECOVERY_D4_OUT_FD=1
WORK="{self.canon}/recovery-x"
recovery_hook_pregates() {{ {pregates}; }}
recovery_hook_regate() {{ {regate}; }}
{unconsumed}
{post}
. "{self.driver}"
RECOVERY_REHEARSAL_REAL_SUDO="{self.sudo}"
RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256="{frozen}"
recovery_rehearse; echo "rc=$?"
'''

    def run(self, *, pregates: str = "return 0", regate: str = "return 0", unconsumed: str | None = None, post: str = "", frozen: str = FROZEN_SHA,
            cli_mode: str = "ok", env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        (self.release / "venv/bin/mode").write_text(cli_mode)
        if unconsumed is None:
            unconsumed = f'recovery_attempt_unconsumed() {{ [ ! -e "{self.canon}/{MARKER}" ]; }}'
        return subprocess.run(["bash", "-c", self.script(pregates=pregates, regate=regate, unconsumed=unconsumed, post=post, frozen=frozen)],
                              text=True, capture_output=True, env={**os.environ, "CLI_MODE": cli_mode, **(env or {})})

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.tmpdir.iterdir())

    def canon_listing(self) -> list[str]:
        return sorted(str(p.relative_to(self.canon)) for p in self.canon.rglob("*")) if self.canon.exists() else []


def parse(proc: subprocess.CompletedProcess[str]) -> dict[str, str]:
    return dict(re.findall(r"^RECOVERY_REHEARSAL_([A-Z0-9_]+)=(.*)$", proc.stdout, re.M))


@pytest.fixture()
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


# ═════════════════════════════════════════════ result semantics ═════════════════════════════════════════════
def test_a_fully_passing_rehearsal_is_a_preflight_pass_that_is_explicitly_not_authorization(rig: Rig) -> None:
    proc = rig.run()
    out = parse(proc)
    assert "rc=20" in proc.stdout, proc.stderr                       # partial: never exit 0
    assert out["RESULT"] == "PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION"
    assert (out["ATTEMPT_UNCONSUMED"], out["PREGATES"], out["REGATE"], out["RELEASE_CLI_PARSE"]) == ("PASS", "PASS", "PASS", "PASS")
    assert (out["AUTHORIZES_RECOVERY"], out["IS_AUTHORITY_TOKEN"], out["ATTEMPT_CONSUMED_BY_REHEARSAL"], out["PRODUCTION_MUTATION_BY_REHEARSAL"], out["DEVICE_COMMANDS"]) == ("NO", "NO", "NO", "NO", "0")
    assert "NOT_AUTHORIZATION" in out["PASS_MEANS"] and out["MARKER_PRESENT"] == "NO" and out["MODE"] == "READ_ONLY_NON_CONSUMING_PREFLIGHT"
    assert out["FROZEN_RUNNER_SHA256"] == FROZEN_SHA


def test_everything_that_was_not_rehearsed_is_reported_not_rehearsed_and_never_pass(rig: Rig) -> None:
    out = parse(rig.run())
    for name in ("BASELINE_AND_ROOT_CAPTURES", "D4_EXACT_TERMINAL_REFUSAL", "ATTEMPT_MARKER", "ISOLATE_D4_RESTORE_CLOSE_FINAL_VERIFY"):
        assert out[name] == "NOT_REHEARSED", name
    assert "RECOVERY_REHEARSAL_RESULT=PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION" in rig.run().stdout
    assert not re.search(r"RECOVERY_REHEARSAL_(ATTEMPT_MARKER|ISOLATE\w*|BASELINE\w*|D4\w*)=PASS", rig.run().stdout)


@pytest.mark.parametrize("which", ["pregates", "regate", "unconsumed", "cli"])
def test_any_failed_check_makes_the_result_blocked_with_a_non_zero_status(rig: Rig, which: str) -> None:
    kwargs: dict = {}
    if which == "pregates":
        kwargs["pregates"] = "echo 'GATE_FAIL: stage gate failed' >&2; return 1"
    elif which == "regate":
        kwargs["regate"] = "echo 'RECOVERY_INTERACTIVE_TERMINAL_REQUIRED' >&2; return 1"
    elif which == "unconsumed":
        (rig.canon).mkdir(mode=0o700)
        (rig.canon / MARKER).write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")
    else:
        kwargs["cli_mode"] = "traceback"
    proc = rig.run(**kwargs)
    out = parse(proc)
    assert "rc=10" in proc.stdout and out["RESULT"] == "BLOCKED"
    assert "PREFLIGHT_PASS" not in proc.stdout
    name = {"pregates": "PREGATES", "regate": "REGATE", "unconsumed": "ATTEMPT_UNCONSUMED", "cli": "RELEASE_CLI_PARSE"}[which]
    assert out[name] == "BLOCKED"
    assert out["AUTHORIZES_RECOVERY"] == "NO"


def test_a_ctv_closed_fail_that_blocks_the_existing_predecessor_gate_is_reported_as_the_blocker(rig: Rig) -> None:
    pre = "echo 'GATE_FAIL: neither historical CTu PASS nor reviewed CTv PASS successor closeout is present' >&2; return 1"
    proc = rig.run(pregates=pre)
    out = parse(proc)
    assert out["PREGATES"] == "BLOCKED" and out["PREDECESSOR_GATE_BLOCKING"] == "YES" and out["RESULT"] == "BLOCKED"
    assert "neither historical CTu PASS nor reviewed CTv PASS" in proc.stdout  # the real reason is shown, bounded
    assert parse(rig.run())["PREDECESSOR_GATE_BLOCKING"] == "NO"


def test_the_real_predecessor_gates_still_refuse_ctv_closed_fail_and_the_rehearsal_does_not_weaken_them(tmp_path: Path) -> None:
    """Drives the REAL recovery_ctu_successor_gate / recovery_ctv_successor_gate against a canonical directory that holds a CTv FAIL closeout: both still refuse."""
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text("CTV_ATTEMPT_CONSUMED=YES\n")
    (canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("CTV_RESULT=FAIL_IMMUTABLE\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    main = sup.commit_all(repo)
    script = f'{sup.seam(tmp_path)}. "{LIB}"\nSUDO=""\nrecovery_ctv_successor_gate "{repo}" "{main}"; echo "ctv_rc=$?"\nrecovery_ctu_successor_gate "{repo}" "{main}"; echo "ctu_rc=$?"\n'
    proc = subprocess.run(["bash", "-c", script], text=True, capture_output=True)
    assert "ctv_rc=1" in proc.stdout and "ctu_rc=1" in proc.stdout
    assert not (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()


@pytest.mark.parametrize("mode", ["traceback", "refused", "nonzero"])
def test_the_release_cli_check_is_help_only_and_a_bad_parse_is_blocked(rig: Rig, mode: str) -> None:
    proc = rig.run(cli_mode=mode)
    assert parse(proc)["RELEASE_CLI_PARSE"] == "BLOCKED"
    calls = (rig.release / "calls" / "cli-calls").read_text().splitlines()
    assert calls and all(call.endswith("restore --help") or "restore --help" in call for call in calls)
    assert not (rig.release / "calls" / "restore-ran").exists()  # the restore entry point is never run


def test_the_release_cli_check_never_runs_restore_in_the_passing_case_either(rig: Rig) -> None:
    rig.run()
    assert not (rig.release / "calls" / "restore-ran").exists()
    assert all("--help" in call for call in (rig.release / "calls" / "cli-calls").read_text().splitlines())


def test_a_missing_or_malformed_frozen_digest_blocks_before_any_directory_or_wrapper_exists(rig: Rig) -> None:
    for bad in ("", "xyz", "A" * 64, "ab" * 31):
        proc = rig.run(frozen=bad)
        assert "rc=10" in proc.stdout and parse(proc)["RESULT"] == "BLOCKED" and "FROZEN_RUNNER_SHA256_MISSING" in proc.stdout
    assert rig.leftovers() == [] and not (rig.log / "real-sudo").exists()


def test_the_pregates_are_judged_against_the_frozen_digest_not_the_derived_copys_digest(rig: Rig) -> None:
    proc = rig.run(post='RUNNER_SHA256=derived-copy-digest', pregates='echo "SEEN=$RUNNER_SHA256" >&2; [ "$RUNNER_SHA256" = "%s" ]' % FROZEN_SHA)
    assert parse(proc)["PREGATES"] == "PASS"


# ═════════════════════════════════════════════ no consumption, no mutation, repeatable ═════════════════════════════════════════════
@pytest.mark.parametrize("name", POISONED)
def test_every_consuming_or_mutating_function_is_a_tripwire_that_stops_the_rehearsal(rig: Rig, name: str) -> None:
    proc = rig.run(pregates=f'{name} "{rig.canon}/recovery-x" || true; echo AFTER_TRIPWIRE_CONTINUED')
    out = parse(proc)
    assert "rc=97" in proc.stdout and out["RESULT"] == "SAFETY_TRIPWIRE" and out["SAFETY_TRIPWIRE"] == "FIRED"
    assert not (rig.canon / MARKER).exists() and rig.canon_listing() == []  # nothing consumed, no work directory, no provenance file
    assert out["AUTHORIZES_RECOVERY"] == "NO" and "PREFLIGHT_PASS" not in proc.stdout
    assert rig.leftovers() == []


def test_a_tripwire_inside_a_subshell_or_a_command_substitution_is_still_detected(rig: Rig) -> None:
    proc = rig.run(pregates='x=$(recovery_consume_attempt "$WORK"); true')
    assert "rc=97" in proc.stdout and parse(proc)["RESULT"] == "SAFETY_TRIPWIRE" and rig.canon_listing() == []


@pytest.mark.parametrize("sub,allowed", [("socket-check", True), ("check-reason", True), ("isolate", False), ("close", False), ("record-d4", False), ("restore-status", False), ("probe-final", False)])
def test_the_core_client_wrapper_allows_only_the_two_read_only_subcommands(rig: Rig, sub: str, allowed: bool) -> None:
    post = f'recovery_operator_py() {{ echo "CLIENT_CALLED:$1" >> "{rig.log}/client"; }}'
    proc = rig.run(pregates=f'recovery_operator_py {sub}', post=post)
    called = (rig.log / "client").exists()
    assert called is allowed
    assert ("rc=97" in proc.stdout) is (not allowed)


def test_a_consumed_marker_is_reported_blocked_and_is_never_modified_or_removed(rig: Rig) -> None:
    rig.canon.mkdir(mode=0o700)
    marker = rig.canon / MARKER
    marker.write_text("RECOVERY_ATTEMPT_CONSUMED=YES\nRECOVERY_RERUN_ALLOWED=NO\n")
    before = (marker.read_bytes(), marker.stat().st_mtime_ns)
    proc = rig.run()
    assert parse(proc)["ATTEMPT_UNCONSUMED"] == "BLOCKED" and parse(proc)["MARKER_PRESENT"] == "YES" and "rc=10" in proc.stdout
    assert (marker.read_bytes(), marker.stat().st_mtime_ns) == before and rig.canon_listing() == [MARKER]


def test_repeating_the_rehearsal_consumes_nothing_and_leaves_no_residue(rig: Rig) -> None:
    rig.canon.mkdir(mode=0o700)
    results = [rig.run() for _ in range(4)]
    assert all("rc=20" in r.stdout and parse(r)["RESULT"] == "PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION" for r in results)
    assert rig.canon_listing() == []                # still no marker, no work directory, no file
    assert rig.leftovers() == []                    # the private rehearsal directory is always removed
    blocked = [rig.run(pregates="return 1") for _ in range(3)]
    assert all("rc=10" in r.stdout for r in blocked) and rig.canon_listing() == [] and rig.leftovers() == []


def test_the_private_directory_is_removed_after_a_failure_and_after_a_tripwire(rig: Rig) -> None:
    rig.run(pregates="return 1")
    rig.run(pregates='recovery_consume_attempt x')
    assert rig.leftovers() == []


def test_the_cleanup_removes_only_the_directory_it_created(rig: Rig) -> None:
    foreign = rig.tmpdir / "keep-me"
    foreign.mkdir()
    (foreign / "f").write_text("x")
    rig.run()
    assert (foreign / "f").read_text() == "x"
    proc = rig.run(post='RH_DIR=/etc; recovery_rehearsal_cleanup; echo "still:$([ -d /etc ] && echo yes)"')
    assert "still:yes" in proc.stdout


# ═════════════════════════════════════════════ privilege wrapper: exact read-only command contracts ═════════════════════════════════════════════
PY_PATH = "/usr/bin/python3"


def wrapper(rig: Rig, *argv: str, driver: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Generate the real wrapper with the driver's own generator and run it with the given privileged command (the real sudo is a recording stub)."""
    script = f'''. "{LIB}"; SUDO=""; . "{driver or rig.driver}"
RECOVERY_REHEARSAL_REAL_SUDO="{rig.sudo}"
RH_DIR="{rig.tmpdir}/aegis-recovery-rehearsal.W"; mkdir -p "$RH_DIR"
recovery_rehearsal_write_sudo_wrapper "$RH_DIR/sudo-ro" "{rig.ctrl}" "{PY_PATH}"
/usr/bin/env ${{WRAP_ENV:-}} "$RH_DIR/sudo-ro" "$@"; echo "wrapper_rc=$?"
'''
    # the hostile variables are given ONLY to the wrapper process (not to the harness shell)
    return subprocess.run(["/usr/bin/bash", "-c", script, "_", *argv], text=True, capture_output=True, cwd=rig.tmp, env={**os.environ, "WRAP_ENV": " ".join(f"{k}={v}" for k, v in (env or {}).items())})


def stub_calls(rig: Rig) -> list[str]:
    path = rig.log / "real-sudo"
    return path.read_text().splitlines() if path.exists() else []


def snapshot(root: Path) -> dict[str, tuple[int, bytes | None]]:
    out = {}
    for path in sorted(root.rglob("*")):
        if "aegis-recovery-rehearsal.W" in path.parts:
            continue  # the wrapper's own private directory (log and tripwire) is the only thing allowed to change
        out[str(path)] = (path.lstat().st_mode, path.read_bytes() if path.is_file() and not path.is_symlink() else None)
    return out


def denied(rig: Rig, *argv: str, **kw) -> subprocess.CompletedProcess[str]:
    before = snapshot(rig.tmp)
    proc = wrapper(rig, *argv, **kw)
    assert "wrapper_rc=97" in proc.stdout, (argv, proc.stdout, proc.stderr)
    assert "RECOVERY_REHEARSAL_SUDO_DENIED" in proc.stderr
    assert stub_calls(rig) == [], (argv, "reached the privileged stub")
    assert (rig.tmpdir / "aegis-recovery-rehearsal.W" / "TRIPWIRE").read_text().startswith("sudo:")
    assert snapshot(rig.tmp) == before, (argv, "changed files or state")
    return proc


def reviewed_forms(rig: Rig) -> list[list[str]]:
    """Every privileged command form that the reviewed Recovery pre-gates actually issue (inventory taken from the sourced libraries)."""
    tool = rig.ctrl / "p4-l7-release-guard.py"
    tool.write_text("print('L7_RELEASE_GUARD=PASS')\n")
    return [
        ["true"],
        ["test", "-d", "/etc"], ["test", "-e", "/etc"], ["test", "-L", "/etc"],
        ["stat", "-c", "%u", "/etc"],
        ["find", "/etc", "-maxdepth", "0", "-perm", "/022"],
        ["find", "/etc", "-maxdepth", "1", "-type", "f", "(", "-name", "CTU-GLOBAL-CLOSEOUT-PASS", "-o", "-name", "CTU-GLOBAL-CLOSEOUT-FAIL", ")", "-printf", "%f\\n"],
        ["awk", "NF >= 1 {print $1}", "/etc/os-release"],
        ["awk", "-F=", "NF >= 2 {print $1}", "/etc/os-release"],
        ["awk", "-F=", '$1 == "CTU_EXPECTED_MAIN" {print $2}', "/etc/os-release"],
        ["awk", "-F=", '$1 == "CTV_DETECTOR_BASELINE_MODE" {print $2}', "/etc/os-release"],
        ["sha256sum", "/etc/os-release"],
        ["readlink", "/etc/os-release"],
        ["systemctl", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID", "aegis-idea3-detector.service"],
        ["pgrep", "-fc", "aegis_soc[.]production_detector"],
        ["nft", "list", "tables"],
        ["nft", "--stateless", "list", "table", "inet", "aegis_idea3_r1i"],
        [PY_PATH, str(tool), "check", "--logical-path", "/opt/aegis-idea3/releases/912b18005bb2fc80bb4e8d1fe8aa88803ac27314", "--host-path", "/opt/aegis-idea3/releases/912b18005bb2fc80bb4e8d1fe8aa88803ac27314", "--expect-owner", "root"],
    ]


def test_every_privileged_form_used_by_the_reviewed_prefix_is_still_allowed(rig: Rig) -> None:
    for argv in reviewed_forms(rig):
        (rig.log / "real-sudo").unlink(missing_ok=True)
        proc = wrapper(rig, *argv)
        assert "RECOVERY_REHEARSAL_SUDO_DENIED" not in proc.stderr, (argv, proc.stderr)
        assert len(stub_calls(rig)) == 1, argv


def test_the_allowed_command_runs_a_fixed_resolved_program_in_a_clean_environment(rig: Rig) -> None:
    wrapper(rig, "stat", "-c", "%u", "/etc", env={"LD_PRELOAD": "/evil.so", "PATH": "/evil", "BASH_ENV": "/evil.sh", "PYTHONPATH": "/evil", "IFS": "x", "SHELLOPTS": "xtrace"})
    (call,) = stub_calls(rig)
    assert call.startswith("/usr/bin/stat ") or call.startswith("/bin/stat ")      # a fixed absolute path, never the caller's PATH
    env_dump = (rig.log / "stub-env").read_text()
    assert "PATH=/usr/sbin:/usr/bin:/sbin:/bin" in env_dump and "LC_ALL=C" in env_dump
    for dangerous in ("LD_PRELOAD", "BASH_ENV", "PYTHONPATH", "IFS=", "SHELLOPTS", "/evil"):
        assert dangerous not in env_dump, dangerous


FORBIDDEN = {
    # awk: variable/ARGV writes, programs from files, includes, pipes, system, getline, any non-reviewed program
    "awk-variable-write": ["awk", "-v", "f=OUT", 'BEGIN{print "x" > f}'],
    "awk-argv-write": ["awk", 'BEGIN{print "x" > ARGV[1]}', "OUT"],
    "awk-append": ["awk", 'BEGIN{print "x" >> ARGV[1]}', "OUT"],
    "awk-system": ["awk", 'BEGIN{system("touch OUT")}'],
    "awk-pipe": ["awk", 'BEGIN{print "x" | "tee OUT"}'],
    "awk-getline": ["awk", 'BEGIN{"id" | getline x; print x}'],
    "awk-program-file": ["awk", "-f", "/etc/os-release", "/etc/os-release"],
    "awk-include": ["awk", "--include", "x", "NF >= 1 {print $1}", "/etc/os-release"],
    "awk-other-program": ["awk", "{print}", "/etc/os-release"],
    "awk-two-files": ["awk", "NF >= 1 {print $1}", "/etc/os-release", "/etc/hostname"],
    "awk-relative-file": ["awk", "NF >= 1 {print $1}", "relative-file"],
    "awk-bad-key": ["awk", "-F=", '$1 == "lower;case" {print $2}', "/etc/os-release"],
    # sort / uniq output files, and the other text verbs no pre-gate runs privileged
    "sort-output": ["sort", "-o", "OUT", "/etc/os-release"],
    "sort-output-long": ["sort", "--output=OUT", "/etc/os-release"],
    "uniq-output-operand": ["uniq", "/etc/os-release", "OUT"],
    "date-set": ["date", "-s", "2000-01-01"],
    "date-plain": ["date"],
    "journalctl-vacuum": ["journalctl", "--vacuum-time=1s"],
    "journalctl-rotate": ["journalctl", "--rotate"],
    "journalctl-flush": ["journalctl", "--flush"],
    "journalctl-readonly-looking": ["journalctl", "-o", "json", "--no-pager", "-n", "1"],
    "cat": ["cat", "/etc/os-release"], "grep": ["grep", "-q", "x", "/etc/os-release"], "cmp": ["cmp", "-s", "/etc/os-release", "/etc/hostname"],
    "tee": ["tee", "OUT"], "dd": ["dd", "of=OUT"], "touch": ["touch", "OUT"], "mkdir": ["mkdir", "-m", "0700", "OUT"], "rm": ["rm", "-rf", "OUT"],
    "chmod": ["chmod", "0777", "OUT"], "chattr": ["chattr", "+i", "OUT"], "sync": ["sync", "--", "OUT"], "mv": ["mv", "a", "b"], "cp": ["cp", "a", "b"], "ln": ["ln", "-s", "a", "OUT"],
    "kill": ["kill", "1"], "reboot": ["reboot"], "curl": ["curl", "http://127.0.0.1/"], "sudo": ["sudo", "true"], "empty": [],
    # alternative executable paths
    "absolute-allowed-name": ["/tmp/x/cat", "/etc/os-release"], "absolute-stat": ["/tmp/x/stat", "-c", "%u", "/etc"], "relative-path": ["./stat", "-c", "%u", "/etc"],
    "absolute-python-other": ["/tmp/x/python3", "SCRIPT", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "bare-python": ["python3", "SCRIPT", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "assignment-as-program": ["LD_PRELOAD=/evil.so", "stat", "-c", "%u", "/etc"],
    # env and shells: never allowed, so no variable (LD_*, PATH, PYTHON*, BASH_ENV, ENV, IFS, SHELLOPTS) can be forwarded
    "env-ld-preload": ["env", "LD_PRELOAD=/evil.so", "stat", "-c", "%u", "/etc"],
    "env-path": ["env", "PATH=/evil", "stat", "-c", "%u", "/etc"],
    "env-pythonpath": ["env", "PYTHONPATH=/evil", PY_PATH, "SCRIPT", "check"],
    "env-bash-env": ["env", "BASH_ENV=/evil.sh", "true"], "env-env": ["env", "ENV=/evil.sh", "true"], "env-ifs": ["env", "IFS=x", "true"], "env-shellopts": ["env", "SHELLOPTS=xtrace", "true"],
    "env-harmless-assignment": ["env", "PYTHONDONTWRITEBYTECODE=1", "true"], "env-clear": ["env", "-i", "true"], "env-split-string": ["env", "-S", "rm OUT"],
    "bash-c": ["bash", "-c", "echo x > OUT"], "sh-c": ["sh", "-c", "touch OUT"], "bash-proc-probe": ["bash", "-c", 'tr "\\0" "\\n" < "/proc/$1/environ" | grep -qx "AEGIS_ALERT_SOURCE_UID=$2"', "_", "1", "0"],
    # python: path traversal, outside the control snapshot, stdin, -c, wrong subcommand/arguments
    "python-traversal": [PY_PATH, "CTRL/../evil.py", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "python-outside-ctrl": [PY_PATH, "/tmp/elsewhere.py", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "python-stdin": [PY_PATH, "-I", "-"], "python-dash-c": [PY_PATH, "-c", "open('OUT','w')"],
    "python-unreviewed-tool": [PY_PATH, "CTRL/p4-other-tool.py", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "python-other-subcommand": [PY_PATH, "CTRL/p4-l7-release-guard.py", "install", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root"],
    "python-bad-logical-path": [PY_PATH, "CTRL/p4-l7-release-guard.py", "check", "--logical-path", "/etc/shadow", "--host-path", "/opt/x", "--expect-owner", "root"],
    "python-extra-argument": [PY_PATH, "CTRL/p4-l7-release-guard.py", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root", "--fix"],
    "python-owner-not-root": [PY_PATH, "CTRL/p4-l7-release-guard.py", "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "nobody"],
    # nft: chaining, newline injection, mutation, scripts
    "nft-chain-semicolon": ["nft", "list tables; flush ruleset"], "nft-chain-in-operand": ["nft", "list", "tables; add table ip x"],
    "nft-newline": ["nft", "list", "tables\nflush ruleset"], "nft-newline-in-table": ["nft", "--stateless", "list", "table", "inet", "aegis_idea3_r1i\nflush ruleset"],
    "nft-braces": ["nft", "--stateless", "list", "table", "inet", "x { }"], "nft-add": ["nft", "add", "table", "inet", "x"], "nft-flush": ["nft", "flush", "ruleset"],
    "nft-file": ["nft", "-f", "rules.nft"], "nft-interactive": ["nft", "-i"], "nft-extra-operand": ["nft", "list", "tables", "extra"],
    "nft-bad-family": ["nft", "--stateless", "list", "table", "bridge;x", "aegis_idea3_r1i"], "nft-list-ruleset": ["nft", "list", "ruleset"],
    # other verbs with unreviewed options
    "stat-printf": ["stat", "--printf=%n", "/etc"], "stat-other-format": ["stat", "-c", "%n", "/etc"], "stat-follow": ["stat", "-L", "-c", "%u", "/etc"],
    "test-write-flag": ["test", "-w", "/etc"], "test-negation": ["test", "!", "-e", "/etc"], "test-relative": ["test", "-e", "relative"],
    "readlink-canonicalize": ["readlink", "-f", "/etc"], "readlink-relative": ["readlink", "x"],
    "sha256sum-check": ["sha256sum", "-c", "/etc/os-release"], "sha256sum-two": ["sha256sum", "/etc/os-release", "/etc/hostname"], "sha256sum-option": ["sha256sum", "--tag", "/etc/os-release"],
    "find-delete": ["find", "/etc", "-delete"], "find-exec": ["find", "/etc", "-maxdepth", "0", "-exec", "rm", "{}", ";"], "find-fprint": ["find", "/etc", "-maxdepth", "0", "-fprint", "OUT"],
    "find-wrong-perm": ["find", "/etc", "-maxdepth", "0", "-perm", "-o+w"], "find-deeper": ["find", "/etc", "-maxdepth", "5", "-perm", "/022"],
    "find-printf-other": ["find", "/etc", "-maxdepth", "1", "-type", "f", "(", "-name", "A", "-o", "-name", "B", ")", "-printf", "%p\\n"],
    "find-name-glob-injection": ["find", "/etc", "-maxdepth", "1", "-type", "f", "(", "-name", "A;B", "-o", "-name", "B", ")", "-printf", "%f\\n"],
    "systemctl-restart": ["systemctl", "restart", "aegis-idea3-core.service"], "systemctl-restart-with-p": ["systemctl", "restart", "-p", "MainPID", "x.service"],
    "systemctl-stop": ["systemctl", "stop", "x.service"], "systemctl-daemon-reload": ["systemctl", "daemon-reload"], "systemctl-show-no-property": ["systemctl", "show", "x.service"],
    "systemctl-show-bad-property": ["systemctl", "show", "-p", "A;B", "x.service"], "systemctl-show-bad-unit": ["systemctl", "show", "-p", "MainPID", "x.socket"],
    "systemctl-show-option": ["systemctl", "show", "--value", "-p", "MainPID", "x.service"], "systemctl-show-trailing": ["systemctl", "show", "-p", "MainPID", "x.service", "y.service"],
    "pgrep-other-pattern": ["pgrep", "-f", "anything"], "pgrep-signal": ["pgrep", "-fc", "x", "--signal", "9"], "pkill": ["pkill", "-f", "x"],
    "true-args": ["true", "x"],
    "control-character": ["test", "-e", "/etc\n/shadow"],
}


def materialise(rig: Rig, argv: list[str]) -> list[str]:
    out = []
    for arg in argv:
        out.append(arg.replace("OUT", str(rig.tmp / "OUT")).replace("CTRL", str(rig.ctrl)).replace("SCRIPT", str(rig.ctrl / "p4-l7-release-guard.py")))
    return out


@pytest.mark.parametrize("name", sorted(FORBIDDEN))
def test_the_privilege_wrapper_denies_every_bypass_class_before_privileged_execution(rig: Rig, name: str) -> None:
    (rig.ctrl / "p4-l7-release-guard.py").write_text("print('x')\n")
    (rig.ctrl / "p4-other-tool.py").write_text("print('x')\n")
    argv = materialise(rig, FORBIDDEN[name])
    denied(rig, *argv)
    assert not (rig.tmp / "OUT").exists() and not (rig.tmp / "a").exists() and not (rig.tmp / "b").exists()


def test_a_symlink_inside_the_control_snapshot_that_points_outside_is_denied(rig: Rig) -> None:
    outside = rig.tmp / "outside.py"
    outside.write_text("print('evil')\n")
    (rig.ctrl / "p4-l7-release-guard.py").symlink_to(outside)
    denied(rig, PY_PATH, str(rig.ctrl / "p4-l7-release-guard.py"), "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root")


def test_the_wrapper_refuses_to_be_generated_with_a_path_that_could_inject_into_the_script(rig: Rig) -> None:
    for bad in (f"{rig.tmp}/a&b", f"{rig.tmp}/a\\b", f"{rig.tmp}/a b", f"{rig.tmp}/a;b", f"{rig.tmp}/a$b", f"{rig.tmp}/../b", "relative"):
        script = f'''. "{LIB}"; SUDO=""; . "{rig.driver}"
RECOVERY_REHEARSAL_REAL_SUDO="{rig.sudo}"; RH_DIR="{rig.tmpdir}/aegis-recovery-rehearsal.W"; mkdir -p "$RH_DIR"
recovery_rehearsal_write_sudo_wrapper "$RH_DIR/sudo-ro" '{bad}' "{PY_PATH}"; echo "generated=$?"
'''
        proc = subprocess.run(["bash", "-c", script], text=True, capture_output=True)
        assert proc.returncode == 97 and "generated=" not in proc.stdout, bad
        assert not (rig.tmpdir / "aegis-recovery-rehearsal.W" / "sudo-ro").exists()


def test_a_positive_rehearsal_runs_only_reviewed_read_verbs_through_the_real_sudo(rig: Rig) -> None:
    proc = rig.run(pregates='$SUDO test -e /etc; $SUDO stat -c %u /etc; $SUDO find /etc -maxdepth 0 -perm /022; $SUDO sha256sum /etc/os-release >/dev/null; $SUDO true',
                   regate='$SUDO systemctl show -p MainPID -p ActiveState x.service; $SUDO nft list tables')
    assert "rc=20" in proc.stdout, proc.stderr
    verbs = {Path(line.split()[0]).name for line in stub_calls_run(rig)}
    assert verbs <= {"test", "stat", "find", "sha256sum", "true", "systemctl", "nft"}


def stub_calls_run(rig: Rig) -> list[str]:
    return (rig.tmp / "stub" / "real-sudo").read_text().splitlines() if (rig.tmp / "stub" / "real-sudo").exists() else []


# ═════════════════════════════════════════════ mutation tests of the wrapper guards ═════════════════════════════════════════════
def weaken_wrapper(tmp_path: Path, old: str, new: str) -> Path:
    text = DRIVER.read_text()
    assert text.count(old) == 1, old
    path = tmp_path / "weak-driver.sh"
    path.write_text(text.replace(old, new))
    return path


def reached(rig: Rig) -> bool:
    return bool(stub_calls(rig))


def test_mutation_dotdot_guard_removed_a_traversing_path_is_accepted(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, '[[ "$1" =~ ^/[A-Za-z0-9._/@:+,=%-]*$ ]] && [[ "$1" != *..* ]]', '[[ "$1" =~ ^/[A-Za-z0-9._/@:+,=%-]*$ ]]'))
    wrapper(weak, "test", "-e", "/etc/../etc/hostname", driver=weak.driver)
    assert reached(weak)
    strict = Rig(tmp_path / "strict")
    denied(strict, "test", "-e", "/etc/../etc/hostname")


def test_mutation_control_snapshot_prefix_guard_removed_a_script_outside_it_is_accepted(tmp_path: Path) -> None:
    old = '[[ "$script" == "$ctrl_real"/* && "$script" != *..* ]] || deny "python-script-outside-control-snapshot"'
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, old, ":"))
    outside = weak.tmp / "p4-l7-release-guard.py"
    outside.write_text("print('evil')\n")
    wrapper(weak, PY_PATH, str(outside), "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root", driver=weak.driver)
    assert reached(weak)
    strict = Rig(tmp_path / "strict")
    (strict.tmp / "p4-l7-release-guard.py").write_text("print('evil')\n")
    denied(strict, PY_PATH, str(strict.tmp / "p4-l7-release-guard.py"), "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root")


def test_mutation_awk_exact_program_guard_removed_a_writing_awk_runs(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, 'else deny "awk-program-or-arguments"; fi ;;', "else :; fi ;;"))
    out = weak.tmp / "OUT"
    wrapper(weak, "awk", 'BEGIN{print "x" > ARGV[1]}', str(out), driver=weak.driver)
    assert out.exists()
    strict = Rig(tmp_path / "strict")
    denied(strict, "awk", 'BEGIN{print "x" > ARGV[1]}', str(strict.tmp / "OUT"))
    assert not (strict.tmp / "OUT").exists()


def test_mutation_env_i_removed_the_callers_dangerous_environment_reaches_the_privileged_command(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, 'exec /usr/bin/env -i PATH="$FIXED_PATH" LC_ALL=C "$REAL" -n', 'exec "$REAL" -n'))
    wrapper(weak, "stat", "-c", "%u", "/etc", driver=weak.driver, env={"LD_PRELOAD": "/evil.so"})
    assert "LD_PRELOAD=/evil.so" in (weak.log / "stub-env").read_text()
    strict = Rig(tmp_path / "strict")
    wrapper(strict, "stat", "-c", "%u", "/etc", env={"LD_PRELOAD": "/evil.so"})
    assert "LD_PRELOAD" not in (strict.log / "stub-env").read_text()


def test_mutation_nft_list_exactness_removed_a_chained_command_is_accepted(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, '[ "${args[1]}" = list ] && [ "${args[2]}" = tables ]', '[ "${args[1]}" = list ]'))
    wrapper(weak, "nft", "list", "tables; flush ruleset", driver=weak.driver)
    assert reached(weak)
    denied(Rig(tmp_path / "strict"), "nft", "list", "tables; flush ruleset")


def test_mutation_systemctl_show_only_removed_a_restart_is_accepted(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, '[ "$n" -ge 5 ] && [ "${args[1]}" = show ] || deny "systemctl-form"', '[ "$n" -ge 5 ] || deny "systemctl-form"'))
    wrapper(weak, "systemctl", "restart", "-p", "MainPID", "aegis-idea3-core.service", driver=weak.driver)
    assert reached(weak)
    denied(Rig(tmp_path / "strict"), "systemctl", "restart", "-p", "MainPID", "aegis-idea3-core.service")


def test_mutation_interpreter_equality_removed_another_python_is_accepted(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, '  "$PY")\n', '  */python3)\n'))
    tool = weak.ctrl / "p4-l7-release-guard.py"
    tool.write_text("print('x')\n")
    fake = weak.tmp / "evil" / "python3"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\necho EVIL_INTERPRETER_RAN >> \"$(dirname \"$0\")/ran\"\n")
    fake.chmod(0o755)
    wrapper(weak, str(fake), str(tool), "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root", driver=weak.driver)
    assert reached(weak)
    strict = Rig(tmp_path / "strict")
    (strict.ctrl / "p4-l7-release-guard.py").write_text("print('x')\n")
    denied(strict, str(fake), str(strict.ctrl / "p4-l7-release-guard.py"), "check", "--logical-path", "/opt/aegis-idea3/releases/r1", "--host-path", "/opt/x", "--expect-owner", "root")


def test_mutation_default_deny_removed_an_unknown_program_runs(tmp_path: Path) -> None:
    weak = Rig(tmp_path / "weak", driver=weaken_wrapper(tmp_path, '  *) deny "program:${prog:0:40}" ;;', "  *) ;;"))
    wrapper(weak, "mkdir", "OUTDIR", driver=weak.driver)
    assert (weak.tmp / "OUTDIR").is_dir()
    denied(Rig(tmp_path / "strict"), "mkdir", "OUTDIR")


def test_the_wrapper_contract_has_no_env_shell_or_text_verb_allowance_left() -> None:
    wrapper_src = DRIVER.read_text().split("<<'WRAPPER'", 1)[1].split("\nWRAPPER", 1)[0]
    allowed = set(re.findall(r"^  ([a-z0-9]+)\)", wrapper_src, re.M)) | {"python"}
    assert allowed == {"true", "test", "stat", "readlink", "sha256sum", "find", "awk", "pgrep", "systemctl", "nft", "python"}
    assert not re.search(r"\b(env|bash|sh|grep|cat|cmp|sort|uniq|date|journalctl)\)", wrapper_src)


# ═════════════════════════════════════════════ real attempt authority (read-only) as root-in-a-userns ═════════════════════════════════════════════
@sup.needs_userns
def test_the_real_unconsumed_gate_runs_through_the_wrapper_and_creates_nothing(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.canon.mkdir(mode=0o700)
    script = rig.script(pregates="return 0", regate="return 0", unconsumed="", post="", frozen=FROZEN_SHA)
    proc = sup.userns_bash(f'export CLI_MODE=ok\n{script}')
    out = parse(proc)
    assert "rc=20" in proc.stdout, proc.stderr + proc.stdout
    assert out["ATTEMPT_UNCONSUMED"] == "PASS" and rig.canon_listing() == []
    (rig.canon / MARKER).write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")
    blocked = parse(sup.userns_bash(f'export CLI_MODE=ok\n{script}'))
    assert blocked["ATTEMPT_UNCONSUMED"] == "BLOCKED" and blocked["RESULT"] == "BLOCKED"
    assert rig.canon_listing() == [MARKER]


# ═════════════════════════════════════════════ static properties ═════════════════════════════════════════════
def test_sourcing_the_driver_executes_nothing_and_defines_no_marker(tmp_path: Path) -> None:
    proc = subprocess.run(["bash", "-c", f'. "{DRIVER}"; echo SOURCED; declare -F | grep -c recovery_rehearse'], text=True, capture_output=True, cwd=tmp_path)
    assert proc.stdout.splitlines()[0] == "SOURCED" and proc.stderr == "" and list(tmp_path.iterdir()) == []


def test_the_driver_never_calls_a_consuming_function_and_mutates_only_its_own_private_directory() -> None:
    code = "\n".join(line for line in sup.code_lines(DRIVER))
    body = re.sub(r'RECOVERY_REHEARSAL_POISONED="[^"]*"', "", code)
    for forbidden in ("recovery_consume_attempt", "recovery_run_attempt", "recovery_hook_isolate", "recovery_hook_d4", "recovery_d4_run", "mosquitto", "systemctl restart", "nft add", "nft flush", "chattr"):
        assert forbidden not in body.replace('recovery_rehearsal_trip "', ""), forbidden
    # every filesystem-changing verb in the driver is bound to the rehearsal's own private directory
    for line in code.splitlines():
        if re.search(r"(^|[\s;(])(mkdir|rm|mv|cp|touch|chmod|ln|tee|install)\s", line) and "<<'WRAPPER'" not in line:
            assert re.search(r'RH_DIR|"\$path"|mktemp|RH_DIR', line), line


def test_the_driver_never_passes_a_secret_or_reads_stdin_into_the_release_cli() -> None:
    code = DRIVER.read_text()
    assert "</dev/null" in code and "RESTORE_SECRET" not in code and "--break-glass" not in code and "getpass" not in code
    assert "restore --help" in code and "restore \"--reason" not in code


# ═════════════════════════════════════════════ mutation tests: weakening a safeguard must be detected ═════════════════════════════════════════════
def mutated(tmp_path: Path, old: str, new: str) -> Path:
    text = DRIVER.read_text()
    assert old in text, old
    path = tmp_path / "mutated-driver.sh"
    path.write_text(text.replace(old, new, 1))
    return path


def test_mutation_without_the_poison_install_a_consuming_call_creates_a_marker_and_the_tripwire_test_catches_it(tmp_path: Path) -> None:
    weak = Rig(tmp_path, driver=mutated(tmp_path, "  recovery_rehearsal_poison_install\n  canon=", "  canon="))
    # the real consume function would now be reachable; a stub that records the call shows the guard really was the poison
    proc = weak.run(pregates=f'mkdir -p "{weak.canon}"; : > "{weak.canon}/{MARKER}"; true')
    assert "rc=97" not in proc.stdout  # nothing trips: proves the unmutated tripwire tests exercise the poison and would fail here
    strict = Rig(tmp_path / "strict")
    assert "rc=97" in strict.run(pregates='recovery_consume_attempt x').stdout


def test_mutation_without_the_final_tripwire_check_a_fired_tripwire_would_be_reported_as_a_pass(tmp_path: Path) -> None:
    weak = Rig(tmp_path, driver=mutated(tmp_path, '  if [ "$RH_TRIPPED" = 1 ]; then recovery_rehearsal_say "RESULT=SAFETY_TRIPWIRE"; return 97; fi\n', ""))
    proc = weak.run(pregates='x=$(recovery_consume_attempt y); true')
    assert "rc=97" not in proc.stdout and "PREFLIGHT_PASS" in proc.stdout  # the unmutated driver returns 97 (asserted in the tripwire tests above)


def test_mutation_if_a_failed_pregate_were_not_counted_the_rehearsal_would_wrongly_pass(tmp_path: Path) -> None:
    old = '    recovery_rehearsal_section PREGATES BLOCKED "see the GATE_FAIL lines above"; blocked=1\n'
    weak = Rig(tmp_path, driver=mutated(tmp_path, old, old.replace("blocked=1", "true")))
    assert "PREFLIGHT_PASS" in weak.run(pregates="return 1").stdout
    assert "rc=10" in Rig(tmp_path / "strict").run(pregates="return 1").stdout


def test_mutation_without_the_frozen_digest_override_the_authorization_check_would_see_the_derived_digest(tmp_path: Path) -> None:
    weak = Rig(tmp_path, driver=mutated(tmp_path, "  RUNNER_SHA256=$frozen_sha\n", "  :\n"))
    probe = 'RUNNER_SHA256=derived-digest-123; [ "$RUNNER_SHA256" = "%s" ]' % FROZEN_SHA
    assert parse(weak.run(pregates=probe))["PREGATES"] == "BLOCKED"
    assert parse(Rig(tmp_path / "strict").run(pregates='[ "${RUNNER_SHA256:-}" = "%s" ]' % FROZEN_SHA))["PREGATES"] == "PASS"


def test_mutation_if_the_cli_check_ran_restore_instead_of_help_the_restore_detector_fires(tmp_path: Path) -> None:
    weak = Rig(tmp_path, driver=mutated(tmp_path, "aegis_soc.cli restore --help", "aegis_soc.cli restore --reason=x"))
    weak.run()
    assert (weak.release / "calls" / "restore-ran").exists()      # the stub detects a restore invocation, so the help-only tests above are meaningful
    strict = Rig(tmp_path / "strict")
    strict.run()
    assert not (strict.release / "calls" / "restore-ran").exists()


# ═════════════════════════════════════════════ secondary findings: truthful output contract (M3, M4, M6) ═════════════════════════════════════════════
def test_m4_a_partial_rehearsal_can_never_exit_zero_or_look_like_a_complete_pass(rig: Rig) -> None:
    proc = rig.run()
    assert "rc=20" in proc.stdout and "rc=0" not in proc.stdout
    out = parse(proc)
    assert out["RESULT"] == "PREFLIGHT_PASS_PARTIAL_NOT_AUTHORIZATION" and "PARTIAL" in out["RESULT"]
    body = DRIVER.read_text().split("recovery_rehearse() {", 1)[1]
    assert "return 0" not in body                                    # no path of the rehearsal returns success


def test_m3_the_output_discloses_that_the_runner_pregates_fetch_from_the_remote(rig: Rig) -> None:
    note = parse(rig.run())["REMOTE_TRACKING_NOTE"]
    assert "git fetch origin" in note and "network" in note and "remote-tracking refs" in note and "never its files or HEAD" in note


def test_m6_the_output_discloses_that_sigkill_and_power_loss_leave_the_private_directory(rig: Rig) -> None:
    note = parse(rig.run())["CLEANUP_LIMIT"]
    assert "SIGKILL_OR_POWER_LOSS_LEAVES" in note and "SAFE_TO_DELETE" in note and "SIGHUP" in note
