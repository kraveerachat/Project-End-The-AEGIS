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


def run_gate(repo: Repo, command: str, main: str, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(DEPLOY / "p4-l9-gates.py"), command, "--repo", str(repo.path), "--main", main, *extra],
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


# ---------------------------------------------------------------------------------------------- observer fixtures


def systemd(pid="100", inv="a" * 32, nrestarts="0", active="active", sub="running", result="success"):
    return {"ActiveState": active, "SubState": sub, "MainPID": pid, "NRestarts": nrestarts, "InvocationID": inv, "Result": result}


class World:
    """Fake Core sources (implements the observer's Sources interface). Every field is editable per test."""

    def __init__(self, device=DEVICE):
        self.device = device
        self.core = systemd("100", "a" * 32)
        self.detector = systemd("200", "b" * 32)
        self.doc = {"pid": 100, "updated_at": 1000.0, "state": "NORMAL", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL"}
        self.m = {"protocol_seen_rowid": 10, "command_rows": 0, "last_allocated_seq": 0, "audit_id": 50, "open_incidents": 0, "open_episodes": 0}
        self.rows: list[tuple[int, float]] = []
        self.audit: list[tuple[int, str, str]] = []

    def systemd(self, unit):
        return dict(self.core if unit == observe.CORE_UNIT else self.detector)

    def status(self, core_pid):
        return dict(self.doc)

    def metrics(self, device_id):
        return dict(self.m)

    def status_rows(self, device_id, after, until):
        return [(i, t) for i, t in self.rows if i > after and (until is None or i <= until)]

    def audit_rows(self, after, until):
        return [r for r in self.audit if r[0] > after and (until is None or r[0] <= until)]


def add_periodic(w: World, start: float, count=5, gap=30.0, state="NORMAL", reason="PERIODIC"):
    for i in range(count):
        w.m["protocol_seen_rowid"] += 1
        w.m["audit_id"] += 1
        w.rows.append((w.m["protocol_seen_rowid"], start + gap * (i + 1)))
        w.audit.append((w.m["audit_id"], "DEVICE_STATUS", f"{state} ({reason})"))


def marker_text(boundary: dict[str, str], device=DEVICE, consumed="YES", rerun="NO") -> str:
    return f"L9_ATTEMPT_CONSUMED={consumed}\nL9_RERUN_ALLOWED={rerun}\nL9_DEVICE_ID={device}\nL9_RUN_ID={RUN}\nwork=/x\n" + "".join(f"{k}={v}\n" for k, v in boundary.items())


def pre_boundary(w: World, now=1000.0) -> dict[str, str]:
    return observe.boundary_from_snapshot(observe.snapshot(w, w.device, now))


class Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def run_observe(w: World, boundary: dict[str, str], *, window=120, start=1000.0, finish_state=None):
    clock = Clock(start)
    return observe.observe(w, marker_text(boundary), w.device, RUN, window, clock=clock, sleep=clock.sleep), w


def good_world():
    w = World()
    b = pre_boundary(w)
    add_periodic(w, 1000.0, 5, 30.0)
    w.doc["updated_at"] = 1130.0
    return w, b


# ---------------------------------------------------------------------------------------------- H. observer: positive path


def test_live_observation_passes_on_authenticated_periodic_status_with_no_actuation() -> None:
    w, b = good_world()
    data, _ = run_observe(w, b)
    assert data["result"] == "PASS", data["failure_boundary"]
    assert data["evidence_class"] == "LIVE_CORE_OBSERVATION" and data["evidence_class"] != "REPOSITORY_FIXTURE"
    assert data["periodic_rows_observed"] == 5 and data["status_rows_observed"] == 5
    assert data["commands_emitted"] == 0 and data["relay_actuation"] == "NONE" and data["deadman_rows_observed"] == 0
    assert data["negative_probes_injected_live"] == "NO" and data["negative_probe_coverage"] == "REPOSITORY_FIXTURE_ONLY"
    assert data["heartbeat_acceptance_basis"] == "NO_DEADMAN_OVER_WINDOW"
    assert set(data) == set(observe.EVIDENCE_FIELDS)


def test_evidence_bundle_is_exact_write_once_and_private(tmp_path: Path) -> None:
    w, b = good_world()
    data, _ = run_observe(w, b)
    path = tmp_path / observe.EVIDENCE_NAME
    observe.write_evidence(path, data)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with pytest.raises(observe.ObserveError, match="EVIDENCE_NOT_WRITABLE"):
        observe.write_evidence(path, data)
    link = tmp_path / "link.json"
    link.symlink_to(path)
    with pytest.raises(observe.ObserveError, match="EVIDENCE_NOT_WRITABLE"):
        observe.write_evidence(link, data)
    with pytest.raises(observe.ObserveError, match="FIELD_SET"):
        observe.write_evidence(tmp_path / "x.json", {**data, "extra": 1})
    raw = path.read_text()
    for secret in ("msg_id", "key", "mac", "password", "token"):
        assert secret not in raw.lower().replace("negative_probe", "").replace("heartbeat_acceptance", "")


# ---------------------------------------------------------------------------------------------- H. observer: every invariant fails closed

MUTATIONS = {
    "CORE_NOT_ACTIVE_RUNNING": lambda w: w.core.update(ActiveState="failed"),
    "CORE_PID_CHANGED": lambda w: (w.core.update(MainPID="101"), w.doc.update(pid=101)),
    "CORE_RESTARTED": lambda w: w.core.update(NRestarts="1"),
    "DETECTOR_NOT_ACTIVE_RUNNING": lambda w: w.detector.update(SubState="dead"),
    "DETECTOR_CHANGED": lambda w: w.detector.update(InvocationID="d" * 32),
    "CORE_STATUS_PID_MISMATCH": lambda w: w.doc.update(pid=999),
    "CORE_STATUS_NOT_REFRESHED": lambda w: w.doc.update(updated_at=1000.0),
    "TIME_TRUST_NOT_SYNCED": lambda w: w.doc.update(time_trust="HOLDOVER"),
    "BROKER_NOT_CONNECTED": lambda w: w.doc.update(broker="DISCONNECTED"),
    "DEVICE_NOT_ONLINE": lambda w: w.doc.update(device="OFFLINE"),
    "UPLINK_CHANGED": lambda w: w.doc.update(uplink="LOCKDOWN"),
    "COMMAND_ISSUED": lambda w: w.m.update(command_rows=1),
    "INCIDENT_STATE_CHANGED": lambda w: w.m.update(open_incidents=1),
}


@pytest.mark.parametrize("failure", sorted(MUTATIONS))
def test_every_core_and_state_invariant_fails_closed(failure: str) -> None:
    w, b = good_world()
    MUTATIONS[failure](w)
    data, _ = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] == failure


