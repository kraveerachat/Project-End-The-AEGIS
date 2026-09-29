"""L4 live mode must never accept documentation-range defaults for owner values.

Live mode = AEGIS_P4_FS_ROOT unset. Tests use AEGIS_L4_VALUES_ONLY=YES (validate then exit before any
work-dir / profile / host mutation) and a PATH shim for `ip` so nothing on the test host is read or changed.
"""
from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
L4 = ROOT / "deploy" / "pr11-phase4" / "stages" / "L4"

APPROVED = {
    "AEGIS_AP_INTERFACE": "wlp0s20f3",
    "AEGIS_AP_ADDRESS": "10.77.30.1",
    "AEGIS_AP_SUBNET": "10.77.30.0/28",
    "AEGIS_DHCP_START": "10.77.30.2",
    "AEGIS_DHCP_END": "10.77.30.14",
    "AEGIS_BROKER_HOSTNAME": "mqtt.aegis.home.arpa",
}
IP_SHIM = r"""#!/usr/bin/env bash
case "$*" in
  "-4 -o addr show") printf '1: lo    inet 127.0.0.1/8 scope host lo\n2: enp62s0    inet 192.168.1.144/24 scope global enp62s0\n5: sdwan0    inet 100.96.0.2/32 scope global sdwan0\n' ;;
  "-4 route show") printf 'default via 192.168.1.1 dev enp62s0\n100.96.0.0/12 dev sdwan0\n192.168.1.0/24 dev enp62s0\n192.168.10.10 dev sdwan0\n' ;;
  *) echo "ip shim: unsupported: $*" >&2; exit 1 ;;
esac
"""


def run(tmp_path: Path, script: str = "apply.sh", *, live: bool = True, drop: tuple[str, ...] = (),
        **override: str) -> subprocess.CompletedProcess[str]:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    shim = bindir / "ip"
    shim.write_text(IP_SHIM)
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
    env = {k: v for k, v in os.environ.items() if not k.startswith("AEGIS_")}
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["AEGIS_L4_WORK_DIR"] = str(tmp_path / "work")
    env["AEGIS_L4_VALUES_ONLY"] = "YES"
    if not live:
        (tmp_path / "root").mkdir(exist_ok=True)
        env["AEGIS_P4_FS_ROOT"] = str(tmp_path / "root")
    env.update({k: v for k, v in {**APPROVED, **override}.items() if k not in drop})
    return subprocess.run(["bash", str(L4 / script)], text=True, capture_output=True, env=env)


def out(r: subprocess.CompletedProcess[str]) -> str:
    return r.stdout + r.stderr


def test_approved_values_pass_live_validation(tmp_path: Path) -> None:
    r = run(tmp_path)
    assert r.returncode == 0, out(r)
    assert "L4_VALUES=VALID" in r.stdout
    assert not (tmp_path / "work").exists()


@pytest.mark.parametrize("var", ["AEGIS_AP_ADDRESS", "AEGIS_AP_SUBNET", "AEGIS_DHCP_START", "AEGIS_DHCP_END",
                                 "AEGIS_BROKER_HOSTNAME", "AEGIS_AP_INTERFACE"])
def test_live_missing_owner_value_fails_closed(tmp_path: Path, var: str) -> None:
    r = run(tmp_path, drop=(var,))
    assert r.returncode != 0
    assert f"LIVE_REQUIRES_EXPLICIT_{var}" in out(r)
    assert not (tmp_path / "work").exists()


@pytest.mark.parametrize("var", ["AEGIS_AP_ADDRESS", "AEGIS_BROKER_HOSTNAME"])
def test_live_empty_owner_value_fails_closed(tmp_path: Path, var: str) -> None:
    r = run(tmp_path, **{var: ""})
    assert r.returncode != 0 and f"LIVE_REQUIRES_EXPLICIT_{var}" in out(r)


def test_fixture_mode_keeps_explicit_fixture_defaults(tmp_path: Path) -> None:
    r = run(tmp_path, live=False, drop=tuple(k for k in APPROVED if k != "AEGIS_AP_INTERFACE"))
    assert r.returncode == 0, out(r)
    assert "L4_VALUES=VALID" in r.stdout


@pytest.mark.parametrize("subnet,ap,s,e", [
    ("192.0.2.0/28", "192.0.2.1", "192.0.2.2", "192.0.2.10"),
    ("198.51.100.0/28", "198.51.100.1", "198.51.100.2", "198.51.100.10"),
    ("203.0.113.0/28", "203.0.113.1", "203.0.113.2", "203.0.113.10"),
])
def test_documentation_ranges_cannot_enter_live_mode(tmp_path: Path, subnet, ap, s, e) -> None:
    r = run(tmp_path, AEGIS_AP_SUBNET=subnet, AEGIS_AP_ADDRESS=ap, AEGIS_DHCP_START=s, AEGIS_DHCP_END=e)
    assert r.returncode != 0 and "LIVE_DOCUMENTATION_RANGE_FORBIDDEN" in out(r)


