"""Stage F1i (post-L7 governed install of ONE repaired immutable release): repository implementation only, hermetic fixtures only.

F1i exists because the historical L6c verifier is intentionally PRE-L7 (it requires /etc/aegis-idea3/credentials and core.env absent and the Core unit
not-found) and is therefore false by design on the current post-L7 Production host. F1i owns ONLY the creation of /opt/aegis-idea3/releases/<release id>
through the reviewed installer; it treats the L7 material, the Core unit and every other Production surface as PRESERVED pre-existing state and never touches
`current`, a service, the detector, Recovery or an ESP32. Nothing here touches /opt, /etc, systemd, a real release or the Core: the tool runs against a fake
host and a fake systemd/installer world (the REAL allow-lists stay in force). Repository behavior only: no live F1i / L6c / F1r / F1 PASS is claimed.
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
TOOL_PATH = DEPLOY / "p4-f1i-install.py"
F1I_LIB = DEPLOY / "p4-f1i-run-lib.sh"
F1R_LIB = DEPLOY / "p4-f1r-run-lib.sh"
F1I_RUNNER = DEPLOY / "owner-run" / "run-f1i-owner.sh"
F1R_RUNNER = DEPLOY / "owner-run" / "run-f1r-owner.sh"
STAGE = DEPLOY / "stages" / "F1i"
GATE = DEPLOY / "p4-stage-gate.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
COMPARE = DEPLOY / "p4-compare.sh"
_REAL_RUN = subprocess.run

CUR_ID = "55c7d18135142293267e8d1ea943d3639358d634"
RID = "c2238375de14678f2a67c039282d9aeff6d553e5"
SRC_SHA = RID
OPT = "/opt/aegis-idea3"
RELEASES = f"{OPT}/releases"
CURRENT = f"{OPT}/current"
CUR_PATH = f"{RELEASES}/{CUR_ID}"
TARGET = f"{RELEASES}/{RID}"
SOURCE_DIR = f"/home/kittipat/Workspace/idea3-p4-evidence/f1i-owner-source/{RID}"
ETC = "/etc/aegis-idea3"
CREDS = f"{ETC}/credentials"
CORE_ENV = f"{ETC}/core.env"
DET_BYTES = b"# repaired production_detector (fixture bytes)\nEXIT_JOURNAL_SOURCE_UNAVAILABLE = 3\n"
DET_SHA = hashlib.sha256(DET_BYTES).hexdigest()
CATALOG_KEY = "host.aegis_idea3.release_catalog"
CURRENT_KEY = "host.symlink./opt/aegis-idea3/current.target"
SECRETS = {CORE_ENV: b"AEGIS_SECRET_TOKEN=hunter2-never-print\n", f"{CREDS}/k_c2d": b"KEY-MATERIAL-never-print-0001", f"{CREDS}/admin.pin": b"424242"}


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_f1i_install", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


@pytest.fixture(autouse=True)
def _hermetic(monkeypatch):
    def guarded(argv, *args, **kwargs):
        raise AssertionError(f"a real process must never be started by the F1i tool tests: {argv!r}")

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


def manifest(release_id=RID, source=SRC_SHA, dirty=False) -> bytes:
    return json.dumps({"release_id": release_id, "source_git_sha": source, "source_tree_dirty": dirty, "schema_version": 1}).encode()


# ═══ fake world ══════════════════════════════════════════════════════════════════════════════════════════════════════════════


class World:
    def __init__(self, *, core_pid="4242", core_restarts="0", core_load="loaded", detector_load="not-found", detector_active="inactive", detector_pid="0"):
        self.core = {"LoadState": core_load, "ActiveState": "active", "SubState": "running", "MainPID": core_pid, "NRestarts": core_restarts}
        self.detector = {"LoadState": detector_load, "ActiveState": detector_active, "MainPID": detector_pid}
        self.tick = 1000
        self.events: list[str] = []


class FakeHost(tool.F1iHost):
    def __init__(self, world: World, *, current_target=CUR_PATH, source_manifest=None, source_det=DET_BYTES, with_current=True, with_target=False, with_parents=True,
                 material=True, guard_overrides=None, core_cwd=CUR_PATH, detector_procs=(), temps=()):
        self.world = world
        self.links = {CURRENT: current_target} if with_current else {}
        self.dirs = {ETC, CREDS, CUR_PATH, SOURCE_DIR} if material else {CUR_PATH, SOURCE_DIR}
        if with_parents:
            self.dirs |= {OPT, RELEASES}
        self.files: dict[str, bytes] = {f"{CUR_PATH}/RELEASE-MANIFEST.json": manifest(CUR_ID, CUR_ID), f"{SOURCE_DIR}/RELEASE-MANIFEST.json": source_manifest or manifest(),
                                        f"{SOURCE_DIR}/aegis_soc/production_detector.py": source_det}
        self.meta: dict[str, dict] = {}
        for path, data in (SECRETS.items() if material else ()):
            self.files[path] = data
        for path in list(self.files) + list(self.dirs):
            self._stamp(path)
        self.guard = {(CUR_PATH, CUR_PATH, "root"): (CUR_ID, CUR_ID), (TARGET, SOURCE_DIR, "any"): (RID, SRC_SHA)}
        self.guard_overrides = guard_overrides or {}
        self.core_cwd = core_cwd
        self.detector_procs = list(detector_procs)
        self.temps = list(temps)
        self.ops: list[tuple[str, ...]] = []
        if with_target:
            self._materialize_target()

    # -- metadata (a content write bumps mtime+ctime, exactly like a real filesystem) -------------------------------------------------------
    def _stamp(self, path, **over):
        self.world.tick += 1
        kind = "dir" if path in self.dirs else "file"
        info = {"type": kind, "mode": 0o600 if kind == "file" else 0o700, "uid": 0, "gid": 0, "size": len(self.files.get(path, b"")), "mtime_ns": self.world.tick,
                "ctime_ns": self.world.tick, "ino": abs(hash(path)) % 10**6}
        info.update(over)
        self.meta[path] = info

    def write_content(self, path, data):
        self.files[path] = data
        self._stamp(path)

    def chmod(self, path, mode):  # a metadata-only change bumps ctime but not mtime
        self.meta[path]["mode"] = mode
        self.meta[path]["ctime_ns"] = self.world.tick = self.world.tick + 1

    # -- the target the fake installer creates -----------------------------------------------------------------------------------------------
    def _materialize_target(self, det=None):
        self.dirs |= {TARGET, f"{TARGET}/aegis_soc"}
        self.files[f"{TARGET}/RELEASE-MANIFEST.json"] = manifest()
        self.files[f"{TARGET}/aegis_soc/production_detector.py"] = det if det is not None else self.files[f"{SOURCE_DIR}/aegis_soc/production_detector.py"]
        for path in (TARGET, f"{TARGET}/aegis_soc", f"{TARGET}/RELEASE-MANIFEST.json", f"{TARGET}/aegis_soc/production_detector.py"):
            self._stamp(path)
        self.guard[(TARGET, TARGET, "root")] = (RID, SRC_SHA)

    # -- F1iHost surface ----------------------------------------------------------------------------------------------------------------------
    def is_symlink(self, path):
        return path in self.links

    def readlink(self, path):
        return self.links[path]

    def lexists(self, path):
        return path in self.links or path in self.files or path in self.dirs

    def is_regular(self, path):
        return path in self.files

    def is_real_dir(self, path):
        return path in self.dirs and path not in self.links

    def read_bytes(self, path):
        return self.files[path]

    def sha256_file(self, path):
        return hashlib.sha256(self.files[path]).hexdigest()

    def realpath(self, path):
        while path in self.links:
            path = self.links[path]
        return path

    def lstat_info(self, path):
        return dict(self.meta[path]) if (path in self.files or path in self.dirs) else None

    def listdir(self, path):
        prefix = path.rstrip("/") + "/"
        names = {p[len(prefix):].split("/")[0] for p in list(self.files) + list(self.dirs) if p.startswith(prefix)}
        return sorted(names)

    def tree_digest(self, path):
        prefix = path.rstrip("/")
        rows = sorted((p, hashlib.sha256(self.files[p]).hexdigest()) for p in self.files if p == prefix or p.startswith(prefix + "/"))
        return hashlib.sha256(json.dumps(rows).encode()).hexdigest()

    def remove_release_tree(self, path):
        self.ops.append(("remove_tree", path))
        prefix = path.rstrip("/")
        for p in [p for p in list(self.files) if p == prefix or p.startswith(prefix + "/")]:
            del self.files[p]
            self.meta.pop(p, None)
        for p in [p for p in list(self.dirs) if p == prefix or p.startswith(prefix + "/")]:
            self.dirs.discard(p)
            self.meta.pop(p, None)
        self.guard.pop((path, path, "root"), None)

    def temp_residue(self, releases_dir, rid):
        return list(self.temps)

    def detector_processes(self):
        return list(self.detector_procs)

    def proc_cwd(self, pid):
        return self.core_cwd

    def release_guard(self, logical, host_path):
        return self.release_guard_as(logical, host_path, "root")

    def release_guard_as(self, logical, host_path, owner):
        key = (logical, host_path, owner)
        if key in self.guard_overrides:
            raise tool.Refusal(f"RELEASE_GUARD:{self.guard_overrides[key]}")
        if key not in self.guard:
            raise tool.Refusal("RELEASE_GUARD:RELEASE_MISSING")
        return self.guard[key]

    # -- the host operations F1i must NEVER use: `current` is never created, replaced or removed --------------------------------------------
    def symlink(self, target, path):
        raise AssertionError("F1i must never create a symlink")

    def replace(self, src, dst):
        raise AssertionError("F1i must never rename/replace anything (current included)")

    def unlink(self, path):
        raise AssertionError("F1i must never unlink a single path (only remove its own release tree)")


class FakeBackend(tool.F1iBackend):
    def __init__(self, world: World, host: FakeHost, *, installer_rc=0, side_effect=None, install_det=None, installer_reason="SOURCE_GUARD_FAILED", foreign_target=False):
        super().__init__()
        self.world, self.host = world, host
        self.installer_rc, self.side_effect, self.install_det = installer_rc, side_effect, install_det
        self.installer_reason, self.foreign_target = installer_reason, foreign_target
        self.argvs: list[list[str]] = []

    def _run(self, args):
        wanted = [a[2:] for a in args[2:]]
        src = self.world.core if args[1] == tool.CORE_UNIT else self.world.detector
        return tool.CommandResult(0, "".join(f"{k}={src[k]}\n" for k in wanted if k in src))

    def _run_installer(self, argv):
        self.argvs.append(list(argv))
        self.world.events.append("installer")
        if self.installer_rc != 0:
            if self.foreign_target:  # another root actor installed a fully valid release during the race window; the installer then refuses
                self.host._materialize_target()
            return tool.CommandResult(self.installer_rc, f"L7_RELEASE_INSTALL=FAIL reason={self.installer_reason}\n")
        self.host._materialize_target(self.install_det)
        if self.side_effect:
            self.side_effect(self.host, self.world)
        return tool.CommandResult(0, f"L7_RELEASE_INSTALL=PASS release_id={RID} source_git_sha={SRC_SHA}\n")


def build(tmp_path, **kw):
    wk = {k: kw.pop(k) for k in ("core_pid", "core_restarts", "core_load", "detector_load", "detector_active", "detector_pid") if k in kw}
    bk = {k: kw.pop(k) for k in ("installer_rc", "side_effect", "install_det", "installer_reason", "foreign_target") if k in kw}
    world = World(**wk)
    host = FakeHost(world, **kw)
    work = tmp_path / "work"
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    return world, host, FakeBackend(world, host, **bk), work


def args_of(**over):
    return {"current_id": CUR_ID, "release_id": RID, "source_dir": SOURCE_DIR, "source_sha": SRC_SHA, "detector_sha": DET_SHA, **over}


def run_check(host, backend, **over):
    a = args_of(**over)
    return tool.preflight(host, backend, a["current_id"], a["release_id"], a["source_dir"], a["source_sha"], a["detector_sha"])


def run_apply(host, backend, work, **over):
    a = args_of(**over)
    return tool.apply(a["current_id"], a["release_id"], a["source_dir"], a["source_sha"], a["detector_sha"], work, host, backend)


def run_verify(host, backend, work, **over):
    a = args_of(**over)
    return tool.verify(a["current_id"], a["release_id"], a["source_sha"], a["detector_sha"], work, host, backend)


def journal(work):
    return json.loads((work / tool.JOURNAL_NAME).read_text())


def assert_untouched(host, backend, work):
    assert backend.argvs == [] and TARGET not in host.dirs and host.links == {CURRENT: CUR_PATH} and not (work / tool.JOURNAL_NAME).exists()


# ═══ preflight refusals: nothing is installed, no journal, nothing consumed ═══════════════════════════════════════════════════


def test_the_happy_preflight_accepts_the_post_l7_state_with_material_core_unit_and_current_present(tmp_path):
    world, host, backend, work = build(tmp_path)
    facts = run_check(host, backend)
    assert facts["current_target"] == CUR_PATH and facts["core_main_pid"] == "4242" and facts["core_n_restarts"] == "0"
    assert set(facts["material"]) >= {CORE_ENV, CREDS, f"{CREDS}/k_c2d", f"{CREDS}/admin.pin"}  # metadata only
    assert backend.argvs == []  # preflight is read-only


def test_credentials_core_env_and_a_loaded_running_core_unit_are_ACCEPTED_not_refused(tmp_path):
    """The exact L6c defect: it demanded these absent. F1i must treat them as PRESERVED pre-existing state."""
    world, host, backend, work = build(tmp_path, core_load="loaded")
    assert run_apply(host, backend, work)["F1I_APPLY"] == "COMPLETE"
    assert host.files[CORE_ENV] == SECRETS[CORE_ENV] and host.files[f"{CREDS}/k_c2d"] == SECRETS[f"{CREDS}/k_c2d"]  # untouched
    assert world.core["LoadState"] == "loaded" and world.core["ActiveState"] == "active"


def test_the_post_l7_material_must_exist_this_stage_is_not_a_pre_l7_stage(tmp_path):
    world, host, backend, work = build(tmp_path, material=False)
    assert refusal(run_check, host, backend) == "MATERIAL_MISSING"
    assert_untouched(host, backend, work)


def test_a_target_release_that_already_exists_refuses_before_any_install(tmp_path):
    world, host, backend, work = build(tmp_path, with_target=True)
    assert refusal(run_apply, host, backend, work) == "TARGET_RELEASE_ALREADY_EXISTS"
    assert backend.argvs == [] and not (work / tool.JOURNAL_NAME).exists()


def test_install_temp_residue_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, temps=[f".install-tmp-{RID}-abc123"])
    assert refusal(run_check, host, backend) == "INSTALL_TEMP_RESIDUE"


@pytest.mark.parametrize("kw", [{"with_parents": False}])
def test_the_parents_must_already_exist_f1i_never_creates_opt_or_releases(tmp_path, kw):
    world, host, backend, work = build(tmp_path, **kw)
    assert refusal(run_check, host, backend) == "PARENT_DIRECTORY_MISSING"
    assert_untouched(host, backend, work)


def test_a_parent_that_is_a_symlink_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    host.links[RELEASES] = "/elsewhere"
    assert refusal(run_check, host, backend) == "PARENT_DIRECTORY_MISSING"


def test_a_missing_current_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, with_current=False)
    assert refusal(run_apply, host, backend, work) == "CURRENT_MISSING"
    assert backend.argvs == []


def test_current_that_is_not_a_symlink_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, with_current=False)
    host.files[CURRENT] = b"a regular file"
    host._stamp(CURRENT)
    assert refusal(run_check, host, backend) == "CURRENT_NOT_A_SYMLINK"


@pytest.mark.parametrize("target", [f"{RELEASES}/someone-else", f"{CUR_PATH}/", f"{RELEASES}/../releases/{CUR_ID}", f"releases/{CUR_ID}", TARGET])
def test_a_wrong_or_inexact_current_target_refuses_before_any_install(tmp_path, target):
    world, host, backend, work = build(tmp_path, current_target=target)
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_EXPECTED_TARGET"  # exact string equality, never "resolves to"
    assert backend.argvs == []


def test_a_current_release_that_fails_the_release_guard_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, guard_overrides={(CUR_PATH, CUR_PATH, "root"): "NOT_ROOT_OWNED"})
    assert refusal(run_check, host, backend) == "CURRENT_RELEASE_INVALID:RELEASE_GUARD:NOT_ROOT_OWNED"


@pytest.mark.parametrize("core", [{"ActiveState": "inactive"}, {"SubState": "dead"}, {"MainPID": "0"}, {"MainPID": "x"}, {"NRestarts": ""}])
def test_a_core_that_is_not_running_refuses(tmp_path, core):
    world, host, backend, work = build(tmp_path)
    world.core.update(core)
    assert refusal(run_apply, host, backend, work) == "CORE_NOT_RUNNING"
    assert backend.argvs == []


@pytest.mark.parametrize("present", [{"detector_load": "loaded"}, {"detector_active": "active"}, {"detector_pid": "9"}])
def test_a_detector_unit_or_process_present_refuses(tmp_path, present):
    world, host, backend, work = build(tmp_path, **present)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"
    assert backend.argvs == []


def test_a_standalone_detector_process_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, detector_procs=[4321])
    assert refusal(run_apply, host, backend, work) == "DETECTOR_STANDALONE_PROCESS_PRESENT"


def test_a_source_that_fails_the_existing_release_guard_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, guard_overrides={(TARGET, SOURCE_DIR, "any"): "SHA256SUMS_MISMATCH"})
    assert refusal(run_apply, host, backend, work) == "SOURCE_RELEASE_INVALID:RELEASE_GUARD:SHA256SUMS_MISMATCH"
    assert backend.argvs == []


def test_a_wrong_release_source_sha_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, source_sha="1" * 40) == "RELEASE_SOURCE_SHA_MISMATCH"
    assert backend.argvs == []
    world, host, backend, work = build(tmp_path / "m", source_manifest=manifest(source="1" * 40))
    assert refusal(run_apply, host, backend, work) == "RELEASE_SOURCE_SHA_MISMATCH"


def test_a_dirty_source_manifest_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, source_manifest=manifest(dirty=True))
    assert refusal(run_apply, host, backend, work) == "RELEASE_SOURCE_TREE_DIRTY"


def test_a_wrong_release_id_in_the_source_manifest_refuses(tmp_path):
    world, host, backend, work = build(tmp_path, source_manifest=manifest(release_id=CUR_ID))
    assert refusal(run_apply, host, backend, work) == "RELEASE_ID_MISMATCH"


def test_a_wrong_detector_digest_refuses_before_any_install(tmp_path):
    world, host, backend, work = build(tmp_path, source_det=DET_BYTES + b"# old detector\n")
    assert refusal(run_apply, host, backend, work) == "DETECTOR_SHA256_MISMATCH"
    assert backend.argvs == []
    world, host, backend, work = build(tmp_path / "pin")
    assert refusal(run_apply, host, backend, work, detector_sha="1" * 64) == "DETECTOR_SHA256_MISMATCH"


@pytest.mark.parametrize("over,reason", [({"release_id": "../x"}, "RELEASE_ID_INVALID"), ({"current_id": "a b"}, "RELEASE_ID_INVALID"), ({"release_id": CUR_ID}, "RELEASE_IDS_NOT_DISTINCT"),
                                         ({"source_sha": "abc"}, "RELEASE_SOURCE_SHA_PIN_INVALID"), ({"detector_sha": DET_SHA.upper()}, "DETECTOR_SHA256_PIN_INVALID"),
                                         ({"source_dir": "relative/dir"}, "SOURCE_DIR_INVALID")])
def test_malformed_pins_refuse_before_anything(tmp_path, over, reason):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_apply, host, backend, work, **over) == reason
    assert backend.argvs == []


def test_a_denied_host_read_is_a_fixed_refusal(tmp_path):
    world, host, backend, work = build(tmp_path)
    host.is_symlink = lambda path: (_ for _ in ()).throw(tool.Refusal("HOST_READ_DENIED"))
    assert refusal(run_check, host, backend) == "HOST_READ_DENIED"


# ═══ apply: exactly one installer call, only the new release changes ═══════════════════════════════════════════════════════════


def test_apply_calls_the_reviewed_installer_exactly_once_with_the_fixed_argv(tmp_path):
    world, host, backend, work = build(tmp_path)
    out = run_apply(host, backend, work)
    assert out["F1I_APPLY"] == "COMPLETE" and out["RELEASE_ID"] == RID and out["F1I_CURRENT_TOUCHED"] == "NO" and out["F1I_CORE_RESTARTED"] == "NO"
    assert len(backend.argvs) == 1
    argv = backend.argvs[0]
    assert Path(argv[1]).name == "p4-l7-install-release.py" and argv[2:] == ["install", "--release-id", RID, "--source", SOURCE_DIR, "--logical-path", TARGET,
                                                                           "--evidence", str(work / "install-evidence.tsv")]


def test_a_second_installer_invocation_in_one_process_is_refused_and_a_second_apply_too(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert refusal(backend.run_installer, RID, SOURCE_DIR, TARGET, str(work / "e.tsv")) == "INSTALLER_ALREADY_INVOKED"
    assert refusal(run_apply, host, FakeBackend(world, host), work) == "ATTEMPT_JOURNAL_ALREADY_EXISTS"


def test_apply_creates_only_the_new_release_and_never_touches_current_or_anything_else(tmp_path):
    world, host, backend, work = build(tmp_path)
    before_files = {p: d for p, d in host.files.items()}
    before_links, before_dirs = dict(host.links), set(host.dirs)
    run_apply(host, backend, work)
    assert host.links == before_links and host.links == {CURRENT: CUR_PATH}  # `current` is byte-for-byte the same pointer
    assert set(host.dirs) - before_dirs == {TARGET, f"{TARGET}/aegis_soc"}
    assert {p for p in host.files if p not in before_files} == {f"{TARGET}/RELEASE-MANIFEST.json", f"{TARGET}/aegis_soc/production_detector.py"}
    assert all(host.files[p] == before_files[p] for p in before_files)  # old release, source, credentials, core.env untouched
    assert host.ops == []  # no removal either


def test_the_journal_records_the_exact_prestate_before_the_installer_runs(tmp_path):
    world, host, backend, work = build(tmp_path)
    seen = []
    real = tool.write_journal

    def spy(path, data):
        seen.append((data["phase"], len(backend.argvs), data.get("current_target"), data.get("core_main_pid")))
        return real(path, data)

    tool.write_journal = spy
    try:
        run_apply(host, backend, work)
    finally:
        tool.write_journal = real
    assert seen[0] == ("preflight", 0, CUR_PATH, "4242") and seen[1] == ("installing", 0, CUR_PATH, "4242")  # both journalled BEFORE the installer
    assert [s[0] for s in seen][-2:] == ["installed", "applied"]


def test_the_target_is_re_proved_absent_immediately_before_the_installer_call(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.check_target_absent
    calls = []

    def racing(h, rid):
        calls.append(1)
        if len(calls) == 2:  # between preflight and the installer another actor creates the target
            h._materialize_target()
        return real(h, rid)

    tool.check_target_absent = racing
    try:
        assert refusal(run_apply, host, backend, work) == "TARGET_RELEASE_ALREADY_EXISTS"
    finally:
        tool.check_target_absent = real
    assert backend.argvs == [] and len(calls) == 2


def test_current_is_re_proved_immediately_before_the_installer_call(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.check_current_expected
    calls = []

    def racing(h, cid):
        calls.append(1)
        if len(calls) == 2:
            h.links[CURRENT] = f"{RELEASES}/intruder"
        return real(h, cid)

    tool.check_current_expected = racing
    try:
        assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_EXPECTED_TARGET"
    finally:
        tool.check_current_expected = real
    assert backend.argvs == []


def test_the_core_snapshot_is_re_proved_immediately_before_the_installer_call(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.core_snapshot
    calls = []

    def racing(h, b):
        calls.append(1)
        if len(calls) == 2:
            world.core["MainPID"] = "7777"
        return real(h, b)

    tool.core_snapshot = racing
    try:
        assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    finally:
        tool.core_snapshot = real
    assert backend.argvs == []


def test_an_installer_failure_is_a_fixed_refusal_and_never_retried(tmp_path):
    world, host, backend, work = build(tmp_path, installer_rc=1)
    assert refusal(run_apply, host, backend, work) == "INSTALL_FAILED:SOURCE_GUARD_FAILED"
    assert len(backend.argvs) == 1
    j = journal(work)
    assert j["phase"] == "installer_failed" and j["installer_rc"] == 1 and j["installer_reason"] == "SOURCE_GUARD_FAILED" and "release_tree_digest" not in j  # persisted BEFORE raising


def test_an_installed_release_whose_detector_differs_from_the_pin_is_refused_after_the_install(tmp_path):
    world, host, backend, work = build(tmp_path, install_det=DET_BYTES + b"# swapped\n")
    assert refusal(run_apply, host, backend, work) == "DETECTOR_SHA256_MISMATCH"
    assert journal(work)["phase"] == "installing" and "release_tree_digest" not in journal(work) and TARGET in host.dirs  # NOT owned for deletion: no digest was journaled


def test_apply_issues_only_read_only_systemctl_show_and_one_installer_call(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    run_verify(host, backend, work)
    assert backend.calls and all(call[0] == "show" for call in backend.calls)
    assert not [c for c in backend.calls if c[0] in ("restart", "start", "stop", "reload", "daemon-reload", "enable", "disable", "kill")]


@pytest.mark.parametrize("verb", [("restart", tool.CORE_UNIT), ("start", tool.CORE_UNIT), ("stop", tool.CORE_UNIT), ("start", tool.DETECTOR_UNIT), ("daemon-reload",),
                                  ("enable", tool.DETECTOR_UNIT), ("kill", tool.CORE_UNIT), ("show", "ssh.service"), ("show", tool.CORE_UNIT, "Environment")])
def test_the_privileged_backend_cannot_restart_start_or_stop_anything(verb):
    assert refusal(tool.F1iBackend().systemctl, *verb) == "SYSTEMCTL_VERB_NOT_ALLOWED"


def test_the_backend_runs_only_the_fixed_installer_argv_never_an_arbitrary_command():
    code = code_only(TOOL_PATH)
    assert code.count("subprocess.run(") == 1  # the installer; the only other process (systemctl show) lives in the reused F1r backend
    assert "p4-l7-install-release.py" in code and "'install'" in code
    for forbidden in ("shell=True", "os.system", "os.popen", "Popen", "chmod", "chown", "os.symlink", "os.rename", "shutil.rmtree", "daemon-reload"):
        assert forbidden not in code, forbidden
    assert code.count("os.replace(") == 1 and "os.replace(tmp, work / JOURNAL_NAME)" in code  # only the private journal write; `current` is never replaced


def test_apply_cannot_touch_current_or_start_the_detector_the_fake_host_forbids_it(tmp_path):
    """FakeHost.symlink/replace/unlink raise AssertionError: a full apply + verify + rollback must never reach them."""
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    run_verify(host, backend, work)
    tool.rollback(work, host, FakeBackend(world, host))
    assert host.links == {CURRENT: CUR_PATH}


# ═══ post-L7 preservation (verify) ═══════════════════════════════════════════════════════════════════════════════════════════


def test_verify_proves_the_new_release_current_core_material_and_detector_absence(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    out = run_verify(host, backend, work)
    assert out == {"F1I_VERIFY": "PASS", "RELEASE_ID": RID, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": SRC_SHA, "PRODUCTION_DETECTOR_SHA256": DET_SHA,
                   "RELEASE_TREE_UNCHANGED": "YES", "CURRENT_TARGET": CUR_PATH, "CURRENT_UNCHANGED": "YES", "CORE_MAIN_PID_UNCHANGED": "YES",
                   "CORE_N_RESTARTS_UNCHANGED": "YES", "L7_MATERIAL_PRESERVED": "YES", "DETECTOR_PRESENT": "NO"}


def test_verify_without_an_applied_journal_refuses(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert refusal(run_verify, host, backend, work) == "ATTEMPT_NOT_APPLIED"


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


def test_a_core_that_stopped_fails_verify_but_a_loaded_unit_is_never_required_absent(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["ActiveState"] = "inactive"
    assert refusal(run_verify, host, backend, work) == "CORE_NOT_RUNNING"


def test_current_drift_after_install_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[CURRENT] = TARGET
    assert refusal(run_verify, host, backend, work) == "CURRENT_CHANGED"


def secret_values():
    return [v.decode() for v in SECRETS.values()]


def assert_no_secret_leak(*texts):
    blob = "\n".join(str(t) for t in texts)
    for value in secret_values():
        assert value not in blob
    assert "hunter2" not in blob and "KEY-MATERIAL" not in blob and "424242" not in blob


@pytest.mark.parametrize("path", [CORE_ENV, f"{CREDS}/k_c2d", f"{CREDS}/admin.pin"])
def test_material_content_drift_after_apply_fails_verify_without_leaking_values(tmp_path, path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.write_content(path, b"CHANGED-SECRET-VALUE-never-print")  # a real write bumps mtime/ctime
    reason = refusal(run_verify, host, backend, work)
    assert reason == "MATERIAL_METADATA_DRIFT" and path not in reason
    assert_no_secret_leak(reason, (work / tool.JOURNAL_NAME).read_text())
    assert "CHANGED-SECRET" not in reason


@pytest.mark.parametrize("path", [CORE_ENV, f"{CREDS}/k_c2d"])
def test_material_metadata_drift_fails_verify(tmp_path, path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.chmod(path, 0o644)
    assert refusal(run_verify, host, backend, work) == "MATERIAL_METADATA_DRIFT"


def test_a_credential_file_added_or_removed_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.write_content(f"{CREDS}/new.key", b"x")
    assert refusal(run_verify, host, backend, work) == "MATERIAL_METADATA_DRIFT"
    world, host, backend, work = build(tmp_path / "r")
    run_apply(host, backend, work)
    del host.files[f"{CREDS}/admin.pin"]
    host.meta.pop(f"{CREDS}/admin.pin")
    assert refusal(run_verify, host, backend, work) == "MATERIAL_METADATA_DRIFT"


@pytest.mark.parametrize("path", [CORE_ENV, f"{CREDS}/k_c2d"])
def test_material_content_changed_by_the_install_step_itself_is_caught_in_apply_in_memory(tmp_path, path):
    """A content change that left the metadata untouched (impossible in practice, forced here) is still caught in the SAME apply process."""
    def tamper(host, world):
        host.files[path] = b"CHANGED-SECRET-VALUE-never-print"  # no _stamp: metadata identical

    world, host, backend, work = build(tmp_path, side_effect=tamper)
    reason = refusal(run_apply, host, backend, work)
    assert reason == "MATERIAL_CONTENT_DRIFT" and "CHANGED-SECRET" not in reason
    assert journal(work)["material_content_preserved"] is False


def test_no_secret_value_digest_or_content_is_ever_persisted_or_printed(tmp_path):
    world, host, backend, work = build(tmp_path)
    out = run_apply(host, backend, work)
    text = (work / tool.JOURNAL_NAME).read_text()
    data = json.loads(text)
    assert_no_secret_leak(text, json.dumps(out))
    for value in SECRETS.values():
        assert hashlib.sha256(value).hexdigest() not in text  # no digest of any secret either
    assert data["material_content_preserved"] is True and not [k for k in data if "digest" in k and k != "release_tree_digest"]
    assert sorted(p.name for p in work.iterdir()) == [tool.JOURNAL_NAME]
    code = code_only(TOOL_PATH)
    assert "hashlib.sha256(env" not in code and "sha256(material" not in code


def test_the_material_comparison_is_in_memory_only(tmp_path):
    code = code_only(TOOL_PATH)
    assert "before_content = material_content(host)" in code and "del before_content" in code


def test_verify_detects_a_detector_that_appeared_a_changed_release_or_a_swapped_tree(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.detector.update(LoadState="loaded", ActiveState="active", MainPID="55")
    assert refusal(run_verify, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"
    world.detector.update(LoadState="not-found", ActiveState="inactive", MainPID="0")
    host.detector_procs = [4321]
    assert refusal(run_verify, host, backend, work) == "DETECTOR_STANDALONE_PROCESS_PRESENT"
    host.detector_procs = []
    host.files[f"{TARGET}/aegis_soc/production_detector.py"] += b"# changed after install\n"
    assert refusal(run_verify, host, backend, work) in ("DETECTOR_SHA256_MISMATCH", "RELEASE_TREE_CHANGED")


def test_verify_requires_the_release_tree_to_equal_the_installed_bytes(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.files[f"{TARGET}/aegis_soc/extra.py"] = b"added"
    assert refusal(run_verify, host, backend, work) == "RELEASE_TREE_CHANGED"


def test_a_release_that_is_a_symlink_or_not_a_real_directory_fails_verify(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[TARGET] = "/elsewhere"
    assert refusal(run_verify, host, backend, work) == "RELEASE_PATH_NOT_A_DIRECTORY"


def test_verify_is_read_only(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    ops, argvs = list(host.ops), list(backend.argvs)
    run_verify(host, backend, work)
    assert host.ops == ops and backend.argvs == argvs


# ═══ rollback: owns ONLY the release this attempt created ═══════════════════════════════════════════════════════════════════


def test_rollback_with_no_journal_or_before_the_installer_owns_nothing(tmp_path):
    world, host, backend, work = build(tmp_path)
    assert tool.rollback(work, host, backend) == {"F1I_ROLLBACK": "NOTHING_OWNED"}
    refusal(run_apply, host, backend, work, release_id="../x")  # refused in preflight: no journal at all
    assert tool.rollback(work, host, backend) == {"F1I_ROLLBACK": "NOTHING_OWNED"} and host.ops == []


def test_rollback_after_a_failed_installer_that_left_nothing_owns_nothing(tmp_path):
    world, host, backend, work = build(tmp_path, installer_rc=1)
    refusal(run_apply, host, backend, work)
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1I_ROLLBACK": "NOTHING_OWNED"}
    assert host.ops == [] and TARGET not in host.dirs


def test_rollback_removes_only_the_owned_new_release(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    out = tool.rollback(work, host, FakeBackend(world, host))
    assert out == {"F1I_ROLLBACK": "PASS", "TARGET_RELEASE_ABSENT": "YES", "CURRENT_TARGET": CUR_PATH, "CORE_UNCHANGED": "YES", "DETECTOR_PRESENT": "NO",
                   "L7_MATERIAL_PRESERVED": "YES"}
    assert host.ops == [("remove_tree", TARGET)] and journal(work)["phase"] == "rolled_back"
    assert TARGET not in host.dirs and not [p for p in host.files if p.startswith(TARGET)]


def test_rollback_preserves_the_old_release_the_parents_current_and_the_material(tmp_path):
    world, host, backend, work = build(tmp_path)
    files_before, dirs_before = dict(host.files), set(host.dirs)
    run_apply(host, backend, work)
    tool.rollback(work, host, FakeBackend(world, host))
    assert host.files == files_before and host.dirs == dirs_before and host.links == {CURRENT: CUR_PATH}
    assert {OPT, RELEASES, CUR_PATH, ETC, CREDS} <= host.dirs  # no parent, old release, credentials directory or core.env was removed
    assert CORE_ENV in host.files and CUR_PATH in host.dirs
    assert not [op for op in host.ops if op[1] != TARGET]  # the ONLY path ever removed is the exact stage-created release


def test_rollback_refuses_a_drifted_release_and_leaves_it_for_the_owner(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.files[f"{TARGET}/aegis_soc/extra.py"] = b"foreign"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH"
    assert TARGET in host.dirs and host.ops == []


@pytest.mark.parametrize("override,reason", [("NOT_ROOT_OWNED", "RELEASE_DRIFTED_REFUSING_ROLLBACK:RELEASE_GUARD:NOT_ROOT_OWNED"),
                                             ("SHA256SUMS_MISMATCH", "RELEASE_DRIFTED_REFUSING_ROLLBACK:RELEASE_GUARD:SHA256SUMS_MISMATCH")])
def test_rollback_refuses_when_the_release_guard_no_longer_passes(tmp_path, override, reason):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.guard_overrides[(TARGET, TARGET, "root")] = override
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == reason and TARGET in host.dirs


def test_rollback_refuses_a_wrong_id_source_sha_or_detector_digest(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.guard[(TARGET, TARGET, "root")] = ("other", SRC_SHA)
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)).startswith("RELEASE_DRIFTED_REFUSING_ROLLBACK")
    host.guard[(TARGET, TARGET, "root")] = (RID, "1" * 40)
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)).startswith("RELEASE_DRIFTED_REFUSING_ROLLBACK")
    host.guard[(TARGET, TARGET, "root")] = (RID, SRC_SHA)
    host.files[f"{TARGET}/aegis_soc/production_detector.py"] = b"swapped"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)).startswith("RELEASE_DRIFTED_REFUSING_ROLLBACK") and TARGET in host.dirs


def test_rollback_refuses_before_any_removal_if_current_changed_after_the_install(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[CURRENT] = TARGET
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "CURRENT_CHANGED_AFTER_INSTALL"
    assert host.ops == [] and TARGET in host.dirs


def test_rollback_refuses_if_the_target_is_not_a_real_directory(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.links[TARGET] = "/elsewhere"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "RELEASE_PATH_NOT_A_DIRECTORY"
    assert host.ops == []


def test_rollback_refuses_install_temp_residue_as_an_owner_decision(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.temps = [f".install-tmp-{RID}-zzz"]
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "INSTALL_TEMP_RESIDUE" and host.ops == []


def test_rollback_after_a_crash_between_the_installer_and_the_journal_never_deletes_an_unproven_target(tmp_path):
    """phase=installing means INSTALL OUTCOME UNKNOWN: a valid-looking target is NOT proof of ownership, so it is left untouched and escalated."""
    world, host, backend, work = build(tmp_path)
    real = tool.write_journal

    def crash_on_installed(path, data):
        if data["phase"] == "installed":
            raise OSError("simulated crash after the installer returned")
        return real(path, data)

    tool.write_journal = crash_on_installed
    try:
        with pytest.raises(tool.Refusal):
            run_apply(host, backend, work)
    finally:
        tool.write_journal = real
    assert journal(work)["phase"] == "installing" and TARGET in host.dirs
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "INSTALL_OUTCOME_UNKNOWN"
    assert host.ops == [] and TARGET in host.dirs and journal(work)["phase"] == "installing"  # nothing removed, nothing rewritten


def test_rollback_postconditions_core_detector_and_material_are_escalated_after_the_removal(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    world.core["MainPID"] = "7777"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "CORE_DRIFT_DURING_ROLLBACK"
    assert TARGET not in host.dirs and journal(work)["phase"] == "rolled_back"  # removed first, then escalated
    world, host, backend, work = build(tmp_path / "d")
    run_apply(host, backend, work)
    host.detector_procs = [9]
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "DETECTOR_STANDALONE_PROCESS_PRESENT"
    world, host, backend, work = build(tmp_path / "m")
    run_apply(host, backend, work)
    host.write_content(CORE_ENV, b"changed")
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "MATERIAL_METADATA_DRIFT"


def test_a_second_rollback_is_a_safe_noop_and_a_foreign_journal_fails_closed(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    tool.rollback(work, host, FakeBackend(world, host))
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1I_ROLLBACK": "ALREADY_ROLLED_BACK"}
    (work / tool.JOURNAL_NAME).write_text(json.dumps({"stage": "F1r", "phase": "installed"}))
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNEXPECTED"
    (work / tool.JOURNAL_NAME).write_text("not json")
    assert refusal(tool.rollback, work, host, backend) == "JOURNAL_UNREADABLE"


def test_the_removal_helper_refuses_symlinks_and_special_files_inside_a_release(tmp_path):
    real = tool.F1iHost(releases_dir=str(tmp_path))  # the same rule as production, with a fixture releases directory
    root = tmp_path / "rel"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "f").write_text("x")
    os.symlink("/etc/passwd", root / "sub" / "link")
    with pytest.raises(tool.Refusal) as exc:
        real.remove_release_tree(str(root))
    assert str(exc.value) == "RELEASE_TREE_UNSAFE" and (root / "sub" / "f").exists()  # refused BEFORE deleting anything
    os.unlink(root / "sub" / "link")
    real.remove_release_tree(str(root))
    assert not root.exists()


def test_the_removal_helper_only_accepts_a_path_directly_under_the_releases_directory():
    real = tool.F1iHost()
    for bad in ("/", "/opt", "/opt/aegis-idea3", "/opt/aegis-idea3/releases", "/opt/aegis-idea3/current", "/etc/aegis-idea3", "/opt/aegis-idea3/releases/a/b", "relative"):
        with pytest.raises(tool.Refusal) as exc:
            real.remove_release_tree(bad)
        assert str(exc.value) == "RELEASE_REMOVE_PATH_NOT_OWNED", bad


def test_the_cli_refuses_without_the_live_flag_and_root_but_check_is_read_only(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("AEGIS_F1I_LIVE_AUTHORIZED", raising=False)
    assert tool.main(["rollback", "--work-dir", str(tmp_path)]) == 1 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in capsys.readouterr().err
    monkeypatch.setenv("AEGIS_F1I_LIVE_AUTHORIZED", "YES")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert tool.main(["apply", "--work-dir", str(tmp_path), "--expected-current-release-id", CUR_ID, "--release-id", RID, "--source-dir", SOURCE_DIR,
                      "--source-sha", SRC_SHA, "--detector-sha256", DET_SHA]) == 1 and "ROOT_REQUIRED" in capsys.readouterr().err


# ═══ stage registration, authorization/K3, handlers, allow files ═══════════════════════════════════════════════════════════════


def stages() -> list[str]:
    line = next(l for l in P4_LIB.read_text().splitlines() if l.strip().startswith("readonly P4_STAGES="))
    return line.split('"')[1].split()


def test_f1i_is_registered_after_l8p_and_before_f1r_and_l6c_keeps_its_original_position():
    order = stages()
    assert order.index("L7") < order.index("L7u") < order.index("L8p") < order.index("F1i") < order.index("F1r") < order.index("F1") < order.index("L8") < order.index("L9")
    assert order.count("F1i") == 1 and "F1I" not in order
    assert order.index("L6b") < order.index("L6c") < order.index("L7")  # historical L6c ordering/meaning is untouched


def sh(script: str, env: dict | None = None, cwd: Path | None = None):
    return _REAL_RUN(["bash", "-c", script], capture_output=True, text=True, timeout=60, check=False, cwd=cwd, env={"PATH": os.environ["PATH"], "LC_ALL": "C", "SUDO": "", **(env or {})})


def test_the_stage_framework_knows_f1i_mutating_gapless_and_extra_field_free():
    out = sh(f'. "{P4_LIB}"; p4_stage_known F1i && echo known; p4_stage_known F1I || echo F1I-unknown; p4_stage_mutates F1i && echo mutates; echo "gaps=$(p4_stage_gaps F1i)"; '
             f'echo "extra=[$(p4_stage_auth_extra F1i)]"; p4_stage_handler_status F1i')
    assert out.stdout.split() == ["known", "F1I-unknown", "mutates", "gaps=none", "extra=[]", "REGISTERED"], out.stdout + out.stderr


def _today() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("Asia/Bangkok")).strftime("%Y-%m-%d")


def _auth(stage: str, **extra) -> str:
    rows = {"stage": stage, "date": _today(), "authorizer": "music", "scope": "F1i repaired release install only; no current switch, no Core restart", "reference": "OD-F1I-FIXTURE-01", **extra}
    return "AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in rows.items() if v is not None)


def _k3(stage: str, **over) -> str:
    rows = {"stage": stage, "date": _today(), "confirmed_by": "music", "confirmation_mode": "IDEA3_OWNER_SELF_ATTESTATION", "idea1_window_overlap": "NONE_KNOWN",
            "reference": "OD-F1I-FIXTURE-01", **over}
    return "AEGIS_P4_K3_CONFIRMATION_V2\n" + "".join(f"{k}={v}\n" for k, v in rows.items())


def gate(tmp_path, stage, auth, k3, mode="live"):
    a, k = tmp_path / "authorization.txt", tmp_path / "k3.txt"
    a.write_text(auth)
    k.write_text(k3)
    return _REAL_RUN(["bash", str(GATE), "--stage", stage, "--mode", mode, "--authorization", str(a), "--k3", str(k)], capture_output=True, text=True, timeout=60, check=False,
                     env={"PATH": os.environ["PATH"], "LC_ALL": "C", "TZ": "Asia/Bangkok"})


def test_fresh_same_day_authorization_and_k3_are_required_and_exact_for_f1i(tmp_path):
    ok = gate(tmp_path, "F1i", _auth("F1i"), _k3("F1i"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    lines = ok.stdout.splitlines()
    for expected in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED", "STAGE_MUTATES_PRODUCTION=YES", "LIVE_STAGE_AUTHORIZED=NO",
                     "PRODUCTION_MUTATION_PERFORMED=NO"):
        assert expected in lines, expected
    assert "GATE_FAIL AUTHORIZATION_MISSING" in gate_missing(tmp_path, auth=False).stdout
    assert "GATE_FAIL K3_MISSING" in gate_missing(tmp_path, auth=True).stdout


def gate_missing(tmp_path, auth: bool):
    a, k = tmp_path / "a.txt", tmp_path / "k.txt"
    a.write_text(_auth("F1i"))
    k.write_text(_k3("F1i"))
    args = ["bash", str(GATE), "--stage", "F1i", "--mode", "live"]
    args += ["--k3", str(k)] if not auth else ["--authorization", str(a)]
    return _REAL_RUN(args, capture_output=True, text=True, timeout=60, check=False, env={"PATH": os.environ["PATH"], "LC_ALL": "C", "TZ": "Asia/Bangkok"})


@pytest.mark.parametrize("extra", [{"d6_notice": "pub"}, {"integration_review": "kla"}, {"recovery_authorization": "OD-REC-01"}, {"physical_recovery_attestation": "OD-PHYS-01"}])
def test_f1i_carries_no_extra_authorization_field(tmp_path, extra):
    bad = gate(tmp_path, "F1i", _auth("F1i", **extra), _k3("F1i"))
    assert bad.returncode == 1 and "GATE_FAIL AUTHORIZATION_MALFORMED" in bad.stdout


@pytest.mark.parametrize("label,auth,k3,reason", [
    ("stale_auth", lambda: _auth("F1i", date="2020-01-01"), lambda: _k3("F1i"), "AUTHORIZATION_STALE"),
    ("stale_k3", lambda: _auth("F1i"), lambda: _k3("F1i", date="2020-01-01"), "K3_STALE"),
    ("auth_for_l6c", lambda: _auth("L6c"), lambda: _k3("F1i"), "AUTHORIZATION_STAGE_MISMATCH"),
    ("k3_for_l6c", lambda: _auth("F1i"), lambda: _k3("L6c"), "K3_STAGE_MISMATCH"),
])
def test_historical_l6c_records_have_no_authority_over_f1i(tmp_path, label, auth, k3, reason):
    bad = gate(tmp_path, "F1i", auth(), k3())
    assert bad.returncode == 1 and f"GATE_FAIL {reason}" in bad.stdout


def test_an_l6c_consumed_marker_neither_blocks_nor_authorizes_f1i(tmp_path):
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "L6C-ATTEMPT-CONSUMED").write_text("consumed_at=2026-10-04T00:00:00Z\n")  # the failed maintenance reuse of L6c
    assert sh(f'. "{F1I_LIB}"; f1i_attempt_unconsumed "{auth}"').returncode == 0
    assert sh(f'. "{F1I_LIB}"; f1i_consume_attempt "{auth}"').returncode == 0 and (auth / "F1I-ATTEMPT-CONSUMED").is_file() and (auth / "L6C-ATTEMPT-CONSUMED").is_file()
    assert "F1I_ATTEMPT_ALREADY_CONSUMED" in sh(f'. "{F1I_LIB}"; f1i_attempt_unconsumed "{auth}"').stderr
    assert "F1I_ATTEMPT_ALREADY_CONSUMED" in sh(f'. "{F1I_LIB}"; f1i_consume_attempt "{auth}"').stderr


def test_the_f1i_handler_set_is_exactly_the_five_contract_files_and_executable():
    assert sorted(p.name for p in STAGE.iterdir()) == ["allow-keys.txt", "allow-listeners.txt", "apply.sh", "rollback.sh", "verify.sh"]
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        assert os.access(STAGE / name, os.X_OK)
        text = active_shell(STAGE / name)
        assert "AEGIS_F1I_LIVE_AUTHORIZED" in text and text.count("exec ") == 1
        assert not re.search(r"systemctl|ln\s+-|\bmv\b|\brm\b|chmod|chown|useradd|esptool|/dev/tty|mosquitto|recovery_ui|server_admin|p4-l7-install", text), name


def test_the_f1i_handlers_do_not_reuse_the_pre_l7_l6c_predicates():
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        text = (STAGE / name).read_text()
        assert "L7_MATERIAL_PRESENT" not in text and "CORE_UNIT_LOADED" not in text and "not-found" not in active_shell(STAGE / name)


def test_the_f1i_allow_files_carry_no_key_and_no_listener():
    for name in ("allow-keys.txt", "allow-listeners.txt"):
        active = [l for l in (STAGE / name).read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
        assert active == [], name  # parents exist post-L7: no path key drifts; the catalog change is approved ONLY by the relational release rule


# ═══ comparator contract: real p4-compare.sh on real captured bundles ═══════════════════════════════════════════════════════════


def _bundle_with(src: Path, dst: Path, **records: str) -> Path:
    import shutil

    shutil.copytree(src, dst)
    for fname, prefix in (("host.tsv", "host."), ("services.tsv", "svc."), ("listeners.tsv", "listen.")):
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
    files = sorted(p.name for p in dst.iterdir() if p.is_file() and p.name != "SHA256SUMS")
    (dst / "SHA256SUMS").write_text(_REAL_RUN(["sha256sum", *files], cwd=dst, capture_output=True, text=True, check=True).stdout)
    return dst


@pytest.fixture(scope="module")
def real_capture(tmp_path_factory):
    sys.path.insert(0, str(ROOT / "tests"))
    import test_pr11_phase4_harness as h

    tmp = tmp_path_factory.mktemp("f1i-compare")
    cap = h.capture(tmp, "before")
    assert cap.result.returncode == 0, cap.result.stdout + cap.result.stderr
    return cap


CAT_A, CAT_B, CAT_NEW = f"{CUR_ID}:{'a' * 64}", f"{'1' * 40}:{'b' * 64}", f"{RID}:{'d' * 64}"


def _cmp(pre: Path, post: Path, release_id: str | None = RID, keys: Path | None = None):
    env = {"PATH": os.environ["PATH"], "HOME": str(pre), "LC_ALL": "C", "DISK_THRESHOLD_PCT": "90", "ALLOW_KEYS_FILE": str(keys or STAGE / "allow-keys.txt"),
           "ALLOW_LISTENERS_FILE": str(STAGE / "allow-listeners.txt")}
    if release_id:
        allow = pre.parent / f"allow-release-{release_id}.txt"
        allow.write_text(f"stage F1i\nrelease_id {release_id}\n")
        env["ALLOW_L6C_RELEASE_FILE"] = str(allow)
    return _REAL_RUN(["bash", str(COMPARE), str(pre), str(post)], capture_output=True, text=True, timeout=60, check=False, env=env)


def _pair(tmp_path, real_capture, post_catalog, **post_extra):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: CUR_PATH})
    post = _bundle_with(real_capture.evid, tmp_path / "post", **{CATALOG_KEY: post_catalog, CURRENT_KEY: CUR_PATH, **post_extra})
    return pre, post


def test_the_comparator_accepts_exactly_one_new_release_added_to_an_otherwise_identical_catalog(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}")
    ok = _cmp(pre, post)
    assert ok.returncode == 0 and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "L6C_RELEASE_INSTALLED" in ok.stdout and "COMPARE_RESULT=PASS" in ok.stdout, ok.stdout


def test_the_comparator_accepts_the_stage_label_f1i_and_still_refuses_unknown_stage_labels(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}")
    allow = tmp_path / "allow.txt"
    allow.write_text(f"stage F1x\nrelease_id {RID}\n")
    env = {"PATH": os.environ["PATH"], "HOME": str(pre), "LC_ALL": "C", "DISK_THRESHOLD_PCT": "90", "ALLOW_L6C_RELEASE_FILE": str(allow)}
    bad = _REAL_RUN(["bash", str(COMPARE), str(pre), str(post)], capture_output=True, text=True, timeout=60, check=False, env=env)
    assert bad.returncode != 0 and "malformed ALLOW_L6C_RELEASE_FILE line" in bad.stdout + bad.stderr


@pytest.mark.parametrize("label,post_catalog", [
    ("no_addition_but_allowed", f"{CAT_A},{CAT_B}"),
])
def test_an_approved_but_absent_addition_is_not_drift(tmp_path, real_capture, label, post_catalog):
    pre, post = _pair(tmp_path, real_capture, post_catalog)
    assert _cmp(pre, post).returncode == 0


@pytest.mark.parametrize("label,post_catalog", [
    ("two_additions", f"{CAT_A},{CAT_B},{CAT_NEW},{'2' * 40}:{'e' * 64}"),
    ("wrong_id", f"{CAT_A},{CAT_B},{'3' * 40}:{'d' * 64}"),
    ("old_release_mutated", f"{CUR_ID}:{'f' * 64},{CAT_B},{CAT_NEW}"),
    ("old_release_removed", f"{CAT_A},{CAT_NEW}"),
])
def test_the_comparator_refuses_every_other_catalog_change(tmp_path, real_capture, label, post_catalog):
    pre, post = _pair(tmp_path, real_capture, post_catalog)
    bad = _cmp(pre, post)
    assert bad.returncode == 1 and "COMPARE_RESULT=PASS" not in bad.stdout


def test_an_addition_without_the_release_allowance_is_refused(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}")
    assert _cmp(pre, post, release_id=None).returncode == 1  # the rollback comparison (zero allowances) rejects the very same addition


def test_current_target_drift_fails_even_with_the_release_allowance(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}", **{CURRENT_KEY: TARGET})
    bad = _cmp(pre, post)
    assert bad.returncode == 1 and CURRENT_KEY in bad.stdout


def test_listener_drift_fails_even_with_the_release_allowance(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}", **{"listen.tcp.0.0.0.0:9999": "present"})
    assert _cmp(pre, post).returncode == 1


@pytest.mark.parametrize("key", ["host.aegis_idea3.file./etc/aegis-idea3/core.env.meta", "host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta",
                                 "svc.aegis-idea3-core.service.MainPID", "svc.aegis-idea3-core.service.NRestarts"])
def test_material_core_pid_and_restart_drift_fail_the_comparator(tmp_path, real_capture, key):
    pre = _bundle_with(real_capture.evid, tmp_path / "pre", **{CATALOG_KEY: f"{CAT_A},{CAT_B}", CURRENT_KEY: CUR_PATH, key: "mode=600 uid=0 gid=0 size=1 mtime=1"})
    post = _bundle_with(real_capture.evid, tmp_path / "post", **{CATALOG_KEY: f"{CAT_A},{CAT_B},{CAT_NEW}", CURRENT_KEY: CUR_PATH, key: "mode=600 uid=0 gid=0 size=2 mtime=2"})
    assert _cmp(pre, post).returncode == 1


def test_the_runner_gate_proves_the_new_entry_is_exactly_the_journaled_release_and_digest(tmp_path, real_capture):
    pre, post = _pair(tmp_path, real_capture, f"{CAT_A},{CAT_B},{CAT_NEW}")

    def catalog(before, after, rid=RID, digest="d" * 64):
        return sh(f'. "{F1I_LIB}"; f1i_catalog_transition_gate "{before}" "{after}" "{rid}" "{digest}"')

    assert catalog(pre, post).returncode == 0
    assert "F1I_CATALOG_TRANSITION_NOT_EXACT" in catalog(pre, post, digest="e" * 64).stderr  # the digest must be the journaled tree digest
    assert catalog(pre, post, rid="3" * 40).returncode == 1
    assert catalog(pre, pre).returncode == 1  # no addition at all
    two = _bundle_with(real_capture.evid, tmp_path / "two", **{CATALOG_KEY: f"{CAT_A},{CAT_B},{CAT_NEW},{'2' * 40}:{'e' * 64}"})
    assert catalog(pre, two).returncode == 1
    mutated = _bundle_with(real_capture.evid, tmp_path / "mut", **{CATALOG_KEY: f"{CUR_ID}:{'f' * 64},{CAT_B},{CAT_NEW}"})
    assert catalog(pre, mutated).returncode == 1


# ═══ shell library gates and the owner runner ═══════════════════════════════════════════════════════════════════════════════════


def lib(snippet: str, **env):
    return sh(f'set -uo pipefail; . "{F1I_LIB}"; {snippet}', env=env)


def stub(tmp_path: Path, rc: int, line: str) -> Path:
    path = tmp_path / "stub-python"
    path.write_text(f'#!/bin/bash\necho "$*" > "{tmp_path}/args.txt"\necho "{line}" >&2\nexit {rc}\n')
    path.chmod(0o755)
    return path


def test_the_f1i_preflight_gate_runs_the_reviewed_tool_through_sudo_read_only(tmp_path):
    log = tmp_path / "sudo.log"
    sudo = tmp_path / "fake-sudo"
    sudo.write_text(f'#!/bin/bash\nprintf "%s\\n" "$*" >> "{log}"\nexec "$@"\n')
    sudo.chmod(0o755)
    ok = lib(f'f1i_preflight_gate "{stub(tmp_path, 0, "F1I_CHECK=PASS")}" TOOL "{CUR_ID}" "{RID}" "{SOURCE_DIR}" "{SRC_SHA}" "{DET_SHA}"', SUDO=str(sudo))
    assert ok.returncode == 0, ok.stderr
    line = log.read_text().splitlines()[0]
    assert line.startswith("env PYTHONDONTWRITEBYTECODE=1 ") and " TOOL check " in line + " " and not any(w in line.split() for w in ("apply", "verify", "rollback"))
    args = (tmp_path / "args.txt").read_text().split()
    for flag in ("--expected-current-release-id", "--release-id", "--source-dir", "--source-sha", "--detector-sha256"):
        assert flag in args


def test_the_f1i_preflight_gate_maps_failures_and_a_failed_elevation(tmp_path):
    bad = lib(f'f1i_preflight_gate "{stub(tmp_path, 1, "F1I_CHECK=FAIL reason=CURRENT_NOT_EXPECTED_TARGET")}" TOOL "{CUR_ID}" "{RID}" "{SOURCE_DIR}" "{SRC_SHA}" "{DET_SHA}"')
    assert bad.returncode == 1 and "F1I_PREFLIGHT_FAILED:CURRENT_NOT_EXPECTED_TARGET" in bad.stderr
    nosudo = lib(f'f1i_preflight_gate "{stub(tmp_path, 0, "F1I_CHECK=PASS")}" TOOL "{CUR_ID}" "{RID}" "{SOURCE_DIR}" "{SRC_SHA}" "{DET_SHA}"', SUDO="false")
    assert nosudo.returncode == 1 and "F1I_PREFLIGHT_FAILED:ROOT_READ_UNAVAILABLE" in nosudo.stderr


L8P_RECEIPT = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_075127_music_idea3-l8p-attempt2-reconciliation-closeout.md"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
L8P_OK = "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n"
F1I_OK = f"F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=YES\nF1I_RELEASE_ID={RID}\n"


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


def test_the_f1i_receipt_gate_requires_l8p_closed_and_makes_f1i_one_shot(tmp_path):
    assert lib(f'f1i_receipt_gate "{git_repo(tmp_path / "a", {L8P_RECEIPT: L8P_OK})}"').returncode == 0
    assert "F1I_L8P_NOT_CLOSED" in lib(f'f1i_receipt_gate "{git_repo(tmp_path / "b", {f"{LOGS}/x.md": "# none\n"})}"').stderr
    elsewhere = git_repo(tmp_path / "c", {f"{LOGS}/2026-10-04_000000_music_other.md": L8P_OK})
    assert "F1I_L8P_RESULT_NOT_IN_CANONICAL_CLOSEOUT_RECEIPT" in lib(f'f1i_receipt_gate "{elsewhere}"').stderr
    done = git_repo(tmp_path / "d", {L8P_RECEIPT: L8P_OK, f"{LOGS}/2026-10-06_000000_music_f1i.md": F1I_OK})
    assert "F1I_ALREADY_EXECUTED" in lib(f'f1i_receipt_gate "{done}"').stderr
    partial = git_repo(tmp_path / "e", {L8P_RECEIPT: L8P_OK, f"{LOGS}/2026-10-06_000000_music_f1i.md": "F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=NO\n"})
    assert lib(f'f1i_receipt_gate "{partial}"').returncode == 0  # a failed/rolled-back attempt is not an install


def test_the_runner_gate_ties_the_detector_pin_to_the_reviewed_source(tmp_path):
    src = tmp_path / "IDEA3-AEGIS_Lockdown" / "aegis_soc"
    src.mkdir(parents=True)
    (src / "production_detector.py").write_bytes(DET_BYTES)
    assert lib(f'f1r_detector_source_gate "{tmp_path}" "{DET_SHA}"').returncode == 0
    assert "F1R_DETECTOR_SOURCE_DIGEST_MISMATCH" in lib(f'f1r_detector_source_gate "{tmp_path}" "{"1" * 64}"').stderr


def test_the_committed_f1i_runner_refuses_to_run_unpinned_and_creates_nothing(tmp_path):
    r = _REAL_RUN(["bash", str(F1I_RUNNER), str(tmp_path)], capture_output=True, text=True, timeout=30, check=False, cwd=tmp_path, env={"PATH": os.environ["PATH"], "LC_ALL": "C"})
    assert r.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in r.stdout and list(tmp_path.iterdir()) == []


def test_the_f1i_runner_pins_exactly_the_seven_owner_frozen_values_and_commits_no_real_value():
    text = F1I_RUNNER.read_text()
    pins = ("EXPECTED_MAIN", "OPERATOR_USER", "OPERATOR_UID", "EXPECTED_CURRENT_RELEASE_ID", "RELEASE_ID", "EXPECTED_SOURCE_SHA", "EXPECTED_PRODUCTION_DETECTOR_SHA256")
    for pin in pins:
        assert re.search(rf"^{pin}=PIN_[A-Z0-9_]+$", text, re.M), pin
    assert len(re.findall(r"^[A-Z0-9_]+=PIN_[A-Z0-9_]+$", text, re.M)) == len(pins)
    assert not re.search(r"=[0-9a-f]{40}\n|=[0-9a-f]{64}\n", text)
    assert "authorization-F1i.txt" in text and "k3-F1i.txt" in text and "--stage F1i" in text and "F1I-ATTEMPT-CONSUMED" not in active_shell(F1I_RUNNER).replace("f1i_consume_attempt", "")


def test_the_f1i_runner_orders_gates_then_pre_then_reprove_then_marker_then_apply_verify_post_compare():
    text = active_shell(F1I_RUNNER)
    order = ["l7u_identity_gate", "p4-stage-gate.sh", "f1i_receipt_gate", "f1r_detector_source_gate", "f1i_preflight_gate", "capture PRE", "f1i_preflight_gate",
             "f1_detector_absent_gate", "f1r_core_snapshot_gate", "f1i_consume_attempt", "handler apply.sh", "handler verify.sh", "capture POST", "f1i_catalog_transition_gate",
             'compare "$PRE" "$EVID/post-root"', "l7u_secret_scan", "F1I_LIVE_EXECUTED=YES"]
    pos = -1
    for token in order:
        nxt = text.find(token, pos + 1)
        assert nxt > pos, token
        pos = nxt
    assert text.count("handler apply.sh") == 1 and text.count("f1i_consume_attempt") == 1 and text.count("handler rollback.sh") == 1
    assert not re.search(r"\b(while|until)\b[^\n]*\bhandler\b|handler[^\n]*\|\|\s*handler (apply|verify)", text)
    pre_gates = re.findall(r"f1i_preflight_gate[^\n]*\\\n\s*\|\| (gate|die) ", text)
    assert pre_gates == ["gate", "die"]  # both abort the run; the second is before the one-shot boundary


def test_the_f1i_runner_rolls_back_only_after_consume_with_zero_drift_and_no_release_allowance():
    text = active_shell(F1I_RUNNER)
    assert "fail_after_attempt()" in text and "ATTEMPTED=1" in text
    rb = text[text.index("rollback_flow()"):text.index("fail_after_attempt()")]
    for needed in ("handler rollback.sh", "f1i_rollback_output_gate", "capture RB", 'compare "$PRE" "$EVID/rb-root"', "empty-allow.txt", "NOT retrying", "exit 3"):
        assert needed in rb, needed
    assert "allow-release" not in rb  # the PRE->RB comparison carries NO release allowance at all
    post = text[text.index("PRE -> POST compare"):]
    assert "allow-release.txt" in text and "stage F1i" in text and 'release_id $RELEASE_ID' in text and "allow-release" in post


def test_the_only_place_the_live_flag_is_set_is_the_post_gate_handler_function():
    text = active_shell(F1I_RUNNER)
    assert text.count("AEGIS_F1I_LIVE_AUTHORIZED=YES") == 1
    handler = text[text.index("handler() {"):text.index("own_pre()")]
    assert "AEGIS_F1I_LIVE_AUTHORIZED=YES" in handler and "AEGIS_F1I_LIVE_AUTHORIZED" not in active_shell(F1I_LIB)


def test_the_f1i_runner_reads_opt_through_sudo_and_never_restarts_switches_or_starts_anything():
    for path in (F1I_RUNNER, F1I_LIB):
        text = active_shell(path)
        assert not re.search(r"systemctl\s+(restart|stop|start|reload|enable|disable|kill|mask|daemon-reload)\b", text), path
        assert not re.search(r"esptool|/dev/tty|serial|recovery_ui|server_admin|RESTORE|\bCUT\b|ln\s+-s|\bmv\b\s|p4-l7-install|p4-l7-build", text), path
    runner = active_shell(F1I_RUNNER)
    assert not re.search(r"\$\(readlink /opt", runner)
    claims = F1I_RUNNER.read_text()
    for claim in ("F1I_LIVE_EXECUTED=YES", "F1I_RELEASE_INSTALLED=YES", "F1I_RELEASE_ID=", "CURRENT_SYMLINK_CHANGED=NO", "CORE_RESTARTED=NO", "F1R_LIVE_EXECUTED=NO",
                  "F1_ATTEMPT_2_PERFORMED=NO", "F1_DETECTOR_STARTED=NO"):
        assert claim in claims, claim
    assert not re.search(r"F1R_CURRENT_SWITCHED=YES|F1_PRODUCTION_DEPLOYED=YES|F1_DETECTOR_STARTED=YES|F1_REAL_DETECTOR_ACCEPTANCE=(PASS|YES)|RECOVERY_R1_R8_PROVEN=YES", claims)


# ═══ Part H: F1r must prove the governed F1i install (and no longer names L6c as its predecessor) ═══════════════════════════════


F1R_RELEASE_ID = RID


def f1r_gate(repo: Path, rid: str = F1R_RELEASE_ID):
    return sh(f'. "{F1R_LIB}"; f1r_receipt_gate "{repo}" "{rid}"')


F1R_OK = "F1R_LIVE_EXECUTED=YES\nF1R_CURRENT_SWITCHED=YES\n"


def f1r_repo(tmp_path, extra: dict[str, str]):
    return git_repo(tmp_path, {L8P_RECEIPT: L8P_OK, **extra})


def test_f1r_refuses_without_any_f1i_receipt(tmp_path):
    r = f1r_gate(f1r_repo(tmp_path, {}))
    assert r.returncode == 1 and "F1R_F1I_NOT_CLOSED" in r.stderr


def test_f1r_refuses_with_only_f1i_live_executed(tmp_path):
    assert "F1R_F1I_NOT_CLOSED" in f1r_gate(f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": f"F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_ID={RID}\n"})).stderr


def test_f1r_refuses_with_only_f1i_release_installed(tmp_path):
    assert "F1R_F1I_NOT_CLOSED" in f1r_gate(f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": f"F1I_RELEASE_INSTALLED=YES\nF1I_RELEASE_ID={RID}\n"})).stderr


def test_f1r_refuses_when_the_f1i_fields_are_split_between_receipts(tmp_path):
    repo = f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_a.md": f"F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_ID={RID}\n", f"{LOGS}/2026-10-05_010000_music_b.md": "F1I_RELEASE_INSTALLED=YES\n"})
    assert "F1R_F1I_NOT_CLOSED" in f1r_gate(repo).stderr


def test_f1r_refuses_duplicate_successful_f1i_receipts(tmp_path):
    repo = f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_a.md": F1I_OK, f"{LOGS}/2026-10-05_010000_music_b.md": F1I_OK})
    assert "F1R_F1I_RESULT_NOT_UNIQUE" in f1r_gate(repo).stderr


def test_f1r_refuses_a_successful_f1i_receipt_for_a_different_release_id(tmp_path):
    repo = f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_a.md": F1I_OK.replace(RID, "3" * 40)})
    r = f1r_gate(repo)
    assert r.returncode == 1 and "F1R_F1I_RELEASE_ID_MISMATCH" in r.stderr
    no_id = f1r_repo(tmp_path / "n", {f"{LOGS}/2026-10-05_000000_music_a.md": "F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=YES\n"})
    assert "F1R_F1I_RELEASE_ID_MISMATCH" in f1r_gate(no_id).stderr  # the receipt must name the release


def test_f1r_refuses_a_receipt_with_more_than_one_f1i_release_id_line_even_if_one_is_the_expected_id(tmp_path):
    both = f"{F1I_OK}F1I_RELEASE_ID={'3' * 40}\n"
    r = f1r_gate(f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": both}))
    assert r.returncode == 1 and "F1R_F1I_RELEASE_ID_NOT_UNIQUE" in r.stderr
    same_twice = f1r_gate(f1r_repo(tmp_path / "s", {f"{LOGS}/2026-10-05_000000_music_f1i.md": f"{F1I_OK}F1I_RELEASE_ID={RID}\n"}))
    assert "F1R_F1I_RELEASE_ID_NOT_UNIQUE" in same_twice.stderr  # exactly ONE line, not "at least one"
    only_wrong_twice = f1r_gate(f1r_repo(tmp_path / "w", {f"{LOGS}/2026-10-05_000000_music_f1i.md": f"F1I_LIVE_EXECUTED=YES\nF1I_RELEASE_INSTALLED=YES\nF1I_RELEASE_ID={'3' * 40}\nF1I_RELEASE_ID={'4' * 40}\n"}))
    assert "F1R_F1I_RELEASE_ID_MISMATCH" in only_wrong_twice.stderr


def test_the_release_id_cardinality_does_not_weaken_whole_line_matching_or_success_receipt_uniqueness(tmp_path):
    prose = f"{F1I_OK}Notes: F1I_RELEASE_ID={'3' * 40} was discussed in prose, not a result line.\n"
    assert f1r_gate(f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": prose})).returncode == 0  # a non-whole-line mention is not a result field
    dup = f1r_repo(tmp_path / "d", {f"{LOGS}/2026-10-05_000000_music_a.md": F1I_OK, f"{LOGS}/2026-10-05_010000_music_b.md": F1I_OK})
    assert "F1R_F1I_RESULT_NOT_UNIQUE" in f1r_gate(dup).stderr


def test_f1r_passes_with_exactly_one_matching_f1i_receipt(tmp_path):
    r = f1r_gate(f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": F1I_OK}))
    assert r.returncode == 0, r.stderr


def test_a_failed_or_repository_only_f1i_record_never_satisfies_f1r(tmp_path):
    repo = f1r_repo(tmp_path, {f"{LOGS}/2026-10-05_000000_music_f1i.md": f"F1I_LIVE_EXECUTED = NO\nF1I_RELEASE_INSTALLED = NO\nF1I_RELEASE_ID={RID}\n"})
    assert "F1R_F1I_NOT_CLOSED" in f1r_gate(repo).stderr
    pr_receipt = next((ROOT.parent / LOGS).glob("*_music_idea3-f1i-repaired-release-install-stage.md"), None)
    if pr_receipt is not None:  # this repository-only task's own receipt must never carry the authoritative YES pair
        lines = [line.strip().strip("`").replace(" ", "") for line in pr_receipt.read_text().splitlines()]
        assert "F1I_LIVE_EXECUTED=YES" not in lines and "F1I_RELEASE_INSTALLED=YES" not in lines


def test_the_f1r_receipt_gate_requires_the_release_id_argument_and_the_runner_passes_it():
    assert "F1R_RELEASE_ID_REQUIRED" in sh(f'. "{F1R_LIB}"; f1r_receipt_gate "{ROOT.parent}"').stderr
    runner = active_shell(F1R_RUNNER)
    assert 'f1r_receipt_gate "$REPO" "$NEW_RELEASE_ID"' in runner


def test_f1r_no_longer_names_l6c_as_its_repaired_release_predecessor():
    for path in (F1R_RUNNER, F1R_LIB, DEPLOY / "p4-f1r-switch.py", STAGE.parent / "F1r" / "apply.sh", STAGE.parent / "F1r" / "verify.sh"):
        text = path.read_text()
        assert "L6c (repair" not in text and "L6c (fresh install-only" not in text and "L6c repair" not in text, path
        assert "F1i" in text or path.name.endswith(".sh") or path.name == "p4-f1r-switch.py", path
    assert "F1i" in F1R_RUNNER.read_text() and "F1i" in (DEPLOY / "p4-f1r-switch.py").read_text()


# ═══ review fix: rollback ownership is a strict journal-state boundary (a valid release is NOT proof of ownership) ═════════════════


def set_journal(work, **changes):
    data = json.loads((work / tool.JOURNAL_NAME).read_text())
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    (work / tool.JOURNAL_NAME).write_text(json.dumps(data, sort_keys=True))


def test_A_a_foreign_valid_target_that_made_the_installer_fail_is_never_deleted(tmp_path):
    """The exact review scenario: the journal reached `installing`; another root actor created a fully valid target; the installer refused with RELEASE_ALREADY_INSTALLED."""
    world, host, backend, work = build(tmp_path, installer_rc=1, installer_reason="RELEASE_ALREADY_INSTALLED", foreign_target=True)
    assert refusal(run_apply, host, backend, work) == "INSTALL_FAILED:RELEASE_ALREADY_INSTALLED"
    j = journal(work)
    assert j["phase"] == "installer_failed" and j["installer_rc"] == 1 and j["installer_reason"] == "RELEASE_ALREADY_INSTALLED" and "release_tree_digest" not in j
    assert TARGET in host.dirs  # the foreign release is fully valid and passes every guard...
    check = tool.check_installed_release
    check(host, RID, SRC_SHA, DET_SHA)  # ...which is exactly why validity must NOT be treated as ownership
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "FOREIGN_OR_UNPROVEN_TARGET"
    assert host.ops == [] and TARGET in host.dirs and f"{TARGET}/aegis_soc/production_detector.py" in host.files  # remove_release_tree was never called
    assert journal(work)["phase"] == "installer_failed"  # nothing was rewritten either


def test_the_installer_failure_reason_is_never_deletion_authority_whatever_it_says(tmp_path):
    for reason in ("RELEASE_ALREADY_INSTALLED", "SOURCE_GUARD_FAILED", "TIMEOUT", "UNKNOWN"):
        world, host, backend, work = build(tmp_path / reason, installer_rc=1, installer_reason=reason, foreign_target=True)
        refusal(run_apply, host, backend, work)
        assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "FOREIGN_OR_UNPROVEN_TARGET"
        assert host.ops == [] and TARGET in host.dirs


def test_the_persisted_installer_result_holds_only_a_fixed_parsed_reason_never_arbitrary_output(tmp_path):
    world, host, backend, work = build(tmp_path, installer_rc=1, installer_reason="weird reason with $(secret) and spaces")
    refusal(run_apply, host, backend, work)
    j = journal(work)
    assert j["installer_reason"] in ("weird", "UNKNOWN") and not re.search(r"[^A-Za-z0-9_:.-]", j["installer_reason"]) and "secret" not in json.dumps(j)
    world, host, backend, work = build(tmp_path / "long", installer_rc=7, installer_reason="X" * 500)
    refusal(run_apply, host, backend, work)
    assert journal(work)["installer_reason"] == "UNKNOWN" and journal(work)["installer_rc"] == 7


def test_B_installer_failed_with_the_target_absent_owns_nothing_and_removes_nothing(tmp_path):
    world, host, backend, work = build(tmp_path, installer_rc=1)
    refusal(run_apply, host, backend, work)
    assert journal(work)["phase"] == "installer_failed" and TARGET not in host.dirs
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1I_ROLLBACK": "NOTHING_OWNED"}
    assert host.ops == [] and journal(work)["phase"] == "rolled_back"


def test_C_an_unknown_install_outcome_with_the_target_present_fails_closed_and_removes_nothing(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    set_journal(work, phase="installing", release_tree_digest=None, material_content_preserved=False)  # an interrupted attempt: outcome unknown, no durable success
    assert TARGET in host.dirs
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "INSTALL_OUTCOME_UNKNOWN"
    assert host.ops == [] and TARGET in host.dirs and journal(work)["phase"] == "installing"


def test_C2_an_unknown_install_outcome_with_the_target_absent_owns_nothing(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.write_journal
    tool.write_journal = lambda path, data: (_ for _ in ()).throw(OSError("crash")) if data["phase"] == "installing" else real(path, data)
    try:
        with pytest.raises(tool.Refusal):
            run_apply(host, backend, work)
    finally:
        tool.write_journal = real
    set_journal(work, phase="installing")
    assert tool.rollback(work, host, FakeBackend(world, host)) == {"F1I_ROLLBACK": "NOTHING_OWNED"} and host.ops == []


@pytest.mark.parametrize("phase", ["installed", "applied"])
def test_D_an_installed_or_applied_journal_without_a_tree_digest_proves_no_ownership(tmp_path, phase):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    set_journal(work, phase=phase, release_tree_digest=None)
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "JOURNAL_OWNERSHIP_UNPROVEN"
    assert host.ops == [] and TARGET in host.dirs
    set_journal(work, release_tree_digest="")  # an empty digest is no digest
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "JOURNAL_OWNERSHIP_UNPROVEN" and host.ops == []


def test_an_unknown_journal_phase_fails_closed(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    set_journal(work, phase="something-else")
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "JOURNAL_PHASE_UNKNOWN" and host.ops == [] and TARGET in host.dirs


def test_E_phase_installed_with_the_exact_digest_still_rolls_back_normally(tmp_path):
    world, host, backend, work = build(tmp_path)
    real = tool.write_journal
    tool.write_journal = lambda path, data: (_ for _ in ()).throw(OSError("crash")) if data["phase"] == "applied" else real(path, data)
    try:
        with pytest.raises(tool.Refusal):
            run_apply(host, backend, work)  # the digest was journaled with phase=installed; the final `applied` write crashed
    finally:
        tool.write_journal = real
    j = journal(work)
    assert j["phase"] == "installed" and j["release_tree_digest"]
    assert tool.rollback(work, host, FakeBackend(world, host))["F1I_ROLLBACK"] == "PASS"
    assert host.ops == [("remove_tree", TARGET)] and TARGET not in host.dirs


def test_F_phase_applied_with_the_exact_digest_still_rolls_back_normally(tmp_path):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    assert journal(work)["phase"] == "applied" and journal(work)["release_tree_digest"]
    assert tool.rollback(work, host, FakeBackend(world, host))["F1I_ROLLBACK"] == "PASS" and host.ops == [("remove_tree", TARGET)]


@pytest.mark.parametrize("phase", ["installed", "applied"])
def test_G_a_drifted_owned_release_is_still_refused_in_both_owned_phases(tmp_path, phase):
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    set_journal(work, phase=phase)
    host.files[f"{TARGET}/aegis_soc/extra.py"] = b"foreign"
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH"
    assert host.ops == [] and TARGET in host.dirs


def test_a_foreign_target_that_matches_only_the_pins_but_has_a_different_tree_digest_is_refused_even_when_owned_phase(tmp_path):
    """Defense in depth: even in phase=installed, a release that is valid by the pins but is not byte-identical to what this attempt installed is refused."""
    world, host, backend, work = build(tmp_path)
    run_apply(host, backend, work)
    host.files[f"{TARGET}/RELEASE-MANIFEST.json"] = manifest() + b" "  # same facts, different bytes
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH" and host.ops == []


# ═══ review hardening: the post-install checks inside APPLY are pinned individually ═════════════════════════════════════════════


def test_apply_refuses_when_current_changes_during_the_install_step(tmp_path):
    def repoint(host, world):
        host.links[CURRENT] = f"{RELEASES}/intruder"

    world, host, backend, work = build(tmp_path, side_effect=repoint)
    assert refusal(run_apply, host, backend, work) == "CURRENT_NOT_EXPECTED_TARGET"
    assert journal(work)["phase"] == "installed" and journal(work)["release_tree_digest"]  # the install itself was proven; the post-install proof failed
    assert refusal(tool.rollback, work, host, FakeBackend(world, host)) == "CURRENT_CHANGED_AFTER_INSTALL" and host.ops == []  # and rollback still refuses before deleting


def test_apply_refuses_when_the_detector_appears_during_the_install_step(tmp_path):
    def start_detector(host, world):
        world.detector.update(LoadState="loaded", ActiveState="active", MainPID="55")

    world, host, backend, work = build(tmp_path, side_effect=start_detector)
    assert refusal(run_apply, host, backend, work) == "DETECTOR_UNIT_OR_PROCESS_PRESENT"
    world.detector.update(LoadState="not-found", ActiveState="inactive", MainPID="0")
    world2, host2, backend2, work2 = build(tmp_path / "proc", side_effect=lambda h, w: h.detector_procs.append(4321))
    assert refusal(run_apply, host2, backend2, work2) == "DETECTOR_STANDALONE_PROCESS_PRESENT"


@pytest.mark.parametrize("path", [CORE_ENV, f"{CREDS}/k_c2d"])
def test_apply_refuses_when_the_material_metadata_changes_during_the_install_step(tmp_path, path):
    world, host, backend, work = build(tmp_path, side_effect=lambda h, w: h.chmod(path, 0o644))
    assert refusal(run_apply, host, backend, work) == "MATERIAL_METADATA_DRIFT"
    assert journal(work)["phase"] == "installed" and journal(work)["material_content_preserved"] is False


def test_apply_refuses_when_the_core_restarts_during_the_install_step(tmp_path):
    world, host, backend, work = build(tmp_path, side_effect=lambda h, w: w.core.update(MainPID="9999"))
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"
    world, host, backend, work = build(tmp_path / "n", side_effect=lambda h, w: w.core.update(NRestarts="1"))
    assert refusal(run_apply, host, backend, work) == "CORE_RESTARTED_OR_REPLACED"


def test_the_critical_gate_surface_exists_in_the_f1i_tool():
    code = code_only(TOOL_PATH)
    for needle in ("CURRENT_NOT_EXPECTED_TARGET", "TARGET_RELEASE_ALREADY_EXISTS", "CORE_RESTARTED_OR_REPLACED", "MATERIAL_METADATA_DRIFT", "MATERIAL_CONTENT_DRIFT",
                   "DETECTOR_SHA256_MISMATCH", "RELEASE_DRIFTED_REFUSING_ROLLBACK", "CURRENT_CHANGED_AFTER_INSTALL", "INSTALLER_ALREADY_INVOKED", "RELEASE_REMOVE_PATH_NOT_OWNED"):
        assert needle in code, needle
