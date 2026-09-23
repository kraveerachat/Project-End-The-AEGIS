import base64
import json
import os
import pathlib
import sys
import threading
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.config import AgentConfig
from aegis_identity_agent.protocol import REQUEST_PROOFS, canonical_auth_payload
from aegis_identity_agent.sequence import SequenceAllocator, SequenceExhausted
from aegis_identity_agent.session_client import AgentSessionClient
from aegis_identity_agent.transport import AgentTransport


def token(size, fill):
    return base64.urlsafe_b64encode(bytes([fill]) * size).rstrip(b"=").decode("ascii")


class Response:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class RecordingSigner:
    def __init__(self):
        self.messages = []

    def sign(self, message):
        self.messages.append(bytes(message))
        return bytes([7]) * 64


def config_env(**overrides):
    values = {
        "AEGIS_AGENT_MONITOR_BASE_URL": "https://monitor.example.test/monitor",
        "AEGIS_AGENT_AUTH_AUDIENCE": "https://monitor.example.test",
        "AEGIS_AGENT_NODE_ID": "edge-a",
        "AEGIS_AGENT_KEY_VERSION": "4",
        "AEGIS_AGENT_KEY_PATH": r"C:\ProgramData\AEGIS\IdentityAgent\machine-identity.dpapi",
        "AEGIS_AGENT_ENGINE_STREAM_URL": "http://aegis-stream-host.internal:18077/stream.mjpg",
        "AEGIS_AGENT_CONNECT_TIMEOUT_S": "2",
        "AEGIS_AGENT_READ_TIMEOUT_S": "5",
        "AEGIS_AGENT_RENEW_BEFORE_S": "120",
        "AEGIS_AGENT_RETRY_MAX_S": "30",
        "AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": "https://monitor.example.test,http://127.0.0.1:5176",
    }
    values.update(overrides)
    return values


def challenge(now=100_000):
    return {
        "challengeId": token(32, 1),
        "nonce": token(32, 2),
        "issuedAtMs": now,
        "expiresAtMs": now + 60_000,
        "audience": "https://monitor.example.test",
        "purpose": "agent-authenticate",
        "nodeId": "edge-a",
        "keyVersion": 4,
    }