def test_a_deadman_status_fails_closed() -> None:
    w, b = good_world()
    add_periodic(w, 1130.0, 1, reason="DEADMAN")
    assert run_observe(w, b)[0]["failure_boundary"] == "DEADMAN_OBSERVED"


@pytest.mark.parametrize("reason,boundary", [("BOOT", "DEVICE_REBOOTED_DURING_OBSERVATION"), ("BOOT_GRACE", "DEVICE_REBOOTED_DURING_OBSERVATION"),
                                             ("COMMAND", "UNEXPECTED_STATUS_REASON"), ("SEQUENCE_REJECTED", "UNEXPECTED_STATUS_REASON")])
def test_reboot_and_command_reasons_fail_closed(reason: str, boundary: str) -> None:
    w, b = good_world()
    add_periodic(w, 1130.0, 1, reason=reason)
    assert run_observe(w, b)[0]["failure_boundary"] == boundary


def test_too_few_periodic_rows_fail_closed_after_the_bounded_wait() -> None:
    w = World()
    b = pre_boundary(w)
    add_periodic(w, 1000.0, 2, 30.0)
    w.doc["updated_at"] = 1130.0
    assert run_observe(w, b)[0]["failure_boundary"] == "PERIODIC_ROWS_INSUFFICIENT"


def test_a_status_gap_larger_than_the_cadence_fails_closed() -> None:
    w = World()
    b = pre_boundary(w)
    add_periodic(w, 1000.0, 5, 50.0)
    w.doc["updated_at"] = 1130.0
    assert run_observe(w, b, window=300)[0]["failure_boundary"] == "STATUS_GAP_TOO_LARGE"


def test_the_window_cannot_be_shortened_below_two_deadman_periods() -> None:
    w, b = good_world()
    with pytest.raises(observe.ObserveError, match="WINDOW_OUT_OF_BOUNDS"):
        run_observe(w, b, window=119)
    with pytest.raises(observe.ObserveError, match="WINDOW_OUT_OF_BOUNDS"):
        run_observe(w, b, window=901)


def test_status_rows_without_matching_authenticated_rows_fail_closed() -> None:
    w, b = good_world()
    w.rows = w.rows[:1]  # the audit says five accepted statuses; the durable replay table has one
    assert run_observe(w, b)[0]["failure_boundary"] in {"PERIODIC_ROWS_INSUFFICIENT", "AUTHENTICATED_ROWS_MISSING"}


def test_mixed_or_changed_output_state_fails_closed() -> None:
    w, b = good_world()
    add_periodic(w, 1130.0, 1, state="LOCKDOWN")
    assert run_observe(w, b)[0]["failure_boundary"] in {"OUTPUT_STATE_CHANGED", "UPLINK_CHANGED"}


def test_unparseable_audit_status_fails_closed() -> None:
    w, b = good_world()
    w.m["audit_id"] += 1
    w.audit.append((w.m["audit_id"], "DEVICE_STATUS", "garbage"))
    assert run_observe(w, b)[0]["failure_boundary"] == "AUDIT_STATUS_UNPARSEABLE"


def test_a_command_sent_audit_row_fails_closed_even_if_the_store_looks_clean() -> None:
    w, b = good_world()
    w.m["audit_id"] += 1
    w.audit.append((w.m["audit_id"], "COMMAND_SENT", "x"))
    assert run_observe(w, b)[0]["failure_boundary"] == "COMMAND_ISSUED"


def test_a_moved_sequence_allocator_fails_closed() -> None:
    w, b = good_world()
    w.m["last_allocated_seq"] = 3
    assert run_observe(w, b)[0]["failure_boundary"] == "COMMAND_ISSUED"


def test_correlation_anomalies_fail_closed() -> None:
    w, b = good_world()
    w.m["audit_id"] += 1
    w.audit.append((w.m["audit_id"], "P1_SEQUENCE_RESYNC", "x"))
    assert run_observe(w, b)[0]["failure_boundary"] == "STATUS_CORRELATION_ANOMALY"


@pytest.mark.parametrize("text,reason", [("L9_ATTEMPT_CONSUMED=NO\n", "MARKER_NOT_CONSUMED"), ("garbage\n", "MARKER_NOT_CONSUMED")])
def test_an_unconsumed_or_foreign_marker_is_refused(text: str, reason: str) -> None:
    with pytest.raises(observe.ObserveError, match=reason):
        observe.parse_marker(text, DEVICE)


