from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
from types import SimpleNamespace
from dataclasses import replace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "deploy/pr11-phase4/r1i-successor/r1i_successor.py"
CONTRACT = ROOT / "deploy/pr11-phase4/r1i-successor/r1i-successor.nft"
VERIFIED_MAIN = "a401cdb71bb9f5df244a093dd612daf457c26a94"
SPEC = importlib.util.spec_from_file_location("r1i_successor", RUNNER)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["r1i_successor"] = runner
SPEC.loader.exec_module(runner)

PRE = {"nftables": [{"metainfo": {"json_schema_version": 1}}, {"table": {"family": "inet", "name": "other_owner"}}, {"chain": {"family": "inet", "table": "other_owner", "name": "input"}}, {"rule": {"family": "inet", "table": "other_owner", "chain": "input", "counter": {"packets": 1, "bytes": 2}, "expr": []}}]}

def owned_state() -> str:
    return runner.OWNED_STATE

def post_ruleset() -> dict:
    return {"nftables": PRE["nftables"] + [{"table": {"family": "inet", "name": runner.TABLE}}, {"chain": {"family": "inet", "table": runner.TABLE, "name": "input"}}, {"rule": {"family": "inet", "table": runner.TABLE, "chain": "input", "expr": []}}]}

class FakeNft:
    def __init__(self, initial: dict, post: dict | None = None, mode: str = "stable") -> None:
        self.current = initial
        self.post = post or post_ruleset()
        self.mode = mode
        self.deleted = False
        self.calls: list[list[str]] = []
        self.reads = 0

    def __call__(self, args: list[str]) -> tuple[int, str]:
        self.calls.append(args)
        if args == ["-j", "list", "ruleset"]:
            self.reads += 1
            if self.mode == "drift" and self.reads == 2:
                return 0, json.dumps({"nftables": [{"table": {"family": "inet", "name": "unexpected"}}]})
            if self.mode == "post-invalid" and self.deleted is False and self.reads >= 3:
                return 0, "not-json"
            return 0, json.dumps(self.current)
        if args == ["--stateless", "list", "table", "inet", runner.TABLE]:
            return (1, "") if self.mode == "owned-invalid" else (0, owned_state())
        if len(args) == 2 and args[0] == "-f":
            if self.mode == "install-fail":
                return 1, ""
            self.current = self.post
            return 0, ""
        if args == ["delete", "table", "inet", runner.TABLE]:
            self.current = PRE
            self.deleted = True
            return (1, "") if self.mode == "delete-fail" else (0, "")
        return 2, ""

def auth_file(tmp: Path, *, main: str | None = None, runner_sha: str | None = None) -> Path:
    path = tmp / "authorization.txt"
    main = main or VERIFIED_MAIN
    path.write_text("\n".join(["successor_id=R1I-SUCCESSOR-20261009", "attempt_id=R1I-SUCCESSOR-ATTEMPT-001", f"trusted_main_sha={main}", f"runner_sha256={runner_sha or hashlib.sha256(RUNNER.read_bytes()).hexdigest()}", f"contract_sha256={runner.CONTRACT_SHA256}", "authorized=YES"]) + "\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return path

def setup(tmp_path: Path, *, mode: str = "stable", post: dict | None = None):
    canonical = tmp_path / "canonical"
    canonical.mkdir(mode=0o700)
    state = tmp_path / "state"
    auth = auth_file(tmp_path)
    trusted_git = tmp_path / "trusted-git"
    trusted_git.write_text(f"#!/bin/sh\nprintf '%s\\n' {VERIFIED_MAIN}\n")
    trusted_git.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    context = runner.Context(ROOT, canonical, auth, state, RUNNER, CONTRACT, trusted_git, Path("/usr/bin/nft"), lambda: VERIFIED_MAIN, True)
    return context, FakeNft(PRE, post, mode)

def invoke(fn, *args):
    try:
        fn(*args)
    except runner.RunnerError as exc:
        return 1, str(exc)
    return 0, ""

def credential_context(tmp_path, token="synthetic-token", curl_result=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    context, fake = setup(tmp_path)
    token_path = tmp_path / "github-token"
    token_path.write_text(token + "\n")
    token_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    calls = {}
    def curl(args, config, env):
        calls["args"] = args
        calls["config"] = config
        calls["env"] = env
        if curl_result is not None:
            return curl_result
        return 0, json.dumps({"ref": "refs/heads/main", "object": {"sha": VERIFIED_MAIN}}), ""
    return replace(context, remote_main=None, token_path=token_path, curl_executor=curl), fake, calls

def test_exact_successor_contract_is_reviewed_input_rule():
    text = CONTRACT.read_text()
    assert text == "create table inet aegis_idea3_r1i\nadd chain inet aegis_idea3_r1i input { type filter hook input priority -10; policy accept; }\nadd rule inet aegis_idea3_r1i input meta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
    assert "forward" not in text and "flush" not in text and "delete" not in text

def test_live_state_paths_use_isolated_root_owned_canonical_directory():
    expected = Path("/var/lib/aegis-idea3-r1i-successor")
    assert runner.LIVE_CANONICAL_DIR == expected
    assert runner.LIVE_AUTHORIZATION == expected / "authorization.txt"
    assert runner.LIVE_STATE_DIR == expected / "state"
    assert runner.LIVE_CANONICAL_DIR != Path("/var/lib/aegis-idea3")

@pytest.mark.parametrize(
    "ancestor_stat",
    [
        SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=1000),
        SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0),
        SimpleNamespace(st_mode=stat.S_IFDIR | 0o775, st_uid=0),
    ],
    ids=["foreign-owner", "symlink", "group-writable"],
)
def test_untrusted_canonical_ancestor_fails_closed_without_consuming_attempt(monkeypatch, tmp_path, ancestor_stat):
    target = tmp_path / "canonical"
    ancestor = tmp_path / "ancestor"
    parts = [Path("/"), ancestor, target]
    monkeypatch.setattr(runner, "_path_chain", lambda _path: parts)

    def fake_lstat(path):
        if path == ancestor:
            return ancestor_stat
        return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)

    monkeypatch.setattr(Path, "lstat", fake_lstat)
    with pytest.raises(runner.RunnerError, match="R1I_TRUSTED_PATH_INVALID"):
        runner.trusted_path(target, directory=True)
    assert not (target / runner.ATTEMPT_MARKER).exists()

