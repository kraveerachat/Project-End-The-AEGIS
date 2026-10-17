"""Status sidecar installer: offline proof on disposable filesystem roots (no /opt, no root, no systemd, no network).

Ownership is never weakened to make tests pass: the default (root-owned) contract is asserted to REFUSE a user-owned fixture, and the
fixture override is asserted to be unusable without a fixture host root.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_status_sidecar_release as rel_tests

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy" / "status-sidecar" / "install-status-sidecar.py"
RID1, RID2 = "sidecar-1", "sidecar-2"


def load():
    spec = importlib.util.spec_from_file_location("install_status_sidecar", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def inst():
    return load()


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    base = tmp_path_factory.mktemp("installer")
    repo = rel_tests.make_repo(base)
    builder = rel_tests.load()
    return {rid: builder.build_sidecar(repo, base / "staging", rid) for rid in (RID1, RID2)}


@pytest.fixture()
def host(tmp_path):
    """A disposable host root holding a fake Core release tree and Recovery state that must never change."""
    root = tmp_path / "host"
    root.mkdir()
    (root / ".aegis-sidecar-fixture-root").write_text("disposable fixture root\n")
    core = root / "opt" / "aegis-idea3"
    (core / "releases" / "core-1" / "venv" / "bin").mkdir(parents=True)
    (core / "releases" / "core-1" / "venv" / "bin" / "python").write_text("#!/bin/sh\n")
    (core / "releases" / "core-1" / "aegis_soc").mkdir()
    (core / "releases" / "core-1" / "aegis_soc" / "supervisor.py").write_text("# core\n")
    (core / "current").symlink_to("releases/core-1")
    (core / "recovery").mkdir()
    (core / "recovery" / "state.json").write_text("{}")
    for path in [root, root / "opt", core, *core.rglob("*")]:
        if path == root / ".aegis-sidecar-fixture-root":
            continue
        if not path.is_symlink():
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
    return root


def snapshot(base: Path) -> dict:
    out = {}
    for path in sorted([base, *base.rglob("*")]):
        info = path.lstat()
        entry = [stat.S_IMODE(info.st_mode), info.st_mtime_ns]
        if path.is_symlink():
            entry.append(os.readlink(path))
        elif path.is_file():
            entry.append(hashlib.sha256(path.read_bytes()).hexdigest())
        out[path.relative_to(base.parent).as_posix()] = entry
    return out


def layout(inst, host):
    return inst.Layout(str(host), True)


def sidecar_root(host: Path) -> Path:
    return host / "opt" / "aegis-idea3-status"


def refuses(fn, *a, **k) -> str:
    with pytest.raises(Exception) as e:
        fn(*a, **k)
    assert type(e.value).__name__ == "Refusal", e.value
    return str(e.value)


def fresh_copy(built, rid, tmp_path, name="src"):
    dest = tmp_path / name / rid
    shutil.copytree(built[rid], dest, symlinks=True)
    return dest


PY = sys.executable


# ---- first install, activation, preservation ----
def test_first_install_and_activate_create_only_the_sidecar_tree(inst, built, host) -> None:
    core_before = snapshot(host / "opt" / "aegis-idea3")
    lay = layout(inst, host)
    result = inst.install(lay, RID1, built[RID1], PY, False)
    assert result["release_id"] == RID1
    inst.activate(lay, RID1, PY, False)
    root = sidecar_root(host)
    assert sorted(p.name for p in root.iterdir()) == ["current", "releases"]
    assert os.readlink(root / "current") == f"releases/{RID1}"
    assert snapshot(host / "opt" / "aegis-idea3") == core_before
    assert sorted(p.name for p in host.iterdir()) == [".aegis-sidecar-fixture-root", "opt"] and sorted(p.name for p in (host / "opt").iterdir()) == ["aegis-idea3", "aegis-idea3-status"]
    for path in [root, *root.rglob("*")]:
        if not path.is_symlink():
            assert not path.lstat().st_mode & 0o022, path
    assert [p for p in (root / "releases").rglob("*") if p.is_symlink()] == []
    assert not list(root.rglob("__pycache__"))


def test_installed_release_is_byte_identical_to_the_verified_source(inst, built, host) -> None:
    inst.install(layout(inst, host), RID1, built[RID1], PY, False)
    installed = sidecar_root(host) / "releases" / RID1
    for path in built[RID1].rglob("*"):
        if path.is_file():
            assert (installed / path.relative_to(built[RID1])).read_bytes() == path.read_bytes()
    assert inst._builder.verify_sidecar(installed, expect_owner="any", release_id=RID1)["release_id"] == RID1


def test_a_second_release_preserves_the_first_and_records_previous(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.activate(lay, RID1, PY, False)
    first = snapshot(sidecar_root(host) / "releases" / RID1)
    inst.install(lay, RID2, built[RID2], PY, False)
    result = inst.activate(lay, RID2, PY, False)
    assert result["previous"] == RID1
    root = sidecar_root(host)
    assert os.readlink(root / "current") == f"releases/{RID2}" and os.readlink(root / "previous") == f"releases/{RID1}"
    assert {k: v for k, v in snapshot(root / "releases" / RID1).items()} == first


def test_install_alone_never_switches_current(inst, built, host) -> None:
    inst.install(layout(inst, host), RID1, built[RID1], PY, False)
    assert not (sidecar_root(host) / "current").exists() and not (sidecar_root(host) / "current").is_symlink()


# ---- refusals ----
def test_an_existing_release_id_is_never_overwritten(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    before = snapshot(sidecar_root(host))
    assert "RELEASE_ALREADY_INSTALLED" in refuses(inst.install, lay, RID1, built[RID1], PY, False)
    assert snapshot(sidecar_root(host)) == before


@pytest.mark.parametrize("mutate,reason", [
    (lambda r: (r / "tools/status_push_client.py").write_text("x = 1\n"), "CHECKSUM_MISMATCH"),
    (lambda r: (r / "tools/extra.py").write_text("x = 1\n"), "PAYLOAD_NOT_THE_ALLOWLIST"),
    (lambda r: (r / "aegis_soc/controller.py").write_text("x = 1\n"), "PAYLOAD_NOT_THE_ALLOWLIST"),
    (lambda r: (r / "tools/link.py").symlink_to(r / "tools/status_push_client.py"), "SYMLINK_IN_PAYLOAD"),
    (lambda r: (r / "tools/client.key").write_text("k"), "CREDENTIAL_LIKE_FILE"),
])
def test_an_altered_source_is_refused_before_anything_is_created(inst, built, host, tmp_path, mutate, reason) -> None:
    src = fresh_copy(built, RID1, tmp_path)
    mutate(src)
    before = snapshot(host)
    assert reason in refuses(inst.install, layout(inst, host), RID1, src, PY, False)
    assert snapshot(host) == before and not sidecar_root(host).exists()


def test_a_source_whose_manifest_names_another_release_is_refused(inst, built, host) -> None:
    assert "MANIFEST_RELEASE_ID_MISMATCH" in refuses(inst.install, layout(inst, host), "other-id", built[RID1], PY, False)


@pytest.mark.parametrize("bad", ["../x", "a/b", ".hidden", "", "x" * 200, "a b", "-x"])
def test_release_ids_cannot_traverse_or_hide(inst, built, host, bad) -> None:
    lay = layout(inst, host)
    assert "RELEASE_ID_INVALID" in refuses(inst.install, lay, bad, built[RID1], PY, False)
    assert "RELEASE_ID_INVALID" in refuses(inst.activate, lay, bad, PY, False)


@pytest.mark.skipif(os.geteuid() == 0, reason="the default ownership contract can only be shown to refuse as a non-root user")
def test_the_default_ownership_contract_refuses_a_user_owned_install(inst, built, host) -> None:
    lay = inst.Layout(str(host), False)
    assert lay.owner == "root"
    reason = refuses(inst.install, lay, RID1, built[RID1], PY, False)
    assert "OWNER_MISMATCH" in reason or "NOT_ROOT_OWNED" in reason
    assert not (sidecar_root(host) / "releases" / RID1).exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="live mode behaves differently for root")
def test_live_mode_without_root_is_refused_and_the_fixture_override_needs_a_host_root(inst) -> None:
    assert "LIVE_INSTALL_REQUIRES_ROOT" in refuses(inst.Layout, "", False)
    assert "FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT" in refuses(inst.Layout, "", True)
    assert "FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT" in refuses(inst.Layout, "", False, True)
    assert "HOST_ROOT_MUST_BE_ABSOLUTE" in refuses(inst.Layout, "relative/dir", True)


def test_the_real_opt_paths_are_never_used_by_the_tests(inst, host) -> None:
    lay = layout(inst, host)
    assert str(lay.root).startswith(str(host)) and str(lay.releases).startswith(str(host))
    assert not Path("/opt/aegis-idea3-status").exists()


def test_a_symlinked_or_writable_destination_ancestor_is_refused(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    sidecar_root(host).symlink_to(elsewhere)
    assert "DESTINATION_PARENT_IS_SYMLINK" in refuses(inst.install, lay, RID1, built[RID1], PY, False)
    assert list(elsewhere.iterdir()) == []
    sidecar_root(host).unlink()
    sidecar_root(host).mkdir()
    os.chmod(sidecar_root(host), 0o777)
    assert "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER" in refuses(inst.install, lay, RID1, built[RID1], PY, False)
    os.chmod(sidecar_root(host), 0o755)
    (sidecar_root(host) / "releases").mkdir()
    os.chmod(sidecar_root(host) / "releases", 0o777)
    assert "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER" in refuses(inst.install, lay, RID1, built[RID1], PY, False)


def test_a_missing_opt_ancestor_is_not_created(inst, built, tmp_path) -> None:
    empty = tmp_path / "empty-host"
    empty.mkdir()
    (empty / ".aegis-sidecar-fixture-root").write_text("x\n")
    assert "DESTINATION_ANCESTOR_MISSING" in refuses(inst.install, inst.Layout(str(empty), True), RID1, built[RID1], PY, False)
    assert [p.name for p in empty.iterdir()] == [".aegis-sidecar-fixture-root"]


def test_the_sidecar_root_cannot_alias_the_core_tree(inst, host, monkeypatch) -> None:
    monkeypatch.setattr(inst, "LOGICAL_ROOT", "/opt/aegis-idea3/status")
    assert "SIDECAR_ROOT_ALIASES_CORE" in refuses(inst.Layout, str(host), True)


# ---- failure, interruption ----
def test_a_failed_installation_leaves_no_partial_release_and_no_staging(inst, built, host, monkeypatch) -> None:
    lay = layout(inst, host)
    real = inst._verify
    calls = []

    def flaky(path, owner, release_id=None):
        calls.append(str(path))
        if Path(path).name.startswith(inst.STAGE_PREFIX):
            inst.refuse("VERIFY_FAILED:INJECTED")
        return real(path, owner, release_id)

    monkeypatch.setattr(inst, "_verify", flaky)
    assert "INJECTED" in refuses(inst.install, lay, RID1, built[RID1], PY, False)
    assert sorted(p.name for p in (sidecar_root(host) / "releases").iterdir()) == []
    monkeypatch.setattr(inst, "_verify", real)
    inst.install(lay, RID1, built[RID1], PY, False)
    assert (sidecar_root(host) / "releases" / RID1).is_dir()


def test_interrupted_staging_is_reported_never_selected_and_does_not_block_a_new_install(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    leftover = sidecar_root(host) / "releases" / ".install-tmp-sidecar-9-abc123"
    leftover.mkdir()
    (leftover / "partial.py").write_text("x")
    assert inst.status(lay)["leftover_staging"] == [leftover.name] and inst.status(lay)["releases"] == [RID1]
    assert inst.plan(lay, RID2, built[RID2], PY, False)["leftover_staging"] == [leftover.name]
    assert "RELEASE_ID_INVALID" in refuses(inst.activate, lay, leftover.name, PY, False)
    inst.install(lay, RID2, built[RID2], PY, False)
    assert leftover.is_dir()  # never silently deleted


def test_plan_and_status_are_read_only(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    before = snapshot(host)
    inst.plan(lay, RID2, built[RID2], PY, False)
    inst.status(lay)
    assert snapshot(host) == before


# ---- activation / rollback ----
def test_activating_a_tampered_installed_release_is_refused_and_current_is_unchanged(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.install(lay, RID2, built[RID2], PY, False)
    inst.activate(lay, RID1, PY, False)
    target = sidecar_root(host) / "releases" / RID2 / "tools" / "status_push_client.py"
    os.chmod(target, 0o644)
    target.write_text(target.read_text() + "\n# tampered\n")
    assert "CHECKSUM_MISMATCH" in refuses(inst.activate, lay, RID2, PY, False)
    assert os.readlink(sidecar_root(host) / "current") == f"releases/{RID1}"


def test_activation_refusals(inst, built, host) -> None:
    lay = layout(inst, host)
    assert "RELEASE_NOT_INSTALLED" in refuses(inst.activate, lay, RID1, PY, False)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.activate(lay, RID1, PY, False)
    assert "ALREADY_CURRENT" in refuses(inst.activate, lay, RID1, PY, False)


def test_current_must_be_a_relative_symlink_into_releases(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.install(lay, RID2, built[RID2], PY, False)
    current = sidecar_root(host) / "current"
    current.mkdir()
    assert "CURRENT_NOT_A_SYMLINK" in refuses(inst.activate, lay, RID1, PY, False)
    current.rmdir()
    current.symlink_to(str(sidecar_root(host) / "releases" / RID1))
    assert "CURRENT_TARGET_UNEXPECTED" in refuses(inst.activate, lay, RID2, PY, False)
    current.unlink()
    current.symlink_to("releases/../../../etc")
    assert "CURRENT_TARGET_UNEXPECTED" in refuses(inst.activate, lay, RID2, PY, False)


def test_rollback_returns_to_the_previous_verified_release_and_deletes_nothing(inst, built, host) -> None:
    lay = layout(inst, host)
    core_before = snapshot(host / "opt" / "aegis-idea3")
    for rid in (RID1, RID2):
        inst.install(lay, rid, built[rid], PY, False)
        inst.activate(lay, rid, PY, False)
    result = inst.rollback(lay, PY, False)
    root = sidecar_root(host)
    assert result == {"release_id": RID1, "previous": RID2}
    assert os.readlink(root / "current") == f"releases/{RID1}" and os.readlink(root / "previous") == f"releases/{RID2}"
    assert sorted(p.name for p in (root / "releases").iterdir()) == [RID1, RID2]
    assert snapshot(host / "opt" / "aegis-idea3") == core_before
    assert inst.rollback(lay, PY, False)["release_id"] == RID2  # and forward again


def test_rollback_never_selects_unverified_content(inst, built, host) -> None:
    lay = layout(inst, host)
    for rid in (RID1, RID2):
        inst.install(lay, rid, built[rid], PY, False)
        inst.activate(lay, rid, PY, False)
    victim = sidecar_root(host) / "releases" / RID1 / "aegis_soc" / "observer.py"
    os.chmod(victim, 0o644)
    victim.write_text("# replaced\n")
    assert "CHECKSUM_MISMATCH" in refuses(inst.rollback, lay, PY, False)
    assert os.readlink(sidecar_root(host) / "current") == f"releases/{RID2}"


def test_rollback_refusals(inst, built, host) -> None:
    lay = layout(inst, host)
    assert "NO_CURRENT_RELEASE" in refuses(inst.rollback, lay, PY, False)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.activate(lay, RID1, PY, False)
    assert "NO_PREVIOUS_RELEASE" in refuses(inst.rollback, lay, PY, False)
    assert "ROLLBACK_TARGET_IS_CURRENT" in refuses(inst.rollback, lay, PY, False, RID1)
    assert "ROLLBACK_TARGET_NOT_INSTALLED" in refuses(inst.rollback, lay, PY, False, "ghost")


def test_a_corrupt_current_release_is_never_recorded_as_previous(inst, built, host) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.install(lay, RID2, built[RID2], PY, False)
    inst.activate(lay, RID1, PY, False)
    victim = sidecar_root(host) / "releases" / RID1 / "tools" / "status_projection_publisher.py"
    os.chmod(victim, 0o644)
    victim.write_text("x = 1\n")
    assert "CHECKSUM_MISMATCH" in refuses(inst.activate, lay, RID2, PY, False)
    assert not (sidecar_root(host) / "previous").exists()


# ---- Python runtime ----
def fake_python(tmp_path: Path, line: str, code: int = 0) -> str:
    script = tmp_path / f"py-{abs(hash(line))}"
    script.write_text(f"#!/bin/sh\necho '{line}'\nexit {code}\n")
    script.chmod(0o755)
    return str(script)


@pytest.mark.parametrize("line,reason", [
    ("3 10 9 CPython posix", "PYTHON_RUNTIME_TOO_OLD"),
    ("3 11 0 CPython posix", "PYTHON_RUNTIME_UNTESTED_MINOR"),
    ("3 99 0 CPython posix", "PYTHON_RUNTIME_UNTESTED_MINOR"),
    ("3 14 7 PyPy posix", "PYTHON_RUNTIME_UNSUPPORTED_PLATFORM"),
    ("3 14 7 CPython nt", "PYTHON_RUNTIME_UNSUPPORTED_PLATFORM"),
    ("garbage", "PYTHON_RUNTIME_UNUSABLE"),
])
def test_an_incompatible_python_runtime_is_refused_before_any_write(inst, built, host, tmp_path, line, reason) -> None:
    before = snapshot(host)
    if reason == "PYTHON_RUNTIME_UNTESTED_MINOR":
        tested = tuple(int(x) for x in sys.version.split()[0].split(".")[:2])
        if tuple(int(x) for x in line.split()[:2]) == tested:
            pytest.skip("host interpreter equals the fake minor")
    assert reason in refuses(inst.install, layout(inst, host), RID1, built[RID1], fake_python(tmp_path, line), False)
    assert snapshot(host) == before


def test_python_runtime_failures_and_missing_interpreters_are_refused(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    assert "PYTHON_RUNTIME_UNUSABLE" in refuses(inst.install, lay, RID1, built[RID1], fake_python(tmp_path, "3 14 7 CPython posix", 1), False)
    assert "PYTHON_RUNTIME_UNUSABLE" in refuses(inst.install, lay, RID1, built[RID1], str(tmp_path / "missing"), False)


def test_an_untested_minor_is_accepted_only_when_the_owner_says_so(inst, built, host, tmp_path) -> None:
    major, minor, _ = (int(x) for x in sys.version.split()[0].split(".")[:3])
    other = f"{major} {minor + 1} 0 CPython posix"
    lay = layout(inst, host)
    assert "UNTESTED_MINOR" in refuses(inst.install, lay, RID1, built[RID1], fake_python(tmp_path, other), False)
    assert inst.install(lay, RID1, built[RID1], fake_python(tmp_path, other), True)["release_id"] == RID1
    assert "TOO_OLD" in refuses(inst.install, lay, RID2, built[RID2], fake_python(tmp_path, "3 10 0 CPython posix"), True)


def test_activation_rechecks_the_runtime(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    assert "PYTHON_RUNTIME_INCOMPATIBLE" in refuses(inst.activate, lay, RID1, fake_python(tmp_path, "3 10 0 CPython posix"), False)
    assert not (sidecar_root(host) / "current").is_symlink()


def test_the_manifest_does_not_claim_more_portability_than_was_tested(inst, built) -> None:
    import json

    manifest = json.loads((built[RID1] / "SIDECAR-MANIFEST.json").read_text())
    assert manifest["python_requires_min"] == "3.11" and manifest["python_version"].startswith(sys.version.split()[0].rsplit(".", 1)[0])
    assert set(manifest) == set(inst._builder.MANIFEST_FIELDS)
    for forbidden in ("architecture", "platform", "portable"):
        assert forbidden not in manifest


# ---- scope of the tool itself ----
def test_the_installer_has_no_privileged_or_service_actions() -> None:
    text = TOOL.read_text()
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("#", '"""')))
    for word in ("sudo", "systemctl", "chown", "daemon-reload", "docker", "mosquitto", "paho", "nftables", "iptables"):
        assert word not in code.replace(__doc__ or "", ""), word
    assert "import subprocess" not in text and "os.system" not in text
    assert text.count("/opt/aegis-idea3") == text.count("/opt/aegis-idea3-status") + text.count('CORE_ROOT = "/opt/aegis-idea3"') + text.count("`/opt/aegis-idea3`")


