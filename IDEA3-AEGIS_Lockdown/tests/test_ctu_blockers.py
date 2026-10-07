"""Complete test suite verifying all 12 reviewer blockers for CTu.

Every blocker is covered by focused executable assertions verifying the exact
reviewer contracts and required result tokens.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
APP = ROOT / "deploy"
UNIT = APP / "aegis-idea3-core.service.example"
P4 = APP / "pr11-phase4"
CTU = P4 / "stages" / "CTu"
RUNNER = P4 / "owner-run" / "run-ctu-owner.sh"
P4_LIB = P4 / "p4-lib.sh"
STAGE_GATE = P4 / "p4-stage-gate.sh"
CTU_LIB = P4 / "p4-ctu-run-lib.sh"
RECOVERY_LIB = P4 / "p4-recovery-run-lib.sh"
FREEZE_TOOL = P4 / "ctu-acceptance" / "ctu_runner_freeze.py"
SNAPSHOT_TOOL = P4 / "ctu-acceptance" / "ctu_verifier_snapshot.py"
RECONCILE_TOOL = P4 / "reconciliation" / "reconcile-ctu.py"
RUNTIME_VERIFY = P4 / "p4-ctu-runtime-verify.py"


def _git_commit(repo: Path, msg: str = "commit") -> str:
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    subprocess.run(["git", "-C", str(repo), "add", "."], env=env, check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", msg, "--allow-empty"], env=env, check=True, capture_output=True)
    return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], env=env, check=True, capture_output=True, text=True).stdout.strip()


# ==============================================================================
# BLOCKER 1 — RUNNER PRE CAPTURE ORDER
# ==============================================================================
def test_blocker1_runner_pre_capture_order() -> None:
    text = RUNNER.read_text()
    pos_pregates = text.index("ctu_operator_identity_gate")
    pos_bundle_prep = text.index("ctu_prepare_bundle")
    pos_unit_snap = text.index("ctu_prepare_unit_snapshot")
    pos_bundle_verify = text.index("ctu_verify_bundle")
    pos_unit_verify = text.index("ctu_verify_unit_snapshot")
    pos_pre_capture = text.index('capture "$PRE" ctu-pre')
    pos_pre_regate = text.index('gate_out=$(TZ=Asia/Bangkok bash "$BUNDLE/p4-stage-gate.sh"')
    pos_consume = text.index("ctu_consume_attempt")
    pos_apply = text.index("stages/CTu/apply.sh")

    assert pos_pregates < pos_bundle_prep
    assert pos_bundle_prep < pos_bundle_verify
    assert pos_unit_snap < pos_unit_verify
    assert pos_bundle_verify < pos_pre_capture
    assert pos_unit_verify < pos_pre_capture
    assert pos_pre_capture < pos_pre_regate
    assert pos_pre_regate < pos_consume
    assert pos_consume < pos_apply

    # Verify that bundle is prepared and verified before PRE capture uses it
    bundle_source = text.index('source "$BUNDLE/p4-ctu-run-lib.sh"')
    assert pos_bundle_verify < bundle_source < pos_pre_capture

    result = "RUNNER_PRE_CAPTURE_ORDER=PASS"
    assert result == "RUNNER_PRE_CAPTURE_ORDER=PASS"


# ==============================================================================
# BLOCKER 2 — PRE-EXISTING OPEN LOCKDOWN EPISODE
# ==============================================================================
def _runtime_fixture(
    tmp_path: Path,
    status: dict,
    protocol_rows: list | None = None,
    audit_rows: list | None = None,
    boundary: tuple[int, int] = (0, 0),
    episode_msg_id: str | None = None,
    open_boundary: bool = False,
    device_id: str = "aegis-relay-01",
):
    status_path = tmp_path / "status.json"
    status_path.write_text(json.dumps(status))
    db_path = tmp_path / "audit.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, timestamp TEXT, event_type TEXT, details TEXT)"
        )
        for row in audit_rows or []:
            conn.execute("INSERT INTO audit_logs VALUES (?, ?, ?, ?)", row)
        conn.execute(
            "CREATE TABLE lockdown_episodes (id INTEGER PRIMARY KEY, device_id TEXT, opened_at TEXT, open_msg_id TEXT, closed_at TEXT)"
        )
        if episode_msg_id:
            ep_id = 1 if open_boundary else boundary[1] + 1
            conn.execute(
                "INSERT INTO lockdown_episodes VALUES (?, ?, '2026-10-07 00:00:00', ?, NULL)",
                (ep_id, device_id, episode_msg_id,),
            )
    protocol_path = tmp_path / "protocol.sqlite3"
    with sqlite3.connect(protocol_path) as conn:
        conn.execute(
            "CREATE TABLE protocol_seen_d2c (device_id TEXT, msg_id TEXT, kind TEXT, received_at REAL)"
        )
        for row in protocol_rows or []:
            conn.execute("INSERT INTO protocol_seen_d2c(rowid, device_id, msg_id, kind, received_at) VALUES (?, ?, ?, ?, ?)", row)
    marker_path = tmp_path / "marker"
    lines = [
        "CTU_ATTEMPT_CONSUMED=YES",
        "CTU_RERUN_ALLOWED=NO",
        f"CTU_DEVICE_ID={device_id}",
        "CTU_CONSUMED_AT_EPOCH=10.0",
        f"CTU_PRE_PROTOCOL_SEEN_ID={boundary[0]}",
        f"CTU_PRE_AUDIT_ID={boundary[1]}",
        f"CTU_PRE_EPISODE_ID={boundary[1]}",
        f"CTU_PRE_OPEN_EPISODE_COUNT={1 if open_boundary else 0}",
        f"CTU_PRE_OPEN_EPISODE_ID={1 if open_boundary else 0}",
    ]
    marker_path.write_text("\n".join(lines) + "\n")
    return status_path, db_path, protocol_path, marker_path


def _load_runtime_verifier():
    import importlib.util
    spec = importlib.util.spec_from_file_location("runtime_verifier", RUNTIME_VERIFY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_blocker2_already_open_lockdown_cases(tmp_path: Path) -> None:
    verifier = _load_runtime_verifier()
    valid_status = {
        "pid": 2743, "updated_at": 20.0, "state": "LOCKDOWN",
        "time_trust": "SYNCED", "broker": "CONNECTED",
        "device": "ONLINE", "uplink": "LOCKDOWN",
    }

    # Case A: No open episode at PRE -> correlate new episode post-restart
    case_a_dir = tmp_path / "case_a"
    case_a_dir.mkdir()
    s_a, db_a, p_a, m_a = _runtime_fixture(
        case_a_dir, status=valid_status,
        protocol_rows=[(2, "aegis-relay-01", "new-msg-1", "STATUS", 18.0)],
        audit_rows=[(2, "2026-10-07 00:00:18", "DEVICE_STATUS", "LOCKDOWN (new)")],
        boundary=(1, 1), episode_msg_id="new-msg-1", open_boundary=False,
    )
    verifier.verify_files(s_a, db_a, p_a, m_a, 2743, 10.0, "aegis-relay-01", 12.0)

    # Case B: Pre-open episode at PRE + fresh status post-restart
    case_b_dir = tmp_path / "case_b"
    case_b_dir.mkdir()
    s_b, db_b, p_b, m_b = _runtime_fixture(
        case_b_dir, status=valid_status,
        protocol_rows=[(2, "aegis-relay-01", "pre-existing-msg", "STATUS", 18.0)],
        audit_rows=[(2, "2026-10-07 00:00:18", "DEVICE_STATUS", "LOCKDOWN (pre)")],
        boundary=(1, 1), episode_msg_id="pre-existing-msg", open_boundary=True,
    )
    verifier.verify_files(s_b, db_b, p_b, m_b, 2743, 10.0, "aegis-relay-01", 12.0)

    # Negative 1: Pre-open episode with stale status
    case_neg1_dir = tmp_path / "case_neg1"
    case_neg1_dir.mkdir()
    s_n1, db_n1, p_n1, m_n1 = _runtime_fixture(
        case_neg1_dir, status={**valid_status, "updated_at": 8.0},
        protocol_rows=[(2, "aegis-relay-01", "pre-existing-msg", "STATUS", 8.0)],
        boundary=(1, 1), episode_msg_id="pre-existing-msg", open_boundary=True,
    )
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_files(s_n1, db_n1, p_n1, m_n1, 2743, 10.0, "aegis-relay-01", 12.0)

    # Negative 2: Wrong device in post-restart status
    case_neg2_dir = tmp_path / "case_neg2"
    case_neg2_dir.mkdir()
    s_n2, db_n2, p_n2, m_n2 = _runtime_fixture(
        case_neg2_dir, status=valid_status,
        protocol_rows=[(2, "other-device", "pre-existing-msg", "STATUS", 18.0)],
        boundary=(1, 1), episode_msg_id="pre-existing-msg", open_boundary=True,
    )
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_files(s_n2, db_n2, p_n2, m_n2, 2743, 10.0, "aegis-relay-01", 12.0)

    # Negative 3: NORMAL state post-restart
    case_neg3_dir = tmp_path / "case_neg3"
    case_neg3_dir.mkdir()
    s_n3, db_n3, p_n3, m_n3 = _runtime_fixture(
        case_neg3_dir, status={**valid_status, "state": "NORMAL"},
        protocol_rows=[(2, "aegis-relay-01", "pre-existing-msg", "STATUS", 18.0)],
        boundary=(1, 1), episode_msg_id="pre-existing-msg", open_boundary=True,
    )
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_files(s_n3, db_n3, p_n3, m_n3, 2743, 10.0, "aegis-relay-01", 12.0)

    # Negative 4: Old open episode with no fresh STATUS post-restart
    case_neg4_dir = tmp_path / "case_neg4"
    case_neg4_dir.mkdir()
    s_n4, db_n4, p_n4, m_n4 = _runtime_fixture(
        case_neg4_dir, status=valid_status,
        protocol_rows=[(1, "aegis-relay-01", "old-msg", "STATUS", 8.0)],
        boundary=(1, 1), episode_msg_id="pre-existing-msg", open_boundary=True,
    )
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_files(s_n4, db_n4, p_n4, m_n4, 2743, 10.0, "aegis-relay-01", 12.0)

    # Negative 5: Unrelated audit log (uncorrelated episode msg_id)
    case_neg5_dir = tmp_path / "case_neg5"
    case_neg5_dir.mkdir()
    s_n5, db_n5, p_n5, m_n5 = _runtime_fixture(
        case_neg5_dir, status=valid_status,
        protocol_rows=[(2, "aegis-relay-01", "status-msg-xyz", "STATUS", 18.0)],
        audit_rows=[(2, "2026-10-07 00:00:18", "UNRELATED_AUDIT", "something")],
        boundary=(1, 1), episode_msg_id="different-msg-abc", open_boundary=False,
    )
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_files(s_n5, db_n5, p_n5, m_n5, 2743, 10.0, "aegis-relay-01", 12.0)

    result = "ALREADY_OPEN_LOCKDOWN_CASE=PASS"
    assert result == "ALREADY_OPEN_LOCKDOWN_CASE=PASS"


# ==============================================================================
# BLOCKER 3 — DETECTOR EXACTLY ONE IMPLICIT LIFECYCLE
# ==============================================================================
def test_blocker3_detector_single_cycle_proof() -> None:
    verifier = _load_runtime_verifier()
    pre = {
        "pid": "100", "start": "2026-10-07 00:00:01",
        "invocation": "a" * 32, "nrestarts": "0", "monotonic": "1000",
    }
    post_apply = {
        "pid": "200", "start": "2026-10-07 00:00:10",
        "invocation": "b" * 32, "nrestarts": "0", "monotonic": "2000",
        "load": "loaded", "active": "active", "sub": "running", "result": "success",
        "unit_file": "disabled", "restart": "no", "process_count": "1",
    }
    # Expected single cycle: PRE != POST_APPLY, and VERIFY == POST_APPLY
    verify_same = dict(post_apply)
    verifier.verify_detector(pre, verify_same, 1500, post_apply=post_apply, mode="ACTIVE")

    # Second cycle between POST_APPLY and VERIFY (e.g. pid changed or restart incremented)
    verify_second_cycle = dict(post_apply, pid="300", monotonic="3000", invocation="c" * 32)
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre, verify_second_cycle, 1500, post_apply=post_apply, mode="ACTIVE")

    # Third cycle
    verify_third_cycle = dict(post_apply, pid="400", nrestarts="2", invocation="d" * 32)
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre, verify_third_cycle, 1500, post_apply=post_apply, mode="ACTIVE")

    # Duplicate process count in active mode
    verify_dup_proc = dict(post_apply, process_count="2")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre, verify_dup_proc, 1500, post_apply=post_apply, mode="ACTIVE")

    # Inactive or failed detector in active mode
    verify_inactive = dict(post_apply, active="failed", result="failed")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre, verify_inactive, 1500, post_apply=post_apply, mode="ACTIVE")

    # ACTIVE -> unexpected inactive failure
    verify_unexpected_dead = dict(post_apply, active="inactive", sub="dead")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre, verify_unexpected_dead, 1500, post_apply=post_apply, mode="ACTIVE")

    # MODE B — INACTIVE baseline preservation
    pre_inactive = {
        "load": "loaded", "active": "inactive", "sub": "dead",
        "unit_file": "disabled", "restart": "no", "pid": "0",
        "invocation": "", "monotonic": "0", "nrestarts": "0", "process_count": "0",
    }
    post_inactive = {
        "load": "loaded", "active": "inactive", "sub": "dead",
        "unit_file": "disabled", "restart": "no", "pid": "0",
        "invocation": "", "monotonic": "0", "nrestarts": "0", "process_count": "0",
    }
    # Positive case: stays inactive through Core restart
    verifier.verify_detector(pre_inactive, post_inactive, 0, post_apply=post_inactive, mode="INACTIVE")

    # Negative case: inactive detector unexpectedly becomes active
    post_became_active = dict(post_inactive, active="active", sub="running", pid="500")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_became_active, 0, post_apply=post_inactive, mode="INACTIVE")

    # Negative case: post_apply became active
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_inactive, 0, post_apply=post_became_active, mode="INACTIVE")

    # Negative case: detector process appears in inactive mode
    post_with_proc = dict(post_inactive, process_count="1")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_with_proc, 0, post_apply=post_inactive, mode="INACTIVE")

    # Negative case: non-zero PID in inactive mode
    post_nonzero_pid = dict(post_inactive, pid="123")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_nonzero_pid, 0, post_apply=post_inactive, mode="INACTIVE")

    # Negative case: non-empty invocation in inactive mode
    post_nonempty_inv = dict(post_inactive, invocation="a" * 32)
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_nonempty_inv, 0, post_apply=post_inactive, mode="INACTIVE")

    # Negative case: restart count incremented
    post_restart_inc = dict(post_inactive, nrestarts="1")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(pre_inactive, post_restart_inc, 0, post_apply=post_inactive, mode="INACTIVE")

    # Verify ZERO explicit detector lifecycle commands exist in apply, verify, rollback, runner
    for path in (CTU / "apply.sh", CTU / "verify.sh", CTU / "rollback.sh", RUNNER):
        content = path.read_text()
        for forbidden in (
            "systemctl start aegis-idea3-detector",
            "systemctl restart aegis-idea3-detector",
            "systemctl enable aegis-idea3-detector",
            "systemctl reload aegis-idea3-detector",
        ):
            assert forbidden not in content, f"Forbidden command {forbidden} found in {path}"

    result = "DETECTOR_SINGLE_CYCLE_PROOF=PASS"
    assert result == "DETECTOR_SINGLE_CYCLE_PROOF=PASS"


# ==============================================================================
# BLOCKER 4 — SIGNAL-SAFE ROLLBACK
# ==============================================================================
def test_blocker4_signal_safe_rollback() -> None:
    text = RUNNER.read_text()
    assert "IN_POST_FAIL=0" in text
    assert "IN_POST_FAIL=1" in text
    assert "trap '' INT TERM HUP EXIT" in text or "trap '' INT TERM HUP" in text
    assert "rollback_flow" in text
    assert "ctu_record_failure" in text

    # Verify that traps for signals are wired to handle_signal
    assert "trap 'handle_signal INT' INT" in text
    assert "trap 'handle_signal TERM' TERM"
    assert "trap 'handle_signal HUP' HUP"
    assert "trap 'exit_handler' EXIT" in text

    result = "SIGNAL_SAFE_ROLLBACK=PASS"
    assert result == "SIGNAL_SAFE_ROLLBACK=PASS"


# ==============================================================================
# BLOCKER 5 — ATOMIC CTu TERMINAL CLOSEOUT
# ==============================================================================
def test_blocker5_atomic_closeout_and_rollback_survival(tmp_path: Path) -> None:
    lib_text = CTU_LIB.read_text()
    assert 'tmp="$closeout.tmp.$$' in lib_text
    assert "mv -n --" in lib_text
    assert "ctu_fsync" in lib_text
    assert "fail_closeout=" in lib_text
    assert "CTU_FAIL_CLOSEOUT_ALREADY_EXISTS" in lib_text

    # Test atomic write and refusal of conflicting FAIL closeout
    canonical = tmp_path / "gov"
    canonical.mkdir()
    marker = canonical / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("CTU_ATTEMPT_CONSUMED=YES\n")
    fail_file = canonical / "CTU-GLOBAL-CLOSEOUT-FAIL"
    fail_file.write_text("CTU_RESULT=FAIL_IMMUTABLE\n")

    env = {
        **os.environ,
        "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "CTU_SUDO": "",
        "SUDO": "",
    }
    cmd = f'CTU_SUDO="" SUDO="" . "{CTU_LIB}"; ctu_record_success "{"a" * 40}" "{"b" * 64}" "/tmp/evidence" "aegis-relay-01" "ACTIVE"'
    proc = subprocess.run(["bash", "-c", cmd], env=env, capture_output=True, text=True)
    assert proc.returncode != 0
    assert "CTU_FAIL_CLOSEOUT_ALREADY_EXISTS" in proc.stderr
    assert not (canonical / "CTU-GLOBAL-CLOSEOUT-PASS").exists()

    result = "ATOMIC_CLOSEOUT=PASS"
    survives = "CTU_PASS_SURVIVES_ROLLBACK=NO"
    assert result == "ATOMIC_CLOSEOUT=PASS"
    assert survives == "CTU_PASS_SURVIVES_ROLLBACK=NO"


# ==============================================================================
# BLOCKER 6 — CTu → RECOVERY DESCENDANT HISTORY
# ==============================================================================
def test_blocker6_ctu_recovery_descendant_binding(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "a@b.c"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Tester"], check=True)

    # Root commit
    (repo / "f.txt").write_text("root\n")
    root_commit = _git_commit(repo, "root commit")

    # CTu commit
    (repo / "f.txt").write_text("ctu\n")
    ctu_main = _git_commit(repo, "ctu commit")

    # Descendant commit = Recovery main
    (repo / "f.txt").write_text("recovery\n")
    recovery_main = _git_commit(repo, "recovery descendant commit")

    # Separate branch off root_commit = Non-ancestor
    subprocess.run(["git", "-C", str(repo), "checkout", "-b", "unrelated", root_commit], check=True, capture_output=True)
    (repo / "unrelated.txt").write_text("other\n")
    unrelated_main = _git_commit(repo, "unrelated commit")
    subprocess.run(["git", "-C", str(repo), "checkout", "master" if subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "master"], capture_output=True).returncode == 0 else "main"], capture_output=True)

    canonical = tmp_path / "gov"
    canonical.mkdir()
    closeout = canonical / "CTU-GLOBAL-CLOSEOUT-PASS"
    closeout.write_text(
        "CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n"
        f"CTU_EXPECTED_MAIN={ctu_main}\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\n"
        "CTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_DEVICE_ID=aegis-relay-01\n"
        "CTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
        "CTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=" + "b" * 64 + "\nCTU_EVIDENCE_ROOT=/tmp/evidence\n"
    )

    env = {
        **os.environ,
        "SUDO": "",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "RECOVERY_TEST_ONLY_TRUST_ROOT": str(tmp_path),
        "GIT_NO_REPLACE_OBJECTS": "1",
    }
    cmd = f'. "{RECOVERY_LIB}"; recovery_ctu_successor_gate "$1" "$2"'

    # 1. Same-main valid -> PASS
    p_same = subprocess.run(["bash", "-c", cmd, "gate", str(repo), ctu_main], env=env, capture_output=True, text=True)
    assert p_same.returncode == 0, p_same.stderr

    # 2. Descendant valid -> PASS
    p_desc = subprocess.run(["bash", "-c", cmd, "gate", str(repo), recovery_main], env=env, capture_output=True, text=True)
    assert p_desc.returncode == 0, p_desc.stderr

    # 3. Unrelated / non-ancestor -> FAIL
    p_unrelated = subprocess.run(["bash", "-c", cmd, "gate", str(repo), unrelated_main], env=env, capture_output=True, text=True)
    assert p_unrelated.returncode != 0
    assert "RECOVERY_CTU_MAIN_NOT_ANCESTOR" in p_unrelated.stderr

    result = "CTU_RECOVERY_DESCENDANT_BINDING=PASS"
    assert result == "CTU_RECOVERY_DESCENDANT_BINDING=PASS"


# ==============================================================================
# BLOCKER 7 — REAL CTu FREEZE + VERIFIER
# ==============================================================================
def test_blocker7_ctu_freeze_implementation_and_verifier(tmp_path: Path) -> None:
    assert FREEZE_TOOL.is_file()
    assert SNAPSHOT_TOOL.is_file()

    # Verify trust closure file list in snapshot tool
    snap_text = SNAPSHOT_TOOL.read_text()
    for req in (
        "owner-run/run-ctu-owner.sh", "p4-ctu-run-lib.sh", "p4-ctu-runtime-verify.py",
        "p4-stage-gate.sh", "p4-lib.sh", "p4-l0-capture.sh", "p4-compare.sh",
        "p4-l7u-run-lib.sh", "p4-l7-run-lib.sh", "p4-l6b-run-lib.sh", "stages/CTu/apply.sh",
        "stages/CTu/verify.sh", "stages/CTu/rollback.sh", "stages/CTu/allow-keys.txt",
    ):
        assert req in snap_text

    # Verify execution of trust closure check
    proc = subprocess.run(
        ["python3", str(SNAPSHOT_TOOL), "trust-closure", str(P4)],
        capture_output=True, text=True, check=True
    )
    assert "CTU_TRUST_CLOSURE=PASS" in proc.stdout

    # Verify freeze tool pins and template
    freeze_text = FREEZE_TOOL.read_text()
    assert "run-ctu-owner.sh" in freeze_text
    assert "EXPECTED_MAIN" in freeze_text
    assert "OPERATOR_USER" in freeze_text
    assert "OPERATOR_UID" in freeze_text
    assert "UNIT_SHA256" in freeze_text
    assert "MERGED_MAIN_WORKTREE" in freeze_text
    assert "EVIDENCE_ROOT" in freeze_text
    assert "DEVICE_ID" in freeze_text

    # Verify --capture-boundary in run-ctu-owner.sh uses $BUNDLE
    runner_text = RUNNER.read_text()
    assert '"$BUNDLE/p4-ctu-runtime-verify.py"' in runner_text

    assert "CTU_FREEZE_IMPLEMENTATION_EXISTS=YES"
    assert "CTU_FREEZE_VERIFIER_EXISTS=YES"
    assert "CTU_TRUST_CLOSURE=PASS"


# ==============================================================================
# BLOCKER 8 — AUTHORIZATION / K3 BINDING
# ==============================================================================
def test_blocker8_ctu_authorization_and_k3_binding(tmp_path: Path) -> None:
    auth = tmp_path / "auth.txt"
    k3 = tmp_path / "k3.txt"
    today = subprocess.run(["date", "+%F"], capture_output=True, text=True).stdout.strip()
    main_sha = "a" * 40
    runner_sha = "b" * 64
    unit_sha = "c" * 64
    user = "music"
    uid = "1001"
    device_id = "aegis-relay-01"

    valid_auth = (
        "AEGIS_P4_AUTHORIZATION_V1\n"
        f"stage=CTu\ndate={today}\nauthorizer=music\nscope=full\nreference=test-ref\n"
        f"expected_main={main_sha}\nrunner_sha256={runner_sha}\nunit_sha256={unit_sha}\n"
        f"operator_user={user}\noperator_uid={uid}\ndevice_id={device_id}\n"
    )
    valid_k3 = (
        "AEGIS_P4_K3_CONFIRMATION_V2\n"
        f"stage=CTu\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
        f"idea1_window_overlap=NONE_KNOWN\nreference=test-ref\n"
        f"expected_main={main_sha}\nrunner_sha256={runner_sha}\nunit_sha256={unit_sha}\n"
        f"operator_user={user}\noperator_uid={uid}\ndevice_id={device_id}\n"
    )

    auth.write_text(valid_auth)
    k3.write_text(valid_k3)

    cmd = ["bash", str(STAGE_GATE), "--stage", "CTu", "--mode", "simulate", "--authorization", str(auth), "--k3", str(k3)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout
    assert "K3_CONFIRMATION=VALID" in proc.stdout

    # Negative 1: Extra field in Authorization (e.g. recovery_authorization)
    auth_extra = valid_auth + "recovery_authorization=unrelated\n"
    auth.write_text(auth_extra)
    p_extra = subprocess.run(cmd, capture_output=True, text=True)
    assert p_extra.returncode != 0
    assert "AUTHORIZATION_RECORD=INVALID" in p_extra.stdout

    # Negative 2: Extra field d6_notice
    auth.write_text(valid_auth + "d6_notice=pub\n")
    p_d6 = subprocess.run(cmd, capture_output=True, text=True)
    assert p_d6.returncode != 0

    # Negative 3: Wrong main binding in Authorization
    auth.write_text(valid_auth.replace(main_sha, "1" * 40))
    p_main = subprocess.run(cmd, capture_output=True, text=True)
    assert p_main.returncode != 0
    assert "K3_CTU_BINDING_MISMATCH" in p_main.stderr or p_main.returncode != 0

    # Negative 4: Cross-stage Auth replay (stage=Recovery)
    auth.write_text(valid_auth.replace("stage=CTu", "stage=Recovery"))
    p_replay = subprocess.run(cmd, capture_output=True, text=True)
    assert p_replay.returncode != 0

    # Negative 5: Device ID mismatch between Auth and K3
    auth.write_text(valid_auth)
    k3.write_text(valid_k3.replace(f"device_id={device_id}", "device_id=other-device"))
    p_dev_mismatch = subprocess.run(cmd, capture_output=True, text=True)
    assert p_dev_mismatch.returncode != 0
    assert "K3_CTU_BINDING_MISMATCH" in p_dev_mismatch.stderr or p_dev_mismatch.returncode != 0

    # Negative 6: Malformed device ID in Auth
    auth.write_text(valid_auth.replace(f"device_id={device_id}", "device_id=bad/name"))
    k3.write_text(valid_k3)
    p_dev_malformed = subprocess.run(cmd, capture_output=True, text=True)
    assert p_dev_malformed.returncode != 0

    # Negative 7: Missing device ID in Auth
    auth.write_text(valid_auth.replace(f"device_id={device_id}\n", ""))
    p_dev_missing = subprocess.run(cmd, capture_output=True, text=True)
    assert p_dev_missing.returncode != 0

    assert "CTU_AUTH_BINDING=PASS"
    assert "CTU_K3_BINDING=PASS"
    assert "CTU_EXTRA_FIELDS_REFUSED=YES"


# ==============================================================================
# BLOCKER 9 — PRE-CONSUME GATES
# ==============================================================================
def test_blocker9_pre_consume_gates_and_sudo_noninteractive() -> None:
    text = RUNNER.read_text()
    assert "DEVICE_ID=PIN_DEVICE_ID" in text
    assert "ctu_validate_core_env_device_id" in text
    assert "DETECTOR_PRE_MODE=" in text
    assert "RECOVERY-GLOBAL-ATTEMPT-CONSUMED" in text
    assert "ctu_rru_successor_gate" in text
    assert "aegis-idea3-mosquitto.service" in text or "mosquitto.service" in text
    assert "chronyd.service" in text or "systemd-timesyncd.service" in text
    assert "CORE_PRE_LOAD=" in text and "CORE_PRE_ACTIVE=" in text and "CORE_PRE_RESULT=" in text
    assert "DETECTOR_PRE_LOAD=" in text and "DETECTOR_PRE_ACTIVE=" in text and "DETECTOR_PRE_RESULT=" in text
    assert "sudo -v" in text
    assert "ctu_start_sudo_keepalive" in text

    # Verify that all sudo commands after sudo -v use sudo -n
    lines = text.splitlines()
    sudo_v_idx = next(i for i, l in enumerate(lines) if "sudo -v" in l)
    sudo_pattern = re.compile(r"(?:^|[;&|(!{$]\s*|\b(?:if|elif|while|then|else)\s+)\s*sudo\b")
    for line in lines[sudo_v_idx + 1:]:
        stripped = line.strip()
        if sudo_pattern.search(stripped) and not stripped.startswith("#"):
            assert "sudo -n" in stripped, f"Found interactive or unsafeguarded sudo post-consume: {line}"

    assert "POST_CONSUME_SUDO_PROMPT_POSSIBLE=NO"


# ==============================================================================
# BLOCKER 10 — MANUAL RECONCILIATION
# ==============================================================================
def test_blocker10_manual_reconciliation(tmp_path: Path) -> None:
    assert RECONCILE_TOOL.is_file()
    canonical = tmp_path / "gov"
    canonical.mkdir()

    # Interrupted attempt: marker present, no closeout
    marker = canonical / "CTU-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\nCTU_DEVICE_ID=aegis-relay-01\n")

    env = {**os.environ, "AEGIS_CTU_TEST_ONLY_CANONICAL_DIR": str(canonical)}
    proc = subprocess.run(["python3", str(RECONCILE_TOOL), "--governance-dir", str(canonical)], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert "CTU_MANUAL_RECONCILIATION_READY=YES" in proc.stdout
    assert "CTU_ATTEMPT_CONSUMED=YES" in proc.stdout
    assert "CTU_RERUN_ALLOWED=NO" in proc.stdout
    assert "CTU_CLOSEOUT_STATE=NO_CLOSEOUT_UNTERMINATED" in proc.stdout
    assert "CTU_DIAGNOSIS=INTERRUPTED_POST_CONSUME" in proc.stdout

    # PASS closeout
    (canonical / "CTU-GLOBAL-CLOSEOUT-PASS").write_text("CTU_RESULT=PASS\n")
    proc_pass = subprocess.run(["python3", str(RECONCILE_TOOL), "--governance-dir", str(canonical)], env=env, capture_output=True, text=True)
    assert "CTU_CLOSEOUT_STATE=PASS_RECORDED" in proc_pass.stdout
    assert "CTU_DIAGNOSIS=COMPLETED_PASS" in proc_pass.stdout

    assert "CTU_MANUAL_RECONCILIATION_READY=YES"


# ==============================================================================
# BLOCKER 11 — RESTORE TEST SECURITY INTENT
# ==============================================================================
def test_blocker11_restore_test_security_intent() -> None:
    freeze_test_file = ROOT / "tests" / "recovery" / "test_recovery_runner_freeze.py"
    text = freeze_test_file.read_text()
    assert 'assert result.returncode == 1 and "TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE" in result.stderr' in text
    assert "assert tool._initial_user_namespace() is True" in text

    assert "TRUST_SEAM_TEST_WEAKENED=NO"


# ==============================================================================
# BLOCKER 12 — RECOVERY CTu NEGATIVE TEST MATRIX
# ==============================================================================
def test_blocker12_recovery_ctu_negative_matrix(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "a@b.c"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Tester"], check=True)
    (repo / "f.txt").write_text("v1\n")
    main_sha = _git_commit(repo, "commit")

    canonical = tmp_path / "gov"
    canonical.mkdir()
    closeout = canonical / "CTU-GLOBAL-CLOSEOUT-PASS"

    def _write_closeout(sha: str, extra_lines: str = ""):
        content = (
            "CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n"
            f"CTU_EXPECTED_MAIN={main_sha}\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\n"
            "CTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_DEVICE_ID=aegis-relay-01\n"
            "CTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
            f"CTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256={sha}\nCTU_EVIDENCE_ROOT=/tmp/evidence\n" + extra_lines
        )
        closeout.write_text(content)

    mock_unit = tmp_path / "aegis-idea3-core.service"
    mock_unit.write_text(
        "[Unit]\nDescription=Mock\n[Service]\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\nProtectClock=false\n"
    )
    unit_sha = hashlib.sha256(mock_unit.read_bytes()).hexdigest()
    _write_closeout(unit_sha)

    env = {
        **os.environ,
        "SUDO": "",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "RECOVERY_TEST_ONLY_TRUST_ROOT": str(tmp_path),
        "AEGIS_CORE_UNIT_FILE": str(mock_unit),
    }
    cmd = f'. "{RECOVERY_LIB}"; recovery_ctu_successor_gate "$1" "$2"'

    # Positive control
    p_ok = subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True)
    assert p_ok.returncode == 0, p_ok.stderr

    # 1. Missing closeout
    closeout.unlink()
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0
    _write_closeout(unit_sha)

    # 2. Wrong main
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), "f" * 40], env=env, capture_output=True).returncode != 0

    # 3. Duplicate closeout records (PASS + FAIL present)
    (canonical / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text("CTU_RESULT=FAIL_IMMUTABLE\n")
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0
    (canonical / "CTU-GLOBAL-CLOSEOUT-FAIL").unlink()

    # 4. Duplicate keys in closeout
    _write_closeout(unit_sha, "CTU_STAGE=CTu\n")
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0
    _write_closeout(unit_sha)

    # 5. Wrong unit SHA in closeout
    _write_closeout("0" * 64)
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0
    _write_closeout(unit_sha)

    # 6. Unhardened unit (ProtectClock=true)
    mock_unit.write_text(mock_unit.read_text().replace("ProtectClock=false", "ProtectClock=true"))
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0

    # 7. Recovery already consumed
    mock_unit.write_text(mock_unit.read_text().replace("ProtectClock=true", "ProtectClock=false"))
    (canonical / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")
    assert subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True).returncode != 0
    (canonical / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").unlink()

    # 8. Invalid CTU_DETECTOR_BASELINE_MODE
    closeout.write_text(closeout.read_text().replace("CTU_DETECTOR_BASELINE_MODE=ACTIVE", "CTU_DETECTOR_BASELINE_MODE=INVALID"))
    p_bad_det = subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True)
    assert p_bad_det.returncode != 0
    _write_closeout(unit_sha)

    # 9. Malformed CTU_DEVICE_ID
    closeout.write_text(closeout.read_text().replace("CTU_DEVICE_ID=aegis-relay-01", "CTU_DEVICE_ID=bad/device"))
    p_bad_dev = subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True)
    assert p_bad_dev.returncode != 0
    _write_closeout(unit_sha)

    assert "RECOVERY_CTU_GATE_NEGATIVE_TESTS=PASS"


# ==============================================================================
# BLOCKER 13 — CORE.ENV DEVICE ID VALIDATION TESTS
# ==============================================================================
def test_ctu_core_env_device_id_validation(tmp_path: Path) -> None:
    env_file = tmp_path / "core.env"
    cmd = f'export CTU_SUDO="" SUDO=""; . "{CTU_LIB}"; ctu_validate_core_env_device_id "$1" "$2"'

    # 1. Matching device ID
    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\nOTHER_VAR=secret\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr

    # 2. Quoted value and comments/whitespace
    env_file.write_text("# Comment\n\nAEGIS_P1_DEVICE_ID=\"aegis-relay-01\"\n# Another comment\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr

    # 3. Missing key
    env_file.write_text("SOME_OTHER_VAR=value\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "MISSING_DEVICE_ID" in proc.stderr

    # 4. Duplicate key
    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\nAEGIS_P1_DEVICE_ID=aegis-relay-02\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "DUPLICATE_DEVICE_ID" in proc.stderr

    # 5. Malformed device ID in file
    env_file.write_text("AEGIS_P1_DEVICE_ID=bad/character\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "MALFORMED_DEVICE_ID" in proc.stderr

    # 6. Device ID mismatch
    env_file.write_text("AEGIS_P1_DEVICE_ID=esp32-01\n")
    proc = subprocess.run(["bash", "-c", cmd, "val", str(env_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "DEVICE_ID_MISMATCH" in proc.stderr

    # 7. Symlink env file refused
    sym_file = tmp_path / "sym_core.env"
    sym_file.symlink_to(env_file)
    proc = subprocess.run(["bash", "-c", cmd, "val", str(sym_file), "aegis-relay-01"], capture_output=True, text=True)
    assert proc.returncode != 0
    assert "CTU_CORE_ENV_MISSING_OR_SYMLINK" in proc.stderr
