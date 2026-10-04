#!/usr/bin/env python3
"""F1r governed current-release activation: the atomic switch of /opt/aegis-idea3/current, with NO Core restart.

Repository tooling; merging it authorizes nothing live. The live path runs only through the frozen owner runner (run-f1r-owner.sh) and the stages/F1r
handlers. Stage order: L7 -> L7u -> L8p -> L6c (fresh install-only run for the repaired release) -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9.

F1r owns exactly ONE mutation: replace the ``current`` symlink, from the exact frozen OLD release target to the exact frozen NEW release target. The NEW
release must ALREADY be installed (by L6c): this tool never builds, copies, installs, chmods, chowns or deletes anything under /opt/aegis-idea3/releases.
Atomicity: a temporary symlink is created next to ``current`` and renamed over it (``os.replace``), so ``current`` is never absent and never half-written.
It never restarts, starts, stops or reloads any service (the privileged backend can only ``systemctl show`` the Core and detector units), so the running
Core keeps its PID, restart count and working directory; changing ``current`` does NOT move the running Core to the new release. The detector is never
started or installed here; that is stage F1 (attempt 2).

Ownership: a journal in the attempt's private work directory records the exact OLD target BEFORE any mutation. Rollback acts only on that journal, only
after proving ``current`` still points exactly where this attempt left it, and refuses (changing nothing) otherwise.
Output is fixed reason codes and non-secret identifiers (release ids, source SHAs, digests, paths); never environment or secret content.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent

OPT_DIR = "/opt/aegis-idea3"
CURRENT = f"{OPT_DIR}/current"
RELEASES_DIR = f"{OPT_DIR}/releases"
TMP_LINK = f"{OPT_DIR}/.current.f1r-tmp"
CORE_UNIT = "aegis-idea3-core.service"
DETECTOR_UNIT = "aegis-idea3-detector.service"
DETECTOR_UNIT_PATHS = (
    f"/etc/systemd/system/{DETECTOR_UNIT}", f"/usr/lib/systemd/system/{DETECTOR_UNIT}", f"/lib/systemd/system/{DETECTOR_UNIT}", f"/run/systemd/system/{DETECTOR_UNIT}",
    f"/etc/systemd/system/{DETECTOR_UNIT}.d", f"/run/systemd/system/{DETECTOR_UNIT}.d", f"/usr/lib/systemd/system/{DETECTOR_UNIT}.d",
)
DETECTOR_REL = "aegis_soc/production_detector.py"
DETECTOR_MODULE = "aegis_soc.production_detector"  # the argv token of `python -m aegis_soc.production_detector` (the unit's ExecStart and any hand-run copy)
MANIFEST_REL = "RELEASE-MANIFEST.json"
JOURNAL_NAME = "f1r-journal.json"
SHOW_TIMEOUT_SEC = 10.0
CORE_PROPS = ("ActiveState", "SubState", "MainPID", "NRestarts")
DETECTOR_PROPS = ("LoadState", "ActiveState", "MainPID")
RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
SHA1_RE = re.compile(r"[0-9a-f]{40}", re.ASCII)
SHA256_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)


class Refusal(Exception):
    """A fixed reason code. Never carries environment or secret content."""


def refuse(code: str) -> None:
    raise Refusal(code)


class CommandResult(NamedTuple):
    rc: int
    out: str


# ── the only privileged surface ──────────────────────────────────────────────────────────────────────────────────────────────


class F1rBackend:
    """An exact allow-list: ``systemctl show`` of the Core and detector units with ``-p`` properties. Every other verb (restart, start, stop, reload,
    daemon-reload, enable, kill, …) and every other unit is refused, so F1r cannot restart the Core or start the detector by construction."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    @staticmethod
    def allowed(args: tuple[str, ...]) -> bool:
        return len(args) >= 2 and args[0] == "show" and args[1] in (CORE_UNIT, DETECTOR_UNIT) and all(a.startswith("-p") for a in args[2:])

    def systemctl(self, *args: str) -> CommandResult:
        if not self.allowed(args):
            refuse("SYSTEMCTL_VERB_NOT_ALLOWED")
        self.calls.append(args)
        return self._run(args)

    def _run(self, args: tuple[str, ...]) -> CommandResult:
        try:
            done = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=SHOW_TIMEOUT_SEC, check=False)
        except subprocess.TimeoutExpired:
            return CommandResult(124, "")
        return CommandResult(done.returncode, done.stdout)


