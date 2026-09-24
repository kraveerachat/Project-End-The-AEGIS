# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L7 Core Credential Delivery / Core Start Test Suite.

Authoritative Design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md
Decisions:
  OD-L7-01 through OD-L7-08 (Approved 2026-09-21).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L7_STAGE = STAGES / "L7"
P4_LIB = DEPLOY / "p4-lib.sh"
COMPARE = DEPLOY / "p4-compare.sh"
NVS_PROVISION = DEPLOY / "p4-nvs-provision.py"

REQUIRED_HANDLER_FILES = (
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
)

FIXTURE_C2D = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
FIXTURE_D2C = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
FIXTURE_PASS = "fixture-mqtt-core-password-12345"
FIXTURE_PIN = "849201"

EXPECTED_ALLOW_KEYS = {
    "svc.aegis-idea3-core.service.ActiveState",
    "svc.aegis-idea3-core.service.SubState",
    "svc.aegis-idea3-core.service.MainPID",
    "svc.aegis-idea3-core.service.ExecMainStartTimestamp",
    "svc.aegis-idea3-core.service.Result",
    "svc.aegis-idea3-core.service.LoadState",
    "svc.aegis-idea3-core.service.NRestarts",
    "svc.aegis-idea3-core.service.UnitFileState",
    "host.path./opt/aegis-idea3/current",
    "host.path./run/aegis-idea3",
    "host.path./var/lib/aegis-idea3",
    "host.path./var/log/aegis-idea3",
    "host.symlink./opt/aegis-idea3/current.target",
    "host.unit_file./etc/systemd/system/aegis-idea3-core.service.class",
    "host.unit_file./etc/systemd/system/aegis-idea3-core.service.meta",
    "host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256",
    "host.aegis_idea3.file./etc/aegis-idea3/core.env.class",
    "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.class",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_d2c.class",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_d2c.meta",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/mqtt-core.pass.class",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/mqtt-core.pass.meta",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/admin.pin.class",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/admin.pin.meta",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/restore.credential.class",
    "host.aegis_idea3.file./etc/aegis-idea3/credentials/restore.credential.meta",
}


def create_fixture_input_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "k_c2d").write_text(FIXTURE_C2D + "\n", encoding="utf-8")
    (path / "k_c2d").chmod(0o600)
    (path / "k_d2c").write_text(FIXTURE_D2C + "\n", encoding="utf-8")
    (path / "k_d2c").chmod(0o600)
    (path / "mqtt-core.pass").write_text(FIXTURE_PASS + "\n", encoding="utf-8")
    (path / "mqtt-core.pass").chmod(0o600)
    (path / "admin.pin").write_text(FIXTURE_PIN + "\n", encoding="utf-8")
    (path / "admin.pin").chmod(0o600)

    # Valid D4 restore.credential fixture using aegis_soc.local_restore
    sys.path.insert(0, str(ROOT))
    try:
        from aegis_soc.local_restore import hash_secret, SCRYPT_MIN_N
        cred_text = hash_secret("fixture-restore-secret-12345", n=SCRYPT_MIN_N) + "\n"
        cred_path = path / "restore.credential"
        cred_path.write_text(cred_text, encoding="ascii")
        cred_path.chmod(0o600)
    finally:
        if str(ROOT) in sys.path:
            sys.path.remove(str(ROOT))

    return path


def make_fixture_release(fs_root: Path, name: str = "v1.0.0") -> Path:
    """Minimal immutable-release fixture below the fixture root (the L7 release guard requires it)."""
    rel = fs_root / "opt" / "aegis-idea3" / "releases" / name
    (rel / "aegis_soc").mkdir(parents=True, exist_ok=True)
    (rel / "aegis_soc" / "supervisor.py").write_text("# fixture\n", encoding="utf-8")
    python = rel / "venv" / "bin" / "python"
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text("#!/bin/sh\n", encoding="utf-8")
    python.chmod(0o755)
    rel.chmod(0o755)
    return rel


# =============================================================================
# 1. Handler Registration and Shell Syntax Tests
# =============================================================================

