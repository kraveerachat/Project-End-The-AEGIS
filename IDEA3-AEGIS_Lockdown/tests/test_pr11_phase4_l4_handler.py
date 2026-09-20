from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path
import pytest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HANDLER = DEPLOY / "stages" / "L4"
COMPARE = DEPLOY / "p4-compare.sh"

REQUIRED_HANDLER_FILES = {
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
}

DISALLOWED_BROAD_KEYS = {
    "nm.active",
    "nm.devices",
    "nm.general",
    "wifi.dev.sha256",
    "wifi.rfkill.wlan",
    "net.route4.sha256",
    "net.route6.sha256",
    "net.route4.default",
    "net.route6.default",
    "wlan-test0",
}


def run_handler(
    script: Path,
    *,
    fs_root: Path,
    work_dir: Path,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "AEGIS_P4_FS_ROOT": str(fs_root),
            "AEGIS_L4_WORK_DIR": str(work_dir),
            "AEGIS_AP_INTERFACE": "wlan-test0",
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_AP_SUBNET": "192.0.2.0/28",
            "AEGIS_DHCP_START": "192.0.2.2",
            "AEGIS_DHCP_END": "192.0.2.10",
            "AEGIS_BROKER_HOSTNAME": "mqtt.aegis.invalid",
        }
    )
    if extra_env:
        env.update(extra_env)

    return subprocess.run(
        ["bash", str(script)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def code_text(path: Path) -> str:
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(raw)
    return "\n".join(lines)


def setup_l3_fs(fs_root: Path, iface: str = "wlan-test0") -> Path:
    nm_dir = fs_root / "etc" / "NetworkManager" / "system-connections"
    nm_dir.mkdir(parents=True, exist_ok=True)
    profile = nm_dir / "aegis-idea3-ap.nmconnection"
    profile.write_text(
        f"""[connection]
id=aegis-idea3-ap
uuid=11111111-2222-3333-4444-555555555555
type=wifi
interface-name={iface}
autoconnect=false

[wifi]
mode=ap
band=bg
channel=6
ssid=AEGIS_TEST_SSID

[wifi-security]
key-mgmt=wpa-psk
psk=fixture-secret-psk-material-test

[ipv4]
method=disabled

[ipv6]
method=disabled
""",
        encoding="utf-8",
    )
    profile.chmod(0o600)

    idea3_etc = fs_root / "etc" / "aegis-idea3"
    idea3_etc.mkdir(parents=True, exist_ok=True)
    return profile


def make_bundle(
    dir_path: Path,
    label: str,
    records: dict[str, str],
    *,
    evidence_class: str = "TEST_FIXTURE",
) -> Path:
    dir_path.mkdir(parents=True, exist_ok=True)
    meta = {
        "meta.schema": "1",
        "meta.evidence_class": evidence_class,
        "meta.label": label,
        "meta.captured_at": "2026-09-20T00:00:00Z",
        "meta.capture_status": "COMPLETE",
        "meta.journal_since": "2026-09-17 00:00:00 UTC",
    }
    all_rec = {**meta, **records}

    categories = {
        "meta": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("meta.")],
        "cap": [
            "cap.ip\tavailable",
            "cap.sysctl\tavailable",
            "cap.nft\tavailable",
            "cap.ss\tavailable",
            "cap.systemctl\tavailable",
            "cap.journalctl\tavailable",
            "cap.df\tavailable",
            "cap.timedatectl\tavailable",
            "cap.nmcli\tavailable",
            "cap.iw\tavailable",
            "cap.rfkill\tavailable",
        ],
        "net": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("net.") or k.startswith("sysctl.")],
        "wifi": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("wifi.") or k.startswith("nm.")],
        "fw": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("fw.")],
        "time": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("time.") or k.startswith("svc.")],
        "mqtt": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("mqtt.") or k.startswith("listen.")],
        "idea2": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("idea2.")],
        "host": [f"{k}\t{v}" for k, v in all_rec.items() if k.startswith("host.") or k.startswith("disk.")],
    }

    default_idea2 = [
        "idea2.verdict.process_active\tYES",
        "idea2.verdict.tunnel_healthy\tNO_FAILURE_OBSERVED",
        "idea2.verdict.runtime_healthy\tNOT_PROVEN",
    ]
    if not any(k.startswith("idea2.verdict") for k in all_rec):
        categories["idea2"].extend(default_idea2)
    default_disk = ["disk.root.use_pct\t50"]
    if not any(k.startswith("disk.") for k in all_rec):
        categories["host"].extend(default_disk)

    for cat_name, lines in categories.items():
        tsv_file = dir_path / f"{cat_name}.tsv"
        content = "\n".join(sorted(lines)) + ("\n" if lines else "")
        tsv_file.write_text(content, encoding="utf-8")

    sha_lines = []
    for tsv in sorted(dir_path.glob("*.tsv")):
        h = hashlib.sha256(tsv.read_bytes()).hexdigest()
        sha_lines.append(f"{h}  {tsv.name}\n")
    (dir_path / "SHA256SUMS").write_text("".join(sha_lines), encoding="utf-8")
    return dir_path