def test_the_cli_reports_no_systemd_action_and_no_core_touch(inst, built, host, capsys) -> None:
    rc = inst.main(["--host-root", str(host), "--fixture-dest-owner-any", "--python", PY, "install", "--release-id", RID1, "--source", str(built[RID1])])
    out = capsys.readouterr().out
    assert rc == 0 and "STATUS_SIDECAR_INSTALL=PASS" in out and "SYSTEMD_ACTION=NONE" in out and "CORE_TOUCHED=NO" in out
    rc = inst.main(["--host-root", str(host), "--fixture-dest-owner-any", "--python", PY, "install", "--release-id", RID1, "--source", str(built[RID1])])
    assert rc == 1 and "RELEASE_ALREADY_INSTALLED" in capsys.readouterr().out


# ---- STEP 38.8: fixture-root isolation (construction and refusal only; the real /opt is never mutated) ----
REAL_ROOT = "/opt/aegis-idea3-status"


@pytest.mark.parametrize("bad,reason", [
    ("/", "HOST_ROOT_IS_FILESYSTEM_ROOT"),
    ("//", "HOST_ROOT_"),
    ("/.", "HOST_ROOT_NOT_CANONICAL"),
    ("/./", "HOST_ROOT_NOT_CANONICAL"),
    ("/tmp/..", "HOST_ROOT_NOT_CANONICAL"),
    ("/opt/..", "HOST_ROOT_NOT_CANONICAL"),
    ("/tmp/x/../..", "HOST_ROOT_NOT_CANONICAL"),
    ("/tmp/", "HOST_ROOT_NOT_CANONICAL"),
    ("relative", "HOST_ROOT_MUST_BE_ABSOLUTE"),
    ("/opt", "HOST_ROOT_IN_SYSTEM_LOCATION"),
    ("/opt/aegis-idea3-status", "HOST_ROOT_IN_SYSTEM_LOCATION"),
    ("/opt/aegis-idea3", "HOST_ROOT_IN_SYSTEM_LOCATION"),
    ("/etc", "HOST_ROOT_IN_SYSTEM_LOCATION"),
    ("/usr", "HOST_ROOT_IN_SYSTEM_LOCATION"),
    ("/run", "HOST_ROOT_IN_SYSTEM_LOCATION"),
])
def test_dangerous_fixture_roots_are_refused_even_with_every_override(inst, bad, reason) -> None:
    for owner_any in (True, False):
        for dirty in (True, False):
            assert reason in refuses(inst.Layout, bad, owner_any, dirty), (bad, owner_any, dirty)


