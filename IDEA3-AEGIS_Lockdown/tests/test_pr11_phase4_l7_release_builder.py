"""L7 release builder / verifier (repository tooling only).

The builder produces, in a USER-OWNED staging directory, the immutable release layout that the L7 release guard expects at
/opt/aegis-idea3/releases/<release-id>/ : venv/bin/python, aegis_soc/supervisor.py and the exact runtime closure of
`python -m aegis_soc.supervisor --profile production --live --headless --no-detector --no-voice`, plus requirements.txt,
RELEASE-MANIFEST.json and RELEASE-SHA256SUMS. It never writes /opt, never uses sudo, never touches systemd/NetworkManager/
rfkill/iw, and installs dependencies only from a local wheelhouse (no Internet).

Tests are hermetic: a throwaway git repo holds a copy of the real `aegis_soc` package, and the wheelhouse contains a tiny
locally-built wheel named like the pinned dependency. No network, no root, no /opt.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
TOOL = ROOT / "deploy" / "pr11-phase4" / "p4-l7-build-release.py"

MANIFEST_FIELDS = {"schema_version", "release_id", "source_git_sha", "source_tree_dirty", "python_version",
                   "requirements_sha256", "file_count", "created_by_tool_version"}
CLOSURE = {"__init__", "comms", "config", "controller", "database", "dispatch_client", "dispatch_ledger", "dispatch_worker",
           "ip_containment", "local_restore", "mqtt_client", "paths", "platform_lock", "protocol_inbound", "protocol_runtime",
           "protocol_store", "protocol_v1", "runtime", "security", "supervisor", "systemd_credentials", "trusted_time"}
NOT_RUNTIME = {"cli", "gui", "production_runtime", "telegram_control", "theme", "windows_launcher", "wizard"}


def load():
    assert TOOL.is_file(), f"missing {TOOL}"
    spec = importlib.util.spec_from_file_location("p4_l7_build_release", TOOL)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": "/dev/null"}
    return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True, env=env).stdout.strip()


def make_wheelhouse(path: Path) -> Path:
    """A minimal valid wheel named like the pinned dependency; contents are a stub, never real paho."""
    path.mkdir(parents=True, exist_ok=True)
    files = {"paho/__init__.py": b"", "paho/mqtt/__init__.py": b"", "paho/mqtt/client.py": b"# stub\n",
             "paho_mqtt-2.1.0.dist-info/METADATA": b"Metadata-Version: 2.1\nName: paho-mqtt\nVersion: 2.1.0\n",
             "paho_mqtt-2.1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
    record = []
    for name, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{name},sha256={digest},{len(data)}")
    record.append("paho_mqtt-2.1.0.dist-info/RECORD,,")
    files["paho_mqtt-2.1.0.dist-info/RECORD"] = ("\n".join(record) + "\n").encode()
    with zipfile.ZipFile(path / "paho_mqtt-2.1.0-py3-none-any.whl", "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def make_repo(base: Path) -> Path:
    repo = base / "repo"
    pkg_root = repo / "IDEA3-AEGIS_Lockdown"
    shutil.copytree(ROOT / "aegis_soc", pkg_root / "aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(ROOT / "requirements.txt", pkg_root / "requirements.txt")
    (repo / ".gitignore").write_text("__pycache__/\n")
    _git(base, "init", "-q", str(repo))
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fixture")
    return repo


@pytest.fixture(scope="module")
def tool():
    return load()


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path)


@pytest.fixture()
def wh(tmp_path: Path) -> Path:
    return make_wheelhouse(tmp_path / "wheelhouse")


@pytest.fixture(scope="module")
def good(tool, tmp_path_factory) -> Path:
    base = tmp_path_factory.mktemp("good")
    repo = make_repo(base)
    wheelhouse = make_wheelhouse(base / "wheelhouse")
    staging = base / "staging"
    tool.build_release(repo, staging, "r1.0.0", wheelhouse)
    return staging / "r1.0.0"


@pytest.fixture()
def rel(good: Path, tmp_path: Path) -> Path:
    dest = tmp_path / "r1.0.0"          # the directory name is the release id the manifest must match
    shutil.copytree(good, dest, symlinks=True)
    return dest


def resum(rel: Path) -> None:
    """Recompute RELEASE-SHA256SUMS so a test can tamper with ONE thing without also breaking the checksum."""
    lines = []
    for p in sorted(rel.rglob("*")):
        if p.is_file() and not p.is_symlink() and p.name != "RELEASE-SHA256SUMS":
            lines.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(rel).as_posix()}")
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")


def refuses(fn, *a, **k) -> str:
    with pytest.raises(Exception) as e:
        fn(*a, **k)
    return f"{type(e.value).__name__}: {e.value}"


# ---- tool exists / good build shape ----
def test_tool_exists() -> None:
    assert TOOL.is_file()


def test_good_release_has_required_layout(good: Path) -> None:
    for p in ("venv/bin/python", "aegis_soc/supervisor.py", "requirements.txt", "RELEASE-MANIFEST.json", "RELEASE-SHA256SUMS"):
        assert (good / p).exists(), p
    assert os.access(good / "venv/bin/python", os.X_OK)
    assert not (good / "venv/bin/python").is_symlink(), "interpreter must be a copy, not a symlink out of the release"


def test_runtime_closure_is_exact(good: Path) -> None:
    names = {p.stem for p in (good / "aegis_soc").glob("*.py")}
    assert names == CLOSURE
    assert not names & NOT_RUNTIME
    assert not (good / "detector.py").exists() and not (good / "server_admin.py").exists()


def test_manifest_has_exact_allowlisted_fields(good: Path) -> None:
    m = json.loads((good / "RELEASE-MANIFEST.json").read_text())
    assert set(m) == MANIFEST_FIELDS
    assert m["source_tree_dirty"] is False and m["release_id"] == "r1.0.0" and m["schema_version"] == 1
    assert re.fullmatch(r"[0-9a-f]{40}", m["source_git_sha"])
    assert m["requirements_sha256"] == hashlib.sha256((good / "requirements.txt").read_bytes()).hexdigest()
    text = (good / "RELEASE-MANIFEST.json").read_text()
    assert os.environ.get("USER", "\0") not in text and socket.gethostname() not in text
    assert str(good.parent) not in text


def test_no_staging_path_username_or_command_line_leaks_into_payload(good: Path) -> None:
    cfg = (good / "venv/pyvenv.cfg").read_text()
    assert not re.search(r"^command\s*=", cfg, re.MULTILINE)
    for p in good.rglob("*"):
        if p.is_file() and not p.is_symlink() and p.stat().st_size < 1_000_000 and p.suffix in {".py", ".cfg", ".json", ".txt", ""}:
            try:
                assert str(good.parent).encode() not in p.read_bytes(), p
            except OSError:
                pass


def test_activation_scripts_and_pycache_are_absent(good: Path) -> None:
    assert not list(good.rglob("__pycache__"))
    assert not (good / "venv/bin/activate").exists() and not (good / ".git").exists()


def test_checksums_cover_payload_exactly_and_sorted(good: Path) -> None:
    lines = (good / "RELEASE-SHA256SUMS").read_text().splitlines()
    paths = [ln.split("  ", 1)[1] for ln in lines]
    assert paths == sorted(paths) and "RELEASE-SHA256SUMS" not in paths and "RELEASE-MANIFEST.json" in paths
    on_disk = sorted(p.relative_to(good).as_posix() for p in good.rglob("*")
                     if p.is_file() and not p.is_symlink() and p.name != "RELEASE-SHA256SUMS")
    assert paths == on_disk


def test_file_modes_have_no_group_or_world_write(good: Path) -> None:
    for p in good.rglob("*"):
        if not p.is_symlink():
            assert not p.stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH), p


def test_good_release_verifies_and_verify_is_read_only_and_deterministic(tool, good: Path) -> None:
    def snap():
        return sorted((p.relative_to(good).as_posix(), p.stat().st_mtime_ns, p.stat().st_mode) for p in good.rglob("*"))
    before = snap()
    r1 = tool.verify_release(good)
    r2 = tool.verify_release(good)
    assert r1 == r2 and snap() == before


# ---- 1-5 release id / destination ----
def test_valid_release_ids_are_accepted(tool) -> None:
    for rid in ("v1.0.0", "r1", "2026-09-25_a", "A.b-c_d"):
        tool.validate_release_id(rid)


@pytest.mark.parametrize("rid", ["", "a/b", "/abs", "..", "a..b/c", "../x", ".hidden", "-x", "a b", "a\nb", "x" * 129, "é"])
def test_bad_release_ids_are_refused(tool, rid: str) -> None:
    assert refuses(tool.validate_release_id, rid)


def test_existing_destination_is_refused_and_untouched(tool, repo, wh, tmp_path) -> None:
    staging = tmp_path / "s"; (staging / "r1").mkdir(parents=True)
    (staging / "r1" / "keep").write_text("x")
    refuses(tool.build_release, repo, staging, "r1", wh)
    assert (staging / "r1" / "keep").read_text() == "x"


def test_destination_symlink_is_refused(tool, repo, wh, tmp_path) -> None:
    staging = tmp_path / "s"; staging.mkdir()
    victim = tmp_path / "victim"; victim.mkdir()
    (staging / "r1").symlink_to(victim)
    refuses(tool.build_release, repo, staging, "r1", wh)
    assert not any(victim.iterdir())


def test_staging_root_symlink_is_refused(tool, repo, wh, tmp_path) -> None:
    real = tmp_path / "real"; real.mkdir()
    (tmp_path / "link").symlink_to(real)
    refuses(tool.build_release, repo, tmp_path / "link", "r1", wh)
    assert not any(real.iterdir())


# ---- 7 dirty source ----
def test_dirty_source_is_refused_by_default(tool, repo, wh, tmp_path) -> None:
    (repo / "IDEA3-AEGIS_Lockdown" / "aegis_soc" / "config.py").write_text("# dirty\n", encoding="utf-8")
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh)
    assert not (tmp_path / "s" / "r1").exists()


def test_untracked_file_also_counts_as_dirty(tool, repo, wh, tmp_path) -> None:
    (repo / "IDEA3-AEGIS_Lockdown" / "stray.txt").write_text("x")
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh)


def test_allow_dirty_records_dirty_true(tool, repo, wh, tmp_path) -> None:
    (repo / "IDEA3-AEGIS_Lockdown" / "stray.txt").write_text("x")
    tool.build_release(repo, tmp_path / "s", "r1", wh, allow_dirty=True)
    assert json.loads((tmp_path / "s/r1/RELEASE-MANIFEST.json").read_text())["source_tree_dirty"] is True


# ---- 8-10, 11-12, 13-15, 16-18 verifier tamper matrix ----
def test_missing_venv_python_fails(tool, rel) -> None:
    (rel / "venv/bin/python").unlink(); resum(rel)
    assert "VENV_PYTHON_MISSING" in refuses(tool.verify_release, rel)


def test_non_executable_venv_python_fails(tool, rel) -> None:
    (rel / "venv/bin/python").chmod(0o644); resum(rel)
    assert "python" in refuses(tool.verify_release, rel).lower()


def test_missing_supervisor_fails(tool, rel) -> None:
    (rel / "aegis_soc/supervisor.py").unlink(); resum(rel)
    assert "SUPERVISOR_MISSING" in refuses(tool.verify_release, rel)


@pytest.mark.parametrize("bit", [stat.S_IWGRP, stat.S_IWOTH])
def test_group_or_world_writable_payload_fails(tool, rel, bit) -> None:
    p = rel / "aegis_soc/config.py"; p.chmod(p.stat().st_mode | bit)
    assert "GROUP_OR_WORLD_WRITABLE" in refuses(tool.verify_release, rel)


@pytest.mark.parametrize("bit", [stat.S_IWGRP, stat.S_IWOTH])
def test_group_or_world_writable_directory_fails(tool, rel, bit) -> None:
    p = rel / "aegis_soc"; p.chmod(p.stat().st_mode | bit)
    assert "GROUP_OR_WORLD_WRITABLE" in refuses(tool.verify_release, rel)


def test_checksum_mismatch_fails(tool, rel) -> None:
    (rel / "aegis_soc/config.py").write_text("tampered\n")
    assert "CHECKSUM_MISMATCH" in refuses(tool.verify_release, rel)


def test_missing_checksum_entry_fails(tool, rel) -> None:
    f = rel / "RELEASE-SHA256SUMS"
    f.write_text("\n".join(ln for ln in f.read_text().splitlines() if not ln.endswith("aegis_soc/config.py")) + "\n")
    assert "CHECKSUM_ENTRY_MISSING" in refuses(tool.verify_release, rel)


def test_unlisted_extra_file_fails(tool, rel) -> None:
    (rel / "aegis_soc/extra.py").write_text("x = 1\n")
    assert "CHECKSUM_ENTRY_MISSING" in refuses(tool.verify_release, rel)


def test_extra_checksum_entry_fails(tool, rel) -> None:
    f = rel / "RELEASE-SHA256SUMS"
    f.write_text("\n".join(sorted([*f.read_text().splitlines(), f"{'0' * 64}  aegis_soc/ghost.py"], key=lambda ln: ln.split("  ", 1)[1])) + "\n")
    assert "CHECKSUM_ENTRY_EXTRA" in refuses(tool.verify_release, rel)


def test_missing_file_listed_in_checksums_fails(tool, rel) -> None:
    (rel / "aegis_soc/comms.py").unlink()
    assert "CHECKSUM_ENTRY_EXTRA" in refuses(tool.verify_release, rel)


def test_missing_checksum_file_fails(tool, rel) -> None:
    (rel / "RELEASE-SHA256SUMS").unlink()
    assert "REQUIRED_FILE_MISSING" in refuses(tool.verify_release, rel)


def test_manifest_missing_field_fails(tool, rel) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text()); m.pop("requirements_sha256")
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m)); resum(rel)
    assert "MANIFEST_FIELDS_INVALID" in refuses(tool.verify_release, rel)


def test_manifest_extra_field_fails(tool, rel) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text()); m["hostname"] = "box"
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m)); resum(rel)
    assert "MANIFEST_FIELDS_INVALID" in refuses(tool.verify_release, rel)


@pytest.mark.parametrize("sha", ["", "abc", "G" * 40, "a" * 39, "a" * 41, "A" * 40])
def test_malformed_source_sha_fails(tool, rel, sha: str) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text()); m["source_git_sha"] = sha
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m)); resum(rel)
    assert "MANIFEST_SOURCE_SHA_MALFORMED" in refuses(tool.verify_release, rel)


def test_manifest_dirty_true_is_reported_but_wrong_types_fail(tool, rel) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text()); m["file_count"] = "many"
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m)); resum(rel)
    assert "MANIFEST_FILE_COUNT_MISMATCH" in refuses(tool.verify_release, rel)


@pytest.mark.parametrize("key,val,reason", [
    ("file_count", 1, "MANIFEST_FILE_COUNT_MISMATCH"), ("requirements_sha256", "0" * 64, "MANIFEST_REQUIREMENTS_HASH_MISMATCH"),
    ("release_id", "other", "MANIFEST_RELEASE_ID_MISMATCH"), ("schema_version", 2, "MANIFEST_SCHEMA_VERSION_UNSUPPORTED")])
def test_manifest_values_must_match_the_payload(tool, rel, key: str, val, reason: str) -> None:
    m = json.loads((rel / "RELEASE-MANIFEST.json").read_text()); m[key] = val
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(m)); resum(rel)
    assert reason in refuses(tool.verify_release, rel)


# ---- 19-22 file types / symlinks ----
def test_source_symlink_escape_is_refused(tool, repo, wh, tmp_path) -> None:
    target = tmp_path / "outside.py"; target.write_text("secret = 1\n")
    cfg = repo / "IDEA3-AEGIS_Lockdown/aegis_soc/config.py"
    cfg.unlink(); cfg.symlink_to(target)
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "link")
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh)
    assert not (tmp_path / "s" / "r1").exists()


def test_source_fifo_is_refused(tool, repo, wh, tmp_path) -> None:
    os.mkfifo(repo / "IDEA3-AEGIS_Lockdown/aegis_soc/pipe.py")   # untracked, ignored by neither: dirty OR fifo, both refuse
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh, allow_dirty=True)


def test_source_socket_is_refused(tool, repo, wh, tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(repo / "IDEA3-AEGIS_Lockdown/aegis_soc")       # AF_UNIX paths are length-limited: bind relatively
    s = socket.socket(socket.AF_UNIX); s.bind("sock.py")
    try:
        refuses(tool.build_release, repo, tmp_path / "s", "r1", wh, allow_dirty=True)
    finally:
        s.close()


def test_device_file_kind_is_classified_as_forbidden(tool) -> None:
    assert tool.file_kind(stat.S_IFCHR | 0o600) == "device" and tool.file_kind(stat.S_IFBLK | 0o600) == "device"
    assert tool.file_kind(stat.S_IFIFO) == "fifo" and tool.file_kind(stat.S_IFSOCK) == "socket"
    assert tool.file_kind(stat.S_IFREG | 0o644) == "file" and tool.file_kind(stat.S_IFDIR) == "dir" and tool.file_kind(stat.S_IFLNK) == "symlink"


def test_verifier_refuses_fifo_socket_and_escaping_symlinks(tool, rel) -> None:
    os.mkfifo(rel / "aegis_soc/pipe")
    assert "fifo" in refuses(tool.verify_release, rel).lower()
    os.unlink(rel / "aegis_soc/pipe")
    (rel / "aegis_soc/link.py").symlink_to("/etc/passwd")
    assert "symlink" in refuses(tool.verify_release, rel).lower()
    (rel / "aegis_soc/link.py").unlink()
    (rel / "aegis_soc/rel.py").symlink_to("../../outside")
    assert "SYMLINK" in refuses(tool.verify_release, rel)
    (rel / "aegis_soc/rel.py").unlink()
    (rel / "aegis_soc/abs.py").symlink_to(rel / "aegis_soc/config.py")   # absolute, even if it stays inside: unexpected
    assert "SYMLINK" in refuses(tool.verify_release, rel)


def test_verifier_refuses_socket_in_payload(tool, rel, monkeypatch) -> None:
    monkeypatch.chdir(rel / "aegis_soc")
    s = socket.socket(socket.AF_UNIX); s.bind("s")
    try:
        assert "socket" in refuses(tool.verify_release, rel).lower()
    finally:
        s.close()


# ---- 23 aliasing ----
def test_staging_inside_source_or_equal_is_refused(tool, repo, wh) -> None:
    refuses(tool.build_release, repo, repo / "staging", "r1", wh)
    refuses(tool.build_release, repo, repo, "r1", wh)
    refuses(tool.build_release, repo, repo / "IDEA3-AEGIS_Lockdown" / "aegis_soc", "r1", wh)
    assert not (repo / "staging").exists()


def test_source_inside_staging_is_refused(tool, tmp_path, wh) -> None:
    staging = tmp_path / "s"; staging.mkdir()
    repo = make_repo(staging)
    refuses(tool.build_release, repo, staging, "r1", wh)


# ---- 24-26 exclusions ----
def test_credentials_git_and_pycache_are_never_copied(tool, repo, wh, tmp_path) -> None:
    pkg = repo / "IDEA3-AEGIS_Lockdown/aegis_soc"
    for name in (".env", "mqtt-core.pass", "k_c2d", "server.key", "restore.credential", "id_rsa"):
        (pkg / name).write_text("SECRET-MARKER\n")
    (pkg / "__pycache__").mkdir(); (pkg / "__pycache__/x.pyc").write_bytes(b"\0")
    _git(repo, "add", "-f", "-A"); _git(repo, "commit", "-q", "-m", "secrets-in-tree")
    tool.build_release(repo, tmp_path / "s", "r1", wh)
    out = tmp_path / "s/r1"
    assert not list(out.rglob(".env")) and not list(out.rglob("*.pass")) and not list(out.rglob("*.key"))
    assert not list(out.rglob("__pycache__")) and not (out / ".git").exists()
    assert not any(b"SECRET-MARKER" in p.read_bytes() for p in out.rglob("*") if p.is_file() and not p.is_symlink())


def test_verifier_refuses_credential_git_and_pycache_payload(tool, rel) -> None:
    for name, body in (("aegis_soc/.env", "A=1"), ("aegis_soc/x.key", "k"), ("aegis_soc/mqtt-core.pass", "p"),
                       ("aegis_soc/note.txt", "-----BEGIN PRIVATE KEY-----\nabc\n")):
        f = rel / name; f.write_text(body); resum(rel)
        assert re.search("CREDENTIAL_LIKE_FILE|PRIVATE_KEY_MATERIAL", refuses(tool.verify_release, rel)), name
        f.unlink()
    (rel / "aegis_soc/__pycache__").mkdir(); (rel / "aegis_soc/__pycache__/a.pyc").write_bytes(b"0"); resum(rel)
    assert "FORBIDDEN_DIRECTORY" in refuses(tool.verify_release, rel)
    shutil.rmtree(rel / "aegis_soc/__pycache__")
    (rel / ".git").mkdir(); (rel / ".git/HEAD").write_text("x"); resum(rel)
    assert "FORBIDDEN_DIRECTORY" in refuses(tool.verify_release, rel)


# ---- dependency audit ----
def test_unmapped_third_party_import_is_refused(tool, repo, wh, tmp_path) -> None:
    cfg = repo / "IDEA3-AEGIS_Lockdown/aegis_soc/config.py"
    cfg.write_text("import requests\n" + cfg.read_text())
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "dep")
    assert "requests" in refuses(tool.build_release, repo, tmp_path / "s", "r1", wh)


def test_unresolvable_local_import_is_refused(tool, repo, wh, tmp_path) -> None:
    cfg = repo / "IDEA3-AEGIS_Lockdown/aegis_soc/config.py"
    cfg.write_text("from . import does_not_exist\n" + cfg.read_text())
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "dep")
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh)


def test_closure_is_computed_from_source_not_hard_coded(tool, repo) -> None:
    mods, third = tool.runtime_closure(repo / "IDEA3-AEGIS_Lockdown")
    assert set(mods) == CLOSURE - {"__init__"} and third == {"paho"}


# ---- 27-30 no host mutation ----
@pytest.mark.parametrize("bad", ["/opt/aegis-idea3/releases", "/opt/x", "/etc/aegis-idea3", "/usr/local/x", "/var/lib/x"])
def test_system_locations_are_refused_before_any_write(tool, repo, wh, bad: str) -> None:
    msg = refuses(tool.build_release, repo, Path(bad), "r1", wh)
    assert msg
    assert not Path("/opt/aegis-idea3").exists()


def code_only(path: Path) -> str:
    """The tool's executable code: no comments (dropped by unparse) and no docstrings."""
    import ast
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False) is not None:
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def test_tool_source_never_uses_sudo_systemd_network_or_root_paths() -> None:
    text = code_only(TOOL)
    for pat in (r"\bsudo\b", r"\bsystemctl\b", r"\bnmcli\b", r"\brfkill\b", r"\biw\b\s", r"\bchown\b", r"os\.chown", r"\bnft\b",
                r"pip[\"']?,?\s*[\"']?install[^\n]*(?<!-index)\s+https?://"):
        assert not re.search(pat, text), pat


