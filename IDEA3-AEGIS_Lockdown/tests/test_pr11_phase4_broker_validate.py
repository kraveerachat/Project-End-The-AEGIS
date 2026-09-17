from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "deploy/pr11-phase4/p4-broker-validate.py"


def test_isolated_validator_exists_and_exposes_validate_command() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--help",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "--config" in result.stdout
    assert "--core-password-file" in result.stdout
    assert "--device-password-file" in result.stdout
    assert "--device-id" in result.stdout


def test_validator_refuses_production_port_8883(tmp_path: Path) -> None:
    import os

    config = tmp_path / "mosquitto.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous false",
                "listener 8883 127.0.0.1",
                "protocol mqtt",
                "",
            ]
        ),
        encoding="utf-8",
    )

    core_secret.write_text("core-test-secret\n", encoding="utf-8")
    device_secret.write_text("device-test-secret\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "8883" in result.stderr


def test_validator_refuses_non_loopback_listener(tmp_path: Path) -> None:
    import os

    config = tmp_path / "mosquitto.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous false",
                "listener 28883 0.0.0.0",
                "protocol mqtt",
                "",
            ]
        ),
        encoding="utf-8",
    )

    core_secret.write_text("core-test-secret\n", encoding="utf-8")
    device_secret.write_text("device-test-secret\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "loopback" in result.stderr.lower()


def test_validator_rejects_config_that_real_mosquitto_cannot_start(
    tmp_path: Path,
) -> None:
    import os
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    config = tmp_path / "broken-mosquitto.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {tmp_path / 'missing-ca.crt'}",
                f"certfile {tmp_path / 'missing-broker.crt'}",
                f"keyfile {tmp_path / 'missing-broker.key'}",
                "tls_version tlsv1.2",
                "",
            ]
        ),
        encoding="utf-8",
    )

    core_secret.write_text("core-test-secret\n", encoding="utf-8")
    device_secret.write_text("device-test-secret\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert (
        "broker" in result.stderr.lower()
        or "mosquitto" in result.stderr.lower()
    )


def _make_test_tls_material(tmp_path: Path) -> tuple[Path, Path, Path]:
    ca_key = tmp_path / "ca.key"
    ca = tmp_path / "ca.crt"
    broker_key = tmp_path / "broker.key"
    broker_csr = tmp_path / "broker.csr"
    broker = tmp_path / "broker.crt"
    extensions = tmp_path / "broker.ext"

    extensions.write_text(
        "subjectAltName=IP:127.0.0.1\n",
        encoding="ascii",
    )

    commands = [
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca),
            "-days",
            "1",
            "-subj",
            "/CN=AEGIS-T2-TEST-CA",
        ],
        [
            "openssl",
            "req",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            str(broker_key),
            "-out",
            str(broker_csr),
            "-subj",
            "/CN=AEGIS-T2-TEST-BROKER",
        ],
        [
            "openssl",
            "x509",
            "-req",
            "-in",
            str(broker_csr),
            "-CA",
            str(ca),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(broker),
            "-days",
            "1",
            "-extfile",
            str(extensions),
        ],
    ]

    for command in commands:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
        )

    return ca, broker, broker_key


def test_validator_starts_and_stops_isolated_broker_without_residue(
    tmp_path: Path,
) -> None:
    import os
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_test_tls_material(tmp_path)

    config = tmp_path / "mosquitto.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous true",
                "persistence false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {ca}",
                f"certfile {broker_cert}",
                f"keyfile {broker_key}",
                "tls_version tlsv1.2",
                "",
            ]
        ),
        encoding="utf-8",
    )

    core_secret.write_text("core-test-secret\n", encoding="utf-8")
    device_secret.write_text("device-test-secret\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr
    assert "BROKER_PROCESS_STARTED=YES" in result.stdout
    assert "BROKER_RESIDUE=NO" in result.stdout

    with socket.socket() as probe:
        probe.settimeout(0.25)
        assert probe.connect_ex(("127.0.0.1", port)) != 0


def test_validator_refuses_plaintext_isolated_broker(
    tmp_path: Path,
) -> None:
    import os
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    config = tmp_path / "plaintext.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous true",
                "persistence false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                "",
            ]
        ),
        encoding="utf-8",
    )

    core_secret.write_text(
        "core-test-secret\n",
        encoding="utf-8",
    )
    device_secret.write_text(
        "device-test-secret\n",
        encoding="utf-8",
    )
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode != 0
    assert "tls" in result.stderr.lower()


