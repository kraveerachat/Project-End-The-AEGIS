from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import ssl
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.config import AgentConfig, validate_ca_bundle
from aegis_identity_agent.session_client import AgentAuthenticationError, AgentSessionClient
from aegis_identity_agent.transport import AgentTransport


def _token(size: int, fill: int) -> str:
    return base64.urlsafe_b64encode(bytes([fill]) * size).rstrip(b"=").decode("ascii")


def _config_env(base_url: str, **overrides: str) -> dict[str, str]:
    values = {
        "AEGIS_AGENT_MONITOR_BASE_URL": base_url,
        "AEGIS_AGENT_AUTH_AUDIENCE": base_url,
        "AEGIS_AGENT_NODE_ID": "edge-a",
        "AEGIS_AGENT_KEY_VERSION": "4",
        "AEGIS_AGENT_KEY_PATH": r"C:\ProgramData\AEGIS\IdentityAgent\machine-identity.dpapi",
        "AEGIS_AGENT_ENGINE_STREAM_URL": "http://aegis-stream-host.internal:18077/stream.mjpg",
        "AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS": base_url,
    }
    values.update(overrides)
    if "AEGIS_AGENT_CA_BUNDLE" in values:
        values.setdefault(
            "AEGIS_AGENT_CONFIGURATION_ROOT",
            str(Path(values["AEGIS_AGENT_CA_BUNDLE"]).parent),
        )
    return values


def _issue_certificates(*, ca_expired: bool = False):
    now = datetime.now(timezone.utc)
    ca_not_before = now - timedelta(days=2 if ca_expired else 0, minutes=5)
    ca_not_after = now - timedelta(days=1) if ca_expired else now + timedelta(days=1)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AEGIS disposable test CA")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(ca_not_before)
        .not_valid_after(ca_not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(leaf_name)
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return ca_key, ca_cert, leaf_key, leaf_cert


def _write_certificates(root: Path, *, ca_expired: bool = False):
    root.mkdir(parents=True, exist_ok=True)
    ca_key, ca_cert, leaf_key, leaf_cert = _issue_certificates(ca_expired=ca_expired)
    ca_path = root / "agent-ca-bundle.pem"
    leaf_path = root / "server-cert.pem"
    key_path = root / "server-key.pem"
    ca_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    leaf_path.write_bytes(leaf_cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return ca_key, ca_cert, ca_path, leaf_path, key_path


class _Signer:
    def sign(self, _message):
        return bytes([7]) * 64


class _Response:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class _FakeHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.trust_env = True

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


class _AgentAuthHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        if self.path.endswith("/internal/agent-auth/challenge"):
            body = {
                "challengeId": _token(32, 1),
                "nonce": _token(32, 2),
                "issuedAtMs": 100_000,
                "expiresAtMs": 160_000,
                "audience": self.server.audience,
                "purpose": "agent-authenticate",
                "nodeId": "edge-a",
                "keyVersion": 4,
            }
        elif self.path.endswith("/internal/agent-auth/verify"):
            body = {"sessionId": _token(32, 3), "expiresAtMs": 700_000}
        else:
            self.send_error(404)
            return
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format, *_args):
        return


class _TlsAgentServer:
    def __init__(self, root: Path):
        _, _, self.ca_path, leaf_path, key_path = _write_certificates(root)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _AgentAuthHandler)
        self.port = self.httpd.server_address[1]
        self.httpd.audience = f"https://localhost:{self.port}"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(leaf_path, key_path)
        self.httpd.socket = context.wrap_socket(self.httpd.socket, server_side=True)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.httpd.shutdown()
        self.thread.join(timeout=5)
        self.httpd.server_close()


