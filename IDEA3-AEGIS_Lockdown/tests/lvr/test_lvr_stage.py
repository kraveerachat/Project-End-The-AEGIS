"""Comprehensive executable tests for LVR (post-Recovery read-only acceptance stage).

Covers:
- Stage definition and registry in p4-lib.sh
- Fresh LVR Authorization and K3 governance in p4-stage-gate.sh
- Cross-stage reuse / replay rejection
- Recovery -> LVR predecessor closeout gate (ancestry, uniqueness, regularity)
- Recovery canonical marker gate
- LVR runtime acceptance verifier (positive and negative controls)
- Stage handlers (apply.sh, rollback.sh, verify.sh)
- Safety by construction (no Production mutation)
- Canonical LVR closeout contract validation
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
P4 = ROOT / "deploy/pr11-phase4"
P4_LIB = P4 / "p4-lib.sh"
STAGE_GATE = P4 / "p4-stage-gate.sh"
LVR_LIB = P4 / "p4-lvr-run-lib.sh"
LVR_VERIFY_PY = P4 / "p4-lvr-runtime-verify.py"
STG_LVR = P4 / "stages/LVR"


def bash(cmd: str, **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", cmd],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "LC_ALL": "C", "TZ": "Asia/Bangkok"},
        **kwargs,
    )


def test_lvr_registry_properties() -> None:
    res = bash(f'. "{P4_LIB}"; p4_stage_known LVR && echo KNOWN; p4_stage_mutates LVR && echo MUTATES || echo NON_MUTATING; p4_stage_requires_k3 LVR && echo REQUIRES_K3; p4_stage_gaps LVR; echo "extra=[$(p4_stage_auth_extra LVR)]"; p4_stage_handler_status LVR')
    assert res.returncode == 0
    lines = res.stdout.strip().splitlines()
    assert lines[0] == "KNOWN"
    assert lines[1] == "NON_MUTATING"
    assert lines[2] == "REQUIRES_K3"
    assert lines[3] == "none"
    assert lines[4] == "extra=[expected_main frozen_runner_sha256 operator_user operator_uid recovery_execution_main]"
    assert lines[5] == "REGISTERED"


def test_lvr_stage_order_in_p4_stages() -> None:
    text = P4_LIB.read_text()
    stages = next(line for line in text.splitlines() if line.startswith("readonly P4_STAGES=")).split('"')[1].split()
    assert stages.count("LVR") == 1
    assert stages[stages.index("CTu") + 1] == "Recovery"
    assert stages[stages.index("Recovery") + 1] == "LVR"
    assert stages[stages.index("LVR") + 1] == "L8"
    assert stages[stages.index("L8") + 1] == "L9"


# ---------------------------------------------------------------------------
# Authorization and K3 Gate Tests
# ---------------------------------------------------------------------------

def make_auth(tmp: Path, **overrides) -> Path:
    today = time.strftime("%Y-%m-%d", time.localtime())
    fields = {
        "stage": "LVR",
        "date": today,
        "authorizer": "music",
        "scope": "READ_ONLY_LVR_ACCEPTANCE",
        "reference": "REQ-LVR-01",
        "expected_main": "a" * 40,
        "frozen_runner_sha256": "b" * 64,
        "operator_user": "operator_test",
        "operator_uid": "1001",
        "recovery_execution_main": "c" * 40,
    }
    fields.update(overrides)
    p = tmp / "authorization-LVR.txt"
    lines = ["AEGIS_P4_AUTHORIZATION_V1"]
    for k, v in fields.items():
        if v is not None:
            lines.append(f"{k}={v}")
    p.write_text("\n".join(lines) + "\n")
    return p


def make_k3_v1(tmp: Path, **overrides) -> Path:
    today = time.strftime("%Y-%m-%d", time.localtime())
    fields = {
        "stage": "LVR",
        "date": today,
        "confirmed_by": "kraveerachat",
        "idea1_window_overlap": "NONE",
        "reference": "REF-K3-01",
    }
    fields.update(overrides)
    p = tmp / "k3-LVR.txt"
    lines = ["AEGIS_P4_K3_CONFIRMATION_V1"]
    for k, v in fields.items():
        if v is not None:
            lines.append(f"{k}={v}")
    p.write_text("\n".join(lines) + "\n")
    return p


def make_k3_v2(tmp: Path, **overrides) -> Path:
    today = time.strftime("%Y-%m-%d", time.localtime())
    fields = {
        "stage": "LVR",
        "date": today,
        "confirmed_by": "music",
        "confirmation_mode": "IDEA3_OWNER_SELF_ATTESTATION",
        "idea1_window_overlap": "NONE_KNOWN",
        "reference": "REF-K3-02",
    }
    fields.update(overrides)
    p = tmp / "k3-LVR.txt"
    lines = ["AEGIS_P4_K3_CONFIRMATION_V2"]
    for k, v in fields.items():
        if v is not None:
            lines.append(f"{k}={v}")
    p.write_text("\n".join(lines) + "\n")
    return p


def test_stage_gate_passes_with_valid_auth_and_k3_v1(tmp_path: Path) -> None:
    auth = make_auth(tmp_path)
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 0
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout
    assert "K3_CONFIRMATION=VALID" in res.stdout
    assert "STAGE_MUTATES_PRODUCTION=NO" in res.stdout
    assert "READ_ONLY_CAPTURE_ALLOWED=YES" in res.stdout
    assert "STAGE_GATE=PASS_READ_ONLY" in res.stdout
    assert "ROLLBACK_HANDLER=NOT_APPLICABLE" in res.stdout


def test_stage_gate_passes_with_valid_auth_and_k3_v2(tmp_path: Path) -> None:
    auth = make_auth(tmp_path)
    k3 = make_k3_v2(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 0
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout
    assert "K3_CONFIRMATION=VALID" in res.stdout
    assert "STAGE_GATE=PASS_READ_ONLY" in res.stdout


def test_stage_gate_fails_when_auth_missing(tmp_path: Path) -> None:
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_MISSING" in res.stdout


def test_stage_gate_fails_when_k3_missing(tmp_path: Path) -> None:
    auth = make_auth(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}"')
    assert res.returncode == 1
    assert "GATE_FAIL K3_MISSING" in res.stdout


def test_stage_gate_fails_on_stage_mismatch_in_auth(tmp_path: Path) -> None:
    auth = make_auth(tmp_path, stage="Recovery")
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_STAGE_MISMATCH" in res.stdout


def test_stage_gate_fails_on_stage_mismatch_in_k3(tmp_path: Path) -> None:
    auth = make_auth(tmp_path)
    k3 = make_k3_v1(tmp_path, stage="Recovery")
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL K3_STAGE_MISMATCH" in res.stdout


def test_stage_gate_fails_on_stale_auth_date(tmp_path: Path) -> None:
    auth = make_auth(tmp_path, date="2020-01-01")
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_STALE" in res.stdout


def test_stage_gate_fails_on_stale_k3_date(tmp_path: Path) -> None:
    auth = make_auth(tmp_path)
    k3 = make_k3_v1(tmp_path, date="2020-01-01")
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL K3_STALE" in res.stdout


@pytest.mark.parametrize("field,bad_val", [
    ("expected_main", "not-a-sha"),
    ("frozen_runner_sha256", "short-sha"),
    ("operator_user", "123invalid_user"),
    ("operator_uid", "0"),  # non-root required
    ("recovery_execution_main", "zzz"),
])
def test_stage_gate_fails_on_invalid_lvr_binding_field(tmp_path: Path, field: str, bad_val: str) -> None:
    auth = make_auth(tmp_path, **{field: bad_val})
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_LVR_BINDING_INVALID" in res.stdout or "GATE_FAIL AUTHORIZATION_MALFORMED" in res.stdout


@pytest.mark.parametrize("field,val", [
    ("d6_notice", "pub"),
    ("integration_review", "kla"),
    ("recovery_authorization", "REF-REC-123"),
    ("physical_recovery_attestation", "REF-PHY-123"),
])
def test_stage_gate_fails_on_forbidden_extra_field(tmp_path: Path, field: str, val: str) -> None:
    auth = make_auth(tmp_path, **{field: val})
    k3 = make_k3_v1(tmp_path)
    res = bash(f'bash "{STAGE_GATE}" --stage LVR --mode live --authorization "{auth}" --k3 "{k3}"')
    assert res.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_MALFORMED" in res.stdout


# ---------------------------------------------------------------------------
# Recovery Predecessor Gate Tests
# ---------------------------------------------------------------------------

def init_git_repo(tmp: Path) -> tuple[Path, str]:
    repo = tmp / "git_repo"
    repo.mkdir(parents=True)
    logs_dir = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
    logs_dir.mkdir(parents=True)
    bash("git init -q", cwd=repo)
    bash("git config user.email 'test@example.com'", cwd=repo)
    bash("git config user.name 'Tester'", cwd=repo)
    (repo / "README.md").write_text("# Test Repo\n")
    bash("git add -A && git commit -qm 'initial'", cwd=repo)
    head = bash("git rev-parse HEAD", cwd=repo).stdout.strip()
    return repo, head


def make_recovery_closeout_content(exec_main: str, **overrides) -> str:
    fields = {
        "RECOVERY_LIVE": "CLOSED_PASS",
        "RECOVERY_LIVE_EXECUTED": "YES",
        "RECOVERY_RESULT": "PASS",
        "RECOVERY_R2_R8_EXECUTED": "YES",
        "RECOVERY_ATTEMPT_CONSUMED": "YES",
        "RECOVERY_RERUN_ALLOWED": "NO",
        "RECOVERY_STAGE": "Recovery",
        "RECOVERY_EXECUTION_MAIN": exec_main,
        "RECOVERY_EXPECTED_MAIN": exec_main,
        "LVR_PROVEN": "NO",
        "L8_ACCEPTANCE": "NO",
        "L9_PROVEN": "NO",
    }
    fields.update(overrides)
    return "\n".join(f"{k}={v}" for k, v in fields.items()) + "\n"


def commit_recovery_closeout(repo: Path, filename: str, content: str) -> str:
    path = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs" / filename
    path.write_text(content)
    bash(f"git add -A && git commit -qm 'add recovery closeout {filename}'", cwd=repo)
    return bash("git rev-parse HEAD", cwd=repo).stdout.strip()


def test_recovery_closeout_gate_passes_with_valid_descendant(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    closeout_content = make_recovery_closeout_content(exec_main)
    # create closeout commit which is a descendant of exec_main
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", closeout_content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 0
    assert "LVR_RECOVERY_CLOSEOUT=PASS" in res.stdout
    assert f"LVR_RECOVERY_EXECUTION_MAIN={exec_main}" in res.stdout


def test_recovery_closeout_gate_fails_when_absent(tmp_path: Path) -> None:
    repo, main = init_git_repo(tmp_path)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_CLOSEOUT_MISSING" in res.stderr


def test_recovery_closeout_gate_fails_on_duplicate_closeouts(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    content = make_recovery_closeout_content(exec_main)
    path1 = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_120000_music_idea3-recovery-live-closeout.md"
    path2 = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_130000_music_idea3-recovery-live-closeout.md"
    path1.write_text(content)
    path2.write_text(content)
    bash("git add -A && git commit -qm 'duplicate closeouts'", cwd=repo)
    lvr_main = bash("git rev-parse HEAD", cwd=repo).stdout.strip()
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_CLOSEOUT_NOT_UNIQUE" in res.stderr


def test_recovery_closeout_gate_fails_on_git_symlink(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    content = make_recovery_closeout_content(exec_main)
    target = repo / "real_closeout.md"
    target.write_text(content)
    sym = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_120000_music_idea3-recovery-live-closeout.md"
    os.symlink("../../real_closeout.md", sym)
    bash("git add -A && git commit -qm 'symlink closeout'", cwd=repo)
    lvr_main = bash("git rev-parse HEAD", cwd=repo).stdout.strip()
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_CLOSEOUT_SYMLINK" in res.stderr


def test_recovery_closeout_gate_fails_on_recovery_failure(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    content = make_recovery_closeout_content(exec_main, RECOVERY_RESULT="FAIL", RECOVERY_LIVE="CLOSED_FAIL")
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1


def test_recovery_closeout_gate_fails_on_contradictory_results(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    # contains both PASS and CLOSED_FAIL
    content = make_recovery_closeout_content(exec_main) + "RECOVERY_RESULT=FAIL\n"
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1


def test_recovery_closeout_gate_fails_when_exec_main_is_not_ancestor(tmp_path: Path) -> None:
    repo, _ = init_git_repo(tmp_path)
    # create a foreign sha not in git history
    foreign_main = "f" * 40
    content = make_recovery_closeout_content(foreign_main)
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_MAIN_NOT_ANCESTOR" in res.stderr


def test_recovery_closeout_gate_fails_on_repository_only_receipt(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    content = make_recovery_closeout_content(exec_main, RECOVERY_LIVE_EXECUTED="NO", RECOVERY_ATTEMPT_CONSUMED="NO")
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_CLOSEOUT_FIELD_INVALID:RECOVERY_LIVE_EXECUTED" in res.stderr


def test_recovery_closeout_gate_fails_on_wrong_stage(tmp_path: Path) -> None:
    repo, exec_main = init_git_repo(tmp_path)
    content = make_recovery_closeout_content(exec_main, RECOVERY_STAGE="CTu")
    lvr_main = commit_recovery_closeout(repo, "2026-10-07_120000_music_idea3-recovery-live-closeout.md", content)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_closeout_gate "{repo}" "{lvr_main}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_CLOSEOUT_FIELD_INVALID:RECOVERY_STAGE" in res.stderr


# ---------------------------------------------------------------------------
# Recovery Marker Gate Tests
# ---------------------------------------------------------------------------

def make_marker(tmp: Path, **overrides) -> Path:
    p = tmp / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
    lines = [
        "RECOVERY_ATTEMPT_CONSUMED=YES",
        "RECOVERY_RERUN_ALLOWED=NO",
    ]
    p.write_text("\n".join(lines) + "\n")
    p.chmod(0o600)
    return p


def test_recovery_marker_gate_passes_on_valid_marker(tmp_path: Path) -> None:
    m = make_marker(tmp_path)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_marker_gate "{m}"')
    assert res.returncode == 0


def test_recovery_marker_gate_fails_when_marker_missing(tmp_path: Path) -> None:
    m = tmp_path / "nonexistent"
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_marker_gate "{m}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_MARKER_MISSING_OR_SYMLINK" in res.stderr


def test_recovery_marker_gate_fails_when_marker_is_symlink(tmp_path: Path) -> None:
    real = make_marker(tmp_path)
    sym = tmp_path / "symlink-marker"
    os.symlink(real, sym)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_marker_gate "{sym}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_MARKER_MISSING_OR_SYMLINK" in res.stderr


def test_recovery_marker_gate_fails_when_marker_mode_invalid(tmp_path: Path) -> None:
    m = make_marker(tmp_path)
    m.chmod(0o644)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_marker_gate "{m}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_MARKER_MODE_INVALID" in res.stderr


def test_recovery_marker_gate_fails_when_not_consumed(tmp_path: Path) -> None:
    p = tmp_path / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
    p.write_text("RECOVERY_ATTEMPT_CONSUMED=NO\nRECOVERY_RERUN_ALLOWED=NO\n")
    p.chmod(0o600)
    res = bash(f'. "{LVR_LIB}"; lvr_recovery_marker_gate "{p}"')
    assert res.returncode == 1
    assert "LVR_RECOVERY_MARKER_NOT_CONSUMED" in res.stderr


# ---------------------------------------------------------------------------
# Operator Identity Gate Tests
# ---------------------------------------------------------------------------

def test_operator_identity_gate() -> None:
    curr_uid = os.getuid()
    curr_user = os.environ.get("USER", "kittipat")
    res = bash(f'. "{LVR_LIB}"; lvr_operator_identity_gate "{curr_user}" "{curr_uid}" && echo PASS')
    assert res.returncode == 0
    assert "PASS" in res.stdout

    # wrong user
    res_bad = bash(f'. "{LVR_LIB}"; lvr_operator_identity_gate "wrong_user" "{curr_uid}"')
    assert res_bad.returncode == 1

    # root rejected
    res_root = bash(f'. "{LVR_LIB}"; lvr_operator_identity_gate "root" "0"')
    assert res_root.returncode == 1


# ---------------------------------------------------------------------------
# Runtime Acceptance Verifier Tests (p4-lvr-runtime-verify.py)
# ---------------------------------------------------------------------------

def setup_runtime_fixture(tmp: Path, **status_overrides) -> tuple[Path, Path, Path, Path]:
    now = 1700000000.0
    status_data = {
        "broker": "CONNECTED",
        "device": "ONLINE",
        "uplink": "NORMAL",
        "time_trust": "SYNCED",
        "armed": "ARMED",
        "pid": 5555,
        "updated_at": now - 10.0,
    }
    status_data.update(status_overrides)
    status_file = tmp / "status.json"
    status_file.write_text(json.dumps(status_data))

    systemd_fixture = tmp / "systemd"
    systemd_fixture.mkdir(parents=True)
    core_show = systemd_fixture / "aegis-idea3-core.show"
    core_show.write_text(
        "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nMainPID=5555\nNRestarts=0\n"
    )
    det_show = systemd_fixture / "aegis-idea3-detector.show"
    det_show.write_text(
        "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nMainPID=5556\nNRestarts=0\n"
    )

    marker = tmp / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("RECOVERY_ATTEMPT_CONSUMED=YES\nRECOVERY_RERUN_ALLOWED=NO\n")
    marker.chmod(0o600)

    db_path = tmp / "audit.db"
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE incidents (id INTEGER PRIMARY KEY, state TEXT)")
    conn.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, event_type TEXT, incident_id INTEGER)")
    conn.execute("INSERT INTO incidents (id, state) VALUES (1, 'CLOSED')")
    conn.execute("INSERT INTO audit_logs (id, event_type, incident_id) VALUES (1, 'RECOVERY_R8_CLOSE', 1)")
    conn.execute("INSERT INTO audit_logs (id, event_type, incident_id) VALUES (2, 'INCIDENT_CLOSED', 1)")
    conn.commit()
    conn.close()

    return status_file, systemd_fixture, marker, db_path


def run_runtime_verify(status: Path, fixture: Path, marker: Path, db: Path, now: float = 1700000000.0) -> subprocess.CompletedProcess[str]:
    cmd = [
        sys.executable,
        str(LVR_VERIFY_PY),
        "--status", str(status),
        "--audit-db", str(db),
        "--recovery-marker", str(marker),
        "--systemd-fixture", str(fixture),
        "--now", str(now),
        "--max-age", "300",
    ]
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def test_runtime_verifier_passes_on_valid_fixture(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 0
    assert "LVR_RUNTIME_PROOF=PASS" in res.stdout
    assert "LVR_CLAIM_BOUNDARY=LVR_ONLY" in res.stdout


@pytest.mark.parametrize("status_key,bad_val,expected_reason", [
    ("broker", "DISCONNECTED", "STATUS_BROKER_NOT_CONNECTED"),
    ("device", "OFFLINE", "STATUS_DEVICE_NOT_ONLINE"),
    ("uplink", "LOCKDOWN", "STATUS_UPLINK_NOT_NORMAL"),
    ("time_trust", "UNSYNCED", "STATUS_TIME_TRUST_NOT_SYNCED"),
    ("armed", "INVALID_ARMED", "STATUS_ARMED_INVALID"),
    ("updated_at", 1700000000.0 - 500.0, "STATUS_STALE"),
])
def test_runtime_verifier_fails_on_status_defects(tmp_path: Path, status_key: str, bad_val: object, expected_reason: str) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path, **{status_key: bad_val})
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert f"reason={expected_reason}" in res.stdout


def test_runtime_verifier_fails_when_core_pid_mismatches_status_pid(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path, pid=9999)
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=STATUS_PID_NOT_CURRENT_CORE" in res.stdout


def test_runtime_verifier_fails_on_unhealthy_core(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    core_show = fixture / "aegis-idea3-core.show"
    core_show.write_text("LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=5555\nNRestarts=1\n")
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=CORE_ACTIVESTATE_INVALID" in res.stdout


def test_runtime_verifier_fails_on_unhealthy_detector(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    det_show = fixture / "aegis-idea3-detector.show"
    det_show.write_text("LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nMainPID=0\nNRestarts=0\n")
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=DETECTOR_ACTIVESTATE_INVALID" in res.stdout


def test_runtime_verifier_fails_when_incident_remains_open(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO incidents (id, state) VALUES (2, 'OPEN')")
    conn.commit()
    conn.close()
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=OPEN_INCIDENT_REMAINS" in res.stdout


def test_runtime_verifier_fails_when_recovery_close_logs_missing(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM audit_logs")
    conn.commit()
    conn.close()
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=RECOVERY_CLOSE_EVIDENCE_MISSING" in res.stdout


def test_runtime_verifier_observes_committed_wal_state_and_cannot_mutate(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    # Enable WAL mode with auto-checkpoint disabled; live connection simulates running Core service
    live_conn = sqlite3.connect(db)
    live_conn.execute("PRAGMA journal_mode=WAL")
    live_conn.execute("PRAGMA wal_autocheckpoint=0")
    live_conn.execute("INSERT INTO incidents (id, state) VALUES (2, 'CLOSED')")
    live_conn.execute("INSERT INTO audit_logs (id, event_type, incident_id) VALUES (3, 'RECOVERY_R8_CLOSE', 2)")
    live_conn.execute("INSERT INTO audit_logs (id, event_type, incident_id) VALUES (4, 'INCIDENT_CLOSED', 2)")
    live_conn.commit()

    wal_file = Path(str(db) + "-wal")
    assert wal_file.exists() and wal_file.stat().st_size > 0

    try:
        # LVR runtime verifier MUST observe the committed rows in WAL while Core is running
        res = run_runtime_verify(status, fixture, marker, db)
        assert res.returncode == 0
        assert "LVR_RUNTIME_PROOF=PASS" in res.stdout

        # Prove query_only / read-only guarantee: logical writes are strictly blocked
        ro_conn = sqlite3.connect(f"file:{db.resolve()}?mode=ro", uri=True)
        ro_conn.execute("PRAGMA query_only=ON")
        cur = ro_conn.cursor()
        for stmt in ["INSERT INTO incidents (id, state) VALUES (3, 'OPEN')", "UPDATE incidents SET state='OPEN'", "DELETE FROM incidents", "CREATE TABLE dummy (x INT)"]:
            with pytest.raises(sqlite3.OperationalError, match="attempt to write a readonly database"):
                cur.execute(stmt)
        ro_conn.close()
    finally:
        live_conn.close()


def test_runtime_verifier_fails_when_recovery_close_not_on_latest_incident(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    conn = sqlite3.connect(db)
    # Incident 2 was created after incident 1, but incident 1 was the one with RECOVERY_R8_CLOSE
    conn.execute("INSERT INTO incidents (id, state) VALUES (2, 'CLOSED')")
    conn.commit()
    conn.close()
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=RECOVERY_CLOSE_NOT_LATEST_INCIDENT" in res.stdout


def test_runtime_verifier_fails_when_detector_pid_invalid(tmp_path: Path) -> None:
    status, fixture, marker, db = setup_runtime_fixture(tmp_path)
    # Tamper with detector fixture to set invalid MainPID
    det_show = fixture / "aegis-idea3-detector.show"
    content = det_show.read_text(encoding="utf-8")
    tampered = content.replace("MainPID=5556", "MainPID=0")
    det_show.write_text(tampered, encoding="utf-8")
    res = run_runtime_verify(status, fixture, marker, db)
    assert res.returncode == 1
    assert "reason=DETECTOR_PID_INVALID" in res.stdout


# ---------------------------------------------------------------------------
# Handlers Contract Tests (apply.sh, rollback.sh, verify.sh)
# ---------------------------------------------------------------------------

def test_lvr_apply_handler_is_noop_read_only() -> None:
    apply_sh = STG_LVR / "apply.sh"
    res = bash(f'bash "{apply_sh}"')
    assert res.returncode == 0
    assert "LVR_APPLY=COMPLETE" in res.stdout
    assert "LVR_PRODUCTION_MUTATION=NO" in res.stdout
    assert "LVR_STAGE=LVR" in res.stdout

    # accepts no arguments
    res_arg = bash(f'bash "{apply_sh}" extra_arg')
    assert res_arg.returncode == 1
    assert "reason=NO_ARGUMENTS_ACCEPTED" in res_arg.stderr


def test_lvr_rollback_handler_is_noop_read_only() -> None:
    rollback_sh = STG_LVR / "rollback.sh"
    res = bash(f'bash "{rollback_sh}"')
    assert res.returncode == 0
    assert "LVR_ROLLBACK=NOTHING_OWNED" in res.stdout
    assert "LVR_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO" in res.stdout
    assert "LVR_IS_RECOVERY_RETRY=NO" in res.stdout

    # accepts no arguments
    res_arg = bash(f'bash "{rollback_sh}" extra_arg')
    assert res_arg.returncode == 1
    assert "reason=NO_ARGUMENTS_ACCEPTED" in res_arg.stderr


def test_lvr_verify_handler_requires_live_authorization(tmp_path: Path) -> None:
    verify_sh = STG_LVR / "verify.sh"
    res = bash(f'bash "{verify_sh}"')
    assert res.returncode == 1
    assert "reason=LIVE_AUTHORIZATION_REQUIRED" in res.stderr


def test_lvr_allow_files_exist_and_permit_no_mutation() -> None:
    keys = (STG_LVR / "allow-keys.txt").read_text()
    listeners = (STG_LVR / "allow-listeners.txt").read_text()
    # non-comment lines must be empty
    assert not [line for line in keys.splitlines() if line.strip() and not line.strip().startswith("#")]
    assert not [line for line in listeners.splitlines() if line.strip() and not line.strip().startswith("#")]


# ---------------------------------------------------------------------------
# Safety by Construction: No Production Mutation
# ---------------------------------------------------------------------------

def test_lvr_contains_no_production_mutation_calls() -> None:
    paths = [
        LVR_LIB,
        LVR_VERIFY_PY,
        STG_LVR / "apply.sh",
        STG_LVR / "rollback.sh",
        STG_LVR / "verify.sh",
        P4 / "owner-run/run-lvr-owner.sh",
    ]
    for p in paths:
        text = p.read_text()
        assert not re.search(r"systemctl\s+(start|stop|restart|reload|disable|enable)", text), f"systemctl in {p.name}"
        assert not re.search(r"nft\s+(add|delete|flush|destroy|insert)", text), f"nft mutation in {p.name}"
        assert not re.search(r"(INSERT|UPDATE|DELETE|DROP|ALTER)\s+", text, re.IGNORECASE) or p == LVR_VERIFY_PY, f"SQL write in {p.name}"
        assert not re.search(r"mosquitto_pub", text), f"mosquitto_pub in {p.name}"
        assert not re.search(r"esp32|relay", text, re.IGNORECASE) or "run-lvr-owner.sh" in p.name, f"hardware touch in {p.name}"


# ---------------------------------------------------------------------------
# Canonical LVR Closeout Contract Validation
# ---------------------------------------------------------------------------

def test_lvr_closeout_validator() -> None:
    valid_content = """LVR_LIVE=CLOSED_PASS
