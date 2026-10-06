"""R1Bv contract: a NON-MUTATING successor validation of the EXISTING failed R1B evidence (NOT an R1B retry). Registry, stage gate, runner/handler/library safety by construction (no socket, no marker or window-record
write, no event generation, no sleep), the predecessor receipt gate, the Recovery predecessor gate, the sudo credential gate, the TrustedClock closure and the handler/verify contract. Hermetic: user namespace and temporary
seams only; no host path, socket or database is touched."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_r1bv_stage as base  # noqa: E402

ROOT, P4, STG, LIB, RUNNER, LOGS = base.ROOT, base.P4, base.STG, base.LIB, base.RUNNER, base.LOGS
OBSERVER = ROOT / "aegis_soc/r1bv_validation.py"
FILES = [LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", OBSERVER]
RELEASE = "ebffab6f8a6d7d98973fac7e89167352d529a87e"
needs_userns = base.needs_userns


def code(path: Path) -> str:
    if path.suffix == ".py":
        import ast

        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
                node.body = node.body[1:] or [ast.Pass()]
        return ast.unparse(tree)
    return "\n".join(base.code_lines(path))


# ---------------------------------------------------------------- F. registry




def gate_record(tmp_path: Path, **over: str) -> Path:
    today = subprocess.run(["date", "+%F"], env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]}, text=True, capture_output=True).stdout.strip()
    fields = {"stage": "R1Bv", "date": today, "authorizer": "music", "scope": "R1Bv: read-only validation of the existing R1B evidence; no mutation", "reference": "OWNER-AUTHORIZATION-R1BV.txt", **over}
    path = tmp_path / "authorization-R1Bv.txt"
    path.write_text("AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None))
    return path


def stage_gate(auth: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(P4 / "p4-stage-gate.sh"), "--stage", "R1Bv", "--mode", "live", "--authorization", str(auth), *extra], env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]},
                          text=True, capture_output=True)


def test_the_stage_gate_accepts_a_fresh_authorization_alone_for_the_non_mutating_stage(tmp_path: Path) -> None:
    result = stage_gate(gate_record(tmp_path))
    out = result.stdout.splitlines()
    assert result.returncode == 0 and "AUTHORIZATION_RECORD=VALID" in out and "STAGE_MUTATES_PRODUCTION=NO" in out and "READ_ONLY_CAPTURE_ALLOWED=YES" in out and "STAGE_GATE=PASS_READ_ONLY" in out, result.stdout
    assert "ROLLBACK_HANDLER=NOT_APPLICABLE" in out  # no mutating-stage semantics: no K3 and no rollback handler requirement


@pytest.mark.parametrize("over", [{"stage": "R1D"}, {"date": "2020-01-01"}, {"d6_notice": "pub"}, {"integration_review": "yes"}, {"recovery_authorization": "x"}, {"scope": "x" * 201}])
def test_the_stage_gate_refuses_a_wrong_stale_extra_field_or_oversized_authorization(tmp_path: Path, over: dict) -> None:
    result = stage_gate(gate_record(tmp_path, **over))
    assert result.returncode == 1 and "AUTHORIZATION_RECORD=VALID" not in result.stdout.splitlines()


# ---------------------------------------------------------------- D. safety by construction
def test_no_r1bv_path_can_reach_the_r1d_socket_the_caller_or_a_dispose_step() -> None:
    for path in FILES:
        text = code(path)
        for forbidden in ("historical-disposition.sock", "r1d_dispose_call", "r1bv_dispose_call", "DISPOSE", "dispose_historical", "AF_UNIX", "socat", "nc ", "r1bv_hook_dispose", "HistoricalDispositionServer", "record_attempt"):
            assert not re.search(r"(?<![A-Za-z_])" + re.escape(forbidden) + r"(?![A-Za-z_])", text) if forbidden == "DISPOSE" else forbidden not in text, (path.name, forbidden)
    assert not list((P4 / "r1bv-acceptance").glob("*dispose*"))  # no caller ships with the R1Bv tooling


def test_no_r1bv_path_creates_a_marker_a_consumption_record_or_a_one_shot() -> None:
    for path in FILES:
        text = code(path)
        for forbidden in ("R1BV-GLOBAL-ATTEMPT-CONSUMED", "R1BV-ATTEMPT-CONSUMED", "r1bv_consume_attempt", "r1bv_run_attempt", "r1bv_attempt_unconsumed", "chattr", "r1bv_durable", "r1bv_fsync", "ATTEMPT_STARTED"):
            assert forbidden not in text, (path.name, forbidden)
    for path in (RUNNER, LIB):
        for line in base.code_lines(path):
            if re.search(r"R1[ABD]-(GLOBAL|ATTEMPT)|R1[ABD]_(MARKER|WINDOW)_NAME", line):
                assert not re.search(r">>?\s*\"?\$|noclobber|\brm\b|\bmv\b|truncate|chattr|install ", line), (path.name, line)  # governance records are only ever READ


def test_no_r1bv_path_writes_sqlite_restarts_a_service_alters_nft_runs_recovery_or_touches_esp32() -> None:
    for path in FILES:
        text = code(path)
        assert not re.search(r"systemctl\s+(start|stop|restart|reload|kill|enable|disable|mask)", text), path.name
        assert not re.search(r"nft\s+(add|delete|flush|destroy|insert|replace|create)", text), path.name
        assert not re.search(r"\b(PROBE|ISOLATE|RESTORE|aegisctl|recovery_client|recovery\.sock|OP_CLOSE|mosquitto_pub|paho|esp32|firmware)\b", text, re.I), path.name
        assert not re.search(r"\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b", text) or path.suffix == ".py" and "mode=ro" in (ROOT / "aegis_soc/historical_disposition.py").read_text(), path.name
        assert "sqlite3.connect(" not in text and "BEGIN IMMEDIATE" not in text, path.name


def test_the_handler_only_opens_the_observer_and_the_rollback_acts_on_nothing() -> None:
    apply_code = code(STG / "apply.sh")
    assert "aegis_soc.r1bv_validation" in apply_code and "aegis_soc.historical_disposition" not in apply_code and "aegis_soc.r1_acceptance" not in apply_code
    assert re.search(r"case \"\$STEP\" in BASELINE \| FINAL\) ;; \*\) fail STEP_INVALID", apply_code)
    rollback = code(STG / "rollback.sh")
    assert not re.search(r"sqlite|socket|python|sudo|rm |mv |reopen", rollback, re.I) and "R1BV_ROLLBACK=NOTHING_OWNED" in rollback
    assert not (STG / "k3-R1Bv.txt").exists()










# ---------------------------------------------------------------- B. TrustedClock snapshot repair
R1D_TOOL = P4 / "r1d-acceptance/r1d_verifier_snapshot.py"
R1BV_TOOL = P4 / "r1bv-acceptance/r1bv_verifier_snapshot.py"


def load(path: Path, name: str):
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("path,name", [(R1D_TOOL, "snap_r1d"), (R1BV_TOOL, "snap_r1bv")])
def test_the_repaired_verifier_snapshot_closure_includes_trusted_time_and_its_local_imports(path: Path, name: str) -> None:
    tool = load(path, name)
    closure = set(tool.closure(ROOT))
    assert "aegis_soc/trusted_time.py" in closure and "aegis_soc/protocol_v1.py" in closure and "aegis_soc/__init__.py" in closure
    for rel in closure:  # transitively closed: every local import of every member is itself a member
        for dep in tool._imports(ROOT / rel):
            if tool._module_file(ROOT, dep) is not None:
                assert str(tool._module_file(ROOT, dep).relative_to(ROOT)) in closure, (rel, dep)
    assert "trusted_time" in tool.ENTRIES


def test_the_old_observer_only_closure_is_what_omitted_trusted_time() -> None:
    tool = load(R1D_TOOL, "snap_r1d_old")
    tool.ENTRIES = (tool.ENTRY,)  # the pre-repair closure rooted only in the observer
    assert "aegis_soc/trusted_time.py" not in set(tool.closure(ROOT))  # this is exactly the R1D live failure
    assert "trusted_time" in load(R1D_TOOL, "snap_r1d_new").ENTRIES


def flat_control(tmp_path: Path) -> Path:
    ctrl = tmp_path / "authority" / "control"
    ctrl.parent.mkdir()
    shutil.copytree(P4, ctrl, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return ctrl


@pytest.mark.parametrize("path,name", [(R1D_TOOL, "snap_r1d_run"), (R1BV_TOOL, "snap_r1bv_run")])
def test_p4_l5_clock_imports_and_runs_against_the_immutable_snapshot_with_no_mutable_fallback(tmp_path: Path, path: Path, name: str) -> None:
    tool = load(path, name)
    snap = tmp_path / "snap"
    sha = tool.snapshot(ROOT, snap)
    tool.check(snap, sha, owner_uid=None)  # manifest / file set / writability invariants intact
    ctrl = flat_control(tmp_path)
    # without the snapshot on PYTHONPATH the FLAT control copy cannot import trusted_time (the historical failure mode)
    bare = subprocess.run([sys.executable, str(ctrl / "p4-l5-clock.py"), "state"], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert bare.returncode != 0 and "No module named" in bare.stderr
    # exactly how the frozen runner invokes the capture: PYTHONPATH=<immutable snapshot>
    run = subprocess.run(["env", f"PYTHONPATH={snap}", "PYTHONDONTWRITEBYTECODE=1", sys.executable, str(ctrl / "p4-l5-clock.py"), "state"], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert "ModuleNotFoundError" not in run.stderr and re.match(r"^state=[A-Z_]+", run.stdout), (run.stdout, run.stderr)
    assert (snap / "aegis_soc/trusted_time.py").read_bytes() == (ROOT / "aegis_soc/trusted_time.py").read_bytes()


def test_the_snapshot_repair_does_not_weaken_the_comparator_or_allowlists() -> None:
    compare = (P4 / "p4-compare.sh").read_text()
    assert 'A["time.trustedclock.state"] == "SYNCED"' in compare  # unchanged comparison semantics
    for stage in ("R1D", "R1Bv"):
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            active = [ln for ln in (P4 / "stages" / stage / name).read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
            assert not any("trustedclock" in ln.lower() for ln in active) and active == [], (stage, name)


def clock_fn() -> str:
    return re.search(r"^clock_available\(\) \{.*\}$", RUNNER.read_text(), re.M).group(0)


def clock_ok(tmp_path: Path, rows: str) -> bool:
    (tmp_path / "time.tsv").write_text(rows)
    return subprocess.run(["bash", "-c", f'{clock_fn()}\nclock_available "{tmp_path}"']).returncode == 0


@pytest.mark.parametrize("state,ok", [("SYNCED", True), ("HOLDOVER", True), ("UNTRUSTED", True), ("UNKNOWN", False), ("UNAVAILABLE", False), ("NOT_RECORDED", False), ("", False), ("synced", False), ("BOGUS", False)])
def test_only_an_evaluated_trustedclock_state_is_available_evidence(tmp_path: Path, state: str, ok: bool) -> None:
    assert clock_ok(tmp_path, f"time.trustedclock.state\t{state}\n") is ok, state


def test_a_missing_or_duplicated_trustedclock_record_is_not_evidence(tmp_path: Path) -> None:
    assert clock_ok(tmp_path, "time.other\tx\n") is False
    assert clock_ok(tmp_path, "") is False
    assert clock_ok(tmp_path, "time.trustedclock.state\tSYNCED\ntime.trustedclock.state\tSYNCED\n") is False


def test_an_unavailable_probe_is_recorded_as_unknown_and_the_r1bv_gate_refuses_it(tmp_path: Path, capsys) -> None:
    """The real failure mode: p4-l5-clock.py `state` with an unavailable kernel probe prints state=UNKNOWN reason=PROBE_UNAVAILABLE and p4-l0-capture records only the parsed state. Hermetic: the probe is
    stubbed in-process and the fixture CLI is used; the live clock is never touched."""
    clock = load(P4 / "p4-l5-clock.py", "p4_l5_clock_hermetic")
    clock.adjtimex_raw = lambda: None  # kernel probe unavailable
    assert clock.main(["state"]) == 0
    line = capsys.readouterr().out.splitlines()[0]
    assert line.startswith("state=UNKNOWN reason=PROBE_UNAVAILABLE"), line
    fixture = subprocess.run([sys.executable, str(P4 / "p4-l5-clock.py"), "probe", "--fixture-probe", "none"], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
    assert fixture.stdout.startswith("state=UNKNOWN reason=PROBE_UNAVAILABLE"), fixture.stdout
    parsed = subprocess.run(["sed", "-n", r"s/^state=\([A-Z]*\) .*/\1/p"], input=line + "\n", capture_output=True, text=True).stdout.strip()  # exactly the sed p4-l0-capture.sh applies
    assert parsed == "UNKNOWN" and "sed -n 's/^state=\\([A-Z]*\\) .*/\\1/p'" in (P4 / "p4-l0-capture.sh").read_text()
    assert clock_ok(tmp_path, f"time.trustedclock.state\t{parsed}\n") is False  # evidence unavailable -> R1Bv refuses


def test_the_clock_gate_fix_does_not_touch_the_comparator_the_allowlists_or_historical_r1d() -> None:
    for stage in ("R1D", "R1Bv"):
        active = [ln for ln in (P4 / "stages" / stage / "allow-keys.txt").read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        assert active == [], stage
    assert not any("UNKNOWN" in ln for ln in (P4 / "p4-compare.sh").read_text().splitlines() if "trustedclock" in ln)
    assert "UNKNOWN" not in "\n".join(l for l in (P4 / "owner-run/run-r1d-owner.sh").read_text().splitlines() if "clock_available" in l)




# ================================================================ R1Bv-specific contract
REPO = ROOT.parent
B_LIB = P4 / "p4-r1b-run-lib.sh"
R1BV_CLOSEOUT_REL = f"{LOGS}/2026-10-08_100000_music_idea3-r1bv-live-closeout.md"
R1BV_LIVE_FIELDS = ("R1BV_LIVE=CLOSED_PASS", "R1BV_LIVE_EXECUTED=YES", "R1BV_RESULT=PASS", "R1BV_VERIFY=PASS", "R1BV_IS_R1B_RETRY=NO", "R1BV_READ_ONLY_VALIDATION_ONLY=YES", "R1BV_NEW_EXTERNAL_EVENT_GENERATED=NO",
                    "R1BV_EXISTING_R1B_EVIDENCE_ONLY=YES", "R1BV_INCIDENT_MUTATED=NO", "R1BV_R1B_MARKER_MUTATED=NO", "R1BV_WINDOW_RECORD_CREATED=NO", "R1BV_WINDOW_RECORD_RECONSTRUCTED=NO",
                    "R1BV_CANONICAL_MARKER_TIME_AUTHORITY=PASS", "R1BV_HISTORICAL_BOUND=PASS", "R1BV_EXPECTED_SOURCE_BOUND=PASS", "R1BV_REAL_DETECTOR_CHAIN=PASS", "R1BV_NEW_INCIDENT_CREATED_SEMANTICS=PASS",
                    "R1BV_AUDIT_PROVENANCE=PASS", "R1BV_AUDIT_INTEGRITY=PASS", "R1BV_R1I_STATE=PASS", "R1BV_TRUSTEDCLOCK_EVIDENCE_AVAILABLE=YES", "R1BV_PRESERVATION_S10=PASS", "R1BV_COMPARE_RESULT=PASS", "R1B_RESULT=FAIL_IMMUTABLE",
                    "R1B_RESULT_REWRITTEN=NO", "RECOVERY_R2_R8_EXECUTED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO")
REAL_RECEIPTS = ["2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md", "2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md", "2026-10-05_041108_music_idea3-f1u-live-closeout.md",
                 "2026-10-05_063546_music_idea3-r1i-live-closeout.md", "2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md", "2026-10-06_070624_music_idea3-r1du-live-closeout.md",
                 "2026-10-06_073302_music_idea3-r1d-live-failure-closeout.md", "2026-10-06_095103_music_idea3-r1dv-live-closeout.md", "2026-10-06_112233_music_idea3-r1b-live-failure-closeout.md"]
R1B_FAIL = f"{LOGS}/2026-10-06_112233_music_idea3-r1b-live-failure-closeout.md"


def bullet(items, drop=None, extra=()) -> str:
    return "\n".join(f"- `{x}`" for x in (*[i for i in items if i != drop], *extra)) + "\n"


def world(tmp_path: Path, *, closeout: str | None = None, **change: str | None) -> Path:
    """A throw-away Git repo holding the REAL merged receipts (so the gate must accept exactly what is shipped), plus optional changes."""
    files = {f"{LOGS}/{n}": (REPO / LOGS / n).read_text() for n in REAL_RECEIPTS}
    if closeout is not None:
        files[R1BV_CLOSEOUT_REL] = closeout
    for key, value in change.items():
        files.pop(key, None) if value is None else files.__setitem__(key, value)
    repo = tmp_path / "repo"
    repo.mkdir()
    base.git(repo, "init", "-q")
    base.git(repo, "config", "user.email", "t@e.invalid")
    base.git(repo, "config", "user.name", "t")
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text)
    base.git(repo, "add", "-A")
    base.git(repo, "commit", "-q", "-m", "x")
    return repo


def run_gate(fn: str, repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return base.bash(f'. "{LIB}"; {fn} "{repo}" {" ".join(args)} {base.head_of(repo)}' if fn == "r1bv_receipt_gate" else f'. "{LIB}"; {fn} "{repo}" {base.head_of(repo)}')


def receipt_gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return run_gate("r1bv_receipt_gate", repo, RELEASE)


def recovery_gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return run_gate("r1bv_recovery_predecessor_gate", repo)


# ---------------------------------------------------------------- registry
def test_r1bv_is_registered_exactly_once_right_after_r1b_and_is_non_mutating() -> None:
    order = base.stages()
    assert order.count("R1Bv") == 1 and order.index("R1Dv") < order.index("R1B") < order.index("R1Bv") < order.index("L8") < order.index("L9")
    assert order[order.index("R1B") + 1] == "R1Bv" and order[order.index("R1Bv") + 1] == "L8"
    out = base.bash(f'. "{base.P4_LIB}"; p4_stage_known R1Bv && echo KNOWN; p4_stage_mutates R1Bv && echo MUTATES || echo NON_MUTATING; p4_stage_gaps R1Bv; echo "extra=[$(p4_stage_auth_extra R1Bv)]"; p4_stage_handler_status R1Bv').stdout.split("\n")
    assert out[:5] == ["KNOWN", "NON_MUTATING", "none", "extra=[]", "REGISTERED"]
    for mutating in ("R1B", "R1D", "R1A", "L8"):
        assert "MUTATES" in base.bash(f'. "{base.P4_LIB}"; p4_stage_mutates {mutating} && echo MUTATES').stdout  # nothing else became read-only


def test_documented_order_names_r1bv_after_r1b_and_keeps_recovery_blocked() -> None:
    assert "R1Dv -> R1B (immutable FAIL at windowrecord) -> R1Bv -> Recovery R2-R8 -> LVR -> L8 -> L9" in base.P4_LIB.read_text()
    readme = (P4 / "README.md").read_text()
    section = readme[readme.index("## 22. Stage R1Bv"):]
    for needle in ("IMPLEMENTED != LIVE EXECUTED != PASS", "R1BV_LIVE_EXECUTED=NO", "R1Bv (REPOSITORY_IMPLEMENTED; at that merge LIVE NOT RUN", "Recovery R2-R8 (at that merge blocked until R1Bv LIVE PASS", "superseded by section 23"):
        assert needle in section, needle


# ---------------------------------------------------------------- safety by construction
def test_no_r1bv_path_creates_or_reconstructs_the_r1b_window_record_or_touches_the_r1b_marker() -> None:
    for path in FILES:
        text = code(path)
        for line in text.split("\n"):
            if "R1B-ATTEMPT-WINDOW" in line or "R1B_WINDOW_NAME" in line or "WINDOW_RECORD_NAME" in line:
                assert not re.search(r">>?\s*[\"$]|noclobber|\brm\b|\bmv\b|truncate|chattr|install |touch|open\(|write|O_CREAT|mkdir", line), (path.name, line)
        assert not re.search(r"(?<![A-Za-z_])(touch|chattr|mv|rm|truncate)\b[^\n]*R1B-(GLOBAL|ATTEMPT)", text), path.name
    obs = OBSERVER.read_text()
    assert "R1B-ATTEMPT-WINDOW" in obs and obs.count("O_CREAT") == 1 and "O_EXCL" in obs  # the observer's only create is its own exclusive 0600 result file
    for forbidden in ("os.utime", "os.chown", "os.chmod", "os.rename", "os.unlink", "os.remove", "shutil", "O_TRUNC", "O_APPEND", "open(path, \"w", "write_text", "sqlite3.connect"):
        assert forbidden not in obs, forbidden


def test_no_r1bv_path_generates_an_event_traffic_or_an_alert_or_waits() -> None:
    for path in FILES:
        text = code(path)
        for tool in ("curl", "wget", "nmap", "hping", "ping ", "nc ", "ncat", "socat", "ssh ", "iperf", "telnet", "alert.sock", "AF_INET", "AF_UNIX", "socket.", "SENT_BOUND_INJECT", "logger "):
            assert not re.search(r"(?<![A-Za-z0-9_])" + re.escape(tool), text), (path.name, tool)
        assert not re.search(r"\bsleep\b", text), path.name  # R1Bv has NO observation wait (R1B failed after a long wait on an expired sudo prompt)
        assert "time.sleep" not in text, path.name
    assert "OBSERVE_SECONDS = 600" in OBSERVER.read_text() and "WAITING_FOR_GENUINE_EXTERNAL_EVENT" not in RUNNER.read_text().replace("# ", "") .split("echo", 1)[0]


def test_r1bv_has_no_k3_no_marker_and_no_rollback_mutation() -> None:
    assert not (STG / "k3-R1Bv.txt").exists()
    rollback = code(STG / "rollback.sh")
    assert "R1BV_ROLLBACK=NOTHING_OWNED" in rollback and not re.search(r"sqlite|socket|python|sudo|rm |mv |reopen", rollback, re.I)
    text = RUNNER.read_text()
    assert "--k3" not in code(RUNNER) and "a K3 record is not part of the non-mutating R1Bv workflow" in text
    assert "r1bv_run_attempt" not in text and "r1bv_consume" not in text and "R1BV_IS_R1B_RETRY=NO" in text and "R1BV_ATTEMPT_MARKER_CREATED=NO" in text and "R1BV_WINDOW_RECORD_CREATED=NO" in text


def test_the_handler_only_opens_the_r1bv_observer() -> None:
    apply_code = code(STG / "apply.sh")
    assert "aegis_soc.r1bv_validation" in apply_code and "aegis_soc.r1_acceptance" not in apply_code and "aegis_soc.historical_disposition" not in apply_code
    assert re.search(r"case \"\$STEP\" in BASELINE \| FINAL\) ;; \*\) fail STEP_INVALID", apply_code)
    assert "R1BV_EVENT_GENERATED_BY_HANDLER=NO" in apply_code and "-P -m aegis_soc.r1bv_validation" in apply_code  # -P: nothing in the working directory can shadow a module


# ---------------------------------------------------------------- the runner
def test_the_committed_runner_template_refuses_to_run_unpinned_and_creates_nothing(tmp_path: Path) -> None:
    result = base.bash(f'bash "{RUNNER}" "{tmp_path}"')
    assert result.returncode == 2 and "runner is not pinned" in result.stdout and list(tmp_path.iterdir()) == []
    for pin in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "RELEASE_ID", "EXPECTED_SOURCE_IP", "R1B_EVIDENCE_DIR", "R1B_AUTH_DIR", "AUDIT_DB", "DETECTOR_UID"):
        assert f"{pin}=PIN_" in RUNNER.read_text()
    text = RUNNER.read_text()
    assert "BINDING_SHA256" not in text  # no R1D binding concept in R1Bv
    for private in ("192.168.", "kittipat", "/home/", "2743706", " 948"):
        assert private not in code(RUNNER).replace("/home/PIN_OPERATOR_HOME/PIN_PINNED_WORKTREE_NOT_A_REAL_PATH", ""), private  # M2: no machine-local detail is a repository constant


def test_no_private_runtime_detail_is_a_repository_constant_in_any_r1bv_file() -> None:
    for path in FILES + [P4 / "r1bv-acceptance/r1bv_runner_freeze.py", P4 / "r1bv-acceptance/r1bv_verifier_snapshot.py"]:
        text = path.read_text()
        for private in ("192.168.", "10.77.30", "kittipat", "2743706", "2743686"):
            assert private not in text.replace("10.77.30.1", "").replace("wlp0s20f3", ""), (path.name, private)
    assert "AP_ADDR=10.77.30.1" in RUNNER.read_text()  # the pre-existing broker/AP gate constant shared by every stage (not a private source/target)


def test_the_runner_refuses_environment_overrides(tmp_path: Path) -> None:
    frozen = base.pinned_copy(tmp_path)
    for var in ("AEGIS_P4_FS_ROOT", "AEGIS_R1BV_STEP", "AEGIS_R1BV_TEST_ONLY_MARKER", "AEGIS_R1BV_EXPECTED_SOURCE_IP", "AEGIS_R1BV_R1B_EVIDENCE_DIR", "AEGIS_R1BV_R1B_AUTH_DIR", "R1BV_CANONICAL_DIR", "R1BV_TEST_ONLY_CANONICAL_DIR_ENABLED"):
        result = base.bash(f'bash "{frozen}" "{tmp_path}"', env={var: "x"})
        assert result.returncode == 2 and "environment override" in result.stdout, var


def test_the_runner_is_read_only_and_ordered_with_the_final_observation_last() -> None:
    text = RUNNER.read_text()
    seq = text[text.index('echo "== R1Bv pre-gates'):]
    order = ["pregates ||", "capture PRE", "clock_available \"$PRE\"", "handler BASELINE", "capture POST", "clock_available \"$POST\"", "compare \"$PRE\" \"$POST\"",
             "authority_gates || r1bv_fail authority_before_final", "handler FINAL || r1bv_fail final", "handler FINAL verify.sh"]
    positions = [seq.index(o) for o in order]
    assert positions == sorted(positions), dict(zip(order, positions))
    between = seq[seq.index("handler FINAL || r1bv_fail final"):seq.index("handler FINAL verify.sh")]
    assert not re.search(r"runtime_unchanged|r1bv_r1i_present_gate|capture |compare |authority_gates", between.split("\n", 1)[1]), between
    assert "--stage R1Bv --mode live --authorization" in text and "STAGE_MUTATES_PRODUCTION=NO" in text and "READ_ONLY_CAPTURE_ALLOWED=YES" in text
    assert "R1BV_R1I_STATE=PASS" in text and "R1B_RESULT=FAIL_IMMUTABLE (R1B_RESULT_REWRITTEN=NO)" in text


def runner_code_lines() -> list[str]:
    return [ln for ln in RUNNER.read_text().split("\n") if not ln.lstrip().startswith("#")]


def test_every_privileged_command_after_the_single_interactive_auth_is_itself_noninteractive() -> None:
    lines = runner_code_lines()
    sudo_uses = [ln for ln in lines if re.search(r"(?<![A-Za-z0-9_$])sudo(?![A-Za-z0-9_-])", ln.split("echo ", 1)[0] if ln.lstrip().startswith("echo") else ln)]
    interactive = [ln for ln in sudo_uses if re.search(r"(?<![A-Za-z0-9_$\"])sudo\s+(?!-n\b)(?!-v\b)", re.sub(r'"[^"]*"', '""', ln))]
    assert not interactive, interactive  # no `sudo <cmd>` without -n; the ONE interactive boundary is `sudo -v`
    assert sum(1 for ln in lines if re.match(r"\s*sudo -v\b", ln)) == 1
    text = RUNNER.read_text()
    assert text.index('SUDO="sudo -n"') < text.index('source "$LIB"') < text.index("sudo -v || die")  # the libraries' $SUDO is non-interactive from their first use
    assert "sudo -n install -d -m 700" in text and "sudo -n chown" in text and "sudo -n grep -q 'L0_CAPTURE=COMPLETE'" in text and 'sudo -n bash -c "cd' in text and "sudo -n env -u AEGIS_P4_FS_ROOT" in text
    # the library's own $SUDO uses stay non-interactive too: the gate only ever calls `<sudo> -n true`
    assert "${SUDO%% *} -n true" in LIB.read_text()


def test_a_noninteractive_credential_gate_still_precedes_every_privileged_phase() -> None:
    text = RUNNER.read_text()
    seq = text[text.index('echo "== R1Bv pre-gates'):]
    phases = ["sudo -n install -d -m 700 -o root -g root \"$WORK\"", "capture PRE \"$PRE\"", "handler BASELINE", "capture POST \"$POST\"", "authority_gates || r1bv_fail authority_before_final", "handler FINAL || r1bv_fail final", "out=$(handler FINAL verify.sh"]
    for phase in phases:
        idx = seq.index(phase)
        assert "r1bv_sudo_noninteractive_gate" in seq[max(0, idx - 200):idx], phase


def extract(text: str, start: str, end_suffix: str) -> str:
    lines = text.split("\n")
    i = next(n for n, ln in enumerate(lines) if ln.startswith(start))
    j = next(n for n in range(i, len(lines)) if lines[n].rstrip().endswith(end_suffix))
    return "\n".join(lines[i:j + 1])


def stub_sudo(tmp_path: Path, rc_n: int) -> str:
    """A stub `sudo`: `-n ...` exits ``rc_n`` (non-zero = an EXPIRED credential); anything else is PROMPT-CAPABLE and is recorded as such. Every call is logged."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "sudo.log"
    (bindir / "sudo").write_text('#!/bin/sh\necho "$*" >> "%s"\nif [ "$1" = "-n" ]; then exit %d; fi\necho "PROMPT_CAPABLE: $*" >> "%s"\nexit 1\n' % (log, rc_n, log))
    os.chmod(bindir / "sudo", 0o755)
    return f'PATH="{bindir}:$PATH"; '


