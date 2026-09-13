"""HTTPS client for the PR10 S2 machine dispatch route (spec §5.3).

The Core pulls; the server never calls the Core. The transport is injectable:
tests use a fake, and the default is urllib over an mTLS SSLContext built only
from configured absolute paths. Any failure raises DispatchUnavailable with a
reason and changes nothing locally, so undelivered evidence stays queued in the
dispatch ledger.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ACTION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
CANONICAL_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
REQUEST_TIMEOUT_SEC = 5

Transport = Callable[[str, str, bytes | None, Mapping[str, str]], tuple[int, bytes]]


class DispatchUnavailable(Exception):
    """The machine route cannot be used right now; nothing was changed locally.

    The reason is NETWORK, CREDENTIAL, SERVER, or PROTOCOL.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class DispatchCredentialError(DispatchUnavailable):
    """A configured CA, client certificate, or client key is missing or unusable."""

    def __init__(self, detail: str):
        super().__init__("CREDENTIAL")
        self.detail = detail


@dataclass(frozen=True)
class PendingAction:
    action_id: str
    action: str
    accepted_at: str
    expires_at: float


@dataclass(frozen=True)
class ClaimResult:
    """CLAIMED, NOT_FOUND, EXPIRED, ALREADY_CLAIMED, or NOT_DISPATCHABLE."""

    status: str
    expires_at: float | None = None


@dataclass(frozen=True)
class ReportResult:
    """RECORDED, UNCHANGED, or REJECTED (a definitive 4xx; the evidence is never resent)."""

    status: str


def _epoch(value: object) -> float:
    if not isinstance(value, str) or not CANONICAL_TIMESTAMP.fullmatch(value):
        raise DispatchUnavailable("PROTOCOL")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError as exc:
        raise DispatchUnavailable("PROTOCOL") from exc


def _usable_file(value: object) -> Path | None:
    if value is None or value == "":
        return None
    path = Path(value)
    return path if path.is_absolute() and path.is_file() else None


def credential_files_available(*, ca_file: object, cert_file: object, key_file: object) -> bool:
    """True only when the CA, client certificate, and client key are existing absolute files."""
    return all(_usable_file(value) is not None for value in (ca_file, cert_file, key_file))


def build_client_ssl_context(*, ca_file: object, cert_file: object, key_file: object) -> ssl.SSLContext:
    """Build the mTLS client context; missing or relative paths are refused before anything is loaded."""
    paths: dict[str, Path] = {}
    for name, value in (("CA", ca_file), ("client certificate", cert_file), ("client key", key_file)):
        path = _usable_file(value)
        if path is None:
            raise DispatchCredentialError(f"the dispatch {name} must be an existing absolute file")
        paths[name] = path
    try:
        context = ssl.create_default_context(cafile=str(paths["CA"]))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile=str(paths["client certificate"]), keyfile=str(paths["client key"]))
    except (OSError, ssl.SSLError) as exc:
        raise DispatchCredentialError("the dispatch credentials could not be loaded") from exc
    return context


def urllib_transport(context: ssl.SSLContext, *, timeout: float = REQUEST_TIMEOUT_SEC) -> Transport:
    """Default transport: HTTPS only, over the given mTLS context. HTTP errors come back as responses."""

    def transport(method: str, url: str, body: bytes | None, headers: Mapping[str, str]) -> tuple[int, bytes]:
        if urlsplit(url).scheme != "https":
            raise ValueError("The dispatch transport only speaks https")
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(request, context=context, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read()
            finally:
                error.close()

    return transport


class DispatchClient:
    """Typed client for list, claim, and report on the machine dispatch route."""

    def __init__(self, base_url: str, transport: Transport):
        parts = urlsplit(base_url or "")
        if parts.scheme != "https" or not parts.netloc or parts.query or parts.fragment:
            raise ValueError("The dispatch base URL must be an https:// URL without a query")
        self._base = base_url.rstrip("/")
        self._transport = transport

    @staticmethod
    def _action_path(action_id: str, suffix: str) -> str:
        if not isinstance(action_id, str) or not ACTION_ID.fullmatch(action_id):
            raise ValueError("A dispatch action id must be a lower-case UUID")
        return f"/dispatch/{action_id}/{suffix}"

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
        headers = {"Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        try:
            status, raw = self._transport(method, f"{self._base}{path}", payload, headers)
        except ssl.SSLError as exc:
            raise DispatchUnavailable("CREDENTIAL") from exc
        except urllib.error.URLError as exc:
            raise DispatchUnavailable("CREDENTIAL" if isinstance(exc.reason, ssl.SSLError) else "NETWORK") from exc
        except OSError as exc:
            raise DispatchUnavailable("NETWORK") from exc
        # The machine identity guard answers 403: the HUB did not vouch for this Core.
        if status == 403:
            raise DispatchUnavailable("CREDENTIAL")
        if status >= 500:
            raise DispatchUnavailable("SERVER")
        try:
            document = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DispatchUnavailable("PROTOCOL") from exc
        return status, document

    def list_pending(self) -> list[PendingAction]:
        status, document = self._request("GET", "/dispatch/pending")
        if status != 200 or not isinstance(document, dict) or not isinstance(document.get("actions"), list):
            raise DispatchUnavailable("PROTOCOL")
        actions = []
        for item in document["actions"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("actionId"), str)
                or not ACTION_ID.fullmatch(item["actionId"])
                or not isinstance(item.get("action"), str)
            ):
                raise DispatchUnavailable("PROTOCOL")
            _epoch(item.get("acceptedAt"))
            actions.append(PendingAction(item["actionId"], item["action"], item["acceptedAt"], _epoch(item.get("expiresAt"))))
        return actions

    def claim(self, action_id: str) -> ClaimResult:
        path = self._action_path(action_id, "claim")
        status, document = self._request("POST", path, {})
        if status == 200:
            if not isinstance(document, dict) or document.get("actionId") != action_id or document.get("state") != "CORE_CLAIMED":
                raise DispatchUnavailable("PROTOCOL")
            return ClaimResult("CLAIMED", _epoch(document.get("expiresAt")))
        if status == 404:
            return ClaimResult("NOT_FOUND")
        if status == 410:
            return ClaimResult("EXPIRED")
        if status == 409:
            error = document.get("error") if isinstance(document, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            return ClaimResult("NOT_DISPATCHABLE" if code == "ACTION_NOT_DISPATCHABLE" else "ALREADY_CLAIMED")
        raise DispatchUnavailable("PROTOCOL")

    def report(self, action_id: str, entry: Mapping[str, object]) -> ReportResult:
        path = self._action_path(action_id, "evidence")
        status, _document = self._request("POST", path, dict(entry))
        if status == 201:
            return ReportResult("RECORDED")
        if status == 200:
            return ReportResult("UNCHANGED")
        if 400 <= status < 500:
            return ReportResult("REJECTED")
        raise DispatchUnavailable("PROTOCOL")