LVR_LIVE_EXECUTED=YES
LVR_RESULT=PASS
LVR_STAGE=LVR
LVR_EXECUTION_MAIN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
LVR_EXPECTED_MAIN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
LVR_RUNNER_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
LVR_RECOVERY_PREDECESSOR=PASS
LVR_RECOVERY_EXECUTION_MAIN=cccccccccccccccccccccccccccccccccccccccc
LVR_RUNTIME_PROOF=PASS
LVR_RUNTIME_PROOF_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
LVR_PRE_POST_PRESERVATION=PASS
LVR_S10=PASS
LVR_PRODUCTION_MUTATION=NO
LVR_FAILURE_RESULT=NONE
L8_ACCEPTANCE=NO
L9_PROVEN=NO
"""
    res = bash(f'. "{LVR_LIB}"; lvr_validate_closeout_content "{valid_content}" && echo VALID')
    assert res.returncode == 0
    assert "VALID" in res.stdout

    # missing field
    invalid_content = valid_content.replace("LVR_LIVE=CLOSED_PASS\n", "")
    res_bad = bash(f'. "{LVR_LIB}"; lvr_validate_closeout_content "{invalid_content}" && echo VALID')
    assert res_bad.returncode == 1

    # missing runtime proof sha
    missing_sha = valid_content.replace("LVR_RUNTIME_PROOF_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n", "")
    res_no_sha = bash(f'. "{LVR_LIB}"; lvr_validate_closeout_content "{missing_sha}" && echo VALID')
    assert res_no_sha.returncode == 1

    # invalid runtime proof sha
    bad_sha = valid_content.replace("LVR_RUNTIME_PROOF_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n", "LVR_RUNTIME_PROOF_SHA256=short-sha\n")
    res_bad_sha = bash(f'. "{LVR_LIB}"; lvr_validate_closeout_content "{bad_sha}" && echo VALID')
    assert res_bad_sha.returncode == 1

    # contradictory failure
    contradictory = valid_content + "LVR_RESULT=FAIL\n"
    res_contra = bash(f'. "{LVR_LIB}"; lvr_validate_closeout_content "{contradictory}" && echo VALID')
    assert res_contra.returncode == 1
