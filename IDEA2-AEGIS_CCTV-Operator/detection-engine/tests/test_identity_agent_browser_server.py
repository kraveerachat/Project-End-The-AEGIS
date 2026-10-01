import io
import json
import pathlib
import sys
import unittest

ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.browser_server import (
    BrowserAssertionApplication,
    BrowserRateLimiter,
    read_bounded_http_body,
    validate_loopback_bind,
)


class _Signer:
    class _Identity:
        node_id = "edge-node-01"
        key_version = 7

    public_identity = _Identity()

    def sign(self, payload):
        return b"x" * 64


class BrowserAssociationServerTests(unittest.TestCase):
    def test_key_store_health_is_fresh_loopback_only_nonsecret_attestation(self):
        calls = []

        def attest():
            calls.append(True)
            return {
                "status": "ok",
                "processId": 321,
                "keyState": "PRESENT",
                "keyAcl": "VALID",
                "dataRootAcl": "VALID",
            }

        app = BrowserAssertionApplication(
            _Signer(), allowed_origins={"https://aegis.internal"},
            expected_audience="https://aegis.internal", health_check=attest,
        )
        result = app.handle("GET", "/v1/health/key-store", {}, b"")
        self.assertEqual(200, result.status)
        self.assertEqual(1, len(calls))
        payload = json.loads(result.body)
        self.assertEqual("PRESENT", payload["keyState"])
        self.assertNotIn("Access-Control-Allow-Origin", result.headers)
        self.assertNotIn("private", result.body.decode("ascii").lower())

    def test_bind_is_ipv4_loopback_only(self):
        self.assertEqual("127.0.0.1", validate_loopback_bind("127.0.0.1"))
        for host in ("0.0.0.0", "::1", "localhost", "192.168.1.5"):
            with self.subTest(host=host):
                with self.assertRaisesRegex(ValueError, "127.0.0.1"):
                    validate_loopback_bind(host)

    def test_origin_cors_pna_and_route_surface_are_exact(self):
        app = BrowserAssertionApplication(
            _Signer(), allowed_origins={"https://aegis.internal"}, expected_audience="https://aegis.internal"
        )
        preflight = app.handle("OPTIONS", "/v1/browser-association/assert", {"origin": "https://aegis.internal", "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true"}, b"")
        self.assertEqual(204, preflight.status)
        self.assertEqual("https://aegis.internal", preflight.headers["Access-Control-Allow-Origin"])
        self.assertEqual("true", preflight.headers["Access-Control-Allow-Private-Network"])
        self.assertNotIn("Access-Control-Allow-Credentials", preflight.headers)
        for method, path, origin in [
            ("GET", "/v1/browser-association/assert", "https://aegis.internal"),
            ("POST", "/v1/browser-association/assert?x=1", "https://aegis.internal"),
            ("POST", "/v1/browser-association/assert", "https://evil.invalid"),
        ]:
            self.assertGreaterEqual(app.handle(method, path, {"origin": origin, "content-type": "application/json"}, b"{}").status, 400)

    def test_body_reader_caps_content_length_chunked_and_absent_length(self):
        with self.assertRaisesRegex(ValueError, "size"):
            read_bounded_http_body(io.BytesIO(b"x" * 20), {"content-length": "20"}, max_bytes=16)
        chunked = io.BytesIO(b"9\r\n123456789\r\n9\r\n123456789\r\n0\r\n\r\n")
        with self.assertRaisesRegex(ValueError, "size"):
            read_bounded_http_body(chunked, {"transfer-encoding": "chunked"}, max_bytes=16)
        with self.assertRaisesRegex(ValueError, "length"):
            read_bounded_http_body(io.BytesIO(b"{}"), {}, max_bytes=16)

    def test_body_reader_enforces_one_monotonic_deadline_across_trickled_reads(self):
        clock = [0.0]

        class Trickle:
            def read(self, _size):
                clock[0] += 0.4
                return b"x"

        with self.assertRaisesRegex(TimeoutError, "deadline"):
            read_bounded_http_body(
                Trickle(), {"content-length": "4"}, max_bytes=16,
                deadline=1.0, now=lambda: clock[0],
            )

    def test_post_attempt_is_rate_admitted_before_body_read(self):
        limiter = BrowserRateLimiter(now=lambda: 100.0, limit=1)
        app = BrowserAssertionApplication(
            _Signer(), allowed_origins={"https://aegis.internal"},
            expected_audience="https://aegis.internal", rate_limiter=limiter,
        )
        headers = {"origin": "https://aegis.internal", "content-type": "application/json"}
        origin, immediate = app.prepare("POST", "/v1/browser-association/assert", headers)
        self.assertEqual("https://aegis.internal", origin)
        self.assertIsNone(immediate)
        _origin, rejected = app.prepare("POST", "/v1/browser-association/assert", headers)
        self.assertEqual(429, rejected.status)

    def test_valid_post_returns_only_fixed_public_assertion_and_duplicate_keys_fail(self):
        app = BrowserAssertionApplication(
            _Signer(), allowed_origins={"https://aegis.internal"}, expected_audience="https://aegis.internal"
        )
        token = "A" * 43
        challenge = {
            "version": 1,
            "purpose": "AEGIS-BROWSER-NODE-ASSOCIATION-V1",
            "audience": "https://aegis.internal",
            "challenge_id": token,
            "challenge_nonce": token,
            "session_binding": token,
            "issued_at_ms": 1,
            "expires_at_ms": 30_001,
        }
        result = app.handle(
            "POST", "/v1/browser-association/assert",
            {"origin": "https://aegis.internal", "content-type": "application/json"},
            json.dumps(challenge).encode("utf-8"),
        )
        self.assertEqual(200, result.status)
        assertion = json.loads(result.body)
        self.assertEqual({"claims", "signature"}, set(assertion))
        self.assertEqual("edge-node-01", assertion["claims"]["node_id"])
        self.assertNotIn("private", result.body.decode("ascii").lower())
        duplicate = b'{"version":1,"version":1}'
        rejected = app.handle(
            "POST", "/v1/browser-association/assert",
            {"origin": "https://aegis.internal", "content-type": "application/json"}, duplicate,
        )
        self.assertEqual(400, rejected.status)
        self.assertEqual({"error": "INVALID_REQUEST"}, json.loads(rejected.body))
        wrong_audience = {**challenge, "audience": "https://other.invalid"}
        rejected = app.handle(
            "POST", "/v1/browser-association/assert",
            {"origin": "https://aegis.internal", "content-type": "application/json"},
            json.dumps(wrong_audience).encode("utf-8"),
        )
        self.assertEqual(400, rejected.status)

    def test_rate_limiter_allows_twelve_attempts_per_origin_per_rolling_minute(self):
        limiter = BrowserRateLimiter(now=lambda: 100.0)
        for _ in range(12):
            self.assertTrue(limiter.allow("https://aegis.internal"))
        self.assertFalse(limiter.allow("https://aegis.internal"))

    def test_server_module_does_not_import_camera_or_engine_runtime(self):
        import aegis_identity_agent.browser_server as module
        source = pathlib.Path(module.__file__).read_text(encoding="utf-8")
        self.assertNotIn("aegis_engine", source)
        self.assertNotIn("camera", source.lower())


if __name__ == "__main__":
    unittest.main()
