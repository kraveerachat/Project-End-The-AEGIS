"""AEGIS IDEA3 PR11 Phase 4 — L1 live package backend test suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md
Decisions: D1 (disk threshold=90), D2 (pacman/chrony contract), D3 (rollback).

Live authorization is coupled to the CANONICAL p4-stage-gate.sh: this module
never re-implements record parsing, it writes real
AEGIS_P4_AUTHORIZATION_V1 / AEGIS_P4_K3_CONFIRMATION_V1 record files and lets
the actual gate script validate them, exactly as a real stage runner would.

Every test in this file runs against a mocked `run_pacman`/`subprocess.run`
seam or exercises the fail-closed path that never reaches pacman at all. No
test in this file invokes a real package manager, mutates /etc or /opt,
starts/enables a service, or contacts any live host service. Live execution
is never authorized here.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import re
import subprocess
import sys
import types
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L1_STAGE = STAGES / "L1"
L1_PACKAGES = DEPLOY / "p4-l1-packages.py"
GATE = DEPLOY / "p4-stage-gate.sh"

LIVE_AUTH_FILE_ENV = "AEGIS_L1_LIVE_AUTHORIZATION_FILE"
LIVE_K3_FILE_ENV = "AEGIS_L1_LIVE_K3_FILE"

WINDOW_TZ = ZoneInfo("Asia/Bangkok")


def today(offset: int = 0) -> str:
    return (dt.datetime.now(WINDOW_TZ).date() + dt.timedelta(days=offset)).isoformat()


def auth_record(stage: str = "L1", date: str | None = None, **overrides: str) -> str:
    fields = {
        "stage": stage,
        "date": date or today(),
        "authorizer": "music",
        "scope": "test-only placeholder authorization record",
        "reference": "https://example.invalid/aegis-p4-test-authorization",
        "d6_notice": "pub",
    }
    fields.update(overrides)
    body = "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None)
    return "AEGIS_P4_AUTHORIZATION_V1\n" + body


def k3_record(stage: str = "L1", date: str | None = None, **overrides: str) -> str:
    fields = {
        "stage": stage,
        "date": date or today(),
        "confirmed_by": "kraveerachat",
        "idea1_window_overlap": "NONE",
        "reference": "https://example.invalid/aegis-p4-test-k3",
    }
    fields.update(overrides)
    return "AEGIS_P4_K3_CONFIRMATION_V1\n" + "".join(
        f"{k}={v}\n" for k, v in fields.items() if v is not None
    )


def _write(path: Path, content: str) -> str:
    path.write_text(content)
    return str(path)


def valid_auth_k3_files(tmp_path: Path) -> tuple[str, str]:
    # Distinct filenames from any test-local "auth.txt"/"k3.txt" so a test
    # customizing one side never has it silently overwritten by this helper.
    return (
        _write(tmp_path / "valid_auth.txt", auth_record()),
        _write(tmp_path / "valid_k3.txt", k3_record()),
    )


def _load_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("p4_l1_packages_under_test", L1_PACKAGES)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def mod(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    monkeypatch.delenv(LIVE_AUTH_FILE_ENV, raising=False)
    monkeypatch.delenv(LIVE_K3_FILE_ENV, raising=False)
    return _load_module()


def _fake_completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["pacman"], returncode=returncode, stdout=stdout, stderr=stderr)


# ---------------------------------------------------------------------------
# Gate-coupled authorization: exact scenarios required by the hardening pass
# ---------------------------------------------------------------------------


def test_live_authorization_absent_by_default(mod: types.ModuleType) -> None:
    assert mod.live_authorization_present() is False


def test_live_authorization_valid_records_pass(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is True


def test_live_authorization_missing_auth_file_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, str(tmp_path / "does-not-exist.txt"))
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_malformed_auth_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth = _write(tmp_path / "auth.txt", "NOT_A_VALID_RECORD\nfoo=bar\n")
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_stale_auth_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth = _write(tmp_path / "auth.txt", auth_record(date=today(offset=-1)))
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_wrong_stage_auth_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth = _write(tmp_path / "auth.txt", auth_record(stage="L2", d6_notice=None, integration_review="kla"))
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_missing_d6_notice_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth = _write(tmp_path / "auth.txt", auth_record(d6_notice=None))
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_wrong_d6_notice_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth = _write(tmp_path / "auth.txt", auth_record(d6_notice="kla"))
    _, k3 = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_missing_k3_file_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, _ = valid_auth_k3_files(tmp_path)
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, str(tmp_path / "missing-k3.txt"))
    assert mod.live_authorization_present() is False


def test_live_authorization_malformed_k3_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, _ = valid_auth_k3_files(tmp_path)
    k3 = _write(tmp_path / "k3.txt", "NOT_A_K3_RECORD\nfoo=bar\n")
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_stale_k3_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, _ = valid_auth_k3_files(tmp_path)
    k3 = _write(tmp_path / "k3.txt", k3_record(date=today(offset=-1)))
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_wrong_stage_k3_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, _ = valid_auth_k3_files(tmp_path)
    k3 = _write(tmp_path / "k3.txt", k3_record(stage="L2"))
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_k3_overlap_not_none_fails(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    auth, _ = valid_auth_k3_files(tmp_path)
    k3 = _write(tmp_path / "k3.txt", k3_record(idea1_window_overlap="0900-1000"))
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, auth)
    monkeypatch.setenv(LIVE_K3_FILE_ENV, k3)
    assert mod.live_authorization_present() is False


def test_live_authorization_forged_env_vars_without_real_files_fail(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plausible-looking but nonexistent path must fail closed — no boolean
    or static token can substitute for real, gate-validated records."""
    monkeypatch.setenv(LIVE_AUTH_FILE_ENV, "/tmp/forged-auth-does-not-exist.txt")
    monkeypatch.setenv(LIVE_K3_FILE_ENV, "/tmp/forged-k3-does-not-exist.txt")
    assert mod.live_authorization_present() is False


