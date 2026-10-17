"""Contracts for the optional Core-side status push client (synthetic TEST_ONLY data, fake transport, no network)."""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
from pathlib import Path

import pytest

from tools import status_push_client as client

NOW = 1_700_000_100.0
URL = "https://idea3-core.aegis.internal/security/api/machine/v1"


def _core_status(**changes):
    value = {
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False,
        "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY",
        "dispatch": "DISABLED", "time_trust": "SYNCED", "updated_at": NOW - 5, "components": {"detector": "RUNNING"},
        "pid": 4242, "detail": "token=SHOULD-NOT-LEAK /etc/aegis-idea3/credentials/k_c2d", "secret": "hunter2",
    }
    value.update(changes)
    return value


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "status.json"
    path.write_text(json.dumps(_core_status()), encoding="utf-8")
    return path


class Recorder:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url, body, dict(headers)))
        reply = self.replies.pop(0) if self.replies else (200, b'{"status":"ACCEPTED"}')
        if isinstance(reply, BaseException):
            raise reply
        return reply


def _pusher(source, transport):
    return client.StatusPusher(source, URL, transport)


def test_sends_one_bounded_allowlisted_envelope(source):
    transport = Recorder()
    result = _pusher(source, transport).push_once(now=NOW)

    assert result.accepted
    ((method, url, body, headers),) = transport.calls
    assert (method, url) == ("POST", URL + "/status")
    assert headers["Content-Type"] == "application/json"
    assert len(body) <= client.MAX_BODY_BYTES
    envelope = json.loads(body)
    assert set(envelope) == {"schema", "version", "sentAtMs", "projection"}
    assert envelope["schema"] == "aegis.idea3.status-push"
    assert envelope["projection"]["evidenceSource"] == "RUNTIME_STATUS_FILE"
    text = body.decode()
    for leaked in ("SHOULD-NOT-LEAK", "hunter2", "4242", "/etc/aegis-idea3", "credentials"):
        assert leaked not in text


def test_preserves_the_core_timestamp_and_does_not_promote_freshness(source):
    transport = Recorder()
    _pusher(source, transport).push_once(now=NOW)
    envelope = json.loads(transport.calls[0][2])
    assert envelope["projection"]["generatedAt"] == "2023-11-14T22:14:55.000Z"
    assert envelope["sentAtMs"] == int(NOW * 1000)


@pytest.mark.parametrize("variant", ["missing", "stale", "future", "malformed", "contradictory"])
def test_unusable_source_sends_nothing(tmp_path, variant):
    path = tmp_path / "status.json"
    if variant == "stale":
        path.write_text(json.dumps(_core_status(updated_at=NOW - 3600)))
    elif variant == "future":
        path.write_text(json.dumps(_core_status(updated_at=NOW + 3600)))
    elif variant == "malformed":
        path.write_text("{not json")
    elif variant == "contradictory":
        path.write_text(json.dumps(_core_status(state="LOCKDOWN", uplink="NORMAL")))
    transport = Recorder()
    result = _pusher(path, transport).push_once(now=NOW)
    assert result.outcome == client.NOT_SENT
    assert transport.calls == []


def test_sent_timestamps_strictly_increase_even_within_one_millisecond(source):
    transport = Recorder()
    pusher = _pusher(source, transport)
    pusher.push_once(now=NOW)
    pusher.push_once(now=NOW)
    pusher.push_once(now=NOW - 1)
    sent = [json.loads(call[2])["sentAtMs"] for call in transport.calls]
    assert sent == sorted(set(sent)) and len(sent) == 3


def test_no_queue_and_no_replay_each_cycle_rereads_the_source(source):
    transport = Recorder(OSError("down"), (200, b"{}"))
    pusher = _pusher(source, transport)
    assert pusher.push_once(now=NOW).outcome == client.RETRY
    source.write_text(json.dumps(_core_status(broker="DISCONNECTED", updated_at=NOW + 1)))
    assert pusher.push_once(now=NOW + 2).accepted
    second = json.loads(transport.calls[1][2])
    assert second["projection"]["components"]["broker"] == "DISCONNECTED"
    assert len(transport.calls) == 2


