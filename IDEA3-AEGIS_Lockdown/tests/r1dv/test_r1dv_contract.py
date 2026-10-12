"""R1Dv contract: a NON-MUTATING successor validation of the committed R1D disposition (NOT an R1D retry). Registry, stage gate, runner/handler safety by construction (no socket, no caller, no DISPOSE, no marker, no write),
the predecessor receipt gate, the immutable R1D failure closeout, the TrustedClock snapshot repair and an end-to-end run through the real handlers and the real read-only observer. Hermetic: user namespace and
temporary seams only; no host path, socket or database is touched."""

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
import test_r1dv_stage as base  # noqa: E402

from aegis_soc import config  # noqa: E402
from aegis_soc import database as db  # noqa: E402
from aegis_soc import historical_disposition as hd  # noqa: E402
from aegis_soc import local_restore as lr  # noqa: E402

ROOT, P4, STG, LIB, RUNNER, LOGS = base.ROOT, base.P4, base.STG, base.LIB, base.RUNNER, base.LOGS
OBSERVER = ROOT / "aegis_soc/historical_validation.py"
FILES = [LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", OBSERVER]
RELEASE = "ebffab6f8a6d7d98973fac7e89167352d529a87e"
UID, IP = 987, "203.0.113.9"
ROOT_PEER = lr.Peer(uid=0, pid=1234)
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
def test_r1dv_is_registered_exactly_once_between_r1d_and_r1b_and_is_non_mutating() -> None:
    order = base.stages()
    assert order.count("R1Dv") == 1 and order.index("R1Du") < order.index("R1D") < order.index("R1Dv") < order.index("R1B") < order.index("R1Bv") < order.index("L8")
    assert order[order.index("R1D") + 1] == "R1Dv" and order[order.index("R1Dv") + 1] == "R1B"
    out = base.bash(f'. "{base.P4_LIB}"; p4_stage_known R1Dv && echo KNOWN; p4_stage_mutates R1Dv && echo MUTATES || echo NON_MUTATING; p4_stage_gaps R1Dv; echo "extra=[$(p4_stage_auth_extra R1Dv)]"; p4_stage_handler_status R1Dv').stdout.split("\n")
    assert out[0] == "KNOWN" and out[1] == "NON_MUTATING" and out[2] == "none" and out[3] == "extra=[]" and out[4] == "REGISTERED"
    assert "MUTATES" in base.bash(f'. "{base.P4_LIB}"; p4_stage_mutates R1D && echo MUTATES; p4_stage_mutates L0 || echo L0_READONLY').stdout  # R1D (and every other stage) stays mutating
    assert "readonly P4_STAGES=" in base.P4_LIB.read_text() and "R1Du R1D R1Dv R1B" in base.P4_LIB.read_text()


def test_documented_operational_order_names_r1dv_between_r1d_and_r1b() -> None:
    assert "R1D (immutable FAIL after a committed disposition) -> R1Dv -> R1B (immutable FAIL at windowrecord) -> R1Bv -> Recovery R2-R8" in base.P4_LIB.read_text()
    readme = (P4 / "README.md").read_text()
    assert "R1D (immutable FAIL after a COMMITTED disposition) -> R1Dv -> R1B -> Recovery R2-R8" in readme


def gate_record(tmp_path: Path, **over: str) -> Path:
    today = subprocess.run(["date", "+%F"], env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]}, text=True, capture_output=True).stdout.strip()
    fields = {"stage": "R1Dv", "date": today, "authorizer": "music", "scope": "R1Dv: read-only validation of the committed R1D disposition; no mutation", "reference": "OWNER-AUTHORIZATION-R1DV.txt", **over}
    path = tmp_path / "authorization-R1Dv.txt"
    path.write_text("AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None))
    return path


def stage_gate(auth: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(P4 / "p4-stage-gate.sh"), "--stage", "R1Dv", "--mode", "live", "--authorization", str(auth), *extra], env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]},
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
def test_no_r1dv_path_can_reach_the_r1d_socket_the_caller_or_a_dispose_step() -> None:
    for path in FILES:
        text = code(path)
        for forbidden in ("historical-disposition.sock", "r1d_dispose_call", "r1dv_dispose_call", "DISPOSE", "dispose_historical", "AF_UNIX", "socat", "nc ", "r1dv_hook_dispose", "HistoricalDispositionServer", "record_attempt"):
            assert not re.search(r"(?<![A-Za-z_])" + re.escape(forbidden) + r"(?![A-Za-z_])", text) if forbidden == "DISPOSE" else forbidden not in text, (path.name, forbidden)
    assert not list((P4 / "r1dv-acceptance").glob("*dispose*"))  # no caller ships with the R1Dv tooling


