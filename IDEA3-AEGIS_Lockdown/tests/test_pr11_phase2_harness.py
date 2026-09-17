"""PR11 Phase 2 runtime evidence harness — parser and host-identity regressions.

Two harness defects surfaced during the owner-run Phase 2B window on 2026-09-16:

1. ``p2b-tests-server.sh`` read the HTTP status as a fixed whitespace field of
   BusyBox ``wget -S`` output. For a non-2xx response BusyBox also prints
   ``wget: server returned error: HTTP/1.1 403 Forbidden``, whose second field
   is ``server``, so correct 403/404 refusals were reported as FAIL.
2. ``p2-k8-core-evidence.sh`` and ``p2b-tests-core.sh`` required the optional
   ``hostname`` executable, which the real Arch Core does not have.

Everything here runs against stubbed ``docker``/``curl``/``ip``/``openssl``
commands in a pytest temporary directory. Nothing reaches the network, the
HUB, or the Core PKI, and nothing here is Phase 2 runtime evidence.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

LOCKDOWN = Path(__file__).resolve().parents[1]
DEPLOY = LOCKDOWN / "deploy" / "pr11-phase2"
PORTABLE = DEPLOY / "p2-portable.sh"
SERVER_TESTS = DEPLOY / "p2b-tests-server.sh"
CORE_TESTS = DEPLOY / "p2b-tests-core.sh"
K8_EVIDENCE = DEPLOY / "p2-k8-core-evidence.sh"

# Real tools the scripts need; `hostname` is deliberately never linked.
TOOLS = (
    "bash", "date", "grep", "head", "tail", "awk", "cut", "tr", "cat", "rm",
    "tee", "sed", "sort", "sha256sum", "dirname", "ls", "find", "seq",
)

pytestmark = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in TOOLS),
    reason="a POSIX userland with bash is required",
)


def make_bin(root: Path, stubs: dict[str, str]) -> Path:
    """Return a PATH directory holding only the real TOOLS plus the given stubs."""
    bindir = root / "bin"
    bindir.mkdir()
    for tool in TOOLS:
        (bindir / tool).symlink_to(shutil.which(tool))
    for name, body in stubs.items():
        stub = bindir / name
        stub.write_text("#!" + shutil.which("bash") + "\n" + body)
        stub.chmod(0o755)
    assert not (bindir / "hostname").exists()
    return bindir


def run(script: Path, bindir: Path, **env: str) -> subprocess.CompletedProcess:
    base = {"PATH": str(bindir), "HOME": str(bindir.parent), "LC_ALL": "C"}
    base.update(env)
    return subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, env=base,
        stdin=subprocess.DEVNULL, timeout=60,
    )


def shell(snippet: str, bindir: Path, stdin: str = "", **env: str) -> subprocess.CompletedProcess:
    base = {"PATH": str(bindir), "LC_ALL": "C"}
    base.update(env)
    return subprocess.run(
        ["bash", "-c", f'set -uo pipefail; . "{PORTABLE}"; {snippet}'],
        capture_output=True, text=True, env=base, input=stdin, timeout=30,
    )


# ── BusyBox wget status parsing ──────────────────────────────────────────────

BUSYBOX_OK = "Connecting to 172.31.243.3:8004 (172.31.243.3:8004)\n  HTTP/1.1 200 OK\n  Content-Type: application/json\n"
BUSYBOX_403 = (
    "Connecting to 172.31.243.3:8004 (172.31.243.3:8004)\n"
    "  HTTP/1.1 403 Forbidden\n  Content-Type: application/json\n"
    "wget: server returned error: HTTP/1.1 403 Forbidden\n"
)
BUSYBOX_404 = (
    "Connecting to 172.31.243.3:8003 (172.31.243.3:8003)\n"
    "  HTTP/1.1 404 Not Found\n"
    "wget: server returned error: HTTP/1.1 404 Not Found\n"
)


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("HTTP/1.1 200 OK\n", "200"),
        ("HTTP/1.1 403 Forbidden\n", "403"),
        ("wget: server returned error: HTTP/1.1 403 Forbidden\n", "403"),
        ("HTTP/1.1 404 Not Found\n", "404"),
        ("wget: server returned error: HTTP/1.1 404 Not Found\n", "404"),
        (BUSYBOX_OK, "200"),
        (BUSYBOX_403, "403"),
        (BUSYBOX_404, "404"),
        ("  HTTP/2 400 \n", "400"),
    ],
)
def test_http_status_is_taken_from_the_http_version_token(tmp_path: Path, output: str, expected: str) -> None:
    result = shell("p2_http_status", make_bin(tmp_path, {}), stdin=output)
    assert result.returncode == 0, result.stderr
    assert result.stdout == expected + "\n"


@pytest.mark.parametrize(
    "output",
    [
        "",
        "wget: can't connect to remote host (172.31.243.3): Connection refused\n",
        "wget: bad address 'idea3-web'\n",
        "HTTP/1.1 OK\n",
        "HTTP/1.1 4033 Forbidden\n",
        "server returned error 403\n",
        "403\n",
    ],
)
def test_missing_or_unparsable_status_fails_closed(tmp_path: Path, output: str) -> None:
    result = shell("p2_http_status", make_bin(tmp_path, {}), stdin=output)
    assert result.returncode != 0
    assert result.stdout == "000\n"
    assert result.stdout.strip() not in {"200", "403", "404"}


def test_the_old_fixed_field_parser_misreads_busybox_error_output() -> None:
    """Documents the root cause: field 2 of the error line is `server`, not the code."""
    awk = shutil.which("awk")
    old = subprocess.run(
        [awk, r"/HTTP\//{c=$2} END{print c+0}"], input=BUSYBOX_403,
        capture_output=True, text=True, check=True,
    )
    assert old.stdout == "0\n"
    assert "awk '/HTTP\\//{c=$2}" not in SERVER_TESTS.read_text()
    assert 'awk "/HTTP\\//{c=\\$2}' not in SERVER_TESTS.read_text()


# ── p2b-tests-server.sh end to end, against a stubbed Production ─────────────

DOCKER_STUB = r"""
# Stub: emulates BusyBox wget inside the HUB and IDEA3 Web containers.
container=$2
if [ "$1" = exec ] && [ "$3" = wget ]; then
  args="$*"
  url="${@: -1}"
  emit() { # code reason
    echo "Connecting to 172.31.243.3"
    echo "  HTTP/1.1 $1 $2"
    [ "$1" = 200 ] || echo "wget: server returned error: HTTP/1.1 $1 $2"
  }
  case "${SCENARIO:-correct}" in
    forged-accepted) emit 200 OK; exit 0 ;;
    garbage) echo "wget: can't connect to remote host"; exit 1 ;;
  esac
  case "$url" in
    *:8003/*) emit 404 "Not Found"; exit 1 ;;
  esac
  if [ "$container" = aegis-prod-idea3-web-1 ]; then emit 403 Forbidden; exit 1; fi
  case "$args" in
    *"CN=idea3-core"*) emit 200 OK; exit 0 ;;
    *) emit 403 Forbidden; exit 1 ;;
  esac
fi
if [ "$1" = exec ] && [ "$3" = nginx ]; then
  printf '    server_name idea3-core.aegis.internal;\n    ssl_verify_client on;\n    ssl_verify_depth 1;\n'
  exit 0
fi
if [ "$1" = inspect ]; then echo AEGIS_IDEA3_DISPATCH_ENABLED; exit 0; fi
exit 0
"""

OPENSSL_STUB = r"""
case "$*" in
  *"crl "*"-nextupdate"*) echo "nextUpdate=Oct 16 15:10:17 2099 GMT" ;;
  *subjectAltName*) echo "X509v3 Subject Alternative Name:"; echo "    DNS:idea3-core.aegis.internal" ;;
esac
exit 0
"""


def server_bin(tmp_path: Path) -> Path:
    return make_bin(tmp_path, {"docker": DOCKER_STUB, "openssl": OPENSSL_STUB, "id": "echo 0\n"})


def test_server_tests_pass_when_production_refuses_with_busybox_error_output(tmp_path: Path) -> None:
    result = run(SERVER_TESTS, server_bin(tmp_path))
    out = result.stdout
    assert "PASS peer .3 with forged SUCCESS identity is refused (403)" in out, out
    assert "PASS peer .3 without identity headers is refused (403)" in out, out
    assert "PASS HUB peer with SUCCESS + CN=idea3-core is accepted (200)" in out, out
    assert "PASS HUB peer with a wrong CN is refused (403)" in out, out
    assert "PASS browser listener 8003 returns 404 for the machine path" in out, out
    assert "FAIL" not in out, out
    assert "PHASE2B_SERVER_TESTS=PASS" in out
    assert result.returncode == 0


def test_server_tests_fail_when_a_forged_identity_is_accepted(tmp_path: Path) -> None:
    result = run(SERVER_TESTS, server_bin(tmp_path), SCENARIO="forged-accepted")
    assert "FAIL peer .3 with forged SUCCESS identity is refused (403)" in result.stdout
    assert "FAIL browser listener 8003 returns 404 for the machine path" in result.stdout
    assert "PHASE2B_SERVER_TESTS=FAIL" in result.stdout
    assert result.returncode != 0


def test_server_tests_fail_closed_when_no_status_is_returned(tmp_path: Path) -> None:
    result = run(SERVER_TESTS, server_bin(tmp_path), SCENARIO="garbage")
    for label in (
        "peer .3 with forged SUCCESS identity is refused (403)",
        "peer .3 without identity headers is refused (403)",
        "HUB peer with SUCCESS + CN=idea3-core is accepted (200)",
        "HUB peer with a wrong CN is refused (403)",
        "browser listener 8003 returns 404 for the machine path",
    ):
        assert f"FAIL {label}" in result.stdout, result.stdout
    assert "PHASE2B_SERVER_TESTS=FAIL" in result.stdout
    assert result.returncode != 0


def test_server_expected_security_statuses_are_exact() -> None:
    source = SERVER_TESTS.read_text()
    assert source.count("= 403 ]") == 3
    assert source.count("= 404 ]") == 1
    assert source.count("= 200 ]") == 1


# ── host identity without the optional `hostname` executable ────────────────

def hostnamectl_stub(name: str) -> str:
    return f'[ "$1" = --static ] && {{ echo "{name}"; exit 0; }}\necho " Static hostname: {name}"\n'


@pytest.mark.parametrize(
    ("stubs", "hostname_file", "expected"),
    [
        ({"hostnamectl": hostnamectl_stub("archlinux")}, None, "archlinux"),
        ({}, "archlinux\n", "archlinux"),
        ({}, "# managed by systemd\n\n  archlinux  \n", "archlinux"),
        ({"hostnamectl": "exit 1\n"}, "archlinux\n", "archlinux"),
        ({"hostnamectl": "echo\n"}, "archlinux\n", "archlinux"),
    ],
)
def test_host_identity_without_hostname_binary(tmp_path: Path, stubs, hostname_file, expected) -> None:
    bindir = make_bin(tmp_path, stubs)
    hfile = tmp_path / "etc-hostname"
    if hostname_file is not None:
        hfile.write_text(hostname_file)
    result = shell("p2_host_identity", bindir, AEGIS_P2_HOSTNAME_FILE=str(hfile))
    assert result.returncode == 0, result.stderr
    assert result.stdout == expected + "\n"


@pytest.mark.parametrize(
    ("stubs", "hostname_file"),
    [
        ({}, None),
        ({"hostnamectl": "exit 1\n"}, ""),
        ({}, "# only a comment\n"),
        ({"hostnamectl": 'echo "bad host name"\n'}, None),
        ({}, "evil;rm -rf /\n"),
    ],
)
def test_host_identity_fails_closed_when_undeterminable(tmp_path: Path, stubs, hostname_file) -> None:
    bindir = make_bin(tmp_path, stubs)
    hfile = tmp_path / "etc-hostname"
    if hostname_file is not None:
        hfile.write_text(hostname_file)
    result = shell("p2_host_identity", bindir, AEGIS_P2_HOSTNAME_FILE=str(hfile))
    assert result.returncode != 0
    assert result.stdout == ""


def test_hostnamectl_wins_over_the_hostname_file(tmp_path: Path) -> None:
    bindir = make_bin(tmp_path, {"hostnamectl": hostnamectl_stub("archlinux")})
    hfile = tmp_path / "etc-hostname"
    hfile.write_text("other-host\n")
    result = shell("p2_host_identity", bindir, AEGIS_P2_HOSTNAME_FILE=str(hfile))
    assert result.stdout == "archlinux\n"


CORE_STUBS = {
    "hostnamectl": hostnamectl_stub("archlinux"),
    # Every network-facing tool is inert: no request leaves the test.
    "curl": "printf 000\nexit 7\n",
    "openssl": "exit 1\n",
    "getent": "exit 2\n",
    "ip": "exit 1\n",
    "systemctl": "exit 0\n",
    "sudo": "exit 1\n",
    "timeout": "exit 1\n",
}


@pytest.mark.parametrize("script", [CORE_TESTS, K8_EVIDENCE], ids=["p2b-tests-core", "p2-k8-core-evidence"])
def test_core_scripts_accept_the_declared_core_without_hostname(tmp_path: Path, script: Path) -> None:
    result = run(script, make_bin(tmp_path, CORE_STUBS), CORE_DECLARED="archlinux", WIRED_IF="aegis-test-if0",
                 AEGIS_P2_HOSTNAME_FILE=str(tmp_path / "absent"))
    combined = result.stdout + result.stderr
    assert "command not found" not in combined, combined
    assert "STOP: not the declared Core" not in combined, combined
    if script == K8_EVIDENCE:
        assert "PASS running on the declared Core host" in result.stdout, combined
    else:
        assert "=== T1 valid Core certificate is accepted" in result.stdout, combined


@pytest.mark.parametrize("script", [CORE_TESTS, K8_EVIDENCE], ids=["p2b-tests-core", "p2-k8-core-evidence"])
def test_core_scripts_refuse_a_mismatched_declared_core(tmp_path: Path, script: Path) -> None:
    result = run(script, make_bin(tmp_path, CORE_STUBS), CORE_DECLARED="archlinux2", WIRED_IF="aegis-test-if0",
                 AEGIS_P2_HOSTNAME_FILE=str(tmp_path / "absent"))
    assert result.returncode != 0
    if script == K8_EVIDENCE:
        assert "FAIL running on the declared Core host" in result.stdout
        assert "K8_CORE_EVIDENCE=FAIL" in result.stdout
    else:
        assert "STOP: not the declared Core" in result.stdout
        assert "=== T1" not in result.stdout


@pytest.mark.parametrize("script", [CORE_TESTS, K8_EVIDENCE], ids=["p2b-tests-core", "p2-k8-core-evidence"])
def test_core_scripts_refuse_when_identity_is_undeterminable(tmp_path: Path, script: Path) -> None:
    stubs = dict(CORE_STUBS)
    del stubs["hostnamectl"]
    result = run(script, make_bin(tmp_path, stubs), CORE_DECLARED="archlinux", WIRED_IF="aegis-test-if0",
                 AEGIS_P2_HOSTNAME_FILE=str(tmp_path / "absent"))
    assert result.returncode != 0
    if script == K8_EVIDENCE:
        assert "FAIL running on the declared Core host" in result.stdout
    else:
        assert "STOP: not the declared Core" in result.stdout


def test_core_scripts_have_no_hostname_executable_dependency() -> None:
    for script in (CORE_TESTS, K8_EVIDENCE):
        source = script.read_text()
        assert "$(hostname)" not in source
        assert "p2_host_identity" in source
        assert '. "$HERE/p2-portable.sh"' in source