def test_the_real_destination_is_unreachable_through_any_fixture_spelling(inst) -> None:
    for spelling in ("/", "//", "/.", "/tmp/..", "/opt/..", "/proc/self/root", "/proc/1/root"):
        with pytest.raises(Exception) as e:
            inst.Layout(spelling, True, True)
        assert type(e.value).__name__ == "Refusal", spelling
    assert not Path(REAL_ROOT).exists()


def test_a_symlinked_fixture_root_cannot_alias_the_real_destination(inst, tmp_path) -> None:
    link = tmp_path / "rootlink"
    link.symlink_to("/")
    assert "HOST_ROOT_IS_SYMLINK" in refuses(inst.Layout, str(link), True)
    (tmp_path / "real").mkdir()
    (tmp_path / "real" / ".aegis-sidecar-fixture-root").write_text("x\n")
    alias = tmp_path / "alias"
    alias.symlink_to(tmp_path / "real")
    assert "HOST_ROOT_IS_SYMLINK" in refuses(inst.Layout, str(alias), True)
    # a symlinked PARENT of the fixture root is an alias too
    nested = tmp_path / "alias" / "inner"
    (tmp_path / "real" / "inner").mkdir()
    (tmp_path / "real" / "inner" / ".aegis-sidecar-fixture-root").write_text("x\n")
    assert "HOST_ROOT_ALIAS" in refuses(inst.Layout, str(nested), True)


