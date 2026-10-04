#!/usr/bin/env python3
"""F1 governed detector deployment (stage F1): exact unit install, daemon-reload, ONE start, verify, owned rollback.

Repository tooling; merging it authorizes nothing live. The live path runs only through the frozen owner runner (run-f1-owner.sh) and the
stages/F1 handlers. It reuses the reviewed ``p4-f1-alert-source.py`` for the unit contract (``verify_unit``) and for the ordered START
(``start_detector`` re-proves the account, core.env uid, the RUNNING Core uid and group, and the alert socket before its single start).

Scope (owner decision, stage F1): install the exact pinned detector unit, ``systemctl daemon-reload``, start the detector exactly once, verify the
detector runtime, and roll back ONLY what this attempt owns. It NEVER restarts the Core, never touches core.env, users or groups, never enables the
unit, never injects an alert, never sends CUT/RESTORE, never touches the ESP32 or a serial port, and never retries. A successful run proves only
F1_PRODUCTION_DEPLOYED=YES and F1_DETECTOR_STARTED=YES; it proves neither F1_REAL_DETECTOR_ACCEPTANCE nor Recovery R1-R8 nor R1_VERIFIED.

Ownership: a journal in the attempt's private work directory records what this attempt did BEFORE it does it. Rollback acts only on that journal and
only after re-proving that the installed bytes and inode are still the ones this attempt wrote; anything else is a fail-closed owner decision.
Output is fixed reason codes and non-secret identifiers only; never environment content.
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
import time
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent


def _load_alert_source():
    spec = importlib.util.spec_from_file_location("p4_f1_alert_source", HERE / "p4-f1-alert-source.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("F1_ALERT_SOURCE_TOOL_MISSING")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("p4_f1_alert_source", module)
    spec.loader.exec_module(module)
    return module


F1 = _load_alert_source()
Refusal = F1.Refusal
refuse = F1.refuse

DETECTOR_UNIT = F1.DETECTOR_UNIT
CORE_UNIT = F1.CORE_UNIT
UNIT_PATH = F1.UNIT_PATH
UNIT_DIR = "/etc/systemd/system"
OTHER_UNIT_PATHS = (f"/usr/lib/systemd/system/{DETECTOR_UNIT}", f"/run/systemd/system/{DETECTOR_UNIT}", f"/lib/systemd/system/{DETECTOR_UNIT}")
DROPIN_DIRS = (f"{UNIT_DIR}/{DETECTOR_UNIT}.d", f"/run/systemd/system/{DETECTOR_UNIT}.d", f"/usr/lib/systemd/system/{DETECTOR_UNIT}.d")
UNIT_MODE = 0o644
JOURNAL_NAME = "f1-journal.json"
SETTLE_SEC = 5.0
SHOW_TIMEOUT_SEC = 10.0
RELOAD_TIMEOUT_SEC = 60.0
DETECTOR_PROPS = ("LoadState", "ActiveState", "SubState", "UnitFileState", "Result", "MainPID", "NRestarts", "FragmentPath", "Restart")
CORE_PROPS = ("ActiveState", "SubState", "MainPID", "NRestarts")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class CommandResult(NamedTuple):
    rc: int
    out: str


class F1Backend:
    """The only privileged surface. An exact allow-list; every other systemctl form is refused. ``start`` can be issued at most once.

    ``show`` of the Core/detector, ``daemon-reload``, one ``start`` and ``stop`` of the F1 detector unit. No enable, disable, restart, mask,
    reset-failed, kill or any verb on another unit exists here, so the stage cannot restart the Core or enable the detector.
    """

    def __init__(self) -> None:
        self.starts = 0
        self.calls: list[tuple[str, ...]] = []

    @staticmethod
    def allowed(args: tuple[str, ...]) -> bool:
        if args == ("daemon-reload",):
            return True
        if len(args) >= 2 and args[0] == "show" and args[1] in (CORE_UNIT, DETECTOR_UNIT) and all(a.startswith("-p") for a in args[2:]):
            return True
        return len(args) == 2 and args[0] in ("start", "stop") and args[1] == DETECTOR_UNIT

    def systemctl(self, *args: str) -> CommandResult:
        if not self.allowed(args):
            refuse("SYSTEMCTL_VERB_NOT_ALLOWED")
        if args[0] == "start":
            if self.starts >= 1:
                refuse("DETECTOR_START_ALREADY_ISSUED")  # exactly one start, ever, per process; nothing retries
            self.starts += 1
        self.calls.append(args)
        return self._run(args)

    def _run(self, args: tuple[str, ...]) -> CommandResult:
        timeout = {"show": SHOW_TIMEOUT_SEC, "daemon-reload": RELOAD_TIMEOUT_SEC, "start": F1.START_TIMEOUT_SEC, "stop": F1.STOP_TIMEOUT_SEC}[args[0]]
        try:
            done = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return CommandResult(124, "")
        return CommandResult(done.returncode, done.stdout)


class F1Host(F1.Host):
    """Host reads/writes for the unit file only. Fixtures substitute this class with a path-rooted fake."""

    def exists(self, path: str) -> bool:
        return os.path.lexists(path)

    def link_new(self, tmp: str, final: str) -> None:
        os.link(tmp, final)  # atomic and never overwrites: EEXIST if the final path appeared meanwhile

    def unlink(self, path: str) -> None:
        os.unlink(path)

    def write_exclusive(self, path: str, data: bytes) -> None:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, UNIT_MODE)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, UNIT_MODE)
        if os.geteuid() == 0:
            os.chown(path, 0, 0)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


# ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_sha(text: str) -> str:
    if not SHA_RE.fullmatch(text or ""):  # fullmatch: "$" would accept a trailing newline
        refuse("UNIT_PIN_INVALID")
    return text


def pinned_unit(template_bytes: bytes, pin: str) -> bytes:
    """The reviewed template, rendered and contract-checked, whose SHA-256 must equal the frozen pin. No other bytes are ever installed."""
    blob = F1.render_unit(template_bytes)
    if sha256(blob) != parse_sha(pin):
        refuse("UNIT_PIN_MISMATCH")
    return blob


def props(backend: F1Backend, unit: str, names: tuple[str, ...]) -> dict[str, str]:
    result = backend.systemctl("show", unit, *[f"-p{n}" for n in names])
    if result.rc != 0:
        refuse("UNIT_STATE_UNKNOWN")
    return dict(line.split("=", 1) for line in result.out.splitlines() if "=" in line)


def core_snapshot(backend: F1Backend) -> dict[str, str]:
    snap = props(backend, CORE_UNIT, CORE_PROPS)
    if snap.get("ActiveState") != "active" or snap.get("SubState") != "running":
        refuse("CORE_NOT_RUNNING")
    if not snap.get("MainPID", "").isdigit() or int(snap["MainPID"]) <= 0 or not snap.get("NRestarts", "").isdigit():
        refuse("CORE_NOT_RUNNING")
    return {k: snap[k] for k in ("MainPID", "NRestarts")}


def core_env_digest(host: F1Host) -> str:
    return sha256(host.read_bytes(F1.CORE_ENV))


def write_journal(work: Path, data: dict) -> None:
    """Atomic, fsynced. Written BEFORE each mutation so rollback never has to guess what was done."""
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
    if not isinstance(data, dict) or data.get("stage") != "F1":
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


# ── preflight (read-only; nothing is created or changed before it passes) ───────────────────────────────────────────────────


def preflight(uid: int, core_uid: int, pin: str, host: F1Host, backend: F1Backend) -> dict:
    """Every pre-mutation gate that ``start_detector`` does not itself own. Returns the facts the journal records."""
    blob = pinned_unit((F1.UNIT_TEMPLATE).read_bytes(), pin)
    F1.verify_account(host, uid, core_uid)
    for path in (UNIT_PATH, *OTHER_UNIT_PATHS, *DROPIN_DIRS):
        if host.exists(path):
            refuse("DETECTOR_UNIT_ALREADY_PRESENT")  # never replace, adopt or remove a pre-existing unit
    state = props(backend, DETECTOR_UNIT, DETECTOR_PROPS)
    if state.get("LoadState") != "not-found":
        refuse("DETECTOR_UNIT_ALREADY_LOADED")
    if state.get("ActiveState") not in ("inactive", None) or state.get("MainPID", "0") not in ("0", ""):
        refuse("DETECTOR_PROCESS_RUNNING")
    core = core_snapshot(backend)
    return {"unit_sha256": sha256(blob), "core_main_pid": core["MainPID"], "core_n_restarts": core["NRestarts"], "core_env_sha256": core_env_digest(host)}


# ── apply ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def install_unit(blob: bytes, work: Path, journal: dict, host: F1Host) -> None:
    tmp = f"{UNIT_DIR}/.{DETECTOR_UNIT}.f1tmp"
    if host.exists(tmp):
        refuse("INSTALL_TEMP_EXISTS")
    journal["phase"] = "installing"
    write_journal(work, journal)
    host.write_exclusive(tmp, blob)
    try:
        host.link_new(tmp, UNIT_PATH)
    except FileExistsError:
        host.unlink(tmp)
        refuse("DETECTOR_UNIT_ALREADY_PRESENT")
    except OSError:
        host.unlink(tmp)
        refuse("UNIT_INSTALL_FAILED")
    host.unlink(tmp)
    info = host.lstat(UNIT_PATH)
    journal.update(phase="installed", unit_dev=info.st_dev, unit_ino=info.st_ino)  # this attempt owns exactly this inode
    write_journal(work, journal)
    verify_installed_file(host, journal)


def verify_installed_file(host: F1Host, journal: dict) -> None:
    """The installed unit is byte-identical to the pin and has the exact owner and mode, and is the inode this attempt wrote."""
    info = host.lstat(UNIT_PATH)
    if not stat.S_ISREG(info.st_mode):
        refuse("INSTALLED_UNIT_NOT_REGULAR")
    if (info.st_dev, info.st_ino) != (journal.get("unit_dev"), journal.get("unit_ino")):
        refuse("INSTALLED_UNIT_NOT_OWNED_BY_THIS_ATTEMPT")
    if stat.S_IMODE(info.st_mode) != UNIT_MODE or info.st_uid != 0 or info.st_gid != 0:
        refuse("INSTALLED_UNIT_OWNER_OR_MODE")
    if sha256(host.read_bytes(UNIT_PATH)) != journal["unit_sha256"]:
        refuse("INSTALLED_UNIT_BYTES_CHANGED")


def verify_loaded(backend: F1Backend, expect_active: bool) -> dict[str, str]:
    state = props(backend, DETECTOR_UNIT, DETECTOR_PROPS)
    if state.get("LoadState") != "loaded" or state.get("FragmentPath") != UNIT_PATH:
        refuse("DETECTOR_UNIT_NOT_LOADED")
    if state.get("UnitFileState") == "enabled":
        refuse("DETECTOR_UNIT_ENABLED")  # this stage never enables the unit
    if state.get("Restart") != "no":
        refuse("DETECTOR_RESTART_POLICY_CHANGED")
    if expect_active:
        if state.get("ActiveState") != "active" or state.get("SubState") != "running":
            refuse("DETECTOR_NOT_RUNNING")
        if not state.get("MainPID", "").isdigit() or int(state["MainPID"]) <= 0:
            refuse("DETECTOR_NO_MAIN_PID")
        if state.get("Result") != "success" or state.get("NRestarts") != "0":
            refuse("DETECTOR_UNHEALTHY")
    return state


def verify_core_unchanged(host: F1Host, backend: F1Backend, journal: dict) -> None:
    core = core_snapshot(backend)
    if core["MainPID"] != journal["core_main_pid"] or core["NRestarts"] != journal["core_n_restarts"]:
        refuse("CORE_RESTARTED_OR_REPLACED")
    if core_env_digest(host) != journal["core_env_sha256"]:
        refuse("CORE_ENV_CHANGED")


def apply(uid: int, core_uid: int, pin: str, work: Path, host: F1Host, backend: F1Backend) -> dict[str, str]:
    """preflight -> journal -> install -> daemon-reload -> loaded check -> ONE start (reusing start_detector) -> settle -> verify.

    Any refusal propagates to the caller; the runner then calls ``rollback`` once. Nothing here retries or starts twice.
    """
    if read_journal(work) is not None:
        refuse("ATTEMPT_JOURNAL_ALREADY_EXISTS")  # one attempt per work directory
    facts = preflight(uid, core_uid, pin, host, backend)
    journal = {"stage": "F1", "phase": "preflight", **facts, "daemon_reload": False, "start_issued": False}
    write_journal(work, journal)
    blob = pinned_unit(F1.UNIT_TEMPLATE.read_bytes(), pin)
    install_unit(blob, work, journal, host)
    journal["daemon_reload"] = True  # journalled first: rollback must reload even if the reload itself failed half way
    write_journal(work, journal)
    if backend.systemctl("daemon-reload").rc != 0:
        refuse("DAEMON_RELOAD_FAILED")
    verify_loaded(backend, expect_active=False)
    journal.update(phase="starting", start_issued=True)  # journalled BEFORE the start so a failed/unknown start is still rolled back
    write_journal(work, journal)
    try:
        F1.start_detector(uid, core_uid, host, backend)  # the reviewed ordered gate, then exactly one systemctl start
    except Refusal:
        if backend.starts == 0:  # refused by a gate BEFORE any start was issued: this attempt never started the detector
            journal["start_issued"] = False
            write_journal(work, journal)
        raise
    host.sleep(SETTLE_SEC)  # observation window only; never a second start
    verify_after_start(host, backend, journal, uid, core_uid)
    journal["phase"] = "complete"
    write_journal(work, journal)
    return {"F1_APPLY": "COMPLETE", "F1_UNIT_INSTALLED": "YES", "F1_UNIT_SHA256": journal["unit_sha256"], "F1_START_COUNT": "1", "F1_UNIT_ENABLED": "NO"}


def verify_after_start(host: F1Host, backend: F1Backend, journal: dict, uid: int, core_uid: int) -> None:
    verify_installed_file(host, journal)
    verify_loaded(backend, expect_active=True)
    gid = host.resolve_group(F1.ALERT_GROUP)
    if gid is None or gid <= 0:
        refuse("ALERT_GROUP_MISSING")
    F1.verify_socket(host, core_uid, uid, gid)  # the alert transport is still exactly as contracted
    verify_core_unchanged(host, backend, journal)


def verify(uid: int, core_uid: int, work: Path, host: F1Host, backend: F1Backend) -> dict[str, str]:
    """Read-only post-change check, repeatable. Issues no start, stop, reload or write."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") != "complete":
        refuse("ATTEMPT_NOT_COMPLETE")
    verify_after_start(host, backend, journal, uid, core_uid)
    return {"F1_VERIFY": "PASS", "F1_PRODUCTION_DEPLOYED": "YES", "F1_DETECTOR_STARTED": "YES", "F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN",
            "RECOVERY_R1_R8_PROVEN": "NO"}


