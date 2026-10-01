#!/usr/bin/env python3
"""F1 alert-source deployment package: render / verify / ordered start / bounded stop (repository tooling; merging it authorizes nothing live).

Companion of the Core-local alert ingress (SO_PEERCRED, ``AEGIS_ALERT_SOURCE_UID``) and of the production detector
(``python -m aegis_soc.production_detector``). Owner decision OD-F1-DEPLOY-01 fixes the contract a FUTURE governed deployment must satisfy:

    1. new Core release installed + alert group / runtime policy + core.env uid + Core supplementary group + ONE Core restart + Core alert
       socket verified                        (L7u owns ALL of this; this tool never touches the Core, core.env or the group database)
    2. only then the detector unit may start  -> ``start-detector`` re-proves every gate, then issues exactly one ``systemctl start``

Identity: the dedicated NON-ROOT account ``aegis-idea3-detector`` whose numeric uid is owner-frozen (= AEGIS_ALERT_SOURCE_UID). Root and the
Core account are forbidden; ``getpwnam`` must resolve the exact account name to exactly the frozen uid. The tool never creates the account,
never chooses a uid and never takes an account name as input. Transport group ``aegis-idea3-alert`` is filesystem reachability ONLY (traverse
the dedicated /run/aegis-idea3-alert directory 2750, connect to alert.sock 0620): the SO_PEERCRED uid is the authentication authority, no
capability (CAP_DAC_OVERRIDE is forbidden) is ever held.

Boundaries: no useradd/groupadd, no Core verb at all (no restart/stop/start of aegis-idea3-core.service, only ``show``), no MQTT, no ESP32, no
CUT/RESTORE, no containment, no shell, no automatic retry, no host-root option. ``start-detector``/``stop-detector`` act on the real host only
with AEGIS_F1_LIVE_AUTHORIZED=YES and root; the Python API is driven by a ``Host``/``Backend`` pair so the fixture tests never touch a host.
Output is fixed reason codes and non-secret identifiers only; never environment content.

Phase A gap (recorded, deliberate): the Core AlertServer still creates alert.sock under its general runtime directory until the Phase B hook
lands after PR #287. This tool targets ONLY the dedicated surface, so until Phase B a real start is impossible (the dedicated socket never
exists): CORE_ALERT_SOCKET_HOOK_IMPLEMENTED=NO.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

HERE = Path(__file__).resolve().parent
DEPLOY_DIR = HERE.parent

DETECTOR_UNIT = "aegis-idea3-detector.service"
CORE_UNIT = "aegis-idea3-core.service"
CORE_USER = "aegis-idea3"
DETECTOR_ACCOUNT = "aegis-idea3-detector"
ALERT_GROUP = "aegis-idea3-alert"
UNIT_TEMPLATE = DEPLOY_DIR / "aegis-idea3-detector.service.example"
UNIT_PATH = f"/etc/systemd/system/{DETECTOR_UNIT}"
CORE_ENV = "/etc/aegis-idea3/core.env"
RUNTIME_DIR = "/run/aegis-idea3-alert"  # dedicated; NEVER the general /run/aegis-idea3 and never the Recovery directory
SOCKET_PATH = f"{RUNTIME_DIR}/alert.sock"
ENV_KEY = "AEGIS_ALERT_SOURCE_UID"
SOCKET_MODE = 0o620  # owner rw, group write (connect) only, nothing for others
RUNTIME_DIR_MODE = 0o2750  # setgid, owner rwx, group r-x: traverse only, no group create/delete, nothing for others
UNIT_SUPPLEMENTARY_GROUPS = (ALERT_GROUP, "systemd-journal")  # alert = transport; journal = journalctl (unrelated to the alert path)
STOP_TIMEOUT_SEC = 30.0
START_TIMEOUT_SEC = 45.0
SHOW_TIMEOUT_SEC = 10.0
ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")

#: The only active (non-comment) lines the unit may contain besides the hardening block verified key by key below.
EXEC_PRE = "/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.alert_sink check-socket --wait-sec 15"
EXEC_START = "/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector"
REQUIRED_UNIT_LINES = (
    "Requires=aegis-idea3-core.service", "After=aegis-idea3-core.service", "Restart=no", "NoNewPrivileges=true",
    "RestrictAddressFamilies=AF_UNIX", "CapabilityBoundingSet=", "AmbientCapabilities=", "ProtectSystem=strict", "PrivateTmp=true",
    f"ExecStartPre={EXEC_PRE}", f"ExecStart={EXEC_START}",
)
SINGLE_VALUE_KEYS = ("User", "Group", "SupplementaryGroups", "CapabilityBoundingSet", "AmbientCapabilities", "ExecStart", "ExecStartPre", "Restart", "EnvironmentFile", "Environment", "ExecStartPost",
                     "ExecStop", "ExecStopPost", "ExecReload", "LoadCredential", "ReadWritePaths", "RestrictAddressFamilies")
# Substrings that must never appear on an active unit line: MQTT transport/topic, plaintext broker port, shells, containment verbs.
FORBIDDEN_ACTIVE = ("mqtt", "paho", "attacker_ip", "1883", "8883", "/bin/sh", "/bin/bash", "bash ", "sh -c", "&&", "||", ";", "|", "`",
                    "$(", "cap_", "nft", "iptables", "containment", "restore", "environmentfile", "loadcredential", "ExecStartPost",
                    "ExecStop=", "ExecReload", "AF_INET", "AF_NETLINK", "AF_PACKET")
CUT_WORD = re.compile(r"\bcut\b", re.IGNORECASE)


class Refusal(Exception):
    """A fixed reason code. Never carries environment or secret content."""


def refuse(code: str) -> None:
    raise Refusal(code)


class CommandResult(NamedTuple):
    rc: int
    out: str


def _load_core_env_helper():
    spec = importlib.util.spec_from_file_location("p4_l7_core_env", HERE / "p4-l7-core-env.py")
    if spec is None or spec.loader is None:
        refuse("CORE_ENV_HELPER_MISSING")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_ENV = _load_core_env_helper()


def parse_uid(text: str) -> int:
    """The single owner-input contract for the source uid: canonical decimal, exactly as the L7 core-env helper validates it."""
    if not _ENV.valid_alert_uid(text):
        refuse("ALERT_SOURCE_UID_INVALID")
    return int(text)


# ── identity / socket contract ──────────────────────────────────────────────────────────────────────────────────────────────


def can_connect(uid: int, gids: tuple[int, ...], *, socket_uid: int, socket_gid: int, socket_mode: int, dir_uid: int, dir_gid: int,
                dir_mode: int) -> bool:
    """Whether ``uid`` with supplementary ``gids`` can connect(2) to a socket with this ownership and these modes.

    Plain DAC with NO capability and NO root special case (DAC override is forbidden): the owner, group and other classes are chosen
    exactly as the kernel does. It needs search permission on the directory and write permission on the socket.
    """
    def allowed(owner: int, group: int, mode: int, owner_bit: int) -> bool:
        if uid == owner:
            return bool(mode & owner_bit)
        if group in gids:
            return bool(mode & (owner_bit >> 3))
        return bool(mode & (owner_bit >> 6))

    return allowed(dir_uid, dir_gid, dir_mode, 0o100) and allowed(socket_uid, socket_gid, socket_mode, 0o200)


def verify_identity(uid: int, core_uid: int) -> None:
    """The frozen uid: non-root and not the Core account (a sender indistinguishable from the Core)."""
    if core_uid <= 0:
        refuse("CORE_UID_INVALID")
    if uid <= 0:
        refuse("ALERT_SOURCE_IS_ROOT")
    if uid == core_uid:
        refuse("ALERT_SOURCE_IS_CORE_ACCOUNT")


def verify_account(host: Host, uid: int, core_uid: int) -> None:
    """The exact account ``aegis-idea3-detector`` must exist and resolve to exactly the frozen uid. No other name is ever consulted."""
    verify_identity(uid, core_uid)
    resolved = host.resolve_user(DETECTOR_ACCOUNT)
    if resolved is None:
        refuse("DETECTOR_ACCOUNT_MISSING")
    if resolved != uid:
        refuse("DETECTOR_UID_MISMATCH")


# ── unit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _active_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def render_unit(template: bytes) -> bytes:
    """The unit is static (it names the account, not a uid): rendering is the contract check plus a byte-exact copy."""
    verify_unit(template)
    return template


def verify_unit(data: bytes) -> None:
    """Static contract of an installed/rendered detector unit. Raises a fixed reason on the first violation."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        refuse("UNIT_NOT_UTF8")
    lines = _active_lines(text)
    for line in lines:
        lowered = line.lower()
        if "@" in line:
            refuse("UNIT_PLACEHOLDER_LEFT")
        if any(token.lower() in lowered for token in FORBIDDEN_ACTIVE) or CUT_WORD.search(line):
            refuse("UNIT_FORBIDDEN_CONTENT")
    for key in SINGLE_VALUE_KEYS:
        if sum(1 for line in lines if line.startswith(f"{key}=")) > 1:
            refuse(f"UNIT_DUPLICATE_KEY:{key}")
    if "CAP_DAC_OVERRIDE" in text:
        refuse("UNIT_CAPABILITY_NOT_ALLOWED")  # not even in a comment: the model is gone, so the name must be gone
    users = [line for line in lines if line.startswith("User=")]
    if len(users) != 1:
        refuse("UNIT_USER_MISSING")
    if users[0] != f"User={DETECTOR_ACCOUNT}":
        refuse("UNIT_USER_MISMATCH")  # exactly the dedicated account: no uid, no other name, never root
    if any(line.startswith("Group=") for line in lines):
        refuse("UNIT_GROUP_NOT_ALLOWED")  # the primary group follows the account; an extra group is an unreviewed identity
    for required in REQUIRED_UNIT_LINES:
        if required not in lines:
            refuse(f"UNIT_REQUIRED_LINE_MISSING:{required.split('=', 1)[0]}")
    if any(line.startswith(("CapabilityBoundingSet=", "AmbientCapabilities=")) and line.split("=", 1)[1].strip() for line in lines):
        refuse("UNIT_CAPABILITY_NOT_ALLOWED")  # both stay EMPTY: no capability of any kind
    groups = [line for line in lines if line.startswith("SupplementaryGroups=")]
    if len(groups) != 1 or tuple(groups[0].split("=", 1)[1].split()) != UNIT_SUPPLEMENTARY_GROUPS:
        refuse("UNIT_SUPPLEMENTARY_GROUPS_UNEXPECTED")
    if any(line.startswith(("ExecStartPre=", "ExecStart=")) and line not in (f"ExecStartPre={EXEC_PRE}", f"ExecStart={EXEC_START}")
           for line in lines):
        refuse("UNIT_EXEC_UNEXPECTED")
    if any(line.startswith(("ReadWritePaths=", "BindPaths=", "BindReadOnlyPaths=")) for line in lines):
        refuse("UNIT_WRITABLE_PATHS_NOT_ALLOWED")  # connecting to a socket needs no write mount; the unit stays read-only
    if any(line.startswith("WantedBy=") and line != "WantedBy=multi-user.target" for line in lines):
        refuse("UNIT_INSTALL_UNEXPECTED")


