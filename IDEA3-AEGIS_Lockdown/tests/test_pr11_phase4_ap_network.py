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