# ── rollback ────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def rollback(work: Path, host: F1Host, backend: F1Backend) -> dict[str, str]:
    """Undo ONLY what this attempt journalled. Never the Core, core.env, users, groups or a pre-existing unit. Unknown state => refusal.

    stop (only if this attempt issued the start) -> prove the installed unit is still ours -> remove it -> daemon-reload -> prove not-found.
    """
    journal = read_journal(work)
    if journal is None or journal.get("phase") in (None, "preflight"):
        return {"F1_ROLLBACK": "NOTHING_OWNED"}  # no mutation was journalled: nothing may be touched (a pre-existing unit is never ours)
    if journal.get("phase") == "rolled_back":
        return {"F1_ROLLBACK": "ALREADY_ROLLED_BACK"}
    owned_file = journal.get("phase") in ("installing", "installed", "starting", "complete")
    if journal.get("start_issued"):
        if backend.systemctl("stop", DETECTOR_UNIT).rc != 0:
            refuse("DETECTOR_STOP_FAILED")
        if props(backend, DETECTOR_UNIT, DETECTOR_PROPS).get("ActiveState") not in ("inactive", "failed"):
            refuse("DETECTOR_STILL_ACTIVE")
    if owned_file and host.exists(UNIT_PATH):
        if journal.get("unit_ino") is None:
            refuse("ROLLBACK_UNIT_IDENTITY_UNKNOWN")  # crashed mid-install before the inode was journalled: owner decision
        verify_installed_file(host, journal)  # changed bytes / owner / mode / inode => refuse, leave the file for the owner
        host.unlink(UNIT_PATH)
    tmp = f"{UNIT_DIR}/.{DETECTOR_UNIT}.f1tmp"
    if owned_file and host.exists(tmp):
        host.unlink(tmp)
    if journal.get("daemon_reload") or owned_file:
        if backend.systemctl("daemon-reload").rc != 0:
            refuse("ROLLBACK_DAEMON_RELOAD_FAILED")
    if props(backend, DETECTOR_UNIT, DETECTOR_PROPS).get("LoadState") != "not-found":
        refuse("ROLLBACK_UNIT_STILL_LOADED")
    journal["phase"] = "rolled_back"
    write_journal(work, journal)
    return {"F1_ROLLBACK": "PASS"}


# ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("apply", "verify", "rollback"):
        sp = sub.add_parser(name)
        sp.add_argument("--work-dir", required=True)
        if name != "rollback":
            sp.add_argument("--uid", required=True)
        if name == "apply":
            sp.add_argument("--unit-sha256", required=True)
    args = parser.parse_args(argv)
    label = "F1_" + args.command.upper()
    try:
        if os.environ.get("AEGIS_F1_LIVE_AUTHORIZED") != "YES":
            refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
        if os.geteuid() != 0:
            refuse("ROOT_REQUIRED")
        work = require_work_dir(args.work_dir)
        host, backend = F1Host(), F1Backend()
        if args.command == "rollback":
            result = rollback(work, host, backend)
        else:
            uid = F1.parse_uid(args.uid)
            core_uid = F1._core_uid_from_passwd()
            result = apply(uid, core_uid, args.unit_sha256, work, host, backend) if args.command == "apply" else verify(uid, core_uid, work, host, backend)
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
