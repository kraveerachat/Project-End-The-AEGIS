"""PR11 Phase 4 T5 — repository-only AP network renderer tests."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


LOCKDOWN = Path(__file__).resolve().parents[1]
RENDERER = LOCKDOWN / "deploy" / "pr11-phase4" / "p4-ap-network.py"


def render(tmp_path: Path, **overrides: str):
    values = {
        "interface": "wlan-test0",
        "ssid_label": "AEGIS_TEST",
        "channel": "6",
        "country": "TH",
        "ap_address": "192.0.2.1",
        "ap_subnet": "192.0.2.0/28",
        "dhcp_start": "192.0.2.2",
        "dhcp_end": "192.0.2.10",
        "broker_hostname": "mqtt.aegis.invalid",
    }
    values.update(overrides)

    output_dir = tmp_path / values.pop("output_dir", "out")

    argv = [
        sys.executable,
        str(RENDERER),
        "render",
        "--interface", values["interface"],
        "--ssid-label", values["ssid_label"],
        "--channel", values["channel"],
        "--country", values["country"],
        "--ap-address", values["ap_address"],
        "--ap-subnet", values["ap_subnet"],
        "--dhcp-start", values["dhcp_start"],
        "--dhcp-end", values["dhcp_end"],
        "--broker-hostname", values["broker_hostname"],
        "--output-dir", str(output_dir),
    ]

    result = subprocess.run(
        argv,
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, output_dir


def rendered_tree(root: Path) -> dict[str, bytes]:
    if not root.exists():
        return {}
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_renderer_exists():
    assert RENDERER.is_file(), f"renderer missing: {RENDERER}"


def test_valid_render_is_deterministic_and_repository_safe(tmp_path):
    first, first_dir = render(tmp_path, output_dir="first")
    second, second_dir = render(tmp_path, output_dir="second")

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr

    first_tree = rendered_tree(first_dir)
    second_tree = rendered_tree(second_dir)

    assert first_tree
    assert first_tree == second_tree

    combined = b"\n".join(first_tree.values()).decode("utf-8")

    assert "<AEGIS_AP_PSK>" in combined
    assert "ipv4.method=shared" not in combined
    assert "method=shared" not in combined
    assert "table ip nat" not in combined
    assert "type nat hook" not in combined
    assert "masquerade" not in combined
    assert "type=bridge" not in combined
    assert "master=" not in combined


@pytest.mark.parametrize("channel", ["0", "14", "99", "-1"])
def test_rejects_unapproved_channel(tmp_path, channel):
    result, output_dir = render(tmp_path, channel=channel)

    assert result.returncode != 0
    assert rendered_tree(output_dir) == {}


@pytest.mark.parametrize("country", ["US", "th", "00", ""])
def test_requires_exact_th_country(tmp_path, country):
    result, output_dir = render(tmp_path, country=country)

    assert result.returncode != 0
    assert rendered_tree(output_dir) == {}


def test_rejects_ap_address_outside_subnet(tmp_path):
    result, output_dir = render(
        tmp_path,
        ap_address="198.51.100.1",
    )

    assert result.returncode != 0
    assert rendered_tree(output_dir) == {}


@pytest.mark.parametrize(
    ("dhcp_start", "dhcp_end"),
    [
        ("198.51.100.2", "192.0.2.10"),
        ("192.0.2.2", "198.51.100.10"),
        ("192.0.2.1", "192.0.2.10"),
        ("192.0.2.2", "192.0.2.1"),
        ("192.0.2.10", "192.0.2.2"),
    ],
)
def test_rejects_invalid_dhcp_range(tmp_path, dhcp_start, dhcp_end):
    result, output_dir = render(
        tmp_path,
        dhcp_start=dhcp_start,
        dhcp_end=dhcp_end,
    )

    assert result.returncode != 0
    assert rendered_tree(output_dir) == {}


@pytest.mark.parametrize(
    "broker_hostname",
    [
        "mqtt bad",
        "http://mqtt.aegis.invalid",
        "-mqtt.aegis.invalid",
        "mqtt_.aegis.invalid",
        "192.0.2.1",
    ],
)
def test_rejects_invalid_broker_hostname(tmp_path, broker_hostname):
    result, output_dir = render(
        tmp_path,
        broker_hostname=broker_hostname,
    )

    assert result.returncode != 0
    assert rendered_tree(output_dir) == {}


def test_refuses_non_empty_output_directory(tmp_path):
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    sentinel = output_dir / "KEEP"
    sentinel.write_text("do-not-overwrite\n")

    result, returned_dir = render(tmp_path)

    assert returned_dir == output_dir
    assert result.returncode != 0
    assert sentinel.read_text() == "do-not-overwrite\n"
    assert sorted(path.name for path in output_dir.iterdir()) == ["KEEP"]


def test_cli_does_not_accept_psk_argument():
    result = subprocess.run(
        [sys.executable, str(RENDERER), "render", "--help"],
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    help_text = result.stdout + result.stderr
    assert "--psk" not in help_text.lower()
    assert "--password" not in help_text.lower()


NM_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-ap.nmconnection.example"
)


def test_networkmanager_template_exists():
    assert NM_TEMPLATE.is_file(), f"NetworkManager template missing: {NM_TEMPLATE}"


def test_render_creates_private_ap_networkmanager_profile(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    profile = output_dir / "aegis-idea3-ap.nmconnection"
    assert profile.is_file()

    text = profile.read_text()

    assert "[connection]" in text
    assert "type=wifi" in text
    assert "interface-name=wlan-test0" in text

    assert "[wifi]" in text
    assert "mode=ap" in text
    assert "band=bg" in text
    assert "channel=6" in text
    assert "ssid=AEGIS_TEST" in text

    assert "[wifi-security]" in text
    assert "key-mgmt=wpa-psk" in text
    assert "psk=<AEGIS_AP_PSK>" in text

    assert "[ipv4]" in text
    assert "method=manual" in text
    assert "address1=192.0.2.1/28" in text
    assert "never-default=true" in text

    assert "[ipv6]" in text
    assert "method=disabled" in text


def test_networkmanager_profile_forbids_shared_bridge_and_default_route(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    profile = output_dir / "aegis-idea3-ap.nmconnection"
    text = profile.read_text().lower()

    assert "method=shared" not in text
    assert "type=bridge" not in text
    assert "slave-type=" not in text
    assert "master=" not in text
    assert "gateway1=" not in text
    assert "route1=" not in text


@pytest.mark.parametrize("channel", ["1", "6", "11", "13"])
def test_networkmanager_profile_uses_owner_selected_approved_channel(tmp_path, channel):
    result, output_dir = render(
        tmp_path,
        channel=channel,
        output_dir=f"channel-{channel}",
    )

    assert result.returncode == 0, result.stderr

    profile = output_dir / "aegis-idea3-ap.nmconnection"
    text = profile.read_text()

    assert f"channel={channel}" in text


def test_networkmanager_profile_does_not_embed_live_psk(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    profile = output_dir / "aegis-idea3-ap.nmconnection"
    text = profile.read_text()

    assert "<AEGIS_AP_PSK>" in text
    assert "psk=" + "<AEGIS_AP_PSK>" in text


DNSMASQ_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-dnsmasq.conf.example"
)

DNSMASQ_SERVICE_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-dnsmasq.service.example"
)


def test_dnsmasq_templates_exist():
    assert DNSMASQ_TEMPLATE.is_file(), f"dnsmasq template missing: {DNSMASQ_TEMPLATE}"
    assert DNSMASQ_SERVICE_TEMPLATE.is_file(), (
        f"dnsmasq service template missing: {DNSMASQ_SERVICE_TEMPLATE}"
    )


def test_render_creates_ap_scoped_dnsmasq_configuration(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    config = output_dir / "aegis-idea3-dnsmasq.conf"
    assert config.is_file()

    text = config.read_text()

    assert "interface=wlan-test0" in text
    assert "bind-interfaces" in text
    assert "dhcp-range=192.0.2.2,192.0.2.10,255.255.255.240" in text
    assert "dhcp-option=option:dns-server,192.0.2.1" in text


def test_dnsmasq_broker_name_is_core_local_only(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    config = output_dir / "aegis-idea3-dnsmasq.conf"
    text = config.read_text()

    assert "address=/mqtt.aegis.invalid/192.0.2.1" in text
    assert "no-resolv" in text

    assert "server=" not in text
    assert "resolv-file=" not in text


def test_dnsmasq_does_not_advertise_internet_router(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    config = output_dir / "aegis-idea3-dnsmasq.conf"
    text = config.read_text()

    # Empty router option deliberately suppresses a default gateway.
    assert "dhcp-option=option:router" in text

    lines = [line.strip() for line in text.splitlines()]
    router_lines = [
        line for line in lines
        if line.startswith("dhcp-option=option:router")
    ]
    assert router_lines == ["dhcp-option=option:router"]


def test_dnsmasq_artifacts_never_target_wired_uplink(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    combined = "\n".join(
        path.read_text()
        for path in sorted(output_dir.iterdir())
        if path.is_file()
    )

    assert "enp62s0" not in combined


def test_render_creates_dedicated_dnsmasq_service(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    service = output_dir / "aegis-idea3-dnsmasq.service"
    assert service.is_file()

    text = service.read_text()

    assert "[Service]" in text
    assert "/usr/bin/dnsmasq" in text
    assert "--keep-in-foreground" in text
    assert "--conf-file=/etc/aegis-idea3/dnsmasq-ap.conf" in text

    assert "systemctl start dnsmasq.service" not in text
    assert "systemctl restart dnsmasq.service" not in text
    assert "ExecStart=/usr/bin/dnsmasq.service" not in text


def test_dnsmasq_template_keeps_owner_values_unresolved():
    text = DNSMASQ_TEMPLATE.read_text()

    assert "<AEGIS_AP_INTERFACE>" in text
    assert "<AEGIS_DHCP_START>" in text
    assert "<AEGIS_DHCP_END>" in text
    assert "<AEGIS_AP_NETMASK>" in text
    assert "<AEGIS_AP_ADDRESS>" in text
    assert "<AEGIS_BROKER_HOSTNAME>" in text

    assert "enp62s0" not in text


NFT_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-nftables.conf.example"
)

NFT_SERVICE_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-nftables-load.service.example"
)

SYSCTL_TEMPLATE = (
    LOCKDOWN
    / "deploy"
    / "network"
    / "aegis-idea3-sysctl.conf.example"
)


def test_firewall_templates_exist():
    assert NFT_TEMPLATE.is_file(), f"nftables template missing: {NFT_TEMPLATE}"
    assert NFT_SERVICE_TEMPLATE.is_file(), (
        f"nftables loader template missing: {NFT_SERVICE_TEMPLATE}"
    )
    assert SYSCTL_TEMPLATE.is_file(), f"sysctl template missing: {SYSCTL_TEMPLATE}"


def test_render_creates_dedicated_idea3_firewall(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    firewall = output_dir / "aegis-idea3-nftables.conf"
    assert firewall.is_file()

    text = firewall.read_text()

    assert "table inet aegis_idea3" in text
    assert "wlan-test0" in text
    assert "192.0.2.0/28" in text


def test_ap_firewall_accepts_only_required_core_services(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (output_dir / "aegis-idea3-nftables.conf").read_text()

    assert 'iifname "wlan-test0" udp dport 67' in text
    assert 'iifname "wlan-test0" udp dport 53' in text
    assert 'iifname "wlan-test0" tcp dport 53' in text
    assert 'iifname "wlan-test0" udp dport 123' in text
    assert 'iifname "wlan-test0" tcp dport 8883' in text

    assert 'iifname "wlan-test0" tcp dport 1883' in text
    assert "drop" in text.lower()


def test_ap_firewall_has_explicit_plaintext_mqtt_drop(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    lines = [
        line.strip().lower()
        for line in (output_dir / "aegis-idea3-nftables.conf").read_text().splitlines()
    ]

    mqtt_1883 = [
        line for line in lines
        if 'iifname "wlan-test0"' in line
        and "tcp dport 1883" in line
    ]

    assert len(mqtt_1883) == 1
    assert mqtt_1883[0].endswith("drop")


def test_ap_firewall_drops_remaining_ap_input_and_forwarding(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (output_dir / "aegis-idea3-nftables.conf").read_text().lower()

    assert 'iifname "wlan-test0" drop' in text
    assert "chain forward" in text
    assert 'iifname "wlan-test0" drop' in text


def test_firewall_never_owns_nat_or_whole_host_ruleset(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (output_dir / "aegis-idea3-nftables.conf").read_text().lower()

    forbidden = (
        "flush ruleset",
        "destroy table inet filter",
        "table ip nat",
        "table inet nat",
        "type nat hook",
        "masquerade",
        "snat",
        "dnat",
    )

    for token in forbidden:
        assert token not in text


def test_nftables_source_template_owns_only_idea3_table():
    text = NFT_TEMPLATE.read_text().lower()

    assert "table inet aegis_idea3" in text
    assert "flush ruleset" not in text
    assert "destroy table inet filter" not in text
    assert "masquerade" not in text
    assert "table ip nat" not in text
    assert "table inet nat" not in text


def test_render_creates_dedicated_nftables_loader(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    service = output_dir / "aegis-idea3-nftables-load.service"
    assert service.is_file()

    text = service.read_text()

    assert "[Service]" in text
    assert "/usr/bin/nft" in text
    assert "/etc/aegis-idea3/aegis-idea3.nft" in text

    assert "/etc/nftables.conf" not in text
    assert "nftables.service" not in text
    assert "flush ruleset" not in text
    assert "destroy table inet filter" not in text


def test_firewall_loader_rollback_removes_only_idea3_table(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (
        output_dir / "aegis-idea3-nftables-load.service"
    ).read_text().lower()

    assert "delete table inet aegis_idea3" in text
    assert "flush ruleset" not in text
    assert "delete table inet filter" not in text


def test_sysctl_template_never_enables_forwarding():
    text = SYSCTL_TEMPLATE.read_text().lower()

    assert "net.ipv4.ip_forward = 0" in text
    assert "net.ipv6.conf.all.forwarding = 0" in text
    assert "net.ipv6.conf.default.forwarding = 0" in text
    assert "net.ipv6.conf.<aegis_ap_interface>.forwarding = 0" in text

    forwarding_lines = [
        line.strip()
        for line in text.splitlines()
        if "forward" in line and not line.strip().startswith("#")
    ]

    assert forwarding_lines
    assert all(
        line.endswith("= 0") or line.endswith("=0")
        for line in forwarding_lines
    )


def test_rendered_sysctl_keeps_ap_forwarding_disabled(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    sysctl = output_dir / "aegis-idea3-sysctl.conf"
    assert sysctl.is_file()

    text = sysctl.read_text().lower()

    assert "net.ipv4.ip_forward = 0" in text
    assert "wlan-test0" in text
    assert "= 1" not in text
    assert "=1" not in text


def _pf01_errors(text: str, interface: str) -> list[str]:
    lines = [line.strip().lower() for line in text.splitlines()]
    interface = interface.lower()

    try:
        start = lines.index("chain input {") + 1
    except ValueError:
        return ["input chain missing"]

    input_lines = []
    for line in lines[start:]:
        if line == "}":
            break
        input_lines.append(line)

    explicit_1883 = [
        (index, line)
        for index, line in enumerate(input_lines)
        if f'iifname "{interface}"' in line
        and "tcp dport 1883" in line
    ]

    errors = []

    if len(explicit_1883) != 1:
        errors.append("exactly one explicit AP TCP/1883 rule required")
    else:
        explicit_index, explicit_line = explicit_1883[0]

        if " accept" in f" {explicit_line}":
            errors.append("AP TCP/1883 must never be accepted")

        if not explicit_line.endswith("drop"):
            errors.append("AP TCP/1883 must explicitly drop")

        catch_all = [
            index
            for index, line in enumerate(input_lines)
            if line == f'iifname "{interface}" drop'
        ]

        if not catch_all:
            errors.append("AP catch-all drop missing")
        elif explicit_index >= catch_all[0]:
            errors.append("AP TCP/1883 drop must precede AP catch-all drop")

    forbidden = (
        "masquerade",
        "table ip nat",
        "table inet nat",
        "type nat hook",
        " snat",
        " dnat",
    )

    lowered = text.lower()
    for token in forbidden:
        if token in lowered:
            errors.append(f"forbidden firewall token: {token.strip()}")

    return errors


def test_pf01_rendered_ruleset_enforces_plaintext_mqtt_negative_control(tmp_path):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (output_dir / "aegis-idea3-nftables.conf").read_text()

    assert _pf01_errors(text, "wlan-test0") == []


@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        (
            "remove-1883",
            "exactly one explicit AP TCP/1883 rule required",
        ),
        (
            "accept-1883",
            "AP TCP/1883 must never be accepted",
        ),
        (
            "late-1883",
            "AP TCP/1883 drop must precede AP catch-all drop",
        ),
        (
            "add-nat",
            "forbidden firewall token: masquerade",
        ),
    ],
)
def test_pf01_proof_detects_broken_firewall_variants(
    tmp_path,
    mutation,
    expected_error,
):
    result, output_dir = render(tmp_path)

    assert result.returncode == 0, result.stderr

    text = (output_dir / "aegis-idea3-nftables.conf").read_text()

    explicit = 'iifname "wlan-test0" tcp dport 1883 drop'
    catch_all = 'iifname "wlan-test0" drop'

    if mutation == "remove-1883":
        text = text.replace(explicit, "")
    elif mutation == "accept-1883":
        text = text.replace(explicit, explicit.replace("drop", "accept"))
    elif mutation == "late-1883":
        text = text.replace(
            explicit + "\n        " + catch_all,
            catch_all + "\n        " + explicit,
        )
    elif mutation == "add-nat":
        text += "\nmasquerade\n"
    else:
        raise AssertionError(f"unknown mutation: {mutation}")

    errors = _pf01_errors(text, "wlan-test0")

    assert expected_error in errors


PF02_PROBE = LOCKDOWN / "tests" / "p4_pf02_dnsmasq_netns.py"


def test_pf02_dnsmasq_isolation_probe():
    assert PF02_PROBE.is_file(), f"PF-02 probe missing: {PF02_PROBE}"

    result = subprocess.run(
        [
            "/usr/bin/python3",
            str(PF02_PROBE),
        ],
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )

    output = result.stdout + result.stderr

    if "PF02_RESULT=ENVIRONMENT_UNAVAILABLE" in output:
        pytest.fail(
            "PF02_ENVIRONMENT_UNAVAILABLE: isolated namespace proof "
            "did not run; PF-02 remains open"
        )

    assert result.returncode == 0, output
    assert "PF02_RESULT=PASS" in output
    assert "PF02_DHCP_AP=PASS" in output
    assert "PF02_DHCP_UPLINK=NO_REPLY" in output
    assert "PF02_DNS_AP=PASS" in output
    assert "PF02_DNS_UPLINK=NO_REPLY" in output
    assert "PF02_REAL_INTERFACE_USE=NO" in output
    assert "PF02_CLEANUP=PASS" in output
