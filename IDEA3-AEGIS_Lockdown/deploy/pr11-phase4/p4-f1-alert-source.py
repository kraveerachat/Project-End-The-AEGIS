#!/usr/bin/env python3
"""F1 alert-source deployment package: render / verify / ordered start / bounded stop (repository tooling; merging it authorizes nothing live).

Companion of the merged Core-local alert ingress (<runtime_dir>/alert.sock, SO_PEERCRED, ``AEGIS_ALERT_SOURCE_UID``) and of the production
detector (``python -m aegis_soc.production_detector``). It carries the contract a FUTURE governed deployment must satisfy:

    1. new Core release installed            (L7u / owner stage; not this tool)
    2. core.env holds ONE verified AEGIS_ALERT_SOURCE_UID   -> ``verify-env``
    3. Core started/restarted                (L7u / owner stage; not this tool; this tool never restarts the Core)
    4. alert.sock present, Core-owned 0600, the account can reach it, the running Core carries the uid   -> ``start-detector`` gate
    5. only then the detector unit may start -> ``start-detector`` (exactly one ``systemctl start`` of the F1 detector unit)

Identity is an owner-supplied, frozen, non-secret numeric uid (F1_ALERT_SOURCE_IDENTITY = OWNER_INPUT_REQUIRED). The tool never creates an
account, never chooses a uid, and refuses (fail closed) a uid that the merged Core socket contract cannot serve (0600 socket in a 0700
directory, both Core-owned: only root or the Core account can connect) and the Core's own uid (a sender indistinguishable from the Core).

Boundaries: no useradd/groupadd, no Core verb at all (no restart/stop/start of aegis-idea3-core.service, only ``show``), no MQTT, no ESP32, no
CUT/RESTORE, no containment, no shell, no automatic retry, no host-root option. ``start-detector``/``stop-detector`` act on the real host only
with AEGIS_F1_LIVE_AUTHORIZED=YES and root; the Python API is driven by a ``Host``/``Backend`` pair so the fixture tests never touch a host.
Output is fixed reason codes and non-secret identifiers only; never environment content.
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
UNIT_TEMPLATE = DEPLOY_DIR / "aegis-idea3-detector.service.example"
UNIT_PATH = f"/etc/systemd/system/{DETECTOR_UNIT}"
CORE_ENV = "/etc/aegis-idea3/core.env"
RUNTIME_DIR = "/run/aegis-idea3"
SOCKET_PATH = f"{RUNTIME_DIR}/alert.sock"
PLACEHOLDER = "@AEGIS_ALERT_SOURCE_UID@"
ENV_KEY = "AEGIS_ALERT_SOURCE_UID"
SOCKET_MODE = 0o600
RUNTIME_DIR_MODE = 0o700  # RuntimeDirectoryMode of the Core unit
STOP_TIMEOUT_SEC = 30.0
START_TIMEOUT_SEC = 45.0
SHOW_TIMEOUT_SEC = 10.0
ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")

#: The only active (non-comment) lines the unit may contain besides the hardening block verified key by key below.
EXEC_PRE = "/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.alert_sink check-socket --wait-sec 15"
EXEC_START = "/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector"
REQUIRED_UNIT_LINES = (
    "Requires=aegis-idea3-core.service", "After=aegis-idea3-core.service", "Restart=no", "NoNewPrivileges=true",
    "RestrictAddressFamilies=AF_UNIX", "CapabilityBoundingSet=CAP_DAC_OVERRIDE", "ProtectSystem=strict", "PrivateTmp=true",
    f"ExecStartPre={EXEC_PRE}", f"ExecStart={EXEC_START}",
)
SINGLE_VALUE_KEYS = ("User", "Group", "ExecStart", "ExecStartPre", "Restart", "EnvironmentFile", "Environment", "ExecStartPost",
                     "ExecStop", "ExecStopPost", "ExecReload", "LoadCredential", "ReadWritePaths", "RestrictAddressFamilies")
# Substrings that must never appear on an active unit line: MQTT transport/topic, plaintext broker port, shells, containment verbs.
FORBIDDEN_ACTIVE = ("mqtt", "paho", "attacker_ip", "1883", "8883", "/bin/sh", "/bin/bash", "bash ", "sh -c", "&&", "||", ";", "|", "`",
                    "$(", "nft", "iptables", "containment", "restore", "environmentfile", "loadcredential", "ExecStartPost",
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


def can_connect(uid: int, *, socket_uid: int, socket_mode: int, dir_uid: int, dir_mode: int) -> bool:
    """Whether ``uid`` (no supplementary groups assumed) can connect(2) to a socket with this ownership and these modes.

    root passes (CAP_DAC_OVERRIDE, which the unit retains); otherwise it needs search permission on the directory and write permission on the
    socket as owner or as other. The merged Core ingress creates the socket 0600 and the runtime directory is 0700, both Core-owned.
    """
    if uid == 0:
        return True
    dir_ok = bool(dir_mode & (0o100 if uid == dir_uid else 0o001))
    sock_ok = bool(socket_mode & (0o200 if uid == socket_uid else 0o002))
    return dir_ok and sock_ok


def verify_identity(uid: int, core_uid: int, *, socket_mode: int = SOCKET_MODE, dir_mode: int = RUNTIME_DIR_MODE) -> None:
    if core_uid <= 0:
        refuse("CORE_UID_INVALID")
    if uid == core_uid:
        refuse("ALERT_SOURCE_IS_CORE_ACCOUNT")
    if not can_connect(uid, socket_uid=core_uid, socket_mode=socket_mode, dir_uid=core_uid, dir_mode=dir_mode):
        refuse("ALERT_SOURCE_CANNOT_REACH_SOCKET")


# ── unit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def _active_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def render_unit(template: bytes, uid: int) -> bytes:
    try:
        text = template.decode("utf-8")
    except UnicodeDecodeError:
        refuse("TEMPLATE_INVALID")
    if sum(line.count(PLACEHOLDER) for line in _active_lines(text)) != 1:
        refuse("TEMPLATE_INVALID")
    out = text.replace(f"User={PLACEHOLDER}", f"User={uid}")
    if PLACEHOLDER in "\n".join(_active_lines(out)):
        refuse("TEMPLATE_INVALID")
    return out.encode("utf-8")


def verify_unit(data: bytes, uid: int) -> None:
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
    users = [line for line in lines if line.startswith("User=")]
    if len(users) != 1:
        refuse("UNIT_USER_MISSING")
    if users[0] != f"User={uid}":
        refuse("UNIT_USER_MISMATCH")
    if any(line.startswith("Group=") for line in lines):
        refuse("UNIT_GROUP_NOT_ALLOWED")  # the primary group follows the frozen uid; an extra group is an unreviewed identity
    for required in REQUIRED_UNIT_LINES:
        if required not in lines:
            refuse(f"UNIT_REQUIRED_LINE_MISSING:{required.split('=', 1)[0]}")
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


def verify_socket(host: Host, core_uid: int, uid: int, *, socket_path: str = SOCKET_PATH, runtime_dir: str = RUNTIME_DIR) -> None:
    """Static facts only (no connect, so no alert is ever created): socket type, owner, mode, directory, and that ``uid`` can reach it."""
    try:
        directory = host.lstat(runtime_dir)
        sock = host.lstat(socket_path)
    except FileNotFoundError:
        refuse("ALERT_SOCKET_MISSING")
    except OSError:
        refuse("ALERT_SOCKET_UNREADABLE")
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != core_uid or stat.S_IMODE(directory.st_mode) & 0o022:
        refuse("ALERT_RUNTIME_DIR_UNEXPECTED")
    if not stat.S_ISSOCK(sock.st_mode):
        refuse("ALERT_SOCKET_NOT_A_SOCKET")
    if sock.st_uid != core_uid:
        refuse("ALERT_SOCKET_WRONG_OWNER")
    if stat.S_IMODE(sock.st_mode) != SOCKET_MODE:
        refuse("ALERT_SOCKET_WRONG_MODE")
    verify_identity(uid, core_uid, socket_mode=stat.S_IMODE(sock.st_mode), dir_mode=stat.S_IMODE(directory.st_mode))


def start_detector(uid: int, core_uid: int, host: Host, backend: Backend) -> dict[str, str]:
    """The ordered gate. Every earlier step must pass before the single ``systemctl start`` of the F1 detector unit; nothing is retried."""
    verify_identity(uid, core_uid)
    verify_env(host.read_bytes(CORE_ENV), uid, core_uid=core_uid)  # 2. core.env carries the verified uid
    verify_unit(host.read_bytes(UNIT_PATH), uid)  # the unit that would start is the rendered one for this uid
    props = _core_props(backend)  # 3. the Core is up ...
    if props.get("ActiveState") != "active" or props.get("SubState") != "running":
        refuse("CORE_NOT_RUNNING")
    pid = props.get("MainPID", "0")
    if not pid.isdigit() or int(pid) <= 0:
        refuse("CORE_NOT_RUNNING")
    projected = [line for line in host.proc_environ(int(pid)).decode("utf-8", "replace").split("\0") if line.startswith(f"{ENV_KEY}=")]
    if projected != [f"{ENV_KEY}={uid}"]:  # ... and the RUNNING Core actually carries the uid (restarted after core.env changed)
        refuse("CORE_RUNNING_WITHOUT_ALERT_SOURCE_UID")
    verify_socket(host, core_uid, uid)  # 4. alert.sock exists with the expected owner/mode
    if backend.systemctl("start", DETECTOR_UNIT).rc != 0:  # 5. only now
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
    sp.add_argument("--uid", required=True)
    sp.add_argument("--output", required=True)
    sp = sub.add_parser("verify-unit")
    sp.add_argument("--uid", required=True)
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
            uid = parse_uid(args.uid)
            output = Path(args.output)
            if output.exists() or output.is_symlink():
                refuse("OUTPUT_EXISTS")
            blob = render_unit(UNIT_TEMPLATE.read_bytes(), uid)
            verify_unit(blob, uid)
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(blob)
            result = {label: "PASS"}
        elif args.command == "verify-unit":
            verify_unit(Path(args.file).read_bytes(), parse_uid(args.uid))
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