@pytest.mark.parametrize("subnet,ap,s,e", [
    ("8.8.8.0/28", "8.8.8.1", "8.8.8.2", "8.8.8.14"),
    ("100.64.5.0/28", "100.64.5.1", "100.64.5.2", "100.64.5.14"),
    ("169.254.5.0/28", "169.254.5.1", "169.254.5.2", "169.254.5.14"),
])
def test_live_subnet_must_be_private_non_cgnat(tmp_path: Path, subnet, ap, s, e) -> None:
    r = run(tmp_path, AEGIS_AP_SUBNET=subnet, AEGIS_AP_ADDRESS=ap, AEGIS_DHCP_START=s, AEGIS_DHCP_END=e)
    assert r.returncode != 0 and "LIVE_SUBNET_NOT_PRIVATE" in out(r)


@pytest.mark.parametrize("subnet,ap,s,e", [
    ("192.168.1.0/28", "192.168.1.1", "192.168.1.2", "192.168.1.14"),      # enp62s0 address net
    ("192.168.10.0/28", "192.168.10.1", "192.168.10.2", "192.168.10.14"),  # route to 192.168.10.10/32 only
    ("172.16.0.0/28", "172.16.0.1", "172.16.0.2", "172.16.0.14"),          # clean control → must PASS
])
def test_subnet_overlap_with_addresses_and_routes_rejected(tmp_path: Path, subnet, ap, s, e) -> None:
    r = run(tmp_path, AEGIS_AP_SUBNET=subnet, AEGIS_AP_ADDRESS=ap, AEGIS_DHCP_START=s, AEGIS_DHCP_END=e)
    if subnet.startswith("172."):
        assert r.returncode == 0, out(r)
    else:
        assert r.returncode != 0 and "MANAGEMENT_NETWORK_OVERLAP" in out(r)


@pytest.mark.parametrize("override,reason", [
    ({"AEGIS_AP_ADDRESS": "10.77.31.1"}, "AP_ADDRESS_NOT_IN_SUBNET"),
    ({"AEGIS_DHCP_START": "10.77.31.2"}, "DHCP_START_NOT_IN_SUBNET"),
    ({"AEGIS_DHCP_END": "10.77.30.20"}, "DHCP_END_NOT_IN_SUBNET"),
    ({"AEGIS_DHCP_START": "10.77.30.1"}, "DHCP_RANGE_CONTAINS_CORE_AP"),
    ({"AEGIS_DHCP_START": "10.77.30.0"}, "DHCP_START_IS_NETWORK_OR_BROADCAST"),
    ({"AEGIS_DHCP_END": "10.77.30.15"}, "DHCP_END_IS_NETWORK_OR_BROADCAST"),
    ({"AEGIS_AP_ADDRESS": "10.77.30.0"}, "AP_ADDRESS_IS_NETWORK_OR_BROADCAST"),
    ({"AEGIS_AP_ADDRESS": "10.77.30.15"}, "AP_ADDRESS_IS_NETWORK_OR_BROADCAST"),
    ({"AEGIS_DHCP_START": "10.77.30.9", "AEGIS_DHCP_END": "10.77.30.3"}, "DHCP_START_GREATER_THAN_END"),
    ({"AEGIS_AP_SUBNET": "10.77.30.1/28"}, "INVALID_SUBNET"),
    ({"AEGIS_AP_SUBNET": "10.77.30.0/31"}, "SUBNET_TOO_SMALL"),
    ({"AEGIS_AP_ADDRESS": "not-an-ip"}, "INVALID_IP_ADDRESS"),
])
def test_address_relationship_rules_rejected(tmp_path: Path, override, reason) -> None:
    r = run(tmp_path, **override)
    assert r.returncode != 0 and reason in out(r), out(r)


@pytest.mark.parametrize("host", ["-bad.aegis.home.arpa", "mqtt..home.arpa", "under_score.home.arpa", "mqtt.aegis.home.arpa.",
                                  "a" * 64 + ".home.arpa", "mqtt aegis.home.arpa", "singlelabel", "mqtt.aegis.invalid",
                                  "mqtt.aegis.example", "mqtt.aegis.local", "mqtt.aegis.test", "mqtt.aegis.localhost", "10.77.30.1"])
def test_invalid_or_reserved_live_hostname_rejected(tmp_path: Path, host: str) -> None:
    r = run(tmp_path, AEGIS_BROKER_HOSTNAME=host)
    assert r.returncode != 0 and ("INVALID_BROKER_HOSTNAME" in out(r) or "LIVE_BROKER_HOSTNAME_RESERVED" in out(r)), out(r)


def test_malformed_hostname_rejected_in_fixture_mode_too(tmp_path: Path) -> None:
    r = run(tmp_path, live=False, AEGIS_BROKER_HOSTNAME="mqtt..bad")
    assert r.returncode != 0 and "INVALID_BROKER_HOSTNAME" in out(r)


def test_live_verify_requires_explicit_ap_address(tmp_path: Path) -> None:
    (tmp_path / "work").mkdir()
    r = run(tmp_path, "verify.sh", drop=("AEGIS_AP_ADDRESS",))
    assert r.returncode != 0 and "LIVE_REQUIRES_EXPLICIT_AEGIS_AP_ADDRESS" in out(r)


def test_documentation_defaults_only_exist_in_fixture_branch() -> None:
    for name in ("apply.sh", "verify.sh"):
        lines = [ln for ln in (L4 / name).read_text().splitlines() if not ln.lstrip().startswith("#")]
        text = "\n".join(lines)
        first_doc = text.index("192.0.2")
        assert text.index("LIVE_REQUIRES_EXPLICIT") < first_doc
        assert '-z "$ROOT"' in text[: first_doc]
