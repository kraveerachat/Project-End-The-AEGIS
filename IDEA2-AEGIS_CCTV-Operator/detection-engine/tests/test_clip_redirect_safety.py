"""A login redirect is not an acknowledgement of a verified clip row."""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace

from aegis_engine.config import EngineConfig
from aegis_engine.identity_agent_client import IdentityAgentClient
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import SegmentInfo
from aegis_engine.monitor_client import MonitorClient
from aegis_engine.nas_sync import NASSyncWorker
from aegis_identity_agent.pipe_protocol import decode_request, encode_response
from aegis_identity_agent.sequence import SequenceAllocator
from aegis_identity_agent.transport import AgentTransport


class _RedirectHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        self._respond()

    def do_GET(self):
        self._respond()

    def _respond(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        self.server.hits.append((self.command, self.path))
        if self.path == "/internal/clips":
            self.send_response(self.server.redirect_code)
            self.send_header("Location", "/login")
        elif self.path == "/login":
            self.send_response(200)
        else:
            self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args):
        pass


class _RedirectServer:
    def __init__(self, code):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _RedirectHandler)
        self.httpd.redirect_code = code
        self.httpd.hits = []
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    @property
    def hits(self):
        return self.httpd.hits

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.httpd.shutdown()
        self.thread.join(timeout=5)
        self.httpd.server_close()


class _Signer:
    def sign(self, _message):
        return bytes([7]) * 64


class _Sessions:
    def __init__(self):
        self.sequences = SequenceAllocator()
        self.invalidated = False
        token = base64.urlsafe_b64encode(bytes([8]) * 32).rstrip(b"=").decode("ascii")
        self.session = SimpleNamespace(session_id=token)

    def ensure_session(self):
        return self.session

    def invalidate(self):
        self.invalidated = True


def _transport(base_url):
    # Local-only HTTP fixture. Production AgentConfig still enforces HTTPS;
    # this exercises the real requests.Session redirect behavior in isolation.
    config = SimpleNamespace(
        monitor_base_url=base_url,
        engine_stream_url="http://aegis-stream-host.internal:18077/stream.mjpg",
        http_timeout=(2, 2),
        tls_verify=True,
    )
    return AgentTransport(config, _Sessions(), _Signer(),
                          now_ms=lambda: 100_000,
                          random_bytes=lambda count: bytes([9]) * count)


def _strict_clip():
    return {
        "cameraId": "CAM-02",
        "startedAt": "2026-09-19T00:00:00Z",
        "durationSec": 10.0,
        "filePath": "/verified/clip.mp4",
        "storedOnNas": True,
        "producerGeneration": "9007199254740993",
        "endedAt": "2026-09-19T00:00:10Z",
    }


class ClipRedirectSafetyTests(unittest.TestCase):
    def test_signed_agent_transport_rejects_login_redirect_without_following_it(self):
        for code in (302, 303, 307, 308):
            with self.subTest(code=code), _RedirectServer(code) as server:
                result = _transport(server.base_url).submit("clip", _strict_clip())
                self.assertFalse(result.ok)
                self.assertEqual(code, result.status)
                self.assertEqual([("POST", "/internal/clips")], server.hits)

    def test_direct_monitor_transport_rejects_login_redirect_without_following_it(self):
        for code in (302, 303, 307, 308):
            with self.subTest(code=code), _RedirectServer(code) as server:
                monitor = MonitorClient(base_url=server.base_url, api_key="test-key")
                acknowledged = monitor.post_clip(
                    "CAM-02", "2026-09-19T00:00:00Z", 10.0, "/verified/clip.mp4", True,
                )
                self.assertFalse(acknowledged)
                self.assertEqual([("POST", "/internal/clips")], server.hits)

    def test_agent_login_redirect_keeps_verified_local_source(self):
        with _RedirectServer(302) as server, tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "clip.mp4")
            with open(path, "wb") as handle:
                handle.write(b"verified-source")
            transport = _transport(server.base_url)

            def connector(_pipe, raw, _timeout, _limit, _response_timeout):
                request = decode_request(raw)
                result = transport.submit(request.operation, request.payload)
                return encode_response(ok=result.ok, status=result.status, error=result.error)

            monitor = MonitorClient(
                identity_agent_client=IdentityAgentClient(connector=connector),
                ingest_mode="identity_agent",
            )
            config = EngineConfig(
                nas_enabled=True, nas_user="aegis", nas_host="nas.local",
                nas_delete_after_sync=True,
            ).validate()
            worker = NASSyncWorker(config, MetricsRegistry(), monitor=monitor)
            worker._prepare_browser_playback = lambda *_args: True
            worker._ensure_remote_dir = lambda: None
            worker._transfer = lambda *_args: (0, "", "")
            worker._verify = lambda *_args: True
            worker._sync_one(SegmentInfo(
                path=path, camera_id="CAM-02",
                started_wall="2026-09-19T00:00:00Z",
                ended_wall="2026-09-19T00:00:10Z",
                duration_s=10.0, size_bytes=os.path.getsize(path),
                producer_generation=9007199254740993,
            ))
            self.assertTrue(os.path.exists(path))
            self.assertEqual([("POST", "/internal/clips")], server.hits)


if __name__ == "__main__":
    unittest.main()
