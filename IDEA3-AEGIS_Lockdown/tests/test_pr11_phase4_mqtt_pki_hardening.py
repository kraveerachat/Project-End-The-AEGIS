"""p4-mqtt-pki.py must also police weak algorithms, over-long lifetimes and key/cert mismatch."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy/pr11-phase4/p4-mqtt-pki.py"
HOST = "mqtt.aegis.home.arpa"


def ossl(*args: object) -> None:
    r = subprocess.run(["openssl", *map(str, args)], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    assert r.returncode == 0, r.stderr


def tool(*args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(TOOL), *map(str, args)], capture_output=True, text=True, stdin=subprocess.DEVNULL)


@pytest.fixture()
def ca(tmp_path: Path):
    key, crt = tmp_path / "ca.key", tmp_path / "ca.crt"
    ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", crt,
         "-days", "3650", "-subj", "/CN=AEGIS IDEA3 MQTT CA", "-addext", "basicConstraints=critical,CA:TRUE")
    return key, crt


def leaf(tmp_path: Path, ca, *, newkey=("ec", "-pkeyopt", "ec_paramgen_curve:P-256"), digest="sha256", days="365", name="leaf"):
    ca_key, ca_crt = ca
    key, csr, crt, ext = (tmp_path / f"{name}.{x}" for x in ("key", "csr", "crt", "ext"))
    ossl("req", "-newkey", *newkey, "-nodes", "-keyout", key, "-out", csr, "-subj", f"/CN={HOST}")
    ext.write_text(f"subjectAltName=DNS:{HOST}\nbasicConstraints=critical,CA:FALSE\n"
                   "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    ossl("x509", "-req", "-in", csr, "-CA", ca_crt, "-CAkey", ca_key, "-CAcreateserial", "-out", crt, "-extfile", ext,
         f"-{digest}", "-days", days)
    return key, crt


def validate(ca, crt, *extra):
    return tool("validate-broker-cert", "--ca-file", ca[1], "--cert-file", crt, *extra)


def test_ec_p256_sha256_short_lifetime_accepted(tmp_path, ca):
    _, crt = leaf(tmp_path, ca)
    r = validate(ca, crt)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("newkey", [("ec", "-pkeyopt", "ec_paramgen_curve:P-384"), ("rsa:3072",), ("rsa:2048",)])
def test_approved_key_algorithms_accepted(tmp_path, ca, newkey):
    _, crt = leaf(tmp_path, ca, newkey=newkey)
    assert validate(ca, crt).returncode == 0


@pytest.mark.parametrize("newkey", [("rsa:1024",), ("rsa:1536",), ("ec", "-pkeyopt", "ec_paramgen_curve:secp192r1")])
def test_weak_key_rejected(tmp_path, ca, newkey):
    try:
        _, crt = leaf(tmp_path, ca, newkey=newkey)
    except AssertionError:
        pytest.skip("openssl build refuses to create this weak key")
    r = validate(ca, crt)
    assert r.returncode != 0 and "weak" in r.stderr.lower()


@pytest.mark.parametrize("digest", ["sha1", "md5"])
def test_weak_signature_digest_rejected(tmp_path, ca, digest):
    try:
        _, crt = leaf(tmp_path, ca, digest=digest)
    except AssertionError:
        pytest.skip("openssl build refuses to sign with this digest")
    r = validate(ca, crt)
    assert r.returncode != 0 and "signature" in r.stderr.lower()


def test_overlong_leaf_lifetime_rejected(tmp_path, ca):
    _, crt = leaf(tmp_path, ca, days="36500")
    r = validate(ca, crt)
    assert r.returncode != 0 and "lifetime" in r.stderr.lower()


def test_key_file_match_checked_when_supplied(tmp_path, ca):
    key, crt = leaf(tmp_path, ca)
    other_key, _ = leaf(tmp_path, ca, name="other")
    assert validate(ca, crt, "--key-file", key).returncode == 0
    r = validate(ca, crt, "--key-file", other_key)
    assert r.returncode != 0 and "key" in r.stderr.lower() and "match" in r.stderr.lower()


def test_corrupt_key_file_rejected(tmp_path, ca):
    _, crt = leaf(tmp_path, ca)
    bad = tmp_path / "bad.key"
    bad.write_text("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")
    assert validate(ca, crt, "--key-file", bad).returncode != 0


def test_key_file_must_be_private_mode(tmp_path, ca):
    key, crt = leaf(tmp_path, ca)
    key.chmod(0o644)
    r = validate(ca, crt, "--key-file", key)
    assert r.returncode != 0 and "mode" in r.stderr.lower()
    key.chmod(0o600)
    assert validate(ca, crt, "--key-file", key).returncode == 0


def test_key_file_symlink_rejected(tmp_path, ca):
    key, crt = leaf(tmp_path, ca)
    link = tmp_path / "link.key"
    link.symlink_to(key)
    assert validate(ca, crt, "--key-file", link).returncode != 0