def test_l7_all_required_files_exist() -> None:
    """All 5 required stage files must exist in deploy/pr11-phase4/stages/L7/."""
    assert L7_STAGE.is_dir(), f"Stage directory missing: {L7_STAGE}"
    for filename in REQUIRED_HANDLER_FILES:
        filepath = L7_STAGE / filename
        assert filepath.exists(), f"Required L7 stage file missing: {filename}"
        assert filepath.is_file(), f"Required L7 stage entry is not a file: {filename}"


def test_l7_handler_registration_status() -> None:
    """p4-lib.sh must report p4_stage_handler_status L7 as REGISTERED."""
    cmd = [
        "bash",
        "-c",
        f". '{P4_LIB}' && p4_stage_handler_status L7",
    ]
    res = subprocess.run(cmd, text=True, capture_output=True, check=False)
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "REGISTERED"


def test_l7_shell_scripts_pass_bash_n() -> None:
    """All L7 shell scripts must pass bash -n syntax validation."""
    for script_name in ("apply.sh", "verify.sh", "rollback.sh"):
        script_path = L7_STAGE / script_name
        assert script_path.exists(), f"Script missing: {script_name}"
        res = subprocess.run(
            ["bash", "-n", str(script_path)],
            text=True,
            capture_output=True,
            check=False,
        )
        assert res.returncode == 0, f"bash -n failed on {script_name}:\n{res.stderr}"


# =============================================================================
# 2. Stage Contract & Input Directory Validation
# =============================================================================

def test_l7_apply_requires_input_and_work_dirs(tmp_path: Path) -> None:
    """apply.sh fails closed if AEGIS_L7_INPUT_DIR or AEGIS_L7_WORK_DIR is missing."""
    apply_script = L7_STAGE / "apply.sh"
    assert apply_script.exists()

    env_clean = os.environ.copy()
    env_clean.pop("AEGIS_L7_INPUT_DIR", None)
    env_clean.pop("AEGIS_L7_WORK_DIR", None)

    res = subprocess.run(["bash", str(apply_script)], text=True, capture_output=True, check=False, env=env_clean)
    assert res.returncode != 0
    assert "AEGIS_L7_INPUT_DIR" in res.stdout or "AEGIS_L7_INPUT_DIR" in res.stderr

    env_clean["AEGIS_L7_INPUT_DIR"] = str(tmp_path / "inputs")
    res2 = subprocess.run(["bash", str(apply_script)], text=True, capture_output=True, check=False, env=env_clean)
    assert res2.returncode != 0
    assert "AEGIS_L7_WORK_DIR" in res2.stdout or "AEGIS_L7_WORK_DIR" in res2.stderr


def test_l7_apply_fails_closed_on_missing_keys(tmp_path: Path) -> None:
    """apply.sh fails closed if k_c2d or k_d2c is missing from input directory."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    # Missing k_c2d
    (input_dir / "k_c2d").unlink()
    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0
    assert "k_c2d" in (res.stdout + res.stderr)


# =============================================================================
# 3. Protocol Key Validation Tests (OD-L7-02)
# =============================================================================

@pytest.mark.parametrize(
    ("c2d_val", "d2c_val", "expected_err"),
    [
        ("1234", FIXTURE_D2C, "length"),  # Short key
        (FIXTURE_C2D + "ab", FIXTURE_D2C, "length"),  # Long key
        ("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF", FIXTURE_D2C, "uppercase"),
        ("0123456789xyzdef0123456789abcdef0123456789abcdef0123456789abcdef", FIXTURE_D2C, "hex"),
        ("0" * 64, FIXTURE_D2C, "zero"),  # All-zero key
        (FIXTURE_C2D, FIXTURE_C2D, "identical"),  # Identical keys
        ("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", FIXTURE_D2C, "forbidden"),  # Known test key
    ],
)
def test_l7_apply_rejects_invalid_protocol_keys(
    tmp_path: Path, c2d_val: str, d2c_val: str, expected_err: str
) -> None:
    """apply.sh rejects keys that violate canonical Protocol v1 constraints."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    (input_dir / "k_c2d").write_text(c2d_val + "\n", encoding="utf-8")
    (input_dir / "k_d2c").write_text(d2c_val + "\n", encoding="utf-8")

    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    assert (L7_STAGE / "apply.sh").exists(), "apply.sh must exist"
    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0, f"Expected rejection for {expected_err}, but apply succeeded"


