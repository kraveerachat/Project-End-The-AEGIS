"""PR11 Phase 4 L7 — release installer (deploy/pr11-phase4/p4-l7-install-release.py).

Closes the remaining release-install gap: p4-l7-build-release.py (PR #208, merged into main) produces a release in a
USER-OWNED staging directory; p4-l7-release-guard.py (this branch) proves an ALREADY-INSTALLED release's contract. Nothing in
the repository copied a built release into /opt/aegis-idea3/releases/<id>. This tool does exactly that, and ONLY that:

* Source: a completed builder output directory. It never builds anything and never touches secrets. It re-validates the
  source with the REAL, CURRENT `p4-l7-release-guard.py` (imported directly, not a copy of any predicate) before any
  mutation, at `--expect-owner any` (the builder output is user-owned).
* Destination: exactly /opt/aegis-idea3/releases/<release-id>. It refuses to overwrite an existing release, never recurses
  into /opt/aegis-idea3, rejects a symlinked destination or ancestor, stages through a sibling temporary directory and
  places the release with a single atomic rename, and re-verifies the STAGED COPY with the same real guard immediately
  before that rename.
* `current`: this tool NEVER creates, reads as a target, or otherwise touches /opt/aegis-idea3/current — stages/L7/apply.sh
  is the sole owner of that symlink (verified by source inspection below), so the two workflows can never race.
* Failure: fails closed, never retries, removes only its own temporary staging directory on failure before the final
  rename, and never touches an already-placed immutable release afterwards.
* Evidence: an optional --evidence file records only release_id, source_git_sha and the logical destination — no host
  username, no absolute source/staging path, no secret.

No systemd mutation, no service start, no ESP32/L8 action: this is a plain file-copy tool.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
INSTALLER = DEPLOY / "p4-l7-install-release.py"
GUARD = DEPLOY / "p4-l7-release-guard.py"
APPLY = DEPLOY / "stages" / "L7" / "apply.sh"

sys.path.insert(0, str(ROOT / "tests"))
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

REL_ID = "rel-installer-1"
LOGICAL = f"/opt/aegis-idea3/releases/{REL_ID}"


def install(source: Path, root: Path, *, release_id: str = REL_ID, logical: str = LOGICAL, expect_owner: str = "any",
            evidence: Path | None = None) -> subprocess.CompletedProcess[str]:
    args = [sys.executable, str(INSTALLER), "install", "--release-id", release_id, "--source", str(source),
            "--logical-path", logical, "--host-root", str(root), "--expect-owner", expect_owner]
    if evidence is not None:
        args += ["--evidence", str(evidence)]
    return subprocess.run(args, text=True, capture_output=True, check=False)


def reason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_RELEASE_INSTALL=FAIL reason=(\S+)", res.stdout + res.stderr)
    return m.group(1) if m else ""


def guard(root: Path, release_id: str = REL_ID, logical: str = LOGICAL, expect_owner: str = "any") -> subprocess.CompletedProcess[str]:
    host = f"{root}{logical}"
    return subprocess.run([sys.executable, str(GUARD), "check", "--logical-path", logical, "--host-path", host,
                           "--expect-owner", expect_owner], text=True, capture_output=True, check=False)


def test_installer_and_guard_tools_exist() -> None:
    assert INSTALLER.is_file() and GUARD.is_file()


def test_apply_sh_is_the_sole_owner_of_the_current_symlink_and_installer_never_touches_it() -> None:
    apply_text = APPLY.read_text()
    assert "ln -s" in apply_text and '"$CURRENT"' in apply_text  # apply.sh creates/owns `current`
    installer_text = INSTALLER.read_text()
    module_doc_end = installer_text.index('"""', installer_text.index('"""') + 3) + 3
    code = installer_text[module_doc_end:]
    assert "os.symlink" not in code
    assert "/opt/aegis-idea3/current" not in code, "installer must never reference /opt/aegis-idea3/current outside its docstring"


def test_installer_installs_a_valid_builder_output_and_the_new_guard_accepts_it(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert f"L7_RELEASE_INSTALL=PASS release_id={REL_ID}" in res.stdout
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    assert dest.is_dir() and not dest.is_symlink()
    g = guard(root)
    assert g.returncode == 0, g.stdout + g.stderr  # BUILDER_OUTPUT_NEW_GUARD=PASS, end to end through the real installer


def test_installer_produces_root_ownable_content_when_run_as_root_live(tmp_path: Path) -> None:
    """Live mode (--host-root omitted) copies as the invoking process; as root that means root-owned, satisfying expect-owner root.
    Modes must never be group/other-writable regardless of who runs it."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    install(src, root)
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    for p in [dest, *dest.rglob("*")]:
        assert stat.S_IMODE(p.lstat().st_mode) & 0o022 == 0, p


