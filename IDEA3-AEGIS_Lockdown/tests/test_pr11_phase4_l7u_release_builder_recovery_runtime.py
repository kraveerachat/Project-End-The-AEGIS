"""AEGIS IDEA3 PR11 Phase 4 — the deterministic L7 release builder must ship the COMPLETE Recovery runtime that L7u requires.

Regression for the L7u live preflight failure NEW_RELEASE_LACKS_RECOVERY_RUNTIME: the builder used to compute the runtime closure of
`aegis_soc.supervisor` only. recovery_ui (the Recovery observer entrypoint, `python -m aegis_soc.recovery_ui`) and its recovery_client are
not imported by the Core, so a real build omitted them. The release now ships the union of the closures of its two entrypoints.
These tests build a REAL release from this repository's source (real builder, offline stub wheelhouse) — never a hand-made fixture.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7u_support as s
import test_pr11_phase4_l7_release_builder as b

REQUIRED = ("recovery_core.py", "recovery_protocol.py", "recovery_client.py", "recovery_ui.py")


@pytest.fixture(scope="module")
def tool():
    return b.load()


@pytest.fixture(scope="module")
def built(tool, tmp_path_factory):
    base = tmp_path_factory.mktemp("real")
    repo = b.make_repo(base)
    wheelhouse = b.make_wheelhouse(base / "wheelhouse")
    release = tool.build_release(repo, base / "staging", s.NEW_ID, wheelhouse)
    sha = b._git(repo, "rev-parse", "HEAD")
    return release, sha, repo


def _copy(built, tmp_path: Path) -> Path:
    dest = tmp_path / s.NEW_ID
    shutil.copytree(built[0], dest, symlinks=True)
    return dest


def test_real_release_contains_all_four_recovery_runtime_files(built) -> None:
    for name in REQUIRED:
        assert (built[0] / "aegis_soc" / name).is_file(), name


def test_manifest_and_checksums_cover_the_recovery_runtime(built) -> None:
    release = built[0]
    sums = (release / "RELEASE-SHA256SUMS").read_text().splitlines()
    for name in REQUIRED:
        digest = hashlib.sha256((release / "aegis_soc" / name).read_bytes()).hexdigest()
        assert f"{digest}  aegis_soc/{name}" in sums, name
    manifest = json.loads((release / "RELEASE-MANIFEST.json").read_text())
    covered = [line.split("  ", 1)[1] for line in sums]
    assert manifest["file_count"] == len([c for c in covered if c != "RELEASE-MANIFEST.json"])  # the manifest itself is checksummed, not counted
    assert all(f"aegis_soc/{n}" in covered for n in REQUIRED)


def test_canonical_verify_passes_and_package_is_exactly_the_entrypoint_closure(tool, built) -> None:
    info = tool.verify_release(built[0], expect_owner="self", release_id=s.NEW_ID)
    assert info["release_id"] == s.NEW_ID
    names = {p.stem for p in (built[0] / "aegis_soc").glob("*.py")}
    assert names == b.CLOSURE
    assert not names & b.NOT_RUNTIME, "unrelated modules must not be swept into the release"


def test_closure_is_the_union_of_exactly_the_supervisor_recovery_ui_and_f1_detector_entrypoints(tool) -> None:
    project = b.ROOT
    core, _ = tool.runtime_closure(project, "supervisor")
    observer, third = tool.runtime_closure(project, "recovery_ui")
    detector, detector_third = tool.runtime_closure(project, "production_detector")
    both, _ = tool.runtime_closure(project)
    assert tool.ENTRYPOINTS == ("supervisor", "recovery_ui", "production_detector")
    assert set(both) == set(core) | set(observer) | set(detector)
    assert {"alert_sink", "production_detector"} <= set(both) - set(core), "the Core never reaches the F1 alert source"
    assert detector_third == set(), "the F1 alert source adds no third-party dependency"
    assert {"recovery_client", "recovery_ui"} <= set(both) - set(core), "the Core alone never reaches the Recovery observer"
    assert observer == ["recovery_client", "recovery_protocol", "recovery_ui"] and third == set()


def test_offline_wheelhouse_behaviour_is_unchanged(tool) -> None:
    text = b.TOOL.read_text()
    assert "--no-index" in text and "--isolated" in text and "--only-binary=:all:" in text


@pytest.mark.parametrize("name", ["recovery_ui.py", "recovery_client.py"])
def test_a_source_tree_without_a_recovery_entrypoint_module_is_refused_by_the_builder(tool, tmp_path, name: str) -> None:
    repo = b.make_repo(tmp_path)
    (repo / "IDEA3-AEGIS_Lockdown/aegis_soc" / name).unlink()
    b._git(repo, "add", "-A")
    b._git(repo, "commit", "-q", "-m", "drop")
    wheelhouse = b.make_wheelhouse(tmp_path / "wheelhouse")
    msg = b.refuses(tool.build_release, repo, tmp_path / "s", "r1", wheelhouse)
    assert "ENTRYPOINT_MISSING" in msg or "UNRESOLVED_LOCAL_IMPORT" in msg


@pytest.mark.parametrize("name", REQUIRED)
def test_verify_refuses_a_release_missing_a_recovery_runtime_file(tool, built, tmp_path, name: str) -> None:
    rel = _copy(built, tmp_path)
    (rel / "aegis_soc" / name).unlink()
    b.resum(rel)
    manifest = json.loads((rel / "RELEASE-MANIFEST.json").read_text())
    manifest["file_count"] -= 1
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    b.resum(rel)
    assert b.refuses(tool.verify_release, rel, expect_owner="self")


def _preflight(tmp_path: Path, source: Path, sha: str):
    fx = s.build(tmp_path)
    cfg = dataclasses.replace(fx.cfg, source_dir=source, expected_main=sha)
    return fx, cfg


def test_l7u_engine_preflight_accepts_the_real_builder_output(built, tmp_path) -> None:
    fx, cfg = _preflight(tmp_path, built[0], built[1])
    plan = fx.engine.preflight(cfg, fx.host, fx.system)
    assert plan.group_created_by_attempt is True


@pytest.mark.parametrize("name", REQUIRED)
def test_l7u_engine_preflight_still_refuses_when_a_recovery_file_is_missing(built, tmp_path, name: str) -> None:
    src = _copy(built, tmp_path / "src")
    (src / "aegis_soc" / name).unlink()
    b.resum(src)
    manifest = json.loads((src / "RELEASE-MANIFEST.json").read_text())
    manifest["file_count"] -= 1
    (src / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    b.resum(src)
    fx, cfg = _preflight(tmp_path / "fx", src, built[1])
    with pytest.raises(fx.engine.Refusal) as exc:
        fx.engine.preflight(cfg, fx.host, fx.system)
    assert str(exc.value).startswith(("NEW_RELEASE_LACKS_RECOVERY_RUNTIME", "NEW_RELEASE_GUARD_FAILED"))