def _load_guard():
    spec = importlib.util.spec_from_file_location("p4_l7_release_guard", HERE / "p4-l7-release-guard.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("RELEASE_GUARD_TOOL_MISSING")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class F1rHost:
    """Host reads/writes for the switch only. Fixtures substitute this class with an in-memory fake.

    Reads of /opt/aegis-idea3 may need ROOT (the parent can be root-only): the read-only ``check`` / ``check-runtime`` are therefore run through ``sudo`` by
    the owner libraries, and a read that is DENIED here is a fixed refusal (``HOST_READ_DENIED``), never an empty "absent" answer."""

    def _lstat(self, path: str):
        try:
            return os.lstat(path)
        except (FileNotFoundError, NotADirectoryError):
            return None  # genuinely absent
        except PermissionError:
            refuse("HOST_READ_DENIED")  # cannot be proven either way: fail closed

    def is_symlink(self, path: str) -> bool:
        info = self._lstat(path)
        return info is not None and stat.S_ISLNK(info.st_mode)

    def readlink(self, path: str) -> str:
        try:
            return os.readlink(path)
        except PermissionError:
            refuse("HOST_READ_DENIED")
            raise  # unreachable

    def lexists(self, path: str) -> bool:
        return self._lstat(path) is not None

    def is_regular(self, path: str) -> bool:
        info = self._lstat(path)
        return info is not None and stat.S_ISREG(info.st_mode)

    def detector_processes(self, proc_root: str = "/proc") -> list[int]:
        """Read-only detection of any standalone ``python -m aegis_soc.production_detector`` (or ``.../production_detector.py``) process, by EXACT argv tokens:
        a unit that is ``not-found`` does not prove no detector runs. Never signals, stops or kills anything. Run with root read authority so no process is
        hidden; an unreadable /proc entry is a refusal, not an absence."""
        found: list[int] = []
        me = os.getpid()
        try:
            names = os.listdir(proc_root)
        except PermissionError:
            refuse("PROC_READ_DENIED")
        for name in names:
            if not name.isdigit() or int(name) == me:
                continue
            try:
                data = Path(proc_root, name, "cmdline").read_bytes()
            except PermissionError:
                refuse("PROC_READ_DENIED")
            except OSError:
                continue  # the process exited between the listing and the read
            args = [a.decode("utf-8", "replace") for a in data.split(b"\0") if a]
            if any(a == DETECTOR_MODULE or os.path.basename(a) == "production_detector.py" for a in args):
                found.append(int(name))
        return sorted(found)

    def read_bytes(self, path: str) -> bytes:
        try:
            return Path(path).read_bytes()
        except PermissionError:
            refuse("HOST_READ_DENIED")
            raise  # unreachable

    def sha256_file(self, path: str) -> str:
        digest = hashlib.sha256()
        try:
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
        except PermissionError:
            refuse("HOST_READ_DENIED")
        return digest.hexdigest()

    def realpath(self, path: str) -> str:
        return os.path.realpath(path)

    def symlink(self, target: str, path: str) -> None:
        os.symlink(target, path)

    def replace(self, src: str, dst: str) -> None:
        os.replace(src, dst)  # rename(2): atomically replaces the destination symlink itself, never following it

    def unlink(self, path: str) -> None:
        os.unlink(path)

    def fsync_dir(self, path: str) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def proc_cwd(self, pid: int) -> str | None:
        try:
            return os.readlink(f"/proc/{int(pid)}/cwd")
        except OSError:
            return None  # root-only on a hardened host; recorded as UNREADABLE, never required

    def release_guard(self, logical: str, host_path: str) -> tuple[str, str]:
        """The existing, reviewed release guard, in-process, always at --expect-owner root. Returns (release_id, source_git_sha)."""
        self._lstat(host_path)  # a denied read must surface as HOST_READ_DENIED, not as the guard's "missing release"
        guard = _load_guard()
        try:
            return guard.check(logical, Path(host_path), "root")
        except guard.Refusal as exc:
            refuse(f"RELEASE_GUARD:{exc}")
            raise  # unreachable


# ── pins ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def release_id(text: str) -> str:
    if not isinstance(text, str) or not RELEASE_ID_RE.fullmatch(text) or ".." in text:
        refuse("RELEASE_ID_INVALID")
    return text


def source_sha_pin(text: str) -> str:
    if not isinstance(text, str) or not SHA1_RE.fullmatch(text):  # fullmatch: "$" would accept a trailing newline
        refuse("RELEASE_SOURCE_SHA_PIN_INVALID")
    return text


def detector_sha_pin(text: str) -> str:
    if not isinstance(text, str) or not SHA256_RE.fullmatch(text):
        refuse("DETECTOR_SHA256_PIN_INVALID")
    return text


def release_path(rid: str) -> str:
    return f"{RELEASES_DIR}/{rid}"


# ── read-only checks (shared by preflight, verify, rollback and the F1 pre-consume runtime gate) ────────────────────────────────


def check_current(host: F1rHost, old_id: str) -> str:
    """``current`` is a symlink whose target STRING is exactly the OLD release path (never "resolves to"): relative, trailing-slash and ``..`` forms are refused."""
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    target = host.readlink(CURRENT)
    if target != release_path(old_id):
        refuse("CURRENT_NOT_OLD_TARGET")
    return target


def check_old_release(host: F1rHost, old_id: str) -> None:
    try:
        rid, _ = host.release_guard(release_path(old_id), release_path(old_id))
    except Refusal as exc:
        refuse(f"OLD_RELEASE_INVALID:{exc}")
    if rid != old_id:
        refuse("OLD_RELEASE_INVALID:RELEASE_ID_MISMATCH")


def check_new_release(host: F1rHost, rid: str, source_sha: str, detector_sha: str) -> None:
    """The release is root-owned and valid (existing guard, --expect-owner root), is exactly the pinned id/source SHA, was built from a clean tree, and its
    production_detector.py bytes are exactly the pinned reviewed digest."""
    path = release_path(rid)
    guard_id, guard_sha = host.release_guard(path, path)
    if guard_id != rid:
        refuse("RELEASE_ID_MISMATCH")
    try:
        data = json.loads(host.read_bytes(f"{path}/{MANIFEST_REL}"))
    except (OSError, ValueError, KeyError):
        refuse("RELEASE_MANIFEST_UNREADABLE")
    if not isinstance(data, dict):
        refuse("RELEASE_MANIFEST_UNREADABLE")
    if data.get("release_id") != rid:
        refuse("RELEASE_ID_MISMATCH")
    if guard_sha != source_sha or data.get("source_git_sha") != source_sha:
        refuse("RELEASE_SOURCE_SHA_MISMATCH")
    if data.get("source_tree_dirty") is not False:
        refuse("RELEASE_SOURCE_TREE_DIRTY")
    detector = f"{path}/{DETECTOR_REL}"
    if not host.is_regular(detector):
        refuse("DETECTOR_FILE_INVALID")
    if host.sha256_file(detector) != detector_sha:
        refuse("DETECTOR_SHA256_MISMATCH")


def props(backend: F1rBackend, unit: str, names: tuple[str, ...]) -> dict[str, str]:
    result = backend.systemctl("show", unit, *[f"-p{n}" for n in names])
    if result.rc != 0:
        refuse("UNIT_STATE_UNKNOWN")
    return dict(line.split("=", 1) for line in result.out.splitlines() if "=" in line)


def detector_absent(host: F1rHost, backend: F1rBackend) -> None:
    """The detector is absent on BOTH surfaces: (A) the systemd surface (no unit file anywhere, LoadState not-found, inactive, MainPID 0) and (B) no standalone
    ``aegis_soc.production_detector`` process exists (a bare process leaves the unit not-found). Used by preflight/check, apply, verify, check-runtime and the
    rollback postcondition. Detection only: nothing is ever stopped or signalled."""
    for path in DETECTOR_UNIT_PATHS:
        if host.lexists(path):
            refuse("DETECTOR_UNIT_OR_PROCESS_PRESENT")
    state = props(backend, DETECTOR_UNIT, DETECTOR_PROPS)
    if state.get("LoadState") != "not-found" or state.get("ActiveState") != "inactive" or state.get("MainPID") != "0":
        refuse("DETECTOR_UNIT_OR_PROCESS_PRESENT")
    if host.detector_processes():
        refuse("DETECTOR_STANDALONE_PROCESS_PRESENT")


def core_snapshot(host: F1rHost, backend: F1rBackend) -> dict[str, str]:
    snap = props(backend, CORE_UNIT, CORE_PROPS)
    if snap.get("ActiveState") != "active" or snap.get("SubState") != "running":
        refuse("CORE_NOT_RUNNING")
    pid, restarts = snap.get("MainPID", ""), snap.get("NRestarts", "")
    if not pid.isdigit() or int(pid) <= 0 or not restarts.isdigit():
        refuse("CORE_NOT_RUNNING")
    cwd = host.proc_cwd(int(pid))
    return {"core_main_pid": pid, "core_n_restarts": restarts, "core_cwd": cwd if cwd is not None else "UNREADABLE"}


def preflight(host: F1rHost, backend: F1rBackend, old_id: str, new_id: str, source_sha: str, detector_sha: str) -> dict[str, str]:
    """Every pre-mutation gate. Returns the non-secret facts the journal records. Mutates nothing."""
    release_id(old_id)
    release_id(new_id)
    if old_id == new_id:
        refuse("RELEASE_IDS_NOT_DISTINCT")
    source_sha_pin(source_sha)
    detector_sha_pin(detector_sha)
    old_target = check_current(host, old_id)
    check_old_release(host, old_id)
    check_new_release(host, new_id, source_sha, detector_sha)
    detector_absent(host, backend)
    return {"old_target": old_target, "new_target": release_path(new_id), **core_snapshot(host, backend)}


def check_runtime_release(host: F1rHost, backend: F1rBackend, rid: str, source_sha: str, detector_sha: str) -> dict[str, str]:
    """Read-only pre-consume gate for the FUTURE F1 attempt: Production must already resolve to the exact repaired release (right id, source SHA and
    detector bytes, valid root-owned release) and the detector unit/process must still be absent."""
    release_id(rid)
    source_sha_pin(source_sha)
    detector_sha_pin(detector_sha)
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    if host.readlink(CURRENT) != release_path(rid):
        refuse("CURRENT_NOT_EXPECTED_RUNTIME_RELEASE")
    check_new_release(host, rid, source_sha, detector_sha)
    detector_absent(host, backend)
    return {"F1R_CHECK_RUNTIME": "PASS", "RUNTIME_RELEASE_ID": rid, "RUNTIME_RELEASE_SOURCE_SHA": source_sha, "PRODUCTION_DETECTOR_SHA256": detector_sha,
            "DETECTOR_PRESENT": "NO"}


# ── journal ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def write_journal(work: Path, data: dict) -> None:
    """Atomic, fsynced, written BEFORE each mutation so rollback never has to guess what was done."""
    tmp = work / (JOURNAL_NAME + ".tmp")
    blob = json.dumps(data, sort_keys=True).encode()
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(blob)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, work / JOURNAL_NAME)


