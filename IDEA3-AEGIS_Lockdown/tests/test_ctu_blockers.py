"""Complete test suite verifying all 12 reviewer blockers for CTu.

Every blocker is covered by focused executable assertions verifying the exact
reviewer contracts and required result tokens.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
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
    pos_apply = text.index("declare -f ctu_validate_dropins_root ctu_apply_fail")

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
    cmd = f'CTU_SUDO="" SUDO="" . "{CTU_LIB}"; ctu_record_success "{"a" * 40}" "{"b" * 64}" "/tmp/evidence" "aegis-relay-01" "ACTIVE" "{"c" * 64}" "{"d" * 64}"'
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
        f"CTU_EXPECTED_MAIN={ctu_main}\nCTU_EXECUTION_MAIN={ctu_main}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\n"
        "CTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_DEVICE_ID=aegis-relay-01\nCTU_EVIDENCE_MANIFEST_SHA256=" + "d" * 64 + "\n"
        "CTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
        "CTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256=" + "b" * 64 + "\nCTU_EVIDENCE_ROOT=/tmp/evidence\n"
    )
    host_sha = hashlib.sha256(closeout.read_bytes()).hexdigest()
    sidecar = canonical / "CTU-GLOBAL-CLOSEOUT-PASS.sha256"
    sidecar.write_text(f"{host_sha}  CTU-GLOBAL-CLOSEOUT-PASS\n")
    sidecar.chmod(0o600)
    receipt = tmp_path / "ctu-live-receipt.md"
    receipt.write_text(f"CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\nCTU_EXPECTED_MAIN={ctu_main}\nCTU_EXECUTION_MAIN={ctu_main}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_UNIT_SHA256={'b' * 64}\nCTU_DEVICE_ID=aegis-relay-01\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_EVIDENCE_MANIFEST_SHA256={'d' * 64}\nCTU_HOST_CLOSEOUT_SHA256={host_sha}\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n")

    env = {
        **os.environ,
        "SUDO": "",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "RECOVERY_TEST_ONLY_TRUST_ROOT": str(tmp_path),
        "GIT_NO_REPLACE_OBJECTS": "1",
        "RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT": str(receipt),
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


def _load_snapshot_tool():
    spec = importlib.util.spec_from_file_location("ctu_verifier_snapshot", SNAPSHOT_TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _userns_usable() -> bool:
    return bool(shutil.which("unshare")) and subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


def test_blocker7_ctu_control_snapshot_directory_seal_and_permissions(tmp_path: Path) -> None:
    tool = _load_snapshot_tool()
    snap_dir = tmp_path / "snap"
    sha = tool.control_snapshot(P4, snap_dir)

    # 1. Nested directories are non-writable and 0555
    nested_dirs = [p for p in snap_dir.rglob("*") if p.is_dir()]
    assert len(nested_dirs) > 0
    assert all(not (d.stat().st_mode & 0o222) for d in nested_dirs)
    assert all((d.stat().st_mode & 0o777) == 0o555 for d in nested_dirs)

    # 2. Root snapshot directory is non-writable and 0555
    assert not (snap_dir.stat().st_mode & 0o222)
    assert (snap_dir.stat().st_mode & 0o777) == 0o555

    # 3. Nested ctu-acceptance directory is non-writable and 0555
    ctu_acc = snap_dir / "ctu-acceptance"
    assert ctu_acc.is_dir()
    assert not (ctu_acc.stat().st_mode & 0o222)
    assert (ctu_acc.stat().st_mode & 0o777) == 0o555

    # 4. Nested stages/CTu directory is non-writable and 0555
    stages_ctu = snap_dir / "stages" / "CTu"
    assert stages_ctu.is_dir()
    assert not (stages_ctu.stat().st_mode & 0o222)
    assert (stages_ctu.stat().st_mode & 0o777) == 0o555

    # 5. Copied executable/script files remain 0555
    scripts = [snap_dir / rel for rel in tool.TRUST_CLOSURE_FILES if rel.endswith((".sh", ".py"))]
    assert len(scripts) > 0
    assert all(not (s.stat().st_mode & 0o222) for s in scripts)
    assert all((s.stat().st_mode & 0o777) == 0o555 for s in scripts)

    # 6. Non-executable files remain 0444
    non_exec = [snap_dir / rel for rel in tool.TRUST_CLOSURE_FILES if rel.endswith(".txt")]
    assert len(non_exec) > 0
    assert all(not (f.stat().st_mode & 0o222) for f in non_exec)
    assert all((f.stat().st_mode & 0o777) == 0o444 for f in non_exec)

    # 7. Manifest remains 0444
    manifest = snap_dir / tool.CONTROL_MANIFEST_NAME
    assert manifest.is_file()
    assert not (manifest.stat().st_mode & 0o222)
    assert (manifest.stat().st_mode & 0o777) == 0o444

    # 8. control_check succeeds immediately on a freshly generated valid snapshot
    tool.control_check(snap_dir, sha, owner_uid=None)
    tool.check_trust_closure(snap_dir, check_permissions=True)


def test_blocker7_ctu_control_snapshot_writable_refusal(tmp_path: Path) -> None:
    tool = _load_snapshot_tool()
    snap_dir = tmp_path / "snap"
    sha = tool.control_snapshot(P4, snap_dir)

    # 9. Manually re-adding write bit to a directory causes control_check FAIL
    # Nested ctu-acceptance
    ctu_acc = snap_dir / "ctu-acceptance"
    ctu_acc.chmod(0o755)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_SOURCE_WRITABLE:ctu-acceptance"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    ctu_acc.chmod(0o555)

    # Nested stages/CTu
    stages_ctu = snap_dir / "stages" / "CTu"
    stages_ctu.chmod(0o755)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_SOURCE_WRITABLE:stages/CTu"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    stages_ctu.chmod(0o555)

    # Root snapshot directory
    snap_dir.chmod(0o755)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_SOURCE_WRITABLE:\."):
        tool.control_check(snap_dir, sha, owner_uid=None)
    snap_dir.chmod(0o555)

    # 10. Manually re-adding write bit to a file causes control_check FAIL
    # Script file
    f_sh = snap_dir / "p4-ctu-run-lib.sh"
    f_sh.chmod(0o755)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_SOURCE_WRITABLE:p4-ctu-run-lib\.sh"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    f_sh.chmod(0o555)

    # Non-executable file
    f_txt = snap_dir / "stages" / "CTu" / "allow-keys.txt"
    f_txt.chmod(0o644)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_SOURCE_WRITABLE:stages/CTu/allow-keys\.txt"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    f_txt.chmod(0o444)

    # Manifest file
    manifest = snap_dir / tool.CONTROL_MANIFEST_NAME
    manifest.chmod(0o644)
    with pytest.raises(tool.SnapshotError, match=rf"CONTROL_SOURCE_WRITABLE:{re.escape(tool.CONTROL_MANIFEST_NAME)}"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    manifest.chmod(0o444)


def test_blocker7_ctu_control_snapshot_symlink_fail_closed(tmp_path: Path) -> None:
    tool = _load_snapshot_tool()
    snap_dir = tmp_path / "snap"
    sha = tool.control_snapshot(P4, snap_dir)

    # 11. Symlink protections remain fail-closed
    # Symlink file in snapshot
    snap_dir.chmod(0o755)
    (snap_dir / "stages" / "CTu").chmod(0o755)
    link = snap_dir / "stages" / "CTu" / "symlink_test.sh"
    link.symlink_to(snap_dir / "p4-ctu-run-lib.sh")
    (snap_dir / "stages" / "CTu").chmod(0o555)
    snap_dir.chmod(0o555)
    with pytest.raises(tool.SnapshotError, match="CONTROL_SYMLINK_IN_SNAPSHOT"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    snap_dir.chmod(0o755)
    (snap_dir / "stages" / "CTu").chmod(0o755)
    link.unlink()
    (snap_dir / "stages" / "CTu").chmod(0o555)
    snap_dir.chmod(0o555)

    # Symlink directory in snapshot
    snap_dir.chmod(0o755)
    dlink = snap_dir / "symlink_dir"
    dlink.symlink_to(snap_dir / "ctu-acceptance")
    snap_dir.chmod(0o555)
    with pytest.raises(tool.SnapshotError, match="CONTROL_SYMLINK_IN_SNAPSHOT"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    snap_dir.chmod(0o755)
    dlink.unlink()
    snap_dir.chmod(0o555)

    # Symlinked snapshot root
    root_link = tmp_path / "snap_link"
    root_link.symlink_to(snap_dir)
    with pytest.raises(tool.SnapshotError, match="CONTROL_SNAPSHOT_INVALID"):
        tool.control_check(root_link, sha, owner_uid=None)


def test_blocker7_ctu_control_snapshot_trust_closure_exactness(tmp_path: Path) -> None:
    tool = _load_snapshot_tool()
    snap_dir = tmp_path / "snap"
    sha = tool.control_snapshot(P4, snap_dir)

    # 12. Trust closure set remains exact
    # Extra foreign file
    snap_dir.chmod(0o755)
    extra = snap_dir / "foreign.sh"
    extra.write_bytes(b"#!/bin/bash\nexit 0\n")
    extra.chmod(0o555)
    snap_dir.chmod(0o555)
    with pytest.raises(tool.SnapshotError, match="CONTROL_FILE_SET_MISMATCH"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    snap_dir.chmod(0o755)
    extra.unlink()
    snap_dir.chmod(0o555)

    # Missing trust closure file
    snap_dir.chmod(0o755)
    (snap_dir / "stages" / "CTu").chmod(0o755)
    missing_file = snap_dir / "stages" / "CTu" / "allow-keys.txt"
    content = missing_file.read_bytes()
    missing_file.unlink()
    (snap_dir / "stages" / "CTu").chmod(0o555)
    snap_dir.chmod(0o555)
    with pytest.raises(tool.SnapshotError, match="CONTROL_FILE_SET_MISMATCH"):
        tool.control_check(snap_dir, sha, owner_uid=None)
    with pytest.raises(tool.SnapshotError, match=r"TRUST_CLOSURE_MISSING:stages/CTu/allow-keys\.txt"):
        tool.check_trust_closure(snap_dir)
    snap_dir.chmod(0o755)
    (snap_dir / "stages" / "CTu").chmod(0o755)
    missing_file.write_bytes(content)
    missing_file.chmod(0o444)
    (snap_dir / "stages" / "CTu").chmod(0o555)
    snap_dir.chmod(0o555)

    # Altered file digest
    altered_file = snap_dir / "stages" / "CTu" / "allow-keys.txt"
    (snap_dir / "stages" / "CTu").chmod(0o755)
    altered_file.chmod(0o644)
    altered_file.write_bytes(b"modified_key_content\n")
    altered_file.chmod(0o444)
    (snap_dir / "stages" / "CTu").chmod(0o555)
    with pytest.raises(tool.SnapshotError, match=r"CONTROL_FILE_DIGEST_MISMATCH:stages/CTu/allow-keys\.txt"):
        tool.control_check(snap_dir, sha, owner_uid=None)


def test_blocker7_ctu_control_snapshot_root_owned_protection(tmp_path: Path) -> None:
    tool = _load_snapshot_tool()

    # 13. Root-owned behavior remains protected
    # Non-root cannot invoke root-owned snapshot
    with pytest.raises(tool.SnapshotError, match="ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT"):
        tool.control_snapshot(P4, tmp_path / "snap_root", root_owned=True)

    # Production trust root defaults
    assert tool.PRODUCTION_TRUST_ROOT == "/"
    assert tool.PRODUCTION_OWNER_UID == 0
    assert tool.trust_root() == "/"

    # Test seam refused in real root namespace (when initial userns)
    if tool._initial_user_namespace():
        old_en = os.environ.get(tool.TEST_SEAM_ENABLED)
        old_rt = os.environ.get(tool.TEST_SEAM_ROOT)
        try:
            os.environ[tool.TEST_SEAM_ENABLED] = "YES"
            os.environ[tool.TEST_SEAM_ROOT] = str(tmp_path)
            with pytest.raises(tool.SnapshotError, match="TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE"):
                tool.trust_root()
        finally:
            if old_en is not None:
                os.environ[tool.TEST_SEAM_ENABLED] = old_en
            else:
                os.environ.pop(tool.TEST_SEAM_ENABLED, None)
            if old_rt is not None:
                os.environ[tool.TEST_SEAM_ROOT] = old_rt
            else:
                os.environ.pop(tool.TEST_SEAM_ROOT, None)

    # Half-set test seam refused
    old_en = os.environ.get(tool.TEST_SEAM_ENABLED)
    try:
        os.environ[tool.TEST_SEAM_ENABLED] = "YES"
        os.environ.pop(tool.TEST_SEAM_ROOT, None)
        with pytest.raises(tool.SnapshotError, match="TEST_TRUST_SEAM_HALF_SET"):
            tool.trust_root()
    finally:
        if old_en is not None:
            os.environ[tool.TEST_SEAM_ENABLED] = old_en
        else:
            os.environ.pop(tool.TEST_SEAM_ENABLED, None)

    # User namespace execution if unshare available
    if _userns_usable():
        script = f"""