def test_a_fixture_root_without_the_approval_marker_is_refused(inst, tmp_path) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    assert "HOST_ROOT_NOT_APPROVED_FIXTURE" in refuses(inst.Layout, str(bare), True)
    (bare / ".aegis-sidecar-fixture-root").symlink_to("/etc/hostname")
    assert "HOST_ROOT_NOT_APPROVED_FIXTURE" in refuses(inst.Layout, str(bare), True)
    assert "HOST_ROOT_NOT_A_DIRECTORY" in refuses(inst.Layout, str(tmp_path / "missing"), True)


def test_a_fixture_root_cannot_contain_or_sit_inside_the_real_production_tree(inst, tmp_path, monkeypatch) -> None:
    fake_real = tmp_path / "pretend-opt"
    (fake_real / "aegis-idea3-status").mkdir(parents=True)
    monkeypatch.setattr(inst, "LOGICAL_ROOT", str(fake_real / "aegis-idea3-status"))
    monkeypatch.setattr(inst, "CORE_ROOT", str(fake_real / "aegis-idea3"))
    for candidate in (fake_real, tmp_path):
        (candidate / ".aegis-sidecar-fixture-root").write_text("x\n")
        assert "HOST_ROOT_ALIASES_PRODUCTION" in refuses(inst.Layout, str(candidate), True), candidate


