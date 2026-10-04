#!/usr/bin/env python3
"""F1u governed post-F1 Core upgrade: install ONE new immutable release, switch ``current`` OLD -> NEW, restart the Core EXACTLY ONCE, verify (repository tooling; authorizes nothing live).

Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> F1u -> [R1A: owner-approved model, NOT registered here] -> Recovery R2-R8 -> LVR -> L8 -> L9.

Why F1u exists: PR #342 (the Core ``ALERT_ACCEPTED`` implementation) is NEW Core runtime code. The running Core is an older process; the F1 detector was started by F1 and is a separate unit.
F1u owns ONLY: (1) install one new immutable release through the reviewed installer, (2) atomic ``current`` switch from the exact frozen OLD target to the exact frozen NEW target, (3) ONE
Core restart, (4) proof that the restarted Core runs from the NEW release (its working directory, never merely the ``current`` pointer), (5) proof of the detector lifecycle that the restart
causes. It never edits core.env, credentials, units, drop-ins, tmpfiles, groups, firewall, network, broker, IDEA1/IDEA2, an ESP32, incidents, the audit DB or Recovery state.

DETECTOR LIFECYCLE (owner amendment, OPTION A: ``F1U_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A``, ``F1U_DETECTOR_DEPENDENCY_CYCLE_OWNER_APPROVED=YES``). ``aegis-idea3-detector.service`` has ``Requires=`` +
``After=aegis-idea3-core.service``. Per systemd.unit(5), a plain ``systemctl restart aegis-idea3-core.service`` propagates a restart job to the running detector: D1 stops, the Core stops, the Core
starts from the NEW release, the detector starts again (D2). The unit files are NOT edited, no drop-in is added and NO job-mode override is used: the restart is the normal governed one. That
detector cycle is an EXPLICIT, owner-approved F1u-owned CONSEQUENCE of the one Core restart; it is not a replay of F1, not a second F1 attempt, not a detector deployment and not a hidden repair. The
backend therefore accepts EXACTLY one restart argv (the Core unit, nothing else) and ``systemctl show``; it can never start, stop or restart the detector unit itself (zero explicit detector
commands). After the restart the tool PROVES the lifecycle: D2 != D1, a newer start timestamp (and monotonic start, never before the Core's own), a changed InvocationID when systemd reports one, the
SAME reviewed unit bytes, the SAME pinned production_detector.py bytes, disabled, ``Restart=no``, exactly one detector process, and that the new process runs from the NEW release. ``NRestarts``
is NOT lifecycle evidence (``Restart=no``): it is only a no-restart-loop sanity value. Anything else (detector absent, wrong bytes, a second process, an unexplained identity) FAILS CLOSED and is never
repaired by F1u. Before the restart (and in a rollback that never reached it) the detector D1 must be exactly untouched.

Ownership: a journal in the attempt's private work directory records every owned step BEFORE it happens (installing, switching, restarting). Rollback acts only on that journal: before the restart it
restores ``current`` and removes ONLY the release this attempt installed (D1 untouched); after the restart was issued it restores ``current`` NEW -> OLD, restarts the Core at most once more (the
same plain argv, so the detector cycles AGAIN as the dependency consequence: D1 -> D2 -> D3 is acceptable only because every cycle is explained by an owned Core restart), proves the OLD runtime, and
removes ONLY the owned release after re-proving its journaled tree digest. Unknown or foreign state refuses before anything is changed. The rolled-back Core runs the OLD *current* release, which is
not necessarily the pre-F1u process image. Output is fixed reason codes and non-secret identifiers; core.env and credentials are never printed, hashed or journaled with content.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{filename}_MISSING")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


F1I = _load("p4_f1i_install", "p4-f1i-install.py")  # reviewed primitives: installer call, release facts, tree digest, material metadata, one-release removal
F1R = F1I.F1R
Refusal = F1R.Refusal
refuse = F1R.refuse
CommandResult = F1R.CommandResult

OPT_DIR = F1I.OPT_DIR
RELEASES_DIR = F1I.RELEASES_DIR
CURRENT = F1I.CURRENT
TMP_LINK = f"{OPT_DIR}/.current.f1u-tmp"
CORE_UNIT = F1R.CORE_UNIT
DETECTOR_UNIT = F1R.DETECTOR_UNIT
DETECTOR_UNIT_PATH = f"/etc/systemd/system/{DETECTOR_UNIT}"
DETECTOR_REL = F1R.DETECTOR_REL
RECOVERY_CORE_REL = "aegis_soc/recovery_core.py"
ACCEPT_MARKER = b"ALERT_ACCEPTED"  # the PR #342 Core ingress audit event: the new release must carry it
CORE_ENV = F1I.MATERIAL_FILE
CORE_USER = "aegis-idea3"
DETECTOR_USER = "aegis-idea3-detector"
RECOVERY_GROUP = "aegis-idea3-recovery"
ALERT_GROUP = "aegis-idea3-alert"
RECOVERY_DIR, RECOVERY_SOCK = "/run/aegis-idea3-recovery", "/run/aegis-idea3-recovery/recovery.sock"
ALERT_DIR, ALERT_SOCK = "/run/aegis-idea3-alert", "/run/aegis-idea3-alert/alert.sock"
ALERT_UID_KEY = "AEGIS_ALERT_SOURCE_UID"
JOURNAL_NAME = "f1u-journal.json"
#: The ONLY Core restart argv: the normal governed restart (OPTION A). systemd itself propagates the dependency jobs to the detector; F1u never addresses the detector unit.
RESTART_ARGS = ("restart", CORE_UNIT)
RESTART_TIMEOUT_SEC = 120.0
STABLE_SAMPLES = 3
STABLE_WAIT_SEC = 3.0
CORE_PROPS = ("LoadState", "ActiveState", "SubState", "UnitFileState", "Result", "MainPID", "NRestarts", "ExecMainStartTimestamp", "ExecMainStartTimestampMonotonic")
DETECTOR_PROPS = ("LoadState", "ActiveState", "SubState", "UnitFileState", "Restart", "Result", "MainPID", "NRestarts", "ExecMainStartTimestamp", "ExecMainStartTimestampMonotonic",
                  "ActiveEnterTimestamp", "InvocationID", "FragmentPath", "DropInPaths")
CORE_HEALTHY = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success"}
SHA256_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
ENV_UID_RE = re.compile(rf"^{ALERT_UID_KEY}=([1-9][0-9]{{0,9}})$", re.MULTILINE)

# Journal phases and what they MEAN for rollback (ownership is a strict state boundary):
UNOWNED_PHASES = ("installing", "installer_failed")  # no durable proof a release was installed: NEVER deletion authority
SWITCH_PHASES = ("switching", "switched", "restarting", "restarted", "applied")  # `current` may point at NEW
RESTART_PHASES = ("restarting", "restarted", "applied")  # the Core may have been restarted onto NEW
OWNED_PHASES = ("installed", *SWITCH_PHASES)  # the release is ours (journaled tree digest)
KNOWN_PHASES = ("preflight", *UNOWNED_PHASES, *OWNED_PHASES, "rolled_back")


def release_path(rid: str) -> str:
    return f"{RELEASES_DIR}/{rid}"


@dataclass(frozen=True)
class Pins:
    old_id: str
    new_id: str
    source_dir: str
    source_sha: str
    detector_sha: str
    core_sha: str
    unit_sha: str


def validate_pins(pins: Pins) -> None:
    F1R.release_id(pins.old_id)
    F1R.release_id(pins.new_id)
    if pins.old_id == pins.new_id:
        refuse("RELEASE_IDS_NOT_DISTINCT")
    F1R.source_sha_pin(pins.source_sha)
    F1R.detector_sha_pin(pins.detector_sha)
    if not SHA256_RE.fullmatch(pins.core_sha):
        refuse("RECOVERY_CORE_SHA256_PIN_INVALID")
    if not SHA256_RE.fullmatch(pins.unit_sha):
        refuse("DETECTOR_UNIT_SHA256_PIN_INVALID")
    F1I._valid_source_dir(pins.source_dir)


# ── the only privileged surface ──────────────────────────────────────────────────────────────────────────────────────────────


class F1uBackend(F1I.F1iBackend):
    """Inherited: read-only ``systemctl show`` of the Core/detector units and the ONE reviewed-installer process. Added: the single Core restart argv ``RESTART_ARGS`` (at most once per process).
    Everything else (stop, start, try-restart, reload, daemon-reload, kill, enable, ANY job-mode option, ANY action on the detector unit) is refused."""

    def __init__(self) -> None:
        super().__init__()
        self.restarts = 0

    @staticmethod
    def allowed(args: tuple[str, ...]) -> bool:
        return args == RESTART_ARGS or F1R.F1rBackend.allowed(args)

    def systemctl(self, *args: str) -> CommandResult:
        if args == RESTART_ARGS:
            if self.restarts >= 1:
                refuse("CORE_RESTART_ALREADY_INVOKED")  # exactly one intentional restart invocation per process
            self.restarts += 1
            self.calls.append(args)
            return self._run(args, timeout=RESTART_TIMEOUT_SEC)
        return super().systemctl(*args)

    def _run(self, args: tuple[str, ...], timeout: float = F1R.SHOW_TIMEOUT_SEC) -> CommandResult:
        try:
            done = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return CommandResult(124, "")
        return CommandResult(done.returncode, done.stdout)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


class F1uHost(F1I.F1iHost):
    """F1iHost plus the one pointer switch (the F1i class disables it) and the read-only process/socket/identity proofs."""

    def symlink(self, target: str, path: str) -> None:
        os.symlink(target, path)

    def replace(self, src: str, dst: str) -> None:
        os.replace(src, dst)

    def unlink(self, path: str) -> None:
        os.unlink(path)

    def fsync_dir(self, path: str) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def identity(self, path: str) -> dict | None:
        info = self._lstat(path)
        if info is None:
            return None
        mode = info.st_mode
        kind = "dir" if stat.S_ISDIR(mode) else "socket" if stat.S_ISSOCK(mode) else "file" if stat.S_ISREG(mode) else "symlink" if stat.S_ISLNK(mode) else "other"
        return {"kind": kind, "mode": stat.S_IMODE(mode), "uid": info.st_uid, "gid": info.st_gid}

    def account(self, name: str) -> tuple[int, int] | None:
        try:
            row = pwd.getpwnam(name)
        except KeyError:
            return None
        return row.pw_uid, row.pw_gid

    def group_gid(self, name: str) -> int | None:
        try:
            import grp
            return grp.getgrnam(name).gr_gid
        except (KeyError, ImportError):
            return None

    def proc_groups(self, pid: int) -> list[int]:
        try:
            text = Path(f"/proc/{int(pid)}/status").read_text(encoding="utf-8")
        except OSError:
            refuse("CORE_PROCESS_UNREADABLE")
        match = re.search(r"^Groups:\s*(.*)$", text, re.MULTILINE)
        if not match:
            refuse("CORE_PROCESS_UNREADABLE")
        return [int(x) for x in match.group(1).split() if x.isdigit()]

    def proc_environ_value(self, pid: int, key: str) -> str | None:
        try:
            data = Path(f"/proc/{int(pid)}/environ").read_bytes()
        except OSError:
            refuse("CORE_PROCESS_UNREADABLE")
        for item in data.split(b"\0"):
            name, _, value = item.partition(b"=")
            if name == key.encode():
                return value.decode("utf-8", "replace")
        return None

    def proc_socket_inodes(self, pid: int) -> set[int]:
        found: set[int] = set()
        base = f"/proc/{int(pid)}/fd"
        try:
            names = os.listdir(base)
        except OSError:
            refuse("CORE_PROCESS_UNREADABLE")
        for name in names:
            try:
                target = os.readlink(f"{base}/{name}")
            except OSError:
                continue  # an fd closed during the listing
            match = re.fullmatch(r"socket:\[(\d+)\]", target)
            if match:
                found.add(int(match.group(1)))
        return found

    def unix_listener_inodes(self, path: str) -> set[int]:
        """Inodes of LISTENING AF_UNIX sockets bound to exactly ``path`` (read of /proc/net/unix). Nothing connects, so no alert and no audit row can ever be created."""
        try:
            lines = Path("/proc/net/unix").read_text(encoding="utf-8", errors="replace").splitlines()[1:]
        except OSError:
            refuse("PROC_NET_UNIX_UNREADABLE")
        found: set[int] = set()
        for line in lines:
            parts = line.split()
            if len(parts) >= 8 and parts[7] == path and int(parts[3], 16) & 0x10000 and parts[6].isdigit():  # __SO_ACCEPTCON
                found.add(int(parts[6]))
        return found


# ── Core / detector state ────────────────────────────────────────────────────────────────────────────────────────────────────


def core_state(host, backend) -> dict:
    props = F1R.props(backend, CORE_UNIT, CORE_PROPS)
    pid = props.get("MainPID", "")
    state = {k: props.get(k, "") for k in CORE_PROPS}
    state["cwd"] = host.proc_cwd(int(pid)) if pid.isdigit() and int(pid) > 0 else None
    return state


def core_healthy(state: dict) -> bool:
    return (all(state.get(k) == v for k, v in CORE_HEALTHY.items()) and state.get("NRestarts") == "0"
            and state.get("MainPID", "").isdigit() and int(state["MainPID"]) > 0)


def check_core_pre(host, backend, pins: Pins) -> dict:
    state = core_state(host, backend)
    if not core_healthy(state):
        refuse("CORE_PRESTATE_NOT_HEALTHY")
    cwd = state["cwd"]
    if cwd is None:
        refuse("CORE_CWD_UNREADABLE")
    if os.path.dirname(cwd) != RELEASES_DIR or cwd == release_path(pins.new_id):
        refuse("CORE_PRESTATE_RELEASE_UNEXPECTED")
    return state


def wait_core_stable(host, backend, *, not_pid: str | None) -> dict:
    """Several samples after a restart: healthy, a NEW MainPID, NRestarts 0 and the identical (PID, start timestamp) across samples (a crash loop or a second restart is refused)."""
    first = None
    state: dict = {}
    for index in range(max(1, STABLE_SAMPLES)):
        if index:
            backend.sleep(STABLE_WAIT_SEC)
        state = core_state(host, backend)
        if not core_healthy(state):
            refuse("CORE_NOT_HEALTHY")
        if not_pid is not None and state["MainPID"] == not_pid:
            refuse("CORE_NOT_RESTARTED")
        sample = (state["MainPID"], state["ExecMainStartTimestamp"])
        if first is not None and sample != first:
            refuse("CORE_NOT_HEALTHY:UNSTABLE")
        first = sample
    return state


def detector_state(host, backend) -> dict:
    props = F1R.props(backend, DETECTOR_UNIT, DETECTOR_PROPS)
    state = {k: props.get(k, "") for k in DETECTOR_PROPS}
    pid = state["MainPID"]
    state["cwd"] = host.proc_cwd(int(pid)) if pid.isdigit() and int(pid) > 0 else None
    state["unit_sha256"] = host.sha256_file(DETECTOR_UNIT_PATH) if host.is_regular(DETECTOR_UNIT_PATH) else "ABSENT"
    source = f"{state['cwd']}/{DETECTOR_REL}" if state["cwd"] else ""
    state["source_sha256"] = host.sha256_file(source) if source and host.is_regular(source) else "ABSENT"
    state["processes"] = host.detector_processes()
    return state


def detector_invariants(state: dict, pins: Pins) -> None:
    """What must hold for EVERY detector process of this stage (D1, D2, D3): the reviewed unit and source bytes, disabled, ``Restart=no``, no drop-in, exactly one process. Independent of identity."""
    pid = state["MainPID"]
    if not (state["LoadState"] == "loaded" and state["ActiveState"] == "active" and state["SubState"] == "running" and state["Result"] == "success"):
        refuse("DETECTOR_NOT_RUNNING")
    if not pid.isdigit() or int(pid) <= 0:
        refuse("DETECTOR_MAINPID_INVALID")
    if state["NRestarts"] != "0":
        refuse("DETECTOR_NRESTARTS_NOT_ZERO")  # sanity only (Restart=no): NOT evidence that the unit survived anything
    if state["UnitFileState"] != "disabled" or state["Restart"] != "no":
        refuse("DETECTOR_UNIT_CONTRACT_MISMATCH")
    if state["FragmentPath"] != DETECTOR_UNIT_PATH or state["DropInPaths"].strip():
        refuse("DETECTOR_UNIT_PATH_OR_DROPIN_UNEXPECTED")
    if state["unit_sha256"] != pins.unit_sha:
        refuse("DETECTOR_UNIT_SHA256_MISMATCH")
    if state["source_sha256"] != pins.detector_sha:
        refuse("DETECTOR_SOURCE_SHA256_MISMATCH")  # the running detector's own release carries exactly the reviewed production_detector.py bytes
    if state["processes"] != [int(pid)]:
        refuse("DETECTOR_PROCESS_SET_UNEXPECTED")  # a standalone second detector, a duplicate, or none


def check_detector_pre(state: dict, pins: Pins) -> None:
    """D1: the detector F1 started, with its true process/release boundary (cwd) = the OLD release it was started from (WorkingDirectory is resolved at start)."""
    detector_invariants(state, pins)
    if state["cwd"] != release_path(pins.old_id):
        refuse("DETECTOR_RELEASE_BOUNDARY_UNEXPECTED")


def detector_unchanged(host, backend, recorded: dict) -> None:
    """Before the restart (and in a rollback that never reached it): D1 is EXACTLY as recorded on every field (MainPID, start/active timestamps, InvocationID, cwd, unit/source digests). Any drift fails closed."""
    now = detector_state(host, backend)
    for key in sorted(recorded):
        if now.get(key) != recorded[key]:
            refuse(f"DETECTOR_DRIFT:{key}")


def _mono(value: str) -> int | None:
    return int(value) if value.isdigit() else None


def check_detector_cycled(host, backend, pins: Pins, prior: dict, core: dict, runtime: str) -> dict:
    """AFTER an owned Core restart: the detector is a NEW, healthy process that systemd started as the dependency consequence, running from ``runtime``. D(new) != D(prior); a newer start; a changed
    InvocationID when systemd reports one; started no earlier than the Core's own new start (``After=``). Returns the observed state (stable across two reads)."""
    now = detector_state(host, backend)
    detector_invariants(now, pins)
    if prior["MainPID"] == now["MainPID"]:
        refuse("DETECTOR_NOT_CYCLED_BY_CORE_RESTART")  # an unchanged identity after an owned restart is unexplained: investigate, never accept
    if prior["ExecMainStartTimestamp"] and prior["ExecMainStartTimestamp"] == now["ExecMainStartTimestamp"]:
        refuse("DETECTOR_START_TIMESTAMP_NOT_NEWER")
    before, after = _mono(prior["ExecMainStartTimestampMonotonic"]), _mono(now["ExecMainStartTimestampMonotonic"])
    if after is None or (before is not None and after <= before):
        refuse("DETECTOR_START_TIMESTAMP_NOT_NEWER")
    core_start = _mono(core["ExecMainStartTimestampMonotonic"])
    if core_start is not None and after < core_start:
        refuse("DETECTOR_STARTED_BEFORE_CORE")
    if prior["InvocationID"] and prior["InvocationID"] == now["InvocationID"]:
        refuse("DETECTOR_INVOCATION_NOT_CHANGED")
    if now["cwd"] != runtime:
        refuse("DETECTOR_NOT_ON_EXPECTED_RUNTIME")  # a NEW process, but not running from the release this stage put the Core on
    if detector_state(host, backend) != now:
        refuse("DETECTOR_UNSTABLE")
    return now