def test_no_r1dv_path_creates_a_marker_a_consumption_record_or_a_one_shot() -> None:
    for path in FILES:
        text = code(path)
        for forbidden in ("R1DV-GLOBAL-ATTEMPT-CONSUMED", "R1DV-ATTEMPT-CONSUMED", "r1dv_consume_attempt", "r1dv_run_attempt", "r1dv_attempt_unconsumed", "chattr", "r1dv_durable", "r1dv_fsync", "ATTEMPT_STARTED"):
            assert forbidden not in text, (path.name, forbidden)
    for path in (RUNNER, LIB):
        for line in base.code_lines(path):
            if re.search(r"R1[ABD]-(GLOBAL|ATTEMPT)|R1[ABD]_(MARKER|WINDOW)_NAME", line):
                assert not re.search(r">>?\s*\"?\$|noclobber|\brm\b|\bmv\b|truncate|chattr|install ", line), (path.name, line)  # governance records are only ever READ


def test_no_r1dv_path_writes_sqlite_restarts_a_service_alters_nft_runs_recovery_or_touches_esp32() -> None:
    for path in FILES:
        text = code(path)
        assert not re.search(r"systemctl\s+(start|stop|restart|reload|kill|enable|disable|mask)", text), path.name
        assert not re.search(r"nft\s+(add|delete|flush|destroy|insert|replace|create)", text), path.name
        assert not re.search(r"\b(PROBE|ISOLATE|RESTORE|aegisctl|recovery_client|recovery\.sock|OP_CLOSE|mosquitto_pub|paho|esp32|firmware)\b", text, re.I), path.name
        assert not re.search(r"\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b", text) or path.suffix == ".py" and "mode=ro" in (ROOT / "aegis_soc/historical_disposition.py").read_text(), path.name
        assert "sqlite3.connect(" not in text and "BEGIN IMMEDIATE" not in text, path.name


def test_the_handler_only_opens_the_observer_and_the_rollback_acts_on_nothing() -> None:
    apply_code = code(STG / "apply.sh")
    assert "aegis_soc.historical_validation" in apply_code and "aegis_soc.historical_disposition" not in apply_code and "aegis_soc.r1_acceptance" not in apply_code
    assert re.search(r"case \"\$STEP\" in BASELINE \| FINAL\) ;; \*\) fail STEP_INVALID", apply_code)
    rollback = code(STG / "rollback.sh")
    assert not re.search(r"sqlite|socket|python|sudo|rm |mv |reopen", rollback, re.I) and "R1DV_ROLLBACK=NOTHING_OWNED" in rollback
    assert not (STG / "k3-R1Dv.txt").exists()


def test_the_runner_is_read_only_ordered_and_needs_no_k3() -> None:
    text = RUNNER.read_text()
    assert "authorization-R1Dv.txt" in text and "k3-R1Dv" in text and "a K3 record is not part of the non-mutating R1Dv workflow" in text
    assert "--stage R1Dv --mode live --authorization" in text and "--k3" not in code(RUNNER)
    for needle in ("STAGE_MUTATES_PRODUCTION=NO", "READ_ONLY_CAPTURE_ALLOWED=YES", "BINDING_SHA256", "$RUNNER_SHA256", "$EXPECTED_MAIN"):
        assert needle in text, needle
    seq = text[text.index("echo \"== R1Dv pre-gates"):]
    order = ["pregates ||", "capture PRE", "clock_available \"$PRE\"", "handler BASELINE", "capture POST", "clock_available \"$POST\"", "compare \"$PRE\" \"$POST\"",
             "authority_gates || r1dv_fail authority_before_final", "handler FINAL || r1dv_fail final", "handler FINAL verify.sh"]
    positions = [seq.index(o) for o in order]
    assert positions == sorted(positions), dict(zip(order, positions))
    # the FINAL durable-state observation is the last substantive validation: nothing but verify sits between FINAL and verify
    between = seq[seq.index("handler FINAL || r1dv_fail final"):seq.index("handler FINAL verify.sh")]
    assert not re.search(r"runtime_unchanged|r1dv_r1i_present_gate|capture |compare |authority_gates", between.split("\n", 1)[1]), between
    assert "r1dv_run_attempt" not in text and "r1dv_consume" not in text and "R1DV_IS_R1D_RETRY=NO" in text and "R1DV_ATTEMPT_MARKER_CREATED=NO" in text


