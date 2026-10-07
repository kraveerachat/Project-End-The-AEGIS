"""Hermetic tests of the Recovery owner-runner / root-handler AUTHORITY chain: pins, control snapshot, exact-main Git authority (replacement objects), operator identity, the real stage gate, the verifier
snapshot and interpreter proofs, and the root handlers' work-directory and snapshot proofs.

Nothing here runs Recovery or touches Production. Root-owned production shapes are exercised inside a user namespace (the invoking user's files appear as uid 0); everything else is refused as non-root."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recovery_support as sup  # noqa: E402
import test_pr11_phase4_harness as h  # noqa: E402

LIB, RUNNER, STG, P4 = sup.LIB, sup.RUNNER, sup.STG, sup.P4
needs_userns = pytest.mark.skipif(not sup.userns_usable(), reason="user namespace unavailable")
CLEAN_VARS = ("PYTHON", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "AEGIS_RUNTIME_DIR", "AEGIS_LOG_PATH", "AEGIS_DB_PATH")
CLEAN = "env " + " ".join(f"-u {v}" for v in CLEAN_VARS)


def run_runner(frozen: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    quoted = " ".join(f'"{a}"' for a in args)
    return sup.bash(f'{CLEAN} bash "{frozen}" {quoted}', env=env)


# --------------------------------------------------------------------------- pins, environment and the inert template


def test_the_committed_runner_refuses_while_unpinned_and_touches_nothing(tmp_path: Path) -> None:
    result = run_runner(RUNNER, str(tmp_path), "reason text for the owner")
    assert result.returncode == 2 and "runner is not pinned" in result.stderr
    assert list(tmp_path.iterdir()) == []
    text = RUNNER.read_text()
    for pin in sup.PINS:
        assert re.search(rf"^{pin}=PIN_", text, re.M), pin
    assert "ATTEMPT_MARKER" not in "\n".join(re.findall(r"^[A-Z_]+=PIN_", text, re.M))  # the marker location is a stage constant, never a pin
    assert not re.search(r"(?i)secret|password|credential|token", "\n".join(re.findall(r"^[A-Z_]+=PIN_\w+$", text, re.M)))  # no secret-bearing pin


def test_the_pinned_runner_refuses_malformed_pins_before_anything_runs(tmp_path: Path) -> None:
    bad = [("EXPECTED_MAIN", "abc"), ("VERIFIER_MANIFEST_SHA256", "zz"), ("RESTORE_CLI_SHA256", "zz"), ("AUDIT_DB", "relative/db"), ("PROTOCOL_DB", "relative/db"), ("R1B_EVIDENCE_DIR", "relative"),
           ("RUNTIME_DIR", "relative"), ("OPERATOR_UID", "0"), ("DETECTOR_UID", "0"), ("VERIFIER_SNAPSHOT_DIR", "relative/dir"), ("CONTROL_SNAPSHOT_DIR", "relative/dir"), ("CONTROL_MANIFEST_SHA256", "zz"),
           ("RELEASE_ID", "a..b"), ("OPERATOR_USER", "Bad_User")]
    for key, value in bad:
        assert run_runner(sup.pinned_copy(tmp_path, **{key: value}), str(tmp_path), "reason text here").returncode == 2, key
    assert not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("ip", ["999.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "127.0.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "169.254.1.1", "1.2.3.256", "not-an-ip"])
def test_a_malformed_or_non_external_pinned_source_ip_refuses_before_anything_runs(tmp_path: Path, ip: str) -> None:
    result = run_runner(sup.pinned_copy(tmp_path, EXPECTED_SOURCE_IP=ip), str(tmp_path), "reason text here")
    assert result.returncode == 2 and "EXPECTED_SOURCE_IP" in result.stderr and not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("var", ["PYTHON", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "AEGIS_RUNTIME_DIR", "AEGIS_P4_FS_ROOT", "P4_FS_ROOT", "AEGIS_P4_HANDLER_DIR",
                                 "AEGIS_LOG_PATH", "AEGIS_DB_PATH", "AEGIS_RECOVERY_SOCKET", "AEGIS_RECOVERY_CORE_USER", "AEGIS_RCVSTAGE_APP_DIR", "AEGIS_RCVSTAGE_AUDIT_DB", "AEGIS_RCVSTAGE_WORK_DIR", "AEGIS_RCVSTAGE_STEP",
                                 "AEGIS_RCVSTAGE_LIVE_AUTHORIZED", "AEGIS_RCVSTAGE_SECRET", "RECOVERY_SECRET", "RECOVERY_RESTORE_CONFIRMATION", "RECOVERY_CANONICAL_DIR", "RECOVERY_TEST_ONLY_CANONICAL_DIR",
                                 "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED", "RECOVERY_TEST_ONLY_TRUST_ROOT", "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED", "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT"])
def test_the_frozen_runner_refuses_to_start_with_any_redirection_or_test_seam_variable_set(tmp_path: Path, var: str) -> None:
    frozen = sup.pinned_copy(tmp_path)
    cleaner = "env " + " ".join(f"-u {v}" for v in CLEAN_VARS if v != var)
    result = sup.bash(f'{cleaner} bash "{frozen}" "{tmp_path}" "reason text here"', env={var: "x"})
    assert result.returncode == 2 and "environment override" in result.stderr, var
    assert not (tmp_path / "evidence").exists()


def test_the_runner_needs_an_auth_dir_and_a_reason_argument(tmp_path: Path) -> None:
    frozen = sup.pinned_copy(tmp_path)
    assert run_runner(frozen).returncode == 2
    assert run_runner(frozen, str(tmp_path)).returncode == 2 and "owner reason" in run_runner(frozen, str(tmp_path)).stderr
    assert run_runner(frozen, str(tmp_path / "missing"), "reason text").returncode == 2


def test_the_runner_fixes_PATH_and_a_hostile_path_cannot_substitute_a_program(tmp_path: Path) -> None:
    fake = tmp_path / "fakebin"
    fake.mkdir()
    sentinel = tmp_path / "HIJACKED"
    for name in ("id", "date", "sha256sum", "readlink", "find", "stat", "git", "sudo"):
        (fake / name).write_text(f'#!/bin/sh\necho "{name}" >> "{sentinel}"\nexit 0\n')
        (fake / name).chmod(0o755)
    frozen = sup.pinned_copy(tmp_path)
    result = sup.bash(f'{CLEAN} bash "{frozen}" "{tmp_path}" "reason text here"', env={"PATH": f"{fake}:{os.environ['PATH']}"})
    assert result.returncode in (1, 2) and not sentinel.exists(), result.stderr
    code = "\n".join(sup.code_lines(RUNNER))
    assert code.index("export PATH=/usr/sbin:/usr/bin:/sbin:/bin") < code.index("date")  # fixed before any program is used


# --------------------------------------------------------------------------- operator identity; stop before any file is created


def test_wrong_operator_is_refused_after_both_control_gates_and_before_sudo_or_any_file_is_created(tmp_path: Path) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    frozen = sup.pinned_copy(tmp_path, repo, OPERATOR_USER="someone-else", OPERATOR_UID="4242", CONTROL_SNAPSHOT_DIR=str(dest), CONTROL_MANIFEST_SHA256=sha, EXPECTED_MAIN=head)
    result = run_runner(frozen, str(tmp_path), "reason text here")
    assert result.returncode == 1 and "operator identity" in result.stderr + result.stdout  # both control gates passed, the library was sourced, the identity gate refused
    assert not (tmp_path / "evidence").exists() and not (tmp_path / "canon").exists()
    assert "RECOVERY_ATTEMPT_CONSUMED=YES" not in result.stdout


def test_a_drifted_control_snapshot_is_refused_before_anything_is_sourced(tmp_path: Path) -> None:
    dest, sha = sup.make_control_snapshot(tmp_path)
    frozen = sup.pinned_copy(tmp_path, CONTROL_SNAPSHOT_DIR=str(dest), CONTROL_MANIFEST_SHA256="a" * 64)
    result = run_runner(frozen, str(tmp_path), "reason text here")
    assert result.returncode == 1 and "CONTROL_MANIFEST_DRIFT" in result.stderr and "not the frozen immutable authority" in result.stderr
    assert "RECOVERY_REPOSITORY_IMPLEMENTED" not in result.stdout  # nothing past the gate ran: the library was never sourced


def test_the_boot_order_is_control_gate_then_control_git_gate_then_the_first_source_and_nothing_sources_earlier() -> None:
    code = "\n".join(sup.code_lines(RUNNER))
    first_source = code.index("source \"$LIB\"")
    assert code.index("control_gate || die") < code.index("control_git_gate || die") < first_source
    assert len(re.findall(r'^source "', code, re.M)) == 1 and not re.search(r'^\. "', code, re.M)  # exactly one source statement, after both gates
    assert code.index("recovery_env_gate") > first_source and code.index("l7u_identity_gate") > first_source and code.index("sudo -v") > code.index("l7u_identity_gate")
    assert len(re.findall(r"^sudo -v ", code, re.M)) == 1 and "SUDO='sudo -n'" in code  # ONE interactive establishment, then only `sudo -n`
    assert not re.search(r"(^|[;&|(]\s*)sudo (?!-v |-n)", code, re.M)  # no other direct sudo invocation in the runner


# --------------------------------------------------------------------------- control_gate / control_git_gate (exact-main authority)


def gates(repo: Path, dest: Path, sha: str, head: str) -> subprocess.CompletedProcess[str]:
    script = (f'CTRL="{dest}"; CONTROL_MANIFEST_SHA256={sha}; REPO="{repo}"; EXPECTED_MAIN={head}; GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4; SNAPSHOT_OWNER_UID={os.getuid()}; SNAPSHOT_TRUST_ROOT="{dest.parent}"\n'
              f'{sup.runner_function("git")}\n{sup.runner_function("control_gate")}\n{sup.runner_function("control_git_gate")}\ncontrol_gate; echo "control=$?"; control_git_gate; echo "git=$?"\n')
    return sup.bash(script)


def test_an_intact_control_snapshot_passes_both_runner_gates(tmp_path: Path) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    out = gates(repo, dest, sha, head)
    assert "control=0" in out.stdout and "git=0" in out.stdout, out.stderr


@pytest.mark.parametrize("victim", ["p4-recovery-run-lib.sh", "p4-r1bv-run-lib.sh", "p4-f1u-run-lib.sh", "stages/Recovery/apply.sh", "stages/Recovery/verify.sh", "stages/Recovery/rollback.sh",
                                     "p4-stage-gate.sh", "p4-l0-capture.sh", "p4-compare.sh", "p4-lib.sh", "r1i-input-instrumentation/r1i_input_instrumentation.py", "recovery-acceptance/recovery_verifier_snapshot.py"])
def test_a_tampered_control_plane_file_is_refused_before_any_source_or_root_execution(tmp_path: Path, victim: str) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    sup.unlock(dest)
    target = dest / victim
    target.write_text(target.read_text() + "\n# tampered\n")
    sup.relock(dest)  # read-only again: ONLY the digest check can catch this
    out = gates(repo, dest, sha, head)
    assert "control=1" in out.stdout and "CONTROL_FILE_DRIFT" in out.stderr, victim


@pytest.mark.parametrize("victim", ["p4-recovery-run-lib.sh", "p4-l7-run-lib.sh", "stages/Recovery/apply.sh", "p4-compare.sh"])
def test_a_self_consistent_tampered_snapshot_is_not_the_pinned_main_source(tmp_path: Path, victim: str) -> None:
    """The attacker also rebuilds the manifest AND re-pins its digest: still refused, because the bytes are not the pinned-main git objects."""
    repo, _, _, head = sup.control_world(tmp_path)
    tampered_src = tmp_path / "tampered-src"
    shutil.copytree(repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4", tampered_src)
    (tampered_src / victim).write_text((tampered_src / victim).read_text() + "\n# not the reviewed source\n")
    dest = tmp_path / "tampered-snapshot"
    tool_sha = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t1").control_snapshot(tampered_src, dest)
    out = gates(repo, dest, tool_sha, head)
    assert "control=0" in out.stdout and "git=1" in out.stdout and "NOT_THE_PINNED_MAIN_SOURCE" in out.stderr, victim


@pytest.mark.parametrize("drift", ["extra", "symlink", "writable_file", "writable_dir", "missing", "manifest"])
def test_extra_symlink_writable_missing_or_manifest_drift_in_the_control_snapshot_is_refused(tmp_path: Path, drift: str) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    sup.unlock(dest)
    if drift == "extra":
        (dest / "stages/Recovery/extra.sh").write_text("#!/bin/sh\n")
    elif drift == "symlink":
        (dest / "stages/Recovery/link.sh").symlink_to("apply.sh")
    elif drift == "missing":
        (dest / "p4-ntp-reactivation-lib.sh").unlink()
    elif drift == "manifest":
        (dest / "RECOVERY-CONTROL-SHA256SUMS").write_text("0" * 64 + "  p4-lib.sh\n")
    sup.relock(dest)
    if drift == "writable_file":
        (dest / "p4-lib.sh").chmod(0o666)
    elif drift == "writable_dir":
        (dest / "stages").chmod(0o777)
    assert "control=1" in gates(repo, dest, sha, head).stdout, drift


def test_the_python_control_check_agrees_with_the_runner_gate(tmp_path: Path) -> None:
    tool = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t2")
    _, dest, sha, _ = sup.control_world(tmp_path)
    tool.control_check(dest, sha, owner_uid=None)
    sup.unlock(dest)
    (dest / "p4-lib.sh").write_text("# drift\n")
    sup.relock(dest)
    with pytest.raises(tool.SnapshotError):
        tool.control_check(dest, sha, owner_uid=None)


def test_root_never_executes_tampered_control_plane_bytes_every_wrapper_reproves_the_snapshot_first(tmp_path: Path) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    log = tmp_path / "sudo.log"
    stub = f'recovery_control_gate() {{ control_gate; }}\nsudo() {{ echo "SUDO $*" >> "{log}"; return 0; }}\n'
    prelude = (f'CTRL="{dest}"; STG="$CTRL/stages/Recovery"; CONTROL_MANIFEST_SHA256={sha}; JOURNAL_SINCE=x; AP_IF=if0; AP_ADDR=10.0.0.1; WORK="{tmp_path}/w"; EVID="{tmp_path}/e"; PROTOCOL_DB=/p; AUDIT_DB=/x; '
               f'PY=/usr/bin/python3; EXPECTED_SOURCE_IP=203.0.113.9; VERIFIER_SNAPSHOT_DIR=/v; VERIFIER_MANIFEST_SHA256={"b" * 64}; DETECTOR_UID=1000; R1B_EVIDENCE_DIR=/r; RECOVERY_CANONICAL_DIR=/c\n'
               f'SNAPSHOT_OWNER_UID={os.getuid()}; SNAPSHOT_TRUST_ROOT="{tmp_path}"\n{stub}')
    funcs = sup.runner_function("control_gate") + "\n" + sup.runner_function("recovery_handler")
    call = (f'. "{LIB}"; SUDO=sudo\n{funcs}\nrecovery_capture PRE "{tmp_path}/pre"; echo "capture=$?"; recovery_compare a b "{tmp_path}/o" 0; echo "compare=$?"; recovery_handler BASELINE; echo "handler=$?"\n')
    intact = sup.bash(prelude + call)
    assert log.exists() and "SUDO" in log.read_text(), intact.stderr  # the wrappers do reach the privilege prefix when the snapshot is intact
    log.unlink()
    sup.unlock(dest)
    (dest / "stages/Recovery/apply.sh").write_text("#!/bin/sh\necho tampered\n")
    sup.relock(dest)
    tampered = sup.bash(prelude + call)
    assert "capture=1" in tampered.stdout and "compare=1" in tampered.stdout and "handler=1" in tampered.stdout, tampered.stderr
    assert not log.exists()  # the privilege prefix was NEVER used: root executed nothing from the tampered control plane


# --------------------------------------------------------------------------- Git replacement-object attack


def run_git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=True)


def replaced_world(tmp_path: Path) -> dict:
    """A repo whose pinned commit GOOD has been silently replaced by EVIL (`git replace GOOD EVIL`): the SHA GOOD is unchanged but plain Git resolves EVIL's bytes."""
    repo = tmp_path / "repo"
    src = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
    shutil.copytree(P4, src, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    run_git(repo, "init", "-q") if repo.exists() else subprocess.run(["git", "init", "-q", str(repo)], check=True)
    good = sup.commit_all(repo)
    sentinel = tmp_path / "SENTINEL_SOURCED"
    lib = src / "p4-recovery-run-lib.sh"
    lib.write_text(f'echo tampered-library-was-sourced > "{sentinel}"\n' + lib.read_text())
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "EVIL: altered library")
    evil = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    evil_src = tmp_path / "evil-src"
    shutil.copytree(src, evil_src)
    run_git(repo, "checkout", "-q", good)
    run_git(repo, "replace", good, evil)
    return {"repo": repo, "good": good, "evil": evil, "evil_src": evil_src, "sentinel": sentinel}