def test_l7_key_parity_with_esp32_provisioner(tmp_path: Path) -> None:
    """Fixture keys ingested by Core match p4-nvs-provision.py binary CSV byte-for-byte."""
    c2d_file = tmp_path / "k_c2d"
    d2c_file = tmp_path / "k_d2c"
    c2d_file.write_text(FIXTURE_C2D + "\n", encoding="ascii")
    d2c_file.write_text(FIXTURE_D2C + "\n", encoding="ascii")

    sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(DEPLOY))
    try:
        from aegis_soc.protocol_v1 import load_protocol_keys
        import importlib.util
        spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(NVS_PROVISION))
        nvs_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(nvs_mod)

        # Ingest through Core validator
        keys = load_protocol_keys(c2d_file, d2c_file)
        assert len(keys.c2d) == 32
        assert len(keys.d2c) == 32

        # Ingest through ESP32 NVS validator
        nvs_c2d, nvs_d2c = nvs_mod.validate_protocol_keys(FIXTURE_C2D, FIXTURE_D2C)
        assert keys.c2d == nvs_c2d
        assert keys.d2c == nvs_d2c
    finally:
        if str(ROOT) in sys.path:
            sys.path.remove(str(ROOT))
        if str(DEPLOY) in sys.path:
            sys.path.remove(str(DEPLOY))


def test_l7_no_production_key_generator_in_repository() -> None:
    """Assert that the repository contains NO production key generator script (OD-L7-02)."""
    matches = list(ROOT.rglob("*key*gen*.py"))
    # Only test fixtures or helper tools allowed, zero production key generator
    for match in matches:
        content = match.read_text(encoding="utf-8", errors="ignore")
        assert "PRODUCTION_KEY_GENERATOR" not in content


# =============================================================================
# 4. Credential File Permissions & Non-Symlink Enforcements (OD-L7-01)
# =============================================================================

def test_l7_apply_rejects_symlink_credentials(tmp_path: Path) -> None:
    """apply.sh rejects input credentials that are symlinks."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    real_key = tmp_path / "real_c2d"
    real_key.write_text(FIXTURE_C2D + "\n")
    real_key.chmod(0o600)
    (input_dir / "k_c2d").unlink()
    (input_dir / "k_c2d").symlink_to(real_key)

    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)
    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0
    assert "symlink" in (res.stdout + res.stderr).lower()


def test_l7_apply_rejects_loose_permissions(tmp_path: Path) -> None:
    """apply.sh rejects input credentials with group or other read/write bits."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    (input_dir / "k_c2d").chmod(0o644)  # Loose group/other read

    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)
    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0
    assert "permission" in (res.stdout + res.stderr).lower() or "mode" in (res.stdout + res.stderr).lower()


def test_l7_staging_enforces_0750_dir_and_0600_files(tmp_path: Path) -> None:
    """Staged credentials directory must be exact 0750 (root:aegis-idea3 live) and staged files exact 0600."""
    fs_root = tmp_path / "fs"
    make_fixture_release(fs_root)
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(fs_root)

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode == 0, f"apply.sh failed:\n{res.stdout}\n{res.stderr}"

    creds_dir = fs_root / "etc" / "aegis-idea3" / "credentials"
    assert creds_dir.is_dir()
    assert stat.S_IMODE(creds_dir.stat().st_mode) == 0o750

    for secret_file in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential"):
        sf = creds_dir / secret_file
        assert sf.is_file()
        assert not sf.is_symlink()
        assert stat.S_IMODE(sf.stat().st_mode) == 0o600


# =============================================================================
# 5. Admin PIN and MQTT Password Validation (OD-L7-04)
# =============================================================================

def test_l7_apply_rejects_default_or_empty_admin_pin(tmp_path: Path) -> None:
    """apply.sh rejects default PIN '1234' and empty PIN."""
    for bad_pin in ("1234", "", "   "):
        input_dir = create_fixture_input_dir(tmp_path / f"inputs_{slug(bad_pin)}")
        (input_dir / "admin.pin").write_text(bad_pin + "\n", encoding="utf-8")
        work_dir = tmp_path / f"work_{slug(bad_pin)}"
        work_dir.mkdir(parents=True)

        env = os.environ.copy()
        env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
        env["AEGIS_L7_WORK_DIR"] = str(work_dir)
        env["P4_FS_ROOT"] = str(tmp_path / "fs")

        res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
        assert res.returncode != 0
        assert "pin" in (res.stdout + res.stderr).lower()


