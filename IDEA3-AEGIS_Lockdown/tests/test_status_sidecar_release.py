"""Status sidecar packaging: executable offline proof against REAL source (throwaway git repo, no network, no root, no /opt).

Proves two things together: (1) the governed Core release contract still EXCLUDES the status components and refuses every way of
adding them, so the exclusion is a tested fact and not an assumption; (2) the separate sidecar package ships exactly the
allowlisted status components, verifies strictly, runs from its own root, and carries no Core, MQTT, controller, restore or CUT code.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l7_release_builder as core_tests

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy" / "status-sidecar" / "build-status-sidecar.py"
RID = "status-sidecar-1"
FILES = (
    "aegis_soc/__init__.py", "aegis_soc/dispatch_client.py", "aegis_soc/observer.py", "aegis_soc/status_projection.py",
    "tools/status_projection_publisher.py", "tools/status_push_client.py",
)
STATUS_COMPONENTS = ("aegis_soc/observer.py", "aegis_soc/status_projection.py", "tools/status_projection_publisher.py",
                     "tools/status_push_client.py")


def load():
    spec = importlib.util.spec_from_file_location("build_status_sidecar", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_repo(base: Path) -> Path:
    repo = core_tests.make_repo(base)
    project = repo / "IDEA3-AEGIS_Lockdown"
    shutil.copytree(ROOT / "tools", project / "tools", ignore=shutil.ignore_patterns("__pycache__", "purple_ui_source"))
    core_tests._git(repo, "add", "-A")
    core_tests._git(repo, "commit", "-q", "-m", "tools")
    return repo


def resum(release: Path) -> None:
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(release).as_posix()}"
             for p in sorted(release.rglob("*")) if p.is_file() and p.name != "SIDECAR-SHA256SUMS"]
    (release / "SIDECAR-SHA256SUMS").write_text("\n".join(lines) + "\n")


@pytest.fixture(scope="module")
def tool():
    return load()


@pytest.fixture(scope="module")
def world(tool, tmp_path_factory):
    base = tmp_path_factory.mktemp("sidecar")
    repo = make_repo(base)
    core = core_tests.load()
    core_release = core.build_release(repo, base / "core-staging", "core-1", core_tests.make_wheelhouse(base / "wheelhouse"))
    sidecar = tool.build_sidecar(repo, base / "sidecar-staging", RID)
    return repo, core, core_release, sidecar


@pytest.fixture()
def sc(world, tmp_path) -> Path:
    dest = tmp_path / RID
    shutil.copytree(world[3], dest, symlinks=True)
    return dest


def refuses(fn, *a, **k) -> str:
    with pytest.raises(Exception) as e:
        fn(*a, **k)
    return str(e.value)


# ---- the Core release contract excludes the status components, and that exclusion is enforced ----
def test_the_governed_core_release_contains_none_of_the_status_components(world) -> None:
    core_release = world[2]
    assert not (core_release / "tools").exists()
    for rel in STATUS_COMPONENTS:
        assert not (core_release / rel).exists(), rel


def test_core_verify_refuses_a_tools_directory_added_to_a_core_release(world, tmp_path) -> None:
    core, core_release = world[1], world[2]
    dest = tmp_path / "core-1"
    shutil.copytree(core_release, dest, symlinks=True)
    (dest / "tools").mkdir()
    shutil.copyfile(ROOT / "tools/status_push_client.py", dest / "tools/status_push_client.py")
    core_tests.resum(dest)
    assert "UNEXPECTED_TOP_LEVEL" in refuses(core.verify_release, dest, expect_owner="self")


@pytest.mark.parametrize("name", ["observer.py", "status_projection.py"])
def test_core_verify_refuses_a_status_module_added_to_the_core_package(world, tmp_path, name: str) -> None:
    core, core_release = world[1], world[2]
    dest = tmp_path / "core-1"
    shutil.copytree(core_release, dest, symlinks=True)
    shutil.copyfile(ROOT / "aegis_soc" / name, dest / "aegis_soc" / name)
    manifest = json.loads((dest / "RELEASE-MANIFEST.json").read_text())
    manifest["file_count"] += 1
    (dest / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    core_tests.resum(dest)
    assert "PACKAGE_IS_NOT_THE_RUNTIME_CLOSURE" in refuses(core.verify_release, dest, expect_owner="self")


def test_the_core_entrypoints_and_closure_are_unchanged_by_the_sidecar_work(world) -> None:
    core = world[1]
    assert core.ENTRYPOINTS == ("supervisor", "recovery_ui", "production_detector", "cli")
    modules, third = core.runtime_closure(ROOT)
    assert not {"observer", "status_projection"} & set(modules) and third == {"paho"}
    # Computed from source, not the pinned core_tests.CLOSURE: that pin is already stale on main (local_cut), see the 38.6 finding.
    assert {p.stem for p in (world[2] / "aegis_soc").glob("*.py")} == {"__init__", *modules}


def test_the_core_release_guard_still_pins_its_layout() -> None:
    text = (ROOT / "deploy/pr11-phase4/p4-l7-release-guard.py").read_text()
    assert 'TOP_LEVEL = {"venv", "aegis_soc", "requirements.txt", MANIFEST, SUMS}' in text


# ---- the sidecar ----
def test_sidecar_contains_exactly_the_allowlist_manifest_and_checksums(world) -> None:
    sidecar = world[3]
    files = sorted(p.relative_to(sidecar).as_posix() for p in sidecar.rglob("*") if p.is_file())
    assert files == sorted([*FILES, "SIDECAR-MANIFEST.json", "SIDECAR-SHA256SUMS"])
    for rel in STATUS_COMPONENTS:
        assert (sidecar / rel).is_file(), rel


def test_sidecar_payload_is_byte_identical_to_the_reviewed_source(world) -> None:
    for rel in FILES:
        assert (world[3] / rel).read_bytes() == (world[0] / "IDEA3-AEGIS_Lockdown" / rel).read_bytes(), rel


def test_sidecar_manifest_has_exactly_the_allowed_fields_and_the_source_sha(tool, world) -> None:
    manifest = json.loads((world[3] / "SIDECAR-MANIFEST.json").read_text())
    assert tuple(manifest) == tool.MANIFEST_FIELDS
    assert manifest["kind"] == "aegis-idea3-status-sidecar" and manifest["source_tree_dirty"] is False
    assert manifest["source_git_sha"] == core_tests._git(world[0], "rev-parse", "HEAD")
    assert manifest["file_count"] == len(FILES)
    assert "home" not in json.dumps(manifest)


def test_sidecar_checksums_cover_every_payload_file(world) -> None:
    sums = (world[3] / "SIDECAR-SHA256SUMS").read_text().splitlines()
    assert [line.split("  ", 1)[1] for line in sums] == sorted([*FILES, "SIDECAR-MANIFEST.json"])
    for line in sums:
        digest, rel = line.split("  ", 1)
        assert hashlib.sha256((world[3] / rel).read_bytes()).hexdigest() == digest


def test_sidecar_verify_passes_and_has_no_symlink_pycache_credential_or_writable_bit(tool, world) -> None:
    info = tool.verify_sidecar(world[3], expect_owner="self", release_id=RID)
    assert info["file_count"] == len(FILES)
    for path in [world[3], *world[3].rglob("*")]:
        assert not path.is_symlink() and path.name != "__pycache__"
        assert not os.lstat(path).st_mode & 0o022


def test_sidecar_has_no_venv_requirements_or_third_party_dependency(world) -> None:
    assert not (world[3] / "venv").exists() and not (world[3] / "requirements.txt").exists()


def test_sidecar_runs_from_its_own_root_without_loading_any_core_module(world) -> None:
    code = ("import sys, aegis_soc.dispatch_client, aegis_soc.observer, aegis_soc.status_projection, "
            "tools.status_projection_publisher, tools.status_push_client;"
            "forbidden = ('aegis_soc.runtime','aegis_soc.controller','aegis_soc.mqtt_client','aegis_soc.local_restore',"
            "'aegis_soc.local_cut','aegis_soc.cut_client','aegis_soc.supervisor','paho');"
            "print(sorted(m for m in forbidden if m in sys.modules))")
    out = subprocess.run([sys.executable, "-E", "-s", "-B", "-c", code], cwd=world[3], capture_output=True, text=True,
                         env={"PATH": "/usr/bin:/bin"}, check=True)
    assert out.stdout.strip() == "[]"
    assert not list(world[3].rglob("__pycache__"))


def test_sidecar_publisher_publishes_from_the_built_package_not_the_checkout(world, tmp_path) -> None:
    status = tmp_path / "run" / "status.json"
    status.parent.mkdir(mode=0o700)
    status.write_text(json.dumps({
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False, "broker": "CONNECTED",
        "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY", "dispatch": "DISABLED", "time_trust": "SYNCED",
        "updated_at": time.time(), "components": {"core": "RUNNING"}}))
    status.chmod(0o600)
    dest = tmp_path / "out"
    dest.mkdir(mode=0o700)
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-m", "tools.status_projection_publisher", "--source", str(status),
                             "--dest-dir", str(dest), "--once"], cwd=world[3], capture_output=True, text=True,
                            env={"PATH": "/usr/bin:/bin"}, check=False)
    assert result.returncode == 0, result.stderr
    document = json.loads((dest / "status.projection.json").read_text())
    assert document["web_projection"]["evidenceSource"] == "RUNTIME_STATUS_FILE"
    assert "detail" not in json.dumps(document) and not list(world[3].rglob("__pycache__"))


def test_sidecar_pusher_is_disabled_by_default_and_never_touches_the_network(world) -> None:
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-m", "tools.status_push_client"], cwd=world[3],
                            capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"}, timeout=20, check=False)
    assert result.returncode == 0 and "status push is disabled" in result.stdout and "nothing was sent" in result.stdout


# ---- strict rejection ----
@pytest.mark.parametrize("rel", FILES)
def test_verify_refuses_a_missing_payload_file(tool, sc, rel: str) -> None:
    (sc / rel).unlink()
    assert "PAYLOAD_NOT_THE_ALLOWLIST" in refuses(tool.verify_sidecar, sc)


@pytest.mark.parametrize("rel", FILES)
def test_verify_refuses_an_altered_payload_file(tool, sc, rel: str) -> None:
    (sc / rel).write_text((sc / rel).read_text() + "\n# tampered\n")
    assert "CHECKSUM_MISMATCH" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_an_extra_file(tool, sc) -> None:
    (sc / "tools" / "extra.py").write_text("x = 1\n")
    resum(sc)
    assert "PAYLOAD_NOT_THE_ALLOWLIST" in refuses(tool.verify_sidecar, sc)


@pytest.mark.parametrize("name", ["controller.py", "local_restore.py", "local_cut.py", "cut_client.py", "mqtt_client.py", "runtime.py"])
def test_verify_refuses_any_core_module_added_to_the_sidecar(tool, sc, name: str) -> None:
    shutil.copyfile(ROOT / "aegis_soc" / name, sc / "aegis_soc" / name)
    resum(sc)
    assert "PAYLOAD_NOT_THE_ALLOWLIST" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_an_unexpected_top_level_entry(tool, sc) -> None:
    (sc / "venv").mkdir()
    assert "UNEXPECTED_TOP_LEVEL" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_a_symlink(tool, sc) -> None:
    (sc / "tools" / "link.py").symlink_to(sc / "tools" / "status_push_client.py")
    assert "SYMLINK_IN_PAYLOAD" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_credential_like_and_private_key_material(tool, sc) -> None:
    (sc / "tools" / "client.key").write_text("x")
    assert "CREDENTIAL_LIKE_FILE" in refuses(tool.verify_sidecar, sc)
    (sc / "tools" / "client.key").unlink()
    (sc / "tools" / "status_push_client.py").write_text("# -----BEGIN PRIVATE KEY-----\n")
    assert "PRIVATE_KEY_MATERIAL" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_a_world_writable_file_and_pycache(tool, sc) -> None:
    os.chmod(sc / "tools/status_push_client.py", 0o666)
    assert "GROUP_OR_WORLD_WRITABLE" in refuses(tool.verify_sidecar, sc)
    os.chmod(sc / "tools/status_push_client.py", 0o644)
    (sc / "tools" / "__pycache__").mkdir()
    assert "FORBIDDEN_DIRECTORY" in refuses(tool.verify_sidecar, sc)


@pytest.mark.parametrize("field,value,reason", [
    ("kind", "aegis-idea3-core-release", "MANIFEST_KIND_INVALID"),
    ("release_id", "other", "MANIFEST_RELEASE_ID_MISMATCH"),
    ("source_git_sha", "zz", "MANIFEST_SOURCE_SHA_MALFORMED"),
    ("file_count", 99, "MANIFEST_FILE_COUNT_MISMATCH"),
    ("schema_version", 2, "MANIFEST_SCHEMA_VERSION_UNSUPPORTED"),
])
def test_verify_refuses_a_tampered_manifest(tool, sc, field, value, reason) -> None:
    manifest = json.loads((sc / "SIDECAR-MANIFEST.json").read_text())
    manifest[field] = value
    (sc / "SIDECAR-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    resum(sc)
    assert reason in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_an_extra_manifest_field(tool, sc) -> None:
    manifest = json.loads((sc / "SIDECAR-MANIFEST.json").read_text())
    manifest["hostname"] = "x"
    (sc / "SIDECAR-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    resum(sc)
    assert "MANIFEST_FIELDS_INVALID" in refuses(tool.verify_sidecar, sc)


def test_verify_refuses_an_import_outside_the_allowlist_even_with_matching_checksums(tool, sc) -> None:
    path = sc / "tools" / "status_push_client.py"
    path.write_text(path.read_text() + "\nimport subprocess\n")
    resum(sc)
    assert "SIDECAR_FORBIDDEN_STDLIB_IMPORT" in refuses(tool.verify_sidecar, sc)
    path.write_text(path.read_text().replace("import subprocess\n", "from aegis_soc import runtime\n"))
    resum(sc)
    assert "SIDECAR_IMPORT_OUTSIDE_ALLOWLIST" in refuses(tool.verify_sidecar, sc)


def test_the_two_verifiers_refuse_each_others_layouts(tool, world) -> None:
    core = world[1]
    assert refuses(tool.verify_sidecar, world[2])
    assert refuses(core.verify_release, world[3])


def test_build_refuses_a_dirty_tree_unless_explicitly_allowed(tool, tmp_path) -> None:
    repo = make_repo(tmp_path)
    (repo / "IDEA3-AEGIS_Lockdown/tools/status_push_client.py").write_text("x = 1\n")
    assert "SOURCE_TREE_DIRTY" in refuses(tool.build_sidecar, repo, tmp_path / "s", "r1")


def test_build_refuses_a_missing_allowlisted_source_file(tool, tmp_path) -> None:
    repo = make_repo(tmp_path)
    (repo / "IDEA3-AEGIS_Lockdown/aegis_soc/status_projection.py").unlink()
    core_tests._git(repo, "add", "-A")
    core_tests._git(repo, "commit", "-q", "-m", "drop")
    assert "SOURCE_FILE_MISSING_OR_SYMLINK" in refuses(tool.build_sidecar, repo, tmp_path / "s", "r1")


def test_build_refuses_a_system_location_and_an_existing_destination(tool, world, tmp_path) -> None:
    assert "STAGING_IN_SYSTEM_LOCATION" in refuses(tool.build_sidecar, world[0], "/opt/aegis-idea3-status/releases", "r1")
    assert "DESTINATION_EXISTS" in refuses(tool.build_sidecar, world[0], world[3].parent, RID)


def test_the_builder_never_references_sudo_or_system_mutation() -> None:
    text = TOOL.read_text()
    for word in ("sudo", "systemctl", "chown", "/etc/", "nftables"):
        assert f'"{word}' not in text and f"'{word}" not in text