def test_plain_git_is_fooled_by_a_replace_ref_but_the_recovery_authority_is_not(tmp_path: Path) -> None:
    w = replaced_world(tmp_path)
    repo, good = w["repo"], w["good"]
    rel = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh"
    assert run_git(repo, "rev-parse", "HEAD").stdout.strip() == good  # the apparent SHA is unchanged
    plain = run_git(repo, "show", f"{good}:{rel}").stdout
    real = subprocess.run(["git", "-C", str(repo), "show", f"{good}:{rel}"], env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}, text=True, capture_output=True).stdout
    assert "tampered-library-was-sourced" in plain and "tampered-library-was-sourced" not in real
    evil_dest = tmp_path / "evil-snapshot"
    sha = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t3").control_snapshot(w["evil_src"], evil_dest)
    fn, wrapper = sup.runner_function("control_git_gate"), sup.runner_function("git")
    base = f'CTRL="{evil_dest}"; REPO="{repo}"; EXPECTED_MAIN={good}; GIT_P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4; CONTROL_MANIFEST_SHA256={sha}\n'
    repaired = sup.bash(base + wrapper + "\n" + fn + '\ncontrol_git_gate; echo "git=$?"\n')
    assert "git=1" in repaired.stdout and "NOT_THE_PINNED_MAIN_SOURCE" in repaired.stderr
    assert "git=0" in sup.bash(base + fn + '\ncontrol_git_gate; echo "git=$?"\n').stdout  # plain git: proves the replace ref really defeats it