def test_expired_credentials_refuse_every_phase_before_substantive_work_and_the_failure_path_never_prompts(tmp_path: Path) -> None:
    text = RUNNER.read_text()
    fn = "\n".join([extract(text, "capture() {", "; }"), extract(text, "compare() {", "done; }"), extract(text, "handler() {", "}"), extract(text, "r1bv_fail() {", "exit 1; }")])
    work = tmp_path / "w"
    work.mkdir()
    script = f"""{stub_sudo(tmp_path, 1)}
control_gate() {{ return 0; }}
SUDO="sudo -n"; CTRL=/nonexistent/ctrl; STG=/nonexistent/stg; WORK="{work}"; VERIFIER_SNAPSHOT_DIR=/nonexistent/v; VERIFIER_MANIFEST_SHA256=x; AUDIT_DB=/nonexistent/db
EXPECTED_SOURCE_IP=203.0.113.1; R1B_EVIDENCE_DIR=/nonexistent/e; R1B_AUTH_DIR=/nonexistent/a; RELEASE_ID=r; PRODUCTION_DETECTOR_SHA256=x; DETECTOR_UID=1; PY=/usr/bin/python3; JOURNAL_SINCE=x; AP_IF=x; AP_ADDR=x; EVID=/nonexistent/evid
{fn}
. "{LIB}"; SUDO="sudo -n"
capture PRE "{tmp_path}/pre"; echo "capture_rc=$?"
handler BASELINE; echo "handler_rc=$?"
compare "{tmp_path}/a" "{tmp_path}/b" "{tmp_path}/out" ; echo "compare_rc=$?"
r1bv_sudo_noninteractive_gate; echo "gate_rc=$?"
LOG_BEFORE=$(wc -l < "{tmp_path}/sudo.log")
(r1bv_fail final_stage_x) ; echo "fail_rc=$?"
LOG_AFTER=$(wc -l < "{tmp_path}/sudo.log")
echo "failure_path_sudo_calls=$((LOG_AFTER-LOG_BEFORE))"
"""
    result = base.bash(script)
    out = result.stdout
    for line in ("capture_rc=1", "handler_rc=1", "compare_rc=1", "gate_rc=1", "fail_rc=1", "failure_path_sudo_calls=0"):
        assert line in out, (line, out, result.stderr)
    log = (tmp_path / "sudo.log").read_text()
    assert log.strip() and all(ln.startswith("-n ") for ln in log.splitlines()), log  # every sudo invocation was non-interactive
    assert "PROMPT_CAPABLE" not in log
    assert "owns NOTHING to roll back" in out and "NO privileged command" in out and "R1BV_RESULT=FAIL" in out
    assert not (tmp_path / "pre").exists() and list(work.iterdir()) == []  # nothing created, nothing mutated
    assert not (tmp_path / "out").exists() or (tmp_path / "out").read_text() == ""  # only the (empty) redirect target of the user-side evidence file may exist; no host state


