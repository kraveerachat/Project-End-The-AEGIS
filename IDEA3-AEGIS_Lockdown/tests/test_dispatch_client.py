"""PR10 S2 Core dispatch client (spec §5.3): typed results and no local effect on failure.

Every test injects a fake transport or patches urlopen. No network connection
is opened and no key material is loaded.
"""

from __future__ import annotations

import io
import json
import ssl
import urllib.error
from datetime import datetime, timezone

import pytest

from aegis_soc import dispatch_client
from aegis_soc.dispatch_client import (
    ClaimResult,
    DispatchClient,
    DispatchCredentialError,
    DispatchUnavailable,
    PendingAction,
    ReportResult,
    build_client_ssl_context,
    credential_files_available,
    urllib_transport,
)

# A placeholder machine route on a reserved .invalid name; never contacted.
BASE_URL = "https://idea3-core.aegis.invalid/security/api/machine/v1"
ACTION_ID = "5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f"
ACCEPTED_AT = "2026-09-12T08:00:00.000Z"
EXPIRES_AT = "2026-09-12T08:02:00.000Z"
EXPIRES_EPOCH = datetime(2026, 9, 12, 8, 2, tzinfo=timezone.utc).timestamp()
ENTRY = {"sequence": 1, "stage": "PUBLISHED", "observedAt": "2026-09-12T08:00:31.000Z", "detail": {}}


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append({
            "method": method,
            "url": url,
            "body": None if body is None else json.loads(body),
            "headers": dict(headers),
        })
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        status, document = response
        return status, document if isinstance(document, bytes) else json.dumps(document).encode("utf-8")


def _pending(action_id=ACTION_ID, expires_at=EXPIRES_AT):
    return {"actionId": action_id, "action": "CUT_UPLINK", "acceptedAt": ACCEPTED_AT, "expiresAt": expires_at}


def test_list_pending_returns_typed_actions_from_the_pending_route():
    transport = FakeTransport((200, {"actions": [_pending()]}))

    actions = DispatchClient(BASE_URL, transport).list_pending()

    assert actions == [PendingAction(action_id=ACTION_ID, action="CUT_UPLINK", accepted_at=ACCEPTED_AT, expires_at=EXPIRES_EPOCH)]
    assert transport.calls == [{
        "method": "GET",
        "url": f"{BASE_URL}/dispatch/pending",
        "body": None,
        "headers": {"Accept": "application/json"},
    }]


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            (200, {"actionId": ACTION_ID, "action": "CUT_UPLINK", "state": "CORE_CLAIMED", "claimedAt": "2026-09-12T08:00:30.000Z", "expiresAt": EXPIRES_AT}),
            ClaimResult("CLAIMED", EXPIRES_EPOCH),
        ),
        ((404, {"error": {"code": "ACTION_NOT_FOUND"}}), ClaimResult("NOT_FOUND")),
        ((410, {"error": {"code": "ACTION_EXPIRED"}}), ClaimResult("EXPIRED")),
        ((409, {"error": {"code": "ACTION_ALREADY_CLAIMED"}}), ClaimResult("ALREADY_CLAIMED")),
        ((409, {"error": {"code": "ACTION_NOT_DISPATCHABLE"}}), ClaimResult("NOT_DISPATCHABLE")),
    ],
)
def test_claim_posts_an_empty_body_and_maps_every_server_answer(response, expected):
    transport = FakeTransport(response)

    assert DispatchClient(BASE_URL, transport).claim(ACTION_ID) == expected
    assert transport.calls == [{
        "method": "POST",
        "url": f"{BASE_URL}/dispatch/{ACTION_ID}/claim",
        "body": {},
        "headers": {"Accept": "application/json", "Content-Type": "application/json"},
    }]


@pytest.mark.parametrize(
    ("status", "expected"),
    [(201, "RECORDED"), (200, "UNCHANGED"), (400, "REJECTED"), (404, "REJECTED"), (409, "REJECTED")],
)
def test_c7_report_sends_the_outbox_entry_and_maps_recorded_unchanged_or_rejected(status, expected):
    body = {"status": expected, "sequence": 1, "stage": "PUBLISHED"} if status < 400 else {"error": {"code": "EVIDENCE_CONFLICT"}}
    transport = FakeTransport((status, body))

    assert DispatchClient(BASE_URL, transport).report(ACTION_ID, ENTRY) == ReportResult(expected)
    assert transport.calls[0]["url"] == f"{BASE_URL}/dispatch/{ACTION_ID}/evidence"
    assert transport.calls[0]["body"] == ENTRY


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (ConnectionRefusedError("refused"), "NETWORK"),
        (TimeoutError("timed out"), "NETWORK"),
        (urllib.error.URLError("unreachable"), "NETWORK"),
        ((502, {"error": {"code": "BAD_GATEWAY"}}), "SERVER"),
        ((503, {"error": {"code": "AUDIT_PERSISTENCE_FAILURE"}}), "SERVER"),
    ],
)
def test_c7_network_failures_and_server_errors_raise_dispatch_unavailable(failure, reason):
    for call in (
        lambda client: client.list_pending(),
        lambda client: client.claim(ACTION_ID),
        lambda client: client.report(ACTION_ID, ENTRY),
    ):
        with pytest.raises(DispatchUnavailable) as raised:
            call(DispatchClient(BASE_URL, FakeTransport(failure)))
        assert raised.value.reason == reason


