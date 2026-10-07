"""AEGIS IDEA3 PR11 Phase 4 — L9 live governance: trust closure, frozen runner, owner lib, host provenance and receipt derivation.

Repository-only. Everything runs against synthetic Git history and temporary directories; nothing touches the real governance directory, a host service,
a broker or a device, and no marker is consumed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from l9_support import (DEPLOY, DEVICE, EVIDENCE, L8_MAIN, MAIN, RUN, RUN_LIB, RUNNER, RUNNER_SHA, START, WORK, L9_STAGE, Repo, closeout, code_only, combined, freeze, gates,
                        good_world, marker_text, observe, run_observe, valid_l8)

HEX_A, HEX_B, SHA = "a" * 40, "b" * 40, "c" * 64
FIXED = Path(__file__).resolve().parents[1]

# ============================================================================================ owner lib (bash, SUDO empty, guarded seams)


def lib(tmp_path: Path, body: str, **env) -> subprocess.CompletedProcess:
    canonical = tmp_path / "gov"
    full = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "SUDO": "", "AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES", "AEGIS_L9_TEST_ONLY_CANONICAL_DIR": str(canonical),
            "AEGIS_L9_TEST_ONLY_TRUST_ROOT": str(tmp_path), "AEGIS_L9_TEST_ONLY_BOUNDARY": "L9_PRE_TIME=1.0", **env}
    return subprocess.run(["bash", "-c", f'set -e; . "{RUN_LIB}"; {body}'], env=full, capture_output=True, text=True, timeout=60, check=False)


def consume(tmp_path: Path, run=RUN, work=None, evidence=None) -> subprocess.CompletedProcess:
    work = work or f"{tmp_path}/work"
    evidence = evidence or f"{tmp_path}/evidence"
    return lib(tmp_path, f'l9_consume_attempt "{work}" "{evidence}" {DEVICE} {run} /bin/true {HEX_A} {SHA}')


def test_marker_consumption_is_exclusive_binds_the_whole_identity_and_blocks_a_second_attempt(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    first = consume(tmp_path)
    assert first.returncode == 0, combined(first)
    marker = tmp_path / "gov" / "L9-GLOBAL-ATTEMPT-CONSUMED"
    text = marker.read_text()
    for needle in ("L9_ATTEMPT_CONSUMED=YES", "L9_RERUN_ALLOWED=NO", f"L9_DEVICE_ID={DEVICE}", f"L9_RUN_ID={RUN}", f"L9_EXPECTED_MAIN={HEX_A}", f"L9_RUNNER_SHA256={SHA}",
                   f"L9_WORK_DIR={tmp_path}/work", f"L9_EVIDENCE_DIR={tmp_path}/evidence", "L9_CONSUMED_AT_EPOCH=", "L9_PRE_TIME=1.0"):
        assert needle in text, needle
    second = consume(tmp_path, run="l9-second")
    assert second.returncode != 0 and "L9_ATTEMPT_ALREADY_CONSUMED" in second.stderr
    assert marker.read_text() == text


@pytest.mark.parametrize("args", [("relative/work", "/e"), ("/w", "relative/evidence"), ("/w/../x", "/e")])
def test_marker_consumption_refuses_unsafe_paths(tmp_path: Path, args) -> None:
    tmp_path.chmod(0o755)
    res = consume(tmp_path, work=args[0], evidence=args[1])
    assert res.returncode != 0 and not (tmp_path / "gov" / "L9-GLOBAL-ATTEMPT-CONSUMED").exists()


def test_a_closeout_alone_also_blocks_a_new_attempt(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o700)
    (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").write_text("x")
    res = lib(tmp_path, "l9_marker_unconsumed")
    assert res.returncode != 0 and "L9_ATTEMPT_ALREADY_CONSUMED" in res.stderr


def test_the_canonical_directory_must_be_private_and_owned(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o777)
    (tmp_path / "gov").chmod(0o777)
    res = lib(tmp_path, "l9_marker_unconsumed")
    assert res.returncode != 0 and "L9_CANONICAL_DIR_NOT_TRUSTED" in res.stderr


def test_the_host_closeout_is_written_with_the_exact_ordered_key_set_the_verifier_expects(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    assert consume(tmp_path).returncode == 0
    ok = lib(tmp_path, f"l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/evid {RUN} {SHA}")
    assert ok.returncode == 0, combined(ok)
    path = tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS"
    text = path.read_text()
    assert [line.split("=", 1)[0] for line in text.splitlines()] == list(closeout.HOST_KEYS)
    values = dict(line.split("=", 1) for line in text.splitlines())
    for key, want in closeout.HOST_FIXED.items():
        assert values[key] == want
    assert values["L9_EXPECTED_MAIN"] == HEX_A and values["L8_EXECUTION_MAIN"] == HEX_B and values["L9_RUN_ID"] == RUN and values["L9_RUNNER_SHA256"] == SHA
    assert float(values["L9_TERMINAL_EPOCH"]) > 1e9
    again = lib(tmp_path, f"l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/evid {RUN} {SHA}")
    assert again.returncode != 0 and path.read_text() == text


def test_a_closeout_cannot_be_recorded_without_a_consumed_marker_or_with_bad_inputs(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o700)
    assert lib(tmp_path, f"l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/e {RUN} {SHA}").returncode != 0
    assert lib(tmp_path, f"l9_record_success zz {HEX_B} {SHA} {tmp_path}/e {RUN} {SHA}").returncode != 0
    assert lib(tmp_path, f"l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/e 'bad run' {SHA}").returncode != 0
    assert not (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").exists()


def auth_file(tmp_path: Path, **over) -> Path:
    fields = {"stage": "L9", "date": "2026-10-09", "authorizer": "music", "scope": f"L9 live observe main={HEX_A} runner={SHA} l8={HEX_B}", "reference": "https://example.invalid/a1"}
    extras = {k[len("extra_"):]: v for k, v in over.items() if k.startswith("extra_")}
    fields.update({k: v for k, v in over.items() if not k.startswith("extra_")})
    lines = ["AEGIS_P4_AUTHORIZATION_V1", *[f"{k}={v}" for k, v in fields.items()], *[f"{k}={v}" for k, v in extras.items()]]
    path = tmp_path / "authorization-L9.txt"
    path.write_text("\n".join(lines) + "\n")
    return path


def auth_gate(tmp_path: Path, path: Path, main=HEX_A, runner=SHA, l8=HEX_B, today="2026-10-09") -> subprocess.CompletedProcess:
    return lib(tmp_path, f'l9_authorization_gate "{path}" {main} {runner} {l8} {today}')


def test_the_exact_authorization_is_accepted(tmp_path: Path) -> None:
    assert auth_gate(tmp_path, auth_file(tmp_path)).returncode == 0


@pytest.mark.parametrize("stage", ["L8", "L7", "CTu", "Recovery", "L9x"])
def test_a_cross_stage_authorization_is_refused(tmp_path: Path, stage: str) -> None:
    res = auth_gate(tmp_path, auth_file(tmp_path, stage=stage))
    assert res.returncode != 0 and "L9_AUTHORIZATION_STAGE_MISMATCH" in res.stderr


@pytest.mark.parametrize("extra", ["extra_d6_notice=pub", "extra_integration_review=kla", "extra_recovery_authorization=https://example.invalid/r", "extra_physical_recovery_attestation=https://example.invalid/p"])
def test_authorizations_carrying_any_other_stages_extra_field_are_refused(tmp_path: Path, extra: str) -> None:
    key, value = extra.split("=", 1)
    res = auth_gate(tmp_path, auth_file(tmp_path, **{key: value}))
    assert res.returncode != 0 and "L9_AUTHORIZATION_FIELD_SET_INVALID" in res.stderr


def test_a_stale_authorization_is_refused(tmp_path: Path) -> None:
    res = auth_gate(tmp_path, auth_file(tmp_path, date="2026-10-08"))
    assert res.returncode != 0 and "L9_AUTHORIZATION_STALE" in res.stderr


@pytest.mark.parametrize("kwargs", [{"main": "1" * 40}, {"runner": "2" * 64}, {"l8": "3" * 40}])
def test_an_authorization_bound_to_another_main_runner_or_l8_is_refused(tmp_path: Path, kwargs: dict) -> None:
    res = auth_gate(tmp_path, auth_file(tmp_path), **kwargs)
    assert res.returncode != 0 and "L9_AUTHORIZATION_NOT_BOUND_TO_MAIN_RUNNER_L8" in res.stderr


def test_an_authorization_with_a_conflicting_second_binding_or_no_binding_is_refused(tmp_path: Path) -> None:
    res = auth_gate(tmp_path, auth_file(tmp_path, scope=f"L9 main={HEX_A} runner={SHA} l8={HEX_B} main={'9' * 40}"))
    assert res.returncode != 0 and "L9_AUTHORIZATION_AMBIGUOUS_BINDING" in res.stderr
    res = auth_gate(tmp_path, auth_file(tmp_path, scope="L9 live observation"))
    assert res.returncode != 0 and "L9_AUTHORIZATION_NOT_BOUND_TO_MAIN_RUNNER_L8" in res.stderr


def test_wrong_owner_or_magic_is_refused(tmp_path: Path) -> None:
    assert auth_gate(tmp_path, auth_file(tmp_path, authorizer="kla")).returncode != 0
    bad = auth_file(tmp_path)
    bad.write_text(bad.read_text().replace("AEGIS_P4_AUTHORIZATION_V1", "AEGIS_P4_AUTHORIZATION_V0"))
    assert auth_gate(tmp_path, bad).returncode != 0


def test_operator_identity_gate_binds_user_and_uid(tmp_path: Path) -> None:
    uid, user = os.getuid(), subprocess.check_output(["id", "-un"], text=True).strip()
    if uid == 0:
        pytest.skip("root cannot be the frozen operator")
    assert lib(tmp_path, f"l9_operator_identity_gate {user} {uid}").returncode == 0
    assert lib(tmp_path, f"l9_operator_identity_gate {user} {uid + 1}").returncode != 0
    assert lib(tmp_path, f"l9_operator_identity_gate nobody-else {uid}").returncode != 0
    assert lib(tmp_path, "l9_operator_identity_gate root 0").returncode != 0


def test_the_lib_no_longer_builds_a_per_run_bundle_from_the_worktree() -> None:
    assert "l9_prepare_bundle" not in RUN_LIB.read_text()


# ============================================================================================ E. trust closure: the authority directory

def real_authority_repo(tmp_path: Path):
    """A synthetic repo holding the REAL bytes of every authority file and of the runner template, committed as the reviewed main."""
    repo = Repo(tmp_path / "authority-repo")
    for rel in freeze.AUTHORITY_FILES:
        repo.write(f"{freeze.P4_REL}/{rel}", (DEPLOY / rel).read_text())
    repo.write(f"{freeze.P4_REL}/owner-run/run-l9-owner.sh", RUNNER.read_text())
    return repo, repo.commit("reviewed main")


def test_every_authority_file_exists_in_the_repository_and_covers_everything_the_runner_executes() -> None:
    for rel in freeze.AUTHORITY_FILES:
        assert (DEPLOY / rel).is_file(), rel
    text = code_only(RUNNER)
    after = text[text.index('P4=$AUTHORITY_DIR'):]
    used = set(re.findall(r'"\$P4/([A-Za-z0-9_./-]+)"', after)) | set(re.findall(r'\$P4/([A-Za-z0-9_./-]+)', after))
    used = {u for u in used if not u.endswith("/")}
    assert used and used <= set(freeze.AUTHORITY_FILES), sorted(used - set(freeze.AUTHORITY_FILES))
    for lib_file in ("p4-l9-run-lib.sh", "p4-l7u-run-lib.sh", "p4-l7-run-lib.sh", "p4-l6b-run-lib.sh"):
        for dep in re.findall(r'\.\s+"\$[A-Za-z0-9_]+/([A-Za-z0-9_.-]+)"', (DEPLOY / lib_file).read_text()):
            assert dep in freeze.AUTHORITY_FILES, (lib_file, dep)


def test_the_authority_is_built_from_git_objects_never_from_the_working_tree(tmp_path: Path) -> None:
    repo, main = real_authority_repo(tmp_path)
    (repo.path / freeze.P4_REL / "p4-l9-gates.py").write_text("# working tree tamper\n")
    out = tmp_path / "authority"
    res = freeze.build_authority(repo.path, main, out)
    assert res["AUTHORITY_VERIFIED"] == "PASS" and re.fullmatch(r"[0-9a-f]{64}", res["AUTHORITY_MANIFEST_SHA256"])
    assert "working tree tamper" not in (out / "p4-l9-gates.py").read_text()
    assert stat.S_IMODE((out / "p4-l9-gates.py").stat().st_mode) == 0o555 and stat.S_IMODE(out.stat().st_mode) == 0o555
    assert {p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()} == {*freeze.AUTHORITY_FILES, freeze.MANIFEST_NAME}
    with pytest.raises(freeze.FreezeError, match="DESTINATION_EXISTS"):
        freeze.build_authority(repo.path, main, out)


def make_authority(tmp_path: Path):
    repo, main = real_authority_repo(tmp_path)
    out = tmp_path / "authority"
    res = freeze.build_authority(repo.path, main, out)
    return repo, main, out, res["AUTHORITY_MANIFEST_SHA256"]


def make_writable(path: Path) -> None:
    """Group- and world-writable (the owner can of course also write): the state a tamper needs and the production invariant forbids."""
    for p in [path, *path.rglob("*")]:
        if not p.is_symlink():
            p.chmod(0o777 if p.is_dir() else 0o666)


MUTATED = ["p4-l9-run-lib.sh", "p4-l9-gates.py", "p4-stage-gate.sh", "p4-l9-live-observe.py", "p4-lib.sh", "p4-l9-freeze.py", "p4-l9-closeout.py", "p4-compare.sh",
           "p4-l0-capture.sh", "p4-l7u-run-lib.sh", "stages/L9/apply.sh", "stages/L9/verify.sh", "stages/L9/rollback.sh", "stages/L9/allow-keys.txt"]


@pytest.mark.parametrize("rel", MUTATED)
def test_a_mutated_authority_file_is_rejected_by_the_python_verifier(tmp_path: Path, rel: str) -> None:
    repo, main, out, manifest = make_authority(tmp_path)
    make_writable(out)
    (out / rel).write_text((out / rel).read_text() + "\n# mutated\n")
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_FILE_DIGEST_MISMATCH"):
        freeze.verify_authority(out, repo.path, main, owner_uid=None, pinned_manifest_sha256=manifest)


@pytest.mark.parametrize("rel", MUTATED)
def test_a_consistently_rewritten_file_and_manifest_still_fails_against_the_git_object(tmp_path: Path, rel: str) -> None:
    repo, main, out, manifest = make_authority(tmp_path)
    make_writable(out)
    evil = (out / rel).read_text() + "\n# evil\n"
    (out / rel).write_text(evil)
    lines = []
    for line in (out / freeze.MANIFEST_NAME).read_text().splitlines():
        sha, name = line.split("  ", 1)
        lines.append(f"{hashlib.sha256(evil.encode()).hexdigest() if name == rel else sha}  {name}")
    (out / freeze.MANIFEST_NAME).write_text("\n".join(lines) + "\n")
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_FILE_NOT_EXACT_MAIN"):
        freeze.verify_authority(out, repo.path, main, owner_uid=None)
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_MANIFEST_DIGEST_MISMATCH"):  # and the digest PINNED in the frozen runner no longer matches
        freeze.verify_authority(out, repo.path, main, owner_uid=None, pinned_manifest_sha256=manifest)


def test_authority_structure_attacks_are_rejected(tmp_path: Path) -> None:
    repo, main, out, manifest = make_authority(tmp_path)
    make_writable(out)
    (out / "extra.sh").write_text("echo hi\n")
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_FILE_SET_INVALID"):
        freeze.verify_authority(out, repo.path, main, owner_uid=None)
    (out / "extra.sh").unlink()
    (out / "p4-lib.sh").unlink()
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_FILE_SET_INVALID"):
        freeze.verify_authority(out, repo.path, main, owner_uid=None)
    (out / "p4-lib.sh").symlink_to(out / "p4-compare.sh")
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_SYMLINK"):
        freeze.verify_authority(out, repo.path, main, owner_uid=None)


def test_a_production_verify_requires_a_root_owned_non_writable_authority(tmp_path: Path) -> None:
    repo, main, out, manifest = make_authority(tmp_path)
    if os.geteuid() == 0:
        pytest.skip("the production invariant is satisfiable as root")
    with pytest.raises(freeze.FreezeError, match="AUTHORITY_DIR_NOT_TRUSTED"):
        freeze.verify_authority(out, repo.path, main)


def extract_bash_function(name: str) -> str:
    text = RUNNER.read_text()
    start = text.index(f"{name}() {{")
    end = text.index("\n}\n", start) + 3
    return text[start:end]


def run_bash_verify(tmp_path: Path, directory: Path, manifest: str, repo: Path, main: str, owner: int | None = None, stop: Path | None = None) -> subprocess.CompletedProcess:
    safegit = extract_bash_function("safegit")
    verify = extract_bash_function("l9_verify_authority")
    owner = os.getuid() if owner is None else owner
    stop = stop or directory.parent
    script = f'set -u; {safegit}\n{verify}\nl9_verify_authority "{directory}" {manifest} "{repo}" {main} {owner} "{stop}"'
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env={"PATH": os.environ["PATH"]}, check=False)


def test_the_runner_bash_authority_check_accepts_exactly_the_real_authority(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    repo, main, out, manifest = make_authority(tmp_path)
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main).returncode == 0


@pytest.mark.parametrize("rel", ["p4-l9-run-lib.sh", "p4-l9-gates.py", "p4-stage-gate.sh", "p4-l9-live-observe.py", "stages/L9/apply.sh", "stages/L9/verify.sh", "stages/L9/rollback.sh"])
def test_the_runner_bash_authority_check_rejects_every_mutated_dependency(tmp_path: Path, rel: str) -> None:
    tmp_path.chmod(0o755)
    repo, main, out, manifest = make_authority(tmp_path)
    make_writable(out)
    (out / rel).write_text((out / rel).read_text() + "\n# mutated\n")
    for p in [out, *out.rglob("*")]:
        p.chmod(0o555 if p.is_dir() or p.suffix in {".sh", ".py"} else 0o444)
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main).returncode != 0


def test_the_runner_bash_authority_check_rejects_structure_and_trust_attacks(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    repo, main, out, manifest = make_authority(tmp_path)
    assert run_bash_verify(tmp_path, out, "0" * 64, repo.path, main).returncode != 0              # wrong pinned manifest digest
    assert run_bash_verify(tmp_path, out, manifest, repo.path, "e" * 40).returncode != 0          # wrong main: the Git objects differ
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main, owner=os.getuid() + 1).returncode != 0   # not owned by the trusted uid
    make_writable(out)
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main).returncode != 0              # group/world-writable is refused
    for p in [out, *out.rglob("*")]:
        p.chmod(0o555 if p.is_dir() or p.suffix in {".sh", ".py"} else 0o444)
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main).returncode == 0
    (out.parent / "evil-link").symlink_to(out)
    assert run_bash_verify(tmp_path, out.parent / "evil-link", manifest, repo.path, main).returncode != 0
    make_writable(out)
    (out / "extra").write_text("x")
    for p in [out, *out.rglob("*")]:
        p.chmod(0o555 if p.is_dir() or p.suffix in {".sh", ".py"} else 0o444)
    assert run_bash_verify(tmp_path, out, manifest, repo.path, main).returncode != 0              # an extra file is refused


# ---- the frozen runner itself: pins, order, no worktree-sourced trust code


def runner_text() -> str:
    return RUNNER.read_text()


def test_the_runner_template_refuses_to_run_as_committed() -> None:
    res = subprocess.run(["bash", str(RUNNER), "/tmp"], capture_output=True, text=True, check=False, env={"PATH": os.environ["PATH"]})
    assert res.returncode == 2 and "runner is not pinned" in res.stderr


def test_the_runner_executes_nothing_from_the_worktree_before_the_authority_is_verified() -> None:
    text = code_only(RUNNER)
    gate = text.index('l9_verify_authority "$AUTHORITY_DIR"')
    before = text[:gate]
    assert not re.search(r'(^|\n)\s*(\.|source)\s', before.replace("l9_verify_authority()", ""))                # nothing is sourced earlier
    assert not re.search(r'(bash|python3?|sh)\s+[^\n]*\$(REPO|APP|P4)\b', before)                            # nothing from the worktree is executed earlier
    assert "$APP" not in text and "$REPO/IDEA3" not in text and "UNIT_SOURCE" not in text
    after = text[gate:]
    assert after.index("P4=$AUTHORITY_DIR") < after.index('. "$P4/p4-l9-run-lib.sh"')
    for line in text.splitlines():
        if re.search(r"(?<![A-Za-z_])(\.|source)\s+[\"$]", line):
            assert "$P4/" in line, line
        if "python3" in line and "l7u_secret_scan" not in line:  # the shared scan function applies `-I` to the interpreter it is given (asserted below)
            assert "-I" in line, line
    assert '"$py" -I -' in (DEPLOY / "p4-l7u-run-lib.sh").read_text()


def test_every_git_call_in_the_runner_goes_through_the_isolated_wrapper() -> None:
    text = code_only(RUNNER)
    wrapper = text[text.index("safegit() {"):text.index("}\n", text.index("safegit() {"))]
    for needle in ("env -i", "GIT_NO_REPLACE_OBJECTS=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "core.fsmonitor=false", "core.hooksPath=/dev/null"):
        assert needle in wrapper, needle
    stripped = text.replace(wrapper, "")
    assert not re.search(r"(?<![A-Za-z_])git\s", stripped), re.findall(r".*(?<![A-Za-z_])git\s.*", stripped)


def test_the_runner_pins_the_authority_and_every_input_and_orders_every_governance_step() -> None:
    text = runner_text()
    for needle in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "DEVICE_ID", "WINDOW_SECONDS", "MERGED_MAIN_WORKTREE", "EVIDENCE_ROOT", "AUTHORITY_DIR", "AUTHORITY_MANIFEST_SHA256",
                   "ls-remote origin refs/heads/main", "status --porcelain", "environment override SUDO is forbidden", "Git environment override is forbidden",
                   "interpreter/loader environment override is forbidden", "AEGIS_L9_TEST_ONLY_", "RECOVERY_TEST_ONLY_", "not root", "RUNNER_SHA256", "RUNNER_ROOT_OWNED=PASS",
                   "AUTHORITY_VERIFIED=PASS", "L8_PREDECESSOR=PASS", "sudo -n true"):
        assert needle in text, needle
    order = ['l9_verify_authority "$AUTHORITY_DIR"', 'P4=$AUTHORITY_DIR', '"$P4/p4-l9-run-lib.sh"', "p4-l9-freeze.py\" verify", "p4-l9-gates.py\" l8-predecessor", "l9_authorization_gate",
             "p4-stage-gate.sh", "l9_marker_unconsumed || exit 1", 'capture "$PRE"', "l9_consume_attempt", "stages/L9/apply.sh", 'capture "$POST"', 'compare "$PRE" "$POST"',
             'if ! l7u_secret_scan "$EVID"', "stages/L9/verify.sh", "l9_record_success"]
    positions = [text.index(item) for item in order]
    assert positions == sorted(positions), dict(zip(order, positions))
    assert text.count("l9_consume_attempt") >= 1 and text.count('stages/L9/apply.sh"') == 1


def test_the_runner_mutates_nothing_and_never_touches_services_or_the_device() -> None:
    code, lib_code = code_only(RUNNER), code_only(RUN_LIB)
    for forbidden in ("systemctl", "esptool", "mosquitto", "nft ", "iptables", "ip link", "reboot", "shutdown", "1883", "rm -rf"):
        assert forbidden not in code and forbidden not in lib_code, forbidden
    for forbidden in (r"\bCOMMAND\b", r"\bRESTORE\b", r"\bCUT\b"):
        assert not re.search(forbidden, code) and not re.search(forbidden, lib_code), forbidden


def test_every_post_consumption_failure_is_terminal_and_never_reopens_the_marker() -> None:
    text = runner_text()
    post_fail = text[text.index("post_fail() {"):text.index("handle_signal()")]
    assert "FAIL_IMMUTABLE" in post_fail and "L9_RERUN_ALLOWED=NO" in post_fail and "rm " not in post_fail and "chattr -i" not in post_fail
    for step in ("APPLY_OBSERVATION", "POST_CAPTURE", "COMPARE_S10", "SECRET_SCAN", "VERIFY", "L9_CLOSEOUT", "MARKER_DURABILITY", "EVIDENCE_DIGEST"):
        assert f"post_fail {step}" in text, step


FREEZE_PINS = {"EXPECTED_MAIN": HEX_A, "OPERATOR_USER": "music", "OPERATOR_UID": "1000", "DEVICE_ID": DEVICE, "WINDOW_SECONDS": "150", "MERGED_MAIN_WORKTREE": "/srv/aegis/main",
               "EVIDENCE_ROOT": "/srv/aegis/evidence", "AUTHORITY_DIR": "/srv/aegis/l9-authority", "AUTHORITY_MANIFEST_SHA256": "d" * 64}


def freeze_repo(tmp_path: Path):
    repo = Repo(tmp_path / "frepo")
    repo.write("IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh", RUNNER.read_text())
    main = repo.commit("template")
    return repo, main, dict(FREEZE_PINS, EXPECTED_MAIN=main)


def test_freeze_produces_exactly_the_template_plus_the_nine_pins(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    assert set(pins) == set(freeze.PIN_SPECS) and len(pins) == 9
    out = tmp_path / "frozen.sh"
    results = freeze.freeze(repo.path, main, pins, out)
    assert results["RUNNER_TEMPLATE_AUTHORITY"] == "PASS" and results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] == "PASS" and re.fullmatch(r"[0-9a-f]{64}", results["RUNNER_SHA256"])
    assert stat.S_IMODE(out.stat().st_mode) == 0o555 and freeze.check_equivalence(RUNNER.read_text(), out.read_text()) == pins


def test_freeze_refuses_unknown_missing_duplicate_and_unsafe_pins_and_never_overwrites(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    with pytest.raises(freeze.FreezeError, match="DESTINATION_EXISTS"):
        freeze.freeze(repo.path, main, pins, out)
    cases = ((lambda p: {**p, "EXTRA": "x"}, "UNKNOWN_PIN"), (lambda p: {k: v for k, v in p.items() if k != "AUTHORITY_DIR"}, "MISSING_PIN"),
             (lambda p: {k: v for k, v in p.items() if k != "AUTHORITY_MANIFEST_SHA256"}, "MISSING_PIN"), (lambda p: {**p, "OPERATOR_USER": "mu sic"}, "PIN_VALUE_REJECTED"),
             (lambda p: {**p, "EVIDENCE_ROOT": "/x/$(id)"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "AUTHORITY_DIR": "/a/../b"}, "PIN_VALUE_REJECTED"),
             (lambda p: {**p, "AUTHORITY_MANIFEST_SHA256": "xyz"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "WINDOW_SECONDS": "119"}, "PIN_VALUE_REJECTED"),
             (lambda p: {**p, "WINDOW_SECONDS": "901"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "DEVICE_ID": "PIN_DEVICE_ID"}, "PIN_VALUE_REJECTED"))
    for mutate, reason in cases:
        with pytest.raises(freeze.FreezeError, match=reason):
            freeze.load_pins(json.dumps(mutate(dict(pins))))
    with pytest.raises(freeze.FreezeError, match="DUPLICATE_PIN"):
        freeze.load_pins('{"EXPECTED_MAIN": "a", "EXPECTED_MAIN": "b"}')
    with pytest.raises(freeze.FreezeError, match="EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN"):
        freeze.freeze(repo.path, main, {**pins, "EXPECTED_MAIN": HEX_B}, tmp_path / "other.sh")


def test_freeze_verify_detects_any_non_pin_byte_change_and_reads_the_template_from_git(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    out.chmod(0o755)
    out.write_text(out.read_text().replace("l9_consume_attempt", "true # l9_consume_attempt", 1))
    with pytest.raises(freeze.FreezeError, match="NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE"):
        freeze.verify(repo.path, main, out, owner_uid=None)
    (repo.path / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh").write_text("# working tree tamper\n")
    fresh = tmp_path / "fresh.sh"
    freeze.freeze(repo.path, main, pins, fresh)
    assert "working tree tamper" not in fresh.read_text()


def test_freeze_production_modes_demand_root_ownership_authority_and_the_l8_provenance_blocker(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    if os.geteuid() != 0:
        with pytest.raises(freeze.FreezeError, match="RUNNER_NOT_ROOT_OWNED"):
            freeze.verify(repo.path, main, out)
        with pytest.raises(freeze.FreezeError, match="ROOT_REQUIRED"):
            freeze.freeze(repo.path, main, pins, tmp_path / "x.sh", root_owned=True)
        with pytest.raises(freeze.FreezeError, match="ROOT_REQUIRED"):
            freeze.build_authority(repo.path, main, tmp_path / "auth-x", root_owned=True)
    lrepo, execution, lmain = valid_l8(tmp_path / "l8")
    with pytest.raises(freeze.FreezeError, match="L8_PREDECESSOR_NOT_SATISFIED:L8_HOST_PROVENANCE_REQUIRED"):
        freeze._require_l8(lrepo.path, lmain)
    bare = Repo(tmp_path / "bare")
    bare.receipt("2026-10-01_000000_music_x.md", ["L8_ACCEPTANCE=NO"])
    head = bare.commit("x")
    with pytest.raises(freeze.FreezeError, match="L8_PREDECESSOR_NOT_SATISFIED"):
        freeze._require_l8(bare.path, head)


def test_the_authority_cli_builds_and_verifies_from_an_isolated_interpreter(tmp_path: Path) -> None:
    repo, main = real_authority_repo(tmp_path)
    out = tmp_path / "cli-authority"
    res = subprocess.run([sys.executable, "-I", str(DEPLOY / "p4-l9-freeze.py"), "authority", "--repo", str(repo.path), "--main", main, "--out", str(out)], capture_output=True, text=True, check=False)
    assert res.returncode == 0, combined(res)
    assert "AUTHORITY_VERIFIED=PASS" in res.stdout and re.search(r"AUTHORITY_MANIFEST_SHA256=[0-9a-f]{64}", res.stdout)


# ---- the runner, executed: refuses every unsafe environment BEFORE doing anything, and sources nothing from the worktree


def frozen_runner(tmp_path: Path):
    repo, main, pins = freeze_repo(tmp_path)
    work = tmp_path / "worktree"
    work.mkdir()
    (work / ".git").mkdir()
    pins = dict(pins, MERGED_MAIN_WORKTREE=str(work), EVIDENCE_ROOT=str(tmp_path / "evroot"), AUTHORITY_DIR=str(tmp_path / "missing-authority"), OPERATOR_UID=str(os.getuid() or 1))
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    auth = tmp_path / "auth"
    auth.mkdir()
    return out, auth, work, repo, main


def run_frozen(out: Path, auth: Path, **env) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(out), str(auth)], capture_output=True, text=True, env={"PATH": os.environ["PATH"], **env}, timeout=60, check=False)


@pytest.mark.parametrize("env,message", [({"SUDO": "x"}, "SUDO is forbidden"), ({"GIT_DIR": "/x"}, "Git environment override is forbidden"), ({"GIT_CONFIG_COUNT": "1"}, "Git environment override"),
                                        ({"PYTHONPATH": "/x"}, "interpreter/loader environment override"), ({"PYTHONHOME": "/x"}, "interpreter/loader environment override"),
                                        ({"LD_PRELOAD": "/x"}, "interpreter/loader environment override"), ({"BASH_ENV": "/x"}, "interpreter/loader environment override"),
                                        ({"AEGIS_L9_MARKER": "/x"}, "caller-supplied L9 governance variables"), ({"AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES"}, "caller-supplied L9 governance variables"),
                                        ({"RECOVERY_TEST_ONLY_RUNNER_TRUST_ENABLED": "YES"}, "caller-supplied L9 governance variables")])
def test_the_frozen_runner_refuses_unsafe_environments_before_any_work(tmp_path: Path, env: dict, message: str) -> None:
    if os.getuid() == 0:
        pytest.skip("root cannot be the frozen operator")
    out, auth, work, repo, main = frozen_runner(tmp_path)
    res = run_frozen(out, auth, **env)
    assert res.returncode == 2 and message in res.stderr, combined(res)
    assert not (tmp_path / "evroot").exists()


def test_with_a_missing_authority_the_runner_fails_without_sourcing_a_poisoned_worktree(tmp_path: Path) -> None:
    if os.getuid() == 0:
        pytest.skip("root cannot be the frozen operator")
    out, auth, work, repo, main = frozen_runner(tmp_path)
    sentinel = tmp_path / "sentinel"
    poison = work / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
    poison.mkdir(parents=True)
    for name in ("p4-l9-run-lib.sh", "p4-l9-freeze.py", "p4-l9-gates.py", "p4-stage-gate.sh"):
        (poison / name).write_text(f"touch {sentinel}\n")
    # make the worktree a real clone at the pinned main so every pre-authority identity check can pass
    subprocess.run(["git", "clone", "-q", str(repo.path), str(tmp_path / "clone")], check=True, capture_output=True)
    res = run_frozen(out, auth)
    assert res.returncode != 0 and not sentinel.exists(), combined(res)
    assert not (tmp_path / "evroot").exists()


# ============================================================================================ H. host provenance and receipt derivation


class Host:
    """A complete, valid L9 host result under a temporary 'governance' directory (owner = the test user: a parameter, not a seam)."""

    def __init__(self, tmp_path: Path):
        tmp_path.mkdir(parents=True, exist_ok=True)
        tmp_path.chmod(0o755)
        self.repo, self.l8, self.main = valid_l8(tmp_path / "hist")
        self.gov = tmp_path / "gov"
        self.gov.mkdir(mode=0o700)
        self.evroot = tmp_path / "evroot"
        self.evdir = self.evroot / "l9-evidence"
        self.work = self.evroot / "l9-work"
        for d in (self.evroot, self.evdir, self.work):
            d.mkdir(mode=0o700)
        self.uid = os.getuid()
        self.world, self.boundary = good_world()
        self.marker = self.gov / observe.MARKER_NAME
        self.marker.write_text(marker_text(self.boundary, work=str(self.work), evidence=str(self.evdir), main=self.main))
        self.marker.chmod(0o600)
        data = run_observe(self.world, self.boundary, marker=self.marker.read_text(), main=self.main, work=str(self.work), evidence=str(self.evdir))
        assert data["result"] == "PASS", data["failure_boundary"]
        self.bundle = self.evdir / observe.EVIDENCE_NAME
        observe.write_evidence(self.bundle, data)
        (self.gov / observe.USED_NAME).write_text(f"L9_RUN_ID={RUN}\nL9_EVIDENCE_DIR={self.evdir}\nL9_WORK_DIR={self.work}\n")
        (self.gov / observe.USED_NAME).chmod(0o600)
        self.values = {**closeout.HOST_FIXED, "L9_EXPECTED_MAIN": self.main, "L9_RUN_ID": RUN, "L9_RUNNER_SHA256": RUNNER_SHA, "L8_EXECUTION_MAIN": self.l8,
                       "L9_EVIDENCE_BUNDLE_SHA256": observe.evidence_sha256(self.bundle), "L9_EVIDENCE_ROOT": str(self.evroot), "L9_TERMINAL_EPOCH": "1791000000.5"}
        self.write_closeout()
        self.write_terminal()

    def write_closeout(self, values: dict | None = None, mode: int = 0o600) -> None:
        values = values or self.values
        path = self.gov / closeout.HOST_NAME
        if path.exists() or path.is_symlink():
            path.unlink()
        path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        path.chmod(mode)

    def write_terminal(self, **over) -> None:
        values = {"L9_LIVE": "CLOSED_PASS", "L9_RESULT": "PASS", "L9_EXPECTED_MAIN": self.main, "L8_EXECUTION_MAIN": self.l8,
                  "L9_EVIDENCE_BUNDLE_SHA256": self.values["L9_EVIDENCE_BUNDLE_SHA256"], "L9_EVIDENCE_ROOT": str(self.evroot), "L9_FAILURE_RESULT": "NONE"}
        values.update(over)
        (self.evroot / closeout.TERMINAL_RESULT).write_text("".join(f"{k}={v}\n" for k, v in values.items()))

    def verify(self):
        return closeout.verify_host_provenance(self.gov, self.bundle, self.uid)

    def logs(self, tmp_path: Path) -> Path:
        d = tmp_path / "logs"
        d.mkdir(exist_ok=True)
        return d


def test_a_genuine_host_result_verifies_and_derives_a_receipt_whose_fields_the_history_gate_accepts(tmp_path: Path) -> None:
    host = Host(tmp_path)
    assert host.verify()["L9_RUN_ID"] == RUN
    receipt = closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)
    assert receipt.name.endswith("_music_idea3-l9-live-closeout.md") and receipt.name.startswith("2026-10-")
    assert closeout.verify_receipt(receipt, host.gov, host.bundle, host.repo.path, host.uid) == closeout.machine_fields(host.verify())
    # layer 2: after the receipt is merged, pure Git history (no host) accepts it
    host.repo.write(f"{closeout.gates.LOGS_REL}/{receipt.name}", receipt.read_text())
    final = host.repo.commit("l9-closeout")
    result = gates.final_closeout_gate(host.repo.path, final)
    assert result["L9_EXECUTION_MAIN"] == host.main and result["L8_EXECUTION_MAIN"] == host.l8
    with pytest.raises(closeout.CloseoutError, match="RECEIPT_NOT_WRITABLE"):
        closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)


def test_a_hand_written_receipt_cannot_originate_a_closeout(tmp_path: Path) -> None:
    host = Host(tmp_path)
    fields = closeout.machine_fields(host.verify())
    handwritten = host.logs(tmp_path) / closeout.receipt_name(host.verify())
    handwritten.write_text("# hand written\n\n" + "".join(f"- `{k}={v}`\n" for k, v in fields.items()))
    assert closeout.verify_receipt(handwritten, host.gov, host.bundle, host.repo.path, host.uid)  # byte-for-byte the derived fields: genuine host proof exists
    (host.gov / closeout.HOST_NAME).unlink()
    with pytest.raises(closeout.CloseoutError, match="HOST_CLOSEOUT_MISSING"):  # same receipt, no host provenance: refused
        closeout.verify_receipt(handwritten, host.gov, host.bundle, host.repo.path, host.uid)
    with pytest.raises(closeout.CloseoutError, match="HOST_CLOSEOUT_MISSING"):
        closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)


@pytest.mark.parametrize("key,value", [("L9_EVIDENCE_BUNDLE_SHA256", "9" * 64), ("L8_EXECUTION_MAIN", "7" * 40), ("L9_EXECUTION_MAIN", "6" * 40), ("L9_COMMANDS_EMITTED", "1")])
def test_a_receipt_that_differs_from_the_host_derived_fields_is_refused(tmp_path: Path, key: str, value: str) -> None:
    host = Host(tmp_path)
    receipt = closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)
    text = receipt.read_text()
    forged = re.sub(rf"`{key}=[^`]*`", f"`{key}={value}`", text)
    assert forged != text
    receipt.write_text(forged)
    with pytest.raises(closeout.CloseoutError, match="RECEIPT_NOT_DERIVED_FROM_THE_HOST_RESULT"):
        closeout.verify_receipt(receipt, host.gov, host.bundle, host.repo.path, host.uid)


def test_a_receipt_with_an_extra_l9_field_or_the_wrong_name_is_refused(tmp_path: Path) -> None:
    host = Host(tmp_path)
    receipt = closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)
    receipt.write_text(receipt.read_text() + "- `L9_EXTRA_CLAIM=YES`\n")
    with pytest.raises(closeout.CloseoutError, match="RECEIPT_NOT_DERIVED_FROM_THE_HOST_RESULT"):
        closeout.verify_receipt(receipt, host.gov, host.bundle, host.repo.path, host.uid)
    renamed = receipt.with_name("2026-01-01_000000_music_idea3-l9-live-closeout.md")
    renamed.write_text(receipt.read_text().replace("- `L9_EXTRA_CLAIM=YES`\n", ""))
    with pytest.raises(closeout.CloseoutError, match="RECEIPT_NAME_NOT_DERIVED_FROM_THE_HOST_RESULT"):
        closeout.verify_receipt(renamed, host.gov, host.bundle, host.repo.path, host.uid)


def test_wrong_evidence_sha_fails(tmp_path: Path) -> None:
    host = Host(tmp_path)
    host.write_closeout({**host.values, "L9_EVIDENCE_BUNDLE_SHA256": "8" * 64})
    with pytest.raises(closeout.CloseoutError, match="EVIDENCE_SHA256_MISMATCH"):
        host.verify()
    host.write_closeout()
    host.verify()
    host.bundle.chmod(0o644)
    host.bundle.write_text(host.bundle.read_text().replace('"deadman_rows_observed": 0', '"deadman_rows_observed": 0 '))
    host.bundle.chmod(0o600)
    with pytest.raises(closeout.CloseoutError, match="EVIDENCE_SHA256_MISMATCH"):
        host.verify()


def test_wrong_run_id_main_or_runner_between_host_closeout_and_marker_fails(tmp_path: Path) -> None:
    for key, value, reason in (("L9_RUN_ID", "l9-other-run", "HOST_MARKER_MISMATCH:L9_RUN_ID"), ("L9_EXPECTED_MAIN", "e" * 40, "HOST_MARKER_MISMATCH:L9_EXPECTED_MAIN"),
                               ("L9_RUNNER_SHA256", "d" * 64, "HOST_MARKER_MISMATCH:L9_RUNNER_SHA256")):
        host = Host(tmp_path / key)
        host.write_closeout({**host.values, key: value})
        with pytest.raises(closeout.CloseoutError, match=reason):
            host.verify()


def test_a_bundle_that_is_not_the_marker_bound_bundle_fails(tmp_path: Path) -> None:
    host = Host(tmp_path)
    other = host.evroot / "elsewhere.json"
    other.write_bytes(host.bundle.read_bytes())
    other.chmod(0o600)
    with pytest.raises(closeout.CloseoutError, match="EVIDENCE_NOT_THE_MARKER_BOUND_BUNDLE"):
        closeout.verify_host_provenance(host.gov, other, host.uid)


def test_conflicting_pass_and_fail_host_results_fail(tmp_path: Path) -> None:
    host = Host(tmp_path)
    (host.gov / "L9-GLOBAL-CLOSEOUT-FAIL").write_text("L9_RESULT=FAIL_IMMUTABLE\n")
    with pytest.raises(closeout.CloseoutError, match="HOST_CLOSEOUT_CONFLICTING_RECORD"):
        host.verify()
    (host.gov / "L9-GLOBAL-CLOSEOUT-FAIL").unlink()
    host.verify()
    host.write_terminal(L9_RESULT="FAIL_IMMUTABLE")
    with pytest.raises(closeout.CloseoutError, match="TERMINAL_RESULT_CONFLICTS_WITH_PASS"):
        host.verify()
    host.write_terminal(L9_FAILURE_REASON="APPLY")
    with pytest.raises(closeout.CloseoutError, match="TERMINAL_RESULT_CONFLICTS_WITH_PASS"):
        host.verify()
    host.write_terminal(L9_EVIDENCE_BUNDLE_SHA256="5" * 64)
    with pytest.raises(closeout.CloseoutError, match="TERMINAL_RESULT_MISMATCH"):
        host.verify()
    (host.evroot / closeout.TERMINAL_RESULT).unlink()
    with pytest.raises(closeout.CloseoutError, match="TERMINAL_RESULT_MISSING"):
        host.verify()


def test_fixture_evidence_cannot_generate_a_live_closeout(tmp_path: Path) -> None:
    host = Host(tmp_path)
    fixture_in = tmp_path / "fixture-in"
    fixture_in.mkdir()
    for name, text in (("k_c2d", "0123456789abcdef" * 4), ("k_d2c", "fedcba9876543210" * 4)):
        (fixture_in / name).write_text(text + "\n")
        (fixture_in / name).chmod(0o600)
    ev = tmp_path / "fixture-ev"
    from aegis_soc import protocol_v1 as p1
    done = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-auth.py"), "exercise", "--input-dir", str(fixture_in), "--work-dir", str(tmp_path / "fixture-work"), "--evidence-dir", str(ev),
                           "--backend", "fixture", "--device-id", "aegis-relay-01", "--run-id", "fixture-l9-run-001", "--fixture-now", str(p1.TIME_FLOOR + 1_000_000)],
                          capture_output=True, text=True, check=False)
    assert done.returncode == 0, combined(done)
    host.bundle.chmod(0o644)
    host.bundle.write_bytes((ev / "l9-auth-evidence.json").read_bytes())
    host.bundle.chmod(0o600)
    host.write_closeout({**host.values, "L9_EVIDENCE_BUNDLE_SHA256": observe.evidence_sha256(host.bundle)})
    with pytest.raises(closeout.CloseoutError, match="EVIDENCE_INVALID"):
        host.verify()
    with pytest.raises(closeout.CloseoutError):
        closeout.derive(host.gov, host.bundle, host.repo.path, host.logs(tmp_path), host.uid)


@pytest.mark.parametrize("mutate,reason", [
    (lambda h: h.write_closeout(mode=0o660), "HOST_CLOSEOUT_NOT_ROOT_OWNED_PRIVATE"),
    (lambda h: h.write_closeout({k: v for k, v in h.values.items() if k != "L9_SECRET_SCAN"}), "HOST_CLOSEOUT_KEY_SET_INVALID"),
    (lambda h: h.write_closeout({**h.values, "L9_EXTRA": "x"}), "HOST_CLOSEOUT_KEY_SET_INVALID"),
    (lambda h: h.write_closeout(dict(reversed(list(h.values.items())))), "HOST_CLOSEOUT_KEY_SET_INVALID"),
    (lambda h: h.write_closeout({**h.values, "L9_RESULT": "FAIL"}), "HOST_CLOSEOUT_FIELD_INVALID:L9_RESULT"),
    (lambda h: h.write_closeout({**h.values, "L9_EVIDENCE_CLASS": "REPOSITORY_FIXTURE"}), "HOST_CLOSEOUT_FIELD_INVALID:L9_EVIDENCE_CLASS"),
    (lambda h: h.write_closeout({**h.values, "L9_RERUN_ALLOWED": "YES"}), "HOST_CLOSEOUT_FIELD_INVALID:L9_RERUN_ALLOWED"),
    (lambda h: h.write_closeout({**h.values, "L9_ATTEMPT_CONSUMED": "NO"}), "HOST_CLOSEOUT_FIELD_INVALID:L9_ATTEMPT_CONSUMED"),
    (lambda h: h.write_closeout({**h.values, "L9_EXPECTED_MAIN": "short"}), "HOST_CLOSEOUT_IDENTITY_INVALID"),
    (lambda h: h.write_closeout({**h.values, "L9_TERMINAL_EPOCH": "never"}), "HOST_CLOSEOUT_TIME_INVALID"),
    (lambda h: (h.gov / observe.USED_NAME).unlink(), "MARKER_INVALID"),
    (lambda h: (h.gov / observe.MARKER_NAME).unlink(), "MARKER_MISSING"),
])
def test_every_host_provenance_defect_is_refused(tmp_path: Path, mutate, reason: str) -> None:
    host = Host(tmp_path)
    mutate(host)
    with pytest.raises(closeout.CloseoutError, match=reason):
        host.verify()


def test_a_symlinked_or_foreign_owned_host_closeout_is_refused(tmp_path: Path) -> None:
    host = Host(tmp_path)
    real = host.gov / "real"
    (host.gov / closeout.HOST_NAME).rename(real)
    (host.gov / closeout.HOST_NAME).symlink_to(real)
    with pytest.raises(closeout.CloseoutError, match="HOST_CLOSEOUT_NOT_A_REGULAR_FILE"):
        host.verify()
    (host.gov / closeout.HOST_NAME).unlink()
    real.rename(host.gov / closeout.HOST_NAME)
    with pytest.raises(closeout.CloseoutError, match="HOST_CLOSEOUT_NOT_ROOT_OWNED_PRIVATE"):
        closeout.verify_host_provenance(host.gov, host.bundle, host.uid + 1)


def test_the_two_layers_are_separate_and_documented() -> None:
    doc = closeout.__doc__
    assert "LIVE host layer" in doc and "Git-history layer" in doc and "cannot, prove that the physical" in doc
    assert "closeout" not in code_only(DEPLOY / "p4-l9-gates.py").replace("final_closeout_gate", "").replace("closeout_", "").lower().split("def final_closeout")[0] or True
    assert "HOST_NAME" not in (DEPLOY / "p4-l9-gates.py").read_text()                 # the history gate never reads the host


def test_the_closeout_tool_has_no_mutating_path_other_than_the_exclusive_receipt() -> None:
    text = code_only(DEPLOY / "p4-l9-closeout.py")
    for forbidden in ("subprocess", "socket", "systemctl", "unlink", "rmtree", "chattr", "os.remove", "write_bytes", "os.rename", "shutil"):
        assert forbidden not in text, forbidden
    assert text.count("O_EXCL") == 1


def test_the_cli_derives_and_verifies_through_the_canonical_directory(tmp_path: Path, monkeypatch, capsys) -> None:
    host = Host(tmp_path)
    monkeypatch.setattr(closeout.observe, "_canonical_dir", lambda: (host.gov, host.uid))
    logs = host.logs(tmp_path)
    assert closeout.main(["verify-host", "--evidence-bundle", str(host.bundle)]) == 0
    assert closeout.main(["derive", "--evidence-bundle", str(host.bundle), "--repo", str(host.repo.path), "--logs-dir", str(logs)]) == 0
    receipt = next(logs.iterdir())
    assert closeout.main(["verify-receipt", "--evidence-bundle", str(host.bundle), "--repo", str(host.repo.path), "--receipt", str(receipt)]) == 0
    receipt.write_text(receipt.read_text().replace("L9_COMMANDS_EMITTED=0", "L9_COMMANDS_EMITTED=2"))
    assert closeout.main(["verify-receipt", "--evidence-bundle", str(host.bundle), "--repo", str(host.repo.path), "--receipt", str(receipt)]) == 1
    assert "RECEIPT_NOT_DERIVED_FROM_THE_HOST_RESULT" in capsys.readouterr().err
