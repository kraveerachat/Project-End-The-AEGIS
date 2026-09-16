"""PR11 K10 server-held dedicated machine-client CA — helper and contract tests.

Every CA, key, CSR, certificate and CRL here is a TEST-ONLY fixture generated in
a pytest temporary directory. Nothing touches /opt/aegis or /etc, and nothing
here is K10 evidence: it proves the helper's refusals and the certificate
profile it produces, not any live issuance.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

LOCKDOWN = Path(__file__).resolve().parents[1]
REPO = LOCKDOWN.parent
DEPLOY = LOCKDOWN / "deploy" / "pr11-phase2"
SERVER_CA = DEPLOY / "p2-k10-server-ca.sh"
CLIENT_PKI = DEPLOY / "p2-k10-client-pki.sh"
MACHINE_NGINX = REPO / "HUB-AEGIS_Entry" / "nginx.idea3-machine-phase2b.conf"
AMENDMENT = (
    LOCKDOWN / "docs" / "superpowers" / "specs"
    / "2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md"
)
PASSPHRASE = "test-only-fixture-passphrase"

pytestmark = pytest.mark.skipif(
    shutil.which("openssl") is None or shutil.which("bash") is None,
    reason="openssl and bash are required",
)


def openssl(*args: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["openssl", *args], capture_output=True, text=True, **kwargs)


class Fixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.pki = root / "pki"
        self.hub = root / "runtime" / "certs"
        self.hub.mkdir(parents=True)
        self.passfile = root / "pass"
        self.passfile.write_text(PASSPHRASE + "\n")
        self.outputs: list[str] = []

    @property
    def ca_key(self) -> Path:
        return self.pki / "private" / "idea3-machine-client-ca.key"

    @property
    def ca_crt(self) -> Path:
        return self.pki / "certs" / "idea3-machine-client-ca.crt"

    @property
    def ca_crl(self) -> Path:
        return self.pki / "crl" / "idea3-machine-client-ca.crl"

    def run(self, mode: str | None, *, authorize: bool = False, test_mode: bool = True, **extra: str):
        env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "LC_ALL": "C"}
        if test_mode:
            env.update(
                AEGIS_K10_TEST_MODE="1",
                AEGIS_K10_PKI_ROOT=str(self.pki),
                AEGIS_K10_HUB_CERTS=str(self.hub),
                AEGIS_K10_TEST_PASSFILE=str(self.passfile),
            )
        if mode is not None:
            env["MODE"] = mode
        if authorize:
            env["AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION"] = "YES"
        env.update(extra)
        result = subprocess.run(
            ["bash", str(SERVER_CA)], capture_output=True, text=True, env=env,
            stdin=subprocess.DEVNULL, timeout=60,
        )
        self.outputs.append(result.stdout + result.stderr)
        return result

    def init(self):
        result = self.run("init", authorize=True)
        assert result.returncode == 0, result.stdout + result.stderr
        return result

    def csr(self, subject: str = "/CN=idea3-core", curve: str = "P-256") -> Path:
        core = self.root / "core"
        core.mkdir(exist_ok=True)
        name = hashlib.sha256(subject.encode()).hexdigest()[:8]
        key, csr = core / f"{name}.key", core / f"{name}.csr"
        made = openssl("req", "-new", "-newkey", "ec", "-pkeyopt", f"ec_paramgen_curve:{curve}",
                       "-nodes", "-keyout", str(key), "-out", str(csr), "-subj", subject)
        assert made.returncode == 0, made.stderr
        return csr

    def sign(self, csr: Path, **extra: str):
        digest = hashlib.sha256(csr.read_bytes()).hexdigest()
        return self.run("sign", authorize=True, CSR=str(csr), CSR_SHA256=extra.pop("CSR_SHA256", digest), **extra)

    def issued(self) -> Path:
        certs = sorted((self.pki / "issued").glob("idea3-core-client-*.crt"))
        assert len(certs) == 1
        return certs[0]


@pytest.fixture
def fx(tmp_path: Path) -> Fixture:
    fixture = Fixture(tmp_path)
    yield fixture
    for output in fixture.outputs:
        assert "PRIVATE KEY-----" not in output, "key material reached stdout/stderr"
        assert PASSPHRASE not in output, "the passphrase reached stdout/stderr"


def ext(cert: Path, name: str) -> str:
    return openssl("x509", "-in", str(cert), "-noout", "-ext", name).stdout


def tree(path: Path) -> list[str]:
    return sorted(str(p.relative_to(path)) for p in path.rglob("*")) if path.exists() else []


# ── default and gating ────────────────────────────────────────────────────────

def test_default_mode_is_read_only_preflight(fx: Fixture) -> None:
    result = fx.run(None)
    assert "MODE=preflight" in result.stdout
    assert result.returncode == 0, result.stdout
    assert "K10_CA_STATE=NOT_INITIALISED" in result.stdout
    assert not fx.pki.exists(), "preflight must not create the PKI root"
    assert tree(fx.hub) == []


@pytest.mark.parametrize("mode", ["init", "sign", "crl", "revoke", "publish"])
def test_mutating_modes_refuse_without_authorization(fx: Fixture, mode: str) -> None:
    result = fx.run(mode)
    assert result.returncode == 2
    assert "AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION=YES is required" in result.stdout
    assert not fx.pki.exists()


@pytest.mark.parametrize("var", ["AEGIS_K10_PKI_ROOT", "AEGIS_K10_HUB_CERTS", "AEGIS_K10_TEST_PASSFILE"])
def test_test_only_overrides_are_refused_outside_test_mode(fx: Fixture, var: str) -> None:
    result = fx.run("preflight", test_mode=False, **{var: str(fx.root / "x")})
    assert result.returncode == 2
    assert f"{var} is TEST-ONLY" in result.stdout


@pytest.mark.parametrize(
    ("var", "path"),
    [
        ("AEGIS_K10_PKI_ROOT", "/opt/aegis/pki"),
        ("AEGIS_K10_PKI_ROOT", "/etc/aegis-idea3/pki"),
        ("AEGIS_K10_HUB_CERTS", "/opt/aegis/runtime/certs"),
    ],
)
def test_test_mode_refuses_production_paths(fx: Fixture, var: str, path: str) -> None:
    result = fx.run("init", authorize=True, **{var: path})
    assert result.returncode == 2
    assert "refuses the Production-like path" in result.stdout


def test_production_defaults_are_explicit() -> None:
    source = SERVER_CA.read_text()
    assert "readonly PROD_PKI_ROOT=/opt/aegis/pki\n" in source
    assert "readonly PROD_HUB_CERTS=/opt/aegis/runtime/certs\n" in source
    assert 'CA_KEY="$PRIV_DIR/idea3-machine-client-ca.key"' in source
    assert 'MODE="${MODE:-preflight}"' in source
    # The CA key is always encrypted; -nodes never appears for the CA.
    assert "-nodes" not in source
    assert "-aes-256-cbc" in source


# ── init ─────────────────────────────────────────────────────────────────────

def test_init_creates_a_dedicated_pathlen0_ca_with_root_only_key_custody(fx: Fixture) -> None:
    fx.init()
    basic = ext(fx.ca_crt, "basicConstraints")
    assert "critical" in basic and "CA:TRUE, pathlen:0" in basic
    usage = ext(fx.ca_crt, "keyUsage")
    assert "critical" in usage and "Certificate Sign, CRL Sign" in usage

    assert stat.S_IMODE(fx.ca_key.stat().st_mode) == 0o600
    assert stat.S_IMODE(fx.ca_key.parent.stat().st_mode) == 0o700
    assert fx.ca_key.read_text().splitlines()[0] == "-----BEGIN ENCRYPTED PRIVATE KEY-----"

    subject = openssl("x509", "-in", str(fx.ca_crt), "-noout", "-subject").stdout
    assert "AEGIS IDEA3 Machine Client CA" in subject
    assert "AEGIS Internal Root CA" not in subject
    assert tree(fx.hub) == [], "init never publishes"
    assert fx.run("verify").returncode == 0


def test_init_refuses_to_overwrite_an_existing_ca(fx: Fixture) -> None:
    fx.init()
    before = hashlib.sha256(fx.ca_key.read_bytes()).hexdigest()
    result = fx.run("init", authorize=True)
    assert result.returncode == 2
    assert "is never overwritten" in result.stdout
    assert hashlib.sha256(fx.ca_key.read_bytes()).hexdigest() == before


def test_preflight_and_verify_fail_on_loose_key_permissions(fx: Fixture) -> None:
    fx.init()
    fx.ca_key.chmod(0o640)
    assert fx.run("preflight").returncode == 1
    assert "FAIL CA key custody" in fx.run("verify").stdout


# ── publish ──────────────────────────────────────────────────────────────────

def test_publish_exports_only_the_public_ca_certificate_and_crl(fx: Fixture) -> None:
    fx.init()
    result = fx.run("publish", authorize=True)
    assert result.returncode == 0, result.stdout
    assert tree(fx.hub) == ["idea3-machine-client-ca.crl", "idea3-machine-client-ca.crt"]
    for published in fx.hub.iterdir():
        assert "PRIVATE KEY" not in published.read_text()
    assert fx.hub.resolve() not in fx.ca_key.resolve().parents


def test_verify_fails_when_a_ca_key_appears_in_the_hub_mount(fx: Fixture) -> None:
    fx.init()
    (fx.hub / "idea3-machine-client-ca.key").write_text("placeholder\n")
    assert fx.run("preflight").returncode == 1
    assert "FAIL NEGATIVE: no CA private key file exists in the HUB certificate mount" in fx.run("verify").stdout


# ── sign ─────────────────────────────────────────────────────────────────────

def test_signed_core_certificate_profile(fx: Fixture) -> None:
    fx.init()
    result = fx.sign(fx.csr())
    assert result.returncode == 0, result.stdout + result.stderr
    cert = fx.issued()

    subject = openssl("x509", "-in", str(cert), "-noout", "-subject", "-nameopt", "RFC2253").stdout.strip()
    assert subject == "subject=CN=idea3-core"
    eku = ext(cert, "extendedKeyUsage")
    assert "TLS Web Client Authentication" in eku
    assert "TLS Web Server Authentication" not in eku
    assert "CA:FALSE" in ext(cert, "basicConstraints")
    assert "Digital Signature" in ext(cert, "keyUsage")

    dates = openssl("x509", "-in", str(cert), "-noout", "-startdate", "-enddate").stdout
    start, end = (subprocess.run(["date", "-u", "-d", line.split("=", 1)[1], "+%s"],
                                 capture_output=True, text=True).stdout for line in dates.splitlines())
    assert (int(end) - int(start)) // 86400 <= 100

    ok = openssl("verify", "-CAfile", str(fx.ca_crt), "-CRLfile", str(fx.ca_crl),
                 "-crl_check", "-purpose", "sslclient", str(cert))
    assert ok.returncode == 0, ok.stderr
    assert not any(p.suffix == ".key" for p in (fx.pki / "issued").iterdir()), "sign never writes a Core key"
    assert fx.run("verify").returncode == 0


@pytest.mark.parametrize("subject", ["/CN=idea3-core-evil", "/O=AEGIS/CN=idea3-core", "/CN=IDEA3-CORE"])
def test_sign_refuses_any_subject_other_than_exactly_cn_idea3_core(fx: Fixture, subject: str) -> None:
    fx.init()
    result = fx.sign(fx.csr(subject))
    assert result.returncode == 2
    assert "CSR subject must be exactly CN=idea3-core" in result.stdout
    assert not list((fx.pki / "issued").glob("*.crt"))


def test_sign_refuses_a_csr_whose_digest_does_not_match_the_core_record(fx: Fixture) -> None:
    fx.init()
    result = fx.sign(fx.csr(), CSR_SHA256="0" * 64)
    assert result.returncode == 2
    assert "CSR SHA-256 does not match" in result.stdout


def test_sign_refuses_a_file_that_carries_a_private_key(fx: Fixture) -> None:
    fx.init()
    csr = fx.csr()
    bundle = fx.root / "bundle.csr"
    bundle.write_text(csr.read_text() + csr.with_suffix(".key").read_text())
    result = fx.sign(bundle)
    assert result.returncode == 2
    assert "contains a private key" in result.stdout


def test_sign_refuses_a_lifetime_over_100_days_and_a_non_p256_key(fx: Fixture) -> None:
    fx.init()
    assert fx.sign(fx.csr(), CORE_DAYS="101").returncode == 2
    result = fx.sign(fx.csr(curve="P-384"))
    assert result.returncode == 2
    assert "EC P-256" in result.stdout


def test_a_certificate_from_a_different_ca_fails_sslclient_verification(fx: Fixture) -> None:
    fx.init()
    assert fx.sign(fx.csr()).returncode == 0
    other = fx.root / "other"
    other.mkdir()
    made = openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                   "-keyout", str(other / "ca.key"), "-out", str(other / "ca.crt"), "-days", "30",
                   "-subj", "/CN=Wrong CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                   "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    assert made.returncode == 0, made.stderr
    wrong = openssl("verify", "-CAfile", str(other / "ca.crt"), "-purpose", "sslclient", str(fx.issued()))
    assert wrong.returncode != 0


# ── CRL and revocation ───────────────────────────────────────────────────────

def test_crl_is_signed_bounded_and_revocation_is_enforced(fx: Fixture) -> None:
    fx.init()
    assert fx.sign(fx.csr()).returncode == 0
    cert = fx.issued()

    assert fx.run("crl", authorize=True, CRL_DAYS="46").returncode == 2
    assert fx.run("crl", authorize=True, CRL_DAYS="6").returncode == 2
    assert fx.run("crl", authorize=True, CRL_DAYS="14").returncode == 0
    signed = openssl("crl", "-in", str(fx.ca_crl), "-noout", "-CAfile", str(fx.ca_crt))
    assert "verify OK" in signed.stdout + signed.stderr

    revoked = fx.run("revoke", authorize=True, CERT=str(cert))
    assert revoked.returncode == 0, revoked.stdout + revoked.stderr
    check = openssl("verify", "-CAfile", str(fx.ca_crt), "-CRLfile", str(fx.ca_crl),
                    "-crl_check", "-purpose", "sslclient", str(cert))
    assert check.returncode != 0 and "revoked" in (check.stdout + check.stderr)
    assert fx.run("verify").returncode == 1


# ── AEGIS Internal Root CA is never reused ───────────────────────────────────

def test_verify_rejects_the_aegis_internal_root_ca_as_the_client_ca(fx: Fixture) -> None:
    fx.init()
    # Replace the fixture CA certificate with a fixture named like the Root CA.
    root_key = fx.root / "root.key"
    made = openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                   "-keyout", str(root_key), "-out", str(fx.ca_crt), "-days", "30",
                   "-subj", "/C=TH/O=AEGIS/CN=AEGIS Internal Root CA",
                   "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                   "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    assert made.returncode == 0, made.stderr
    result = fx.run("verify")
    assert result.returncode == 1
    assert "FAIL NEGATIVE: the CA subject is not the AEGIS Internal Root CA" in result.stdout


def test_verify_rejects_a_ca_sharing_the_root_ca_public_key(fx: Fixture) -> None:
    fx.init()
    result = fx.run("verify", AEGIS_ROOT_CA_CRT=str(fx.ca_crt))
    assert "FAIL NEGATIVE: the CA public key is not the AEGIS Internal Root CA key" in result.stdout


def test_the_owner_observed_root_ca_digest_is_pinned_as_a_negative() -> None:
    assert "8d03ec3090de7d3dc38dce86234219f3675ed0124d44b32d721b6a4eaba10ca7" in SERVER_CA.read_text()


# ── Core-side contract (p2-k10-client-pki.sh) ────────────────────────────────

def core_pki(fx: Fixture) -> Path:
    fx.init()
    csr = fx.csr()
    assert fx.sign(csr).returncode == 0
    pki = fx.root / "core-pki"
    pki.mkdir()
    shutil.copy(csr.with_suffix(".key"), pki / "idea3-core-client.key")
    shutil.copy(fx.issued(), pki / "idea3-core-client.crt")
    shutil.copy(fx.ca_crt, pki / "idea3-machine-client-ca.crt")
    shutil.copy(fx.ca_crl, pki / "idea3-machine-client-ca.crl")
    return pki


def run_client_verify(pki: Path) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ["PATH"], "LC_ALL": "C", "MODE": "verify", "PKI_DIR": str(pki)}
    return subprocess.run(["bash", str(CLIENT_PKI)], capture_output=True, text=True, env=env, timeout=60)


def test_core_verify_passes_on_a_server_signed_fixture(fx: Fixture) -> None:
    result = run_client_verify(core_pki(fx))
    assert result.returncode == 0, result.stdout
    assert "K10_VERIFY=PASS" in result.stdout


def test_core_verify_still_rejects_a_ca_private_key_on_the_core(fx: Fixture) -> None:
    pki = core_pki(fx)
    shutil.copy(fx.ca_key, pki / "idea3-machine-client-ca.key")
    result = run_client_verify(pki)
    assert result.returncode == 1
    assert "FAIL NEGATIVE: no CA private key is present beside the certificate" in result.stdout


def test_core_contract_describes_server_held_custody_not_offline_custody() -> None:
    env = {"PATH": os.environ["PATH"], "LC_ALL": "C", "MODE": "contract"}
    text = subprocess.run(["bash", str(CLIENT_PKI)], capture_output=True, text=True, env=env).stdout
    assert "SERVER_HELD_DEDICATED_CLIENT_CA" in text and "authorized CODEOWNER review" in text
    assert "never\nauthorizes a Production change" in text
    assert "PENDING Kla" not in text, "review routing follows CODEOWNERS, not Kla alone"
    assert "/opt/aegis/pki/private/idea3-machine-client-ca.key" in text
    assert "root:root 0600" in text
    assert "NEVER LEAVES THE CORE" in text
    for stale in ("NEVER LEAVES KLA", "offline", "Not on the server", "a CA key on the server"):
        assert stale not in text
    # The CSR check that the key never leaves the Core is unchanged.
    assert "[ ! -e \"${CA_CRT%.crt}.key\" ]" in CLIENT_PKI.read_text()


# ── NGINX and repository boundaries ──────────────────────────────────────────

def test_nginx_machine_block_references_only_public_ca_and_crl_paths() -> None:
    directives = [
        line.strip() for line in MACHINE_NGINX.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    normalised = [re.sub(r"\s+", " ", d) for d in directives]
    assert "ssl_client_certificate /etc/nginx/certs/idea3-machine-client-ca.crt;" in normalised
    assert "ssl_crl /etc/nginx/certs/idea3-machine-client-ca.crl;" in normalised
    for directive in normalised:
        assert "idea3-machine-client-ca.key" not in directive
        assert "/opt/aegis/pki" not in directive
    assert "offline" not in MACHINE_NGINX.read_text()


def test_no_compose_file_mounts_the_server_pki_root() -> None:
    compose_files = list(REPO.glob("docker-compose*.yml")) + list((LOCKDOWN / "deploy").glob("*.yml"))
    assert compose_files
    for path in compose_files:
        assert "/opt/aegis/pki" not in path.read_text(), path


def test_amendment_records_the_proposal_risk_and_unchanged_state() -> None:
    text = re.sub(r"[ \t]+", " ", AMENDMENT.read_text())
    for required in (
        "K10_CA_MODEL = SERVER_HELD_DEDICATED_CLIENT_CA",
        "ACCEPTED_BY_AUTHORIZED_CODEOWNER",
        "PRODUCTION_MUTATION_AUTHORIZED = NO",
        "CA_ISSUANCE = NOT_DONE",
        "LIVE_MTLS = NOT_PROVEN",
        "not equivalent to offline",
    ):
        assert required in text, required