def test_apply_preserves_real_table_chain_rule_json_and_dynamic_counters(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 0, error
    assert json.loads((context.state_dir / "post-ruleset.json").read_text()) == post_ruleset()
    assert not fake.deleted

def test_existing_or_foreign_r1i_material_rejected_without_marker(tmp_path):
    context, fake = setup(tmp_path)
    fake.current = {"nftables": PRE["nftables"] + [{"table": {"family": "inet", "name": runner.TABLE}}]}
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_EXISTING_OR_FOREIGN_RULE" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

@pytest.mark.parametrize("prefix", ["AEGIS_NEWCONN ", "AEGIS_NEWCONN"])
def test_foreign_aegis_newconn_log_producer_is_rejected(tmp_path, prefix):
    context, fake = setup(tmp_path)
    fake.current = {"nftables": PRE["nftables"] + [{"rule": {"family": "inet", "table": "foreign_owner", "chain": "input", "expr": [{"log": {"prefix": prefix, "level": "info"}}]}}]}
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_EXISTING_OR_FOREIGN_RULE" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_similar_or_nonmatching_log_prefix_is_not_foreign_r1i_material(tmp_path):
    foreign = {"rule": {"family": "inet", "table": "foreign_owner", "chain": "input", "expr": [{"log": {"prefix": "AEGIS_NEWCONNECTION ", "level": "info"}}]}}
    context, fake = setup(tmp_path, post={"nftables": PRE["nftables"] + [foreign] + post_ruleset()["nftables"][len(PRE["nftables"]):]})
    fake.current = {"nftables": PRE["nftables"] + [foreign]}
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 0, error

def test_ruleset_drift_stops_before_install(tmp_path):
    context, fake = setup(tmp_path, mode="drift")
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_PRE_MUTATION_DRIFT" in error
    assert not any(call == ["-f", str(CONTRACT)] for call in fake.calls)

def test_stale_main_authority_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    context = runner.Context(context.repo_root, context.canonical_dir, auth_file(tmp_path, main="0" * 40), context.state_dir, context.runner, context.contract, context.git, context.nft, context.remote_main, True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_MISMATCH" in error

def test_matching_local_head_without_independent_remote_proof_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    context = runner.Context(context.repo_root, context.canonical_dir, context.authorization, context.state_dir, context.runner, context.contract, context.git, context.nft, lambda: (_ for _ in ()).throw(RuntimeError("unavailable")), True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_UNVERIFIED" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_forged_local_authority_file_cannot_replace_remote_proof(tmp_path):
    context, fake = setup(tmp_path)
    (tmp_path / "trusted-main-authority").write_text("main_sha=" + VERIFIED_MAIN + "\n")
    context = runner.Context(context.repo_root, context.canonical_dir, context.authorization, context.state_dir, context.runner, context.contract, context.git, context.nft, lambda: (_ for _ in ()).throw(RuntimeError("unavailable")), True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_UNVERIFIED" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_remote_sha_mismatch_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    context = runner.Context(context.repo_root, context.canonical_dir, context.authorization, context.state_dir, context.runner, context.contract, context.git, context.nft, lambda: "0" * 40, True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_MISMATCH" in error

def test_synthetic_token_is_stdin_only_and_not_in_argv_or_environment(tmp_path):
    token = "synthetic-token-123"
    context, _fake, calls = credential_context(tmp_path, token)
    assert runner.remote_main_sha(context) == VERIFIED_MAIN
    assert token not in " ".join(calls["args"])
    assert all(token not in value for value in calls["env"].values())
    assert token in calls["config"]
    assert calls["args"][1:3] == ["--config", "-"]

def test_credential_failure_does_not_disclose_token(tmp_path):
    token = "synthetic-error-token"
    context, _fake, _calls = credential_context(tmp_path, token, (22, "", f"Authorization: Bearer {token}"))
    rc, error = invoke(runner.remote_main_sha, context)
    assert rc == 1 and token not in error

@pytest.mark.parametrize("mutator", ["missing", "symlink", "hardlink", "permissions", "invalid"])
def test_credential_source_failures_are_closed(tmp_path, mutator):
    context, _fake, _calls = credential_context(tmp_path)
    if mutator == "missing":
        context.token_path.unlink()
    elif mutator == "symlink":
        context.token_path.unlink()
        context.token_path.symlink_to(tmp_path / "other-token")
    elif mutator == "hardlink":
        hard = tmp_path / "hard-token"
        os.link(context.token_path, hard)
    elif mutator == "permissions":
        context.token_path.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP)
    elif mutator == "invalid":
        context.token_path.write_bytes(b"bad\nheader\n")
    rc, error = invoke(runner.remote_main_sha, context)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_UNVERIFIED" in error

def test_response_and_request_failures_are_closed(tmp_path):
    malformed, _fake, _calls = credential_context(tmp_path / "malformed", curl_result=(0, "not-json", ""))
    assert "R1I_MAIN_AUTHORITY_UNVERIFIED" in invoke(runner.remote_main_sha, malformed)[1]
    failed, _fake, _calls = credential_context(tmp_path / "failed", curl_result=(28, "", "timeout"))
    assert "R1I_MAIN_AUTHORITY_UNVERIFIED" in invoke(runner.remote_main_sha, failed)[1]

def test_second_authority_failure_consumes_marker_without_nft_mutation(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    responses = iter([VERIFIED_MAIN, "0" * 40])
    context = replace(context, remote_main=lambda: next(responses))
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_POST_MARKER_AUTHORITY_FAILED" in error
    assert (context.canonical_dir / runner.ATTEMPT_MARKER).exists()
    assert not any(call == ["-f", str(CONTRACT)] for call in fake.calls)

def test_second_authority_unavailable_is_terminal_after_marker(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    calls = 0
    def changing_authority():
        nonlocal calls
        calls += 1
        if calls == 1:
            return VERIFIED_MAIN
        raise RuntimeError("remote unavailable")
    context = replace(context, remote_main=changing_authority)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_POST_MARKER_AUTHORITY_FAILED" in error
    assert (context.canonical_dir / runner.ATTEMPT_MARKER).exists()
    assert not any(call == ["-f", str(CONTRACT)] for call in fake.calls)

def test_untrusted_git_executable_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    link = tmp_path / "git-link"
    link.symlink_to(context.git)
    context = runner.Context(context.repo_root, context.canonical_dir, context.authorization, context.state_dir, context.runner, context.contract, link, context.nft, context.remote_main, True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_TRUSTED_PATH_INVALID" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_invalid_authorization_and_reused_attempt_fail_closed(tmp_path):
    context, fake = setup(tmp_path)
    context.authorization.write_text(context.authorization.read_text().replace("authorized=YES", "authorized=NO"))
    assert "R1I_AUTHORIZATION_INVALID" in invoke(runner.apply, context, fake)[1]
    reused = tmp_path / "reused"
    reused.mkdir()
    context, fake = setup(reused)
    (context.canonical_dir / runner.ATTEMPT_MARKER).write_text("immutable\n")
    assert "R1I_ATTEMPT_ALREADY_CONSUMED" in invoke(runner.apply, context, fake)[1]

def test_historical_marker_is_not_reused(tmp_path):
    context, fake = setup(tmp_path)
    (context.canonical_dir / "R1I-GLOBAL-ATTEMPT-CONSUMED").write_text("historical\n")
    assert invoke(runner.apply, context, fake)[0] == 0
    assert (context.canonical_dir / "R1I-GLOBAL-ATTEMPT-CONSUMED").read_text() == "historical\n"

def test_failed_install_is_inspected_and_attempt_cannot_retry(tmp_path):
    context, fake = setup(tmp_path, mode="install-fail")
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_INSTALL_FAILED_NO_MUTATION_PROVEN" in error
    assert (context.canonical_dir / runner.ATTEMPT_MARKER).exists()
    assert "R1I_ATTEMPT_ALREADY_CONSUMED" in invoke(runner.apply, context, fake)[1]

def test_partial_install_is_ambiguous_and_not_retried(tmp_path):
    context, fake = setup(tmp_path, mode="stable")
    fake.mode = "install-fail"
    fake.post = post_ruleset()
    original = fake.__call__
    def partial(args):
        if len(args) == 2 and args[0] == "-f":
            fake.current = fake.post
            return 1, ""
        return original(args)
    rc, error = invoke(runner.apply, context, partial)
    assert rc == 1 and "R1I_INSTALL_FAILED_AMBIGUOUS" in error

def test_post_verification_unsafe_state_never_deletes(tmp_path):
    context, fake = setup(tmp_path, mode="owned-invalid", post=post_ruleset())
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_ROLLBACK_UNSAFE" in error
    assert not fake.deleted

def test_verify_and_rollback_require_current_authority_marker_and_binding(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    assert invoke(runner.apply, context, fake)[0] == 0
    (context.canonical_dir / runner.ATTEMPT_MARKER).unlink()
    context.authorization.unlink()
    rc, error = invoke(runner.rollback_state, context, fake)
    assert rc == 1 and not fake.deleted

def test_modified_successor_marker_blocks_rollback(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    assert invoke(runner.apply, context, fake)[0] == 0
    (context.canonical_dir / runner.ATTEMPT_MARKER).write_text("successor_id=FOREIGN\nattempt_id=R1I-SUCCESSOR-ATTEMPT-001\n")
    rc, error = invoke(runner.rollback_state, context, fake)
    assert rc == 1 and "R1I_ATTEMPT_MARKER_INVALID" in error and not fake.deleted

def test_tampered_snapshot_blocks_rollback(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    assert invoke(runner.apply, context, fake)[0] == 0
    pre = json.loads((context.state_dir / "pre-ruleset.json").read_text())
    pre["nftables"].append({"table": {"family": "inet", "name": "foreign_after_apply"}})
    (context.state_dir / "pre-ruleset.json").write_text(json.dumps(pre))
    assert "R1I_STATE_INTEGRITY_INVALID" in invoke(runner.rollback_state, context, fake)[1]
    assert not fake.deleted

def test_successful_rollback_restores_snapshot_and_keeps_marker(tmp_path):
    context, fake = setup(tmp_path, post=post_ruleset())
    assert invoke(runner.apply, context, fake)[0] == 0
    rc, error = invoke(runner.rollback_state, context, fake)
    assert rc == 0, error
    assert fake.current == PRE and (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_symlink_and_hardlink_inputs_are_rejected(tmp_path):
    context, fake = setup(tmp_path)
    link = tmp_path / "link"
    link.symlink_to(context.authorization)
    assert "R1I_AUTHORIZATION_INVALID" in invoke(runner.parse_authorization, link, context)[1]
    hard = tmp_path / "hard"
    os.link(context.authorization, hard)
    assert "R1I_AUTHORIZATION_INVALID" in invoke(runner.parse_authorization, hard, context)[1]

def test_fixture_cli_is_not_available():
    result = subprocess.run([sys.executable, str(RUNNER), "apply", "--fixture"], text=True, capture_output=True)
    assert result.returncode == 2 and "unrecognized arguments" in result.stderr

def test_live_cli_does_not_resolve_nft_from_path(tmp_path):
    env = {**os.environ, "AEGIS_R1I_SUCCESSOR_LIVE_AUTHORIZED": "NO", "PATH": str(tmp_path)}
    result = subprocess.run([sys.executable, str(RUNNER), "apply"], env=env, text=True, capture_output=True)
    assert result.returncode == 1 and "R1I_LIVE_AUTHORIZATION_REQUIRED" in result.stderr

def test_source_has_no_unrelated_side_effects():
    text = "\n".join(path.read_text() for path in (RUNNER, CONTRACT))
    forbidden = ("systemctl", "mqtt", "incident", "recovery", "relay", "esp32", "socket")
    assert not any(word in text.lower() for word in forbidden)