def test_a_fixture_whose_opt_is_a_symlink_to_the_real_tree_is_refused_and_nothing_is_written(inst, built, host, tmp_path) -> None:
    real_like = tmp_path / "outside"
    real_like.mkdir()
    (host / "opt" / "aegis-idea3-status").symlink_to(real_like)
    assert "HOST_ROOT_ESCAPE" in refuses(inst.Layout, str(host), True)
    assert list(real_like.iterdir()) == []


def test_the_ownership_bypass_cannot_be_combined_with_a_live_path(inst) -> None:
    assert "FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT" in refuses(inst.Layout, "", True)
    assert "FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT" in refuses(inst.Layout, "", True, True)
    for argv in (["--fixture-dest-owner-any", "status"], ["--fixture-allow-dirty", "status"], ["--host-root", "/", "--fixture-dest-owner-any", "status"]):
        assert inst.main(argv) == 1


def test_a_legitimate_disposable_fixture_root_is_still_accepted(inst, host) -> None:
    lay = inst.Layout(str(host), True)
    assert lay.owner == "any" and lay.allow_dirty is False and str(lay.root).startswith(str(host))


# ---- STEP 38.8: clean-source provenance ----
@pytest.fixture(scope="module")
def dirty(tmp_path_factory):
    base = tmp_path_factory.mktemp("dirty")
    repo = rel_tests.make_repo(base)
    (repo / "IDEA3-AEGIS_Lockdown" / "stray.txt").write_text("uncommitted\n")  # untracked file makes the tree dirty
    return rel_tests.load().build_sidecar(repo, base / "staging", "dirty-1", allow_dirty=True)


