"""Static deployment contracts for the isolated IDEA3 AP; never applied by tests."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NTP = ROOT / "deploy/chrony/aegis-idea3-chrony.conf.example"
SYSCTL = ROOT / "deploy/network/aegis-idea3-sysctl.conf.example"
FIREWALL = ROOT / "deploy/network/aegis-idea3-nftables.conf.example"


def test_ntp_is_ap_bound_with_deferred_trusted_upstream():
    text = NTP.read_text(encoding="utf-8")
    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    assert "bindaddress <AEGIS_AP_ADDRESS>" in lines
    assert "allow <AEGIS_AP_SUBNET>" in lines

    server_lines = [line for line in lines if line.startswith("server ")]
    assert server_lines == ["server <AEGIS_TRUSTED_NTP_UPSTREAM> iburst"]
    assert not any(line.startswith("pool ") for line in lines)

    assert "0.0.0.0" not in text and "::" not in text


def test_forwarding_is_disabled_for_both_ip_families():
    text = SYSCTL.read_text(encoding="utf-8")
    assert "net.ipv4.ip_forward = 0" in text
    assert "net.ipv6.conf.all.forwarding = 0" in text
    assert "net.ipv6.conf.default.forwarding = 0" in text


def test_firewall_drops_ap_forwarding_and_has_no_nat_or_wired_acceptance():
    text = FIREWALL.read_text(encoding="utf-8")
    assert "chain forward {" in text

    forward = text.split("chain forward {", 1)[1]
    assert "hook forward" in forward
    assert "policy accept;" in forward
    assert 'iifname "<AEGIS_AP_INTERFACE>" drop' in forward

    assert "masquerade" not in text.lower()
    assert " snat " not in text.lower() and " dnat " not in text.lower()
    assert "<AEGIS_WIRED_INTERFACE>" not in text


def test_templates_keep_live_values_explicitly_deferred():
    combined = "\n".join(path.read_text(encoding="utf-8") for path in (NTP, SYSCTL, FIREWALL))
    assert "<AEGIS_AP_ADDRESS>" in combined
    assert "<AEGIS_AP_SUBNET>" in combined
    assert "<AEGIS_AP_INTERFACE>" in combined
    assert "192.168." not in combined and "10.0." not in combined and "172.16." not in combined
