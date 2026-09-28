"""PR11 Phase 4 L7 — immutable release guard helper (deploy/pr11-phase4/p4-l7-release-guard.py).

Read-only. Proves an installed release exists, is not a symlink, holds no symlink/special file, is not group/other-writable, has
the expected owner, has the exact top-level layout, an executable venv python, the supervisor entrypoint, and PROVENANCE: a manifest
(release id, 40-hex source sha, clean tree) and a sorted SHA-256 sums file that matches every payload file exactly.
The layout is the one produced by the deterministic release builder (PR #208): venv/, aegis_soc/, requirements.txt,
RELEASE-MANIFEST.json, RELEASE-SHA256SUMS.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "deploy" / "pr11-phase4" / "p4-l7-release-guard.py"
LOGICAL = "/opt/aegis-idea3/releases/rel-20260927"
SHA = "a" * 40


def build_release(base: Path, *, release_id: str = "rel-20260927", dirty: bool = False, sha: str = SHA) -> Path:
    rel = base / release_id
    (rel / "venv/bin").mkdir(parents=True)
    (rel / "aegis_soc").mkdir()
    (rel / "venv/bin/python").write_text("#!/bin/sh\n")
    (rel / "venv/bin/python").chmod(0o755)
    (rel / "aegis_soc/supervisor.py").write_text("print('x')\n")
    (rel / "aegis_soc/__init__.py").write_text("")
    (rel / "requirements.txt").write_text("paho-mqtt==2.1.0\n")
    payload = sorted(p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file())
    manifest = {"schema_version": 1, "release_id": release_id, "source_git_sha": sha, "source_tree_dirty": dirty,
                "python_version": "3.13.1", "requirements_sha256": hashlib.sha256(b"paho-mqtt==2.1.0\n").hexdigest(),
                "file_count": len(payload), "created_by_tool_version": "1"}
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = [f"{hashlib.sha256((rel / p).read_bytes()).hexdigest()}  {p}"
             for p in sorted(p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file() and p.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")
    for p in [rel, *rel.rglob("*")]:
        if not p.is_symlink():
            p.chmod(0o755 if (p.is_dir() or os.access(p, os.X_OK)) else 0o644)
    return rel


def guard(rel: Path, *, logical: str = LOGICAL, owner: str = "any") -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(GUARD), "check", "--logical-path", logical, "--host-path", str(rel), "--expect-owner", owner],
                          text=True, capture_output=True, check=False)


def reason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_RELEASE_GUARD=FAIL reason=(\S+)", res.stdout + res.stderr)
    return m.group(1) if m else ""


def test_guard_tool_exists() -> None:
    assert GUARD.is_file()


def test_guard_accepts_a_complete_release_and_reports_provenance(tmp_path: Path) -> None:
    res = guard(build_release(tmp_path))
    assert res.returncode == 0, res.stdout + res.stderr
    assert f"L7_RELEASE_GUARD=PASS release_id=rel-20260927 source_git_sha={SHA}" in res.stdout


@pytest.mark.parametrize("logical", ["/opt/aegis-idea3/releases/../x", "/opt/aegis-idea3/current", "/tmp/rel-20260927",
                                     "/opt/aegis-idea3/releases/a/b", "/opt/aegis-idea3/releases/", "/opt/aegis-idea3/releases/-x",
                                     "/opt/aegis-idea3/releases/rel 1"])
def test_guard_rejects_a_bad_logical_release_path(tmp_path: Path, logical: str) -> None:
    res = guard(build_release(tmp_path), logical=logical)
    assert res.returncode == 1 and reason(res) == "LOGICAL_PATH_INVALID"


def test_guard_rejects_missing_release(tmp_path: Path) -> None:
    assert reason(guard(tmp_path / "nope")) == "RELEASE_MISSING"


def test_guard_rejects_a_symlinked_release_directory(tmp_path: Path) -> None:
    real = build_release(tmp_path / "real")
    link = tmp_path / "link"
    link.symlink_to(real)
    assert reason(guard(link)) == "RELEASE_IS_SYMLINK"


def test_guard_rejects_any_symlink_inside_the_release(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/evil").symlink_to("/etc/passwd")
    assert reason(guard(rel)) == "SYMLINK_IN_RELEASE"


def test_guard_rejects_special_files(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    os.mkfifo(rel / "aegis_soc/pipe")
    assert reason(guard(rel)) == "SPECIAL_FILE_IN_RELEASE"


@pytest.mark.parametrize("mode", [0o775, 0o757, 0o777])
def test_guard_rejects_group_or_other_writable_paths(tmp_path: Path, mode: int) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/supervisor.py").chmod(mode)
    assert reason(guard(rel)) == "WRITABLE_BY_GROUP_OR_OTHER"


def test_guard_rejects_a_writable_release_directory(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    rel.chmod(0o777)
    assert reason(guard(rel)) == "WRITABLE_BY_GROUP_OR_OTHER"


def test_guard_owner_root_is_enforced(tmp_path: Path) -> None:
    rel = build_release(tmp_path)  # owned by the test user, not root
    if os.geteuid() == 0:
        pytest.skip("running as root")
    assert reason(guard(rel, owner="root")) == "OWNER_INVALID"


@pytest.mark.parametrize("missing,code", [("venv/bin/python", "VENV_PYTHON_MISSING_OR_NOT_EXECUTABLE"),
                                          ("aegis_soc/supervisor.py", "SUPERVISOR_MISSING"),
                                          ("requirements.txt", "REQUIRED_FILE_MISSING"),
                                          ("RELEASE-MANIFEST.json", "REQUIRED_FILE_MISSING"),
                                          ("RELEASE-SHA256SUMS", "REQUIRED_FILE_MISSING")])
def test_guard_rejects_missing_required_files(tmp_path: Path, missing: str, code: str) -> None:
    rel = build_release(tmp_path)
    (rel / missing).unlink()
    assert reason(guard(rel)) == code


def test_guard_rejects_a_non_executable_python(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "venv/bin/python").chmod(0o644)
    assert reason(guard(rel)) == "VENV_PYTHON_MISSING_OR_NOT_EXECUTABLE"


def test_guard_rejects_unexpected_top_level_entries(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / ".git").mkdir()
    assert reason(guard(rel)) == "TOP_LEVEL_ENTRIES_INVALID"


def test_guard_rejects_a_modified_payload_file(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/supervisor.py").write_text("print('tampered')\n")
    assert reason(guard(rel)) == "CHECKSUM_MISMATCH"


def test_guard_rejects_an_unlisted_extra_file(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/extra.py").write_text("x=1\n")
    assert reason(guard(rel)) == "CHECKSUM_ENTRY_MISSING"


def test_guard_rejects_a_listed_but_absent_file(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/__init__.py").unlink()
    assert reason(guard(rel)) == "CHECKSUM_ENTRY_EXTRA"


@pytest.mark.parametrize("line", ["not a checksum line", "ABCD  aegis_soc/x.py", f"{'a'*64} /abs/path", f"{'a'*64}  ../up"])
def test_guard_rejects_malformed_checksum_lines(tmp_path: Path, line: str) -> None:
    rel = build_release(tmp_path)
    with (rel / "RELEASE-SHA256SUMS").open("a") as fh:
        fh.write(line + "\n")
    assert reason(guard(rel)) in {"CHECKSUM_LINE_MALFORMED", "CHECKSUM_PATH_INVALID"}


def rewrite_manifest(rel: Path, **changes) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text())
    m.update(changes)
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m))
    # keep the sums file consistent so ONLY the manifest rule is exercised
    lines = [f"{hashlib.sha256((rel / p).read_bytes()).hexdigest()}  {p}"
             for p in sorted(q.relative_to(rel).as_posix() for q in rel.rglob("*") if q.is_file() and q.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")


@pytest.mark.parametrize("changes,code", [({"release_id": "other"}, "MANIFEST_RELEASE_ID_MISMATCH"),
                                          ({"source_git_sha": "xyz"}, "MANIFEST_SOURCE_SHA_MALFORMED"),
                                          ({"source_git_sha": "A" * 40}, "MANIFEST_SOURCE_SHA_MALFORMED"),
                                          ({"source_tree_dirty": True}, "MANIFEST_SOURCE_TREE_DIRTY"),
                                          ({"schema_version": 2}, "MANIFEST_SCHEMA_VERSION_UNSUPPORTED"),
                                          ({"file_count": 99}, "MANIFEST_FILE_COUNT_MISMATCH"),
                                          ({"extra_field": 1}, "MANIFEST_FIELDS_INVALID")])
def test_guard_enforces_manifest_provenance(tmp_path: Path, changes: dict, code: str) -> None:
    rel = build_release(tmp_path)
    rewrite_manifest(rel, **changes)
    assert reason(guard(rel)) == code


def test_guard_rejects_malformed_manifest(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "RELEASE-MANIFEST.json").write_text("{not json")
    assert reason(guard(rel)) in {"MANIFEST_MALFORMED", "CHECKSUM_MISMATCH"}


def test_guard_is_read_only(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    before = {p.relative_to(rel).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in rel.rglob("*")}
    guard(rel)
    after = {p.relative_to(rel).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in rel.rglob("*")}
    assert before == after
    text = GUARD.read_text()
    for banned in ("subprocess", "os.system", "shutil.rmtree", "os.remove", ".unlink(", "chmod(", "chown(", ".write_text(", "open(" + repr("w")):
        assert banned not in text, banned


def test_guard_output_never_contains_file_contents(tmp_path: Path) -> None:
    rel = build_release(tmp_path)
    (rel / "aegis_soc/supervisor.py").write_text("SECRET-PAYLOAD-CANARY\n")
    res = guard(rel)
    assert "SECRET-PAYLOAD-CANARY" not in res.stdout + res.stderr