def test_the_committed_runner_template_refuses_to_run_unpinned_and_creates_nothing(tmp_path: Path) -> None:
    result = base.bash(f'bash "{RUNNER}" "{tmp_path}"')
    assert result.returncode == 2 and "runner is not pinned" in result.stdout and list(tmp_path.iterdir()) == []
    for pin in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "RELEASE_ID", "BINDING_SHA256", "AUDIT_DB", "DETECTOR_UID"):
        assert f"{pin}=PIN_" in RUNNER.read_text()


def test_the_runner_refuses_environment_overrides_including_the_test_marker_seam(tmp_path: Path) -> None:
    frozen = base.pinned_copy(tmp_path)
    for var in ("AEGIS_P4_FS_ROOT", "AEGIS_R1DV_STEP", "AEGIS_R1DV_TEST_ONLY_MARKER", "AEGIS_R1DV_BINDING_SHA256", "R1DV_CANONICAL_DIR", "R1DV_TEST_ONLY_CANONICAL_DIR_ENABLED"):
        result = base.bash(f'bash "{frozen}" "{tmp_path}"', env={var: "x"})
        assert result.returncode == 2 and "environment override" in result.stdout, var


def test_the_pregates_require_the_original_binding_the_runner_hash_and_exactly_one_authorization() -> None:
    text = RUNNER.read_text()
    pre = text[text.index("pregates() {"):text.index("capture() {")]
    for needle in ("does not name the original R1D binding SHA-256", "does not name this exact runner SHA-256", "carries a field other than stage/date/authorizer/scope/reference", "r1dv_receipt_gate",
                   "r1dv_history_gate", "l7_disk_gate", "l7_idea2_s10_gate", "authority_gates", "r1dv_journal_access_gate", "control_gate"):
        assert needle in pre, needle
    authority = text[text.index("authority_gates() {"):text.index("# ===== PRE-AUTH")]
    for needle in ("r1dv_verifier_gate", "r1dv_interpreter_gate", "r1dv_r1i_present_gate", "r1dv_current_release_gate", "runtime_unchanged", "DETECTOR_UNIT_SHA256", "RECOVERY_CORE_SHA256"):
        assert needle in authority, needle


