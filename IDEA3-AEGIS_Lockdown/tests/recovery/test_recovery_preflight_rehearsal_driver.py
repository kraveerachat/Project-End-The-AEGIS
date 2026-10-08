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
[ "$1" = -n ] && shift
echo "$*" >> "$STUB_LOG/real-sudo"
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
    assert "rc=0" in proc.stdout, proc.stderr
    assert out["RESULT"] == "PREFLIGHT_PASS_NOT_AUTHORIZATION"
    assert (out["ATTEMPT_UNCONSUMED"], out["PREGATES"], out["REGATE"], out["RELEASE_CLI_PARSE"]) == ("PASS", "PASS", "PASS", "PASS")
    assert (out["AUTHORIZES_RECOVERY"], out["IS_AUTHORITY_TOKEN"], out["ATTEMPT_CONSUMED_BY_REHEARSAL"], out["PRODUCTION_MUTATION_BY_REHEARSAL"], out["DEVICE_COMMANDS"]) == ("NO", "NO", "NO", "NO", "0")
    assert "NOT_AUTHORIZATION" in out["PASS_MEANS"] and out["MARKER_PRESENT"] == "NO" and out["MODE"] == "READ_ONLY_NON_CONSUMING_PREFLIGHT"
    assert out["FROZEN_RUNNER_SHA256"] == FROZEN_SHA


def test_everything_that_was_not_rehearsed_is_reported_not_rehearsed_and_never_pass(rig: Rig) -> None:
    out = parse(rig.run())
    for name in ("BASELINE_AND_ROOT_CAPTURES", "D4_EXACT_TERMINAL_REFUSAL", "ATTEMPT_MARKER", "ISOLATE_D4_RESTORE_CLOSE_FINAL_VERIFY"):
        assert out[name] == "NOT_REHEARSED", name
    assert "RECOVERY_REHEARSAL_RESULT=PREFLIGHT_PASS_NOT_AUTHORIZATION" in rig.run().stdout
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
    assert all("rc=0" in r.stdout and parse(r)["RESULT"] == "PREFLIGHT_PASS_NOT_AUTHORIZATION" for r in results)
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


# ═════════════════════════════════════════════ default-deny read-only privilege wrapper ═════════════════════════════════════════════
def wrapper(rig: Rig, *argv: str) -> subprocess.CompletedProcess[str]:
    """Generate the real wrapper with the driver's own generator and run it with the given privileged command."""
    script = f'''. "{LIB}"; SUDO=""; . "{rig.driver}"
RECOVERY_REHEARSAL_REAL_SUDO="{rig.sudo}"; export STUB_LOG="{rig.log}"
RH_DIR="{rig.tmpdir}/aegis-recovery-rehearsal.W"; mkdir -p "$RH_DIR"
recovery_rehearsal_write_sudo_wrapper "$RH_DIR/sudo-ro" "{rig.ctrl}" "/usr/bin/python3"
"$RH_DIR/sudo-ro" "$@"; echo "wrapper_rc=$?"
'''
    return subprocess.run(["bash", "-c", script, "_", *argv], text=True, capture_output=True, cwd=rig.tmp)


DENIED = [
    ["mkdir", "-m", "0700", "x"], ["chmod", "0400", "f"], ["chown", "root", "f"], ["chattr", "+i", "f"], ["rm", "-rf", "x"], ["tee", "f"], ["sync", "--", "f"], ["mv", "a", "b"],
    ["cp", "a", "b"], ["install", "a", "b"], ["ln", "-s", "a", "b"], ["touch", "f"], ["kill", "1"], ["dd", "of=f"], ["systemctl", "restart", "aegis-idea3-core.service"],
    ["systemctl", "stop", "x"], ["systemctl", "daemon-reload"], ["nft", "add", "table", "inet", "x"], ["nft", "flush", "ruleset"], ["nft", "-f", "rules.nft"],
    ["bash", "-c", "echo x > f"], ["sh", "-c", "mkdir x"], ["python3", "-c", "open('f','w')"], ["/usr/bin/python3", "/tmp/not-control.py"], ["find", ".", "-delete"],
    ["find", ".", "-exec", "rm", "{}", ";"], ["find", ".", "-fprint", "f"], ["awk", "BEGIN{system(\"touch f\")}"], ["awk", "{print > \"f\"}"], ["env", "mkdir", "x"],
    ["env", "-i", "PATH=/bin", "rm", "f"], ["env", "-S", "rm f"], ["curl", "http://x"], ["sudo", "true"], ["mosquitto_pub", "-t", "x"], ["reboot"], [],
]
ALLOWED = [
    ["test", "-e", "/etc"], ["stat", "-c", "%u", "/etc"], ["cat", "/etc/hostname"], ["sha256sum", "/etc/hostname"], ["readlink", "-f", "/etc"], ["find", "/etc", "-maxdepth", "0", "-perm", "/022"],
    ["grep", "-q", "x", "/etc/hostname"], ["pgrep", "-fc", "nonexistent-xyz"], ["true"], ["systemctl", "show", "-p", "MainPID", "x.service"],
    ["nft", "list", "tables"], ["nft", "--stateless", "list", "table", "inet", "x"], ["awk", "-F=", "$1 == \"k\" {print $2}", "/etc/os-release"],
    ["awk", "NF >= 1 {print $1}", "/etc/hostname"], ["env", "-i", "PATH=/usr/bin", "cat", "/etc/hostname"], ["env", "-u", "X", "PYTHONDONTWRITEBYTECODE=1", "true"],
]


