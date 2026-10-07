"""AEGIS IDEA3 PR11 Phase 4 — L9 live-capable governed successor suite.

Repository-only. No test contacts a broker, opens a serial device, starts/stops a service, touches the
real governance directory, or executes L8/L9 LIVE. Git history, receipts, sqlite stores and the Core's
status file are all synthetic fixtures built under ``tmp_path``.

Contract under test (design: 2026-10-07-idea3-pr11-phase4-l9-live-successor-design.md):
  L8 PASS (unique, ancestry-bound) -> L9 live observation (read-only) -> unique L9 closeout.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from aegis_soc import protocol_v1 as p1

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L9_STAGE = DEPLOY / "stages" / "L9"
RUNNER = DEPLOY / "owner-run" / "run-l9-owner.sh"
RUN_LIB = DEPLOY / "p4-l9-run-lib.sh"
LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


gates = load("p4_l9_gates", "p4-l9-gates.py")
observe = load("p4_l9_live_observe", "p4-l9-live-observe.py")
freeze = load("p4_l9_freeze", "p4-l9-freeze.py")

DEVICE = "esp32-01"
RUN = "l9-20261008-120000"
HEX_A, HEX_B = "a" * 40, "b" * 40
SHA = "c" * 64


def code_only(path: Path) -> str:
    """Source with comments and docstrings removed (python via ast; shell via comment-line removal)."""
    text = path.read_text()
    if path.suffix == ".py":
        import ast
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body and isinstance(node.body[0], ast.Expr) \
                    and isinstance(getattr(node.body[0], "value", None), ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body = node.body[1:] or [ast.Pass()]
        return ast.unparse(tree)
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("#"))


def combined(res: subprocess.CompletedProcess) -> str:
    return (res.stdout or "") + (res.stderr or "")


# ---------------------------------------------------------------------------------------------- git fixtures

L8_FIELDS = (
    "L8_LIVE=CLOSED_PASS", "L8_LIVE_EXECUTED=YES", "L8_RESULT=PASS", "L8_ATTEMPT_CONSUMED=YES", "L8_RERUN_ALLOWED=NO",
    "L8_STAGE=L8", "L8_FAILURE_RESULT=NONE", "L8_EVIDENCE_CLASS=LIVE_HARDWARE", "L9_LIVE_EXECUTED=NO", "L9_ATTEMPT_CONSUMED=NO",
)
L9_FIELDS = (
    "L9_LIVE=CLOSED_PASS", "L9_LIVE_EXECUTED=YES", "L9_RESULT=PASS", "L9_ATTEMPT_CONSUMED=YES", "L9_RERUN_ALLOWED=NO", "L9_STAGE=L9",
    "L9_EVIDENCE_CLASS=LIVE_CORE_OBSERVATION", "L9_AUTHENTICATED_STATUS_OBSERVED=YES", "L9_DEADMAN_ABSENT_OVER_WINDOW=YES",
    "L9_COMMANDS_EMITTED=0", "L9_RELAY_ACTUATION=NONE", "L9_NEGATIVE_PROBES_INJECTED_LIVE=NO", "L9_PRE_POST_PRESERVATION=PASS",
    "L9_SECRET_SCAN=PASS", "L9_FAILURE_RESULT=NONE", "L9_FINAL_CLOSEOUT_EVIDENCE_COMPLETE=YES",
)


class Repo:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        self.git("config", "commit.gpgsign", "false")
        self.n = 0

    def git(self, *args: str) -> str:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        done = subprocess.run(["git", "-C", str(self.path), *args], capture_output=True, text=True, env=env, check=False)
        assert done.returncode == 0, done.stderr
        return done.stdout.strip()

    def write(self, rel: str, text: str) -> None:
        target = self.path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, message: str = "c") -> str:
        self.n += 1
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", f"{message} {self.n}")
        return self.git("rev-parse", "HEAD")

    def receipt(self, name: str, fields, extra: str = "") -> str:
        rel = f"{LOGS_REL}/{name}"
        self.write(rel, "# receipt\n\n" + "".join(f"- `{f}`\n" for f in fields) + extra)
        return rel


def base_history(tmp_path: Path):
    """history with unrelated historical receipts, then an execution commit, then the L8 closeout (= main)."""
    repo = Repo(tmp_path / "repo")
    repo.receipt("2026-10-01_000000_music_idea3-old.md", ["L8_ACCEPTANCE=NO", "L9_PROVEN=NO", "L8P_LIVE_EXECUTED=NO"], "L8=NOT_RUN\n")
    repo.commit("base")
    execution = repo.commit("l8-execution-main")
    return repo, execution


def l8_closeout(repo: Repo, execution: str, *, name="2026-10-08_010000_music_idea3-l8-live-closeout.md", fields=L8_FIELDS, with_main=True) -> str:
    extra = [f"L8_EXECUTION_MAIN={execution}"] if with_main else []
    return repo.receipt(name, [*fields, *extra])


def valid_l8(tmp_path: Path):
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution)
    main = repo.commit("l8-closeout")
    return repo, execution, main


def run_gate(repo: Repo, command: str, main: str, *extra: str, strict: bool = False) -> subprocess.CompletedProcess:
    """CLI run. The receipt-contract layer is selected explicitly (the L8 host-provenance layer is a deliberate blocker, see below)."""
    flags = ["--receipt-contract-only"] if command == "l8-predecessor" and not strict else []
    return subprocess.run([sys.executable, "-I", str(DEPLOY / "p4-l9-gates.py"), command, "--repo", str(repo.path), "--main", main, *flags, *extra],
                          capture_output=True, text=True, check=False)


def refused(repo: Repo, main: str, reason: str, command: str = "l8-predecessor") -> None:
    res = run_gate(repo, command, main)
    assert res.returncode == 1, combined(res)
    assert "L9_GATE=PASS" not in res.stdout
    assert reason in res.stderr, combined(res)


# ---------------------------------------------------------------------------------------------- B. L8 -> L9 gate


def test_valid_l8_pass_is_allowed_and_reports_the_execution_main(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    res = run_gate(repo, "l8-predecessor", main)
    assert res.returncode == 0, combined(res)
    assert f"L8_EXECUTION_MAIN={execution}" in res.stdout and "L9_GATE=PASS" in res.stdout


def test_l8_never_executed_is_refused(tmp_path: Path) -> None:
    repo, _ = base_history(tmp_path)
    refused(repo, repo.commit("nothing"), "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")


def test_repository_only_l8_receipt_never_satisfies_the_gate(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution, fields=("L8_LIVE_EXECUTED=NO", "L8_STAGE=L8", "L8_REPOSITORY_IMPLEMENTED=YES"))
    refused(repo, repo.commit("repo-only"), "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")


def test_l8_failure_closeout_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    fail = tuple(f for f in L8_FIELDS if not f.startswith(("L8_LIVE=", "L8_RESULT=", "L8_FAILURE_RESULT="))) + ("L8_LIVE=CLOSED_FAIL", "L8_RESULT=FAIL_IMMUTABLE", "L8_FAILURE_RESULT=FAIL")
    l8_closeout(repo, execution, fields=fail)
    refused(repo, repo.commit("fail"), "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")


def test_a_failed_l8_record_next_to_a_pass_is_a_contradiction(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution)
    repo.receipt("2026-10-08_005000_music_idea3-l8-live-failure-closeout.md", ["L8_LIVE=CLOSED_FAIL", "L8_RESULT=FAIL_IMMUTABLE"])
    refused(repo, repo.commit("both"), "L8_EVIDENCE_DUPLICATED_OR_SPLIT")


def test_duplicate_l8_closeouts_are_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution)
    l8_closeout(repo, execution, name="2026-10-08_020000_music_idea3-l8-live-closeout.md")
    refused(repo, repo.commit("dup"), "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")


def test_split_l8_evidence_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution)
    repo.receipt("2026-10-08_030000_music_idea3-l8-restatement.md", ["L8_RESULT=PASS"])
    refused(repo, repo.commit("split"), "L8_EVIDENCE_DUPLICATED_OR_SPLIT")


def test_l8_closeout_with_a_missing_field_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution, fields=tuple(f for f in L8_FIELDS if not f.startswith("L8_ATTEMPT_CONSUMED")))
    refused(repo, repo.commit("incomplete"), "L8_CLOSEOUT_FIELD_INVALID:L8_ATTEMPT_CONSUMED")


def test_l8_closeout_must_use_the_canonical_receipt_name(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l8_closeout(repo, execution, name="2026-10-08_010000_music_idea3-l8-notes.md")
    refused(repo, repo.commit("misnamed"), "L8_CLOSEOUT_NOT_THE_CANONICAL_RECEIPT_NAME")


def test_fixture_evidence_class_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    fields = tuple(f for f in L8_FIELDS if not f.startswith("L8_EVIDENCE_CLASS")) + ("L8_EVIDENCE_CLASS=REPOSITORY_FIXTURE",)
    l8_closeout(repo, execution, fields=fields)
    refused(repo, repo.commit("fixture-class"), "L8_CLOSEOUT_FIELD_INVALID:L8_EVIDENCE_CLASS")


def test_l8_execution_main_not_an_ancestor_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    repo.git("checkout", "-q", "-b", "side")
    side = repo.commit("side-only")
    repo.git("checkout", "-q", "main")
    l8_closeout(repo, side)
    refused(repo, repo.commit("stale"), "L8_EXECUTION_MAIN_NOT_AN_ANCESTOR")


def test_l8_execution_main_that_is_not_a_commit_is_refused(tmp_path: Path) -> None:
    repo, _ = base_history(tmp_path)
    l8_closeout(repo, "f" * 40)
    refused(repo, repo.commit("ghost"), "L8_EXECUTION_MAIN_NOT_A_COMMIT")


def test_the_execution_main_must_be_strictly_before_the_pinned_main_and_before_its_closeout(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    path = f"{LOGS_REL}/2026-10-08_010000_music_idea3-l8-live-closeout.md"
    with pytest.raises(gates.GateError, match="L8_EXECUTION_MAIN_EQUALS_PINNED_MAIN"):
        gates._strict_ancestor(repo.path, main, main, path, "L8")
    with pytest.raises(gates.GateError, match="L8_CLOSEOUT_PREDATES_ITS_EXECUTION"):
        gates._strict_ancestor(repo.path, main, repo.commit("later"), path, "L8")
    gates._strict_ancestor(repo.path, execution, main, path, "L8")


def test_l8_closeout_edited_after_introduction_is_not_immutable(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    repo.write(f"{LOGS_REL}/2026-10-08_010000_music_idea3-l8-live-closeout.md", (repo.path / LOGS_REL / "2026-10-08_010000_music_idea3-l8-live-closeout.md").read_text() + "\nnote\n")
    refused(repo, repo.commit("edit"), "L8_CLOSEOUT_NOT_IMMUTABLE_SINGLE_COMMIT")


def test_an_l9_result_already_recorded_blocks_a_second_live_run(tmp_path: Path) -> None:
    repo, execution, _ = valid_l8(tmp_path)
    repo.receipt("2026-10-08_090000_music_idea3-l9-live-closeout.md", ["L9_LIVE=CLOSED_PASS", "L9_RESULT=PASS"])
    refused(repo, repo.commit("l9"), "L9_ALREADY_RECORDED")


def test_an_l9_positive_pre_run_field_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    fields = tuple(f for f in L8_FIELDS if not f.startswith("L9_LIVE_EXECUTED")) + ("L9_LIVE_EXECUTED=YES",)
    l8_closeout(repo, execution, fields=fields)
    refused(repo, repo.commit("l9-claim"), "L8_CLOSEOUT_FIELD_INVALID:L9_LIVE_EXECUTED")
    repo2 = Repo(tmp_path / "second")
    repo2.receipt("2026-10-01_000000_music_x.md", ["L9_ATTEMPT_CONSUMED=YES"])
    e2 = repo2.commit("x")
    l8_closeout(repo2, e2)
    refused(repo2, repo2.commit("elsewhere"), "L9_ALREADY_RECORDED:L9_ATTEMPT_CONSUMED")


def test_head_must_equal_the_pinned_main_unless_explicitly_waived(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    repo.commit("moved-on")
    refused(repo, main, "L9_HEAD_NOT_THE_PINNED_COMMIT")
    assert run_gate(repo, "l8-predecessor", main, "--no-require-head").returncode == 0


def test_malformed_or_unknown_main_is_refused(tmp_path: Path) -> None:
    repo, *_ = valid_l8(tmp_path)
    refused(repo, "abc", "L9_PINNED_COMMIT_MALFORMED")
    refused(repo, "e" * 40, "L9_PINNED_COMMIT_NOT_A_COMMIT_OBJECT")


def test_historical_unrelated_l8_and_l9_fields_do_not_block_a_valid_l8(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)  # base history already carries L8_ACCEPTANCE=NO, L9_PROVEN=NO, L8=NOT_RUN
    assert run_gate(repo, "l8-predecessor", main).returncode == 0


# ---------------------------------------------------------------------------------------------- G. final closeout gate


def l9_closeout(repo: Repo, execution: str, l8: str, *, name="2026-10-09_010000_music_idea3-l9-live-closeout.md", fields=L9_FIELDS, sha=SHA) -> str:
    return repo.receipt(name, [*fields, f"L9_EXECUTION_MAIN={execution}", f"L8_EXECUTION_MAIN={l8}", f"L9_EVIDENCE_BUNDLE_SHA256={sha}"])


def valid_final(tmp_path: Path):
    repo, l8_exec, l8_main = valid_l8(tmp_path)
    l9_exec = repo.commit("l9-execution-main")
    l9_closeout(repo, l9_exec, l8_exec)
    final = repo.commit("l9-closeout")
    return repo, l8_exec, l9_exec, final


def test_valid_final_closeout_is_accepted(tmp_path: Path) -> None:
    repo, l8_exec, l9_exec, final = valid_final(tmp_path)
    res = run_gate(repo, "final-closeout", final)
    assert res.returncode == 0, combined(res)
    assert f"L9_EXECUTION_MAIN={l9_exec}" in res.stdout and f"L8_EXECUTION_MAIN={l8_exec}" in res.stdout and f"L9_EVIDENCE_BUNDLE_SHA256={SHA}" in res.stdout


def test_final_closeout_absent_is_refused(tmp_path: Path) -> None:
    repo, *_ = valid_l8(tmp_path)
    refused(repo, repo.commit("none"), "L9_CLOSEOUT_MISSING_OR_AMBIGUOUS", "final-closeout")


def test_final_closeout_with_a_failure_record_is_refused(tmp_path: Path) -> None:
    repo, l8_exec, l9_exec, _ = valid_final(tmp_path)
    repo.receipt("2026-10-09_020000_music_idea3-l9-live-failure.md", ["L9_RESULT=FAIL_IMMUTABLE"])
    refused(repo, repo.commit("conflict"), "L9_EVIDENCE_DUPLICATED_OR_SPLIT:L9_RESULT", "final-closeout")


def test_duplicate_final_closeouts_are_refused(tmp_path: Path) -> None:
    repo, l8_exec, l9_exec, _ = valid_final(tmp_path)
    l9_closeout(repo, l9_exec, l8_exec, name="2026-10-09_030000_music_idea3-l9-live-closeout.md")
    refused(repo, repo.commit("dup"), "L9_CLOSEOUT_MISSING_OR_AMBIGUOUS", "final-closeout")


def test_final_closeout_edited_later_is_not_immutable(tmp_path: Path) -> None:
    repo, *_ = valid_final(tmp_path)
    path = repo.path / LOGS_REL / "2026-10-09_010000_music_idea3-l9-live-closeout.md"
    repo.write(f"{LOGS_REL}/2026-10-09_010000_music_idea3-l9-live-closeout.md", path.read_text() + "\nedited\n")
    refused(repo, repo.commit("edit"), "L9_CLOSEOUT_NOT_IMMUTABLE_SINGLE_COMMIT", "final-closeout")


def test_final_closeout_execution_main_must_be_a_strict_ancestor(tmp_path: Path) -> None:
    repo, l8_exec, _ = valid_l8(tmp_path)
    repo.git("checkout", "-q", "-b", "side")
    side = repo.commit("side")
    repo.git("checkout", "-q", "main")
    l9_closeout(repo, side, l8_exec)
    refused(repo, repo.commit("stale"), "L9_EXECUTION_MAIN_NOT_AN_ANCESTOR", "final-closeout")


def test_final_closeout_bound_to_a_different_l8_is_refused(tmp_path: Path) -> None:
    repo, l8_exec, l8_main = valid_l8(tmp_path)
    l9_exec = repo.commit("l9-exec")
    l9_closeout(repo, l9_exec, HEX_B)
    refused(repo, repo.commit("mismatch"), "L9_CLOSEOUT_L8_BINDING_MISMATCH", "final-closeout")


def test_final_closeout_for_an_execution_without_l8_pass_is_refused(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    l9_exec = repo.commit("l9-exec-no-l8")
    l9_closeout(repo, l9_exec, execution)
    refused(repo, repo.commit("no-l8"), "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS", "final-closeout")


@pytest.mark.parametrize("bad", ["L9_COMMANDS_EMITTED=1", "L9_RELAY_ACTUATION=CUT", "L9_NEGATIVE_PROBES_INJECTED_LIVE=YES", "L9_EVIDENCE_CLASS=REPOSITORY_FIXTURE",
                                 "L9_RERUN_ALLOWED=YES", "L9_FAILURE_RESULT=FAIL"])
def test_final_closeout_with_a_contradictory_value_is_refused(tmp_path: Path, bad: str) -> None:
    repo, l8_exec, _ = valid_l8(tmp_path)
    l9_exec = repo.commit("l9-exec")
    key = bad.split("=")[0]
    l9_closeout(repo, l9_exec, l8_exec, fields=tuple(f for f in L9_FIELDS if not f.startswith(key + "=")) + (bad,))
    refused(repo, repo.commit("bad"), f"L9_CLOSEOUT_FIELD_INVALID:{key}", "final-closeout")


def test_final_closeout_requires_a_valid_bundle_digest(tmp_path: Path) -> None:
    repo, l8_exec, _ = valid_l8(tmp_path)
    l9_exec = repo.commit("l9-exec")
    l9_closeout(repo, l9_exec, l8_exec, sha="xyz")
    refused(repo, repo.commit("bad-sha"), "L9_CLOSEOUT_FIELD_INVALID:L9_EVIDENCE_BUNDLE_SHA256", "final-closeout")



# ---------------------------------------------------------------------------------------------- I. L8 interface isolation / host provenance blocker


def test_the_l8_host_provenance_layer_is_a_deliberate_blocker_for_every_live_capable_caller(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    assert gates.L8_HOST_PROVENANCE_IMPLEMENTED is False
    res = run_gate(repo, "l8-predecessor", main, strict=True)
    assert res.returncode == 1 and "L8_HOST_PROVENANCE_REQUIRED" in res.stderr and "L9_GATE=PASS" not in res.stdout
    with pytest.raises(gates.GateError, match="L8_HOST_PROVENANCE_REQUIRED"):
        gates.l8_predecessor_gate(repo.path, main)  # the default is the strict, LIVE-capable mode
    assert gates.l8_predecessor_gate(repo.path, main, require_host_provenance=False)["L8_EXECUTION_MAIN"] == execution


def test_flipping_the_flag_alone_does_not_open_the_blocker(tmp_path: Path, monkeypatch) -> None:
    repo, execution, main = valid_l8(tmp_path)
    monkeypatch.setattr(gates, "L8_HOST_PROVENANCE_IMPLEMENTED", True)
    with pytest.raises(gates.GateError, match="L8_HOST_PROVENANCE_REQUIRED"):
        gates.l8_predecessor_gate(repo.path, main)


def test_the_final_closeout_history_gate_uses_only_the_receipt_contract_layer(tmp_path: Path) -> None:
    repo, l8_exec, l9_exec, final = valid_final(tmp_path)
    assert run_gate(repo, "final-closeout", final).returncode == 0  # pure Git history: the host is not readable forever


def test_l8_predecessor_parsing_is_one_function_the_wiring_point_for_the_host_closeout() -> None:
    src = (DEPLOY / "p4-l9-gates.py").read_text()
    assert src.count("def l8_predecessor_gate(") == 1 and src.count("def l8_host_provenance(") == 1
    assert "L8_HOST_PROVENANCE_REQUIRED" in src


# ---------------------------------------------------------------------------------------------- F. Git hardening of the gate


def test_git_replacement_objects_cannot_forge_the_l8_receipt(tmp_path: Path) -> None:
    repo, execution = base_history(tmp_path)
    rel = l8_closeout(repo, execution, fields=("L8_LIVE_EXECUTED=NO", "L8_STAGE=L8"))  # an INVALID (repository-only) receipt
    main = repo.commit("invalid")
    refused(repo, main, "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")
    bad_blob = repo.git("rev-parse", f"{main}:{rel}")
    forged = repo.path / "forged.md"
    forged.write_text("# receipt\n\n" + "".join(f"- `{f}`\n" for f in L8_FIELDS) + f"- `L8_EXECUTION_MAIN={execution}`\n")
    good_blob = repo.git("hash-object", "-w", str(forged))
    repo.git("replace", bad_blob, good_blob)
    plain = subprocess.run(["git", "-C", str(repo.path), "show", f"{main}:{rel}"], capture_output=True, text=True).stdout
    assert "L8_RESULT=PASS" in plain  # plain Git now shows the forged bytes ...
    refused(repo, main, "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS")  # ... the gate does not
    refused(repo, main, "L8_CLOSEOUT_MISSING_OR_AMBIGUOUS", "l8-predecessor")


def test_inherited_git_environment_cannot_redirect_the_gate(tmp_path: Path, monkeypatch) -> None:
    repo, execution, main = valid_l8(tmp_path)
    other = Repo(tmp_path / "other")
    other.commit("empty")
    monkeypatch.setenv("GIT_DIR", str(other.path / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(other.path))
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "touch " + str(tmp_path / "pwned"))
    assert run_gate(repo, "l8-predecessor", main).returncode == 0
    assert not (tmp_path / "pwned").exists()


def test_repository_local_config_cannot_execute_a_program_through_the_gate(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    marker = tmp_path / "executed"
    repo.git("config", "core.fsmonitor", f"touch {marker}")
    repo.git("config", "core.pager", f"touch {marker}")
    assert run_gate(repo, "l8-predecessor", main).returncode == 0
    assert not marker.exists()


def test_the_gate_runs_under_python_isolation_and_ignores_pythonpath(tmp_path: Path) -> None:
    repo, execution, main = valid_l8(tmp_path)
    evil = tmp_path / "evil"
    evil.mkdir()
    sentinel = tmp_path / "sentinel"
    (evil / "subprocess.py").write_text(f"open({str(sentinel)!r}, 'w').write('x')\nraise SystemExit(99)\n")
    env = {**os.environ, "PYTHONPATH": str(evil)}
    done = subprocess.run([sys.executable, "-I", str(DEPLOY / "p4-l9-gates.py"), "l8-predecessor", "--repo", str(repo.path), "--main", main, "--receipt-contract-only"],
                          capture_output=True, text=True, env=env, check=False)
    assert done.returncode == 0 and not sentinel.exists()
    plain = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-gates.py"), "l8-predecessor", "--repo", str(repo.path), "--main", main, "--receipt-contract-only"],
                           capture_output=True, text=True, env=env, check=False)
    assert plain.returncode != 0 and sentinel.exists()  # control: without -I the injection WOULD have run


# ---------------------------------------------------------------------------------------------- A. contract / registration


def test_p4_registry_is_unchanged_and_l9_stays_last_after_l8() -> None:
    text = (DEPLOY / "p4-lib.sh").read_text()
    assert re.search(r'readonly P4_STAGES="[^"]* Recovery L8 L9"', text)
    assert "L9) echo none ;;" in text


def test_the_template_for_the_final_closeout_receipt_matches_the_gate_contract() -> None:
    template = (DEPLOY / "templates" / "l9-live-closeout-receipt.template.md").read_text()
    fields = {m.group(1): m.group(2) for line in template.splitlines() if (m := re.match(r"^- `([A-Z][A-Z0-9_]*)=([^`]+)`$", line))}
    for key, value in gates.L9_CONTRACT.items():
        assert fields.get(key) == value, key
    for key in gates.L9_GRAMMAR:
        assert key in fields and fields[key].startswith("<"), key
    assert "NOT A RECEIPT" in template and "never commit this file under 90-status/logs" in template.lower()
    assert "L9_LIVE_EXECUTED=YES" in template


def test_the_l8_contract_documented_for_the_l8_work_matches_the_gate() -> None:
    doc = (ROOT / "docs" / "superpowers" / "specs" / "2026-10-07-idea3-pr11-phase4-l9-live-successor-design.md").read_text()
    for key, value in gates.L8_CONTRACT.items():
        assert f"`{key}={value}`" in doc, key
    for key in (*gates.L8_GRAMMAR, *gates.PRE_L9_FIELDS):
        assert f"`{key}=" in doc, key
    for claim in ("LIVE_CORE_OBSERVATION", "NO_DEADMAN_OVER_WINDOW", "REPOSITORY_FIXTURE_ONLY"):
        assert claim in doc


def test_the_new_sources_carry_no_private_key_material() -> None:
    for path in (*DEPLOY.glob("p4-l9-*"), RUNNER, *L9_STAGE.glob("*")):
        assert not re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY", path.read_text()), path
