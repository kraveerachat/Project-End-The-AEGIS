"""Offline certificate-contract tests; no DNS, Docker, or network access."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import stat
from types import SimpleNamespace

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "deploy/idea2/h1-runtime"
sys.path.insert(0, str(RUNTIME))
HOST = "idea2-h1.aegis-lab.internal"


def certificate_set(host=HOST, *, expired=False):
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Disposable H1 CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - timedelta(days=3)).not_valid_after(now + timedelta(days=30))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True)
          .sign(ca_key, hashes.SHA256()))
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    leaf = (x509.CertificateBuilder().subject_name(leaf_name).issuer_name(ca_name)
            .public_key(leaf_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=10) if expired else now - timedelta(days=1))
            .not_valid_after(now - timedelta(days=1) if expired else now + timedelta(days=10))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    return (
        ca.public_bytes(serialization.Encoding.PEM),
        leaf.public_bytes(serialization.Encoding.PEM),
        leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
    )


class N2OfflineTlsTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((RUNTIME / "validate_n2_n3.py").is_file(), "missing offline N2/N3 validator")
        from validate_n2_n3 import inspect_tls
        self.inspect_tls = inspect_tls

    def test_exact_host_ca_chain_and_key_match_are_accepted_without_key_output(self):
        result = self.inspect_tls(*certificate_set(), HOST)
        self.assertEqual(result["san"], [HOST])
        self.assertIn("ca_sha256", result)
        self.assertIn("leaf_sha256", result)
        self.assertNotIn("PRIVATE KEY", repr(result))

    def test_public_ca_bundle_rejects_private_key_material(self):
        ca, leaf, key = certificate_set()
        with self.assertRaises(ValueError):
            self.inspect_tls(ca + key, leaf, key, HOST)

    def test_wrong_hostname_rejected(self):
        with self.assertRaises(ValueError):
            self.inspect_tls(*certificate_set("wrong.aegis-lab.internal"), HOST)

    def test_wrong_ca_rejected(self):
        _, leaf, key = certificate_set()
        other_ca, _, _ = certificate_set()
        with self.assertRaises(ValueError):
            self.inspect_tls(other_ca, leaf, key, HOST)

    def test_expired_leaf_rejected(self):
        with self.assertRaises(ValueError):
            self.inspect_tls(*certificate_set(expired=True), HOST)

    def test_absent_ca_bundle_and_mismatched_key_rejected(self):
        ca, leaf, _ = certificate_set()
        wrong_key = certificate_set()[2]
        for supplied_ca, supplied_key in [(b"", wrong_key), (ca, wrong_key)]:
            with self.subTest(has_ca=bool(supplied_ca)), self.assertRaises(ValueError):
                self.inspect_tls(supplied_ca, leaf, supplied_key, HOST)


class N3GatewayConfigTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((RUNTIME / "validate_n2_n3.py").is_file(), "missing offline N2/N3 validator")
        from validate_n2_n3 import check_gateway
        self.check_gateway = check_gateway
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.cert = Path(temp.name) / "candidate.crt"
        self.key = Path(temp.name) / "candidate.key"
        self.cert.write_text("fixture", encoding="ascii")
        self.key.write_text("fixture", encoding="ascii")
        if sys.platform != "win32":
            self.key.chmod(0o600)

    def fixture(self):
        return {
            "profiles": ["n3"], "image": "aegis-h1-lab-gateway:" + "a" * 40,
            "restart": "no", "networks": ["lab_ingress"],
            "ports": [{"host_ip": "192.168.10.10", "published": "18443", "target": 443, "protocol": "tcp"}],
            "volumes": [
                {"type": "bind", "source": str(self.cert), "target": "/run/aegis-h1-tls/tls.crt", "read_only": True},
                {"type": "bind", "source": str(self.key), "target": "/run/aegis-h1-tls/tls.key", "read_only": True},
            ],
            "build": {"context": str(ROOT / "deploy/idea2/h1-gateway"), "dockerfile": "Dockerfile", "args": {"NGINX_BASE_IMAGE": "nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506"}},
            "mem_limit": 268435456,
            "security_opt": ["no-new-privileges:true"],
            "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "2"}},
            "depends_on": {"monitor": {"condition": "service_healthy"}},
        }

    def check(self, gateway):
        self.check_gateway(gateway, "a" * 40, self.cert, self.key)

    def test_exact_bind_tls_mounts_lab_network_and_source_image(self):
        self.check(self.fixture())

    def test_wildcard_wrong_tuple_and_extra_port_fail_closed(self):
        for mutation in [
            lambda g: g["ports"][0].update(host_ip="0.0.0.0"),
            lambda g: g["ports"][0].update(host_ip="::"),
            lambda g: g["ports"][0].update(published="443"),
            lambda g: g["ports"].append({"host_ip": "192.168.10.10", "published": "18078", "target": 80}),
        ]:
            gateway = self.fixture()
            mutation(gateway)
            with self.assertRaises(ValueError):
                self.check(gateway)

    def test_writable_or_unexpected_tls_mount_fails_closed(self):
        for mutation in [
            lambda g: g["volumes"][0].update(read_only=False),
            lambda g: g["volumes"][1].update(target="/etc/nginx/private.key"),
            lambda g: g["volumes"].append({"type": "volume", "source": "prod", "target": "/extra"}),
        ]:
            gateway = self.fixture()
            mutation(gateway)
            with self.assertRaises(ValueError):
                self.check(gateway)

    def test_production_network_image_or_n2_profile_fails_closed(self):
        for mutation in [
            lambda g: g.update(networks=["lab_ingress", "aegis-prod_default"]),
            lambda g: g.update(image="aegis-prod-gateway:latest"),
            lambda g: g.update(profiles=["n2"]),
        ]:
            gateway = self.fixture()
            mutation(gateway)
            with self.assertRaises(ValueError):
                self.check(gateway)

    def test_gateway_rejects_project_escape_options(self):
        for name, value in [("volumes_from", ["aegis-prod"]), ("network_mode", "host"), ("pid", "host"), ("ipc", "host"), ("userns_mode", "host"), ("expose", [8002])]:
            gateway = self.fixture()
            gateway[name] = value
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check(gateway)

    def test_gateway_rejects_unreviewed_service_options(self):
        for name, value in [("env_file", ["/tmp/secret.env"]), ("user", "root"), ("dns", ["8.8.8.8"]), ("labels", {"com.aegis.scope": "aegis-prod"})]:
            gateway = self.fixture()
            gateway[name] = value
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check(gateway)

    def test_fixture_json_cannot_be_supplied_as_live_cli_evidence(self):
        result = subprocess.run(
            [sys.executable, str(RUNTIME / "validate_n2_n3.py"), "--help"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("--rendered-json", result.stdout)

    def test_tls_source_through_symlink_parent_fails_closed(self):
        source = self.cert.parent / "linked"
        try:
            source.symlink_to(self.cert.parent, target_is_directory=True)
        except OSError:
            self.skipTest("directory symlink creation unavailable")
        gateway = self.fixture()
        gateway["volumes"][0]["source"] = str(source / self.cert.name)
        with self.assertRaises(ValueError):
            self.check(gateway)

    def test_tls_source_rejects_reparse_parent_even_if_final_file_is_regular(self):
        original = Path.lstat
        parent = self.cert.parent

        def inspect(candidate, *args, **kwargs):
            if candidate == parent:
                return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0, st_size=0)
            return original(candidate, *args, **kwargs)

        with patch.object(Path, "lstat", inspect), self.assertRaises(ValueError):
            self.check(self.fixture())

    def test_posix_tls_metadata_rejects_wrong_owner_and_writable_parent(self):
        from validate_n2_n3 import _check_posix_entry
        owner = 1000
        for mode, uid, private in [
            (stat.S_IFDIR | 0o777, owner, False),
            (stat.S_IFDIR | 0o775, owner, False),
            (stat.S_IFDIR | 0o1777, owner, False),
            (stat.S_IFDIR | 0o777, 0, False),
            (stat.S_IFREG | 0o600, owner + 1, True),
            (stat.S_IFREG | 0o644, owner, True),
        ]:
            with self.subTest(mode=oct(mode), uid=uid, private=private), self.assertRaises(ValueError):
                _check_posix_entry(SimpleNamespace(st_mode=mode, st_uid=uid), owner, private=private)
        _check_posix_entry(SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0), owner)
        _check_posix_entry(SimpleNamespace(st_mode=stat.S_IFDIR | 0o1777, st_uid=0), owner)
        _check_posix_entry(SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=owner), owner, private=True)

    def test_rendered_n3_checks_n1_services_without_allowing_new_postgres_ports(self):
        from validate_n2_n3 import check_rendered
        pg_image = "postgres:15-alpine@sha256:25d430274d8a31184f9435cc5b2f56aff254952065bbbcac0c51acedb5a1d1e7"
        base = {"mem_limit": 1073741824, "security_opt": ["no-new-privileges:true"], "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "2"}}}
        rendered = {
            "name": "aegis-h1-lab",
            "networks": {name: {"name": "aegis-h1-lab_" + name, "internal": True} for name in ["lab_backend", "lab_ingress"]},
            "volumes": {"postgres_data": {"name": "aegis-h1-lab_postgres_data"}},
            "services": {
                "postgres": {**base, "restart": "unless-stopped", "image": pg_image, "environment": {"POSTGRES_DB": "aegis_h1_lab", "POSTGRES_USER": "postgres_h1_admin", "POSTGRES_PASSWORD": "fixture-admin", "H1_APP_PASSWORD": "fixture-app"}, "networks": ["lab_backend"], "healthcheck": {"test": ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres_h1_admin -d aegis_h1_lab"]}, "volumes": [{"type": "volume", "source": "postgres_data", "target": "/var/lib/postgresql/data"}, {"type": "bind", "source": str(RUNTIME / "init-role.sh"), "target": "/docker-entrypoint-initdb.d/10-h1-role.sh", "read_only": True}]},
                "migrate": {**base, "restart": "no", "image": pg_image, "entrypoint": ["/bin/sh", "/aegis-h1/migrate.sh"], "environment": {"PGPASSWORD": "fixture-admin"}, "networks": ["lab_backend"], "depends_on": {"postgres": {"condition": "service_healthy"}}, "volumes": [{"type": "bind", "source": str(source), "target": target, "read_only": True} for source, target in [(RUNTIME / "migrate.sh", "/aegis-h1/migrate.sh"), (ROOT / "IDEA2-AEGIS_Monitor/server/db/schema.sql", "/aegis-h1/schema.sql"), (ROOT / "IDEA2-AEGIS_Monitor/server/db/migrations", "/aegis-h1/migrations")]]},
                "monitor": {**base, "restart": "unless-stopped", "image": "aegis-h1-lab-monitor:" + "b" * 40, "build": {"context": str(ROOT / "IDEA2-AEGIS_Monitor"), "dockerfile": "Dockerfile", "args": {"NODE_BASE_IMAGE": "node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb"}}, "networks": ["lab_ingress", "lab_backend"], "depends_on": {"migrate": {"condition": "service_completed_successfully"}}, "environment": {"NODE_ENV": "production", "PORT": "8002", "AGENT_AUTH_REQUIRED": "true", "AGENT_AUTH_AUDIENCE": "https://idea2-h1.aegis-lab.internal:18443", "SESSION_SECRET": "fixture-session", "DATABASE_URL": "postgresql://monitor_h1_app:fixture-app@postgres:5432/aegis_h1_lab"}, "healthcheck": {"test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]}},
                "gateway": {**self.fixture(), "depends_on": {"monitor": {"condition": "service_healthy"}}},
            },
        }
        check_rendered(rendered, "b" * 40, "a" * 40, self.cert, self.key)
        rendered["services"]["gateway"]["depends_on"]["postgres"] = {"condition": "service_healthy"}
        with self.assertRaises(ValueError):
            check_rendered(rendered, "b" * 40, "a" * 40, self.cert, self.key)
        del rendered["services"]["gateway"]["depends_on"]["postgres"]
        rendered["services"]["postgres"]["ports"] = [{"host_ip": "192.168.10.10", "published": "5432", "target": 5432}]
        with self.assertRaises(ValueError):
            check_rendered(rendered, "b" * 40, "a" * 40, self.cert, self.key)


if __name__ == "__main__":
    unittest.main()