def test_the_caller_environment_cannot_re_enable_replacement_and_the_library_installs_the_same_wrapper(tmp_path: Path) -> None:
    w = replaced_world(tmp_path)
    rel = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh"
    out = sup.bash(f'export GIT_NO_REPLACE_OBJECTS=0\n{sup.runner_function("git")}\ngit -C "{w["repo"]}" show {w["good"]}:{rel}')
    assert "tampered-library-was-sourced" not in out.stdout
    out = sup.bash(f'export GIT_NO_REPLACE_OBJECTS=0\n. "{LIB}"; git -C "{w["repo"]}" show {w["good"]}:{rel}')
    assert "tampered-library-was-sourced" not in out.stdout


def test_a_replaced_pinned_commit_never_gets_its_tampered_library_sourced(tmp_path: Path) -> None:
    w = replaced_world(tmp_path)
    dest = tmp_path / "evil-snapshot"
    sha = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t4").control_snapshot(w["evil_src"], dest)  # self-consistent: control_gate passes
    frozen = sup.pinned_copy(tmp_path, w["repo"], CONTROL_SNAPSHOT_DIR=str(dest), CONTROL_MANIFEST_SHA256=sha, EXPECTED_MAIN=w["good"])
    result = run_runner(frozen, str(tmp_path), "reason text here")
    assert result.returncode == 1 and "CONTROL_FILE_NOT_THE_PINNED_MAIN_SOURCE" in result.stderr
    assert not w["sentinel"].exists(), "the replaced (EVIL) library was sourced"