def test_pacman_bin_is_fixed_canonical_path(mod: types.ModuleType) -> None:
    assert mod.PACMAN_BIN == "/usr/bin/pacman"


def test_pacman_bin_not_overridable_by_environment(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PACMAN_BIN", "/tmp/not-a-real-pacman")
    monkeypatch.setenv("AEGIS_PACMAN_BIN", "/tmp/not-a-real-pacman")
    reloaded = _load_module()
    assert reloaded.PACMAN_BIN == "/usr/bin/pacman"


def test_live_authorization_uses_real_gate_script_not_a_duplicate_parser(
    mod: types.ModuleType,
) -> None:
    assert mod.GATE_SCRIPT == GATE.resolve()
    assert mod.GATE_SCRIPT.is_file()


# ---------------------------------------------------------------------------
# CLI / shell entry points fail closed without live authorization
# ---------------------------------------------------------------------------


def test_cli_simulate_install_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    """Live mode never passes --fs-root: it is a TEST-ONLY fixture prefix."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    proc = subprocess.run(
        [
            sys.executable, str(L1_PACKAGES), "simulate-install",
            "--backend", "live", "--work-dir", str(work_dir), "--packages", "chrony",
        ],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_cli_simulate_install_live_with_fs_root_fails_closed(tmp_path: Path) -> None:
    """FS_ROOT contract requirement #3 at the python layer: passing --fs-root
    in live mode is refused outright, before authorization is even checked."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    proc = subprocess.run(
        [
            sys.executable, str(L1_PACKAGES), "simulate-install",
            "--backend", "live", "--work-dir", str(work_dir),
            "--fs-root", str(fs_root), "--packages", "chrony",
        ],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_MODE_FS_ROOT_REFUSED" in proc.stderr


def test_cli_rollback_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(L1_PACKAGES), "rollback", "--backend", "live"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_cli_rollback_live_with_fs_root_fails_closed(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    proc = subprocess.run(
        [sys.executable, str(L1_PACKAGES), "rollback", "--backend", "live", "--fs-root", str(fs_root)],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_MODE_FS_ROOT_REFUSED" in proc.stderr


def test_cli_verify_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(L1_PACKAGES), "verify", "--backend", "live"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_cli_verify_live_with_fs_root_fails_closed(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    proc = subprocess.run(
        [sys.executable, str(L1_PACKAGES), "verify", "--backend", "live", "--fs-root", str(fs_root)],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_MODE_FS_ROOT_REFUSED" in proc.stderr


def test_apply_sh_live_direct_invocation_with_forged_env_cannot_proceed(tmp_path: Path) -> None:
    """Requirement #1/#2: direct apply.sh live invocation with forged/boolean
    env vars (no real gate-validatable files) cannot reach pacman. Live mode
    never sets AEGIS_P4_FS_ROOT (a TEST-ONLY fixture prefix)."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["DISK_THRESHOLD_PCT"] = "90"
    # Forged legacy-style boolean vars must have no effect at all.
    env["AEGIS_L1_LIVE_AUTHORIZATION_TOKEN"] = "AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"
    env["AEGIS_L1_LIVE_K3_CONFIRMED"] = "YES"
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_AUTHORIZATION_MISSING" in proc.stderr
    assert "NOT_AUTHORIZED" in proc.stderr


def test_apply_sh_live_with_fs_root_set_fails_closed_before_pacman(tmp_path: Path) -> None:
    """FS_ROOT contract requirement #3: live mode with AEGIS_P4_FS_ROOT set
    must fail closed, even with otherwise-valid authorization records, and
    must never reach the python helper (no pacman invocation possible)."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    auth, k3 = valid_auth_k3_files(tmp_path)
    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env[LIVE_AUTH_FILE_ENV] = auth
    env[LIVE_K3_FILE_ENV] = k3
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_MODE_FS_ROOT_REFUSED" in proc.stderr
    assert not (fs_root / "usr").exists()  # no fixture tree was ever created


def test_apply_sh_live_without_fs_root_invalid_auth_fails_closed(tmp_path: Path) -> None:
    """FS_ROOT contract requirement #4: live mode with FS_ROOT correctly
    unset but invalid/missing authorization still fails closed."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_AUTHORIZATION_MISSING" in proc.stderr


def test_apply_sh_live_with_valid_records_reaches_gate_pass_creates_no_fixture_tree(tmp_path: Path) -> None:
    """Requirement #14 + #5/#8: a fully valid same-day L1 authorization + K3
    pair must pass the in-script gate re-invocation and never create any
    fixture filesystem tree. To prove this WITHOUT ever invoking real
    pacman, AEGIS_PYTHON_BIN is pointed at a stub that never touches pacman
    and simply records that it was reached — proving the authorization gate
    itself passed and control flow continued past it."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    auth, k3 = valid_auth_k3_files(tmp_path)
    fake_python = tmp_path / "fake_python3.sh"
    fake_python.write_text("#!/usr/bin/env bash\necho FAKE_PYTHON_INVOKED \"$@\"\nexit 0\n")
    fake_python.chmod(0o755)
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_PYTHON_BIN"] = str(fake_python)
    env[LIVE_AUTH_FILE_ENV] = auth
    env[LIVE_K3_FILE_ENV] = k3
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert "LIVE_AUTHORIZATION_MISSING" not in proc.stderr
    assert "LIVE_MODE_FS_ROOT_REFUSED" not in proc.stderr
    assert "FAKE_PYTHON_INVOKED" in proc.stdout  # proves the gate passed and flow continued
    assert proc.returncode == 0
    fake_python_call = [line for line in proc.stdout.splitlines() if "FAKE_PYTHON_INVOKED" in line][0]
    assert "--fs-root" not in fake_python_call  # live mode never passes --fs-root
    assert not any(tmp_path.glob("**/usr/bin/chronyd"))  # no fixture tree anywhere


def test_rollback_sh_live_direct_invocation_with_forged_env_cannot_proceed(tmp_path: Path) -> None:
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_LIVE_AUTHORIZATION_TOKEN"] = "AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"
    env["AEGIS_L1_LIVE_K3_CONFIRMED"] = "YES"
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_rollback_sh_live_with_fs_root_set_fails_closed(tmp_path: Path) -> None:
    """FS_ROOT contract requirement #7: rollback live mode does not require
    (and must refuse) AEGIS_P4_FS_ROOT."""
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    auth, k3 = valid_auth_k3_files(tmp_path)
    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env[LIVE_AUTH_FILE_ENV] = auth
    env[LIVE_K3_FILE_ENV] = k3
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_MODE_FS_ROOT_REFUSED" in proc.stderr


def test_verify_sh_live_does_not_require_fs_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """FS_ROOT contract requirement #6: live verify does not require
    AEGIS_P4_FS_ROOT. Authorization is absent here, so this still fails
    closed — the point is it fails on NOT_AUTHORIZED, never on a missing
    fs-root/work-dir requirement."""
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env.pop("AEGIS_L1_WORK_DIR", None)
    env["AEGIS_L1_BACKEND"] = "live"
    proc = subprocess.run(
        [
            sys.executable, str(L1_PACKAGES), "verify", "--backend", "live",
        ],
        cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr
    assert "fs-root" not in proc.stderr.lower()
    assert "work-dir" not in proc.stderr.lower()


# ---------------------------------------------------------------------------
# Preflight transaction contract (mocked pacman)
# ---------------------------------------------------------------------------


def test_preflight_accepts_exact_chrony(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout="chrony\n"))
    assert mod.pacman_preflight_transaction("chrony") == {"chrony"}


def test_preflight_rejects_dependency_addition(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout="chrony\nlibedit\n"))
    with pytest.raises(SystemExit):
        mod.live_install_package("chrony")


@pytest.mark.parametrize("extra", ["linux", "systemd", "networkmanager", "mosquitto"])
def test_preflight_rejects_specific_unrelated_packages(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, extra: str
) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout=f"chrony\n{extra}\n"))
    with pytest.raises(SystemExit):
        mod.live_install_package("chrony")


def test_preflight_empty_output_fails_closed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout=""))
    with pytest.raises(SystemExit):
        mod.pacman_preflight_transaction("chrony")


