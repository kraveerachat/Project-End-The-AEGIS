"""AEGIS IDEA3 PR11 Phase 4 — L1 package installation handler test suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l1-operational-design.md
Decisions:
  OD-L1-01 through OD-L1-10 (2026-09-21).

Every test runs against FIXTURE material only. No test runs pacman/apt/dnf,
installs real packages, modifies /etc or /opt, or contacts any host service.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L1_STAGE = STAGES / "L1"
P4_LIB = DEPLOY / "p4-lib.sh"
GATE = DEPLOY / "p4-stage-gate.sh"
COMPARE = DEPLOY / "p4-compare.sh"
L1_PACKAGES = DEPLOY / "p4-l1-packages.py"

REQUIRED_HANDLER_FILES = ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt")
L1_SOURCES = (L1_PACKAGES, L1_STAGE / "apply.sh", L1_STAGE / "verify.sh", L1_STAGE / "rollback.sh")

PROHIBITED_TOKENS = (
    r"\bpacman\s+-[SsyuRU]",
    r"\byay\b",
    r"\bparu\b",
    r"\bapt(-get)?\b",
    r"\bdnf\b",
    r"\bsystemctl\s+(enable|start|restart|reload)\b",
    r"\brfkill\s+unblock\b",
    r"\biw\s+reg\s+set\b",
    r"\bnmcli\s+connection\s+up\b",
    r"\btwingate\s+(start|stop|restart)\b",
    r"\bRELAY_TRIGGER\b",
)

APPROVED_ALLOW_KEYS = {
    "svc.chronyd.service.LoadState",
    "svc.chronyd.service.UnitFileState",
    "time.chrony.leap",
    "time.file./etc/chrony.conf.class",
    "time.file./etc/chrony.conf.meta",
    "time.file./etc/chrony.conf.sha256",
}


def test_l1_handler_status_registered() -> None:
    """OD-L1-01 / p4-lib: p4_stage_handler_status L1 must report REGISTERED."""
    assert L1_STAGE.is_dir(), "stages/L1 directory must exist"
    proc = subprocess.run(
        ["bash", "-c", f'set -euo pipefail; . "{P4_LIB}"; p4_stage_handler_status L1'],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert proc.stdout.strip() == "REGISTERED"


def test_l1_all_required_handler_files_exist() -> None:
    """OD-L1-01 / G-15: All five required handler files must be present and regular."""
    assert L1_STAGE.is_dir(), "stages/L1 directory must exist"
    for f in REQUIRED_HANDLER_FILES:
        target = L1_STAGE / f
        assert target.is_file(), f"missing required handler file: {f}"
        assert not target.is_symlink(), f"handler file must not be a symlink: {f}"


def test_l1_shell_scripts_are_executable() -> None:
    """Shell handler scripts must be owner-executable."""
    assert L1_STAGE.is_dir(), "stages/L1 directory must exist"
    for script_name in ("apply.sh", "verify.sh", "rollback.sh"):
        p = L1_STAGE / script_name
        assert p.is_file(), f"missing script: {script_name}"
        assert os.access(p, os.X_OK), f"{script_name} must be executable"


def test_l1_shell_scripts_pass_bash_syntax_check() -> None:
    """OD-L1-01: All L1 shell scripts must pass bash -n syntax verification."""
    assert L1_STAGE.is_dir(), "stages/L1 directory must exist"
    for script_name in ("apply.sh", "verify.sh", "rollback.sh"):
        p = L1_STAGE / script_name
        assert p.is_file(), f"missing script: {script_name}"
        proc = subprocess.run(["bash", "-n", str(p)], capture_output=True, text=True, check=False)
        assert proc.returncode == 0, f"bash -n failed on {script_name}: {proc.stderr}"


def test_l1_sources_contain_no_prohibited_tokens() -> None:
    """OD-L1-02: L1 sources must contain zero execution of prohibited commands."""
    assert L1_STAGE.is_dir(), "stages/L1 directory must exist"
    assert L1_PACKAGES.is_file(), "p4-l1-packages.py must exist"
    for path in L1_SOURCES:
        assert path.is_file(), f"missing source file: {path}"
        content = path.read_text(encoding="utf-8")
        for token_pat in PROHIBITED_TOKENS:
            assert not re.search(token_pat, content), f"prohibited pattern {token_pat} found in {path.name}"


def test_l1_apply_refuses_live_backend(tmp_path: Path) -> None:
    """OD-L1-02 / OD-L1-10: Live backend must fail closed at the shell layer."""
    assert (L1_STAGE / "apply.sh").is_file()
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
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_BACKEND_NOT_IMPLEMENTED" in proc.stderr or "NOT_AUTHORIZED" in proc.stderr


def test_l1_helper_refuses_live_backend(tmp_path: Path) -> None:
    """OD-L1-02 / OD-L1-10: Live backend must fail closed at the Python layer."""
    assert L1_PACKAGES.is_file(), "p4-l1-packages.py must exist"
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    proc = subprocess.run(
        [
            sys.executable,
            str(L1_PACKAGES),
            "simulate-install",
            "--backend",
            "live",
            "--work-dir",
            str(work_dir),
            "--fs-root",
            str(fs_root),
            "--packages",
            "chrony",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "LIVE_BACKEND_NOT_IMPLEMENTED" in proc.stderr or "NOT_AUTHORIZED" in proc.stderr


def test_l1_apply_refuses_unknown_backend(tmp_path: Path) -> None:
    """OD-L1-02: Unknown backend must fail closed."""
    assert (L1_STAGE / "apply.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "invalid_custom_backend"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "unknown backend" in proc.stderr.lower() or "invalid" in proc.stderr.lower()


def test_l1_helper_accepts_approved_chrony_package(tmp_path: Path) -> None:
    """OD-L1-01: Approved package target 'chrony' is accepted and simulated."""
    assert L1_PACKAGES.is_file(), "p4-l1-packages.py must exist"
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    proc = subprocess.run(
        [
            sys.executable,
            str(L1_PACKAGES),
            "simulate-install",
            "--backend",
            "fixture",
            "--work-dir",
            str(work_dir),
            "--fs-root",
            str(fs_root),
            "--packages",
            "chrony",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"failed: {proc.stderr}\n{proc.stdout}"
    assert "L1_SIMULATE_INSTALL=COMPLETE" in proc.stdout
    assert (fs_root / "usr" / "bin" / "chronyd").is_file()
    assert (fs_root / "usr" / "bin" / "chronyc").is_file()
    assert (fs_root / "usr" / "lib" / "systemd" / "system" / "chronyd.service").is_file()


def test_l1_helper_rejects_unapproved_package(tmp_path: Path) -> None:
    """OD-L1-01: Requesting an unapproved package fails closed."""
    assert L1_PACKAGES.is_file(), "p4-l1-packages.py must exist"
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    for bad_pkg in ("hostapd", "nginx", "gcc", "mosquitto", "systemd"):
        proc = subprocess.run(
            [
                sys.executable,
                str(L1_PACKAGES),
                "simulate-install",
                "--backend",
                "fixture",
                "--work-dir",
                str(work_dir),
                "--fs-root",
                str(fs_root),
                "--packages",
                bad_pkg,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode != 0
        assert "UNAPPROVED_PACKAGE" in proc.stderr or "refused" in proc.stderr.lower()


def test_l1_helper_rejects_unrelated_upgrade(tmp_path: Path) -> None:
    """OD-L1-03: Full system upgrade or upgrading unrelated packages must fail closed."""
    assert L1_PACKAGES.is_file(), "p4-l1-packages.py must exist"
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    proc = subprocess.run(
        [
            sys.executable,
            str(L1_PACKAGES),
            "simulate-install",
            "--backend",
            "fixture",
            "--work-dir",
            str(work_dir),
            "--fs-root",
            str(fs_root),
            "--packages",
            "chrony",
            "--transaction-diff",
            "linux:6.10->6.11,systemd:261.2->261.3",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "UNRELATED_UPGRADE_REFUSED" in proc.stderr


def test_l1_apply_service_remains_inactive_and_disabled(tmp_path: Path) -> None:
    """OD-L1-04: Installing chrony must NOT activate or enable chronyd.service."""
    assert (L1_STAGE / "apply.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"apply failed: {proc.stderr}\n{proc.stdout}"
    assert "L1_SERVICES_STARTED=NONE" in proc.stdout
    assert "L1_SERVICES_ENABLED=NONE" in proc.stdout
    assert "L1_APPLY=COMPLETE" in proc.stdout

    # Unit must be in /usr/lib/systemd/system, NOT enabled in /etc/systemd/system
    etc_symlink = fs_root / "etc" / "systemd" / "system" / "multi-user.target.wants" / "chronyd.service"
    assert not etc_symlink.exists(), "chronyd.service must not be enabled in /etc/systemd/system"


def test_l1_fails_if_package_hooks_attempt_service_enable(tmp_path: Path) -> None:
    """OD-L1-04: If package installation enables a unit, stage apply must fail closed."""
    assert (L1_STAGE / "apply.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_L1_INJECT_SERVICE_ENABLE"] = "YES"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "SERVICE_MUTATION_REFUSED" in proc.stderr or "FAIL" in proc.stderr


def test_l1_disk_headroom_gate_fails_closed(tmp_path: Path) -> None:
    """OD-L1-05: When disk usage exceeds threshold, L1 must fail closed."""
    assert (L1_STAGE / "apply.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    # Inject simulated disk usage of 95% (exceeds 90% threshold)
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "95"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "DISK_THRESHOLD_VIOLATION" in proc.stderr or "headroom" in proc.stderr.lower()


def test_l1_disk_headroom_gate_passes_below_threshold(tmp_path: Path) -> None:
    """OD-L1-05: When disk usage is below threshold, L1 headroom check passes."""
    assert (L1_STAGE / "apply.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "80"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0


def test_l1_verify_passes_when_installed_and_inactive(tmp_path: Path) -> None:
    """OD-L1-06 / OD-L1-07: Verify passes when chrony files exist, service inactive, no listeners."""
    assert (L1_STAGE / "verify.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    # Apply first
    subprocess.run(["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, check=True)

    # Verify
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "verify.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"verify failed: {proc.stderr}\n{proc.stdout}"
    assert "HOST_PRE_TO_RB_ZERO_DRIFT=YES" in proc.stdout
    assert "L1_VERIFY=PASS" in proc.stdout


def test_l1_verify_fails_if_binary_missing(tmp_path: Path) -> None:
    """OD-L1-06: Verify fails if expected binary was not installed."""
    assert (L1_STAGE / "verify.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    subprocess.run(["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, check=True)

    # Corrupt by removing chronyd
    (fs_root / "usr" / "bin" / "chronyd").unlink()

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "verify.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "chronyd missing" in proc.stderr.lower() or "missing" in proc.stderr.lower()


def test_l1_verify_fails_if_listener_detected(tmp_path: Path) -> None:
    """OD-L1-07: Verify fails if any new listening socket is detected."""
    assert (L1_STAGE / "verify.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_L1_INJECT_LISTENER"] = "udp:123"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    subprocess.run(["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, check=True)

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "verify.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "UNEXPECTED_LISTENER" in proc.stderr or "listener" in proc.stderr.lower()


def test_l1_allow_listeners_has_zero_active_entries() -> None:
    """OD-L1-07: allow-listeners.txt must contain zero active entries."""
    assert (L1_STAGE / "allow-listeners.txt").is_file()
    content = (L1_STAGE / "allow-listeners.txt").read_text(encoding="utf-8")
    active = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]
    assert active == [], f"allow-listeners.txt must be empty of active listeners, found: {active}"


def test_l1_allow_keys_matches_approved_inventory() -> None:
    """OD-L1-09: allow-keys.txt must match exact approved drift keys with zero wildcards."""
    assert (L1_STAGE / "allow-keys.txt").is_file()
    content = (L1_STAGE / "allow-keys.txt").read_text(encoding="utf-8")
    active = {line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")}
    assert active == APPROVED_ALLOW_KEYS
    for key in active:
        assert "*" not in key, f"wildcards forbidden in allow-keys.txt: {key}"
        assert not re.match(r"^(sysctl\.|idea2\.|net\.route|cap\.|listen\.|disk\.)", key), f"protected key found: {key}"


def test_l1_rollback_removes_only_stage_owned_package_delta(tmp_path: Path) -> None:
    """OD-L1-08: Rollback removes chrony, preserving pre-existing packages."""
    assert (L1_STAGE / "rollback.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    # Create pre-existing dnsmasq and nftables artifacts
    (fs_root / "usr" / "bin").mkdir(parents=True, exist_ok=True)
    dnsmasq_bin = fs_root / "usr" / "bin" / "dnsmasq"
    nft_bin = fs_root / "usr" / "bin" / "nft"
    dnsmasq_bin.write_text("#!/bin/sh\nexit 0\n")
    nft_bin.write_text("#!/bin/sh\nexit 0\n")

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    # Apply
    subprocess.run(["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, check=True)
    assert (fs_root / "usr" / "bin" / "chronyd").is_file()

    # Rollback
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"rollback failed: {proc.stderr}\n{proc.stdout}"
    assert "L1_SERVICES_LEFT_ACTIVE=NONE" in proc.stdout
    assert "L1_SERVICES_LEFT_ENABLED=NONE" in proc.stdout
    assert "L1_ROLLBACK=COMPLETE" in proc.stdout

    # chrony artifacts removed
    assert not (fs_root / "usr" / "bin" / "chronyd").exists()
    assert not (fs_root / "usr" / "bin" / "chronyc").exists()
    assert not (fs_root / "usr" / "lib" / "systemd" / "system" / "chronyd.service").exists()

    # pre-existing packages preserved!
    assert dnsmasq_bin.is_file(), "dnsmasq must be preserved across L1 rollback"
    assert nft_bin.is_file(), "nft must be preserved across L1 rollback"


def test_l1_rollback_is_idempotent(tmp_path: Path) -> None:
    """OD-L1-08: Rollback repeated execution exits 0 and causes no error."""
    assert (L1_STAGE / "rollback.sh").is_file()
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    fs_root = tmp_path / "fs"
    fs_root.mkdir()

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(work_dir)
    env["AEGIS_P4_FS_ROOT"] = str(fs_root)
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_L1_SIMULATED_DISK_PCT"] = "50"
    env["AEGIS_PYTHON_BIN"] = sys.executable

    subprocess.run(["bash", str(L1_STAGE / "apply.sh")], cwd=ROOT, env=env, check=True)
    subprocess.run(["bash", str(L1_STAGE / "rollback.sh")], cwd=ROOT, env=env, check=True)

    # Second rollback must succeed cleanly
    proc = subprocess.run(
        ["bash", str(L1_STAGE / "rollback.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "L1_ROLLBACK=COMPLETE" in proc.stdout


def test_l1_refuses_symlinks_and_host_paths(tmp_path: Path) -> None:
    """OD-L1-02: Symlinks and root system paths for work dir are refused."""
    assert (L1_STAGE / "apply.sh").is_file()
    real_work = tmp_path / "real_work"
    real_work.mkdir()
    symlink_work = tmp_path / "symlink_work"
    symlink_work.symlink_to(real_work)

    env = os.environ.copy()
    env["AEGIS_L1_BACKEND"] = "fixture"
    env["AEGIS_L1_WORK_DIR"] = str(symlink_work)
    env["AEGIS_P4_FS_ROOT"] = str(tmp_path / "fs")
    env["DISK_THRESHOLD_PCT"] = "90"

    proc = subprocess.run(
        ["bash", str(L1_STAGE / "apply.sh")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "symlink" in proc.stderr.lower()

    # Host system path refusal
    for host_path in ("/etc/idea3-test", "/opt/idea3-test", "/var/log/idea3-test"):
        env["AEGIS_L1_WORK_DIR"] = host_path
        proc = subprocess.run(
            ["bash", str(L1_STAGE / "apply.sh")],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode != 0
        assert "host system path" in proc.stderr.lower()


def make_capture_bundle(dir_path: Path, records: dict[str, str], *, label: str = "test") -> Path:
    """Build a valid p4-l0-capture bundle with SHA256SUMS for comparison testing."""
    dir_path.mkdir(parents=True, exist_ok=True)
    all_rec = {
        "meta.schema": "1",
        "meta.evidence_class": "TEST_FIXTURE",
        "meta.capture_status": "COMPLETE",
        "meta.journal_since": "2026-09-20 00:00:00 UTC",
        "meta.capture_label": label,
    }
    all_rec.update(records)

    categories = {
        "meta": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("meta.")],
        "cap": [
            "cap.ip\tavailable",
            "cap.sysctl\tavailable",
            "cap.nft\tavailable",
            "cap.ss\tavailable",
            "cap.systemctl\tavailable",
            "cap.journalctl\tavailable",
            "cap.df\tavailable",
            "cap.timedatectl\tavailable",
            "cap.nmcli\tavailable",
            "cap.iw\tavailable",
            "cap.rfkill\tavailable",
            "cap.chronyc\tavailable",
        ],
        "net": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("net.") or k.startswith("sysctl.")],
        "wifi": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("wifi.") or k.startswith("nm.")],
        "fw": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("fw.")],
        "time": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("time.") or k.startswith("svc.")],
        "mqtt": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("mqtt.") or k.startswith("listen.")],
        "idea2": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("idea2.")],
        "host": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("host.") or k.startswith("disk.")],
    }

    default_idea2 = [
        "idea2.verdict.process_active\tYES",
        "idea2.verdict.tunnel_healthy\tNO_FAILURE_OBSERVED",
        "idea2.verdict.runtime_healthy\tNOT_PROVEN",
    ]
    if not any(k.startswith("idea2.verdict") for k in all_rec):
        categories["idea2"].extend(default_idea2)
    default_disk = ["disk.root.use_pct\t50"]
    if not any(k.startswith("disk.") for k in all_rec):
        categories["host"].extend(default_disk)

    for cat_name, lines in categories.items():
        tsv_file = dir_path / f"{cat_name}.tsv"
        content = "\n".join(sorted(lines)) + ("\n" if lines else "")
        tsv_file.write_text(content, encoding="utf-8")

    sha_lines = []
    for tsv in sorted(dir_path.glob("*.tsv")):
        h = hashlib.sha256(tsv.read_bytes()).hexdigest()
        sha_lines.append(f"{h}  {tsv.name}\n")
    (dir_path / "SHA256SUMS").write_text("".join(sha_lines), encoding="utf-8")
    return dir_path


def run_compare(
    before_dir: Path,
    after_dir: Path,
    *,
    allow_keys_file: Path | None = None,
    allow_listeners_file: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DISK_THRESHOLD_PCT"] = "90"
    if allow_keys_file is not None:
        env["ALLOW_KEYS_FILE"] = str(allow_keys_file)
    if allow_listeners_file is not None:
        env["ALLOW_LISTENERS_FILE"] = str(allow_listeners_file)

    return subprocess.run(
        ["bash", str(COMPARE), str(before_dir), str(after_dir)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def test_l1_p4_compare_post_passes_with_allow_keys(tmp_path: Path) -> None:
    """OD-L1-09: p4-compare.sh PASS with L1 allow-keys when chrony is installed inactive."""
    before_dir = tmp_path / "pre"
    after_dir = tmp_path / "post"

    pre_records = {
        "svc.chronyd.service.LoadState": "not-found",
        "svc.chronyd.service.UnitFileState": "bad",
        "time.file./etc/chrony.conf.class": "absent",
    }
    post_records = {
        "svc.chronyd.service.LoadState": "loaded",
        "svc.chronyd.service.UnitFileState": "disabled",
        "time.file./etc/chrony.conf.class": "config",
        "time.file./etc/chrony.conf.meta": "mode=644 uid=0 gid=0 size=32 mtime=1700000000",
        "time.file./etc/chrony.conf.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
    }

    make_capture_bundle(before_dir, pre_records, label="pre")
    make_capture_bundle(after_dir, post_records, label="post")

    res = run_compare(
        before_dir,
        after_dir,
        allow_keys_file=L1_STAGE / "allow-keys.txt",
        allow_listeners_file=L1_STAGE / "allow-listeners.txt",
    )
    assert res.returncode == 0, f"compare failed: {res.stderr}\n{res.stdout}"
    assert "COMPARE_RESULT=PASS" in res.stdout


def test_l1_p4_compare_post_fails_without_allow_keys(tmp_path: Path) -> None:
    """OD-L1-09: p4-compare.sh FAIL without allow-keys when chrony drift is present."""
    before_dir = tmp_path / "pre"
    after_dir = tmp_path / "post"

    pre_records = {
        "svc.chronyd.service.LoadState": "not-found",
        "svc.chronyd.service.UnitFileState": "bad",
        "time.file./etc/chrony.conf.class": "absent",
    }
    post_records = {
        "svc.chronyd.service.LoadState": "loaded",
        "svc.chronyd.service.UnitFileState": "disabled",
        "time.file./etc/chrony.conf.class": "config",
        "time.file./etc/chrony.conf.meta": "mode=644 uid=0 gid=0 size=32 mtime=1700000000",
        "time.file./etc/chrony.conf.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
    }

    make_capture_bundle(before_dir, pre_records, label="pre")
    make_capture_bundle(after_dir, post_records, label="post")

    res = run_compare(before_dir, after_dir, allow_keys_file=None, allow_listeners_file=None)
    assert res.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res.stdout


def test_l1_p4_compare_rollback_produces_zero_drift(tmp_path: Path) -> None:
    """OD-L1-08 / OD-L1-09: PRE vs RB with zero allow files produces zero drift (PASS)."""
    before_dir = tmp_path / "pre"
    rb_dir = tmp_path / "rb"

    records = {
        "svc.chronyd.service.LoadState": "not-found",
        "svc.chronyd.service.UnitFileState": "bad",
        "time.file./etc/chrony.conf.class": "absent",
    }

    make_capture_bundle(before_dir, records, label="pre")
    make_capture_bundle(rb_dir, records, label="rb")

    res = run_compare(before_dir, rb_dir, allow_keys_file=None, allow_listeners_file=None)
    assert res.returncode == 0, f"rollback compare failed: {res.stderr}\n{res.stdout}"
    assert "COMPARE_RESULT=PASS" in res.stdout
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout
    assert "FINDING\tNEW_OR_WORSENED_DRIFT" not in res.stdout


def test_l1_p4_compare_fails_if_chronyd_service_starts(tmp_path: Path) -> None:
    """OD-L1-04: Negative control: if chronyd.service became active, comparison must FAIL."""
    before_dir = tmp_path / "pre"
    after_dir = tmp_path / "post"

    pre_records = {
        "svc.chronyd.service.LoadState": "not-found",
        "svc.chronyd.service.ActiveState": "inactive",
    }
    post_records = {
        "svc.chronyd.service.LoadState": "loaded",
        "svc.chronyd.service.ActiveState": "active",  # Prohibited!
    }

    make_capture_bundle(before_dir, pre_records, label="pre")
    make_capture_bundle(after_dir, post_records, label="post")

    res = run_compare(
        before_dir,
        after_dir,
        allow_keys_file=L1_STAGE / "allow-keys.txt",
        allow_listeners_file=L1_STAGE / "allow-listeners.txt",
    )
    assert res.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res.stdout
    assert "NEW_OR_WORSENED_DRIFT" in res.stdout


def test_l1_p4_compare_fails_if_listener_added(tmp_path: Path) -> None:
    """OD-L1-07: Negative control: if listening socket was added, comparison must FAIL."""
    before_dir = tmp_path / "pre"
    after_dir = tmp_path / "post"

    pre_records = {
        "svc.chronyd.service.LoadState": "not-found",
    }
    post_records = {
        "svc.chronyd.service.LoadState": "loaded",
        "listen.udp.0.0.0.0:123": "present",  # Prohibited!
    }

    make_capture_bundle(before_dir, pre_records, label="pre")
    make_capture_bundle(after_dir, post_records, label="post")

    res = run_compare(
        before_dir,
        after_dir,
        allow_keys_file=L1_STAGE / "allow-keys.txt",
        allow_listeners_file=L1_STAGE / "allow-listeners.txt",
    )
    assert res.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res.stdout
    assert "NEW_OR_WORSENED_DRIFT" in res.stdout