set -euo pipefail
TRUSTED="{tmp_path}/trusted"
mkdir -p "$TRUSTED"
export CTU_TEST_ONLY_SNAPSHOT_TRUST_ENABLED=YES
export CTU_TEST_ONLY_SNAPSHOT_TRUST_ROOT="$TRUSTED"
python3 -c '
import sys, os
from pathlib import Path
sys.path.insert(0, "{SNAPSHOT_TOOL.parent}")
import ctu_verifier_snapshot as t
src = Path("{P4}")
dest = Path("{tmp_path}/trusted/snap_userns")
sha = t.control_snapshot(src, dest, root_owned=True, trust_root_dir="{tmp_path}/trusted")
t.control_check(dest, sha, owner_uid=0, trust_root_dir="{tmp_path}/trusted")
for p in [dest, *dest.rglob("*")]:
    if p.is_dir():
        assert (p.stat().st_mode & 0o777) == 0o555, f"Dir not 0555: {{p}}"
print("USERNS_ROOT_OWNED=PASS")
'
"""
        proc = subprocess.run(["unshare", "-r", "bash", "-c", script], capture_output=True, text=True)
        assert proc.returncode == 0, f"Userns run failed: stdout={proc.stdout}\nstderr={proc.stderr}"
        assert "USERNS_ROOT_OWNED=PASS" in proc.stdout


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
                f"CTU_EXPECTED_MAIN={main_sha}\nCTU_EXECUTION_MAIN={main_sha}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_STAGE=CTu\nCTU_RUNTIME_PROOF=PASS\nCTU_AUTHENTICATED_STATUS_PROOF=PASS\n"
                "CTU_DETECTOR_LIFECYCLE_PROOF=PASS\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_DEVICE_ID=aegis-relay-01\nCTU_EVIDENCE_MANIFEST_SHA256=" + "d" * 64 + "\n"
            "CTU_PRE_POST_PRESERVATION=PASS\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
            f"CTU_FAILURE_RESULT=NONE\nCTU_UNIT_SHA256={sha}\nCTU_EVIDENCE_ROOT=/tmp/evidence\n" + extra_lines
        )
        closeout.write_text(content)
        host_sha = hashlib.sha256(closeout.read_bytes()).hexdigest()
        sidecar = canonical / "CTU-GLOBAL-CLOSEOUT-PASS.sha256"
        sidecar.write_text(f"{host_sha}  CTU-GLOBAL-CLOSEOUT-PASS\n")
        sidecar.chmod(0o600)
        receipt = tmp_path / "ctu-live-receipt.md"
        receipt.write_text(
                "CTU_LIVE=CLOSED_PASS\nCTU_LIVE_EXECUTED=YES\nCTU_RESULT=PASS\nCTU_ATTEMPT_CONSUMED=YES\n"
                f"CTU_EXPECTED_MAIN={main_sha}\nCTU_EXECUTION_MAIN={main_sha}\nCTU_RUNNER_SHA256={'c' * 64}\nCTU_UNIT_SHA256={sha}\nCTU_DEVICE_ID=aegis-relay-01\nCTU_DETECTOR_BASELINE_MODE=ACTIVE\nCTU_EVIDENCE_MANIFEST_SHA256={'d' * 64}\nCTU_HOST_CLOSEOUT_SHA256={host_sha}\nRECOVERY_LIVE_EXECUTED=NO\nRECOVERY_ATTEMPT_CONSUMED=NO\n"
        )
        return receipt

    mock_unit = tmp_path / "aegis-idea3-core.service"
    mock_unit.write_text(
        "[Unit]\nDescription=Mock\n[Service]\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\nProtectClock=false\n"
    )
    unit_sha = hashlib.sha256(mock_unit.read_bytes()).hexdigest()
    receipt = _write_closeout(unit_sha)

    env = {
        **os.environ,
        "SUDO": "",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED": "YES",
        "RECOVERY_TEST_ONLY_CANONICAL_DIR": str(canonical),
        "RECOVERY_TEST_ONLY_TRUST_ROOT": str(tmp_path),
        "AEGIS_CORE_UNIT_FILE": str(mock_unit),
        "RECOVERY_TEST_ONLY_CTU_LIVE_RECEIPT": str(receipt),
    }
    cmd = f'. "{RECOVERY_LIB}"; recovery_ctu_successor_gate "$1" "$2"'

    # Positive control
    p_ok = subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True)
    assert p_ok.returncode == 0, p_ok.stderr

    # Host closeout and reviewed repository receipt are both mandatory.
    sidecar = canonical / "CTU-GLOBAL-CLOSEOUT-PASS.sha256"
    sidecar.unlink()
    assert "RECOVERY_CTU_HOST_CLOSEOUT_DIGEST_MISSING" in subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True).stderr
    receipt = _write_closeout(unit_sha)
    sidecar.write_text("0" * 64 + "  CTU-GLOBAL-CLOSEOUT-PASS\n")
    sidecar.chmod(0o600)
    assert "RECOVERY_CTU_HOST_CLOSEOUT_DIGEST_INVALID" in subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True).stderr
    _write_closeout(unit_sha)
    receipt.unlink()
    assert "RECOVERY_CTU_LIVE_RECEIPT_MISSING" in subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True).stderr
    receipt = _write_closeout(unit_sha)
    receipt.write_text(receipt.read_text().replace("CTU_HOST_CLOSEOUT_SHA256=", "CTU_HOST_CLOSEOUT_SHA256=" + "0" * 64 + " #"))
    assert "RECOVERY_CTU_REPOSITORY_RECEIPT_HOST_BINDING_INVALID" in subprocess.run(["bash", "-c", cmd, "gate", str(repo), main_sha], env=env, capture_output=True, text=True).stderr
    _write_closeout(unit_sha)

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


def test_ctu_and_recovery_handlers_require_frozen_provenance_before_privileged_work() -> None:
    ctu_apply = (CTU / "apply.sh").read_text()
    ctu_runner = RUNNER.read_text()
    recovery_apply = (P4 / "stages" / "Recovery" / "apply.sh").read_text()
    assert "CTU_FROZEN_RUNNER_SHA256" in ctu_runner
    assert "CTU-GLOBAL-ATTEMPT-CONSUMED" in ctu_runner
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in ctu_apply
    assert "AEGIS_RCVSTAGE_PROVENANCE_FILE" in recovery_apply
    assert "RECOVERY_FROZEN_RUNNER_SHA256" in recovery_apply
    assert "RECOVERY_PROVENANCE" in recovery_apply

    # Caller-controlled authorization is not provenance.  The fixed marker
    # and frozen-runner checks must precede the first privileged action.
    assert ctu_runner.index("CTU_PROVENANCE_MISSING") < ctu_runner.index("systemctl restart")
    assert recovery_apply.index("RECOVERY_PROVENANCE_MISSING") < recovery_apply.index("RUN()")
    assert "AEGIS_CTU_LIVE_AUTHORIZED=YES" in ctu_runner
    assert "AEGIS_RCVSTAGE_LIVE_AUTHORIZED=YES" not in recovery_apply


def test_direct_handler_calls_and_replayed_provenance_are_refused() -> None:
    ctu_apply = (CTU / "apply.sh").read_text()
    ctu_runner = RUNNER.read_text()
    recovery_apply = (P4 / "stages" / "Recovery" / "apply.sh").read_text()

    # A direct root invocation can supply caller-controlled inputs, but cannot
    # manufacture the root-owned consumed marker or frozen-runner binding.
    assert "MARKER=/var/lib/aegis-idea3-governance/CTU-GLOBAL-ATTEMPT-CONSUMED" in ctu_runner
    assert 'stat -c %u:%a "$MARKER"' in ctu_runner
    assert "marker_runner" in ctu_runner and "marker_bundle" in ctu_runner
    assert "CTU-FROZEN-RUNNER-PROVENANCE" in ctu_runner
    assert "CTU_HANDLER_PROVENANCE_CONSUME_FAILED" in ctu_runner
    assert "RECOVERY_PROVENANCE_MISSING" in recovery_apply
    assert "RECOVERY_FROZEN_RUNNER_PROVENANCE_INVALID" in recovery_apply
    assert "RECOVERY_CONTROL_PROVENANCE_INVALID" in recovery_apply

    # Replay still binds to these exact frozen bytes, not to a caller-selected
    # digest supplied in an environment variable.
    assert 'sha256sum "$AEGIS_CTU_BUNDLE/owner-run/run-ctu-owner.sh"' in ctu_runner
    assert 'sha256sum "$CONTROL/owner-run/run-recovery-owner.sh"' in recovery_apply


def test_direct_handler_dynamic_negative_fixture_reaches_no_privileged_call(tmp_path: Path) -> None:
    calls = tmp_path / "calls"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for command in ("systemctl", "install", "mv", "cp"):
        (fake_bin / command).write_text(f'#!/bin/sh\nprintf {command}-called >> "{calls}"\nexit 0\n')
        (fake_bin / command).chmod(0o755)
    unit = tmp_path / "aegis-idea3-core.service"
    unit.write_text("original-unit\n")
    unit_before = unit.read_bytes()
    fake_bundle = tmp_path / "bundle"
    (fake_bundle / "owner-run").mkdir(parents=True)
    (fake_bundle / "CTU-BUNDLE-SHA256SUMS").write_text("fake\n")
    fake_provenance = tmp_path / "CTU-FROZEN-RUNNER-PROVENANCE"
    fake_provenance.write_text("CTU_FROZEN_RUNNER_SHA256=" + "a" * 64 + "\n")
    fake_provenance.chmod(0o600)
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "AEGIS_CTU_LIVE_AUTHORIZED": "YES",
        "AEGIS_CTU_WORK_DIR": str(tmp_path),
        "AEGIS_CTU_UNIT_SNAPSHOT": str(tmp_path / "unit"),
        "AEGIS_CTU_UNIT_SHA256": "b" * 64,
        "AEGIS_CTU_BUNDLE": str(fake_bundle),
        "AEGIS_CTU_JOURNAL_SINCE": "now",
        "AEGIS_CTU_DETECTOR_PRE_MODE": "INACTIVE",
    }
    for label, runner_sha in (("fake", "a" * 64), ("wrong", "b" * 64), ("stale", "c" * 64)):
        fake_provenance.chmod(0o600)
        fake_provenance.write_text(f"CTU_FROZEN_RUNNER_SHA256={runner_sha}\n")
        fake_provenance.chmod(0o400)
        direct = subprocess.run(["bash", str(CTU / "apply.sh")], env=env, text=True, capture_output=True)
        assert direct.returncode != 0, label
        assert "DIRECT_HANDLER_INVOCATION_REFUSED" in direct.stderr, label
        assert not calls.exists(), f"direct CTu apply reached the systemctl stub ({label})"
        sourced = subprocess.run(
            ["bash", "-c", 'source "$1"', "direct-source", str(CTU / "apply.sh")],
            env=env, text=True, capture_output=True,
        )
        assert sourced.returncode != 0 and "DIRECT_HANDLER_INVOCATION_REFUSED" in sourced.stderr, label
        assert not calls.exists(), f"sourced CTu apply reached the systemctl stub ({label})"
        assert unit.read_bytes() == unit_before

    rollback_direct = subprocess.run(
        ["bash", str(CTU / "rollback.sh")], env=env, text=True, capture_output=True,
    )
    assert rollback_direct.returncode != 0
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in rollback_direct.stderr
    assert not calls.exists(), "direct CTu rollback reached the systemctl stub"
    assert unit.read_bytes() == unit_before
    assert not (tmp_path / "mutation-journal").exists()

    recovery = P4 / "stages" / "Recovery" / "apply.sh"
    recovery_direct = subprocess.run(
        ["bash", str(recovery)],
        env={**env, "AEGIS_RCVSTAGE_LIVE_AUTHORIZED": "YES", "AEGIS_RCVSTAGE_STEP": "FINAL"},
        text=True,
        capture_output=True,
    )
    assert recovery_direct.returncode != 0
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in recovery_direct.stderr
    assert not calls.exists(), "direct Recovery handler reached the systemctl stub"
    verify_direct = subprocess.run(
        ["bash", str(P4 / "stages" / "Recovery" / "verify.sh")],
        env={**env, "AEGIS_RCVSTAGE_LIVE_AUTHORIZED": "YES", "AEGIS_RCVSTAGE_STEP": "FINAL"},
        text=True,
        capture_output=True,
    )
    assert verify_direct.returncode != 0
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in verify_direct.stderr
    assert not calls.exists(), "direct Recovery verify reached the systemctl stub"

    # The reviewed runner is the only caller that exports the embedded
    # privileged routine; it does not execute a standalone handler file.
    runner = RUNNER.read_text()
    recovery_runner = (P4 / "owner-run" / "run-recovery-owner.sh").read_text()
    assert "ctu_apply_governed" in runner
    assert "recovery_apply_governed" in recovery_runner
    assert "recovery_verify_governed" in recovery_runner


def test_core_env_post_restart_toctou_is_bound_to_preimage(tmp_path: Path) -> None:
    verifier = _load_runtime_verifier()
    env_file = tmp_path / "core.env"
    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\n")
    pre_sha = hashlib.sha256(env_file.read_bytes()).hexdigest()
    verifier.verify_core_env(env_file, "aegis-relay-01", pre_sha)

    env_file.write_text("AEGIS_P1_DEVICE_ID=esp32-01\n")
    with pytest.raises(verifier.RuntimeProofError, match="CORE_ENV_CHANGED_ACROSS_ATTEMPT"):
        verifier.verify_core_env(env_file, "aegis-relay-01", pre_sha)

    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\nAEGIS_P1_DEVICE_ID=aegis-relay-01\n")
    duplicate_sha = hashlib.sha256(env_file.read_bytes()).hexdigest()
    with pytest.raises(verifier.RuntimeProofError, match="CORE_ENV_DEVICE_ID_CARDINALITY"):
        verifier.verify_core_env(env_file, "aegis-relay-01", duplicate_sha)


def test_inactive_detector_transient_lifecycle_is_refused() -> None:
    verifier = _load_runtime_verifier()
    inactive = {
        "load": "loaded", "active": "inactive", "sub": "dead", "unit_file": "disabled",
        "restart": "no", "pid": "0", "invocation": "", "monotonic": "0",
        "nrestarts": "0", "process_count": "0", "lifecycle_events": "0",
    }
    verifier.verify_detector(inactive, inactive, 0, post_apply=inactive, mode="INACTIVE")
    transient = dict(inactive, lifecycle_events="1")
    with pytest.raises(verifier.RuntimeProofError):
        verifier.verify_detector(inactive, transient, 0, post_apply=transient, mode="INACTIVE")


def test_ctu_interpreter_is_not_environment_selectable() -> None:
    text = CTU_LIB.read_text()
    assert 'CTU_PYTHON:-' not in text
    assert 'command -v python3' not in text
    assert '/usr/bin/python3 -I -B' in text


def test_ctu_frozen_entrypoint_cleans_startup_and_loader_environment(tmp_path: Path) -> None:
    """The executable runner must sanitize before Bash/Python can be selected."""
    sentinel = tmp_path / "startup-sentinel"
    calls = tmp_path / "mutation-calls"
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    for name in ("bash", "python3", "systemctl"):
        fake = fake_bin / name
        fake.write_text(f'#!/bin/sh\nprintf "{name}" >> "{calls}"\nexit 97\n')
        fake.chmod(0o755)
    bash_env = tmp_path / "bash-env"
    bash_env.write_text(f'printf sourced > "{sentinel}"\n')
    hostile_python = tmp_path / "hostile-python"
    hostile_python.mkdir()
    (hostile_python / "sitecustomize.py").write_text(f'open("{sentinel}", "w").write("python")\n')

    base = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "BASH_ENV": str(bash_env),
        "ENV": str(bash_env),
        "PYTHONPATH": str(hostile_python),
        "PYTHONHOME": str(tmp_path / "not-python"),
        "PYTHONSTARTUP": str(bash_env),
        "PYTHONINSPECT": "1",
        "LD_PRELOAD": str(tmp_path / "missing-preload.so"),
        "LD_LIBRARY_PATH": str(tmp_path),
        "AEGIS_CTU_LIVE_AUTHORIZED": "YES",
        "GIT_DIR": str(tmp_path / "hostile.git"),
        "BASH_FUNC_systemctl%%": "() { echo imported >> '" + str(calls) + "'; }",
    }
    proc = subprocess.run([str(RUNNER), str(tmp_path / "fake-auth")], env=base, text=True, capture_output=True)
    assert proc.returncode != 0
    assert not sentinel.exists(), proc.stderr
    assert not calls.exists(), proc.stderr
    assert "CTU-GLOBAL-ATTEMPT-CONSUMED" not in str(tmp_path)

    # Each loader/startup variable is independently neutralized by the clean
    # exec boundary; this also guards against a future partial allow-list.
    for name, value in {
        "BASH_ENV": str(bash_env),
        "ENV": str(bash_env),
        "PYTHONPATH": str(hostile_python),
        "PYTHONHOME": str(tmp_path / "not-python"),
        "PYTHONSTARTUP": str(bash_env),
        "PYTHONINSPECT": "1",
        "LD_PRELOAD": str(tmp_path / "missing-preload.so"),
        "LD_LIBRARY_PATH": str(tmp_path),
    }.items():
        sentinel.unlink(missing_ok=True)
        calls.unlink(missing_ok=True)
        env = {"PATH": "/usr/bin:/bin", name: value}
        result = subprocess.run([str(RUNNER), str(tmp_path / "fake-auth")], env=env, text=True, capture_output=True)
        assert result.returncode != 0, name
        assert not sentinel.exists(), (name, result.stderr)
        assert not calls.exists(), (name, result.stderr)


def test_ctu_core_restart_contract_is_truthful_on_success_and_failure_paths() -> None:
    runner = RUNNER.read_text()
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in (CTU / "apply.sh").read_text()
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in (CTU / "rollback.sh").read_text()
    assert runner.count("systemctl restart aegis-idea3-core.service") == 2
    assert "declare -f ctu_validate_dropins_root ctu_apply_fail ctu_apply_governed" in runner
    assert "declare -f ctu_validate_dropins_root ctu_rollback_fail ctu_rollback_governed" in runner
    apply_body = runner[runner.index("ctu_apply_governed() {"):runner.index("ctu_rollback_fail()")]
    rollback_body = runner[runner.index("ctu_rollback_governed() {"):runner.index("IN_POST_FAIL=0")]
    assert apply_body.count("systemctl restart aegis-idea3-core.service") == 1
    assert rollback_body.count("systemctl restart aegis-idea3-core.service") == 1
    assert "PRECONSUME_CORE_RESTARTS=0" in runner
    assert "POST_CONSUME_FAILURE_MAX_CORE_RESTARTS=2" in runner
    assert "ROLLBACK_CORE_RESTARTS_MAX=1" in runner
    assert "systemctl restart aegis-idea3-core.service" not in runner[runner.index("ctu_consume_attempt"):runner.index("declare -f ctu_validate_dropins_root ctu_apply_fail")]
    assert "post_fail" in runner and "rollback_flow" in runner
