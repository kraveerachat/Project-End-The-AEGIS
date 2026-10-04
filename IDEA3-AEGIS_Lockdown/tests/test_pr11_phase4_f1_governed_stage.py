"""Stage F1 (governed F1 detector unit install + ONE start): repository implementation only, hermetic fixtures only.

Nothing here touches systemd, /etc, a real core.env, the Core, an alert socket, an ESP32 or a serial port. The deploy tool is driven through a fake
host and a fake systemd world (the REAL allow-list and start counter stay in force); the shell gates run against temporary git repositories.
F1 stays NOT deployed: these tests prove the repository contract only.
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
TOOL_PATH = DEPLOY / "p4-f1-deploy.py"
LIB = DEPLOY / "p4-f1-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-f1-owner.sh"
STAGE = DEPLOY / "stages" / "F1"
GATE = DEPLOY / "p4-stage-gate.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
UNIT_EXAMPLE = ROOT / "deploy" / "aegis-idea3-detector.service.example"
REPO_ROOT = ROOT.parent
L8P_RECEIPT = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"

DETECTOR_UID, CORE_UID, ALERT_GID = 953, 952, 948
KEY = "AEGIS_ALERT_SOURCE_UID"


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_f1_deploy", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()
F1 = tool.F1
PIN = hashlib.sha256(UNIT_EXAMPLE.read_bytes()).hexdigest()
UNIT_BYTES = UNIT_EXAMPLE.read_bytes()


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    """No real process, ever: the tool's systemctl is replaced below and every other spawn is a test failure."""
    def guarded(argv, *args, **kwargs):
        raise AssertionError(f"a real process must never be started by the F1 stage tests: {argv!r}")

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


# ═══ fake world: filesystem + systemd, driven through the REAL F1Backend allow-list and start counter ═══════════════════════════


class FakeStat:
    def __init__(self, mode, uid, gid, kind=stat.S_IFDIR, ino=1, dev=1):
        self.st_mode, self.st_uid, self.st_gid, self.st_ino, self.st_dev = kind | mode, uid, gid, ino, dev


class World:
    def __init__(self, *, start_rc=0, reload_rc=0, stop_rc=0, die_on_settle=False, unit_file_state="disabled", core_pid="4242", core_restarts="0"):
        self.loaded = False
        self.active = False
        self.start_rc, self.reload_rc, self.stop_rc, self.die_on_settle = start_rc, reload_rc, stop_rc, die_on_settle
        self.unit_file_state = unit_file_state
        self.core = {"ActiveState": "active", "SubState": "running", "MainPID": core_pid, "NRestarts": core_restarts}
        self.next_ino = 100
        self.events: list[str] = []
        self.race_after_reload = False  # another actor starts the detector between our daemon-reload and our own start
        self.enable_on_start = None  # another actor changes UnitFileState after our start