def test_marker_device_and_rerun_and_boundary_are_bound() -> None:
    w, b = good_world()
    pre = pre_boundary(World())
    with pytest.raises(observe.ObserveError, match="MARKER_DEVICE_MISMATCH"):
        observe.parse_marker(marker_text(pre, device="other-device"), DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_CONSUMED"):
        observe.parse_marker(marker_text(pre, rerun="YES"), DEVICE)
    partial = dict(pre)
    partial.pop("L9_PRE_AUDIT_ID")
    with pytest.raises(observe.ObserveError, match="MARKER_BOUNDARY_INCOMPLETE"):
        observe.parse_marker(marker_text(partial), DEVICE)
    with pytest.raises(observe.ObserveError, match="MARKER_DUPLICATE_KEY"):
        observe.parse_marker(marker_text(pre) + "L9_PRE_AUDIT_ID=1\n", DEVICE)


# ---------------------------------------------------------------------------------------------- H. observer: verify + reconciliation


def good_bundle(tmp_path: Path):
    w, b = good_world()
    data, s = run_observe(w, b)
    path = tmp_path / observe.EVIDENCE_NAME
    observe.write_evidence(path, data)
    return path, data, s


def test_verify_accepts_a_good_bundle_and_reconciles_with_the_core_rows(tmp_path: Path) -> None:
    path, _, s = good_bundle(tmp_path)
    assert observe.verify_evidence(path, s)["result"] == "PASS"
    assert observe.verify_evidence(path)["result"] == "PASS"


def rewrite(path: Path, **changes) -> None:
    data = json.loads(path.read_text())
    data.update(changes)
    path.chmod(0o644)
    path.write_text(json.dumps(data))
    path.chmod(0o600)


@pytest.mark.parametrize("field,value", [
    ("result", "FAIL"), ("failure_boundary", "X"), ("evidence_class", "REPOSITORY_FIXTURE"), ("commands_emitted", 1), ("cut_emitted", 1),
    ("restore_emitted", 1), ("relay_actuation", "CUT"), ("deadman_rows_observed", 1), ("boot_rows_observed", 1), ("periodic_rows_observed", 2),
    ("observation_window_seconds", 90), ("max_status_gap_seconds", 90), ("core_pid_unchanged", False), ("core_time_trust", "UNTRUSTED"),
    ("negative_probes_injected_live", "YES"), ("negative_probe_coverage", "LIVE"), ("output_state_changed", True), ("device_id", "BAD ID"),
    ("heartbeat_acceptance_basis", "CAPTURED_ACK"), ("status_rows_observed", 99),
])
def test_verify_recomputes_the_pass_criteria_and_rejects_a_forged_bundle(tmp_path: Path, field: str, value) -> None:
    path, _, s = good_bundle(tmp_path)
    rewrite(path, **{field: value})
    with pytest.raises(observe.ObserveError):
        observe.verify_evidence(path, s)


def test_verify_rejects_extra_missing_loose_symlinked_and_non_json_bundles(tmp_path: Path) -> None:
    path, data, s = good_bundle(tmp_path)
    rewrite(path, extra_field="x")
    with pytest.raises(observe.ObserveError, match="FIELD_SET"):
        observe.verify_evidence(path, s)
    path.chmod(0o644)
    path.write_text("not json")
    path.chmod(0o600)
    with pytest.raises(observe.ObserveError, match="NOT_JSON"):
        observe.verify_evidence(path, s)
    path.chmod(0o644)
    with pytest.raises(observe.ObserveError, match="MODE_NOT_0600"):
        observe.verify_evidence(path, s)
    with pytest.raises(observe.ObserveError, match="MISSING_OR_SYMLINK"):
        observe.verify_evidence(tmp_path / "absent.json", s)
    link = tmp_path / "l.json"
    link.symlink_to(path)
    with pytest.raises(observe.ObserveError, match="MISSING_OR_SYMLINK"):
        observe.verify_evidence(link, s)


def test_verify_reconciliation_catches_rows_that_the_core_does_not_have(tmp_path: Path) -> None:
    path, data, s = good_bundle(tmp_path)
    s.rows = s.rows[:3]
    with pytest.raises(observe.ObserveError, match="RECONCILIATION_STATUS_ROWS_MISMATCH"):
        observe.verify_evidence(path, s)


def test_verify_reconciliation_catches_a_command_audit_row_inside_the_window(tmp_path: Path) -> None:
    path, data, s = good_bundle(tmp_path)
    s.audit.append((data["until_audit_id"], "COMMAND_SENT", "x"))
    with pytest.raises(observe.ObserveError, match="RECONCILIATION"):
        observe.verify_evidence(path, s)


def test_a_fixture_bundle_cannot_impersonate_a_live_bundle(tmp_path: Path) -> None:
    fixture = tmp_path / "in"
    fixture.mkdir()
    for name, text in (("k_c2d", "0123456789abcdef" * 4), ("k_d2c", "fedcba9876543210" * 4)):
        (fixture / name).write_text(text + "\n")
        (fixture / name).chmod(0o600)
    ev = tmp_path / "ev"
    work = tmp_path / "work"
    res = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-auth.py"), "exercise", "--input-dir", str(fixture), "--work-dir", str(work), "--evidence-dir", str(ev),
                          "--backend", "fixture", "--device-id", "aegis-relay-01", "--run-id", "fixture-l9-run-001", "--fixture-now", str(p1.TIME_FLOOR + 1_000_000)],
                         capture_output=True, text=True, check=False)
    assert res.returncode == 0, combined(res)
    fixture_bundle = ev / "l9-auth-evidence.json"
    assert json.loads(fixture_bundle.read_text())["evidence_class"] == "REPOSITORY_FIXTURE"
    renamed = tmp_path / "l9-live-evidence.json"
    renamed.write_bytes(fixture_bundle.read_bytes())
    renamed.chmod(0o600)
    with pytest.raises(observe.ObserveError):
        observe.verify_evidence(renamed)
    # and a live bundle cannot pass the fixture verifier either
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    live_path, _, _ = good_bundle(live_dir)
    ev2 = tmp_path / "ev2"
    ev2.mkdir()
    (ev2 / "l9-auth-evidence.json").write_bytes(live_path.read_bytes())
    (ev2 / "l9-auth-evidence.json").chmod(0o600)
    ver = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-auth.py"), "verify", "--evidence-dir", str(ev2)], capture_output=True, text=True, check=False)
    assert ver.returncode != 0 and "allowlist" in combined(ver)


