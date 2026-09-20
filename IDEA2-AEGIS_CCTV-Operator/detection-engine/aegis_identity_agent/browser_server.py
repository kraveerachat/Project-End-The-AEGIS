"""Strict loopback HTTP surface for fixed browser-association assertions."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import time
from urllib.parse import urlsplit

from .browser_protocol import build_browser_assertion
from .protocol import parse_strict_json_bytes


LOOPBACK_HOST = "127.0.0.1"
BROWSER_PORT = 8078
ASSERT_PATH = "/v1/browser-association/assert"
MAX_REQUEST_BYTES = 16 * 1024
MAX_RESPONSE_BYTES = 4 * 1024


def validate_loopback_bind(host: str) -> str:
    if host != LOOPBACK_HOST:
        raise ValueError("browser listener must bind exactly 127.0.0.1")
    return host


def normalize_allowed_origins(values) -> frozenset[str]:
    normalized = set()
    for raw in values:
        value = str(raw).strip()
        if not value or value in {"*", "null"}:
            raise ValueError("browser origin is not allowed")
        parsed = urlsplit(value)
        try:
            _port = parsed.port
        except ValueError as exc:
            raise ValueError("browser origin is invalid") from exc
        if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            raise ValueError("browser origin must not contain credentials, query, or fragment")
        if parsed.path not in ("", "/") or not parsed.hostname:
            raise ValueError("browser origin must be an exact serialized origin")
        is_loopback = parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and is_loopback):
            raise ValueError("browser origin must use HTTPS except explicit loopback development")
        canonical = f"{parsed.scheme}://{parsed.netloc}"
        if value.rstrip("/") != canonical:
            raise ValueError("browser origin is not canonical")
        normalized.add(canonical)
    if not normalized:
        raise ValueError("at least one browser origin is required")
    return frozenset(normalized)


class BrowserRateLimiter:
    def __init__(self, *, now=time.monotonic, limit=12, window_s=60.0, max_origins=128):
        self._now = now
        self._limit = int(limit)
        self._window_s = float(window_s)
        self._max_origins = int(max_origins)
        self._attempts = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, origin: str) -> bool:
        now = self._now()
        with self._lock:
            if origin not in self._attempts and len(self._attempts) >= self._max_origins:
                return False
            attempts = self._attempts[origin]
            while attempts and now - attempts[0] >= self._window_s:
                attempts.popleft()
            if len(attempts) >= self._limit:
                return False
            attempts.append(now)
            return True


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes


def _before_io(*, deadline, now, set_timeout):
    if deadline is None:
        return
    remaining = deadline - now()
    if remaining <= 0:
        raise TimeoutError("request deadline exceeded")
    if set_timeout is not None:
        set_timeout(remaining)


def _read_piece(stream, size, *, deadline, now, set_timeout) -> bytes:
    _before_io(deadline=deadline, now=now, set_timeout=set_timeout)
    reader = getattr(stream, "read1", stream.read)
    return reader(size)


def _read_exact(stream, size, *, deadline, now, set_timeout) -> bytes:
    result = bytearray()
    while len(result) < size:
        piece = _read_piece(
            stream, min(4096, size - len(result)), deadline=deadline, now=now, set_timeout=set_timeout
        )
        if not piece:
            raise ValueError("request body is incomplete")
        result.extend(piece)
    return bytes(result)


def _read_line(stream, limit=128, *, deadline=None, now=time.monotonic, set_timeout=None) -> bytes:
    line = bytearray()
    while len(line) <= limit:
        piece = _read_piece(stream, 1, deadline=deadline, now=now, set_timeout=set_timeout)
        if not piece:
            break
        line.extend(piece)
        if line.endswith(b"\r\n"):
            return bytes(line[:-2])
    raise ValueError("request framing is invalid")


def read_bounded_http_body(
    stream, headers, *, max_bytes=MAX_REQUEST_BYTES, deadline=None,
    now=time.monotonic, set_timeout=None,
) -> bytes:
    normalized = {str(key).lower(): str(value).strip() for key, value in headers.items()}
    transfer = normalized.get("transfer-encoding")
    length = normalized.get("content-length")
    if transfer:
        if transfer.lower() != "chunked" or length is not None:
            raise ValueError("request framing is invalid")
        body = bytearray()
        while True:
            size_text = _read_line(
                stream, deadline=deadline, now=now, set_timeout=set_timeout
            ).split(b";", 1)[0]
            try:
                size = int(size_text, 16)
            except ValueError as exc:
                raise ValueError("request chunk is invalid") from exc
            if size < 0 or len(body) + size > max_bytes:
                raise ValueError("request body exceeds size limit")
            if size == 0:
                if _read_line(stream, deadline=deadline, now=now, set_timeout=set_timeout) != b"":
                    raise ValueError("request trailers are not allowed")
                return bytes(body)
            chunk = _read_exact(
                stream, size, deadline=deadline, now=now, set_timeout=set_timeout
            )
            if _read_exact(stream, 2, deadline=deadline, now=now, set_timeout=set_timeout) != b"\r\n":
                raise ValueError("request chunk is incomplete")
            body.extend(chunk)
    if length is None:
        raise ValueError("request content length is required")
    if not length.isdecimal():
        raise ValueError("request content length is invalid")
    size = int(length, 10)
    if size > max_bytes:
        raise ValueError("request body exceeds size limit")
    return _read_exact(stream, size, deadline=deadline, now=now, set_timeout=set_timeout)


class BrowserAssertionApplication:
    def __init__(self, signer, *, allowed_origins, expected_audience, rate_limiter=None):
        self._signer = signer
        self._origins = normalize_allowed_origins(allowed_origins)
        if not isinstance(expected_audience, str) or not expected_audience:
            raise ValueError("expected browser assertion audience is required")
        self._expected_audience = expected_audience
        self._limiter = rate_limiter or BrowserRateLimiter()

    def _cors(self, origin: str) -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin",
        }

    def _json(self, status, code, origin=None, value=None):
        payload = value if value is not None else {"error": code}
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        if len(body) > MAX_RESPONSE_BYTES:
            status, body = 500, b'{"error":"INTERNAL_ERROR"}'
        headers = {"Content-Type": "application/json", "Content-Length": str(len(body)), "Cache-Control": "no-store"}
        if origin in self._origins:
            headers.update(self._cors(origin))
        return HttpResult(status, headers, body)

    def prepare(self, method: str, path: str, headers) -> tuple[str | None, HttpResult | None]:
        normalized = {str(key).lower(): str(value).strip() for key, value in headers.items()}
        origin = normalized.get("origin")
        if origin not in self._origins:
            return None, self._json(403, "ORIGIN_DENIED")
        if path != ASSERT_PATH:
            return origin, self._json(404, "NOT_FOUND", origin)
        if method == "OPTIONS":
            requested_method = normalized.get("access-control-request-method", "").upper()
            requested_headers = {part.strip().lower() for part in normalized.get("access-control-request-headers", "").split(",") if part.strip()}
            if requested_method != "POST" or requested_headers not in (set(), {"content-type"}):
                return origin, self._json(403, "PREFLIGHT_DENIED", origin)
            result_headers = self._cors(origin)
            if normalized.get("access-control-request-private-network", "").lower() == "true":
                result_headers["Access-Control-Allow-Private-Network"] = "true"
            return origin, HttpResult(204, result_headers, b"")
        if method != "POST":
            return origin, self._json(405, "METHOD_NOT_ALLOWED", origin)
        if normalized.get("content-type", "").lower() != "application/json":
            return origin, self._json(415, "UNSUPPORTED_MEDIA_TYPE", origin)
        if not self._limiter.allow(origin):
            return origin, self._json(429, "RATE_LIMITED", origin)
        return origin, None

    def complete_post(self, origin: str, body: bytes) -> HttpResult:
        try:
            challenge = parse_strict_json_bytes(body, max_bytes=MAX_REQUEST_BYTES)
            if challenge.get("audience") != self._expected_audience:
                raise ValueError("assertion audience does not match configuration")
            assertion = build_browser_assertion(challenge, self._signer)
        except Exception:
            return self._json(400, "INVALID_REQUEST", origin)
        return self._json(200, None, origin, assertion)

    def handle(self, method: str, path: str, headers, body: bytes) -> HttpResult:
        origin, immediate = self.prepare(method, path, headers)
        if immediate is not None:
            return immediate
        return self.complete_post(origin, body)


class BrowserAssociationServer:
    def __init__(self, application, *, host=LOOPBACK_HOST, port=BROWSER_PORT, request_timeout_s=5.0):
        validate_loopback_bind(host)
        if port != BROWSER_PORT:
            raise ValueError("browser listener must use port 8078")
        self._application = application
        self._request_timeout_s = float(request_timeout_s)
        self._server = ThreadingHTTPServer((host, port), self._handler_type())
        self._server.daemon_threads = True
        self._server.application = application
        self._server.request_timeout_s = self._request_timeout_s
        self._thread = None

    def _handler_type(self):
        class Handler(BaseHTTPRequestHandler):
            server_version = "AEGISIdentityAgent"
            sys_version = ""

            def setup(self):
                super().setup()
                self.connection.settimeout(self.server.request_timeout_s)

            def _dispatch(self):
                headers = {key.lower(): value for key, value in self.headers.items()}
                try:
                    deadline = time.monotonic() + self.server.request_timeout_s
                    origin, result = self.server.application.prepare(self.command, self.path, headers)
                    if result is None:
                        body = read_bounded_http_body(
                            self.rfile, headers, deadline=deadline,
                            set_timeout=self.connection.settimeout,
                        )
                        result = self.server.application.complete_post(origin, body)
                except (ValueError, socket.timeout):
                    origin = headers.get("origin")
                    result = self.server.application._json(400, "INVALID_REQUEST", origin)
                self.send_response(result.status)
                for key, value in result.headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if result.body:
                    self.wfile.write(result.body)

            do_OPTIONS = _dispatch
            do_POST = _dispatch
            do_GET = _dispatch
            do_HEAD = _dispatch
            do_PUT = _dispatch
            do_PATCH = _dispatch
            do_DELETE = _dispatch
            do_TRACE = _dispatch
            do_CONNECT = _dispatch

            def log_message(self, _format, *_args):
                return

        return Handler

    def start(self):
        if self._thread is not None:
            raise RuntimeError("browser listener already started")
        self._thread = threading.Thread(target=self._server.serve_forever, name="IdentityAgentBrowser", daemon=True)
        self._thread.start()

    def close(self):
        if self._thread is not None:
            self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
