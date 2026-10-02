"""L34 dnsmasq unit authority: exact byte identity against the canonical template RENDERED with the fixed L34 values.

PR #305 turned ``aegis-idea3-dnsmasq.service.example`` into a placeholder template. ``l34_dnsmasq_unit_gate`` used to ``cmp`` the
installed unit against the raw file, so a correctly rendered live unit could never match, and the L34 fixtures hid that by installing
``EXAMPLE_UNIT.read_text()`` directly. The authority is now: raw template -> canonical render with L34_AP_IF/ADDR/PREFIX/CHANNEL ->
exact byte comparison. These tests call the real gate (read-only) against files; nothing touches a host.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_pr11_phase4_l34_reactivation as base  # noqa: E402
import test_pr11_phase4_l4_handler as l4  # noqa: E402

LOCKDOWN = Path(__file__).resolve().parents[1]
LIB = LOCKDOWN / "deploy" / "pr11-phase4" / "p4-l34-reactivation-lib.sh"
TEMPLATE = base.EXAMPLE_UNIT
REACT = LOCKDOWN / "deploy" / "pr11-phase4" / "reactivation"

# The unit exactly as PR #305's parent (main 05af825f) installed it: no readiness gate.
OLD_PRE_PR305_UNIT = """# AEGIS IDEA3 dedicated dnsmasq instance — TEMPLATE, NOT DEPLOYED.

[Unit]
Description=AEGIS IDEA3 private AP DHCP and Core-local DNS
After=NetworkManager.service
Requires=NetworkManager.service

[Service]
Type=simple
ExecStartPre=/usr/bin/dnsmasq --test --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf
ExecStart=/usr/bin/dnsmasq --keep-in-foreground --conf-file=/etc/aegis-idea3/dnsmasq-ap.conf --pid-file=
Restart=on-failure