def test_validator_rejects_wrong_core_password_against_rendered_material(
    tmp_path: Path,
) -> None:
    import os
    import socket

    material = ROOT / "deploy/pr11-phase4/p4-broker-material.py"

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_test_tls_material(tmp_path)

    good_core = tmp_path / "good-core.pass"
    wrong_core = tmp_path / "wrong-core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    good_core.write_text(
        "correct-core-test-secret\n",
        encoding="utf-8",
    )
    wrong_core.write_text(
        "wrong-core-test-secret\n",
        encoding="utf-8",
    )
    device_secret.write_text(
        "correct-device-test-secret\n",
        encoding="utf-8",
    )

    for secret in (
        good_core,
        wrong_core,
        device_secret,
    ):
        os.chmod(secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(good_core),
            "--device-password-file",
            str(device_secret),
            "--output",
            str(password_db),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "render-acl",
            "--device-id",
            "aegis-relay-01",
            "--output",
            str(acl),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    config.write_text(
        "\n".join(
            [
                "per_listener_settings false",
                "allow_anonymous false",
                f"password_file {password_db}",
                f"acl_file {acl}",
                "persistence false",
                "retain_available false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {ca}",
                f"certfile {broker_cert}",
                f"keyfile {broker_key}",
                "tls_version tlsv1.2",
                "require_certificate false",
                "",
            ]
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(wrong_core),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode != 0
    assert "auth" in result.stderr.lower()


def test_validator_authenticates_both_rendered_identities(
    tmp_path: Path,
) -> None:
    import os
    import socket

    material = ROOT / "deploy/pr11-phase4/p4-broker-material.py"

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_test_tls_material(tmp_path)

    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text(
        "correct-core-test-secret\n",
        encoding="utf-8",
    )
    device_secret.write_text(
        "correct-device-test-secret\n",
        encoding="utf-8",
    )

    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--output",
            str(password_db),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "render-acl",
            "--device-id",
            "aegis-relay-01",
            "--output",
            str(acl),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    config.write_text(
        "\n".join(
            [
                "per_listener_settings false",
                "allow_anonymous false",
                f"password_file {password_db}",
                f"acl_file {acl}",
                "persistence false",
                "retain_available false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {ca}",
                f"certfile {broker_cert}",
                f"keyfile {broker_key}",
                "tls_version tlsv1.2",
                "require_certificate false",
                "",
            ]
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr
    assert "CORE_AUTH=PASS" in result.stdout
    assert "DEVICE_AUTH=PASS" in result.stdout
    assert "BROKER_RESIDUE=NO" in result.stdout


def test_validator_proves_acl_matrix(
    tmp_path: Path,
) -> None:
    import os
    import socket

    material = ROOT / "deploy/pr11-phase4/p4-broker-material.py"

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_test_tls_material(tmp_path)

    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text(
        "correct-core-test-secret\n",
        encoding="utf-8",
    )
    device_secret.write_text(
        "correct-device-test-secret\n",
        encoding="utf-8",
    )

    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--output",
            str(password_db),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "render-acl",
            "--device-id",
            "aegis-relay-01",
            "--output",
            str(acl),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    config.write_text(
        "\n".join(
            [
                "per_listener_settings false",
                "allow_anonymous false",
                f"password_file {password_db}",
                f"acl_file {acl}",
                "persistence false",
                "retain_available false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {ca}",
                f"certfile {broker_cert}",
                f"keyfile {broker_key}",
                "tls_version tlsv1.2",
                "require_certificate false",
                "",
            ]
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )

    assert result.returncode == 0, result.stderr
    assert "CORE_AUTH=PASS" in result.stdout
    assert "DEVICE_AUTH=PASS" in result.stdout
    assert "ACL_MATRIX=PASS" in result.stdout
    assert "BROKER_RESIDUE=NO" in result.stdout


def test_validator_reports_negative_security_checks(
    tmp_path: Path,
) -> None:
    import os
    import socket

    material = ROOT / "deploy/pr11-phase4/p4-broker-material.py"

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_test_tls_material(tmp_path)

    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text(
        "correct-core-test-secret\n",
        encoding="utf-8",
    )
    device_secret.write_text(
        "correct-device-test-secret\n",
        encoding="utf-8",
    )

    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--output",
            str(password_db),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    result = subprocess.run(
        [
            sys.executable,
            str(material),
            "render-acl",
            "--device-id",
            "aegis-relay-01",
            "--output",
            str(acl),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr

    config.write_text(
        "\n".join(
            [
                "per_listener_settings false",
                "allow_anonymous false",
                f"password_file {password_db}",
                f"acl_file {acl}",
                "persistence false",
                "retain_available false",
                f"listener {port} 127.0.0.1",
                "protocol mqtt",
                f"cafile {ca}",
                f"certfile {broker_cert}",
                f"keyfile {broker_key}",
                "tls_version tlsv1.2",
                "require_certificate false",
                "",
            ]
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(core_secret),
            "--device-password-file",
            str(device_secret),
            "--device-id",
            "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert "ANONYMOUS_REJECTED=PASS" in result.stdout
    assert "RETAINED_REJECTED=PASS" in result.stdout
    assert "NEGATIVE_SECURITY=PASS" in result.stdout