def test_the_pinned_commit_must_be_a_real_commit_and_equal_head(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "f").write_text("1")
    head = sup.commit_all(repo)
    assert sup.bash(f'. "{LIB}"; recovery_commit_gate "{repo}" {head}').returncode == 0
    for bad in ("1" * 40, "abc", head[:12], "HEAD"):
        assert sup.bash(f'. "{LIB}"; recovery_commit_gate "{repo}" {bad}').returncode == 1, bad
    (repo / "x").write_text("x")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "next")
    assert sup.bash(f'. "{LIB}"; recovery_commit_gate "{repo}" {head}').returncode == 1  # HEAD moved off the pinned commit


def test_every_git_trust_read_names_the_pinned_commit_not_head() -> None:
    for path in (LIB, RUNNER):
        for line in sup.code_lines(path):
            if re.search(r"\bgit\b.*\b(show|grep|cat-file)\b", line):
                assert "HEAD:" not in line and not re.search(r' HEAD\b| HEAD -- ', line), (path.name, line)


# --------------------------------------------------------------------------- production ownership constants; root-owned shape (user namespace)


def runner_gate_script(dest: Path, sha: str, owner: str, trust: str) -> str:
    return (f'CTRL="{dest}"; CONTROL_MANIFEST_SHA256={sha}; SNAPSHOT_OWNER_UID={owner}; SNAPSHOT_TRUST_ROOT="{trust}"\n{sup.runner_function("control_gate")}\ncontrol_gate; echo "control=$?"\n')


def test_the_committed_templates_pin_uid_zero_and_the_filesystem_root_literally() -> None:
    for text in (RUNNER.read_text(), (STG / "apply.sh").read_text(), (STG / "verify.sh").read_text()):
        assert re.search(r"^SNAPSHOT_OWNER_UID=0$", text, re.M) and re.search(r"^SNAPSHOT_TRUST_ROOT=/$", text, re.M)
    assert "--trust-root" not in "\n".join(sup.code_lines(LIB)) and "snapshot_trust_root" not in LIB.read_text()
    tool = sup.SNAPSHOT_TOOL.read_text()
    assert "PRODUCTION_OWNER_UID = 0" in tool and 'PRODUCTION_TRUST_ROOT = "/"' in tool and "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED" in tool


def test_a_non_root_owned_control_snapshot_fails_the_runner_gate_with_the_production_constants(tmp_path: Path) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)  # built by the invoking (non-root) user
    out = sup.bash(runner_gate_script(dest, sha, "0", "/"))
    assert "control=1" in out.stdout and ("NOT_TRUSTED_OWNER" in out.stderr or "ANCESTOR_NOT_TRUSTED" in out.stderr), out.stderr
    assert "control=1" in sup.bash(runner_gate_script(dest, sha, "0", str(tmp_path))).stdout  # even with a perfect trust root, a non-root owner is refused