[Install]
WantedBy=multi-user.target
"""


def gate(unit: Path, template: Path = TEMPLATE) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", f'set -uo pipefail; source "{LIB}"; l34_dnsmasq_unit_gate "{unit}" "{template}"'],
        text=True, capture_output=True, check=False,
    )


def install(tmp_path: Path, text: str, name: str = "unit.service") -> Path:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    path.chmod(0o644)
    return path


def accepted(result: subprocess.CompletedProcess[str]) -> bool:
    return result.returncode == 0


def test_A_raw_placeholder_template_installed_as_the_unit_is_refused(tmp_path: Path) -> None:
    result = gate(install(tmp_path, TEMPLATE.read_text()))
    assert not accepted(result) and "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY" in result.stderr


def test_B_template_rendered_with_canonical_l34_values_is_accepted(tmp_path: Path) -> None:
    result = gate(install(tmp_path, base.canonical_dnsmasq_unit()))
    assert accepted(result), result.stderr


def test_C_a_freshly_l4_rendered_unit_is_accepted(tmp_path: Path) -> None:
    fs_root, work = tmp_path / "fs", tmp_path / "work"
    l4.setup_l3_fs(fs_root, iface="wlp0s20f3")
    result = l4.run_handler(
        l4.HANDLER / "apply.sh", fs_root=fs_root, work_dir=work,
        extra_env={
            "AEGIS_AP_INTERFACE": "wlp0s20f3", "AEGIS_AP_ADDRESS": "10.77.30.1", "AEGIS_AP_SUBNET": "10.77.30.0/28",
            "AEGIS_DHCP_START": "10.77.30.2", "AEGIS_DHCP_END": "10.77.30.14", "AEGIS_BROKER_HOSTNAME": "mqtt.aegis.home.arpa",
        },
    )
    assert result.returncode == 0, result.stderr
    installed = fs_root / "etc" / "systemd" / "system" / "aegis-idea3-dnsmasq.service"
    assert installed.read_bytes() == base.canonical_dnsmasq_unit().encode()
    assert accepted(gate(installed))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.replace("dev wlp0s20f3", "dev wlp0s20f9"),  # interface
        lambda t: t.replace("inet 10.77.30.1/28 ", "inet 10.77.30.2/28 "),  # IPv4
        lambda t: t.replace("10.77.30.1/28 ", "10.77.30.1/24 "),  # prefix
        lambda t: t.replace('"type AP"', '"type managed"'),  # AP mode
        lambda t: t.replace('"channel 6 "', '"channel 11 "'),  # channel
        lambda t: t.replace("do /usr/bin/sleep 1; done", "do :; done"),  # readiness command
        lambda t: t.replace("grep -Fq", "grep -q"),  # readiness command semantics
        lambda t: t.replace("/usr/bin/timeout 30 ", "/usr/bin/timeout 300 "),  # timeout
        lambda t: t.replace("TimeoutStartSec=45", "TimeoutStartSec=450"),  # timeout
        lambda t: t.replace("--keep-in-foreground --conf-file", "--keep-in-foreground --user=root --conf-file"),  # ExecStart
        lambda t: t.replace("Restart=on-failure", "Restart=always"),  # Restart policy
        lambda t: t.replace("StartLimitBurst=5", "StartLimitBurst=50"),
        lambda t: t.replace("RestartSec=2", "RestartSec=0"),
        lambda t: t.rstrip("\n"),  # a byte-level difference (trailing newline)
        lambda t: t + "\n",
        lambda t: t.replace("Requires=NetworkManager.service", "Wants=NetworkManager.service"),
    ],
    ids=["interface", "ipv4", "prefix", "ap-mode", "channel", "gate-command", "gate-grep", "gate-timeout", "start-timeout",
         "execstart", "restart", "burst", "restartsec", "no-trailing-newline", "extra-newline", "requires"],
)
def test_D_any_mutation_of_the_rendered_unit_is_refused(tmp_path: Path, mutate) -> None:
    canonical = base.canonical_dnsmasq_unit()
    mutated = mutate(canonical)
    assert mutated != canonical, "the mutation must actually change the unit"
    assert not accepted(gate(install(tmp_path, mutated)))


def test_E_the_old_pre_pr305_installed_unit_without_the_gate_is_refused(tmp_path: Path) -> None:
    result = gate(install(tmp_path, OLD_PRE_PR305_UNIT))
    assert not accepted(result) and "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY" in result.stderr


def test_the_authority_is_not_loose_or_missing_or_a_symlink(tmp_path: Path) -> None:
    unit = install(tmp_path, base.canonical_dnsmasq_unit())
    assert not accepted(gate(tmp_path / "absent.service"))
    link = tmp_path / "link.service"
    link.symlink_to(unit)
    assert not accepted(gate(link)), "a symlinked unit is not accepted"
    assert not accepted(gate(unit, tmp_path / "no-template"))
    # An unresolvable authority (a template carrying an unknown placeholder) must be refused, never ignored.
    odd = install(tmp_path, TEMPLATE.read_text() + "# <AEGIS_UNKNOWN>\n", "odd.example")
    result = gate(install(tmp_path, base.canonical_dnsmasq_unit(), "u2.service"), odd)
    assert not accepted(result) and "L34_DNSMASQ_UNIT_TEMPLATE_UNRESOLVED" in result.stderr


def test_the_rendered_authority_is_derived_from_the_single_template(tmp_path: Path) -> None:
    """No second unit definition: editing the template changes what is accepted."""
    changed = install(tmp_path, TEMPLATE.read_text().replace("RestartSec=2", "RestartSec=3"), "changed.example")
    rendered = base.canonical_dnsmasq_unit().replace("RestartSec=2", "RestartSec=3")
    assert accepted(gate(install(tmp_path, rendered, "r.service"), changed))
    assert not accepted(gate(install(tmp_path, base.canonical_dnsmasq_unit(), "c.service"), changed))


def test_the_fixture_no_longer_installs_the_raw_template() -> None:
    source = (Path(__file__).parent / "test_pr11_phase4_l34_reactivation.py").read_text()
    assert "(UNIT_REL, EXAMPLE_UNIT.read_text(), 0o644)" not in source
    assert "<AEGIS_" not in base.canonical_dnsmasq_unit()


def test_every_gate_consumer_passes_the_template_path_and_none_compares_the_raw_file() -> None:
    sites = []
    for script in sorted(REACT.rglob("*.sh")):
        text = script.read_text()
        for number, line in enumerate(text.splitlines(), 1):
            if "l34_dnsmasq_unit_gate" in line:
                sites.append((script.relative_to(REACT).as_posix(), number))
                assert '"$EXAMPLE_UNIT"' in line, f"{script}:{number} must pass the canonical template to the rendering gate"
        assert not re.search(r"cmp\s+-s[^\n]*EXAMPLE_UNIT", text), f"{script} compares the raw example directly"
    assert {s for s, _ in sites} == {
        "l34/apply.sh", "l34/verify.sh", "l34-v5-post-l6b-degraded/apply.sh", "l34-v6-stale-broker-ap-down/apply.sh",
        "l34-v7-radio-disabled-broker-churn/apply.sh", "l34-v7-radio-disabled-broker-churn/verify.sh",
        "l34-v8-post-v7-persistent-ap-recovery/apply.sh", "l34-v8-post-v7-persistent-ap-recovery/verify.sh",
    }
    assert len(sites) == 8