def test_tool_never_installs_globally_or_from_the_internet() -> None:
    text = TOOL.read_text()
    assert "--no-index" in text and "--find-links" in text and "--isolated" in text and "--without-pip" in text
    assert "--user" not in text and "--break-system-packages" not in text


# ---- 31-33 bounded, offline ----
def test_venv_and_pip_calls_are_bounded_and_offline(tool, repo, wh, tmp_path) -> None:
    calls = []
    real = subprocess.run

    def spy(argv, **kw):
        calls.append((list(map(str, argv)), kw))
        return real(argv, **kw)
    tool.build_release(repo, tmp_path / "s", "r1", wh, runner=spy)
    venv = [c for c in calls if "venv" in c[0]]
    pip = [c for c in calls if "pip" in c[0]]
    assert venv and pip
    for argv, kw in venv + pip:
        assert isinstance(kw.get("timeout"), (int, float)) and 0 < kw["timeout"] <= 600, argv
        assert kw.get("stdin") == subprocess.DEVNULL
        assert not any(k.lower().endswith("_proxy") for k in kw["env"]), "proxy variables must not reach pip"
    for argv, kw in pip:
        assert "--no-index" in argv and "--isolated" in argv and any(a.startswith("--find-links") or a == "--find-links" for a in argv)
        assert kw["env"].get("PIP_NO_INPUT") == "1"