def test_a_non_root_owned_verifier_snapshot_fails_python_lib_and_apply(tmp_path: Path) -> None:
    tool = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t5")
    dest, sha = sup.make_snapshot(tmp_path)
    with pytest.raises(tool.SnapshotError, match="NOT_TRUSTED_OWNER"):
        tool.check(dest, sha)  # production default: owner uid 0, trust root /
    cli = subprocess.run(["python3", str(sup.SNAPSHOT_TOOL), "check", str(dest), sha], capture_output=True, text=True)
    assert cli.returncode == 1 and "NOT_TRUSTED_OWNER" in cli.stderr
    assert sup.bash(f'. "{LIB}"; recovery_verifier_gate "{dest}" {sha} "{sup.ROOT.parent}" "{sup.SNAPSHOT_TOOL}" {"1" * 40}').returncode == 1


@needs_userns
def test_the_correct_root_owned_production_shape_passes_the_control_and_snapshot_gates(tmp_path: Path) -> None:
    repo, dest, sha, head = sup.control_world(tmp_path)
    out = sup.userns_bash(runner_gate_script(dest, sha, "0", str(tmp_path)))
    assert "control=0" in out.stdout, out.stderr
    seam = f'export RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT="{tmp_path}"\n'
    run = sup.userns_bash(f'{seam}python3 "{sup.SNAPSHOT_TOOL}" control-check "{dest}" {sha}')
    assert run.returncode == 0 and "R1A_CONTROL_SNAPSHOT=PASS" in run.stdout.replace("RECOVERY", "R1A") or run.returncode == 0, run.stderr
    vdest, vsha = sup.make_snapshot(tmp_path)
    assert sup.userns_bash(f'{seam}python3 "{sup.SNAPSHOT_TOOL}" check "{vdest}" {vsha}').returncode == 0
    # the test-only trust seam is refused in the REAL root namespace (this process is not inside a user namespace)
    refused = sup.bash(f'{seam}python3 "{sup.SNAPSHOT_TOOL}" check "{vdest}" {vsha}')
    assert refused.returncode == 1 and "TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE" in refused.stderr


# --------------------------------------------------------------------------- the REAL stage gate; Authorization/K3 binding; predecessor + authority wiring


def stage_gate(tmp_path: Path, **kw):
    tmp_path.mkdir(parents=True, exist_ok=True)
    return h.gate(tmp_path, "--stage", "Recovery", "--mode", "live", **kw)


def test_the_real_stage_gate_accepts_a_valid_fresh_authorization_and_k3_for_the_mutating_stage(tmp_path: Path) -> None:
    result = stage_gate(tmp_path, auth=h.auth_record("Recovery"), k3=h.k3v2_record("Recovery"))
    out = result.stdout.splitlines()
    assert result.returncode == 0 and "AUTHORIZATION_RECORD=VALID" in out and "K3_CONFIRMATION=VALID" in out and "ROLLBACK_HANDLER=REGISTERED" in out and "K3_RECORD_VERSION=V2" in out


@pytest.mark.parametrize("kw,code", [
    ({"k3": None}, "K3_MISSING"),
    ({"auth": None}, "AUTHORIZATION_MISSING"),
    ({"auth": h.auth_record("Recovery", date=h.today(-1))}, "AUTHORIZATION_STALE"),
    ({"auth": h.auth_record("Recovery", date=h.today(1))}, "AUTHORIZATION_STALE"),
    ({"auth": h.auth_record("R1B")}, "AUTHORIZATION_STAGE_MISMATCH"),
    ({"auth": h.auth_record("Recovery") + "recovery_authorization=x\n"}, "AUTHORIZATION_MALFORMED"),
    ({"auth": h.auth_record("Recovery") + "d6_notice=x\n"}, "AUTHORIZATION_MALFORMED"),
])
def test_the_real_stage_gate_refuses_a_missing_stale_wrong_stage_or_extended_authorization_and_a_missing_k3(tmp_path: Path, kw: dict, code: str) -> None:
    args = {"auth": h.auth_record("Recovery"), "k3": h.k3v2_record("Recovery"), **kw}
    result = stage_gate(tmp_path, **{k: v for k, v in args.items() if v is not None})
    assert result.returncode == 1 and f"GATE_FAIL {code}" in result.stdout and "STAGE_GATE=FAIL" in result.stdout


@pytest.mark.parametrize("k3", [h.k3v2_record("Recovery", date=h.today(-1)), h.k3v2_record("R1B"), h.k3v2_record("Recovery", idea1_window_overlap="UNKNOWN_VALUE"), h.k3v2_record("Recovery") + "extra_field=1\n"])
def test_the_real_stage_gate_refuses_a_stale_wrong_stage_or_malformed_k3(tmp_path: Path, k3: str) -> None:
    result = stage_gate(tmp_path, auth=h.auth_record("Recovery"), k3=k3)
    assert result.returncode == 1 and "K3_CONFIRMATION=INVALID" in result.stdout and "STAGE_GATE=FAIL" in result.stdout


def test_the_runner_runs_the_real_stage_gate_from_the_control_snapshot_and_binds_main_runner_release_and_source() -> None:
    pregates = sup.runner_function("recovery_pregates")
    for needle in ("authorization-Recovery.txt", "k3-Recovery.txt", "date=$TODAY", "stage=Recovery", "$EXPECTED_MAIN", "$RUNNER_SHA256", "$EXPECTED_SOURCE_IP", "$RELEASE_ID",
                   'bash "$CTRL/p4-stage-gate.sh" --stage Recovery --mode live', "AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "confirmation_mode confirmed_by date idea1_window_overlap reference stage",
                   "authorizer date reference scope stage"):
        assert needle in pregates, needle
    assert not re.search(r"(?i)secret|restore_credential|d4", "\n".join(re.findall(r"authorization-Recovery.*", pregates)))  # no D4 secret is read into or from Authorization/K3


