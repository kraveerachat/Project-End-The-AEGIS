"""PR11 Phase 4 L6c/L7 — release-directory permission fix under a hostile process umask.

Live evidence (2026-09-28, `sudo namei -l` against the installed release at
/opt/aegis-idea3/releases/1de1b4eaaa1506a8ec411f822be731994a7c1ca9): every directory the installer/L6c handler itself
created (/opt/aegis-idea3, releases/, the release root, venv/, venv/bin/) came out mode 0700 instead of the reviewed
0755, even though `p4-l7-install-release.py` passes `mode=0o755` at every `Path.mkdir()` call site. Root cause:
`stages/L6c/apply.sh` sets `umask 077` (deliberately, to keep its own work dir private) before invoking the installer
as a subprocess exactly once; `Path.mkdir(mode=...)`/`os.mkdir(mode=...)` AND with `~umask`, so the inherited 077
umask silently turns every 0755 directory this tool creates into 0700 — a plain file, meanwhile, always gets an
explicit `os.chmod()` afterward and is unaffected. `venv/bin/python` ends up 0755 only because it is a FILE (explicit
chmod), but its parent directories being 0700 still block traversal for the non-root `aegis-idea3` service identity.

This file proves the failure exists under a hostile umask (RED against pre-fix `main`) and then proves the fix
normalizes every directory THIS installer itself creates, without ever touching a pre-existing ancestor's mode/owner.
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_pr11_phase4_l7_release_guard_helper import build_release

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "deploy" / "pr11-phase4" / "p4-l7-install-release.py"
REL_ID = "rel-umask-fix-1"
LOGICAL = f"/opt/aegis-idea3/releases/{REL_ID}"
HOSTILE_UMASK = 0o077


def _install_under_umask(source: Path, host_root: Path, umask: int, *, release_id: str = REL_ID,
                          logical: str = LOGICAL) -> subprocess.CompletedProcess[str]:
    """Runs the REAL installer as a real subprocess (matching how stages/L6c/apply.sh invokes it) with the given
    process umask set only for that child, exactly reproducing the live failure mode instead of simulating it."""
    args = [sys.executable, str(INSTALLER), "install", "--release-id", release_id, "--source", str(source),
            "--logical-path", logical, "--host-root", str(host_root), "--fixture-dest-owner-any",
            "--evidence", str(host_root / "evidence.tsv")]
    return subprocess.run(args, text=True, capture_output=True, check=False,
                           preexec_fn=lambda: os.umask(umask))


def test_installed_release_directories_are_exactly_0755_under_a_077_process_umask(tmp_path: Path) -> None:
    """The RED case: reproduces the exact live condition (umask 077, absent parents, valid release source)."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"  # /opt/aegis-idea3 does not exist yet, matching the live first install
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 0, res.stdout + res.stderr

    opt = root / "opt/aegis-idea3"
    releases = opt / "releases"
    dest = releases / REL_ID
    assert stat.S_IMODE(opt.stat().st_mode) == 0o755, "opt dir must not inherit the hostile umask"
    assert stat.S_IMODE(releases.stat().st_mode) == 0o755, "releases dir must not inherit the hostile umask"
    for p in [dest, *dest.rglob("*")]:
        if p.is_dir():
            assert stat.S_IMODE(p.lstat().st_mode) == 0o755, f"{p} directory must be 0755, not umask-narrowed"
        else:
            expected = 0o755 if p.lstat().st_mode & stat.S_IXUSR else 0o644
            assert stat.S_IMODE(p.lstat().st_mode) == expected, f"{p} file mode must be unaffected by umask"


def test_venv_bin_python_directory_chain_is_traversable_under_hostile_umask(tmp_path: Path) -> None:
    """Directly targets the reported symptom: venv/, venv/bin/ must both be 0755 (traversable+listable by group/other
    with the x bit), independent of process umask, matching the file p4-l7-release-guard.py already expects."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 0, res.stdout + res.stderr
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    for rel in ("venv", "venv/bin"):
        mode = stat.S_IMODE((dest / rel).stat().st_mode)
        assert mode == 0o755, f"{rel} = {oct(mode)}, expected 0o755"
    py = dest / "venv/bin/python"
    assert py.stat().st_mode & stat.S_IXUSR
    # traversal simulated deterministically: every ancestor directory has the "other execute" bit set
    node = py.parent
    while node != dest.parent:
        assert stat.S_IMODE(node.stat().st_mode) & stat.S_IXOTH, f"{node} not traversable by other (non-owner service identity)"
        node = node.parent


def test_fix_never_touches_a_preexisting_releases_dir_even_under_hostile_umask(tmp_path: Path) -> None:
    """L6C_MUTATION_BOUNDARY: a parent this run did NOT create must never be chmod/chown repaired, hostile umask or not."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    releases = root / "opt/aegis-idea3/releases"
    releases.mkdir(parents=True)
    releases.chmod(0o750)  # unusual but acceptable pre-existing mode
    before = releases.stat()
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 0, res.stdout + res.stderr
    after = releases.stat()
    assert stat.S_IMODE(after.st_mode) == 0o750, "pre-existing parent must never be repaired"
    assert after.st_uid == before.st_uid and after.st_gid == before.st_gid


def test_fix_never_touches_a_preexisting_opt_dir_even_under_hostile_umask(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    opt = root / "opt/aegis-idea3"
    opt.mkdir(parents=True)
    opt.chmod(0o700)
    before = opt.stat()
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 0, res.stdout + res.stderr
    after = opt.stat()
    assert stat.S_IMODE(after.st_mode) == 0o700, "pre-existing opt dir must never be repaired"
    assert after.st_uid == before.st_uid and after.st_gid == before.st_gid


def test_group_or_other_writable_preexisting_parent_still_fails_closed_under_hostile_umask(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    releases = root / "opt/aegis-idea3/releases"
    releases.mkdir(parents=True)
    releases.chmod(0o777)
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 1
    assert "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER" in (res.stdout + res.stderr)
    assert list(releases.iterdir()) == []


def test_symlinked_destination_ancestor_still_rejected_under_hostile_umask(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    real_dir = tmp_path / "elsewhere"
    real_dir.mkdir()
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").symlink_to(real_dir)
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 1
    assert "DESTINATION_PARENT_IS_SYMLINK" in (res.stdout + res.stderr)
    assert not (real_dir / REL_ID).exists()


def test_symlink_in_source_still_rejected_under_hostile_umask(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/evil").symlink_to("/etc/passwd")
    root = tmp_path / "fs"
    res = _install_under_umask(src, root, HOSTILE_UMASK)
    assert res.returncode == 1
    assert "SYMLINK_IN_RELEASE" in (res.stdout + res.stderr)