# ---------------------------------------------------------------------------------------------- C. no caller-provided success, no actuation surface


def test_the_live_observer_cli_has_no_override_or_success_flags() -> None:
    res = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-live-observe.py"), "observe", "--help"], capture_output=True, text=True, check=False)
    flags = set(re.findall(r"--[a-z-]+", res.stdout)) - {"--help"}
    assert flags == {"--marker", "--evidence-dir", "--device-id", "--run-id", "--window-seconds"}
    verify_help = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-live-observe.py"), "verify", "--help"], capture_output=True, text=True, check=False)
    assert set(re.findall(r"--[a-z-]+", verify_help.stdout)) - {"--help"} == {"--evidence-dir"}


def test_the_live_observer_source_is_read_only() -> None:
    text = code_only(DEPLOY / "p4-l9-live-observe.py")
    for forbidden in ("socket", "paho", "mqtt", "publish", "serial", "esptool", "reserve_command", "send_command", "local_restore", "protocol_v1", "p1.encode",
                      "urandom", "token_bytes", "token_hex", "openssl", "INSERT ", "UPDATE ", "DELETE ", "DROP ", "CREATE ", "ALTER ", "1883", "setLockdown"):
        assert forbidden not in text, forbidden
    assert re.findall(r"'(start|stop|restart|kill|mask|enable|disable|reload|daemon-reload|reset-failed)'", text) == []
    assert text.count("'show'") == 1 and "mode=ro" in text and "query_only" in text.replace(" ", "")
    assert "SYSTEMCTL = '/usr/bin/systemctl'" in text


def test_the_marker_must_be_the_canonical_root_owned_private_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(observe.SEAM_ENABLED, "YES")
    monkeypatch.setenv(observe.SEAM_DIR, str(tmp_path))
    monkeypatch.setattr(observe, "_initial_user_namespace", lambda: False)
    marker = tmp_path / observe.MARKER_NAME
    other = tmp_path / "other"
    other.write_text("x")
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_THE_CANONICAL_PATH"):
        observe.check_marker_file(other)
    with pytest.raises(observe.ObserveError, match="MARKER_MISSING"):
        observe.check_marker_file(marker)
    marker.write_text("x")
    marker.chmod(0o666)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_ROOT_OWNED_PRIVATE"):
        observe.check_marker_file(marker)
    marker.chmod(0o600)
    observe.check_marker_file(marker)
    marker.unlink()
    marker.symlink_to(other)
    with pytest.raises(observe.ObserveError, match="MARKER_NOT_A_REGULAR_FILE"):
        observe.check_marker_file(marker)


def test_the_marker_test_seam_is_refused_in_the_real_root_namespace(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv(observe.SEAM_ENABLED, "YES")
    monkeypatch.setenv(observe.SEAM_DIR, str(tmp_path))
    monkeypatch.setattr(observe, "_initial_user_namespace", lambda: True)
    with pytest.raises(observe.ObserveError, match="REFUSED_IN_THE_REAL_ROOT_NAMESPACE"):
        observe.check_marker_file(tmp_path / observe.MARKER_NAME)
    monkeypatch.delenv(observe.SEAM_DIR)
    with pytest.raises(observe.ObserveError, match="TEST_SEAM_INCOMPLETE"):
        observe.check_marker_file(tmp_path / observe.MARKER_NAME)


def test_the_live_observer_cli_refuses_a_non_canonical_marker_before_reading_anything(tmp_path: Path) -> None:
    marker = tmp_path / "marker"
    marker.write_text("L9_ATTEMPT_CONSUMED=YES\n")
    ev = tmp_path / "ev"
    ev.mkdir()
    res = subprocess.run([sys.executable, str(DEPLOY / "p4-l9-live-observe.py"), "observe", "--marker", str(marker), "--evidence-dir", str(ev), "--device-id", DEVICE,
                          "--run-id", RUN, "--window-seconds", "120"], capture_output=True, text=True, check=False)
    assert res.returncode == 1 and "MARKER_NOT_THE_CANONICAL_PATH" in res.stderr
    assert list(ev.iterdir()) == []


# ---------------------------------------------------------------------------------------------- stage handlers (live branch)


def stage_env(tmp_path: Path, **over) -> dict[str, str]:
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "AEGIS_L9_WORK_DIR": str(tmp_path / "work"), "AEGIS_L9_EVIDENCE_DIR": str(tmp_path / "evidence"),
           "AEGIS_L9_DEVICE_ID": DEVICE, "AEGIS_L9_RUN_ID": RUN, "AEGIS_L9_WINDOW_SECONDS": "120", "AEGIS_L9_MARKER": str(tmp_path / "marker"),
           "AEGIS_L9_BACKEND": "live", "AEGIS_L9_LIVE_AUTHORIZED": "YES"}
    for key, value in over.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def run_stage(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(L9_STAGE / script)], env=env, capture_output=True, text=True, timeout=60, check=False)


def test_live_apply_requires_the_explicit_live_authorization(tmp_path: Path) -> None:
    for value in (None, "NO", "yes", ""):
        res = run_stage("apply.sh", stage_env(tmp_path, AEGIS_L9_LIVE_AUTHORIZED=value))
        assert res.returncode != 0 and "LIVE_L9_NOT_AUTHORIZED" in combined(res)
    assert not (tmp_path / "evidence").exists()