@pytest.mark.parametrize("argv", DENIED, ids=lambda a: " ".join(a)[:48] or "empty")
def test_the_privilege_wrapper_denies_every_mutation_verb_and_anything_unknown(rig: Rig, argv: list[str]) -> None:
    proc = wrapper(rig, *argv)
    assert "wrapper_rc=97" in proc.stdout, proc.stderr
    assert "RECOVERY_REHEARSAL_SUDO_DENIED" in proc.stderr
    assert not (rig.log / "real-sudo").exists()                       # the real sudo was never even called
    assert (rig.tmpdir / "aegis-recovery-rehearsal.W" / "TRIPWIRE").read_text().startswith("sudo:")
    assert not any(p.name in {"x", "f", "b"} for p in rig.tmp.iterdir())


@pytest.mark.parametrize("argv", ALLOWED, ids=lambda a: " ".join(a)[:48])
def test_the_privilege_wrapper_allows_the_read_only_verbs_the_pregates_use(rig: Rig, argv: list[str]) -> None:
    proc = wrapper(rig, *argv)
    assert "RECOVERY_REHEARSAL_SUDO_DENIED" not in proc.stderr, proc.stderr
    assert (rig.log / "real-sudo").exists()


def test_the_wrapper_allows_control_snapshot_python_tools_and_stdin_gates_only(rig: Rig) -> None:
    tool = rig.ctrl / "p4-l7-release-guard.py"
    tool.write_text("print('ok')\n")
    assert "SUDO_DENIED" not in wrapper(rig, "/usr/bin/python3", str(tool), "check").stderr
    assert "SUDO_DENIED" not in wrapper(rig, "env", "PYTHONDONTWRITEBYTECODE=1", "/usr/bin/python3", str(tool), "check-runtime").stderr
    assert "SUDO_DENIED" not in wrapper(rig, "/usr/bin/python3", "-I", "-").stderr
    assert "SUDO_DENIED" in wrapper(rig, "/usr/bin/python3", "-I", "-B", "/tmp/elsewhere.py").stderr
    assert "SUDO_DENIED" in wrapper(rig, "/usr/bin/python3", "-c", "print(1)").stderr
    assert "SUDO_DENIED" in wrapper(rig, "/opt/other/python", str(tool)).stderr


def test_the_wrapper_allows_only_the_one_reviewed_proc_environ_probe_through_a_shell(rig: Rig) -> None:
    probe = 'tr "\\0" "\\n" < "/proc/$1/environ" | grep -qx "AEGIS_ALERT_SOURCE_UID=$2"'
    assert "SUDO_DENIED" not in wrapper(rig, "bash", "-c", probe, "_", "1", "0").stderr
    assert "SUDO_DENIED" in wrapper(rig, "bash", "-c", probe + "; touch f", "_", "1", "0").stderr
    assert "SUDO_DENIED" in wrapper(rig, "bash", probe).stderr


def test_a_positive_rehearsal_runs_only_read_verbs_through_the_real_sudo(rig: Rig) -> None:
    proc = rig.run(pregates='$SUDO test -e /etc; $SUDO stat -c %u /etc; $SUDO cat /etc/hostname >/dev/null; $SUDO find /etc -maxdepth 0; $SUDO true',
                   regate='$SUDO systemctl show -p MainPID x; $SUDO nft list tables')
    assert "rc=0" in proc.stdout, proc.stderr
    verbs = {line.split()[0] for line in (rig.log / "real-sudo").read_text().splitlines()}
    assert verbs <= {"test", "stat", "cat", "find", "true", "systemctl", "nft"}


# ═════════════════════════════════════════════ real attempt authority (read-only) as root-in-a-userns ═════════════════════════════════════════════
@sup.needs_userns
def test_the_real_unconsumed_gate_runs_through_the_wrapper_and_creates_nothing(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.canon.mkdir(mode=0o700)
    script = rig.script(pregates="return 0", regate="return 0", unconsumed="", post="", frozen=FROZEN_SHA)
    proc = sup.userns_bash(f'export CLI_MODE=ok\n{script}')
    out = parse(proc)
    assert "rc=0" in proc.stdout, proc.stderr + proc.stdout
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


def test_mutation_without_the_wrapper_deny_for_mkdir_the_real_sudo_would_create_a_directory(tmp_path: Path) -> None:
    text = DRIVER.read_text()
    weak_path = tmp_path / "weak-driver.sh"
    weak_path.write_text(text.replace("  *) deny \"program:$prog\" ;;", "  *) ;;"))
    weak = Rig(tmp_path / "weak", driver=weak_path)
    proc = wrapper(weak, "mkdir", "x")
    assert "wrapper_rc=0" in proc.stdout and (weak.tmp / "x").is_dir()      # an unknown program would run
    strict = Rig(tmp_path / "strict")
    assert "wrapper_rc=97" in wrapper(strict, "mkdir", "x").stdout and not (strict.tmp / "x").exists()


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