class AgentConfigTests(unittest.TestCase):
    def test_machine_a_advertises_stable_server_endpoint_not_runtime_ip(self):
        cfg = AgentConfig.from_env(config_env(
            AEGIS_AGENT_ENGINE_STREAM_URL="http://aegis-stream-host.internal:18077/stream.mjpg",
        ))
        self.assertEqual("http://aegis-stream-host.internal:18077/stream.mjpg", cfg.engine_stream_url)

    def test_stream_endpoint_allows_deployment_owned_dns_and_port_for_future_nodes(self):
        cfg = AgentConfig.from_env(config_env(
            AEGIS_AGENT_ENGINE_STREAM_URL="http://edge-stream.aegis.test:18123/stream.mjpg",
        ))
        self.assertEqual("http://edge-stream.aegis.test:18123/stream.mjpg", cfg.engine_stream_url)

    def test_config_is_https_only_bounded_and_redacted(self):
        cfg = AgentConfig.from_env(config_env())
        self.assertEqual("https://monitor.example.test/monitor", cfg.monitor_base_url)
        self.assertEqual((2.0, 5.0), cfg.http_timeout)
        self.assertEqual("http://aegis-stream-host.internal:18077/stream.mjpg", cfg.engine_stream_url)
        self.assertEqual(120_000, cfg.renew_before_ms)
        self.assertLessEqual(cfg.retry_max_s, 30.0)
        self.assertEqual(("http://127.0.0.1:5176", "https://monitor.example.test"), cfg.browser_allowed_origins)
        rendered = json.dumps(cfg.redacted(), sort_keys=True)
        self.assertNotIn("machine-identity.dpapi", rendered)
        self.assertNotIn("session", rendered.lower())
        self.assertNotIn("secret", rendered.lower())

        invalid = [
            {"AEGIS_AGENT_MONITOR_BASE_URL": "http://monitor.example.test"},
            {"AEGIS_AGENT_MONITOR_BASE_URL": "https://u:p@monitor.example.test"},
            {"AEGIS_AGENT_MONITOR_BASE_URL": "https://monitor.example.test/?x=1"},
            {"AEGIS_AGENT_MONITOR_BASE_URL": "https://monitor.example.test/#x"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://127.0.0.1:18078/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://127.0.0.1:18077/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://172.18.0.1:18077/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://[::1]:18077/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://aegis-stream-host.internal.:18077/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://aegis-stream-host.internal:0/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://aegis-stream-host.internal:80/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://u:p@127.0.0.1:18077/stream.mjpg"},
            {"AEGIS_AGENT_ENGINE_STREAM_URL": "http://127.0.0.1:18077/other"},
            {"AEGIS_AGENT_TLS_VERIFY": "false"},
            {"AEGIS_AGENT_RENEW_BEFORE_S": "0"},
            {"AEGIS_AGENT_RETRY_MAX_S": "999"},
            {"AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": ""},
            {"AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": "*"},
            {"AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": "http://monitor.example.test"},
            {"AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": "https://monitor.example.test/path"},
        ]
        for override in invalid:
            with self.subTest(override=override), self.assertRaises(ValueError):
                AgentConfig.from_env(config_env(**override))


class AgentSessionTests(unittest.TestCase):
    def test_authentication_uses_exact_canonical_proof_and_renews_at_threshold(self):
        now = [100_000]
        first = challenge(now[0])
        second = challenge(now[0] + 480_000)
        http = FakeHttp([
            Response(200, first), Response(200, {"sessionId": token(32, 3), "expiresAtMs": 700_000}),
            Response(200, second), Response(200, {"sessionId": token(32, 4), "expiresAtMs": 1_180_000}),
        ])
        signer = RecordingSigner()
        client = AgentSessionClient(
            AgentConfig.from_env(config_env()), signer, http=http, now_ms=lambda: now[0]
        )
        session = client.ensure_session()
        self.assertEqual(token(32, 3), session.session_id)
        self.assertEqual(canonical_auth_payload(first), signer.messages[0])
        self.assertEqual({"nodeId": "edge-a"}, http.calls[0][1]["json"])
        self.assertNotIn("verify", http.calls[0][1])
        self.assertEqual((2.0, 5.0), http.calls[0][1]["timeout"])

        now[0] = 579_999
        self.assertIs(session, client.ensure_session())
        self.assertEqual(2, len(http.calls))
        now[0] = 580_000
        replacement = client.ensure_session()
        self.assertEqual(token(32, 4), replacement.session_id)
        self.assertEqual(4, len(http.calls))
        self.assertEqual(0, client.sequences.current)

    def test_failed_renewal_keeps_unexpired_session_and_never_calls_camera(self):
        now = [100_000]
        http = FakeHttp([
            Response(200, challenge()), Response(200, {"sessionId": token(32, 5), "expiresAtMs": 700_000}),
            Response(503, {"error": "IDENTITY_SERVICE_UNAVAILABLE"}),
        ])
        client = AgentSessionClient(
            AgentConfig.from_env(config_env()), RecordingSigner(), http=http, now_ms=lambda: now[0]
        )
        original = client.ensure_session()
        now[0] = 580_000
        self.assertIs(original, client.ensure_session())
        self.assertEqual(0, client.camera_demand_side_effects)

    def test_sequence_allocator_is_unique_thread_safe_and_exhaustion_is_explicit(self):
        allocator = SequenceAllocator()
        values = []
        lock = threading.Lock()

        def allocate():
            local = [allocator.next() for _ in range(250)]
            with lock:
                values.extend(local)

        threads = [threading.Thread(target=allocate) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(list(range(1, 1001)), sorted(values))
        exhausted = SequenceAllocator(initial=(1 << 64) - 1)
        with self.assertRaises(SequenceExhausted):
            exhausted.next()

    def test_transport_signs_and_sends_the_same_compact_bytes(self):
        now = [100_000]
        session_http = FakeHttp([
            Response(200, challenge()), Response(200, {"sessionId": token(32, 6), "expiresAtMs": 700_000}),
            Response(201, {"ok": True}),
        ])
        signer = RecordingSigner()
        client = AgentSessionClient(
            AgentConfig.from_env(config_env()), signer, http=session_http, now_ms=lambda: now[0]
        )
        transport = AgentTransport(
            AgentConfig.from_env(config_env()), client, signer, http=session_http,
            now_ms=lambda: now[0], random_bytes=lambda count: bytes([8]) * count,
        )
        result = transport.submit("detection", {"cameraId": "CAM-01", "entities": []})
        self.assertTrue(result.ok)
        url, kwargs = session_http.calls[-1]
        self.assertTrue(url.endswith(REQUEST_PROOFS["detection"]["path"]))
        self.assertEqual(b'{"cameraId":"CAM-01","entities":[]}', kwargs["data"])
        self.assertNotIn("json", kwargs)
        self.assertNotIn("verify", kwargs)
        self.assertEqual("1", kwargs["headers"]["X-Aegis-Request-Sequence"])
        self.assertNotIn("=", kwargs["headers"]["X-Aegis-Request-Nonce"])
        self.assertEqual(2, len(signer.messages))

    def test_transport_adds_agent_owned_stream_source_to_physical_heartbeat(self):
        now = [100_000]
        http = FakeHttp([
            Response(200, challenge()),
            Response(200, {"sessionId": token(32, 6), "expiresAtMs": 700_000}),
            Response(200, {"ok": True}),
        ])
        signer = RecordingSigner()
        cfg = AgentConfig.from_env(config_env())
        client = AgentSessionClient(cfg, signer, http=http, now_ms=lambda: now[0])
        transport = AgentTransport(
            cfg, client, signer, http=http,
            now_ms=lambda: now[0], random_bytes=lambda count: bytes([8]) * count,
        )

        result = transport.submit("heartbeat", {"cameraConnected": False})

        self.assertTrue(result.ok)
        body = json.loads(http.calls[-1][1]["data"])
        self.assertEqual({
            "cameraConnected": False,
            "streamUrl": "http://aegis-stream-host.internal:18077/stream.mjpg",
        }, body)
        for forbidden in ("cameraId", "nodeId", "physicalCameraId"):
            self.assertNotIn(forbidden, body)

    def test_rejected_ingest_invalidates_session_without_replaying_event(self):
        now = [100_000]
        http = FakeHttp([
            Response(200, challenge()),
            Response(200, {"sessionId": token(32, 6), "expiresAtMs": 700_000}),
            Response(401, {"error": "REQUEST_PROOF_FAILED"}),
        ])
        signer = RecordingSigner()
        client = AgentSessionClient(
            AgentConfig.from_env(config_env()), signer, http=http, now_ms=lambda: now[0]
        )
        transport = AgentTransport(
            AgentConfig.from_env(config_env()), client, signer, http=http,
            now_ms=lambda: now[0], random_bytes=lambda count: bytes([8]) * count,
        )
        result = transport.submit("detection", {"cameraId": "CAM-01", "entities": []})
        self.assertFalse(result.ok)
        self.assertEqual(401, result.status)
        self.assertEqual("MONITOR_REJECTED", result.error)
        self.assertEqual(3, len(http.calls), "a rejected event must not cross into a new Agent session")
        self.assertIsNone(client._session)


if __name__ == "__main__":
    unittest.main()
