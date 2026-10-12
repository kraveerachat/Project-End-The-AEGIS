"""Stage R1Du (governed post-F1 Core upgrade): repository implementation only, hermetic fixtures only.

R1Du owns exactly: install ONE new immutable release, switch ``/opt/aegis-idea3/current`` OLD -> NEW, restart the Core EXACTLY ONCE (the normal governed restart, no job-mode override), prove the restarted
Core runs from the NEW release, and prove the detector lifecycle that systemd imposes through ``Requires=`` (OPTION A: D1 stops and a NEW D2 starts from the NEW release, as an owner-approved R1Du consequence;
R1Du itself never addresses the detector unit). Nothing here touches /opt, systemd, a service, the Core, the detector, an alert socket, an ESP32 or a real release: the tool is driven through a
fake host and a fake systemd world (the REAL privileged-backend allow-list stays in force) and the shell gates run on fixtures. The systemd world models the DOCUMENTED ``Requires=`` restart
propagation (a restart job on the Core is also queued, by systemd, for every active unit that Requires= it): it is a model of the documentation, not a live experiment. These tests prove REPOSITORY behavior only; no live R1Du PASS is claimed.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
TOOL_PATH = DEPLOY / "p4-r1du-upgrade.py"
R1DU_LIB = DEPLOY / "p4-r1du-run-lib.sh"
R1DU_RUNNER = DEPLOY / "owner-run" / "run-r1du-owner.sh"
STAGE = DEPLOY / "stages" / "R1Du"
GATE = DEPLOY / "p4-stage-gate.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
COMPARE = DEPLOY / "p4-compare.sh"
DETECTOR_SRC = ROOT / "aegis_soc" / "production_detector.py"
DETECTOR_UNIT_EXAMPLE = ROOT / "deploy" / "aegis-idea3-detector.service.example"
CORE_UNIT_EXAMPLE = ROOT / "deploy" / "aegis-idea3-core.service.example"
_REAL_RUN = subprocess.run

RUNNING = "55c7d18135142293267e8d1ea943d3639358d634"  # the release the OLD running Core process was started from
OLD = "c2238375de14678f2a67c039282d9aeff6d553e5"  # what `current` points at (F1r) and what the detector was started from (F1)
NEW = "9cebd2a061f8d47bc97349762aa87f169c706710"
NEW_SRC = NEW
OPT = "/opt/aegis-idea3"
RELEASES = f"{OPT}/releases"
CURRENT = f"{OPT}/current"
OLD_PATH, NEW_PATH, RUNNING_PATH = f"{RELEASES}/{OLD}", f"{RELEASES}/{NEW}", f"{RELEASES}/{RUNNING}"
SOURCE_DIR = f"/home/owner/idea3-p4-evidence/r1du-owner-source/{NEW}"
CORE_ENV = "/etc/aegis-idea3/core.env"
CRED_DIR = "/etc/aegis-idea3/credentials"
UNIT_PATH = "/etc/systemd/system/aegis-idea3-detector.service"
DET_BYTES = b"# reviewed production_detector (fixture bytes)\nEXIT_JOURNAL_SOURCE_UNAVAILABLE = 3\n"
DET_SHA = hashlib.sha256(DET_BYTES).hexdigest()
CORE_BYTES = b"# recovery_core fixture\nALERT_ACCEPTED = 'ALERT_ACCEPTED'\n"
CORE_SHA = hashlib.sha256(CORE_BYTES).hexdigest()
UNIT_BYTES = b"[Unit]\nRequires=aegis-idea3-core.service\n"
UNIT_SHA = hashlib.sha256(UNIT_BYTES).hexdigest()
REVIEWED_DETECTOR_SHA = "a91bcfc228c6e0892d019923b51b33d3545c685e2b5fed229f1ad8f980db9332"
CURRENT_KEY = "host.symlink./opt/aegis-idea3/current.target"
CATALOG_KEY = "host.aegis_idea3.release_catalog"
CORE_UID, DET_UID, REC_GID, ALERT_GID = 990, 991, 980, 981
ALERT, RECOVERY = "/run/aegis-idea3-alert/alert.sock", "/run/aegis-idea3-recovery/recovery.sock"
R1D_SOCK = "/run/aegis-idea3/historical-disposition.sock"
ARM = b"AEGIS_R1D_DISPOSITION_ENABLED=YES\n"


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_r1du_upgrade", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()
PINS = tool.Pins(OLD, NEW, SOURCE_DIR, NEW_SRC, DET_SHA, CORE_SHA, UNIT_SHA)


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    """No real process may be started by the tool tests; shell/gate tests use ``_REAL_RUN`` captured at import."""
    def guarded(argv, *args, **kwargs):
        raise AssertionError(f"a real process must never be started by the R1Du tool tests: {argv!r}")

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


# ═══ fake world: systemd + filesystem ═════════════════════════════════════════════════════════════════════════════════════════


def manifest(release_id=NEW, source=NEW_SRC, dirty=False) -> bytes:
    return json.dumps({"release_id": release_id, "source_git_sha": source, "source_tree_dirty": dirty, "schema_version": 1}).encode()


def parse_requires(path: Path) -> set[str]:
    out: set[str] = set()
    for line in path.read_text().splitlines():
        if line.startswith("Requires="):
            out |= set(line.split("=", 1)[1].split())
    return out


def restart_jobs(target: str, job_mode: str, requires: dict[str, set[str]]) -> set[str]:
    """The DOCUMENTED systemd rule (systemd.unit(5) Requires=, systemctl(1) --job-mode): a restart job on X propagates a restart to every unit that Requires= X, unless the job mode is
    ``ignore-dependencies`` ("only the specific unit will be affected")."""
    jobs = {target}
    if job_mode != "ignore-dependencies":
        jobs |= {unit for unit, deps in requires.items() if target in deps}
    return jobs


class World:
    def __init__(self):
        self.core = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "MainPID": "4242", "NRestarts": "0",
                     "ExecMainStartTimestamp": "T0", "ExecMainStartTimestampMonotonic": "1000"}
        self.det = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "disabled", "Restart": "no", "Result": "success", "MainPID": "5151",
                    "NRestarts": "0", "ExecMainStartTimestamp": "D0", "ExecMainStartTimestampMonotonic": "1100", "ActiveEnterTimestamp": "DA0", "InvocationID": "inv-d1",
                    "FragmentPath": UNIT_PATH, "DropInPaths": ""}
        self.core_cwd: str | None = RUNNING_PATH
        self.det_cwd: str | None = OLD_PATH
        self.extra_detector_procs: list[int] = []
        self.requires = {"aegis-idea3-detector.service": parse_requires(DETECTOR_UNIT_EXAMPLE)}  # the REAL unit's edges
        self.events: list[str] = []
        self.hooks: dict[str, object] = {}
        self.restart_modes: list[str] = []  # one entry per Core restart invocation (always the plain argv)
        self.detector_cycles = 0
        self.mono = 1000
        self.det_comes_back = True  # False: the dependency start of the detector fails
        self.det_cycles = True  # False: systemd (unexpectedly) leaves the detector identity untouched
        self.restart_fails = False
        self.restart_leaves_down = False
        self.cwd_override: str | None = None
        self.drop_once: set[str] = set()  # sockets that do not come back on the FIRST restart only
        self.nrestarts_after = "0"
        self.flap = False
        self.groups = [CORE_UID, REC_GID, ALERT_GID]
        self.env_uid = str(DET_UID)
        self.armed_env = False
        self.core_fds = {101, 102}
        self.listeners = {ALERT: {101}, RECOVERY: {102}}
        self.next_pid = 7000
        self.restarts_done = 0
        self.host: FakeHost | None = None

    def fire(self, name: str) -> None:
        self.events.append(name)
        hook = self.hooks.get(name)
        if hook:
            hook()

    def restart_core(self, job_mode: str = "replace") -> int:
        self.fire("restart")
        self.restart_modes.append("plain")
        if self.restart_fails:
            return 1
        self.restarts_done += 1
        self.next_pid += 1
        self.core.update(ActiveState="active", SubState="running", MainPID=str(self.next_pid), ExecMainStartTimestamp=f"T{self.restarts_done}", NRestarts=self.nrestarts_after)
        self.core_cwd = self.cwd_override or self.host.links[CURRENT]
        self.mono += 1000
        self.core["ExecMainStartTimestampMonotonic"] = str(self.mono)
        went_down = self.restart_leaves_down
        if self.restart_leaves_down:
            self.core.update(ActiveState="failed", SubState="failed", MainPID="0")
            self.restart_leaves_down = False
        self.core_fds = {200 + self.restarts_done, 300 + self.restarts_done}
        carries_r1d = f"{self.core_cwd}/aegis_soc/historical_disposition.py" in self.host.files
        self.armed_env = ARM in self.host.files[CORE_ENV]
        if self.armed_env and carries_r1d:  # the armed NEW Core serves its Core-private R1D socket
            self.core_fds.add(400 + self.restarts_done)
            self.host.ident[R1D_SOCK] = {"kind": "socket", "mode": 0o600, "uid": CORE_UID, "gid": CORE_UID}
            self.listeners[R1D_SOCK] = {400 + self.restarts_done}
        else:
            self.host.ident.pop(R1D_SOCK, None)
            self.listeners.pop(R1D_SOCK, None)
        for sock, inode in ((ALERT, 200 + self.restarts_done), (RECOVERY, 300 + self.restarts_done)):
            if sock in self.drop_once:
                self.drop_once.discard(sock)
                self.host.ident.pop(sock, None)
                self.listeners[sock] = set()
            else:
                self.host.ident.setdefault(sock, self.host.sock_identity(sock))
                self.listeners[sock] = {inode}
        # the DOCUMENTED propagation: the restart job on the Core is queued by systemd for every ACTIVE unit that Requires= it (a try-restart: an inactive detector is not started)
        if "aegis-idea3-detector.service" in restart_jobs(CORE_UNIT, job_mode, self.requires) and self.det["ActiveState"] == "active":
            if went_down or not self.det_comes_back:
                self.det.update(ActiveState="inactive" if went_down else "failed", SubState="dead" if went_down else "failed", MainPID="0", Result="success" if went_down else "exit-code")
                self.det_cwd = None
            elif self.det_cycles:
                self.detector_cycles += 1
                self.next_pid += 1
                self.det.update(MainPID=str(self.next_pid), ExecMainStartTimestamp=f"D{self.restarts_done}", ExecMainStartTimestampMonotonic=str(self.mono + 100),
                                ActiveEnterTimestamp=f"DA{self.restarts_done}", InvocationID=f"inv-d{self.restarts_done + 1}")
                self.det_cwd = self.core_cwd
        return 0


CORE_UNIT = tool.CORE_UNIT


class FakeBackend(tool.R1DuBackend):
    def __init__(self, world: World, host: FakeHost, installer_rc: int = 0, installer_reason: str = "RELEASE_ALREADY_INSTALLED"):
        super().__init__()
        self.world, self.host = world, host
        self.installer_rc, self.installer_reason = installer_rc, installer_reason
        self.slept = 0

    def _run(self, args, timeout=10.0):
        if args[0] == "show":
            unit, wanted = args[1], [a[2:] for a in args[2:]]
            state = self.world.core if unit == tool.CORE_UNIT else self.world.det
            if unit == tool.CORE_UNIT and self.world.flap and self.world.restarts_done:
                self.world.next_pid += 1
                state["MainPID"] = str(self.world.next_pid)
            return tool.CommandResult(0, "".join(f"{k}={state.get(k, '')}\n" for k in wanted))
        assert args[0] == "restart"
        assert args == ("restart", tool.CORE_UNIT)  # the real allow-list admits nothing else
        return tool.CommandResult(self.world.restart_core("replace"), "")

    def run_installer(self, rid, source_dir, logical, evidence):
        if self.installs >= 1:
            tool.refuse("INSTALLER_ALREADY_INVOKED")
        self.installs += 1
        self.world.fire("install")
        if self.installer_rc:
            return tool.CommandResult(self.installer_rc, f"L7_RELEASE_INSTALL=FAIL reason={self.installer_reason}\n")
        self.host.copy_release(source_dir, logical)
        return tool.CommandResult(0, "L7_RELEASE_INSTALL=PASS\n")

    def sleep(self, seconds):
        self.slept += 1


class FakeHost(tool.R1DuHost):
    def __init__(self, world: World):
        self.world = world
        world.host = self
        self.links = {CURRENT: OLD_PATH}
        self.dirs = {OPT, RELEASES, OLD_PATH, SOURCE_DIR, "/etc/aegis-idea3", CRED_DIR}
        self.files: dict[str, bytes] = {CORE_ENV: f"AEGIS_ALERT_SOURCE_UID={DET_UID}\nAEGIS_X=1\n".encode(), f"{CRED_DIR}/k_c2d": b"sekrit-1", f"{CRED_DIR}/admin.pin": b"1234",
                                        UNIT_PATH: UNIT_BYTES}
        self.meta: dict[str, dict] = {}
        self.guard: dict[str, object] = {}
        self.ident = {"/run/aegis-idea3-recovery": {"kind": "dir", "mode": 0o750, "uid": CORE_UID, "gid": REC_GID},
                      "/run/aegis-idea3-alert": {"kind": "dir", "mode": 0o2750, "uid": CORE_UID, "gid": ALERT_GID},
                      ALERT: self.sock_identity(ALERT), RECOVERY: self.sock_identity(RECOVERY)}
        self.ops: list[tuple[str, ...]] = []
        self.snapshots: list[bool] = []
        self.release(OLD_PATH, OLD, OLD)
        self.release(RUNNING_PATH, RUNNING, RUNNING, det=b"# the OLDER detector that ships with the running-Core release\n")
        self.guard[RUNNING_PATH] = (RUNNING, RUNNING)
        self.release(SOURCE_DIR, NEW, NEW_SRC, r1d=True)
        self.guard[OLD_PATH], self.guard[SOURCE_DIR] = (OLD, OLD), (NEW, NEW_SRC)
        for i, path in enumerate(sorted(p for p in self.files if p.startswith("/etc/aegis-idea3"))):
            self.meta[path] = {"type": "file", "mode": 0o600, "uid": 0, "gid": 0, "size": len(self.files[path]), "mtime_ns": 1, "ctime_ns": 1, "ino": 10 + i}
        self.meta["/etc/aegis-idea3/credentials"] = {"type": "dir", "mode": 0o700, "uid": 0, "gid": 0, "size": 0, "mtime_ns": 1, "ctime_ns": 1, "ino": 9}

    @staticmethod
    def sock_identity(path):
        if path == ALERT:
            return {"kind": "socket", "mode": 0o620, "uid": CORE_UID, "gid": ALERT_GID}
        return {"kind": "socket", "mode": 0o660, "uid": CORE_UID, "gid": REC_GID}

    def release(self, root, rid, source, *, det=DET_BYTES, core=CORE_BYTES, dirty=False, r1d=False):
        self.dirs.add(root)
        if r1d:
            self.files[f"{root}/aegis_soc/historical_disposition.py"] = b"# R1D authority fixture\nEVENT = 'INCIDENT_DISPOSED_HISTORICAL'\n"
        self.files[f"{root}/RELEASE-MANIFEST.json"] = manifest(rid, source, dirty)
        self.files[f"{root}/aegis_soc/production_detector.py"] = det
        self.files[f"{root}/aegis_soc/recovery_core.py"] = core
        self.files[f"{root}/aegis_soc/supervisor.py"] = b"# supervisor (Core entrypoint) fixture\n"
        self.files[f"{root}/requirements.txt"] = b"pinned==1\n"
        self.files[f"{root}/venv/bin/python"] = b"#!interpreter fixture\n"

    def copy_release(self, src, dst):
        self.dirs.add(dst)
        for path in [p for p in self.files if p.startswith(src + "/")]:
            self.files[dst + path[len(src):]] = self.files[path]
        self.guard[dst] = self.guard[src]

    # ---- the filesystem surface the tool reads/writes
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
        if path.endswith("/RELEASE-SHA256SUMS") and path not in self.files:  # derived from the CURRENT files, like the (guard-verified) real sums
            root = path.rsplit("/", 1)[0]
            rows = sorted((p[len(root) + 1:], hashlib.sha256(b).hexdigest()) for p, b in self.files.items() if p.startswith(root + "/"))
            return "".join(f"{digest}  {rel}\n" for rel, digest in rows).encode()
        return self.files[path]

    def sha256_file(self, path):
        return hashlib.sha256(self.files[path]).hexdigest()

    def listdir(self, path):
        names = {p[len(path) + 1:].split("/")[0] for p in [*self.files, *self.dirs, *self.meta] if p.startswith(path + "/")}
        return sorted(names)

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

    # ---- process / account proofs
    def detector_processes(self):
        pid = self.world.det["MainPID"]
        base = [int(pid)] if self.world.det["ActiveState"] == "active" and pid.isdigit() and int(pid) > 0 else []
        return sorted(base + self.world.extra_detector_procs)

    def proc_cwd(self, pid):
        pid = str(pid)
        if pid == self.world.core["MainPID"]:
            return self.world.core_cwd
        if pid == self.world.det["MainPID"]:
            return self.world.det_cwd
        return None

    def identity(self, path):
        return self.ident.get(path)

    def account(self, name):
        return {tool.CORE_USER: (CORE_UID, CORE_UID), tool.DETECTOR_USER: (DET_UID, DET_UID)}.get(name)

    def group_gid(self, name):
        return {tool.RECOVERY_GROUP: REC_GID, tool.ALERT_GROUP: ALERT_GID}.get(name)

    def proc_groups(self, pid):
        return list(self.world.groups)

    def proc_environ_value(self, pid, key):
        if key == tool.ARM_KEY:
            return "YES" if self.world.armed_env else None
        return self.world.env_uid

    # ---- core.env arming (the ONE owned edit): an atomic replace changes size, mtime, ctime and inode; owner/group/mode are preserved
    def core_env_arm(self, line):
        before = self.files[CORE_ENV]
        suffix = (b"" if before.endswith(b"\n") or not before else b"\n") + line.encode("ascii") + b"\n"
        self._set_core_env(before + suffix)
        self.ops.append(("arm", CORE_ENV))
        return suffix

    def core_env_unarm(self, suffix):
        current = self.files[CORE_ENV]
        if not current.endswith(suffix):
            tool.refuse("CORE_ENV_SUFFIX_NOT_OURS")
        self._set_core_env(current[: len(current) - len(suffix)])
        self.ops.append(("unarm", CORE_ENV))

    def core_env_size(self):
        return len(self.files[CORE_ENV])

    def core_env_tail(self, length):
        return self.files[CORE_ENV][-length:] if length else b""

    def _set_core_env(self, data):
        self.files[CORE_ENV] = data
        meta = self.meta[CORE_ENV]
        meta.update(size=len(data), mtime_ns=meta["mtime_ns"] + 7, ctime_ns=meta["ctime_ns"] + 7, ino=meta["ino"] + 1000)

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


# ═══ architecture audit: Core restart vs the running detector (hermetic systemd model) ═══════════════════════════════════════════


def test_the_real_detector_unit_requires_the_core_and_binds_nothing_stronger():
    text = DETECTOR_UNIT_EXAMPLE.read_text()
    assert "aegis-idea3-core.service" in parse_requires(DETECTOR_UNIT_EXAMPLE)
    assert re.search(r"^After=aegis-idea3-core\.service$", text, re.MULTILINE) and re.search(r"^Restart=no$", text, re.MULTILINE)
    # Requires= reacts only to JOBS; BindsTo/PartOf/Upholds/PropagatesStopTo would react to plain state changes or pull the detector in: none may exist (the units are not edited by R1Du)
    assert not re.search(r"^(BindsTo|PartOf|Upholds|PropagatesStopTo|PropagatesReloadTo|ConsistsOf|Wants)=", text, re.MULTILINE)
    core = CORE_UNIT_EXAMPLE.read_text()
    assert "detector" not in core.lower() or not re.search(r"^(Before|BindsTo|PartOf|Upholds|ConsistsOf|Wants|Requires)=.*detector", core, re.MULTILINE)


def test_a_normal_core_restart_propagates_to_the_detector_through_systemd_and_r1du_uses_no_job_mode_override():
    requires = {"aegis-idea3-detector.service": parse_requires(DETECTOR_UNIT_EXAMPLE)}
    assert restart_jobs(tool.CORE_UNIT, "replace", requires) == {tool.CORE_UNIT, "aegis-idea3-detector.service"}  # default job mode: systemd restarts the detector (a new MainPID)
    assert restart_jobs(tool.CORE_UNIT, "fail", requires) == {tool.CORE_UNIT, "aegis-idea3-detector.service"}
    assert tool.RESTART_ARGS == ("restart", tool.CORE_UNIT)  # OPTION A: the normal governed restart, nothing bypassing the dependency
    assert not [a for a in tool.RESTART_ARGS if a.startswith("-")]


def test_the_world_model_cycles_the_detector_as_the_dependency_consequence_of_the_one_core_restart(tmp_path):
    _host, backend, world, _ = build(tmp_path)
    assert backend.systemctl(*tool.RESTART_ARGS).rc == 0
    assert world.restart_modes == ["plain"] and world.detector_cycles == 1
    assert world.det["MainPID"] != "5151" and world.det["ActiveEnterTimestamp"] != "DA0" and world.det["InvocationID"] != "inv-d1"
    assert [c for c in backend.calls if c[0] != "show"] == [tool.RESTART_ARGS]  # the detector was never commanded: only the Core restart was issued


@pytest.mark.parametrize("argv", [
    ("restart", "--job-mode=replace", tool.CORE_UNIT), ("restart", "--job-mode=fail", tool.CORE_UNIT), ("restart", "--job-mode=ignore-requirements", tool.CORE_UNIT),
    ("restart", "--job-mode=ignore-dependencies", tool.CORE_UNIT), ("--job-mode=ignore-dependencies", "restart", tool.CORE_UNIT), ("restart", "--job-mode=ignore-dependencies", tool.DETECTOR_UNIT),
    ("restart", "--no-block", tool.CORE_UNIT), ("restart", "--now", tool.CORE_UNIT), ("restart", tool.CORE_UNIT, tool.DETECTOR_UNIT), ("restart", "x.service"),
    ("try-restart", tool.CORE_UNIT), ("reload-or-restart", tool.CORE_UNIT), ("start", tool.CORE_UNIT), ("stop", tool.CORE_UNIT), ("start", tool.DETECTOR_UNIT), ("stop", tool.DETECTOR_UNIT),
    ("restart", tool.DETECTOR_UNIT), ("try-restart", tool.DETECTOR_UNIT), ("kill", tool.CORE_UNIT), ("kill", tool.DETECTOR_UNIT), ("reset-failed", tool.DETECTOR_UNIT),
    ("daemon-reload",), ("enable", tool.DETECTOR_UNIT), ("disable", tool.DETECTOR_UNIT), ("mask", tool.CORE_UNIT), ("show", "other.service", "-pMainPID"), ("show", tool.CORE_UNIT, "--now"),
    ("edit", tool.DETECTOR_UNIT), ("set-property", tool.CORE_UNIT, "CPUWeight=1"),
])
def test_the_privileged_backend_offers_only_show_and_the_one_core_restart_and_never_a_detector_command_or_a_job_mode(argv):
    assert tool.R1DuBackend.allowed(argv) is False
    backend = tool.R1DuBackend()
    assert refusal(backend.systemctl, *argv) == "SYSTEMCTL_VERB_NOT_ALLOWED" and backend.calls == []


def test_the_allow_list_accepts_exactly_show_of_the_two_units_and_the_exact_core_restart_argv():
    assert tool.R1DuBackend.allowed(("restart", tool.CORE_UNIT)) and tool.RESTART_ARGS == ("restart", tool.CORE_UNIT)
    assert tool.R1DuBackend.allowed(("show", tool.CORE_UNIT, "-pMainPID", "-pNRestarts"))
    assert tool.R1DuBackend.allowed(("show", tool.DETECTOR_UNIT, "-pMainPID"))


def test_the_backend_records_exactly_one_restart_invocation_and_refuses_a_second(tmp_path):
    _host, backend, world, _ = build(tmp_path)
    assert backend.systemctl(*tool.RESTART_ARGS).rc == 0 and backend.restarts == 1
    assert refusal(backend.systemctl, *tool.RESTART_ARGS) == "CORE_RESTART_ALREADY_INVOKED" and world.restart_modes == ["plain"]


# ═══ APPLY: install once, switch once, restart once, in order; the Core moves to the NEW runtime ═══════════════════════════════


def test_apply_installs_switches_and_restarts_once_in_order_and_the_running_core_uses_the_new_release(tmp_path):
    host, backend, world, work = build(tmp_path)
    out = run_apply(host, backend, work)
    assert out == {"R1DU_APPLY": "COMPLETE", "NEW_RELEASE_ID": NEW, "CURRENT_TARGET": NEW_PATH, "OLD_TARGET": OLD_PATH, "R1DU_CORE_RESTART_INVOCATIONS": "1", "R1DU_EXPLICIT_DETECTOR_COMMANDS": "0",
                   "R1DU_DETECTOR_CYCLED_BY_CORE_RESTART": "YES"}
    assert world.events == ["install", "switch", "restart"] and backend.installs == 1 and backend.restarts == 1
    assert [op for op in host.ops if op[0] == "replace"] == [("replace", CURRENT)] and host.links[CURRENT] == NEW_PATH
    assert world.core_cwd == NEW_PATH  # the RUNNING Core (not merely the pointer) is on the new release
    assert world.core["MainPID"] != "4242" and world.core["NRestarts"] == "0"
    # OPTION A: systemd stopped the detector D1 with the Core and started a NEW D2 from the NEW release, as the dependency consequence of the ONE restart
    assert world.restart_modes == ["plain"] and world.detector_cycles == 1
    assert world.det["MainPID"] not in ("5151", "") and world.det["MainPID"] != world.core["MainPID"] and world.det_cwd == NEW_PATH and world.det["InvocationID"] != "inv-d1"
    assert world.det["ExecMainStartTimestamp"] != "D0" and int(world.det["ExecMainStartTimestampMonotonic"]) > int(world.core["ExecMainStartTimestampMonotonic"])
    assert world.det["UnitFileState"] == "disabled" and world.det["Restart"] == "no" and host.files[UNIT_PATH] == UNIT_BYTES and world.det["NRestarts"] == "0"
    assert host.detector_processes() == [int(world.det["MainPID"])]  # exactly one detector process
    assert out["R1DU_EXPLICIT_DETECTOR_COMMANDS"] == "0" and out["R1DU_DETECTOR_CYCLED_BY_CORE_RESTART"] == "YES"
    j = journal(work)
    assert j["phase"] == "applied" and j["restart_invocations"] == 1 and j["release_tree_digest"] == host.tree_digest(NEW_PATH) and j["core"]["MainPID"] == "4242"
    assert j["detector"]["MainPID"] == "5151" and j["detector_post"]["MainPID"] == world.det["MainPID"] != j["detector"]["MainPID"] and j["detector_post"]["cwd"] == NEW_PATH
    assert host.files[f"{NEW_PATH}/aegis_soc/production_detector.py"] == DET_BYTES == host.files[f"{OLD_PATH}/aegis_soc/production_detector.py"]  # byte-identical detector


def test_current_is_never_absent_during_the_switch_and_only_the_temp_link_is_created(tmp_path):
    host, backend, _world, work = build(tmp_path)
    run_apply(host, backend, work)
    assert host.snapshots == [True] and ("symlink", tool.TMP_LINK) in host.ops and not [o for o in host.ops if o[0] == "unlink"]
    assert tool.TMP_LINK not in host.links


def test_the_journal_records_each_owned_step_before_it_happens(tmp_path):
    host, backend, world, work = build(tmp_path)
    seen: dict[str, str] = {}
    for name in ("install", "switch", "restart"):
        world.hooks[name] = (lambda n=name: seen.__setitem__(n, journal(work)["phase"]))
    run_apply(host, backend, work)
    assert seen == {"install": "installing", "switch": "switching", "restart": "restarting"}
    assert journal(work)["restart_invocations"] == 1


def test_apply_and_verify_use_only_show_and_the_one_core_restart_argv_and_issue_zero_detector_commands(tmp_path):
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    run_verify(host, backend, work)
    verbs = [c for c in backend.calls if c[0] != "show"]
    assert verbs == [tool.RESTART_ARGS] == [("restart", tool.CORE_UNIT)]
    assert all(c[1] in (tool.CORE_UNIT, tool.DETECTOR_UNIT) for c in backend.calls if c[0] == "show")
    assert not [c for c in backend.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]  # ZERO explicit detector start/stop/restart: the cycle is systemd's dependency consequence
    assert world.restart_modes == ["plain"] and world.detector_cycles == 1


def test_verify_proves_the_core_and_the_cycled_detector_run_from_the_new_release_and_issues_no_mutation(tmp_path):
    host, backend, _world, work = build(tmp_path)
    run_apply(host, backend, work)
    ops, restarts = list(host.ops), backend.restarts
    out = run_verify(host, backend, work, source_dir="/unused")
    assert out["R1DU_VERIFY"] == "PASS" and out["CORE_RUNNING_FROM_NEW_RELEASE"] == "YES" and out["DETECTOR_CYCLED_BY_CORE_RESTART"] == "YES" and out["CORE_RESTARTED_ONCE"] == "YES"
    assert out["DETECTOR_RUNNING_FROM_NEW_RELEASE"] == "YES" and out["DETECTOR_UNIT_AND_SOURCE_UNCHANGED"] == "YES"
    assert out["ALERT_SOCKET_SERVED_BY_CORE"] == "YES" and out["RECOVERY_SOCKET_SERVED_BY_CORE"] == "YES"
    assert host.ops == ops and backend.restarts == restarts


def test_a_second_apply_for_the_same_work_directory_is_refused_before_anything_else(tmp_path):
    host, backend, _world, work = build(tmp_path)
    run_apply(host, backend, work)
    host2 = FakeHost(World())
    assert refusal(run_apply, host2, FakeBackend(host2.world, host2), work) == "ATTEMPT_JOURNAL_ALREADY_EXISTS" and host2.world.events == []


def test_a_core_that_does_not_serve_the_alert_socket_even_if_the_file_exists_fails_the_runtime_proof(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.listeners[ALERT] = {999}  # someone else (or nobody) holds the listening socket: the Core process does not
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_NOT_SERVED_BY_CORE"  # refused by the PRE gate, before any mutation
    assert_untouched(host, world, work)


# ═══ PRE gates: every refusal happens before a single mutation or journal ════════════════════════════════════════════════════════


def _w(**kv):
    return lambda host, world: world.core.update(kv)


def _d(**kv):
    return lambda host, world: world.det.update(kv)


PRE_CASES = [
    ("candidate release already exists", lambda h, w: h.dirs.add(NEW_PATH), "TARGET_RELEASE_ALREADY_EXISTS"),
    ("install temp residue", lambda h, w: h.dirs.add(f"{RELEASES}/.install-tmp-{NEW}-abc"), "INSTALL_TEMP_RESIDUE"),
    ("wrong current target", lambda h, w: h.links.__setitem__(CURRENT, f"{RELEASES}/intruder"), "CURRENT_NOT_EXPECTED_TARGET"),
    ("relative current target", lambda h, w: h.links.__setitem__(CURRENT, f"releases/{OLD}"), "CURRENT_NOT_EXPECTED_TARGET"),
    ("current missing", lambda h, w: h.links.pop(CURRENT), "CURRENT_MISSING"),
    ("current not a symlink", lambda h, w: (h.links.pop(CURRENT), h.files.__setitem__(CURRENT, b"x")), "CURRENT_NOT_A_SYMLINK"),
    ("source release invalid", lambda h, w: h.guard.__setitem__(SOURCE_DIR, "SYMLINK_IN_RELEASE"), "SOURCE_RELEASE_INVALID:RELEASE_GUARD:SYMLINK_IN_RELEASE"),
    ("source release id mismatch", lambda h, w: h.guard.__setitem__(SOURCE_DIR, ("other", NEW_SRC)), "RELEASE_ID_MISMATCH"),
    ("release source sha mismatch (guard)", lambda h, w: h.guard.__setitem__(SOURCE_DIR, (NEW, "1" * 40)), "RELEASE_SOURCE_SHA_MISMATCH"),
    ("manifest source sha mismatch", lambda h, w: h.files.__setitem__(f"{SOURCE_DIR}/RELEASE-MANIFEST.json", manifest(source="2" * 40)), "RELEASE_SOURCE_SHA_MISMATCH"),
    ("dirty source tree", lambda h, w: h.files.__setitem__(f"{SOURCE_DIR}/RELEASE-MANIFEST.json", manifest(dirty=True)), "RELEASE_SOURCE_TREE_DIRTY"),
    ("non boolean dirty flag", lambda h, w: h.files.__setitem__(f"{SOURCE_DIR}/RELEASE-MANIFEST.json", manifest(dirty="false")), "RELEASE_SOURCE_TREE_DIRTY"),
    ("new release detector digest mismatch", lambda h, w: h.files.__setitem__(f"{SOURCE_DIR}/aegis_soc/production_detector.py", DET_BYTES + b"x"), "DETECTOR_SHA256_MISMATCH"),
    ("new release recovery core digest mismatch", lambda h, w: h.files.__setitem__(f"{SOURCE_DIR}/aegis_soc/recovery_core.py", CORE_BYTES + b"x"), "RECOVERY_CORE_SHA256_MISMATCH"),
    ("old release invalid", lambda h, w: h.guard.__setitem__(OLD_PATH, "OWNER_INVALID"), "CURRENT_RELEASE_INVALID"),
    ("old release detector bytes differ from the reviewed pin", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/production_detector.py", b"other"), "OLD_RELEASE_DETECTOR_SHA256_MISMATCH"),
    ("temp link exists", lambda h, w: h.links.__setitem__(tool.TMP_LINK, "x"), "SWITCH_TEMP_EXISTS"),
    ("core inactive", lambda h, w: w.core.update(ActiveState="inactive"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core not running substate", lambda h, w: w.core.update(SubState="dead"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core pid 0", lambda h, w: w.core.update(MainPID="0"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core nrestarts nonzero", lambda h, w: w.core.update(NRestarts="2"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core result failure", lambda h, w: w.core.update(Result="exit-code"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core unit not enabled", lambda h, w: w.core.update(UnitFileState="disabled"), "CORE_PRESTATE_NOT_HEALTHY"),
    ("core cwd unreadable", lambda h, w: setattr(w, "core_cwd", None), "CORE_CWD_UNREADABLE"),
    ("core already on the new release", lambda h, w: setattr(w, "core_cwd", NEW_PATH), "CORE_PRESTATE_RELEASE_UNEXPECTED"),
    ("detector inactive", lambda h, w: w.det.update(ActiveState="inactive"), "DETECTOR_NOT_RUNNING"),
    ("detector not loaded", lambda h, w: w.det.update(LoadState="not-found"), "DETECTOR_NOT_RUNNING"),
    ("detector failed result", lambda h, w: w.det.update(Result="exit-code"), "DETECTOR_NOT_RUNNING"),
    ("detector pid 0", lambda h, w: w.det.update(MainPID="0"), "DETECTOR_MAINPID_INVALID"),
    ("detector nrestarts nonzero", lambda h, w: w.det.update(NRestarts="1"), "DETECTOR_NRESTARTS_NOT_ZERO"),
    ("detector unit enabled", lambda h, w: w.det.update(UnitFileState="enabled"), "DETECTOR_UNIT_CONTRACT_MISMATCH"),
    ("detector restart policy", lambda h, w: w.det.update(Restart="on-failure"), "DETECTOR_UNIT_CONTRACT_MISMATCH"),
    ("detector drop-in present", lambda h, w: w.det.update(DropInPaths="/etc/systemd/system/aegis-idea3-detector.service.d/x.conf"), "DETECTOR_UNIT_PATH_OR_DROPIN_UNEXPECTED"),
    ("detector fragment elsewhere", lambda h, w: w.det.update(FragmentPath="/usr/lib/systemd/system/aegis-idea3-detector.service"), "DETECTOR_UNIT_PATH_OR_DROPIN_UNEXPECTED"),
    ("detector unit bytes differ", lambda h, w: h.files.__setitem__(UNIT_PATH, UNIT_BYTES + b"x"), "DETECTOR_UNIT_SHA256_MISMATCH"),
    ("a standalone second detector", lambda h, w: w.extra_detector_procs.append(9999), "DETECTOR_PROCESS_SET_UNEXPECTED"),
    ("detector release boundary is not the old release", lambda h, w: (setattr(w, "det_cwd", RUNNING_PATH), h.files.__setitem__(f"{RUNNING_PATH}/aegis_soc/production_detector.py", DET_BYTES)),
     "DETECTOR_RELEASE_BOUNDARY_UNEXPECTED"),
    ("detector runs source bytes that differ from the reviewed pin", lambda h, w: setattr(w, "det_cwd", RUNNING_PATH), "DETECTOR_SOURCE_SHA256_MISMATCH"),
    ("alert socket missing", lambda h, w: h.ident.pop(ALERT), "ALERT_SOCKET_MISSING"),
    ("recovery socket missing", lambda h, w: h.ident.pop(RECOVERY), "RECOVERY_SOCKET_MISSING"),
    ("alert socket wrong mode", lambda h, w: h.ident[ALERT].update(mode=0o666), "ALERT_SOCKET_METADATA_INVALID"),
    ("recovery socket wrong group", lambda h, w: h.ident[RECOVERY].update(gid=1), "RECOVERY_SOCKET_METADATA_INVALID"),
    ("alert dir wrong mode", lambda h, w: h.ident["/run/aegis-idea3-alert"].update(mode=0o755), "ALERT_RUNTIME_DIR_METADATA_INVALID"),
    ("core lacks the alert group", lambda h, w: setattr(w, "groups", [CORE_UID, REC_GID]), "CORE_PROCESS_LACKS_ALERT_GROUP"),
    ("recovery socket not served by the core", lambda h, w: w.listeners.__setitem__(RECOVERY, {1}), "RECOVERY_SOCKET_NOT_SERVED_BY_CORE"),
    ("alert uid is not the detector uid", lambda h, w: h.files.__setitem__(CORE_ENV, b"AEGIS_ALERT_SOURCE_UID=5\n"), "ALERT_UID_CONTRACT_MISMATCH"),
    ("alert uid missing from core.env", lambda h, w: h.files.__setitem__(CORE_ENV, b"AEGIS_X=1\n"), "ALERT_UID_CONTRACT_MISMATCH"),
    ("alert uid duplicated in core.env", lambda h, w: h.files.__setitem__(CORE_ENV, f"AEGIS_ALERT_SOURCE_UID={DET_UID}\nAEGIS_ALERT_SOURCE_UID={DET_UID}\n".encode()), "ALERT_UID_CONTRACT_MISMATCH"),
    ("running core lacks the alert uid", lambda h, w: setattr(w, "env_uid", "5"), "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("credentials directory missing", lambda h, w: h.meta.pop("/etc/aegis-idea3/credentials"), "MATERIAL_MISSING"),
    ("core.env missing", lambda h, w: h.meta.pop(CORE_ENV), "MATERIAL_MISSING"),
    ("releases parent missing", lambda h, w: h.dirs.discard(RELEASES), "PARENT_DIRECTORY_MISSING"),
]


@pytest.mark.parametrize("label,mutate,code", PRE_CASES, ids=[c[0] for c in PRE_CASES])
def test_every_pre_gate_refuses_before_any_mutation(tmp_path, label, mutate, code):
    host, backend, world, work = build(tmp_path)
    mutate(host, world)
    snapshot = (dict(host.links), set(host.dirs), world.core["MainPID"], world.det["MainPID"])
    assert code in refusal(run_apply, host, backend, work), label
    assert world.events == [] and backend.installs == 0 and backend.restarts == 0 and not (work / tool.JOURNAL_NAME).exists()
    assert (dict(host.links), set(host.dirs) - {NEW_PATH}, world.core["MainPID"], world.det["MainPID"])[1:] == (snapshot[1] - {NEW_PATH}, snapshot[2], snapshot[3]) or "ALREADY" in code
    assert not [o for o in host.ops if o[0] in ("replace", "symlink", "remove")]


def test_a_recovery_core_without_the_alert_accepted_implementation_is_refused_even_with_a_matching_pin(tmp_path):
    host, backend, world, work = build(tmp_path)
    bare = b"# pre-PR342 core: no audit event\n"
    host.files[f"{SOURCE_DIR}/aegis_soc/recovery_core.py"] = bare
    assert refusal(run_apply, host, backend, work, core_sha=hashlib.sha256(bare).hexdigest()) == "ALERT_ACCEPTED_IMPLEMENTATION_MISSING"
    assert_untouched(host, world, work)


def test_a_symlinked_or_missing_detector_or_core_runtime_file_in_the_release_refuses(tmp_path):
    host, backend, _world, work = build(tmp_path)
    del host.files[f"{SOURCE_DIR}/aegis_soc/production_detector.py"]
    assert refusal(run_apply, host, backend, work) == "DETECTOR_FILE_INVALID"
    host2, backend2, _world2, work2 = build(tmp_path / "b")
    del host2.files[f"{SOURCE_DIR}/aegis_soc/recovery_core.py"]
    assert refusal(run_apply, host2, backend2, work2) == "RECOVERY_CORE_FILE_INVALID"


@pytest.mark.parametrize("bad", ["", "../x", "a/b", ".hidden", "x" * 129, "a b", "a;b"])
def test_malformed_release_ids_refuse(tmp_path, bad):
    host, backend, world, work = build(tmp_path)
    assert "RELEASE_ID_INVALID" in refusal(run_apply, host, backend, work, new_id=bad)
    assert "RELEASE_ID_INVALID" in refusal(run_apply, host, backend, work, old_id=bad)
    assert_untouched(host, world, work)


def test_old_and_new_release_ids_must_differ(tmp_path):
    host, backend, _world, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, new_id=OLD) == "RELEASE_IDS_NOT_DISTINCT"


@pytest.mark.parametrize("field,values,code", [
    ("source_sha", ["", "abc", "1" * 39, "1" * 41, "G" * 40, NEW_SRC.upper(), NEW_SRC + "\n"], "RELEASE_SOURCE_SHA_PIN_INVALID"),
    ("detector_sha", ["", "abc", "0" * 63, "0" * 65, DET_SHA.upper(), DET_SHA + "\n"], "DETECTOR_SHA256_PIN_INVALID"),
    ("core_sha", ["", "abc", "0" * 63, CORE_SHA.upper(), CORE_SHA + "\n"], "RECOVERY_CORE_SHA256_PIN_INVALID"),
    ("unit_sha", ["", "abc", "0" * 65, UNIT_SHA.upper(), UNIT_SHA + "\n"], "DETECTOR_UNIT_SHA256_PIN_INVALID"),
    ("source_dir", ["", "relative/x", "/a/../b", "/opt/aegis-idea3/releases/x"], "SOURCE_DIR_INVALID"),
])
def test_malformed_pins_refuse_before_any_mutation(tmp_path, field, values, code):
    for i, bad in enumerate(values):
        host, backend, world, work = build(tmp_path / f"{field}{i}")
        assert refusal(run_apply, host, backend, work, **{field: bad}) == code
        assert_untouched(host, world, work)


def test_unreadable_host_state_is_a_fixed_refusal_not_an_empty_answer(tmp_path):
    host, backend, world, work = build(tmp_path)

    def denied(path):
        tool.refuse("HOST_READ_DENIED")

    host.is_real_dir = denied
    assert refusal(run_apply, host, backend, work) == "HOST_READ_DENIED"
    assert_untouched(host, world, work)


# ═══ FAIL CLOSED after the attempt starts: injected faults at every owned boundary ═══════════════════════════════════════════════


def test_an_installer_failure_is_evidence_never_ownership_and_nothing_else_happens(tmp_path):
    host, backend, world, work = build(tmp_path, installer_rc=1, installer_reason="RELEASE_ALREADY_INSTALLED")
    assert refusal(run_apply, host, backend, work) == "INSTALL_FAILED:RELEASE_ALREADY_INSTALLED"
    j = journal(work)
    assert j["phase"] == "installer_failed" and j["installer_reason"] == "RELEASE_ALREADY_INSTALLED"
    assert world.events == ["install"] and backend.restarts == 0 and host.links[CURRENT] == OLD_PATH and not [o for o in host.ops if o[0] == "replace"]


def test_an_unrecognised_installer_reason_is_not_persisted(tmp_path):
    host, backend, _world, work = build(tmp_path, installer_rc=2, installer_reason="bad/reason;rm")
    assert refusal(run_apply, host, backend, work) == "INSTALL_FAILED:UNKNOWN"
    assert journal(work)["installer_reason"] == "UNKNOWN"


def test_a_foreign_current_drift_right_after_the_install_stops_before_the_switch(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: host.links.__setitem__(CURRENT, f"{RELEASES}/foreign")
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_EXPECTED_TARGET"
    assert journal(work)["phase"] == "installed" and "switch" not in world.events and backend.restarts == 0


def test_a_core_replaced_by_another_actor_before_the_switch_stops_before_the_switch(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: world.core.update(MainPID="31337")
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    assert "switch" not in world.events and backend.restarts == 0


@pytest.mark.parametrize("hook,key,value,code", [
    ("install", "MainPID", "6000", "DETECTOR_DRIFT:MainPID"),
    ("install", "ActiveEnterTimestamp", "other", "DETECTOR_DRIFT:ActiveEnterTimestamp"),
    ("install", "InvocationID", "other", "DETECTOR_DRIFT:InvocationID"),
    ("switch", "ExecMainStartTimestamp", "other", "DETECTOR_DRIFT:ExecMainStartTimestamp"),
    ("switch", "NRestarts", "1", "DETECTOR_DRIFT:NRestarts"),
    ("switch", "UnitFileState", "enabled", "DETECTOR_DRIFT:UnitFileState"),
])
def test_before_the_restart_the_detector_must_still_be_exactly_d1_and_any_drift_stops_the_attempt(tmp_path, hook, key, value, code):
    host, backend, world, work = build(tmp_path)
    world.hooks[hook] = lambda: world.det.update({key: value})
    assert code in refusal(run_apply, host, backend, work)
    # drift seen BEFORE an owned step stops the attempt before that step: install-time drift never reaches the switch, switch-time drift never reaches the restart
    later = {"install": ("switch", "restart"), "switch": ("restart",)}[hook]
    assert not [event for event in later if event in world.events], (hook, world.events)
    assert [c for c in backend.calls if c[0] != "show"] == [] and not [c for c in backend.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]


def after_restart(world, host, mutate):
    """Run ``mutate`` right AFTER the (modelled) Core restart and its systemd dependency cycle."""
    original = world.restart_core

    def wrapped(mode="replace"):
        rc = original(mode)
        mutate(host, world)
        return rc

    world.restart_core = wrapped


@pytest.mark.parametrize("label,mutate,code", [
    ("detector does not come back", lambda h, w: w.det.update(ActiveState="inactive", SubState="dead", MainPID="0"), "DETECTOR_NOT_RUNNING"),
    ("detector start failed (Core restart succeeded)", lambda h, w: w.det.update(ActiveState="failed", SubState="failed", Result="exit-code"), "DETECTOR_NOT_RUNNING"),
    ("detector comes back with the wrong source digest", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/production_detector.py", DET_BYTES + b"# tampered"), "DETECTOR_SOURCE_SHA256_MISMATCH"),
    ("detector unit bytes changed", lambda h, w: h.files.__setitem__(UNIT_PATH, UNIT_BYTES + b"# edited\n"), "DETECTOR_UNIT_SHA256_MISMATCH"),
    ("detector unit became enabled", lambda h, w: w.det.update(UnitFileState="enabled"), "DETECTOR_UNIT_CONTRACT_MISMATCH"),
    ("detector restart policy changed", lambda h, w: w.det.update(Restart="on-failure"), "DETECTOR_UNIT_CONTRACT_MISMATCH"),
    ("detector gained a drop-in", lambda h, w: w.det.update(DropInPaths="/etc/systemd/system/aegis-idea3-detector.service.d/x.conf"), "DETECTOR_UNIT_PATH_OR_DROPIN_UNEXPECTED"),
    ("a second detector process exists", lambda h, w: w.extra_detector_procs.append(777), "DETECTOR_PROCESS_SET_UNEXPECTED"),
    ("the detector still runs from the OLD release", lambda h, w: setattr(w, "det_cwd", OLD_PATH), "DETECTOR_NOT_ON_EXPECTED_RUNTIME"),
    ("the detector runs from an unrelated release", lambda h, w: (setattr(w, "det_cwd", RUNNING_PATH), h.files.__setitem__(f"{RUNNING_PATH}/aegis_soc/production_detector.py", DET_BYTES)),
     "DETECTOR_NOT_ON_EXPECTED_RUNTIME"),
    ("detector NRestarts sanity value moved", lambda h, w: w.det.update(NRestarts="1"), "DETECTOR_NRESTARTS_NOT_ZERO"),
    ("detector start timestamp not newer", lambda h, w: w.det.update(ExecMainStartTimestamp="D0"), "DETECTOR_START_TIMESTAMP_NOT_NEWER"),
    ("detector monotonic start not newer", lambda h, w: w.det.update(ExecMainStartTimestampMonotonic="900"), "DETECTOR_START_TIMESTAMP_NOT_NEWER"),
    ("detector started before the Core", lambda h, w: w.det.update(ExecMainStartTimestampMonotonic="1500"), "DETECTOR_STARTED_BEFORE_CORE"),
    ("detector invocation id unchanged", lambda h, w: w.det.update(InvocationID="inv-d1"), "DETECTOR_INVOCATION_NOT_CHANGED"),
    ("detector pid unchanged after the owned restart", lambda h, w: w.det.update(MainPID="5151"), "DETECTOR_NOT_CYCLED_BY_CORE_RESTART"),
])
def test_after_the_restart_the_detector_lifecycle_is_proven_or_the_attempt_fails_closed(tmp_path, label, mutate, code):
    host, backend, world, work = build(tmp_path)
    after_restart(world, host, mutate)
    if label == "detector pid unchanged after the owned restart":
        world.det_cycles = False  # systemd (unexpectedly) left D1 alone: unexplained, never accepted
        world.det["ExecMainStartTimestamp"] = "D0"
    assert refusal(run_apply, host, backend, work) == code, label
    assert journal(work)["phase"] == "restarted" and not [c for c in backend.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]


def test_a_detector_that_never_cycles_after_the_owned_restart_is_investigated_not_accepted(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.det_cycles = False
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_CYCLED_BY_CORE_RESTART"


def test_a_detector_that_fails_to_start_as_the_dependency_consequence_fails_closed_and_is_never_started_by_r1du(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.det_comes_back = False
    assert refusal(run_apply, host, backend, work) == "DETECTOR_NOT_RUNNING"
    assert [c for c in backend.calls if c[0] != "show"] == [tool.RESTART_ARGS]


def test_a_detector_whose_identity_keeps_moving_after_the_restart_is_unstable_and_refused(tmp_path):
    host, backend, world, work = build(tmp_path)
    ticks = iter(range(1000))
    original = host.detector_processes

    def churn():
        world.det["ExecMainStartTimestamp"] = f"churn{next(ticks)}"  # the identity keeps moving between two reads
        return original()

    after_restart(world, host, lambda h, w: setattr(h, "detector_processes", churn))
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNSTABLE"


def test_ordering_the_detector_must_not_start_before_the_core_is_healthy_when_observable(tmp_path):
    host, backend, world, work = build(tmp_path)
    after_restart(world, host, lambda h, w: w.det.update(ExecMainStartTimestampMonotonic=str(int(w.core["ExecMainStartTimestampMonotonic"]) - 1)))
    assert refusal(run_apply, host, backend, work) == "DETECTOR_STARTED_BEFORE_CORE"


def test_a_core_restart_that_fails_leaves_everything_journaled_for_rollback(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.restart_fails = True
    assert refusal(run_apply, host, backend, work) == "CORE_RESTART_FAILED"
    j = journal(work)
    assert j["phase"] == "restarting" and j["restart_invocations"] == 1 and backend.restarts == 1


def test_a_core_that_stays_down_after_the_restart_is_refused(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.restart_leaves_down = True
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_HEALTHY"


def test_a_core_that_comes_back_in_a_restart_loop_is_refused(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.nrestarts_after = "1"
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_HEALTHY"
    host2, backend2, world2, work2 = build(tmp_path / "flap")
    world2.flap = True
    assert refusal(run_apply, host2, backend2, work2) == "CORE_NOT_HEALTHY:UNSTABLE"


def test_a_core_that_was_not_actually_restarted_is_refused(tmp_path):
    host, backend, world, work = build(tmp_path)

    def noop_restart(mode):
        world.restart_modes.append(mode)
        return 0

    world.restart_core = noop_restart
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_RESTARTED"


def test_a_core_that_comes_back_on_the_wrong_release_is_refused_even_though_current_points_at_new(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.cwd_override = RUNNING_PATH
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_RUNNING_FROM_NEW_RELEASE"
    assert host.links[CURRENT] == NEW_PATH  # the pointer alone proved nothing


def test_alert_socket_missing_after_the_restart_fails_closed(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"


def test_recovery_socket_missing_after_the_restart_fails_closed(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(RECOVERY)
    assert refusal(run_apply, host, backend, work) == "RECOVERY_SOCKET_MISSING"


@pytest.mark.parametrize("label,mutate,code", [
    ("alert socket owner/mode drift", lambda h, w: h.ident[ALERT].update(mode=0o660), "ALERT_SOCKET_METADATA_INVALID"),
    ("core lost the recovery group", lambda h, w: setattr(w, "groups", [CORE_UID, ALERT_GID]), "CORE_PROCESS_LACKS_RECOVERY_GROUP"),
    ("core lost the alert uid in its environment", lambda h, w: setattr(w, "env_uid", "5"), "CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID"),
    ("alert socket held by nobody", lambda h, w: w.listeners.__setitem__(ALERT, set()), "ALERT_SOCKET_NOT_SERVED_BY_CORE"),
])
def test_post_restart_transport_drift_fails_closed(tmp_path, label, mutate, code):
    host, backend, world, work = build(tmp_path)
    world.hooks["restart"] = lambda: None
    original = world.restart_core

    def restart_then_mutate(mode):
        rc = original(mode)
        mutate(host, world)
        return rc

    world.restart_core = restart_then_mutate
    assert refusal(run_apply, host, backend, work) == code, label


def test_core_env_and_credentials_content_drift_during_apply_fails_closed(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.hooks["restart"] = lambda: host.files.__setitem__(f"{CRED_DIR}/k_c2d", b"rotated")
    assert refusal(run_apply, host, backend, work) == "MATERIAL_CONTENT_DRIFT"
    host2, backend2, world2, work2 = build(tmp_path / "meta")
    world2.hooks["restart"] = lambda: host2.meta[CORE_ENV].update(mode=0o644)  # owner/group/mode of core.env must survive the owned atomic replace unchanged
    assert refusal(run_apply, host2, backend2, work2) == "MATERIAL_METADATA_DRIFT"
    host3, backend3, world3, work3 = build(tmp_path / "foreign")
    world3.hooks["restart"] = lambda: host3.files.__setitem__(CORE_ENV, host3.files[CORE_ENV] + b"AEGIS_FOREIGN=1\n")  # ANY byte other than the owned suffix is drift
    assert refusal(run_apply, host3, backend3, work3) in ("MATERIAL_CONTENT_DRIFT", "MATERIAL_METADATA_DRIFT")


def test_a_second_restart_invocation_in_one_process_is_impossible(tmp_path):
    host, backend, world, work = build(tmp_path)
    backend.restarts = 1  # one intentional restart per process, ever
    assert refusal(run_apply, host, backend, work) == "CORE_RESTART_ALREADY_INVOKED"
    assert world.restart_modes == []


def test_a_leftover_temp_link_that_appears_after_the_install_is_never_adopted(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: host.links.__setitem__(tool.TMP_LINK, "x")
    assert refusal(run_apply, host, backend, work) == "SWITCH_TEMP_EXISTS"
    assert host.links[tool.TMP_LINK] == "x" and host.links[CURRENT] == OLD_PATH


# ═══ VERIFY ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def applied(tmp_path):
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    return host, FakeBackend(world, host), world, work


def test_verify_without_an_applied_journal_refuses(tmp_path):
    host, backend, world, work = build(tmp_path)
    assert refusal(run_verify, host, backend, work) == "ATTEMPT_NOT_APPLIED"
    world.restart_fails = True
    refusal(run_apply, host, backend, work)
    assert refusal(run_verify, host, FakeBackend(world, host), work) == "ATTEMPT_NOT_APPLIED"


@pytest.mark.parametrize("over", [{"new_id": "f" * 40}, {"old_id": "e" * 40}, {"source_sha": "3" * 40}, {"detector_sha": "4" * 64}, {"core_sha": "5" * 64}, {"unit_sha": "6" * 64}])
def test_verify_refuses_pins_that_differ_from_the_attempt(tmp_path, over):
    host, backend, _world, work = applied(tmp_path)
    assert refusal(run_verify, host, backend, work, **over) == "ATTEMPT_PINS_MISMATCH"


@pytest.mark.parametrize("label,mutate,code", [
    ("current repointed", lambda h, w: h.links.__setitem__(CURRENT, OLD_PATH), "CURRENT_NOT_NEW_TARGET"),
    ("temp link left behind", lambda h, w: h.links.__setitem__(tool.TMP_LINK, "x"), "SWITCH_TEMP_EXISTS"),
    ("release tree changed", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/extra.py", b"x"), "RELEASE_TREE_CHANGED"),
    ("release guard fails", lambda h, w: h.guard.__setitem__(NEW_PATH, "OWNER_INVALID"), "RELEASE_GUARD:OWNER_INVALID"),
    ("old release gone", lambda h, w: h.guard.pop(OLD_PATH), "CURRENT_RELEASE_INVALID"),
    ("core restarted again after apply", lambda h, w: w.core.update(MainPID="8888", ExecMainStartTimestamp="T9"), "CORE_RESTARTED_AGAIN_AFTER_APPLY"),
    ("core stopped", lambda h, w: w.core.update(ActiveState="inactive"), "CORE_NOT_HEALTHY"),
    ("core back on an old runtime", lambda h, w: setattr(w, "core_cwd", RUNNING_PATH), "CORE_NOT_RUNNING_FROM_NEW_RELEASE"),
    ("detector cycled again after apply (pid)", lambda h, w: w.det.update(MainPID="1"), "DETECTOR_CYCLED_AGAIN_AFTER_APPLY:MainPID"),
    ("detector cycled again after apply (active-enter)", lambda h, w: w.det.update(ActiveEnterTimestamp="x"), "DETECTOR_CYCLED_AGAIN_AFTER_APPLY:ActiveEnterTimestamp"),
    ("detector stopped after apply", lambda h, w: w.det.update(ActiveState="inactive", SubState="dead", MainPID="0"), "DETECTOR_NOT_RUNNING"),
    ("detector unit edited after apply", lambda h, w: h.files.__setitem__(UNIT_PATH, b"edited"), "DETECTOR_UNIT_SHA256_MISMATCH"),
    ("detector moved back to the old release", lambda h, w: setattr(w, "det_cwd", OLD_PATH), "DETECTOR_NOT_ON_EXPECTED_RUNTIME"),
    ("a duplicate detector appeared after apply", lambda h, w: w.extra_detector_procs.append(99), "DETECTOR_PROCESS_SET_UNEXPECTED"),
    ("alert socket gone", lambda h, w: h.ident.pop(ALERT), "ALERT_SOCKET_MISSING"),
    ("core.env mode drift", lambda h, w: h.meta[CORE_ENV].update(mode=0o644), "MATERIAL_METADATA_DRIFT"),
    ("the arming line is gone", lambda h, w: h.files.__setitem__(CORE_ENV, h.files[CORE_ENV].replace(ARM, b"")), "ARM_LINE_NOT_PRESENT"),
])
def test_verify_refuses_every_post_apply_deviation(tmp_path, label, mutate, code):
    host, backend, world, work = applied(tmp_path)
    mutate(host, world)
    assert code in refusal(run_verify, host, backend, work), label


def test_verify_refuses_when_the_journal_does_not_record_exactly_one_restart(tmp_path):
    host, backend, _world, work = applied(tmp_path)
    j = journal(work)
    j["restart_invocations"] = 2
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    assert refusal(run_verify, host, backend, work) == "CORE_RESTART_COUNT_NOT_ONE"


# ═══ ROLLBACK ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════


def rollback(host, world, work, backend=None):
    return tool.rollback(work, host, backend or FakeBackend(world, host))


def test_rollback_with_no_journal_or_before_any_mutation_owns_nothing(tmp_path):
    host, backend, world, work = build(tmp_path)
    assert rollback(host, world, work, backend) == {"R1DU_ROLLBACK": "NOTHING_OWNED"}
    tool.write_journal(work, {"stage": "R1Du", "phase": "preflight"})
    assert rollback(host, world, work, backend) == {"R1DU_ROLLBACK": "NOTHING_OWNED"} and not host.ops and not backend.calls


def fail_reprove_on_call(monkeypatch, number: int, code: str) -> None:
    """Inject a fixed refusal into the Nth ``reprove_prestate`` call of apply (1 = before the install, 2 = after it, 3 = after the switch)."""
    original, calls = tool.reprove_prestate, {"n": 0}

    def flaky(h, b, j):
        calls["n"] += 1
        if calls["n"] == number:
            tool.refuse(code)
        return original(h, b, j)

    monkeypatch.setattr(tool, "reprove_prestate", flaky)


def test_rollback_after_a_pre_switch_failure_removes_only_the_owned_release_and_touches_nothing_else(tmp_path, monkeypatch):
    host, backend, world, work = build(tmp_path)
    fail_reprove_on_call(monkeypatch, 2, "INJECTED_PRE_SWITCH_FAILURE")
    assert refusal(run_apply, host, backend, work) == "INJECTED_PRE_SWITCH_FAILURE"
    assert journal(work)["phase"] == "installed" and NEW_PATH in host.dirs
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK"] == "PASS" and out["CORE_RESTARTED_FOR_ROLLBACK"] == "NO" and out["NEW_RELEASE_ABSENT"] == "YES"
    assert NEW_PATH not in host.dirs and OLD_PATH in host.dirs and host.links[CURRENT] == OLD_PATH
    assert world.core["MainPID"] == "4242" and world.restart_modes == [] and world.det["MainPID"] == "5151"


def test_rollback_after_a_post_switch_pre_restart_failure_restores_current_without_a_restart(tmp_path, monkeypatch):
    host, backend, world, work = build(tmp_path)
    fail_reprove_on_call(monkeypatch, 3, "INJECTED_POST_SWITCH_FAILURE")
    assert refusal(run_apply, host, backend, work) == "INJECTED_POST_SWITCH_FAILURE"
    assert journal(work)["phase"] == "switched" and host.links[CURRENT] == NEW_PATH
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK"] == "PASS" and out["CORE_RESTARTED_FOR_ROLLBACK"] == "NO" and out["DETECTOR_CYCLED_AGAIN_BY_ROLLBACK_RESTART"] == "NO"
    assert host.links[CURRENT] == OLD_PATH and NEW_PATH not in host.dirs and world.restart_modes == []
    assert world.det["MainPID"] == "5151" and world.detector_cycles == 0 and world.det_cwd == OLD_PATH  # pre-restart rollback: D1 untouched
    assert world.det["MainPID"] == "5151" and world.det["ActiveEnterTimestamp"] == "DA0" and world.det_cwd == OLD_PATH and world.detector_cycles == 0  # D1 untouched


def test_a_pre_restart_rollback_escalates_a_detector_that_is_no_longer_exactly_d1(tmp_path, monkeypatch):
    host, backend, world, work = build(tmp_path)
    fail_reprove_on_call(monkeypatch, 3, "INJECTED_POST_SWITCH_FAILURE")
    assert refusal(run_apply, host, backend, work) == "INJECTED_POST_SWITCH_FAILURE"
    world.det.update(MainPID="6666")  # the Core was never restarted, so an unexplained detector change is NOT a dependency consequence
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == "DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_DRIFT:MainPID"
    assert host.links[CURRENT] == OLD_PATH and rb.restarts == 0  # restored first, escalated, never repaired


def test_rollback_after_a_failed_restart_that_never_happened_does_not_restart_again(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.restart_fails = True
    refusal(run_apply, host, backend, work)
    world.restart_fails = False
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK"] == "PASS" and out["CORE_RESTARTED_FOR_ROLLBACK"] == "NO"
    assert world.restart_modes == ["plain"]  # only the failed apply attempt
    assert host.links[CURRENT] == OLD_PATH and NEW_PATH not in host.dirs and world.core["MainPID"] == "4242"
    assert world.det["MainPID"] == "5151" and world.detector_cycles == 0  # the restart never took effect: D1 was never cycled


def test_rollback_after_a_post_restart_failure_cycles_the_detector_again_d1_d2_d3_and_restores_the_old_core_and_removes_only_the_owned_release(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"
    assert journal(work)["phase"] == "restarted" and world.core_cwd == NEW_PATH
    d1, d2 = "5151", world.det["MainPID"]
    assert d2 != d1 and world.det_cwd == NEW_PATH  # the failed apply already cycled the detector (D1 -> D2) as the Core restart's consequence
    foreign = f"{RELEASES}/{'7' * 40}"
    host.release(foreign, "7" * 40, "7" * 40)
    rb_backend = FakeBackend(world, host)
    out = rollback(host, world, work, rb_backend)
    assert out == {"R1DU_ROLLBACK": "PASS", "R1DU_ROLLBACK_CLASS": "SAFE_EQUIVALENT", "R1DU_ROLLBACK_EXACT_PRE_RESTORATION": "NO", "CORE_RUNTIME_EQUIVALENCE": "PROVEN",
                   "CORE_PRE_RELEASE": RUNNING_PATH, "CORE_FINAL_RELEASE": OLD_PATH, "CURRENT_TARGET": OLD_PATH, "NEW_RELEASE_ABSENT": "YES", "CORE_RESTARTED_FOR_ROLLBACK": "YES", "R1DU_CORE_ENV_ARM_REMOVED": "YES",
                   "DETECTOR_HEALTHY_AND_UNCHANGED_IN_CODE_AND_UNIT": "YES", "DETECTOR_CYCLED_AGAIN_BY_ROLLBACK_RESTART": "YES"}
    assert host.links[CURRENT] == OLD_PATH and world.core_cwd == OLD_PATH  # the Core is back on the OLD current release
    assert NEW_PATH not in host.dirs and OLD_PATH in host.dirs and f"{foreign}/RELEASE-MANIFEST.json" in host.files  # a foreign release is never touched
    assert [c for c in rb_backend.calls if c[0] != "show"] == [tool.RESTART_ARGS] and rb_backend.restarts == 1
    d3 = world.det["MainPID"]
    assert len({d1, d2, d3}) == 3 and world.detector_cycles == 2 and world.det_cwd == OLD_PATH  # D1 -> D2 -> D3, each explained by an owned Core restart
    assert host.files[UNIT_PATH] == UNIT_BYTES and world.det["UnitFileState"] == "disabled" and world.det["Restart"] == "no" and host.detector_processes() == [int(d3)]
    assert world.restart_modes == ["plain", "plain"] and not [c for c in rb_backend.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]
    assert journal(work)["phase"] == "rolled_back" and journal(work)["rollback_restart_invoked"] is True


def test_rollback_after_a_restart_that_left_the_core_down_restores_the_core_but_escalates_a_detector_systemd_did_not_bring_back(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.restart_leaves_down = True
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_HEALTHY"
    assert world.det["ActiveState"] == "inactive"  # the dependency start failed with the Core: the detector is down
    code = refusal(rollback, host, world, work)
    # a try-restart job never starts an inactive unit and R1Du never commands the detector, so the detector stays down: UNKNOWN detector state escalates (restored first, then reported)
    assert code == "DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_NOT_RUNNING"
    assert world.core_cwd == OLD_PATH and world.core["ActiveState"] == "active" and host.links[CURRENT] == OLD_PATH and NEW_PATH not in host.dirs
    assert world.det["ActiveState"] == "inactive" and not [c for c in backend.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]


def test_rollback_never_deletes_the_release_the_running_core_executes_from(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    rb = FakeBackend(world, host)
    world.cwd_override = NEW_PATH  # the rolled-back Core would STILL come up on NEW: the restart proof refuses before any deletion
    assert refusal(rollback, host, world, work, rb) == "CORE_NOT_ON_OLD_RELEASE_AFTER_ROLLBACK"
    assert NEW_PATH in host.dirs and host.links[CURRENT] == OLD_PATH


def test_a_foreign_runtime_core_is_never_restarted_or_acted_on_by_rollback(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.cwd_override = RUNNING_PATH
    refusal(run_apply, host, backend, work)
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == "CORE_FOREIGN_RUNTIME_REFUSING_ROLLBACK"
    assert rb.restarts == 0 and NEW_PATH in host.dirs and host.links[CURRENT] == OLD_PATH  # restored first, then escalated; the release is left


def test_rollback_refuses_foreign_current_state_before_changing_anything(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    host.links[CURRENT] = f"{RELEASES}/foreign"
    before = (dict(host.links), set(host.dirs), dict(host.files))
    assert refusal(rollback, host, world, work) == "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT"
    assert (dict(host.links), set(host.dirs), dict(host.files)) == before and world.restart_modes == ["plain"]


def test_rollback_refuses_when_current_was_already_restored_to_something_else_in_pre_switch_phases(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.hooks["install"] = lambda: host.links.__setitem__(CURRENT, NEW_PATH)  # another actor pointed current at OUR release
    refusal(run_apply, host, backend, work)
    assert journal(work)["phase"] == "installing" or journal(work)["phase"] == "installed"
    assert refusal(rollback, host, world, work) == "CURRENT_NOT_OWNED_BY_THIS_ATTEMPT"  # before the switch phases, NEW is not ours to undo


def test_rollback_refuses_a_foreign_or_unproven_release_and_never_deletes_it(tmp_path):
    host, backend, world, work = build(tmp_path, installer_rc=1, installer_reason="RELEASE_ALREADY_INSTALLED")
    # a foreign release wins the race at the target path AFTER preflight; the installer then refuses
    world.hooks["install"] = lambda: (host.dirs.add(NEW_PATH), host.files.__setitem__(f"{NEW_PATH}/RELEASE-MANIFEST.json", b"foreign"))
    assert refusal(run_apply, host, backend, work) == "INSTALL_FAILED:RELEASE_ALREADY_INSTALLED"
    assert journal(work)["phase"] == "installer_failed"
    assert refusal(rollback, host, world, work) == "FOREIGN_OR_UNPROVEN_TARGET"
    assert host.files[f"{NEW_PATH}/RELEASE-MANIFEST.json"] == b"foreign" and NEW_PATH in host.dirs and not [o for o in host.ops if o[0] == "remove"]


def manual_journal(host, backend, work, phase, **extra):
    """The journal apply would have written at ``phase`` (for crash-recovery scenarios that cannot be produced by an in-process failure)."""
    facts = tool.preflight(host, backend, PINS)
    data = {"stage": "R1Du", "phase": phase, "old_release_id": OLD, "new_release_id": NEW, "source_sha": NEW_SRC, "detector_sha": DET_SHA, "core_sha": CORE_SHA, "unit_sha": UNIT_SHA, **facts,
            "restart_invocations": 0, "rollback_restart_invoked": False, "material_content_preserved": False, **extra}
    tool.write_journal(work, data)
    return data


def test_rollback_with_an_unknown_install_outcome_never_deletes_a_valid_looking_release(tmp_path):
    host, backend, world, work = build(tmp_path)
    manual_journal(host, backend, work, "installing")  # the process died inside the installer: the outcome is unknown
    host.copy_release(SOURCE_DIR, NEW_PATH)
    assert refusal(rollback, host, world, work) == "INSTALL_OUTCOME_UNKNOWN"
    assert NEW_PATH in host.dirs and f"{NEW_PATH}/RELEASE-MANIFEST.json" in host.files and not [o for o in host.ops if o[0] == "remove"]
    host.dirs.discard(NEW_PATH)
    for path in [p for p in host.files if p.startswith(NEW_PATH + "/")]:
        del host.files[path]
    out = rollback(host, world, work)  # the installer left nothing behind: nothing to remove, and every postcondition is still proven
    assert out["R1DU_ROLLBACK"] == "PASS" and out["NEW_RELEASE_ABSENT"] == "YES" and out["CORE_RESTARTED_FOR_ROLLBACK"] == "NO" and not [o for o in host.ops if o[0] == "remove"]


def test_rollback_refuses_a_release_that_drifted_since_it_was_installed(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    host.files[f"{NEW_PATH}/aegis_soc/extra.py"] = b"tampered"
    assert refusal(rollback, host, world, work).startswith("RELEASE_DRIFTED_REFUSING_ROLLBACK")
    assert NEW_PATH in host.dirs and f"{NEW_PATH}/aegis_soc/extra.py" in host.files


def test_rollback_refuses_ownership_without_a_journaled_tree_digest(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    j = journal(work)
    del j["release_tree_digest"]
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    assert refusal(rollback, host, world, work) == "JOURNAL_OWNERSHIP_UNPROVEN"
    assert NEW_PATH in host.dirs


def test_rollback_after_a_crash_between_journal_and_switch_removes_only_its_own_temp_link(tmp_path):
    host, backend, world, work = build(tmp_path)
    pre_env, pre_meta = host.files[CORE_ENV], dict(host.meta[CORE_ENV])
    run_apply(host, backend, work)
    host.files[CORE_ENV], host.meta[CORE_ENV] = pre_env, pre_meta  # a crash at "switching" means the arming edit (a LATER step) never happened
    host.links[CURRENT] = OLD_PATH
    host.links[tool.TMP_LINK] = NEW_PATH
    j = journal(work)
    j.update(phase="switching")
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    world.core.update(MainPID="4242", ExecMainStartTimestamp="T0", ExecMainStartTimestampMonotonic="1000")
    world.core_cwd = RUNNING_PATH
    world.det.update(MainPID="5151", ExecMainStartTimestamp="D0", ExecMainStartTimestampMonotonic="1100", ActiveEnterTimestamp="DA0", InvocationID="inv-d1")
    world.det_cwd = OLD_PATH  # the crash happened before the switch took effect: neither the Core nor the detector were ever cycled
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK"] == "PASS" and tool.TMP_LINK not in host.links and host.links[CURRENT] == OLD_PATH and NEW_PATH not in host.dirs


def test_rollback_refuses_a_temp_link_it_does_not_own(tmp_path):
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[tool.TMP_LINK] = "somewhere-else"
    assert refusal(rollback, host, world, work) == "SWITCH_TEMP_NOT_OWNED_BY_THIS_ATTEMPT"


def test_a_second_rollback_is_a_safe_noop_and_never_restarts_again(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    first = FakeBackend(world, host)
    assert rollback(host, world, work, first)["R1DU_ROLLBACK"] == "PASS"
    second = FakeBackend(world, host)
    assert rollback(host, world, work, second) == {"R1DU_ROLLBACK": "ALREADY_ROLLED_BACK"} and second.calls == [] and second.restarts == 0


def test_the_rollback_restart_is_bounded_to_one_per_journal(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    j = journal(work)
    j["rollback_restart_invoked"] = True  # a previous rollback process already restarted the Core and died
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == "ROLLBACK_RESTART_ALREADY_INVOKED" and rb.restarts == 0


@pytest.mark.parametrize("raw,code", [("{not json", "JOURNAL_UNREADABLE"), (json.dumps({"stage": "F1r", "phase": "installed"}), "JOURNAL_UNEXPECTED"),
                                      (json.dumps({"stage": "F1i", "phase": "installed"}), "JOURNAL_UNEXPECTED"), (json.dumps([1]), "JOURNAL_UNEXPECTED")])
def test_a_corrupt_or_foreign_journal_fails_closed(tmp_path, raw, code):
    host, _backend, world, work = build(tmp_path)
    (work / tool.JOURNAL_NAME).write_text(raw)
    assert refusal(rollback, host, world, work) == code and not host.ops


def test_an_unknown_journal_phase_fails_closed(tmp_path):
    host, backend, world, work = build(tmp_path)
    run_apply(host, backend, work)
    j = journal(work)
    j["phase"] = "mystery"
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    ops = list(host.ops)
    assert refusal(rollback, host, world, work) == "JOURNAL_PHASE_UNKNOWN" and host.ops == ops


def after_failed_apply(tmp_path):
    """A failed apply AFTER the Core restart: the Core and the detector run from the NEW release (D2) and the rollback has not started."""
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    assert refusal(run_apply, host, backend, work) == "ALERT_SOCKET_MISSING"
    assert world.restart_modes == ["plain"] and world.core_cwd == NEW_PATH
    return host, world, work


def foreign_detector_cases():
    unit = lambda h, w: h.files.__setitem__(UNIT_PATH, UNIT_BYTES + b"# tampered\n")
    return [
        ("tampered detector unit", unit, "DETECTOR_AUTHORITY_FOREIGN:UNIT_SHA256"),
        ("a new detector drop-in", lambda h, w: w.det.update(DropInPaths="/etc/systemd/system/aegis-idea3-detector.service.d/x.conf"), "DETECTOR_AUTHORITY_FOREIGN:UNIT_PATH_OR_DROPIN"),
        ("the unit moved to another fragment path", lambda h, w: w.det.update(FragmentPath="/usr/lib/systemd/system/aegis-idea3-detector.service"), "DETECTOR_AUTHORITY_FOREIGN:UNIT_PATH_OR_DROPIN"),
        ("wrong Restart=", lambda h, w: w.det.update(Restart="on-failure"), "DETECTOR_AUTHORITY_FOREIGN:UNIT_CONTRACT"),
        ("detector enabled", lambda h, w: w.det.update(UnitFileState="enabled"), "DETECTOR_AUTHORITY_FOREIGN:UNIT_CONTRACT"),
        ("detector unit no longer loaded", lambda h, w: w.det.update(LoadState="not-found"), "DETECTOR_AUTHORITY_FOREIGN:UNIT_NOT_LOADED"),
        ("a duplicate standalone detector", lambda h, w: w.extra_detector_procs.append(4321), "DETECTOR_AUTHORITY_FOREIGN:DETECTOR_PROCESS_SET_UNEXPECTED"),
        ("the active detector runs a wrong source digest", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/production_detector.py", DET_BYTES + b"# x"),
         "DETECTOR_AUTHORITY_FOREIGN:DETECTOR_SOURCE_SHA256_MISMATCH"),
        ("a detector process without an active unit", lambda h, w: (w.det.update(ActiveState="inactive", SubState="dead", MainPID="0"), w.extra_detector_procs.append(4321)),
         "DETECTOR_AUTHORITY_FOREIGN:PROCESS_WITHOUT_ACTIVE_UNIT"),
    ]


@pytest.mark.parametrize("label,mutate,code", foreign_detector_cases(), ids=[c[0] for c in foreign_detector_cases()])
def test_a_foreign_detector_authority_blocks_the_rollback_core_restart_before_it_can_cycle_it(tmp_path, label, mutate, code):
    host, world, work = after_failed_apply(tmp_path)
    mutate(host, world)
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == code, label
    assert rb.restarts == 0 and world.restart_modes == ["plain"]  # ZERO rollback Core restarts: the changed detector unit/source is never triggered
    assert not [c for c in rb.calls if c[0] != "show"] and not [c for c in rb.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]
    assert NEW_PATH in host.dirs and world.core_cwd == NEW_PATH  # the release the Core still runs from is never removed
    assert host.links[CURRENT] == OLD_PATH and journal(work)["phase"] == "restarted" and journal(work)["rollback_restart_invoked"] is False  # escalated; nothing was cycled or marked


def test_an_inactive_detector_is_permitted_for_the_rollback_restart_which_never_starts_it_and_the_post_check_escalates(tmp_path):
    host, world, work = after_failed_apply(tmp_path)
    world.det.update(ActiveState="inactive", SubState="dead", MainPID="0", Result="success")  # the failed APPLY restart did not bring it back
    rb = FakeBackend(world, host)
    # documented behavior: the Core is restored (one restart, no detector command); systemd's try-restart does not start an inactive unit; the detector is then reported, never started by R1Du
    assert refusal(rollback, host, world, work, rb) == "DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_NOT_RUNNING"
    assert rb.restarts == 1 and world.core_cwd == OLD_PATH and host.links[CURRENT] == OLD_PATH and NEW_PATH not in host.dirs
    assert world.det["ActiveState"] == "inactive" and not [c for c in rb.calls if tool.DETECTOR_UNIT in c and c[0] != "show"]


def test_the_rollback_equivalence_is_re_proved_before_the_rollback_restart(tmp_path):
    host, world, work = after_failed_apply(tmp_path)
    host.files[f"{OLD_PATH}/aegis_soc/supervisor.py"] = b"# the rollback target changed since preflight\n"
    j = journal(work)  # defense in depth: even with baselines that (wrongly) match the drifted tree, the equivalence itself still refuses
    j["old_release_tree_digest"] = host.tree_digest(OLD_PATH)
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb).startswith("ROLLBACK_TARGET_NOT_SAFE_EQUIVALENT:CORE_RUNTIME_NOT_EQUIVALENT:FILE_DIFFERS:aegis_soc/supervisor.py")
    assert rb.restarts == 0 and NEW_PATH in host.dirs


def test_a_rollback_whose_detector_does_not_cycle_or_runs_the_wrong_release_is_escalated(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    world.det_cycles = False  # the rollback restart leaves the detector identity untouched: unexplained
    # the stale D2 still points into the (now removed) NEW release: either its missing source or its unchanged identity escalates; it is never accepted
    assert refusal(rollback, host, world, work, FakeBackend(world, host)) in ("DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_SOURCE_SHA256_MISMATCH", "DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_NOT_CYCLED_BY_CORE_RESTART")
    host2, backend2, world2, work2 = build(tmp_path / "wrongrt")
    host2.files[f"{RUNNING_PATH}/aegis_soc/production_detector.py"] = DET_BYTES  # part of the PRE baseline (set before the attempt)
    world2.drop_once.add(ALERT)
    refusal(run_apply, host2, backend2, work2)
    original = world2.restart_core
    world2.restart_core = lambda mode="replace": (original(mode), setattr(world2, "det_cwd", RUNNING_PATH))[0]  # the new detector runs from a release that is NOT the restored OLD one
    assert refusal(rollback, host2, world2, work2, FakeBackend(world2, host2)) == "DETECTOR_DRIFT_DURING_ROLLBACK:DETECTOR_NOT_ON_EXPECTED_RUNTIME"


def test_rollback_reports_material_drift_after_restoring(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    host.meta[CORE_ENV].update(mode=0o644)
    assert refusal(rollback, host, world, work) == "MATERIAL_METADATA_DRIFT" and host.links[CURRENT] == OLD_PATH


def test_the_rolled_back_core_runs_the_old_current_release_not_necessarily_the_pre_r1du_image(tmp_path):
    host, backend, world, work = build(tmp_path)
    assert world.core_cwd == RUNNING_PATH != OLD_PATH  # the PRE process runs an older release than `current`
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    rollback(host, world, work)
    assert world.core_cwd == OLD_PATH  # documented limitation: the old PROCESS image cannot be recreated; the OLD current release is what a restart yields


# ═══ running-Core runtime identity + SAFE_EQUIVALENT rollback proof (review round 2) ═══════════════════════════════════════════


def test_the_pre_running_core_release_is_recorded_explicitly_and_never_inferred_from_current(tmp_path):
    host, backend, _world, work = build(tmp_path)
    run_apply(host, backend, work)
    j = journal(work)
    assert j["core_pre_release"] == RUNNING_PATH != OLD_PATH and j["core"]["cwd"] == RUNNING_PATH and j["old_target"] == OLD_PATH  # three DIFFERENT facts: running, current, detector
    assert j["detector"]["cwd"] == OLD_PATH and j["rollback_class"] == "SAFE_EQUIVALENT"
    assert j["equivalence_differing"] == ["RELEASE-MANIFEST.json", tool.DETECTOR_REL]  # exactly the two entries allowed to differ


def test_a_pre_runtime_that_is_the_old_current_release_needs_no_equivalence_proof(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.core_cwd = OLD_PATH
    run_apply(host, backend, work)
    assert journal(work)["rollback_class"] == "EXACT_RELEASE" and journal(work)["equivalence_differing"] == []


def break_pre(h, rel, data=b"# changed in the PRE running release only\n"):
    h.files[f"{RUNNING_PATH}/{rel}"] = data


EQUIV_CASES = [
    ("a Core entrypoint file differs", lambda h, w: break_pre(h, "aegis_soc/supervisor.py"), "FILE_DIFFERS:aegis_soc/supervisor.py"),
    ("another aegis_soc module differs", lambda h, w: break_pre(h, "aegis_soc/recovery_core.py"), "FILE_DIFFERS:aegis_soc/recovery_core.py"),
    ("requirements differ", lambda h, w: break_pre(h, "requirements.txt"), "FILE_DIFFERS:requirements.txt"),
    ("a venv file differs", lambda h, w: break_pre(h, "venv/bin/python"), "FILE_DIFFERS:venv/bin/python"),
    ("an extra file exists in the PRE release", lambda h, w: break_pre(h, "aegis_soc/extra.py"), "FILE_SET"),
    ("a file is missing from the PRE release", lambda h, w: h.files.pop(f"{RUNNING_PATH}/requirements.txt"), "FILE_SET"),
    ("python version differs", lambda h, w: h.files.__setitem__(f"{RUNNING_PATH}/RELEASE-MANIFEST.json", json.dumps({"release_id": RUNNING, "source_git_sha": RUNNING, "source_tree_dirty": False,
                                                                                                                    "schema_version": 1, "python_version": "3.13"}).encode()), "MANIFEST_"),
    ("the PRE release fails the release guard", lambda h, w: h.guard.__setitem__(RUNNING_PATH, "OWNER_INVALID"), "RELEASE_INVALID:RELEASE_GUARD:OWNER_INVALID"),
    ("the PRE release does not exist", lambda h, w: (h.guard.pop(RUNNING_PATH), h.dirs.discard(RUNNING_PATH)), "RELEASE_INVALID:RELEASE_GUARD:RELEASE_MISSING"),
    ("the Core imports the differing detector module (in both releases)", lambda h, w: [h.files.__setitem__(f"{r}/aegis_soc/supervisor.py", b"import production_detector\n") for r in (RUNNING_PATH, OLD_PATH)],
     "DETECTOR_MODULE_REFERENCED"),
    ("the PRE Core runs outside the releases directory", lambda h, w: setattr(w, "core_cwd", "/srv/elsewhere"), None),
]


@pytest.mark.parametrize("label,mutate,reason", EQUIV_CASES, ids=[c[0] for c in EQUIV_CASES])
def test_no_machine_proof_of_core_equivalence_means_preflight_refuses_before_any_mutation(tmp_path, label, mutate, reason):
    host, backend, world, work = build(tmp_path)
    mutate(host, world)
    code = refusal(run_apply, host, backend, work)
    if reason is None:
        assert code == "CORE_PRESTATE_RELEASE_UNEXPECTED"
    else:
        assert code.startswith("ROLLBACK_TARGET_NOT_SAFE_EQUIVALENT:CORE_RUNTIME_NOT_EQUIVALENT:") and reason in code, (label, code)
    assert_untouched(host, world, work)


def test_the_equivalence_proof_tolerates_exactly_the_manifest_identity_and_the_detector_entrypoint():
    host = FakeHost(World())
    assert tool.core_runtime_equivalence(host, RUNNING_PATH, OLD_PATH) == ["RELEASE-MANIFEST.json", tool.DETECTOR_REL]
    host.files[f"{RUNNING_PATH}/RELEASE-MANIFEST.json"] = json.dumps({"release_id": RUNNING, "source_git_sha": RUNNING, "source_tree_dirty": False, "schema_version": 1}).encode()
    assert tool.core_runtime_equivalence(host, RUNNING_PATH, OLD_PATH)  # identity fields differ, nothing else does


def test_the_rollback_class_is_declared_honestly_per_scenario(tmp_path):
    # Core never restarted (pre-restart failure): the very same process
    host, backend, world, work = build(tmp_path / "a")
    world.restart_fails = True
    refusal(run_apply, host, backend, work)
    world.restart_fails = False
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK_CLASS"] == "EXACT_PROCESS" and out["R1DU_ROLLBACK_EXACT_PRE_RESTORATION"] == "YES" and out["CORE_RUNTIME_EQUIVALENCE"] == "NOT_APPLICABLE"
    assert out["CORE_PRE_RELEASE"] == RUNNING_PATH == out["CORE_FINAL_RELEASE"]
    # restarted onto the very same release the PRE Core ran: exact release, new process
    host, backend, world, work = build(tmp_path / "b")
    world.core_cwd = OLD_PATH
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK_CLASS"] == "EXACT_RELEASE" and out["R1DU_ROLLBACK_EXACT_PRE_RESTORATION"] == "NO" and out["CORE_RUNTIME_EQUIVALENCE"] == "NOT_APPLICABLE"
    # restarted onto a different but machine-proven equivalent release: safe-equivalent, NEVER reported as exact
    host, backend, world, work = build(tmp_path / "c")
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK_CLASS"] == "SAFE_EQUIVALENT" and out["R1DU_ROLLBACK_EXACT_PRE_RESTORATION"] == "NO" and out["CORE_RUNTIME_EQUIVALENCE"] == "PROVEN"
    assert out["CORE_PRE_RELEASE"] == RUNNING_PATH and out["CORE_FINAL_RELEASE"] == OLD_PATH and RUNNING_PATH != OLD_PATH


def test_a_rollback_never_reports_exact_pre_restoration_unless_the_core_process_was_never_replaced(tmp_path):
    for sub_dir, setup in (("a", lambda w: w.drop_once.add(ALERT)), ("b", lambda w: setattr(w, "restart_leaves_down", True))):
        host, backend, world, work = build(tmp_path / sub_dir)
        setup(world)
        refusal(run_apply, host, backend, work)
        try:
            out = rollback(host, world, work)
        except tool.Refusal:
            continue  # escalated: nothing is reported as restored
        assert out["R1DU_ROLLBACK_EXACT_PRE_RESTORATION"] == "NO"


def test_the_class_tokens_are_exactly_the_three_declared_ones():
    text = TOOL_PATH.read_text()
    for token in ("EXACT_PROCESS", "EXACT_RELEASE", "SAFE_EQUIVALENT"):
        assert token in text
    assert "ROLLBACK_TARGET_NOT_SAFE_EQUIVALENT" in text and "EXACT_PRE_RESTORATION" in text


# ═══ execution boundary: the release about to execute is re-proved immediately before the restart (review round 3) ═══════════════


def mutate_on_reprove_call(monkeypatch, number: int, mutate) -> None:
    """Run ``mutate`` right before the Nth ``reprove_prestate`` call of apply (3 = after the switch, immediately before the forward restart check)."""
    original, calls = tool.reprove_prestate, {"n": 0}

    def hooked(h, b, j):
        calls["n"] += 1
        if calls["n"] == number:
            mutate()
        return original(h, b, j)

    monkeypatch.setattr(tool, "reprove_prestate", hooked)


NEW_CHANGES = [
    ("production_detector.py changed", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/production_detector.py", DET_BYTES + b"# changed"), "NEW_RELEASE_CHANGED_BEFORE_RESTART:DETECTOR_SHA256_MISMATCH"),
    ("recovery_core.py changed", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/recovery_core.py", CORE_BYTES + b"# changed"), "NEW_RELEASE_CHANGED_BEFORE_RESTART:RECOVERY_CORE_SHA256_MISMATCH"),
    ("recovery_core.py loses ALERT_ACCEPTED (pin forged to match)", None, None),
    ("another payload file changed", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/aegis_soc/supervisor.py", b"# swapped Core entrypoint\n"), "NEW_RELEASE_CHANGED_BEFORE_RESTART:TREE_DIGEST"),
    ("an extra payload file appears", lambda h, w: h.files.__setitem__(f"{NEW_PATH}/venv/bin/evil", b"x"), "NEW_RELEASE_CHANGED_BEFORE_RESTART:TREE_DIGEST"),
    ("the release no longer passes the guard", lambda h, w: h.guard.__setitem__(NEW_PATH, "OWNER_INVALID"), "NEW_RELEASE_CHANGED_BEFORE_RESTART:RELEASE_GUARD:OWNER_INVALID"),
    ("the release id changed", lambda h, w: h.guard.__setitem__(NEW_PATH, ("other", NEW_SRC)), "NEW_RELEASE_CHANGED_BEFORE_RESTART:RELEASE_ID_MISMATCH"),
    ("current moved away from NEW", lambda h, w: h.links.__setitem__(CURRENT, OLD_PATH), "NEW_RELEASE_NOT_CURRENT_BEFORE_RESTART"),
    ("current points at a foreign release", lambda h, w: h.links.__setitem__(CURRENT, f"{RELEASES}/foreign"), "NEW_RELEASE_NOT_CURRENT_BEFORE_RESTART"),
]


@pytest.mark.parametrize("label,mutate,code", [c for c in NEW_CHANGES if c[1]], ids=[c[0] for c in NEW_CHANGES if c[1]])
def test_a_new_release_altered_after_the_switch_never_executes_zero_core_restarts(tmp_path, monkeypatch, label, mutate, code):
    host, backend, world, work = build(tmp_path)
    mutate_on_reprove_call(monkeypatch, 3, lambda: mutate(host, world))
    assert refusal(run_apply, host, backend, work) == code, label
    assert backend.restarts == 0 and world.restart_modes == [] and "restart" not in world.events  # CORE_RESTART_INVOCATIONS=0: no altered NEW release can execute
    assert journal(work)["phase"] == "switched" and journal(work)["restart_invocations"] == 0 and world.core["MainPID"] == "4242" and world.det["MainPID"] == "5151"


def test_the_forward_reproof_runs_after_the_prestate_proof_and_before_the_restart_is_journaled(tmp_path):
    host, backend, world, work = build(tmp_path)
    seen = {}
    world.hooks["restart"] = lambda: seen.__setitem__("phase", journal(work)["phase"])
    run_apply(host, backend, work)
    assert seen["phase"] == "restarting"
    code = TOOL_PATH.read_text()
    assert code.index("reprove_new_release(host, pins, journal)") < code.index('journal.update(phase="restarting", restart_invocations=1)')


def old_release_changes():
    def detector(h, w):  # a foreign but INTERNALLY CONSISTENT release: the fake sums are derived from the files, the guard still passes
        h.files[f"{OLD_PATH}/aegis_soc/production_detector.py"] = b"# foreign detector that will be STARTED by the rollback restart\n"
    return [
        ("OLD detector changed (valid-looking release)", detector, "ROLLBACK_OLD_RELEASE_AUTHORITY_FAILED:OLD_RELEASE_DETECTOR_SHA256_MISMATCH"),
        ("OLD supervisor changed", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/supervisor.py", b"# swapped\n"), "ROLLBACK_OLD_RELEASE_TREE_CHANGED"),
        ("OLD recovery_core changed", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/recovery_core.py", CORE_BYTES + b"# x"), "ROLLBACK_OLD_RELEASE_TREE_CHANGED"),
        ("OLD venv payload changed", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/venv/bin/python", b"#!evil\n"), "ROLLBACK_OLD_RELEASE_TREE_CHANGED"),
        ("OLD release gained a file", lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/extra.py", b"x"), "ROLLBACK_OLD_RELEASE_TREE_CHANGED"),
        ("OLD release fails the guard (foreign owner)", lambda h, w: h.guard.__setitem__(OLD_PATH, "OWNER_INVALID"), "ROLLBACK_OLD_RELEASE_AUTHORITY_FAILED:CURRENT_RELEASE_INVALID:RELEASE_GUARD:OWNER_INVALID"),
        ("OLD release is malformed (no manifest/guard record)", lambda h, w: h.guard.pop(OLD_PATH), "ROLLBACK_OLD_RELEASE_AUTHORITY_FAILED:CURRENT_RELEASE_INVALID:RELEASE_GUARD:RELEASE_MISSING"),
        ("OLD release reports a different id", lambda h, w: h.guard.__setitem__(OLD_PATH, ("someone-else", OLD)), "ROLLBACK_OLD_RELEASE_AUTHORITY_FAILED:CURRENT_RELEASE_INVALID:RELEASE_ID_MISMATCH"),
        ("PRE running-Core release tree changed", lambda h, w: h.files.__setitem__(f"{RUNNING_PATH}/aegis_soc/supervisor.py", b"# drifted\n"), "ROLLBACK_PRE_RELEASE_TREE_CHANGED"),
        ("PRE running-Core release gained a file", lambda h, w: h.files.__setitem__(f"{RUNNING_PATH}/aegis_soc/extra.py", b"x"), "ROLLBACK_PRE_RELEASE_TREE_CHANGED"),
    ]


@pytest.mark.parametrize("label,mutate,code", old_release_changes(), ids=[c[0] for c in old_release_changes()])
def test_a_changed_or_foreign_rollback_release_never_executes_zero_rollback_core_restarts(tmp_path, label, mutate, code):
    host, world, work = after_failed_apply(tmp_path)
    mutate(host, world)
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == code, label
    assert rb.restarts == 0 and world.restart_modes == ["plain"]  # ROLLBACK_CORE_RESTART_INVOCATIONS=0: the changed OLD release (and its detector) is never started
    assert not [c for c in rb.calls if c[0] != "show"] and NEW_PATH in host.dirs and journal(work)["rollback_restart_invoked"] is False


@pytest.mark.parametrize("label,mutate,code", old_release_changes()[1:8], ids=[c[0] for c in old_release_changes()[1:8]])
def test_exact_release_mode_also_re_proves_the_release_before_the_rollback_restart(tmp_path, label, mutate, code):
    host, backend, world, work = build(tmp_path)
    world.core_cwd = OLD_PATH  # PRE running release == OLD current: EXACT_RELEASE (no equivalence proof is ever run)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    assert journal(work)["rollback_class"] == "EXACT_RELEASE"
    mutate(host, world)
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == code, label
    assert rb.restarts == 0 and NEW_PATH in host.dirs


def test_current_not_exactly_old_blocks_the_rollback_restart(tmp_path):
    host, _world, work = after_failed_apply(tmp_path)
    j = journal(work)
    host.links[CURRENT] = f"{RELEASES}/foreign"
    assert refusal(tool.reprove_rollback_target, host, PINS, j, OLD_PATH) == "ROLLBACK_CURRENT_NOT_OLD_BEFORE_RESTART"
    host.links[CURRENT] = OLD_PATH
    tool.reprove_rollback_target(host, PINS, j, OLD_PATH)  # the untouched world passes


def test_exact_release_means_the_same_release_content_not_just_the_same_path(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.core_cwd = OLD_PATH
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    rb = FakeBackend(world, host)
    after_restart(world, host, lambda h, w: h.files.__setitem__(f"{OLD_PATH}/aegis_soc/extra.py", b"changed after the rollback restart"))  # the release drifts AFTER it was proven
    code = refusal(rollback, host, world, work, rb)
    assert code == "ROLLBACK_OLD_RELEASE_TREE_CHANGED"  # never reported as EXACT_RELEASE
    assert rb.restarts == 1  # the proof before the restart held; the post-restart class refuses instead of declaring a false class


def test_safe_equivalent_never_compares_drifted_reference_trees(tmp_path):
    host, world, work = after_failed_apply(tmp_path)
    after_restart(world, host, lambda h, w: h.files.__setitem__(f"{RUNNING_PATH}/aegis_soc/extra.py", b"drift after the restart"))
    rb = FakeBackend(world, host)
    assert refusal(rollback, host, world, work, rb) == "ROLLBACK_PRE_RELEASE_TREE_CHANGED"


def test_the_preflight_journals_both_release_tree_baselines_with_the_reviewed_digest(tmp_path):
    host, backend, _world, work = build(tmp_path)
    run_apply(host, backend, work)
    j = journal(work)
    assert j["old_release_tree_digest"] == hashlib.sha256(b"x").hexdigest() * 0 or len(j["old_release_tree_digest"]) == 64
    assert j["core_pre_release_tree_digest"] != j["old_release_tree_digest"]  # different releases: different baselines
    host2, backend2, world2, work2 = build(tmp_path / "same")
    world2.core_cwd = OLD_PATH
    run_apply(host2, backend2, work2)
    j2 = journal(work2)
    assert j2["old_release_tree_digest"] == j2["core_pre_release_tree_digest"]  # identical paths: identical digests
    code = TOOL_PATH.read_text()
    assert "host.tree_digest(release_path(pins.old_id)), host.tree_digest(pre_release)" in code


def test_the_reviewed_catalog_digest_helper_is_the_one_used_for_the_baselines():
    code = code_only(TOOL_PATH)
    assert "def tree_digest" not in code and "hashlib" not in code  # no second, weaker digest is invented: F1iHost.tree_digest (the L6c catalog digest) is reused


# ═══ the CLI ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════


CLI_PINS = ["--old-release-id", OLD, "--new-release-id", NEW, "--source-sha", NEW_SRC, "--detector-sha256", DET_SHA, "--recovery-core-sha256", CORE_SHA, "--detector-unit-sha256", UNIT_SHA]


def test_the_cli_refuses_apply_verify_and_rollback_without_the_live_flag_and_root(monkeypatch, capsys, tmp_path):
    host = FakeHost(World())
    monkeypatch.setattr(tool, "R1DuHost", lambda: host)
    monkeypatch.setattr(tool, "R1DuBackend", lambda: FakeBackend(host.world, host))
    monkeypatch.delenv("AEGIS_R1DU_LIVE_AUTHORIZED", raising=False)
    for command in ("apply", "verify"):
        extra = ["--source-dir", SOURCE_DIR] if command == "apply" else []
        assert tool.main([command, "--work-dir", str(tmp_path), *CLI_PINS, *extra]) == 1
        assert f"R1DU_{command.upper()}=FAIL reason=LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    assert tool.main(["rollback", "--work-dir", str(tmp_path)]) == 1 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_R1DU_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["rollback", "--work-dir", str(tmp_path)]) == 1 and "ROOT_REQUIRED" in capsys.readouterr().err
    assert host.world.events == [] and not host.ops


def test_the_cli_check_prints_only_fixed_non_secret_fields(monkeypatch, capsys):
    host = FakeHost(World())
    backend = FakeBackend(host.world, host)
    monkeypatch.setattr(tool, "R1DuHost", lambda: host)
    monkeypatch.setattr(tool, "R1DuBackend", lambda: backend)
    rc = tool.main(["check", *CLI_PINS, "--source-dir", SOURCE_DIR])
    out = capsys.readouterr().out
    assert rc == 0 and "R1DU_CHECK=PASS" in out and "sekrit" not in out and "1234" not in out and "AEGIS_ALERT_SOURCE_UID" not in out
    assert host.world.events == [] and backend.restarts == 0 and not host.ops


# ═══ static claims boundary: the tool cannot do more than R1Du owns ═══════════════════════════════════════════════════════════


def test_the_tool_contains_no_forbidden_systemctl_verb_and_the_word_restart_only_in_the_one_argv():
    tree = ast.parse(code_only(TOOL_PATH))
    constants = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    for verb in ("start", "stop", "try-restart", "reload", "reload-or-restart", "daemon-reload", "enable", "disable", "mask", "unmask", "kill", "isolate", "reset-failed", "--now"):
        assert verb not in constants, verb
    assert constants.count("restart") == 1
    assert not [c for c in constants if "job-mode" in c or "ignore-dependencies" in c or "ignore-requirements" in c]  # OPTION A: nothing bypasses the systemd dependency
    for path in (R1DU_RUNNER, R1DU_LIB, *STAGE.glob("*.sh")):
        assert "ignore-dependencies" not in active_shell(path) and "job-mode" not in active_shell(path), path.name


def test_the_tool_imports_no_recovery_mqtt_serial_network_or_hardware_module():
    tree = ast.parse(TOOL_PATH.read_text())
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert imported <= {"__future__", "argparse", "importlib", "json", "os", "pwd", "re", "stat", "subprocess", "sys", "time", "dataclasses", "pathlib", "grp"}
    code = code_only(TOOL_PATH)
    assert not re.search(r"socket\.(socket|create_connection)|\.connect\(|esptool|serial|paho|mosquitto|recovery_ui|recovery_client|sqlite|nft|ip route|iptables", code)
    assert "AF_UNIX" not in code  # nothing connects to the alert or Recovery socket: no synthetic alert, no audit row


def test_the_tool_and_stage_never_claim_real_detector_acceptance_r1_recovery_lvr_l8_or_l9():
    for path in (TOOL_PATH, R1DU_RUNNER, *STAGE.iterdir()):
        text = path.read_text()
        for claim in ("F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES", "RECOVERY_R2_R8_EXECUTED=YES", "LVR_PROVEN=YES", "L8_ACCEPTANCE=YES", "L9_PROVEN=YES"):
            assert claim not in text, (path.name, claim)
    lib_text = R1DU_LIB.read_text()  # the library names the claims ONLY inside the contradiction REFUSAL
    assert lib_text.count("F1_REAL_DETECTOR_ACCEPTANCE=PROVEN") == 1 and "R1DU_CONTRADICTORY_CLAIM" in lib_text
    assert "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN R1_VERIFIED=VERIFIED RECOVERY_R1_R8_PROVEN=YES" in lib_text
    runner = R1DU_RUNNER.read_text()
    for needed in ("F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO", "RECOVERY_R2_R8_EXECUTED=NO", "LVR_PROVEN=NO", "L8_ACCEPTANCE=NO", "L9_PROVEN=NO",
                   "ALERT_INJECTED=NO", "R1_ATTEMPT_OPENED=NO", "EXPLICIT_DETECTOR_COMMANDS=0", "R1DU_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A",
                   "R1DU_DETECTOR_DEPENDENCY_CYCLE_OWNER_APPROVED=YES", "IGNORE_DEPENDENCIES_USED=NO"):
        assert needed in runner, needed


def test_production_detector_and_the_unit_templates_are_untouched_by_r1du():
    assert hashlib.sha256(DETECTOR_SRC.read_bytes()).hexdigest() == REVIEWED_DETECTOR_SHA
    text = DETECTOR_UNIT_EXAMPLE.read_text()
    assert "Requires=aegis-idea3-core.service" in text and "Restart=no" in text and not re.search(r"^\s*PartOf=|^\s*BindsTo=", text, re.MULTILINE)


# ═══ stage registration, authorization/K3 contract, handlers, allow files ═════════════════════════════════════════════════════


def stages() -> list[str]:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    return line.split('"')[1].split()


def test_r1du_is_registered_exactly_once_after_the_historical_r1a_and_before_r1d_and_r1b():
    order = stages()
    assert order.index("L7") < order.index("L7u") < order.index("L8p") < order.index("F1i") < order.index("F1r") < order.index("F1") < order.index("F1u") < order.index("R1I") < order.index("R1A")
    assert order.index("R1A") < order.index("R1Du") < order.index("R1D") < order.index("R1Dv") < order.index("R1B") < order.index("R1Bv") < order.index("RRu") < order.index("CTu") < order.index("Recovery") < order.index("L8") < order.index("L9")
    assert order[order.index("R1A") + 1:order.index("R1A") + 4] == ["R1Du", "R1D", "R1Dv"]
    assert all(order.count(x) == 1 for x in ("R1I", "R1A", "R1Du", "R1D", "R1Dv", "R1B", "R1Bv", "RRu", "CTu", "Recovery")) and "R1a" not in order and "R1b" not in order
    assert 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I R1A R1Du R1D R1Dv R1B R1Bv RRu CTu CTv ICu Recovery L8 L9"' in P4_LIB.read_text()


def sh(script: str, env: dict | None = None, cwd: Path | None = None):
    return _REAL_RUN(["bash", "-c", script], capture_output=True, text=True, timeout=60, check=False, cwd=cwd,
                     env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": "", **(env or {})})


def test_the_stage_framework_knows_r1du_mutating_gapless_and_extra_field_free():
    out = sh(f'. "{P4_LIB}"; p4_stage_known R1Du && echo known; p4_stage_known R1DU || echo R1DU-unknown; p4_stage_known R1a || echo R1a-unknown; p4_stage_mutates R1Du && echo mutates; '
             f'echo "gaps=$(p4_stage_gaps R1Du)"; echo "extra=[$(p4_stage_auth_extra R1Du)]"; p4_stage_handler_status R1Du')
    assert out.stdout.split() == ["known", "R1DU-unknown", "R1a-unknown", "mutates", "gaps=none", "extra=[]", "REGISTERED"], out.stdout + out.stderr


def _today() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")


def _auth(stage: str, **extra) -> str:
    rows = {"stage": stage, "date": _today(), "authorizer": "music", "scope": "R1Du Core upgrade fixture", "reference": "OD-R1DU-FIXTURE-01", **extra}
    return "AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def _k3(stage: str, **over) -> str:
    rows = {"stage": stage, "date": _today(), "confirmed_by": "music", "confirmation_mode": "IDEA3_OWNER_SELF_ATTESTATION", "idea1_window_overlap": "NONE_KNOWN",
            "reference": "OD-R1DU-FIXTURE-01", **over}
    return "AEGIS_P4_K3_CONFIRMATION_V2\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def gate(tmp_path, stage, auth, k3, mode="live"):
    a, k = tmp_path / "authorization.txt", tmp_path / "k3.txt"
    a.write_text(auth)
    k.write_text(k3)
    return _REAL_RUN(["bash", str(GATE), "--stage", stage, "--mode", mode, "--authorization", str(a), "--k3", str(k)], capture_output=True, text=True, timeout=60,
                     check=False, env={"PATH": os.environ["PATH"], "LC_ALL": "C", "TZ": "Asia/Bangkok"})


def test_the_exact_fresh_same_day_authorization_and_k3_contract_for_r1du(tmp_path):
    ok = gate(tmp_path, "R1Du", _auth("R1Du"), _k3("R1Du"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    lines = ok.stdout.splitlines()
    for expected in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "STAGE_MUTATES_PRODUCTION=YES", "REQUIRED_REPOSITORY_GAPS=none",
                     "LIVE_STAGE_AUTHORIZED=NO", "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert expected in lines, expected


@pytest.mark.parametrize("extra", [{"d6_notice": "pub"}, {"integration_review": "kla"}, {"recovery_authorization": "OD-REC-01"}, {"physical_recovery_attestation": "OD-PHYS-01"}])
def test_r1du_carries_no_extra_authorization_field(tmp_path, extra):
    bad = gate(tmp_path, "R1Du", _auth("R1Du", **extra), _k3("R1Du"))
    assert bad.returncode == 1 and "AUTHORIZATION_MALFORMED" in bad.stdout


@pytest.mark.parametrize("historical", ["F1", "F1i", "F1r", "L8p", "L7u"])
def test_historical_stage_records_are_refused_for_r1du_and_r1du_records_for_them(tmp_path, historical):
    for label, auth, k3 in (("auth", _auth(historical), _k3("R1Du")), ("k3", _auth("R1Du"), _k3(historical))):
        bad = gate(tmp_path / label, "R1Du", auth, k3) if (tmp_path / label).mkdir() is None else None
        assert bad.returncode == 1 and ("AUTHORIZATION_STAGE_MISMATCH" in bad.stdout or "K3_STAGE_MISMATCH" in bad.stdout), (historical, label, bad.stdout)
    (tmp_path / "rev").mkdir()
    rev = gate(tmp_path / "rev", historical, _auth("R1Du"), _k3("R1Du"))
    assert rev.returncode == 1 and "STAGE_MISMATCH" in rev.stdout


@pytest.mark.parametrize("label,auth,k3,reason", [
    ("stale auth", _auth("R1Du", date="2020-01-01"), _k3("R1Du"), "AUTHORIZATION_STALE"),
    ("stale k3", _auth("R1Du"), _k3("R1Du", date="2020-01-01"), "K3_STALE"),
    ("placeholder reference", _auth("R1Du", reference="REPLACE-ME-link"), _k3("R1Du"), "AUTHORIZATION_MALFORMED"),
    ("wrong authorizer", _auth("R1Du", authorizer="someone"), _k3("R1Du"), "AUTHORIZATION_MALFORMED"),
    ("k3 overlap", _auth("R1Du"), _k3("R1Du", idea1_window_overlap="MAYBE"), "K3_OVERLAP_NOT_NONE"),
])
def test_stale_or_malformed_records_are_refused_for_r1du(tmp_path, label, auth, k3, reason):
    bad = gate(tmp_path, "R1Du", auth, k3)
    assert bad.returncode == 1 and reason in bad.stdout, label


def test_the_r1du_handler_set_is_the_contract_files_plus_the_rollback_allow_file_and_handlers_are_executable_and_inert_without_the_flag():
    assert sorted(p.name for p in STAGE.iterdir()) == ["allow-keys-rollback.txt", "allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert os.access(STAGE / name, os.X_OK)
        text = active_shell(STAGE / name)
        assert "AEGIS_R1DU_LIVE_AUTHORIZED" in text and text.count("exec ") == 1
        assert not re.search(r"systemctl|ln\s+-|\bmv\b|\brm\b|chmod|chown|useradd|esptool|/dev/tty|mosquitto|recovery_ui|server_admin", text), name
        refused = _REAL_RUN(["bash", str(STAGE / name)], capture_output=True, text=True, timeout=30, check=False, env={"PATH": os.environ["PATH"]})
        assert refused.returncode == 1 and "required" in refused.stderr


def test_the_allow_files_are_exactly_the_proven_owned_transitions_and_nothing_wider():
    def active(name):
        return [l for l in (STAGE / name).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]

    assert active("allow-listeners.txt") == []
    identity = ["svc.aegis-idea3-core.service.MainPID", "svc.aegis-idea3-core.service.ExecMainStartTimestamp", "svc.aegis-idea3-detector.service.MainPID",
                "svc.aegis-idea3-detector.service.ExecMainStartTimestamp", "host.aegis_idea3.recovery.core.runtime_cwd", "host.aegis_idea3.alert.detector.runtime_cwd"]
    core_env_key = "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta"  # R1Du's ONE owned core.env edit (the arming line): only its size/mtime may differ
    assert active("allow-keys.txt") == [CURRENT_KEY, *identity, core_env_key]
    assert active("allow-keys-rollback.txt") == [*identity, core_env_key]
    for forbidden in ("NRestarts", "UnitFileState", "unit_file", "Restart", "ActiveState", "SubState", "Result", "credentials", "release_catalog", "alert.socket", "alert.runtime_dir", "alert.group", "recovery.socket", "recovery.runtime_dir", "recovery.group", "supplementary_groups", "dropin_paths", "process_groups", "listener", "*"):
        assert not any(forbidden in l for l in active("allow-keys.txt")), forbidden


# ═══ comparator contract: real p4-compare.sh on real captured bundles ══════════════════════════════════════════════════════════


def _bundle_with(src: Path, dst: Path, **records: str) -> Path:
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
    (dst / "SHA256SUMS").write_text(_REAL_RUN(["sha256sum", *files], cwd=dst, capture_output=True, text=True, check=True).stdout)
    return dst


@pytest.fixture(scope="module")
def real_capture(tmp_path_factory):
    sys.path.insert(0, str(ROOT / "tests"))
    import test_pr11_phase4_harness as h

    tmp = tmp_path_factory.mktemp("r1du-compare")
    cap = h.capture(tmp, "before")
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    return cap


CAT_A, CAT_B, CAT_NEW = f"{OLD}:{'a' * 64}", f"{RUNNING}:{'b' * 64}", f"{NEW}:{'d' * 64}"
CORE_PID, CORE_TS = "svc.aegis-idea3-core.service.MainPID", "svc.aegis-idea3-core.service.ExecMainStartTimestamp"


def _cmp(pre: Path, post: Path, *, keys: Path | None = None, release_id: str | None = NEW, stage_label: str = "R1Du", listeners: Path | None = None):
    env = {"PATH": os.environ["PATH"], "HOME": str(pre), "LC_ALL": "C", "DISK_THRESHOLD_PCT": "90", "ALLOW_KEYS_FILE": str(keys or STAGE / "allow-keys.txt"),
           "ALLOW_LISTENERS_FILE": str(listeners or STAGE / "allow-listeners.txt")}
    if release_id:
        allow = pre.parent / f"allow-release-{stage_label}-{release_id}.txt"
        allow.write_text(f"stage {stage_label}\nrelease_id {release_id}\n")
        env["ALLOW_L6C_RELEASE_FILE"] = str(allow)
    return _REAL_RUN(["bash", str(COMPARE), str(pre), str(post)], capture_output=True, text=True, timeout=60, check=False, env=env)


DET = "svc.aegis-idea3-detector.service"
CORE_CWD, DET_CWD = "host.aegis_idea3.recovery.core.runtime_cwd", "host.aegis_idea3.alert.detector.runtime_cwd"
DETECTOR_PRE = {f"{DET}.LoadState": "loaded", f"{DET}.ActiveState": "active", f"{DET}.SubState": "running", f"{DET}.UnitFileState": "disabled", f"{DET}.NRestarts": "0", f"{DET}.Result": "success",
                f"{DET}.MainPID": "5151", f"{DET}.ExecMainStartTimestamp": "D0",
                "host.unit_file./etc/systemd/system/aegis-idea3-detector.service.sha256": "c" * 64, CORE_CWD: RUNNING_PATH, DET_CWD: OLD_PATH}
DETECTOR_POST_IDENTITY = {f"{DET}.MainPID": "7001", f"{DET}.ExecMainStartTimestamp": "D1", CORE_CWD: NEW_PATH, DET_CWD: NEW_PATH}  # the ONLY detector fields that legitimately change (the Requires= dependency cycle)
PRE_SURFACES = {**DETECTOR_PRE, "host.aegis_idea3.alert.socket": "type=socket mode=620 uid=990 gid=981", "host.aegis_idea3.recovery.socket": "type=socket mode=660 uid=990 gid=980",
                "host.aegis_idea3.alert.group.aegis-idea3-alert": "present gid=981 members=", "host.aegis_idea3.file./etc/aegis-idea3/core.env.meta": "mode=600 uid=0 gid=0 size=40 mtime=5"}


def _pair(tmp_path, real_capture, *, post_catalog=f"{CAT_A},{CAT_B},{CAT_NEW}", post_current=NEW_PATH, **post_extra):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: OLD_PATH, CORE_PID: "100", CORE_TS: "T0", **PRE_SURFACES})
    post = _bundle_with(real_capture.evid, tmp_path / "post", **{CATALOG_KEY: post_catalog, CURRENT_KEY: post_current, CORE_PID: "200", CORE_TS: "T1", **PRE_SURFACES, **DETECTOR_POST_IDENTITY, **post_extra})
    return pre, post


def test_the_comparator_accepts_exactly_the_proven_owned_transitions_including_the_detector_identity_cycle(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture)
    assert (pre / "services.tsv").read_text() != (post / "services.tsv").read_text()
    ok = _cmp(pre, post)
    assert ok.returncode == 0 and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "COMPARE_RESULT=PASS" in ok.stdout and "L6C_RELEASE_INSTALLED" in ok.stdout, ok.stdout


@pytest.mark.parametrize("label,kwargs", [
    ("a second release added", {"post_catalog": f"{CAT_A},{CAT_B},{CAT_NEW},{'9' * 40}:{'e' * 64}"}),
    ("a different release added", {"post_catalog": f"{CAT_A},{CAT_B},{'8' * 40}:{'d' * 64}"}),
    ("an existing release mutated", {"post_catalog": f"{OLD}:{'f' * 64},{CAT_B},{CAT_NEW}"}),
    ("an existing release removed", {"post_catalog": f"{CAT_A},{CAT_NEW}"}),
    ("NRestarts drift", {CORE_PID.replace("MainPID", "NRestarts"): "1"}),
    ("detector-visible Core state drift", {"svc.aegis-idea3-core.service.ActiveState": "failed"}),
    ("credentials metadata drift", {"host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta": "mode=600 uid=0 gid=0 size=1 mtime=9"}),
    ("alert socket metadata drift", {"host.aegis_idea3.alert.socket": "type=socket mode=666 uid=1 gid=1"}),
    ("recovery socket removed", {"host.aegis_idea3.recovery.socket": "absent"}),
    ("alert group drift", {"host.aegis_idea3.alert.group.aegis-idea3-alert": "present gid=1 members=x"}),
    ("a drop-in unit file appears", {"host.unit_file./etc/systemd/system/aegis-idea3-core.service.d/99-x.conf.sha256": "a" * 64}),
    ("a tmpfiles drift", {"host.unit_file./etc/tmpfiles.d/aegis-idea3-alert.conf.sha256": "b" * 64}),
    ("an unexpected host path", {"host.path./etc/aegis-idea3": "absent"}),
    ("detector unit bytes drift", {"host.unit_file./etc/systemd/system/aegis-idea3-detector.service.sha256": "d" * 64}),
    ("detector became enabled", {f"{DET}.UnitFileState": "enabled"}),
    ("detector NRestarts moved", {f"{DET}.NRestarts": "1"}),
    ("detector not running after the restart", {f"{DET}.ActiveState": "inactive", f"{DET}.SubState": "dead"}),
    ("detector result failure", {f"{DET}.Result": "exit-code"}),
    ("detector unit disappeared", {f"{DET}.LoadState": "not-found"}),
])
def test_any_other_captured_drift_still_fails_even_with_the_r1du_allowances(tmp_path, real_capture, label, kwargs):
    pre, post = _pair(tmp_path, real_capture, **kwargs)
    bad = _cmp(pre, post)
    assert bad.returncode == 1 and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" not in bad.stdout, (label, bad.stdout)


def test_the_l0_capture_records_the_detector_unit_so_the_comparator_can_prove_the_lifecycle():
    capture = (DEPLOY / "p4-l0-capture.sh").read_text()
    assert "aegis-idea3-detector.service\"\nUNIT_PROPS" in capture and "for unit_file in aegis-idea3-core.service aegis-idea3-mosquitto.service aegis-idea3-detector.service; do" in capture


def test_the_comparator_refuses_the_core_restart_and_the_pointer_move_without_the_r1du_allowances(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture)
    empty = tmp_path / "empty.txt"
    empty.write_text("")
    bare = _cmp(pre, post, keys=empty)
    assert bare.returncode == 1 and CURRENT_KEY in bare.stdout and CORE_PID in bare.stdout and f"{DET}.MainPID" in bare.stdout and f"{DET}.ExecMainStartTimestamp" in bare.stdout
    no_release = _cmp(pre, post, release_id=None)
    assert no_release.returncode == 1 and CATALOG_KEY in no_release.stdout


def test_a_new_listener_is_refused_by_the_empty_listener_allow_list(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture)
    listeners_post = post / "listeners.tsv"
    if listeners_post.exists():
        listeners_post.write_text(listeners_post.read_text() + "tcp\t0.0.0.0:4444\tpython\n")
        (post / "SHA256SUMS").write_text(_REAL_RUN(["sha256sum", *sorted(p.name for p in post.iterdir() if p.is_file() and p.name != "SHA256SUMS")], cwd=post, capture_output=True,
                                                   text=True, check=True).stdout)
        bad = _cmp(pre, post)
        assert bad.returncode == 1


def test_the_rollback_comparison_approves_only_the_core_restart_identity(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: OLD_PATH, CORE_PID: "100", CORE_TS: "T0", **PRE_SURFACES})
    rb_ok = _bundle_with(real_capture.evid, tmp_path / "rb", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: OLD_PATH, CORE_PID: "300", CORE_TS: "T2", **PRE_SURFACES,
                                                                f"{DET}.MainPID": "7002", f"{DET}.ExecMainStartTimestamp": "D2", CORE_CWD: OLD_PATH, DET_CWD: OLD_PATH})
    keys = STAGE / "allow-keys-rollback.txt"
    ok = _cmp(pre, rb_ok, keys=keys, release_id=None)
    assert ok.returncode == 0 and "COMPARE_RESULT=PASS" in ok.stdout, ok.stdout
    for label, extra in (("current still NEW", {CURRENT_KEY: NEW_PATH}), ("release left behind", {CATALOG_KEY: f"{CAT_A},{CAT_B},{CAT_NEW}"}),
                         ("core NRestarts", {CORE_PID.replace("MainPID", "NRestarts"): "1"}), ("detector unit bytes", {"host.unit_file./etc/systemd/system/aegis-idea3-detector.service.sha256": "e" * 64}),
                         ("detector enabled", {f"{DET}.UnitFileState": "enabled"}), ("detector down", {f"{DET}.ActiveState": "inactive"})):
        rb = _bundle_with(real_capture.evid, tmp_path / f"rb-{label.replace(' ', '-')}", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: OLD_PATH, CORE_PID: "300", CORE_TS: "T2", **PRE_SURFACES,
                                                                                              f"{DET}.MainPID": "7002", f"{DET}.ExecMainStartTimestamp": "D2", CORE_CWD: OLD_PATH, DET_CWD: OLD_PATH, **extra})
        bad = _cmp(pre, rb, keys=keys, release_id=None)
        assert bad.returncode == 1, label


def test_the_comparator_still_refuses_unknown_stage_labels_for_the_release_allowance(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture)
    bad = _cmp(pre, post, stage_label="F1x")
    assert bad.returncode != 0 and "malformed ALLOW_L6C_RELEASE_FILE line" in bad.stdout + bad.stderr


def test_the_runner_gates_prove_the_exact_values_from_the_capture_records(tmp_path, real_capture):
    pre, good = _pair(tmp_path, real_capture)
    wrong = _bundle_with(real_capture.evid, tmp_path / "wrong", **{CURRENT_KEY: f"{OPT}/releases/intruder"})
    absent = _bundle_with(real_capture.evid, tmp_path / "absent", **{CURRENT_KEY: "absent"})

    def current(before, after):
        return lib(f'r1du_current_transition_gate "{before}" "{after}" "{OLD_PATH}" "{NEW_PATH}"')

    assert current(pre, good).returncode == 0
    for bad in (wrong, absent, pre):
        r = current(pre, bad)
        assert r.returncode == 1 and "R1DU_CURRENT_TRANSITION_NOT_EXACT" in r.stderr
    assert current(good, good).returncode == 1  # the PRE bundle must itself hold the exact OLD target

    def catalog(before, after, digest="d" * 64):
        return lib(f'r1du_catalog_transition_gate "{before}" "{after}" "{NEW}" "{digest}"')

    assert catalog(pre, good).returncode == 0
    assert "R1DU_CATALOG_TRANSITION_NOT_EXACT" in catalog(pre, good, "e" * 64).stderr  # a different digest than the journaled one
    two = _bundle_with(real_capture.evid, tmp_path / "two", **{CATALOG_KEY: f"{CAT_A},{CAT_B},{CAT_NEW},{'9' * 40}:{'e' * 64}"})
    assert catalog(pre, two).returncode == 1
    removed = _bundle_with(real_capture.evid, tmp_path / "removed", **{CATALOG_KEY: f"{CAT_A},{CAT_NEW}"})
    assert catalog(pre, removed).returncode == 1
    assert catalog(pre, pre).returncode == 1  # no addition at all


def test_the_l0_capture_records_the_running_core_and_detector_release_identity(real_capture):
    rows = dict(line.split("\t", 1) for line in (real_capture.evid / "host.tsv").read_text().splitlines())
    assert CORE_CWD in rows and DET_CWD in rows  # present in every capture (fixture root: no /proc, recorded as none)
    capture = (DEPLOY / "p4-l0-capture.sh").read_text()
    assert 'runtime_cwd_record host.aegis_idea3.recovery.core.runtime_cwd aegis-idea3-core.service' in capture
    assert 'runtime_cwd_record host.aegis_idea3.alert.detector.runtime_cwd aegis-idea3-detector.service' in capture
    assert 'p4_ro readlink -- "/proc/$pid/cwd"' in capture  # through the read-only command guard, never a shell-out


def test_a_pre_to_rb_runtime_change_is_visible_to_the_comparator_and_never_reported_as_exact(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CORE_CWD: RUNNING_PATH, DET_CWD: OLD_PATH, CORE_PID: "100", CORE_TS: "T0"})
    rb = _bundle_with(real_capture.evid, tmp_path / "rb", **{CORE_CWD: OLD_PATH, DET_CWD: OLD_PATH, CORE_PID: "300", CORE_TS: "T2"})
    empty = tmp_path / "empty.txt"
    empty.write_text("")
    hidden = _cmp(pre, rb, keys=empty, release_id=None)  # without the reviewed rollback allowance the runtime change is DRIFT (it is no longer an evidence blind spot)
    assert hidden.returncode == 1 and CORE_CWD in hidden.stdout
    approved = _cmp(pre, rb, keys=STAGE / "allow-keys-rollback.txt", release_id=None)
    assert approved.returncode == 0  # approved by KEY only; the exact values are proven by the runner gate below
    assert lib(f'r1du_runtime_transition_gate "{pre}" "{rb}" SAFE_EQUIVALENT "{OLD_PATH}"').returncode == 0
    for cls in ("EXACT_PROCESS", "EXACT_RELEASE"):
        r = lib(f'r1du_runtime_transition_gate "{pre}" "{rb}" {cls} "{OLD_PATH}"')
        assert r.returncode == 1 and "R1DU_RUNTIME_TRANSITION_NOT_EXACT" in r.stderr  # an exact class cannot hide a changed runtime


def test_the_runtime_transition_gate_demands_real_values_and_the_exact_old_target(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CORE_CWD: RUNNING_PATH})
    same = _bundle_with(real_capture.evid, tmp_path / "same", **{CORE_CWD: RUNNING_PATH})
    wrong = _bundle_with(real_capture.evid, tmp_path / "wrong", **{CORE_CWD: NEW_PATH})
    other = _bundle_with(real_capture.evid, tmp_path / "other", **{CORE_CWD: f"{RELEASES}/{'9' * 40}"})
    for bad in ("none", "UNREADABLE", "UNAVAILABLE", ""):
        b = _bundle_with(real_capture.evid, tmp_path / f"bad{bad or 'empty'}", **{CORE_CWD: bad})
        assert lib(f'r1du_runtime_transition_gate "{pre}" "{b}" EXACT_PROCESS "{OLD_PATH}"').returncode == 1
        assert lib(f'r1du_runtime_transition_gate "{b}" "{same}" EXACT_PROCESS "{OLD_PATH}"').returncode == 1
    assert lib(f'r1du_runtime_transition_gate "{pre}" "{same}" EXACT_PROCESS "{OLD_PATH}"').returncode == 0
    assert lib(f'r1du_runtime_transition_gate "{pre}" "{same}" SAFE_EQUIVALENT "{OLD_PATH}"').returncode == 1  # SAFE_EQUIVALENT requires an actual, proven change to OLD
    assert lib(f'r1du_runtime_transition_gate "{pre}" "{wrong}" SAFE_EQUIVALENT "{OLD_PATH}"').returncode == 1  # still on NEW
    assert lib(f'r1du_runtime_transition_gate "{pre}" "{other}" SAFE_EQUIVALENT "{OLD_PATH}"').returncode == 1  # some other release
    assert "CLASS_INVALID" in lib(f'r1du_runtime_transition_gate "{pre}" "{same}" WHATEVER "{OLD_PATH}"').stderr


def test_the_forward_runtime_gate_proves_both_processes_run_from_the_new_release_not_the_pointer(tmp_path, real_capture):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CORE_CWD: RUNNING_PATH, DET_CWD: OLD_PATH, CURRENT_KEY: OLD_PATH})
    good = _bundle_with(real_capture.evid, tmp_path / "good", **{CORE_CWD: NEW_PATH, DET_CWD: NEW_PATH, CURRENT_KEY: NEW_PATH})
    pointer_only = _bundle_with(real_capture.evid, tmp_path / "pointer", **{CORE_CWD: RUNNING_PATH, DET_CWD: OLD_PATH, CURRENT_KEY: NEW_PATH})
    core_only = _bundle_with(real_capture.evid, tmp_path / "coreonly", **{CORE_CWD: NEW_PATH, DET_CWD: OLD_PATH, CURRENT_KEY: NEW_PATH})
    det_only = _bundle_with(real_capture.evid, tmp_path / "detonly", **{CORE_CWD: RUNNING_PATH, DET_CWD: NEW_PATH, CURRENT_KEY: NEW_PATH})
    unreadable = _bundle_with(real_capture.evid, tmp_path / "unread", **{CORE_CWD: "UNREADABLE", DET_CWD: NEW_PATH})
    assert lib(f'r1du_core_runtime_gate "{pre}" "{good}" "{NEW_PATH}"').returncode == 0
    for bad in (pointer_only, core_only, det_only, unreadable, pre):
        r = lib(f'r1du_core_runtime_gate "{pre}" "{bad}" "{NEW_PATH}"')
        assert r.returncode == 1 and "R1DU_RUNTIME_RELEASE_NOT_PROVEN" in r.stderr
    assert lib(f'r1du_core_runtime_gate "{good}" "{good}" "{NEW_PATH}"').returncode == 1  # the PRE side must itself be a real, non-NEW release


def test_the_rollback_class_gate_accepts_only_consistent_declarations():
    good = {
        "EXACT_PROCESS": "R1DU_ROLLBACK=PASS\nR1DU_ROLLBACK_CLASS=EXACT_PROCESS\nR1DU_ROLLBACK_EXACT_PRE_RESTORATION=YES\nCORE_RUNTIME_EQUIVALENCE=NOT_APPLICABLE",
        "EXACT_RELEASE": "R1DU_ROLLBACK=PASS\nR1DU_ROLLBACK_CLASS=EXACT_RELEASE\nR1DU_ROLLBACK_EXACT_PRE_RESTORATION=NO\nCORE_RUNTIME_EQUIVALENCE=NOT_APPLICABLE",
        "SAFE_EQUIVALENT": "R1DU_ROLLBACK=PASS\nR1DU_ROLLBACK_CLASS=SAFE_EQUIVALENT\nR1DU_ROLLBACK_EXACT_PRE_RESTORATION=NO\nCORE_RUNTIME_EQUIVALENCE=PROVEN",
    }
    for cls, out in good.items():
        r = lib('r1du_rollback_class "$OUT"', OUT=out)
        assert r.returncode == 0 and r.stdout.strip() == cls
    for label, out in (("safe-equivalent claiming exactness", good["SAFE_EQUIVALENT"].replace("RESTORATION=NO", "RESTORATION=YES")),
                       ("safe-equivalent without proof", good["SAFE_EQUIVALENT"].replace("PROVEN", "NOT_APPLICABLE")),
                       ("exact process without exactness", good["EXACT_PROCESS"].replace("RESTORATION=YES", "RESTORATION=NO")),
                       ("exact release claiming exactness", good["EXACT_RELEASE"].replace("RESTORATION=NO", "RESTORATION=YES")),
                       ("unknown class", good["EXACT_PROCESS"].replace("EXACT_PROCESS", "FUZZY")), ("no class", "R1DU_ROLLBACK=PASS")):
        r = lib('r1du_rollback_class "$OUT"', OUT=out)
        assert r.returncode == 1 and "R1DU_ROLLBACK_CLASS_" in r.stderr, label


def test_the_runner_proves_the_running_release_and_the_rollback_class_in_order():
    text = active_shell(R1DU_RUNNER)
    assert text.index("capture POST") < text.index("r1du_core_runtime_gate") < text.index("r1du_current_transition_gate")
    rb = text[text.index("rollback_flow()"):text.index("fail_after_attempt()")]
    assert rb.index("r1du_rollback_class") < rb.index("capture RB") < rb.index("r1du_runtime_transition_gate") < rb.index('compare "$PRE" "$EVID/rb-root"')
    assert "EXACT_PROCESS is the only exact PRE restoration" in rb


# ═══ shell library gates ═════════════════════════════════════════════════════════════════════════════════════════════════════


def lib(snippet: str, **env):
    return sh(f'set -uo pipefail; . "{R1DU_LIB}"; {snippet}', env=env)


def test_the_one_attempt_marker_is_distinct_and_consumed_once(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    assert lib(f'r1du_attempt_unconsumed "{auth}" && r1du_consume_attempt "{auth}" && echo consumed').returncode == 0 and (auth / "R1DU-ATTEMPT-CONSUMED").is_file()
    assert "R1DU_ATTEMPT_ALREADY_CONSUMED" in lib(f'r1du_attempt_unconsumed "{auth}"').stderr
    assert "R1DU_ATTEMPT_ALREADY_CONSUMED" in lib(f'r1du_consume_attempt "{auth}"').stderr
    other = tmp_path / "other"
    other.mkdir()
    for historical in ("F1-ATTEMPT-CONSUMED", "F1I-ATTEMPT-CONSUMED", "F1R-ATTEMPT-CONSUMED", "L7U-ATTEMPT-CONSUMED", "L8P-ATTEMPT-CONSUMED"):
        (other / historical).write_text("x")  # a consumed historical marker neither blocks nor authorizes R1Du
    assert lib(f'r1du_attempt_unconsumed "{other}"').returncode == 0
    assert lib(f'r1du_consume_attempt "{other}"').returncode == 0 and (other / "F1-ATTEMPT-CONSUMED").read_text() != "consumed"
    assert "R1DU_ATTEMPT_AUTH_DIR_INVALID" in lib(f'r1du_consume_attempt "{tmp_path}/missing"').stderr
    link = tmp_path / "link"
    link.symlink_to(auth)
    assert "R1DU_ATTEMPT_AUTH_DIR_INVALID" in lib(f'r1du_attempt_unconsumed "{link}"').stderr


def test_the_marker_is_created_atomically_and_never_overwritten(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "R1DU-ATTEMPT-CONSUMED").write_text("consumed_at=original\n")
    assert lib(f'r1du_consume_attempt "{auth}"').returncode == 1
    assert (auth / "R1DU-ATTEMPT-CONSUMED").read_text() == "consumed_at=original\n"
    assert re.search(r"set -o noclobber", R1DU_LIB.read_text())


LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
F1_RECEIPT = f"{LOGS}/2026-10-04_233030_music_idea3-f1-attempt2-live-closeout.md"
R1_RECEIPT = f"{LOGS}/2026-10-05_005444_music_idea3-r1-real-detector-acceptance.md"
F1_OK = "F1_LIVE_RESULT=PASS\nF1_PRODUCTION_DEPLOYED=YES\nF1_DETECTOR_STARTED=YES\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\n"
R1_OK = "R1_EVIDENCE_VERIFIER_IMPLEMENTED=YES\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\n"


F1U_RECEIPT = f"{LOGS}/2026-10-05_041108_music_idea3-f1u-live-closeout.md"
R1I_RECEIPT = f"{LOGS}/2026-10-05_063546_music_idea3-r1i-live-closeout.md"
R1A_FAIL_RECEIPT = f"{LOGS}/2026-10-05_232827_music_idea3-r1a-live-failure-closeout.md"
F1U_OK = "release `x` was installed and activated.\nF1u proves deployment only.\n"
R1I_OK = "\n".join(f"- `{x}`" for x in ("R1I_LIVE=CLOSED_PASS", "R1I_LIVE_EXECUTED=YES", "R1I_ATTEMPT_CONSUMED=YES", "R1I_RERUN_ALLOWED=NO")) + "\n"
R1A_FAIL_OK = "\n".join(f"- `{x}`" for x in ("R1A_LIVE_EXECUTED=YES", "R1A_ATTEMPT_CONSUMED=YES", "R1A_RERUN_ALLOWED=NO", "R1A_RESULT=FAIL", "R1A_STAGE_VERIFY=NOT_REACHED",
                                          "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R2_R8_EXECUTED=NO")) + "\n"
PREDECESSORS = {F1U_RECEIPT: F1U_OK, R1I_RECEIPT: R1I_OK, R1A_FAIL_RECEIPT: R1A_FAIL_OK}  # the R1Du-specific predecessors every fixture carries unless a test overrides one


def git_repo(tmp_path: Path, receipts: dict[str, str]) -> Path:
    receipts = {**PREDECESSORS, **receipts}
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


def receipt_gate(repo):
    return lib(f'r1du_receipt_gate "{repo}"')


def test_the_receipt_gate_requires_the_f1_closeout_and_the_pr342_foundation_by_content(tmp_path):
    assert receipt_gate(git_repo(tmp_path / "ok", {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK})).returncode == 0
    assert "R1DU_F1_CLOSEOUT_NOT_CLOSED" in receipt_gate(git_repo(tmp_path / "zero_f1", {R1_RECEIPT: R1_OK})).stderr
    assert "R1DU_R1_FOUNDATION_NOT_CLOSED" in receipt_gate(git_repo(tmp_path / "zero_r1", {F1_RECEIPT: F1_OK})).stderr
    assert "R1DU_F1_CLOSEOUT_NOT_CLOSED" in receipt_gate(git_repo(tmp_path / "none", {f"{LOGS}/x.md": "# none\n"})).stderr


def test_the_receipt_gate_refuses_split_duplicate_malformed_and_wrong_file_receipts(tmp_path):
    split = git_repo(tmp_path / "split", {F1_RECEIPT: "F1_LIVE_RESULT=PASS\nF1_PRODUCTION_DEPLOYED=YES\n", f"{LOGS}/b.md": "F1_DETECTOR_STARTED=YES\n", R1_RECEIPT: R1_OK})
    assert "R1DU_F1_CLOSEOUT_FIELDS_SPLIT_ACROSS_RECEIPTS" in receipt_gate(split).stderr
    dup = git_repo(tmp_path / "dup", {F1_RECEIPT: F1_OK, f"{LOGS}/2026-10-04_999999_music_copy.md": F1_OK, R1_RECEIPT: R1_OK})
    assert "R1DU_F1_CLOSEOUT_RESULT_NOT_UNIQUE" in receipt_gate(dup).stderr
    wrong = git_repo(tmp_path / "wrong", {f"{LOGS}/2026-10-04_000000_music_other.md": F1_OK, R1_RECEIPT: R1_OK})
    assert "R1DU_F1_CLOSEOUT_RESULT_NOT_IN_CANONICAL_RECEIPT" in receipt_gate(wrong).stderr
    dup_r1 = git_repo(tmp_path / "dupr1", {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK, f"{LOGS}/2026-10-05_999999_music_r1copy.md": R1_OK})
    assert "R1DU_R1_FOUNDATION_RESULT_NOT_UNIQUE" in receipt_gate(dup_r1).stderr
    wrong_r1 = git_repo(tmp_path / "wrongr1", {F1_RECEIPT: F1_OK, f"{LOGS}/2026-10-05_000001_music_fake.md": R1_OK})
    assert "R1DU_R1_FOUNDATION_RESULT_NOT_IN_CANONICAL_RECEIPT" in receipt_gate(wrong_r1).stderr
    malformed = git_repo(tmp_path / "mal", {F1_RECEIPT: "F1_LIVE_RESULT = PASS extra\nF1_PRODUCTION_DEPLOYED=YES maybe\nF1_DETECTOR_STARTED=YES\n", R1_RECEIPT: R1_OK})
    assert receipt_gate(malformed).returncode == 1
    prose = git_repo(tmp_path / "prose", {F1_RECEIPT: "The runner will print F1_LIVE_RESULT=PASS and F1_PRODUCTION_DEPLOYED=YES one day.\n", R1_RECEIPT: R1_OK})
    assert receipt_gate(prose).returncode == 1  # a prose sentence is not a result


def test_the_pr_number_alone_is_never_trusted_only_receipt_content_is(tmp_path):
    text = "PR #342 merged\nR1_EVIDENCE_VERIFIER_IMPLEMENTED=NO\n"
    assert "R1DU_R1_FOUNDATION_NOT_CLOSED" in receipt_gate(git_repo(tmp_path, {F1_RECEIPT: F1_OK, R1_RECEIPT: text})).stderr
    assert "PR #" not in R1DU_LIB.read_text().replace("PR #342 repository foundation", "").replace("(PR #342)", "").replace("PR #342", "")


@pytest.mark.parametrize("claim", ["F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", "R1_VERIFIED=VERIFIED", "RECOVERY_R1_R8_PROVEN=YES", "F1_PRODUCTION_DEPLOYED=NO", "F1_LIVE_RESULT=FAIL"])
def test_the_receipt_gate_refuses_contradictory_live_claims(tmp_path, claim):
    repo = git_repo(tmp_path, {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK, f"{LOGS}/2026-10-06_000000_music_contradiction.md": f"{claim}\n"})
    r = receipt_gate(repo)
    assert r.returncode == 1 and "R1DU_CONTRADICTORY_CLAIM" in r.stderr


def test_the_receipt_gate_makes_r1du_one_shot_and_a_repository_only_record_does_not_count(tmp_path):
    base = {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK}
    done = git_repo(tmp_path / "done", {**base, f"{LOGS}/2026-10-07_000000_music_r1du.md": "R1DU_LIVE_EXECUTED=YES\nR1DU_PRODUCTION_DEPLOYED=YES\n"})
    assert "R1DU_ALREADY_EXECUTED" in receipt_gate(done).stderr
    repo_only = git_repo(tmp_path / "repo_only", {**base, f"{LOGS}/2026-10-05_100000_music_r1du.md": "R1DU_REPOSITORY_IMPLEMENTED=YES\nR1DU_LIVE_EXECUTED=NO\nR1DU_PRODUCTION_DEPLOYED=NO\n"})
    assert receipt_gate(repo_only).returncode == 0
    rolled = git_repo(tmp_path / "rolled", {**base, f"{LOGS}/2026-10-07_000000_music_r1du.md": "R1DU_LIVE_EXECUTED=YES\nR1DU_PRODUCTION_DEPLOYED=NO\n"})
    assert receipt_gate(rolled).returncode == 0  # a rolled-back attempt is not a deployment (a new attempt is still a fresh owner decision)


def test_the_receipt_gate_reads_the_pinned_commit_not_the_working_tree(tmp_path):
    repo = git_repo(tmp_path, {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK})
    (repo / R1_RECEIPT).write_text("R1_EVIDENCE_VERIFIER_IMPLEMENTED=NO\n")  # uncommitted edit
    assert receipt_gate(repo).returncode == 0


def test_the_receipt_gate_is_independent_of_historical_stage_receipts(tmp_path):
    hist = {f"{LOGS}/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md": "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n",
            f"{LOGS}/h1.md": "F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=YES\nF1I_RELEASE_ID=" + OLD + "\n", f"{LOGS}/h2.md": "F1R_LIVE_EXECUTED=YES\nF1R_CURRENT_SWITCHED=YES\n"}
    assert receipt_gate(git_repo(tmp_path / "a", {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK, **hist})).returncode == 0
    assert receipt_gate(git_repo(tmp_path / "b", hist)).returncode == 1  # historical receipts alone never satisfy R1Du


def source_tree(tmp_path: Path, det: bytes = DET_BYTES, core: bytes = CORE_BYTES) -> Path:
    """A committed fixture repository holding the four runtime files (the pinned commit is HEAD)."""
    app = "IDEA3-AEGIS_Lockdown/aegis_soc"
    return git_repo(tmp_path, {f"{app}/production_detector.py": det.decode(), f"{app}/recovery_core.py": core.decode(), f"{app}/supervisor.py": "# supervisor\n",
                               f"{app}/alert_sink.py": "# alert sink\n", f"{app}/historical_disposition.py": "# R1D authority\n"})


def test_the_runtime_source_gate_ties_both_pins_to_the_reviewed_bytes_of_the_pinned_commit(tmp_path):
    root = source_tree(tmp_path / "ok")
    assert lib(f'r1du_runtime_source_gate "{root}" "{DET_SHA}" "{CORE_SHA}"').returncode == 0
    assert "R1DU_DETECTOR_SOURCE_DIGEST_MISMATCH" in lib(f'r1du_runtime_source_gate "{root}" "{"1" * 64}" "{CORE_SHA}"').stderr
    assert "R1DU_RECOVERY_CORE_SOURCE_DIGEST_MISMATCH" in lib(f'r1du_runtime_source_gate "{root}" "{DET_SHA}" "{"1" * 64}"').stderr
    assert "R1DU_DETECTOR_PIN_INVALID" in lib(f'r1du_runtime_source_gate "{root}" abc "{CORE_SHA}"').stderr
    assert "R1DU_RECOVERY_CORE_PIN_INVALID" in lib(f'r1du_runtime_source_gate "{root}" "{DET_SHA}" abc').stderr
    # the working tree is not trusted: an uncommitted edit does not change the answer
    (root / "IDEA3-AEGIS_Lockdown" / "aegis_soc" / "production_detector.py").write_bytes(b"edited")  # uncommitted
    assert lib(f'r1du_runtime_source_gate "{root}" "{DET_SHA}" "{CORE_SHA}"').returncode == 0


def test_the_runtime_source_gate_refuses_a_core_without_alert_accepted(tmp_path):
    bare = b"# no audit event\n"
    root = source_tree(tmp_path, core=bare)
    r = lib(f'r1du_runtime_source_gate "{root}" "{DET_SHA}" "{hashlib.sha256(bare).hexdigest()}"')
    assert r.returncode == 1 and "R1DU_ALERT_ACCEPTED_IMPLEMENTATION_MISSING" in r.stderr


def test_the_real_repository_runtime_pins_match_the_reviewed_sources():
    core = ROOT / "aegis_soc" / "recovery_core.py"
    assert b"ALERT_ACCEPTED" in core.read_bytes()
    assert hashlib.sha256(DETECTOR_SRC.read_bytes()).hexdigest() == REVIEWED_DETECTOR_SHA


def test_the_release_content_gate_requires_every_listed_runtime_file_to_equal_the_pinned_commit(tmp_path):
    root = source_tree(tmp_path / "r")
    rel = tmp_path / "rel"
    rel.mkdir()
    files = {"aegis_soc/production_detector.py": DET_BYTES, "aegis_soc/recovery_core.py": CORE_BYTES, "aegis_soc/supervisor.py": b"# supervisor\n", "aegis_soc/alert_sink.py": b"# alert sink\n",
             "aegis_soc/historical_disposition.py": b"# R1D authority\n"}
    (rel / "RELEASE-SHA256SUMS").write_text("".join(f"{hashlib.sha256(b).hexdigest()}  {p}\n" for p, b in sorted(files.items())) + f"{'a' * 64}  requirements.txt\n")
    assert lib(f'r1du_release_content_gate "{root}" "{rel}"').returncode == 0
    (rel / "RELEASE-SHA256SUMS").write_text("".join(f"{hashlib.sha256(b if p != 'aegis_soc/recovery_core.py' else b'other').hexdigest()}  {p}\n" for p, b in sorted(files.items())))
    r = lib(f'r1du_release_content_gate "{root}" "{rel}"')
    assert r.returncode == 1 and "R1DU_RELEASE_CONTENT_MISMATCH:aegis_soc/recovery_core.py" in r.stderr
    (rel / "RELEASE-SHA256SUMS").write_text(f"{hashlib.sha256(b'x').hexdigest()}  aegis_soc/not_in_commit.py\n" + "".join(f"{hashlib.sha256(b).hexdigest()}  {p}\n" for p, b in sorted(files.items())))
    assert "R1DU_RELEASE_CONTENT_MISMATCH:aegis_soc/not_in_commit.py" in lib(f'r1du_release_content_gate "{root}" "{rel}"').stderr
    (rel / "RELEASE-SHA256SUMS").write_text(f"{'a' * 64}  requirements.txt\n")
    assert "R1DU_RELEASE_CONTENT_TOO_SMALL" in lib(f'r1du_release_content_gate "{root}" "{rel}"').stderr
    (rel / "RELEASE-SHA256SUMS").unlink()
    assert "R1DU_RELEASE_SUMS_MISSING" in lib(f'r1du_release_content_gate "{root}" "{rel}"').stderr


def stub(tmp_path: Path, rc: int, line: str) -> Path:
    path = tmp_path / "stub-python"
    path.write_text(f'#!/bin/bash\necho "$*" > "{tmp_path}/args.txt"\necho "{line}" >&2\nexit {rc}\n')
    path.chmod(0o755)
    return path


def test_the_r1du_preflight_gate_delegates_to_the_reviewed_tool_and_maps_failure(tmp_path):
    ok = lib(f'r1du_preflight_gate "{stub(tmp_path, 0, "R1DU_CHECK=PASS")}" TOOL "{OLD}" "{NEW}" "{SOURCE_DIR}" "{NEW_SRC}" "{DET_SHA}" "{CORE_SHA}" "{UNIT_SHA}"')
    assert ok.returncode == 0
    args = (tmp_path / "args.txt").read_text().split()
    assert args[0] == "TOOL" and args[1] == "check"
    for flag in ("--old-release-id", "--new-release-id", "--source-dir", "--source-sha", "--detector-sha256", "--recovery-core-sha256", "--detector-unit-sha256"):
        assert flag in args
    bad = lib(f'r1du_preflight_gate "{stub(tmp_path, 1, "R1DU_CHECK=FAIL reason=DETECTOR_NOT_RUNNING")}" TOOL "{OLD}" "{NEW}" "{SOURCE_DIR}" "{NEW_SRC}" "{DET_SHA}" "{CORE_SHA}" "{UNIT_SHA}"')
    assert bad.returncode == 1 and "R1DU_PREFLIGHT_FAILED:DETECTOR_NOT_RUNNING" in bad.stderr
    root_missing = lib(f'r1du_preflight_gate "{stub(tmp_path, 1, "no reason here")}" TOOL "{OLD}" "{NEW}" "{SOURCE_DIR}" "{NEW_SRC}" "{DET_SHA}" "{CORE_SHA}" "{UNIT_SHA}"')
    assert "R1DU_PREFLIGHT_FAILED:ROOT_READ_UNAVAILABLE" in root_missing.stderr


def systemctl_stub(tmp_path: Path) -> str:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text(
        '#!/bin/bash\nunit=""; for a in "$@"; do case "$a" in *.service) unit=$a;; esac; done\n'
        'if [ "$unit" = aegis-idea3-detector.service ]; then\n'
        '  printf "%s\\n" "LoadState=${D_LOAD:-loaded}" "ActiveState=${D_ACTIVE:-active}" "SubState=running" "MainPID=${D_PID:-5151}" "NRestarts=${D_NR:-0}" "UnitFileState=${D_UFS:-disabled}" "Restart=${D_RESTART:-no}"\n'
        'else\n  printf "%s\\n" "ActiveState=${C_ACTIVE:-active}" "SubState=running" "MainPID=${C_PID:-4242}" "NRestarts=${C_NR:-0}"\nfi\n')
    (bindir / "systemctl").chmod(0o755)
    (bindir / "pgrep").write_text('#!/bin/bash\necho "${PGREP_COUNT:-1}"\nexit 0\n')
    (bindir / "pgrep").chmod(0o755)
    return f"{bindir}:{os.environ['PATH']}"


def test_the_detector_gates_accept_only_the_preserved_running_unit(tmp_path):
    path = systemctl_stub(tmp_path)
    assert lib("r1du_detector_running_gate", PATH=path).returncode == 0
    for env in ({"D_ACTIVE": "failed"}, {"D_LOAD": "not-found"}, {"D_PID": "0"}, {"D_NR": "1"}, {"D_UFS": "enabled"}, {"D_RESTART": "on-failure"}, {"PGREP_COUNT": "2"}, {"PGREP_COUNT": "0"}):
        r = lib("r1du_detector_running_gate", PATH=path, **env)
        assert r.returncode == 1 and "R1DU_DETECTOR_" in r.stderr, env
    assert lib("r1du_detector_snapshot_gate 5151/0", PATH=path).returncode == 0
    for env in ({"D_PID": "1"}, {"D_NR": "1"}, {"D_ACTIVE": "failed"}):
        r = lib("r1du_detector_snapshot_gate 5151/0", PATH=path, **env)
        assert r.returncode == 1 and "R1DU_DETECTOR_DRIFT" in r.stderr


def test_the_detector_cycled_gate_requires_a_new_pid_and_the_unchanged_contract_and_one_process(tmp_path):
    path = systemctl_stub(tmp_path)
    assert lib("r1du_detector_cycled_gate 5151/0", PATH=path, D_PID="7001").returncode == 0
    for env in ({"D_PID": "5151"}, {"D_PID": "0"}, {"D_PID": "7001", "D_NR": "1"}, {"D_PID": "7001", "D_ACTIVE": "failed"}, {"D_PID": "7001", "D_UFS": "enabled"}, {"D_PID": "7001", "D_RESTART": "on-failure"},
               {"D_PID": "7001", "D_LOAD": "not-found"}, {"D_PID": "7001", "PGREP_COUNT": "2"}, {"D_PID": "7001", "PGREP_COUNT": "0"}):
        r = lib("r1du_detector_cycled_gate 5151/0", PATH=path, **env)
        assert r.returncode == 1 and "R1DU_DETECTOR_" in r.stderr, env


def test_the_core_restarted_gate_requires_a_new_pid_active_running_and_zero_nrestarts(tmp_path):
    path = systemctl_stub(tmp_path)
    assert lib("r1du_core_restarted_gate 4242/0", PATH=path, C_PID="7001").returncode == 0
    for env in ({"C_PID": "4242"}, {"C_PID": "0"}, {"C_PID": "7001", "C_NR": "1"}, {"C_PID": "7001", "C_ACTIVE": "failed"}, {"C_PID": "x"}):
        r = lib("r1du_core_restarted_gate 4242/0", PATH=path, **env)
        assert r.returncode == 1 and "R1DU_CORE_NOT_RESTARTED_ONCE_CLEANLY" in r.stderr, env


def test_the_rollback_output_gate_accepts_only_the_fixed_success_lines():
    for good in ("R1DU_ROLLBACK=PASS", "R1DU_ROLLBACK=NOTHING_OWNED", "R1DU_ROLLBACK=ALREADY_ROLLED_BACK"):
        assert lib(f'r1du_rollback_output_gate "x\n{good}\ny"').returncode == 0
    for bad in ("R1DU_ROLLBACK=FAIL", "F1I_ROLLBACK=PASS", "R1DU_ROLLBACK=PASS extra", ""):
        assert lib(f'r1du_rollback_output_gate "{bad}"').returncode == 1


# ═══ owner runner template ═══════════════════════════════════════════════════════════════════════════════════════════════════


PINS_EXPECTED = ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "OLD_RELEASE_ID", "NEW_RELEASE_ID", "NEW_RELEASE_SOURCE_SHA", "PRODUCTION_DETECTOR_SHA256", "DETECTOR_UNIT_SHA256",
                 "RECOVERY_CORE_SHA256")


def test_the_committed_r1du_runner_refuses_to_run_unpinned_and_creates_nothing(tmp_path):
    r = _REAL_RUN(["bash", str(R1DU_RUNNER), str(tmp_path)], capture_output=True, text=True, timeout=30, check=False, cwd=tmp_path, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
    assert r.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in r.stdout and list(tmp_path.iterdir()) == []
    assert os.access(R1DU_RUNNER, os.X_OK)


def test_each_single_unpinned_value_blocks_the_runner(tmp_path):
    text = R1DU_RUNNER.read_text()
    real = {"EXPECTED_MAIN": "a" * 40, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "OLD_RELEASE_ID": OLD, "NEW_RELEASE_ID": NEW, "NEW_RELEASE_SOURCE_SHA": NEW_SRC,
            "PRODUCTION_DETECTOR_SHA256": DET_SHA, "DETECTOR_UNIT_SHA256": UNIT_SHA, "RECOVERY_CORE_SHA256": CORE_SHA}
    for blocked in PINS_EXPECTED:
        body = text
        for pin, value in real.items():
            if pin != blocked:
                body = re.sub(rf"^{pin}=PIN_[A-Z0-9_]+$", f"{pin}={value}", body, count=1, flags=re.MULTILINE)
        script = tmp_path / f"runner-{blocked}.sh"
        script.write_text(body)
        r = _REAL_RUN(["bash", str(script), str(tmp_path)], capture_output=True, text=True, timeout=30, check=False, cwd=tmp_path, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
        assert r.returncode == 2 and f"runner is not pinned ({blocked})" in r.stdout, blocked


def test_the_r1du_runner_pins_exactly_the_owner_frozen_values_and_commits_no_real_value():
    text = R1DU_RUNNER.read_text()
    for pin in PINS_EXPECTED:
        assert re.search(rf"^{pin}=PIN_[A-Z0-9_]+$", text, re.MULTILINE), pin
    assert len(re.findall(r"^[A-Z0-9_]+=PIN_[A-Z0-9_]+$", text, re.MULTILINE)) == len(PINS_EXPECTED)
    assert not re.search(r"=[0-9a-f]{40}\n|=[0-9a-f]{64}\n|\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b", re.sub(r"\[0-9a-f\]\{\d+\}", "", text))
    assert "authorization-R1Du.txt" in text and "k3-R1Du.txt" in text and "--stage R1Du" in text and 'grep -qx "stage=R1Du"' in text
    for historical in ("authorization-F1.txt", "authorization-F1r.txt", "authorization-F1i.txt", "F1-ATTEMPT-CONSUMED", "F1R-ATTEMPT-CONSUMED", "F1I-ATTEMPT-CONSUMED"):
        assert historical not in text and historical not in active_shell(R1DU_LIB), historical


def test_the_r1du_runner_orders_gates_then_pre_then_reprove_then_marker_then_apply_verify_post_compare():
    text = active_shell(R1DU_RUNNER)
    order = ["l7u_identity_gate", "p4-stage-gate.sh", "r1du_receipt_gate", "r1du_runtime_source_gate", "r1du_release_content_gate", "r1du_detector_running_gate", "r1du_preflight_gate", "capture PRE",
             "r1du_preflight_gate", "r1du_consume_attempt", "handler apply.sh", "handler verify.sh", "r1du_core_restarted_gate", "capture POST", "r1du_current_transition_gate",
             "r1du_catalog_transition_gate", 'compare "$PRE" "$EVID/post-root"', "l7u_secret_scan", "s10_unchanged", "R1DU_LIVE_EXECUTED=YES"]
    pos = -1
    for token in order:
        nxt = text.find(token, pos + 1)
        assert nxt > pos, token
        pos = nxt
    assert text.count("handler apply.sh") == 1 and text.count("r1du_consume_attempt") == 1 and text.count("handler rollback.sh") == 1
    assert not re.search(r"\b(while|until)\b[^\n]*\bhandler\b|handler[^\n]*\|\|\s*handler (apply|verify)", text)  # never looped or retried
    assert text.index("r1du_consume_attempt") < text.index("handler apply.sh")  # no mutation before the marker


def test_the_r1du_runner_rolls_back_only_after_consume_and_checks_the_detector_and_the_one_restart():
    text = active_shell(R1DU_RUNNER)
    assert "fail_after_attempt()" in text and "ATTEMPTED=1" in text and 'ATTEMPTED" = 1' in text
    rb = text[text.index("rollback_flow()"):text.index("fail_after_attempt()")]
    for needed in ("handler rollback.sh", "r1du_rollback_output_gate", "r1du_detector_running_gate", "capture RB", 'compare "$PRE" "$EVID/rb-root"', "allow-keys-rollback.txt", "NOT retrying", "exit 3"):
        assert needed in rb, needed
    assert "rollback_flow" not in text[:text.index("rollback_flow()")]  # nothing can roll back before the function (and the marker) exists
    assert "r1du_detector_cycled_gate" in text[text.index("handler verify.sh"):text.index("capture POST")]  # after apply the detector must be a NEW cycled process, not D1
    assert "r1du_detector_snapshot_gate" not in rb and "r1du_detector_snapshot_gate" not in text[text.index("r1du_consume_attempt \"$AUTH_DIR\""):]  # D1-equality is only a PRE-consume gate


def test_the_only_place_the_live_flag_is_set_is_the_post_gate_handler_function():
    text = active_shell(R1DU_RUNNER)
    assert text.count("AEGIS_R1DU_LIVE_AUTHORIZED=YES") == 1
    assert text.index("AEGIS_R1DU_LIVE_AUTHORIZED=YES") > text.index("handler()") and "AEGIS_R1DU_LIVE_AUTHORIZED=YES" not in active_shell(R1DU_LIB)


def test_the_runner_and_lib_never_issue_a_service_action_touch_the_detector_or_recovery_or_hardware():
    for path in (R1DU_RUNNER, R1DU_LIB):
        text = active_shell(path)
        assert not re.search(r"systemctl\s+(start|stop|restart|try-restart|reload|daemon-reload|enable|disable|mask|kill|reset-failed|isolate|edit|set-property)", text), path.name
        assert not re.search(r"esptool|/dev/tty|mosquitto_pub|recovery_ui|recovery_client|server_admin|nft |iptables|socat|nc -U|alert_sink send|send_alert", text), path.name
        assert not re.search(r"\b(kill|pkill|killall)\b", text), path.name
    assert not re.search(r"systemctl[^\n]*(restart|start|stop)", active_shell(R1DU_RUNNER))


def test_the_runner_keeps_core_and_detector_out_of_s10_because_both_are_proven_by_their_own_lifecycle_gates():
    text = active_shell(R1DU_RUNNER)
    body = text[text.index("s10_unchanged()"):text.index("rollback_flow()")]
    assert "$CORE_UNIT" not in body and "$DETECTOR_UNIT" not in body  # both legitimately change identity (OPTION A); S10 services must not
    assert "r1du_core_restarted_gate" in text and "r1du_detector_cycled_gate" in text and text.count("r1du_detector_cycled_gate") == 1
    assert "DETECTOR_PRE=$(snap $DETECTOR_UNIT)" in text  # the D1 identity is recorded for the cycled-gate comparison and the PRE-consume snapshot gate


def test_the_runner_never_injects_an_alert_or_opens_an_r1_attempt():
    text = R1DU_RUNNER.read_text()
    assert "R1_ATTEMPT_OPENED=NO" in text and "ALERT_INJECTED=NO" in text and "R1D_EXECUTED=NO" in text and "INCIDENT_MUTATED=NO" in text
    assert not re.search(r"r1_acceptance|open-attempt|inject|attacker_ip|logger\s", active_shell(R1DU_RUNNER))


# ═══ governance: the stage changes only what it declares ═══════════════════════════════════════════════════════════════════════


def test_r1du_registration_is_additive_and_the_neighbouring_stage_handlers_are_unchanged_in_shape():
    for neighbour in ("F1", "F1i", "F1r"):
        names = sorted(p.name for p in (DEPLOY / "stages" / neighbour).iterdir())
        assert names == ["allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"], neighbour
    assert {p.name for p in (DEPLOY / "owner-run").glob("run-f1*-owner.sh")} == {"run-f1-owner.sh", "run-f1i-owner.sh", "run-f1r-owner.sh", "run-f1u-owner.sh"}


@pytest.mark.parametrize("missing", [F1U_RECEIPT, R1I_RECEIPT, R1A_FAIL_RECEIPT])
def test_r1du_requires_the_f1u_r1i_and_immutable_r1a_failure_closeouts(tmp_path, missing):
    repo = git_repo(tmp_path, {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK})  # then a plain git removal in the throw-away repository
    env = {"PATH": os.environ["PATH"], "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(tmp_path)}
    _REAL_RUN(["git", "-C", str(repo), "rm", "-q", missing], env=env, check=True)
    _REAL_RUN(["git", "-C", str(repo), "commit", "-q", "-m", "drop"], env=env, check=True)
    result = receipt_gate(repo)
    assert result.returncode == 1 and ("MISSING" in result.stderr or "NOT_CLOSED" in result.stderr or "NOT_THE_DEPLOYMENT" in result.stderr), result.stderr


def test_an_r1a_pass_or_an_existing_r1d_r1b_or_recovery_claim_blocks_r1du(tmp_path):
    for claim in ("R1A_LIVE=CLOSED_PASS", "R1D_LIVE_EXECUTED=YES", "R1B_LIVE_EXECUTED=YES", "RECOVERY_R2_R8_EXECUTED=YES"):
        repo = git_repo(tmp_path / claim, {F1_RECEIPT: F1_OK, R1_RECEIPT: R1_OK, f"{LOGS}/2026-10-06_000000_music_x.md": f"{claim}\n"})
        assert "R1DU_CONTRADICTORY_CLAIM" in receipt_gate(repo).stderr, claim


# ═══ R1Du arming (the ONE owned core.env edit) and the R1D release contract ═══════════════════════════════════════════════════


def test_apply_arms_the_channel_with_exactly_one_line_before_the_single_restart_and_the_new_core_serves_the_private_socket(tmp_path):
    host, backend, world, work = build(tmp_path)
    before = host.files[CORE_ENV]
    out = run_apply(host, backend, work)
    assert out["R1DU_APPLY"] == "COMPLETE"
    assert host.files[CORE_ENV] == before + ARM  # PRE content plus exactly the owned suffix; nothing else
    assert ("arm", CORE_ENV) in host.ops and world.restart_modes == ["plain"]
    assert host.ident[R1D_SOCK] == {"kind": "socket", "mode": 0o600, "uid": CORE_UID, "gid": CORE_UID} and world.armed_env is True
    j = journal(work)
    assert j["phase"] == "applied" and j["arm_suffix_len"] == len(ARM)


def test_the_arming_edit_is_journaled_before_it_happens_and_precedes_the_restart(tmp_path):
    host, backend, world, work = build(tmp_path)
    seen: list[str] = []
    original = host.core_env_arm

    def spy(line):
        seen.append(journal(work)["phase"])  # the journal already says "arming" when the edit runs
        seen.append("restart-done" if world.restarts_done else "no-restart-yet")
        return original(line)

    host.core_env_arm = spy
    run_apply(host, backend, work)
    assert seen == ["arming", "no-restart-yet"]


@pytest.mark.parametrize("seed", [b"AEGIS_ALERT_SOURCE_UID=991\nAEGIS_R1D_DISPOSITION_ENABLED=NO\n", b"AEGIS_ALERT_SOURCE_UID=991\nAEGIS_R1D_DISPOSITION_ENABLED=YES\n"])
def test_a_core_env_that_already_carries_the_arming_key_is_refused_before_any_mutation(tmp_path, seed):
    host, backend, world, work = build(tmp_path)
    host.files[CORE_ENV] = seed
    host.meta[CORE_ENV]["size"] = len(seed)
    assert refusal(run_apply, host, backend, work) == "R1D_CHANNEL_ALREADY_ARMED"
    assert_untouched(host, world, work)


def test_a_new_release_without_the_r1d_authority_is_refused_before_anything_changes(tmp_path):
    host, backend, world, work = build(tmp_path)
    del host.files[f"{SOURCE_DIR}/aegis_soc/historical_disposition.py"]
    assert refusal(run_apply, host, backend, work) == "R1D_DISPOSITION_AUTHORITY_MISSING"
    assert_untouched(host, world, work)
    host2, backend2, world2, work2 = build(tmp_path / "marker")
    host2.files[f"{SOURCE_DIR}/aegis_soc/historical_disposition.py"] = b"# no event name\n"
    assert refusal(run_apply, host2, backend2, work2) == "R1D_DISPOSITION_AUTHORITY_MISSING"


def test_a_restarted_core_that_does_not_serve_the_private_r1d_socket_or_lacks_the_flag_fails_closed(tmp_path):
    for label, mutate, code in (
        ("socket missing", lambda h, w: h.ident.pop(R1D_SOCK), "R1D_SOCKET_MISSING"),
        ("socket group-reachable", lambda h, w: h.ident[R1D_SOCK].update(mode=0o660), "R1D_SOCKET_METADATA_INVALID"),
        ("socket owned by another uid", lambda h, w: h.ident[R1D_SOCK].update(uid=0), "R1D_SOCKET_METADATA_INVALID"),
        ("socket not held by the Core", lambda h, w: w.listeners.__setitem__(R1D_SOCK, {999}), "R1D_SOCKET_NOT_SERVED_BY_CORE"),
        ("running Core without the flag", lambda h, w: setattr(w, "armed_env", False), "CORE_RUNNING_WITHOUT_R1D_ARMING"),
    ):
        host, backend, world, work = build(tmp_path / label.replace(" ", "_"))
        orig = world.restart_core

        def restart_then_mutate(job_mode="replace", _o=orig, _m=mutate, _h=host, _w=world):
            rc = _o(job_mode)
            _m(_h, _w)
            return rc

        world.restart_core = restart_then_mutate
        assert refusal(run_apply, host, backend, work) == code, label


def test_rollback_removes_exactly_the_owned_suffix_before_any_rollback_restart_and_restores_core_env_bytes(tmp_path):
    host, backend, world, work = build(tmp_path)
    before = host.files[CORE_ENV]
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)  # fails AFTER the restart: core.env carries the suffix
    assert host.files[CORE_ENV] == before + ARM
    out = rollback(host, world, work)
    assert out["R1DU_CORE_ENV_ARM_REMOVED"] == "YES" and host.files[CORE_ENV] == before
    assert [op[0] for op in host.ops].index("unarm") < len(host.ops)
    assert R1D_SOCK not in host.ident


def test_rollback_refuses_a_core_env_whose_tail_is_not_exactly_the_owned_suffix(tmp_path):
    host, backend, world, work = build(tmp_path)
    world.drop_once.add(ALERT)
    refusal(run_apply, host, backend, work)
    host.files[CORE_ENV] = host.files[CORE_ENV][:-1] + b"X"  # someone else edited the tail
    host.meta[CORE_ENV]["size"] = len(host.files[CORE_ENV])
    assert refusal(rollback, host, world, work) == "CORE_ENV_NOT_OWNED_BY_THIS_ATTEMPT"
    assert host.files[CORE_ENV].endswith(b"X")  # left exactly as found


def test_rollback_of_a_crash_before_the_arming_edit_leaves_core_env_untouched(tmp_path):
    host, backend, world, work = build(tmp_path)
    pre = host.files[CORE_ENV]
    run_apply(host, backend, work)
    host.files[CORE_ENV], host.meta[CORE_ENV] = pre, dict(journal(work)["material"][CORE_ENV])
    j = journal(work)
    j.update(phase="arming")  # journaled but the edit never happened
    (work / tool.JOURNAL_NAME).write_text(json.dumps(j))
    world.core.update(MainPID="4242", ExecMainStartTimestamp="T0", ExecMainStartTimestampMonotonic="1000")
    world.core_cwd = RUNNING_PATH
    world.det.update(MainPID="5151", ExecMainStartTimestamp="D0", ExecMainStartTimestampMonotonic="1100", ActiveEnterTimestamp="DA0", InvocationID="inv-d1")
    world.det_cwd = OLD_PATH
    out = rollback(host, world, work)
    assert out["R1DU_ROLLBACK"] == "PASS" and out["R1DU_CORE_ENV_ARM_REMOVED"] == "NO" and host.files[CORE_ENV] == pre


def test_r1du_never_touches_incidents_the_audit_database_or_runs_r1d():
    text = code_only(TOOL_PATH)
    assert not re.search(r"sqlite3|incidents|audit_logs|import historical_disposition|dispose\(|from aegis_soc", text)
    assert "historical-disposition.sock" in text and "connect(" not in text  # the socket is only inspected by metadata/inode; nothing connects to it
