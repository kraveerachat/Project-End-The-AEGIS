#!/usr/bin/env python3
"""R1D stage-only caller (stdlib only). Sends the ONE disposition request to the Core's dedicated local socket and prints the Core's answer.

It carries no incident id and no address: only the owner-authorized binding digest (confirmation). The Core verifies the kernel peer credentials (uid 0), re-derives the target
itself, re-checks every eligibility condition and the digest inside one atomic transaction. This tool never opens the database and never retries: a transport failure is
reported as OUTCOME_UNKNOWN (the caller must inspect read-only, never resend)."""

from __future__ import annotations

import json
import re
import socket
import stat
import sys
from pathlib import Path

CHANNEL_NAME = "historical-disposition.sock"
_DIGEST = re.compile(r"[0-9a-f]{64}")


def call(socket_path: str, digest: str, timeout: float = 10.0) -> dict:
    path = Path(socket_path)
    if not path.is_absolute() or path.name != CHANNEL_NAME or ".." in path.parts:
        return {"ok": False, "code": "SOCKET_PATH_INVALID"}
    if _DIGEST.fullmatch(digest) is None:
        return {"ok": False, "code": "BINDING_INVALID"}
    try:
        if not stat.S_ISSOCK(path.lstat().st_mode):
            return {"ok": False, "code": "NOT_A_SOCKET"}
    except OSError:
        return {"ok": False, "code": "SOCKET_MISSING"}
    body = json.dumps({"v": 1, "op": "DISPOSE_HISTORICAL", "binding_sha256": digest}, separators=(",", ":")).encode("ascii") + b"\n"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(path))
            client.sendall(body)
            data = b""
            while not data.endswith(b"\n") and len(data) < 4096:
                chunk = client.recv(1024)
                if not chunk:
                    break
                data += chunk
        return json.loads(data.decode("utf-8"))
    except (OSError, ValueError):
        return {"ok": False, "code": "OUTCOME_UNKNOWN"}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: r1d_dispose_call.py SOCKET_PATH BINDING_SHA256", file=sys.stderr)
        return 2
    response = call(argv[1], argv[2])
    if response.get("ok") is True and response.get("code") == "DISPOSED":
        print(f"R1D_DISPOSITION=DISPOSED R1D_INCIDENT_ID={int(response['incident_id'])} R1D_RECOVERY_R8=NO")
        return 0
    print(f"R1D_DISPOSITION=FAIL reason={str(response.get('code', 'UNKNOWN'))[:64]}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