# ── release / runtime checks ─────────────────────────────────────────────────────────────────────────────────────────────────


def check_runtime_marker(host, release_dir: str, core_sha: str) -> None:
    """The Core runtime in the release is exactly the pinned reviewed bytes and carries the PR #342 ``ALERT_ACCEPTED`` implementation."""
    path = f"{release_dir}/{RECOVERY_CORE_REL}"
    if not host.is_regular(path):
        refuse("RECOVERY_CORE_FILE_INVALID")
    if host.sha256_file(path) != core_sha:
        refuse("RECOVERY_CORE_SHA256_MISMATCH")
    if ACCEPT_MARKER not in host.read_bytes(path):
        refuse("ALERT_ACCEPTED_IMPLEMENTATION_MISSING")


def check_source_release(host, pins: Pins) -> None:
    F1I.check_source_release(host, pins.source_dir, pins.new_id, pins.source_sha, pins.detector_sha)
    check_runtime_marker(host, pins.source_dir, pins.core_sha)


def check_installed_release(host, pins: Pins) -> None:
    F1I.check_installed_release(host, pins.new_id, pins.source_sha, pins.detector_sha)
    check_runtime_marker(host, release_path(pins.new_id), pins.core_sha)


def check_old_release(host, pins: Pins) -> None:
    F1I.check_current_release(host, pins.old_id)
    old_detector = f"{release_path(pins.old_id)}/{DETECTOR_REL}"
    if not host.is_regular(old_detector) or host.sha256_file(old_detector) != pins.detector_sha:
        refuse("OLD_RELEASE_DETECTOR_SHA256_MISMATCH")  # the running detector's release carries exactly the reviewed bytes; the NEW one must be byte-identical (pinned above)