def test_the_failure_path_never_invokes_the_rollback_handler_or_any_privileged_command() -> None:
    fail_line = extract(RUNNER.read_text(), "r1bv_fail() {", "exit 1; }")
    assert "sudo" not in fail_line and "handler" not in fail_line and "rollback" not in fail_line
    assert not re.search(r"handler\s+(BASELINE|FINAL)[^\n]*rollback|STG/rollback|\$STG/\$\{?2?:?-?rollback", "\n".join(runner_code_lines()))  # only the presence check of the handler files mentions it


def test_a_lapsed_sudo_credential_fails_the_gate_with_an_explicit_reason_and_never_prompts(tmp_path: Path) -> None:
    ok = base.bash(f'{stub_sudo(tmp_path, 0)}. "{LIB}"; SUDO="sudo -n"; r1bv_sudo_noninteractive_gate')
    bad = base.bash(f'{stub_sudo(tmp_path / "x", 1) if (tmp_path / "x").mkdir() is None else ""}. "{LIB}"; SUDO="sudo -n"; r1bv_sudo_noninteractive_gate')
    assert ok.returncode == 0 and bad.returncode == 1 and "R1BV_SUDO_CREDENTIAL_NOT_ACTIVE" in bad.stderr
    assert base.bash(f'. "{LIB}"; SUDO=""; r1bv_sudo_noninteractive_gate').returncode == 0  # no sudo in use (tests / root)
    assert "PROMPT_CAPABLE" not in (tmp_path / "sudo.log").read_text() and "PROMPT_CAPABLE" not in (tmp_path / "x" / "sudo.log").read_text()


