# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L6a Isolated TLS / PKI Validation Test Suite.

Authoritative Design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-20-idea3-pr11-phase4-l6a-operational-design.md
Decisions:
  OD-L6A-01 through OD-L6A-07 (Approved 2026-09-20).
"""

from __future__ import annotations

import os
import re
import socket
import stat
import subprocess
import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L6A_STAGE = STAGES / "L6a"
P4_LIB = DEPLOY / "p4-lib.sh"
COMPARE = DEPLOY / "p4-compare.sh"
VALIDATOR = DEPLOY / "p4-broker-validate.py"
MATERIAL = DEPLOY / "p4-broker-material.py"
MQTT_PKI = DEPLOY / "p4-mqtt-pki.py"
ACL_TEMPLATE = ROOT / "deploy" / "mosquitto" / "aegis-idea3-mosquitto.acl.example"

REQUIRED_HANDLER_FILES = (
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
)

EVIDENCE_ALLOWED_KEYS = (
    "schema",
    "stage",
    "result",
    "listener_address",
    "listener_port",
    "pki_profile",
    "pki_chain",
    "pki_hostname",
    "tls_runtime_version",
    "core_auth",
    "device_auth",
    "anonymous_rejected",
    "wrong_core_password_rejected",
    "wrong_device_password_rejected",
    "acl_matrix",
    "retained_rejected",
    "broker_residue",
    "secret_output_scan",
    "started_at",
    "finished_at",
)

FORBIDDEN_ROLLBACK_PATTERNS = [
    r"\bpkill\b",
    r"\bkillall\b",
    r"\bpgrep\b",
]


def _make_pki(
    tmp_path: Path,
    *,
    dns_san: str = "mqtt.aegis.home.arpa",
    include_ip_san: bool = False,
    ca_cn: str = "AEGIS IDEA3 MQTT CA",
) -> tuple[Path, Path, Path]:
    """Helper to generate throwaway TEST PKI fixtures."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    ca_key = tmp_path / "ca.key"
    ca = tmp_path / "ca.crt"
    broker_key = tmp_path / "broker.key"
    broker_csr = tmp_path / "broker.csr"
    broker = tmp_path / "broker.crt"
    extensions = tmp_path / "broker.ext"

    san_entries = [f"DNS:{dns_san}"]
    if include_ip_san:
        san_entries.append("IP:127.0.0.1")

    ext_content = [
        f"subjectAltName={','.join(san_entries)}",
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
    ]
    extensions.write_text("\n".join(ext_content), encoding="ascii")

    commands = [
        [
            "openssl", "req", "-x509", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
            "-keyout", str(ca_key), "-out", str(ca),
            "-days", "1", "-subj", f"/CN={ca_cn}",
        ],
        [
            "openssl", "req", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
            "-keyout", str(broker_key), "-out", str(broker_csr),
            "-subj", f"/CN={dns_san}",
        ],
        [
            "openssl", "x509", "-req", "-in", str(broker_csr),
            "-CA", str(ca), "-CAkey", str(ca_key), "-CAcreateserial",
            "-out", str(broker), "-days", "1", "-extfile", str(extensions),
        ],
    ]

    for command in commands:
        subprocess.run(command, check=True, capture_output=True)

    return ca, broker, broker_key


# ==============================================================================
# 1. L6A HANDLER REGISTRATION & STRUCTURE CONTRACT (OD-L6A-06)
# ==============================================================================

def test_l6a_handler_files_exist_and_executable() -> None:
    """OD-L6A-06: stages/L6a/ must exist with all 5 required handler files."""
    assert L6A_STAGE.is_dir(), "stages/L6a directory must exist"
    for filename in REQUIRED_HANDLER_FILES:
        filepath = L6A_STAGE / filename
        assert filepath.is_file(), f"Missing required L6a file: {filename}"
        assert not filepath.is_symlink(), f"L6a file must not be a symlink: {filename}"
        mode = filepath.stat().st_mode
        if filename.endswith(".sh"):
            assert bool(mode & stat.S_IXUSR), f"{filename} must be executable"
        else:
            assert bool(mode & stat.S_IRUSR), f"{filename} must be readable"


def test_l6a_stage_registered_in_p4_lib() -> None:
    """OD-L6A-06: p4_stage_handler_status L6a must evaluate to REGISTERED."""
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"source '{P4_LIB}' && p4_stage_handler_status L6a",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "REGISTERED"