@pytest.mark.parametrize("which", ["venv", "pip"])
def test_timeouts_fail_closed_and_leave_no_partial_release(tool, repo, wh, tmp_path, which: str) -> None:
    real = subprocess.run

    def hang(argv, **kw):
        if which in list(map(str, argv)):
            raise subprocess.TimeoutExpired(argv, kw.get("timeout", 1))
        return real(argv, **kw)
    refuses(tool.build_release, repo, tmp_path / "s", "r1", wh, runner=hang)
    s = tmp_path / "s"
    assert not (s / "r1").exists() and not any(s.iterdir()) if s.exists() else True


def test_build_works_with_no_internet_even_with_dead_proxy(tool, repo, wh, tmp_path, monkeypatch) -> None:
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
        monkeypatch.setenv(k, "http://127.0.0.1:9")
    monkeypatch.setenv("PIP_INDEX_URL", "http://127.0.0.1:9/simple")
    tool.build_release(repo, tmp_path / "s", "r1", wh)
    tool.verify_release(tmp_path / "s/r1")


def test_missing_or_empty_wheelhouse_is_refused(tool, repo, tmp_path) -> None:
    refuses(tool.build_release, repo, tmp_path / "s", "r1", tmp_path / "nope")
    (tmp_path / "empty").mkdir()
    refuses(tool.build_release, repo, tmp_path / "s2", "r1", tmp_path / "empty")
    assert not (tmp_path / "s" / "r1").exists() and not (tmp_path / "s2" / "r1").exists()