# ── core.env ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def verify_env(data: bytes, uid: int, *, core_uid: int | None = None) -> None:
    """core.env must carry exactly one AEGIS_ALERT_SOURCE_UID line equal to ``uid`` and no secret-bearing key. Values are never echoed."""
    if uid <= 0:
        refuse("ALERT_SOURCE_IS_ROOT")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        refuse("CORE_ENV_NOT_UTF8")
    seen: list[str] = []
    for line in text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = ENV_LINE_RE.match(line)
        if not match:
            refuse("CORE_ENV_LINE_MALFORMED")
        key = match.group(1)
        if key in _ENV.FORBIDDEN:
            refuse("CORE_ENV_FORBIDDEN_KEY")
        if key == ENV_KEY:
            if line != f"{ENV_KEY}={match.group(2)}":  # no export prefix, no leading blanks
                refuse("ALERT_SOURCE_UID_INVALID")
            seen.append(match.group(2))
    if not seen:
        refuse("ALERT_SOURCE_UID_MISSING")
    if len(seen) > 1:
        refuse("ALERT_SOURCE_UID_DUPLICATE")
    if parse_uid(seen[0]) != uid:
        refuse("ALERT_SOURCE_UID_MISMATCH")
    if core_uid is not None:
        verify_identity(uid, core_uid)