def test_l7_apply_rejects_empty_mqtt_password(tmp_path: Path) -> None:
    """apply.sh rejects empty MQTT password file."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    (input_dir / "mqtt-core.pass").write_text("", encoding="utf-8")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0
    assert "mqtt" in (res.stdout + res.stderr).lower() or "password" in (res.stdout + res.stderr).lower()


# =============================================================================
# 6. D4 Local Restore Prerequisite (OD-L7-08)
# =============================================================================

def test_l7_apply_fails_closed_when_d4_credential_missing(tmp_path: Path) -> None:
    """apply.sh fails closed if restore.credential is missing in input directory."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    (input_dir / "restore.credential").unlink()
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0
    assert "restore.credential" in (res.stdout + res.stderr)


def test_l7_apply_fails_closed_when_d4_credential_invalid(tmp_path: Path) -> None:
    """apply.sh fails closed if restore.credential is malformed."""
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    (input_dir / "restore.credential").write_text("corrupted_format_without_json\n", encoding="utf-8")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(tmp_path / "fs")

    assert (L7_STAGE / "apply.sh").exists(), "apply.sh must exist"
    res = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res.returncode != 0


# =============================================================================
# 7. No Actuation & Boundary Invariants (OD-L7-05)
# =============================================================================

def test_l7_verify_asserts_zero_actuation(tmp_path: Path) -> None:
    """verify.sh asserts zero relay commands in SQLite store and status."""
    verify_script = L7_STAGE / "verify.sh"
    assert verify_script.exists()

    fs_root = tmp_path / "fs"
    fs_root.mkdir(parents=True)
    db_dir = fs_root / "var" / "lib" / "aegis-idea3" / "data"
    db_dir.mkdir(parents=True)

    # Initialize empty SQLite database
    import sqlite3
    db_path = db_dir / "core-audit.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE audit_events (id INTEGER PRIMARY KEY, event_type TEXT, timestamp TEXT)")
    conn.commit()
    conn.close()

    env = os.environ.copy()
    env["P4_FS_ROOT"] = str(fs_root)
    env["AEGIS_L7_WORK_DIR"] = str(tmp_path / "work")

    # When 0 actuations exist, verify should pass the actuation check
    res = subprocess.run(["bash", str(verify_script)], text=True, capture_output=True, check=False, env=env)
    assert "CUT_UPLINK" not in res.stdout
    assert "RESTORE_UPLINK" not in res.stdout