def test_failed_build_leaves_no_partial_directory(tool, repo, wh, tmp_path) -> None:
    (tmp_path / "s").mkdir()
    refuses(tool.build_release, repo, tmp_path / "s", "r1", tmp_path / "empty-wheelhouse")
    assert list((tmp_path / "s").iterdir()) == []


# ---- ownership option ----
def test_expect_owner_root_fails_for_a_user_owned_release(tool, rel) -> None:
    if os.getuid() == 0:
        pytest.skip("running as root")
    assert "owner" in refuses(tool.verify_release, rel, expect_owner="root").lower()
    tool.verify_release(rel, expect_owner="self")
    tool.verify_release(rel, expect_owner="any")


# ---- CLI ----
def test_cli_build_and_verify_roundtrip(repo, wh, tmp_path) -> None:
    py = sys.executable
    b = subprocess.run([py, str(TOOL), "build", "--source-root", str(repo), "--staging-root", str(tmp_path / "s"),
                        "--release-id", "r9", "--wheelhouse", str(wh)], text=True, capture_output=True)
    assert b.returncode == 0, b.stderr
    assert "L7_RELEASE_BUILD=PASS" in b.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in b.stdout
    v = subprocess.run([py, str(TOOL), "verify", str(tmp_path / "s/r9")], text=True, capture_output=True, check=False)
    assert v.returncode == 0 and "L7_RELEASE_VERIFY=PASS" in v.stdout
    assert str(tmp_path) not in v.stdout.replace(str(tmp_path / "s/r9"), "")
    (tmp_path / "s/r9/aegis_soc/config.py").write_text("x")
    bad = subprocess.run([py, str(TOOL), "verify", str(tmp_path / "s/r9")], text=True, capture_output=True, check=False)
    assert bad.returncode != 0 and "L7_RELEASE_VERIFY=FAIL" in bad.stderr + bad.stdout