def test_a_dirty_package_records_the_flag_and_still_verifies_as_a_package(inst, dirty) -> None:
    info = inst._builder.verify_sidecar(dirty, expect_owner="self", release_id="dirty-1")
    assert info["source_tree_dirty"] is True


def test_a_dirty_package_is_refused_for_install_plan_and_the_fixture_default(inst, dirty, host) -> None:
    lay = layout(inst, host)
    before = snapshot(host)
    assert "DIRTY_SOURCE_NOT_ALLOWED" in refuses(inst.install, lay, "dirty-1", dirty, PY, False)
    assert "DIRTY_SOURCE_NOT_ALLOWED" in refuses(inst.plan, lay, "dirty-1", dirty, PY, False)
    assert snapshot(host) == before and not sidecar_root(host).exists()


def test_a_dirty_package_needs_the_explicit_fixture_switch_for_every_later_step(inst, dirty, host) -> None:
    allowed = inst.Layout(str(host), True, True)
    inst.install(allowed, "dirty-1", dirty, PY, False)
    strict = layout(inst, host)
    assert "DIRTY_SOURCE_NOT_ALLOWED" in refuses(inst.activate, strict, "dirty-1", PY, False)
    assert not (sidecar_root(host) / "current").is_symlink()
    inst.activate(allowed, "dirty-1", PY, False)
    assert os.readlink(sidecar_root(host) / "current") == "releases/dirty-1"


