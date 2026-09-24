"""L7 must prove the immutable release exists before it stages anything or points `current` at it.

Fixture filesystem only (AEGIS_P4_FS_ROOT below tmp_path). No /opt, no systemctl, no service.
"""
from __future__ import annotations

import getpass
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
L7 = ROOT / "deploy" / "pr11-phase4" / "stages" / "L7"
REL = "/opt/aegis-idea3/releases/v1.0.0"

_spec = __import__("importlib.util").util.spec_from_file_location("l7h", ROOT / "tests" / "test_pr11_phase4_l7_handler.py")
_mod = __import__("importlib.util").util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
create_fixture_input_dir = _mod.create_fixture_input_dir


def make_release(fs: Path, rel: str = REL, *, venv: bool = True, supervisor: bool = True, executable: bool = True) -> Path:
    r = fs / rel.lstrip("/")
    (r / "aegis_soc").mkdir(parents=True)
    if supervisor:
        (r / "aegis_soc" / "supervisor.py").write_text("# fixture\n")
    if venv:
        py = r / "venv" / "bin" / "python"
        py.parent.mkdir(parents=True)
        py.write_text("#!/bin/sh\n")
        py.chmod(0o755 if executable else 0o644)
    r.chmod(0o755)
    return r


def run(script: str, tmp: Path, fs: Path, **env: str) -> subprocess.CompletedProcess[str]:
    e = {k: v for k, v in os.environ.items() if not k.startswith("AEGIS_") and k != "P4_FS_ROOT"}
    e.update({"AEGIS_P4_FS_ROOT": str(fs), "AEGIS_L7_WORK_DIR": str(tmp / "work"), "AEGIS_L7_INPUT_DIR": str(tmp / "in")})
    e.update(env)
    return subprocess.run(["bash", str(L7 / script)], text=True, capture_output=True, env=e)


def out(r): return r.stdout + r.stderr


@pytest.fixture()
def env(tmp_path: Path):
    create_fixture_input_dir(tmp_path / "in")
    fs = tmp_path / "fs"
    fs.mkdir()
    return tmp_path, fs


def untouched(fs: Path) -> bool:
    return not (fs / "etc/aegis-idea3/credentials").exists() and not (fs / "opt/aegis-idea3/current").is_symlink()


def test_valid_release_applies_and_current_resolves(env):
    tmp, fs = env
    make_release(fs)
    r = run("apply.sh", tmp, fs)
    assert r.returncode == 0, out(r)
    link = fs / "opt/aegis-idea3/current"
    assert link.is_symlink() and os.readlink(link) == REL


def test_missing_release_fails_before_any_mutation(env):
    tmp, fs = env
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and "L7_RELEASE_MISSING" in out(r)
    assert untouched(fs)


@pytest.mark.parametrize("kw,reason", [
    ({"venv": False}, "L7_RELEASE_VENV_MISSING"),
    ({"executable": False}, "L7_RELEASE_VENV_MISSING"),
    ({"supervisor": False}, "L7_RELEASE_INCOMPLETE"),
])
def test_incomplete_release_fails_closed(env, kw, reason):
    tmp, fs = env
    make_release(fs, **kw)
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and reason in out(r), out(r)
    assert untouched(fs)


def test_release_writable_by_group_or_other_fails(env):
    tmp, fs = env
    rel = make_release(fs)
    (rel / "aegis_soc" / "supervisor.py").chmod(0o666)
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and "L7_RELEASE_WRITABLE" in out(r)
    assert untouched(fs)


def test_release_owner_is_enforced(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs, AEGIS_L7_RELEASE_OWNER=getpass.getuser()).returncode == 0
    tmp2 = tmp / "second"; tmp2.mkdir()
    create_fixture_input_dir(tmp2 / "in")
    fs2 = tmp2 / "fs"; fs2.mkdir(); make_release(fs2)
    r = run("apply.sh", tmp2, fs2, AEGIS_L7_RELEASE_OWNER="aegis-idea3")
    assert r.returncode != 0 and "L7_RELEASE_OWNERSHIP_INVALID" in out(r)
    assert untouched(fs2)


@pytest.mark.parametrize("bad", ["/opt/aegis-idea3/releases/../evil", "/tmp/rel", "relative/rel", "/opt/aegis-idea3/releases/", "/opt/aegis-idea3/releases/..", "/opt/aegis-idea3/releases/a/b"])
def test_release_dir_must_be_a_single_component_under_releases(env, bad):
    tmp, fs = env
    make_release(fs)
    r = run("apply.sh", tmp, fs, AEGIS_L7_RELEASE_DIR=bad)
    assert r.returncode != 0 and "L7_RELEASE_DIR_INVALID" in out(r), out(r)
    assert untouched(fs)


