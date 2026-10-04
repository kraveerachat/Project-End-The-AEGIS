"""Stage F1r (current-release activation, NO Core restart): repository implementation only, hermetic fixtures only.

F1r owns exactly one Production mutation: the atomic switch of ``/opt/aegis-idea3/current`` from a frozen OLD release to a frozen, ALREADY INSTALLED
NEW release (the repaired immutable release). Nothing here touches /opt, systemd, a service, the Core, the detector, an alert socket, an ESP32 or any real
release: the tool is driven through a fake host and a fake systemd world (the REAL allow-list stays in force) and the shell gates run on fixtures.
These tests prove REPOSITORY behavior only; no live F1r / L6c / F1 attempt-2 PASS is claimed.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
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
TOOL_PATH = DEPLOY / "p4-f1r-switch.py"
F1R_LIB = DEPLOY / "p4-f1r-run-lib.sh"
F1_LIB = DEPLOY / "p4-f1-run-lib.sh"
F1R_RUNNER = DEPLOY / "owner-run" / "run-f1r-owner.sh"
F1_RUNNER = DEPLOY / "owner-run" / "run-f1-owner.sh"
STAGE = DEPLOY / "stages" / "F1r"
GATE = DEPLOY / "p4-stage-gate.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
COMPARE = DEPLOY / "p4-compare.sh"
DETECTOR_SRC = ROOT / "aegis_soc" / "production_detector.py"
_REAL_RUN = subprocess.run

OLD = "55c7d18135142293267e8d1ea943d3639358d634"
NEW = "2107f1972f77d49b4d42ca7fef513148dc6b39ae"
NEW_SRC = NEW
OPT = "/opt/aegis-idea3"
CURRENT = f"{OPT}/current"
OLD_PATH = f"{OPT}/releases/{OLD}"
NEW_PATH = f"{OPT}/releases/{NEW}"
DET_BYTES = b"# repaired production_detector (fixture bytes)\nEXIT_JOURNAL_SOURCE_UNAVAILABLE = 3\n"
DET_SHA = hashlib.sha256(DET_BYTES).hexdigest()
REPAIRED_DETECTOR_SHA = "a91bcfc228c6e0892d019923b51b33d3545c685e2b5fed229f1ad8f980db9332"
CURRENT_KEY = "host.symlink./opt/aegis-idea3/current.target"


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_f1r_switch", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    """No real process may be started by the tool tests; shell/gate tests use ``_REAL_RUN`` captured at import."""
    def guarded(argv, *args, **kwargs):
        raise AssertionError(f"a real process must never be started by the F1r tool tests: {argv!r}")

    monkeypatch.setattr(subprocess, "run", guarded)


def code_only(path: Path) -> str:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def active_shell(path: Path) -> str:
    return "\n".join(line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#"))


def refusal(fn, *args, **kwargs) -> str:
    with pytest.raises(tool.Refusal) as exc:
        fn(*args, **kwargs)
    return str(exc.value)


# ═══ fake world ══════════════════════════════════════════════════════════════════════════════════════════════════════════════


def manifest(release_id=NEW, source=NEW_SRC, dirty=False) -> bytes:
    return json.dumps({"release_id": release_id, "source_git_sha": source, "source_tree_dirty": dirty, "schema_version": 1}).encode()


class World:
    def __init__(self, *, core_pid="4242", core_restarts="0", detector_load="not-found", detector_active="inactive", detector_pid="0"):
        self.core = {"ActiveState": "active", "SubState": "running", "MainPID": core_pid, "NRestarts": core_restarts}
        self.detector = {"LoadState": detector_load, "ActiveState": detector_active, "MainPID": detector_pid}
        self.events: list[str] = []


class FakeHost(tool.F1rHost):
    def __init__(self, world: World, *, current_target=OLD_PATH, new_manifest=None, det_bytes=DET_BYTES, guard=None, core_cwd=OLD_PATH, det_symlink=False,
                 detector_procs=(), deny_reads=False):
        self.world = world
        self.detector_procs = list(detector_procs)  # standalone `python -m aegis_soc.production_detector` processes (the systemd unit stays not-found)
        self.deny_reads = deny_reads
        self.links = {CURRENT: current_target}
        self.files = {f"{OLD_PATH}/RELEASE-MANIFEST.json": manifest(OLD, OLD), f"{NEW_PATH}/RELEASE-MANIFEST.json": new_manifest or manifest(),
                      f"{NEW_PATH}/aegis_soc/production_detector.py": det_bytes}
        self.symlink_files = {f"{NEW_PATH}/aegis_soc/production_detector.py"} if det_symlink else set()
        self.dirs = {OPT, f"{OPT}/releases", OLD_PATH, NEW_PATH}
        self.guard = {OLD_PATH: (OLD, OLD), NEW_PATH: (NEW, NEW_SRC)} if guard is None else guard
        self.core_cwd = core_cwd
        self.ops: list[tuple[str, ...]] = []
        self.snapshots: list[bool] = []  # after each mutating op: does `current` still exist as a symlink?

    def _snap(self):
        self.snapshots.append(CURRENT in self.links)

    def is_symlink(self, path):
        if self.deny_reads:
            raise tool.Refusal("HOST_READ_DENIED")
        return path in self.links or path in self.symlink_files

    def detector_processes(self):
        return list(self.detector_procs)

    def readlink(self, path):
        return self.links[path]

    def lexists(self, path):
        return path in self.links or path in self.files or path in self.dirs

    def is_regular(self, path):
        return path in self.files and path not in self.symlink_files

    def read_bytes(self, path):
        return self.files[path]

    def sha256_file(self, path):
        return hashlib.sha256(self.files[path]).hexdigest()

    def realpath(self, path):
        seen = path
        while seen in self.links:
            seen = self.links[seen]
        return seen

    def symlink(self, target, path):
        if path in self.links:
            raise FileExistsError(path)
        self.ops.append(("symlink", target, path))
        self.links[path] = target
        self._snap()

    def replace(self, src, dst):
        self.ops.append(("replace", src, dst))
        self.links[dst] = self.links.pop(src)  # one step: `current` is never absent
        self._snap()

    def unlink(self, path):
        self.ops.append(("unlink", path))
        del self.links[path]
        self._snap()

    def fsync_dir(self, path):
        self.ops.append(("fsync_dir", path))

    def proc_cwd(self, pid):
        return self.core_cwd

    def release_guard(self, logical, host_path):
        if logical not in self.guard:
            raise tool.Refusal("RELEASE_GUARD:RELEASE_MISSING")
        result = self.guard[logical]
        if isinstance(result, str):
            raise tool.Refusal(f"RELEASE_GUARD:{result}")
        return result


class FakeBackend(tool.F1rBackend):
    def __init__(self, world: World):
        super().__init__()
        self.world = world

    def _run(self, args):
        wanted = [a[2:] for a in args[2:]]
        src = self.world.core if args[1] == tool.CORE_UNIT else self.world.detector
        return tool.CommandResult(0, "".join(f"{k}={src[k]}\n" for k in wanted if k in src))


def build(tmp_path, **kw):
    world = World(**{k: kw.pop(k) for k in ("core_pid", "core_restarts", "detector_load", "detector_active", "detector_pid") if k in kw})
    host = FakeHost(world, **kw)
    work = tmp_path / "work"
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    return world, host, FakeBackend(world), work


def run_apply(host, backend, work, **over):
    args = {"old_id": OLD, "new_id": NEW, "source_sha": NEW_SRC, "detector_sha": DET_SHA, **over}
    return tool.apply(args["old_id"], args["new_id"], args["source_sha"], args["detector_sha"], work, host, backend)


def run_verify(host, backend, work, **over):
    args = {"old_id": OLD, "new_id": NEW, "source_sha": NEW_SRC, "detector_sha": DET_SHA, **over}
    return tool.verify(args["old_id"], args["new_id"], args["source_sha"], args["detector_sha"], work, host, backend)


def journal(work):
    return json.loads((work / tool.JOURNAL_NAME).read_text())


# ═══ preflight refusals: nothing is mutated and no journal exists ═════════════════════════════════════════════════════════════


def assert_untouched(host, world, work):
    assert host.links == {CURRENT: OLD_PATH} and host.ops == [] and not (work / tool.JOURNAL_NAME).exists()


def test_a_wrong_old_current_target_refuses_before_any_mutation(tmp_path):
    world, host, backend, work = build(tmp_path, current_target=f"{OPT}/releases/someone-else")
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_OLD_TARGET"
    assert host.links == {CURRENT: f"{OPT}/releases/someone-else"} and host.ops == [] and not (work / tool.JOURNAL_NAME).exists()


def test_current_that_is_not_a_symlink_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    del host.links[CURRENT]
    host.files[CURRENT] = b"a regular file"
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_A_SYMLINK"


def test_a_relative_or_equivalent_but_inexact_current_target_refuses(tmp_path):
    for target in (f"{OLD_PATH}/", f"{OPT}/releases/../releases/{OLD}", f"releases/{OLD}"):
        world, host, backend, work = build(tmp_path / str(abs(hash(target))), current_target=target)
        assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_OLD_TARGET"  # exact string equality, never "resolves to"


def test_a_missing_new_release_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, guard={OLD_PATH: (OLD, OLD)})
    assert refusal(run_apply, host, backend, work) == "RELEASE_GUARD:RELEASE_MISSING"
    assert_untouched(host, world, work)


@pytest.mark.parametrize("code", ["RELEASE_IS_SYMLINK", "SYMLINK_IN_RELEASE", "SPECIAL_FILE_IN_RELEASE", "NOT_ROOT_OWNED", "SHA256SUMS_MISMATCH", "MANIFEST_INVALID"])
def test_a_symlinked_or_malformed_or_unowned_new_release_refuses(tmp_path, code):
    world, host, backend, work = build(tmp_path, guard={OLD_PATH: (OLD, OLD), NEW_PATH: code})
    assert refusal(run_apply, host, backend, work) == f"RELEASE_GUARD:{code}"
    assert_untouched(host, world, work)


def test_a_missing_or_malformed_old_release_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, guard={NEW_PATH: (NEW, NEW_SRC)})
    assert refusal(run_apply, host, backend, work) == "OLD_RELEASE_INVALID:RELEASE_GUARD:RELEASE_MISSING"
    assert_untouched(host, world, work)


@pytest.mark.parametrize("bad", ["", "../x", "a/b", ".hidden", "x" * 129, "a b", "a;b"])
def test_malformed_release_ids_refuse(tmp_path, bad):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, new_id=bad) == "RELEASE_ID_INVALID"
    assert refusal(run_apply, host, backend, work, old_id=bad) == "RELEASE_ID_INVALID"


def test_old_and_new_must_be_distinct(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, new_id=OLD) == "RELEASE_IDS_NOT_DISTINCT"


def test_a_wrong_release_id_in_the_manifest_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, new_manifest=manifest(release_id=OLD))
    assert refusal(run_apply, host, backend, work) == "RELEASE_ID_MISMATCH"
    assert_untouched(host, world, work)


def test_the_guard_reporting_a_different_release_id_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, guard={OLD_PATH: (OLD, OLD), NEW_PATH: ("other-id", NEW_SRC)})
    assert refusal(run_apply, host, backend, work) == "RELEASE_ID_MISMATCH"


def test_a_wrong_source_sha_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, source_sha="1" * 40) == "RELEASE_SOURCE_SHA_MISMATCH"
    assert_untouched(host, world, work)
    world, host, backend, work = build(tmp_path / "m", new_manifest=manifest(source="1" * 40))
    assert refusal(run_apply, host, backend, work) == "RELEASE_SOURCE_SHA_MISMATCH"


@pytest.mark.parametrize("sha", ["", "abc", "1" * 39, "1" * 41, "G" * 40, NEW_SRC.upper(), NEW_SRC + "\n"])
def test_a_malformed_source_sha_pin_refuses(tmp_path, sha):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, source_sha=sha) == "RELEASE_SOURCE_SHA_PIN_INVALID"


def test_a_dirty_release_manifest_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, new_manifest=manifest(dirty=True))
    assert refusal(run_apply, host, backend, work) == "RELEASE_SOURCE_TREE_DIRTY"
    assert_untouched(host, world, work)


def test_a_non_boolean_dirty_flag_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, new_manifest=json.dumps({"release_id": NEW, "source_git_sha": NEW_SRC, "source_tree_dirty": "false"}).encode())
    assert refusal(run_apply, host, backend, work) == "RELEASE_SOURCE_TREE_DIRTY"


def test_a_wrong_production_detector_sha_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, det_bytes=DET_BYTES + b"# tampered\n")
    assert refusal(run_apply, host, backend, work) == "DETECTOR_SHA256_MISMATCH"
    assert_untouched(host, world, work)


@pytest.mark.parametrize("pin", ["", "abc", "0" * 63, "0" * 65, DET_SHA.upper(), DET_SHA + "\n"])
def test_a_malformed_detector_digest_pin_refuses(tmp_path, pin):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, detector_sha=pin) == "DETECTOR_SHA256_PIN_INVALID"


def test_a_symlinked_or_missing_detector_file_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, det_symlink=True)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_FILE_INVALID"
    world, host, backend, work = build(tmp_path / "m")
    del host.files[f"{NEW_PATH}/aegis_soc/production_detector.py"]
    assert refusal(run_apply, host, backend, work) == "DETECTOR_FILE_INVALID"


@pytest.mark.parametrize("present", [
    {"detector_load": "loaded"}, {"detector_active": "active"}, {"detector_pid": "321"}, {"detector_load": "loaded", "detector_active": "failed"},
])
def test_a_detector_unit_or_process_already_present_refuses(tmp_path, present):
    world, host, backend, work = build(tmp_path, **present)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"
    assert_untouched(host, world, work)


@pytest.mark.parametrize("path", list(tool.DETECTOR_UNIT_PATHS))
def test_a_detector_unit_file_anywhere_refuses(tmp_path, path):
    world, host, backend, work = build(tmp_path)
    host.files[path] = b"[Unit]\n"
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"


@pytest.mark.parametrize("core", [{"ActiveState": "inactive"}, {"SubState": "dead"}, {"MainPID": "0"}, {"MainPID": "x"}, {"NRestarts": ""}])
def test_a_core_that_is_not_running_refuses(tmp_path, core):
    world, host, backend, work = build(tmp_path)
    world.core.update(core)
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_RUNNING"
    assert_untouched(host, world, work)


# ═══ apply: only `current` changes, atomically ═══════════════════════════════════════════════════════════════════════════════


def test_apply_changes_only_current_and_leaves_both_releases_untouched(tmp_path):
    world, host, backend, work = build(tmp_path)
    files_before, dirs_before = dict(host.files), set(host.dirs)
    out = run_apply(host, backend, work)
    assert out["F1R_APPLY"] == "COMPLETE" and out["CURRENT_TARGET"] == NEW_PATH and out["F1R_CORE_RESTARTED"] == "NO"
    assert host.links == {CURRENT: NEW_PATH}  # the only symlink is `current`, now the NEW target; the temp name is gone
    assert host.files == files_before and host.dirs == dirs_before  # neither immutable release was altered
    assert host.ops == [("symlink", NEW_PATH, tool.TMP_LINK), ("replace", tool.TMP_LINK, CURRENT), ("fsync_dir", OPT)]
    assert host.realpath(CURRENT) == NEW_PATH


def test_the_switch_is_atomic_current_is_never_absent_and_there_is_no_unlink_of_current(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert host.snapshots and all(host.snapshots)  # `current` existed after every mutating step
    assert ("unlink", CURRENT) not in host.ops
    code = code_only(TOOL_PATH)
    assert "os.replace(src, dst)" in code and "os.symlink(target, path)" in code
    for forbidden in ("os.remove", "shutil", "rmtree", "os.chmod", "os.chown", "os.rename", "os.system", "ln -", "os.mkdir", "os.makedirs", "os.truncate"):
        assert forbidden not in code, forbidden
    assert code.count("subprocess.run(") == 1 and "['systemctl', *args]" in code  # the ONLY process ever started is the allow-listed read-only `systemctl show`


def test_the_journal_records_the_exact_old_target_before_the_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    seen = []
    real = tool.write_journal

    def spy(path, data):
        seen.append((data["phase"], data["old_target"], len(host.ops)))
        return real(path, data)

    tool.write_journal = spy
    try:
        run_apply(host, backend, work)
    finally:
        tool.write_journal = real
    assert seen[0] == ("preflight", OLD_PATH, 0) and seen[1] == ("switching", OLD_PATH, 0)  # both journalled BEFORE any host operation
    assert seen[-1][0] == "switched" and journal(work)["switched"] is True
    assert journal(work)["old_target"] == OLD_PATH and journal(work)["new_target"] == NEW_PATH


def test_current_is_re_read_immediately_before_the_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.check_current
    calls = []

    def racing(h, old_id):
        calls.append(1)
        if len(calls) == 2:  # between preflight and the mutation another actor repoints `current`
            h.links[CURRENT] = f"{OPT}/releases/intruder"
        return real(h, old_id)

    tool.check_current = racing
    try:
        assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_OLD_TARGET"
    finally:
        tool.check_current = real
    assert host.ops == [] and host.links[CURRENT] == f"{OPT}/releases/intruder" and len(calls) == 2


def test_an_existing_temp_link_refuses_and_is_never_replaced(tmp_path):
    world, host, backend, work = build(tmp_path)
    host.links[tool.TMP_LINK] = "/somewhere"
    assert refusal(run_apply, host, backend, work) == "SWITCH_TEMP_EXISTS"
    assert host.links[tool.TMP_LINK] == "/somewhere" and host.links[CURRENT] == OLD_PATH


def test_a_second_apply_for_the_same_work_directory_is_refused(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert refusal(run_apply, host, backend, work) == "ATTEMPT_JOURNAL_ALREADY_EXISTS"


def test_a_post_switch_mismatch_is_refused_immediately(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = host.replace

    def wrong_replace(src, dst):
        real(src, dst)
        host.links[CURRENT] = f"{OPT}/releases/elsewhere"  # the world is not what the switch intended

    host.replace = wrong_replace
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_NEW_TARGET_AFTER_SWITCH"


# ═══ boundaries: no Core restart, no detector start, nothing but `show` ═════════════════════════════════════════════════════════


@pytest.mark.parametrize("verb", [("restart", tool.CORE_UNIT), ("start", tool.CORE_UNIT), ("stop", tool.CORE_UNIT), ("reload", tool.CORE_UNIT), ("daemon-reload",),
                                  ("try-restart", tool.CORE_UNIT), ("kill", tool.CORE_UNIT), ("start", tool.DETECTOR_UNIT), ("stop", tool.DETECTOR_UNIT),
                                  ("enable", tool.DETECTOR_UNIT), ("show", "ssh.service"), ("show", tool.CORE_UNIT, "Environment"), ("reset-failed", tool.CORE_UNIT)])
def test_the_privileged_backend_offers_only_show_of_the_core_and_detector_units(verb):
    assert refusal(tool.F1rBackend().systemctl, *verb) == "SYSTEMCTL_VERB_NOT_ALLOWED"


def test_apply_and_verify_issue_only_read_only_systemctl_show(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    run_verify(host, backend, work)
    assert backend.calls and all(call[0] == "show" for call in backend.calls)
    assert not [c for c in backend.calls if c[0] in ("restart", "start", "stop", "reload", "daemon-reload")]


def test_a_detector_start_is_impossible_from_f1r():
    code = code_only(TOOL_PATH)
    assert not re.search(r"""["'](start|stop|restart|reload|enable|daemon-reload|try-restart|kill)["']""", code.replace('"show"', ""))
    for path in (STAGE / "apply.sh", STAGE / "verify.sh", STAGE / "rollback.sh", F1R_RUNNER, F1R_LIB):
        assert not re.search(r"systemctl\s+(restart|start|stop|reload|enable|disable|daemon-reload|kill|mask)\b", active_shell(path)), path


# ═══ verify ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def test_verify_requires_the_exact_new_target_core_unchanged_and_the_detector_absent(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    out = run_verify(host, backend, work)
    assert out == {"F1R_VERIFY": "PASS", "CURRENT_TARGET": NEW_PATH, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": NEW_SRC,
                   "PRODUCTION_DETECTOR_SHA256": DET_SHA, "CORE_MAIN_PID_UNCHANGED": "YES", "CORE_N_RESTARTS_UNCHANGED": "YES", "CORE_CWD": "UNCHANGED",
                   "CORE_MOVED_TO_NEW_RELEASE": "NO", "DETECTOR_PRESENT": "NO"}


def test_verify_without_a_switched_journal_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_verify, host, backend, work) == "ATTEMPT_NOT_SWITCHED"


