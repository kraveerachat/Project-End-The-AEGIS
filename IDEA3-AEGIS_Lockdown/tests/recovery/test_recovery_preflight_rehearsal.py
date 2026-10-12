"""Hermetic tests of the Recovery NON-CONSUMING pre-live rehearsal (builder, entry point, driver library and read-only privilege wrapper).

Nothing here runs Recovery or touches Production: the canonical governance directory is a TEST-ONLY seam under a temporary directory, `sudo` is a recording stub, the release CLI is a
stub script, and the pre-gates are stubs or the real read-only functions driven against temporary files. A rehearsal PASS asserted here never means authorization.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import recovery_support as sup  # noqa: E402

ACC = sup.P4 / "recovery-acceptance"
DRIVER = ACC / "recovery_preflight_rehearsal.sh"
BUILDER = ACC / "recovery_rehearsal_build.py"
ENTRY = ACC / "recovery-preflight-rehearse.sh"
LIB = sup.LIB
REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
FROZEN_SHA = "ab" * 32
TAIL_MARK = "\nif recovery_run_attempt; then\n"

freeze = sup.load_tool(ACC / "recovery_runner_freeze.py", "rehearsal_test_freeze")
build = sup.load_tool(BUILDER, "rehearsal_test_build")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------- a temp exact-main repository holding the real Phase 4 tree


class World:
    def __init__(self, tmp: Path, *, with_driver: bool = True) -> None:
        self.tmp = tmp
        tmp.chmod(0o700)
        self.repo = tmp / "repo"
        shutil.copytree(sup.P4, self.repo / REL, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        if not with_driver:
            (self.repo / REL / "recovery-acceptance" / "recovery_preflight_rehearsal.sh").unlink()
        subprocess.run(["git", "-C", str(self.repo), "init", "-q"], check=True)
        self.main = sup.commit_all(self.repo)
        self.tool_dir = self.repo / REL / "recovery-acceptance"
        pins = dict(sup.PINS)
        pins.update(EXPECTED_MAIN=self.main, REPO=str(self.repo), PY="/usr/bin/python3", EVIDENCE_ROOT=str(tmp / "evidence"),
                    CTU_LIVE_RECEIPT_RELATIVE="/ctu-live-receipt.md", CTV_LIVE_RECEIPT_RELATIVE="Obsidian/x/ctv.md")
        self.pins = pins
        self.frozen = tmp / "frozen.sh"
        self.frozen_text = freeze.render(freeze.read_template(self.repo, self.main), pins)
        self.frozen.write_text(self.frozen_text)
        self.frozen.chmod(0o555)
        self.auth = tmp / "auth"
        self.auth.mkdir()

    def out_dir(self, name: str | None = None) -> Path:
        self.counter = getattr(self, "counter", 0) + 1
        path = self.tmp / (name or f"out{self.counter}")
        path.mkdir(mode=0o700)
        path.chmod(0o700)
        return path

    def build(self, *, frozen: Path | None = None, out: Path | None = None, repo: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(BUILDER), "--repo", str(repo or self.repo), "--frozen", str(frozen or self.frozen), "--out-dir", str(out or self.out_dir())],
            text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"},
        )

    def entry(self, *, frozen: Path | None = None, reason: str = "rehearsal reason", env: dict[str, str] | None = None, tool: Path | None = None) -> subprocess.CompletedProcess[str]:
        script = (tool or self.tool_dir) / "recovery-preflight-rehearse.sh"
        return subprocess.run(["sh", str(script), str(frozen or self.frozen), str(self.repo), str(self.auth), reason], text=True, capture_output=True,
                              env={"PATH": "/usr/bin:/bin", **(env or {})})

    def remain(self) -> None:
        """Commit working-tree edits to the exact-main repository and re-render the frozen runner for the new main."""
        self.main = sup.commit_all(self.repo)
        self.pins["EXPECTED_MAIN"] = self.main
        self.frozen_text = freeze.render(freeze.read_template(self.repo, self.main), self.pins)
        self.frozen.chmod(0o755)
        self.frozen.write_text(self.frozen_text)
        self.frozen.chmod(0o555)

    def retemplate(self, edit) -> None:
        """Change the REVIEWED template in the exact-main repository (a future template edit), commit it, and re-render the frozen runner from it."""
        template = self.repo / REL / "owner-run" / "run-recovery-owner.sh"
        template.write_text(edit(template.read_text()))
        self.main = sup.commit_all(self.repo)
        self.pins["EXPECTED_MAIN"] = self.main
        self.frozen_text = freeze.render(freeze.read_template(self.repo, self.main), self.pins)
        self.frozen.chmod(0o755)
        self.frozen.write_text(self.frozen_text)
        self.frozen.chmod(0o555)


@pytest.fixture()
def world(tmp_path: Path) -> World:
    return World(tmp_path)


def tmp_rehearsal_dirs() -> set[str]:
    return {p.name for p in Path("/tmp").glob("aegis-recovery-rehearsal*")}


# ═════════════════════════════════════════════ builder: a derived copy, the frozen runner untouched ═════════════════════════════════════════════
def test_the_derived_copy_is_the_frozen_prefix_plus_the_driver_and_the_frozen_runner_is_untouched(world: World) -> None:
    before = (sha(world.frozen), world.frozen.stat().st_mtime_ns, stat.S_IMODE(world.frozen.stat().st_mode))
    proc = world.build()
    assert proc.returncode == 0, proc.stderr
    facts = dict(line.split("=", 1) for line in proc.stdout.splitlines())
    derived = Path(facts["RECOVERY_REHEARSAL_DERIVED_PATH"])
    text = derived.read_text()
    cut = world.frozen_text.index(TAIL_MARK) + 1
    assert text.startswith(world.frozen_text[:cut])                                # every frozen line before the attempt block, byte for byte
    assert facts["RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256"] == before[0] == hashlib.sha256(world.frozen_text.encode()).hexdigest()
    assert f"RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256={before[0]}\n" in text       # the driver judges the FROZEN digest the Authorization names
    assert text.endswith("recovery_rehearse\nexit $?\n")
    assert not re.search(r"^\s*(if\s+)?recovery_run_attempt\b", text, re.M)       # the attempt call does not exist in the copy
    assert "RECOVERY_AUTOMATIC_RESULT_ONLY" not in text and "exit 0\nfi" not in text.split("REHEARSAL DRIVER", 1)[1]
    assert stat.S_IMODE(derived.stat().st_mode) == 0o500 and facts["RECOVERY_REHEARSAL_FROZEN_RUNNER_MODIFIED"] == "NO"
    assert (sha(world.frozen), world.frozen.stat().st_mtime_ns, stat.S_IMODE(world.frozen.stat().st_mode)) == before  # never modified, re-timed or re-moded
    assert text.split("REHEARSAL DRIVER", 1)[1].count("recovery_rehearse\n") == 1


def test_the_derived_copy_is_valid_bash_and_the_driver_call_is_the_last_thing_it_runs(world: World) -> None:
    proc = world.build()
    derived = Path(re.search(r"DERIVED_PATH=(.*)", proc.stdout).group(1))
    assert subprocess.run(["bash", "-n", str(derived)], capture_output=True).returncode == 0
    lines = [ln for ln in derived.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert lines[-2:] == ["recovery_rehearse", "exit $?"]


def test_the_driver_embedded_is_the_pinned_main_object_not_a_working_tree_file(world: World) -> None:
    (world.tool_dir / "recovery_preflight_rehearsal.sh").write_text("echo EVIL_WORKING_TREE_DRIVER\n")  # uncommitted edit
    proc = world.build()
    assert proc.returncode == 0, proc.stderr
    text = Path(re.search(r"DERIVED_PATH=(.*)", proc.stdout).group(1)).read_text()
    assert "EVIL_WORKING_TREE_DRIVER" not in text and "recovery_rehearse()" in text


@pytest.mark.parametrize("edit,reason", [
    (lambda t: t.replace('umask 077\n', 'umask 022\n', 1), "NOT_THE_REVIEWED_TEMPLATE"),                                    # a non-pin byte changed
    (lambda t: t.replace("exit 1\n", "exit 0\n") if t.endswith("exit 1\n") else t, "NOT_THE_REVIEWED_TEMPLATE"),            # tail verdict flipped
    (lambda t: t.replace("OPERATOR_UID=1000", "OPERATOR_UID=0"), "NOT_THE_REVIEWED_TEMPLATE|PIN_VALUE_REJECTED"),           # an invalid pin value
])
def test_a_frozen_runner_that_is_not_exactly_the_reviewed_template_is_refused(world: World, edit, reason: str) -> None:
    tampered = world.tmp / "tampered.sh"
    tampered.write_text(edit(world.frozen_text))
    proc = world.build(frozen=tampered)
    assert proc.returncode == 1 and re.search(reason, proc.stderr), proc.stderr


@pytest.mark.parametrize("edit,reason", [
    (lambda t: t + "echo appended after the attempt block\n", "ATTEMPT_BLOCK_NOT_THE_KNOWN_TAIL"),                    # something runs after the attempt block
    (lambda t: t.replace("fi\nexit 1\n", "fi\nexit 1\n\nif recovery_run_attempt; then\n  :\nfi\n"), "ATTEMPT_BLOCK_NOT_UNIQUE"),  # a second attempt block
    (lambda t: t.replace('  exit 0\nfi\nexit 1\n', '  exit 0\nfi\nrecovery_consume_attempt x\nexit 1\n'), "ATTEMPT_BLOCK_NOT_THE_KNOWN_TAIL"),
])
def test_a_future_template_whose_attempt_block_is_not_the_known_tail_is_refused_until_re_reviewed(world: World, edit, reason: str) -> None:
    world.retemplate(edit)  # the template ITSELF changed, so the freeze equivalence holds and only the tail guard can refuse
    proc = world.build()
    assert proc.returncode == 1 and reason in proc.stderr, proc.stderr


def test_a_symlinked_oversized_or_missing_frozen_runner_is_refused(world: World) -> None:
    link = world.tmp / "link.sh"
    link.symlink_to(world.frozen)
    assert "NOT_A_REGULAR_FILE" in world.build(frozen=link).stderr
    assert world.build(frozen=world.tmp / "absent.sh").returncode == 1
    big = world.tmp / "big.sh"
    big.write_text("#" * 1_000_001)
    assert "TOO_LARGE" in world.build(frozen=big).stderr


def test_a_driver_missing_from_the_pinned_main_makes_the_build_refuse(tmp_path: Path) -> None:
    proc = World(tmp_path, with_driver=False).build() if False else None
    w = World(tmp_path, with_driver=False)
    proc = w.build()
    assert proc.returncode == 1 and "REHEARSAL_DRIVER_NOT_IN_THE_PINNED_MAIN" in proc.stderr


@pytest.mark.parametrize("prepare,reason", [
    (lambda w: w.tmp.joinpath("loose").mkdir(mode=0o755) or w.tmp / "loose", "OUT_DIR_NOT_A_PRIVATE_OWN_DIRECTORY"),
    (lambda w: (w.tmp / "target").mkdir(mode=0o700) or (w.tmp / "linkdir").symlink_to(w.tmp / "target") or w.tmp / "linkdir", "OUT_DIR_NOT_A_PRIVATE_OWN_DIRECTORY"),
])
def test_the_output_directory_must_be_a_private_own_directory(world: World, prepare, reason: str) -> None:
    out = prepare(world)
    if out.is_dir() and not out.is_symlink():
        out.chmod(0o755)
    proc = world.build(out=out)
    assert proc.returncode == 1 and reason in proc.stderr


def test_the_output_is_created_exclusively_and_never_overwrites(world: World) -> None:
    out = world.out_dir()
    assert world.build(out=out).returncode == 0
    second = world.build(out=out)
    assert second.returncode == 1  # O_EXCL: an existing derived file is never overwritten


def test_relative_or_traversing_paths_are_refused(world: World) -> None:
    for frozen in ("frozen.sh", "/tmp/../etc/passwd"):
        proc = subprocess.run(["/usr/bin/python3", "-I", "-B", str(BUILDER), "--repo", str(world.repo), "--frozen", frozen, "--out-dir", str(world.out_dir(f"o{len(frozen)}"))],
                              text=True, capture_output=True)
        assert proc.returncode == 1 and "PATH_NOT_ABSOLUTE" in proc.stderr


# ═════════════════════════════════════════════ entry point ═════════════════════════════════════════════
def test_the_entry_point_refuses_an_environment_override_before_building_anything(world: World) -> None:
    before = tmp_rehearsal_dirs()
    # A caller who pre-sets the clean-start guard to skip the scrub still hits the override gate and is refused before anything is built.
    for var in ("PYTHONPATH", "LD_PRELOAD", "BASH_ENV", "TMPDIR", "RECOVERY_TEST_ONLY_CANONICAL_DIR", "AEGIS_P4_FS_ROOT"):
        proc = world.entry(env={"AEGIS_RECOVERY_REHEARSAL_CLEAN_START": "YES", var: "/x"})
        assert proc.returncode == 2 and f"ENVIRONMENT_OVERRIDE_SET:{var}" in proc.stderr, (var, proc.stderr)
    assert tmp_rehearsal_dirs() == before


def test_without_the_preset_guard_the_clean_start_silently_neutralises_overrides(world: World) -> None:
    proc = world.entry(env={"PYTHONPATH": "/evil", "LD_PRELOAD": "/evil.so", "BASH_ENV": "/evil.sh"})
    assert "ENVIRONMENT_OVERRIDE_SET" not in proc.stderr and "RECOVERY_REHEARSAL_BUILD=OK" in proc.stdout


def test_the_entry_point_refuses_a_dirty_worktree_and_a_wrong_head(world: World) -> None:
    before = tmp_rehearsal_dirs()
    (world.repo / "stray").write_text("x")
    assert "WORKTREE_NOT_CLEAN" in world.entry().stderr
    (world.repo / "stray").unlink()
    (world.repo / "other").write_text("y")
    sup.commit_all(world.repo)  # HEAD no longer equals the frozen EXPECTED_MAIN
    assert "WORKTREE_HEAD_NOT_THE_FROZEN_MAIN" in world.entry().stderr
    assert tmp_rehearsal_dirs() == before


@pytest.mark.parametrize("victim", ["recovery_rehearsal_build.py", "recovery_preflight_rehearsal.sh", "recovery_runner_freeze.py", "recovery_verifier_snapshot.py", "recovery-preflight-rehearse.sh"])
def test_a_tool_file_whose_bytes_differ_from_the_pinned_main_blob_is_refused_even_when_git_status_is_clean(world: World, victim: str) -> None:
    # `skip-worktree` hides the edit from `git status`, so only the per-file blob digest check can catch it (M1: a surviving mutant before)
    target = world.tool_dir / victim
    target.write_text(target.read_text() + "\n# local edit\n")
    subprocess.run(["git", "-C", str(world.repo), "update-index", "--skip-worktree", f"{REL}/recovery-acceptance/{victim}"], check=True)
    assert subprocess.run(["git", "-C", str(world.repo), "status", "--porcelain"], capture_output=True, text=True).stdout == ""
    proc = world.entry()
    assert proc.returncode == 2 and f"TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:{victim}" in proc.stderr, proc.stderr


@pytest.mark.skipif(not shutil.which("unshare") or subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode != 0, reason="user namespace unavailable")
def test_the_entry_point_refuses_to_run_as_root(world: World) -> None:
    script = world.tool_dir / "recovery-preflight-rehearse.sh"
    proc = subprocess.run(["unshare", "-r", "sh", str(script), str(world.frozen), str(world.repo), str(world.auth), "reason"], text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert proc.returncode == 2 and "RUN_AS_THE_OPERATOR_NOT_ROOT" in proc.stderr


def test_a_prefix_that_would_reach_the_attempt_call_before_the_tail_is_refused(world: World) -> None:
    # M1: a reviewed template that mentions/calls recovery_run_attempt BEFORE the final block must never be turned into a rehearsal copy
    world.retemplate(lambda t: t.replace("\nif recovery_run_attempt; then\n", "\n: recovery_run_attempt would be called here\nif recovery_run_attempt; then\n", 1))
    proc = world.build()
    assert proc.returncode == 1 and "ATTEMPT_CALL_REACHABLE_BEFORE_THE_TAIL" in proc.stderr, proc.stderr


def _swapping_builder(world: World) -> None:
    builder = world.tool_dir / "recovery_rehearsal_build.py"
    text = builder.read_text()
    marker = '    print("RECOVERY_REHEARSAL_BUILD=OK")'
    assert marker in text
    builder.write_text(text.replace(marker, '    os.chmod(target, 0o600)\n    open(target, "a").write("# swapped after the build\\n")\n' + marker, 1))
    world.remain()


def test_m2_a_derived_copy_that_changes_after_the_build_is_refused_before_it_runs(world: World) -> None:
    _swapping_builder(world)
    proc = world.entry()
    assert proc.returncode == 2 and "DERIVED_COPY_CHANGED_AFTER_THE_BUILD" in proc.stderr and "RECOVERY_REHEARSAL_STAGE" not in proc.stdout, proc.stderr


def test_m2_mutation_without_the_rehash_the_swapped_copy_would_run(world: World) -> None:
    _swapping_builder(world)
    entry = world.tool_dir / "recovery-preflight-rehearse.sh"
    text = entry.read_text()
    old = '[ "$(sha256sum -- "$derived" | cut -d\' \' -f1)" = "$want_derived_sha" ] && [ ! -L "$derived" ] || fail DERIVED_COPY_CHANGED_AFTER_THE_BUILD'
    assert old in text
    entry.write_text(text.replace(old, ":", 1))
    world.remain()
    proc = world.entry()
    assert "DERIVED_COPY_CHANGED_AFTER_THE_BUILD" not in proc.stderr and "RECOVERY_REHEARSAL_START=YES" in proc.stdout
def test_the_entry_point_must_run_from_the_pinned_worktree_with_group_unwritable_files(world: World) -> None:
    elsewhere = world.tmp / "elsewhere"
    shutil.copytree(world.tool_dir, elsewhere)
    assert "TOOL_NOT_RUN_FROM_THE_PINNED_WORKTREE" in world.entry(tool=elsewhere).stderr
    (world.tool_dir / "recovery_runner_freeze.py").chmod(0o666)
    assert "TOOL_FILE_UNTRUSTED:recovery_runner_freeze.py" in world.entry().stderr


def test_a_runner_prefix_refusal_never_reaches_the_driver_and_leaves_no_trace(world: World) -> None:
    # The pinned control snapshot does not exist, so the runner's own prefix refuses before sourcing anything or calling sudo.
    before = tmp_rehearsal_dirs()
    frozen_before = sha(world.frozen)
    proc = world.entry()
    assert proc.returncode == 2 and "DERIVED_COPY_REFUSED" not in proc.stderr or proc.returncode in (1, 2), proc.stderr
    assert "RECOVERY_REHEARSAL_STAGE" not in proc.stdout and "RECOVERY_REHEARSAL_RESULT=PREFLIGHT_PASS" not in proc.stdout
    assert "RECOVERY_REHEARSAL_START=YES" in proc.stdout and "RUNNER_PREFIX_REFUSED_BEFORE_THE_REHEARSAL_DRIVER" in proc.stdout + proc.stderr
    assert "RECOVERY_REHEARSAL_AUTHORIZES_RECOVERY=NO" in proc.stdout and "RECOVERY_ATTEMPT_CONSUMED_BY_REHEARSAL=NO" in proc.stdout
    assert tmp_rehearsal_dirs() == before and sha(world.frozen) == frozen_before


def test_the_unpinned_committed_template_cannot_be_rehearsed(world: World) -> None:
    template = world.tmp / "template.sh"
    template.write_text((sup.P4 / "owner-run/run-recovery-owner.sh").read_text())
    proc = world.build(frozen=template)
    assert proc.returncode == 1 and "NOT_THE_REVIEWED_TEMPLATE" in proc.stderr or "PIN" in proc.stderr