# ---------------------------------------------------------------- the R1Bv predecessor receipt gate (REAL receipts as the fixture)
def test_the_real_merged_history_satisfies_the_r1bv_receipt_gate(tmp_path: Path) -> None:
    result = receipt_gate(world(tmp_path))
    assert result.returncode == 0, result.stderr


def test_exactly_one_real_r1b_failure_closeout_is_truthful_and_unpromoted() -> None:
    found = sorted((REPO / LOGS).glob("*_music_idea3-r1b-live-failure-closeout.md"))
    assert len(found) == 1
    whole = {ln.strip().strip("`-* ").strip("`") for ln in found[0].read_text().splitlines()}
    for want in ("R1B_RESULT=FAIL_IMMUTABLE", "R1B_FAILED_STAGE=windowrecord", "R1B_WINDOW_RECORD=ABSENT", "R1B_RERUN_ALLOWED=NO", "R1BV_REQUIRED=YES"):
        assert want in whole, want
    for never in ("R1B_RESULT=PASS", "R1B_LIVE=CLOSED_PASS", "R1B_WINDOW_RECORD=PRESENT", "R1B_RERUN_ALLOWED=YES", "R1B_FINAL_VERIFIER_REACHED=YES"):
        assert never not in whole, never


@pytest.mark.parametrize("name,change", [
    ("missing R1B failure closeout", {R1B_FAIL: None}),
    ("duplicate R1B failure closeout", {f"{LOGS}/2026-10-06_000000_music_idea3-r1b-live-failure-closeout.md": "COPY"}),
    ("extra bare R1B_RESULT=FAIL_IMMUTABLE receipt", {f"{LOGS}/2026-10-06_000001_music_x.md": "- `R1B_RESULT=FAIL_IMMUTABLE`\n"}),
    ("extra bare R1B_LIVE=CLOSED_FAIL receipt", {f"{LOGS}/2026-10-06_000002_music_x.md": "- `R1B_LIVE=CLOSED_FAIL`\n"}),
    ("R1B PASS history", {f"{LOGS}/2026-10-06_000003_music_x.md": "- `R1B_RESULT=PASS`\n"}),
    ("R1B CLOSED_PASS", {f"{LOGS}/2026-10-06_000004_music_x.md": "- `R1B_LIVE=CLOSED_PASS`\n"}),
    ("bare R1B_RESULT=FAIL", {f"{LOGS}/2026-10-06_000005_music_x.md": "- `R1B_RESULT=FAIL`\n"}),
    ("R1B rerun claim", {f"{LOGS}/2026-10-06_000006_music_x.md": "- `R1B_RERUN_ALLOWED=YES`\n"}),
    ("R1B window record present claim", {f"{LOGS}/2026-10-06_000007_music_x.md": "- `R1B_WINDOW_RECORD=PRESENT`\n"}),
    ("R1B final verifier reached claim", {f"{LOGS}/2026-10-06_000008_music_x.md": "- `R1B_FINAL_VERIFIER_REACHED=YES`\n"}),
    ("R1B rewrite claim", {f"{LOGS}/2026-10-06_000009_music_x.md": "- `R1B_RESULT_REWRITTEN=YES`\n"}),
    ("existing R1Bv PASS closeout", {R1BV_CLOSEOUT_REL: bullet(R1BV_LIVE_FIELDS)}),
    ("R1Bv FAIL closeout", {R1BV_CLOSEOUT_REL: "- `R1BV_RESULT=FAIL`\n"}),
    ("R1Bv live executed claim", {f"{LOGS}/2026-10-06_000010_music_x.md": "- `R1BV_LIVE_EXECUTED=YES`\n"}),
    ("R1Bv retry claim", {f"{LOGS}/2026-10-06_000011_music_x.md": "- `R1BV_IS_R1B_RETRY=YES`\n"}),
    ("R1Bv incident mutation claim", {f"{LOGS}/2026-10-06_000012_music_x.md": "- `R1BV_INCIDENT_MUTATED=YES`\n"}),
    ("R1Bv marker mutation claim", {f"{LOGS}/2026-10-06_000013_music_x.md": "- `R1BV_R1B_MARKER_MUTATED=YES`\n"}),
    ("R1Bv window created claim", {f"{LOGS}/2026-10-06_000014_music_x.md": "- `R1BV_WINDOW_RECORD_CREATED=YES`\n"}),
    ("R1Bv window reconstructed claim", {f"{LOGS}/2026-10-06_000015_music_x.md": "- `R1BV_WINDOW_RECORD_RECONSTRUCTED=YES`\n"}),
    ("R1Bv new external event claim", {f"{LOGS}/2026-10-06_000016_music_x.md": "- `R1BV_NEW_EXTERNAL_EVENT_GENERATED=YES`\n"}),
    ("Recovery executed claim", {f"{LOGS}/2026-10-06_000017_music_x.md": "- `RECOVERY_R2_R8_EXECUTED=YES`\n"}),
    ("F1 promotion claim", {f"{LOGS}/2026-10-06_000018_music_x.md": "- `F1_REAL_DETECTOR_ACCEPTANCE=PROVEN`\n"}),
    ("R1 verified claim", {f"{LOGS}/2026-10-06_000019_music_x.md": "- `R1_VERIFIED=VERIFIED`\n"}),
    ("R1D PASS rewrite", {f"{LOGS}/2026-10-06_000020_music_x.md": "- `R1D_RESULT=PASS`\n"}),
])
def test_the_r1bv_receipt_gate_fails_closed(tmp_path: Path, name: str, change: dict) -> None:
    change = {k: ((REPO / R1B_FAIL).read_text() if v == "COPY" else v) for k, v in change.items()}
    assert receipt_gate(world(tmp_path, **change)).returncode == 1, name


