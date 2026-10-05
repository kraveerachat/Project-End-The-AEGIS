"""Bootstrap authority: root never executes operator-mutable tool bytes and a root-owned snapshot never reads operator-mutable source. Privileged tools run FROM the trusted exact-main authority; the self-authority
check and the source-authority check are defence in depth that fail closed BEFORE any parse/read/scan. Hermetic: user namespace + test-only seam; nothing touches a real production path."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

import test_r1a_runner_freeze as rf
import test_r1a_stage as base

needs_userns = base.needs_userns


def run_snap(tmp_path: Path, tools: Path, kind: str, src: Path, dest: Path, *, seam_root: Path | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    seam = base.trust_seam(seam_root or tmp_path)
    return base.userns_bash(f'{seam}timeout {timeout} python3 -I -B "{tools}/r1a_verifier_snapshot.py" {kind} "{src}" "{dest}" --root-owned')


def trusted_world(tmp_path: Path) -> Path:
    """Everything under `tmp_path/trusted` is the trusted tree (the seam root is `tmp_path/trusted`)."""
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    return trusted


def tools_in(parent: Path) -> Path:
    d = parent / "tools"
    d.mkdir()
    shutil.copy(base.SNAPSHOT_TOOL, d / "r1a_verifier_snapshot.py")
    shutil.copy(base.P4 / "r1a-acceptance/r1a_runner_freeze.py", d / "r1a_runner_freeze.py")
    return d


def small_src(parent: Path) -> Path:
    """A trusted COPY of the real verifier source package (the entry module must exist)."""
    dest = parent / "src"
    shutil.copytree(base.ROOT / "aegis_soc", dest / "aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
    return dest


# ---- I1: tool authority ----
@needs_userns
def test_tool_outside_the_trusted_tree_is_refused_before_any_output(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    src = small_src(trusted)
    tools = tools_in(tmp_path)  # operator-mutable location: NOT under the trusted root
    out = trusted / "snap"
    r = run_snap(tmp_path, tools, "snapshot", src, out, seam_root=trusted)
    assert r.returncode == 1 and "TOOL_AUTHORITY_NOT_TRUSTED" in r.stderr, r.stderr
    assert not out.exists()


@needs_userns
def test_tool_in_the_trusted_tree_runs(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    r = run_snap(tmp_path, tools_in(trusted), "snapshot", small_src(trusted), trusted / "snap", seam_root=trusted)
    assert r.returncode == 0, r.stderr
    assert (trusted / "snap").is_dir()


@needs_userns
def test_a_writable_tool_ancestor_or_dir_is_refused(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    src, tools = small_src(trusted), tools_in(trusted)
    tools.chmod(0o777)
    r = run_snap(tmp_path, tools, "snapshot", src, trusted / "snap", seam_root=trusted)
    assert r.returncode == 1 and "TOOL_AUTHORITY_NOT_TRUSTED" in r.stderr and "WRITABLE" in r.stderr, r.stderr
    assert not (trusted / "snap").exists()


@needs_userns
def test_a_symlinked_tool_authority_path_is_refused(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    src, tools = small_src(trusted), tools_in(trusted)
    link = trusted / "tools-link"
    link.symlink_to(tools)
    r = run_snap(tmp_path, link, "snapshot", src, trusted / "snap", seam_root=trusted)
    assert r.returncode == 1 and "TOOL_AUTHORITY" in r.stderr, r.stderr
    assert not (trusted / "snap").exists()


@needs_userns
def test_an_untrusted_or_symlinked_sibling_tool_is_refused(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    repo, main = rf.make_repo(tmp_path)
    tools = trusted / "tools"
    tools.mkdir()
    shutil.copy(base.P4 / "r1a-acceptance/r1a_runner_freeze.py", tools / "r1a_runner_freeze.py")
    evil = tmp_path / "evil"
    evil.mkdir()
    shutil.copy(base.SNAPSHOT_TOOL, evil / "r1a_verifier_snapshot.py")
    (tools / "r1a_verifier_snapshot.py").symlink_to(evil / "r1a_verifier_snapshot.py")  # sibling resolves OUTSIDE the tool directory
    out = trusted / "frozen.sh"
    r = rf.tuserns(f'python3 -I -B "{tools}/r1a_runner_freeze.py" freeze --repo "{repo}" --main {main} --pins "{rf.pins_file(tmp_path, main)}" --out "{out}" --root-owned', trusted)
    assert r.returncode == 1 and "SIBLING_TOOL_NOT_IN_THE_SAME_AUTHORITY_DIRECTORY" in r.stderr, r.stderr
    assert not out.exists()


def test_the_authority_gate_runs_before_the_template_is_read() -> None:
    text = (base.P4 / "r1a-acceptance/r1a_runner_freeze.py").read_text()
    body = text[text.index("def freeze("):]
    assert body.index("_prove_privileged_authority(") < body.index("read_template(")
    snap = base.SNAPSHOT_TOOL.read_text()
    for fn in ("def snapshot(", "def control_snapshot("):
        b = snap[snap.index(fn):]
        assert b.index("_prove_privileged_inputs(") < max(b.index("closure(") if fn == "def snapshot(" else 0, b.index("control_files(") if fn != "def snapshot(" else 0)


# ---- I2: source authority ----
@needs_userns
def test_untrusted_source_is_refused_before_parse_read_or_scan(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    tools = tools_in(trusted)
    evil = tmp_path / "evil-src" / "aegis_soc"
    evil.mkdir(parents=True)
    (evil / "__init__.py").write_text("def broken(:\n")  # a parse of this would raise a SyntaxError-class failure
    out = trusted / "snap"
    r = run_snap(tmp_path, tools, "snapshot", evil.parent, out, seam_root=trusted)
    assert r.returncode == 1 and "SOURCE_NOT_TRUSTED" in r.stderr and "Syntax" not in r.stderr, r.stderr
    assert not out.exists()
    r2 = run_snap(tmp_path, tools, "control-snapshot", evil.parent, out, seam_root=trusted)
    assert r2.returncode == 1 and "SOURCE_NOT_TRUSTED" in r2.stderr and not out.exists(), r2.stderr


@needs_userns
def test_trusted_source_snapshots(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    r = run_snap(tmp_path, tools_in(trusted), "snapshot", small_src(trusted), trusted / "snap", seam_root=trusted)
    assert r.returncode == 0, r.stderr


@needs_userns
@pytest.mark.parametrize("kind", ["symlink", "fifo", "writable-file", "writable-dir"])
def test_source_entries_that_are_not_plain_root_owned_files_are_refused(tmp_path: Path, kind: str) -> None:
    trusted = trusted_world(tmp_path)
    tools = tools_in(trusted)
    src = small_src(trusted)
    pkg = src / "aegis_soc"
    if kind == "symlink":
        (pkg / "link.py").symlink_to(pkg / "__init__.py")
    elif kind == "fifo":
        os.mkfifo(pkg / "fifo.py")
    elif kind == "writable-file":
        (pkg / "__init__.py").chmod(0o666)
    else:
        pkg.chmod(0o777)
    out = trusted / "snap"
    r = run_snap(tmp_path, tools, "snapshot", src, out, seam_root=trusted, timeout=20)  # a FIFO must be refused, never opened (no hang)
    assert r.returncode == 1 and "SOURCE_NOT_TRUSTED" in r.stderr, (r.returncode, r.stderr)
    assert not out.exists()


@needs_userns
def test_a_non_root_owned_entry_is_refused_by_the_ownership_check(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    src = small_src(trusted)
    code = (f"import sys; sys.path.insert(0, '{tools_in(trusted)}'); import r1a_verifier_snapshot as t; from pathlib import Path\n"
            f"try:\n    t.check_tree_owner(Path('{src}'), 12345)\nexcept t.SnapshotError as e:\n    print('REFUSED', e)\n")
    r = base.userns_bash(f'python3 -I -B -c "{code}"')
    assert "REFUSED" in r.stdout and "NOT_TRUSTED_OWNER" in r.stdout, (r.stdout, r.stderr)


@needs_userns
def test_the_privileged_read_helper_refuses_symlinks_and_special_files(tmp_path: Path) -> None:
    trusted = trusted_world(tmp_path)
    (trusted / "f").write_text("x")
    (trusted / "l").symlink_to(trusted / "f")
    os.mkfifo(trusted / "p")
    code = (f"import sys; sys.path.insert(0, '{tools_in(trusted)}'); import r1a_verifier_snapshot as t; from pathlib import Path\n"
            f"print(t.read_regular(Path('{trusted}/f')))\n"
            f"for n in ('l','p'):\n    try:\n        t.read_regular(Path('{trusted}/'+n))\n        print('READ', n)\n    except (t.SnapshotError, OSError) as e:\n        print('REFUSED', n)\n")
    r = base.userns_bash(f'timeout 20 python3 -I -B -c "{code}"')
    assert "b'x'" in r.stdout and "REFUSED l" in r.stdout and "REFUSED p" in r.stdout and "READ" not in r.stdout, (r.stdout, r.stderr)


# ---- M1: full-string pin validation ----
GOOD_SHA = "a" * 64


@pytest.mark.parametrize("bad", [GOOD_SHA + "\n", GOOD_SHA + "\r\n", " " + GOOD_SHA, GOOD_SHA + " ", "\t" + GOOD_SHA])
def test_sha256_pins_must_match_the_full_string(bad: str) -> None:
    assert rf.tool._SHA256.fullmatch(GOOD_SHA)
    assert not rf.tool._SHA256.fullmatch(bad)


@pytest.mark.parametrize("bad", ["/opt/x\n", "/opt/x\r\n", " /opt/x", "/opt/x ", "/opt/x\t"])
def test_path_pins_must_match_the_full_string(bad: str) -> None:
    assert rf.tool._PATH.fullmatch("/opt/x")
    assert not rf.tool._PATH.fullmatch(bad)


@pytest.mark.parametrize("suffix", ["\\n", "\\r\\n", " "])
def test_a_pin_with_trailing_newline_crlf_or_space_is_refused_before_write(tmp_path: Path, suffix: str) -> None:
    repo, main = rf.make_repo(tmp_path)
    import json
    pins = json.loads(rf.pins_file(tmp_path, main).read_text())
    key = next(k for k, v in pins.items() if isinstance(v, str) and len(v) == 64 and all(c in "0123456789abcdef" for c in v))
    raw = rf.pins_file(tmp_path, main).read_text().replace(f'"{pins[key]}"', f'"{pins[key]}{suffix}"', 1)
    pf = tmp_path / "bad-pins.json"
    pf.write_text(raw)
    out = tmp_path / "o.sh"
    r = rf.cli("freeze", "--repo", str(repo), "--main", main, "--pins", str(pf), "--out", str(out))
    assert r.returncode == 1 and not out.exists(), r.stderr


# ---- docs: one owner workflow ----
def _section17() -> str:
    readme = (base.P4 / "README.md").read_text()
    return readme[readme.index("## 17. Stage R1A — pre-live hardening"):]


def test_docs_run_every_privileged_python_only_from_the_root_owned_authority_with_isolated_system_python() -> None:
    import re

    sec = _section17()
    privileged = re.findall(r"`(sudo [^`]*r1a_[a-z_]+\.py[^`]*)`", sec)
    assert len(privileged) == 3
    for cmd in privileged:
        assert cmd.startswith("sudo /usr/bin/python3 -I -B /opt/aegis-idea3-r1a-authority/source-<EXPECTED_MAIN>/"), cmd
    assert not re.search(r"sudo python3 r1a_", sec)


def test_docs_phase_a_names_only_system_executables_and_the_proof_lines() -> None:
    sec = _section17()
    phase_a = sec[sec.index("**PHASE A"):sec.index("**PHASE B")]
    for line in ("ROOT_OWNED_EXACT_MAIN_AUTHORITY=PASS", "AUTHORITY_MAIN=<sha>", "AUTHORITY_HEAD_MATCH=PASS", "AUTHORITY_ROOT_OWNED=PASS", "AUTHORITY_NONWRITABLE_TO_OPERATOR=PASS", "AUTHORITY_TRUSTED_ANCESTORS=PASS"):
        assert line in phase_a, line
    assert "/usr/bin/git" in phase_a and "no repository script or Python runs as root" in phase_a and "GIT_NO_REPLACE_OBJECTS=1" in phase_a
    assert ".sh" not in phase_a and "r1a_" not in phase_a  # no repository tool is invoked in Phase A
    phase_c = sec[sec.index("**PHASE C"):sec.index("**What the tools enforce")]
    for line in ("CONTROL_SNAPSHOT=PASS", "VERIFIER_SNAPSHOT=PASS", "RUNNER_TEMPLATE_AUTHORITY=PASS", "RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS", "RUNNER_ROOT_OWNED=PASS", "RUNNER_NONWRITABLE=PASS", "RUNNER_SHA256=<digest>"):
        assert line in phase_c, line


def test_the_tools_state_they_run_isolated_and_self_check_is_defence_in_depth_only() -> None:
    sec = _section17()
    assert "does NOT replace Phase A" in sec or "do NOT replace Phase A" in sec
    assert "re.fullmatch" in sec and "CRLF" in sec
