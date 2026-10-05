"""R1D contract: the stage runs only the ONE Core-mediated historical disposition, never Recovery R2-R8, never touches R1A/R1B records or evidence, promotes nothing, and works end to end through the real
handlers, the real read-only observer (from an immutable snapshot) and a real Core-side server. Hermetic: user namespace + temporary seams; no host path is read or written."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_r1d_stage as base  # noqa: E402

from aegis_soc import config  # noqa: E402
from aegis_soc import database as db  # noqa: E402
from aegis_soc import historical_disposition as hd  # noqa: E402

P4, LIB, RUNNER, STG, ROOT = base.P4, base.LIB, base.RUNNER, base.STG, base.ROOT
FILES = [LIB, RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh", P4 / "r1d-acceptance/r1d_dispose_call.py"]
UID, IP = 987, "203.0.113.9"


def code(path: Path) -> str:
    return "\n".join(base.code_lines(path))


# ---- isolation from R1A / R1B / R1I / Recovery ----
def test_r1d_owns_only_its_own_marker_and_never_writes_the_r1a_or_r1b_records() -> None:
    assert 'R1D_GLOBAL_MARKER_NAME="R1D-GLOBAL-ATTEMPT-CONSUMED"' in LIB.read_text()
    for path in FILES:
        for line in base.code_lines(path):
            if re.search(r"R1[AB]-(GLOBAL|ATTEMPT)|R1[AB]_(MARKER|WINDOW)_NAME", line):
                assert not re.search(r">>?\s*\"?\$|noclobber|chattr|\brm\b|\bmv\b|truncate", line), (path.name, line)  # the R1A/R1B names are only ever READ (`test -f`, `test -e`)


def test_no_r1d_code_runs_recovery_probe_isolate_restore_or_close_or_touches_r1i_esp32_mqtt() -> None:
    for path in FILES:
        text = code(path)
        assert not re.search(r"\b(PROBE|ISOLATE|RESTORE|aegisctl|recovery\.sock|recovery_client|OP_CLOSE|mosquitto_pub|paho|mqtt_client|esp32|firmware|blocked_ipv4)\b", text, re.I), path.name
        assert not re.search(r"nft\s+(add|delete|flush|destroy)|systemctl\s+(start|stop|restart|reload|kill|enable|disable)", text), path.name
        assert "RECOVERY_R8_CLOSE" not in text and "INCIDENT_CLOSED" not in text, path.name


def test_the_only_core_call_is_the_stdlib_caller_with_the_binding_and_no_incident_or_address() -> None:
    import ast

    tree = ast.parse((P4 / "r1d-acceptance/r1d_dispose_call.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    caller = ast.unparse(tree)
    assert "binding_sha256" in caller and "DISPOSE_HISTORICAL" in caller
    assert not re.search(r"incident_id|attacker_ip|sqlite3|import database|aegis_soc", caller.replace("int(response['incident_id'])", ""))
    apply = code(STG / "apply.sh")
    assert apply.count("r1d_dispose_call") + apply.count("$CALLER") >= 1 and "sqlite3" not in apply and "UPDATE" not in apply


def test_the_claim_boundary_is_stated_and_nothing_is_promoted() -> None:
    for path in (RUNNER, STG / "verify.sh"):
        text = path.read_text()
        assert "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in text and "R1_VERIFIED=NOT_CLAIMED" in text and "RECOVERY_R1_R8_PROVEN=NO" in text, path.name
    for path in (RUNNER, STG / "apply.sh", STG / "verify.sh", STG / "rollback.sh"):
        for line in base.code_lines(path):
            assert "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN" not in line and "R1_VERIFIED=VERIFIED" not in line and "RECOVERY_R1_R8_PROVEN=YES" not in line and "R1B_ATTEMPT_CONSUMED=YES" not in line, (path.name, line)
    assert "R1D_PROMOTION=NONE" in LIB.read_text() and "R1B_ATTEMPT_CONSUMED=NO" in LIB.read_text()


def test_rollback_is_a_no_op_that_never_reopens_or_retries_the_disposition() -> None:
    body = code(STG / "rollback.sh")
    assert not re.search(r"sqlite|socket|python|sudo|rm |mv |OPEN|reopen", body, re.I)


# ---- the runner binds the owner-authorized digest ----
def test_the_runner_pins_the_binding_and_the_socket_path_is_a_literal() -> None:
    text = RUNNER.read_text()
    assert "BINDING_SHA256=PIN_BINDING_SHA256" in text and "authorization-R1D.txt does not name the owner-authorized binding SHA-256" in text
    assert "AEGIS_R1D_SOCKET=/run/aegis-idea3/historical-disposition.sock" in text and "EXPECTED_SOURCE_IP" not in text and "OBSERVE_SECONDS" not in text
    freeze = (P4 / "r1d-acceptance/r1d_runner_freeze.py").read_text()
    assert '"BINDING_SHA256"' in freeze and '"EXPECTED_SOURCE_IP"' not in freeze and '"OBSERVE_SECONDS"' not in freeze


def test_the_baseline_window_check_precedes_the_marker_and_the_dispose_call_follows_it() -> None:
    text = RUNNER.read_text()
    baseline = text[text.index("r1d_hook_baseline() {"):text.index("r1d_hook_regate() {")]
    assert baseline.index("handler BASELINE") < baseline.index("handler WINDOW")
    lib = LIB.read_text()
    machine = lib[lib.index("r1d_run_attempt() {"):lib.index("r1d_attempt_failed() {")]
    assert machine.index("pregates baseline regate") < machine.index("r1d_consume_attempt") < machine.index("r1d_hook_dispose") < machine.index("r1d_hook_final") < machine.index("r1d_hook_verify")
    assert "r1d_consume_attempt" not in baseline and "R1D-ATTEMPT-CONSUMED" not in baseline


# ---- end to end: real handlers + real observer snapshot + real Core-side server (user namespace) ----
needs_userns = base.needs_userns


def seeded_db(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "audit.sqlite3"
    monkeypatch.setattr(config, "DB_PATH", str(path))
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", UID)
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    db.init_db()
    incident = db.create_incident(IP)
    db.log_event_strict("INCIDENT_BOUND", f"attacker_ip={IP} source=detector_alert action=CREATED", db.WARN, incident)
    db.log_event_strict("ALERT_ACCEPTED", f"uid={UID} pid=4321 attacker_ip={IP} action=CREATED", db.INFO, incident)
    return path


def handler_env(tmp_path: Path, snapshot: Path, manifest: str, step: str, audit: Path, digest: str, sock: str, canon: Path) -> dict[str, str]:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    return {"AEGIS_R1D_LIVE_AUTHORIZED": "YES", "AEGIS_R1D_WORK_DIR": str(work), "AEGIS_R1D_STEP": step, "AEGIS_R1D_APP_DIR": str(snapshot),
            "AEGIS_R1D_VERIFIER_MANIFEST_SHA256": manifest, "AEGIS_R1D_AUDIT_DB": str(audit), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1D_BINDING_SHA256": digest,
            "AEGIS_R1D_DETECTOR_UID": str(UID), "AEGIS_R1D_CALLER": str(P4 / "r1d-acceptance/r1d_dispose_call.py"), "AEGIS_R1D_SOCKET": sock, "AEGIS_R1D_TEST_ONLY_SOCKET": "YES",
            "AEGIS_R1D_CANONICAL_DIR": str(canon), "AEGIS_R1D_TEST_ONLY_CANONICAL": "YES"}


@needs_userns
def test_end_to_end_baseline_window_dispose_final_verify_through_the_real_pieces(tmp_path: Path, monkeypatch) -> None:
    import time

    audit = seeded_db(tmp_path, monkeypatch)
    digest = hd.read_binding(str(audit), UID)["binding_sha256"]
    snapshot, manifest = base.make_snapshot(tmp_path)
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    now = time.time()
    (canon / "R1A-ATTEMPT-WINDOW").write_text(f"window_start={now - 60}\nwindow_end={now + 60}\nobserve_seconds=120\n")
    short = Path(os.environ.get("TMPDIR", "/tmp")) / f"r1de2e-{os.getpid()}"
    short.mkdir(mode=0o755, exist_ok=True)
    sock = short / hd.CHANNEL_NAME
    server = hd.HistoricalDispositionServer(sock, hd.HistoricalDispositionService(profile="production", detector_uid=UID, required_peer_uid=os.geteuid()), allowed_uid=os.geteuid())

    def run(step: str, script: str = "apply.sh") -> subprocess.CompletedProcess[str]:
        env = handler_env(tmp_path, snapshot, manifest, step, audit, digest, str(sock), canon)
        copy = base.apply_copy(env, name=f"{script}-{step}.sh") if script == "apply.sh" else None
        if copy is None:
            text = re.sub(r"^SNAPSHOT_OWNER_UID=0$", "SNAPSHOT_OWNER_UID=0", (STG / script).read_text(), flags=re.M)
            copy = tmp_path / f"{script}-{step}.sh"
            copy.write_text(text)
        return subprocess.run(["unshare", "-r", "bash", str(copy)], env={**os.environ, **env}, text=True, capture_output=True)

    before = audit.read_bytes()
    r = run("BASELINE")
    assert r.returncode == 0 and "R1D_STEP=BASELINE" in r.stdout, r.stderr
    assert audit.read_bytes() == before  # the observer is read-only
    r = run("WINDOW")
    assert r.returncode == 0 and "R1A_WINDOW_COMPATIBLE=YES" in r.stdout, r.stderr
    server.start()
    try:
        r = run("DISPOSE")
        assert r.returncode == 0 and "R1D_DISPOSITION=DISPOSED" in r.stdout and "R1D_RECOVERY_R8=NO" in r.stdout, (r.stdout, r.stderr)
        for _ in range(50):
            if server.finished():
                break
            threading.Event().wait(0.1)
        assert server.finished() and not sock.exists()  # the channel is dead after the one success
    finally:
        server.close()
    conn = sqlite3.connect(audit)
    assert conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0] == 0
    conn.close()
    r = run("FINAL")
    assert r.returncode == 0, r.stderr
    verify_env = handler_env(tmp_path, snapshot, manifest, "FINAL", audit, digest, str(sock), canon)
    v = subprocess.run(["bash", str(STG / "verify.sh")], env={**os.environ, **verify_env}, text=True, capture_output=True)
    assert v.returncode == 0 and "R1D_VERIFY=PASS" in v.stdout and "PREEXISTING_OPEN_INCIDENT_COUNT=0" in v.stdout and "R1B_ATTEMPT_CONSUMED=NO" in v.stdout, (v.stdout, v.stderr)
    assert "R1D_PROMOTION=NONE" in v.stdout and "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in v.stdout
    # the step markers make every step one-shot per work directory (no verifier/Core-call retry, ever)
    assert run("DISPOSE").returncode == 1


@needs_userns
def test_the_dispose_step_refuses_a_non_literal_socket_path_and_a_wrong_caller_without_the_test_seam(tmp_path: Path, monkeypatch) -> None:
    audit = seeded_db(tmp_path, monkeypatch)
    digest = hd.read_binding(str(audit), UID)["binding_sha256"]
    snapshot, manifest = base.make_snapshot(tmp_path)
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    env = handler_env(tmp_path, snapshot, manifest, "BASELINE", audit, digest, "/tmp/x/historical-disposition.sock", canon)
    assert subprocess.run(["unshare", "-r", "bash", str(base.apply_copy(env, name="b.sh"))], env={**os.environ, **env}, text=True, capture_output=True).returncode == 0
    env = handler_env(tmp_path, snapshot, manifest, "DISPOSE", audit, digest, "/tmp/x/historical-disposition.sock", canon)
    env.pop("AEGIS_R1D_TEST_ONLY_SOCKET")
    result = subprocess.run(["unshare", "-r", "bash", str(base.apply_copy(env, name="d.sh"))], env={**os.environ, **env}, text=True, capture_output=True)
    assert result.returncode == 1 and "SOCKET_PATH_REFUSED" in result.stderr


def test_verify_requires_the_attempt_row_and_the_one_shot_index_in_the_observer_result(tmp_path: Path) -> None:
    def verify(checks: dict) -> subprocess.CompletedProcess[str]:
        work = tmp_path / "w"
        work.mkdir(exist_ok=True)
        (work / "R1D-FINAL-RAN").write_text("x\n")
        doc = {"schema": "aegis.idea3.r1d-result/1", "result": "PASS", "reason": "OK", "binding_sha256": "7" * 64,
               "claims": {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}, "checks": checks}
        (work / "r1d-result.json").write_text(json.dumps(doc))
        return subprocess.run(["bash", str(STG / "verify.sh")], env={**os.environ, "AEGIS_R1D_WORK_DIR": str(work), "AEGIS_PYTHON_BIN": sys.executable, "AEGIS_R1D_BINDING_SHA256": "7" * 64},
                              text=True, capture_output=True)

    good = {"PREEXISTING_OPEN_INCIDENT_COUNT": 0, "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED": "YES", "R1B_ATTEMPT_CONSUMED": "NO", "DISPOSITION_AUDIT_ROW": "ONE",
            "ATTEMPT_ROW": "ONE", "ONE_SHOT_INDEX": "EXPECTED_DEFINITION", "HASH_CHAIN": "VALID", "RECOVERY_R8_FABRICATED": "NO"}
    assert verify(good).returncode == 0
    for drop in ("ATTEMPT_ROW", "ONE_SHOT_INDEX"):
        assert verify({k: v for k, v in good.items() if k != drop}).returncode == 1, drop


def test_the_declared_mutation_set_is_stated_in_the_runner_handler_and_docs() -> None:
    for path in (RUNNER, STG / "apply.sh"):
        assert "ux_audit_historical_disposition" in path.read_text() or "one-shot partial unique index" in path.read_text(), path.name
    readme = (P4 / "README.md").read_text()
    section = readme[readme.index("## 19. Stages R1Du and R1D"):]
    assert "ux_audit_historical_disposition" in section and "R1D_DISPOSITION_ATTEMPT_RECORDED" in section and "R1D LIVE PASS closeout" in section