# ── host / backend (the only privileged surface; fixtures substitute both) ──────────────────────────────────────────────────


class Host:
    def read_bytes(self, path: str) -> bytes:
        return Path(path).read_bytes()

    def lstat(self, path: str) -> os.stat_result:
        return os.lstat(path)

    def proc_environ(self, pid: int) -> bytes:
        return Path(f"/proc/{int(pid)}/environ").read_bytes()

    def proc_groups(self, pid: int) -> list[int]:
        text = Path(f"/proc/{int(pid)}/status").read_text(encoding="utf-8", errors="replace")
        match = re.search(r"^Groups:\s*(.*)$", text, re.MULTILINE)
        if match is None:
            refuse("CORE_PROCESS_UNREADABLE")
        return [int(x) for x in match.group(1).split() if x.isdigit()]

    def resolve_user(self, name: str) -> int | None:
        """getpwnam(name).pw_uid, or None when the account does not exist."""
        import pwd

        try:
            return pwd.getpwnam(name).pw_uid
        except KeyError:
            return None

    def resolve_group(self, name: str) -> int | None:
        import grp

        try:
            return grp.getgrnam(name).gr_gid
        except KeyError:
            return None


class Backend:
    """Allow-listed systemctl: ``show`` of the Core, ``start``/``stop`` of the F1 detector unit ONLY. Anything else is refused."""

    def systemctl(self, *args: str) -> CommandResult:
        allowed = args == ("show", CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID") or (
            len(args) == 2 and args[0] in ("start", "stop") and args[1] == DETECTOR_UNIT
        )
        if not allowed:
            refuse("SYSTEMCTL_VERB_NOT_ALLOWED")
        timeout = SHOW_TIMEOUT_SEC if args[0] == "show" else (START_TIMEOUT_SEC if args[0] == "start" else STOP_TIMEOUT_SEC)
        try:
            done = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return CommandResult(124, "")
        return CommandResult(done.returncode, done.stdout)