@pytest.mark.parametrize("error", [OSError("refused"), TimeoutError(), urllib.error.URLError("x")])
def test_transport_failures_are_retryable_and_never_raise(source, error):
    pusher = _pusher(source, Recorder(error))
    result = pusher.push_once(now=NOW)
    assert result.outcome == client.RETRY and pusher.failures == 1


def test_tls_failures_are_transport_failures(source):
    import ssl
    for error in (ssl.SSLCertVerificationError(1, "bad host"), urllib.error.URLError(ssl.SSLError("bad"))):
        assert _pusher(source, Recorder(error)).push_once(now=NOW).outcome == client.RETRY


def test_identity_rejection_is_reported_without_leaking(source):
    pusher = _pusher(source, Recorder((403, b'{"error":{"code":"MACHINE_IDENTITY_INVALID"}}')))
    result = pusher.push_once(now=NOW)
    assert result.outcome == client.CREDENTIAL and pusher.failures == 1


@pytest.mark.parametrize("status,code", [(409, "STATUS_PUSH_REPLAY"), (422, "STATUS_PUSH_STALE"), (422, "STATUS_PUSH_FUTURE"),
                                          (422, "STATUS_PUSH_PROFILE"), (400, "STATUS_PUSH_INVALID")])
def test_definitive_refusals_are_dropped_not_retried(source, status, code):
    body = json.dumps({"error": {"code": code}}).encode()
    pusher = _pusher(source, Recorder((status, body)))
    result = pusher.push_once(now=NOW)
    assert result.outcome == client.DROPPED and code in result.reason
    assert pusher.failures == 0


def test_server_errors_and_missing_route_back_off_but_stay_bounded(source):
    pusher = _pusher(source, Recorder(*[(503, b"")] * 20))
    waits = []
    for index in range(12):
        assert pusher.push_once(now=NOW + index).outcome == client.RETRY
        waits.append(pusher.backoff_seconds(10))
    assert waits[0] == 20 and waits == sorted(waits) and max(waits) == client.MAX_BACKOFF_SECONDS
    assert _pusher(source, Recorder((404, b""))).push_once(now=NOW).outcome == client.RETRY
    pusher = _pusher(source, Recorder((503, b""), (200, b"{}")))
    pusher.push_once(now=NOW)
    pusher.push_once(now=NOW + 1)
    assert pusher.backoff_seconds(10) == 10


def test_redirects_are_never_followed_and_are_not_a_verdict(source):
    handler = client._NoRedirect()
    assert handler.redirect_request(object(), object(), 302, "Found", {}, "https://elsewhere.example/") is None
    pusher = _pusher(source, Recorder((302, b"")))
    assert pusher.push_once(now=NOW).outcome == client.RETRY


def test_transport_is_https_only_and_bounds_the_response(monkeypatch):
    import ssl

    transport = client.no_redirect_transport(ssl.create_default_context())
    with pytest.raises(ValueError):
        transport("POST", "http://idea3-core.aegis.internal/x", b"{}", {})

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def read(self, limit):
            assert limit == client.MAX_RESPONSE_BYTES
            return b"x" * limit

    class Opener:
        def open(self, request, timeout):
            assert timeout == client.REQUEST_TIMEOUT_SECONDS and request.get_method() == "POST"
            return Response()

    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *_handlers: Opener())
    status, body = client.no_redirect_transport(ssl.create_default_context())("POST", "https://h.example/x", b"{}", {})
    assert (status, len(body)) == (200, client.MAX_RESPONSE_BYTES)


def test_never_sends_to_a_non_https_url(source):
    for url in ("http://idea3-core.aegis.internal/x", "ftp://x/y", "", "https://h/x?q=1", "https:///x"):
        with pytest.raises(ValueError):
            client.StatusPusher(source, url, Recorder())


def _env(tmp_path, **changes):
    values = {
        client.ENABLE_VARIABLE: "1",
        "AEGIS_CORE_STATUS_PUSH_BASE_URL": URL,
        "AEGIS_CORE_STATUS_PUSH_SOURCE": str(tmp_path / "status.json"),
        "AEGIS_CORE_STATUS_PUSH_CA_FILE": str(tmp_path / "ca.crt"),
        "AEGIS_CORE_STATUS_PUSH_CLIENT_CERT": str(tmp_path / "c.crt"),
        "AEGIS_CORE_STATUS_PUSH_CLIENT_KEY": str(tmp_path / "c.key"),
    }
    values.update(changes)
    return values


