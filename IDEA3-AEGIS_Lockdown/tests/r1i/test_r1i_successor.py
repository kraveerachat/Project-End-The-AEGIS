from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "deploy/pr11-phase4/r1i-successor/r1i_successor.py"
CONTRACT = ROOT / "deploy/pr11-phase4/r1i-successor/r1i-successor.nft"
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
    main = main or runner.TRUSTED_MAIN_SHA
    path.write_text("\n".join(["successor_id=R1I-SUCCESSOR-20261009", "attempt_id=R1I-SUCCESSOR-ATTEMPT-001", f"trusted_main_sha={main}", f"runner_sha256={runner_sha or hashlib.sha256(RUNNER.read_bytes()).hexdigest()}", f"contract_sha256={runner.CONTRACT_SHA256}", "authorized=YES"]) + "\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return path

def setup(tmp_path: Path, *, mode: str = "stable", post: dict | None = None):
    canonical = tmp_path / "canonical"
    canonical.mkdir(mode=0o700)
    state = tmp_path / "state"
    auth = auth_file(tmp_path)
    authority = tmp_path / "trusted-main-authority"
    authority.write_bytes(runner.TRUSTED_MAIN_AUTHORITY_RECORD)
    authority.chmod(stat.S_IRUSR | stat.S_IWUSR)
    trusted_git = tmp_path / "trusted-git"
    trusted_git.write_text(f"#!/bin/sh\nprintf '%s\\n' {runner.TRUSTED_MAIN_SHA}\n")
    trusted_git.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    context = runner.Context(ROOT, canonical, auth, state, RUNNER, CONTRACT, trusted_git, Path("/usr/bin/nft"), authority, True)
    return context, FakeNft(PRE, post, mode)

def invoke(fn, *args):
    try:
        fn(*args)
    except runner.RunnerError as exc:
        return 1, str(exc)
    return 0, ""

def test_exact_successor_contract_is_reviewed_input_rule():
    text = CONTRACT.read_text()
    assert text == "create table inet aegis_idea3_r1i\nadd chain inet aegis_idea3_r1i input { type filter hook input priority -10; policy accept; }\nadd rule inet aegis_idea3_r1i input meta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
    assert "forward" not in text and "flush" not in text and "delete" not in text

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
    context = runner.Context(context.repo_root, context.canonical_dir, auth_file(tmp_path, main="0" * 40), context.state_dir, context.runner, context.contract, context.git, context.nft, context.main_authority, True)
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_MISMATCH" in error

def test_matching_local_head_without_independent_authority_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    context.main_authority.unlink()
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_UNVERIFIED" in error
    assert not (context.canonical_dir / runner.ATTEMPT_MARKER).exists()

def test_tampered_independent_authority_is_rejected(tmp_path):
    context, fake = setup(tmp_path)
    context.main_authority.write_bytes(runner.TRUSTED_MAIN_AUTHORITY_RECORD.replace(b"GITHUB_MAIN_VERIFIED", b"LOCAL_HEAD"))
    rc, error = invoke(runner.apply, context, fake)
    assert rc == 1 and "R1I_MAIN_AUTHORITY_UNVERIFIED" in error

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