# ---------------------------------------------------------------- predecessor receipts + history
R1DU_LINES = ("R1DU_LIVE=CLOSED_PASS", "R1DU_LIVE_EXECUTED=YES", "R1DU_PRODUCTION_DEPLOYED=YES", "R1DU_ATTEMPT_CONSUMED=YES", "R1DU_RERUN_ALLOWED=NO", f"R1DU_RELEASE_ID={RELEASE}", "R1DU_R1D_EXECUTED=NO",
              "R1DU_INCIDENT_MUTATED=NO", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")
R1A_LINES = ("R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED",
             "RECOVERY_R2_R8_EXECUTED=NO")
R1I_LINES = ("R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO")
R1D_FAIL_PATH = f"{LOGS}/2026-10-06_073302_music_idea3-r1d-live-failure-closeout.md"


def lines(items, drop=None) -> str:
    return "\n".join(f"- `{x}`" for x in items if x != drop) + "\n"


def repo_with(tmp_path: Path, **change: str | None) -> Path:
    real = (ROOT.parent / R1D_FAIL_PATH).read_text()  # the REAL committed failure closeout is the fixture: the gate must accept exactly what we ship
    files = {
        base.F1_RECEIPT: "- `F1_LIVE_RESULT=PASS`\n- `F1_PRODUCTION_DEPLOYED=YES`\n- `F1_DETECTOR_STARTED=YES`\n",
        base.FOUNDATION: "- `R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES`\n- `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`\n- `R1_VERIFIED=NOT_CLAIMED`\n",
        base.F1U_RECEIPT: "release installed and activated.\nF1u proves deployment only.\n",
        f"{LOGS}/2026-10-06_070624_music_idea3-r1du-live-closeout.md": lines(R1DU_LINES),
        base.R1I_RECEIPT: lines(R1I_LINES), base.R1A_FAIL_RECEIPT: lines(R1A_LINES), R1D_FAIL_PATH: real,
    }
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


def receipt_gate(repo: Path) -> subprocess.CompletedProcess[str]:
    return base.bash(f'. "{LIB}"; r1dv_receipt_gate "{repo}" {RELEASE} {base.head_of(repo)}')


def test_the_real_r1d_failure_closeout_and_the_full_predecessor_history_satisfy_the_r1dv_gate(tmp_path: Path) -> None:
    result = receipt_gate(repo_with(tmp_path))
    assert result.returncode == 0, result.stderr


def test_exactly_one_real_r1d_failure_closeout_exists_and_is_truthful() -> None:
    found = [p for p in (ROOT.parent / LOGS).glob("*_music_idea3-r1d-live-failure-closeout.md")]
    assert len(found) == 1 and found[0].name == Path(R1D_FAIL_PATH).name
    text = found[0].read_text()
    whole = {ln.strip().strip("`-* ").strip("`") for ln in text.splitlines()}
    for want in ("R1D_FAILURE_CLOSEOUT=YES", "R1D_LIVE=CLOSED_FAIL", "R1D_LIVE_EXECUTED=YES", "R1D_ATTEMPT_CONSUMED=YES", "R1D_RERUN_ALLOWED=NO", "R1D_RESULT=FAIL", "R1D_FAILED_STAGE=final",
                 "R1D_CORE_DISPOSITION_CALL=ONCE", "R1D_DISPOSITION_COMMITTED=YES", "R1D_DISPOSITION=DISPOSED", "R1D_INCIDENT_ID=1", "R1D_RECOVERY_R8=NO", "R1D_FINAL=PASS", "R1D_VERIFY=NOT_REACHED",
                 "PRESERVATION_S10=FAIL", "COMPARE_RESULT=FAIL", "FINDINGS_INCOMPARABLE=1", "R1D_FAILURE_REASON=TRUSTEDCLOCK_EVIDENCE_UNAVAILABLE",
                 "R1D_FAILURE_ROOT_CAUSE=R1D_VERIFIER_SNAPSHOT_MISSING_TRUSTED_TIME", "R1D_ATTEMPT_AUDIT_COUNT=1", "R1D_DISPOSITION_AUDIT_COUNT=1", "RECOVERY_R8_CLOSE_COUNT=0", "HISTORICAL_INCIDENT_STATE=CLOSED",
                 "PREEXISTING_OPEN_INCIDENT_COUNT=0", "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES", "R1DV_REQUIRED=YES", "R1B_BLOCKED_UNTIL_R1DV_PASS_AND_CLOSEOUT=YES", "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN",
                 "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO", "RECOVERY_R2_R8_EXECUTED=NO", "R1A_RESULT=FAIL_IMMUTABLE"):
        assert want in whole, want
    for never in ("R1D_RESULT=PASS", "R1D_LIVE=CLOSED_PASS", "R1DV_LIVE=CLOSED_PASS", "R1B_ATTEMPT_CONSUMED=YES", "RECOVERY_R2_R8_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED"):
        assert never not in whole, never
    assert "date: 2026-10-06T07:33:02+07:00" in text and "NOT Recovery R8" in text.replace("is NOT Recovery R8", "NOT Recovery R8")


@pytest.mark.parametrize("change", [
    {R1D_FAIL_PATH: None},
    {f"{LOGS}/2026-10-06_000000_music_idea3-r1d-live-failure-closeout.md": (ROOT.parent / R1D_FAIL_PATH).read_text()},  # a second, duplicate-by-name failure closeout is ambiguous
    {f"{LOGS}/2026-10-06_000001_music_x.md": "- `R1D_RESULT=PASS`\n"},  # an R1D PASS contradicts the immutable FAIL
    {f"{LOGS}/2026-10-06_000002_music_x.md": "- `R1B_ATTEMPT_CONSUMED=YES`\n"},
    {f"{LOGS}/2026-10-06_000003_music_x.md": "- `RECOVERY_R2_R8_EXECUTED=YES`\n"},
    {f"{LOGS}/2026-10-06_000004_music_x.md": "- `R1DV_LIVE=CLOSED_PASS`\n"},  # an R1Dv success is created only AFTER a live run
    {f"{LOGS}/2026-10-06_000005_music_x.md": "- `R1DV_R1D_SOCKET_CONNECTED=YES`\n"},
    {f"{LOGS}/2026-10-06_000006_music_x.md": "- `R1DV_INCIDENT_MUTATED=YES`\n"},
    {f"{LOGS}/2026-10-06_000007_music_x.md": "- `R1DV_DISPOSITION_CREATED=YES`\n"},
])
def test_the_r1dv_receipt_gate_refuses_a_missing_duplicate_contradictory_or_forbidden_state(tmp_path: Path, change: dict) -> None:
    assert receipt_gate(repo_with(tmp_path, **change)).returncode == 1


@pytest.mark.parametrize("missing", [base.F1_RECEIPT, base.FOUNDATION, base.F1U_RECEIPT, base.R1I_RECEIPT, base.R1A_FAIL_RECEIPT, f"{LOGS}/2026-10-06_070624_music_idea3-r1du-live-closeout.md"])
def test_a_missing_predecessor_receipt_fails(tmp_path: Path, missing: str) -> None:
    assert receipt_gate(repo_with(tmp_path, **{missing: None})).returncode == 1


def test_the_r1du_closeout_must_name_the_pinned_release(tmp_path: Path) -> None:
    repo = repo_with(tmp_path)
    result = base.bash(f'. "{LIB}"; r1dv_receipt_gate "{repo}" {"a" * 40} {base.head_of(repo)}')
    assert result.returncode == 1 and "R1DV_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def history(tmp_path: Path, *, have=("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED")) -> subprocess.CompletedProcess[str]:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700, exist_ok=True)
    for name in have:
        if not (canon / name).exists():
            (canon / name).write_text("x\n")
    return base.bash(f'{base.seam(tmp_path)}. "{LIB}"; SUDO=""; r1dv_history_gate')


def test_the_history_gate_requires_r1a_and_the_r1d_marker_and_forbids_r1b(tmp_path: Path) -> None:
    assert history(tmp_path).returncode == 0
    for name in ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED"):
        sub = tmp_path / name
        sub.mkdir()
        r = history(sub, have=tuple(n for n in ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED") if n != name))
        assert r.returncode == 1 and f"R1DV_HISTORY_RECORD_MISSING:{name}" in r.stderr
    for name in ("R1B-GLOBAL-ATTEMPT-CONSUMED", "R1B-ATTEMPT-WINDOW"):
        sub = tmp_path / name
        sub.mkdir()
        r = history(sub, have=("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED", name))
        assert r.returncode == 1 and "R1DV_R1B_ALREADY_BEGUN" in r.stderr


def test_the_history_gate_never_creates_or_changes_a_governance_record(tmp_path: Path) -> None:
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    for name in ("R1A-GLOBAL-ATTEMPT-CONSUMED", "R1A-ATTEMPT-WINDOW", "R1D-GLOBAL-ATTEMPT-CONSUMED"):
        (canon / name).write_text("immutable\n")
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in canon.iterdir()}
    assert history(tmp_path).returncode == 0
    assert {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in canon.iterdir()} == before


# ---------------------------------------------------------------- B. TrustedClock snapshot repair
R1D_TOOL = P4 / "r1d-acceptance/r1d_verifier_snapshot.py"
R1DV_TOOL = P4 / "r1dv-acceptance/r1dv_verifier_snapshot.py"


def load(path: Path, name: str):
    from importlib.util import module_from_spec, spec_from_file_location

    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("path,name", [(R1D_TOOL, "snap_r1d"), (R1DV_TOOL, "snap_r1dv")])
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


@pytest.mark.parametrize("path,name", [(R1D_TOOL, "snap_r1d_run"), (R1DV_TOOL, "snap_r1dv_run")])
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
    for stage in ("R1D", "R1Dv"):
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


def test_an_unavailable_probe_is_recorded_as_unknown_and_the_r1dv_gate_refuses_it(tmp_path: Path, capsys) -> None:
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
    assert clock_ok(tmp_path, f"time.trustedclock.state\t{parsed}\n") is False  # evidence unavailable -> R1Dv refuses


def test_the_clock_gate_fix_does_not_touch_the_comparator_the_allowlists_or_historical_r1d() -> None:
    for stage in ("R1D", "R1Dv"):
        active = [ln for ln in (P4 / "stages" / stage / "allow-keys.txt").read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        assert active == [], stage
    assert not any("UNKNOWN" in ln for ln in (P4 / "p4-compare.sh").read_text().splitlines() if "trustedclock" in ln)
    assert "UNKNOWN" not in "\n".join(l for l in (P4 / "owner-run/run-r1d-owner.sh").read_text().splitlines() if "clock_available" in l)


# ---------------------------------------------------------------- end to end: real handlers + real snapshot + real read-only observer
def committed_db(tmp_path: Path, monkeypatch) -> tuple[Path, str]:
    path = tmp_path / "audit.sqlite3"
    monkeypatch.setattr(config, "DB_PATH", str(path))
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", UID)
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    db.init_db()
    incident = db.create_incident(IP)
    db.log_event_strict("INCIDENT_BOUND", f"attacker_ip={IP} source=detector_alert action=CREATED", db.WARN, incident)
    db.log_event_strict("ALERT_ACCEPTED", f"uid={UID} pid=4321 attacker_ip={IP} action=CREATED", db.INFO, incident)
    binding = hd.read_binding(str(path), UID)["binding_sha256"]
    hd.record_attempt(ROOT_PEER)
    assert hd.HistoricalDispositionService(profile="production", detector_uid=UID).dispose({"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": binding}, ROOT_PEER)["ok"] is True
    return path, binding


def handler_env(tmp_path: Path, snapshot: Path, manifest: str, step: str, audit: Path, binding: str, marker: Path) -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    return {"AEGIS_R1DV_LIVE_AUTHORIZED": "YES", "AEGIS_R1DV_WORK_DIR": str(work), "AEGIS_R1DV_STEP": step, "AEGIS_R1DV_APP_DIR": str(snapshot), "AEGIS_R1DV_VERIFIER_MANIFEST_SHA256": manifest,
            "AEGIS_R1DV_AUDIT_DB": str(audit), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1DV_BINDING_SHA256": binding, "AEGIS_R1DV_TEST_ONLY_MARKER": str(marker)}


def run_step(env: dict[str, str], name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["unshare", "-r", "bash", str(base.apply_copy(env, name=name))], env={**os.environ, **env}, text=True, capture_output=True)


@needs_userns
def test_end_to_end_baseline_final_verify_validates_the_committed_state_and_mutates_nothing(tmp_path: Path, monkeypatch) -> None:
    audit, binding = committed_db(tmp_path, monkeypatch)
    snapshot, manifest = base.make_snapshot(tmp_path)
    assert (snapshot / "aegis_soc/historical_validation.py").is_file() and (snapshot / "aegis_soc/trusted_time.py").is_file()
    marker = tmp_path / "R1D-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("consumed_at=x\n")
    before = audit.read_bytes()
    env = lambda step: handler_env(tmp_path, snapshot, manifest, step, audit, binding, marker)  # noqa: E731
    r = run_step(env("BASELINE"), "b.sh")
    assert r.returncode == 0 and "R1DV_STEP=BASELINE" in r.stdout and "R1DV_MUTATION_BY_HANDLER=NO" in r.stdout, r.stderr
    r = run_step(env("FINAL"), "f.sh")
    assert r.returncode == 0 and "R1DV_STEP=FINAL" in r.stdout, r.stderr
    assert audit.read_bytes() == before  # the database file is byte-identical: nothing was written
    v = subprocess.run(["bash", str(STG / "verify.sh")], env={**os.environ, **env("FINAL")}, text=True, capture_output=True)
    assert v.returncode == 0 and "R1DV_VERIFY=PASS" in v.stdout and "R1DV_IS_R1D_RETRY=NO" in v.stdout and "R1DV_R1D_SOCKET_CONNECTED=NO" in v.stdout and "R1B_ATTEMPT_CONSUMED=NO" in v.stdout, v.stderr
    assert "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in v.stdout and "R1D_RESULT_REWRITTEN=NO" in v.stdout and "R1D_RESULT=PASS" not in v.stdout
    # one-shot step markers live only in the WORK directory; nothing is created beside the governance marker
    assert sorted(p.name for p in marker.parent.iterdir() if p.name.startswith("R1D")) == ["R1D-GLOBAL-ATTEMPT-CONSUMED"]
    assert run_step(env("FINAL"), "f2.sh").returncode == 1  # a step runs once per work directory


@needs_userns
def test_end_to_end_a_not_committed_or_tampered_state_fails_closed(tmp_path: Path, monkeypatch) -> None:
    audit, binding = committed_db(tmp_path, monkeypatch)
    snapshot, manifest = base.make_snapshot(tmp_path)
    marker = tmp_path / "R1D-GLOBAL-ATTEMPT-CONSUMED"
    conn = sqlite3.connect(audit)
    conn.execute("UPDATE incidents SET state='OPEN', closed_at=NULL WHERE id=1")
    conn.commit()
    conn.close()
    marker.write_text("x\n")
    r = run_step(handler_env(tmp_path, snapshot, manifest, "BASELINE", audit, binding, marker), "b.sh")
    assert r.returncode == 1 and "BASELINE_REFUSED" in r.stderr and "HISTORICAL_INCIDENT_NOT_CLOSED" in r.stderr
    marker.unlink()
    r2 = run_step(handler_env(tmp_path / "w2" if (tmp_path / "w2").mkdir() is None else tmp_path, snapshot, manifest, "BASELINE", audit, binding, marker), "b2.sh")
    assert r2.returncode == 1


def test_verify_requires_every_check_and_the_unpromoted_claims(tmp_path: Path) -> None:
    def verify(doc: dict) -> subprocess.CompletedProcess[str]:
        work = tmp_path / "w"
        work.mkdir(exist_ok=True)
        (work / "R1DV-FINAL-RAN").write_text("x\n")
        (work / "r1dv-result.json").write_text(json.dumps(doc))
        return subprocess.run(["bash", str(STG / "verify.sh")], env={**os.environ, "AEGIS_R1DV_WORK_DIR": str(work), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1DV_BINDING_SHA256": "7" * 64}, text=True, capture_output=True)

    good = {"schema": "aegis.idea3.r1dv-result/1", "result": "PASS", "reason": "OK", "original_binding_sha256": "7" * 64,
            "claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"},
            "checks": {"R1D_MARKER": "PRESENT", "R1DV_R1D_ATTEMPT_AUDIT_COUNT": 1, "R1DV_R1D_DISPOSITION_AUDIT_COUNT": 1, "R1DV_RECOVERY_R8_CLOSE_COUNT": 0, "R1DV_HISTORICAL_INCIDENT_STATE": "CLOSED",
                       "PREEXISTING_OPEN_INCIDENT_COUNT": 0, "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED": "YES", "R1DV_ONE_SHOT_INDEX": "PASS", "R1DV_AUDIT_INTEGRITY": "PASS",
                       "R1DV_ORIGINAL_BINDING_IN_DISPOSITION_ROW": "MATCH"}}
    assert verify(good).returncode == 0
    for key in good["checks"]:
        bad = json.loads(json.dumps(good))
        del bad["checks"][key]
        assert verify(bad).returncode == 1, key
    for claim, value in (("F1_REAL_DETECTOR_ACCEPTANCE", "PROVEN"), ("R1_VERIFIED", "VERIFIED"), ("RECOVERY_R1_R8_PROVEN", "YES")):
        bad = json.loads(json.dumps(good))
        bad["claims"][claim] = value
        assert verify(bad).returncode == 1, claim
    wrong = json.loads(json.dumps(good))
    wrong["original_binding_sha256"] = "8" * 64
    assert verify(wrong).returncode == 1


@needs_userns
def test_a_database_change_after_baseline_and_before_the_final_observation_is_refused(tmp_path: Path, monkeypatch) -> None:
    audit, binding = committed_db(tmp_path, monkeypatch)
    snapshot, manifest = base.make_snapshot(tmp_path)
    marker = tmp_path / "R1D-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("x\n")
    env = lambda step: handler_env(tmp_path, snapshot, manifest, step, audit, binding, marker)  # noqa: E731
    assert run_step(env("BASELINE"), "b.sh").returncode == 0
    # the window the old ordering left unobserved: durable state changes after BASELINE (and the generic POST work) but before FINAL
    db.create_incident("203.0.113.77")
    r = run_step(env("FINAL"), "f.sh")
    assert r.returncode == 1 and re.search(r"OPEN_INCIDENTS_PRESENT|INCIDENT_SET_CHANGED_BETWEEN_PRE_AND_POST|HISTORICAL_INCIDENT_NOT_EXACTLY_ONE", r.stderr + r.stdout), (r.stdout, r.stderr)
    assert not (tmp_path / "work/r1dv-result.json").exists() or "PASS" not in (tmp_path / "work/r1dv-result.json").read_text()
