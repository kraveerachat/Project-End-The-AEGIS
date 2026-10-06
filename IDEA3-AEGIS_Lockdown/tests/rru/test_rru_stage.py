"""Stage RRu (governed Recovery-PREPARATION release deployment): repository implementation only, hermetic fixtures only.

RRu owns exactly: install ONE new immutable release that also carries ``aegis_soc/cli.py`` and switch ``/opt/aegis-idea3/current`` OLD -> NEW. It restarts NOTHING. Nothing here touches /opt, systemd, a service, the
Core, the detector, a socket, an ESP32 or a real release: the tool is driven through a fake host and a fake systemd world (the REAL privileged-backend allow-list stays in force) and the shell gates run on
fixtures. These tests prove REPOSITORY behavior only; no live RRu PASS is claimed.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[2]
ROOT = APP.parent
DEPLOY = APP / "deploy" / "pr11-phase4"
TOOL_PATH = DEPLOY / "p4-rru-upgrade.py"
LIB = DEPLOY / "p4-rru-run-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-rru-owner.sh"
STAGE = DEPLOY / "stages" / "RRu"
P4_LIB = DEPLOY / "p4-lib.sh"
GATE = DEPLOY / "p4-stage-gate.sh"
COMPARE = DEPLOY / "p4-compare.sh"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
_REAL_RUN = subprocess.run

OLD = "ebffab6f8a6d7d98973fac7e89167352d529a87e"  # the release Production runs (R1Du) and the one `current` points at
NEW = "9cebd2a061f8d47bc97349762aa87f169c706710"
OPT, RELEASES = "/opt/aegis-idea3", "/opt/aegis-idea3/releases"
CURRENT = f"{OPT}/current"
OLD_PATH, NEW_PATH = f"{RELEASES}/{OLD}", f"{RELEASES}/{NEW}"
SOURCE_DIR = f"/home/owner/idea3-p4-evidence/rru-owner-source/{NEW}"
CORE_ENV, CRED_DIR = "/etc/aegis-idea3/core.env", "/etc/aegis-idea3/credentials"
UNIT_PATH = "/etc/systemd/system/aegis-idea3-detector.service"
DET_BYTES = b"# reviewed production_detector (fixture bytes)\n"
CORE_BYTES = b"# recovery_core fixture\nALERT_ACCEPTED = 'ALERT_ACCEPTED'\n"
CLI_BYTES = b"# cli fixture (Recovery D4 restore entrypoint)\n"
UNIT_BYTES = b"[Unit]\nRequires=aegis-idea3-core.service\n"
sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
DET_SHA, CORE_SHA, CLI_SHA, UNIT_SHA = sha(DET_BYTES), sha(CORE_BYTES), sha(CLI_BYTES), sha(UNIT_BYTES)
CORE_UID, DET_UID, REC_GID, ALERT_GID = 990, 991, 980, 981
ALERT, RECOVERY = "/run/aegis-idea3-alert/alert.sock", "/run/aegis-idea3-recovery/recovery.sock"
R1D_SOCK = "/run/aegis-idea3/historical-disposition.sock"


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_rru_upgrade", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()
PINS = tool.Pins(OLD, NEW, SOURCE_DIR, NEW, DET_SHA, CORE_SHA, UNIT_SHA, CLI_SHA)


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    def guarded(argv, *args, **kwargs):
        raise AssertionError(f"a real process must never be started by the RRu tool tests: {argv!r}")

    monkeypatch.setattr(subprocess, "run", guarded)


def refusal(fn, *args, **kwargs) -> str:
    with pytest.raises(tool.Refusal) as exc:
        fn(*args, **kwargs)
    return str(exc.value)


# ═══ fake world ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════


class World:
    def __init__(self):
        self.core = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "MainPID": "4242", "NRestarts": "0",
                     "ExecMainStartTimestamp": "T0", "ExecMainStartTimestampMonotonic": "1000"}
        self.det = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "disabled", "Restart": "no", "Result": "success", "MainPID": "5151",
                    "NRestarts": "0", "ExecMainStartTimestamp": "D0", "ExecMainStartTimestampMonotonic": "1100", "ActiveEnterTimestamp": "DA0", "InvocationID": "inv-d1",
                    "FragmentPath": UNIT_PATH, "DropInPaths": ""}
        self.core_cwd, self.det_cwd = OLD_PATH, OLD_PATH
        self.events: list[str] = []
        self.hooks: dict[str, object] = {}
        # RRu runs after the committed R1D disposition: that one-shot server has closed and unlinked its socket.
        self.core_fds = {101, 102}
        self.listeners = {ALERT: {101}, RECOVERY: {102}}
        self.r1d_arming = "YES"  # the unchanged running Core still carries the R1Du process environment
        self.groups = [CORE_UID, REC_GID, ALERT_GID]
        self.systemctl_calls: list[tuple[str, ...]] = []
        self.host: FakeHost | None = None

    def fire(self, name: str) -> None:
        self.events.append(name)
        hook = self.hooks.get(name)
        if hook:
            hook()


class FakeBackend(tool.RRuBackend):
    def __init__(self, world: World, host: "FakeHost", installer_rc: int = 0, installer_reason: str = "RELEASE_ALREADY_INSTALLED"):
        super().__init__()
        self.world, self.host = world, host
        self.installer_rc, self.installer_reason = installer_rc, installer_reason

    def _run(self, args, timeout=10.0):
        self.world.systemctl_calls.append(tuple(args))
        assert args[0] == "show"  # the real allow-list admits nothing else
        unit, wanted = args[1], [a[2:] for a in args[2:]]
        state = self.world.core if unit == tool.R1DU.CORE_UNIT else self.world.det
        return tool.CommandResult(0, "".join(f"{k}={state.get(k, '')}\n" for k in wanted))

    def run_installer(self, rid, source_dir, logical, evidence):
        if self.installs >= 1:
            tool.refuse("INSTALLER_ALREADY_INVOKED")
        self.installs += 1
        self.world.fire("install")
        if self.installer_rc:
            return tool.CommandResult(self.installer_rc, f"L7_RELEASE_INSTALL=FAIL reason={self.installer_reason}\n")
        self.host.copy_release(source_dir, logical)
        return tool.CommandResult(0, "L7_RELEASE_INSTALL=PASS\n")


class FakeHost(tool.RRuHost):
    def __init__(self, world: World):
        self.world = world
        world.host = self
        self.links = {CURRENT: OLD_PATH}
        self.dirs = {OPT, RELEASES, OLD_PATH, SOURCE_DIR, "/etc/aegis-idea3", CRED_DIR}
        self.files: dict[str, bytes] = {CORE_ENV: f"AEGIS_ALERT_SOURCE_UID={DET_UID}\nAEGIS_R1D_DISPOSITION_ENABLED=YES\n".encode(), f"{CRED_DIR}/k_c2d": b"sekrit-1",
                                        f"{CRED_DIR}/admin.pin": b"1234", UNIT_PATH: UNIT_BYTES}
        self.meta: dict[str, dict] = {}
        self.guard: dict[str, object] = {}
        self.ident = {"/run/aegis-idea3-recovery": {"kind": "dir", "mode": 0o750, "uid": CORE_UID, "gid": REC_GID},
                      "/run/aegis-idea3-alert": {"kind": "dir", "mode": 0o2750, "uid": CORE_UID, "gid": ALERT_GID},
                      ALERT: {"kind": "socket", "mode": 0o620, "uid": CORE_UID, "gid": ALERT_GID},
                      RECOVERY: {"kind": "socket", "mode": 0o660, "uid": CORE_UID, "gid": REC_GID}}
        self.ops: list[tuple[str, ...]] = []
        self.snapshots: list[bool] = []
        self.release(OLD_PATH, OLD, OLD)
        self.release(SOURCE_DIR, NEW, NEW, cli=True)
        self.guard[OLD_PATH], self.guard[SOURCE_DIR] = (OLD, OLD), (NEW, NEW)
        for i, path in enumerate(sorted(p for p in self.files if p.startswith("/etc/aegis-idea3"))):
            self.meta[path] = {"type": "file", "mode": 0o600, "uid": 0, "gid": 0, "size": len(self.files[path]), "mtime_ns": 1, "ctime_ns": 1, "ino": 10 + i}
        self.meta["/etc/aegis-idea3/credentials"] = {"type": "dir", "mode": 0o700, "uid": 0, "gid": 0, "size": 0, "mtime_ns": 1, "ctime_ns": 1, "ino": 9}

    def release(self, root, rid, source, *, cli=False):
        self.dirs.add(root)
        self.files[f"{root}/aegis_soc/historical_disposition.py"] = b"# R1D authority fixture\nEVENT = 'INCIDENT_DISPOSED_HISTORICAL'\n"
        self.files[f"{root}/aegis_soc/production_detector.py"] = DET_BYTES
        self.files[f"{root}/aegis_soc/recovery_core.py"] = CORE_BYTES
        self.files[f"{root}/aegis_soc/supervisor.py"] = b"# supervisor (Core entrypoint) fixture\n"
        self.files[f"{root}/requirements.txt"] = b"pinned==1\n"
        self.files[f"{root}/venv/bin/python"] = b"#!interpreter fixture\n"
        if cli:
            self.files[f"{root}/aegis_soc/cli.py"] = CLI_BYTES
        count = len([p for p in self.files if p.startswith(root + "/") and not p.endswith(("/RELEASE-MANIFEST.json", "/RELEASE-SHA256SUMS"))])
        self.files[f"{root}/RELEASE-MANIFEST.json"] = json.dumps({"release_id": rid, "source_git_sha": source, "source_tree_dirty": False, "schema_version": 1, "python_version": "3.14.0",
                                                                 "requirements_sha256": sha(b"pinned==1\n"), "file_count": count, "created_by_tool_version": "1"}).encode()

    def set_manifest(self, root, **over):
        data = json.loads(self.files[f"{root}/RELEASE-MANIFEST.json"])
        data.update(over)
        self.files[f"{root}/RELEASE-MANIFEST.json"] = json.dumps(data).encode()

    def copy_release(self, src, dst):
        self.dirs.add(dst)
        for path in [p for p in self.files if p.startswith(src + "/")]:
            self.files[dst + path[len(src):]] = self.files[path]
        self.guard[dst] = self.guard[src]

    def lexists(self, path):
        return path in self.links or path in self.files or path in self.dirs or path in self.ident or path in self.meta

    def is_symlink(self, path):
        return path in self.links

    def readlink(self, path):
        return self.links[path]

    def realpath(self, path):
        return self.links.get(path, path)

    def is_regular(self, path):
        return path in self.files

    def is_real_dir(self, path):
        return path in self.dirs

    def read_bytes(self, path):
        if path.endswith("/RELEASE-SHA256SUMS") and path not in self.files:
            root = path.rsplit("/", 1)[0]
            rows = sorted((p[len(root) + 1:], sha(b)) for p, b in self.files.items() if p.startswith(root + "/") and not p.endswith("/RELEASE-SHA256SUMS"))
            return "".join(f"{digest}  {rel}\n" for rel, digest in rows).encode()
        return self.files[path]

    def sha256_file(self, path):
        return sha(self.files[path])

    def listdir(self, path):
        return sorted({p[len(path) + 1:].split("/")[0] for p in [*self.files, *self.dirs, *self.meta] if p.startswith(path + "/")})

    def lstat_info(self, path):
        info = self.meta.get(path)
        return dict(info) if info is not None else None

    def temp_residue(self, releases_dir, rid):
        return [n for n in self.listdir(releases_dir) if n.startswith(f".install-tmp-{rid}-")]

    def release_guard(self, logical, host_path):
        g = self.guard.get(host_path)
        if g is None:
            tool.refuse("RELEASE_GUARD:RELEASE_MISSING")
        if isinstance(g, str):
            tool.refuse(f"RELEASE_GUARD:{g}")
        return g

    def release_guard_as(self, logical, host_path, owner):
        return self.release_guard(logical, host_path)

    def tree_digest(self, path):
        h = hashlib.sha256()
        for p in sorted(p for p in self.files if p.startswith(path + "/")):
            h.update(p.encode() + b"\0" + self.files[p])
        return h.hexdigest()

    def remove_release_tree(self, path):
        self.ops.append(("remove", path))
        for p in [p for p in self.files if p.startswith(path + "/")]:
            del self.files[p]
        self.dirs.discard(path)
        self.guard.pop(path, None)

    def symlink(self, target, path):
        self.ops.append(("symlink", path))
        self.links[path] = target

    def replace(self, src, dst):
        self.ops.append(("replace", dst))
        self.links[dst] = self.links.pop(src)
        self.snapshots.append(CURRENT in self.links)
        self.world.fire("switch")

    def unlink(self, path):
        self.ops.append(("unlink", path))
        del self.links[path]

    def fsync_dir(self, path):
        self.ops.append(("fsync", path))

    def detector_processes(self):
        pid = self.world.det["MainPID"]
        return [int(pid)] if self.world.det["ActiveState"] == "active" and pid.isdigit() and int(pid) > 0 else []

    def proc_cwd(self, pid):
        pid = str(pid)
        return self.world.core_cwd if pid == self.world.core["MainPID"] else self.world.det_cwd if pid == self.world.det["MainPID"] else None

    def identity(self, path):
        return self.ident.get(path)

    def account(self, name):
        return {tool.R1DU.CORE_USER: (CORE_UID, CORE_UID), tool.R1DU.DETECTOR_USER: (DET_UID, DET_UID)}.get(name)

    def group_gid(self, name):
        return {tool.R1DU.RECOVERY_GROUP: REC_GID, tool.R1DU.ALERT_GROUP: ALERT_GID}.get(name)

    def proc_groups(self, pid):
        return list(self.world.groups)

    def proc_environ_value(self, pid, key):
        return self.world.r1d_arming if key == tool.R1DU.ARM_KEY else str(DET_UID)

    def proc_socket_inodes(self, pid):
        return set(self.world.core_fds)

    def unix_listener_inodes(self, path):
        return set(self.world.listeners.get(path, set()))


def build(tmp_path, **kw):
    world = World()
    host = FakeHost(world)
    backend = FakeBackend(world, host, **kw)
    work = tmp_path / "work"
    work.mkdir(mode=0o700, exist_ok=True, parents=True)
    return host, backend, world, work


def journal(work):
    return json.loads((work / tool.JOURNAL_NAME).read_text())


def run_apply(host, backend, work, **over):
    return tool.apply(tool.Pins(**{**PINS.__dict__, **over}), work, host, backend)


def run_verify(host, backend, work, **over):
    return tool.verify(tool.Pins(**{**PINS.__dict__, **over}), work, host, backend)


def assert_untouched(host, world, work):
    assert world.events == [] and host.links == {CURRENT: OLD_PATH} and not host.ops and not (work / tool.JOURNAL_NAME).exists()
    assert NEW_PATH not in host.dirs and world.core["MainPID"] == "4242" and world.det["MainPID"] == "5151"


def test_default_world_is_the_post_r1d_terminal_surface_and_preflight_accepts_it(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    assert R1D_SOCK not in host.ident and R1D_SOCK not in world.listeners and 103 not in world.core_fds
    assert world.r1d_arming == "YES"
    facts = tool.preflight(host, backend, PINS)
    assert facts["old_target"] == OLD_PATH and facts["core"]["MainPID"] == "4242"
    assert not (work / tool.JOURNAL_NAME).exists() and world.events == [] and not host.ops


# ═══ the stage is NEW and registered once ═════════════════════════════════════════════════════════════════════════════════════


def stages() -> list[str]:
    out = _REAL_RUN(["bash", "-c", f'. "{P4_LIB}"; printf "%s\\n" $P4_STAGES'], capture_output=True, text=True)
    return out.stdout.split()


def test_rru_is_a_new_stage_registered_exactly_once_between_r1bv_and_recovery() -> None:
    order = stages()
    assert order.count("RRu") == 1 and len(order) == len(set(order))
    assert order[order.index("R1Bv") + 1] == "RRu" and order[order.index("RRu") + 1] == "Recovery"
    for consumed in ("F1i", "F1r", "F1u", "R1Du", "R1D", "R1B"):
        assert consumed in order and consumed != "RRu"


def test_rru_mutates_no_repository_gap_and_the_stage_gate_and_compare_know_it() -> None:
    out = _REAL_RUN(["bash", "-c", f'. "{P4_LIB}"; p4_stage_gaps RRu'], capture_output=True, text=True)
    assert out.stdout.strip() == "none"
    assert "$STAGE\" = RRu" in GATE.read_text() or '"$STAGE" = RRu' in GATE.read_text()
    assert "'stage RRu'" in COMPARE.read_text()


def test_rru_handler_files_exist_and_are_executable() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert (STAGE / name).is_file() and (STAGE / name).stat().st_mode & 0o111
    for name in ("allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt"):
        assert (STAGE / name).is_file()
    keys = [ln for ln in (STAGE / "allow-keys.txt").read_text().splitlines() if ln.strip() and not ln.startswith("#")]
    assert keys == ["host.symlink./opt/aegis-idea3/current.target"]  # ONLY the pointer: nothing restarts, so no process-identity key is approved
    for name in ("allow-keys-rollback.txt", "allow-listeners.txt"):
        assert not [ln for ln in (STAGE / name).read_text().splitlines() if ln.strip() and not ln.startswith("#")]  # ZERO allowance


# ═══ the privileged surface: nothing can restart anything ═════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("argv", [("restart", "aegis-idea3-core.service"), ("try-restart", "aegis-idea3-core.service"), ("restart", "aegis-idea3-detector.service"),
                                  ("stop", "aegis-idea3-detector.service"), ("start", "aegis-idea3-detector.service"), ("daemon-reload",), ("kill", "aegis-idea3-core.service"),
                                  ("enable", "aegis-idea3-core.service"), ("reload", "aegis-idea3-core.service"), ("restart", "--job-mode=ignore-dependencies", "aegis-idea3-core.service")])
def test_the_backend_refuses_every_verb_but_show_so_a_restart_is_impossible_by_construction(argv) -> None:
    assert tool.RRuBackend.allowed(argv) is False
    with pytest.raises(tool.Refusal):
        tool.RRuBackend().systemctl(*argv)


def test_the_only_accepted_argv_are_read_only_show_of_the_two_units() -> None:
    assert tool.RRuBackend.allowed(("show", "aegis-idea3-core.service", "-pMainPID"))
    assert tool.RRuBackend.allowed(("show", "aegis-idea3-detector.service", "-pMainPID", "-pNRestarts"))
    assert not tool.RRuBackend.allowed(("show", "sshd.service", "-pMainPID"))
    assert not hasattr(tool, "RESTART_ARGS")


def test_rru_has_no_r1d_authority_reopen_or_connection_path() -> None:
    text = TOOL_PATH.read_text()
    for forbidden in ("HistoricalDispositionServer", "r1d_dispose_call", ".connect(", "socket.socket("):
        assert forbidden not in text


# ═══ apply ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def test_apply_installs_then_switches_once_with_no_restart_and_the_core_and_detector_stay_exactly_the_same(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    out = run_apply(host, backend, work)
    assert out["RRU_APPLY"] == "COMPLETE" and out["RRU_CORE_RESTART_INVOCATIONS"] == "0" and out["RRU_EXPLICIT_DETECTOR_COMMANDS"] == "0"
    assert world.events == ["install", "switch"]
    assert host.links[CURRENT] == NEW_PATH and NEW_PATH in host.dirs and OLD_PATH in host.dirs
    assert world.core["MainPID"] == "4242" and world.core["NRestarts"] == "0" and world.core_cwd == OLD_PATH
    assert world.det["MainPID"] == "5151" and world.det_cwd == OLD_PATH
    assert all(call[0] == "show" for call in world.systemctl_calls)  # zero systemd mutation of any kind
    assert journal(work)["phase"] == "applied" and journal(work)["cli_sha"] == CLI_SHA
    assert (NEW_PATH + "/aegis_soc/cli.py") in host.files


def test_current_is_never_absent_during_the_switch(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    assert host.snapshots == [True]
    assert [op for op in host.ops if op[0] in ("symlink", "replace")] == [("symlink", tool.TMP_LINK), ("replace", CURRENT)]


def test_the_journal_records_each_owned_step_before_it_happens(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    seen: dict[str, str] = {}
    world.hooks["install"] = lambda: seen.setdefault("install", journal(work)["phase"])
    world.hooks["switch"] = lambda: seen.setdefault("switch", journal(work)["phase"])
    run_apply(host, backend, work)
    assert seen == {"install": "installing", "switch": "switching"}


def test_a_second_apply_for_the_same_work_directory_is_refused(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    assert refusal(run_apply, host, backend, work) == "ATTEMPT_JOURNAL_ALREADY_EXISTS"


def test_the_release_is_machine_proved_to_be_old_plus_cli_only(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    assert tool.successor_equivalence(host, OLD_PATH, SOURCE_DIR) == ["aegis_soc/cli.py"]


@pytest.mark.parametrize("label,mutate,code", [
    ("an extra module", lambda h: h.files.__setitem__(f"{SOURCE_DIR}/aegis_soc/extra.py", b"x"), "SUCCESSOR_NOT_EQUIVALENT:FILE_SET"),
    ("a removed module", lambda h: h.files.pop(f"{SOURCE_DIR}/aegis_soc/supervisor.py"), "SUCCESSOR_NOT_EQUIVALENT:FILE_SET"),
    ("cli missing", lambda h: h.files.pop(f"{SOURCE_DIR}/aegis_soc/cli.py"), "SUCCESSOR_NOT_EQUIVALENT:FILE_SET"),
    ("a changed Core runtime module", lambda h: h.files.__setitem__(f"{SOURCE_DIR}/aegis_soc/recovery_core.py", CORE_BYTES + b"#"), "SUCCESSOR_NOT_EQUIVALENT:FILE_DIFFERS:aegis_soc/recovery_core.py"),
    ("a changed interpreter", lambda h: h.files.__setitem__(f"{SOURCE_DIR}/venv/bin/python", b"#evil"), "SUCCESSOR_NOT_EQUIVALENT:FILE_DIFFERS:venv/bin/python"),
    ("a changed requirements file", lambda h: h.files.__setitem__(f"{SOURCE_DIR}/requirements.txt", b"other==2\n"), "SUCCESSOR_NOT_EQUIVALENT:FILE_DIFFERS:requirements.txt"),
    ("a dependency/python version drift", lambda h: h.set_manifest(SOURCE_DIR, python_version="3.99.0"), "SUCCESSOR_NOT_EQUIVALENT:MANIFEST_python_version"),
    ("a requirements digest drift", lambda h: h.set_manifest(SOURCE_DIR, requirements_sha256="0" * 64), "SUCCESSOR_NOT_EQUIVALENT:MANIFEST_requirements_sha256"),
    ("a wrong file count", lambda h: h.set_manifest(SOURCE_DIR, file_count=99), "SUCCESSOR_NOT_EQUIVALENT:MANIFEST_file_count"),
    ("another module imports cli", lambda h: h.files.__setitem__(f"{SOURCE_DIR}/aegis_soc/supervisor.py", b"from . import cli\n"), "SUCCESSOR_NOT_EQUIVALENT:FILE_DIFFERS:aegis_soc/supervisor.py"),
])
def test_equivalence_refuses_any_difference_beyond_cli(tmp_path, label, mutate, code) -> None:
    host, backend, world, work = build(tmp_path)
    mutate(host)
    assert refusal(tool.successor_equivalence, host, OLD_PATH, SOURCE_DIR) == code, label


def test_a_release_whose_cli_is_not_the_pinned_digest_or_not_manifested_is_refused(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, cli_sha="a" * 64) == "RESTORE_CLI_SHA256_MISMATCH"
    assert_untouched(host, world, work)
    host2, backend2, world2, work2 = build(tmp_path / "b")
    host2.files.pop(f"{SOURCE_DIR}/aegis_soc/cli.py")
    assert refusal(run_apply, host2, backend2, work2) == "RESTORE_CLI_FILE_INVALID"
    assert_untouched(host2, world2, work2)


@pytest.mark.parametrize("label,mutate,code", [
    ("current is not OLD", lambda h, w: h.links.__setitem__(CURRENT, f"{RELEASES}/other"), "CURRENT_NOT_EXPECTED_TARGET"),
    ("the NEW release already exists", lambda h, w: h.dirs.add(NEW_PATH), "TARGET"),
    ("the Core runs from another release", lambda h, w: setattr(w, "core_cwd", f"{RELEASES}/other"), "CORE_NOT_RUNNING_FROM_CURRENT_OLD_RELEASE"),
    ("the Core is down", lambda h, w: w.core.update(ActiveState="failed"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("the detector is not running", lambda h, w: w.det.update(ActiveState="inactive"), "DETECTOR_NOT_RUNNING"),
    ("the detector runs from another release", lambda h, w: setattr(w, "det_cwd", f"{RELEASES}/other"), "DETECTOR_SOURCE_SHA256_MISMATCH"),
    ("the Recovery socket is missing", lambda h, w: h.ident.pop(RECOVERY), "RECOVERY_SOCKET_MISSING"),
    ("the Recovery socket is not served by the Core", lambda h, w: w.listeners.__setitem__(RECOVERY, set()), "RECOVERY_SOCKET_NOT_SERVED_BY_CORE"),
    ("the alert socket is missing", lambda h, w: h.ident.pop(ALERT), "ALERT_SOCKET_MISSING"),
    ("the alert socket is not served by the Core", lambda h, w: w.listeners.__setitem__(ALERT, set()), "ALERT_SOCKET_NOT_SERVED_BY_CORE"),
    ("the terminal R1D socket reappears", lambda h, w: h.ident.__setitem__(R1D_SOCK, {"kind": "socket", "mode": 0o600, "uid": CORE_UID, "gid": CORE_UID}), "R1D_SOCKET_PRESENT_WHILE_UNARMED"),
    ("the persisted R1D arming identity is missing", lambda h, w: setattr(w, "r1d_arming", "NO"), "CORE_RUNNING_WITHOUT_R1D_ARMING"),
    ("the OLD release fails the guard", lambda h, w: h.guard.__setitem__(OLD_PATH, "OWNER_MISMATCH"), "RELEASE_GUARD"),
    ("a stale temp link exists", lambda h, w: h.links.__setitem__(tool.TMP_LINK, OLD_PATH), "SWITCH_TEMP_EXISTS"),
])
def test_every_pre_gate_refuses_before_any_mutation(tmp_path, label, mutate, code) -> None:
    host, backend, world, work = build(tmp_path)
    mutate(host, world)
    saved_links = dict(host.links)
    message = refusal(run_apply, host, backend, work)
    assert code in message, (label, message)
    assert "install" not in world.events and "switch" not in world.events and not host.ops
    assert host.links == saved_links and not (work / tool.JOURNAL_NAME).exists()


@pytest.mark.parametrize("field,value,code", [("cli_sha", "xyz", "RESTORE_CLI_SHA256_PIN_INVALID"), ("old_id", NEW, "RELEASE_IDS_NOT_DISTINCT"), ("new_id", "../x", "RELEASE_ID")])
def test_malformed_pins_refuse_before_any_mutation(tmp_path, field, value, code) -> None:
    host, backend, world, work = build(tmp_path)
    assert code in refusal(run_apply, host, backend, work, **{field: value})
    assert_untouched(host, world, work)


def test_an_installer_failure_is_evidence_never_ownership(tmp_path) -> None:
    host, backend, world, work = build(tmp_path, installer_rc=1)
    assert refusal(run_apply, host, backend, work).startswith("INSTALL_FAILED:")
    assert journal(work)["phase"] == "installer_failed" and host.links[CURRENT] == OLD_PATH and "switch" not in world.events


def test_a_foreign_core_replacement_before_the_switch_stops_before_the_switch(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: world.core.update(MainPID="9999")
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    assert host.links[CURRENT] == OLD_PATH and "switch" not in world.events


def test_a_detector_that_drifts_before_the_switch_stops_before_the_switch(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: world.det.update(MainPID="6000")
    assert "DETECTOR_DRIFT" in refusal(run_apply, host, backend, work)
    assert host.links[CURRENT] == OLD_PATH


def test_a_stale_r1d_socket_that_reappears_during_switch_fails_the_post_switch_proof(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: host.ident.__setitem__(R1D_SOCK, {"kind": "socket", "mode": 0o600, "uid": CORE_UID, "gid": CORE_UID})
    assert refusal(run_apply, host, backend, work) == "R1D_SOCKET_PRESENT_WHILE_UNARMED"
    assert journal(work)["phase"] == "switched"


def test_missing_r1d_arming_identity_during_switch_fails_the_post_switch_proof(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: setattr(world, "r1d_arming", "NO")
    assert refusal(run_apply, host, backend, work) == "CORE_RUNNING_WITHOUT_R1D_ARMING"
    assert journal(work)["phase"] == "switched"


def test_a_core_that_is_restarted_by_someone_else_during_the_switch_fails_the_post_switch_proof(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: world.core.update(MainPID="9999", ExecMainStartTimestamp="T9")
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    assert journal(work)["phase"] == "switched"


def test_core_env_or_credential_metadata_drift_fails_closed(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: host.meta[CORE_ENV].update(size=host.meta[CORE_ENV]["size"] + 1)
    assert refusal(run_apply, host, backend, work) == "MATERIAL_METADATA_DRIFT"


def test_core_env_content_drift_fails_closed_without_printing_content(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: host.files.__setitem__(f"{CRED_DIR}/k_c2d", b"changed")
    message = refusal(run_apply, host, backend, work)
    assert message == "MATERIAL_CONTENT_DRIFT" and "sekrit" not in message


def test_apply_never_edits_core_env_or_credentials(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    before = {p: b for p, b in host.files.items() if p.startswith("/etc/aegis-idea3")}
    run_apply(host, backend, work)
    assert {p: b for p, b in host.files.items() if p.startswith("/etc/aegis-idea3")} == before and not any(op[0] in ("arm", "unarm") for op in host.ops)


# ═══ verify ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def applied(tmp_path):
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    return host, backend, world, work


def test_verify_passes_after_apply_and_claims_only_runtime_release_readiness(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    out = run_verify(host, backend, work, source_dir="/unused")
    assert out["RRU_VERIFY"] == "PASS" and out["RECOVERY_RUNTIME_RELEASE_READY"] == "YES" and out["CORE_RESTARTED"] == "NO"
    assert out["RRU_RECOVERY_EXECUTED"] == "NO" and out["RRU_INCIDENT_MUTATED"] == "NO" and out["NEW_RELEASE_IS_OLD_PLUS_CLI_ONLY"] == "YES"
    joined = " ".join(f"{k}={v}" for k, v in out.items())
    for forbidden in ("RECOVERY_RESULT", "RECOVERY_R2_R8_EXECUTED=YES", "R1_VERIFIED", "LVR", "L8", "L9"):
        assert forbidden not in joined


def test_verify_without_an_applied_journal_refuses(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    assert refusal(run_verify, host, backend, work, source_dir="/unused") == "ATTEMPT_NOT_APPLIED"


@pytest.mark.parametrize("label,mutate,code", [
    ("current drifted", lambda h, w: h.links.__setitem__(CURRENT, OLD_PATH), "CURRENT_NOT_NEW_TARGET"),
    ("the release tree changed", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/cli.py", CLI_BYTES + b"#"), "RESTORE_CLI_SHA256_MISMATCH"),
    ("the Core was restarted", lambda h, w: w.core.update(MainPID="9999"), "CORE_RESTARTED_OR_REPLACED"),
    ("the Core moved release", lambda h, w: setattr(w, "core_cwd", NEW_PATH), "CORE_RESTARTED_OR_REPLACED"),
    ("the detector was cycled", lambda h, w: w.det.update(MainPID="6000"), "DETECTOR_DRIFT"),
    ("the OLD release changed", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/supervisor.py", b"#x"), "OLD_RELEASE_TREE_CHANGED"),
    ("the Recovery socket lost its Core", lambda h, w: w.listeners.__setitem__(RECOVERY, set()), "RECOVERY_SOCKET_NOT_SERVED_BY_CORE"),
    ("the alert socket lost its Core", lambda h, w: w.listeners.__setitem__(ALERT, set()), "ALERT_SOCKET_NOT_SERVED_BY_CORE"),
    ("the terminal R1D socket reappeared", lambda h, w: h.ident.__setitem__(R1D_SOCK, {"kind": "socket", "mode": 0o600, "uid": CORE_UID, "gid": CORE_UID}), "R1D_SOCKET_PRESENT_WHILE_UNARMED"),
    ("the persisted R1D arming identity drifted", lambda h, w: setattr(w, "r1d_arming", "NO"), "CORE_RUNNING_WITHOUT_R1D_ARMING"),
])
def test_verify_refuses_every_post_apply_deviation(tmp_path, label, mutate, code) -> None:
    host, backend, world, work = applied(tmp_path)
    mutate(host, world)
    assert code in refusal(run_verify, host, backend, work, source_dir="/unused"), label


def test_verify_refuses_pins_that_differ_from_the_attempt(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    assert refusal(run_verify, host, backend, work, source_dir="/unused", cli_sha="b" * 64) == "ATTEMPT_PINS_MISMATCH"


# ═══ rollback: owns only this stage's release and pointer transition ══════════════════════════════════════════════════════════


def rollback(host, backend, work):
    return tool.rollback(work, host, backend)


def test_rollback_with_no_journal_owns_nothing(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    assert rollback(host, backend, work) == {"RRU_ROLLBACK": "NOTHING_OWNED"} and not host.ops


def test_rollback_after_a_full_apply_restores_current_removes_only_the_owned_release_and_never_restarts(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    out = rollback(host, backend, work)
    assert out["RRU_ROLLBACK"] == "PASS" and out["RRU_ROLLBACK_CLASS"] == "EXACT_PROCESS" and out["CORE_RESTARTED_FOR_ROLLBACK"] == "NO" and out["NEW_RELEASE_ABSENT"] == "YES"
    assert host.links == {CURRENT: OLD_PATH} and NEW_PATH not in host.dirs and OLD_PATH in host.dirs
    assert ("remove", NEW_PATH) in host.ops and not [op for op in host.ops if op[0] == "remove" and op[1] != NEW_PATH]
    assert world.core["MainPID"] == "4242" and world.det["MainPID"] == "5151" and all(c[0] == "show" for c in world.systemctl_calls)
    assert rollback(host, backend, work) == {"RRU_ROLLBACK": "ALREADY_ROLLED_BACK"}


def test_rollback_after_an_installer_failure_removes_nothing(tmp_path) -> None:
    host, backend, world, work = build(tmp_path, installer_rc=1)
    refusal(run_apply, host, backend, work)
    assert rollback(host, backend, work)["RRU_ROLLBACK"] == "PASS" and not [op for op in host.ops if op[0] == "remove"]


def test_rollback_after_a_post_install_pre_switch_failure_removes_the_owned_release_and_leaves_current(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["switch"] = lambda: (_ for _ in ()).throw(RuntimeError("stop"))
    with pytest.raises(RuntimeError):
        run_apply(host, backend, work)
    host.links[CURRENT] = OLD_PATH  # the replace never took effect; the temp link is still ours
    assert journal(work)["phase"] == "switching"
    out = rollback(host, backend, work)
    assert out["RRU_ROLLBACK"] == "PASS" and NEW_PATH not in host.dirs and host.links == {CURRENT: OLD_PATH}


def test_rollback_refuses_a_foreign_current_and_changes_nothing(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    host.links[CURRENT] = f"{RELEASES}/foreign"
    assert refusal(rollback, host, backend, work) == "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT"
    assert host.links[CURRENT] == f"{RELEASES}/foreign" and NEW_PATH in host.dirs and not [op for op in host.ops if op[0] == "remove"]


def test_rollback_refuses_a_drifted_release_and_never_deletes_it(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    host.files[f"{NEW_PATH}/aegis_soc/extra.py"] = b"x"
    assert "RELEASE_DRIFTED_REFUSING_ROLLBACK" in refusal(rollback, host, backend, work)
    assert NEW_PATH in host.dirs and not [op for op in host.ops if op[0] == "remove"]


def test_rollback_never_deletes_a_release_it_cannot_prove_it_installed(tmp_path) -> None:
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: host.dirs.add(NEW_PATH)  # another actor created the NEW id while the installer ran: ownership is unproven
    host.files[f"{NEW_PATH}/foreign"] = b"x"
    refusal(run_apply, host, backend, work)
    assert journal(work)["phase"] in ("installing", "installer_failed")
    assert "OUTCOME_UNKNOWN" in refusal(rollback, host, backend, work) or "FOREIGN" in refusal(rollback, host, backend, work)
    assert NEW_PATH in host.dirs and not [op for op in host.ops if op[0] == "remove"]


def test_rollback_escalates_a_core_that_is_no_longer_the_preflight_process_instead_of_acting(tmp_path) -> None:
    host, backend, world, work = applied(tmp_path)
    world.core.update(MainPID="9999")
    assert refusal(rollback, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    assert all(c[0] == "show" for c in world.systemctl_calls)


# ═══ static contract: what the tool must never contain ═════════════════════════════════════════════════════════════════════════


def code_text(path: Path) -> str:
    import ast
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def test_the_tool_never_references_a_database_mqtt_nft_restore_close_or_a_restart_verb() -> None:
    code = code_text(TOOL_PATH)
    for forbidden in ("sqlite3", "paho", "mqtt", "nft", "nftables", "'isolate'", "'restore'", "'close'", "local_restore", "recovery_client", "recovery_core.py\"", "RECOVERY-GLOBAL-ATTEMPT-CONSUMED",
                      "RESTART_ARGS", "try-restart", "daemon-reload", "core_env_arm(", "core_env_unarm(", "R1D-GLOBAL", "R1B-GLOBAL", "incident", "esp32", "ESP32"):
        assert forbidden not in code, forbidden
    assert "ignore-dependencies" not in code


def active_shell(path: Path) -> str:
    return "\n".join(line for line in path.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#"))


def test_the_shell_surfaces_only_read_the_recovery_marker_and_never_write_it() -> None:
    for path in (LIB, RUNNER, *STAGE.glob("*.sh")):
        text = active_shell(path)
        for line in text.splitlines():
            if "RECOVERY-GLOBAL-ATTEMPT-CONSUMED" in line or "RRU_RECOVERY_MARKER_NAME" in line or "RRU_CANONICAL_DIR/" in line:
                assert not re.search(r"(>|\btouch\b|\bmkdir\b|\brm\b|\bln\b|\bchattr\b|\binstall\b|\btee\b)", line.replace("2>/dev/null", "")), (path.name, line)
        for write in ("chattr", "recovery_consume_attempt", "rm -f", "nft add", "nft delete", "mosquitto_pub", "sqlite3", "systemctl restart", "systemctl stop", "systemctl start", "cli restore", "--reason"):
            if write == "chattr" and path == LIB:
                continue  # RRu may best-effort chattr its own durable canonical marker only.
            assert write not in text, (path.name, write)


def test_runner_template_refuses_unpinned_and_pins_the_cli_digest() -> None:
    text = RUNNER.read_text()
    assert "RESTORE_CLI_SHA256=PIN_RESTORE_CLI_SHA256" in text and "PIN_MAIN_SHA" in text and "RRU-ATTEMPT-CONSUMED" not in active_shell(RUNNER)  # the marker name lives only in the library
    result = _REAL_RUN(["bash", str(RUNNER), str(Path("/nonexistent"))], capture_output=True, text=True)
    assert result.returncode == 2 and "runner is not pinned" in result.stdout


def test_the_runner_never_consumes_or_names_another_stage_marker_and_leaves_recovery_unconsumed() -> None:
    text = RUNNER.read_text()
    for other in ("R1DU-ATTEMPT-CONSUMED", "F1I-ATTEMPT", "F1U-ATTEMPT", "R1B-GLOBAL", "RECOVERY-GLOBAL"):
        assert other not in text
    assert "RECOVERY_ATTEMPT_CONSUMED=NO RECOVERY_LIVE_EXECUTED=NO RECOVERY_R2_R8_EXECUTED=NO" in text
    for claim in ("RECOVERY_RESULT=PASS", "RECOVERY_R2_R8_EXECUTED=YES", "R1_VERIFIED=VERIFIED", "LVR_PROVEN=YES", "L8_ACCEPTANCE=YES", "L9_PROVEN=YES"):
        assert claim not in text


# ═══ shell gates on fixtures ══════════════════════════════════════════════════════════════════════════════════════════════════


def bash(script: str, **env) -> subprocess.CompletedProcess[str]:
    return _REAL_RUN(["bash", "-c", script], capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", **env})


def receipt_repo(tmp: Path, change: dict[str, str | None] | None = None) -> Path:
    """A throw-away repo holding the REAL committed status logs of this checkout (so the real R1B-failure/R1Bv/R1Du closeouts are exercised), optionally mutated."""
    repo = tmp / "repo"
    shutil.copytree(ROOT / LOGS, repo / LOGS)
    for rel, text in (change or {}).items():
        if text is None:
            (repo / rel).unlink()
        else:
            (repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / rel).write_text(text)
    for args in (["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        _REAL_RUN(["git", "-C", str(repo), *args], check=True, capture_output=True)
    return repo


def head(repo: Path) -> str:
    return _REAL_RUN(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


def receipt_gate(repo: Path, release: str = OLD) -> subprocess.CompletedProcess[str]:
    return bash(f'. "{LIB}"; SUDO=""; rru_receipt_gate "{repo}" {head(repo)} {release}')


R1DU_CLOSEOUT = f"{LOGS}/2026-10-06_070624_music_idea3-r1du-live-closeout.md"
REAL_OLD = "ebffab6f8a6d7d98973fac7e89167352d529a87e"


def test_the_real_committed_history_satisfies_the_predecessor_gate_and_rru_is_not_yet_recorded(tmp_path) -> None:
    result = receipt_gate(receipt_repo(tmp_path), REAL_OLD)
    assert result.returncode == 0, result.stderr


def test_the_closeout_must_name_the_pinned_old_release(tmp_path) -> None:
    result = receipt_gate(receipt_repo(tmp_path), "a" * 40)
    assert result.returncode == 1 and "RRU_R1DU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in result.stderr


def test_a_missing_r1du_closeout_or_a_missing_r1bv_pass_blocks_the_stage(tmp_path) -> None:
    assert receipt_gate(receipt_repo(tmp_path, {R1DU_CLOSEOUT: None}), REAL_OLD).returncode == 1
    r1bv = next((ROOT / LOGS).glob("*_music_idea3-r1bv-live-closeout.md")).name
    (tmp_path / "m").mkdir()
    assert receipt_gate(receipt_repo(tmp_path / "m", {f"{LOGS}/{r1bv}": None}), REAL_OLD).returncode == 1  # the existing predecessor is not weakened


@pytest.mark.parametrize("claim", ["RECOVERY_R2_R8_EXECUTED=YES", "RECOVERY_RESULT=PASS", "R1_VERIFIED=VERIFIED", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "LVR_PROVEN=YES", "L8_ACCEPTANCE=YES", "L9_PROVEN=YES"])
def test_any_contradictory_promotion_blocks_the_stage(tmp_path, claim) -> None:
    result = receipt_gate(receipt_repo(tmp_path, {f"{LOGS}/2026-10-07_000000_music_idea3-bogus.md": f"- `{claim}`\n"}), REAL_OLD)
    assert result.returncode == 1


@pytest.mark.parametrize("claim", ["RRU_LIVE_EXECUTED=YES", "RRU_PRODUCTION_DEPLOYED=YES", "RECOVERY_RUNTIME_RELEASE_READY=YES"])
def test_a_recorded_rru_result_blocks_a_second_attempt(tmp_path, claim) -> None:
    result = receipt_gate(receipt_repo(tmp_path, {f"{LOGS}/2026-10-07_000000_music_idea3-rru-live-closeout.md": f"- `{claim}`\n"}), REAL_OLD)
    assert result.returncode == 1 and "RRU_ALREADY_EXECUTED" in result.stderr


def test_a_stale_pinned_commit_is_refused(tmp_path) -> None:
    repo = receipt_repo(tmp_path)
    result = bash(f'. "{LIB}"; SUDO=""; rru_receipt_gate "{repo}" {"0" * 40} {REAL_OLD}')
    assert result.returncode == 1


def test_the_recovery_marker_must_be_absent(tmp_path) -> None:
    canon = tmp_path / "gov"
    canon.mkdir()
    gate = f'export RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; rru_recovery_marker_absent'
    assert bash(gate).returncode == 0
    (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("x")
    result = bash(gate)
    assert result.returncode == 1 and "RRU_RECOVERY_ATTEMPT_ALREADY_CONSUMED" in result.stderr
    (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").unlink()
    (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").symlink_to(tmp_path / "dangling")  # even a dangling symlink counts as consumed
    assert bash(gate).returncode == 1


def test_the_rru_marker_is_canonical_durable_atomic_and_never_uses_auth_dir(tmp_path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "RRU-ATTEMPT-CONSUMED").write_text("operator-created\n")
    script = (f'export RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{tmp_path / "canon"}" '
              f'RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; '
              f'rru_attempt_unconsumed "{auth}" && rru_consume_attempt "{auth}" && echo consumed; '
              f'rru_attempt_unconsumed "{auth}"; rru_consume_attempt "{auth}"')
    result = bash(script)
    assert "consumed" in result.stdout and result.stderr.count("RRU_ATTEMPT_ALREADY_CONSUMED") == 2
    marker = tmp_path / "canon" / "RRU-GLOBAL-ATTEMPT-CONSUMED"
    assert marker.is_file() and "consumed_at=" in marker.read_text()
    assert (auth / "RRU-ATTEMPT-CONSUMED").read_text() == "operator-created\n"
    assert not (tmp_path / "canon" / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()


def test_rru_marker_requires_private_real_canonical_directory_and_durable_sync(tmp_path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o770)
    canon.chmod(0o770)
    bad = bash(f'export RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; rru_attempt_unconsumed "{auth}"')
    assert bad.returncode == 1 and "RRU_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED" in bad.stderr
    stat_bin = tmp_path / "stat-bin"
    stat_bin.mkdir()
    (stat_bin / "stat").write_text('#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %u ] && { echo 999; exit 0; }\nexec /usr/bin/stat "$@"\n')
    (stat_bin / "stat").chmod(0o755)
    wrong_owner = bash(f'export PATH="{stat_bin}:/usr/bin:/bin" RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; rru_attempt_unconsumed "{auth}"')
    assert wrong_owner.returncode == 1 and "RRU_CANONICAL_DIR_NOT_PRIVATE_ROOT_OWNED" in wrong_owner.stderr
    canon.chmod(0o700)
    canon.rename(tmp_path / "real")
    canon.symlink_to(tmp_path / "real")
    bad_link = bash(f'export RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; rru_attempt_unconsumed "{auth}"')
    assert bad_link.returncode == 1
    canon.unlink()
    calls = tmp_path / "sync.calls"
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "sync").write_text(f'#!/bin/sh\necho "$*" >> "{calls}"\n')
    (shim / "sync").chmod(0o755)
    good = bash(f'export PATH="{shim}:/usr/bin:/bin" RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; rru_consume_attempt "{auth}"')
    assert good.returncode == 0, good.stderr
    assert len(calls.read_text().splitlines()) >= 3  # parent-before-create, marker, containing directory


def test_rru_existing_canonical_marker_blocks_without_any_mutation(tmp_path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    marker = canon / "RRU-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("kept\n")
    result = bash(f'export RRU_TEST_ONLY_CANONICAL_DIR_ENABLED=YES RRU_TEST_ONLY_CANONICAL_DIR="{canon}" RRU_TEST_ONLY_TRUST_ROOT="{tmp_path}"; . "{LIB}"; SUDO=""; if rru_attempt_unconsumed "{auth}"; then echo mutation; exit 2; else exit 1; fi')
    assert result.returncode == 1 and "RRU_ATTEMPT_ALREADY_CONSUMED" in result.stderr and "mutation" not in result.stdout
    assert marker.read_text() == "kept\n"


RRU_CLOSEOUT = f"{LOGS}/2026-10-07_000000_music_idea3-rru-live-closeout.md"
RRU_SUCCESSOR_FIELDS = """RRU_LIVE=CLOSED_PASS
RRU_LIVE_EXECUTED=YES
RRU_RESULT=PASS
RRU_PRODUCTION_DEPLOYED=YES
RECOVERY_RUNTIME_RELEASE_READY=YES
RRU_RELEASE_ID=912b18005bb2fc80bb4e8d1fe8aa88803ac27314
RECOVERY_ATTEMPT_CONSUMED=NO
RECOVERY_LIVE_EXECUTED=NO
RECOVERY_R2_R8_EXECUTED=NO
R1B_RESULT=FAIL_IMMUTABLE
R1BV_RESULT=PASS
"""


def successor_gate(repo: Path, release: str = "912b18005bb2fc80bb4e8d1fe8aa88803ac27314") -> subprocess.CompletedProcess[str]:
    return bash(f'. "{LIB}"; SUDO=""; rru_recovery_successor_gate "{repo}" {head(repo)} "{release}"')


def test_recovery_successor_gate_requires_one_pinned_main_rru_closeout(tmp_path) -> None:
    repo = receipt_repo(tmp_path)
    assert successor_gate(repo).returncode == 1
    repo = receipt_repo(tmp_path / "valid", {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS})
    result = successor_gate(repo)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("change", [
    {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS.replace("RRU_RESULT=PASS", "RRU_RESULT=FAIL")},
    {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS.replace("RECOVERY_RUNTIME_RELEASE_READY=YES", "RECOVERY_RUNTIME_RELEASE_READY=NO")},
    {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS.replace("RRU_RELEASE_ID=912b18005bb2fc80bb4e8d1fe8aa88803ac27314", "RRU_RELEASE_ID=other")},
    {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS.replace("RRU_LIVE_EXECUTED=YES", "RRU_LIVE_EXECUTED=NO")},
])
def test_recovery_successor_gate_rejects_failed_unready_or_mismatched_closeout(tmp_path, change) -> None:
    result = successor_gate(receipt_repo(tmp_path, change))
    assert result.returncode == 1


def test_recovery_successor_gate_rejects_duplicate_or_split_pinned_main_closeouts(tmp_path) -> None:
    duplicate = receipt_repo(tmp_path, {RRU_CLOSEOUT: RRU_SUCCESSOR_FIELDS, f"{LOGS}/2026-10-07_000001_music_idea3-rru-live-closeout.md": RRU_SUCCESSOR_FIELDS})
    assert successor_gate(duplicate).returncode == 1
    split = receipt_repo(tmp_path / "split", {RRU_CLOSEOUT: "RRU_LIVE=CLOSED_PASS\n", f"{LOGS}/2026-10-07_000001_music_idea3-rru-live-closeout.md": RRU_SUCCESSOR_FIELDS.replace("RRU_LIVE=CLOSED_PASS\n", "")})
    assert successor_gate(split).returncode == 1


def test_recovery_successor_gate_ignores_working_tree_only_closeout(tmp_path) -> None:
    repo = receipt_repo(tmp_path)
    path = repo / RRU_CLOSEOUT
    path.write_text(RRU_SUCCESSOR_FIELDS)
    result = successor_gate(repo)
    assert result.returncode == 1


def make_source(tmp: Path, cli_line: bool = True, corrupt: str | None = None) -> tuple[Path, Path]:
    repo = tmp / "r"
    for rel, data in (("aegis_soc/production_detector.py", b"det"), ("aegis_soc/recovery_core.py", b"core ALERT_ACCEPTED"), ("aegis_soc/cli.py", b"cli"), ("aegis_soc/historical_disposition.py", b"hd")):
        (repo / "IDEA3-AEGIS_Lockdown" / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / "IDEA3-AEGIS_Lockdown" / rel).write_bytes(data)
    for args in (["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "x"]):
        _REAL_RUN(["git", "-C", str(repo), *args], check=True, capture_output=True)
    src = tmp / "src"
    src.mkdir()
    rows = [("aegis_soc/production_detector.py", b"det"), ("aegis_soc/recovery_core.py", b"core ALERT_ACCEPTED"), ("aegis_soc/historical_disposition.py", b"hd")]
    if cli_line:
        rows.append(("aegis_soc/cli.py", b"cli" if corrupt != "cli" else b"evil"))
    (src / "RELEASE-SHA256SUMS").write_text("".join(f"{hashlib.sha256(d).hexdigest()}  {r}\n" for r, d in rows))
    return repo, src


def test_the_release_content_gate_requires_cli_and_byte_identity_with_the_pinned_commit(tmp_path) -> None:
    repo, src = make_source(tmp_path)
    ok = bash(f'. "{LIB}"; rru_release_content_gate "{repo}" "{src}"')
    assert ok.returncode == 0, ok.stderr
    repo2, src2 = make_source(tmp_path / "a", cli_line=False)
    assert "RRU_CLI_NOT_IN_RELEASE" in bash(f'. "{LIB}"; rru_release_content_gate "{repo2}" "{src2}"').stderr
    repo3, src3 = make_source(tmp_path / "b", corrupt="cli")
    assert "RRU_RELEASE_CONTENT_MISMATCH:aegis_soc/cli.py" in bash(f'. "{LIB}"; rru_release_content_gate "{repo3}" "{src3}"').stderr


def test_the_runtime_source_gate_binds_detector_core_and_cli_digests_to_the_pinned_commit(tmp_path) -> None:
    repo, _ = make_source(tmp_path)
    good = (sha(b"det"), sha(b"core ALERT_ACCEPTED"), sha(b"cli"))
    assert bash(f'. "{LIB}"; rru_runtime_source_gate "{repo}" {" ".join(good)}').returncode == 0
    for index, label in enumerate(("DETECTOR", "RECOVERY_CORE", "RESTORE_CLI")):
        bad = list(good)
        bad[index] = "f" * 64
        assert f"RRU_{label}_SOURCE_DIGEST_MISMATCH" in bash(f'. "{LIB}"; rru_runtime_source_gate "{repo}" {" ".join(bad)}').stderr


def capture(tmp: Path, name: str, **rec) -> Path:
    d = tmp / name
    d.mkdir(parents=True)
    rows = {"host.symlink./opt/aegis-idea3/current.target": OLD_PATH, "host.aegis_idea3.recovery.core.runtime_cwd": OLD_PATH, "host.aegis_idea3.alert.detector.runtime_cwd": OLD_PATH,
            "host.aegis_idea3.release_catalog": f"{OLD}:aaa"}
    rows.update(rec)
    (d / "host.tsv").write_text("".join(f"{k}\t{v}\n" for k, v in rows.items()))
    return d


def test_post_capture_gates_prove_the_pointer_the_catalog_and_the_unchanged_runtime(tmp_path) -> None:
    pre = capture(tmp_path, "pre")
    post = capture(tmp_path, "post", **{"host.symlink./opt/aegis-idea3/current.target": NEW_PATH, "host.aegis_idea3.release_catalog": f"{OLD}:aaa,{NEW}:bbb"})
    run = lambda g: bash(f'. "{LIB}"; {g}')  # noqa: E731
    assert run(f'rru_current_transition_gate "{pre}" "{post}" {OLD_PATH} {NEW_PATH}').returncode == 0
    assert run(f'rru_catalog_transition_gate "{pre}" "{post}" {NEW} bbb').returncode == 0
    assert run(f'rru_runtime_unchanged_gate "{pre}" "{post}" {OLD_PATH}').returncode == 0
    assert run(f'rru_catalog_transition_gate "{pre}" "{post}" {NEW} ccc').returncode == 1
    moved = capture(tmp_path, "moved", **{"host.aegis_idea3.recovery.core.runtime_cwd": NEW_PATH})
    assert "RRU_RUNTIME_RELEASE_CHANGED" in run(f'rru_runtime_unchanged_gate "{pre}" "{moved}" {OLD_PATH}').stderr
    det_moved = capture(tmp_path, "detmoved", **{"host.aegis_idea3.alert.detector.runtime_cwd": NEW_PATH})
    assert run(f'rru_runtime_unchanged_gate "{pre}" "{det_moved}" {OLD_PATH}').returncode == 1
    assert run(f'rru_current_transition_gate "{pre}" "{pre}" {OLD_PATH} {NEW_PATH}').returncode == 1


def test_the_rollback_output_gate_accepts_only_the_exact_process_class() -> None:
    ok = "RRU_ROLLBACK=PASS\nRRU_ROLLBACK_CLASS=EXACT_PROCESS\nCORE_RESTARTED_FOR_ROLLBACK=NO\n"
    assert _REAL_RUN(["bash", "-c", f'. "{LIB}"; rru_rollback_output_gate "$1"', "_", ok], capture_output=True, text=True).returncode == 0
    for bad in ("RRU_ROLLBACK=PASS\nRRU_ROLLBACK_CLASS=SAFE_EQUIVALENT\nCORE_RESTARTED_FOR_ROLLBACK=NO\n", "RRU_ROLLBACK=PASS\nRRU_ROLLBACK_CLASS=EXACT_PROCESS\nCORE_RESTARTED_FOR_ROLLBACK=YES\n", "RRU_ROLLBACK=MAYBE\n", ""):
        assert _REAL_RUN(["bash", "-c", f'. "{LIB}"; rru_rollback_output_gate "$1"', "_", bad], capture_output=True, text=True).returncode == 1
    assert _REAL_RUN(["bash", "-c", f'. "{LIB}"; rru_rollback_output_gate "$1"', "_", "RRU_ROLLBACK=NOTHING_OWNED\n"], capture_output=True, text=True).returncode == 0


def test_recovery_authority_is_unchanged_by_this_stage() -> None:
    lib = (DEPLOY / "p4-recovery-run-lib.sh").read_text()
    runner = (DEPLOY / "owner-run/run-recovery-owner.sh").read_text()
    for kept in ("recovery_cli_gate", "recovery_release_closure_gate", "RESTORE_CLI_SHA256", "RELEASE_SUMS_SHA256", "RECOVERY_CLI_NOT_A_MANIFESTED_ENTRY", "RECOVERY_CLI_DIGEST_MISMATCH"):
        assert kept in lib or kept in (DEPLOY / "recovery-acceptance" / "recovery_runner_freeze.py").read_text()
    assert "rru_recovery_successor_gate" in runner and "recovery_predecessor_gate" in runner  # additive RRu readiness; existing R1B/R1Bv gate remains


def test_rru_canonical_marker_is_before_apply_and_rollback_never_clears_it() -> None:
    runner = RUNNER.read_text()
    assert runner.index("rru_consume_attempt") < runner.index("handler apply.sh")
    rollback = (STAGE / "rollback.sh").read_text()
    assert "RRU-GLOBAL-ATTEMPT-CONSUMED" not in rollback and "RRU-ATTEMPT-CONSUMED" not in rollback