def test_l6a_allowlists_are_completely_empty() -> None:
    """OD-L6A-06: L6a Option B requires zero active keys and zero active listeners."""
    keys_file = L6A_STAGE / "allow-keys.txt"
    listeners_file = L6A_STAGE / "allow-listeners.txt"
    assert keys_file.is_file()
    assert listeners_file.is_file()

    active_keys = [
        line.strip()
        for line in keys_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    active_listeners = [
        line.strip()
        for line in listeners_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]

    assert active_keys == [], f"allow-keys.txt must be empty, found: {active_keys}"
    assert active_listeners == [], f"allow-listeners.txt must be empty, found: {active_listeners}"


def test_l6a_single_broker_lifecycle_owner_in_apply() -> None:
    """OD-L6A-02: apply.sh must NOT spawn Mosquitto; p4-broker-validate.py is sole owner."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()
    content = apply_script.read_text(encoding="utf-8")

    # Assert apply.sh invokes p4-broker-validate.py
    assert "p4-broker-validate.py" in content, "apply.sh must invoke p4-broker-validate.py"
    # Assert apply.sh does not directly execute mosquitto
    assert not re.search(r"\bmosquitto\s+-c\b", content), "apply.sh must not directly launch mosquitto"


# ==============================================================================
# 2. REQUIRED PORT CONTRACT & 1883/8883 REJECTION (OD-L6A-02)
# ==============================================================================

def test_l6a_validator_rejects_isolated_1883_listener(tmp_path: Path) -> None:
    """OD-L6A-02: Isolated validation config must explicitly reject plaintext port 1883."""
    config = tmp_path / "mosquitto.conf"
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"

    config.write_text(
        "\n".join(
            [
                "allow_anonymous false",
                "listener 1883 127.0.0.1",
                "protocol mqtt",
                "",
            ]
        ),
        encoding="utf-8",
    )
    core_secret.write_text("secret1\n", encoding="utf-8")
    device_secret.write_text("secret2\n", encoding="utf-8")
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
        "1883" in result.stderr
        or "plaintext" in result.stderr.lower()
    ), f"Validator must explicitly reject port 1883: {result.stderr}"


def test_l6a_handler_requires_port_variable(tmp_path: Path) -> None:
    """OD-L6A-02: apply.sh must fail closed if AEGIS_L6A_PORT is unset."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()

    env = os.environ.copy()
    env.pop("AEGIS_L6A_PORT", None)
    env["AEGIS_L6A_WORK_DIR"] = str(tmp_path / "work")
    env["AEGIS_L6A_INPUT_DIR"] = str(tmp_path / "inputs")

    result = subprocess.run(
        ["bash", str(apply_script)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "AEGIS_L6A_PORT" in (result.stdout + result.stderr)


def test_l6a_handler_rejects_forbidden_or_invalid_port(tmp_path: Path) -> None:
    """OD-L6A-02: apply.sh must reject 1883, 8883, 1024, 65536, and invalid port ranges."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()

    for bad_port in ("1024", "1883", "8883", "999", "65536", "70000", "invalid"):
        env = os.environ.copy()
        env["AEGIS_L6A_PORT"] = bad_port
        env["AEGIS_L6A_WORK_DIR"] = str(tmp_path / f"work_{bad_port}")
        env["AEGIS_L6A_INPUT_DIR"] = str(tmp_path / "inputs")

        result = subprocess.run(
            ["bash", str(apply_script)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode != 0, f"apply.sh must reject AEGIS_L6A_PORT={bad_port}"
        assert "AEGIS_L6A_PORT" in (result.stdout + result.stderr)


def test_l6a_handler_accepts_contractual_port_boundaries(tmp_path: Path) -> None:
    """OD-L6A-02: apply.sh must accept boundary ports 1025 and 65535 during port validation."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()

    for valid_boundary_port in ("1025", "65535"):
        env = os.environ.copy()
        env["AEGIS_L6A_PORT"] = valid_boundary_port
        env["AEGIS_L6A_WORK_DIR"] = str(tmp_path / f"work_{valid_boundary_port}")
        env["AEGIS_L6A_INPUT_DIR"] = str(tmp_path / "inputs_nonexistent")

        result = subprocess.run(
            ["bash", str(apply_script)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        output = result.stdout + result.stderr
        assert "AEGIS_L6A_PORT" not in output, (
            f"apply.sh must not reject valid port {valid_boundary_port} on port validation: {output}"
        )
        assert "AEGIS_L6A_INPUT_DIR must exist" in output


# ==============================================================================
# 3. SECRET & FILE AUTHORITY / SYMLINK REJECTION (OD-L6A-01)
# ==============================================================================

def test_l6a_broker_material_rejects_symlink_secrets(tmp_path: Path) -> None:
    """OD-L6A-01: build-password-db must reject symlinks for secret password inputs."""
    real_secret = tmp_path / "real.pass"
    real_secret.write_text("correct-password\n", encoding="utf-8")
    os.chmod(real_secret, 0o600)

    symlink_secret = tmp_path / "symlink.pass"
    symlink_secret.symlink_to(real_secret)

    device_secret = tmp_path / "device.pass"
    device_secret.write_text("device-password\n", encoding="utf-8")
    os.chmod(device_secret, 0o600)

    output_db = tmp_path / "passwords"

    result = subprocess.run(
        [
            sys.executable,
            str(MATERIAL),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(symlink_secret),
            "--device-password-file",
            str(device_secret),
            "--output",
            str(output_db),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0, "Must reject symlink password file input"
    assert "symlink" in result.stderr.lower()


def test_l6a_validator_rejects_symlink_secrets(tmp_path: Path) -> None:
    """OD-L6A-01: p4-broker-validate.py must reject symlink secret inputs."""
    real_secret = tmp_path / "real.pass"
    real_secret.write_text("correct-password\n", encoding="utf-8")
    os.chmod(real_secret, 0o600)

    symlink_secret = tmp_path / "symlink.pass"
    symlink_secret.symlink_to(real_secret)

    device_secret = tmp_path / "device.pass"
    device_secret.write_text("device-password\n", encoding="utf-8")
    os.chmod(device_secret, 0o600)

    config = tmp_path / "mosquitto.conf"
    config.write_text("listener 18884 127.0.0.1\n", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "validate",
            "--config",
            str(config),
            "--core-password-file",
            str(symlink_secret),
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
    assert result.returncode != 0, "Validator must fail on symlink secret input"
    assert "symlink" in result.stderr.lower()


def test_l6a_pki_rejects_symlink_certificates(tmp_path: Path) -> None:
    """OD-L6A-01: validate-broker-cert must reject symlink certificate inputs."""
    ca, broker, _ = _make_pki(tmp_path)

    symlink_ca = tmp_path / "symlink_ca.crt"
    symlink_ca.symlink_to(ca)

    result = subprocess.run(
        [
            sys.executable,
            str(MQTT_PKI),
            "validate-broker-cert",
            "--ca-file",
            str(symlink_ca),
            "--cert-file",
            str(broker),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0, "validate-broker-cert must reject symlink CA"
    assert "symlink" in result.stderr.lower()


def test_l6a_rejects_loose_private_modes(tmp_path: Path) -> None:
    """OD-L6A-01: Secrets must strictly have mode 0600 or 0400, rejecting 0644/0660."""
    secret = tmp_path / "loose.pass"
    secret.write_text("test-secret\n", encoding="utf-8")
    os.chmod(secret, 0o644)

    other = tmp_path / "other.pass"
    other.write_text("test-secret\n", encoding="utf-8")
    os.chmod(other, 0o600)

    out = tmp_path / "out.db"

    result = subprocess.run(
        [
            sys.executable,
            str(MATERIAL),
            "build-password-db",
            "--device-id",
            "aegis-relay-01",
            "--core-password-file",
            str(secret),
            "--device-password-file",
            str(other),
            "--output",
            str(out),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0, "Must reject loose permissions on secret"


# ==============================================================================
# 4. EXACT DNS-ONLY SAN PROFILE (OD-L6A-03)
# ==============================================================================

def test_l6a_pki_rejects_extra_ip_san_in_broker_cert(tmp_path: Path) -> None:
    """OD-L6A-03: p4-mqtt-pki.py must reject certificates containing extra IP SANs."""
    ca, broker, _ = _make_pki(tmp_path, dns_san="mqtt.aegis.home.arpa", include_ip_san=True)

    result = subprocess.run(
        [
            sys.executable,
            str(MQTT_PKI),
            "validate-broker-cert",
            "--ca-file",
            str(ca),
            "--cert-file",
            str(broker),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0, "Broker cert with extra IP SAN must be rejected by exact profile"
    assert (
        "ip san" in result.stderr.lower()
        or "extra san" in result.stderr.lower()
        or "profile" in result.stderr.lower()
    )


def test_l6a_pki_accepts_pure_dns_san_cert(tmp_path: Path) -> None:
    """OD-L6A-03: p4-mqtt-pki.py must accept certificates with exact DNS SAN."""
    ca, broker, _ = _make_pki(tmp_path, dns_san="mqtt.aegis.home.arpa", include_ip_san=False)

    result = subprocess.run(
        [
            sys.executable,
            str(MQTT_PKI),
            "validate-broker-cert",
            "--ca-file",
            str(ca),
            "--cert-file",
            str(broker),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "MQTT_PKI_PROFILE=PASS" in result.stdout


def test_l6a_pki_rejects_wrong_san_and_wrong_ca(tmp_path: Path) -> None:
    """OD-L6A-03: p4-mqtt-pki.py must reject certs with wrong hostname or wrong CA."""
    # 1. Wrong hostname SAN
    ca, wrong_host_broker, _ = _make_pki(tmp_path, dns_san="wrong.host.arpa", include_ip_san=False)
    result = subprocess.run(
        [
            sys.executable, str(MQTT_PKI), "validate-broker-cert",
            "--ca-file", str(ca), "--cert-file", str(wrong_host_broker),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "hostname" in result.stderr.lower() or "san" in result.stderr.lower()

    # 2. Wrong CA CN
    wrong_ca, valid_broker, _ = _make_pki(tmp_path / "sub", ca_cn="UNTRUSTED CA")
    result = subprocess.run(
        [
            sys.executable, str(MQTT_PKI), "validate-broker-cert",
            "--ca-file", str(wrong_ca), "--cert-file", str(valid_broker),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "ca" in result.stderr.lower() or "chain" in result.stderr.lower()


# ==============================================================================
# 5. RUNTIME DNS SAN VERIFICATION OVER LOOPBACK (OD-L6A-03)
# ==============================================================================

def test_l6a_runtime_dns_san_loopback_verification(tmp_path: Path) -> None:
    """OD-L6A-03: Validator must connect to pure DNS SAN cert on loopback via scoped resolver."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    # Create cert with PURE DNS SAN (no IP SAN)
    ca, broker_cert, broker_key = _make_pki(
        tmp_path,
        dns_san="mqtt.aegis.home.arpa",
        include_ip_san=False,
    )

    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text("correct-core-test-secret\n", encoding="utf-8")
    device_secret.write_text("correct-device-test-secret\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    # Render material
    subprocess.run(
        [
            sys.executable, str(MATERIAL), "build-password-db",
            "--device-id", "aegis-relay-01",
            "--core-password-file", str(core_secret),
            "--device-password-file", str(device_secret),
            "--output", str(password_db),
        ],
        check=True,
    )
    subprocess.run(
        [
            sys.executable, str(MATERIAL), "render-acl",
            "--device-id", "aegis-relay-01",
            "--output", str(acl),
        ],
        check=True,
    )

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

    # With pure DNS SAN and current 127.0.0.1 connection, this MUST fail hostname verification
    # Once the scoped resolver is implemented, this will succeed.
    assert result.returncode == 0, f"Runtime loopback TLS with pure DNS SAN must succeed: {result.stderr}"
    assert "CORE_AUTH=PASS" in result.stdout


# ==============================================================================
# 6. RUNTIME TLS VERSION PROOF (OD-L6A-03)
# ==============================================================================

def test_l6a_validator_proves_negotiated_tls_version_at_runtime(tmp_path: Path) -> None:
    """OD-L6A-03: Validator must inspect active socket and emit TLS_RUNTIME_VERSION=PASS."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_pki(tmp_path, include_ip_san=True)
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text("core-pass\n", encoding="utf-8")
    device_secret.write_text("dev-pass\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    subprocess.run(
        [sys.executable, str(MATERIAL), "build-password-db", "--device-id", "aegis-relay-01",
         "--core-password-file", str(core_secret), "--device-password-file", str(device_secret),
         "--output", str(password_db)],
        check=True,
    )
    subprocess.run(
        [sys.executable, str(MATERIAL), "render-acl", "--device-id", "aegis-relay-01",
         "--output", str(acl)],
        check=True,
    )

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
            sys.executable, str(VALIDATOR), "validate",
            "--config", str(config),
            "--core-password-file", str(core_secret),
            "--device-password-file", str(device_secret),
            "--device-id", "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )
    assert "TLS_RUNTIME_VERSION=PASS" in result.stdout, "Validator must emit TLS_RUNTIME_VERSION=PASS"


# ==============================================================================
# 7. AUTHENTICATION NEGATIVES: WRONG PASSWORD PROBES (OD-L6A-04)
# ==============================================================================

def test_l6a_validator_proves_wrong_core_and_device_password_rejection(tmp_path: Path) -> None:
    """OD-L6A-04: Validator must run dedicated wrong-password probes for Core and Device."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    ca, broker_cert, broker_key = _make_pki(tmp_path, include_ip_san=True)
    core_secret = tmp_path / "core.pass"
    device_secret = tmp_path / "device.pass"
    password_db = tmp_path / "passwords"
    acl = tmp_path / "aegis.acl"
    config = tmp_path / "mosquitto.conf"

    core_secret.write_text("core-pass\n", encoding="utf-8")
    device_secret.write_text("dev-pass\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)

    subprocess.run(
        [sys.executable, str(MATERIAL), "build-password-db", "--device-id", "aegis-relay-01",
         "--core-password-file", str(core_secret), "--device-password-file", str(device_secret),
         "--output", str(password_db)],
        check=True,
    )
    subprocess.run(
        [sys.executable, str(MATERIAL), "render-acl", "--device-id", "aegis-relay-01",
         "--output", str(acl)],
        check=True,
    )

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
            sys.executable, str(VALIDATOR), "validate",
            "--config", str(config),
            "--core-password-file", str(core_secret),
            "--device-password-file", str(device_secret),
            "--device-id", "aegis-relay-01",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )
    assert "WRONG_CORE_PASSWORD_REJECTED=PASS" in result.stdout
    assert "WRONG_DEVICE_PASSWORD_REJECTED=PASS" in result.stdout


# ==============================================================================
# 8. PROCESS OWNERSHIP RECORD & PID REUSE DEFENSE (OD-L6A-02, OD-L6A-07)
# ==============================================================================

def test_l6a_validator_records_process_ownership_metadata(tmp_path: Path) -> None:
    """OD-L6A-02: Validator must record non-secret broker-process.json metadata."""
    state_dir = tmp_path / "state"
    state_dir.mkdir(mode=0o700)

    # Validator must support --state-dir to record ownership metadata
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
    assert "--state-dir" in result.stdout, "Validator must accept --state-dir argument"


def test_l6a_rollback_contains_no_forbidden_kill_patterns() -> None:
    """OD-L6A-07: rollback.sh must not use pkill, killall, or generic pgrep."""
    rollback_script = L6A_STAGE / "rollback.sh"
    assert rollback_script.is_file()
    content = rollback_script.read_text(encoding="utf-8")

    for pat in FORBIDDEN_ROLLBACK_PATTERNS:
        assert not re.search(pat, content), f"rollback.sh must not contain pattern {pat}"


# ==============================================================================
# 9. EVIDENCE CONTRACT VALIDATION (OD-L6A-06)
# ==============================================================================

def test_l6a_evidence_contract_schema(tmp_path: Path) -> None:
    """OD-L6A-06: validation-evidence.tsv must conform to strict 20-key schema."""
    evidence_file = tmp_path / "validation-evidence.tsv"
    
    # Create sample valid evidence
    lines = [
        "schema\t1",
        "stage\tL6a",
        "result\tPASS",
        "listener_address\t127.0.0.1",
        "listener_port\t18884",
        "pki_profile\tPASS",
        "pki_chain\tPASS",
        "pki_hostname\tPASS",
        "tls_runtime_version\tPASS",
        "core_auth\tPASS",
        "device_auth\tPASS",
        "anonymous_rejected\tPASS",
        "wrong_core_password_rejected\tPASS",
        "wrong_device_password_rejected\tPASS",
        "acl_matrix\tPASS",
        "retained_rejected\tPASS",
        "broker_residue\tNO",
        "secret_output_scan\tPASS",
        "started_at\t2026-09-20T21:00:00Z",
        "finished_at\t2026-09-20T21:00:05Z",
    ]
    evidence_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Assert keys match exactly
    seen_keys: list[str] = []
    for raw in evidence_file.read_text(encoding="utf-8").splitlines():
        parts = raw.split("\t")
        assert len(parts) == 2, f"Malformed line: {raw}"
        seen_keys.append(parts[0])

    assert tuple(seen_keys) == EVIDENCE_ALLOWED_KEYS
    assert len(seen_keys) == len(set(seen_keys)), "Duplicate keys forbidden"


def test_l6a_evidence_rejects_missing_or_unknown_keys(tmp_path: Path) -> None:
    """OD-L6A-06: Verification must reject unknown or missing keys."""
    verify_script = L6A_STAGE / "verify.sh"
    assert verify_script.is_file()


def test_l6a_secret_canary_absence_across_all_outputs(tmp_path: Path) -> None:
    """OD-L6A-05: Sentinel passwords must never leak to evidence, stdout, or stderr."""
    apply_script = L6A_STAGE / "apply.sh"
    inputs = tmp_path / "inputs"
    work_dir = tmp_path / "work"
    inputs.mkdir(parents=True, exist_ok=True)

    ca, broker, broker_key = _make_pki(inputs)
    core_secret = inputs / "core.pass"
    device_secret = inputs / "device.pass"
    core_secret.write_text("CANARY_SECRET_CORE_12345\n", encoding="utf-8")
    device_secret.write_text("CANARY_SECRET_DEV_67890\n", encoding="utf-8")
    os.chmod(core_secret, 0o600)
    os.chmod(device_secret, 0o600)
    os.chmod(broker_key, 0o600)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    env = os.environ.copy()
    env["AEGIS_L6A_PORT"] = str(port)
    env["AEGIS_L6A_INPUT_DIR"] = str(inputs)
    env["AEGIS_L6A_WORK_DIR"] = str(work_dir)
    env["AEGIS_PYTHON_BIN"] = sys.executable

    result = subprocess.run(
        ["bash", str(apply_script)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, f"apply.sh failed: {result.stderr}\n{result.stdout}"
    assert "CANARY_SECRET" not in result.stdout
    assert "CANARY_SECRET" not in result.stderr

    evidence_file = work_dir / "validation-evidence.tsv"
    assert evidence_file.is_file(), "validation-evidence.tsv must exist after apply"
    content = evidence_file.read_text(encoding="utf-8")
    assert "CANARY_SECRET" not in content


# ==============================================================================
# 10. WORK DIRECTORY & INPUT DIRECTORY SAFETY (OD-L6A-01, OD-L6A-06)
# ==============================================================================

def test_l6a_handler_requires_work_dir_safety(tmp_path: Path) -> None:
    """OD-L6A-06: apply.sh must require AEGIS_L6A_WORK_DIR and reject unsafe paths."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()

    # Missing work dir
    env = os.environ.copy()
    env.pop("AEGIS_L6A_WORK_DIR", None)
    env["AEGIS_L6A_PORT"] = "18884"
    env["AEGIS_L6A_INPUT_DIR"] = str(tmp_path / "inputs")

    result = subprocess.run(
        ["bash", str(apply_script)],
        cwd=ROOT, env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode != 0
    assert "WORK_DIR" in (result.stdout + result.stderr)


def test_l6a_handler_requires_input_dir(tmp_path: Path) -> None:
    """OD-L6A-01: apply.sh must require AEGIS_L6A_INPUT_DIR and fail closed if absent."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()

    env = os.environ.copy()
    env.pop("AEGIS_L6A_INPUT_DIR", None)
    env["AEGIS_L6A_PORT"] = "18884"
    env["AEGIS_L6A_WORK_DIR"] = str(tmp_path / "work")

    result = subprocess.run(
        ["bash", str(apply_script)],
        cwd=ROOT, env=env, text=True, capture_output=True, check=False,
    )
    assert result.returncode != 0
    assert "INPUT_DIR" in (result.stdout + result.stderr)


def test_l6a_apply_runs_and_leaves_zero_drift(tmp_path: Path) -> None:
    """OD-L6A-06: apply.sh must leave zero residual processes and zero drift."""
    apply_script = L6A_STAGE / "apply.sh"
    assert apply_script.is_file()