def alert_uid_contract(host, core_pid: int) -> None:
    """core.env carries exactly one AEGIS_ALERT_SOURCE_UID, it is the dedicated detector account's uid (never root or the Core account), and the RUNNING Core carries the same value."""
    match = ENV_UID_RE.findall(host.read_bytes(CORE_ENV).decode("utf-8", "replace"))
    detector, core = host.account(DETECTOR_USER), host.account(CORE_USER)
    if len(match) != 1 or detector is None or core is None or detector[0] != int(match[0]) or detector[0] in (0, core[0]):
        refuse("ALERT_UID_CONTRACT_MISMATCH")
    if host.proc_environ_value(core_pid, ALERT_UID_KEY) != match[0]:
        refuse("CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID")


def check_surfaces(host, core_pid: int) -> None:
    """Recovery and alert transport after (and before) the restart: exact type/owner/group/mode, the Core process carries the group AND holds the listening socket itself (read-only /proc proof;
    nothing connects, so no synthetic alert and no audit row)."""
    core = host.account(CORE_USER)
    if core is None:
        refuse("CORE_ACCOUNT_MISSING")
    groups = host.proc_groups(core_pid)
    held = host.proc_socket_inodes(core_pid)
    for label, group, directory, dir_mode, sock, sock_mode in (("RECOVERY", RECOVERY_GROUP, RECOVERY_DIR, 0o750, RECOVERY_SOCK, 0o660),
                                                               ("ALERT", ALERT_GROUP, ALERT_DIR, 0o2750, ALERT_SOCK, 0o620)):
        gid = host.group_gid(group)
        if gid is None:
            refuse(f"{label}_GROUP_MISSING")
        meta = host.identity(directory)
        if meta is None or (meta["kind"], meta["mode"], meta["uid"], meta["gid"]) != ("dir", dir_mode, core[0], gid):
            refuse(f"{label}_RUNTIME_DIR_METADATA_INVALID")
        meta = host.identity(sock)
        if meta is None:
            refuse(f"{label}_SOCKET_MISSING")
        if (meta["kind"], meta["mode"], meta["uid"], meta["gid"]) != ("socket", sock_mode, core[0], gid):
            refuse(f"{label}_SOCKET_METADATA_INVALID")
        if gid not in groups:
            refuse(f"CORE_PROCESS_LACKS_{label}_GROUP")
        if not (host.unix_listener_inodes(sock) & held):
            refuse(f"{label}_SOCKET_NOT_SERVED_BY_CORE")
    alert_uid_contract(host, core_pid)


