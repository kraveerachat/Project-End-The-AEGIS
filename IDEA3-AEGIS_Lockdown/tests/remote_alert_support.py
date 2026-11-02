"""Disposable PKI for the remote alert tests: a CA, a broker certificate and client certificates. Nothing here is a real secret."""

from __future__ import annotations

import datetime
import ipaddress
from dataclasses import dataclass
from pathlib import Path

cryptography = __import__("pytest").importorskip("cryptography")

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

NOW = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


@dataclass
class Identity:
    cert: x509.Certificate
    key: object
    cert_path: Path | None = None
    key_path: Path | None = None

    @property
    def der(self) -> bytes:
        return self.cert.public_bytes(serialization.Encoding.DER)

    @property
    def pem(self) -> bytes:
        return self.cert.public_bytes(serialization.Encoding.PEM)


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def make_ca(common_name="AEGIS test CA") -> Identity:
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder().subject_name(_name(common_name)).issuer_name(_name(common_name))
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(NOW - datetime.timedelta(days=1)).not_valid_after(NOW + datetime.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
                                     key_encipherment=False, data_encipherment=False, key_agreement=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .sign(key, hashes.SHA256())
    )
    return Identity(cert, key)


def issue(ca: Identity, common_name: str, *, kind="ec", client_auth=True, server_auth=False, is_ca=False,
          not_before=None, not_after=None, san_dns=()) -> Identity:
    key = {"ec": lambda: ec.generate_private_key(ec.SECP256R1()), "ed25519": ed25519.Ed25519PrivateKey.generate,
           "rsa": lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048)}[kind]()
    builder = (
        x509.CertificateBuilder().subject_name(_name(common_name)).issuer_name(ca.cert.subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(not_before or NOW - datetime.timedelta(days=1)).not_valid_after(not_after or NOW + datetime.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=is_ca, path_length=0 if is_ca else None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca.key.public_key()), critical=False)
    )
    usages = ([ExtendedKeyUsageOID.CLIENT_AUTH] if client_auth else []) + ([ExtendedKeyUsageOID.SERVER_AUTH] if server_auth else [])
    if usages:
        builder = builder.add_extension(x509.ExtendedKeyUsage(usages), critical=False)
    if san_dns:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in san_dns] + [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            critical=False,
        )
    return Identity(builder.sign(ca.key, hashes.SHA256()), key)


def write(identity: Identity, directory: Path, name: str) -> Identity:
    directory.mkdir(parents=True, exist_ok=True)
    identity.cert_path = directory / f"{name}.crt"
    identity.key_path = directory / f"{name}.key"
    identity.cert_path.write_bytes(identity.pem)
    identity.key_path.write_bytes(identity.key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    identity.key_path.chmod(0o600)
    return identity
