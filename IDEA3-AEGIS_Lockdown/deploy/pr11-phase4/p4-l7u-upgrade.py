#!/usr/bin/env python3
"""L7u — Post-L7 Recovery Core upgrade engine (repository tooling; no live execution is authorized by merging this file).

Authority: docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md.

Stage order: L7 -> L7u -> Recovery R1-R8 -> LVR -> L8. L7u only moves the running Production Core onto a NEW immutable release that
contains the merged Core-mediated Recovery runtime, and provisions the filesystem/identity surface that runtime needs:

    1. install the new immutable release (the existing p4-l7-install-release.py, which re-runs the real release guard),
    2. the dedicated transport group ``aegis-idea3-recovery`` (created only if absent) and the operator's membership in it,
    3. three new lines appended to core.env (every pre-existing byte is preserved),
    4. a systemd drop-in giving the Core that supplementary group and write access to the socket directory,
    5. a systemd-tmpfiles rule + the pre-provisioned runtime directory (0750 aegis-idea3:aegis-idea3-recovery) — never the application's mkdir,
    6. daemon-reload, an atomic ``current`` pointer switch, ONE governed Core restart, and verification of the Recovery channel.

Everything is journaled BEFORE it is changed so that ``rollback`` knows exactly what this attempt created or changed. Rollback refuses any
unknown or mismatched state before it touches anything, restores the exact prestate (pointer, core.env bytes+metadata, drop-in, tmpfiles,
runtime directory, membership, group, the new release), restarts the OLD Core only as part of that bounded rollback, and verifies it.

Boundaries, all deliberate: no ESP32/serial access, no CUT/RESTORE, no IDEA1/IDEA2 action, no firewall/network/broker change, no systemctl verb
other than daemon-reload/restart/stop/start/reset-failed/show on aegis-idea3-core.service, no shell, no automatic retry, and no host-root option:
the CLI always acts on the real host, and only the Python API (used by the fixture tests) can be pointed at a fixture root with a fixture Host.
The Python API never shells out on its own: every privileged operation goes through the ``Backend`` object.

Output never contains core.env values, secrets or environment content: only fixed reason codes and non-secret identifiers.
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
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
DEPLOY_DIR = HERE.parent  # IDEA3-AEGIS_Lockdown/deploy

GROUP_NAME = "aegis-idea3-recovery"
CORE_UNIT = "aegis-idea3-core.service"
CORE_USER = "aegis-idea3"
CORE_PRIMARY_GROUP = "aegis-idea3"
RELEASES = "/opt/aegis-idea3/releases"
CURRENT = "/opt/aegis-idea3/current"
CORE_ENV = "/etc/aegis-idea3/core.env"
RUNTIME_DIR = "/run/aegis-idea3-recovery"
SOCKET_PATH = f"{RUNTIME_DIR}/recovery.sock"
DROPIN_DIR = "/etc/systemd/system/aegis-idea3-core.service.d"
DROPIN_PATH = f"{DROPIN_DIR}/10-recovery.conf"
TMPFILES_DIR = "/etc/tmpfiles.d"
TMPFILES_PATH = f"{TMPFILES_DIR}/aegis-idea3-recovery.conf"
DROPIN_TEMPLATE = DEPLOY_DIR / "aegis-idea3-core-recovery.dropin.example"
TMPFILES_TEMPLATE = DEPLOY_DIR / "aegis-idea3-recovery.tmpfiles.example"
DROPIN_ACTIVE = ["[Service]", f"SupplementaryGroups={GROUP_NAME}", f"ReadWritePaths={RUNTIME_DIR}"]
TMPFILES_ACTIVE = [f"d {RUNTIME_DIR} 0750 {CORE_USER} {GROUP_NAME} -"]
ENV_KEY_UID = "AEGIS_RECOVERY_OPERATOR_UID"
ENV_KEY_GID = "AEGIS_RECOVERY_SOCKET_GID"
ENV_KEY_SOCKET = "AEGIS_RECOVERY_SOCKET"
OWNED_ENV_KEYS = (ENV_KEY_UID, ENV_KEY_GID, ENV_KEY_SOCKET)
PROBE_ENV_KEYS = ("AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET", "AEGIS_RECOVERY_NETWORK_PROBE_TARGETS", "AEGIS_RECOVERY_WEB_READINESS_URL")
RECOVERY_RUNTIME_FILES = ("recovery_core.py", "recovery_protocol.py", "recovery_client.py", "recovery_ui.py")
SYSTEM_GID_MAX = 999
RELEASE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", re.ASCII)
USER_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}", re.ASCII)
MAIN_RE = re.compile(r"[0-9a-f]{40}", re.ASCII)
ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
JOURNAL_KINDS = ("RELEASE_INSTALL", "GROUP", "MEMBERSHIP", "CORE_ENV", "DROPIN", "TMPFILES", "RUNTIME_DIR", "DAEMON_RELOAD", "CURRENT_SWITCH",
                 "CORE_RESTART")
HEALTHY = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success"}


class Refusal(Exception):
    """A fixed reason code (optionally ``CODE:detail`` with a non-secret detail). Never carries environment or secret content."""


def refuse(code: str) -> None:
    raise Refusal(code)


class CommandResult(NamedTuple):
    rc: int
    out: str


@dataclass(frozen=True)
class Config:
    old_release_id: str
    new_release_id: str
    expected_main: str
    source_dir: Path
    work_dir: Path
    operator_user: str
    operator_uid: int
    owner_expect: str = "root"  # 'any' is fixture-only: it is refused unless the Host has a fixture root
    stable_wait_sec: float = 3.0
    stable_samples: int = 3


@dataclass(frozen=True)
class Identity:
    kind: str
    mode: int
    uid: int
    gid: int
    size: int
    mtime_ns: int


@dataclass
class Plan:
    core_uid: int
    core_gid: int
    operator_primary_gid: int
    group_exists: bool
    group_gid: int | None
    group_created_by_attempt: bool
    operator_is_member: bool
    env_missing: list[str]
    env_identity: Identity
    core_pid: int
    old_source_sha: str = ""


# ── host access (real filesystem, optionally under a FIXTURE root) ────────────────────────────────────────────────────────


class Host:
    """Filesystem access by LOGICAL path. ``root`` is a fixture prefix and is never set by the CLI. Ownership goes through ``chown`` and
    ``owner_of`` so a fixture subclass (the test user cannot chown) can overlay it; everything else is real filesystem behaviour."""

    def __init__(self, root: str = "") -> None:
        self.root = root.rstrip("/")

    @property
    def fixture(self) -> bool:
        return bool(self.root)

    def p(self, logical: str) -> Path:
        return Path(self.root + logical) if self.root else Path(logical)

    def lexists(self, logical: str) -> bool:
        return os.path.lexists(self.p(logical))

    def lstat(self, logical: str) -> os.stat_result:
        return os.lstat(self.p(logical))

    def owner_of(self, logical: str) -> tuple[int, int]:
        info = os.lstat(self.p(logical))
        return info.st_uid, info.st_gid

    def identity(self, logical: str) -> Identity:
        info = os.lstat(self.p(logical))
        mode = info.st_mode
        kind = ("link" if stat.S_ISLNK(mode) else "dir" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode)
                else "socket" if stat.S_ISSOCK(mode) else "other")
        uid, gid = self.owner_of(logical)
        return Identity(kind, stat.S_IMODE(mode), uid, gid, info.st_size, info.st_mtime_ns)

    def read_bytes(self, logical: str) -> bytes:
        return self.p(logical).read_bytes()

    def read_text(self, logical: str) -> str:
        return self.p(logical).read_text(encoding="utf-8")

    def readlink(self, logical: str) -> str:
        return os.readlink(self.p(logical))

    def listdir(self, logical: str) -> list[str]:
        return sorted(os.listdir(self.p(logical)))

    def chown(self, logical: str, uid: int, gid: int) -> None:
        os.chown(self.p(logical), uid, gid, follow_symlinks=False)

    def chmod(self, logical: str, mode: int) -> None:
        os.chmod(self.p(logical), mode)

    def utime(self, logical: str, mtime_ns: int) -> None:
        os.utime(self.p(logical), ns=(mtime_ns, mtime_ns), follow_symlinks=False)

    def mkdir(self, logical: str, mode: int, uid: int, gid: int) -> None:
        os.mkdir(self.p(logical), 0o700)  # never broader than the final mode at any instant
        os.chmod(self.p(logical), mode)
        self.chown(logical, uid, gid)

    def rmdir(self, logical: str) -> None:
        os.rmdir(self.p(logical))

    def remove_file(self, logical: str) -> None:
        os.remove(self.p(logical))

    def replace(self, src_logical: str, dst_logical: str) -> None:
        os.replace(self.p(src_logical), self.p(dst_logical))

    def write_atomic(self, logical: str, data: bytes, *, mode: int, uid: int, gid: int) -> None:
        parent, _, name = logical.rpartition("/")
        tmp = f"{parent}/.{name}.l7u-tmp"
        descriptor = os.open(self.p(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(self.p(tmp), mode)
            self.chown(tmp, uid, gid)
            self.replace(tmp, logical)
        except BaseException:
            self._discard(tmp)
            raise

    def symlink_atomic(self, link: str, target: str) -> None:
        parent, _, name = link.rpartition("/")
        tmp = f"{parent}/.{name}.l7u-new"
        os.symlink(target, self.p(tmp))  # fails if a leftover exists: never reuse or unlink an unknown entry
        try:
            self.replace(tmp, link)  # rename(2) over the old symlink: readers see the old or the new target, never a gap
        except BaseException:
            self._discard(tmp)
            raise

    def _discard(self, logical: str) -> None:
        try:
            os.remove(self.p(logical))
        except OSError:
            pass


# ── privileged operations (the ONLY place a process is started) ────────────────────────────────────────────────────────────


class Backend:
    """Abstract privileged operations. Fixture tests use a stateful fake; the live run uses ``SystemBackend``."""

    def groupadd(self, name: str) -> None:
        raise NotImplementedError

    def groupdel(self, name: str) -> None:
        raise NotImplementedError

    def gpasswd_add(self, user: str, group: str) -> None:
        raise NotImplementedError

    def gpasswd_del(self, user: str, group: str) -> None:
        raise NotImplementedError

    def tmpfiles_create(self, conf_logical: str) -> None:
        raise NotImplementedError

    def systemctl(self, *args: str) -> CommandResult:
        raise NotImplementedError

    def sleep(self, seconds: float) -> None:
        raise NotImplementedError

    def unit_props(self, names: list[str]) -> dict[str, str]:
        args = ["show"]
        for name in names:
            args += ["-p", name]
        result = self.systemctl(*args, CORE_UNIT)
        if result.rc != 0:
            refuse("CORE_STATE_UNREADABLE")
        props: dict[str, str] = {}
        for line in result.out.splitlines():
            key, _, value = line.partition("=")
            props.setdefault(key, value)
        return props


class SystemBackend(Backend):
    SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
    PROP_RE = re.compile(r"[A-Za-z]{1,40}")

    def _run(self, argv: list[str]) -> CommandResult:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False, env=self.SAFE_ENV)
        return CommandResult(done.returncode, done.stdout or "")

    @staticmethod
    def _owned_group(name: str) -> None:
        if name != GROUP_NAME:
            refuse("BACKEND_GROUP_NOT_OWNED")

    @staticmethod
    def _member(user: str) -> None:
        if not USER_RE.fullmatch(user) or user in ("root", CORE_USER):
            refuse("BACKEND_USER_NOT_ALLOWED")

    def groupadd(self, name: str) -> None:
        self._owned_group(name)
        if self._run(["groupadd", "--system", name]).rc != 0:
            refuse("GROUPADD_FAILED")

    def groupdel(self, name: str) -> None:
        self._owned_group(name)
        if self._run(["groupdel", name]).rc != 0:
            refuse("GROUPDEL_FAILED")

    def gpasswd_add(self, user: str, group: str) -> None:
        self._owned_group(group)
        self._member(user)
        if self._run(["gpasswd", "-a", user, group]).rc != 0:
            refuse("GPASSWD_ADD_FAILED")

    def gpasswd_del(self, user: str, group: str) -> None:
        self._owned_group(group)
        self._member(user)
        if self._run(["gpasswd", "-d", user, group]).rc != 0:
            refuse("GPASSWD_DEL_FAILED")

    def tmpfiles_create(self, conf_logical: str) -> None:
        if conf_logical != TMPFILES_PATH:
            refuse("BACKEND_TMPFILES_NOT_OWNED")
        if self._run(["systemd-tmpfiles", "--create", conf_logical]).rc != 0:
            refuse("TMPFILES_FAILED")

    def systemctl(self, *args: str) -> CommandResult:
        if args == ("daemon-reload",):
            return self._run(["systemctl", "daemon-reload"])
        if len(args) == 2 and args[0] in ("restart", "stop", "start", "reset-failed") and args[1] == CORE_UNIT:
            return self._run(["systemctl", *args])
        if len(args) >= 4 and args[0] == "show" and args[-1] == CORE_UNIT and all(
            (a == "-p") if i % 2 == 1 else bool(self.PROP_RE.fullmatch(a)) for i, a in enumerate(args[1:-1], start=1)
        ) and len(args[1:-1]) % 2 == 0:
            return self._run(["systemctl", *args])
        refuse("BACKEND_SYSTEMCTL_NOT_ALLOWED")
        raise AssertionError  # pragma: no cover

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


# ── reused tools (never duplicated) ───────────────────────────────────────────────────────────────────────────────────────


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_guard():
    return _load("p4_l7_release_guard", "p4-l7-release-guard.py")


def load_installer():
    return _load("p4_l7_install_release", "p4-l7-install-release.py")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def logical_release(release_id: str) -> str:
    return f"{RELEASES}/{release_id}"


# ── journal ───────────────────────────────────────────────────────────────────────────────────────────────────────────────


class Journal:
    def __init__(self, work: Path) -> None:
        self.path = work / "journal.jsonl"
        self.seq = 0

    def append(self, kind: str, data: dict) -> None:
        assert kind in JOURNAL_KINDS
        self.seq += 1
        line = json.dumps({"seq": self.seq, "kind": kind, "phase": "intent", "data": data}, sort_keys=True)
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())


# ── parsing helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────


def parse_passwd(host: Host) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for line in host.read_text("/etc/passwd").splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[2].isdigit() and parts[3].isdigit():
            out.setdefault(parts[0], (int(parts[2]), int(parts[3])))
    return out


def parse_groups(host: Host) -> list[tuple[str, int, list[str]]]:
    rows = []
    for line in host.read_text("/etc/group").splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[2].isdigit():
            rows.append((parts[0], int(parts[2]), [m for m in parts[3].split(",") if m]))
    return rows


def group_row(host: Host) -> tuple[int, list[str]] | None:
    rows = parse_groups(host)
    named = [r for r in rows if r[0] == GROUP_NAME]
    if len(named) > 1:
        refuse("GROUP_DB_DUPLICATE")
    if not named:
        return None
    return named[0][1], named[0][2]


def gid_is_shared(host: Host, gid: int) -> bool:
    return sum(1 for r in parse_groups(host) if r[1] == gid) > 1


def primary_gids(passwd: dict[str, tuple[int, int]]) -> set[int]:
    return {gid for _, gid in passwd.values()}


def check_group_safe(gid: int, core_gid: int, operator_gid: int) -> None:
    if gid == 0 or gid in (core_gid, operator_gid):
        refuse("GROUP_GID_CONFLICT")
    if not 1 <= gid <= SYSTEM_GID_MAX:
        refuse("GROUP_GID_NOT_SYSTEM")


def parse_env(data: bytes) -> tuple[dict[str, list[tuple[str, str]]], int]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        refuse("CORE_ENV_NOT_UTF8")
    found: dict[str, list[tuple[str, str]]] = {}
    for line in text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = ENV_LINE_RE.match(line)
        if match:
            found.setdefault(match.group(1), []).append((match.group(2), line))
    return found, len(found)


def expected_env(cfg: Config, gid: int | None) -> dict[str, str | None]:
    return {ENV_KEY_UID: str(cfg.operator_uid), ENV_KEY_GID: None if gid is None else str(gid), ENV_KEY_SOCKET: SOCKET_PATH}


def check_env(cfg: Config, data: bytes, gid: int | None, *, require_all: bool) -> list[str]:
    """Validate core.env. Returns the owned keys still missing. Never includes a value in a message."""
    found, _ = parse_env(data)
    for key in PROBE_ENV_KEYS:
        if len(found.get(key, [])) != 1:
            refuse(f"ENV_PROBE_KEY_MISSING:{key}")
    missing = []
    for key, want in expected_env(cfg, gid).items():
        entries = found.get(key, [])
        if len(entries) > 1:
            refuse(f"ENV_OWNED_KEY_DUPLICATE:{key}")
        if not entries:
            missing.append(key)
            continue
        if want is None:
            refuse(f"ENV_OWNED_KEY_WITHOUT_GROUP:{key}")
        if entries[0][1] != f"{key}={want}":
            refuse(f"ENV_OWNED_KEY_UNEXPECTED_VALUE:{key}")
    if require_all and missing:
        refuse(f"ENV_OWNED_KEY_MISSING:{missing[0]}")
    return missing


def check_templates() -> tuple[bytes, bytes]:
    try:
        dropin, tmpfiles = DROPIN_TEMPLATE.read_bytes(), TMPFILES_TEMPLATE.read_bytes()
    except OSError:
        refuse("TEMPLATE_INVALID")
    def active(blob: bytes) -> list[str]:
        return [l for l in blob.decode("utf-8").splitlines() if l.strip() and not l.lstrip().startswith("#")]
    if active(dropin) != DROPIN_ACTIVE or active(tmpfiles) != TMPFILES_ACTIVE:
        refuse("TEMPLATE_INVALID")
    return dropin, tmpfiles


def validate_config(cfg: Config, host: Host) -> None:
    if not MAIN_RE.fullmatch(cfg.expected_main):
        refuse("MAIN_PIN_INVALID")
    for release_id in (cfg.old_release_id, cfg.new_release_id):
        if not RELEASE_ID_RE.fullmatch(release_id):
            refuse("RELEASE_ID_INVALID")
    if cfg.old_release_id == cfg.new_release_id:
        refuse("OLD_EQUALS_NEW")
    if cfg.owner_expect not in ("root", "any"):
        refuse("OWNER_EXPECT_INVALID")
    if cfg.owner_expect == "any" and not host.fixture:
        refuse("OWNER_ANY_REQUIRES_FIXTURE_ROOT")
    if not USER_RE.fullmatch(cfg.operator_user) or cfg.operator_uid <= 0:
        refuse("OPERATOR_IDENTITY_MISMATCH")


def check_work_dir(cfg: Config, host: Host) -> None:
    work = cfg.work_dir
    if os.path.islink(work):
        refuse("WORK_DIR_IS_SYMLINK")
    etc = str(host.p("/etc"))
    if str(work) == etc or str(work).startswith(etc + "/"):
        refuse("WORK_DIR_INSIDE_ETC")
    if os.path.lexists(work):
        refuse("WORK_DIR_ALREADY_EXISTS")


# ── core state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


def core_health(backend: Backend, *, prestate: bool) -> dict[str, str]:
    props = backend.unit_props(["LoadState", "ActiveState", "SubState", "UnitFileState", "Result", "NRestarts", "MainPID"])
    bad = "CORE_PRESTATE_NOT_HEALTHY" if prestate else "CORE_NOT_HEALTHY"
    for key, want in HEALTHY.items():
        if props.get(key) != want:
            refuse(f"{bad}:{key}")
    if props.get("NRestarts") != "0":
        refuse(f"{bad}:NRestarts")
    if not props.get("MainPID", "").isdigit() or int(props["MainPID"]) <= 0:
        refuse(f"{bad}:MainPID")
    return props


def process_groups(host: Host, pid: int) -> list[int]:
    try:
        text = host.read_text(f"/proc/{pid}/status")
    except OSError:
        refuse("CORE_PROCESS_UNREADABLE")
    match = re.search(r"^Groups:\s*(.*)$", text, re.MULTILINE)
    if not match:
        refuse("CORE_PROCESS_UNREADABLE")
    return [int(x) for x in match.group(1).split() if x.isdigit()]


def check_recovery_channel(host: Host, gid: int, core_uid: int, pid: int) -> None:
    if not host.lexists(RUNTIME_DIR):
        refuse("RUNTIME_DIR_METADATA_INVALID")
    directory = host.identity(RUNTIME_DIR)
    if (directory.kind, directory.mode, directory.uid, directory.gid) != ("dir", 0o750, core_uid, gid):
        refuse("RUNTIME_DIR_METADATA_INVALID")
    if not host.lexists(SOCKET_PATH):
        refuse("RECOVERY_CHANNEL_MISSING")
    sock = host.identity(SOCKET_PATH)
    if (sock.kind, sock.mode, sock.uid, sock.gid) != ("socket", 0o660, core_uid, gid):
        refuse("RECOVERY_CHANNEL_METADATA_INVALID")
    if gid not in process_groups(host, pid):
        refuse("CORE_PROCESS_LACKS_RECOVERY_GROUP")


# ── preflight (read-only) ─────────────────────────────────────────────────────────────────────────────────────────────────


def preflight(cfg: Config, host: Host, backend: Backend) -> Plan:
    validate_config(cfg, host)
    passwd = parse_passwd(host)
    rows = parse_groups(host)
    core = passwd.get(CORE_USER)
    core_group = next((r for r in rows if r[0] == CORE_PRIMARY_GROUP), None)
    if core is None or core_group is None or core[1] != core_group[1]:
        refuse("CORE_IDENTITY_INVALID")
    operator = passwd.get(cfg.operator_user)
    if operator is None or operator[0] != cfg.operator_uid:
        refuse("OPERATOR_IDENTITY_MISMATCH")
    if cfg.operator_user == CORE_USER or cfg.operator_uid == core[0]:
        refuse("OPERATOR_IS_CORE_ACCOUNT")
    if GROUP_NAME in passwd:
        refuse("GROUP_NAME_IS_USER")
    row = group_row(host)
    group_exists = row is not None
    gid = row[0] if row else None
    operator_member = False
    if row:
        check_group_safe(row[0], core[1], operator[1])
        if gid_is_shared(host, row[0]):
            refuse("GROUP_DB_DUPLICATE")
        if set(row[1]) - {cfg.operator_user}:
            refuse("GROUP_UNEXPECTED_MEMBERS")
        if row[0] in primary_gids(passwd):
            refuse("GROUP_IS_PRIMARY_GROUP_OF_USER")
        operator_member = cfg.operator_user in row[1]

    props = core_health(backend, prestate=True)

    old_logical, new_logical = logical_release(cfg.old_release_id), logical_release(cfg.new_release_id)
    if not host.lexists(CURRENT) or not stat.S_ISLNK(host.lstat(CURRENT).st_mode):
        refuse("CURRENT_NOT_SYMLINK")
    if host.readlink(CURRENT) != old_logical:
        refuse("CURRENT_POINTER_MISMATCH")
    guard = load_guard()
    try:
        _, old_sha = guard.check(old_logical, host.p(old_logical), cfg.owner_expect)
    except guard.Refusal as exc:
        refuse(f"OLD_RELEASE_GUARD_FAILED:{exc}")
    if host.lexists(new_logical):
        refuse("NEW_RELEASE_ALREADY_INSTALLED")
    try:
        new_id, new_sha = guard.check(new_logical, cfg.source_dir, "any")
    except guard.Refusal as exc:
        refuse(f"NEW_RELEASE_GUARD_FAILED:{exc}")
    if new_id != cfg.new_release_id or new_sha != cfg.expected_main:
        refuse("NEW_RELEASE_SOURCE_NOT_PINNED_MAIN")
    if not all((cfg.source_dir / "aegis_soc" / name).is_file() for name in RECOVERY_RUNTIME_FILES):
        refuse("NEW_RELEASE_LACKS_RECOVERY_RUNTIME")

    check_templates()
    if host.lexists(DROPIN_PATH):
        refuse("DROPIN_ALREADY_EXISTS")
    if host.lexists(DROPIN_DIR) and not stat.S_ISDIR(host.lstat(DROPIN_DIR).st_mode):
        refuse("DROPIN_DIR_NOT_DIRECTORY")
    if host.lexists(TMPFILES_PATH):
        refuse("TMPFILES_ALREADY_EXISTS")
    if host.lexists(TMPFILES_DIR) and not stat.S_ISDIR(host.lstat(TMPFILES_DIR).st_mode):
        refuse("TMPFILES_DIR_NOT_DIRECTORY")
    if host.lexists(RUNTIME_DIR):
        refuse("RUNTIME_DIR_ALREADY_EXISTS")

    if not host.lexists(CORE_ENV) or host.identity(CORE_ENV).kind != "file":
        refuse("CORE_ENV_NOT_REGULAR")
    data = host.read_bytes(CORE_ENV)
    if not data.endswith(b"\n"):
        refuse("CORE_ENV_NOT_NEWLINE_TERMINATED")
    missing = check_env(cfg, data, gid, require_all=False)
    return Plan(core_uid=core[0], core_gid=core[1], operator_primary_gid=operator[1], group_exists=group_exists, group_gid=gid,
                group_created_by_attempt=not group_exists, operator_is_member=operator_member, env_missing=missing,
                env_identity=host.identity(CORE_ENV), core_pid=int(props["MainPID"]), old_source_sha=old_sha)


# ── apply ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _guard_installed(cfg: Config, host: Host, release_id: str) -> None:
    guard = load_guard()
    logical = logical_release(release_id)
    try:
        guard.check(logical, host.p(logical), cfg.owner_expect)
    except guard.Refusal as exc:
        refuse(f"RELEASE_GUARD_FAILED:{exc}")


def apply(cfg: Config, host: Host, backend: Backend) -> dict[str, str]:
    validate_config(cfg, host)
    check_work_dir(cfg, host)
    plan = preflight(cfg, host, backend)
    dropin_bytes, tmpfiles_bytes = check_templates()
    os.mkdir(cfg.work_dir, 0o700)
    journal = Journal(cfg.work_dir)
    marker = cfg.work_dir / "production-mutation"
    marker.write_text("YES\n")
    old_logical, new_logical = logical_release(cfg.old_release_id), logical_release(cfg.new_release_id)
    operator = cfg.operator_user

    # 1. the new immutable release, through the existing installer (which re-runs the real guard before and after the copy)
    journal.append("RELEASE_INSTALL", {"release_id": cfg.new_release_id, "logical": new_logical, "source_git_sha": cfg.expected_main})
    installer = load_installer()
    try:
        installer.install(release_id=cfg.new_release_id, source=cfg.source_dir, logical=new_logical, host_root=host.root,
                          fixture_dest_owner_any=cfg.owner_expect == "any", evidence=None)
    except installer.Refusal as exc:
        refuse(f"RELEASE_INSTALL_FAILED:{exc}")

    # 2. dedicated transport group
    journal.append("GROUP", {"name": GROUP_NAME, "created": plan.group_created_by_attempt})
    if plan.group_created_by_attempt:
        backend.groupadd(GROUP_NAME)
    row = group_row(host)
    if row is None:
        refuse("GROUP_MISSING_AFTER_CREATE")
    gid = row[0]
    check_group_safe(gid, plan.core_gid, plan.operator_primary_gid)
    if gid_is_shared(host, gid):
        refuse("GROUP_DB_DUPLICATE")

    # 3. operator membership (supplementary only; the Core is never added to the group database — systemd grants it via the drop-in)
    add_member = not plan.operator_is_member
    journal.append("MEMBERSHIP", {"user": operator, "group": GROUP_NAME, "added": add_member})
    if add_member:
        backend.gpasswd_add(operator, GROUP_NAME)
    after = group_row(host)
    if after is None or operator not in after[1] or set(after[1]) - {operator}:
        refuse("MEMBERSHIP_STATE_INVALID")

    # 4. core.env: append only the missing owned lines; every pre-existing byte stays
    data = host.read_bytes(CORE_ENV)
    missing = check_env(cfg, data, gid, require_all=False)
    pre = host.identity(CORE_ENV)
    if missing:
        want = expected_env(cfg, gid)
        suffix = "".join(f"{key}={want[key]}\n" for key in OWNED_ENV_KEYS if key in missing).encode("utf-8")
        journal.append("CORE_ENV", {"changed": True, "size": len(data), "sha256": sha256_bytes(data), "mode": pre.mode, "uid": pre.uid,
                                    "gid": pre.gid, "mtime_ns": pre.mtime_ns, "suffix_len": len(suffix), "suffix_sha256": sha256_bytes(suffix)})
        host.write_atomic(CORE_ENV, data + suffix, mode=pre.mode, uid=pre.uid, gid=pre.gid)
    else:
        journal.append("CORE_ENV", {"changed": False})
    check_env(cfg, host.read_bytes(CORE_ENV), gid, require_all=True)

    # 5. systemd drop-in and tmpfiles rule (repository templates, byte-exact)
    dropin_dir_created = not host.lexists(DROPIN_DIR)
    journal.append("DROPIN", {"file": DROPIN_PATH, "dir": DROPIN_DIR, "dir_created": dropin_dir_created, "sha256": sha256_bytes(dropin_bytes)})
    if dropin_dir_created:
        host.mkdir(DROPIN_DIR, 0o755, 0, 0)
    host.write_atomic(DROPIN_PATH, dropin_bytes, mode=0o644, uid=0, gid=0)
    tmpfiles_dir_created = not host.lexists(TMPFILES_DIR)
    journal.append("TMPFILES", {"file": TMPFILES_PATH, "dir": TMPFILES_DIR, "dir_created": tmpfiles_dir_created, "sha256": sha256_bytes(tmpfiles_bytes)})
    if tmpfiles_dir_created:
        host.mkdir(TMPFILES_DIR, 0o755, 0, 0)
    host.write_atomic(TMPFILES_PATH, tmpfiles_bytes, mode=0o644, uid=0, gid=0)

    # 6. the runtime directory is provisioned by tmpfiles and VERIFIED before the Core restarts (never the application's mkdir under UMask 0077)
    journal.append("RUNTIME_DIR", {"path": RUNTIME_DIR})
    backend.tmpfiles_create(TMPFILES_PATH)
    if not host.lexists(RUNTIME_DIR):
        refuse("RUNTIME_DIR_METADATA_INVALID")
    directory = host.identity(RUNTIME_DIR)
    if (directory.kind, directory.mode, directory.uid, directory.gid) != ("dir", 0o750, plan.core_uid, gid) or host.listdir(RUNTIME_DIR):
        refuse("RUNTIME_DIR_METADATA_INVALID")

    # 7. daemon-reload, atomic pointer switch, ONE governed restart
    journal.append("DAEMON_RELOAD", {})
    if backend.systemctl("daemon-reload").rc != 0:
        refuse("DAEMON_RELOAD_FAILED")
    _guard_installed(cfg, host, cfg.old_release_id)
    _guard_installed(cfg, host, cfg.new_release_id)
    journal.append("CURRENT_SWITCH", {"link": CURRENT, "old_target": old_logical, "new_target": new_logical})
    host.symlink_atomic(CURRENT, new_logical)
    if host.readlink(CURRENT) != new_logical:
        refuse("CURRENT_SWITCH_NOT_APPLIED")
    journal.append("CORE_RESTART", {"pre_main_pid": plan.core_pid})
    if backend.systemctl("restart", CORE_UNIT).rc != 0:
        refuse("CORE_RESTART_FAILED")
    _post_restart_checks(cfg, host, backend, plan, gid)
    return {"L7U_APPLY": "PASS", "L7U_SECRETS_PRINTED": "NO", "L7U_CORE_RESTARTS": "1", "L7U_NEW_RELEASE": cfg.new_release_id,
            "L7U_GROUP": GROUP_NAME}


def _post_restart_checks(cfg: Config, host: Host, backend: Backend, plan: Plan, gid: int) -> None:
    first: tuple[str, str] | None = None
    for index in range(max(1, cfg.stable_samples)):
        if index:
            backend.sleep(cfg.stable_wait_sec)
        props = core_health(backend, prestate=False)
        sample = (props["MainPID"], props["NRestarts"])
        if int(props["MainPID"]) == plan.core_pid:
            refuse("CORE_NOT_RESTARTED")
        if first is not None and sample != first:
            refuse("CORE_NOT_HEALTHY:UNSTABLE")
        first = sample
    check_recovery_channel(host, gid, plan.core_uid, int(first[0]))  # type: ignore[index]


# ── verify (read-only) ────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(cfg: Config, host: Host, backend: Backend) -> dict[str, str]:
    validate_config(cfg, host)
    passwd = parse_passwd(host)
    core = passwd.get(CORE_USER)
    operator = passwd.get(cfg.operator_user)
    if core is None or operator is None or operator[0] != cfg.operator_uid:
        refuse("OPERATOR_IDENTITY_MISMATCH")
    row = group_row(host)
    if row is None:
        refuse("GROUP_MISSING")
    gid, members = row
    check_group_safe(gid, core[1], operator[1])
    if set(members) != {cfg.operator_user}:
        refuse("GROUP_MEMBERS_INVALID")
    new_logical = logical_release(cfg.new_release_id)
    if not host.lexists(CURRENT) or host.readlink(CURRENT) != new_logical:
        refuse("CURRENT_POINTER_MISMATCH")
    _guard_installed(cfg, host, cfg.new_release_id)
    _guard_installed(cfg, host, cfg.old_release_id)
    check_env(cfg, host.read_bytes(CORE_ENV), gid, require_all=True)
    dropin, tmpfiles = check_templates()
    if not host.lexists(DROPIN_PATH) or host.read_bytes(DROPIN_PATH) != dropin:
        refuse("DROPIN_MODIFIED")
    if not host.lexists(TMPFILES_PATH) or host.read_bytes(TMPFILES_PATH) != tmpfiles:
        refuse("TMPFILES_MODIFIED")
    props = core_health(backend, prestate=False)
    check_recovery_channel(host, gid, core[0], int(props["MainPID"]))
    return {"L7U_VERIFY": "PASS", "L7U_RECOVERY_CHANNEL": "PRESENT", "L7U_GROUP_GID": str(gid), "L7U_SECRETS_PRINTED": "NO"}


# ── rollback ──────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _read_journal(cfg: Config) -> dict[str, dict]:
    path = cfg.work_dir / "journal.jsonl"
    if os.path.islink(path) or not path.is_file():
        refuse("JOURNAL_MISSING")
    entries: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
            kind, data = record["kind"], record["data"]
        except (ValueError, KeyError, TypeError):
            refuse("JOURNAL_INVALID")
        if kind not in JOURNAL_KINDS:
            refuse("JOURNAL_KIND_UNKNOWN")
        if kind in entries or not isinstance(data, dict):
            refuse("JOURNAL_INVALID")
        entries[kind] = data
    new_logical, old_logical = logical_release(cfg.new_release_id), logical_release(cfg.old_release_id)
    owned = {
        "RELEASE_INSTALL": {"logical": new_logical, "release_id": cfg.new_release_id},
        "GROUP": {"name": GROUP_NAME},
        "MEMBERSHIP": {"user": cfg.operator_user, "group": GROUP_NAME},
        "DROPIN": {"file": DROPIN_PATH, "dir": DROPIN_DIR},
        "TMPFILES": {"file": TMPFILES_PATH, "dir": TMPFILES_DIR},
        "RUNTIME_DIR": {"path": RUNTIME_DIR},
        "CURRENT_SWITCH": {"link": CURRENT, "old_target": old_logical, "new_target": new_logical},
    }
    for kind, fields in owned.items():
        if kind in entries and any(entries[kind].get(k) != v for k, v in fields.items()):
            refuse("JOURNAL_ENTRY_NOT_OWNED")
    return entries


def _remove_tree(host: Host, logical: str) -> None:
    """Two-pass, symlink-refusing removal of exactly one release tree (no recursive shell removal)."""
    root = host.p(logical)
    entries: list[tuple[str, bool]] = []

    def scan(path: str) -> None:
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            refuse("RELEASE_REMOVE_REFUSED_SYMLINK")
        if stat.S_ISDIR(info.st_mode):
            for name in sorted(os.listdir(path)):
                scan(os.path.join(path, name))
        elif not stat.S_ISREG(info.st_mode):
            refuse("RELEASE_REMOVE_REFUSED_SPECIAL")
        entries.append((path, stat.S_ISDIR(info.st_mode)))

    scan(str(root))
    for path, is_dir in entries:
        os.rmdir(path) if is_dir else os.remove(path)


def rollback(cfg: Config, host: Host, backend: Backend) -> dict[str, str]:
    validate_config(cfg, host)
    journal = _read_journal(cfg)
    done_marker = cfg.work_dir / "rollback-done"
    already_done = done_marker.exists()
    old_logical, new_logical = logical_release(cfg.old_release_id), logical_release(cfg.new_release_id)
    passwd = parse_passwd(host)
    operator = cfg.operator_user

    # ── phase 1: prove every surface is either at its prestate or exactly what this attempt wrote (changes NOTHING) ──────────
    guard = load_guard()
    try:
        guard.check(old_logical, host.p(old_logical), cfg.owner_expect)
    except guard.Refusal as exc:
        refuse(f"OLD_RELEASE_GUARD_FAILED:{exc}")

    restore_current = False
    if "CURRENT_SWITCH" in journal:
        if not host.lexists(CURRENT) or not stat.S_ISLNK(host.lstat(CURRENT).st_mode):
            refuse("CURRENT_UNKNOWN_STATE")
        target = host.readlink(CURRENT)
        if target == new_logical:
            restore_current = True
        elif target != old_logical:
            refuse("CURRENT_UNKNOWN_STATE")
    elif host.lexists(CURRENT) and host.readlink(CURRENT) != old_logical:
        refuse("CURRENT_UNKNOWN_STATE")

    env_action = None
    if journal.get("CORE_ENV", {}).get("changed"):
        entry = journal["CORE_ENV"]
        current = host.read_bytes(CORE_ENV)
        size, suffix_len = int(entry["size"]), int(entry["suffix_len"])
        if sha256_bytes(current[:size]) != entry["sha256"]:
            refuse("CORE_ENV_UNKNOWN_STATE")
        if len(current) == size:
            env_action = ("metadata", entry)
        elif len(current) == size + suffix_len and sha256_bytes(current[size:]) == entry["suffix_sha256"]:
            env_action = ("rewrite", entry)
        else:
            refuse("CORE_ENV_UNKNOWN_STATE")

    def check_owned_file(kind: str, path: str, code: str) -> bool:
        if kind not in journal or not host.lexists(path):
            return False
        if host.identity(path).kind != "file" or sha256_bytes(host.read_bytes(path)) != journal[kind]["sha256"]:
            refuse(code)
        return True

    remove_dropin = check_owned_file("DROPIN", DROPIN_PATH, "DROPIN_MODIFIED")
    remove_tmpfiles = check_owned_file("TMPFILES", TMPFILES_PATH, "TMPFILES_MODIFIED")
    for kind, path, file_path in (("DROPIN", DROPIN_DIR, DROPIN_PATH), ("TMPFILES", TMPFILES_DIR, TMPFILES_PATH)):
        if kind in journal and journal[kind].get("dir_created") and host.lexists(path) \
                and set(host.listdir(path)) - {file_path.rsplit("/", 1)[1]}:
            refuse(f"{kind}_DIR_NOT_EMPTY")

    remove_socket = remove_runtime = False
    if "RUNTIME_DIR" in journal and host.lexists(RUNTIME_DIR):
        if host.identity(RUNTIME_DIR).kind != "dir":
            refuse("RUNTIME_DIR_UNKNOWN_STATE")
        names = host.listdir(RUNTIME_DIR)
        if names not in ([], ["recovery.sock"]):
            refuse("RUNTIME_DIR_NOT_EMPTY")
        remove_socket = bool(names)
        if remove_socket and host.identity(SOCKET_PATH).kind != "socket":
            refuse("RUNTIME_DIR_NOT_EMPTY")
        remove_runtime = True

    release_present = False
    if "RELEASE_INSTALL" in journal and host.lexists(new_logical):
        try:
            rid, sha = guard.check(new_logical, host.p(new_logical), cfg.owner_expect)
        except guard.Refusal as exc:
            refuse(f"RELEASE_DRIFTED:{exc}")
        if rid != cfg.new_release_id or sha != cfg.expected_main:
            refuse("RELEASE_DRIFTED:IDENTITY")
        release_present = True

    remove_member = delete_group = False
    row = group_row(host)
    if row is not None and "GROUP" in journal:
        gid, members = row
        if journal.get("MEMBERSHIP", {}).get("added") and operator in members:
            remove_member = True
        if journal["GROUP"].get("created"):
            if set(members) - {operator} or gid in primary_gids(passwd):
                refuse("GROUP_IN_USE_REFUSING_DELETE")
            delete_group = True

    restart_journaled = "CORE_RESTART" in journal and not already_done

    # ── phase 2: act, in a fixed order ───────────────────────────────────────────────────────────────────────────────────────
    if restart_journaled and backend.systemctl("stop", CORE_UNIT).rc != 0:
        refuse("ROLLBACK_CORE_STOP_FAILED")
    if remove_socket and host.lexists(SOCKET_PATH):  # the stopped Core may already have removed it
        if host.identity(SOCKET_PATH).kind != "socket":
            refuse("RUNTIME_DIR_NOT_EMPTY")
        host.remove_file(SOCKET_PATH)
    if remove_runtime and host.lexists(RUNTIME_DIR):
        if host.listdir(RUNTIME_DIR):
            refuse("RUNTIME_DIR_NOT_EMPTY")
        host.rmdir(RUNTIME_DIR)
    if restore_current:
        host.symlink_atomic(CURRENT, old_logical)
        if host.readlink(CURRENT) != old_logical:
            refuse("CURRENT_RESTORE_FAILED")
    if env_action:
        kind, entry = env_action
        current = host.read_bytes(CORE_ENV)
        if kind == "rewrite":
            host.write_atomic(CORE_ENV, current[: int(entry["size"])], mode=int(entry["mode"]), uid=int(entry["uid"]), gid=int(entry["gid"]))
        host.chmod(CORE_ENV, int(entry["mode"]))
        host.chown(CORE_ENV, int(entry["uid"]), int(entry["gid"]))
        host.utime(CORE_ENV, int(entry["mtime_ns"]))
    if remove_dropin:
        host.remove_file(DROPIN_PATH)
    if remove_tmpfiles:
        host.remove_file(TMPFILES_PATH)
    for kind, path in (("DROPIN", DROPIN_DIR), ("TMPFILES", TMPFILES_DIR)):
        if kind in journal and journal[kind].get("dir_created") and host.lexists(path) and not host.listdir(path):
            host.rmdir(path)
    if ("DROPIN" in journal or "DAEMON_RELOAD" in journal) and not already_done and backend.systemctl("daemon-reload").rc != 0:
        refuse("ROLLBACK_DAEMON_RELOAD_FAILED")
    if remove_member:
        backend.gpasswd_del(operator, GROUP_NAME)
    if delete_group:
        backend.groupdel(GROUP_NAME)
    if release_present:
        _remove_tree(host, new_logical)
    if restart_journaled:
        props = backend.unit_props(["ActiveState", "Result"])
        if props.get("ActiveState") == "failed" or props.get("Result") != "success":
            backend.systemctl("reset-failed", CORE_UNIT)
        if backend.systemctl("start", CORE_UNIT).rc != 0:
            refuse("OLD_CORE_NOT_HEALTHY:START_FAILED")

    # ── phase 3: prove the prestate, including the OLD Core ─────────────────────────────────────────────────────────────────
    if host.lexists(CURRENT) and host.readlink(CURRENT) != old_logical:
        refuse("CURRENT_RESTORE_FAILED")
    try:
        core_health(backend, prestate=True)
    except Refusal as exc:
        refuse(str(exc).replace("CORE_PRESTATE_NOT_HEALTHY", "OLD_CORE_NOT_HEALTHY"))
    try:
        guard.check(old_logical, host.p(old_logical), cfg.owner_expect)
    except guard.Refusal as exc:
        refuse(f"OLD_RELEASE_GUARD_FAILED:{exc}")
    done_marker.write_text("YES\n")
    return {"L7U_ROLLBACK": "PASS", "L7U_OLD_CORE": "ACTIVE_RUNNING_ENABLED", "L7U_OLD_RELEASE": cfg.old_release_id, "L7U_SECRETS_PRINTED": "NO"}


# ── capture delta: value-level proof of the approved PRE->POST delta ─────────────────────────────────────────────────────────


def _catalog(value: str) -> dict[str, str]:
    if value in ("absent", "<empty>", ""):
        return {}
    return dict(item.split(":", 1) for item in value.split(","))


def delta(pre: dict[str, str], post: dict[str, str], cfg: Config, group_gid: int, *, core_uid: int | None = None,
          require_systemd: bool = False) -> dict[str, str]:
    old_logical, new_logical = logical_release(cfg.old_release_id), logical_release(cfg.new_release_id)
    cur = "host.symlink./opt/aegis-idea3/current.target"
    if pre.get(cur) != old_logical or post.get(cur) != new_logical:
        refuse("DELTA_CURRENT_TARGET")
    before, after = _catalog(pre.get("host.aegis_idea3.release_catalog", "absent")), _catalog(post.get("host.aegis_idea3.release_catalog", "absent"))
    if any(after.get(k) != v for k, v in before.items()) or set(after) - set(before) != {cfg.new_release_id}:
        refuse("DELTA_RELEASE_CATALOG")
    group_key = f"host.aegis_idea3.recovery.group.{GROUP_NAME}"
    if post.get(group_key) != f"present gid={group_gid} members={cfg.operator_user}":
        refuse("DELTA_GROUP")
    dropin, tmpfiles = check_templates()
    for path, blob, directory in ((DROPIN_PATH, dropin, "/etc/systemd/system/aegis-idea3-core.service.d/"), (TMPFILES_PATH, tmpfiles, "/etc/tmpfiles.d/")):
        if post.get(f"host.unit_file.{path}.sha256") != sha256_bytes(blob):
            refuse("DELTA_TEMPLATE_FILE")
        extra = {k for k in post if k.startswith(f"host.unit_file.{directory}") and k not in pre and not k.startswith(f"host.unit_file.{path}.")}
        if extra:
            refuse("DELTA_UNEXPECTED_KEY")
    directory, sock = post.get("host.aegis_idea3.recovery.runtime_dir", ""), post.get("host.aegis_idea3.recovery.socket", "")
    want_dir = re.fullmatch(r"mode=750 uid=(\d+) gid=(\d+)", directory)
    want_sock = re.fullmatch(r"type=socket mode=660 uid=(\d+) gid=(\d+)", sock)
    if not want_dir:
        refuse("DELTA_RUNTIME_DIR")
    if not want_sock:
        refuse("DELTA_SOCKET")
    if core_uid is not None:
        for match in (want_dir, want_sock):
            if (int(match.group(1)), int(match.group(2))) != (core_uid, group_gid):
                refuse("DELTA_OWNER")
    groups_key = "host.aegis_idea3.recovery.core.supplementary_groups"
    if require_systemd:
        if GROUP_NAME not in post.get(groups_key, "").split():
            refuse("DELTA_SUPPLEMENTARY_GROUPS")
        if str(group_gid) not in post.get("host.aegis_idea3.recovery.core.process_groups", "").split():
            refuse("DELTA_PROCESS_GROUPS")
    return {"L7U_DELTA": "PASS"}


def read_records(capture_dir: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for name in ("host.tsv", "services.tsv"):
        for line in (capture_dir / name).read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("\t")
            records.setdefault(key, value)
    return records


# ── CLI (always the real host; no host-root option by design) ────────────────────────────────────────────────────────────────


def _config(args: argparse.Namespace) -> Config:
    return Config(old_release_id=args.old_release_id, new_release_id=args.new_release_id, expected_main=args.expected_main,
                  source_dir=Path(args.source_dir), work_dir=Path(args.work_dir), operator_user=args.operator_user,
                  operator_uid=int(args.operator_uid), owner_expect="root")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "apply", "verify", "rollback", "delta"):
        sp = sub.add_parser(name)
        sp.add_argument("--old-release-id", required=True)
        sp.add_argument("--new-release-id", required=True)
        sp.add_argument("--expected-main", required=True)
        sp.add_argument("--source-dir", required=True)
        sp.add_argument("--work-dir", required=True)
        sp.add_argument("--operator-user", required=True)
        sp.add_argument("--operator-uid", required=True)
        if name == "delta":
            sp.add_argument("--pre-dir", required=True)
            sp.add_argument("--post-dir", required=True)
    args = parser.parse_args(argv)
    label = f"L7U_{args.command.upper()}"
    try:
        if args.command in ("apply", "rollback") and os.environ.get("AEGIS_L7U_LIVE_AUTHORIZED") != "YES":
            refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
        if args.command != "delta" and os.geteuid() != 0:
            refuse("ROOT_REQUIRED")
        cfg, host, backend = _config(args), Host(""), SystemBackend()
        if args.command == "preflight":
            plan = preflight(cfg, host, backend)
            result = {"L7U_PREFLIGHT": "PASS", "L7U_GROUP_EXISTS": "YES" if plan.group_exists else "NO"}
        elif args.command == "apply":
            result = apply(cfg, host, backend)
        elif args.command == "verify":
            result = verify(cfg, host, backend)
        elif args.command == "rollback":
            result = rollback(cfg, host, backend)
        else:
            pre, post = read_records(Path(args.pre_dir)), read_records(Path(args.post_dir))
            row = group_row(host)
            passwd = parse_passwd(host)
            if row is None or CORE_USER not in passwd:
                refuse("DELTA_GROUP")
            result = delta(pre, post, cfg, row[0], core_uid=passwd[CORE_USER][0], require_systemd=True)
    except Refusal as exc:
        print(f"{label}=FAIL reason={exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # any unexpected error is a fail-closed, secret-free refusal
        print(f"{label}=FAIL reason=UNEXPECTED:{type(exc).__name__}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