@pytest.mark.parametrize(
    "failure",
    [
        ssl.SSLCertVerificationError("certificate verify failed"),
        ssl.SSLError("tlsv13 alert certificate required"),
        urllib.error.URLError(ssl.SSLError("handshake failure")),
        (403, {"error": {"code": "MACHINE_IDENTITY_INVALID"}}),
    ],
)
def test_c8_tls_and_machine_identity_failures_are_credential_problems(failure):
    with pytest.raises(DispatchUnavailable) as raised:
        DispatchClient(BASE_URL, FakeTransport(failure)).list_pending()

    assert raised.value.reason == "CREDENTIAL"


@pytest.mark.parametrize(
    ("call", "response"),
    [
        ("list", (200, b"not json")),
        ("list", (200, {"unexpected": []})),
        ("list", (200, {"actions": [_pending(action_id="not-a-uuid")]})),
        ("list", (200, {"actions": [_pending(expires_at="2026-09-12 08:02")]})),
        ("claim", (200, {"actionId": "6c1f4d2f-9a7b-4d3e-8c8f-3a2b1d0e9f8a", "state": "CORE_CLAIMED", "expiresAt": EXPIRES_AT})),
        ("claim", (400, {"error": {"code": "ACTION_ID_INVALID"}})),
    ],
)
def test_protocol_violations_are_refused(call, response):
    client = DispatchClient(BASE_URL, FakeTransport(response))

    with pytest.raises(DispatchUnavailable) as raised:
        client.list_pending() if call == "list" else client.claim(ACTION_ID)

    assert raised.value.reason == "PROTOCOL"


def test_refuses_a_non_https_base_url_or_a_malformed_action_id_before_any_request():
    for url in ("http://idea3-core.aegis.invalid/x", "idea3-core/x", "https://", "https://host.invalid/x?y=1"):
        with pytest.raises(ValueError, match="https"):
            DispatchClient(url, FakeTransport())

    transport = FakeTransport()
    client = DispatchClient(BASE_URL, transport)
    for bad in ("not-a-uuid", ACTION_ID.upper(), f"{ACTION_ID}/../pending"):
        with pytest.raises(ValueError, match="action id"):
            client.claim(bad)
        with pytest.raises(ValueError, match="action id"):
            client.report(bad, ENTRY)
    assert transport.calls == []


def test_c8_credential_files_must_be_existing_absolute_paths(tmp_path):
    placeholder = tmp_path / "placeholder.pem"
    placeholder.write_text("not a certificate\n", encoding="utf-8")

    assert credential_files_available(ca_file=placeholder, cert_file=placeholder, key_file=placeholder) is True
    for missing in (None, "", "relative.pem", tmp_path / "absent.pem"):
        assert credential_files_available(ca_file=missing, cert_file=placeholder, key_file=placeholder) is False
        assert credential_files_available(ca_file=placeholder, cert_file=missing, key_file=placeholder) is False
        assert credential_files_available(ca_file=placeholder, cert_file=placeholder, key_file=missing) is False


def test_c8_the_tls_context_builder_refuses_missing_or_relative_paths_before_loading_anything(tmp_path, monkeypatch):
    placeholder = tmp_path / "placeholder.pem"
    placeholder.write_text("not a certificate\n", encoding="utf-8")
    monkeypatch.setattr(dispatch_client.ssl, "create_default_context", lambda **_: pytest.fail("no TLS context may be built"))

    for paths in (
        {"ca_file": "relative.pem", "cert_file": placeholder, "key_file": placeholder},
        {"ca_file": placeholder, "cert_file": tmp_path / "absent.pem", "key_file": placeholder},
        {"ca_file": placeholder, "cert_file": placeholder, "key_file": None},
    ):
        with pytest.raises(DispatchCredentialError) as raised:
            build_client_ssl_context(**paths)
        assert raised.value.reason == "CREDENTIAL"


def test_urllib_transport_returns_http_errors_as_responses_and_refuses_plain_http(monkeypatch):
    class Response:
        status = 200

        def read(self):
            return b'{"actions": []}'

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    seen = {}

    def fake_urlopen(request, *, context, timeout):
        seen.update(method=request.get_method(), url=request.full_url, context=context, timeout=timeout, body=request.data)
        return Response()

    context = object()
    monkeypatch.setattr(dispatch_client.urllib.request, "urlopen", fake_urlopen)
    transport = urllib_transport(context)

    assert transport("GET", f"{BASE_URL}/dispatch/pending", None, {"Accept": "application/json"}) == (200, b'{"actions": []}')
    assert seen == {"method": "GET", "url": f"{BASE_URL}/dispatch/pending", "context": context, "timeout": 5, "body": None}

    conflict_body = b'{"error":{"code":"ACTION_ALREADY_CLAIMED"}}'

    def conflict(request, *, context, timeout):
        raise urllib.error.HTTPError(request.full_url, 409, "Conflict", {}, io.BytesIO(conflict_body))

    monkeypatch.setattr(dispatch_client.urllib.request, "urlopen", conflict)
    assert transport("POST", f"{BASE_URL}/dispatch/{ACTION_ID}/claim", b"{}", {"Content-Type": "application/json"}) == (409, conflict_body)

    with pytest.raises(ValueError, match="https"):
        transport("GET", "http://idea3-core.aegis.invalid/x", None, {})