def test_disabled_by_default_and_by_any_other_value(tmp_path, monkeypatch, capsys):
    def explode(*_a, **_k):
        raise AssertionError("a disabled push client must not touch credentials or the network")

    monkeypatch.setattr(client.dispatch_client, "build_client_ssl_context", explode)
    monkeypatch.setattr(client.dispatch_client, "urllib_transport", explode)
    for value in (None, "0", "", "true", "yes", "2"):
        environ = _env(tmp_path)
        environ.pop(client.ENABLE_VARIABLE)
        if value is not None:
            environ[client.ENABLE_VARIABLE] = value
        assert client.main([], environ) == 0
    assert "disabled" in capsys.readouterr().out


@pytest.mark.parametrize("change", [
    {"AEGIS_CORE_STATUS_PUSH_BASE_URL": "http://idea3-core.aegis.internal/x"},
    {"AEGIS_CORE_STATUS_PUSH_BASE_URL": "https://user:pw@idea3-core.aegis.internal/x"},
    {"AEGIS_CORE_STATUS_PUSH_BASE_URL": ""},
    {"AEGIS_CORE_STATUS_PUSH_SOURCE": "relative/status.json"},
    {"AEGIS_CORE_STATUS_PUSH_CA_FILE": ""},
    {"AEGIS_CORE_STATUS_PUSH_CLIENT_KEY": "key.pem"},
    {"AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC": "0"},
    {"AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC": "9999"},
    {"AEGIS_CORE_STATUS_PUSH_INTERVAL_SEC": "soon"},
])
def test_unsafe_settings_refuse_to_start(tmp_path, change):
    with pytest.raises(client.SettingsError):
        client.settings_from_environment(_env(tmp_path, **change))
    assert client.main([], _env(tmp_path, **change)) == 2


def test_missing_credential_files_refuse_to_start_without_an_insecure_fallback(tmp_path, capsys):
    assert client.main(["--once"], _env(tmp_path)) == 2
    assert "not started" in capsys.readouterr().err


def test_credentials_are_only_accepted_from_the_environment(tmp_path):
    assert client.main(["--key", "x"], _env(tmp_path)) == 2
    assert client.main(["--token=abc"], _env(tmp_path)) == 2


def test_run_loop_stops_cleanly_and_logs_no_secrets(source):
    source.write_text(json.dumps(_core_status(updated_at=time.time())))
    stop = threading.Event()
    logs = []
    transport = Recorder(OSError("secret-host-detail"), (200, b"{}"))
    pusher = _pusher(source, transport)

    def log(message):
        logs.append(message)
        stop.set()

    assert client.run(pusher, 0.01, stop, log=log) == 0
    assert logs == ["status push RETRY: transport failure: OSError"]
    assert "secret-host-detail" not in logs[0]


def test_source_has_no_forbidden_capability():
    text = Path(client.__file__).read_text(encoding="utf-8")
    code = re.sub(r'""".*?"""', "", text, flags=re.DOTALL)
    for pattern in (r"\bsubprocess\b", r"\bsudo\b", r"os\.system", r"\bpaho\b", r"mqtt", r"\.listen\(", r"socketserver",
                    r"http\.server", r"chmod", r"chown", r"CERT_NONE", r"check_hostname\s*=\s*False", r"_create_unverified",
                    r"verify\s*=\s*False", r"\bcut\b", r"\brestore\b"):
        assert not re.search(pattern, code, flags=re.IGNORECASE), pattern


def test_deployment_templates_are_inert():
    root = Path(client.__file__).resolve().parents[1] / "deploy"
    env_text = (root / "aegis-idea3-status-push.env.example").read_text(encoding="utf-8")
    unit = (root / "aegis-idea3-status-push.service.example").read_text(encoding="utf-8")
    assert "AEGIS_CORE_STATUS_PUSH_ENABLED=0" in env_text
    assert "[Install]" not in unit.replace("# Intentionally no [Install] section", "")
    assert "NOT INSTALLED" in unit and "NOT INSTALLED" in env_text
    assert not re.search(r"(?im)^[A-Z_]*(TOKEN|PASSWORD|SECRET)[A-Z_]*=\S", env_text)
    assert "--key" not in unit and "--token" not in unit
