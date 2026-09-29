# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — G-15 Host Artifact Capture and Compare Test Suite.

Authoritative Design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md
Decisions:
  OD-L7-06 G-15 Shared Harness Amendment (Option A — Exact Narrow Host Exception).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
COMPARE = DEPLOY / "p4-compare.sh"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
STAGES = DEPLOY / "stages"


def make_bundle(
    dir_path: Path,
    label: str,
    records: dict[str, str],
    *,
    evidence_class: str = "CORE_HOST_READ_ONLY",
) -> Path:
    dir_path.mkdir(parents=True, exist_ok=True)
    all_rec = dict(records)

    categories = {
        "meta": [
            f"meta.schema\t1",
            f"meta.label\t{label}",
            f"meta.captured_at\t2026-09-21T00:00:00Z",
            f"meta.journal_since\t2026-09-21 00:00:00 UTC",
            f"meta.run_uid\t0",
            f"meta.capture_status\tCOMPLETE",
            f"meta.production_mutation\tNO",
            f"meta.evidence_class\t{evidence_class}",
            f"meta.fs_root\tnone",
        ],
        "caps": [
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
        ],
        "net": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("net.") or k.startswith("sysctl.")],
        "wifi": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("wifi.") or k.startswith("nm.")],
        "fw": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("fw.")],
        "time": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("time.")],
        "mqtt": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("mqtt.")],
        "svc": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("svc.")],
        "listen": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("listen.")],
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
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DISK_THRESHOLD_PCT"] = "90"
    if allow_keys_file is not None:
        env["ALLOW_KEYS_FILE"] = str(allow_keys_file)
    if allow_listeners_file is not None:
        env["ALLOW_LISTENERS_FILE"] = str(allow_listeners_file)
    if extra_env:
        env.update(extra_env)

    return subprocess.run(
        ["bash", str(COMPARE), str(before_dir), str(after_dir)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


# =============================================================================
# G-15 Harness Exception Tests (Option A)
# =============================================================================

def test_g15_option_a_exact_host_keys_accepted(tmp_path: Path) -> None:
    """p4-compare.sh accepts exact allowed host keys under Option A narrow exception."""
    before_dir = make_bundle(tmp_path / "before", "before", {
        "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta": "600:0:0:100:1234567890",
        "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta": "600:0:0:64:1234567890",
        "host.path./opt/aegis-idea3/current": "absent",
        "host.symlink./opt/aegis-idea3/current.target": "absent",
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
    })
    after_dir = make_bundle(tmp_path / "after", "after", {
        "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta": "600:0:0:200:1234567999",
        "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta": "600:0:0:64:1234567999",
        "host.path./opt/aegis-idea3/current": "present",
        "host.symlink./opt/aegis-idea3/current.target": "/opt/aegis-idea3/releases/rel-1",
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
    })

    allow_file = tmp_path / "allow-keys.txt"
    allow_file.write_text(
        "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta\n"
        "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta\n"
        "host.path./opt/aegis-idea3/current\n"
        "host.symlink./opt/aegis-idea3/current.target\n"
        "host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256\n",
        encoding="utf-8",
    )

    res = run_compare(before_dir, after_dir, allow_keys_file=allow_file)
    assert res.returncode == 0, f"Compare failed unexpectedly:\n{res.stdout}\n{res.stderr}"
    assert "COMPARE_RESULT=PASS" in res.stdout
    assert "DRIFT_RESULT=PASS" in res.stdout


def test_g15_protected_host_keys_still_rejected(tmp_path: Path) -> None:
    """p4-compare.sh continues to reject protected host keys like boot_id, identity, kernel."""
    before_dir = make_bundle(tmp_path / "before", "before", {})
    after_dir = make_bundle(tmp_path / "after", "after", {})
    allow_file = tmp_path / "allow-keys.txt"

    for protected_key in (
        "host.boot_id",
        "host.identity",
        "host.kernel",
        "host.twingate.status",
        "disk.root.use_pct",
    ):
        allow_file.write_text(f"{protected_key}\n", encoding="utf-8")
        res = run_compare(before_dir, after_dir, allow_keys_file=allow_file)
        assert res.returncode == 2, f"Protected key {protected_key} was unexpectedly accepted!"
        assert "protected key cannot be approved" in (res.stdout + res.stderr)


def test_g15_wildcard_host_keys_rejected(tmp_path: Path) -> None:
    """Wildcard allow keys for host entries must be rejected as malformed or protected."""
    before_dir = make_bundle(tmp_path / "before", "before", {})
    after_dir = make_bundle(tmp_path / "after", "after", {})
    allow_file = tmp_path / "allow-keys.txt"

    for wildcard in ("host.*", "host.aegis_idea3.*", "host.path.*", "*"):
        allow_file.write_text(f"{wildcard}\n", encoding="utf-8")
        res = run_compare(before_dir, after_dir, allow_keys_file=allow_file)
        assert res.returncode == 2, f"Wildcard {wildcard} was not rejected with exit code 2!"


def test_g15_l6b_mqtt_files_regression_free(tmp_path: Path) -> None:
    """L6b mqtt files under /etc/aegis-idea3/mqtt/ pass compare when in allow-keys."""
    before_dir = make_bundle(tmp_path / "before", "before", {
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.meta": "644:0:0:100:1000",
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.class": "secret-metadata-only",
    })
    after_dir = make_bundle(tmp_path / "after", "after", {
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.meta": "644:0:0:150:2000",
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.class": "secret-metadata-only",
    })

    allow_file = tmp_path / "allow-keys.txt"
    allow_file.write_text(
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.meta\n"
        "host.aegis_idea3.file./etc/aegis-idea3/mqtt/mosquitto.conf.class\n",
        encoding="utf-8",
    )

    res = run_compare(before_dir, after_dir, allow_keys_file=allow_file)
    assert res.returncode == 0, f"L6b regression: {res.stdout}\n{res.stderr}"
    assert "COMPARE_RESULT=PASS" in res.stdout


# =============================================================================
# G-15 Capture Script Enhancements Tests (p4-l0-capture.sh)
# =============================================================================

def test_g15_capture_release_symlink_target(tmp_path: Path) -> None:
    """p4-l0-capture.sh captures exact symlink target of /opt/aegis-idea3/current."""
    fs_root = tmp_path / "fs"
    fs_root.mkdir(parents=True)
    evid_dir = tmp_path / "evid"
    evid_dir.mkdir(parents=True)

    # Setup simulated release structure
    rel_dir = fs_root / "opt" / "aegis-idea3" / "releases" / "v1.0.0"
    rel_dir.mkdir(parents=True)
    current_symlink = fs_root / "opt" / "aegis-idea3" / "current"
    current_symlink.symlink_to("/opt/aegis-idea3/releases/v1.0.0")

    # Run capture with P4_FS_ROOT
    env = os.environ.copy()
    env["P4_FS_ROOT"] = str(fs_root)
    env["EVID_DIR"] = str(evid_dir)
    env["JOURNAL_SINCE"] = "2026-09-21 00:00:00 UTC"
    env["CAPTURE_LABEL"] = "test-symlink"

    res = subprocess.run(
        ["bash", str(CAPTURE)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    assert res.returncode in (0, 3), f"Capture failed:\n{res.stdout}\n{res.stderr}"

    host_tsv = evid_dir / "host.tsv"
    assert host_tsv.exists(), "host.tsv was not generated"
    host_content = host_tsv.read_text(encoding="utf-8")

    # Expect host.symlink./opt/aegis-idea3/current.target recorded with its target
    assert "host.symlink./opt/aegis-idea3/current.target\t/opt/aegis-idea3/releases/v1.0.0" in host_content


def test_g15_capture_core_unit_file(tmp_path: Path) -> None:
    """p4-l0-capture.sh captures /etc/systemd/system/aegis-idea3-core.service."""
    fs_root = tmp_path / "fs"
    fs_root.mkdir(parents=True)
    evid_dir = tmp_path / "evid"
    evid_dir.mkdir(parents=True)

    unit_file = fs_root / "etc" / "systemd" / "system" / "aegis-idea3-core.service"
    unit_file.parent.mkdir(parents=True)
    unit_content = "[Unit]\nDescription=AEGIS Core Test\n[Service]\nExecStart=/bin/true\n"
    unit_file.write_text(unit_content, encoding="utf-8")
    expected_sha = hashlib.sha256(unit_content.encode("utf-8")).hexdigest()

    env = os.environ.copy()
    env["P4_FS_ROOT"] = str(fs_root)
    env["EVID_DIR"] = str(evid_dir)
    env["JOURNAL_SINCE"] = "2026-09-21 00:00:00 UTC"
    env["CAPTURE_LABEL"] = "test-unit"

    res = subprocess.run(
        ["bash", str(CAPTURE)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    assert res.returncode in (0, 3), f"Capture failed:\n{res.stdout}\n{res.stderr}"

    host_tsv = evid_dir / "host.tsv"
    assert host_tsv.exists(), "host.tsv was not generated"
    host_content = host_tsv.read_text(encoding="utf-8")

    assert "host.unit_file./etc/systemd/system/aegis-idea3-core.service.class\tconfig" in host_content
    assert f"host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256\t{expected_sha}" in host_content
    assert "host.unit_file./etc/systemd/system/aegis-idea3-core.service.meta\t" in host_content