def reprove_prestate(host, backend, journal: dict) -> None:
    """Immediately before an owned mutation: the SAME Core process and the SAME detector, both untouched so far."""
    now = core_state(host, backend)
    pre = journal["core"]
    if not core_healthy(now) or any(now[k] != pre[k] for k in ("MainPID", "NRestarts", "ExecMainStartTimestamp")):
        refuse("CORE_RESTARTED_OR_REPLACED")
    detector_unchanged(host, backend, journal["detector"])


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
    if not isinstance(data, dict) or data.get("stage") != "F1u":
        refuse("JOURNAL_UNEXPECTED")
    return data


def pins_from_journal(journal: dict, source_dir: str = "/unused") -> Pins:
    return Pins(journal["old_release_id"], journal["new_release_id"], source_dir, journal["source_sha"], journal["detector_sha"], journal["core_sha"], journal["unit_sha"])


# ── preflight (read-only) ────────────────────────────────────────────────────────────────────────────────────────────────────


def preflight(host, backend, pins: Pins) -> dict:
    """Every pre-mutation gate. Returns the non-secret facts the journal records. Mutates nothing and creates no alert."""
    validate_pins(pins)
    F1I.check_parents(host)
    old_target = F1I.check_current_expected(host, pins.old_id)
    check_old_release(host, pins)
    F1I.check_target_absent(host, pins.new_id)
    if host.lexists(TMP_LINK):
        refuse("SWITCH_TEMP_EXISTS")
    check_source_release(host, pins)
    core = check_core_pre(host, backend, pins)
    detector = detector_state(host, backend)
    check_detector_pre(detector, pins)
    check_surfaces(host, int(core["MainPID"]))
    return {"old_target": old_target, "new_target": release_path(pins.new_id), "core": core, "detector": detector, "material": F1I.material_metadata(host)}


# ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _atomic_point(host, target: str) -> None:
    """symlink to ``target`` at the temp name, rename it over ``current``, fsync the directory. ``current`` is never absent."""
    host.symlink(target, TMP_LINK)
    host.replace(TMP_LINK, CURRENT)
    host.fsync_dir(OPT_DIR)


def _current_is(host, target: str) -> bool:
    return host.is_symlink(CURRENT) and host.readlink(CURRENT) == target and host.realpath(CURRENT) == target


def verify_runtime(host, backend, journal: dict, pins: Pins, *, expect_core_pid: str | None, expect_detector: dict | None) -> tuple[dict, dict]:
    """After the restart: the Core is healthy and stable on a NEW MainPID and its working directory IS the NEW release (the pointer alone proves nothing); the Recovery/alert surfaces are served by that
    very process; the detector is the dependency-cycled D2 running from the NEW release. ``expect_*`` (verify) pin the identities recorded at the end of apply: nothing may have cycled again."""
    core = wait_core_stable(host, backend, not_pid=journal["core"]["MainPID"])
    if expect_core_pid is not None and core["MainPID"] != expect_core_pid:
        refuse("CORE_RESTARTED_AGAIN_AFTER_APPLY")
    if core["cwd"] != release_path(pins.new_id):
        refuse("CORE_NOT_RUNNING_FROM_NEW_RELEASE")
    check_surfaces(host, int(core["MainPID"]))
    if expect_detector is None:
        detector = check_detector_cycled(host, backend, pins, journal["detector"], core, release_path(pins.new_id))
    else:
        detector = detector_state(host, backend)
        detector_invariants(detector, pins)
        if detector["cwd"] != release_path(pins.new_id):
            refuse("DETECTOR_NOT_ON_EXPECTED_RUNTIME")
        for key in sorted(expect_detector):
            if detector.get(key) != expect_detector[key]:
                refuse(f"DETECTOR_CYCLED_AGAIN_AFTER_APPLY:{key}")
    return core, detector