def test_cli_refuses_bad_release_id_without_traceback(repo, wh, tmp_path) -> None:
    r = subprocess.run([sys.executable, str(TOOL), "build", "--source-root", str(repo), "--staging-root", str(tmp_path / "s"),
                        "--release-id", "../x", "--wheelhouse", str(wh)], text=True, capture_output=True)
    assert r.returncode != 0 and "Traceback" not in r.stderr and "L7_RELEASE_BUILD=FAIL" in r.stderr + r.stdout


# ---- compatibility with the L7 release guard (verbatim predicate from PR #202 apply.sh, fixture root only) ----
GUARD = r'''
fail() { echo "GUARD_FAIL=$1"; exit 1; }
host_path() { printf '%s%s\n' "${ROOT%/}" "$1"; }
rel_dir="/opt/aegis-idea3/releases/$RID"
[[ "$rel_dir" =~ ^/opt/aegis-idea3/releases/[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "L7_RELEASE_DIR_INVALID"
rel_host=$(host_path "$rel_dir")
[ -d "$rel_host" ] && [ ! -L "$rel_host" ] || fail "L7_RELEASE_MISSING"
[ -f "$rel_host/venv/bin/python" ] && [ -x "$rel_host/venv/bin/python" ] || fail "L7_RELEASE_VENV_MISSING"
[ -f "$rel_host/aegis_soc/supervisor.py" ] || fail "L7_RELEASE_INCOMPLETE"
release_owner="${AEGIS_L7_RELEASE_OWNER:-}"
if [ -n "$release_owner" ]; then
  for p in "$rel_host" "$rel_host/venv/bin/python" "$rel_host/aegis_soc/supervisor.py"; do
    [ "$(stat -c %U "$p")" = "$release_owner" ] || fail "L7_RELEASE_OWNERSHIP_INVALID"
  done
fi
[ -z "$(find "$rel_host" -xdev ! -type l \( -perm -g+w -o -perm -o+w \) -print -quit)" ] || fail "L7_RELEASE_WRITABLE"
pre_current=$(host_path "/opt/aegis-idea3/current")
if [ -L "$pre_current" ]; then
  pre_target=$(readlink "$pre_current")
  [ -d "$(host_path "$pre_target")" ] || fail "L7_CURRENT_LINK_DANGLING"
fi
echo GUARD_PASS
'''