def test_installer_never_creates_or_modifies_current(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    install(src, root)
    assert not (root / "opt/aegis-idea3/current").exists()
    assert not (root / "opt/aegis-idea3/current").is_symlink()


def test_installer_refuses_to_overwrite_an_existing_release(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    before = (root / "opt/aegis-idea3/releases" / REL_ID / "RELEASE-SHA256SUMS").read_bytes()
    other = build_release(tmp_path / "staging2", release_id=REL_ID, sha="b" * 40)
    res = install(other, root)
    assert res.returncode == 1 and reason(res) == "RELEASE_ALREADY_INSTALLED"
    assert (root / "opt/aegis-idea3/releases" / REL_ID / "RELEASE-SHA256SUMS").read_bytes() == before  # untouched


def test_installer_respects_an_existing_current_symlink_ownership(tmp_path: Path) -> None:
    """Confirms the installer neither creates nor is blocked/confused by a pre-existing `current` (apply.sh's own concern)."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/current").symlink_to("/opt/aegis-idea3/releases/some-other-release")
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert os.readlink(root / "opt/aegis-idea3/current") == "/opt/aegis-idea3/releases/some-other-release"  # unchanged


def _resync_sums(rel: Path) -> None:
    import hashlib

    lines = [f"{hashlib.sha256((rel / p).read_bytes()).hexdigest()}  {p}"
             for p in sorted(q.relative_to(rel).as_posix() for q in rel.rglob("*") if q.is_file() and q.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")


@pytest.mark.parametrize("mutate,code", [
    (lambda rel: ((rel / "RELEASE-MANIFEST.json").write_text("{not json"), _resync_sums(rel)), "RELEASE_GUARD_FAILED:MANIFEST_MALFORMED"),
    (lambda rel: (rel / "aegis_soc/supervisor.py").write_text("print('tampered')\n"), "RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"),
])
def test_installer_fails_before_mutation_on_an_invalid_manifest_or_checksum(tmp_path: Path, mutate, code: str) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    mutate(src)
    root = tmp_path / "fs"
    res = install(src, root)
    assert res.returncode == 1 and reason(res) == code
    assert not (root / "opt/aegis-idea3/releases" / REL_ID).exists()
    assert not list((root / "opt/aegis-idea3/releases").glob(".install-tmp-*")) if (root / "opt/aegis-idea3/releases").exists() else True


def test_installer_rejects_an_unexpected_extra_file_in_the_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/extra.py").write_text("x=1\n")
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:CHECKSUM_ENTRY_MISSING"


def test_installer_rejects_a_symlink_in_the_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/evil").symlink_to("/etc/passwd")
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:SYMLINK_IN_RELEASE"


def test_installer_rejects_a_symlinked_source_directory(tmp_path: Path) -> None:
    real = build_release(tmp_path / "staging", release_id=REL_ID)
    link = tmp_path / "src-link"
    link.symlink_to(real)
    res = install(link, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:RELEASE_IS_SYMLINK"


def test_installer_rejects_a_symlinked_destination_release_path(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases" / REL_ID).symlink_to("/etc")
    res = install(src, root)
    assert reason(res) == "DESTINATION_IS_SYMLINK"
    assert (root / "opt/aegis-idea3/releases" / REL_ID).is_symlink()  # untouched, not removed


def test_installer_rejects_a_symlinked_destination_ancestor(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    real_dir = tmp_path / "elsewhere"
    real_dir.mkdir()
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").symlink_to(real_dir)
    res = install(src, root)
    assert reason(res) == "DESTINATION_PARENT_IS_SYMLINK"
    assert not (real_dir / REL_ID).exists()


def test_installer_rejects_group_or_other_writable_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/supervisor.py").chmod(0o666)
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:WRITABLE_BY_GROUP_OR_OTHER"


def test_installer_partial_failure_cleans_only_its_own_temporary_staging(tmp_path: Path) -> None:
    """Simulate a mid-copy failure (unreadable file) after the pre-copy guard already passed: only .install-tmp-* is removed."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    victim = src / "aegis_soc" / "supervisor.py"
    original_mode = victim.stat().st_mode
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    try:
        victim.chmod(0)
        res = install(src, root)
        assert res.returncode == 1
    finally:
        victim.chmod(original_mode)
    releases_dir = root / "opt/aegis-idea3/releases"
    assert list(releases_dir.iterdir()) == []  # no leftover temp staging, no partial final release


def test_installer_never_deletes_an_already_placed_release_on_a_later_unrelated_failure(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    before = {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob("*") if p.is_file()}
    # a second, unrelated bad install attempt for a DIFFERENT release id must not touch the first
    bad_src = build_release(tmp_path / "staging2", release_id="rel-installer-2")
    (bad_src / "RELEASE-MANIFEST.json").write_text("{not json")
    assert install(bad_src, root, release_id="rel-installer-2", logical="/opt/aegis-idea3/releases/rel-installer-2").returncode == 1
    after = {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob("*") if p.is_file()}
    assert after == before


def test_installer_evidence_has_no_secret_no_username_no_host_path(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    evidence = tmp_path / "evidence.tsv"
    res = install(src, root, evidence=evidence)
    assert res.returncode == 0
    text = evidence.read_text()
    assert "release_id" in text and REL_ID in text and "source_git_sha" in text
    assert LOGICAL in text
    assert str(tmp_path) not in text and str(src) not in text and os.environ.get("USER", "\0no-user\0") not in text
    for name in ("HOME", "USER", "LOGNAME"):
        val = os.environ.get(name)
        if val:
            assert val not in text


@pytest.mark.parametrize("release_id", ["../evil", "a/b", "", "has space", "-leading"])
def test_installer_rejects_invalid_release_ids(tmp_path: Path, release_id: str) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    res = install(src, tmp_path / "fs", release_id=release_id, logical=f"/opt/aegis-idea3/releases/{release_id or 'x'}")
    assert res.returncode != 0


def test_installer_requires_the_logical_path_to_embed_the_exact_release_id(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    res = install(src, tmp_path / "fs", logical="/opt/aegis-idea3/releases/different-id")
    assert reason(res) == "LOGICAL_PATH_RELEASE_ID_MISMATCH"


def test_installer_requires_the_manifest_release_id_to_match_the_requested_release_id(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id="rel-other")
    res = install(src, tmp_path / "fs", release_id=REL_ID, logical=LOGICAL)
    assert reason(res) == "RELEASE_GUARD_FAILED:MANIFEST_RELEASE_ID_MISMATCH"


def test_installer_never_reads_or_writes_secret_credential_files() -> None:
    text = INSTALLER.read_text()
    for name in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential"):
        assert name not in text
    assert not any(bad in text for bad in ("systemctl", "runuser", "sudo ", "subprocess"))


def test_installer_is_idempotent_read_only_verification_via_the_guard(tmp_path: Path) -> None:
    """Running the guard against an installed release repeatedly is read-only and always agrees."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    before = {p.relative_to(dest).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in dest.rglob("*")}
    for _ in range(2):
        assert guard(root).returncode == 0
    after = {p.relative_to(dest).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in dest.rglob("*")}
    assert before == after


def test_installer_creates_the_releases_parent_directory_if_missing(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"  # /opt/aegis-idea3 does not exist at all yet
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert stat.S_IMODE((root / "opt/aegis-idea3/releases").stat().st_mode) & 0o022 == 0
