from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "deploy/pr11-phase4/r1i-successor/r1i_successor.py"
CONTRACT = ROOT / "deploy/pr11-phase4/r1i-successor/r1i-successor.nft"
MAIN_SHA = "a401cdb71bb9f5df244a093dd612daf457c26a94"
CONTRACT_SHA = "7cb088c698d1a5fc8df62f13ec94c83ab37e974a7644588c7fd15bb9449f7888"

PRE_RULESET = {
    "nftables": [
        {"metainfo": {"json_schema_version": 1}},
        {"table": {"family": "inet", "name": "other_owner"}},
        {"chain": {"family": "inet", "table": "other_owner", "name": "input"}},
    ]
}


def fake_nft(tmp_path: Path) -> Path:
    script = tmp_path / "nft"
    script.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

state = Path(os.environ[\"FAKE_NFT_STATE\"])
current = state / \"current.json\"
calls = state / \"calls.log\"
args = sys.argv[1:]
calls.open(\"a\", encoding=\"utf-8\").write(\" \".join(args) + \"\\n\")

def load():
    return json.loads(current.read_text(encoding=\"utf-8\"))

if args == [\"-j\", \"list\", \"ruleset\"]:
    mode = os.environ.get(\"FAKE_NFT_MODE\", \"stable\")
    if mode == \"drift\" and not (state / \"drifted\").exists():
        (state / \"drifted\").write_text(\"1\")
        print(json.dumps({\"nftables\": [{\"table\": {\"family\": \"inet\", \"name\": \"unexpected\"}}]}))
    else:
        print(json.dumps(load()))
    raise SystemExit(0)
if args == [\"--stateless\", \"list\", \"table\", \"inet\", \"aegis_idea3_r1i\"]:
    sys.stdout.write((state / \"owned.txt\").read_text(encoding=\"utf-8\"))
    raise SystemExit(0)
if len(args) == 2 and args[0] == \"-f\":
    if os.environ.get(\"FAKE_NFT_MODE\") == \"install-fail\":
        raise SystemExit(1)
    (state / \"installed\").write_text(\"1\")
    if os.environ.get(\"FAKE_NFT_MODE\") == \"post-invalid\":
        current.write_text(\"not-json\", encoding=\"utf-8\")
        raise SystemExit(0)
    post = os.environ.get(\"FAKE_NFT_POST\")
    if post:
        current.write_text(post, encoding=\"utf-8\")
    raise SystemExit(0)
if args == [\"delete\", \"table\", \"inet\", \"aegis_idea3_r1i\"]:
    if os.environ.get(\"FAKE_NFT_MODE\") == \"delete-fail\":
        raise SystemExit(1)
    current.write_text(os.environ[\"FAKE_NFT_PRE\"], encoding=\"utf-8\")
    (state / \"deleted\").write_text(\"1\")
    raise SystemExit(0)
raise SystemExit(2)
""",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


def owned_state() -> str:
    return (
        "table inet aegis_idea3_r1i {\n"
        "\tchain input {\n"
        "\t\ttype filter hook input priority filter - 10; policy accept;\n"
        "\t\tmeta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
        "\t}\n"
        "}\n"
    )


def post_ruleset() -> dict:
    return {
        "nftables": PRE_RULESET["nftables"]
        + [{"table": {"family": "inet", "name": "aegis_idea3_r1i"}}]
    }


def auth_file(tmp_path: Path, *, main: str = MAIN_SHA, runner: str | None = None) -> Path:
    path = tmp_path / "authorization.txt"
    path.write_text(
        "\n".join(
            [
                "successor_id=R1I-SUCCESSOR-20261009",
                "attempt_id=R1I-SUCCESSOR-ATTEMPT-001",
                f"trusted_main_sha={main}",
                f"runner_sha256={runner or hashlib.sha256(RUNNER.read_bytes()).hexdigest()}",
                f"contract_sha256={CONTRACT_SHA}",
                "authorized=YES",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return path


def setup(tmp_path: Path, *, mode: str = "stable", post: dict | None = None):
    state = tmp_path / "nft-state"
    state.mkdir()
    (state / "current.json").write_text(json.dumps(PRE_RULESET), encoding="utf-8")
    (state / "owned.txt").write_text(owned_state(), encoding="utf-8")
    nft_dir = tmp_path / "bin"
    nft_dir.mkdir()
    fake_nft(tmp_path)
    (nft_dir / "nft").symlink_to(tmp_path / "nft")
    env = {
        **os.environ,
        "PATH": f"{nft_dir}:{os.environ['PATH']}",
        "FAKE_NFT_STATE": str(state),
        "FAKE_NFT_MODE": mode,
        "FAKE_NFT_PRE": json.dumps(PRE_RULESET),
        "AEGIS_R1I_SUCCESSOR_FIXTURE": "YES",
    }
    if post is not None:
        env["FAKE_NFT_POST"] = json.dumps(post)
    canonical = tmp_path / "canonical"
    canonical.mkdir()
    authorization = auth_file(tmp_path)
    work = tmp_path / "work"
    return env, state, canonical, authorization, work


def run_runner(env, canonical, authorization, work, command="apply", repo=ROOT):
    return subprocess.run(
        [
            "python3",
            str(RUNNER),
            command,
            "--repo-root",
            str(repo),
            "--canonical-dir",
            str(canonical),
            "--authorization",
            str(authorization),
            "--state-dir",
            str(work),
            "--fixture",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_exact_successor_contract_is_the_reviewed_input_rule() -> None:
    text = CONTRACT.read_text(encoding="utf-8")
    assert text == (
        "create table inet aegis_idea3_r1i\n"
        "add chain inet aegis_idea3_r1i input { type filter hook input priority -10; policy accept; }\n"
        "add rule inet aegis_idea3_r1i input meta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix \"AEGIS_NEWCONN \" level info\n"
    )
    assert "forward" not in text and "flush" not in text and "delete" not in text


def test_missing_rule_is_prepared_once_and_unrelated_rules_are_preserved(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 0, result.stderr
    assert "R1I_SUCCESSOR_APPLY=PASS" in result.stdout
    assert json.loads((work / "pre-ruleset.json").read_text()) == PRE_RULESET
    assert json.loads((work / "post-ruleset.json").read_text()) == post_ruleset()
    assert (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").is_file()
    assert "aegis_idea3_r1i" not in json.dumps(PRE_RULESET)
    assert not (state / "deleted").exists()


def test_existing_or_foreign_r1i_rule_is_rejected_without_consuming_attempt(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    existing = {"nftables": PRE_RULESET["nftables"] + [{"table": {"family": "inet", "name": "aegis_idea3_r1i"}}]}
    (state / "current.json").write_text(json.dumps(existing), encoding="utf-8")
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 1 and "R1I_EXISTING_OR_FOREIGN_RULE" in result.stderr
    assert not (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert not (state / "installed").exists()


def test_ruleset_drift_between_preflight_and_immediate_snapshot_stops_before_install(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, mode="drift", post=post_ruleset())
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 1 and "R1I_PRE_MUTATION_DRIFT" in result.stderr
    assert not (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert not (state / "installed").exists()


def test_stale_main_authority_is_rejected(tmp_path: Path) -> None:
    env, state, canonical, _auth, work = setup(tmp_path, post=post_ruleset())
    auth = auth_file(tmp_path, main="0" * 40)
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 1 and "R1I_MAIN_AUTHORITY_MISMATCH" in result.stderr
    assert not (state / "installed").exists()


def test_invalid_authorization_and_reused_attempt_are_fail_closed(tmp_path: Path) -> None:
    env, _state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    auth.write_text(auth.read_text().replace("authorized=YES", "authorized=NO"), encoding="utf-8")
    assert "R1I_AUTHORIZATION_INVALID" in run_runner(env, canonical, auth, work).stderr
    auth = auth_file(tmp_path)
    (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").write_text("immutable\n", encoding="utf-8")
    assert "R1I_ATTEMPT_ALREADY_CONSUMED" in run_runner(env, canonical, auth, work).stderr


def test_historical_attempt_marker_is_untouched_and_successor_is_distinct(tmp_path: Path) -> None:
    env, _state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    historical = canonical / "R1I-GLOBAL-ATTEMPT-CONSUMED"
    historical.write_text("historical\n", encoding="utf-8")
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 0, result.stderr
    assert historical.read_text(encoding="utf-8") == "historical\n"
    assert (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").is_file()


def test_failed_install_consumes_successor_attempt_and_cannot_retry(tmp_path: Path) -> None:
    env, _state, canonical, auth, work = setup(tmp_path, mode="install-fail", post=post_ruleset())
    first = run_runner(env, canonical, auth, work)
    assert first.returncode == 1 and "R1I_INSTALL_FAILED" in first.stderr
    assert (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").is_file()
    second = run_runner(env, canonical, auth, work)
    assert second.returncode == 1 and "R1I_ATTEMPT_ALREADY_CONSUMED" in second.stderr


def test_failed_post_verification_leaves_owned_state_for_escalation(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    (state / "owned.txt").write_text("foreign owned shape\n", encoding="utf-8")
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 1 and "R1I_POST_VERIFY_FAILED" in result.stderr
    assert "R1I_ROLLBACK_UNSAFE" in result.stderr
    assert (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").is_file()
    assert not (state / "deleted").exists()


def test_ambiguous_post_state_is_terminal_and_never_retried(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, mode="post-invalid", post=post_ruleset())
    result = run_runner(env, canonical, auth, work)
    assert result.returncode == 1 and "R1I_POST_VERIFY_FAILED" in result.stderr
    assert "R1I_ROLLBACK_UNSAFE" in result.stderr
    assert (canonical / "R1I-SUCCESSOR-GLOBAL-ATTEMPT-CONSUMED").is_file()
    assert not (state / "deleted").exists()


def test_verify_and_rollback_refuse_drift_and_never_delete_unowned_state(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    assert run_runner(env, canonical, auth, work).returncode == 0
    (state / "current.json").write_text(json.dumps({"nftables": [{"table": {"family": "inet", "name": "foreign"}}]}), encoding="utf-8")
    verify = run_runner(env, canonical, auth, work, "verify")
    rollback = run_runner(env, canonical, auth, work, "rollback")
    assert "R1I_POST_STATE_DRIFT" in verify.stderr
    assert "R1I_ROLLBACK_UNSAFE" in rollback.stderr
    assert not (state / "deleted").exists()


def test_successful_rollback_restores_the_complete_pre_snapshot(tmp_path: Path) -> None:
    env, state, canonical, auth, work = setup(tmp_path, post=post_ruleset())
    assert run_runner(env, canonical, auth, work).returncode == 0
    rollback = run_runner(env, canonical, auth, work, "rollback")
    assert rollback.returncode == 0, rollback.stderr
    assert json.loads((state / "current.json").read_text()) == PRE_RULESET
    assert "R1I_SUCCESSOR_ROLLBACK=PASS" in rollback.stdout


def test_source_has_no_detector_incident_recovery_relay_or_core_lifecycle_side_effects() -> None:
    text = "\n".join(p.read_text(encoding="utf-8") for p in (RUNNER, CONTRACT))
    forbidden = ("systemctl", "mqtt", "incident", "recovery", "relay", "esp32", "socket")
    assert not any(word in text.lower() for word in forbidden)
    assert not any(word in text for word in ("CUT", "ISOLATE", "RESTORE"))