def read_journal(work: Path) -> dict | None:
    path = work / JOURNAL_NAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        refuse("JOURNAL_UNREADABLE")
    if not isinstance(data, dict) or data.get("stage") != "F1r":
        refuse("JOURNAL_UNEXPECTED")
    return data


def require_work_dir(path: str) -> Path:
    work = Path(path)
    if not work.is_absolute() or work.is_symlink() or not work.is_dir():
        refuse("WORK_DIR_INVALID")
    info = work.stat()
    if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
        refuse("WORK_DIR_NOT_PRIVATE")
    return work


# ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _atomic_point(host: F1rHost, target: str) -> None:
    """symlink to ``target`` at the temp name, rename it over ``current``, fsync the directory. ``current`` is never absent."""
    host.symlink(target, TMP_LINK)
    host.replace(TMP_LINK, CURRENT)
    host.fsync_dir(OPT_DIR)


def _current_is(host: F1rHost, target: str) -> bool:
    return host.is_symlink(CURRENT) and host.readlink(CURRENT) == target and host.realpath(CURRENT) == target


def apply(old_id: str, new_id: str, source_sha: str, detector_sha: str, work: Path, host: F1rHost, backend: F1rBackend) -> dict[str, str]:
    """preflight -> journal OLD -> re-read current -> journal -> atomic switch -> journal -> immediate exact verification. One attempt, no retry."""
    if read_journal(work) is not None:
        refuse("ATTEMPT_JOURNAL_ALREADY_EXISTS")  # one attempt per work directory
    facts = preflight(host, backend, old_id, new_id, source_sha, detector_sha)
    journal = {"stage": "F1r", "phase": "preflight", "old_release_id": old_id, "new_release_id": new_id, **facts, "switched": False}
    write_journal(work, journal)  # the exact OLD target is on disk before anything changes
    try:
        check_current(host, old_id)  # re-read immediately before the mutation: refuse unless it is STILL exactly the OLD target
        if host.lexists(TMP_LINK):
            refuse("SWITCH_TEMP_EXISTS")  # never replace or adopt a name this attempt did not create
        journal["phase"] = "switching"
        write_journal(work, journal)
        _atomic_point(host, facts["new_target"])
        journal.update(phase="switched", switched=True)  # before the check: from here the switch is OURS even if verification fails
        write_journal(work, journal)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    if not _current_is(host, facts["new_target"]):
        refuse("CURRENT_NOT_NEW_TARGET_AFTER_SWITCH")
    return {"F1R_APPLY": "COMPLETE", "CURRENT_TARGET": facts["new_target"], "OLD_TARGET": facts["old_target"], "F1R_CORE_RESTARTED": "NO"}


