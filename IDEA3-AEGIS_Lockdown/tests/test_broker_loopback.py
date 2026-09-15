"""Isolated TLS broker tests using only throwaway ``tmp_path`` material."""

import getpass
import socket
import subprocess
import time
from pathlib import Path
from shutil import which

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.conf.example"
ACL = ROOT / "deploy/mosquitto/aegis-idea3-mosquitto.acl.example"


def _run(args, *, timeout=5):
    return subprocess.run(args, check=False, capture_output=True, text=True, timeout=timeout)


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _client_args(port, ca, user=None, password=None, *, client_id=None):
    client_id = client_id or user or "anonymous-test-client"
    args = ["-h", "127.0.0.1", "-p", str(port), "--cafile", str(ca), "-V", "mqttv311", "-i", client_id]
    if user is not None:
        args += ["-u", user, "-P", password]
    return args


def _certificates(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    ca_key, ca = tmp_path / "ca.key", tmp_path / "ca.crt"
    broker_key, broker_csr, broker = tmp_path / "broker.key", tmp_path / "broker.csr", tmp_path / "broker.crt"
    extensions = tmp_path / "broker.ext"
    extensions.write_text("subjectAltName=IP:127.0.0.1,IP:127.0.0.2\n", encoding="ascii")
    commands = [
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
         "-keyout", str(ca_key), "-out", str(ca), "-days", "1", "-subj", "/CN=AEGIS-TEST-ONLY-CA"],
        ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
         "-keyout", str(broker_key), "-out", str(broker_csr), "-subj", "/CN=AEGIS-TEST-ONLY-BROKER"],
        ["openssl", "x509", "-req", "-in", str(broker_csr), "-CA", str(ca), "-CAkey", str(ca_key),
         "-CAcreateserial", "-out", str(broker), "-days", "1", "-extfile", str(extensions)],
    ]
    for command in commands:
        subprocess.run(command, check=True, capture_output=True)
    return ca, broker, broker_key


def _wait_for_broker(process, port):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            pytest.fail(f"test broker exited early: {stdout}{stderr}")
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.02)
    pytest.fail("test broker did not listen within five seconds")


@pytest.mark.skipif(
    which("mosquitto") is None or which("openssl") is None or which("mosquitto_passwd") is None,
    reason="mosquitto, mosquitto_passwd, and openssl are required for the isolated broker test",
)
def test_tls_only_broker_enforces_identity_acl_and_retained_policy(tmp_path):
    port = _free_port()
    ca, broker_cert, broker_key = _certificates(tmp_path)
    password_file = tmp_path / "passwords"
    acl_file = tmp_path / "acl"
    config_file = tmp_path / "mosquitto.conf"
    subprocess.run(["mosquitto_passwd", "-b", "-c", str(password_file), "idea3-core", "core-test-pass"], check=True)
    subprocess.run(
        ["mosquitto_passwd", "-b", str(password_file), "idea3-dev-device-id", "device-test-pass"], check=True,
    )
    acl_file.write_text(ACL.read_text(encoding="utf-8"), encoding="utf-8")
    config = CONF.read_text(encoding="utf-8")
    replacements = {
        "8883": str(port),
        "<AEGIS_AP_ADDRESS>": "127.0.0.2",
        "<AEGIS_MQTT_PASSWORD_FILE>": str(password_file),
        "<AEGIS_MQTT_ACL_FILE>": str(acl_file),
        "<AEGIS_MQTT_CA_FILE>": str(ca),
        "<AEGIS_MQTT_CERT_FILE>": str(broker_cert),
        "<AEGIS_MQTT_KEY_FILE>": str(broker_key),
    }
    for old, new in replacements.items():
        config = config.replace(old, new)
    config = f"user {getpass.getuser()}\n" + config
    config_file.write_text(config, encoding="utf-8")

    broker = subprocess.Popen(["mosquitto", "-c", str(config_file), "-v"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True)
    try:
        _wait_for_broker(broker, port)
        core = _client_args(port, ca, "idea3-core", "core-test-pass")
        device = _client_args(port, ca, "idea3-dev-device-id", "device-test-pass")
        command = "aegis/idea3/v1/device-id/command"
        status = "aegis/idea3/v1/device-id/status"
        ack = "aegis/idea3/v1/device-id/ack"

        subscriber = subprocess.Popen(["mosquitto_sub", *device, "-t", command, "-C", "1", "-W", "3"],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.1)
        assert _run(["mosquitto_pub", *core, "-t", command, "-m", "test-only-frame"]).returncode == 0
        received, errors = subscriber.communicate(timeout=5)
        assert (subscriber.returncode, received.strip(), errors) == (0, "test-only-frame", "")

        assert _run(["mosquitto_pub", *device, "-t", status, "-m", "test-only-status"]).returncode == 0
        observer = subprocess.Popen(
            ["mosquitto_sub", *_client_args(port, ca, "idea3-core", "core-test-pass",
                                             client_id="idea3-core-denied-publish-observer"),
             "-t", status, "-C", "1", "-W", "1"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        time.sleep(0.1)
        _run(["mosquitto_pub", *core, "-t", status, "-m", "denied"])
        denied_delivery, _observer_errors = observer.communicate(timeout=5)
        assert denied_delivery == ""
        assert observer.returncode != 0
        assert _run(["mosquitto_sub", *device, "-t", ack, "-C", "1", "-W", "1"]).returncode != 0
        assert _run(["mosquitto_pub", *_client_args(port, ca), "-t", command, "-m", "anonymous"]).returncode != 0
        assert _run(["mosquitto_pub", "-h", "127.0.0.1", "-p", str(port), "-t", command, "-m", "plain"]).returncode != 0
        _run(["mosquitto_pub", *core, "-r", "-t", command, "-m", "retained"])
        retained_probe = _run(["mosquitto_sub", *device, "-t", command, "-C", "1", "-W", "1"])
        assert retained_probe.stdout == ""
        assert retained_probe.returncode != 0

        wrong_ca, _wrong_cert, _wrong_key = _certificates(tmp_path / "wrong")
        assert _run(["mosquitto_pub", *_client_args(port, wrong_ca, "idea3-core", "core-test-pass"),
                     "-t", command, "-m", "wrong-ca"]).returncode != 0
    finally:
        broker.terminate()
        try:
            broker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            broker.kill()
            broker.wait(timeout=5)
    assert broker.poll() is not None