def apply(pins: Pins, work: Path, host, backend) -> dict[str, str]:
    """preflight -> journal -> re-prove -> installer ONCE -> journal -> switch ONCE -> journal -> Core restart ONCE -> runtime and detector-lifecycle proofs -> journal. No retry."""
    if read_journal(work) is not None:
        refuse("ATTEMPT_JOURNAL_ALREADY_EXISTS")  # one attempt per work directory
    facts = preflight(host, backend, pins)
    journal = {"stage": "F1u", "phase": "preflight", "old_release_id": pins.old_id, "new_release_id": pins.new_id, "source_sha": pins.source_sha, "detector_sha": pins.detector_sha,
               "core_sha": pins.core_sha, "unit_sha": pins.unit_sha, **facts, "restart_invocations": 0, "rollback_restart_invoked": False, "material_content_preserved": False}
    write_journal(work, journal)  # the exact prestate is on disk before anything changes
    target = facts["new_target"]
    try:
        before_content = F1I.material_content(host)  # secret CONTENT stays in this process's memory only
        F1I.check_target_absent(host, pins.new_id)
        F1I.check_current_expected(host, pins.old_id)
        reprove_prestate(host, backend, journal)
        journal["phase"] = "installing"
        write_journal(work, journal)  # BEFORE the installer: from here a release may exist and is ours
        result = backend.run_installer(pins.new_id, pins.source_dir, target, str(work / "install-evidence.tsv"))
        if result.rc != 0:
            match = F1I.REASON_RE.search(result.out or "")
            reason = match.group(1) if match and F1I.SAFE_REASON_RE.fullmatch(match.group(1)) else "UNKNOWN"
            journal.update(phase="installer_failed", installer_rc=int(result.rc), installer_reason=reason)
            write_journal(work, journal)  # a failure is evidence, never ownership
            refuse(f"INSTALL_FAILED:{reason}")
        check_installed_release(host, pins)
        journal.update(phase="installed", release_tree_digest=host.tree_digest(target))
        write_journal(work, journal)
        F1I.check_current_expected(host, pins.old_id)
        reprove_prestate(host, backend, journal)
        if host.lexists(TMP_LINK):
            refuse("SWITCH_TEMP_EXISTS")  # never adopt a name this attempt did not create
        journal["phase"] = "switching"
        write_journal(work, journal)  # BEFORE the switch
        _atomic_point(host, target)
        journal["phase"] = "switched"
        write_journal(work, journal)
        if not _current_is(host, target):
            refuse("CURRENT_NOT_NEW_TARGET_AFTER_SWITCH")
        reprove_prestate(host, backend, journal)  # the Core and the detector are still untouched immediately before the restart
        journal.update(phase="restarting", restart_invocations=1)
        write_journal(work, journal)  # BEFORE the restart: from here the Core may be on NEW
        if backend.systemctl(*RESTART_ARGS).rc != 0:
            refuse("CORE_RESTART_FAILED")
        journal["phase"] = "restarted"
        write_journal(work, journal)
        state, detector = verify_runtime(host, backend, journal, pins, expect_core_pid=None, expect_detector=None)
        if F1I.material_metadata(host) != facts["material"]:
            refuse("MATERIAL_METADATA_DRIFT")
        if F1I.material_content(host) != before_content:
            refuse("MATERIAL_CONTENT_DRIFT")  # a fixed reason: no value, path or digest is ever printed
        del before_content
        journal.update(phase="applied", material_content_preserved=True, core_post={"MainPID": state["MainPID"], "ExecMainStartTimestamp": state["ExecMainStartTimestamp"]},
                       detector_post=detector)
        write_journal(work, journal)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    return {"F1U_APPLY": "COMPLETE", "NEW_RELEASE_ID": pins.new_id, "CURRENT_TARGET": target, "OLD_TARGET": facts["old_target"], "F1U_CORE_RESTART_INVOCATIONS": "1",
            "F1U_EXPLICIT_DETECTOR_COMMANDS": "0", "F1U_DETECTOR_CYCLED_BY_CORE_RESTART": "YES"}