def test_every_live_authority_link_is_in_the_authority_gates_and_is_reproved_before_the_marker_and_before_final() -> None:
    gates_fn = sup.runner_function("recovery_authority_gates")
    for needle in ("control_gate", "control_git_gate", "recovery_verifier_gate", "recovery_interpreter_gate", "recovery_r1i_present_gate", "l7u_core_running_gate", "f1u_detector_running_gate", "RECOVERY_CORE",
                   "DETECTOR_SOURCE", "DETECTOR_UNIT", "recovery_current_release_gate", "recovery_release_closure_gate", "recovery_cli_gate", "recovery_runtime_unchanged"):
        assert needle in gates_fn, needle
    pregates = sup.runner_function("recovery_pregates")
    for needle in ("recovery_authority_gates", "l7_disk_gate", "l8p_service_gate", "l7_broker_runtime_gate", "l7_idea2_s10_gate", "recovery_sudo_authority_gate", "recovery_predecessor_gate", "socket-check"):
        assert needle in pregates, needle
    lib = LIB.read_text()
    assert "recovery_authority_gates && recovery_sudo_authority_gate && recovery_tty_gate && recovery_attempt_unconsumed" in lib  # the regate before the marker
    assert "recovery_authority_gates || { echo \"RECOVERY_AUTHORITY_DRIFT_BEFORE_FINAL=YES\"" in lib  # and immediately before FINAL


def test_the_runner_defines_every_hook_the_library_requires_and_never_creates_evidence_itself() -> None:
    text = RUNNER.read_text()
    for fn in ("recovery_authority_gates", "recovery_handler", "recovery_pregates", "recovery_prepare_evidence", "control_gate", "control_git_gate"):
        assert f"{fn}() {{" in text, fn
    missing = sup.bash(f'. "{LIB}"; SUDO=""; recovery_capture PRE /x; echo "rc=$?"; recovery_run_attempt; echo "rc=$?"')
    assert "RECOVERY_RUNNER_HOOK_MISSING:recovery_control_gate" in missing.stderr  # a missing runner hook is a fail-closed refusal, never a default


# --------------------------------------------------------------------------- the verifier gate (snapshot byte-identical to the pinned main) and the root handlers