@pytest.mark.parametrize("missing", [f"{LOGS}/{n}" for n in REAL_RECEIPTS])
def test_each_predecessor_receipt_is_load_bearing(tmp_path: Path, missing: str) -> None:
    assert receipt_gate(world(tmp_path, **{missing: None})).returncode == 1


def test_the_r1du_closeout_must_name_the_pinned_release(tmp_path: Path) -> None:
    repo = world(tmp_path)
    result = base.bash(f'. "{LIB}"; r1bv_receipt_gate "{repo}" {"a" * 40} {base.head_of(repo)}')
    assert result.returncode == 1 and "R1BV_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_non_commit_or_wrong_head_fails(tmp_path: Path) -> None:
    repo = world(tmp_path)
    assert base.bash(f'. "{LIB}"; r1bv_receipt_gate "{repo}" {RELEASE} {"b" * 40}').returncode == 1


# ---------------------------------------------------------------- canonical history, corroboration presence
def history(tmp_path: Path, have: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700, exist_ok=True)
    for name in have:
        if not (canon / name).exists():
            (canon / name).write_text("x\n")
    return base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1bv_history_gate')


FULL = ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED", "R1B-GLOBAL-ATTEMPT-CONSUMED")


def test_the_history_gate_requires_every_consumed_marker_and_an_absent_r1b_window(tmp_path: Path) -> None:
    assert history(tmp_path, FULL).returncode == 0
    for name in FULL:
        sub = tmp_path / name
        sub.mkdir()
        r = history(sub, tuple(n for n in FULL if n != name))
        assert r.returncode == 1 and f"R1BV_HISTORY_RECORD_MISSING:{name}" in r.stderr, name
    sub = tmp_path / "window"
    sub.mkdir()
    r = history(sub, (*FULL, "R1B-ATTEMPT-WINDOW"))
    assert r.returncode == 1 and "R1BV_R1B_WINDOW_RECORD_PRESENT" in r.stderr


def test_the_history_gate_never_creates_or_changes_a_governance_record(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    for name in FULL:
        (canon / name).write_text("immutable\n")
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in canon.iterdir()}
    assert history(tmp_path, FULL).returncode == 0
    assert {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in canon.iterdir()} == before
    assert not (canon / "R1B-ATTEMPT-WINDOW").exists()


def test_the_corroboration_presence_gate_never_invents_an_artifact(tmp_path: Path) -> None:
    auth, evid = tmp_path / "auth", tmp_path / "evid"
    (evid / "r1b-work").mkdir(parents=True)
    auth.mkdir()
    def gate() -> subprocess.CompletedProcess[str]:
        return base.bash(f'. "{LIB}"; SUDO=""; r1bv_corroboration_gate "{auth}" "{evid}"')
    assert gate().returncode == 1 and "R1BV_LOCAL_MARKER_MISSING" in gate().stderr
    (auth / "R1B-ATTEMPT-CONSUMED").write_text("x\n")
    assert "R1BV_RUNNER_LOG_MISSING" in gate().stderr
    (evid / "owner-run.log").write_text("x\n")
    assert "R1BV_PRESERVED_BASELINE_MISSING" in gate().stderr
    assert sorted(p.name for p in evid.iterdir()) == ["owner-run.log", "r1b-work"] and list((evid / "r1b-work").iterdir()) == []  # nothing was created
    (evid / "r1b-work" / "r1-baseline.json").write_text("{}")
    assert gate().returncode == 0
    (auth / "R1B-ATTEMPT-CONSUMED").unlink()
    (auth / "real").write_text("x\n")
    os.symlink(auth / "real", auth / "R1B-ATTEMPT-CONSUMED")
    assert gate().returncode == 1  # a symlink is not the local marker


# ---------------------------------------------------------------- Recovery predecessor reconciliation (the reusable gate)
def test_recovery_predecessor_accepts_only_the_unique_r1b_failure_plus_the_unique_r1bv_live_pass(tmp_path: Path) -> None:
    result = recovery_gate(world(tmp_path, closeout=bullet(R1BV_LIVE_FIELDS)))
    assert result.returncode == 0, result.stderr