# ── verify (read-only) ───────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(pins: Pins, work: Path, host, backend) -> dict[str, str]:
    journal = read_journal(work)
    if journal is None or journal.get("phase") != "applied" or journal.get("material_content_preserved") is not True:
        refuse("ATTEMPT_NOT_APPLIED")
    if pins_from_journal(journal, pins.source_dir) != pins:
        refuse("ATTEMPT_PINS_MISMATCH")
    if journal.get("restart_invocations") != 1:
        refuse("CORE_RESTART_COUNT_NOT_ONE")
    new_target = journal["new_target"]
    if not _current_is(host, new_target):
        refuse("CURRENT_NOT_NEW_TARGET")
    if host.lexists(TMP_LINK):
        refuse("SWITCH_TEMP_EXISTS")
    check_installed_release(host, pins)
    if host.tree_digest(new_target) != journal["release_tree_digest"]:
        refuse("RELEASE_TREE_CHANGED")
    check_old_release(host, pins)  # the OLD release still exists and is unaltered
    verify_runtime(host, backend, journal, pins, expect_core_pid=journal["core_post"]["MainPID"], expect_detector=journal["detector_post"])
    if F1I.material_metadata(host) != journal["material"]:
        refuse("MATERIAL_METADATA_DRIFT")
    return {"F1U_VERIFY": "PASS", "CURRENT_TARGET": new_target, "NEW_RELEASE_GUARD": "PASS", "NEW_RELEASE_SOURCE_SHA": pins.source_sha, "PRODUCTION_DETECTOR_SHA256": pins.detector_sha,
            "RECOVERY_CORE_SHA256": pins.core_sha, "CORE_RUNNING_FROM_NEW_RELEASE": "YES", "CORE_RESTARTED_ONCE": "YES", "ALERT_SOCKET_SERVED_BY_CORE": "YES",
            "RECOVERY_SOCKET_SERVED_BY_CORE": "YES", "DETECTOR_RUNNING_FROM_NEW_RELEASE": "YES", "DETECTOR_CYCLED_BY_CORE_RESTART": "YES", "DETECTOR_UNIT_AND_SOURCE_UNCHANGED": "YES",
            "L7_MATERIAL_PRESERVED": "YES"}


