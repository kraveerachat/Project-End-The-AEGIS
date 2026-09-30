"""Offline N2 certificate and read-only N3 Compose validation.

Never print a rendered Compose document, PEM material, credentials, or private
key bytes. A PASS from this helper is not live DNS, browser, or Agent evidence.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import subprocess

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.verification import DNSName, PolicyBuilder, Store, VerificationError

from docker_exec import docker_command
from validate import COMPOSE, PROJECT, ROOT, check as check_n1, check_reviewed_checkout, ensure_unprivileged_python, require


OVERLAY = COMPOSE.with_name("compose.n3.yml")
HOSTNAME = "idea2-h1.aegis-lab.internal"
BIND_IPV4 = "192.168.10.10"
HTTPS_PORT = "18443"
GATEWAY_IMAGE = "aegis-h1-lab-gateway:"
GATEWAY_BASE = "nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506"
CERT_TARGET = "/run/aegis-h1-tls/tls.crt"
KEY_TARGET = "/run/aegis-h1-tls/tls.key"
PEM_CERT = re.compile(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.DOTALL)
PRIVATE_PEM = re.compile(rb"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")


def _certificates(material):
    require(bool(material) and len(material) <= 1024 * 1024, "invalid certificate material")
    require(not PRIVATE_PEM.search(material), "private key in public certificate material")
    blocks = PEM_CERT.findall(material)
    require(bool(blocks) and not PEM_CERT.sub(b"", material).strip(), "certificate material is not public PEM only")
    try:
        return [x509.load_pem_x509_certificate(block) for block in blocks]
    except ValueError as exc:
        raise ValueError("malformed certificate") from exc


def _window(certificate, now):
    start = getattr(certificate, "not_valid_before_utc", None)
    end = getattr(certificate, "not_valid_after_utc", None)
    if start is None:
        start = certificate.not_valid_before.replace(tzinfo=timezone.utc)
        end = certificate.not_valid_after.replace(tzinfo=timezone.utc)
    require(start <= now < end, "certificate is not currently valid")
    return start, end


def inspect_tls(ca_material, leaf_material, key_material, hostname=HOSTNAME):
    """Return public certificate evidence after verifying the offline chain."""
    require(hostname == HOSTNAME, "candidate hostname drift")
    cas = _certificates(ca_material)
    chain = _certificates(leaf_material)
    require(bool(key_material) and len(key_material) <= 1024 * 1024, "invalid leaf private key")
    now = datetime.now(timezone.utc)
    try:
        for ca in cas:
            require(ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca, "non-CA in public bundle")
            _window(ca, now)
        leaf = chain[0]
        require(not leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca, "CA used as leaf")
        start, end = _window(leaf, now)
        san = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        dns_names = san.get_values_for_type(x509.DNSName)
        require(dns_names == [HOSTNAME] and len(san) == 1, "leaf SAN must be the exact candidate hostname only")
        for intermediate in chain[1:]:
            require(intermediate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca, "non-CA intermediate")
            _window(intermediate, now)
        key = serialization.load_pem_private_key(key_material, password=None)
        require(
            leaf.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
            == key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo),
            "leaf certificate/private key mismatch",
        )
        verifier = PolicyBuilder().store(Store(cas)).time(now).build_server_verifier(DNSName(HOSTNAME))
        verifier.verify(leaf, chain[1:])
    except (ValueError, TypeError, x509.ExtensionNotFound, VerificationError) as exc:
        raise ValueError("candidate TLS validation failed") from exc
    return {
        "ca_sha256": [certificate.fingerprint(hashes.SHA256()).hex() for certificate in cas],
        "leaf_sha256": leaf.fingerprint(hashes.SHA256()).hex(),
        "san": dns_names,
        "issuer": leaf.issuer.rfc4514_string(),
        "subject": leaf.subject.rfc4514_string(),
        "not_before_utc": start.isoformat(),
        "not_after_utc": end.isoformat(),
        "chain_certificates": len(chain),
    }


def _check_posix_entry(metadata, owner_uid, *, private=False):
    require(metadata.st_uid == owner_uid if private else metadata.st_uid in (0, owner_uid), "untrusted candidate TLS path owner")
    mode = stat.S_IMODE(metadata.st_mode)
    # A root-owned sticky /tmp-style ancestor cannot be renamed by another
    # user; the private test directory beneath it is still owner-only.
    sticky_root_directory = stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0 and bool(mode & stat.S_ISVTX)
    require(mode & 0o022 == 0 or sticky_root_directory, "replaceable candidate TLS path")
    if private:
        require(mode & 0o077 == 0, "candidate private key must be owner-only")


def _safe_file(path, *, private=False):
    require(path.is_absolute() and not path.is_relative_to(ROOT), "candidate TLS path must be absolute and outside Git")
    require("aegis-prod" not in str(path).lower() and "aegis.internal" not in str(path).lower(), "Production TLS path forbidden")
    current = path
    while True:
        entry = current.lstat()
        require(not stat.S_ISLNK(entry.st_mode) and not getattr(entry, "st_file_attributes", 0) & 0x400, "candidate TLS path contains a link/reparse point")
        if os.name == "posix":
            _check_posix_entry(entry, os.getuid(), private=private and current == path)
        if current.parent == current:
            break
        require(current == path or stat.S_ISDIR(entry.st_mode), "candidate TLS parent must be a directory")
        current = current.parent
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode), "candidate TLS input must be a regular file")
    require(0 < metadata.st_size <= 1024 * 1024, "candidate TLS input size invalid")
    resolved = path.resolve(strict=True)
    require(not resolved.is_relative_to(ROOT), "candidate TLS path resolves inside Git")
    return resolved


def check_gateway(gateway, gateway_sha, cert_path, key_path):
    """Reject any N3 gateway rendering outside the exact candidate boundary."""
    require(re.fullmatch(r"[0-9a-f]{40}", gateway_sha) is not None, "invalid gateway source SHA")
    require(set(gateway) - {"command", "entrypoint"} == {
        "profiles", "image", "restart", "networks", "ports", "volumes",
        "build", "mem_limit", "security_opt", "logging", "depends_on",
    }, "unreviewed gateway service option")
    require(gateway.get("command") is None, "gateway command must be inert")
    require(gateway.get("entrypoint") is None, "gateway entrypoint must be inert")
    require(gateway.get("profiles") == ["n3"], "gateway must not start at N1 or N2")
    require(gateway.get("image") == GATEWAY_IMAGE + gateway_sha, "unreviewed gateway source image")
    require(gateway.get("restart") == "no", "gateway restart policy drift")
    require(gateway.get("networks") in (["lab_ingress"], {"lab_ingress": None}, {"lab_ingress": {}}), "gateway network drift")
    require(gateway.get("ports") == [{"host_ip": BIND_IPV4, "published": HTTPS_PORT, "target": 443, "protocol": "tcp"}], "gateway must bind only exact candidate IPv4:18443")
    require(str(gateway.get("mem_limit")) == "268435456", "gateway memory ceiling drift")
    require(gateway.get("security_opt") == ["no-new-privileges:true"], "gateway security option drift")
    require(gateway.get("logging") == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "2"}}, "gateway log cap drift")
    require(gateway.get("depends_on") == {"monitor": {"condition": "service_healthy"}}, "gateway must depend only on healthy lab Monitor")
    build = gateway.get("build", {})
    require(set(build) == {"context", "dockerfile", "args"}, "gateway build option drift")
    require(Path(build.get("context", "")).resolve() == ROOT / "deploy/idea2/h1-gateway", "gateway source context drift")
    require(build.get("dockerfile") == "Dockerfile" and build.get("args") == {"NGINX_BASE_IMAGE": GATEWAY_BASE}, "gateway Dockerfile/base digest drift")
    mounts = gateway.get("volumes", [])
    require(len(mounts) == 2, "gateway TLS mount count drift")
    expected = {CERT_TARGET: _safe_file(Path(cert_path)), KEY_TARGET: _safe_file(Path(key_path), private=True)}
    for mount in mounts:
        target = mount.get("target")
        require(target in expected and mount.get("type") == "bind" and mount.get("read_only") is True, "gateway TLS mount must be exact and read-only")
        require(_safe_file(Path(mount.get("source", "")), private=target == KEY_TARGET) == expected[target], "gateway TLS source drift")
    require({mount["target"] for mount in mounts} == set(expected), "gateway TLS target drift")


def check_rendered(rendered, monitor_sha, gateway_sha, cert_path, key_path):
    require(set(rendered.get("services", {})) == {"postgres", "migrate", "monitor", "gateway"}, "N3 service set drift")
    base = dict(rendered)
    base["services"] = {name: service for name, service in rendered["services"].items() if name != "gateway"}
    check_n1(base, monitor_sha)
    check_gateway(rendered["services"]["gateway"], gateway_sha, cert_path, key_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-ca", type=Path, required=True)
    parser.add_argument("--leaf-cert", type=Path, required=True)
    parser.add_argument("--leaf-key", type=Path, required=True)
    parser.add_argument("--monitor-source-sha")
    parser.add_argument("--gateway-source-sha")
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    try:
        ca_path = _safe_file(args.public_ca)
        cert_path = _safe_file(args.leaf_cert)
        key_path = _safe_file(args.leaf_key, private=True)
        evidence = inspect_tls(ca_path.read_bytes(), cert_path.read_bytes(), key_path.read_bytes())
        if args.monitor_source_sha or args.gateway_source_sha or args.env_file:
            require(args.monitor_source_sha and args.gateway_source_sha and args.env_file, "both source SHAs and the owner env file required for N3")
            ensure_unprivileged_python()
            check_reviewed_checkout(args.gateway_source_sha)
            env_path = _safe_file(args.env_file, private=True)
            result = subprocess.run(
                docker_command("compose", "--project-name", PROJECT, "--env-file", str(env_path), "-f", str(COMPOSE), "-f", str(OVERLAY), "--profile", "n3", "config", "--format", "json"),
                capture_output=True, text=True, check=False, timeout=30,
            )
            require(result.returncode == 0, "Compose render failed")
            rendered = json.loads(result.stdout)
            check_rendered(rendered, args.monitor_source_sha, args.gateway_source_sha, cert_path, key_path)
    except (ValueError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ImportError):
        print("H1_N2_N3_VALIDATION=FAIL reason=invalid input or unavailable local dependency")
        return 2
    print("H1_N2_N3_VALIDATION=PASS")
    print(json.dumps(evidence, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