def test_recovery_predecessor_refuses_r1b_failure_alone_and_r1bv_implementation_alone(tmp_path: Path) -> None:
    alone = recovery_gate(world(tmp_path))
    assert alone.returncode == 1 and "R1BV_RECOVERY_R1BV_CLOSEOUT_MISSING_OR_AMBIGUOUS" in alone.stderr
    (tmp_path / "b").mkdir()
    assert recovery_gate(world(tmp_path / "b", closeout=bullet(R1BV_LIVE_FIELDS), **{R1B_FAIL: None})).returncode == 1  # R1Bv PASS without the R1B failure history


@pytest.mark.parametrize("drop", R1BV_LIVE_FIELDS)
def test_every_r1bv_closeout_field_is_load_bearing_for_recovery(tmp_path: Path, drop: str) -> None:
    assert recovery_gate(world(tmp_path, closeout=bullet(R1BV_LIVE_FIELDS, drop=drop))).returncode == 1, drop


@pytest.mark.parametrize("name,extra", [
    ("R1Bv FAIL result beside PASS in the same file", ("R1BV_RESULT=FAIL",)), ("R1Bv CLOSED_FAIL beside CLOSED_PASS in the same file", ("R1BV_LIVE=CLOSED_FAIL",)),
    ("retry claim", ("R1BV_IS_R1B_RETRY=YES",)), ("not read-only", ("R1BV_READ_ONLY_VALIDATION_ONLY=NO",)), ("incident mutated", ("R1BV_INCIDENT_MUTATED=YES",)),
    ("marker mutated", ("R1BV_R1B_MARKER_MUTATED=YES",)), ("window created", ("R1BV_WINDOW_RECORD_CREATED=YES",)), ("window reconstructed", ("R1BV_WINDOW_RECORD_RECONSTRUCTED=YES",)),
    ("new event", ("R1BV_NEW_EXTERNAL_EVENT_GENERATED=YES",)), ("existing evidence only violated", ("R1BV_EXISTING_R1B_EVIDENCE_ONLY=NO",)), ("R1B rewritten", ("R1B_RESULT_REWRITTEN=YES",)),
    ("R1B PASS", ("R1B_RESULT=PASS",)), ("recovery executed", ("RECOVERY_R2_R8_EXECUTED=YES",)), ("F1 promoted", ("F1_REAL_DETECTOR_ACCEPTANCE=PROVEN",)), ("R1 verified", ("R1_VERIFIED=VERIFIED",)),
])
def test_recovery_predecessor_refuses_contradictory_mutation_or_promotion_claims(tmp_path: Path, name: str, extra: tuple) -> None:
    assert recovery_gate(world(tmp_path, closeout=bullet(R1BV_LIVE_FIELDS, extra=extra))).returncode == 1, name


def test_recovery_predecessor_refuses_duplicate_ambiguous_or_failed_r1bv_closeouts(tmp_path: Path) -> None:
    dup = f"{LOGS}/2026-10-08_110000_music_idea3-r1bv-live-closeout.md"
    assert recovery_gate(world(tmp_path, closeout=bullet(R1BV_LIVE_FIELDS), **{dup: bullet(R1BV_LIVE_FIELDS)})).returncode == 1
    (tmp_path / "f").mkdir()
    failed = f"{LOGS}/2026-10-08_120000_music_idea3-r1bv-live-failure.md"
    assert recovery_gate(world(tmp_path / "f", closeout=bullet(R1BV_LIVE_FIELDS), **{failed: "- `R1BV_RESULT=FAIL`\n"})).returncode == 1  # a failed R1Bv alongside a pass is ambiguity
    (tmp_path / "m").mkdir()
    misnamed = f"{LOGS}/2026-10-08_130000_music_idea3-something.md"
    assert recovery_gate(world(tmp_path / "m", **{misnamed: bullet(R1BV_LIVE_FIELDS)})).returncode == 1  # the closeout must be the canonical NAME
    (tmp_path / "x").mkdir()
    assert recovery_gate(world(tmp_path / "x", closeout=bullet(R1BV_LIVE_FIELDS), **{f"{LOGS}/2026-10-06_000030_music_x.md": "- `R1B_RESULT=FAIL_IMMUTABLE`\n"})).returncode == 1  # an extra bare R1B receipt


def test_the_recovery_gate_is_not_wired_to_a_stage_and_bypasses_nothing() -> None:
    lib = LIB.read_text()
    assert "No Recovery stage exists in this repository yet" in lib and "ONE predecessor, not the whole Recovery gate" in lib or "one predecessor, not the whole Recovery gate" in lib
    assert "recovery" not in " ".join(base.stages()).lower() and "R2" not in re.search(r'readonly P4_STAGES="([^"]*)"', base.P4_LIB.read_text()).group(1)
    assert "r1bv_recovery_predecessor_gate" not in RUNNER.read_text() and "r1bv_recovery_predecessor_gate" not in " ".join((p.read_text() for p in STG.glob("*.sh")))


def test_r1b_acceptance_semantics_and_the_r1b_gate_are_unchanged() -> None:
    acceptance = (ROOT / "aegis_soc/r1_acceptance.py").read_text()
    assert 'raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")' in acceptance and 'groups() != (ip, "detector_alert", "CREATED")' in acceptance and "SKEW_SEC = 2.0" in acceptance
    base_lib = B_LIB.read_text()
    assert "r1b_r1d_history_gate" in base_lib and "r1bv" not in base_lib.lower()