def test_preflight_command_failure_fails_closed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(1, stderr="error: some failure"))
    with pytest.raises(SystemExit):
        mod.pacman_preflight_transaction("chrony")


def test_preflight_never_passes_refresh_or_upgrade_flags(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        seen.append(list(args))
        return _fake_completed(0, stdout="chrony\n")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    mod.pacman_preflight_transaction("chrony")
    joined = " ".join(seen[0])
    for forbidden in ("-Sy", "-Su", "-Syu", "--refresh", "--sysupgrade"):
        assert forbidden not in joined


# ---------------------------------------------------------------------------
# Install contract (mocked pacman)
# ---------------------------------------------------------------------------


def test_live_install_runs_after_exact_preflight_match(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        if "--print" in args:
            return _fake_completed(0, stdout="chrony\n")
        return _fake_completed(0)

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    mod.live_install_package("chrony")
    assert len(calls) == 2
    install_call = calls[1]
    assert "chrony" in install_call
    for forbidden in ("-Sy", "-Su", "-Syu", "--refresh", "--sysupgrade"):
        assert forbidden not in " ".join(install_call)


def test_live_install_command_failure_fails_closed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        if "--print" in args:
            return _fake_completed(0, stdout="chrony\n")
        return _fake_completed(1, stderr="transaction failed")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    with pytest.raises(SystemExit):
        mod.live_install_package("chrony")


def test_no_install_without_preflight_match(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    install_attempted = False

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        nonlocal install_attempted
        if "--print" in args:
            return _fake_completed(0, stdout="chrony\nextra-dep\n")
        install_attempted = True
        return _fake_completed(0)

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    with pytest.raises(SystemExit):
        mod.live_install_package("chrony")
    assert install_attempted is False


# ---------------------------------------------------------------------------
# Rollback contract (mocked pacman) — idempotence per OD-L1-08
# ---------------------------------------------------------------------------


def test_live_rollback_removes_target_when_present(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _fake_completed(0)  # --query succeeds (installed); --remove succeeds

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    mod.live_rollback_package("chrony")
    assert len(calls) == 2
    query_call, remove_call = calls
    assert "--query" in query_call
    joined = " ".join(remove_call)
    assert "chrony" in remove_call
    for forbidden in ("-Rns", "-Rs", "-Rc", "--recursive", "--cascade"):
        assert forbidden not in joined


def test_live_rollback_already_absent_is_idempotent_no_remove_call(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OD-L1-08: rollback is idempotent. If chrony is already absent, this
    must succeed without ever invoking a removal command."""
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _fake_completed(1, stderr="error: package 'chrony' was not found")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    mod.live_rollback_package("chrony")  # must not raise
    assert len(calls) == 1
    assert "--query" in calls[0]


def test_live_rollback_ambiguous_query_failure_fails_closed(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A query failure that is NOT pacman's own not-found message is
    ambiguous and must fail closed rather than being treated as absence."""
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _fake_completed(1, stderr="error: could not open database")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    with pytest.raises(SystemExit):
        mod.live_rollback_package("chrony")
    assert len(calls) == 1  # never attempted removal


def test_live_rollback_dependency_conflict_fails_closed_no_escalation(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        if "--query" in args:
            return _fake_completed(0)  # installed
        return _fake_completed(1, stderr="error: failed to remove chrony (could not satisfy dependencies)")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    with pytest.raises(SystemExit):
        mod.live_rollback_package("chrony")
    assert len(calls) == 2  # query + one remove attempt, never a second/escalated call


# ---------------------------------------------------------------------------
# Verify contract (mocked pacman + systemctl) — fail-closed service queries
# ---------------------------------------------------------------------------


def test_live_verify_fails_if_package_not_installed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(1, stderr="error: package 'chrony' was not found"))
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


def test_live_verify_active_state_query_failure_fails_closed(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        return _fake_completed(1, stderr="Failed to get properties: Unit not loaded")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


def test_live_verify_unit_file_state_query_failure_fails_closed(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        if "ActiveState" in cmd:
            return _fake_completed(0, stdout="inactive\n")
        return _fake_completed(1, stderr="Failed to get properties")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


def test_live_verify_empty_state_fails_closed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        return _fake_completed(0, stdout="")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


def test_live_verify_fails_if_service_active(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        if "ActiveState" in cmd:
            return _fake_completed(0, stdout="active\n")
        return _fake_completed(0, stdout="disabled\n")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


def test_live_verify_fails_if_service_enabled(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        if "ActiveState" in cmd:
            return _fake_completed(0, stdout="inactive\n")
        return _fake_completed(0, stdout="enabled\n")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    with pytest.raises(SystemExit):
        mod.live_verify_package("chrony")


@pytest.mark.parametrize("unit_file_state", ["disabled", "static"])
def test_live_verify_passes_when_installed_inactive_and_accepted_unit_state(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch, unit_file_state: str
) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        if "ActiveState" in cmd:
            return _fake_completed(0, stdout="inactive\n")
        return _fake_completed(0, stdout=f"{unit_file_state}\n")

    monkeypatch.setattr(subprocess, "run", fake_systemctl)
    mod.live_verify_package("chrony")  # must not raise


# ---------------------------------------------------------------------------
# Static safety audit — executable source paths only
# ---------------------------------------------------------------------------

FORBIDDEN_LIVE_TOKENS = (
    "-Sy", "-Su", "-Syu", "-Rns", "-Rs", "-Rc",
    "--refresh", "--sysupgrade", "--recursive", "--cascade",
)


def test_l1_live_sources_never_pass_forbidden_pacman_flags_as_literals() -> None:
    """Checks only quoted string-literal argv tokens (the only form that can
    actually reach subprocess), not prose in comments/docstrings that merely
    names a forbidden flag for documentation purposes."""
    sources = (
        L1_PACKAGES,
        L1_STAGE / "apply.sh",
        L1_STAGE / "verify.sh",
        L1_STAGE / "rollback.sh",
    )
    for path in sources:
        content = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_LIVE_TOKENS:
            quoted = re.findall(r"""(['"])""" + re.escape(token) + r"""\1""", content)
            assert not quoted, f"forbidden literal argv token {token!r} found in {path.name}"


def test_l1_live_sources_never_enable_or_start_services() -> None:
    sources = (
        L1_PACKAGES,
        L1_STAGE / "apply.sh",
        L1_STAGE / "verify.sh",
        L1_STAGE / "rollback.sh",
    )
    pattern = re.compile(r"\bsystemctl\s+(enable|start|restart|reload)\b")
    for path in sources:
        content = path.read_text(encoding="utf-8")
        assert not pattern.search(content), f"forbidden systemctl mutation found in {path.name}"


def test_l1_live_sources_read_only_systemctl_is_show_only() -> None:
    content = L1_PACKAGES.read_text(encoding="utf-8")
    for match in re.finditer(r"\bsystemctl\s+(\S+)", content):
        assert match.group(1) == "show", f"unexpected systemctl subcommand: {match.group(1)}"


def test_pacman_bin_constant_appears_exactly_once_and_is_canonical() -> None:
    content = L1_PACKAGES.read_text(encoding="utf-8")
    assert content.count('PACMAN_BIN = "/usr/bin/pacman"') == 1


def test_l1_sources_never_reintroduce_static_token_or_boolean_gate() -> None:
    """The prior boolean/static-token gate must not reappear anywhere in the
    executable sources — only file-path env vars validated by the real
    gate script are acceptable."""
    banned = (
        "AEGIS_L1_LIVE_AUTHORIZATION_TOKEN",
        "AEGIS_L1_LIVE_K3_CONFIRMED",
        "AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED",
    )
    sources = (
        L1_PACKAGES,
        L1_STAGE / "apply.sh",
        L1_STAGE / "verify.sh",
        L1_STAGE / "rollback.sh",
    )
    for path in sources:
        content = path.read_text(encoding="utf-8")
        for token in banned:
            assert token not in content, f"stale boolean/token gate reference {token!r} found in {path.name}"


# ---------------------------------------------------------------------------
# Evidence-integrity: no handler may claim an unproven state
# ---------------------------------------------------------------------------


def _fake_python_logging_verify(tmp_path: Path, verify_exit: int = 0) -> tuple[Path, Path]:
    """A python3 stub for apply.sh that logs every invocation's argv and
    lets the test control whether the internal live post-install
    `verify` subcommand succeeds or fails, without ever touching pacman."""
    call_log = tmp_path / "calls.log"
    script = tmp_path / "fake_python3.sh"
    script.write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> "{call_log}"\n'
        'case "$2" in\n'
        f'  verify) exit {verify_exit} ;;\n'
        "  *) exit 0 ;;\n"
        "esac\n"
    )
    script.chmod(0o755)
    return script, call_log


def test_apply_sh_live_invokes_post_install_verify_before_success(tmp_path: Path) -> None:
    """Requirement: apply live cannot report service-none markers without
    actually invoking the post-install verification first."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    auth, k3 = valid_auth_k3_files(tmp_path)
    fake_python, call_log = _fake_python_logging_verify(tmp_path, verify_exit=0)
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_PYTHON_BIN"] = str(fake_python)
    env[LIVE_AUTH_FILE_ENV] = auth
    env[LIVE_K3_FILE_ENV] = k3
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0, proc.stderr
    log_lines = call_log.read_text().splitlines()
    assert any("verify" in line.split() for line in log_lines), "verify subcommand was never invoked"
    assert "L1_SERVICES_STARTED=NONE" in proc.stdout
    assert "L1_SERVICES_ENABLED=NONE" in proc.stdout


def test_apply_sh_live_fails_if_post_install_verify_fails(tmp_path: Path) -> None:
    """Requirement: a failed post-install service verification makes live
    apply fail, and it must not print the service-none success markers."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    auth, k3 = valid_auth_k3_files(tmp_path)
    fake_python, call_log = _fake_python_logging_verify(tmp_path, verify_exit=1)
    env = os.environ.copy()
    env.pop("AEGIS_P4_FS_ROOT", None)
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_PYTHON_BIN"] = str(fake_python)
    env[LIVE_AUTH_FILE_ENV] = auth
    env[LIVE_K3_FILE_ENV] = k3
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "POST_INSTALL_SERVICE_VERIFICATION_FAILED" in proc.stderr
    assert "L1_SERVICES_STARTED=NONE" not in proc.stdout
    assert "L1_APPLY=COMPLETE" not in proc.stdout
    log_lines = call_log.read_text().splitlines()
    assert any("verify" in line.split() for line in log_lines), "verify subcommand was never invoked"


def test_apply_sh_never_claims_pre_rb_zero_drift() -> None:
    content = (L1_STAGE / "apply.sh").read_text(encoding="utf-8")
    assert "HOST_PRE_TO_RB_ZERO_DRIFT" not in content
    assert "HOST_PRE_TO_RB_COMPARE=REQUIRED" in content


def test_verify_sh_never_claims_pre_rb_zero_drift() -> None:
    content = (L1_STAGE / "verify.sh").read_text(encoding="utf-8")
    assert "HOST_PRE_TO_RB_ZERO_DRIFT" not in content
    assert "HOST_PRE_TO_RB_COMPARE=REQUIRED" in content


def test_rollback_sh_never_claims_unverified_service_state() -> None:
    content = (L1_STAGE / "rollback.sh").read_text(encoding="utf-8")
    assert "L1_SERVICES_LEFT_ACTIVE" not in content
    assert "L1_SERVICES_LEFT_ENABLED" not in content
    assert "HOST_PRE_TO_RB_ZERO_DRIFT" not in content


def test_rollback_sh_emits_compare_required_and_capture_required_markers(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    (fs_root / "usr" / "bin").mkdir(parents=True)
    (fs_root / "usr" / "bin" / "chronyd").write_text("#!/bin/sh\nexit 0\n")
    env = os.environ.copy()
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert "L1_ROLLBACK_PACKAGE_STATE=ABSENT" in proc.stdout
    assert "POST_ROLLBACK_CAPTURE_REQUIRED=YES" in proc.stdout
    assert "HOST_PRE_TO_RB_COMPARE=REQUIRED" in proc.stdout