def _core_props(backend: Backend) -> dict[str, str]:
    result = backend.systemctl("show", CORE_UNIT, "-pActiveState", "-pSubState", "-pMainPID")
    if result.rc != 0:
        refuse("CORE_STATE_UNKNOWN")
    return dict(line.split("=", 1) for line in result.out.splitlines() if "=" in line)


def verify_socket(host: Host, core_uid: int, uid: int, gid: int, *, socket_path: str = SOCKET_PATH,
                  runtime_dir: str = RUNTIME_DIR) -> None:
    """Static facts only (no connect, so no alert is ever created): socket type, owner, group, mode, the dedicated directory, and that the
    detector (``uid`` + the alert group, no capability) can reach it."""
    try:
        directory = host.lstat(runtime_dir)
        sock = host.lstat(socket_path)
    except FileNotFoundError:
        refuse("ALERT_SOCKET_MISSING")
    except OSError:
        refuse("ALERT_SOCKET_UNREADABLE")
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != core_uid or directory.st_gid != gid
            or stat.S_IMODE(directory.st_mode) != RUNTIME_DIR_MODE):
        refuse("ALERT_RUNTIME_DIR_UNEXPECTED")
    if not stat.S_ISSOCK(sock.st_mode):
        refuse("ALERT_SOCKET_NOT_A_SOCKET")
    if sock.st_uid != core_uid or sock.st_gid != gid:
        refuse("ALERT_SOCKET_WRONG_OWNER")
    if stat.S_IMODE(sock.st_mode) != SOCKET_MODE:
        refuse("ALERT_SOCKET_WRONG_MODE")
    if not can_connect(uid, (gid,), socket_uid=sock.st_uid, socket_gid=sock.st_gid, socket_mode=stat.S_IMODE(sock.st_mode),
                       dir_uid=directory.st_uid, dir_gid=directory.st_gid, dir_mode=stat.S_IMODE(directory.st_mode)):
        refuse("ALERT_SOURCE_CANNOT_REACH_SOCKET")