def test_live_apply_refuses_fixture_inputs_and_missing_live_inputs(tmp_path: Path) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path, AEGIS_L9_INPUT_DIR=str(tmp_path)))
    assert res.returncode != 0 and "LIVE_L9_FIXTURE_INPUT_COMBINATION_REFUSED" in combined(res)
    res = run_stage("apply.sh", stage_env(tmp_path, AEGIS_L9_FIXTURE_NOW="1700000001"))
    assert res.returncode != 0 and "LIVE_L9_FIXTURE_INPUT_COMBINATION_REFUSED" in combined(res)
    for var in ("AEGIS_L9_WORK_DIR", "AEGIS_L9_EVIDENCE_DIR", "AEGIS_L9_DEVICE_ID", "AEGIS_L9_RUN_ID", "AEGIS_L9_WINDOW_SECONDS", "AEGIS_L9_MARKER"):
        res = run_stage("apply.sh", stage_env(tmp_path, **{var: None}))
        assert res.returncode != 0 and var in combined(res)


@pytest.mark.parametrize("var,value", [("AEGIS_L9_DEVICE_ID", "BAD ID"), ("AEGIS_L9_WINDOW_SECONDS", "12"), ("AEGIS_L9_WINDOW_SECONDS", "abc"),
                                       ("AEGIS_L9_EVIDENCE_DIR", "/run/aegis-idea3/ev"), ("AEGIS_L9_EVIDENCE_DIR", "/etc/ev")])
def test_live_apply_refuses_malformed_inputs(tmp_path: Path, var: str, value: str) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path, **{var: value}))
    assert res.returncode != 0 and "L9_APPLY=FAIL" in combined(res)


def test_live_apply_without_the_canonical_marker_writes_no_evidence_and_never_reaches_the_fixture_path(tmp_path: Path) -> None:
    res = run_stage("apply.sh", stage_env(tmp_path))
    assert res.returncode != 0 and "live observation failed" in combined(res) and "MARKER_NOT_THE_CANONICAL_PATH" in combined(res)
    assert not list((tmp_path / "evidence").glob("*.json")) and not (tmp_path / "work" / "fixture-protocol.sqlite3").exists()
    assert "L9_APPLY=COMPLETE" not in res.stdout


def test_a_live_run_never_emits_a_command_marker_in_its_success_output() -> None:
    text = (L9_STAGE / "apply.sh").read_text()
    live = text[text.index("# 0. Live backend"):text.index("# 1. Mandatory environment")]
    assert "L9_COMMAND_SENT=NONE" in live and "L9_LIVE_OBSERVATION=COMPLETE" in live
    assert "p4-l9-auth.py" not in live and "k_c2d" not in live and "k_d2c" not in live


def test_live_verify_fails_closed_without_exactly_one_correctly_named_live_bundle(tmp_path: Path) -> None:
    env = stage_env(tmp_path)
    (tmp_path / "evidence").mkdir()
    assert run_stage("verify.sh", env).returncode != 0
    live = tmp_path / "evidence" / "l9-live-evidence.json"
    live.write_text("{}")
    live.chmod(0o600)
    res = run_stage("verify.sh", env)  # content/DB cannot verify in the test environment: it must fail closed, not pass
    assert res.returncode != 0 and "L9_VERIFY=PASS" not in res.stdout
    fixture_named = tmp_path / "evidence" / "l9-auth-evidence.json"
    fixture_named.write_text("{}")
    assert "expected exactly one evidence bundle" in combined(run_stage("verify.sh", env))
    live.unlink()
    assert "live evidence bundle missing" in combined(run_stage("verify.sh", env))


def test_fixture_verify_still_refuses_a_live_named_bundle(tmp_path: Path) -> None:
    env = stage_env(tmp_path, AEGIS_L9_BACKEND=None, AEGIS_L9_LIVE_AUTHORIZED=None)
    (tmp_path / "evidence").mkdir()
    live = tmp_path / "evidence" / "l9-live-evidence.json"
    live.write_text("{}")
    live.chmod(0o600)
    res = run_stage("verify.sh", env)
    assert res.returncode != 0 and "unexpected bundle filename" in combined(res)


def test_live_rollback_is_a_no_op_that_preserves_evidence_and_never_stops_the_core(tmp_path: Path) -> None:
    (tmp_path / "evidence").mkdir()
    (tmp_path / "work").mkdir()
    (tmp_path / "evidence" / "l9-live-evidence.json").write_text("{}")
    res = run_stage("rollback.sh", stage_env(tmp_path))
    assert res.returncode == 0
    for marker in ("L9_CORE_ACTION_TAKEN=NONE", "L9_DEVICE_ACTION_TAKEN=NONE", "L9_COMMAND_SENT=NONE", "L9_EVIDENCE_PRESERVED=YES",
                   "L9_LIVE_OBSERVATION_MUTATED_NOTHING=YES", "L9_ROLLBACK=COMPLETE"):
        assert marker in res.stdout
    assert (tmp_path / "evidence" / "l9-live-evidence.json").is_file()


def test_the_stage_still_has_zero_host_drift_allowances() -> None:
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        assert [l for l in (L9_STAGE / name).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")] == []


def test_the_stage_gate_still_never_authorizes_live_and_reports_the_registered_handler(tmp_path: Path) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")
    auth = tmp_path / "a"
    auth.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L9\ndate={today}\nauthorizer=music\nscope=test only\nreference=https://example.invalid/a1\n")
    k3 = tmp_path / "k"
    k3.write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L9\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=https://example.invalid/k1\n")
    res = subprocess.run(["bash", str(DEPLOY / "p4-stage-gate.sh"), "--stage", "L9", "--mode", "live", "--authorization", str(auth), "--k3", str(k3)], capture_output=True, text=True, check=False)
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout and "K3_CONFIRMATION=VALID" in res.stdout and "ROLLBACK_HANDLER=REGISTERED" in res.stdout
    assert "LIVE_STAGE_AUTHORIZED=NO" in res.stdout


# ---------------------------------------------------------------------------------------------- owner-run lib (bash, SUDO empty, guarded seams)


def lib(tmp_path: Path, body: str, **env) -> subprocess.CompletedProcess:
    canonical = tmp_path / "gov"
    full = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "SUDO": "", "AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES", "AEGIS_L9_TEST_ONLY_CANONICAL_DIR": str(canonical),
            "AEGIS_L9_TEST_ONLY_TRUST_ROOT": str(tmp_path), "AEGIS_L9_TEST_ONLY_BOUNDARY": "L9_PRE_TIME=1.0", **env}
    return subprocess.run(["bash", "-c", f'set -e; . "{RUN_LIB}"; {body}'], env=full, capture_output=True, text=True, timeout=60, check=False)