def test_release_dir_symlink_rejected(env):
    tmp, fs = env
    real = make_release(fs, "/opt/aegis-idea3/releases/real")
    (fs / "opt/aegis-idea3/releases/v1.0.0").symlink_to(real)
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and "L7_RELEASE_MISSING" in out(r)


def test_preexisting_dangling_current_link_fails_before_mutation(env):
    tmp, fs = env
    make_release(fs)
    cur = fs / "opt/aegis-idea3/current"
    cur.symlink_to("/opt/aegis-idea3/releases/gone")
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and "L7_CURRENT_LINK_DANGLING" in out(r)
    assert not (fs / "etc/aegis-idea3/credentials").exists()


def test_verify_rejects_dangling_current_link(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    import shutil
    shutil.rmtree(fs / "opt/aegis-idea3/releases/v1.0.0")
    r = run("verify.sh", tmp, fs)
    assert r.returncode != 0 and "L7_CURRENT_LINK_DANGLING" in out(r), out(r)


def test_verify_rejects_current_link_outside_releases(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    cur = fs / "opt/aegis-idea3/current"; cur.unlink(); cur.symlink_to("/tmp")
    r = run("verify.sh", tmp, fs)
    assert r.returncode != 0 and "L7_CURRENT_LINK_TARGET_INVALID" in out(r)


def test_verify_rejects_unit_execstart_without_runtime(env):
    tmp, fs = env
    rel = make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    (rel / "venv/bin/python").unlink()
    r = run("verify.sh", tmp, fs)
    assert r.returncode != 0 and ("L7_RELEASE_VENV_MISSING" in out(r) or "L7_UNIT_EXECSTART_MISSING" in out(r))


def test_verify_passes_only_with_complete_release(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    r = run("verify.sh", tmp, fs)
    assert r.returncode == 0 and "L7_VERIFY=PASS" in r.stdout, out(r)


def test_rollback_never_leaves_dangling_current(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    assert run("rollback.sh", tmp, fs).returncode == 0
    cur = fs / "opt/aegis-idea3/current"
    assert not cur.is_symlink() and not cur.exists()


# ---- D4 credential contract (code facts: RestoreCredential.load = mode 0600 + owner == Core euid) ----
def test_staged_credentials_dir_is_traversable_by_the_service_group(env):
    tmp, fs = env
    make_release(fs)
    assert run("apply.sh", tmp, fs).returncode == 0
    creds = fs / "etc/aegis-idea3/credentials"
    assert stat.S_IMODE(creds.stat().st_mode) == 0o750
    for name in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential"):
        assert stat.S_IMODE((creds / name).stat().st_mode) == 0o600


def test_readonly_0400_restore_credential_input_is_accepted(env):
    tmp, fs = env
    make_release(fs)
    (tmp / "in" / "restore.credential").chmod(0o400)
    r = run("apply.sh", tmp, fs)
    assert r.returncode == 0, out(r)
    assert stat.S_IMODE((fs / "etc/aegis-idea3/credentials/restore.credential").stat().st_mode) == 0o600


def test_oversized_restore_credential_rejected(env):
    tmp, fs = env
    make_release(fs)
    p = tmp / "in" / "restore.credential"
    p.chmod(0o600); p.write_text("scrypt$" + "1" * 5000 + "\n"); p.chmod(0o600)
    r = run("apply.sh", tmp, fs)
    assert r.returncode != 0 and "restore.credential" in out(r)


def _code(name: str) -> str:
    return "\n".join(ln for ln in (L7 / name).read_text().splitlines() if not ln.lstrip().startswith("#"))


def test_live_apply_has_explicit_start_failure_and_stability_reasons():
    t = _code("apply.sh")
    assert "L7_SERVICE_START_FAILED" in t and "L7_SERVICE_NOT_STABLE" in t
    assert t.index("L7_SERVICE_START_FAILED") < t.index("L7_SERVICE_NOT_STABLE") < t.index("L7_APPLY=COMPLETE")


def test_live_apply_chowns_service_owned_files_only_in_live_mode():
    t = _code("apply.sh")
    assert "chown root:aegis-idea3" in t and "chown aegis-idea3:aegis-idea3" in t
    live_block = t[t.index("chown root:aegis-idea3") - 200: t.index("chown aegis-idea3:aegis-idea3") + 120]
    assert '[ -n "$ROOT" ] ||' in live_block