# ---------------------------------------------------------------- verify.sh (stored result) contract
def verify_doc(tmp_path: Path, doc: dict, *, ip: str = "203.0.113.50") -> subprocess.CompletedProcess[str]:
    work = tmp_path / "w"
    work.mkdir(exist_ok=True)
    (work / "R1BV-FINAL-RAN").write_text("x\n")
    (work / "r1bv-result.json").write_text(json.dumps(doc))
    return subprocess.run(["bash", str(STG / "verify.sh")], env={**os.environ, "AEGIS_R1BV_WORK_DIR": str(work), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1BV_EXPECTED_SOURCE_IP": ip}, text=True, capture_output=True)


def good_doc() -> dict:
    from aegis_soc import r1bv_validation as v

    return {"schema": "aegis.idea3.r1bv-result/1", "result": "PASS", "reason": "OK", "expected_source_ip": "203.0.113.50", "attacker_ip": "203.0.113.50", "claims": dict(v.CLAIMS),
            "checks": {"R1BV_CANONICAL_MARKER_TIME_AUTHORITY": "PASS", "R1BV_TIMING_CORROBORATION": "PASS", "R1BV_HISTORICAL_BOUND": "PASS", "R1BV_EXPECTED_SOURCE_BOUND": "PASS", "R1BV_REAL_DETECTOR_CHAIN": "PASS",
                       "R1BV_NEW_INCIDENT_CREATED_SEMANTICS": "PASS", "R1BV_AUDIT_PROVENANCE": "PASS", "R1BV_AUDIT_INTEGRITY": "PASS", "R1BV_WINDOW_RECORD_ABSENT": "YES"},
            "bound": {"lower": 1791259349.358577, "deadline": 1791259949.358577, "observe_seconds": 600, "derivation": "x"}}


def test_verify_accepts_only_the_complete_unpromoted_result_and_never_writes_r1b_pass(tmp_path: Path) -> None:
    ok = verify_doc(tmp_path, good_doc())
    assert ok.returncode == 0 and "R1BV_VERIFY=PASS" in ok.stdout and "R1BV_IS_R1B_RETRY=NO" in ok.stdout and "R1B_RESULT=FAIL_IMMUTABLE" in ok.stdout and "R1B_RESULT_REWRITTEN=NO" in ok.stdout
    assert "R1B_RESULT=PASS" not in ok.stdout and "R1B_LIVE=CLOSED_PASS" not in ok.stdout and "=PROVEN" not in ok.stdout and "R1_VERIFIED=NOT_CLAIMED" in ok.stdout


def test_verify_fails_closed_on_any_altered_field(tmp_path: Path) -> None:
    for i, mutate in enumerate([
        lambda d: d.update(result="FAIL"), lambda d: d.update(schema="x"), lambda d: d["checks"].pop("R1BV_HISTORICAL_BOUND"), lambda d: d["checks"].update(R1BV_HISTORICAL_BOUND="FAIL"),
        lambda d: d["claims"].update(R1_VERIFIED="VERIFIED"), lambda d: d["claims"].update(R1B_RESULT="PASS"), lambda d: d["claims"].update(R1B_RESULT_REWRITTEN="YES"), lambda d: d["claims"].pop("RECOVERY_R2_R8_EXECUTED"),
        lambda d: d.update(attacker_ip="203.0.113.99"), lambda d: d.update(expected_source_ip="203.0.113.99"), lambda d: d["bound"].update(deadline=d["bound"]["deadline"] + 1.0),
        lambda d: d["bound"].update(observe_seconds=601), lambda d: d["checks"].update(R1BV_WINDOW_RECORD_ABSENT="NO"),
    ]):
        doc = good_doc()
        mutate(doc)
        sub = tmp_path / f"c{i}"
        sub.mkdir()
        assert verify_doc(sub, doc).returncode == 1, i
    sub = tmp_path / "ip"
    sub.mkdir()
    assert verify_doc(sub, good_doc(), ip="203.0.113.77").returncode == 1  # the LIVE pin must equal the document's source


# ---------------------------------------------------------------- the observer CLI end to end (in-process; real code, hermetic seams)
def test_the_observer_cli_baseline_then_final_passes_and_a_mutation_between_them_fails(tmp_path: Path, monkeypatch, capsys) -> None:
    import test_r1bv_observer as obs  # the hermetic world builder of the observer suite

    from aegis_soc import r1_acceptance as r1
    from aegis_soc import r1bv_validation as v

    w = obs.build(tmp_path)
    uid = os.getuid()
    real_bound, real_load = v.derive_bound, v.load_baseline
    monkeypatch.setattr(v, "CANONICAL_MARKER", str(w.marker))
    monkeypatch.setattr(v, "derive_bound", lambda marker, **kw: real_bound(marker, owner_uid=uid, trust_root=str(w.tmp), **kw))
    monkeypatch.setattr(v, "load_baseline", lambda path, bound, **kw: real_load(path, bound, owner_uid=uid, **kw))
    monkeypatch.setattr(r1, "service_snapshot", lambda unit, run=None: dict(w.services["core" if unit == r1.CORE_UNIT else "detector"]))
    monkeypatch.setattr(r1, "read_journal", lambda since: copy_journal(w))
    monkeypatch.setattr(v, "_services_now", lambda: {k: dict(x) for k, x in w.services.items()})
    work = tmp_path / "r1b-work"
    work.mkdir(mode=0o700)
    (work / "r1-baseline.json").write_text(json.dumps(w.baseline))
    os.chmod(work / "r1-baseline.json", 0o600)
    common = ["--audit-db", w.db, "--r1b-baseline", str(work / "r1-baseline.json"), "--expected-source-ip", obs.SRC, "--expected-release-id", "rel-1", "--expected-detector-sha256", "a" * 64, "--expected-detector-uid", str(acc_uid()), "--local-marker", str(w.local), "--runner-log", str(w.log)]
    # defaults were bound at definition time: route the module's own defaults through the seams
    monkeypatch.setattr(v, "validate", lambda **kw: orig_validate(services=lambda: {k: dict(x) for k, x in w.services.items()}, journal=lambda s: copy_journal(w), **kw))
    monkeypatch.setattr(v, "fingerprint", lambda **kw: orig_fp(services=lambda: {k: dict(x) for k, x in w.services.items()}, **kw))
    assert v.main(["baseline", *common, "--out", str(tmp_path / "base.json")]) == 0
    assert v.main(["final", *common, "--baseline", str(tmp_path / "base.json"), "--out", str(tmp_path / "result.json")]) == 0
    doc = json.loads((tmp_path / "result.json").read_text())
    assert doc["result"] == "PASS" and doc["claims"] == v.CLAIMS and doc["checks"]["R1BV_WINDOW_RECORD_ABSENT"] == "YES" and doc["bound"]["observe_seconds"] == 600
    assert not (w.marker.parent / v.WINDOW_RECORD_NAME).exists()  # R1Bv never created the window record
    assert sorted(p.name for p in w.marker.parent.iterdir()) == ["R1B-GLOBAL-ATTEMPT-CONSUMED"]  # and nothing else was written beside the marker
    capsys.readouterr()
    # a mutation between the two observations (an audit row appended) fails the FINAL
    import sqlite3

    conn = sqlite3.connect(w.db)
    conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES ('2030-01-01 00:00:00', 'INFO', 'X', 'x', NULL)")
    conn.commit()
    conn.close()
    obs.rechain(w.db)  # a VALID chain: only the no-mutation fingerprint (not the chain) must catch the appended row
    assert v.main(["final", *common, "--baseline", str(tmp_path / "base.json"), "--out", str(tmp_path / "result2.json")]) == 1
    assert "STATE_CHANGED_BETWEEN_VALIDATIONS:audit_max_id" in capsys.readouterr().err and not (tmp_path / "result2.json").exists()


def acc_uid() -> int:
    import test_r1_acceptance as acc

    return acc.UID


def copy_journal(w) -> dict:
    import copy

    return copy.deepcopy(w.journal)


def _orig():
    from aegis_soc import r1bv_validation as v

    return v.validate, v.fingerprint


orig_validate, orig_fp = _orig()


# ---------------------------------------------------------------- the verifier closure (TrustedClock lesson carried over)
R1BV_TOOL = P4 / "r1bv-acceptance/r1bv_verifier_snapshot.py"


def test_the_r1bv_verifier_closure_contains_every_executed_entry_point_and_the_reused_verifier() -> None:
    tool = load(R1BV_TOOL, "snap_r1bv_closure")
    closure = set(tool.closure(ROOT))
    for rel in ("aegis_soc/r1bv_validation.py", "aegis_soc/r1_acceptance.py", "aegis_soc/trusted_time.py", "aegis_soc/production_detector.py", "aegis_soc/recovery_evidence.py", "aegis_soc/ip_containment.py"):
        assert rel in closure, rel
    assert "trusted_time" in tool.ENTRIES and "r1bv_validation" in tool.ENTRIES
    tool.ENTRIES = (tool.ENTRY,)  # negative control: an observer-only root is what omitted trusted_time in the R1D failure
    assert "aegis_soc/r1bv_validation.py" in set(tool.closure(ROOT))


def test_the_r1bv_verifier_gate_requires_the_reused_verifier_and_clock_in_the_snapshot() -> None:
    text = LIB.read_text()
    for rel in ("r1bv_validation.py", "r1_acceptance.py", "production_detector.py", "recovery_evidence.py", "ip_containment.py", "trusted_time.py"):
        assert f"$snap/aegis_soc/{rel}" in text, rel
    assert "R1BV_VERIFIER_CLOSURE_INCOMPLETE" in text


# ---------------------------------------------------------------- no claim promotion from the repository implementation
def test_the_repository_implementation_promotes_no_claim_and_creates_no_authorization() -> None:
    from aegis_soc import r1bv_validation as v

    assert v.CLAIMS == {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO", "RECOVERY_R2_R8_EXECUTED": "NO", "R1B_RESULT": "FAIL_IMMUTABLE",
                        "R1B_RESULT_REWRITTEN": "NO", "R1BV_IS_R1B_RETRY": "NO"}
    # (history: at the implementation merge no LIVE closeout existed; the LIVE closeout is now recorded and checked by tests/r1bv/test_r1bv_live_closeout.py)
    for path in [f for f in FILES if f != LIB] + [P4 / "r1bv-acceptance/r1bv_runner_freeze.py"]:  # the library only LISTS these as refused claims (covered by the gate tests)
        text = path.read_text()
        for never in ("R1B_RESULT=PASS", "R1B_LIVE=CLOSED_PASS"):
            assert never not in text.replace("R1B_RESULT=PASS R1B_RESULT=FAIL", ""), (path.name, never)
    assert not (P4 / "stages/R1Bv/authorization-R1Bv.txt").exists() and not list(P4.glob("**/authorization-R1Bv*"))


# ---------------------------------------------------------------- the handler's own guards (no root, no live authorization, no override of the work area)
def run_apply(env: dict[str, str], *, root: bool = False) -> subprocess.CompletedProcess[str]:
    cmd = ["bash", str(STG / "apply.sh")]
    if root:
        cmd = ["unshare", "-r", *cmd]
    return subprocess.run(cmd, env={"PATH": os.environ["PATH"], **env}, text=True, capture_output=True)


def test_the_handler_refuses_without_live_authorization_without_root_and_without_a_work_dir(tmp_path: Path) -> None:
    assert "LIVE_AUTHORIZATION_REQUIRED" in run_apply({}).stderr
    assert "ROOT_REQUIRED" in run_apply({"AEGIS_R1BV_LIVE_AUTHORIZED": "YES"}).stderr
    if base.needs_userns.args[0] is False:  # user namespaces available: reach the next guards as a namespace root
        assert "WORK_DIR_REQUIRED" in run_apply({"AEGIS_R1BV_LIVE_AUTHORIZED": "YES"}, root=True).stderr
        work = tmp_path / "w"
        work.mkdir()
        assert "APP_DIR_INVALID" in run_apply({"AEGIS_R1BV_LIVE_AUTHORIZED": "YES", "AEGIS_R1BV_WORK_DIR": str(work), "AEGIS_R1BV_APP_DIR": str(tmp_path)}, root=True).stderr


def test_the_handler_creates_nothing_before_every_guard_has_passed(tmp_path: Path) -> None:
    work = tmp_path / "w"
    work.mkdir()
    run_apply({"AEGIS_R1BV_LIVE_AUTHORIZED": "YES", "AEGIS_R1BV_WORK_DIR": str(work), "AEGIS_R1BV_STEP": "BASELINE"})
    assert list(work.iterdir()) == []  # no step marker, no evidence, no governance record from a refused invocation


# ---------------------------------------------------------------- I4: every positive R1Bv live-result claim must be in the ONE canonical closeout
@pytest.mark.parametrize("claim", ["R1BV_LIVE_EXECUTED=YES", "R1BV_VERIFY=PASS", "R1BV_RESULT=PASS", "R1BV_LIVE=CLOSED_PASS", "R1BV_HISTORICAL_BOUND=PASS", "R1BV_REAL_DETECTOR_CHAIN=PASS", "R1BV_AUDIT_INTEGRITY=PASS", "R1BV_COMPARE_RESULT=PASS"])
def test_a_valid_canonical_closeout_plus_an_extra_bare_positive_claim_is_ambiguous(tmp_path: Path, claim: str) -> None:
    extra = {f"{LOGS}/2026-10-08_140000_music_idea3-notes.md": f"- `{claim}`\n"}
    assert recovery_gate(world(tmp_path, closeout=bullet(R1BV_LIVE_FIELDS), **extra)).returncode == 1, claim
    (tmp_path / "ctl").mkdir()
    assert recovery_gate(world(tmp_path / "ctl", closeout=bullet(R1BV_LIVE_FIELDS))).returncode == 0  # control: the canonical closeout alone is accepted


def test_successful_r1bv_fields_split_across_files_are_refused(tmp_path: Path) -> None:
    half = len(R1BV_LIVE_FIELDS) // 2
    change = {R1BV_CLOSEOUT_REL: bullet(R1BV_LIVE_FIELDS[:half]), f"{LOGS}/2026-10-08_150000_music_idea3-r1bv-live-closeout-part2.md": bullet(R1BV_LIVE_FIELDS[half:])}
    assert recovery_gate(world(tmp_path, **change)).returncode == 1
    (tmp_path / "m").mkdir()
    assert recovery_gate(world(tmp_path / "m", **{f"{LOGS}/2026-10-08_160000_music_idea3-r1bv-misnamed.md": bullet(R1BV_LIVE_FIELDS)})).returncode == 1  # a complete but MISNAMED closeout


def test_the_receipt_gate_for_a_live_preparation_also_refuses_any_positive_r1bv_claim(tmp_path: Path) -> None:
    for claim in ("R1BV_VERIFY=PASS", "R1BV_LIVE_EXECUTED=YES", "R1BV_RESULT=PASS"):
        sub = tmp_path / claim.split("=")[0]
        sub.mkdir()
        assert receipt_gate(world(sub, **{f"{LOGS}/2026-10-08_170000_music_x.md": f"- `{claim}`\n"})).returncode == 1, claim


# ---------------------------------------------------------------- I1: the snapshot detector is the pinned production detector
def test_the_verifier_gate_binds_the_snapshot_production_detector_to_the_pinned_digest() -> None:
    text = LIB.read_text()
    assert 'sha256sum "$snap/aegis_soc/production_detector.py"' in text and "R1BV_SNAPSHOT_DETECTOR_NOT_THE_PINNED_PRODUCTION_DETECTOR" in text
    gate_src = extract(text, "r1bv_verifier_gate() {", "\n}") if False else text[text.index("r1bv_verifier_gate() {"):text.index("r1bv_interpreter_gate() {")]
    assert gate_src.index("NOT_THE_PINNED_PRODUCTION_DETECTOR") < gate_src.index("R1BV_VERIFIER_CLOSURE_INCOMPLETE")


def test_a_snapshot_whose_production_detector_differs_from_the_pin_fails_and_the_matching_digest_passes(tmp_path: Path) -> None:
    import hashlib

    snap = tmp_path / "snap"
    (snap / "aegis_soc").mkdir(parents=True)
    detector = snap / "aegis_soc/production_detector.py"
    detector.write_text("# detector\n")
    line = next(ln.strip() for ln in LIB.read_text().split("\n") if 'sha256sum "$snap/aegis_soc/production_detector.py"' in ln)  # the exact production line
    good = hashlib.sha256(detector.read_bytes()).hexdigest()

    def check(pin: str) -> subprocess.CompletedProcess[str]:
        return base.bash(f'r1bv_reason() {{ printf "%s\\n" "$1" >&2; return 1; }}; f() {{ snap="{snap}"; det="{pin}"; {line}; echo MATCH; }}; f')

    assert "MATCH" in check(good).stdout
    bad = check("0" * 64)
    assert "MATCH" not in bad.stdout and "R1BV_SNAPSHOT_DETECTOR_NOT_THE_PINNED_PRODUCTION_DETECTOR" in bad.stderr
    detector.write_text("# tampered detector\n")  # the snapshot bytes change, the pin does not
    assert "MATCH" not in check(good).stdout


def text_between(text: str, start: str, end: str) -> str:
    a = text.index(start)
    line_start = text.rfind("\n", 0, a) + 1
    b = text.index(end, a)
    return text[line_start:b].rstrip()


def test_the_frozen_identity_pins_are_load_bearing_not_dead_authority() -> None:
    runner, apply_sh = RUNNER.read_text(), (STG / "apply.sh").read_text()
    for pin, env in (("RELEASE_ID", "AEGIS_R1BV_RELEASE_ID"), ("PRODUCTION_DETECTOR_SHA256", "AEGIS_R1BV_DETECTOR_SHA256"), ("DETECTOR_UID", "AEGIS_R1BV_DETECTOR_UID")):
        assert f'{env}="${pin}"' in runner, pin  # the frozen runner pin reaches the handler environment
    for flag in ("--expected-release-id", "--expected-detector-sha256", "--expected-detector-uid"):
        assert flag in apply_sh
    obs = OBSERVER.read_text()
    assert 'baseline["release_id"] != expected["release_id"]' in obs and 'baseline["detector_sha256"] != expected["detector_sha256"]' in obs and "baseline[\"detector_uid\"] != expected[\"detector_uid\"]" in obs
    assert "DETECTOR_UID" in re.sub(r"^DETECTOR_UID=.*$|^\[\[ \"\$DETECTOR_UID\".*$", "", runner, flags=re.M)  # used beyond its definition and syntax check


# ---------------------------------------------------------------- M2: no stale "R1Bv not implemented" current-state wording
def current_sections(path: Path):
    out, head, buf = [], "", []
    for line in path.read_text().split("\n"):
        if line.startswith("## "):
            out.append((head, "\n".join(buf)))
            head, buf = line, []
        else:
            buf.append(line)
    out.append((head, "\n".join(buf)))
    return out


def test_no_current_state_text_says_r1bv_is_not_implemented() -> None:
    stale = re.compile(r"R1Bv[^.\n]{0,80}(NOT implemented|not implemented)|R1BV_REPOSITORY_IMPLEMENTED=NO", re.I)
    vault = REPO / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3"
    bad = []
    for path in (vault / "idea3-status.md", vault / "idea3-moc.md", P4 / "README.md"):
        for head, body in current_sections(path):
            text = head + "\n" + body
            for m in stale.finditer(text):
                around = text[max(0, m.start() - 250):m.end() + 250].lower()
                opening = (head + "\n" + body[:900]).lower()
                if not (("historical" in around or "superseded" in around or "since implemented" in around or "has since" in around) and ("historical" in opening or "superseded" in opening)):
                    bad.append((path.name, head[:70], m.group(0)[:70]))
    assert not bad, bad
    status = (vault / "idea3-status.md").read_text()
    assert "R1BV_REPOSITORY_IMPLEMENTED=YES" in status[:status.index("## IDEA3 R1B LIVE")] and "R1BV_LIVE_EXECUTED=NO" in status[:status.index("## IDEA3 R1B LIVE")]
    readme = (P4 / "README.md").read_text()
    assert "R1BV_REPOSITORY_IMPLEMENTED=YES" in readme[readme.index("## 22. Stage R1Bv"):]


# ---------------------------------------------------------------- M1: the design spec matches the owner-approved successor history (no legacy R1B PASS path)
def test_the_design_spec_has_only_the_failure_plus_r1bv_pass_recovery_history() -> None:
    spec = (ROOT / "docs/superpowers/specs/2026-10-06-idea3-r1bv-successor-validation-design.md").read_text()
    section = spec[spec.index("## 10."):]
    assert "PATH A" not in section and "PATH B" not in section and "legacy R1B LIVE PASS" not in section
    assert "There is no legacy R1B PASS path and none is added" in section and "exactly ONE accepted successor history" in section
    assert "R1BV_AUDIT_INTEGRITY" in spec and "does NOT verify the audit hash chain" in spec
    gate = LIB.read_text()
    body = gate[gate.index("r1bv_recovery_predecessor_gate() {"):gate.index("# ---- host gates")]
    assert "legacy" not in body.lower() and "R1B_RESULT=PASS" in body  # R1B PASS appears only as a REFUSED claim
