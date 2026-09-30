"""Unprivileged Recovery client: one bounded AF_UNIX request to the Core-owned Recovery socket.

Stdlib and ``recovery_protocol`` only. It holds no protocol key, broker credential, database handle,
containment socket or PIN, and it never publishes. It refuses to talk to a socket whose server is not
the Core account, so an impostor listener on the path cannot feed the operator false evidence.
"""

from __future__ import annotations

import json
import os
import socket
import struct
from typing import Any

from . import recovery_protocol as rp

DEFAULT_CORE_USER = "aegis-idea3"
SOCKET_ENV = "AEGIS_RECOVERY_SOCKET"
CORE_USER_ENV = "AEGIS_RECOVERY_CORE_USER"


class RecoveryUnavailable(RuntimeError):
    """The channel could not be reached or trusted; nothing was requested."""


class RecoveryOutcomeUnknown(RuntimeError):
    """The Core accepted the connection but no bounded, valid answer came back; do not assume success."""


def _peer_uid(connection: socket.socket) -> int:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)[1]


def socket_path(environ: dict[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    path = env.get(SOCKET_ENV, "").strip() or rp.DEFAULT_SOCKET_PATH
    if not os.path.isabs(path):
        raise RecoveryUnavailable("the Recovery socket path must be absolute")
    return path


def core_uid(environ: dict[str, str] | None = None) -> int:
    import pwd

    env = os.environ if environ is None else environ
    user = env.get(CORE_USER_ENV, "").strip() or DEFAULT_CORE_USER
    try:
        return pwd.getpwnam(user).pw_uid
    except KeyError:
        raise RecoveryUnavailable("the Core account cannot be resolved") from None


def request(
    op: str,
    *,
    summary: str | None = None,
    path: str | None = None,
    expected_uid: int | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    try:
        body = rp.build_request(op, summary=summary)
    except rp.RequestError as error:
        raise RecoveryUnavailable(f"request refused locally: {error.code}") from None
    target = path if path is not None else socket_path()
    server_uid = expected_uid if expected_uid is not None else core_uid()
    if not hasattr(socket, "AF_UNIX") or not hasattr(socket, "SO_PEERCRED"):
        raise RecoveryUnavailable("local Recovery requires a POSIX AF_UNIX platform")

    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    connected = False
    try:
        client.connect(target)
        connected = True
        if _peer_uid(client) != server_uid:
            raise RecoveryUnavailable("the Recovery server is not the Core account")
        client.sendall(json.dumps(body, ensure_ascii=False).encode("utf-8") + b"\n")
        reply = client.makefile("rb").readline(rp.MAX_MESSAGE_BYTES + 1)
        if not reply or len(reply) > rp.MAX_MESSAGE_BYTES:
            raise RecoveryOutcomeUnknown("no bounded result was returned")
        try:
            parsed = json.loads(reply.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise RecoveryOutcomeUnknown("the Core returned an invalid result") from None
        if not isinstance(parsed, dict) or parsed.get("v") != rp.PROTOCOL_VERSION or "ok" not in parsed:
            raise RecoveryOutcomeUnknown("the Core returned an invalid result")
        return parsed
    except (RecoveryUnavailable, RecoveryOutcomeUnknown):
        raise
    except OSError:
        if connected:
            raise RecoveryOutcomeUnknown("the result was lost; do not assume success") from None
        raise RecoveryUnavailable("the Core Recovery channel is unavailable") from None
    finally:
        client.close()
