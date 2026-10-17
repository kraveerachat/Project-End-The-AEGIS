"""Optional, disabled-by-default Core-side client that pushes the allowlisted status projection to the Web machine route.

This is a separate component, not part of the Core Supervisor: a failure here can never interrupt supervision, and the
Supervisor is unchanged. It only ever opens a Core-initiated HTTPS connection (no listener) using the same reviewed
machine mTLS identity as dispatch. It reads the Core ``status.json`` through the same fail-closed gate as the Purple
Desktop, builds the same allowlisted projection as the publisher, and sends one bounded envelope per cycle.

Safety properties (each is covered by tests): disabled unless ``AEGIS_CORE_STATUS_PUSH_ENABLED=1``; TLS 1.2+ with
certificate and hostname verification and no insecure fallback; credentials are only paths in the environment, never
arguments, never logged; connect/read timeout 5 s; no queue and no replay (every cycle re-reads the current source and
a source that is missing, stale, future-dated or contradictory sends nothing); backoff is bounded; no MQTT, relay, CUT,
RESTORE, subprocess, sudo, chmod or chown. Installing or enabling it on a Production host is an owner action.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from aegis_soc import dispatch_client, observer
from tools import status_projection_publisher as publisher

ENABLE_VARIABLE = "AEGIS_CORE_STATUS_PUSH_ENABLED"
REQUEST_TIMEOUT_SECONDS = 5.0
DEFAULT_INTERVAL_SECONDS = 10.0
MAX_BACKOFF_SECONDS = 60.0
MAX_BODY_BYTES = 8 * 1024
STATUS_PATH = "/status"

ACCEPTED = "ACCEPTED"
NOT_SENT = "NOT_SENT"
DROPPED = "DROPPED"
RETRY = "RETRY"
CREDENTIAL = "CREDENTIAL"

# Definitive Web refusals: the evidence is never re-sent, the next cycle sends fresh evidence instead.
_DROP_CODES = frozenset({"STATUS_PUSH_INVALID", "STATUS_PUSH_UNSUPPORTED", "STATUS_PUSH_REPLAY", "STATUS_PUSH_STALE",
                         "STATUS_PUSH_FUTURE", "STATUS_PUSH_PROFILE"})


@dataclass(frozen=True)
class PushResult:
    outcome: str
    reason: str

    @property
    def accepted(self) -> bool:
        return self.outcome == ACCEPTED


@dataclass(frozen=True)
class PushSettings:
    source: Path
    base_url: str
    ca_file: Path
    cert_file: Path
    key_file: Path
    interval: float = DEFAULT_INTERVAL_SECONDS


class SettingsError(ValueError):
    """The environment does not describe a safe, complete configuration."""


def enabled(environ: Mapping[str, str]) -> bool:
    return environ.get(ENABLE_VARIABLE, "0") == "1"


def settings_from_environment(environ: Mapping[str, str]) -> PushSettings:
    """Build settings from the environment. Only paths and a URL are read; secrets stay in the key file."""

    def absolute(name: str) -> Path:
        value = environ.get(name, "")
        path = Path(value)
        if not value or not path.is_absolute():
            raise SettingsError(f"{name} must be an absolute path")
        return path

    base = environ.get("AEGIS_CORE_STATUS_PUSH_BASE_URL", "")
    parts = urlsplit(base)
    if parts.scheme != "https" or not parts.hostname or parts.query or parts.fragment or parts.username or parts.password:
        raise SettingsError("AEGIS_CORE_STATUS_PUSH_BASE_URL must be an https:// URL without credentials or a query")
    try:
        interval = float(environ.get("AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC", DEFAULT_INTERVAL_SECONDS))
    except ValueError as error:
        raise SettingsError("AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC must be a number") from error
    if not (1 <= interval <= 60):
        raise SettingsError("AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC must be between 1 and 60")
    return PushSettings(
        source=absolute("AEGIS_CORE_STATUS_PUSH_SOURCE"),
        base_url=base.rstrip("/"),
        ca_file=absolute("AEGIS_CORE_STATUS_PUSH_CA_FILE"),
        cert_file=absolute("AEGIS_CORE_STATUS_PUSH_CLIENT_CERT"),
        key_file=absolute("AEGIS_CORE_STATUS_PUSH_CLIENT_KEY"),
        interval=interval,
    )


MAX_RESPONSE_BYTES = 16 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the client certificate must only ever be presented to the configured host."""

    def redirect_request(self, *_args, **_kwargs):
        return None


