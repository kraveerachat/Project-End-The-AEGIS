"""CTu PRE-capture dependency-closure regressions.

These tests execute the real L0 capture script against a fixture filesystem and
exercise the same frozen-bundle preparation and checksum verification paths
used by the owner runner.  They intentionally model the BASE_MAIN bundle with
the two direct helpers absent, then verify the repaired bundle end to end.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
P4 = ROOT / "deploy" / "pr11-phase4"
CAPTURE = P4 / "p4-l0-capture.sh"
CTU_LIB = P4 / "p4-ctu-run-lib.sh"
SNAPSHOT = P4 / "ctu-acceptance" / "ctu_verifier_snapshot.py"

from test_pr11_phase4_harness import capture as fixture_capture  # noqa: E402
from test_pr11_phase4_harness import fs_fixture, make_bin, write_tree  # noqa: E402


HELPERS = {"p4-l5-clock.py", "p4-l6c-tree-digest.py"}


def _userns_usable() -> bool:
    if shutil.which("unshare") is None:
        return False
    return subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


def _commit_fixture_repo(tmp_path: Path) -> tuple[Path, Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "AEGIS Test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@aegis.local"], check=True)
    target = repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
    target.parent.mkdir(parents=True)
    shutil.copytree(P4, target)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "ctu fixture"], check=True, capture_output=True)
    main = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    return repo, target, main


def _prepare_bundle(tmp_path: Path) -> Path:
    repo, target, main = _commit_fixture_repo(tmp_path)
    work = tmp_path / "work"
    bundle = work / "bundle"
    script = f'''\nset -Eeuo pipefail\nsource "{target / "p4-ctu-run-lib.sh"}"\nCTU_SUDO=""\nctu_prepare_work_dir "{work}"\nctu_prepare_bundle "{repo}" "{target}" "{bundle}" "{main}"\nctu_verify_bundle "{bundle}"\n'''
    command = ["unshare", "-r", "bash", "-c", script] if _userns_usable() else ["bash", "-c", script]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return bundle


def _capture_bundle(bundle: Path, tmp_path: Path, *, label: str) -> subprocess.CompletedProcess[str]:
    root = tmp_path / f"fixture-{label}"
    root.mkdir()
    fix = root / "fix"
    write_tree(fix, {
        **__import__("test_pr11_phase4_harness").healthy_fixtures(),
        "units/systemd-timesyncd.service": "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nMainPID=0\nNRestarts=0\nResult=success\nExecMainStartTimestamp=\n",
    })
    fsroot = root / "fsroot"
    write_tree(fsroot, fs_fixture("P4CANARYdependency"))
    release = fsroot / "opt/aegis-idea3/releases/rel-a"
    release.mkdir(parents=True)
    (release / "payload.txt").write_text("valid release payload\n")
    bindir = make_bin(root)
    (bindir / "xargs").symlink_to(shutil.which("xargs"))
    (bindir / "basename").symlink_to(shutil.which("basename"))
    (bindir / "python3").symlink_to(shutil.which("python3"))
    evidence = root / "evidence"
    env = {
        **os.environ,
        "PATH": str(bindir),
        "HOME": str(root),
        "LC_ALL": "C",
        "P4_FIX": str(fix),
        "P4_CALL_LOG": str(root / "calls.log"),
        "AEGIS_P4_FS_ROOT": str(fsroot),
        "EVID_DIR": str(evidence),
        "CAPTURE_LABEL": label,
        "JOURNAL_SINCE": "2026-09-27 00:00:00 UTC",
    }
    (root / "calls.log").touch()
    return subprocess.run(["bash", str(bundle / "p4-l0-capture.sh")], env={**env, "PATH": str(bindir)}, capture_output=True, text=True)


def _host_value(evidence: Path, key: str) -> str:
    for line in (evidence / "host.tsv").read_text().splitlines():
        k, _, value = line.partition("\t")
        if k == key:
            return value
    raise AssertionError(f"missing {key}")


def test_base_style_missing_digest_helper_makes_nonempty_catalog_unreadable(tmp_path: Path) -> None:
    bundle = tmp_path / "base-bundle"
    bundle.mkdir()
    for name in ("p4-l0-capture.sh", "p4-lib.sh", "p4-iw-phy-regnorm.awk"):
        shutil.copy2(P4 / name, bundle / name)
    result = _capture_bundle(bundle, tmp_path, label="base-missing")
    assert result.returncode == 3
    evidence = tmp_path / "fixture-base-missing" / "evidence"
    assert _host_value(evidence, "host.aegis_idea3.release_catalog").endswith(":UNREADABLE")
    assert "L0_CAPTURE=PARTIAL" in (evidence / "capture.log").read_text()


def test_repaired_bundle_captures_valid_digest_and_reaches_complete(tmp_path: Path) -> None:
    bundle = _prepare_bundle(tmp_path)
    assert all((bundle / helper).is_file() for helper in HELPERS)
    result = _capture_bundle(bundle, tmp_path, label="repaired")
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = tmp_path / "fixture-repaired" / "evidence"
    value = _host_value(evidence, "host.aegis_idea3.release_catalog")
    assert re.fullmatch(r"rel-a:[0-9a-f]{64}", value)
    assert "L0_CAPTURE=COMPLETE" in (evidence / "capture.log").read_text()


@pytest.mark.parametrize("helper", sorted(HELPERS))
def test_bundle_integrity_refuses_missing_or_tampered_helper(tmp_path: Path, helper: str) -> None:
    bundle = _prepare_bundle(tmp_path)
    manifest = bundle / "CTU-BUNDLE-SHA256SUMS"
    command = f'. "{CTU_LIB}"; CTU_SUDO=""; ctu_verify_bundle "$1"'
    mutation = ["rm", "--", str(bundle / helper)]
    if _userns_usable():
        mutation = ["unshare", "-r", "sh", "-c", "rm -- \"$1\"", "rm", str(bundle / helper)]
    subprocess.run(mutation, check=True)
    missing = subprocess.run(["bash", "-c", command, "verify", str(bundle)], capture_output=True)
    assert missing.returncode != 0

    bundle = _prepare_bundle(tmp_path / "tampered")
    target = bundle / helper
    tamper = f'''chmod 0755 "{target}"; printf '\\n# tampered\\n' >> "{target}"; chmod 0555 "{target}"'''
    if _userns_usable():
        tamper_cmd = ["unshare", "-r", "sh", "-c", tamper]
    else:
        tamper_cmd = ["sh", "-c", tamper]
    subprocess.run(tamper_cmd, check=True)
    tampered = subprocess.run(["bash", "-c", command, "verify", str(bundle)], capture_output=True)
    assert tampered.returncode != 0
    assert hashlib.sha256(manifest.read_bytes()).hexdigest()


def test_l0_direct_local_dependencies_are_present_in_frozen_bundle_and_snapshot(tmp_path: Path) -> None:
    refs = set(re.findall(r"\$P4_HERE/([A-Za-z0-9._-]+)", (P4 / "p4-l0-capture.sh").read_text()))
    assert refs == HELPERS
    bundle = _prepare_bundle(tmp_path)
    assert refs <= {str(path.relative_to(bundle)) for path in bundle.rglob("*") if path.is_file()}
    snapshot_text = SNAPSHOT.read_text()
    assert all(f'"{helper}"' in snapshot_text for helper in sorted(HELPERS))