def run_guard(root: Path, rid: str) -> str:
    env = {**os.environ, "ROOT": str(root), "RID": rid, "AEGIS_L7_RELEASE_OWNER": subprocess.run(["id", "-un"], text=True, capture_output=True, check=False).stdout.strip()}
    return subprocess.run(["bash", "-c", GUARD], text=True, capture_output=True, env=env, check=False).stdout


def test_builder_output_satisfies_the_l7_release_guard_in_a_fixture_root(good: Path, tmp_path: Path) -> None:
    root = tmp_path / "fixroot"; dest = root / "opt/aegis-idea3/releases/r1.0.0"
    dest.parent.mkdir(parents=True); shutil.copytree(good, dest, symlinks=True)
    assert "GUARD_PASS" in run_guard(root, "r1.0.0")
    cur = root / "opt/aegis-idea3/current"; cur.symlink_to("/opt/aegis-idea3/releases/gone")
    assert "L7_CURRENT_LINK_DANGLING" in run_guard(root, "r1.0.0")


def test_guard_rejects_tampered_builder_output(good: Path, tmp_path: Path) -> None:
    root = tmp_path / "fixroot"; dest = root / "opt/aegis-idea3/releases/r1.0.0"
    dest.parent.mkdir(parents=True); shutil.copytree(good, dest, symlinks=True)
    (dest / "aegis_soc/supervisor.py").chmod(0o666)
    assert "L7_RELEASE_WRITABLE" in run_guard(root, "r1.0.0")
    (dest / "aegis_soc/supervisor.py").chmod(0o644)
    (dest / "venv/bin/python").chmod(0o644)
    assert "L7_RELEASE_VENV_MISSING" in run_guard(root, "r1.0.0")