def run_compare(
    before_dir: Path,
    after_dir: Path,
    *,
    allow_keys_file: Path | None = None,
    allow_listeners_file: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DISK_THRESHOLD_PCT"] = "90"
    if allow_keys_file is not None:
        env["ALLOW_KEYS_FILE"] = str(allow_keys_file)
    if allow_listeners_file is not None:
        env["ALLOW_LISTENERS_FILE"] = str(allow_listeners_file)
    if extra_env:
        env.update(extra_env)

    return subprocess.run(
        ["bash", str(COMPARE), str(before_dir), str(after_dir)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


# -----------------------------------------------------------------------------
# 1. Handler contract files
# -----------------------------------------------------------------------------
def test_l4_handler_files_exist() -> None:
    assert HANDLER.is_dir(), f"L4 handler dir missing: {HANDLER}"
    for filename in REQUIRED_HANDLER_FILES:
        target = HANDLER / filename
        assert target.is_file(), f"missing required handler file: {target}"


# -----------------------------------------------------------------------------
# 2. Live path requires auth flag, root, exact target wlp0s20f3
# -----------------------------------------------------------------------------
def test_l4_live_path_guards() -> None:
    apply_text = code_text(HANDLER / "apply.sh")
    assert "AEGIS_L4_LIVE_AUTHORIZED" in apply_text
    assert "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3" in apply_text
    assert "wlp0s20f3" in apply_text
    assert "id -u" in apply_text or "ROOT_REQUIRED" in apply_text


# -----------------------------------------------------------------------------
# 3. Fixture mode performs zero real host mutation
# -----------------------------------------------------------------------------
def test_l4_fixture_mode_zero_host_mutation(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    res = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L4_APPLY=PASS" in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY" in res.stdout


# -----------------------------------------------------------------------------
# 4. Refuses when L3 prerequisite state is missing
# -----------------------------------------------------------------------------
def test_l4_refuses_when_l3_prerequisite_missing(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    fs_root.mkdir(parents=True)

    res = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    assert res.returncode != 0
    assert "L3_PROFILE_MISSING" in res.stderr


# -----------------------------------------------------------------------------
# 5. Valid synthetic AP address / subnet accepted
# -----------------------------------------------------------------------------
def test_l4_accepts_valid_synthetic_network(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        extra_env={
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_AP_SUBNET": "192.0.2.0/28",
            "AEGIS_DHCP_START": "192.0.2.2",
            "AEGIS_DHCP_END": "192.0.2.14",
            "AEGIS_BROKER_HOSTNAME": "mqtt.aegis.invalid",
        },
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L4_APPLY=PASS" in res.stdout


# -----------------------------------------------------------------------------
# 6. Invalid / out-of-subnet / network / broadcast address rejected
# -----------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad_env,err_fragment",
    [
        ({"AEGIS_AP_ADDRESS": "192.0.2.0"}, "NETWORK_OR_BROADCAST"),
        ({"AEGIS_AP_ADDRESS": "192.0.2.15"}, "NETWORK_OR_BROADCAST"),
        ({"AEGIS_AP_ADDRESS": "10.0.0.1"}, "NOT_IN_SUBNET"),
        ({"AEGIS_DHCP_START": "192.0.2.1"}, "DHCP_RANGE_CONTAINS_CORE_AP"),
        ({"AEGIS_DHCP_START": "192.0.2.10", "AEGIS_DHCP_END": "192.0.2.5"}, "DHCP_START_GREATER_THAN_END"),
    ],
)
def test_l4_rejects_invalid_network_inputs(tmp_path: Path, bad_env: dict[str, str], err_fragment: str) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    res = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, extra_env=bad_env)
    assert res.returncode != 0
    assert err_fragment in res.stderr


# -----------------------------------------------------------------------------
# 7. Overlapping prohibited management/uplink network rejected
# -----------------------------------------------------------------------------
def test_l4_rejects_overlapping_management_network(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        extra_env={
            "AEGIS_EXISTING_NETWORKS": "198.51.100.0/24",
            "AEGIS_AP_SUBNET": "198.51.100.0/24",
            "AEGIS_AP_ADDRESS": "198.51.100.1",
            "AEGIS_DHCP_START": "198.51.100.2",
            "AEGIS_DHCP_END": "198.51.100.10",
        },
    )
    assert res.returncode != 0
    assert "MANAGEMENT_NETWORK_OVERLAP" in res.stderr

    work_dir2 = tmp_path / "work2"
    res2 = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir2,
        extra_env={
            "AEGIS_EXISTING_NETWORKS": "203.0.113.0/24",
            "AEGIS_AP_SUBNET": "192.0.2.0/28",
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_DHCP_START": "192.0.2.2",
            "AEGIS_DHCP_END": "192.0.2.10",
        },
    )
    assert res2.returncode == 0, res2.stderr


# -----------------------------------------------------------------------------
# 8. L4 never uses method=shared
# -----------------------------------------------------------------------------
def test_l4_never_uses_method_shared(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    profile = setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    content = profile.read_text(encoding="utf-8")
    assert "method=shared" not in content
    assert "shared" not in content


# -----------------------------------------------------------------------------
# 9. L4 never creates gateway/default route, NAT, bridge, forwarding
# -----------------------------------------------------------------------------
def test_l4_never_creates_forbidden_network_constructs(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    profile = setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    content = profile.read_text(encoding="utf-8")
    assert "gateway=" not in content
    assert "never-default=true" in content

    dnsmasq_conf = fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf"
    assert dnsmasq_conf.is_file()
    text = dnsmasq_conf.read_text(encoding="utf-8")
    assert "dhcp-option=option:router" in text
    assert not re.search(r"dhcp-option=option:router,[0-9]", text)


# -----------------------------------------------------------------------------
# 10. Fixture transition: L3 -> L4 manual address -> verify PASS
# -----------------------------------------------------------------------------
def test_l4_fixture_transition_and_verify_pass(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    profile = setup_l3_fs(fs_root)

    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_apply.returncode == 0, res_apply.stderr

    content = profile.read_text(encoding="utf-8")
    assert "method=manual" in content
    assert "address1=192.0.2.1/28" in content
    assert "never-default=true" in content
    assert "psk=fixture-secret-psk-material-test" in content

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode == 0, res_verify.stderr
    assert "L4_VERIFY=PASS" in res_verify.stdout


# -----------------------------------------------------------------------------
# 11. Fixture rollback: L4 -> exact L3 profile/addressing state
# -----------------------------------------------------------------------------
def test_l4_fixture_rollback_restores_l3_state(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    profile = setup_l3_fs(fs_root)
    original_l3 = profile.read_text(encoding="utf-8")

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    res_rb = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb.returncode == 0, res_rb.stderr
    assert "L4_ROLLBACK=PASS" in res_rb.stdout

    restored_text = profile.read_text(encoding="utf-8")
    assert restored_text == original_l3
    assert not (fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").exists()
    assert not (fs_root / "etc" / "systemd" / "system" / "aegis-idea3-dnsmasq.service").exists()


# -----------------------------------------------------------------------------
# 12. Repeated rollback is idempotent
# -----------------------------------------------------------------------------
def test_l4_repeated_rollback_is_idempotent(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    res_rb1 = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb1.returncode == 0
    res_rb2 = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb2.returncode == 0
    assert "L4_ROLLBACK=PASS" in res_rb2.stdout


# -----------------------------------------------------------------------------
# 13. Rollback does not delete L3 profile/radio ownership
# -----------------------------------------------------------------------------
def test_l4_rollback_does_not_delete_l3_profile(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    profile = setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert profile.is_file(), "L4 rollback must not delete L3 connection profile"


# -----------------------------------------------------------------------------
# 14. Unrelated file sentinel survives apply / rollback
# -----------------------------------------------------------------------------
def test_unrelated_sentinel_survives(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    sentinel1 = fs_root / "etc" / "aegis-idea3" / "unrelated-sentinel.txt"
    sentinel1.write_text("sentinel_data", encoding="utf-8")
    sentinel2 = fs_root / "etc" / "NetworkManager" / "system-connections" / "other.nmconnection"
    sentinel2.write_text("other_connection", encoding="utf-8")

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    assert sentinel1.read_text(encoding="utf-8") == "sentinel_data"
    assert sentinel2.read_text(encoding="utf-8") == "other_connection"

    run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert sentinel1.read_text(encoding="utf-8") == "sentinel_data"
    assert sentinel2.read_text(encoding="utf-8") == "other_connection"


# -----------------------------------------------------------------------------
# 15. Negative control: unrelated NetworkManager device drift fails
# -----------------------------------------------------------------------------
def test_unrelated_nm_device_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"nm.device.enp62s0.state": "connected"})
    a_dir = make_bundle(tmp_path / "a", "after", {"nm.device.enp62s0.state": "disconnected"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "NM_DEVICE_DRIFT" in res.stdout


# -----------------------------------------------------------------------------
# 16. Negative control: unrelated active connection drift fails
# -----------------------------------------------------------------------------
def test_unrelated_active_connection_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"nm.active.device.enp62s0": "wired"})
    a_dir = make_bundle(tmp_path / "a", "after", {"nm.active.device.enp62s0": "none"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "NM_ACTIVE_DRIFT" in res.stdout


# -----------------------------------------------------------------------------
# 17. Negative control: unrelated interface address drift fails
# -----------------------------------------------------------------------------
def test_unrelated_interface_address_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"net.addr.enp62s0": "192.168.20.50/24"})
    a_dir = make_bundle(tmp_path / "a", "after", {"net.addr.enp62s0": "192.168.20.99/24"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "INTERFACE_ADDRESS_DRIFT" in res.stdout


# -----------------------------------------------------------------------------
# 18. Protected control: default route drift fails and cannot be allowlisted
# -----------------------------------------------------------------------------
def test_default_route_drift_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"net.route4.default": "default via 192.168.20.1 dev enp62s0"})
    a_dir = make_bundle(tmp_path / "a", "after", {"net.route4.default": "default via 192.0.2.1 dev wlp0s20f3"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "DEFAULT_ROUTE_DRIFT" in res.stdout

    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("net.route4.default\n", encoding="utf-8")
    res_bad = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res_bad.returncode == 2
    assert "protected key cannot be approved" in res_bad.stdout


# -----------------------------------------------------------------------------
# 19. Protected control: DNS drift fails and cannot be allowlisted
# -----------------------------------------------------------------------------
def test_dns_drift_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"net.dns.nameservers": "127.0.0.53"})
    a_dir = make_bundle(tmp_path / "a", "after", {"net.dns.nameservers": "1.1.1.1"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "DNS_CONFIGURATION_DRIFT" in res.stdout


# -----------------------------------------------------------------------------
# 20. Protected control: forwarding drift fails and cannot be allowlisted
# -----------------------------------------------------------------------------
def test_forwarding_drift_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"sysctl.net.ipv4.ip_forward": "0"})
    a_dir = make_bundle(tmp_path / "a", "after", {"sysctl.net.ipv4.ip_forward": "1"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "FORWARDING_ENABLED" in res.stdout


# -----------------------------------------------------------------------------
# 21. Negative control: L2 firewall drift fails
# -----------------------------------------------------------------------------
def test_l2_firewall_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"fw.nft.tables": "table inet aegis_idea3"})
    a_dir = make_bundle(tmp_path / "a", "after", {"fw.nft.tables": "none"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "NFT_TABLE_SET_DRIFT" in res.stdout


# -----------------------------------------------------------------------------
# 22. Negative control: IDEA2 preservation drift fails
# -----------------------------------------------------------------------------
def test_idea2_preservation_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"idea2.listen.8077": "present"})
    a_dir = make_bundle(tmp_path / "a", "after", {"idea2.listen.8077": "<absent>"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "IDEA2_8077_LISTENER_REMOVED" in res.stdout


# -----------------------------------------------------------------------------
# 23. Positive control: exact target L4 address drift passes only with exact allow-keys
# -----------------------------------------------------------------------------
def test_exact_target_l4_drift_passes_with_allow_keys(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.addr.wlp0s20f3": "none",
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
            "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 size=250",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.class": "text",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.meta": "<absent>",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "<absent>",
            "svc.aegis-idea3-dnsmasq.service.LoadState": "not-found",
            "svc.aegis-idea3-dnsmasq.service.ActiveState": "inactive",
            "svc.aegis-idea3-dnsmasq.service.SubState": "dead",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.addr.wlp0s20f3": "192.0.2.1/28",
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "192.0.2.0/28 dev wlp0s20f3 proto kernel scope link src 192.0.2.1",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
            "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 size=300",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.class": "text",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.meta": "mode=644 size=200",
            "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "3333333333333333333333333333333333333333333333333333333333333333",
            "svc.aegis-idea3-dnsmasq.service.LoadState": "loaded",
            "svc.aegis-idea3-dnsmasq.service.ActiveState": "active",
            "svc.aegis-idea3-dnsmasq.service.SubState": "running",
            "listen.tcp.192.0.2.1:53": "present",
            "listen.udp.192.0.2.1:53": "present",
            "listen.udp.0.0.0.0%wlp0s20f3:67": "present",
        },
    )

    res = run_compare(
        b_dir,
        a_dir,
        allow_keys_file=HANDLER / "allow-keys.txt",
        allow_listeners_file=HANDLER / "allow-listeners.txt",
        extra_env={"AEGIS_AP_ADDRESS": "192.0.2.1", "AEGIS_AP_INTERFACE": "wlp0s20f3"},
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "COMPARE_RESULT=PASS" in res.stdout
    assert "DRIFT_RESULT=PASS" in res.stdout


# -----------------------------------------------------------------------------
# 24. No wlan-test0 key exists in Production allowlists
# -----------------------------------------------------------------------------
def test_no_wlan_test0_in_production_allowlists() -> None:
    keys = (HANDLER / "allow-keys.txt").read_text(encoding="utf-8")
    assert "wlan-test0" not in keys
    listeners = (HANDLER / "allow-listeners.txt").read_text(encoding="utf-8")
    assert "wlan-test0" not in listeners


# -----------------------------------------------------------------------------
# 25. No broad aggregate keys exist in Production allowlists
# -----------------------------------------------------------------------------
def test_no_broad_aggregate_keys_in_allowlist() -> None:
    keys = {
        line.strip()
        for line in (HANDLER / "allow-keys.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }
    assert (keys & DISALLOWED_BROAD_KEYS) == set()


# -----------------------------------------------------------------------------
# 26. DHCP dedicated config, no generic dnsmasq, empty router, PF-02 UDP/67
# -----------------------------------------------------------------------------
def test_dnsmasq_dhcp_dedicated_ap_scoped(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    conf = (fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert "interface=wlan-test0" in conf
    assert "bind-interfaces" in conf
    assert "dhcp-range=192.0.2.2,192.0.2.10,255.255.255.240" in conf
    assert "dhcp-option=option:router" in conf
    assert "enp62s0" not in conf

    service = (fs_root / "etc" / "systemd" / "system" / "aegis-idea3-dnsmasq.service").read_text(encoding="utf-8")
    assert "dnsmasq.service" not in service


# -----------------------------------------------------------------------------
# 27. Core-local DNS: no upstream forwarding, only broker mapping
# -----------------------------------------------------------------------------
def test_dnsmasq_core_local_dns(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    conf = (fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert "address=/mqtt.aegis.invalid/192.0.2.1" in conf
    assert "no-resolv" in conf
    assert "no-hosts" in conf
    assert "server=" not in conf


# -----------------------------------------------------------------------------
# 28. Plaintext MQTT 1883 remains explicitly dropped
# -----------------------------------------------------------------------------
def test_plaintext_1883_remains_dropped() -> None:
    nft_example = ROOT / "deploy" / "network" / "aegis-idea3-nftables.conf.example"
    text = nft_example.read_text(encoding="utf-8")
    assert "tcp dport 1883 drop" in text


# -----------------------------------------------------------------------------
# 29. L4 listener allowlist contains only justified exact listener drift
# -----------------------------------------------------------------------------
def test_listener_allowlist_contains_only_justified_drift() -> None:
    lines = [
        line.strip()
        for line in (HANDLER / "allow-listeners.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    expected = {
        "listen.tcp.<AEGIS_AP_ADDRESS>:53",
        "listen.udp.<AEGIS_AP_ADDRESS>:53",
        "listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67",
    }
    assert set(lines) == expected


# -----------------------------------------------------------------------------
# 30. Stage registration matrix
# -----------------------------------------------------------------------------
def test_stage_registration_status() -> None:
    lib_path = DEPLOY / "p4-lib.sh"
    cmd = f"""
source "{lib_path}"
for st in L2 L3 L4 L5 L6a L6b; do
  echo "$st $(p4_stage_handler_status $st)"
done
"""
    res = subprocess.run(["bash", "-c", cmd], text=True, capture_output=True, check=True)
    status_map = dict(line.split() for line in res.stdout.strip().splitlines())
    assert status_map["L2"] == "REGISTERED"
    assert status_map["L3"] == "REGISTERED"
    assert status_map["L4"] == "REGISTERED"
    assert status_map["L5"] == "REGISTERED"
    assert status_map["L6a"] == "NOT_REGISTERED"
    assert status_map["L6b"] == "REGISTERED"


# -----------------------------------------------------------------------------
# 31. Deterministic netmask derivation for non-/24 subnets (/28, /29)
# -----------------------------------------------------------------------------
def test_l4_derives_correct_netmask_for_non_24_subnets(tmp_path: Path) -> None:
    fs28 = tmp_path / "fs28"
    work28 = tmp_path / "work28"
    setup_l3_fs(fs28)
    res28 = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs28,
        work_dir=work28,
        extra_env={
            "AEGIS_AP_SUBNET": "192.0.2.0/28",
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_DHCP_START": "192.0.2.2",
            "AEGIS_DHCP_END": "192.0.2.14",
        },
    )
    assert res28.returncode == 0, res28.stderr
    conf28 = (fs28 / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert "dhcp-range=192.0.2.2,192.0.2.14,255.255.255.240" in conf28

    fs29 = tmp_path / "fs29"
    work29 = tmp_path / "work29"
    setup_l3_fs(fs29)
    res29 = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs29,
        work_dir=work29,
        extra_env={
            "AEGIS_AP_SUBNET": "192.0.2.0/29",
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_DHCP_START": "192.0.2.2",
            "AEGIS_DHCP_END": "192.0.2.6",
        },
    )
    assert res29.returncode == 0, res29.stderr
    conf29 = (fs29 / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert "dhcp-range=192.0.2.2,192.0.2.6,255.255.255.248" in conf29


# -----------------------------------------------------------------------------
# 32. No hardcoded Production management subnet in Production source/allowlists
# -----------------------------------------------------------------------------
def test_l4_no_hardcoded_management_subnet_in_production_source() -> None:
    for filename in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        text = (HANDLER / filename).read_text(encoding="utf-8")
        assert "192.168.20.0" not in text, f"Production file {filename} contains hardcoded management subnet"


# -----------------------------------------------------------------------------
# 33. Unrelated interface route drift fails compare (enp62s0)
# -----------------------------------------------------------------------------
def test_unrelated_interface_route_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.enp62s0": "198.51.100.0/24 dev enp62s0 proto kernel scope link",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.enp62s0": "198.51.100.0/24 dev enp62s0;10.0.0.0/8 dev enp62s0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "ROUTE_TABLE_DRIFT" in res.stdout
    assert "net.route4.iface.enp62s0" in res.stdout


# -----------------------------------------------------------------------------
# 34. New and changed default route drift fails compare
# -----------------------------------------------------------------------------
def test_new_and_changed_default_route_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b1",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a1",
        "after",
        {
            "net.route4.default": "default via 192.0.2.1 dev wlp0s20f3",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    res1 = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res1.returncode != 0
    assert "DEFAULT_ROUTE_DRIFT" in res1.stdout

    b_dir2 = make_bundle(
        tmp_path / "b2",
        "before",
        {
            "net.route4.default": "none",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir2 = make_bundle(
        tmp_path / "a2",
        "after",
        {
            "net.route4.default": "default via 192.0.2.1 dev wlp0s20f3",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    res2 = run_compare(b_dir2, a_dir2, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res2.returncode != 0
    assert "DEFAULT_ROUTE_DRIFT" in res2.stdout


# -----------------------------------------------------------------------------
# 35. Unrelated route-table drift without approved iface route fails compare
# -----------------------------------------------------------------------------
def test_unrelated_route_table_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.sha256": "3333333333333333333333333333333333333333333333333333333333333333",
        },
    )
    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "ROUTE_TABLE_DRIFT" in res.stdout
    assert "net.route4.sha256" in res.stdout


# -----------------------------------------------------------------------------
# 36. No broad route digest allowed in L4 allow-keys (and protected by compare)
# -----------------------------------------------------------------------------
def test_no_broad_route_digest_in_allow_keys(tmp_path: Path) -> None:
    keys = (HANDLER / "allow-keys.txt").read_text(encoding="utf-8")
    assert "net.route4.sha256" not in keys
    assert "net.route6.sha256" not in keys
    assert "net.route4.default" not in keys

    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("net.route4.sha256\n", encoding="utf-8")
    b_dir = make_bundle(tmp_path / "b", "before", {"net.addr.wlp0s20f3": "none"})
    a_dir = make_bundle(tmp_path / "a", "after", {"net.addr.wlp0s20f3": "none"})
    res = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res.returncode != 0
    assert "protected key cannot be approved: net.route4.sha256" in (res.stdout + res.stderr)


# -----------------------------------------------------------------------------
# 37. PF-02 listener policy negative controls (exact UDP/67 exception)
# -----------------------------------------------------------------------------
def test_pf02_listener_negative_controls(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {})
    a_dir = make_bundle(tmp_path / "a", "after", {})

    def check_listener_allow(listener_line: str, expected_err: str) -> None:
        al_file = tmp_path / f"al_{hashlib.md5(listener_line.encode()).hexdigest()[:8]}.txt"
        al_file.write_text(listener_line + "\n", encoding="utf-8")
        res = run_compare(
            b_dir,
            a_dir,
            allow_listeners_file=al_file,
            extra_env={"AEGIS_AP_INTERFACE": "wlp0s20f3"},
        )
        assert res.returncode != 0
        assert expected_err in (res.stdout + res.stderr)

    check_listener_allow("listen.udp.0.0.0.0:67", "wildcard listener cannot be approved")
    check_listener_allow("listen.udp.0.0.0.0%enp62s0:67", "wildcard listener cannot be approved")
    check_listener_allow("listen.tcp.0.0.0.0%wlp0s20f3:67", "wildcard listener cannot be approved")
    check_listener_allow("listen.udp.0.0.0.0%wlp0s20f3:53", "wildcard listener cannot be approved")
    check_listener_allow("listen.udp.0.0.0.0%wlp0s20f3:123", "wildcard listener cannot be approved")
    check_listener_allow("listen.tcp.192.0.2.1:1883", "plaintext 1883 listener cannot be approved")
    check_listener_allow("listen.udp.[::]%wlp0s20f3:67", "wildcard listener cannot be approved")


# -----------------------------------------------------------------------------
# 38. dnsmasq config and service contain no unauthorized directives
# -----------------------------------------------------------------------------
def test_dnsmasq_conf_contains_no_unauthorized_directives(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir)
    conf = (fs_root / "etc" / "aegis-idea3" / "dnsmasq-ap.conf").read_text(encoding="utf-8")
    assert "listen-address" not in conf
    assert "12h" not in conf
    assert "bogus-priv" not in conf
    assert "domain-needed" not in conf
    assert "server=" not in conf

    service = (fs_root / "etc" / "systemd" / "system" / "aegis-idea3-dnsmasq.service").read_text(encoding="utf-8")
    assert "User=" not in service
    assert "Group=" not in service
    assert "dnsmasq.service" not in service


# -----------------------------------------------------------------------------
# 39. PF-02 host vs fixture interface validation (no enp62s0 override on host)
# -----------------------------------------------------------------------------
def test_pf02_host_vs_fixture_interface_validation(tmp_path: Path) -> None:
    # 1. AEGIS_AP_INTERFACE=enp62s0 + host/real evidence + listen.udp.0.0.0.0%enp62s0:67 => STOP / FAIL
    b_host = make_bundle(tmp_path / "b_host", "before", {}, evidence_class="CORE_HOST_READ_ONLY")
    a_host_enp = make_bundle(
        tmp_path / "a_host_enp",
        "after",
        {"listen.udp.0.0.0.0%enp62s0:67": "present"},
        evidence_class="CORE_HOST_READ_ONLY",
    )
    al_enp = tmp_path / "al_enp.txt"
    al_enp.write_text("listen.udp.0.0.0.0%enp62s0:67\n", encoding="utf-8")
    res1 = run_compare(
        b_host,
        a_host_enp,
        allow_listeners_file=al_enp,
        extra_env={"AEGIS_AP_INTERFACE": "enp62s0"},
    )
    assert res1.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res1.stdout
    assert "wildcard listener cannot be approved" in (res1.stdout + res1.stderr)

    # Also test placeholder expansion with AEGIS_AP_INTERFACE=enp62s0 on host evidence
    al_placeholder = tmp_path / "al_placeholder.txt"
    al_placeholder.write_text("listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67\n", encoding="utf-8")
    res1_ph = run_compare(
        b_host,
        a_host_enp,
        allow_listeners_file=al_placeholder,
        extra_env={"AEGIS_AP_INTERFACE": "enp62s0"},
    )
    assert res1_ph.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res1_ph.stdout
    assert "wildcard listener cannot be approved" in (res1_ph.stdout + res1_ph.stderr)

    # 2. Real evidence + wlp0s20f3 UDP/67 => allowed ONLY when explicitly present in allow-listeners.txt
    a_host_wlp = make_bundle(
        tmp_path / "a_host_wlp",
        "after",
        {"listen.udp.0.0.0.0%wlp0s20f3:67": "present"},
        evidence_class="CORE_HOST_READ_ONLY",
    )
    al_wlp = tmp_path / "al_wlp.txt"
    al_wlp.write_text("listen.udp.0.0.0.0%wlp0s20f3:67\n", encoding="utf-8")
    res_wlp_ok = run_compare(b_host, a_host_wlp, allow_listeners_file=al_wlp)
    assert res_wlp_ok.returncode == 0
    assert "COMPARE_RESULT=PASS" in res_wlp_ok.stdout
    assert "IDEA3_LISTENER_APPROVED" in res_wlp_ok.stdout

    # When missing from allow-listeners.txt: fails
    al_empty = tmp_path / "al_empty.txt"
    al_empty.write_text("# no listeners\n", encoding="utf-8")
    res_wlp_fail = run_compare(b_host, a_host_wlp, allow_listeners_file=al_empty)
    assert res_wlp_fail.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res_wlp_fail.stdout
    assert "IDEA3_LISTENER_OUT_OF_SCOPE" in res_wlp_fail.stdout

    # 3. Fixture synthetic interface behavior may pass ONLY for TEST_FIXTURE
    b_fix = make_bundle(tmp_path / "b_fix", "before", {}, evidence_class="TEST_FIXTURE")
    a_fix = make_bundle(
        tmp_path / "a_fix",
        "after",
        {"listen.udp.0.0.0.0%wlan-test0:67": "present"},
        evidence_class="TEST_FIXTURE",
    )
    al_fix = tmp_path / "al_fix.txt"
    al_fix.write_text("listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67\n", encoding="utf-8")
    res_fix_ok = run_compare(
        b_fix,
        a_fix,
        allow_listeners_file=al_fix,
        extra_env={"AEGIS_AP_INTERFACE": "wlan-test0"},
    )
    assert res_fix_ok.returncode == 0
    assert "COMPARE_RESULT=PASS" in res_fix_ok.stdout

    # But synthetic interface fails if evidence is host/real
    a_host_syn = make_bundle(
        tmp_path / "a_host_syn",
        "after",
        {"listen.udp.0.0.0.0%wlan-test0:67": "present"},
        evidence_class="CORE_HOST_READ_ONLY",
    )
    res_host_syn_fail = run_compare(
        b_host,
        a_host_syn,
        allow_listeners_file=al_fix,
        extra_env={"AEGIS_AP_INTERFACE": "wlan-test0"},
    )
    assert res_host_syn_fail.returncode != 0
    assert "wildcard listener cannot be approved" in (res_host_syn_fail.stdout + res_host_syn_fail.stderr)


# -----------------------------------------------------------------------------
# 40. Simultaneous approved wlp0s20f3 route + unauthorized unscoped route fails
# -----------------------------------------------------------------------------
def test_simultaneous_approved_route_and_unauthorized_unscoped_drift_fails(tmp_path: Path) -> None:
    # BEFORE: no L4 AP connected route, no blackhole route
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.unscoped": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    # AFTER: expected connected route on wlp0s20f3 PLUS unauthorized blackhole/unscoped route
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "192.0.2.0/28 dev wlp0s20f3 proto kernel scope link src 192.0.2.1",
            "net.route4.unscoped": "blackhole 203.0.113.0/24",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    # L4 allow-keys includes only: net.route4.iface.wlp0s20f3
    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res.stdout
    assert "UNSCOPED_ROUTE_DRIFT" in res.stdout
    assert "net.route4.unscoped" in res.stdout
    assert "ROUTE_CHANGES_ACCOUNTED_BY_APPROVED_IFACE" not in res.stdout


# -----------------------------------------------------------------------------
# 41. Unscoped route alone fails compare
# -----------------------------------------------------------------------------
def test_unscoped_route_alone_fails_compare(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.unscoped": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.unscoped": "unreachable 198.51.100.0/24",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "COMPARE_RESULT=FAIL" in res.stdout
    assert "UNSCOPED_ROUTE_DRIFT" in res.stdout
    assert "net.route4.unscoped" in res.stdout


# -----------------------------------------------------------------------------
# 42. Target route alone passes compare with proper sha accounting
# -----------------------------------------------------------------------------
def test_target_route_alone_passes_compare(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "none",
            "net.route4.unscoped": "none",
            "net.route4.sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.route4.default": "default via 192.0.2.254 dev eth0",
            "net.route4.iface.wlp0s20f3": "192.0.2.0/28 dev wlp0s20f3 proto kernel scope link src 192.0.2.1",
            "net.route4.unscoped": "none",
            "net.route4.sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        },
    )
    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode == 0
    assert "COMPARE_RESULT=PASS" in res.stdout
    assert "ROUTE_CHANGES_ACCOUNTED_BY_APPROVED_IFACE" in res.stdout


# -----------------------------------------------------------------------------
# 43. Unscoped route key is protected against allow-keys
# -----------------------------------------------------------------------------
def test_unscoped_route_key_is_protected_against_allow_keys(tmp_path: Path) -> None:
    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("net.route4.unscoped\n", encoding="utf-8")
    b_dir = make_bundle(tmp_path / "b", "before", {})
    a_dir = make_bundle(tmp_path / "a", "after", {})
    res = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res.returncode != 0
    assert "protected key cannot be approved: net.route4.unscoped" in (res.stdout + res.stderr)


# -----------------------------------------------------------------------------
# Fixture helper for L2 firewall precondition testing
# -----------------------------------------------------------------------------
VALID_T5_NFT_TABLE = """table inet aegis_idea3 {
    chain input {
        type filter hook input priority filter; policy accept;

        # DHCP must also allow the pre-lease client state.
        iifname "wlp0s20f3" udp dport 67 accept

        iifname "wlp0s20f3" udp dport 53 ip saddr 192.0.2.0/28 accept
        iifname "wlp0s20f3" tcp dport 53 ip saddr 192.0.2.0/28 accept
        iifname "wlp0s20f3" udp dport 123 ip saddr 192.0.2.0/28 accept
        iifname "wlp0s20f3" tcp dport 8883 ip saddr 192.0.2.0/28 accept

        iifname "wlp0s20f3" tcp dport 1883 drop
        iifname "wlp0s20f3" drop
    }

    chain forward {
        type filter hook forward priority filter; policy accept;

        iifname "wlp0s20f3" drop
    }
}
"""


def setup_mock_firewall_env(
    tmp_path: Path,
    *,
    table_rules: str | None = VALID_T5_NFT_TABLE,
    all_tables: str = "table inet aegis_idea3\n",
    all_rules: str = "",
    forwarding_val: str = "0",
) -> tuple[Path, dict[str, str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    has_table = "1" if table_rules is not None else "0"
    rules_content = table_rules or ""
    nft_script = bin_dir / "nft"
    nft_script.write_text(
        f"""#!/usr/bin/env bash
cmd="$*"
if [[ "$cmd" == *"list table inet aegis_idea3"* ]]; then
  if [ "{has_table}" = "0" ]; then exit 1; fi
  cat <<'EOF'
{rules_content}
EOF
  exit 0
fi
if [[ "$cmd" == *"list tables"* ]]; then
  cat <<'EOF'
{all_tables}
EOF
  exit 0
fi
if [[ "$cmd" == *"list ruleset"* ]]; then
  cat <<'EOF'
{all_rules}
EOF
  exit 0
fi
exit 0
""",
        encoding="utf-8",
    )
    nft_script.chmod(0o755)

    sysctl_script = bin_dir / "sysctl"
    sysctl_script.write_text(
        f"""#!/usr/bin/env bash
if [[ "$*" == *"forward"* ]]; then
  echo "{forwarding_val}"
else
  echo "0"
fi
exit 0
""",
        encoding="utf-8",
    )
    sysctl_script.chmod(0o755)

    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "AEGIS_L4_FIREWALL_PRECONDITION_TEST": "1",
        "AEGIS_AP_INTERFACE": "wlp0s20f3",
    }
    return bin_dir, env


# -----------------------------------------------------------------------------
# 44. L2 firewall precondition: missing IDEA3 table fails
# -----------------------------------------------------------------------------
def test_l4_firewall_precondition_missing_table_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    _, extra = setup_mock_firewall_env(tmp_path, table_rules=None)
    res = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, extra_env=extra)
    assert res.returncode != 0
    assert "L4_APPLY=FAIL" in res.stderr
    assert "L2_FIREWALL_TABLE_MISSING" in res.stderr


# -----------------------------------------------------------------------------
# 45. L2 firewall precondition: missing DHCP and DNS permits fail
# -----------------------------------------------------------------------------
def test_l4_firewall_precondition_missing_dhcp_and_dns_permits_fail(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    # Missing DHCP permit
    no_dhcp = VALID_T5_NFT_TABLE.replace('iifname "wlp0s20f3" udp dport 67 accept', '')
    _, extra_no_dhcp = setup_mock_firewall_env(tmp_path / "dhcp", table_rules=no_dhcp)
    res_dhcp = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "1", extra_env=extra_no_dhcp)
    assert res_dhcp.returncode != 0
    assert "L4_APPLY=FAIL" in res_dhcp.stderr
    assert "L2_DHCP_PERMIT_MISSING" in res_dhcp.stderr

    # Missing DNS permit (UDP)
    no_dns_udp = VALID_T5_NFT_TABLE.replace('iifname "wlp0s20f3" udp dport 53 ip saddr 192.0.2.0/28 accept', '')
    _, extra_no_dns = setup_mock_firewall_env(tmp_path / "dns", table_rules=no_dns_udp)
    res_dns = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "2", extra_env=extra_no_dns)
    assert res_dns.returncode != 0
    assert "L4_APPLY=FAIL" in res_dns.stderr
    assert "L2_DNS_PERMIT_MISSING" in res_dns.stderr


# -----------------------------------------------------------------------------
# 46. L2 firewall precondition: missing 1883 drop and unexpected NAT fail
# -----------------------------------------------------------------------------
def test_l4_firewall_precondition_missing_1883_drop_and_unexpected_nat_fail(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    # Missing explicit 1883 drop
    no_1883 = VALID_T5_NFT_TABLE.replace('iifname "wlp0s20f3" tcp dport 1883 drop', '')
    _, extra_1883 = setup_mock_firewall_env(tmp_path / "1883", table_rules=no_1883)
    res_1883 = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "1", extra_env=extra_1883)
    assert res_1883.returncode != 0
    assert "L4_APPLY=FAIL" in res_1883.stderr
    assert "L2_1883_DROP_MISSING" in res_1883.stderr

    # Unexpected NAT / masquerade in table
    nat_table = VALID_T5_NFT_TABLE + "\nmasquerade\n"
    _, extra_nat = setup_mock_firewall_env(tmp_path / "nat", table_rules=nat_table)
    res_nat = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "2", extra_env=extra_nat)
    assert res_nat.returncode != 0
    assert "L4_APPLY=FAIL" in res_nat.stderr
    assert "UNEXPECTED_NAT_DETECTED" in res_nat.stderr

    # Unexpected NAT table in nft list tables
    _, extra_nat_tbl = setup_mock_firewall_env(
        tmp_path / "nat_tbl",
        table_rules=VALID_T5_NFT_TABLE,
        all_tables="table inet aegis_idea3\ntable ip nat\n",
    )
    res_nat_tbl = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "3", extra_env=extra_nat_tbl)
    assert res_nat_tbl.returncode != 0
    assert "L4_APPLY=FAIL" in res_nat_tbl.stderr
    assert "UNEXPECTED_NAT_DETECTED" in res_nat_tbl.stderr


# -----------------------------------------------------------------------------
# 47. L2 firewall precondition: forwarding enabled fails and valid contract passes
# -----------------------------------------------------------------------------
def test_l4_firewall_precondition_forwarding_and_valid_contract(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    setup_l3_fs(fs_root)

    # Forwarding enabled fails
    _, extra_fwd = setup_mock_firewall_env(tmp_path / "fwd", forwarding_val="1")
    res_fwd = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "1", extra_env=extra_fwd)
    assert res_fwd.returncode != 0
    assert "L4_APPLY=FAIL" in res_fwd.stderr
    assert "FORWARDING_NOT_ZERO" in res_fwd.stderr

    # Commented-out rule cannot satisfy check
    commented_dhcp = VALID_T5_NFT_TABLE.replace(
        'iifname "wlp0s20f3" udp dport 67 accept',
        '# iifname "wlp0s20f3" udp dport 67 accept',
    )
    _, extra_comment = setup_mock_firewall_env(tmp_path / "comment", table_rules=commented_dhcp)
    res_comment = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "2", extra_env=extra_comment)
    assert res_comment.returncode != 0
    assert "L4_APPLY=FAIL" in res_comment.stderr
    assert "L2_DHCP_PERMIT_MISSING" in res_comment.stderr

    # Valid contract passes on apply.sh
    _, extra_valid = setup_mock_firewall_env(tmp_path / "valid")
    res_valid = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir / "3", extra_env=extra_valid)
    assert res_valid.returncode == 0, res_valid.stdout + res_valid.stderr
    assert "L2_FIREWALL_PRECONDITIONS=PASS" in res_valid.stdout

    # Valid contract passes on verify.sh
    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir / "3", extra_env=extra_valid)
    assert res_verify.returncode == 0, res_verify.stdout + res_verify.stderr
    assert "L2_FIREWALL_PRECONDITIONS=PASS" in res_verify.stdout
