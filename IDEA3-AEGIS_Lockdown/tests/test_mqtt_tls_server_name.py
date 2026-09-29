"""Core MQTT TLS server-name contract (L7 live-preparation finding, 2026-09-27).

The L6a/L6b broker certificate profile allows exactly ``DNS:mqtt.aegis.home.arpa`` and FORBIDS IP SANs
(deploy/pr11-phase4/p4-mqtt-pki.py). The Core connects to a broker IP address (runtime preflight refuses other hostnames), and
paho passes the connect host as ``server_hostname``, so a verifying client rejects the certificate with "IP address mismatch".
``AEGIS_MQTT_TLS_SERVER_NAME`` lets the Core verify the certificate against the DNS name while connecting to the IP. Verification
stays fully on (CERT_REQUIRED, check_hostname, pinned CA, TLS 1.2 minimum); nothing here weakens it.
Throwaway loopback Mosquitto only; no host service is touched.
"""

from __future__ import annotations

import socket
import ssl
import subprocess
import time
from pathlib import Path

import pytest

from aegis_soc import config
from aegis_soc import mqtt_client as mqtt_module
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.mqtt_client import build_mqtt_ssl_context

NAME = "mqtt.aegis.home.arpa"


def make_profile_pki(directory: Path) -> None:
    """A CA with proper CA key usage and a DNS-only broker leaf (the L6a profile), so Python's strict verification is on."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "ca.ext").write_text("basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n", encoding="ascii")
    (directory / "leaf.ext").write_text(
        f"subjectAltName=DNS:{NAME}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
        encoding="ascii",
    )
    for cmd in (
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt",
         "-days", "1", "-subj", "/CN=AEGIS IDEA3 MQTT CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
        ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "broker.key", "-out", "broker.csr", "-subj", f"/CN={NAME}"],
        ["openssl", "x509", "-req", "-in", "broker.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "broker.crt", "-days", "1", "-extfile", "leaf.ext"],
    ):
        subprocess.run(cmd, cwd=directory, check=True, capture_output=True)


@pytest.fixture()
def broker(tmp_path: Path):
    pki = tmp_path / "pki"
    make_profile_pki(pki)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    conf = tmp_path / "b.conf"
    conf.write_text(
        f"allow_anonymous true\npersistence false\nlistener {port} 127.0.0.1\ncafile {pki/'ca.crt'}\ncertfile {pki/'broker.crt'}\n"
        f"keyfile {pki/'broker.key'}\ntls_version tlsv1.2\n", encoding="ascii")
    proc = subprocess.Popen(["mosquitto", "-c", str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield pki / "ca.crt", port
    proc.terminate()
    proc.wait(timeout=3)


def handshake(ctx: ssl.SSLContext, port: int, server_hostname: str) -> str:
    """Do exactly what paho does: wrap the socket with server_hostname == the connect host."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=3)
    with ctx.wrap_socket(sock, server_hostname=server_hostname) as wrapped:
        return wrapped.version()


def test_dns_only_certificate_is_rejected_when_verifying_against_the_broker_ip(broker) -> None:
    """The live gap: default behaviour verifies against the connect address, which the profile forbids as an IP SAN."""
    ca, port = broker
    with pytest.raises(ssl.SSLCertVerificationError, match="IP address mismatch"):
        handshake(build_mqtt_ssl_context(str(ca)), port, "127.0.0.1")


def test_server_name_lets_the_core_verify_the_dns_name_while_connecting_to_the_ip(broker) -> None:
    ca, port = broker
    ctx = build_mqtt_ssl_context(str(ca), server_name=NAME)
    assert handshake(ctx, port, "127.0.0.1").startswith("TLSv1")


def test_server_name_never_weakens_verification(broker) -> None:
    ca, port = broker
    ctx = build_mqtt_ssl_context(str(ca), server_name=NAME)
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True
    assert ctx.minimum_version >= ssl.TLSVersion.TLSv1_2
    # a wrong name still fails, and so does a CA that did not sign the broker certificate
    with pytest.raises(ssl.SSLCertVerificationError):
        handshake(build_mqtt_ssl_context(str(ca), server_name="wrong.example.test"), port, "127.0.0.1")


def test_server_name_ignores_a_caller_supplied_hostname_but_still_needs_the_pinned_ca(broker, tmp_path: Path) -> None:
    ca, port = broker
    other = tmp_path / "other"
    make_profile_pki(other)
    with pytest.raises(ssl.SSLCertVerificationError):
        handshake(build_mqtt_ssl_context(str(other / "ca.crt"), server_name=NAME), port, "127.0.0.1")


@pytest.mark.parametrize("bad", ["10.77.30.1", "::1", "has space", "a..b", "-lead.example", "x" * 254, "mqtt.aegis.home.arpa\n"])
def test_server_name_must_be_a_dns_name(bad: str, tmp_path: Path) -> None:
    make_profile_pki(tmp_path)
    with pytest.raises(ValueError):
        build_mqtt_ssl_context(str(tmp_path / "ca.crt"), server_name=bad)


def test_empty_server_name_keeps_the_existing_behaviour(tmp_path: Path) -> None:
    make_profile_pki(tmp_path)
    ctx = build_mqtt_ssl_context(str(tmp_path / "ca.crt"), server_name="")
    assert ctx.check_hostname is True and ctx.verify_mode == ssl.CERT_REQUIRED


class _Client:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def tls_set_context(self, context) -> None:
        self.calls.append(("tls_set_context", context))

    def username_pw_set(self, *a) -> None: ...
    def connect_async(self, *a) -> None:
        self.calls.append(("connect_async", a))

    def loop_start(self) -> None: ...


def _start(monkeypatch, tmp_path: Path, server_name: str):
    ca = tmp_path / "ca.crt"
    ca.write_text("x")
    monkeypatch.setattr(config, "BROKER_CONFIGURED", True)
    monkeypatch.setattr(config, "MQTT_TLS", True)
    monkeypatch.setattr(config, "MQTT_CA_FILE", str(ca))
    monkeypatch.setattr(config, "MQTT_TLS_SERVER_NAME", server_name, raising=False)
    monkeypatch.setattr(config, "BROKER_IP", "10.77.30.1")
    seen: list[tuple] = []
    monkeypatch.setattr(mqtt_module, "build_mqtt_ssl_context", lambda *a, **k: seen.append((a, k)) or "CTX")
    client = _Client()
    obj = MQTTManager(protocol=None, client_factory=lambda: client, protocol_mode="legacy-v0-lab")
    obj.start()
    return seen, client.calls


def test_start_passes_the_configured_server_name_and_still_connects_to_the_broker_ip(monkeypatch, tmp_path: Path) -> None:
    seen, calls = _start(monkeypatch, tmp_path, NAME)
    assert seen == [((str(tmp_path / "ca.crt"),), {"server_name": NAME})]
    assert ("connect_async", ("10.77.30.1", config.PORT, 60)) in calls


def test_start_without_a_server_name_calls_the_builder_exactly_as_before(monkeypatch, tmp_path: Path) -> None:
    seen, _ = _start(monkeypatch, tmp_path, "")
    assert seen == [((str(tmp_path / "ca.crt"),), {})]


def test_config_reads_the_server_name_from_the_environment(monkeypatch) -> None:
    import importlib

    monkeypatch.setenv("AEGIS_MQTT_TLS_SERVER_NAME", f"  {NAME}  ")
    try:
        assert importlib.reload(config).MQTT_TLS_SERVER_NAME == NAME
    finally:
        monkeypatch.delenv("AEGIS_MQTT_TLS_SERVER_NAME")
        importlib.reload(config)
