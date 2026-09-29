# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V5 authorization scope and stage-gate contract tests.

Proves:
1. V5 EXPECTED_SCOPE length is <=200 bytes/characters (global stage-gate contract).
2. V5 scope remains distinct from V3 and V4.
3. A real AEGIS_P4_AUTHORIZATION_V1 record using the exact V5 EXPECTED_SCOPE
   passes the REAL p4-stage-gate.sh parser for stage L4 with a valid K3 fixture.
4. An overlong V5 scope fails the real stage-gate parser (proving boundary coverage).
5. Existing V3 and V4 authorization behavior/definitions are preserved.
6. Owner-run freeze/auth/one-attempt semantics remain unchanged.
7. Pure repository test: no live commands, no Production mutation.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER_V5 = DEPLOY / "owner-run" / "run-l34-v5-post-l6b-degraded-owner.sh"
RUNNER_V4 = DEPLOY / "owner-run" / "run-l34-v4-post-l6b-owner.sh"
RUNNER_V3 = DEPLOY / "owner-run" / "run-l34-reactivation-owner.sh"
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"


def extract_expected_scope(runner_path: Path) -> str:
    match = re.search(r"^EXPECTED_SCOPE='([^']+)'", runner_path.read_text(), re.M)
    assert match is not None, f"EXPECTED_SCOPE not found in {runner_path}"
    return match.group(1)


def test_v5_expected_scope_length_le_200() -> None:
    scope = extract_expected_scope(RUNNER_V5)
    raw_bytes = scope.encode("ascii")
    assert 1 <= len(raw_bytes) <= 200, (
        f"V5 EXPECTED_SCOPE exceeds the global <=200 character limit: {len(raw_bytes)} bytes"
    )
    assert all(32 <= b <= 126 for b in raw_bytes), "Scope must contain only printable ASCII"


def test_v5_scope_remains_distinct_from_v3_and_v4() -> None:
    scope_v5 = extract_expected_scope(RUNNER_V5)
    scope_v4 = extract_expected_scope(RUNNER_V4)
    scope_v3 = extract_expected_scope(RUNNER_V3)

    assert scope_v5 != scope_v4
    assert scope_v5 != scope_v3
    assert scope_v4 != scope_v3

    assert "L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED:" in scope_v5
    assert "L3_L4_RUNTIME_REACTIVATION_V3" not in scope_v5
    assert "L3_L4_RUNTIME_REACTIVATION_V4" not in scope_v5


def test_v5_scope_passes_real_stage_gate_parser(tmp_path: Path) -> None:
    scope = extract_expected_scope(RUNNER_V5)
    today = subprocess.run(
        ["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"), check=True
    ).stdout.strip()

    ref_file = tmp_path / "owner-ref.txt"
    ref_file.write_text("Owner authorization record reference.\n")

    auth_file = tmp_path / "authorization-L4.txt"
    auth_file.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"authorizer=music\n"
        f"scope={scope}\n"
        f"reference=file://{ref_file}\n"
    )

    k3_file = tmp_path / "k3-L4.txt"
    k3_file.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V2\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"confirmed_by=music\n"
        f"confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
        f"idea1_window_overlap=NONE_KNOWN\n"
        f"reference=file://{ref_file}\n"
    )

    proc = subprocess.run(
        [
            "bash",
            str(STAGE_GATE),
            "--stage", "L4",
            "--mode", "live",
            "--authorization", str(auth_file),
            "--k3", str(k3_file),
        ],
        text=True,
        capture_output=True,
        env=dict(os.environ, TZ="Asia/Bangkok", LC_ALL="C"),
        check=False,
    )

    assert proc.returncode == 0, f"stage gate failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout
    assert "K3_CONFIRMATION=VALID" in proc.stdout
    assert "STAGE_GATE=PASS_SIMULATION" in proc.stdout


def test_overlong_v5_scope_fails_real_stage_gate_parser(tmp_path: Path) -> None:
    # 201-byte scope must fail the <=200 boundary
    overlong_scope = "L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED: " + ("x" * 152)
    assert len(overlong_scope) == 201

    today = subprocess.run(
        ["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"), check=True
    ).stdout.strip()

    ref_file = tmp_path / "owner-ref.txt"
    ref_file.write_text("Owner authorization record reference.\n")

    auth_file = tmp_path / "authorization-L4.txt"
    auth_file.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"authorizer=music\n"
        f"scope={overlong_scope}\n"
        f"reference=file://{ref_file}\n"
    )

    k3_file = tmp_path / "k3-L4.txt"
    k3_file.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V2\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"confirmed_by=music\n"
        f"confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
        f"idea1_window_overlap=NONE_KNOWN\n"
        f"reference=file://{ref_file}\n"
    )

    proc = subprocess.run(
        [
            "bash",
            str(STAGE_GATE),
            "--stage", "L4",
            "--mode", "live",
            "--authorization", str(auth_file),
            "--k3", str(k3_file),
        ],
        text=True,
        capture_output=True,
        env=dict(os.environ, TZ="Asia/Bangkok", LC_ALL="C"),
        check=False,
    )

    assert proc.returncode == 1
    assert "GATE_FAIL AUTHORIZATION_MALFORMED" in proc.stdout
    assert "AUTHORIZATION_RECORD=INVALID" in proc.stdout
    assert "STAGE_GATE=FAIL" in proc.stdout


def test_v3_authorization_behavior_unchanged(tmp_path: Path) -> None:
    scope_v3 = extract_expected_scope(RUNNER_V3)
    assert len(scope_v3) <= 200

    today = subprocess.run(
        ["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"), check=True
    ).stdout.strip()

    ref_file = tmp_path / "owner-ref.txt"
    ref_file.write_text("Owner authorization record reference.\n")

    auth_file = tmp_path / "authorization-L4.txt"
    auth_file.write_text(
        f"AEGIS_P4_AUTHORIZATION_V1\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"authorizer=music\n"
        f"scope={scope_v3}\n"
        f"reference=file://{ref_file}\n"
    )

    k3_file = tmp_path / "k3-L4.txt"
    k3_file.write_text(
        f"AEGIS_P4_K3_CONFIRMATION_V2\n"
        f"stage=L4\n"
        f"date={today}\n"
        f"confirmed_by=music\n"
        f"confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
        f"idea1_window_overlap=NONE_KNOWN\n"
        f"reference=file://{ref_file}\n"
    )

    proc = subprocess.run(
        [
            "bash",
            str(STAGE_GATE),
            "--stage", "L4",
            "--mode", "live",
            "--authorization", str(auth_file),
            "--k3", str(k3_file),
        ],
        text=True,
        capture_output=True,
        env=dict(os.environ, TZ="Asia/Bangkok", LC_ALL="C"),
        check=False,
    )

    assert proc.returncode == 0
    assert "AUTHORIZATION_RECORD=VALID" in proc.stdout
    assert "K3_CONFIRMATION=VALID" in proc.stdout


def test_owner_run_freeze_auth_semantics_remain_unchanged() -> None:
    text = RUNNER_V5.read_text()
    assert 'EXPECTED_MAIN=PIN_MAIN_SHA' in text
    assert 'grep -qxF "scope=$EXPECTED_SCOPE" "$AUTH_DIR/authorization-L4.txt"' in text
    assert '[ ! -e "$AUTH_DIR/L34-V5-REACTIVATION-ATTEMPT-CONSUMED" ]' in text
    assert 'marker="$AUTH_DIR/L34-V5-REACTIVATION-ATTEMPT-CONSUMED"' in text
    assert 'p4-stage-gate.sh" --stage L4 --mode live' in text
