from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy/pr11-phase4/p4-mqtt-pki.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("p4_mqtt_pki", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _openssl(*args: str) -> None:
    result = subprocess.run(
        ["openssl", *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def _make_ca(tmp_path: Path, name: str = "AEGIS IDEA3 MQTT CA") -> tuple[Path, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    key = tmp_path / f"{name.replace(' ', '-')}.key"
    cert = tmp_path / f"{name.replace(' ', '-')}.crt"
    _openssl("genrsa", "-out", str(key), "2048")
    _openssl(
        "req", "-x509", "-new", "-key", str(key), "-sha256", "-days", "2",
        "-subj", f"/CN={name}", "-addext", "basicConstraints=critical,CA:TRUE",
        "-out", str(cert),
    )
    return key, cert


def _make_leaf(tmp_path: Path, ca_key: Path, ca_cert: Path, hostname: str) -> Path:
    leaf_key = tmp_path / f"leaf-{hostname}.key"
    csr = tmp_path / f"leaf-{hostname}.csr"
    cert = tmp_path / f"leaf-{hostname}.crt"
    ext = tmp_path / f"leaf-{hostname}.ext"
    ext.write_text(
        "\n".join(
            [
                f"subjectAltName=DNS:{hostname}",
                "basicConstraints=critical,CA:FALSE",
                "keyUsage=critical,digitalSignature,keyEncipherment",
                "extendedKeyUsage=serverAuth",
                "",
            ]
        ),
        encoding="utf-8",
    )
    _openssl("genrsa", "-out", str(leaf_key), "2048")
    _openssl("req", "-new", "-key", str(leaf_key), "-subj", f"/CN={hostname}", "-out", str(csr))
    _openssl(
        "x509", "-req", "-in", str(csr), "-CA", str(ca_cert), "-CAkey", str(ca_key),
        "-CAcreateserial", "-out", str(cert), "-days", "1", "-sha256", "-extfile", str(ext),
    )
    return cert


def test_tool_exists_for_t3_profile() -> None:
    assert TOOL.is_file(), "T3 MQTT PKI tool is missing"


def test_profile_constants_and_exact_dns_san(tmp_path: Path) -> None:
    module = _load_tool()
    assert module.BROKER_HOSTNAME == "mqtt.aegis.home.arpa"
    assert module.CA_COMMON_NAME == "AEGIS IDEA3 MQTT CA"
    assert module.CA_VALIDITY_DAYS == 1825

    output = tmp_path / "broker.ext"
    result = _run("render-broker-ext", "--output", str(output))
    assert result.returncode == 0, result.stderr
    text = output.read_text(encoding="utf-8")
    assert "subjectAltName=DNS:mqtt.aegis.home.arpa" in text
    assert "IP:" not in text
    assert "basicConstraints=critical,CA:FALSE" in text
    assert "extendedKeyUsage=serverAuth" in text


def test_renderer_refuses_overwrite(tmp_path: Path) -> None:
    output = tmp_path / "broker.ext"
    output.write_text("sentinel\n", encoding="utf-8")
    result = _run("render-broker-ext", "--output", str(output))
    assert result.returncode != 0
    assert output.read_text(encoding="utf-8") == "sentinel\n"


def test_validate_accepts_exact_hostname_chain_and_profile(tmp_path: Path) -> None:
    ca_key, ca_cert = _make_ca(tmp_path)
    leaf = _make_leaf(tmp_path, ca_key, ca_cert, "mqtt.aegis.home.arpa")
    result = _run("validate-broker-cert", "--ca-file", str(ca_cert), "--cert-file", str(leaf))
    assert result.returncode == 0, result.stderr
    assert "MQTT_PKI_CHAIN=PASS" in result.stdout
    assert "MQTT_PKI_HOSTNAME=PASS" in result.stdout
    assert "MQTT_PKI_PROFILE=PASS" in result.stdout


def test_validate_rejects_wrong_dns_san(tmp_path: Path) -> None:
    ca_key, ca_cert = _make_ca(tmp_path)
    leaf = _make_leaf(tmp_path, ca_key, ca_cert, "wrong.aegis.home.arpa")
    result = _run("validate-broker-cert", "--ca-file", str(ca_cert), "--cert-file", str(leaf))
    assert result.returncode != 0
    assert "MQTT_PKI_PROFILE=PASS" not in result.stdout


def test_validate_rejects_broken_chain(tmp_path: Path) -> None:
    ca_key, ca_cert = _make_ca(tmp_path)
    leaf = _make_leaf(tmp_path, ca_key, ca_cert, "mqtt.aegis.home.arpa")
    _, other_ca = _make_ca(tmp_path / "other")
    result = _run("validate-broker-cert", "--ca-file", str(other_ca), "--cert-file", str(leaf))
    assert result.returncode != 0
    assert "MQTT_PKI_PROFILE=PASS" not in result.stdout