class FakeHost(tool.F1Host):
    def __init__(self, world: World, *, files=None, install_uid=0, install_mode=0o644, socket_mode=0o620, with_socket=True, proc_env_uid=str(DETECTOR_UID),
                 users=None, env_uid=str(DETECTOR_UID)):
        self.world = world
        self.files = dict(files or {})
        self.meta: dict[str, FakeStat] = {p: FakeStat(0o644, 0, 0, stat.S_IFREG, ino=7) for p in self.files}
        self.dirs: set[str] = set()
        self.install_uid, self.install_mode = install_uid, install_mode
        self.users = {F1.DETECTOR_ACCOUNT: DETECTOR_UID, F1.CORE_USER: CORE_UID} if users is None else users
        self.files[F1.CORE_ENV] = f"AEGIS_PROFILE=production\n{KEY}={env_uid}\n".encode()
        self.meta[F1.CORE_ENV] = FakeStat(0o640, 0, CORE_UID, stat.S_IFREG, ino=3)
        self.stats = {F1.RUNTIME_DIR: FakeStat(0o2750, CORE_UID, ALERT_GID)}
        if with_socket:
            self.stats[F1.SOCKET_PATH] = FakeStat(socket_mode, CORE_UID, ALERT_GID, stat.S_IFSOCK)
        self.proc = f"AEGIS_PROFILE=production\0{KEY}={proc_env_uid}\0".encode()
        self.sleeps: list[float] = []

    # filesystem
    def exists(self, path):
        return path in self.files or path in self.dirs

    def read_bytes(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def lstat(self, path):
        if path in self.stats:
            return self.stats[path]
        if path in self.meta:
            return self.meta[path]
        raise FileNotFoundError(path)

    def write_exclusive(self, path, data):
        if path in self.files:
            raise FileExistsError(path)
        self.world.next_ino += 1
        self.files[path] = bytes(data)
        self.meta[path] = FakeStat(self.install_mode, self.install_uid, 0, stat.S_IFREG, ino=self.world.next_ino)
        self.world.events.append(f"write:{path}")

    def link_new(self, tmp, final):
        if final in self.files:
            raise FileExistsError(final)
        self.files[final] = self.files[tmp]
        self.meta[final] = self.meta[tmp]
        self.world.events.append(f"link:{final}")

    def unlink(self, path):
        del self.files[path]
        self.meta.pop(path, None)
        self.world.events.append(f"unlink:{path}")

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        if self.world.die_on_settle:
            self.world.active = False

    # identity / process
    def resolve_user(self, name):
        return self.users.get(name)

    def resolve_group(self, name):
        return ALERT_GID if name == F1.ALERT_GROUP else None

    def proc_environ(self, pid):
        return self.proc

    def proc_groups(self, pid):
        return [CORE_UID, ALERT_GID]


class FakeBackend(tool.F1Backend):
    def __init__(self, world: World, host: FakeHost):
        super().__init__()
        self.world, self.host = world, host

    def _run(self, args):
        w = self.world
        w.events.append("systemctl:" + " ".join(a for a in args if not a.startswith("-p")))
        if args[0] == "daemon-reload":
            if w.reload_rc == 0:
                w.loaded = tool.UNIT_PATH in self.host.files or w.active  # a running unit stays loaded (stale) when its file is removed
                if w.race_after_reload and w.loaded:
                    w.active = True
            return tool.CommandResult(w.reload_rc, "")
        if args[0] == "start":
            if w.start_rc == 0:
                w.active = True
                if w.enable_on_start:
                    w.unit_file_state = w.enable_on_start
            return tool.CommandResult(w.start_rc, "")
        if args[0] == "stop":
            if w.stop_rc == 0:
                w.active = False
            return tool.CommandResult(w.stop_rc, "")
        wanted = [a[2:] for a in args[2:]]
        if args[1] == tool.CORE_UNIT:
            return tool.CommandResult(0, "".join(f"{k}={w.core[k]}\n" for k in wanted if k in w.core))
        full = {
            "LoadState": "loaded" if w.loaded else "not-found", "ActiveState": "active" if w.active else "inactive",
            "SubState": "running" if w.active else "dead", "UnitFileState": w.unit_file_state if w.loaded else "", "Result": "success",
            "MainPID": "777" if w.active else "0", "NRestarts": "0", "FragmentPath": tool.UNIT_PATH if w.loaded else "", "Restart": "no",
        }
        return tool.CommandResult(0, "".join(f"{k}={full[k]}\n" for k in wanted if k in full))


def build(tmp_path, **kw):
    world_kw = {k: kw.pop(k) for k in ("start_rc", "reload_rc", "stop_rc", "die_on_settle", "unit_file_state", "core_pid", "core_restarts") if k in kw}
    flags = {k: kw.pop(k) for k in ("race_after_reload", "enable_on_start") if k in kw}
    world = World(**world_kw)
    for k, v in flags.items():
        setattr(world, k, v)
    host = FakeHost(world, **kw)
    backend = FakeBackend(world, host)
    work = tmp_path / "work"
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    return world, host, backend, work


def run_apply(host, backend, work, pin=PIN):
    return tool.apply(DETECTOR_UID, CORE_UID, pin, work, host, backend)


@pytest.fixture(autouse=True)
def _template_is_the_repo_unit(monkeypatch):
    assert F1.UNIT_TEMPLATE == UNIT_EXAMPLE


# ═══ exact unit install ══════════════════════════════════════════════════════════════════════════════════════════════════════


ATTEMPT1_UNIT_SHA256 = "748a4c5bd3d6c30a23324819609ad89bcb4e8c4710cb775ab2c0d789a211772a"  # consumed live attempt 1 (ProcSubset=pid); never reinstall


def test_the_pinned_unit_sha_is_the_reviewed_rendered_candidate():
    # attempt-1 successor repair: ProcSubset=pid removed (journalctl -f needs /proc/sys), so the digest changed and is derived from the exact bytes.
    assert PIN == "da40399ef57b1e29cf30dc63792f67ded15333faacd8a3e04feb1c8e60d419b9" != ATTEMPT1_UNIT_SHA256
    assert F1.render_unit(UNIT_BYTES) == UNIT_BYTES


def test_the_exact_install_path_and_modes_are_fixed_constants():
    assert tool.UNIT_PATH == "/etc/systemd/system/aegis-idea3-detector.service"
    assert tool.UNIT_MODE == 0o644 and tool.UNIT_DIR == "/etc/systemd/system"


def test_apply_installs_exactly_the_pinned_bytes_root_owned_0644_via_a_no_overwrite_link(tmp_path):
    world, host, backend, work = build(tmp_path)
    result = run_apply(host, backend, work)
    assert result == {"F1_APPLY": "COMPLETE", "F1_UNIT_INSTALLED": "YES", "F1_UNIT_SHA256": PIN, "F1_START_COUNT": "1", "F1_UNIT_ENABLED": "NO",
                      "CORE_ENV_PRESERVED": "YES"}
    assert host.files[tool.UNIT_PATH] == UNIT_BYTES
    info = host.meta[tool.UNIT_PATH]
    assert (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o644)
    tmp_name = f"{tool.UNIT_DIR}/.{tool.DETECTOR_UNIT}.f1tmp"
    assert tmp_name not in host.files  # the temporary name never survives
    assert [e for e in world.events if e.startswith(("write:", "link:", "unlink:"))] == [f"write:{tmp_name}", f"link:{tool.UNIT_PATH}", f"unlink:{tmp_name}"]


def test_the_real_install_never_overwrites_and_never_renames_over_an_existing_path():
    code = code_only(TOOL_PATH)
    assert "os.link(tmp, final)" in code and "os.replace(tmp, work / JOURNAL_NAME)" in code  # replace only for the private journal
    assert "O_EXCL" in code and "O_NOFOLLOW" in code
    assert "os.rename" not in code and "shutil" not in code


@pytest.mark.parametrize("kw", [{"install_uid": 1000}, {"install_mode": 0o666}])
def test_a_wrong_owner_or_mode_after_install_is_refused_and_rolled_back(tmp_path, kw):
    world, host, backend, work = build(tmp_path, **kw)
    assert refusal(run_apply, host, backend, work) == "INSTALLED_UNIT_OWNER_OR_MODE"
    assert backend.starts == 0  # never started a unit that is not exactly root:root 0644
    host.meta[tool.UNIT_PATH] = FakeStat(0o644, 0, 0, stat.S_IFREG, ino=host.meta[tool.UNIT_PATH].st_ino)  # owner fixes it; identity (inode) is unchanged
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"} and tool.UNIT_PATH not in host.files


# ═══ pre-existing unit refusal / pin mismatch ════════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("present", [tool.UNIT_PATH, *tool.OTHER_UNIT_PATHS])
def test_a_pre_existing_unit_file_anywhere_is_refused_before_any_mutation(tmp_path, present):
    world, host, backend, work = build(tmp_path, files={present: b"[Unit]\nDescription=someone else\n"})
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_ALREADY_PRESENT"
    assert host.files[present] == b"[Unit]\nDescription=someone else\n"  # untouched
    assert not (work / tool.JOURNAL_NAME).exists()
    assert not [e for e in world.events if e.startswith(("write:", "link:", "unlink:", "systemctl:daemon-reload", "systemctl:start"))]


def test_a_pre_existing_dropin_directory_is_refused(tmp_path):
    world, host, backend, work = build(tmp_path)
    host.dirs.add(tool.DROPIN_DIRS[0])
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_ALREADY_PRESENT"


def test_an_already_loaded_unit_or_a_running_detector_is_refused(tmp_path):
    world, host, backend, work = build(tmp_path)
    world.loaded = True
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_ALREADY_LOADED"
    world, host, backend, work = build(tmp_path / "second")
    world.active = True  # a process is running although no unit is loaded
    assert refusal(tool.preflight, DETECTOR_UID, CORE_UID, PIN, host, backend) == "DETECTOR_PROCESS_RUNNING"


def test_a_pre_existing_unit_is_never_removed_by_rollback(tmp_path):
    world, host, backend, work = build(tmp_path, files={tool.UNIT_PATH: b"someone else's unit\n"})
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_ALREADY_PRESENT"
    assert tool.rollback(work, host, backend) == {"F1_ROLLBACK": "NOTHING_OWNED"}
    assert host.files[tool.UNIT_PATH] == b"someone else's unit\n"
    assert not [e for e in world.events if e.startswith(("unlink:", "systemctl:stop", "systemctl:daemon-reload"))]


def test_a_unit_that_appears_between_preflight_and_install_is_not_overwritten_or_removed(tmp_path):
    world, host, backend, work = build(tmp_path)
    real_link = host.link_new

    def racing(tmp, final):
        host.files[final] = b"raced in\n"
        host.meta[final] = FakeStat(0o644, 0, 0, stat.S_IFREG, ino=9)
        real_link(tmp, final)

    host.link_new = racing
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_ALREADY_PRESENT"
    assert host.files[tool.UNIT_PATH] == b"raced in\n"
    assert refusal(tool.rollback, work, host, backend) == "ROLLBACK_UNIT_IDENTITY_UNKNOWN"  # never removes what it cannot prove it wrote
    assert host.files[tool.UNIT_PATH] == b"raced in\n"


@pytest.mark.parametrize("bad", ["", "abc", "0" * 63, "0" * 65, PIN.upper(), PIN + "\n"])
def test_a_malformed_pin_is_refused_before_any_mutation(tmp_path, bad):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, pin=bad) == "UNIT_PIN_INVALID"
    assert not host.files.get(tool.UNIT_PATH) and not (work / tool.JOURNAL_NAME).exists()


def test_a_sha_mismatch_is_refused_before_any_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, pin="0" * 64) == "UNIT_PIN_MISMATCH"
    assert tool.UNIT_PATH not in host.files and not (work / tool.JOURNAL_NAME).exists()
    assert not [e for e in world.events if e.startswith(("write:", "link:", "systemctl:daemon-reload", "systemctl:start"))]


# ═══ ordering, one start, no enable ══════════════════════════════════════════════════════════════════════════════════════════


def test_ordering_is_install_then_daemon_reload_then_exactly_one_start_then_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    ev = world.events
    link, reload, start = ev.index(f"link:{tool.UNIT_PATH}"), ev.index("systemctl:daemon-reload"), ev.index(f"systemctl:start {tool.DETECTOR_UNIT}")
    assert link < reload < start
    assert [e for e in ev if e.startswith("systemctl:start")] == [f"systemctl:start {tool.DETECTOR_UNIT}"] and backend.starts == 1
    assert host.sleeps == [tool.SETTLE_SEC]  # one bounded observation window, never a second start
    assert [e for e in ev if e.startswith("systemctl:daemon-reload")] == ["systemctl:daemon-reload"]
    assert json.loads((work / tool.JOURNAL_NAME).read_text())["phase"] == "complete"


