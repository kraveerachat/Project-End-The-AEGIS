"""Snapshot freeze path authority: BOTH production builders (`snapshot` for the verifier closure, `control-snapshot` for the shell control plane) prove the destination path BEFORE root creates anything, and the
production trust root of all four commands is the literal `/` with no CLI option and only a guarded, user-namespace-only test seam. Hermetic tests run inside a user namespace (the invoking user's files appear as
uid 0) with the explicit TEST seam; nothing here touches a real production path."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

import recovery_support as base

TOOL_PATH = base.SNAPSHOT_TOOL
spec = spec_from_file_location("recovery_snapshot_tool_freeze", TOOL_PATH)
tool = module_from_spec(spec)
sys.modules["recovery_snapshot_tool_freeze"] = tool
spec.loader.exec_module(tool)

needs_userns = base.needs_userns
# (command, source, check command, manifest name) for the two production builders
BUILDERS = [
    pytest.param("snapshot", base.ROOT, "check", "RECOVERY-VERIFIER-SHA256SUMS", id="verifier-snapshot"),
    pytest.param("control-snapshot", base.P4, "control-check", "RECOVERY-CONTROL-SHA256SUMS", id="control-snapshot"),
]


def build(kind: str, src: Path, dest: "Path | str", trust: Path | None, *, extra: str = "--root-owned") -> subprocess.CompletedProcess[str]:
    """A root-owned build the way production runs it: the TOOL (a copy of both files) and the SOURCE both sit in the trusted temp tree; only the DESTINATION is varied by the tests."""
    tmp = trust.parent if trust is not None else Path("/nonexistent")
    tools = base.authority_tools(tmp)
    source = base.copy_verifier_src(tmp) if kind == "snapshot" else base.copy_control_src(tmp)
    seam = base.trust_seam(tmp)
    return base.userns_bash(f'{seam}python3 -I -B "{tools}/recovery_verifier_snapshot.py" {kind} "{source}" "{dest}" {extra}')


def tree(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*")) if root.exists() else []


# --- A: pre-write refusals (nothing is created anywhere) -----------------------------------------------------------------------------------------------


@needs_userns
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_a_symlinked_parent_or_symlinked_ancestor_is_refused_before_any_file_is_created(tmp_path: Path, kind, src, check, manifest) -> None:
    trusted = tmp_path / "trusted"
    real = trusted / "real"
    (real / "inner").mkdir(parents=True)
    (trusted / "link").symlink_to(real)
    refused = build(kind, src, trusted / "link" / "out", trusted)
    assert refused.returncode == 1 and "DEST_PARENT_MISSING_OR_SYMLINK" in refused.stderr, refused.stderr
    assert tree(real) == ["inner"] and not (real / "out").exists()  # nothing was created at the symlink target
    (trusted / "mid").symlink_to(real)  # the parent is a real directory but the PATH traverses a symlink
    deep = build(kind, src, trusted / "mid" / "inner" / "out", trusted)
    assert deep.returncode == 1 and "DEST_PARENT_NOT_TRUSTED" in deep.stderr and "NOT_CANONICAL" in deep.stderr, deep.stderr
    assert tree(real) == ["inner"]


@needs_userns
def test_a_parent_owned_by_another_uid_is_refused_before_create(tmp_path: Path) -> None:
    """`_begin_destination` is the shared destination gate of both builders; /usr/share is owned by the REAL root, so inside the user namespace it appears as another (nobody) uid."""
    target = Path("/usr/share/recovery-snapshot-must-never-exist")
    code = (f"import sys; sys.path.insert(0, '{base.authority_tools(tmp_path)}'); import recovery_verifier_snapshot as t; from pathlib import Path\n"
            f"try:\n    t._begin_destination(Path('{target}'), True, '/usr/share')\nexcept t.SnapshotError as e:\n    print('REFUSED', e)\n")
    result = base.userns_bash(f'python3 -I -B -c "{code}"')
    assert "REFUSED DEST_PARENT_NOT_TRUSTED" in result.stdout and "NOT_TRUSTED_OWNER" in result.stdout, (result.stdout, result.stderr)
    assert not target.exists()


@needs_userns
@pytest.mark.parametrize("mode", [0o775, 0o777])
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_a_group_or_world_writable_parent_is_refused_before_create(tmp_path: Path, kind, src, check, manifest, mode: int) -> None:
    trusted = tmp_path / "trusted"
    inner = trusted / "inner"
    inner.mkdir(parents=True)
    inner.chmod(mode)
    refused = build(kind, src, inner / "out", trusted)
    assert refused.returncode == 1 and "DEST_PARENT_NOT_TRUSTED" in refused.stderr and "WRITABLE" in refused.stderr, refused.stderr
    assert tree(trusted) == ["inner"]


@needs_userns
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_a_missing_parent_is_never_auto_created(tmp_path: Path, kind, src, check, manifest) -> None:
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    refused = build(kind, src, trusted / "authority" / "out", trusted)
    assert refused.returncode == 1 and "DEST_PARENT_MISSING_OR_SYMLINK" in refused.stderr
    assert tree(trusted) == []  # no parents=True: the authority parent must already exist


@needs_userns
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_an_existing_or_dangling_destination_is_refused_and_left_untouched(tmp_path: Path, kind, src, check, manifest) -> None:
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    existing = trusted / "out"
    existing.mkdir()
    (existing / "owner-kept.txt").write_text("keep\n")
    before = (existing / "owner-kept.txt").stat().st_mtime_ns
    kept = build(kind, src, existing, trusted)
    assert kept.returncode == 1 and "DEST_EXISTS" in kept.stderr
    assert tree(existing) == ["owner-kept.txt"] and (existing / "owner-kept.txt").read_text() == "keep\n" and (existing / "owner-kept.txt").stat().st_mtime_ns == before
    dangling = trusted / "dangling"
    dangling.symlink_to(trusted / "target-must-not-appear")
    refused = build(kind, src, dangling, trusted)
    assert refused.returncode == 1 and "DEST_EXISTS" in refused.stderr and not (trusted / "target-must-not-appear").exists()


@needs_userns
@pytest.mark.parametrize("bad", ["relative-out", "./trusted-rel", "TRUSTED/./out", "TRUSTED//out", "TRUSTED/sub/../out"])
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_a_destination_that_is_not_absolute_and_canonical_is_refused_before_create(tmp_path: Path, kind, src, check, manifest, bad: str) -> None:
    trusted = tmp_path / "trusted"
    (trusted / "sub").mkdir(parents=True)
    dest = bad.replace("TRUSTED", str(trusted))
    refused = build(kind, src, dest, trusted)  # the RAW text reaches the CLI (a Path would normalise `.` and `//` away)
    assert refused.returncode == 1 and "DEST_NOT_ABSOLUTE_AND_CANONICAL" in refused.stderr, refused.stderr
    assert tree(trusted) == ["sub"]


@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_without_root_a_root_owned_snapshot_is_refused_before_create(tmp_path: Path, kind, src, check, manifest) -> None:
    refused = subprocess.run([sys.executable, str(TOOL_PATH), kind, str(src), str(tmp_path / "out"), "--root-owned"], capture_output=True, text=True)
    assert refused.returncode == 1 and "ROOT_REQUIRED_FOR_ROOT_OWNED_SNAPSHOT" in refused.stderr and not (tmp_path / "out").exists()


# --- B: success and post-create verification ---------------------------------------------------------------------------------------------------------


@needs_userns
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_a_canonical_root_owned_parent_succeeds_and_the_full_check_runs_after_creation(tmp_path: Path, kind, src, check, manifest) -> None:
    trusted = tmp_path / "trusted"
    (trusted / "authority").mkdir(parents=True)
    dest = trusted / "authority" / "snap"
    built = build(kind, src, dest, trusted)
    assert built.returncode == 0, built.stderr
    sha = re.search(r"=([0-9a-f]{64})", built.stdout).group(1)
    assert sha == hashlib.sha256((dest / manifest).read_bytes()).hexdigest()  # the printed digest is the digest of the manifest file
    again = base.userns_bash(f'{base.trust_seam(trusted)}python3 "{TOOL_PATH}" {check} "{dest}" {sha}')
    assert again.returncode == 0 and "PASS" in again.stdout, again.stderr
    for line in (dest / manifest).read_text().splitlines():  # manifest meaning unchanged: sha256 + two spaces + relative path, every digest is the file's
        digest, rel = line.split("  ", 1)
        assert hashlib.sha256((dest / rel).read_bytes()).hexdigest() == digest
    assert all(not (p.stat().st_mode & 0o222) for p in [dest, *dest.rglob("*")])


def test_the_post_create_verification_is_part_of_both_builders() -> None:
    text = TOOL_PATH.read_text()
    assert text.count("the full proof again, after creation") == 2
    for fn, checker in (("def snapshot(", "check("), ("def control_snapshot(", "control_check(")):
        body = text[text.index(fn):text.index("\ndef ", text.index(fn) + 5)]
        assert body.index("_install_root_owned(dest, trust_root)") < body.index(f"        {checker}dest") and "_begin_destination(dest, root_owned, trust_root)" in body
    begin = text[text.index("def _begin_destination("):text.index("def _install_root_owned(")]
    root_branch = begin[begin.index("if os.geteuid() != 0"):]
    assert "parents=True" not in root_branch and "dir_fd=fd" in root_branch and "os.O_NOFOLLOW" in root_branch  # no parents=True for production authority; fd-anchored creation


# --- C: the production trust root is the literal `/` -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("command", ["snapshot", "control-snapshot", "check", "control-check"])
def test_no_production_command_accepts_a_trust_root_option(tmp_path: Path, command: str) -> None:
    args = {"snapshot": [str(base.ROOT), str(tmp_path / "o")], "control-snapshot": [str(base.P4), str(tmp_path / "o")], "check": [str(tmp_path), "0" * 64], "control-check": [str(tmp_path), "0" * 64]}[command]
    result = subprocess.run([sys.executable, str(TOOL_PATH), command, *args, "--trust-root", str(tmp_path)], capture_output=True, text=True)
    assert result.returncode == 2 and "unrecognized arguments: --trust-root" in result.stderr
    assert not (tmp_path / "o").exists()
    assert "--trust-root" not in "\n".join(re.findall(r'add_argument\("(--[a-z-]+)"', TOOL_PATH.read_text()))


def test_the_default_trust_root_is_the_literal_slash(monkeypatch) -> None:
    for var in (tool.TEST_SEAM_ENABLED, tool.TEST_SEAM_ROOT):
        monkeypatch.delenv(var, raising=False)
    assert tool.trust_root() == "/" and tool.PRODUCTION_TRUST_ROOT == "/" and tool.PRODUCTION_OWNER_UID == 0


@needs_userns
@pytest.mark.parametrize("check", ["check", "control-check"])
def test_the_production_check_reaches_slash_and_fails_on_untrusted_ancestors_without_the_seam(tmp_path: Path, check: str) -> None:
    kind = "snapshot" if check == "check" else "control-snapshot"
    src = base.ROOT if check == "check" else base.P4
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    built = build(kind, src, trusted / "snap", trusted)
    assert built.returncode == 0, built.stderr
    sha = re.search(r"=([0-9a-f]{64})", built.stdout).group(1)
    live = base.userns_bash(f'python3 "{TOOL_PATH}" {check} "{trusted / "snap"}" {sha}')  # NO seam: the chain is walked to `/`, whose ancestors are not uid 0 inside the namespace
    assert live.returncode == 1 and "ANCESTOR" in live.stderr, live.stderr


@pytest.mark.parametrize("env", [{"RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT": "/tmp"}, {"RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED": "YES"}, {"RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED": "yes", "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT": "/tmp"}])
def test_a_test_trust_root_without_the_enable_flag_or_half_set_is_refused(tmp_path: Path, env) -> None:
    result = subprocess.run([sys.executable, str(TOOL_PATH), "check", str(tmp_path), "0" * 64], env={**os.environ, **env}, capture_output=True, text=True)
    assert result.returncode == 1 and "TEST_TRUST_SEAM_INCOMPLETE" in result.stderr


def test_the_test_seam_is_refused_in_the_real_root_namespace(tmp_path: Path) -> None:
    env = {**os.environ, "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED": "YES", "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT": str(tmp_path)}
    result = subprocess.run([sys.executable, str(TOOL_PATH), "check", str(tmp_path), "0" * 64], env=env, capture_output=True, text=True)
    assert result.returncode == 1 and "TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE" in result.stderr
    assert tool._initial_user_namespace() is True


@needs_userns
def test_the_enabled_seam_works_in_a_user_namespace_and_a_malformed_root_is_refused(tmp_path: Path) -> None:
    ok = base.userns_bash(f'{base.trust_seam(tmp_path)}python3 -c "import sys; sys.path.insert(0, \'{TOOL_PATH.parent}\'); import recovery_verifier_snapshot as t; print(t.trust_root())"')
    assert ok.returncode == 0 and ok.stdout.strip() == str(tmp_path), ok.stderr
    for bad in ("relative/dir", "/tmp/../tmp", "/nonexistent-dir-xyz"):
        res = base.userns_bash(f'{base.trust_seam(Path(bad))}python3 -c "import sys; sys.path.insert(0, \'{TOOL_PATH.parent}\'); import recovery_verifier_snapshot as t; print(t.trust_root())"')
        assert res.returncode != 0 and "TEST_TRUST_SEAM_ROOT_INVALID" in res.stderr, bad


def test_the_library_and_the_runner_still_refuse_or_forward_the_test_seam_correctly() -> None:
    runner = "\n".join(base.code_lines(base.RUNNER))
    for var in ("RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ENABLED", "RECOVERY_TEST_ONLY_SNAPSHOT_TRUST_ROOT"):
        assert var in runner  # the frozen runner refuses to start with the snapshot trust seam set
    assert "--trust-root" not in "\n".join(base.code_lines(base.LIB)) + runner  # nothing in the live path passes a trust root


@needs_userns
@pytest.mark.parametrize("kind,src,check,manifest", BUILDERS)
def test_the_python_api_also_refuses_a_non_canonical_destination_before_create(tmp_path: Path, kind, src, check, manifest) -> None:
    """Second layer below the CLI's raw-text check: a Path keeps `..`, so a direct API call with a non-canonical destination must still be refused before anything is created."""
    trusted = tmp_path / "trusted"
    (trusted / "sub").mkdir(parents=True)
    fn = "snapshot" if kind == "snapshot" else "control_snapshot"
    source = base.copy_verifier_src(tmp_path) if kind == "snapshot" else base.copy_control_src(tmp_path)
    code = (f"import sys; sys.path.insert(0, '{base.authority_tools(tmp_path)}'); import recovery_verifier_snapshot as t; from pathlib import Path\n"
            f"try:\n    t.{fn}(Path('{source}'), Path('{trusted}/sub/../out'), root_owned=True, trust_root='{tmp_path}')\nexcept t.SnapshotError as e:\n    print('REFUSED', e)\n")
    result = base.userns_bash(f'{base.trust_seam(tmp_path)}python3 -I -B -c "{code}"')
    assert "REFUSED DEST_NOT_ABSOLUTE_AND_CANONICAL" in result.stdout, (result.stdout, result.stderr)
    assert tree(trusted) == ["sub"]