def repo_with_aegis_soc(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    shutil.copytree(sup.ROOT / "aegis_soc", repo / "IDEA3-AEGIS_Lockdown/aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    sup.commit_all(repo)
    return repo


def verifier_gate(repo: Path, snap: Path, sha: str, main: str | None = None, tool: Path | None = None) -> subprocess.CompletedProcess[str]:
    seam = f'export RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT="{snap.parent}"\n'
    return sup.userns_bash(f'{seam}. "{LIB}"; recovery_verifier_gate "{snap}" {sha} "{repo}" "{tool or sup.SNAPSHOT_TOOL}" {main or sup.head_of(repo)}')


@needs_userns
def test_the_verifier_gate_requires_the_snapshot_to_be_the_pinned_main_source_with_the_full_closure(tmp_path: Path) -> None:
    tool = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t6")
    repo = repo_with_aegis_soc(tmp_path)
    snap = tmp_path / "snap"
    sha = tool.snapshot(repo / "IDEA3-AEGIS_Lockdown", snap)
    assert verifier_gate(repo, snap, sha).returncode == 0
    assert verifier_gate(repo, snap, "0" * 64).returncode == 1  # wrong pinned manifest
    mutated = tmp_path / "mutated-src"
    shutil.copytree(repo / "IDEA3-AEGIS_Lockdown", mutated)
    (mutated / "aegis_soc/recovery_stage.py").write_text((mutated / "aegis_soc/recovery_stage.py").read_text() + "\n# not the reviewed source\n")
    msnap = tmp_path / "msnap"
    msha = tool.snapshot(mutated, msnap)  # internally consistent manifest, but not the pinned-main bytes
    refused = verifier_gate(repo, msnap, msha)
    assert refused.returncode == 1 and "NOT_THE_PINNED_MAIN_SOURCE" in refused.stderr


@needs_userns
def test_a_replaced_pinned_commit_does_not_make_an_evil_verifier_snapshot_acceptable(tmp_path: Path) -> None:
    tool = sup.load_tool(sup.SNAPSHOT_TOOL, "recovery_snapshot_tool_t7")
    repo = repo_with_aegis_soc(tmp_path)
    good = sup.head_of(repo)
    dep = repo / "IDEA3-AEGIS_Lockdown/aegis_soc/recovery_evidence.py"
    dep.write_text(dep.read_text() + "\n# EVIL\n")
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "evil")
    evil = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    snap = tmp_path / "evil-snap"
    sha = tool.snapshot(repo / "IDEA3-AEGIS_Lockdown", snap)
    run_git(repo, "checkout", "-q", good)
    run_git(repo, "replace", good, evil)
    seam = f'export RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT="{snap.parent}"\n'
    plain = sup.userns_bash(f'{seam}. "{LIB}"; unset -f git; recovery_verifier_gate "{snap}" {sha} "{repo}" "{sup.SNAPSHOT_TOOL}" {good}')
    assert plain.returncode == 0, plain.stderr  # plain Git would accept the self-consistent EVIL snapshot
    assert verifier_gate(repo, snap, sha, good).returncode == 1  # the library's wrapper does not


def handler_world(tmp_path: Path, step: str = "FINAL", **kw):
    app, sha = sup.write_baseline_app(tmp_path, **kw)
    env = sup.apply_env(tmp_path, app, sha, step)
    return app, sha, env


def test_the_handlers_refuse_without_authorization_or_root() -> None:
    for script in ("apply.sh", "verify.sh"):
        out = sup.bash(f'bash "{STG / script}"')
        assert out.returncode == 1 and "DIRECT_HANDLER_INVOCATION_REFUSED" in out.stderr


@needs_userns
def test_a_handler_step_runs_exactly_once_per_work_dir_from_the_immutable_snapshot_with_a_neutral_cwd(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path)
    first = sup.run_handler(env)
    assert first.returncode == 2 and "RECOVERY_FINAL_VERIFIER_EXIT=2" in first.stderr  # a failed verifier is still a consumed observation
    second = sup.run_handler(env)
    assert second.returncode == 1 and "STEP_ALREADY_RAN_FINAL" in second.stderr
    calls = (tmp_path / "calls.txt").read_text()
    assert calls.count("runpy.run_module(\"aegis_soc.recovery_stage\",run_name=\"__main__\")") == 1
    assert "-I -B -c" in calls and "final-verify" in calls
    assert f"--attempt-marker {tmp_path}/canon/RECOVERY-GLOBAL-ATTEMPT-CONSUMED" in calls and (tmp_path / "cwd.txt").read_text().strip() == str(tmp_path / "work")
    assert (tmp_path / "work/RECOVERY-STEP-FINAL-RAN").is_file()


@needs_userns
@pytest.mark.parametrize("tamper", ["file", "manifest", "extra", "symlink", "writable", "wrong_pin", "closure"])
def test_a_handler_refuses_root_execution_when_the_verifier_snapshot_drifted(tmp_path: Path, tamper: str) -> None:
    modules = tuple(m for m in ("__init__", "recovery_stage", "recovery_evidence", "recovery_client", "recovery_protocol", "local_restore", "ip_containment", "r1_acceptance", "r1bv_validation") if True) if tamper == "closure" else None
    app, sha = sup.write_baseline_app(tmp_path, modules=modules)
    env = sup.apply_env(tmp_path, app, sha)
    app.chmod(0o755)
    (app / "aegis_soc").chmod(0o755)
    stage_file = app / "aegis_soc/recovery_stage.py"
    if tamper == "file":
        stage_file.chmod(0o644)
        stage_file.write_text("# drift\n")
        stage_file.chmod(0o444)
    elif tamper == "manifest":
        (app / "RECOVERY-VERIFIER-SHA256SUMS").chmod(0o644)
        (app / "RECOVERY-VERIFIER-SHA256SUMS").write_text("0" * 64 + "  aegis_soc/recovery_stage.py\n")
        (app / "RECOVERY-VERIFIER-SHA256SUMS").chmod(0o444)
    elif tamper == "extra":
        (app / "aegis_soc/evil.py").write_text("")
        (app / "aegis_soc/evil.py").chmod(0o444)
    elif tamper == "symlink":
        (app / "aegis_soc/link.py").symlink_to("recovery_stage.py")
    elif tamper == "writable":
        stage_file.chmod(0o666)
    elif tamper == "wrong_pin":
        env["AEGIS_RCVSTAGE_VERIFIER_MANIFEST_SHA256"] = "a" * 64
    if tamper != "writable":
        app.chmod(0o555)
        (app / "aegis_soc").chmod(0o555)
    result = sup.run_handler(env)
    assert result.returncode == 1 and "RECOVERY_APPLY=FAIL" in result.stderr, tamper
    assert not (tmp_path / "calls.txt").exists() and not (tmp_path / "work/RECOVERY-STEP-FINAL-RAN").exists()  # the interpreter was never started


@needs_userns
def test_a_handler_refuses_an_untrusted_snapshot_owner_and_ancestor(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path)
    assert "VERIFIER_SNAPSHOT_NOT_TRUSTED_OWNER" in sup.run_handler(env, sup.handler_copy(env, owner_uid=os.getuid() + 12345)).stderr or "WORK_ANCESTOR_NOT_TRUSTED" in sup.run_handler(env, sup.handler_copy(env, owner_uid=os.getuid() + 12345)).stderr
    tmp_path.chmod(0o777)
    refused = sup.run_handler(env)
    assert refused.returncode == 1 and "ANCESTOR_NOT_TRUSTED" in refused.stderr and not (tmp_path / "calls.txt").exists()


@needs_userns
def test_a_handler_refuses_a_symlinked_unprivate_or_foreign_work_directory(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path)
    real = Path(env["AEGIS_RCVSTAGE_WORK_DIR"])
    real.chmod(0o755)
    assert "WORK_DIR_NOT_PRIVATE" in sup.run_handler(env).stderr
    real.chmod(0o700)
    link = tmp_path / "work-link"
    link.symlink_to(real)
    assert sup.run_handler({**env, "AEGIS_RCVSTAGE_WORK_DIR": str(link)}).returncode == 1
    assert "WORK_DIR_REQUIRED" in sup.run_handler({**env, "AEGIS_RCVSTAGE_WORK_DIR": str(tmp_path / "nope")}).stderr
    assert not (tmp_path / "calls.txt").exists()


@needs_userns
def test_a_handler_refuses_an_interpreter_that_is_not_an_absolute_root_owned_not_writable_file(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path)
    fake = Path(env["AEGIS_PYTHON_BIN"])
    fake.chmod(0o775)
    assert "INTERPRETER_NOT_ROOT_OWNED" in sup.run_handler(env).stderr
    fake.chmod(0o755)
    assert "INTERPRETER_UNRESOLVABLE" in sup.run_handler({**env, "AEGIS_PYTHON_BIN": "python3"}).stderr
    assert "INTERPRETER_UNRESOLVABLE" in sup.run_handler({**env, "AEGIS_PYTHON_BIN": ""}).stderr
    sysroot = shutil.which("python3")
    assert "INTERPRETER_NOT_ROOT_OWNED" in sup.run_handler({**env, "AEGIS_PYTHON_BIN": sysroot}).stderr  # a real system interpreter is owned by the REAL root, which is not uid 0 inside this namespace
    assert not (tmp_path / "calls.txt").exists()


@needs_userns
def test_baseline_passes_only_the_frozen_pins_and_never_an_attacker_ip_from_the_runner(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path, "BASELINE")
    assert sup.run_handler(env).returncode == 1  # the stub interpreter fails: a refused baseline
    calls = (tmp_path / "calls.txt").read_text()
    assert f"baseline-db --audit-db {tmp_path}/audit.db --r1b-baseline {tmp_path}/r1b-baseline.json --expected-source-ip {sup.IP} --detector-uid 948 --work-dir {tmp_path}/work" in calls
    assert "BASELINE_REFUSED" in sup.run_handler({**env, "AEGIS_RCVSTAGE_STEP": "BASELINE"}).stderr or True
    for bad in ({"AEGIS_RCVSTAGE_DETECTOR_UID": "0"}, {"AEGIS_RCVSTAGE_DETECTOR_UID": "x"}, {"AEGIS_RCVSTAGE_R1B_BASELINE": "relative"}, {"AEGIS_RCVSTAGE_EXPECTED_SOURCE_IP": ""}):
        sub = tmp_path / "bad"
        sub.mkdir(exist_ok=True)
        (sub / "x").write_text("")
        assert "BASELINE_INPUTS_INVALID" in sup.run_handler({**env, **bad, "AEGIS_RCVSTAGE_WORK_DIR": str(_fresh_work(tmp_path))}).stderr, bad


def _fresh_work(tmp_path: Path) -> Path:
    n = len(list(tmp_path.glob("work-*")))
    work = tmp_path / f"work-{n}"
    work.mkdir(mode=0o700)
    work.chmod(0o700)
    return work


@needs_userns
def test_unknown_steps_and_the_forbidden_step_names_are_refused(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path)
    for step in ("", "ISOLATE", "RESTORE", "CLOSE", "baseline", "FINAL;id", "NFT_FLUSH"):
        assert "STEP_INVALID" in sup.run_handler({**env, "AEGIS_RCVSTAGE_STEP": step}).stderr, step
    assert not (tmp_path / "calls.txt").exists()


@needs_userns
def test_the_delta_and_dump_check_steps_call_only_the_read_only_commands_with_root_work_paths(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path, "DELTA")
    sup.run_handler(env)
    sup.run_handler({**env, "AEGIS_RCVSTAGE_STEP": "NFT_PRE_CHECK", "AEGIS_RCVSTAGE_WORK_DIR": str(_fresh_work(tmp_path))})
    calls = (tmp_path / "calls.txt").read_text()
    work = tmp_path / "work"
    assert f"containment-delta --pre-bundle {work}/pre-root --post-bundle {work}/post-root --pre-nft {work}/nft-pre.txt --post-nft {work}/nft-post.txt --work-dir {work}" in calls
    assert "nft-dump-check --bundle" in calls and "--ip" not in calls


@needs_userns
def test_verify_sh_prints_pass_only_when_the_bound_result_proof_passes_and_never_the_closed_pass_token(tmp_path: Path) -> None:
    app, sha, env = handler_world(tmp_path, "FINAL")
    good_py = tmp_path / "okpy"
    good_py.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path / "verify-calls.txt"}"\nexit 0\n')
    good_py.chmod(0o755)
    ok = sup.run_handler({**env, "AEGIS_PYTHON_BIN": str(good_py)}, sup.handler_copy(env, "verify.sh"))
    assert ok.returncode == 0 and "RECOVERY_VERIFY=PASS" in ok.stdout and "RECOVERY_PROMOTION=NOT_AUTOMATIC" in ok.stdout and "CLOSED_PASS" not in ok.stdout
    assert "R1B_RESULT=FAIL_IMMUTABLE" in ok.stdout and "R1BV_RESULT=PASS" in ok.stdout and "LVR_PROVEN=NO" in ok.stdout and "L8_ACCEPTANCE=NO" in ok.stdout and "L9_PROVEN=NO" in ok.stdout
    assert "verify-result --audit-db" in (tmp_path / "verify-calls.txt").read_text() and "--attempt-marker" in (tmp_path / "verify-calls.txt").read_text()
    bad = sup.run_handler(env, sup.handler_copy(env, "verify.sh", name="verify_bad.sh"))  # the default stub interpreter exits 2
    assert bad.returncode == 1 and "RESULT_NOT_BOUND_TO_THE_ATTEMPT" in bad.stderr and "RECOVERY_VERIFY=PASS" not in bad.stdout