# ---- every build refusal fails for the INTENDED reason (guards against vacuous passes) ----
def test_build_refusals_carry_their_specific_reason(tool, repo, wh, tmp_path, monkeypatch) -> None:
    pkg = repo / "IDEA3-AEGIS_Lockdown/aegis_soc"
    s = tmp_path / "s"
    assert "RELEASE_ID_INVALID" in refuses(tool.build_release, repo, s, "../x", wh)
    assert "STAGING_IN_SYSTEM_LOCATION" in refuses(tool.build_release, repo, Path("/opt/aegis-idea3/releases"), "r1", wh)
    assert "STAGING_ALIASES_SOURCE" in refuses(tool.build_release, repo, repo / "staging", "r1", wh)
    assert "WHEELHOUSE_MISSING_OR_EMPTY" in refuses(tool.build_release, repo, s, "r1", tmp_path / "nope")
    (s / "r1").mkdir(parents=True)
    assert "DESTINATION_EXISTS" in refuses(tool.build_release, repo, s, "r1", wh)
    (tmp_path / "lnk").symlink_to(s)
    assert "STAGING_ROOT_IS_SYMLINK" in refuses(tool.build_release, repo, tmp_path / "lnk", "r2", wh)
    (repo / "IDEA3-AEGIS_Lockdown/stray.txt").write_text("x")
    assert "SOURCE_TREE_DIRTY" in refuses(tool.build_release, repo, s, "r3", wh)
    os.mkfifo(pkg / "pipe.py")
    assert "SOURCE_FIFO_REFUSED" in refuses(tool.build_release, repo, s, "r3", wh, allow_dirty=True)
    os.unlink(pkg / "pipe.py")
    (pkg / "lnk.py").symlink_to("/etc/hostname")
    assert "SOURCE_SYMLINK_REFUSED" in refuses(tool.build_release, repo, s, "r3", wh, allow_dirty=True)
    os.unlink(pkg / "lnk.py")
    monkeypatch.chdir(pkg)
    sock = socket.socket(socket.AF_UNIX); sock.bind("sk.py")
    try:
        assert "SOURCE_SOCKET_REFUSED" in refuses(tool.build_release, repo, s, "r3", wh, allow_dirty=True)
    finally:
        sock.close()