class AgentCaBundleConfigTests(unittest.TestCase):
    def test_default_trust_is_explicit_when_custom_bundle_is_unset(self):
        config = AgentConfig.from_env(_config_env("https://monitor.example.test"))
        self.assertIsNone(config.ca_bundle_path)
        self.assertIs(True, config.tls_verify)
        self.assertEqual("DEFAULT", config.redacted()["ca_bundle_state"])
        empty = AgentConfig.from_env(_config_env(
            "https://monitor.example.test",
            AEGIS_AGENT_CA_BUNDLE="",
        ))
        self.assertIsNone(empty.ca_bundle_path)
        self.assertIs(True, empty.tls_verify)

    def test_valid_public_ca_bundle_is_accepted_without_exposing_its_path(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, ca_path, _, _ = _write_certificates(Path(directory))
            config = AgentConfig.from_env(_config_env(
                "https://monitor.example.test",
                AEGIS_AGENT_CA_BUNDLE=str(ca_path),
            ))
        self.assertEqual(str(ca_path.resolve()), config.ca_bundle_path)
        self.assertEqual(str(ca_path.resolve()), config.tls_verify)
        self.assertEqual("MANAGED", config.redacted()["ca_bundle_state"])
        self.assertNotIn(str(ca_path), json.dumps(config.redacted(), sort_keys=True))

    def test_invalid_bundle_shapes_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca_key, _, ca_path, leaf_path, _ = _write_certificates(root)
            missing = root / "missing.pem"
            empty = root / "empty.pem"
            malformed = root / "malformed.pem"
            private = root / "private.pem"
            empty.write_bytes(b"")
            malformed.write_text("not a PEM certificate", encoding="ascii")
            private.write_bytes(
                ca_path.read_bytes()
                + ca_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
            invalid = [missing, root, empty, malformed, private, leaf_path]
            for candidate in invalid:
                with self.subTest(candidate=candidate.name), self.assertRaises(ValueError):
                    AgentConfig.from_env(_config_env(
                        "https://monitor.example.test",
                        AEGIS_AGENT_CA_BUNDLE=str(candidate),
                    ))
            with self.assertRaises(ValueError):
                validate_ca_bundle("relative-ca.pem")

    def test_reparse_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, ca_path, _, _ = _write_certificates(root)
            fake_stat = os.lstat(ca_path)
            with mock.patch(
                "aegis_identity_agent.config.os.lstat",
                return_value=mock.Mock(
                    st_mode=fake_stat.st_mode,
                    st_size=fake_stat.st_size,
                    st_file_attributes=getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400),
                ),
            ):
                with self.assertRaises(ValueError):
                    validate_ca_bundle(str(ca_path))

    def test_expired_ca_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, ca_path, _, _ = _write_certificates(root, ca_expired=True)
            with self.assertRaises(ValueError):
                AgentConfig.from_env(_config_env(
                    "https://monitor.example.test",
                    AEGIS_AGENT_CA_BUNDLE=str(ca_path),
                ))

    def test_valid_bundle_outside_the_managed_configuration_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, ca_path, _, _ = _write_certificates(root / "outside")
            (root / "managed").mkdir()
            with self.assertRaises(ValueError):
                AgentConfig.from_env(_config_env(
                    "https://monitor.example.test",
                    AEGIS_AGENT_CA_BUNDLE=str(ca_path),
                    AEGIS_AGENT_CONFIGURATION_ROOT=str(root / "managed"),
                ))

    def test_unmanaged_requests_trust_environment_is_rejected(self):
        for name in (
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                AgentConfig.from_env(_config_env(
                    "https://monitor.example.test",
                    **{name: r"C:\unmanaged\ca.pem"},
                ))


class AgentCaBundleTransportTests(unittest.TestCase):
    def test_agent_auth_and_ingest_share_the_same_explicit_custom_trust(self):
        with tempfile.TemporaryDirectory() as directory:
            _, _, ca_path, _, _ = _write_certificates(Path(directory))
            config = AgentConfig.from_env(_config_env(
                "https://monitor.example.test",
                AEGIS_AGENT_CA_BUNDLE=str(ca_path),
            ))
            http = _FakeHttp([
                _Response(200, {
                    "challengeId": _token(32, 1),
                    "nonce": _token(32, 2),
                    "issuedAtMs": 100_000,
                    "expiresAtMs": 160_000,
                    "audience": "https://monitor.example.test",
                    "purpose": "agent-authenticate",
                    "nodeId": "edge-a",
                    "keyVersion": 4,
                }),
                _Response(200, {"sessionId": _token(32, 3), "expiresAtMs": 700_000}),
                _Response(200, {"ok": True}),
            ])
            signer = _Signer()
            sessions = AgentSessionClient(config, signer, http=http, now_ms=lambda: 100_000)
            transport = AgentTransport(
                config,
                sessions,
                signer,
                http=http,
                now_ms=lambda: 100_000,
                random_bytes=lambda count: bytes([8]) * count,
            )
            self.assertTrue(transport.submit("heartbeat", {"cameraConnected": False}).ok)
            self.assertTrue(http.calls)
            for _url, kwargs in http.calls:
                self.assertEqual(str(ca_path.resolve()), kwargs["verify"])

    def test_internally_owned_requests_sessions_ignore_environment_trust(self):
        config = AgentConfig.from_env(_config_env("https://monitor.example.test"))
        auth_http = _FakeHttp([])
        transport_http = _FakeHttp([])
        with mock.patch("requests.Session", side_effect=[auth_http, transport_http]):
            sessions = AgentSessionClient(config, _Signer())
            AgentTransport(config, sessions, _Signer())
        self.assertIs(False, auth_http.trust_env)
        self.assertIs(False, transport_http.trust_env)

    def test_approved_ca_succeeds_and_default_or_untrusted_ca_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with _TlsAgentServer(root) as server:
                base_url = f"https://localhost:{server.port}"
                approved = AgentConfig.from_env(_config_env(
                    base_url,
                    AEGIS_AGENT_CA_BUNDLE=str(server.ca_path),
                ))
                session = AgentSessionClient(approved, _Signer(), now_ms=lambda: 100_000).ensure_session()
                self.assertEqual(_token(32, 3), session.session_id)

                default_trust = AgentConfig.from_env(_config_env(base_url))
                with self.assertRaises(AgentAuthenticationError):
                    AgentSessionClient(default_trust, _Signer(), now_ms=lambda: 100_000).ensure_session()

                _, _, unrelated_ca, _, _ = _write_certificates(root / "unrelated")
                untrusted = AgentConfig.from_env(_config_env(
                    base_url,
                    AEGIS_AGENT_CA_BUNDLE=str(unrelated_ca),
                ))
                with self.assertRaises(AgentAuthenticationError):
                    AgentSessionClient(untrusted, _Signer(), now_ms=lambda: 100_000).ensure_session()

    def test_hostname_validation_remains_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            with _TlsAgentServer(Path(directory)) as server:
                config = AgentConfig.from_env(_config_env(
                    f"https://127.0.0.1:{server.port}",
                    AEGIS_AGENT_AUTH_AUDIENCE=f"https://127.0.0.1:{server.port}",
                    AEGIS_AGENT_CA_BUNDLE=str(server.ca_path),
                ))
                with self.assertRaises(AgentAuthenticationError):
                    AgentSessionClient(config, _Signer(), now_ms=lambda: 100_000).ensure_session()


if __name__ == "__main__":
    unittest.main()