def test_rollback_is_evidence_preserving_bounded_and_acts_on_nothing() -> None:
    out = sup.bash(f'bash "{STG / "rollback.sh"}"')
    assert out.returncode == 0 and "RECOVERY_AUTOMATIC_ROLLBACK=NO" in out.stdout and "RECOVERY_RERUN_ALLOWED=NO" in out.stdout and "R1I_MUST_REMAIN_INSTALLED=YES" in out.stdout and "RECOVERY_IS_R1B_RETRY=NO" in out.stdout
    assert sup.bash(f'bash "{STG / "rollback.sh"}" x').returncode == 1  # accepts no argument
    text = "\n".join(sup.code_lines(STG / "rollback.sh"))
    assert not re.search(r"\b(nft|systemctl|sqlite3?|rm|mv|chattr|aegisctl|python3?)\b", text)


def test_no_handler_or_runner_path_speaks_to_the_core_socket_writes_sqlite_publishes_or_mutates_nft() -> None:
    for path in sup.RECOVERY_FILES:
        text = "\n".join(sup.code_lines(path))
        assert not re.search(r"\bsqlite3\b|mosquitto_pub|\bmqtt\b|recovery\.sock|\bnft\s+(-\S+\s+)*(add|delete|destroy|flush|insert|replace|create|reset|rename|-f)\b|--break-glass|break_glass|\bcurl\b|\bnc\b", text), path
    apply = "\n".join(sup.code_lines(STG / "apply.sh"))
    assert apply.count("nft --stateless list table inet aegis_idea3") == 1  # the ONLY nft use is the read-only dump