# ── rollback ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def rollback(work: Path, host, backend) -> dict[str, str]:
    """Undo ONLY what this attempt journalled: `current` back to OLD, ONE bounded Core restart onto OLD when the Core was (or may have been) restarted, then removal of ONLY the release this attempt
    installed. Before the Core restart was issued the detector D1 is untouched; after it, the detector may legitimately cycle again as the Requires= consequence of the rollback restart (D1 -> D2 -> D3):
    that is accepted ONLY with the lifecycle proof. F1u never addresses the detector unit itself, never touches a foreign release or pointer, nor core.env/credentials/Recovery/audit. Foreign state
    refuses before anything changes; restored first, drift escalated."""
    journal = read_journal(work)
    if journal is None or journal.get("phase") == "preflight":
        return {"F1U_ROLLBACK": "NOTHING_OWNED"}
    phase = journal.get("phase")
    if phase == "rolled_back":
        return {"F1U_ROLLBACK": "ALREADY_ROLLED_BACK"}
    if phase not in KNOWN_PHASES:
        refuse("JOURNAL_PHASE_UNKNOWN")  # fail closed on any state this tool did not write
    pins = pins_from_journal(journal)
    old_target, new_target = journal["old_target"], journal["new_target"]
    old_path, new_path = release_path(pins.old_id), release_path(pins.new_id)
    pre = journal["core"]
    if host.temp_residue(RELEASES_DIR, pins.new_id):
        refuse("INSTALL_TEMP_RESIDUE")
    if not host.is_symlink(CURRENT):
        refuse("CURRENT_NOT_A_SYMLINK")
    now = host.readlink(CURRENT)
    if now != old_target and not (phase in SWITCH_PHASES and now == new_target):
        refuse("CURRENT_NOT_OWNED_BY_THIS_ATTEMPT")  # another actor changed `current`: left exactly as found
    if host.lexists(TMP_LINK):
        if not (phase == "switching" and now == old_target and host.is_symlink(TMP_LINK) and host.readlink(TMP_LINK) == new_target):
            refuse("SWITCH_TEMP_NOT_OWNED_BY_THIS_ATTEMPT")
        host.unlink(TMP_LINK)
    # 1. the pointer
    try:
        if now == new_target:
            journal["rollback_step"] = "repointing"
            write_journal(work, journal)
            _atomic_point(host, old_target)
    except OSError as exc:
        refuse(f"IO:{type(exc).__name__}")
    if not _current_is(host, old_target):
        refuse("CURRENT_NOT_OLD_TARGET_AFTER_ROLLBACK")
    # 2. the Core
    restarted = False
    detector_prior: dict | None = None  # the detector as observed right before the rollback's own Core restart
    state = core_state(host, backend)
    unchanged = core_healthy(state) and all(state[k] == pre[k] for k in ("MainPID", "NRestarts", "ExecMainStartTimestamp"))
    if phase in RESTART_PHASES:
        if unchanged or (core_healthy(state) and state["cwd"] == old_path):
            pass  # the restart never happened (or the Core already runs the OLD release): nothing to restart
        elif state["cwd"] == new_path or not core_healthy(state):
            if journal.get("rollback_restart_invoked"):
                refuse("ROLLBACK_RESTART_ALREADY_INVOKED")  # no retry
            detector_prior = detector_state(host, backend)
            journal["rollback_restart_invoked"] = True
            write_journal(work, journal)  # BEFORE the restart
            if backend.systemctl(*RESTART_ARGS).rc != 0:
                refuse("CORE_RESTART_FAILED_DURING_ROLLBACK")
            state = wait_core_stable(host, backend, not_pid=state["MainPID"] if state["MainPID"] != "0" else None)
            if state["cwd"] != old_path:
                refuse("CORE_NOT_ON_OLD_RELEASE_AFTER_ROLLBACK")
            check_surfaces(host, int(state["MainPID"]))
            restarted = True
        else:
            refuse("CORE_FOREIGN_RUNTIME_REFUSING_ROLLBACK")
    elif not unchanged:
        refuse("CORE_DRIFT_DURING_ROLLBACK")  # F1u never restarted the Core in this phase
    # 3. the release (ownership = a journaled tree digest, re-proved)
    target_present = host.lexists(new_path)
    if phase in UNOWNED_PHASES:
        if target_present:
            refuse("INSTALL_OUTCOME_UNKNOWN" if phase == "installing" else "FOREIGN_OR_UNPROVEN_TARGET")  # never delete what this attempt cannot prove it installed
    elif phase in OWNED_PHASES and target_present:
        digest = journal.get("release_tree_digest")
        if not isinstance(digest, str) or not digest:
            refuse("JOURNAL_OWNERSHIP_UNPROVEN")
        if not host.is_real_dir(new_path):
            refuse("RELEASE_PATH_NOT_A_DIRECTORY")
        try:
            check_installed_release(host, pins)
        except Refusal as exc:
            refuse(f"RELEASE_DRIFTED_REFUSING_ROLLBACK:{exc}")
        if host.tree_digest(new_path) != digest:
            refuse("RELEASE_DRIFTED_REFUSING_ROLLBACK:TREE_DIGEST_MISMATCH")
        if state["cwd"] == new_path:
            refuse("CORE_STILL_RUNNING_FROM_NEW_RELEASE")  # never delete the release the running Core executes from
        try:
            host.remove_release_tree(new_path)
        except OSError as exc:
            refuse(f"IO:{type(exc).__name__}")
        if host.lexists(new_path):
            refuse("RELEASE_RESIDUE")
    journal["phase"] = "rolled_back"
    write_journal(work, journal)
    # 4. postconditions: restored first, then any drift is escalated
    F1I.check_parents(host)
    if not _current_is(host, old_target):
        refuse("CURRENT_NOT_OLD_TARGET_AFTER_ROLLBACK")
    check_old_release(host, pins)
    final = core_state(host, backend)
    if not core_healthy(final):
        refuse("CORE_DRIFT_DURING_ROLLBACK")
    try:
        if detector_prior is not None:  # this rollback restarted the Core: the detector must have cycled again, healthy, on the restored OLD runtime
            check_detector_cycled(host, backend, pins, detector_prior, final, old_path)
        elif phase in RESTART_PHASES and not unchanged:  # the Core was restarted before (by apply) and is already on OLD: identity unknown, invariants + OLD runtime must hold
            detector_invariants(detector_state(host, backend), pins)
            if detector_state(host, backend)["cwd"] != old_path:
                refuse("DETECTOR_NOT_ON_EXPECTED_RUNTIME")
        else:  # the Core was never restarted: D1 must be exactly untouched
            detector_unchanged(host, backend, journal["detector"])
    except Refusal as exc:
        refuse(f"DETECTOR_DRIFT_DURING_ROLLBACK:{exc}")
    if F1I.material_metadata(host) != journal["material"]:
        refuse("MATERIAL_METADATA_DRIFT")
    return {"F1U_ROLLBACK": "PASS", "CURRENT_TARGET": old_target, "NEW_RELEASE_ABSENT": "YES" if not host.lexists(new_path) else "NO", "CORE_RESTARTED_FOR_ROLLBACK": "YES" if restarted else "NO",
            "DETECTOR_HEALTHY_AND_UNCHANGED_IN_CODE_AND_UNIT": "YES", "DETECTOR_CYCLED_AGAIN_BY_ROLLBACK_RESTART": "YES" if restarted else "NO"}


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def pin_args(sp, work: bool, source: bool) -> None:
        if work:
            sp.add_argument("--work-dir", required=True)
        sp.add_argument("--old-release-id", required=True)
        sp.add_argument("--new-release-id", required=True)
        sp.add_argument("--source-dir", required=source, default="/unused")
        sp.add_argument("--source-sha", required=True)
        sp.add_argument("--detector-sha256", required=True)
        sp.add_argument("--recovery-core-sha256", required=True)
        sp.add_argument("--detector-unit-sha256", required=True)

    pin_args(sub.add_parser("check"), work=False, source=True)  # read-only preflight (run through sudo for root read authority); no live flag, no write, no alert
    pin_args(sub.add_parser("apply"), work=True, source=True)
    pin_args(sub.add_parser("verify"), work=True, source=False)
    sub.add_parser("rollback").add_argument("--work-dir", required=True)
    args = parser.parse_args(argv)
    label = "F1U_" + args.command.upper()
    try:
        host, backend = F1uHost(), F1uBackend()
        if args.command == "rollback":
            pins = None
        else:
            pins = Pins(args.old_release_id, args.new_release_id, args.source_dir, args.source_sha, args.detector_sha256, args.recovery_core_sha256, args.detector_unit_sha256)
        if args.command == "check":
            facts = preflight(host, backend, pins)
            result = {"F1U_CHECK": "PASS", "CURRENT_TARGET": facts["old_target"], "NEW_RELEASE_ABSENT": "YES", "SOURCE_RELEASE_GUARD": "PASS", "CORE_RUNNING": "YES",
                      "DETECTOR_RUNNING_BASELINE": "YES", "ALERT_AND_RECOVERY_SURFACES": "SERVED_BY_CORE"}
        else:
            if os.environ.get("AEGIS_F1U_LIVE_AUTHORIZED") != "YES":
                refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
            if os.geteuid() != 0:
                refuse("ROOT_REQUIRED")
            work = F1R.require_work_dir(args.work_dir)
            if args.command == "rollback":
                result = rollback(work, host, backend)
            elif args.command == "apply":
                result = apply(pins, work, host, backend)
            else:
                result = verify(pins, work, host, backend)
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