def test_marker_consumption_is_exclusive_and_blocks_a_second_attempt(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    first = lib(tmp_path, f'l9_consume_attempt "{tmp_path}/work" {DEVICE} {RUN} /bin/true && echo CONSUMED')
    assert first.returncode == 0 and "CONSUMED" in first.stdout, combined(first)
    marker = tmp_path / "gov" / "L9-GLOBAL-ATTEMPT-CONSUMED"
    text = marker.read_text()
    assert "L9_ATTEMPT_CONSUMED=YES" in text and "L9_RERUN_ALLOWED=NO" in text and f"L9_DEVICE_ID={DEVICE}" in text and "L9_PRE_TIME=1.0" in text
    second = lib(tmp_path, f'l9_consume_attempt "{tmp_path}/work2" {DEVICE} {RUN} /bin/true')
    assert second.returncode != 0 and "L9_ATTEMPT_ALREADY_CONSUMED" in second.stderr
    assert marker.read_text() == text


def test_a_closeout_alone_also_blocks_a_new_attempt(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o700)
    (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").write_text("x")
    res = lib(tmp_path, 'l9_marker_unconsumed')
    assert res.returncode != 0 and "L9_ATTEMPT_ALREADY_CONSUMED" in res.stderr


def test_the_canonical_directory_must_be_private_and_owned(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o777)
    (tmp_path / "gov").chmod(0o777)
    res = lib(tmp_path, 'l9_marker_unconsumed')
    assert res.returncode != 0 and "L9_CANONICAL_DIR_NOT_TRUSTED" in res.stderr


def test_the_closeout_is_written_with_the_exact_key_set_once(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    assert lib(tmp_path, f'l9_consume_attempt "{tmp_path}/w" {DEVICE} {RUN} /bin/true').returncode == 0
    ok = lib(tmp_path, f'l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/evidence')
    assert ok.returncode == 0, combined(ok)
    text = (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").read_text()
    keys = [l.split("=", 1)[0] for l in text.splitlines()]
    assert keys == ["L9_LIVE", "L9_LIVE_EXECUTED", "L9_RESULT", "L9_ATTEMPT_CONSUMED", "L9_RERUN_ALLOWED", "L9_STAGE", "L9_EVIDENCE_CLASS", "L9_EXPECTED_MAIN", "L8_EXECUTION_MAIN",
                    "L9_EVIDENCE_BUNDLE_SHA256", "L9_EVIDENCE_ROOT", "L9_AUTHENTICATED_STATUS_OBSERVED", "L9_DEADMAN_ABSENT_OVER_WINDOW", "L9_COMMANDS_EMITTED", "L9_RELAY_ACTUATION",
                    "L9_NEGATIVE_PROBES_INJECTED_LIVE", "L9_PRE_POST_PRESERVATION", "L9_SECRET_SCAN", "L9_FAILURE_RESULT"]
    assert "L9_LIVE=CLOSED_PASS" in text and "L9_COMMANDS_EMITTED=0" in text and "L9_FAILURE_RESULT=NONE" in text
    again = lib(tmp_path, f'l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/evidence')
    assert again.returncode != 0
    assert (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").read_text() == text


def test_a_closeout_cannot_be_recorded_without_a_consumed_marker_or_with_bad_inputs(tmp_path: Path) -> None:
    tmp_path.chmod(0o755)
    (tmp_path / "gov").mkdir(mode=0o700)
    assert lib(tmp_path, f'l9_record_success {HEX_A} {HEX_B} {SHA} {tmp_path}/e').returncode != 0
    assert lib(tmp_path, f'l9_record_success zz {HEX_B} {SHA} {tmp_path}/e').returncode != 0
    assert not (tmp_path / "gov" / "L9-GLOBAL-CLOSEOUT-PASS").exists()


def auth_file(tmp_path: Path, **over) -> Path:
    fields = {"stage": "L9", "date": "2026-10-09", "authorizer": "music", "scope": f"L9 live observe main={HEX_A} runner={SHA} l8={HEX_B}",
              "reference": "https://example.invalid/a1"}
    fields.update({k: v for k, v in over.items() if v is not None})
    lines = ["AEGIS_P4_AUTHORIZATION_V1"] + [f"{k}={v}" for k, v in fields.items() if k not in over or over[k] is not None]
    lines += [f"{k}={v}" for k, v in over.items() if k.startswith("extra_")]
    path = tmp_path / "authorization-L9.txt"
    path.write_text("\n".join(lines).replace("extra_", "") + "\n")
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


def test_an_authorization_with_a_second_conflicting_binding_is_refused(tmp_path: Path) -> None:
    res = auth_gate(tmp_path, auth_file(tmp_path, scope=f"L9 main={HEX_A} runner={SHA} l8={HEX_B} main={'9' * 40}"))
    assert res.returncode != 0 and "L9_AUTHORIZATION_AMBIGUOUS_BINDING" in res.stderr


def test_an_authorization_without_the_binding_tokens_is_refused(tmp_path: Path) -> None:
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
    assert lib(tmp_path, f'l9_operator_identity_gate {user} {uid}').returncode == 0
    assert lib(tmp_path, f'l9_operator_identity_gate {user} {uid + 1}').returncode != 0
    assert lib(tmp_path, f'l9_operator_identity_gate nobody-else {uid}').returncode != 0
    assert lib(tmp_path, 'l9_operator_identity_gate root 0').returncode != 0


def test_bundle_preparation_requires_byte_exact_main_objects(tmp_path: Path) -> None:
    repo = Repo(tmp_path / "bundle-repo")
    p4 = repo.path / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
    names = ["p4-lib.sh", "p4-l0-capture.sh", "p4-compare.sh", "p4-l7u-run-lib.sh", "p4-l7-run-lib.sh", "p4-l6b-run-lib.sh", "p4-l9-live-observe.py", "p4-l9-gates.py", "p4-l9-auth.py",
             "stages/L9/apply.sh", "stages/L9/verify.sh", "stages/L9/rollback.sh", "stages/L9/allow-keys.txt", "stages/L9/allow-listeners.txt"]
    for n in names:
        (p4 / n).parent.mkdir(parents=True, exist_ok=True)
        (p4 / n).write_text(f"# {n}\n")
    main = repo.commit("files")
    ok = lib(tmp_path, f'SUDO= l9_prepare_bundle "{repo.path}" "{p4}" "{tmp_path}/bundle" {main}', SUDO="")
    # install -o root needs root; without it the byte-exactness gate (before install) is what we assert on
    (p4 / "stages/L9/apply.sh").write_text("# tampered\n")
    bad = lib(tmp_path, f'l9_prepare_bundle "{repo.path}" "{p4}" "{tmp_path}/bundle2" {main}')
    assert bad.returncode != 0 and "L9_BUNDLE_SOURCE_NOT_EXACT_MAIN:stages/L9/apply.sh" in bad.stderr
    assert ok.returncode in (0, 1)


# ---------------------------------------------------------------------------------------------- D/F. owner runner and freeze


def test_the_runner_template_refuses_to_run_as_committed() -> None:
    res = subprocess.run(["bash", str(RUNNER), "/tmp"], capture_output=True, text=True, check=False, env={"PATH": os.environ["PATH"]})
    assert res.returncode == 2 and "runner is not pinned" in res.stderr


def runner_text() -> str:
    return RUNNER.read_text()


def test_the_runner_orders_every_governance_step() -> None:
    text = runner_text()
    order = ["p4-l9-freeze.py\" verify", "p4-l9-gates.py\" l8-predecessor", "l9_authorization_gate", "p4-stage-gate.sh", "l9_marker_unconsumed", "l9_prepare_bundle", "capture \"$PRE\"",
             "l9_consume_attempt", "stages/L9/apply.sh", "capture \"$POST\"", "compare \"$PRE\" \"$POST\"", "if ! l7u_secret_scan \"$EVID\"", "stages/L9/verify.sh", "l9_record_success"]
    positions = [text.index(item) for item in order]
    assert positions == sorted(positions), dict(zip(order, positions))
    assert text.count("l9_consume_attempt") == 1 and text.count("stages/L9/apply.sh") == 1


def test_the_runner_binds_pins_main_origin_clean_tree_and_forbids_overrides() -> None:
    text = runner_text()
    for needle in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "DEVICE_ID", "WINDOW_SECONDS", "MERGED_MAIN_WORKTREE", "EVIDENCE_ROOT",
                   "git -C \"$REPO\" rev-parse HEAD", "status --porcelain", "ls-remote origin refs/heads/main", "environment override SUDO is forbidden",
                   "Git environment override is forbidden", "AEGIS_L9_TEST_ONLY_", "RECOVERY_TEST_ONLY_", "not root", "RUNNER_SHA256", "RUNNER_ROOT_OWNED=PASS",
                   "L8_PREDECESSOR=PASS", "sudo -n true"):
        assert needle in text, needle


def test_the_runner_mutates_nothing_and_never_touches_services_or_the_device() -> None:
    code = code_only(RUNNER)
    lib_code = code_only(RUN_LIB)
    for forbidden in ("systemctl", "esptool", "mosquitto", "nft ", "iptables", "ip link", "reboot", "shutdown", "1883", "rm -rf"):
        assert forbidden not in code, forbidden
        assert forbidden not in lib_code, forbidden
    for forbidden in (r"\bCOMMAND\b", r"\bRESTORE\b", r"\bCUT\b"):
        assert not re.search(forbidden, code) and not re.search(forbidden, lib_code), forbidden


def test_the_runner_never_accepts_success_from_arguments_or_environment() -> None:
    text = runner_text()
    assert "${1:-}" in text and "${2" not in text
    assert "L9_RESULT" in text and "AEGIS_L9_RESULT" not in text
    assert "AEGIS_L9_BACKEND=live AEGIS_L9_LIVE_AUTHORIZED=YES" in text


def test_every_post_consumption_failure_is_terminal_and_never_reopens_the_marker() -> None:
    text = runner_text()
    post_fail = text[text.index("post_fail() {"):text.index("handle_signal()")]
    assert "FAIL_IMMUTABLE" in post_fail and "L9_RERUN_ALLOWED=NO" in post_fail and "rm " not in post_fail and "chattr -i" not in post_fail
    for step in ("APPLY_OBSERVATION", "POST_CAPTURE", "COMPARE_S10", "SECRET_SCAN", "VERIFY", "L9_CLOSEOUT", "MARKER_DURABILITY", "EVIDENCE_DIGEST"):
        assert f"post_fail {step}" in text, step


FREEZE_PINS = {"EXPECTED_MAIN": HEX_A, "OPERATOR_USER": "music", "OPERATOR_UID": "1000", "DEVICE_ID": DEVICE, "WINDOW_SECONDS": "150",
               "MERGED_MAIN_WORKTREE": "/srv/aegis/main", "EVIDENCE_ROOT": "/srv/aegis/evidence"}


def freeze_repo(tmp_path: Path):
    repo = Repo(tmp_path / "frepo")
    rel = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh"
    repo.write(rel, RUNNER.read_text())
    main = repo.commit("template")
    pins = dict(FREEZE_PINS, EXPECTED_MAIN=main)
    return repo, main, pins


def test_freeze_produces_exactly_the_template_plus_the_pins(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    results = freeze.freeze(repo.path, main, pins, out)
    assert results["RUNNER_TEMPLATE_AUTHORITY"] == "PASS" and results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] == "PASS"
    assert re.fullmatch(r"[0-9a-f]{64}", results["RUNNER_SHA256"]) and stat.S_IMODE(out.stat().st_mode) == 0o555
    frozen = out.read_text()
    assert f"EXPECTED_MAIN={main}" in frozen and "PIN_" not in "\n".join(l for l in frozen.splitlines() if re.match(r"^(EXPECTED_MAIN|OPERATOR_USER|OPERATOR_UID|DEVICE_ID|WINDOW_SECONDS|MERGED_MAIN_WORKTREE|EVIDENCE_ROOT)=", l))
    assert freeze.check_equivalence(RUNNER.read_text(), frozen) == {**pins}


def test_freeze_never_overwrites_and_refuses_unknown_missing_or_unsafe_pins(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    with pytest.raises(freeze.FreezeError, match="DESTINATION_EXISTS"):
        freeze.freeze(repo.path, main, pins, out)
    base = json.dumps(pins)
    for mutate, reason in ((lambda p: {**p, "EXTRA": "x"}, "UNKNOWN_PIN"), (lambda p: {k: v for k, v in p.items() if k != "DEVICE_ID"}, "MISSING_PIN"),
                           (lambda p: {**p, "OPERATOR_USER": "mu sic"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "EVIDENCE_ROOT": "/x/$(id)"}, "PIN_VALUE_REJECTED"),
                           (lambda p: {**p, "WINDOW_SECONDS": "119"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "WINDOW_SECONDS": "901"}, "PIN_VALUE_REJECTED"),
                           (lambda p: {**p, "EVIDENCE_ROOT": "/a/../b"}, "PIN_VALUE_REJECTED"), (lambda p: {**p, "DEVICE_ID": "PIN_DEVICE_ID"}, "PIN_VALUE_REJECTED")):
        with pytest.raises(freeze.FreezeError, match=reason):
            freeze.load_pins(json.dumps(mutate(json.loads(base))))
    with pytest.raises(freeze.FreezeError, match="DUPLICATE_PIN"):
        freeze.load_pins('{"EXPECTED_MAIN": "a", "EXPECTED_MAIN": "b"}')
    with pytest.raises(freeze.FreezeError, match="EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN"):
        freeze.freeze(repo.path, main, {**pins, "EXPECTED_MAIN": HEX_B}, tmp_path / "other.sh")


def test_freeze_verify_detects_any_non_pin_byte_change(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    out.chmod(0o755)
    out.write_text(out.read_text().replace("l9_consume_attempt", "true # l9_consume_attempt", 1))
    with pytest.raises(freeze.FreezeError, match="NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE"):
        freeze.verify(repo.path, main, out, owner_uid=None)
    out.write_text(out.read_text())  # keep
    with pytest.raises(freeze.FreezeError):
        freeze.verify(repo.path, HEX_B, out, owner_uid=None)


def test_freeze_verify_in_production_mode_requires_root_ownership_and_the_l8_predecessor(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    with pytest.raises(freeze.FreezeError, match="RUNNER_NOT_ROOT_OWNED"):
        freeze.verify(repo.path, main, out)


def test_freeze_root_owned_mode_requires_root_and_the_l8_predecessor(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    if os.geteuid() != 0:
        with pytest.raises(freeze.FreezeError, match="ROOT_REQUIRED"):
            freeze.freeze(repo.path, main, pins, tmp_path / "x.sh", root_owned=True)
    else:  # pragma: no cover - the real invariant when run as root
        with pytest.raises(freeze.FreezeError, match="L8_PREDECESSOR_NOT_SATISFIED"):
            freeze.freeze(repo.path, main, pins, tmp_path / "x.sh", root_owned=True)


def test_freeze_l8_predecessor_check_uses_the_shared_gate(tmp_path: Path, monkeypatch) -> None:
    repo, execution, main = valid_l8(tmp_path)
    assert freeze._require_l8(repo.path, main)["L8_EXECUTION_MAIN"] == execution
    bare = Repo(tmp_path / "bare")
    bare.receipt("2026-10-01_000000_music_x.md", ["L8_ACCEPTANCE=NO"])
    head = bare.commit("x")
    with pytest.raises(freeze.FreezeError, match="L8_PREDECESSOR_NOT_SATISFIED:L8_CLOSEOUT_MISSING_OR_AMBIGUOUS"):
        freeze._require_l8(bare.path, head)


def test_freeze_reads_the_template_from_the_git_object_not_the_working_tree(tmp_path: Path) -> None:
    repo, main, pins = freeze_repo(tmp_path)
    (repo.path / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l9-owner.sh").write_text("# working tree tamper\n")
    out = tmp_path / "frozen.sh"
    freeze.freeze(repo.path, main, pins, out)
    assert "working tree tamper" not in out.read_text()


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


def test_an_unknown_core_uplink_never_passes() -> None:
    w, b = good_world()
    w.doc["uplink"] = "UNKNOWN"
    data, _ = run_observe(w, b)
    assert data["result"] == "FAIL" and data["failure_boundary"] == "UPLINK_CHANGED"
    w2 = World()
    w2.doc["uplink"] = "UNKNOWN"
    b2 = pre_boundary(w2)
    add_periodic(w2, 1000.0, 5, 30.0)
    w2.doc["updated_at"] = 1130.0
    assert run_observe(w2, b2)[0]["result"] == "FAIL"