# ── verify ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(old_id: str, new_id: str, source_sha: str, detector_sha: str, work: Path, host: F1rHost, backend: F1rBackend) -> dict[str, str]:
    """Read-only. The exact NEW target, the guarded NEW release and detector bytes, the SAME running Core (PID, restart count, cwd) and an absent detector."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") != "switched" or journal.get("switched") is not True:
        refuse("ATTEMPT_NOT_SWITCHED")
    if journal.get("old_release_id") != old_id or journal.get("new_release_id") != new_id:
        refuse("ATTEMPT_PINS_MISMATCH")
    new_target = journal["new_target"]
    if not host.is_symlink(CURRENT) or host.readlink(CURRENT) != new_target or host.realpath(CURRENT) != new_target:
        refuse("CURRENT_NOT_NEW_TARGET")
    source_sha_pin(source_sha)
    detector_sha_pin(detector_sha)
    check_new_release(host, new_id, source_sha, detector_sha)
    check_old_release(host, old_id)  # the old release still exists and is unaltered; F1r never touches it
    core = core_snapshot(host, backend)
    if core["core_main_pid"] != journal["core_main_pid"] or core["core_n_restarts"] != journal["core_n_restarts"]:
        refuse("CORE_RESTARTED_OR_REPLACED")
    cwd_state = "UNREADABLE"
    if journal.get("core_cwd") != "UNREADABLE":
        if core["core_cwd"] != journal["core_cwd"]:
            refuse("CORE_CWD_CHANGED")  # the running Core process itself did not change directory: it was not restarted
        cwd_state = "UNCHANGED"
    detector_absent(host, backend)
    return {"F1R_VERIFY": "PASS", "CURRENT_TARGET": new_target, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": source_sha,
            "PRODUCTION_DETECTOR_SHA256": detector_sha, "CORE_MAIN_PID_UNCHANGED": "YES", "CORE_N_RESTARTS_UNCHANGED": "YES", "CORE_CWD": cwd_state,
            "CORE_MOVED_TO_NEW_RELEASE": "NO", "DETECTOR_PRESENT": "NO"}


# ── rollback ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def rollback(work: Path, host: F1rHost, backend: F1rBackend) -> dict[str, str]:
    """Undo ONLY a switch this attempt journalled. Never deletes or alters a release, never touches the Core, the detector or anything but ``current`` and
    this attempt's own temp link. Unknown or foreign state => refusal BEFORE any mutation (owner decision)."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") == "preflight":
        return {"F1R_ROLLBACK": "NOTHING_OWNED"}  # no mutation was journalled
    if journal.get("phase") == "rolled_back":
        return {"F1R_ROLLBACK": "ALREADY_ROLLED_BACK"}
    old_target, new_target = journal["old_target"], journal["new_target"]
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    now = host.readlink(CURRENT)
    if journal.get("phase") == "switching" and now == old_target:
        # the replace never happened: the only thing this attempt may own is its own temp link, removed only after proving it is exactly ours
        if host.lexists(TMP_LINK):
            if not host.is_symlink(TMP_LINK) or host.readlink(TMP_LINK) != new_target:
                refuse("SWITCH_TEMP_NOT_OWNED_BY_THIS_ATTEMPT")
            host.unlink(TMP_LINK)
        journal["phase"] = "rolled_back"
        write_journal(work, journal)
        return {"F1R_ROLLBACK": "NOTHING_OWNED"}
    if now != new_target:
        refuse("CURRENT_NOT_OWNED_BY_THIS_ATTEMPT")  # another actor changed `current` (or restored it): left exactly as found
    if host.lexists(TMP_LINK):
        refuse("SWITCH_TEMP_EXISTS")
    try:
        _atomic_point(host, old_target)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    if not _current_is(host, old_target):
        refuse("CURRENT_NOT_OLD_TARGET_AFTER_ROLLBACK")
    journal["phase"] = "rolled_back"
    write_journal(work, journal)
    try:
        core = core_snapshot(host, backend)
    except Refusal:
        refuse("CORE_DRIFT_DURING_ROLLBACK")
    if core["core_main_pid"] != journal["core_main_pid"] or core["core_n_restarts"] != journal["core_n_restarts"]:
        refuse("CORE_DRIFT_DURING_ROLLBACK")  # restored first, then escalated
    detector_absent(host, backend)
    return {"F1R_ROLLBACK": "PASS", "CURRENT_TARGET": old_target, "CORE_UNCHANGED": "YES", "DETECTOR_PRESENT": "NO"}


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def pins(sp, work: bool) -> None:
        if work:
            sp.add_argument("--work-dir", required=True)
        sp.add_argument("--old-release-id", required=True)
        sp.add_argument("--new-release-id", required=True)
        sp.add_argument("--new-source-sha", required=True)
        sp.add_argument("--new-detector-sha256", required=True)

    pins(sub.add_parser("check"), work=False)  # read-only preflight; needs neither root nor the live flag
    sp = sub.add_parser("check-runtime")  # read-only gate for the FUTURE F1 pre-consume boundary
    sp.add_argument("--release-id", required=True)
    sp.add_argument("--source-sha", required=True)
    sp.add_argument("--detector-sha256", required=True)
    pins(sub.add_parser("apply"), work=True)
    pins(sub.add_parser("verify"), work=True)
    sub.add_parser("rollback").add_argument("--work-dir", required=True)
    args = parser.parse_args(argv)
    label = "F1R_" + args.command.upper().replace("-", "_")
    try:
        host, backend = F1rHost(), F1rBackend()
        if args.command == "check":
            facts = preflight(host, backend, args.old_release_id, args.new_release_id, args.new_source_sha, args.new_detector_sha256)
            result = {"F1R_CHECK": "PASS", "CURRENT_TARGET": facts["old_target"], "NEW_TARGET": facts["new_target"], "DETECTOR_PRESENT": "NO", "CORE_RUNNING": "YES"}
        elif args.command == "check-runtime":
            result = check_runtime_release(host, backend, args.release_id, args.source_sha, args.detector_sha256)
        else:
            if os.environ.get("AEGIS_F1R_LIVE_AUTHORIZED") != "YES":
                refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
            if os.geteuid() != 0:
                refuse("ROOT_REQUIRED")
            work = require_work_dir(args.work_dir)
            if args.command == "rollback":
                result = rollback(work, host, backend)
            else:
                run = apply if args.command == "apply" else verify
                result = run(args.old_release_id, args.new_release_id, args.new_source_sha, args.new_detector_sha256, work, host, backend)
    except Refusal as exc:
        print(f"{label}=FAIL reason={exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"{label}=FAIL reason=IO:{type(exc).__name__}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
