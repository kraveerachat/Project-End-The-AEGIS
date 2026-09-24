from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HANDLER = DEPLOY / "stages" / "L3"
COMPARE = DEPLOY / "p4-compare.sh"

REQUIRED_HANDLER_FILES = {
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
    "allow-transitions.txt",
}

DISALLOWED_BROAD_KEYS = {
    "nm.active",
    "nm.devices",
    "nm.general",
    "wifi.dev.sha256",
    "wifi.rfkill.wlan",
}


def run_handler(
    script: Path,
    *,
    fs_root: Path,
    work_dir: Path,
    psk_file: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "AEGIS_P4_FS_ROOT": str(fs_root),
            "AEGIS_L3_WORK_DIR": str(work_dir),
            "AEGIS_AP_INTERFACE": "wlan-test0",
            "AEGIS_AP_SSID": "AEGIS_TEST_SSID",
            "AEGIS_AP_CHANNEL": "6",
            "AEGIS_AP_COUNTRY": "TH",
        }
    )
    if psk_file is not None:
        env["AEGIS_AP_PSK_FILE"] = str(psk_file)
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


def make_bundle(
    dir_path: Path,
    label: str,
    records: dict[str, str],
) -> Path:
    dir_path.mkdir(parents=True, exist_ok=True)
    meta = {
        "meta.schema": "1",
        "meta.evidence_class": "TEST_FIXTURE",
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
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DISK_THRESHOLD_PCT"] = "90"
    if allow_keys_file is not None:
        env["ALLOW_KEYS_FILE"] = str(allow_keys_file)
    if allow_listeners_file is not None:
        env["ALLOW_LISTENERS_FILE"] = str(allow_listeners_file)

    return subprocess.run(
        ["bash", str(COMPARE), str(before_dir), str(after_dir)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def test_l3_handler_contract_files_exist() -> None:
    assert HANDLER.is_dir()
    actual = {path.name for path in HANDLER.iterdir() if path.is_file()}
    assert actual == REQUIRED_HANDLER_FILES


def test_l3_allow_listener_contract_is_empty() -> None:
    path = HANDLER / "allow-listeners.txt"
    active = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert active == []


def test_l3_allowlist_has_no_broad_aggregates() -> None:
    path = HANDLER / "allow-keys.txt"
    keys = {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    intersect = keys & DISALLOWED_BROAD_KEYS
    assert intersect == set(), f"broad aggregate keys in allow-keys: {intersect}"


def test_l3_allowlist_has_no_fixture_interface() -> None:
    path = HANDLER / "allow-keys.txt"
    content = path.read_text(encoding="utf-8")
    assert "wlan-test0" not in content


def test_l3_allow_keys_are_valid_and_non_protected() -> None:
    path = HANDLER / "allow-keys.txt"
    protected_pattern = re.compile(
        r"^(sysctl\.|idea2\.|net\.route[46]\.default|net\.dns|host\.|meta\.|cap\.|listen\.|disk\.|nm\.general$|wifi\.reg\.|wifi\.rfkill\..*\.(id|hard)$)"
    )

    keys = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert len(keys) > 0

    for key in keys:
        assert re.match(r"^[A-Za-z0-9@._:/\[\]-]+$", key), f"malformed key: {key}"
        assert not protected_pattern.match(key), f"protected key in allow-keys: {key}"


def test_l3_apply_has_fixture_and_live_authorization_guards() -> None:
    text = code_text(HANDLER / "apply.sh")

    assert "AEGIS_P4_FS_ROOT" in text
    assert "AEGIS_L3_LIVE_AUTHORIZED" in text
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in text
    assert "ROOT_REQUIRED" in text
    assert "NM_PARENT_DIR_REQUIRED" in text
    assert "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3" in text


def test_l3_apply_has_management_path_fail_closed_guards() -> None:
    text = code_text(HANDLER / "apply.sh")

    assert "AP_IF_HAS_DEFAULT_ROUTE" in text
    assert "NO_ALTERNATE_DEFAULT_ROUTE" in text
    assert "AP_IF_HAS_IPV4_ADDRESS" in text
    assert "AP_IF_ALREADY_CONNECTED" in text


def test_l3_apply_has_regulatory_and_channel_guards() -> None:
    text = code_text(HANDLER / "apply.sh")

    assert "REGULATORY_DOMAIN_MISMATCH" in text + code_text(DEPLOY / "p4-l3-regulatory.sh")
    assert "l3_reg_gate" in text
    assert "AP_CHANNEL_INVALID" in text
    assert re.search(r"\biw\s+reg\s+set\b", text) is None


def test_l3_apply_has_target_rfkill_isolation() -> None:
    text = code_text(HANDLER / "apply.sh")

    helper = code_text(DEPLOY / "p4-l3-rfkill.sh")
    assert "l3_rfkill_prepare" in text
    assert "RFKILL_HARD_BLOCKED" in helper
    assert re.search(r"\brfkill\s+unblock\s+wifi\b", text + helper) is None
    assert re.search(r"rfkill\s+unblock\s+[\"']?\$", helper) is not None


def test_l3_handlers_never_enable_shared_routing_nat_bridge() -> None:
    combined = "\n".join(
        code_text(HANDLER / name)
        for name in ("apply.sh", "verify.sh", "rollback.sh")
    )

    forbidden = (
        r"method=shared",
        r"\baddress1\b",
        r"\bmasquerade\b",
        r"\bsnat\b",
        r"\bdnat\b",
        r"\bbrctl\b",
        r"ip\s+link\s+add.*\bbridge\b",
        r"flush\s+ruleset",
    )

    for pattern in forbidden:
        assert re.search(pattern, combined, re.IGNORECASE) is None, pattern


def test_l3_secret_handling_rejects_insecure_permissions(tmp_path: Path) -> None:
    fs_root = tmp_path / "root"
    work_dir = tmp_path / "work"

    insecure_psk = tmp_path / "psk_insecure.txt"
    insecure_psk.write_text("insecure-psk-passphrase-test\n", encoding="utf-8")
    insecure_psk.chmod(0o644)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        psk_file=insecure_psk,
    )
    assert res.returncode != 0
    assert "PSK_FILE_PERMISSIONS_INSECURE" in res.stderr + res.stdout


def test_unrelated_network_manager_device_state_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"nm.device.enp62s0.state": "connected"})
    a_dir = make_bundle(tmp_path / "a", "after", {"nm.device.enp62s0.state": "disconnected"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "NM_DEVICE_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout


def test_unrelated_active_connection_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"nm.active.device.enp62s0": "wired:802-3-ethernet"})
    a_dir = make_bundle(tmp_path / "a", "after", {"nm.active.device.enp62s0": "none"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "NM_ACTIVE_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout


def test_unrelated_wifi_interface_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"wifi.iface.wlan1.type": "managed"})
    a_dir = make_bundle(tmp_path / "a", "after", {"wifi.iface.wlan1.type": "AP"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "WIFI_STATE_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout


def test_unrelated_rfkill_soft_state_drift_fails(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"wifi.rfkill.iface.wlan1.soft": "blocked"})
    a_dir = make_bundle(tmp_path / "a", "after", {"wifi.rfkill.iface.wlan1.soft": "unblocked"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "RFKILL_STATE_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout


def test_target_hard_rfkill_drift_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"wifi.rfkill.iface.wlp0s20f3.hard": "unblocked"})
    a_dir = make_bundle(tmp_path / "a", "after", {"wifi.rfkill.iface.wlp0s20f3.hard": "blocked"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "RFKILL_HARD_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout

    # Verify protected status: cannot be approved in allow-keys
    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("wifi.rfkill.iface.wlp0s20f3.hard\n", encoding="utf-8")
    res_bad = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res_bad.returncode == 2
    assert "STOP" in res_bad.stdout
    assert "protected key cannot be approved" in res_bad.stdout


def test_target_regulatory_drift_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"wifi.reg.global": "00"})
    a_dir = make_bundle(tmp_path / "a", "after", {"wifi.reg.global": "US"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "REGULATORY_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout

    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("wifi.reg.global\n", encoding="utf-8")
    res_bad = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res_bad.returncode == 2
    assert "STOP" in res_bad.stdout
    assert "protected key cannot be approved" in res_bad.stdout


def test_dns_drift_still_fails_and_is_protected(tmp_path: Path) -> None:
    b_dir = make_bundle(tmp_path / "b", "before", {"net.dns.nameservers": "127.0.0.53"})
    a_dir = make_bundle(tmp_path / "a", "after", {"net.dns.nameservers": "1.1.1.1"})

    res = run_compare(b_dir, a_dir, allow_keys_file=HANDLER / "allow-keys.txt")
    assert res.returncode != 0
    assert "DNS_CONFIGURATION_DRIFT" in res.stdout
    assert "COMPARE_RESULT=FAIL" in res.stdout

    bad_allow = tmp_path / "bad-allow.txt"
    bad_allow.write_text("net.dns.nameservers\n", encoding="utf-8")
    res_bad = run_compare(b_dir, a_dir, allow_keys_file=bad_allow)
    assert res_bad.returncode == 2
    assert "STOP" in res_bad.stdout
    assert "protected key cannot be approved" in res_bad.stdout


def test_target_specific_l3_expected_drift_passes_with_l3_allow_keys(tmp_path: Path) -> None:
    b_dir = make_bundle(
        tmp_path / "b",
        "before",
        {
            "net.link.wlp0s20f3": "DOWN",
            "nm.active.device.wlp0s20f3": "none",
            "nm.device.wlp0s20f3.state": "unavailable",
            "wifi.iface.wlp0s20f3.type": "managed",
            "wifi.rfkill.iface.wlp0s20f3.soft": "blocked",
            "wifi.rfkill.iface.wlp0s20f3.hard": "unblocked",
        },
    )
    a_dir = make_bundle(
        tmp_path / "a",
        "after",
        {
            "net.link.wlp0s20f3": "UP",
            "nm.active.device.wlp0s20f3": "aegis-idea3-ap:wifi",
            "nm.device.wlp0s20f3.state": "connected",
            "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.class": "secret-metadata-only",
            "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 uid=0 gid=0 size=250 mtime=12345",
            "wifi.iface.wlp0s20f3.channel": "6 2437 MHz",
            "wifi.iface.wlp0s20f3.ssid": "AEGIS_LOCKDOWN",
            "wifi.iface.wlp0s20f3.type": "AP",
            "wifi.rfkill.iface.wlp0s20f3.soft": "unblocked",
            "wifi.rfkill.iface.wlp0s20f3.hard": "unblocked",
        },
    )

    res = run_compare(
        b_dir,
        a_dir,
        allow_keys_file=HANDLER / "allow-keys.txt",
        allow_listeners_file=HANDLER / "allow-listeners.txt",
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "COMPARE_RESULT=PASS" in res.stdout
    assert "DRIFT_RESULT=PASS" in res.stdout


def test_l3_fixture_apply_verify_rollback_roundtrip(tmp_path: Path) -> None:
    fs_root = tmp_path / "root"
    work_dir = tmp_path / "work"

    psk_file = tmp_path / "psk.txt"
    psk_file.write_text("valid-secret-psk-fixture-value\n", encoding="utf-8")
    psk_file.chmod(0o600)

    sentinel = fs_root / "etc" / "unrelated.conf"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("KEEP\n", encoding="utf-8")

    nm_dir = fs_root / "etc" / "NetworkManager" / "system-connections"
    nm_dir.mkdir(parents=True)

    apply_result = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        psk_file=psk_file,
    )

    assert apply_result.returncode == 0, (
        apply_result.stdout + apply_result.stderr
    )
    assert "L3_APPLY=PASS" in apply_result.stdout

    profile = nm_dir / "aegis-idea3-ap.nmconnection"
    assert profile.is_file()

    file_mode = stat.S_IMODE(profile.stat().st_mode)
    assert file_mode == 0o600

    content = profile.read_text(encoding="utf-8")
    assert "mode=ap" in content
    assert "band=bg" in content
    assert "channel=6" in content
    assert "ssid=AEGIS_TEST_SSID" in content
    assert "valid-secret-psk-fixture-value" in content
    assert "ipv4" in content
    assert "method=disabled" in content
    assert "ipv6" in content
    assert "shared" not in content
    assert "address1" not in content
    assert "gateway" not in content
    assert "dns" not in content

    verify_result = run_handler(
        HANDLER / "verify.sh",
        fs_root=fs_root,
        work_dir=work_dir,
    )

    assert verify_result.returncode == 0, (
        verify_result.stdout + verify_result.stderr
    )
    assert "L3_VERIFY=PASS" in verify_result.stdout

    rollback_result = run_handler(
        HANDLER / "rollback.sh",
        fs_root=fs_root,
        work_dir=work_dir,
    )

    assert rollback_result.returncode == 0, (
        rollback_result.stdout + rollback_result.stderr
    )
    assert "L3_ROLLBACK=PASS" in rollback_result.stdout

    assert not profile.exists()
    assert sentinel.read_text(encoding="utf-8") == "KEEP\n"

    rollback_repeat = run_handler(
        HANDLER / "rollback.sh",
        fs_root=fs_root,
        work_dir=work_dir,
    )
    assert rollback_repeat.returncode == 0
    assert "L3_ROLLBACK=PASS" in rollback_repeat.stdout
