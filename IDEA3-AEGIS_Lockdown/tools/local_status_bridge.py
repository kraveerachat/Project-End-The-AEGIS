"""Loopback, read-only bridge from the Core status file to the Web runtime feed.

The Web reads the Core's versioned ``safe_status_projection`` over HTTP
(``AEGIS_IDEA3_RUNTIME_STATUS_URL``).  This process serves exactly that document
for one explicit status file and nothing else.  It is a LAB/local aid: it binds
loopback only, answers ``GET /status`` only, never writes, never runs a
subprocess (no sudo fallback), and never contacts MQTT, the Core, or hardware.
A missing, unreadable or stale file yields the Core's own "absent" projection,
which the Web renders as UNKNOWN.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from aegis_soc.runtime import read_status, safe_status_projection

STATUS_ROUTE = "/status"
MAX_STATUS_BYTES = 64 * 1024


def _require_loopback(host: str) -> str:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as error:
        raise ValueError("bridge host must be a loopback IP literal") from error
    if not address.is_loopback:
        raise ValueError("bridge host must be a loopback address")
    return host


def projection_for(status_file: Path) -> dict:
    """Return the Core projection for ``status_file``; anything unusable is the absent projection."""

    try:
        if status_file.stat().st_size > MAX_STATUS_BYTES:
            return safe_status_projection(None)
    except OSError:
        return safe_status_projection(None)
    return safe_status_projection(read_status(status_file))


def make_handler(status_file: Path):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AegisStatusBridge"
        sys_version = ""

        def _send(self, code: int, body: bytes = b"", content_type: str = "application/json") -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            if self.path != STATUS_ROUTE:
                return self._send(404)
            return self._send(200, json.dumps(projection_for(status_file)).encode("utf-8"))

        def _refuse(self):
            self._send(405)

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse

        def log_message(self, *_args):
            return None

    return Handler


def build_server(status_file: Path, *, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    status_file = Path(status_file)
    if not status_file.is_absolute():
        raise ValueError("status file must be an absolute path")
    server = ThreadingHTTPServer((_require_loopback(host), port), make_handler(status_file))
    server.daemon_threads = True
    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--status-file", required=True, type=Path, help="absolute path of the Core status.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    try:
        server = build_server(args.status_file, host=args.host, port=args.port)
    except (ValueError, OSError) as error:
        print(f"status bridge refused to start: {error}", file=sys.stderr)
        return 2
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"status bridge listening on http://{server.server_address[0]}:{server.server_address[1]}{STATUS_ROUTE}", flush=True)
    stop.wait()
    server.shutdown()
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
