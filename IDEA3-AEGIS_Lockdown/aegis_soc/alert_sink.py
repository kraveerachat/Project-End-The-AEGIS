"""F1 production alert sink: one bounded AF_UNIX request to the Core-owned ``alert.sock``.

Stdlib and ``ip_containment`` only (the same address rules the Core ingress applies). It holds no broker credential, no key, no
database handle and never publishes to MQTT. The sender chooses nothing but the IPv4 address it observed: the payload is exactly
``{"v":1,"attacker_ip":"<IPv4>"}`` plus a newline, the socket path is a constant (never derived from detection input), and the
Core account is verified through SO_PEERCRED before a byte is written. One call is one attempt: there is no retry loop here.

Every outcome is a stable, secret-free ``AlertResult.code``. The module also carries the bounded start-time socket check used by the
detector unit's ``ExecStartPre=`` so a detector can never start (and spam) before the Core ingress exists.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import struct
import sys
import time
from typing import NamedTuple

from . import ip_containment

# OD-F1-DEPLOY-01: ONE dedicated F1 alert surface. The general /run/aegis-idea3 directory and the Recovery socket are never used here.
ALERT_RUNTIME_DIR = "/run/aegis-idea3-alert"
ALERT_SOCKET_PATH = f"{ALERT_RUNTIME_DIR}/alert.sock"
CORE_USER = "aegis-idea3"
ALERT_GROUP = "aegis-idea3-alert"  # filesystem reachability only; SO_PEERCRED uid stays the authentication authority
DETECTOR_ACCOUNT = "aegis-idea3-detector"
PAYLOAD_VERSION = 1
SEND_TIMEOUT_SEC = 2.0  # one monotonic budget for connect + write + read (the Core's own request deadline is 2 s)
MAX_REPLY_BYTES = 4096
SOCKET_MODE = 0o620  # Core-owned, group aegis-idea3-alert: owner rw, group write (= connect) only, nothing for others
RUNTIME_DIR_MODE = 0o2750  # setgid, owner rwx, group r-x (traverse only; no group create/delete), nothing for others
CHECK_WAIT_MAX_SEC = 60.0
CHECK_POLL_SEC = 0.5

# Result codes. The first group is produced locally; REJECTED_* mirror the Core's stable refusal codes.
SENT_BOUND = "SENT_BOUND"
SENT_EXISTING = "SENT_EXISTING"
INVALID_ADDRESS = "INVALID_ADDRESS"
SOCKET_MISSING = "SOCKET_MISSING"
SOCKET_REFUSED = "SOCKET_REFUSED"
PEER_NOT_CORE = "PEER_NOT_CORE"
TIMEOUT = "TIMEOUT"
REPLY_INVALID = "REPLY_INVALID"
OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"
UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM"
CORE_REJECTED = "CORE_REJECTED"
#: Failures that mean the Core ingress itself is not usable (as opposed to one refused alert).
TRANSPORT_FAILURES = frozenset({SOCKET_MISSING, SOCKET_REFUSED, PEER_NOT_CORE, TIMEOUT, REPLY_INVALID, OUTCOME_UNKNOWN, UNSUPPORTED_PLATFORM})
_CORE_CODES = frozenset({"PEER_REFUSED", "RATE_LIMITED", "MALFORMED_REQUEST", "BAD_ADDRESS", "ALERT_FAILED", "NOT_PRODUCTION",
                         "IGNORED_DIFFERENT_IP", "AUDIT_UNAVAILABLE", "OUTCOME_UNKNOWN"})


class AlertResult(NamedTuple):
    ok: bool
    code: str
    detail: str = ""  # a stable non-secret token (for a Core refusal: the Core's own code), never free text


def build_payload(address: object) -> bytes:
    """The exact F1 request line. Raises ``ValueError`` for anything the Core ingress would refuse as an address."""
    try:
        validated = str(ip_containment.validate_block_target(address, ()))
    except ip_containment.ContainmentRejected:
        raise ValueError(INVALID_ADDRESS) from None
    return json.dumps({"v": PAYLOAD_VERSION, "attacker_ip": validated}, separators=(",", ":")).encode("ascii") + b"\n"


def _peer_uid(connection: socket.socket) -> int:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)[1]


def core_uid() -> int:
    import pwd

    return pwd.getpwnam(CORE_USER).pw_uid


def alert_gid() -> int:
    import grp

    return grp.getgrnam(ALERT_GROUP).gr_gid


def send_alert(address: object, *, path: str = ALERT_SOCKET_PATH, expected_core_uid: int | None = None,
               timeout: float = SEND_TIMEOUT_SEC) -> AlertResult:
    """Send one alert, once. ``path`` is configuration (tests, the constant default) and never comes from detection input."""
    try:
        payload = build_payload(address)
    except ValueError:
        return AlertResult(False, INVALID_ADDRESS)
    if not hasattr(socket, "AF_UNIX") or not hasattr(socket, "SO_PEERCRED"):
        return AlertResult(False, UNSUPPORTED_PLATFORM)
    try:
        want_uid = core_uid() if expected_core_uid is None else int(expected_core_uid)
    except (KeyError, ImportError):
        return AlertResult(False, PEER_NOT_CORE, "core_account_unresolved")
    deadline = time.monotonic() + max(0.05, float(timeout))
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connected = False
    try:
        client.settimeout(max(0.05, deadline - time.monotonic()))
        client.connect(path)
        connected = True
        if _peer_uid(client) != want_uid:
            return AlertResult(False, PEER_NOT_CORE)
        client.settimeout(max(0.05, deadline - time.monotonic()))
        client.sendall(payload)
        reply = bytearray()
        while len(reply) <= MAX_REPLY_BYTES and b"\n" not in reply:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            client.settimeout(remaining)
            chunk = client.recv(1024)
            if not chunk:
                break
            reply.extend(chunk)
        return _interpret(bytes(reply))
    except TimeoutError:
        return AlertResult(False, TIMEOUT) if not connected else AlertResult(False, OUTCOME_UNKNOWN, "timeout")
    except FileNotFoundError:
        return AlertResult(False, SOCKET_MISSING)
    except (ConnectionRefusedError, PermissionError):
        return AlertResult(False, SOCKET_REFUSED)
    except OSError:
        return AlertResult(False, OUTCOME_UNKNOWN if connected else SOCKET_REFUSED)
    finally:
        client.close()


def _interpret(reply: bytes) -> AlertResult:
    if not reply or len(reply) > MAX_REPLY_BYTES or b"\n" not in reply:
        return AlertResult(False, REPLY_INVALID)
    try:
        parsed = json.loads(reply.split(b"\n", 1)[0].decode("utf-8"))
    except (UnicodeError, ValueError):
        return AlertResult(False, REPLY_INVALID)
    if not isinstance(parsed, dict) or parsed.get("v") != 1 or not isinstance(parsed.get("ok"), bool):
        return AlertResult(False, REPLY_INVALID)
    code = parsed.get("code")
    if parsed["ok"]:
        if code == "BOUND":
            return AlertResult(True, SENT_BOUND)
        if code == "EXISTING":
            return AlertResult(True, SENT_EXISTING)
        return AlertResult(False, REPLY_INVALID)
    return AlertResult(False, CORE_REJECTED, code if code in _CORE_CODES else "UNRECOGNISED")


# ---------------------------------------------------------------- start-time socket check (detector ExecStartPre)


def check_socket(path: str = ALERT_SOCKET_PATH, *, expected_core_uid: int | None = None, expected_gid: int | None = None,
                 wait_sec: float = 0.0, sleep=time.sleep, clock=time.monotonic) -> str:
    """Return ``ALERT_SOCKET_OK`` or a stable failure code. Bounded: polls at most ``wait_sec`` (capped), never indefinitely.

    Passes only when the path is a socket owned by the Core account, group ``aegis-idea3-alert``, mode 0620, inside a Core-owned
    0o2750 directory of the same group, and a live Core listener answers the peer credential check. No byte is written, so no alert is
    created by the check.
    """
    wait = min(max(float(wait_sec), 0.0), CHECK_WAIT_MAX_SEC)
    deadline = clock() + wait
    while True:
        verdict = _check_once(path, expected_core_uid, expected_gid)
        if verdict == "ALERT_SOCKET_OK" or verdict != "ALERT_SOCKET_MISSING" or clock() >= deadline:
            return verdict
        sleep(CHECK_POLL_SEC)


def _check_once(path: str, expected_core_uid: int | None, expected_gid: int | None) -> str:
    try:
        want_uid = core_uid() if expected_core_uid is None else int(expected_core_uid)
    except (KeyError, ImportError):
        return "ALERT_SOCKET_CORE_ACCOUNT_UNRESOLVED"
    try:
        want_gid = alert_gid() if expected_gid is None else int(expected_gid)
    except (KeyError, ImportError):
        return "ALERT_SOCKET_GROUP_UNRESOLVED"
    try:
        directory = os.lstat(os.path.dirname(path))
    except FileNotFoundError:
        return "ALERT_SOCKET_MISSING"
    except OSError:
        return "ALERT_SOCKET_UNREADABLE"
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != want_uid or directory.st_gid != want_gid
            or stat.S_IMODE(directory.st_mode) != RUNTIME_DIR_MODE):
        return "ALERT_RUNTIME_DIR_UNEXPECTED"
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return "ALERT_SOCKET_MISSING"
    except OSError:
        return "ALERT_SOCKET_UNREADABLE"
    if not stat.S_ISSOCK(metadata.st_mode):
        return "ALERT_SOCKET_NOT_A_SOCKET"
    if metadata.st_uid != want_uid or metadata.st_gid != want_gid:
        return "ALERT_SOCKET_WRONG_OWNER"
    if stat.S_IMODE(metadata.st_mode) != SOCKET_MODE:
        return "ALERT_SOCKET_WRONG_MODE"
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(1.0)
        probe.connect(path)
        if _peer_uid(probe) != want_uid:
            return "ALERT_SOCKET_PEER_NOT_CORE"
    except (OSError, AttributeError):
        return "ALERT_SOCKET_NOT_LISTENING"
    finally:
        probe.close()
    return "ALERT_SOCKET_OK"


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] != "check-socket":
        print("ALERT_SOCKET=FAIL reason=USAGE", file=sys.stderr)
        return 2
    wait = 0.0
    rest = args[1:]
    if rest:
        if len(rest) != 2 or rest[0] != "--wait-sec":
            print("ALERT_SOCKET=FAIL reason=USAGE", file=sys.stderr)
            return 2
        try:
            wait = float(rest[1])
        except ValueError:
            print("ALERT_SOCKET=FAIL reason=USAGE", file=sys.stderr)
            return 2
    verdict = check_socket(wait_sec=wait)
    if verdict == "ALERT_SOCKET_OK":
        print("ALERT_SOCKET=PASS")
        return 0
    print(f"ALERT_SOCKET=FAIL reason={verdict}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