def start_detector(uid: int, core_uid: int, host: Host, backend: Backend) -> dict[str, str]:
    """The ordered gate. Every earlier step must pass before the single ``systemctl start`` of the F1 detector unit; nothing is retried."""
    verify_account(host, uid, core_uid)  # the exact dedicated, non-root, non-Core account at exactly the frozen uid
    gid = host.resolve_group(ALERT_GROUP)
    if gid is None or gid <= 0:
        refuse("ALERT_GROUP_MISSING")
    verify_env(host.read_bytes(CORE_ENV), uid, core_uid=core_uid)  # core.env carries the verified uid (written by L7u)
    verify_unit(host.read_bytes(UNIT_PATH))  # the unit that would start is the reviewed static one
    props = _core_props(backend)  # the Core is up ...
    if props.get("ActiveState") != "active" or props.get("SubState") != "running":
        refuse("CORE_NOT_RUNNING")
    pid = props.get("MainPID", "0")
    if not pid.isdigit() or int(pid) <= 0:
        refuse("CORE_NOT_RUNNING")
    projected = [line for line in host.proc_environ(int(pid)).decode("utf-8", "replace").split("\0") if line.startswith(f"{ENV_KEY}=")]
    if projected != [f"{ENV_KEY}={uid}"]:  # ... the RUNNING Core actually carries the uid (restarted after core.env changed) ...
        refuse("CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID")
    if gid not in host.proc_groups(int(pid)):  # ... and the alert group (L7u drop-in applied by that same single restart)
        refuse("CORE_LACKS_ALERT_GROUP")
    verify_socket(host, core_uid, uid, gid)  # the dedicated alert.sock exists with the exact owner/group/mode
    if backend.systemctl("start", DETECTOR_UNIT).rc != 0:  # only now
        refuse("DETECTOR_START_FAILED")
    return {"F1_DETECTOR_START": "PASS"}


def rollback_detector(backend: Backend) -> dict[str, str]:
    """Bounded and fail closed: one ``systemctl stop`` of the F1 detector unit, nothing else. Never touches the Core, core.env, ESP32 or containment."""
    if backend.systemctl("stop", DETECTOR_UNIT).rc != 0:
        refuse("DETECTOR_STOP_FAILED")
    return {"F1_DETECTOR_STOP": "PASS"}


# ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _core_uid_from_passwd() -> int:
    import pwd

    try:
        return pwd.getpwnam(CORE_USER).pw_uid
    except KeyError:
        refuse("CORE_ACCOUNT_UNRESOLVED")
        raise  # unreachable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sp = sub.add_parser("render-unit")
    sp.add_argument("--output", required=True)
    sp = sub.add_parser("verify-unit")
    sp.add_argument("--file", required=True)
    sp = sub.add_parser("verify-env")
    sp.add_argument("--uid", required=True)
    sp.add_argument("--file", required=True)
    sp.add_argument("--core-uid", default=None)
    for name in ("start-detector", "stop-detector"):
        sp = sub.add_parser(name)
        if name == "start-detector":
            sp.add_argument("--uid", required=True)
    args = parser.parse_args(argv)
    label = "F1_" + args.command.upper().replace("-", "_")
    try:
        if args.command in ("start-detector", "stop-detector"):
            if os.environ.get("AEGIS_F1_LIVE_AUTHORIZED") != "YES":
                refuse("LIVE_AUTHORIZATION_FLAG_REQUIRED")
            if os.geteuid() != 0:
                refuse("ROOT_REQUIRED")
        if args.command == "render-unit":
            output = Path(args.output)
            if output.exists() or output.is_symlink():
                refuse("OUTPUT_EXISTS")
            blob = render_unit(UNIT_TEMPLATE.read_bytes())
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(blob)
            result = {label: "PASS"}
        elif args.command == "verify-unit":
            verify_unit(Path(args.file).read_bytes())
            result = {label: "PASS"}
        elif args.command == "verify-env":
            core = parse_uid(args.core_uid) if args.core_uid is not None else None
            verify_env(Path(args.file).read_bytes(), parse_uid(args.uid), core_uid=core)
            result = {label: "PASS"}
        elif args.command == "start-detector":
            result = start_detector(parse_uid(args.uid), _core_uid_from_passwd(), Host(), Backend())
        else:
            result = rollback_detector(Backend())
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