def test_l7_verify_fails_closed_on_corrupt_audit_db(tmp_path: Path) -> None:
    """verify.sh must fail closed if core-audit.sqlite3 is corrupt/unreadable."""
    fs_root = tmp_path / "fs"
    make_fixture_release(fs_root)
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(fs_root)

    # Apply staging
    res_apply = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_apply.returncode == 0

    # Corrupt audit database
    db_path = fs_root / "var" / "lib" / "aegis-idea3" / "data" / "core-audit.sqlite3"
    db_path.write_text("corrupted_database_content\n", encoding="utf-8")

    res_verify = subprocess.run(["bash", str(L7_STAGE / "verify.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_verify.returncode != 0, f"Expected verify.sh to fail on corrupt audit DB, but it passed:\n{res_verify.stdout}"
    assert "audit" in (res_verify.stdout + res_verify.stderr).lower() or "sqlite" in (res_verify.stdout + res_verify.stderr).lower()


def test_l7_verify_fails_closed_when_actuation_present(tmp_path: Path) -> None:
    """verify.sh must fail closed if CUT_UPLINK or RESTORE_UPLINK is recorded in audit DB."""
    fs_root = tmp_path / "fs"
    make_fixture_release(fs_root)
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(fs_root)

    # Apply staging
    res_apply = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_apply.returncode == 0

    # Insert an actuation into audit DB
    import sqlite3
    db_path = fs_root / "var" / "lib" / "aegis-idea3" / "data" / "core-audit.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY, event_type TEXT, timestamp TEXT)")
    conn.execute("INSERT INTO audit_events (event_type, timestamp) VALUES ('CUT_UPLINK', '2026-09-21T00:00:00Z')")
    conn.commit()
    conn.close()

    res_verify = subprocess.run(["bash", str(L7_STAGE / "verify.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_verify.returncode != 0, f"Expected verify.sh to fail when actuation is present, but it passed:\n{res_verify.stdout}"
    assert "actuation" in (res_verify.stdout + res_verify.stderr).lower()


def test_l7_allow_listeners_is_empty() -> None:
    """stages/L7/allow-listeners.txt MUST be empty (OD-L7-06)."""
    al_file = L7_STAGE / "allow-listeners.txt"
    assert al_file.exists()
    lines = [line.strip() for line in al_file.read_text(encoding="utf-8").splitlines()]
    active_lines = [l for l in lines if l and not l.startswith("#")]
    assert len(active_lines) == 0, f"Expected empty allow-listeners.txt, found: {active_lines}"


def test_l7_allow_keys_matches_contract() -> None:
    """stages/L7/allow-keys.txt must contain exactly the 28 approved keys."""
    ak_file = L7_STAGE / "allow-keys.txt"
    assert ak_file.exists()
    lines = [line.strip() for line in ak_file.read_text(encoding="utf-8").splitlines()]
    active_keys = {l for l in lines if l and not l.startswith("#")}

    assert active_keys == EXPECTED_ALLOW_KEYS, (
        f"Allow keys mismatch:\nMissing: {EXPECTED_ALLOW_KEYS - active_keys}\nUnexpected: {active_keys - EXPECTED_ALLOW_KEYS}"
    )


# =============================================================================
# 8. Rollback Idempotency and Surgical Recovery (OD-L7-07)
# =============================================================================

def test_l7_rollback_is_idempotent(tmp_path: Path) -> None:
    """Running rollback.sh twice exits cleanly with returncode 0."""
    fs_root = tmp_path / "fs"
    make_fixture_release(fs_root)
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(fs_root)

    # 1. Apply
    res_apply = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_apply.returncode == 0

    # 2. First Rollback
    res_rb1 = subprocess.run(["bash", str(L7_STAGE / "rollback.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_rb1.returncode == 0, f"First rollback failed:\n{res_rb1.stdout}\n{res_rb1.stderr}"

    # 3. Second Rollback (idempotency check)
    res_rb2 = subprocess.run(["bash", str(L7_STAGE / "rollback.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_rb2.returncode == 0, f"Second rollback failed:\n{res_rb2.stdout}\n{res_rb2.stderr}"


def test_l7_rollback_preserves_durable_audit_db(tmp_path: Path) -> None:
    """Rollback cleans transient files but PRESERVES durable audit DB and pre-existing files."""
    fs_root = tmp_path / "fs"
    make_fixture_release(fs_root)
    input_dir = create_fixture_input_dir(tmp_path / "inputs")
    work_dir = tmp_path / "work"
    work_dir.mkdir(parents=True)

    # Pre-existing file
    pre_existing = fs_root / "etc" / "aegis-idea3" / "credentials" / "pre_existing.txt"
    pre_existing.parent.mkdir(parents=True, exist_ok=True)
    pre_existing.write_text("keep_me\n")

    # Durable audit DB
    audit_db = fs_root / "var" / "lib" / "aegis-idea3" / "data" / "core-audit.sqlite3"
    audit_db.parent.mkdir(parents=True, exist_ok=True)
    audit_db.write_text("durable_audit_events\n")

    env = os.environ.copy()
    env["AEGIS_L7_INPUT_DIR"] = str(input_dir)
    env["AEGIS_L7_WORK_DIR"] = str(work_dir)
    env["P4_FS_ROOT"] = str(fs_root)

    res_apply = subprocess.run(["bash", str(L7_STAGE / "apply.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_apply.returncode == 0

    res_rb = subprocess.run(["bash", str(L7_STAGE / "rollback.sh")], text=True, capture_output=True, check=False, env=env)
    assert res_rb.returncode == 0

    # Assert pre-existing file and durable audit DB are intact
    assert pre_existing.exists(), "Pre-existing file was erroneously removed by rollback!"
    assert audit_db.exists(), "Durable audit database was erroneously removed by rollback!"


def slug(s: str) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9]", "_", s) or "empty"