def no_redirect_transport(context, *, timeout: float = REQUEST_TIMEOUT_SECONDS) -> dispatch_client.Transport:
    """HTTPS-only transport over the mTLS context: no redirects, bounded response, HTTP errors returned as responses."""

    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), _NoRedirect())

    def transport(method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> tuple[int, bytes]:
        if urlsplit(url).scheme != "https":
            raise ValueError("The status push transport only speaks https")
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read(MAX_RESPONSE_BYTES)
            finally:
                error.close()

    return transport


class StatusPusher:
    """Pushes one fresh envelope per call. Holds only the last sent timestamp (never evidence) and a failure streak."""

    def __init__(self, source: Path, base_url: str, transport: dispatch_client.Transport,
                 *, max_age_seconds: float = observer.DEFAULT_MAX_AGE_SECONDS):
        parts = urlsplit(base_url or "")
        if parts.scheme != "https" or not parts.netloc or parts.query or parts.fragment:
            raise ValueError("The status push base URL must be an https:// URL without a query")
        self._source = Path(source)
        self._url = base_url.rstrip("/") + STATUS_PATH
        self._transport = transport
        self._max_age = max_age_seconds
        self._last_sent_ms = 0
        self.failures = 0

    def backoff_seconds(self, interval: float) -> float:
        """Interval after success or a definitive refusal; bounded exponential growth after transport failures."""
        if self.failures == 0:
            return interval
        return min(MAX_BACKOFF_SECONDS, interval * (2 ** min(self.failures, 6)))

    def push_once(self, *, now: float | None = None) -> PushResult:
        current = time.time() if now is None else now
        if not self._source.is_absolute():
            return PushResult(NOT_SENT, "source must be an absolute path")
        document, unknown = observer.load_status_document(self._source, now=current, max_age_seconds=self._max_age)
        if document is None:
            return PushResult(NOT_SENT, f"{unknown.freshness}: {unknown.reason}")
        projection = publisher.build_projection(document, published_at=current)
        # Strictly increasing per process; a restart restarts from the wall clock, which is newer.
        sent_at_ms = max(int(current * 1000), self._last_sent_ms + 1)
        envelope = publisher.build_push_envelope(projection, sent_at_ms=sent_at_ms)
        body = json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(body) > MAX_BODY_BYTES:
            return PushResult(NOT_SENT, "envelope exceeds the size bound")

        self._last_sent_ms = sent_at_ms
        try:
            status, raw = self._transport("POST", self._url, body, {"Accept": "application/json", "Content-Type": "application/json"})
        except (OSError, urllib.error.URLError, ValueError) as error:
            # SSL failures (untrusted CA, bad hostname, bad client certificate) are OSError subclasses.
            self.failures += 1
            return PushResult(RETRY, f"transport failure: {type(error).__name__}")
        if status == 200:
            self.failures = 0
            return PushResult(ACCEPTED, "accepted")
        if status == 403:
            self.failures += 1
            return PushResult(CREDENTIAL, "the machine identity was not accepted")
        if not 400 <= status < 500 or status in (404, 413):
            # 3xx (never followed), 5xx, a body-size refusal or a Web without the status route: not a verdict on the evidence.
            self.failures += 1
            return PushResult(RETRY, f"server answered {status}")
        code = _error_code(raw)
        # A definitive refusal is not a transport failure and does not grow the backoff.
        self.failures = 0
        return PushResult(DROPPED, f"refused {status} {code if code in _DROP_CODES else 'UNSPECIFIED'}")


def _error_code(raw: bytes) -> str | None:
    try:
        document = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    error = document.get("error") if isinstance(document, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) and len(code) <= 64 else None


def run(pusher: StatusPusher, interval: float, stop: threading.Event, *, log: Callable[[str], None] | None = None) -> int:
    log = log or (lambda message: print(message, file=sys.stderr, flush=True))
    while not stop.is_set():
        result = pusher.push_once()
        if not result.accepted:
            log(f"status push {result.outcome}: {result.reason}")
        stop.wait(pusher.backoff_seconds(interval))
    return 0


def main(argv=None, environ: Mapping[str, str] | None = None) -> int:
    environ = os.environ if environ is None else environ
    args = list(sys.argv[1:] if argv is None else argv)
    if args not in ([], ["--once"]):
        print("usage: status_push_client [--once]; configuration is read from the environment only", file=sys.stderr)
        return 2
    if not enabled(environ):
        print(f"status push is disabled ({ENABLE_VARIABLE} is not 1); nothing was sent")
        return 0
    try:
        settings = settings_from_environment(environ)
        context = dispatch_client.build_client_ssl_context(
            ca_file=settings.ca_file, cert_file=settings.cert_file, key_file=settings.key_file)
        pusher = StatusPusher(settings.source, settings.base_url,
                              no_redirect_transport(context, timeout=REQUEST_TIMEOUT_SECONDS))
    except (SettingsError, ValueError, dispatch_client.DispatchCredentialError) as error:
        print(f"status push not started: {error}", file=sys.stderr)
        return 2
    if args == ["--once"]:
        result = pusher.push_once()
        print(f"{result.outcome}: {result.reason}")
        return 0 if result.accepted else 1
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    return run(pusher, settings.interval, stop)


if __name__ == "__main__":
    sys.exit(main())