def test_the_start_reuses_the_reviewed_ordered_gate_rather_than_duplicating_it():
    code = code_only(TOOL_PATH)
    assert "F1.start_detector(uid, core_uid, host, backend)" in code
    assert code.count('systemctl("start"') == 0  # the ONLY start verb is reached through start_detector


def test_a_second_start_in_one_process_is_refused_by_the_backend(tmp_path):
    world, host, backend, work = build(tmp_path)
    backend.systemctl("start", tool.DETECTOR_UNIT)
    assert refusal(backend.systemctl, "start", tool.DETECTOR_UNIT) == "DETECTOR_START_ALREADY_ISSUED"


def test_a_second_apply_for_the_same_work_directory_is_refused_and_does_not_start(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    backend2 = FakeBackend(world, host)
    assert refusal(run_apply, host, backend2, work) == "ATTEMPT_JOURNAL_ALREADY_EXISTS"
    assert backend2.starts == 0


@pytest.mark.parametrize("verb", [("enable", tool.DETECTOR_UNIT), ("disable", tool.DETECTOR_UNIT), ("restart", tool.DETECTOR_UNIT), ("restart", tool.CORE_UNIT),
                                  ("stop", tool.CORE_UNIT), ("start", tool.CORE_UNIT), ("reload", tool.CORE_UNIT), ("kill", tool.DETECTOR_UNIT),
                                  ("mask", tool.DETECTOR_UNIT), ("reset-failed", tool.DETECTOR_UNIT), ("daemon-reexec",), ("enable", "--now", tool.DETECTOR_UNIT),
                                  ("start", tool.DETECTOR_UNIT, tool.CORE_UNIT), ("show", "ssh.service"), ("show", tool.CORE_UNIT, "Environment")])
def test_the_backend_allow_list_refuses_every_other_verb(verb):
    assert refusal(tool.F1Backend().systemctl, *verb) == "SYSTEMCTL_VERB_NOT_ALLOWED"


@pytest.mark.parametrize("state", ["enabled", "enabled-runtime", "linked", "linked-runtime", "masked", "masked-runtime", "static", "indirect", ""])
def test_unit_file_state_must_be_exactly_disabled_before_the_start(tmp_path, state):
    world, host, backend, work = build(tmp_path, unit_file_state=state)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_IN_EXPECTED_PRE_START_STATE"
    assert backend.starts == 0 and json.loads((work / tool.JOURNAL_NAME).read_text())["start_issued"] is False  # refused before any start


@pytest.mark.parametrize("state", ["enabled", "enabled-runtime", "linked", "linked-runtime", "masked", "masked-runtime"])
def test_unit_file_state_changed_after_our_start_is_refused_exactly(tmp_path, state):
    world, host, backend, work = build(tmp_path, enable_on_start=state)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_FILE_STATE_UNEXPECTED"
    assert backend.starts == 1
    world.enable_on_start = None
    world.unit_file_state = "disabled"
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"}  # our own start is stopped and our own unit removed


def test_the_exact_expected_unit_file_state_and_pre_start_state_are_pinned():
    assert tool.EXPECTED_UNIT_FILE_STATE == "disabled"
    assert tool.PRE_START_STATE == {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "NRestarts": "0", "Result": "success",
                                    "UnitFileState": "disabled", "Restart": "no", "FragmentPath": "/etc/systemd/system/aegis-idea3-detector.service"}


def test_the_stage_never_enables_the_unit(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert not [c for c in backend.calls if c[0] in ("enable", "disable", "mask", "link", "preset")]
    for path in (TOOL_PATH, STAGE / "apply.sh", STAGE / "verify.sh", STAGE / "rollback.sh", RUNNER, LIB):
        text = code_only(path) if path.suffix == ".py" else active_shell(path)
        assert not re.search(r"systemctl\s+(--now\s+)?(enable|disable|mask|link|preset)\b|enable\s+--now|\bis-enabled\b.*\bset\b", text), path


# ═══ rollback ════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def test_rollback_before_start_removes_only_the_installed_unit_and_never_stops_anything(tmp_path):
    world, host, backend, work = build(tmp_path, reload_rc=1)
    assert refusal(run_apply, host, backend, work) == "DAEMON_RELOAD_FAILED"
    assert tool.UNIT_PATH in host.files and backend.starts == 0
    world.reload_rc = 0
    assert tool.rollback(work, host, backend) == {"F1_ROLLBACK": "PASS"}
    assert tool.UNIT_PATH not in host.files and not world.loaded
    assert not [e for e in world.events if e.startswith("systemctl:stop")]  # this attempt never started it
    assert world.events.count("systemctl:daemon-reload") == 2  # the failed apply reload, then the rollback reload


def test_rollback_after_start_stops_the_detector_removes_the_unit_and_reloads_in_order(tmp_path):
    world, host, backend, work = build(tmp_path, die_on_settle=True)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_RUNNING"  # verify failure after the one start
    assert backend.starts == 1
    mark = len(world.events)
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"}
    tail = [e for e in world.events[mark:] if not e.startswith("systemctl:show")]
    assert tail == [f"systemctl:stop {tool.DETECTOR_UNIT}", f"unlink:{tool.UNIT_PATH}", "systemctl:daemon-reload"]
    assert tool.UNIT_PATH not in host.files and not world.active and not world.loaded


def test_rollback_after_a_fully_complete_apply_also_cleans_up(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert world.active
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"}
    assert not world.active and tool.UNIT_PATH not in host.files


def test_start_failure_triggers_a_bounded_rollback_with_one_stop_and_no_second_start(tmp_path):
    world, host, backend, work = build(tmp_path, start_rc=1)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_START_FAILED"
    assert backend.starts == 1
    rb = FakeBackend(world, host)
    assert tool.rollback(work, host, rb) == {"F1_ROLLBACK": "PASS"}
    assert rb.starts == 0 and [c for c in rb.calls if c[0] == "stop"] == [("stop", tool.DETECTOR_UNIT)]
    assert tool.UNIT_PATH not in host.files


def test_a_gate_refusal_before_the_start_does_not_claim_this_attempt_started_it(tmp_path):
    world, host, backend, work = build(tmp_path, with_socket=False)  # start_detector refuses ALERT_SOCKET_MISSING before any start
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"
    assert backend.starts == 0 and json.loads((work / tool.JOURNAL_NAME).read_text())["start_issued"] is False
    rb = FakeBackend(world, host)
    assert tool.rollback(work, host, rb) == {"F1_ROLLBACK": "PASS"}
    assert not [c for c in rb.calls if c[0] == "stop"]  # never stops what it did not start
    assert tool.UNIT_PATH not in host.files


def test_verify_failure_when_the_core_was_restarted_triggers_rollback_not_a_core_restart(tmp_path):
    world, host, backend, work = build(tmp_path)
    original = host.sleep

    def sleep_then_core_restarts(seconds):
        original(seconds)
        world.core["MainPID"] = "9999"

    host.sleep = sleep_then_core_restarts
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"}
    assert not [e for e in world.events if "restart" in e and "aegis-idea3-core" in e]


def test_a_changed_unit_before_rollback_is_refused_and_left_for_the_owner(tmp_path):
    world, host, backend, work = build(tmp_path, die_on_settle=True)
    refusal(run_apply, host, backend, work)
    host.files[tool.UNIT_PATH] = UNIT_BYTES + b"# tampered\n"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "INSTALLED_UNIT_BYTES_CHANGED"
    assert tool.UNIT_PATH in host.files  # never removed


def test_a_replaced_inode_with_identical_bytes_is_also_refused(tmp_path):
    world, host, backend, work = build(tmp_path, die_on_settle=True)
    refusal(run_apply, host, backend, work)
    host.meta[tool.UNIT_PATH] = FakeStat(0o644, 0, 0, stat.S_IFREG, ino=424242)
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "INSTALLED_UNIT_NOT_OWNED_BY_THIS_ATTEMPT"
    assert tool.UNIT_PATH in host.files


def test_a_failed_stop_during_rollback_fails_closed_and_leaves_the_unit(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.stop_rc = 1
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "DETECTOR_STOP_FAILED"
    assert tool.UNIT_PATH in host.files


def test_rollback_with_no_journal_or_after_a_completed_rollback_is_a_safe_noop(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert tool.rollback(work, host, backend) == {"F1_ROLLBACK": "NOTHING_OWNED"}
    run_apply(host, backend, work)
    tool.rollback(work, host, FakeBackend(world, host))
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "ALREADY_ROLLED_BACK"}


def test_a_corrupt_or_foreign_journal_fails_closed(tmp_path):
    world, host, backend, work = build(tmp_path)
    (work / tool.JOURNAL_NAME).write_text("not json")
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNREADABLE"
    (work / tool.JOURNAL_NAME).write_text(json.dumps({"stage": "L8p", "phase": "installed"}))
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNEXPECTED"


def test_the_journal_is_written_before_each_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    seen: list[str] = []
    real_write = tool.write_journal

    def spy(path, data):
        seen.append(f"{data['phase']}:{data.get('start_issued')}:{data.get('daemon_reload')}")
        return real_write(path, data)

    tool.write_journal, original = spy, tool.write_journal
    try:
        run_apply(host, backend, work)
    finally:
        tool.write_journal = original
    assert seen[:2] == ["preflight:False:False", "installing:False:False"]
    assert seen.index("starting:True:True") > seen.index("installed:False:False")


# ═══ verify, Core and core.env unchanged ═════════════════════════════════════════════════════════════════════════════════════


def test_verify_is_read_only_and_requires_a_completed_attempt(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(tool.verify, DETECTOR_UID, CORE_UID, work, host, backend) == "ATTEMPT_NOT_COMPLETE"
    run_apply(host, backend, work)
    mark = len(world.events)
    out = tool.verify(DETECTOR_UID, CORE_UID, work, host, FakeBackend(world, host))
    assert out["F1_VERIFY"] == "PASS" and out["F1_PRODUCTION_DEPLOYED"] == "YES" and out["F1_DETECTOR_STARTED"] == "YES"
    assert out["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and out["RECOVERY_R1_R8_PROVEN"] == "NO" and out["R1_VERIFIED"] == "NOT_CLAIMED"
    assert not [e for e in world.events[mark:] if not e.startswith("systemctl:show")]  # no start/stop/reload/write


def test_core_pid_and_restart_count_must_be_unchanged_and_verify_reruns_the_non_secret_env_predicate(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["NRestarts"] = "1"
    assert refusal(tool.verify, DETECTOR_UID, CORE_UID, work, host, FakeBackend(world, host)) == "CORE_RESTARTED_OR_REPLACED"
    world.core["NRestarts"] = "0"
    host.files[F1.CORE_ENV] = f"AEGIS_PROFILE=production\n{KEY}=954\n".encode()  # verify has no pre-change digest: only the existing uid predicate
    assert refusal(tool.verify, DETECTOR_UID, CORE_UID, work, host, FakeBackend(world, host)) == "ALERT_SOURCE_UID_MISMATCH"


def journal_text(work) -> str:
    return (work / tool.JOURNAL_NAME).read_text()


def test_core_env_digest_and_bytes_are_never_persisted(tmp_path):
    world, host, backend, work = build(tmp_path)
    env = host.files[F1.CORE_ENV]
    run_apply(host, backend, work)
    text = journal_text(work)
    data = json.loads(text)
    assert "core_env_sha256" not in data and not [k for k in data if "env" in k and k != "core_env_preserved"]
    assert data["core_env_preserved"] is True
    assert hashlib.sha256(env).hexdigest() not in text and env.decode().strip().splitlines()[-1] not in text and "AEGIS_PROFILE" not in text
    assert sorted(data) == ["core_env_preserved", "core_main_pid", "core_n_restarts", "daemon_reload", "phase", "stage", "start_issued", "unit_dev", "unit_ino", "unit_sha256"]
    assert sorted(p.name for p in work.iterdir()) == [tool.JOURNAL_NAME]  # the work directory (copied to evidence) holds only the journal
    assert "core_env_digest" not in code_only(TOOL_PATH) and "core_env_sha256" not in code_only(TOOL_PATH)


def test_the_core_env_comparison_is_in_memory_only_and_output_is_a_fixed_boolean(tmp_path, capsys):
    code = code_only(TOOL_PATH)
    assert "env_before = host.read_bytes(F1.CORE_ENV)" in code and "del env_before" in code
    assert not re.search(r"hashlib|sha256\([^)]*CORE_ENV|sha256\(env", code.split("def apply(")[1].split("def verify_after_start")[0])
    world, host, backend, work = build(tmp_path)
    out = run_apply(host, backend, work)
    assert out["CORE_ENV_PRESERVED"] == "YES"
    shown = json.dumps(out) + journal_text(work)
    assert "AEGIS_" not in shown and str(DETECTOR_UID) not in json.dumps(out)


def test_a_core_env_changed_during_apply_is_refused_and_rolled_back(tmp_path):
    world, host, backend, work = build(tmp_path)
    original = host.sleep

    def sleep_then_env_changes(seconds):
        original(seconds)
        host.files[F1.CORE_ENV] = host.files[F1.CORE_ENV] + b"AEGIS_SOMETHING=1\n"

    host.sleep = sleep_then_env_changes
    assert refusal(run_apply, host, backend, work) == "CORE_ENV_CHANGED"
    assert json.loads(journal_text(work))["core_env_preserved"] is False
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"}


def test_an_unchanged_core_env_passes_and_is_recorded_only_as_a_boolean(tmp_path):
    world, host, backend, work = build(tmp_path)
    before = host.files[F1.CORE_ENV]
    assert run_apply(host, backend, work)["CORE_ENV_PRESERVED"] == "YES"
    assert host.files[F1.CORE_ENV] == before and json.loads(journal_text(work))["core_env_preserved"] is True


def test_a_concurrently_started_detector_is_refused_before_our_start_and_never_adopted(tmp_path):
    world, host, backend, work = build(tmp_path, race_after_reload=True)  # preflight sees absent; install + reload; then another actor starts it
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_IN_EXPECTED_PRE_START_STATE"
    assert backend.starts == 0 and not [e for e in world.events if e.startswith("systemctl:start")]  # we issued no start
    journal = json.loads(journal_text(work))
    assert journal["start_issued"] is False and journal["phase"] != "complete"  # the stage does not claim it performed the start
    unit_before, events_before = host.files[tool.UNIT_PATH], len(world.events)
    rb = FakeBackend(world, host)
    assert refusal(tool.rollback, work, host, rb) == "ROLLBACK_EXTERNAL_DETECTOR_ACTIVE"
    after = [e for e in world.events[events_before:]]
    assert after == ["systemctl:show aegis-idea3-detector.service"]  # one read-only state query; NO stop, NO unlink, NO daemon-reload
    assert world.active and host.files[tool.UNIT_PATH] == unit_before and tool.UNIT_PATH in host.meta  # the external process runs; our exact unit stays
    assert not [c for c in rb.calls if c[0] in ("stop", "start", "daemon-reload")]
    assert json.loads(journal_text(work))["phase"] != "rolled_back"  # nothing was recorded as rolled back


def test_a_race_between_the_post_reload_check_and_the_start_is_caught_by_the_backend_hook(tmp_path):
    world, host, backend, work = build(tmp_path)
    real_check = tool.verify_pre_start_state
    calls = []

    def flip_after_first(b):
        calls.append(1)
        real_check(b)
        if len(calls) == 1:
            world.active = True  # becomes active right after the first (post-reload) check passed

    tool.verify_pre_start_state = flip_after_first
    try:
        assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_IN_EXPECTED_PRE_START_STATE"
    finally:
        tool.verify_pre_start_state = real_check
    assert len(calls) == 2 and backend.starts == 0


def test_a_core_that_is_not_running_is_refused_before_any_mutation(tmp_path):
    world, host, backend, work = build(tmp_path)
    world.core["ActiveState"] = "inactive"
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_RUNNING"
    assert tool.UNIT_PATH not in host.files


@pytest.mark.parametrize("label,kw,reason", [
    ("account_missing", {"users": {F1.CORE_USER: CORE_UID}}, "DETECTOR_ACCOUNT_MISSING"),
    ("account_uid_differs", {"users": {F1.DETECTOR_ACCOUNT: 954, F1.CORE_USER: CORE_UID}}, "DETECTOR_UID_MISMATCH"),
    ("core_env_uid_differs", {"env_uid": "954"}, "ALERT_SOURCE_UID_MISMATCH"),
    ("running_core_lacks_uid", {"proc_env_uid": "954"}, "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("socket_wrong_mode", {"socket_mode": 0o660}, "ALERT_SOCKET_WRONG_MODE"),
])
def test_identity_core_env_running_core_and_socket_contracts_refuse_and_roll_back_cleanly(tmp_path, label, kw, reason):
    world, host, backend, work = build(tmp_path, **kw)
    got = refusal(run_apply, host, backend, work)
    if label in ("account_missing", "account_uid_differs"):
        assert got == reason and tool.UNIT_PATH not in host.files  # refused in preflight, nothing installed
    else:
        assert got == reason and backend.starts == 0  # refused by the reused start gate BEFORE the single start
        assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"} and tool.UNIT_PATH not in host.files


# ═══ boundaries: no Core restart, no group/core.env mutation, no alert, no CUT/RESTORE, no ESP32/serial ═══════════════════════


FORBIDDEN_TOOL_TOKENS = ("useradd", "groupadd", "usermod", "gpasswd", "chgrp", "journalctl", "alert_sink", "AlertSink", "send_alert", "socket.socket", "AF_UNIX",
                         "serial", "esptool", "ttyUSB", "ttyACM", "mqtt", "paho", "CUT", "RESTORE", "isolate", "nft ")
FORBIDDEN_VERB_LITERALS = {"restart", "try-restart", "reload-or-restart", "enable", "disable", "mask", "unmask", "reload", "kill", "isolate", "preset", "link", "--now",
                           "reset-failed", "set-property", "daemon-reexec"}


def test_the_deploy_tool_has_no_group_user_core_env_alert_cut_restore_or_hardware_surface():
    code = code_only(TOOL_PATH)
    for token in FORBIDDEN_TOOL_TOKENS:
        assert token not in code, token
    # no systemctl verb literal other than show/daemon-reload/start/stop exists anywhere in the tool (reasons such as DETECTOR_UNIT_ENABLED are not verbs)
    literals = {n.value for n in ast.walk(ast.parse(TOOL_PATH.read_text())) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    assert not (literals & FORBIDDEN_VERB_LITERALS), literals & FORBIDDEN_VERB_LITERALS
    # core.env is only ever READ (and hashed); it is never opened for writing or passed to a writer
    assert "CORE_ENV" in code and not re.search(r"write\w*\([^)]*CORE_ENV", code)
    assert len(re.findall(r"\bwrite_exclusive\(", code)) == 2  # the definition and the single unit-temp call


def test_the_stage_scripts_never_touch_the_core_core_env_groups_hardware_or_recovery():
    for path in (STAGE / "apply.sh", STAGE / "verify.sh", STAGE / "rollback.sh"):
        text = active_shell(path)
        assert not re.search(r"systemctl|useradd|groupadd|usermod|gpasswd|esptool|/dev/tty|mosquitto|1883|8883|nft |recovery_ui|server_admin", text), path
        assert "AEGIS_F1_LIVE_AUTHORIZED" in text  # guarded: refuses without the live flag
        assert text.count("exec ") == 1


def test_the_runner_and_lib_never_restart_the_core_or_run_recovery_or_touch_hardware():
    for path in (RUNNER, LIB):
        text = active_shell(path)
        assert not re.search(r"systemctl\s+(restart|stop|start|reload|enable|disable|kill|mask)\b", text), path
        assert not re.search(r"esptool|/dev/tty|serial|recovery_ui|server_admin|RESTORE|\bCUT\b|--live|alert\.sock\s*<|nc\s+-U|socat", text), path


def test_the_only_place_the_live_flag_is_set_is_the_post_gate_handler_function():
    text = active_shell(RUNNER)
    assert text.count("AEGIS_F1_LIVE_AUTHORIZED=YES") == 1
    handler = text[text.index("handler() {"):text.index("own_pre()")]
    assert "AEGIS_F1_LIVE_AUTHORIZED=YES" in handler
    assert "AEGIS_F1_LIVE_AUTHORIZED" not in active_shell(LIB)


def test_the_claim_boundary_is_explicit_and_makes_no_unprovable_recovery_or_alert_claim():
    text = RUNNER.read_text()
    shell = active_shell(RUNNER)
    assert "F1_PRODUCTION_DEPLOYED=YES F1_DETECTOR_STARTED=YES" in text
    for claim in ("F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "RECOVERY_R1_R8_PROVEN=NO", "R1_VERIFIED=NOT_CLAIMED", "F1_STAGE_ALERT_INJECTED=NO", "F1_CLAIM_BOUNDARY"):
        assert claim in shell, claim
    assert "RECOVERY_LIVE_EXECUTED" not in text and "RECOVERY_LIVE_EXECUTED" not in TOOL_PATH.read_text()  # unprovable: a real alert may occur in the window
    assert not re.search(r"\bALERT_INJECTED=NO\b", shell.replace("F1_STAGE_ALERT_INJECTED=NO", ""))
    assert "naturally occurring REAL validated alert" in shell and "external production event" in shell
    assert not re.search(r"F1_REAL_DETECTOR_ACCEPTANCE=(PASS|YES)|RECOVERY_R1_R8_PROVEN=YES|R1_VERIFIED=(YES|NO\b)", text + TOOL_PATH.read_text())
    readme = (DEPLOY / "README.md").read_text()
    assert "does NOT claim `RECOVERY_LIVE_EXECUTED=NO`" in readme


def test_the_cli_refuses_without_the_live_flag_and_without_root(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("AEGIS_F1_LIVE_AUTHORIZED", raising=False)
    assert tool.main(["rollback", "--work-dir", str(tmp_path)]) == 1
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_F1_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["apply", "--work-dir", str(tmp_path), "--uid", "953", "--unit-sha256", PIN]) == 1
    assert "ROOT_REQUIRED" in capsys.readouterr().err


def test_the_work_directory_must_be_private_absolute_and_not_a_symlink(tmp_path):
    loose = tmp_path / "loose"
    loose.mkdir(mode=0o755)
    os.chmod(loose, 0o755)
    assert refusal(tool.require_work_dir, str(loose)) == "WORK_DIR_NOT_PRIVATE"
    assert refusal(tool.require_work_dir, "relative") == "WORK_DIR_INVALID"
    target = tmp_path / "t"
    target.mkdir(mode=0o700)
    link = tmp_path / "l"
    link.symlink_to(target)
    assert refusal(tool.require_work_dir, str(link)) == "WORK_DIR_INVALID"


# ═══ governance: stage registration, authorization/K3, handlers, one-attempt marker, receipt gate ═══════════════════════════════


def stages() -> list[str]:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    return line.split('"')[1].split()


def test_f1_is_registered_after_l8p_and_before_l8():
    order = stages()
    # F1r (current-release activation) sits between L8p and F1; F1 itself stays after L8p and before L8.
    assert order.index("L7") < order.index("L7u") < order.index("L8p") < order.index("F1r") < order.index("F1") < order.index("L8") < order.index("L9")
    assert order.count("F1") == 1 and "F1b" not in order


def test_the_f1_handler_set_is_exactly_the_five_contract_files_and_executable_where_required():
    assert sorted(p.name for p in STAGE.iterdir()) == ["allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert os.access(STAGE / name, os.X_OK)
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        active = [l for l in (STAGE / name).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
        assert active == [], name  # ZERO active entries by contract


def _bash(script: str, cwd: Path | None = None, env_extra: dict | None = None) -> "subprocess.CompletedProcess":
    env = {"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": "", **(env_extra or {})}
    return _REAL_RUN(["bash", "-c", script], capture_output=True, text=True, cwd=cwd, env=env, timeout=60, check=False)


_REAL_RUN = subprocess.run


def _gate_record(stage: str, **extra) -> str:
    rows = {"stage": stage, "date": _today(), "authorizer": "music", "scope": "F1 detector unit install and one start", "reference": "OD-F1-STAGE-01", **extra}
    return "AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def _k3_record(stage: str) -> str:
    rows = {"stage": stage, "date": _today(), "confirmed_by": "music", "confirmation_mode": "IDEA3_OWNER_SELF_ATTESTATION", "idea1_window_overlap": "NONE_KNOWN",
            "reference": "OD-F1-STAGE-01"}
    return "AEGIS_P4_K3_CONFIRMATION_V2\n" + "".join(f"{k}={v}\n" for k, v in rows.items())


def _today() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")


def _stage_gate(tmp_path, stage, auth, k3, mode="live"):
    a, k = tmp_path / "authorization.txt", tmp_path / "k3.txt"
    a.write_text(auth)
    k.write_text(k3)
    return _REAL_RUN(["bash", str(GATE), "--stage", stage, "--mode", mode, "--authorization", str(a), "--k3", str(k)], capture_output=True, text=True,
                     env={"PATH": os.environ["PATH"], "LC_ALL": "C", "TZ": "Asia/Bangkok"}, timeout=60, check=False)


def test_stage_f1_gate_accepts_a_same_day_no_extra_field_record_and_reports_the_handler_registered(tmp_path):
    result = _stage_gate(tmp_path, "F1", _gate_record("F1"), _k3_record("F1"))
    assert result.returncode == 0, result.stdout + result.stderr
    lines = result.stdout.splitlines()
    for expected in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "STAGE_MUTATES_PRODUCTION=YES", "REQUIRED_REPOSITORY_GAPS=none",
                     "LIVE_STAGE_AUTHORIZED=NO", "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert expected in lines, expected


@pytest.mark.parametrize("extra", [{"d6_notice": "pub"}, {"integration_review": "kla"}, {"recovery_authorization": "OD-RECOVERY-01"},
                                   {"physical_recovery_attestation": "OD-PHYSICAL-01"}])
def test_stage_f1_carries_no_extra_authorization_field(tmp_path, extra):
    result = _stage_gate(tmp_path, "F1", _gate_record("F1", **extra), _k3_record("F1"))
    assert result.returncode == 1 and "GATE_FAIL AUTHORIZATION_MALFORMED" in result.stdout


def test_an_authorization_for_another_stage_or_a_stale_one_is_refused_for_f1(tmp_path):
    other = _stage_gate(tmp_path, "F1", _gate_record("L8p", physical_recovery_attestation="OD-PHYSICAL-01"), _k3_record("F1"))
    assert "GATE_FAIL AUTHORIZATION_" in other.stdout and other.returncode == 1
    stale = _stage_gate(tmp_path, "F1", _gate_record("F1", date="2020-01-01"), _k3_record("F1"))
    assert "GATE_FAIL AUTHORIZATION_STALE" in stale.stdout
    wrong_k3 = _stage_gate(tmp_path, "F1", _gate_record("F1"), _k3_record("L8p"))
    assert "GATE_FAIL K3_STAGE_MISMATCH" in wrong_k3.stdout


def test_f1_authorization_is_not_accepted_for_neighbouring_stages(tmp_path):
    for stage in ("L8p", "L8"):
        result = _stage_gate(tmp_path, stage, _gate_record("F1"), _k3_record("F1"))
        assert result.returncode == 1 and "AUTHORIZATION_RECORD=INVALID" in result.stdout and "AUTHORIZATION_RECORD=VALID" not in result.stdout


def source_lib(snippet: str, cwd: Path | None = None, **env) -> "subprocess.CompletedProcess":
    return _bash(f'set -uo pipefail; . "{LIB}"; {snippet}', cwd=cwd, env_extra=env)


def test_the_one_attempt_marker_is_consumed_once_and_has_a_distinct_name(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    ok = source_lib(f'f1_attempt_unconsumed "{auth}" && f1_consume_attempt "{auth}" && echo consumed')
    assert ok.returncode == 0 and "consumed" in ok.stdout
    assert (auth / "F1-ATTEMPT-CONSUMED").is_file()
    again = source_lib(f'f1_attempt_unconsumed "{auth}"')
    assert again.returncode == 1 and "F1_ATTEMPT_ALREADY_CONSUMED" in again.stderr
    second = source_lib(f'f1_consume_attempt "{auth}"')
    assert second.returncode == 1 and "F1_ATTEMPT_ALREADY_CONSUMED" in second.stderr
    other = tmp_path / "other"
    other.mkdir()
    (other / "L8p-ATTEMPT-CONSUMED").write_text("x")  # another stage's marker never authorizes or blocks F1
    assert source_lib(f'f1_attempt_unconsumed "{other}"').returncode == 0


def git_repo(tmp_path: Path, receipts: dict[str, str]) -> Path:
    repo = tmp_path / "repo"
    (repo / Path(L8P_RECEIPT).parent).mkdir(parents=True)
    env = {"PATH": os.environ["PATH"], "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(tmp_path)}
    _REAL_RUN(["git", "init", "-q", str(repo)], env=env, check=True)
    for rel, text in receipts.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    _REAL_RUN(["git", "-C", str(repo), "add", "-A"], env=env, check=True)
    _REAL_RUN(["git", "-C", str(repo), "commit", "-q", "-m", "fixture"], env=env, check=True)
    return repo


L8P_OK = "# closeout\nL8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
F1R_OK = "# f1r closeout\nF1R_LIVE_EXECUTED=YES\nF1R_CURRENT_SWITCHED=YES\n"
F1R_RECEIPT = f"{LOGS}/2026-10-06_000000_music_idea3-f1r-live-closeout.md"


def gate_result(repo: Path):
    return source_lib(f'f1_receipt_gate "{repo}"')


def test_the_receipt_gate_passes_only_with_the_canonical_l8p_closeout_the_f1r_closeout_and_no_recorded_f1(tmp_path):
    repo = git_repo(tmp_path, {L8P_RECEIPT: L8P_OK, F1R_RECEIPT: F1R_OK})
    result = gate_result(repo)
    assert result.returncode == 0, result.stderr


def test_the_receipt_gate_refuses_before_l8p_is_closed(tmp_path):
    assert "F1_L8P_NOT_CLOSED" in gate_result(git_repo(tmp_path / "a", {f"{LOGS}/x.md": "# nothing\n"})).stderr
    only_one_field = git_repo(tmp_path / "b", {L8P_RECEIPT: "L8P_LIVE_EXECUTED=YES\n"})
    assert "F1_L8P_NOT_CLOSED" in gate_result(only_one_field).stderr
    split = git_repo(tmp_path / "c", {L8P_RECEIPT: "L8P_LIVE_EXECUTED=YES\n", f"{LOGS}/other.md": "L8P_PROVISIONING=PASS\n"})
    assert "F1_L8P_NOT_CLOSED" in gate_result(split).stderr  # the two fields in two receipts never combine
    failed = git_repo(tmp_path / "d", {L8P_RECEIPT: "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=FAIL\n"})
    assert "F1_L8P_NOT_CLOSED" in gate_result(failed).stderr


def test_the_receipt_gate_requires_the_result_in_the_canonical_receipt_and_unique(tmp_path):
    elsewhere = git_repo(tmp_path / "a", {f"{LOGS}/2026-10-04_000000_music_other.md": L8P_OK})
    assert "F1_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT" in gate_result(elsewhere).stderr
    two = git_repo(tmp_path / "b", {L8P_RECEIPT: L8P_OK, f"{LOGS}/2026-10-04_000000_music_other.md": L8P_OK})
    assert "F1_L8P_RESULT_NOT_UNIQUE" in gate_result(two).stderr


def test_the_receipt_gate_is_one_shot_for_f1_itself(tmp_path):
    repo = git_repo(tmp_path, {L8P_RECEIPT: L8P_OK, F1R_RECEIPT: F1R_OK, f"{LOGS}/2026-10-07_000000_music_f1.md": "F1_PRODUCTION_DEPLOYED=YES\nF1_DETECTOR_STARTED=YES\n"})
    assert "F1_ALREADY_DEPLOYED" in gate_result(repo).stderr
    one_field = git_repo(tmp_path / "y", {L8P_RECEIPT: L8P_OK, F1R_RECEIPT: F1R_OK, f"{LOGS}/2026-10-07_000000_music_f1.md": "F1_PRODUCTION_DEPLOYED=YES\n"})
    assert gate_result(one_field).returncode == 0  # a partial/blocked record is not a deployment


def test_the_receipt_gate_reads_the_pinned_commit_not_the_working_tree(tmp_path):
    repo = git_repo(tmp_path, {L8P_RECEIPT: "# not closed\n"})
    (repo / L8P_RECEIPT).write_text(L8P_OK)  # an uncommitted edit must not satisfy the gate
    assert "F1_L8P_NOT_CLOSED" in gate_result(repo).stderr


def test_the_real_repository_l8p_closeout_receipt_is_the_canonical_one_and_carries_both_fields():
    receipt = REPO_ROOT / L8P_RECEIPT
    if not receipt.exists():
        pytest.skip("canonical L8p closeout receipt not present in this checkout")
    lines = receipt.read_text().splitlines()
    assert "L8P_LIVE_EXECUTED=YES" in lines and "L8P_PROVISIONING=PASS" in lines
    assert f'F1_L8P_CLOSEOUT_RECEIPT_REL="{L8P_RECEIPT}"' in LIB.read_text()


def test_the_detector_absent_gate_refuses_a_present_or_loaded_unit_via_stubbed_systemctl(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text('#!/bin/bash\nprintf "%s\\n" "LoadState=${F1_LOAD:-not-found}" "ActiveState=inactive" "MainPID=${F1_PID:-0}"\n')
    (bindir / "pgrep").write_text('#!/bin/bash\nexit ${F1_PGREP:-1}\n')
    for stub in bindir.iterdir():
        stub.chmod(0o755)
    path = f"{bindir}:{os.environ['PATH']}"

    def gate(**env):
        return _REAL_RUN(["bash", "-c", f'. "{LIB}"; f1_detector_absent_gate'], capture_output=True, text=True, timeout=30, check=False,
                         env={"PATH": path, "LC_ALL": "C", "SUDO": "", **env})

    assert gate().returncode == 0
    assert "F1_DETECTOR_UNIT_ALREADY_LOADED" in gate(F1_LOAD="loaded").stderr
    assert "F1_DETECTOR_PROCESS_RUNNING" in gate(F1_PID="321").stderr
    assert "F1_DETECTOR_PROCESS_RUNNING" in gate(F1_PGREP="0").stderr


def test_the_unit_pin_gate_accepts_only_the_reviewed_digest():
    tool_py = DEPLOY / "p4-f1-alert-source.py"
    ok = _REAL_RUN(["bash", "-c", f'. "{LIB}"; f1_unit_pin_gate "{sys.executable}" "{tool_py}" "{PIN}"'], capture_output=True, text=True, timeout=60, check=False,
                   env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": ""})
    assert ok.returncode == 0, ok.stderr
    bad = _REAL_RUN(["bash", "-c", f'. "{LIB}"; f1_unit_pin_gate "{sys.executable}" "{tool_py}" "{"1" * 64}"'], capture_output=True, text=True, timeout=60, check=False,
                    env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": ""})
    assert bad.returncode == 1 and "F1_UNIT_PIN_MISMATCH" in bad.stderr
    short = _REAL_RUN(["bash", "-c", f'. "{LIB}"; f1_unit_pin_gate "{sys.executable}" "{tool_py}" abc'], capture_output=True, text=True, timeout=60, check=False,
                      env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": ""})
    assert "F1_UNIT_PIN_INVALID" in short.stderr


def test_the_committed_runner_refuses_to_run_unpinned_and_creates_nothing(tmp_path):
    result = _REAL_RUN(["bash", str(RUNNER), str(tmp_path)], capture_output=True, text=True, timeout=30, check=False, cwd=tmp_path,
                       env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
    assert result.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in result.stdout
    assert list(tmp_path.iterdir()) == []


def test_the_runner_orders_gates_then_pre_capture_then_marker_then_apply_verify_post_compare():
    text = active_shell(RUNNER)
    order = ["l7u_identity_gate", "p4-stage-gate.sh", "f1_receipt_gate", "f1_detector_absent_gate", "capture PRE", "f1_consume_attempt", "handler apply.sh", "handler verify.sh",
             "capture POST", "compare \"$PRE\" \"$EVID/post-root\"", "l7u_secret_scan", "F1_LIVE_EXECUTED=YES"]
    positions = []
    for token in order:
        assert token in text, token
        positions.append(text.index(token))
    assert positions == sorted(positions)
    assert text.count("handler apply.sh") == 1 and text.count("f1_consume_attempt") == 1  # one apply, one marker consumption, no loop
    assert not re.search(r"\b(while|until|for)\b[^\n]*\bhandler (apply|verify|rollback)|\bhandler (apply|verify|rollback)[^\n]*\|\|\s*handler (apply|verify)", text)  # the handler is never looped or retried
    assert "rollback_flow" in text and text.count("handler rollback.sh") == 1


def test_the_runner_still_pins_the_original_five_owner_frozen_values():  # three runtime-release pins were added later: see the F1r stage tests
    text = RUNNER.read_text()
    for pin in ("PIN_MAIN_SHA", "PIN_OPERATOR_USER", "PIN_OPERATOR_UID", "PIN_ALERT_SOURCE_UID", "PIN_UNIT_SHA256"):
        assert f"={pin}\n" in text
    assert not re.search(r"=[0-9a-f]{40}\n|=[0-9a-f]{64}\n", text)  # no real value is committed
    assert "authorization-F1.txt" in text and "k3-F1.txt" in text and "--stage F1" in text


@pytest.mark.parametrize("active_state,pid", [("active", "777"), ("activating", "778"), ("deactivating", "779"), ("inactive", "780"), ("failed", "781")])
def test_rollback_without_our_start_refuses_unless_inactive_or_failed_with_no_pid(tmp_path, active_state, pid):
    world, host, backend, work = build(tmp_path, with_socket=False)  # start_detector refuses before any start: start_issued=false
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"
    assert json.loads(journal_text(work))["start_issued"] is False

    class Odd(FakeBackend):
        def _run(self, args):
            if args[0] == "show" and args[1] == tool.DETECTOR_UNIT:
                return tool.CommandResult(0, f"ActiveState={active_state}\nMainPID={pid}\n")
            return super()._run(args)

    rb = Odd(world, host)
    files_before = dict(host.files)
    assert refusal(tool.rollback, work, host, rb) == "ROLLBACK_EXTERNAL_DETECTOR_ACTIVE"  # a PID (or a non-final state) is another actor's process
    assert rb.calls == [("show", tool.DETECTOR_UNIT, "-pActiveState", "-pMainPID")]  # one read-only query, nothing else
    assert host.files == files_before and json.loads(journal_text(work))["phase"] != "rolled_back"


@pytest.mark.parametrize("active_state", ["inactive", "failed"])
def test_normal_rollback_with_no_own_start_and_a_non_running_detector_removes_only_the_owned_unit(tmp_path, active_state):
    world, host, backend, work = build(tmp_path, with_socket=False)
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"
    assert json.loads(journal_text(work))["start_issued"] is False and world.loaded
    reloads_before = world.events.count("systemctl:daemon-reload")

    class State(FakeBackend):
        def _run(self, args):
            if args[0] == "show" and args[1] == tool.DETECTOR_UNIT and "-pMainPID" in args and "-pLoadState" not in args:
                return tool.CommandResult(0, f"ActiveState={active_state}\nMainPID=0\n")
            return super()._run(args)

    rb = State(world, host)
    assert tool.rollback(work, host, rb) == {"F1_ROLLBACK": "PASS"}
    assert tool.UNIT_PATH not in host.files and not world.loaded
    assert not [c for c in rb.calls if c[0] in ("stop", "start")]  # never stops what it did not start
    assert world.events.count("systemctl:daemon-reload") == reloads_before + 1  # exactly one rollback reload
    assert json.loads(journal_text(work))["phase"] == "rolled_back"


# ═══ attempt-1 successor review: the verify path still requires a genuinely running detector ═══════════════════════════════════


def test_attempt_1_failure_shape_is_still_refused_by_the_stage_and_rolled_back(tmp_path):
    """Replay of the live failure: the detector starts, its journalctl dies, systemd logs "Deactivated successfully" (Result=success, inactive)."""
    world, host, backend, work = build(tmp_path, die_on_settle=True)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_RUNNING"
    assert backend.starts == 1 and world.active is False and json.loads(journal_text(work))["core_env_preserved"] is False
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1_ROLLBACK": "PASS"} and tool.UNIT_PATH not in host.files


GOOD_RUNNING = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "MainPID": "777", "Result": "success", "NRestarts": "0",
                "UnitFileState": "disabled", "Restart": "no", "FragmentPath": tool.UNIT_PATH}


class StateBackend(FakeBackend):
    def __init__(self, world, host, state):
        super().__init__(world, host)
        self.state = state

    def _run(self, args):
        if args[0] == "show" and args[1] == tool.DETECTOR_UNIT:
            return tool.CommandResult(0, "".join(f"{k}={v}\n" for k, v in self.state.items() if f"-p{k}" in args))
        return super()._run(args)


def test_the_expected_running_state_is_accepted_and_every_required_property_is_pinned(tmp_path):
    world, host, _, _ = build(tmp_path)
    assert tool.verify_loaded(StateBackend(world, host, dict(GOOD_RUNNING)), expect_active=True)["ActiveState"] == "active"


@pytest.mark.parametrize("key,bad,reason", [
    ("ActiveState", "inactive", "DETECTOR_NOT_RUNNING"), ("ActiveState", "failed", "DETECTOR_NOT_RUNNING"), ("ActiveState", "activating", "DETECTOR_NOT_RUNNING"),
    ("SubState", "dead", "DETECTOR_NOT_RUNNING"), ("SubState", "exited", "DETECTOR_NOT_RUNNING"), ("MainPID", "0", "DETECTOR_NO_MAIN_PID"),
    ("Result", "exit-code", "DETECTOR_UNHEALTHY"), ("NRestarts", "1", "DETECTOR_UNHEALTHY"), ("UnitFileState", "enabled", "DETECTOR_UNIT_FILE_STATE_UNEXPECTED"),
    ("Restart", "on-failure", "DETECTOR_RESTART_POLICY_CHANGED"), ("LoadState", "not-found", "DETECTOR_UNIT_NOT_LOADED"),
])
def test_each_required_running_property_is_enforced_and_nothing_was_weakened(tmp_path, key, bad, reason):
    world, host, _, _ = build(tmp_path)
    assert refusal(tool.verify_loaded, StateBackend(world, host, {**GOOD_RUNNING, key: bad}), True) == reason


# ═══ review hardening: F1 must prove the governed F1r predecessor, not just the runtime pins ═══════════════════════════════════


def f1r_repo(tmp_path, f1r: dict[str, str]):
    return git_repo(tmp_path, {L8P_RECEIPT: L8P_OK, **f1r})


def test_no_f1r_success_receipt_means_the_future_f1_refuses(tmp_path):
    result = gate_result(f1r_repo(tmp_path, {}))
    assert result.returncode == 1 and "F1_F1R_NOT_CLOSED" in result.stderr


def test_only_f1r_live_executed_refuses(tmp_path):
    assert "F1_F1R_NOT_CLOSED" in gate_result(f1r_repo(tmp_path, {F1R_RECEIPT: "F1R_LIVE_EXECUTED=YES\n"})).stderr


def test_only_f1r_current_switched_refuses(tmp_path):
    assert "F1_F1R_NOT_CLOSED" in gate_result(f1r_repo(tmp_path, {F1R_RECEIPT: "F1R_CURRENT_SWITCHED=YES\n"})).stderr


def test_f1r_fields_split_across_two_receipts_never_combine(tmp_path):
    repo = f1r_repo(tmp_path, {F1R_RECEIPT: "F1R_LIVE_EXECUTED=YES\n", f"{LOGS}/2026-10-06_010000_music_other.md": "F1R_CURRENT_SWITCHED=YES\n"})
    assert "F1_F1R_NOT_CLOSED" in gate_result(repo).stderr


def test_exactly_one_receipt_with_both_f1r_fields_passes(tmp_path):
    result = gate_result(f1r_repo(tmp_path, {F1R_RECEIPT: F1R_OK}))
    assert result.returncode == 0, result.stderr


def test_duplicate_successful_f1r_receipts_refuse(tmp_path):
    repo = f1r_repo(tmp_path, {F1R_RECEIPT: F1R_OK, f"{LOGS}/2026-10-06_020000_music_idea3-f1r-second.md": F1R_OK})
    assert "F1_F1R_RESULT_NOT_UNIQUE" in gate_result(repo).stderr


def test_a_repository_only_f1r_receipt_that_records_no_never_satisfies_the_gate(tmp_path):
    repo = f1r_repo(tmp_path, {F1R_RECEIPT: "F1R_LIVE_EXECUTED = NO\nF1R_CURRENT_SWITCHED = NO\n"})
    assert "F1_F1R_NOT_CLOSED" in gate_result(repo).stderr
    pr_receipt = next((REPO_ROOT / LOGS).glob("*_music_idea3-f1r-current-release-activation-stage.md"), None)
    if pr_receipt is not None:  # the repository-only PR receipt itself must never carry the authoritative YES pair
        lines = [line.strip().strip("`").replace(" ", "") for line in pr_receipt.read_text().splitlines()]
        assert "F1R_LIVE_EXECUTED=YES" not in lines and "F1R_CURRENT_SWITCHED=YES" not in lines


def test_the_f1r_predecessor_is_checked_after_l8p_and_the_runtime_gates_stay_as_defense_in_depth():
    text = LIB.read_text()
    body = text[text.index("f1_receipt_gate() {"):text.index("# f1_unit_pin_gate")]
    assert body.index("F1_L8P_NOT_CLOSED") < body.index("F1_F1R_NOT_CLOSED") < body.index("F1_ALREADY_DEPLOYED")
    runner = active_shell(RUNNER)
    assert "f1_receipt_gate" in runner and "f1_runtime_release_gate" in runner  # both remain