def test_a_core_pid_change_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["MainPID"] = "9999"
    assert refusal(run_verify, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"


def test_a_core_nrestarts_change_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["NRestarts"] = "1"
    assert refusal(run_verify, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"


def test_a_core_that_stopped_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["ActiveState"] = "inactive"
    assert refusal(run_verify, host, backend, work) == "CORE_NOT_RUNNING"


def test_a_readable_core_cwd_must_not_change_and_an_unreadable_one_is_recorded_not_required(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert journal(work)["core_cwd"] == OLD_PATH
    host.core_cwd = NEW_PATH
    assert refusal(run_verify, host, backend, work) == "CORE_CWD_CHANGED"
    world, host, backend, work = build(tmp_path / "u", core_cwd=None)
    run_apply(host, backend, work)
    assert journal(work)["core_cwd"] == "UNREADABLE"
    assert run_verify(host, backend, work)["CORE_CWD"] == "UNREADABLE"


def test_verify_refuses_when_current_is_not_exactly_the_new_target(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[CURRENT] = OLD_PATH
    assert refusal(run_verify, host, backend, work) == "CURRENT_NOT_NEW_TARGET"


def test_verify_refuses_a_detector_that_appeared_or_a_new_release_that_changed(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.detector.update(LoadState="loaded", ActiveState="active", MainPID="55")
    assert refusal(run_verify, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"
    world.detector.update(LoadState="not-found", ActiveState="inactive", MainPID="0")
    host.files[f"{NEW_PATH}/aegis_soc/production_detector.py"] += b"# changed after the switch\n"
    assert refusal(run_verify, host, backend, work) == "DETECTOR_SHA256_MISMATCH"


def test_verify_issues_no_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    ops_before = list(host.ops)
    run_verify(host, backend, work)
    assert host.ops == ops_before


# ═══ rollback: owned switch only, fail closed otherwise ════════════════════════════════════════════════════════════════════


def test_rollback_restores_the_exact_old_target_when_the_switch_is_owned(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    mark = len(host.ops)
    assert tool.rollback(work, host, FakeBackend(world)) == {"F1R_ROLLBACK": "PASS", "CURRENT_TARGET": OLD_PATH, "CORE_UNCHANGED": "YES", "DETECTOR_PRESENT": "NO"}
    assert host.links == {CURRENT: OLD_PATH} and host.realpath(CURRENT) == OLD_PATH
    assert host.ops[mark:] == [("symlink", OLD_PATH, tool.TMP_LINK), ("replace", tool.TMP_LINK, CURRENT), ("fsync_dir", OPT)]
    assert journal(work)["phase"] == "rolled_back" and all(host.snapshots)


def test_rollback_with_no_journal_or_before_any_switch_owns_nothing(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert tool.rollback(work, host, backend) == {"F1R_ROLLBACK": "NOTHING_OWNED"}
    refusal(run_apply, host, backend, work, new_id="not valid!")  # refused in preflight: no journal at all
    assert tool.rollback(work, host, backend) == {"F1R_ROLLBACK": "NOTHING_OWNED"} and host.ops == []


def test_rollback_after_a_crash_between_journal_and_switch_removes_only_its_own_temp(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = host.replace

    def crash(src, dst):
        raise OSError("simulated crash before the atomic replace")

    host.replace = crash
    with pytest.raises(tool.Refusal):
        run_apply(host, backend, work)
    assert journal(work)["phase"] == "switching" and host.links[tool.TMP_LINK] == NEW_PATH and host.links[CURRENT] == OLD_PATH
    host.replace = real
    assert tool.rollback(work, host, FakeBackend(world)) == {"F1R_ROLLBACK": "NOTHING_OWNED"}
    assert host.links == {CURRENT: OLD_PATH}


def test_rollback_after_a_crash_after_the_replace_restores_old(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.write_journal
    calls = []

    def crash_on_switched(path, data):
        calls.append(data["phase"])
        if data["phase"] == "switched":
            raise OSError("simulated crash after the replace, before the journal says so")
        return real(path, data)

    tool.write_journal = crash_on_switched
    try:
        with pytest.raises(tool.Refusal):
            run_apply(host, backend, work)
    finally:
        tool.write_journal = real
    assert host.links[CURRENT] == NEW_PATH and journal(work)["phase"] == "switching"
    assert tool.rollback(work, host, FakeBackend(world))["F1R_ROLLBACK"] == "PASS" and host.links == {CURRENT: OLD_PATH}


def test_rollback_refuses_before_any_mutation_if_another_actor_changed_current(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[CURRENT] = f"{OPT}/releases/intruder"
    mark = len(host.ops)
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT"
    assert host.ops[mark:] == [] and host.links[CURRENT] == f"{OPT}/releases/intruder"  # left exactly as found, for the owner


def test_rollback_refuses_if_current_was_already_restored_to_old_by_someone_else(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[CURRENT] = OLD_PATH
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT"


def test_rollback_refuses_if_current_is_not_a_symlink_or_the_temp_exists(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[tool.TMP_LINK] = "/x"
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "SWITCH_TEMP_EXISTS"
    del host.links[tool.TMP_LINK]
    del host.links[CURRENT]
    host.files[CURRENT] = b"regular"
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "CURRENT_NOT_A_SYMLINK"


def test_rollback_never_deletes_or_alters_either_release(tmp_path):
    world, host, backend, work = build(tmp_path)
    files_before, dirs_before = dict(host.files), set(host.dirs)
    run_apply(host, backend, work)
    tool.rollback(work, host, FakeBackend(world))
    assert host.files == files_before and host.dirs == dirs_before
    assert [op for op in host.ops if op[0] == "unlink"] == []  # no unlink at all: both switches are `replace` over `current`


def test_rollback_reports_core_drift_and_a_present_detector_after_restoring(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["MainPID"] = "7777"
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "CORE_DRIFT_DURING_ROLLBACK"
    assert host.links == {CURRENT: OLD_PATH} and journal(work)["phase"] == "rolled_back"  # restored first, then the drift is escalated
    world, host, backend, work = build(tmp_path / "d")
    run_apply(host, backend, work)
    world.detector.update(LoadState="loaded", MainPID="9")
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"


def test_a_second_rollback_is_a_safe_noop(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    tool.rollback(work, host, FakeBackend(world))
    assert tool.rollback(work, host, FakeBackend(world)) == {"F1R_ROLLBACK": "ALREADY_ROLLED_BACK"}


def test_a_corrupt_or_foreign_journal_fails_closed(tmp_path):
    world, host, backend, work = build(tmp_path)
    (work / tool.JOURNAL_NAME).write_text("not json")
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNREADABLE"
    (work / tool.JOURNAL_NAME).write_text(json.dumps({"stage": "F1", "phase": "switched"}))
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNEXPECTED"


def test_the_cli_refuses_without_the_live_flag_and_root_but_check_is_read_only(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("AEGIS_F1R_LIVE_AUTHORIZED", raising=False)
    assert tool.main(["rollback", "--work-dir", str(tmp_path)]) == 1 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_F1R_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["apply", "--work-dir", str(tmp_path), "--old-release-id", OLD, "--new-release-id", NEW, "--new-source-sha", NEW_SRC,
                      "--new-detector-sha256", DET_SHA]) == 1 and "ROOT_REQUIRED" in capsys.readouterr().err


# ═══ stage registration, authorization/K3 contract, handlers, allow files ═════════════════════════════════════════════════════


def stages() -> list[str]:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    return line.split('"')[1].split()


def test_f1r_is_registered_after_l8p_and_before_f1():
    order = stages()
    assert order.index("L7u") < order.index("L8p") < order.index("F1i") < order.index("F1r") < order.index("F1") < order.index("L8") < order.index("L9")
    assert order.count("F1r") == 1 and "F1R" not in order and "F1r2" not in order


def sh(script: str, env: dict | None = None, cwd: Path | None = None):
    return _REAL_RUN(["bash", "-c", script], capture_output=True, text=True, timeout=60, check=False, cwd=cwd,
                     env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": "", **(env or {})})


def test_the_stage_framework_knows_f1r_mutating_gapless_and_extra_field_free():
    out = sh(f'. "{P4_LIB}"; p4_stage_known F1r && echo known; p4_stage_known F1R || echo F1R-unknown; p4_stage_known F1rx || echo F1rx-unknown; '
             f'p4_stage_mutates F1r && echo mutates; echo "gaps=$(p4_stage_gaps F1r)"; echo "extra=[$(p4_stage_auth_extra F1r)]"; p4_stage_handler_status F1r')
    assert out.stdout.split() == ["known", "F1R-unknown", "F1rx-unknown", "mutates", "gaps=none", "extra=[]", "REGISTERED"], out.stdout + out.stderr


def _today() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")


def _auth(stage: str, **extra) -> str:
    rows = {"stage": stage, "date": _today(), "authorizer": "music", "scope": "F1r current-release switch only; no Core restart", "reference": "OD-F1R-FIXTURE-01", **extra}
    return "AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def _k3(stage: str, **over) -> str:
    rows = {"stage": stage, "date": _today(), "confirmed_by": "music", "confirmation_mode": "IDEA3_OWNER_SELF_ATTESTATION", "idea1_window_overlap": "NONE_KNOWN",
            "reference": "OD-F1R-FIXTURE-01", **over}
    return "AEGIS_P4_K3_CONFIRMATION_V2\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def gate(tmp_path, stage, auth, k3, mode="live"):
    a, k = tmp_path / "authorization.txt", tmp_path / "k3.txt"
    a.write_text(auth)
    k.write_text(k3)
    return _REAL_RUN(["bash", str(GATE), "--stage", stage, "--mode", mode, "--authorization", str(a), "--k3", str(k)], capture_output=True, text=True, timeout=60,
                     check=False, env={"PATH": os.environ["PATH"], "LC_ALL": "C", "TZ": "Asia/Bangkok"})


def test_the_exact_fresh_same_day_authorization_and_k3_contract_for_f1r(tmp_path):
    ok = gate(tmp_path, "F1r", _auth("F1r"), _k3("F1r"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    lines = ok.stdout.splitlines()
    for expected in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "STAGE_MUTATES_PRODUCTION=YES", "REQUIRED_REPOSITORY_GAPS=none",
                     "LIVE_STAGE_AUTHORIZED=NO", "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert expected in lines, expected


@pytest.mark.parametrize("extra", [{"d6_notice": "pub"}, {"integration_review": "kla"}, {"recovery_authorization": "OD-REC-01"}, {"physical_recovery_attestation": "OD-PHYS-01"}])
def test_f1r_carries_no_extra_authorization_field(tmp_path, extra):
    bad = gate(tmp_path, "F1r", _auth("F1r", **extra), _k3("F1r"))
    assert bad.returncode == 1 and "GATE_FAIL AUTHORIZATION_MALFORMED" in bad.stdout


@pytest.mark.parametrize("label,auth,k3,reason", [
    ("stale_auth", lambda: _auth("F1r", date="2020-01-01"), lambda: _k3("F1r"), "AUTHORIZATION_STALE"),
    ("stale_k3", lambda: _auth("F1r"), lambda: _k3("F1r", date="2020-01-01"), "K3_STALE"),
    ("auth_for_f1", lambda: _auth("F1"), lambda: _k3("F1r"), "AUTHORIZATION_STAGE_MISMATCH"),
    ("k3_for_f1", lambda: _auth("F1r"), lambda: _k3("F1"), "K3_STAGE_MISMATCH"),
    ("overlap", lambda: _auth("F1r"), lambda: _k3("F1r", idea1_window_overlap="ACTIVE"), "K3_OVERLAP_NOT_NONE"),
])
def test_stale_or_cross_stage_records_are_refused_for_f1r(tmp_path, label, auth, k3, reason):
    bad = gate(tmp_path, "F1r", auth(), k3())
    assert bad.returncode == 1 and f"GATE_FAIL {reason}" in bad.stdout


def test_neighbouring_stage_records_are_not_accepted_by_f1r_and_vice_versa(tmp_path):
    for stage in ("F1", "L8p"):
        r = gate(tmp_path, stage, _auth("F1r"), _k3("F1r"))
        assert r.returncode == 1 and "AUTHORIZATION_RECORD=INVALID" in r.stdout


def test_the_f1r_handler_set_is_exactly_the_five_contract_files_and_executable():
    assert sorted(p.name for p in STAGE.iterdir()) == ["allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert os.access(STAGE / name, os.X_OK)
        text = active_shell(STAGE / name)
        assert "AEGIS_F1R_LIVE_AUTHORIZED" in text and text.count("exec ") == 1  # guarded; one exec of the reviewed tool
        assert not re.search(r"systemctl|ln\s+-|\bmv\b|\brm\b|chmod|chown|useradd|esptool|/dev/tty|mosquitto|recovery_ui|server_admin", text), name


def test_the_listener_allow_list_is_empty_and_the_key_allow_list_is_exactly_the_current_target():
    listeners = [l for l in (STAGE / "allow-listeners.txt").read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
    keys = [l for l in (STAGE / "allow-keys.txt").read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
    assert listeners == [] and keys == [CURRENT_KEY]


# ═══ comparator contract: real p4-compare.sh on real captured bundles ══════════════════════════════════════════════════════════


def _bundle_with(src: Path, dst: Path, **records: str) -> Path:
    """Copy a real fixture capture and set/replace records in host.tsv (and svc.* in services.tsv), then regenerate SHA256SUMS."""
    import shutil

    shutil.copytree(src, dst)
    for fname, prefix in (("host.tsv", "host."), ("services.tsv", "svc.")):
        path = dst / fname
        rows = {}
        for line in path.read_text().splitlines():
            key, _, value = line.partition("\t")
            rows[key] = value
        changed = False
        for key, value in records.items():
            if key.startswith(prefix):
                rows[key] = value
                changed = True
        if changed:
            path.write_text("".join(f"{k}\t{rows[k]}\n" for k in sorted(rows, key=lambda k: k.encode())))
    files = sorted(p.name for p in dst.iterdir() if p.is_file() and p.name not in ("SHA256SUMS",))
    sums = _REAL_RUN(["sha256sum", *files], cwd=dst, capture_output=True, text=True, check=True).stdout
    (dst / "SHA256SUMS").write_text(sums)
    return dst


@pytest.fixture(scope="module")
def real_capture(tmp_path_factory):
    sys.path.insert(0, str(ROOT / "tests"))
    import test_pr11_phase4_harness as h

    tmp = tmp_path_factory.mktemp("f1r-compare")
    cap = h.capture(tmp, "before")
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    return cap


def _run_compare(before: Path, after: Path, allow_keys: Path, listeners: Path):
    return _REAL_RUN(["bash", str(COMPARE), str(before), str(after)], capture_output=True, text=True, timeout=60, check=False,
                     env={"PATH": os.environ["PATH"], "HOME": str(before), "LC_ALL": "C", "DISK_THRESHOLD_PCT": "90",
                          "ALLOW_KEYS_FILE": str(allow_keys), "ALLOW_LISTENERS_FILE": str(listeners)})


def test_the_comparator_accepts_only_the_current_target_transition(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CURRENT_KEY: OLD_PATH})
    post = _bundle_with(real_capture.evid, tmp_path / "post", **{CURRENT_KEY: NEW_PATH})
    keys, listeners = STAGE / "allow-keys.txt", STAGE / "allow-listeners.txt"
    ok = _run_compare(pre, post, keys, listeners)
    assert ok.returncode == 0 and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "COMPARE_RESULT=PASS" in ok.stdout, ok.stdout
    empty = tmp_path / "empty-allow.txt"
    empty.write_text("")
    bare = _run_compare(pre, post, empty, listeners)  # the rollback comparison (zero allowances) must reject the very same transition
    assert bare.returncode == 1 and CURRENT_KEY in bare.stdout


@pytest.mark.parametrize("extra", [
    {"svc.aegis-idea3-core.service.MainPID": "9999"},  # a Core restart is NOT approved
    {"host.path./etc/aegis-idea3": "absent"},
])
def test_any_other_captured_drift_still_fails_even_with_the_f1r_allowance(tmp_path, real_capture, extra):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CURRENT_KEY: OLD_PATH})
    post = _bundle_with(real_capture.evid, tmp_path / "post", **{CURRENT_KEY: NEW_PATH, **extra})
    bad = _run_compare(pre, post, STAGE / "allow-keys.txt", STAGE / "allow-listeners.txt")
    assert bad.returncode == 1 and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" not in bad.stdout


def test_the_runner_gate_proves_the_exact_old_to_new_values_from_the_capture_records(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CURRENT_KEY: OLD_PATH})
    good = _bundle_with(real_capture.evid, tmp_path / "good", **{CURRENT_KEY: NEW_PATH})
    wrong_new = _bundle_with(real_capture.evid, tmp_path / "wrong", **{CURRENT_KEY: f"{OPT}/releases/intruder"})
    absent = _bundle_with(real_capture.evid, tmp_path / "absent", **{CURRENT_KEY: "absent"})

    def transition(before, after):
        return sh(f'. "{F1R_LIB}"; f1r_current_transition_gate "{before}" "{after}" "{OLD_PATH}" "{NEW_PATH}"')

    assert transition(pre, good).returncode == 0
    for bad in (wrong_new, absent, pre):  # a different target, a removed link, or NO transition at all
        r = transition(pre, bad)
        assert r.returncode == 1 and "F1R_CURRENT_TRANSITION_NOT_EXACT" in r.stderr
    r = transition(good, good)
    assert r.returncode == 1  # the PRE bundle must itself hold the exact OLD target


# ═══ shell library gates ═════════════════════════════════════════════════════════════════════════════════════════════════════


def lib(snippet: str, **env):
    return sh(f'set -uo pipefail; . "{F1R_LIB}"; {snippet}', env=env)


def test_the_one_attempt_marker_is_distinct_and_consumed_once(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    ok = lib(f'f1r_attempt_unconsumed "{auth}" && f1r_consume_attempt "{auth}" && echo consumed')
    assert ok.returncode == 0 and (auth / "F1R-ATTEMPT-CONSUMED").is_file()
    assert "F1R_ATTEMPT_ALREADY_CONSUMED" in lib(f'f1r_attempt_unconsumed "{auth}"').stderr
    assert "F1R_ATTEMPT_ALREADY_CONSUMED" in lib(f'f1r_consume_attempt "{auth}"').stderr
    other = tmp_path / "other"
    other.mkdir()
    (other / "F1-ATTEMPT-CONSUMED").write_text("x")  # another stage's marker never blocks or authorizes F1r
    (other / "L6C-ATTEMPT-CONSUMED").write_text("x")
    assert lib(f'f1r_attempt_unconsumed "{other}"').returncode == 0


L8P_RECEIPT = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"


def git_repo(tmp_path: Path, receipts: dict[str, str]) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(parents=True)
    env = {"PATH": os.environ["PATH"], "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(tmp_path)}
    _REAL_RUN(["git", "init", "-q", str(repo)], env=env, check=True)
    for rel, text in receipts.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    _REAL_RUN(["git", "-C", str(repo), "add", "-A"], env=env, check=True)
    _REAL_RUN(["git", "-C", str(repo), "commit", "-q", "-m", "fixture"], env=env, check=True)
    return repo


L8P_OK = "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n"


def test_the_receipt_gate_requires_l8p_closed_the_f1i_install_and_makes_f1r_one_shot(tmp_path):
    rid = NEW
    f1i_ok = f"F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=YES\nF1I_RELEASE_ID={rid}\n"
    f1i = f"{LOGS}/2026-10-05_000000_music_idea3-f1i-live-closeout.md"

    def gate_for(repo):
        return lib(f'f1r_receipt_gate "{repo}" "{rid}"')

    assert gate_for(git_repo(tmp_path / "a", {L8P_RECEIPT: L8P_OK, f1i: f1i_ok})).returncode == 0
    assert "F1R_L8P_NOT_CLOSED" in gate_for(git_repo(tmp_path / "b", {f"{LOGS}/x.md": "# none\n"})).stderr
    other = git_repo(tmp_path / "c", {f"{LOGS}/2026-10-04_000000_music_other.md": L8P_OK, f1i: f1i_ok})
    assert "F1R_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT" in gate_for(other).stderr
    done = git_repo(tmp_path / "d", {L8P_RECEIPT: L8P_OK, f1i: f1i_ok, f"{LOGS}/2026-10-06_000000_music_f1r.md": "F1R_LIVE_EXECUTED=YES\nF1R_CURRENT_SWITCHED=YES\n"})
    assert "F1R_ALREADY_EXECUTED" in gate_for(done).stderr
    partial = git_repo(tmp_path / "e", {L8P_RECEIPT: L8P_OK, f1i: f1i_ok, f"{LOGS}/2026-10-06_000000_music_f1r.md": "F1R_LIVE_EXECUTED=YES\nF1R_CURRENT_SWITCHED=NO\n"})
    assert gate_for(partial).returncode == 0  # a failed/rolled-back attempt is not an executed switch
    # a recorded F1 result neither blocks nor satisfies F1r
    f1 = git_repo(tmp_path / "f", {L8P_RECEIPT: L8P_OK, f1i: f1i_ok, f"{LOGS}/2026-10-06_000000_music_f1.md": "F1_PRODUCTION_DEPLOYED=YES\nF1_DETECTOR_STARTED=YES\n"})
    assert gate_for(f1).returncode == 0


def test_the_repo_detector_digest_gate_ties_the_pin_to_the_reviewed_source(tmp_path):
    src = tmp_path / "IDEA3-AEGIS_Lockdown" / "aegis_soc"
    src.mkdir(parents=True)
    (src / "production_detector.py").write_bytes(DET_BYTES)
    good = lib(f'f1r_detector_source_gate "{tmp_path}" "{DET_SHA}"')
    assert good.returncode == 0, good.stderr
    bad = lib(f'f1r_detector_source_gate "{tmp_path}" "{"1" * 64}"')
    assert bad.returncode == 1 and "F1R_DETECTOR_SOURCE_DIGEST_MISMATCH" in bad.stderr
    assert "F1R_DETECTOR_PIN_INVALID" in lib(f'f1r_detector_source_gate "{tmp_path}" abc').stderr
    # and the real repository's reviewed detector is exactly the digest the owner decision records
    assert hashlib.sha256(DETECTOR_SRC.read_bytes()).hexdigest() == REPAIRED_DETECTOR_SHA


def stub(tmp_path: Path, rc: int, line: str) -> Path:
    path = tmp_path / "stub-python"
    path.write_text(f'#!/bin/bash\necho "$*" > "{tmp_path}/args.txt"\necho "{line}" >&2\nexit {rc}\n')
    path.chmod(0o755)
    return path


def test_the_f1r_preflight_gate_delegates_to_the_reviewed_tool_and_maps_failure(tmp_path):
    ok = lib(f'f1r_preflight_gate "{stub(tmp_path, 0, "F1R_CHECK=PASS")}" TOOL "{OLD}" "{NEW}" "{NEW_SRC}" "{DET_SHA}"')
    assert ok.returncode == 0
    args = (tmp_path / "args.txt").read_text().split()
    assert args[:1] == ["TOOL"] and args[1] == "check" and "--old-release-id" in args and "--new-detector-sha256" in args
    bad = lib(f'f1r_preflight_gate "{stub(tmp_path, 1, "F1R_CHECK=FAIL reason=CURRENT_NOT_OLD_TARGET")}" TOOL "{OLD}" "{NEW}" "{NEW_SRC}" "{DET_SHA}"')
    assert bad.returncode == 1 and "F1R_PREFLIGHT_FAILED:CURRENT_NOT_OLD_TARGET" in bad.stderr


def test_the_f1r_unit_state_gate_accepts_only_core_and_current_as_claimed(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text('#!/bin/bash\nprintf "%s\\n" "ActiveState=${F1R_ACTIVE:-active}" "SubState=running" "MainPID=${F1R_PID:-4242}" "NRestarts=${F1R_NR:-0}"\n')
    (bindir / "systemctl").chmod(0o755)
    path = f"{bindir}:{os.environ['PATH']}"
    ok = lib('f1r_core_snapshot_gate 4242/0', PATH=path)
    assert ok.returncode == 0
    for env in ({"F1R_PID": "1"}, {"F1R_NR": "1"}, {"F1R_ACTIVE": "failed"}):
        r = lib('f1r_core_snapshot_gate 4242/0', PATH=path, **env)
        assert r.returncode == 1 and "F1R_CORE_DRIFT" in r.stderr


# ═══ owner runner template ═══════════════════════════════════════════════════════════════════════════════════════════════════


def test_the_committed_f1r_runner_refuses_to_run_unpinned_and_creates_nothing(tmp_path):
    r = _REAL_RUN(["bash", str(F1R_RUNNER), str(tmp_path)], capture_output=True, text=True, timeout=30, check=False, cwd=tmp_path,
                  env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
    assert r.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in r.stdout and list(tmp_path.iterdir()) == []


def test_the_f1r_runner_pins_exactly_the_seven_owner_frozen_values_and_commits_no_real_value():
    text = F1R_RUNNER.read_text()
    pins = ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "OLD_RELEASE_ID", "NEW_RELEASE_ID", "NEW_RELEASE_SOURCE_SHA", "NEW_PRODUCTION_DETECTOR_SHA256")
    for pin in pins:
        assert re.search(rf"^{pin}=PIN_[A-Z0-9_]+$", text, re.M), pin
    assert len(re.findall(r"^[A-Z0-9_]+=PIN_[A-Z0-9_]+$", text, re.M)) == len(pins)
    assert not re.search(r"=[0-9a-f]{40}\n|=[0-9a-f]{64}\n", text)
    assert "authorization-F1r.txt" in text and "k3-F1r.txt" in text and "--stage F1r" in text


def test_the_f1r_runner_orders_gates_then_pre_then_reprove_then_marker_then_switch_verify_post_compare():
    text = active_shell(F1R_RUNNER)
    order = ["l7u_identity_gate", "p4-stage-gate.sh", "f1r_receipt_gate", "f1r_detector_source_gate", "f1r_preflight_gate", "capture PRE", "f1r_preflight_gate",
             "f1r_consume_attempt", "handler apply.sh", "handler verify.sh", "capture POST", "f1r_current_transition_gate", "compare \"$PRE\" \"$EVID/post-root\"",
             "l7u_secret_scan", "F1R_LIVE_EXECUTED=YES"]
    pos = -1
    for token in order:
        nxt = text.find(token, pos + 1)
        assert nxt > pos, token
        pos = nxt
    assert text.count("handler apply.sh") == 1 and text.count("f1r_consume_attempt") == 1 and text.count("handler rollback.sh") == 1
    assert not re.search(r"\b(while|until)\b[^\n]*\bhandler\b|handler[^\n]*\|\|\s*handler (apply|verify)", text)  # never looped or retried


def test_the_f1r_runner_rolls_back_only_after_consume_and_requires_zero_drift_afterwards():
    text = active_shell(F1R_RUNNER)
    assert "fail_after_attempt()" in text and 'ATTEMPTED=1' in text
    rb = text[text.index("rollback_flow()"):text.index("fail_after_attempt()")]
    for needed in ("handler rollback.sh", "f1r_rollback_output_gate", "capture RB", 'compare "$PRE" "$EVID/rb-root"', "empty-allow.txt", "NOT retrying"):
        assert needed in rb, needed
    assert "exit 3" in rb  # unknown rollback state escalates, never retries


def test_the_only_place_the_live_flag_is_set_is_the_post_gate_handler_function():
    text = active_shell(F1R_RUNNER)
    assert text.count("AEGIS_F1R_LIVE_AUTHORIZED=YES") == 1
    handler = text[text.index("handler() {"):text.index("own_pre()")]
    assert "AEGIS_F1R_LIVE_AUTHORIZED=YES" in handler and "AEGIS_F1R_LIVE_AUTHORIZED" not in active_shell(F1R_LIB)


def test_the_f1r_runner_and_lib_never_restart_the_core_start_the_detector_or_touch_recovery_or_hardware():
    for path in (F1R_RUNNER, F1R_LIB):
        text = active_shell(path)
        assert not re.search(r"systemctl\s+(restart|stop|start|reload|enable|disable|kill|mask|daemon-reload)\b", text), path
        assert not re.search(r"esptool|/dev/tty|serial|recovery_ui|server_admin|RESTORE|\bCUT\b|install-release|p4-l7-install|ln\s+-s|\bmv\b\s", text), path
    claims = F1R_RUNNER.read_text()
    for claim in ("F1R_LIVE_EXECUTED=YES", "F1R_CURRENT_SWITCHED=YES", "CORE_RESTARTED=NO", "F1_ATTEMPT_2_PERFORMED=NO", "F1_DETECTOR_STARTED=NO",
                  "CORE_MOVED_TO_NEW_RELEASE=NO"):
        assert claim in claims, claim
    assert not re.search(r"F1_PRODUCTION_DEPLOYED=YES|F1_DETECTOR_STARTED=YES|F1_REAL_DETECTOR_ACCEPTANCE=(PASS|YES)|RECOVERY_R1_R8_PROVEN=YES", claims)


# ═══ PART E: the future F1 runner may not consume its attempt while Production still resolves the old detector ═════════════════


def test_the_future_f1_runner_pins_the_runtime_release_and_keeps_the_unit_pin_separate():
    text = F1_RUNNER.read_text()
    for pin in ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "ALERT_SOURCE_UID", "UNIT_SHA256", "EXPECTED_RUNTIME_RELEASE_ID",
                "EXPECTED_RUNTIME_RELEASE_SOURCE_SHA", "EXPECTED_PRODUCTION_DETECTOR_SHA256"):
        assert re.search(rf"^{pin}=PIN_[A-Z0-9_]+$", text, re.M), pin
    assert len(re.findall(r"^[A-Z0-9_]+=PIN_[A-Z0-9_]+$", text, re.M)) == 8
    assert not re.search(r"=[0-9a-f]{40}\n|=[0-9a-f]{64}\n", text)
    # UNIT_SHA256 stays a separate pin and is still validated as a 64-hex SHA-256 distinct from the detector digest pin
    assert 'f1_unit_pin_gate "$PY" "$F1_TOOL" "$UNIT_SHA256"' in text and "EXPECTED_PRODUCTION_DETECTOR_SHA256" in text


def test_the_future_f1_runner_runs_the_runtime_gate_before_pre_capture_and_again_before_consume():
    text = active_shell(F1_RUNNER)
    first = text.index("f1_runtime_release_gate")
    pre = text.index("capture PRE")
    again = text.index("f1_runtime_release_gate", pre)
    consume = text.index("f1_consume_attempt")
    assert first < pre < again < consume
    gate_line = next(l for l in text.splitlines() if "f1_runtime_release_gate" in l)
    for token in ("EXPECTED_RUNTIME_RELEASE_ID", "EXPECTED_RUNTIME_RELEASE_SOURCE_SHA", "EXPECTED_PRODUCTION_DETECTOR_SHA256"):
        assert token in gate_line


def test_a_failing_runtime_gate_aborts_the_future_f1_runner_before_the_consume_boundary():
    text = active_shell(F1_RUNNER)
    calls = re.findall(r"f1_runtime_release_gate[^\n]*\\\n\s*\|\| (gate|die) \"([^\"]*)\"", text)
    assert [kind for kind, _ in calls] == ["gate", "die"]  # the pre-gate collects a GATE_FAIL; the post-PRE re-check dies
    assert "NOT consumed" in calls[1][1] and "old detector" in calls[0][1]
    assert not re.search(r"f1_runtime_release_gate[^\n]*\\\n\s*\|\|\s*(true|:)", text)  # never swallowed
    pre_gate_block = text[text.index("[ \"$GATE_FAILED\" = 0 ]"):text.index("capture PRE")]
    assert "die" in pre_gate_block  # a collected gate failure stops the run before any capture or marker


def test_the_future_f1_runner_still_has_every_existing_pre_consume_gate():
    text = active_shell(F1_RUNNER)
    for existing in ("l7u_identity_gate", "p4-stage-gate.sh", "f1_receipt_gate", "l7u_core_running_gate", "l8p_service_gate", "l7_idea2_s10_gate", "l7_disk_gate",
                     "l7u_alert_identity_gate", "f1_core_env_gate", "f1_core_running_alert_uid_gate", "f1_alert_surface_gate", "f1_probe_config_gate", "f1_unit_pin_gate",
                     "f1_detector_absent_gate", "capture PRE", "f1_consume_attempt"):
        assert existing in text, existing


def runtime_world(tmp_path, **kw):
    return build(tmp_path, current_target=kw.pop("current_target", NEW_PATH), **kw)


def check_runtime(host, backend, **over):
    args = {"release_id": NEW, "source_sha": NEW_SRC, "detector_sha": DET_SHA, **over}
    return tool.check_runtime_release(host, backend, args["release_id"], args["source_sha"], args["detector_sha"])


def test_the_runtime_gate_accepts_the_exact_corrected_runtime_facts(tmp_path):
    world, host, backend, work = runtime_world(tmp_path)
    out = check_runtime(host, backend)
    assert out["F1R_CHECK_RUNTIME"] == "PASS" and out["RUNTIME_RELEASE_ID"] == NEW and out["PRODUCTION_DETECTOR_SHA256"] == DET_SHA and out["DETECTOR_PRESENT"] == "NO"
    assert host.ops == [] and all(c[0] == "show" for c in backend.calls)  # strictly read-only


def test_the_runtime_gate_refuses_while_production_still_resolves_the_old_release(tmp_path):
    world, host, backend, work = runtime_world(tmp_path, current_target=OLD_PATH)
    assert refusal(check_runtime, host, backend) == "CURRENT_NOT_EXPECTED_RUNTIME_RELEASE"


def test_the_runtime_gate_refuses_the_correct_release_with_the_wrong_detector_digest(tmp_path):
    world, host, backend, work = runtime_world(tmp_path, det_bytes=DET_BYTES + b"# old detector\n")
    assert refusal(check_runtime, host, backend) == "DETECTOR_SHA256_MISMATCH"
    world, host, backend, work = runtime_world(tmp_path / "pin")
    assert refusal(check_runtime, host, backend, detector_sha="1" * 64) == "DETECTOR_SHA256_MISMATCH"


@pytest.mark.parametrize("label,kw,over,reason", [
    ("guard_fails", {"guard": {NEW_PATH: "NOT_ROOT_OWNED"}}, {}, "RELEASE_GUARD:NOT_ROOT_OWNED"),
    ("wrong_source", {}, {"source_sha": "1" * 40}, "RELEASE_SOURCE_SHA_MISMATCH"),
    ("dirty", {"new_manifest": manifest(dirty=True)}, {}, "RELEASE_SOURCE_TREE_DIRTY"),
    ("detector_present", {"detector_load": "loaded"}, {}, "DETECTOR_UNIT_OR_PROCESS_PRESENT"),
    ("wrong_id", {"new_manifest": manifest(release_id=OLD)}, {}, "RELEASE_ID_MISMATCH"),
])
def test_the_runtime_gate_refuses_every_other_deviation(tmp_path, label, kw, over, reason):
    world, host, backend, work = runtime_world(tmp_path, **kw)
    assert refusal(check_runtime, host, backend, **over) == reason


def test_the_f1_lib_runtime_gate_delegates_to_the_reviewed_tool(tmp_path):
    ok = sh(f'. "{F1_LIB}"; f1_runtime_release_gate "{stub(tmp_path, 0, "F1R_CHECK_RUNTIME=PASS")}" TOOL "{NEW}" "{NEW_SRC}" "{DET_SHA}"')
    assert ok.returncode == 0
    args = (tmp_path / "args.txt").read_text().split()
    assert args[:2] == ["TOOL", "check-runtime"] and "--release-id" in args and "--source-sha" in args and "--detector-sha256" in args
    bad = sh(f'. "{F1_LIB}"; f1_runtime_release_gate "{stub(tmp_path, 1, "F1R_CHECK_RUNTIME=FAIL reason=CURRENT_NOT_EXPECTED_RUNTIME_RELEASE")}" TOOL "{NEW}" "{NEW_SRC}" "{DET_SHA}"')
    assert bad.returncode == 1 and "F1_RUNTIME_RELEASE_GATE_FAILED:CURRENT_NOT_EXPECTED_RUNTIME_RELEASE" in bad.stderr


# ═══ review fix 1: root-only /opt reads run through SUDO, never as the plain operator user ═══════════════════════════════════════


def fake_sudo(tmp_path: Path) -> tuple[Path, Path]:
    """A recording stand-in for `sudo`: logs its whole argv, then runs it (the stub tool plays the privileged read-only process)."""
    log = tmp_path / "sudo.log"
    script = tmp_path / "fake-sudo"
    script.write_text(f'#!/bin/bash\nprintf "%s\\n" "$*" >> "{log}"\nexec "$@"\n')
    script.chmod(0o755)
    return script, log


def test_the_f1r_preflight_gate_runs_the_reviewed_tool_through_sudo_read_only(tmp_path):
    sudo, log = fake_sudo(tmp_path)
    ok = lib(f'f1r_preflight_gate "{stub(tmp_path, 0, "F1R_CHECK=PASS")}" TOOL "{OLD}" "{NEW}" "{NEW_SRC}" "{DET_SHA}"', SUDO=str(sudo))
    assert ok.returncode == 0, ok.stderr
    lines = log.read_text().splitlines()
    assert len(lines) == 1 and lines[0].startswith("env PYTHONDONTWRITEBYTECODE=1 ") and " TOOL check " in lines[0] + " "  # elevated, bytecode-free, `check` only
    assert not any(word in lines[0].split() for word in ("apply", "verify", "rollback"))  # the pre-consume gate can only ever run the read-only subcommand


def test_the_future_f1_runtime_gate_runs_the_reviewed_tool_through_sudo_read_only(tmp_path):
    sudo, log = fake_sudo(tmp_path)
    ok = sh(f'. "{F1_LIB}"; f1_runtime_release_gate "{stub(tmp_path, 0, "F1R_CHECK_RUNTIME=PASS")}" TOOL "{NEW}" "{NEW_SRC}" "{DET_SHA}"', env={"SUDO": str(sudo)})
    assert ok.returncode == 0, ok.stderr
    lines = log.read_text().splitlines()
    assert len(lines) == 1 and lines[0].startswith("env PYTHONDONTWRITEBYTECODE=1 ") and " TOOL check-runtime " in lines[0] + " "
    assert not any(word in lines[0].split() for word in ("apply", "verify", "rollback"))


def test_both_libraries_default_to_sudo_and_never_invoke_the_check_tools_as_a_plain_user_process():
    for path in (F1R_LIB, F1_LIB):
        text = active_shell(path)
        assert re.search(r'^: "\$\{SUDO=sudo\}"$', text, re.M), path
    f1r = active_shell(F1R_LIB)
    f1 = active_shell(F1_LIB)
    assert re.search(r'\$SUDO env PYTHONDONTWRITEBYTECODE=1 "\$py" "\$tool" check ', f1r)
    assert re.search(r'\$SUDO env PYTHONDONTWRITEBYTECODE=1 "\$py" "\$tool" check-runtime ', f1)
    assert not re.search(r'(?<!\$SUDO env PYTHONDONTWRITEBYTECODE=1 )"\$py" "\$tool" (check|check-runtime) ', f1r + "\n" + f1)


def test_the_f1r_runner_reads_current_through_sudo_not_as_the_plain_operator():
    text = active_shell(F1R_RUNNER)
    assert not re.search(r"\$\(readlink /opt/aegis-idea3/current\)", text)
    assert text.count("sudo readlink /opt/aegis-idea3/current") == 2  # the post-switch independent check and the rollback-state check


def test_a_failed_root_read_fails_the_gate_before_any_consume(tmp_path):
    bad = lib(f'f1r_preflight_gate "{stub(tmp_path, 0, "F1R_CHECK=PASS")}" TOOL "{OLD}" "{NEW}" "{NEW_SRC}" "{DET_SHA}"', SUDO="false")  # elevation refused
    assert bad.returncode == 1 and "F1R_PREFLIGHT_FAILED:ROOT_READ_UNAVAILABLE" in bad.stderr
    assert not (tmp_path / "args.txt").exists()  # the tool never ran as an unprivileged substitute
    bad = sh(f'. "{F1_LIB}"; f1_runtime_release_gate "{stub(tmp_path, 0, "F1R_CHECK_RUNTIME=PASS")}" TOOL "{NEW}" "{NEW_SRC}" "{DET_SHA}"', env={"SUDO": "false"})
    assert bad.returncode == 1 and "F1_RUNTIME_RELEASE_GATE_FAILED:ROOT_READ_UNAVAILABLE" in bad.stderr
    runner = active_shell(F1R_RUNNER)
    pre = re.findall(r"f1r_preflight_gate[^\n]*\\\n\s*\|\| (gate|die) ", runner)
    assert pre == ["gate", "die"]  # both calls abort the run; the second one is before the one-shot boundary
    assert runner.index("f1r_preflight_gate", runner.index("capture PRE")) < runner.index("f1r_consume_attempt")


def test_a_denied_read_is_a_fixed_refusal_not_an_empty_answer(tmp_path):
    """A root:root 0700 parent is NOT assumed readable by the operator: an unprivileged lstat that is denied must refuse, never read as 'absent'."""
    if os.geteuid() == 0:
        pytest.skip("directory permissions do not bind root")
    locked = tmp_path / "opt-aegis-idea3"
    (locked / "releases").mkdir(parents=True)
    os.chmod(locked, 0)
    try:
        host = tool.F1rHost()
        inside = str(locked / "current")
        for call in (host.lexists, host.is_symlink, host.is_regular, host.readlink, host.read_bytes, host.sha256_file):
            with pytest.raises(tool.Refusal) as exc:
                call(inside)
            assert str(exc.value) == "HOST_READ_DENIED", call
        with pytest.raises(tool.Refusal) as exc:
            host.release_guard(inside, inside)
        assert str(exc.value) == "HOST_READ_DENIED"
    finally:
        os.chmod(locked, 0o700)


def test_a_missing_path_is_still_just_absent_not_a_denial(tmp_path):
    host = tool.F1rHost()
    assert host.lexists(str(tmp_path / "nope")) is False and host.is_symlink(str(tmp_path / "nope")) is False and host.is_regular(str(tmp_path / "nope")) is False


def test_the_tool_refuses_when_the_host_cannot_be_read(tmp_path):
    world, host, backend, work = build(tmp_path, deny_reads=True)
    assert refusal(tool.preflight, host, backend, OLD, NEW, NEW_SRC, DET_SHA) == "HOST_READ_DENIED"
    assert refusal(check_runtime, host, backend) == "HOST_READ_DENIED"
    assert host.ops == []  # strictly read-only


# ═══ review fix 2: a standalone production_detector process is detector presence even when the unit is not-found ═══════════════


STANDALONE = {"detector_procs": [4321]}  # LoadState=not-found, ActiveState=inactive, MainPID=0 (the defaults) BUT a bare `python -m aegis_soc.production_detector` runs


def test_the_unit_surface_alone_is_not_enough_a_standalone_process_refuses_preflight_and_check(tmp_path):
    world, host, backend, work = build(tmp_path, **STANDALONE)
    assert world.detector == {"LoadState": "not-found", "ActiveState": "inactive", "MainPID": "0"}
    assert refusal(tool.preflight, host, backend, OLD, NEW, NEW_SRC, DET_SHA) == "DETECTOR_STANDALONE_PROCESS_PRESENT"
    assert host.ops == []


def test_a_standalone_process_refuses_apply_before_any_mutation(tmp_path):
    world, host, backend, work = build(tmp_path, **STANDALONE)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_STANDALONE_PROCESS_PRESENT"
    assert_untouched(host, world, work)


def test_a_standalone_process_that_appears_after_the_switch_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.detector_procs = [4321]
    assert refusal(run_verify, host, backend, work) == "DETECTOR_STANDALONE_PROCESS_PRESENT"


def test_a_standalone_process_refuses_the_future_f1_runtime_check(tmp_path):
    world, host, backend, work = runtime_world(tmp_path, **STANDALONE)
    assert refusal(check_runtime, host, backend) == "DETECTOR_STANDALONE_PROCESS_PRESENT"


def test_a_standalone_process_is_caught_by_the_rollback_postcondition_after_the_restore(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.detector_procs = [4321]
    assert refusal(tool.rollback, work, host, FakeBackend(world)) == "DETECTOR_STANDALONE_PROCESS_PRESENT"
    assert host.links == {CURRENT: OLD_PATH} and journal(work)["phase"] == "rolled_back"  # restored first, then escalated; the process is never stopped


def test_detection_only_nothing_is_ever_stopped_or_signalled():
    code = code_only(TOOL_PATH)
    for forbidden in ("os.kill", "signal.", "killpg", "pkill", "terminate", "os.system"):
        assert forbidden not in code, forbidden
    assert code.count("subprocess.run(") == 1  # still ONLY the allow-listed `systemctl show`; no process execution was added


def make_proc(tmp_path: Path, entries: dict[str, bytes | None]) -> Path:
    root = tmp_path / "proc"
    root.mkdir()
    for name, cmdline in entries.items():
        entry = root / name
        entry.mkdir()
        if cmdline is not None:
            (entry / "cmdline").write_bytes(cmdline)
    return root


def test_the_real_host_finds_standalone_detector_processes_by_exact_argv_tokens(tmp_path):
    root = make_proc(tmp_path, {
        "100": b"/usr/bin/python3\0-m\0aegis_soc.production_detector\0",
        "101": b"/opt/aegis-idea3/current/venv/bin/python\0-m\0aegis_soc.supervisor\0--profile\0production\0",
        "102": b"python\0/opt/aegis-idea3/current/aegis_soc/production_detector.py\0",
        "103": b"",  # kernel thread
        "104": b"python\0-m\0aegis_soc.production_detector_extra\0",  # near miss: not the detector
        "105": b"grep\0production_detector\0",  # a search for it, not the detector
        "106": None,  # vanished between listing and reading
        "sys": None, "self": None,  # non-numeric entries
    })
    assert tool.F1rHost().detector_processes(str(root)) == [100, 102]


def test_the_real_host_ignores_its_own_process_and_reports_none_on_a_clean_proc(tmp_path):
    root = make_proc(tmp_path, {str(os.getpid()): b"python\0-m\0aegis_soc.production_detector\0", "7": b"sleep\0100\0"})
    assert tool.F1rHost().detector_processes(str(root)) == []


def test_an_unreadable_proc_entry_is_a_refusal_not_a_silent_absence(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("file permissions do not bind root")
    root = make_proc(tmp_path, {"200": b"python\0-m\0aegis_soc.production_detector\0"})
    os.chmod(root / "200" / "cmdline", 0)
    with pytest.raises(tool.Refusal) as exc:
        tool.F1rHost().detector_processes(str(root))
    assert str(exc.value) == "PROC_READ_DENIED"


def test_the_f1r_runner_re_proves_complete_detector_absence_after_pre_and_right_before_the_consume():
    text = active_shell(F1R_RUNNER)
    pre = text.index("capture PRE")
    consume = text.index("f1r_consume_attempt")
    window = text[pre:consume]
    assert "f1r_preflight_gate" in window  # the tool's detector_absent() now covers the unit surface AND standalone processes
    assert "f1_detector_absent_gate" in window and "die" in window[window.index("f1_detector_absent_gate"):]  # the independent shell check also re-runs, and aborts


def test_the_shell_detector_gate_also_detects_a_standalone_process_while_the_unit_is_not_found(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text('#!/bin/bash\nprintf "%s\\n" "LoadState=not-found" "ActiveState=inactive" "MainPID=0"\n')
    (bindir / "pgrep").write_text("#!/bin/bash\nexit ${F1_PGREP:-1}\n")
    for stub_file in bindir.iterdir():
        stub_file.chmod(0o755)
    path = f"{bindir}:{os.environ['PATH']}"
    assert sh(f'. "{F1_LIB}"; f1_detector_absent_gate', env={"PATH": path}).returncode == 0
    r = sh(f'. "{F1_LIB}"; f1_detector_absent_gate', env={"PATH": path, "F1_PGREP": "0"})
    assert r.returncode == 1 and "F1_DETECTOR_PROCESS_RUNNING" in r.stderr


# ═══ negative controls are exercised separately (mutation of the critical gates); documents the gate surface ═══════════════════


def test_the_critical_gate_surface_exists_in_the_tool():
    code = code_only(TOOL_PATH)
    for needle in ("CURRENT_NOT_OLD_TARGET", "RELEASE_SOURCE_SHA_MISMATCH", "RELEASE_SOURCE_TREE_DIRTY", "DETECTOR_SHA256_MISMATCH", "DETECTOR_UNIT_OR_PROCESS_PRESENT",
                   "CORE_RESTARTED_OR_REPLACED", "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT", "CURRENT_NOT_EXPECTED_RUNTIME_RELEASE", "SYSTEMCTL_VERB_NOT_ALLOWED"):
        assert needle in code, needle