def test_the_dirty_switch_exists_only_for_validated_fixture_roots(inst, dirty, tmp_path) -> None:
    assert "FIXTURE_OVERRIDE_REQUIRES_HOST_ROOT" in refuses(inst.Layout, "", False, True)
    assert "HOST_ROOT_NOT_APPROVED_FIXTURE" in refuses(inst.Layout, str(tmp_path), False, True)


def test_rollback_refuses_a_dirty_previous_release(inst, built, dirty, host) -> None:
    allowed = inst.Layout(str(host), True, True)
    inst.install(allowed, "dirty-1", dirty, PY, False)
    inst.install(allowed, RID1, built[RID1], PY, False)
    inst.activate(allowed, "dirty-1", PY, False)
    inst.activate(allowed, RID1, PY, False)
    strict = layout(inst, host)
    assert os.readlink(sidecar_root(host) / "previous") == "releases/dirty-1"
    assert "DIRTY_SOURCE_NOT_ALLOWED" in refuses(inst.rollback, strict, PY, False)
    assert os.readlink(sidecar_root(host) / "current") == f"releases/{RID1}"


def test_the_dirty_flag_in_the_manifest_cannot_be_laundered_by_editing_it(inst, dirty, host, tmp_path) -> None:
    import json

    src = fresh_copy({"d": dirty}, "d", tmp_path, "launder")
    manifest = json.loads((src / "SIDECAR-MANIFEST.json").read_text())
    manifest["source_tree_dirty"] = False
    (src / "SIDECAR-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    assert "CHECKSUM_MISMATCH" in refuses(inst.install, layout(inst, host), "dirty-1", src, PY, False)


@pytest.mark.parametrize("field,value,reason", [
    ("source_git_sha", "not-a-sha", "MANIFEST_SOURCE_SHA_MALFORMED"),
    ("source_git_sha", "A" * 40, "MANIFEST_SOURCE_SHA_MALFORMED"),
    ("source_git_sha", "a" * 39, "MANIFEST_SOURCE_SHA_MALFORMED"),
    ("release_id", "someone-else", "MANIFEST_RELEASE_ID_MISMATCH"),
    ("source_tree_dirty", "no", "MANIFEST_DIRTY_FLAG_INVALID"),
    ("kind", "aegis-idea3-core-release", "MANIFEST_KIND_INVALID"),
])
def test_tampered_provenance_fields_are_refused_even_when_checksums_are_recomputed(inst, built, host, tmp_path, field, value, reason) -> None:
    import json

    src = fresh_copy(built, RID1, tmp_path)
    manifest = json.loads((src / "SIDECAR-MANIFEST.json").read_text())
    manifest[field] = value
    (src / "SIDECAR-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(src).as_posix()}"
             for p in sorted(src.rglob("*")) if p.is_file() and p.name != "SIDECAR-SHA256SUMS"]
    (src / "SIDECAR-SHA256SUMS").write_text("\n".join(lines) + "\n")
    before = snapshot(host)
    assert reason in refuses(inst.install, layout(inst, host), RID1, src, PY, False)
    assert snapshot(host) == before


def test_a_refusal_leaves_an_existing_release_byte_identical(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.activate(lay, RID1, PY, False)
    before = snapshot(sidecar_root(host))
    bad = fresh_copy(built, RID2, tmp_path)
    (bad / "tools" / "status_push_client.py").write_text("x = 1\n")
    assert "CHECKSUM_MISMATCH" in refuses(inst.install, lay, RID2, bad, PY, False)
    assert "RELEASE_ALREADY_INSTALLED" in refuses(inst.install, lay, RID1, built[RID1], PY, False)
    assert "RELEASE_NOT_INSTALLED" in refuses(inst.activate, lay, RID2, PY, False)
    assert snapshot(sidecar_root(host)) == before


# ---- STEP 38.8: substitution after install ----
def test_an_installed_release_replaced_by_a_symlink_is_never_activated(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    inst.install(lay, RID2, built[RID2], PY, False)
    inst.activate(lay, RID1, PY, False)
    target = sidecar_root(host) / "releases" / RID2
    shutil.rmtree(target)
    target.symlink_to(built[RID2])
    assert "RELEASE_NOT_INSTALLED" in refuses(inst.activate, lay, RID2, PY, False)
    assert os.readlink(sidecar_root(host) / "current") == f"releases/{RID1}"


def test_a_releases_directory_replaced_by_a_symlink_is_refused(inst, built, host, tmp_path) -> None:
    lay = layout(inst, host)
    inst.install(lay, RID1, built[RID1], PY, False)
    releases = sidecar_root(host) / "releases"
    moved = tmp_path / "moved"
    releases.rename(moved)
    releases.symlink_to(moved)
    assert "DESTINATION_PARENT_IS_SYMLINK" in refuses(inst.install, lay, RID2, built[RID2], PY, False)
