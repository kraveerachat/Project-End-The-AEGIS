"""AEGIS IDEA3 PR11 Phase 4 — L1 live package backend test suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-22-idea3-pr11-phase4-l1-live-backend-owner-decision.md
Decisions: D1 (disk threshold=90), D2 (pacman/chrony contract), D3 (rollback).

Every test in this file runs against a mocked `run_pacman` seam (a Python
module-level function monkeypatch) or exercises the fail-closed path that
never reaches pacman at all. No test in this file invokes a real package
manager, mutates /etc or /opt, starts/enables a service, or contacts any
live host service. Live execution is never authorized here.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L1_STAGE = STAGES / "L1"
L1_PACKAGES = DEPLOY / "p4-l1-packages.py"

LIVE_AUTH_TOKEN_ENV = "AEGIS_L1_LIVE_AUTHORIZATION_TOKEN"
LIVE_AUTH_TOKEN_REQUIRED = "AEGIS_P4_LIVE_L1_EXPLICIT_OWNER_AUTHORIZED"
LIVE_K3_ENV = "AEGIS_L1_LIVE_K3_CONFIRMED"


def _load_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("p4_l1_packages_under_test", L1_PACKAGES)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def mod(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    # Ensure a clean environment: no accidental live authorization leaks in.
    monkeypatch.delenv(LIVE_AUTH_TOKEN_ENV, raising=False)
    monkeypatch.delenv(LIVE_K3_ENV, raising=False)
    return _load_module()


def _fake_completed(returncode: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["pacman"], returncode=returncode, stdout=stdout, stderr=stderr)


def _authorize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(LIVE_AUTH_TOKEN_ENV, LIVE_AUTH_TOKEN_REQUIRED)
    monkeypatch.setenv(LIVE_K3_ENV, "YES")


# ---------------------------------------------------------------------------
# Authorization gate
# ---------------------------------------------------------------------------


def test_live_authorization_absent_by_default(mod: types.ModuleType) -> None:
    assert mod.live_authorization_present() is False


def test_live_authorization_requires_both_vars(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(LIVE_AUTH_TOKEN_ENV, LIVE_AUTH_TOKEN_REQUIRED)
    assert mod.live_authorization_present() is False  # K3 var missing
    monkeypatch.delenv(LIVE_AUTH_TOKEN_ENV, raising=False)
    monkeypatch.setenv(LIVE_K3_ENV, "YES")
    assert mod.live_authorization_present() is False  # token var missing


def test_live_authorization_wrong_token_rejected(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(LIVE_AUTH_TOKEN_ENV, "some-other-value")
    monkeypatch.setenv(LIVE_K3_ENV, "YES")
    assert mod.live_authorization_present() is False


def test_live_authorization_present_when_both_correct(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    _authorize(monkeypatch)
    assert mod.live_authorization_present() is True


def test_pacman_bin_is_fixed_canonical_path(mod: types.ModuleType) -> None:
    assert mod.PACMAN_BIN == "/usr/bin/pacman"


def test_pacman_bin_not_overridable_by_environment(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PACMAN_BIN", "/tmp/not-a-real-pacman")
    monkeypatch.setenv("AEGIS_PACMAN_BIN", "/tmp/not-a-real-pacman")
    reloaded = _load_module()
    assert reloaded.PACMAN_BIN == "/usr/bin/pacman"


# ---------------------------------------------------------------------------
# CLI entry points fail closed without live authorization (no pacman call)
# ---------------------------------------------------------------------------


def test_cli_simulate_install_live_without_authorization_never_calls_pacman(
    tmp_path: Path,
) -> None:
    """Subprocess-level check: the authorization gate must reject before any
    pacman invocation could occur, regardless of process boundary."""
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
    assert "NOT_AUTHORIZED" in proc.stderr


def test_cli_rollback_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    proc = subprocess.run(
        [sys.executable, str(L1_PACKAGES), "rollback", "--backend", "live", "--fs-root", str(fs_root)],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_cli_verify_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    proc = subprocess.run(
        [
            sys.executable, str(L1_PACKAGES), "verify",
            "--backend", "live", "--work-dir", str(work_dir), "--fs-root", str(fs_root),
        ],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_apply_sh_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_AUTHORIZATION_MISSING" in proc.stderr
    assert "NOT_AUTHORIZED" in proc.stderr


def test_apply_sh_live_partial_authorization_still_fails(tmp_path: Path) -> None:
    """Token present but K3 var missing must still fail closed."""
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env[LIVE_AUTH_TOKEN_ENV] = LIVE_AUTH_TOKEN_REQUIRED
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


def test_rollback_sh_live_without_authorization_fails_closed(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    fs_root.mkdir()
    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "live"
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")], cwd=ROOT, env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode != 0
    assert "NOT_AUTHORIZED" in proc.stderr


# ---------------------------------------------------------------------------
# Preflight transaction contract (mocked pacman)
# ---------------------------------------------------------------------------


def test_preflight_accepts_exact_chrony(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout="chrony\n"))
    assert mod.pacman_preflight_transaction("chrony") == {"chrony"}


def test_preflight_rejects_dependency_addition(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0, stdout="chrony\nlibedit\n"))
    names = mod.pacman_preflight_transaction("chrony")
    assert names == {"chrony", "libedit"}
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
# Rollback contract (mocked pacman)
# ---------------------------------------------------------------------------


def test_live_rollback_removes_target_only(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _fake_completed(0)

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    mod.live_rollback_package("chrony")
    assert len(calls) == 1
    joined = " ".join(calls[0])
    assert "chrony" in calls[0]
    for forbidden in ("-Rns", "-Rs", "-Rc", "--recursive", "--cascade"):
        assert forbidden not in joined


def test_live_rollback_dependency_conflict_fails_closed_no_escalation(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str]] = []

    def fake_run_pacman(args: list[str]) -> subprocess.CompletedProcess:
        calls.append(list(args))
        return _fake_completed(1, stderr="error: failed to remove chrony (could not satisfy dependencies)")

    monkeypatch.setattr(mod, "run_pacman", fake_run_pacman)
    with pytest.raises(SystemExit):
        mod.live_rollback_package("chrony")
    # Must not have retried with a recursive/cascade flag.
    assert len(calls) == 1


def test_rollback_idempotent_second_call_still_fails_closed_not_silently(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second rollback after package is already gone must not error loudly
    in a way that implies mutation occurred; pacman's own not-installed exit
    is treated as a rollback command failure and surfaced, not swallowed."""
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(1, stderr="error: target not found: chrony"))
    with pytest.raises(SystemExit):
        mod.live_rollback_package("chrony")


# ---------------------------------------------------------------------------
# Verify contract (mocked pacman + systemctl)
# ---------------------------------------------------------------------------


def test_live_verify_fails_if_package_not_installed(mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(1))
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


def test_live_verify_passes_when_installed_inactive_disabled(
    mod: types.ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mod, "run_pacman", lambda args: _fake_completed(0))

    def fake_systemctl(cmd, **kwargs):
        if "ActiveState" in cmd:
            return _fake_completed(0, stdout="inactive\n")
        return _fake_completed(0, stdout="disabled\n")

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
    import re

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
    import re

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
    import re

    content = L1_PACKAGES.read_text(encoding="utf-8")
    for match in re.finditer(r"\bsystemctl\s+(\S+)", content):
        assert match.group(1) == "show", f"unexpected systemctl subcommand: {match.group(1)}"


def test_pacman_bin_constant_appears_exactly_once_and_is_canonical() -> None:
    content = L1_PACKAGES.read_text(encoding="utf-8")
    assert content.count('PACMAN_BIN = "/usr/bin/pacman"') == 1
