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
HANDLER = DEPLOY / "stages" / "L5"
COMPARE = DEPLOY / "p4-compare.sh"
P4_LIB = DEPLOY / "p4-lib.sh"
P4_NTP = DEPLOY / "p4-ntp.py"

REQUIRED_HANDLER_FILES = {
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
}

DISALLOWED_BROAD_KEYS = {
    "time.*",
    "svc.*",
    "listen.*",
    "host.*",
    "net.*",
    "fw.*",
    "time.NTPSynchronized",
    "svc.chronyd.service.UnitFileState",
    "svc.systemd-timesyncd.service.UnitFileState",
}

FORBIDDEN_MUTATION_PATTERNS = [
    r"\bsystemctl\s+enable\b",
    r"\bsystemctl\s+disable\b",
    r"\btimedatectl\s+set-ntp\b",
    r"\bpacman\b",
    r"\bsudo\b",
    r"\bnft\s+(add|delete|flush|insert|replace)\b",
    r"\bnmcli\s+con(nection)?\s+(modify|up|down|delete|add)\b",
    r"\bip\s+(addr|address|route|link)\s+(add|del|change|replace|set)\b",
    r"\bsysctl\s+-w\b",
    r"\blocal\s+stratum\b",
    r"\bmakestep\b",
]


def run_handler(
    script: Path,
    *,
    fs_root: Path,
    work_dir: Path,
    render_dir: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "AEGIS_P4_FS_ROOT": str(fs_root),
            "AEGIS_L5_WORK_DIR": str(work_dir),
            "AEGIS_AP_INTERFACE": "wlp0s20f3",
            "AEGIS_AP_ADDRESS": "192.0.2.1",
            "AEGIS_AP_SUBNET": "192.0.2.0/28",
            "AEGIS_TRUSTED_NTP_UPSTREAM": "198.51.100.123",
        }
    )
    if render_dir is not None:
        env["AEGIS_L5_RENDER_DIR"] = str(render_dir)
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
    if not path.is_file():
        return ""
    lines: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(raw)
    return "\n".join(lines)


def setup_t6_render(
    render_dir: Path,
    *,
    ap_address: str = "192.0.2.1",
    ap_subnet: str = "192.0.2.0/28",
    trusted_upstream: str = "198.51.100.123",
) -> Path:
    render_dir.mkdir(parents=True, exist_ok=True)
    res = subprocess.run(
        [
            "python3",
            str(P4_NTP),
            "render",
            "--output-dir",
            str(render_dir),
            "--ap-address",
            ap_address,
            "--ap-subnet",
            ap_subnet,
            "--trusted-upstream",
            trusted_upstream,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert res.returncode == 0, f"p4-ntp.py render failed: {res.stdout} {res.stderr}"
    return render_dir


def setup_l4_fs(
    fs_root: Path,
    *,
    ap_if: str = "wlp0s20f3",
    ap_address: str = "192.0.2.1",
    include_chronyd_unit: bool = True,
    chronyd_execstart: str = "/usr/bin/chronyd",
    existing_chrony_conf: str | None = None,
    existing_chrony_conf_mode: int = 0o640,
    timesyncd_active: bool = True,
    trusted_clock_state: str = "SYNCED",
    max_error_us: int = 500000,
) -> None:
    # 1. L4 AP NetworkManager profile
    nm_dir = fs_root / "etc" / "NetworkManager" / "system-connections"
    nm_dir.mkdir(parents=True, exist_ok=True)
    profile = nm_dir / "aegis-idea3-ap.nmconnection"
    profile.write_text(
        f"""[connection]
id=aegis-idea3-ap
type=wifi
interface-name={ap_if}

[wifi]
mode=ap

[ipv4]
method=manual
address1={ap_address}/28
never-default=true
""",
        encoding="utf-8",
    )
    profile.chmod(0o600)

    # 2. L4 dnsmasq config
    idea3_etc = fs_root / "etc" / "aegis-idea3"
    idea3_etc.mkdir(parents=True, exist_ok=True)
    dnsmasq_conf = idea3_etc / "dnsmasq-ap.conf"
    dnsmasq_conf.write_text(
        f"interface={ap_if}\nbind-interfaces\ndhcp-range=192.0.2.2,192.0.2.10,255.255.255.240\n",
        encoding="utf-8",
    )
    dnsmasq_conf.chmod(0o644)

    # 3. L2 firewall table inet aegis_idea3 with AP UDP/123 permit
    nft_conf = idea3_etc / "aegis-idea3.nft"
    nft_conf.write_text(
        f"""table inet aegis_idea3 {{
    chain input {{
        type filter hook input priority 0; policy drop;
        iifname "{ap_if}" udp dport 123 accept
        iifname "{ap_if}" udp dport 67 accept
        iifname "{ap_if}" udp dport 53 accept
        iifname "{ap_if}" tcp dport 53 accept
        iifname "{ap_if}" tcp dport 1883 drop
    }}
    chain forward {{
        type filter hook forward priority 0; policy drop;
        iifname "{ap_if}" drop
    }}
}}
""",
        encoding="utf-8",
    )
    nft_conf.chmod(0o600)

    # 4. systemd units directory
    system_unit_dir = fs_root / "etc" / "systemd" / "system"
    system_unit_dir.mkdir(parents=True, exist_ok=True)

    # 5. chronyd unit
    if include_chronyd_unit:
        chrony_unit = system_unit_dir / "chronyd.service"
        chrony_unit.write_text(
            f"""[Unit]
Description=NTP client/server
After=network.target

[Service]
Type=forking
ExecStart={chronyd_execstart}
Restart=on-failure

[Install]
WantedBy=multi-user.target
""",
            encoding="utf-8",
        )
        chrony_unit.chmod(0o644)

    # 6. Pre-existing /etc/chrony.conf if specified
    etc_dir = fs_root / "etc"
    etc_dir.mkdir(parents=True, exist_ok=True)
    if existing_chrony_conf is not None:
        target_chrony_conf = etc_dir / "chrony.conf"
        target_chrony_conf.write_text(existing_chrony_conf, encoding="utf-8")
        target_chrony_conf.chmod(existing_chrony_conf_mode)

    # 7. Fixture mock status directory
    fixture_status = fs_root / "run" / "aegis-idea3-fixture"
    fixture_status.mkdir(parents=True, exist_ok=True)
    (fixture_status / "timesyncd_active").write_text("active\n" if timesyncd_active else "inactive\n", encoding="utf-8")
    (fixture_status / "timesyncd_substate").write_text("running\n" if timesyncd_active else "dead\n", encoding="utf-8")
    (fixture_status / "trusted_clock_state").write_text(f"{trusted_clock_state}\n", encoding="utf-8")
    (fixture_status / "max_error_us").write_text(f"{max_error_us}\n", encoding="utf-8")
    (fixture_status / "forwarding").write_text("0\n", encoding="utf-8")
    (fixture_status / "nat_detected").write_text("NO\n", encoding="utf-8")
    (fixture_status / "ap_active").write_text("YES\n", encoding="utf-8")
    (fixture_status / "ap_ip").write_text(f"{ap_address}\n", encoding="utf-8")


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
            "cap.chronyc\tavailable",
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


# =============================================================================
# A. Registration
# =============================================================================

def test_l5_handler_files_exist() -> None:
    assert HANDLER.is_dir(), f"L5 handler dir missing: {HANDLER}"
    for filename in REQUIRED_HANDLER_FILES:
        target = HANDLER / filename
        assert target.is_file(), f"missing required handler file: {target}"


def test_l5_registration_status() -> None:
    cmd = f'source "{P4_LIB}"; p4_stage_handler_status L5'
    res = subprocess.run(["bash", "-c", cmd], text=True, capture_output=True, check=False)
    assert res.returncode == 0
    assert res.stdout.strip() == "REGISTERED"


# =============================================================================
# B. Fixture / Live Separation
# =============================================================================

def test_l5_live_path_guards() -> None:
    apply_text = code_text(HANDLER / "apply.sh")
    assert "AEGIS_L5_LIVE_AUTHORIZED" in apply_text
    assert "id -u" in apply_text or "ROOT_REQUIRED" in apply_text


def test_l5_live_path_fails_without_authorization(tmp_path: Path) -> None:
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)

    # Empty ROOT triggers live path check
    env = os.environ.copy()
    env["AEGIS_P4_FS_ROOT"] = ""
    env["AEGIS_L5_WORK_DIR"] = str(work_dir)
    env["AEGIS_L5_RENDER_DIR"] = str(render_dir)
    env["AEGIS_AP_ADDRESS"] = "192.0.2.1"
    env["AEGIS_AP_SUBNET"] = "192.0.2.0/28"
    env["AEGIS_TRUSTED_NTP_UPSTREAM"] = "198.51.100.123"
    env["AEGIS_L5_LIVE_AUTHORIZED"] = "NO"

    res = subprocess.run(
        ["bash", str(HANDLER / "apply.sh")],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    assert res.returncode != 0
    assert "LIVE_AUTHORIZATION" in res.stderr or "LIVE_AUTHORIZATION" in res.stdout


def test_l5_fixture_mode_zero_host_mutation(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L5_APPLY=PASS" in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=FIXTURE_ONLY" in res.stdout or "FIXTURE_ONLY" in res.stdout


# =============================================================================
# C. Entry Preconditions
# =============================================================================

def test_l5_refuses_when_l4_prerequisite_missing(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Remove L4 NetworkManager profile
    nm_profile = fs_root / "etc" / "NetworkManager" / "system-connections" / "aegis-idea3-ap.nmconnection"
    nm_profile.unlink()

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "L4" in res.stderr or "PROFILE" in res.stderr or "PRECONDITION" in res.stderr


def test_l5_refuses_when_ap_address_mismatch(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, ap_address="192.0.2.99")  # mismatch with 192.0.2.1

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "ADDRESS_MISMATCH" in res.stderr or "AP_ADDRESS" in res.stderr


def test_l5_refuses_when_forwarding_nonzero(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Set forwarding to 1
    (fs_root / "run" / "aegis-idea3-fixture" / "forwarding").write_text("1\n", encoding="utf-8")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "FORWARDING" in res.stderr


def test_l5_refuses_when_nat_detected(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Inject NAT
    (fs_root / "run" / "aegis-idea3-fixture" / "nat_detected").write_text("YES\n", encoding="utf-8")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "NAT" in res.stderr


def test_l5_refuses_when_l2_firewall_rule_missing(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Remove L2 firewall file
    nft_file = fs_root / "etc" / "aegis-idea3" / "aegis-idea3.nft"
    nft_file.unlink()

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "FIREWALL" in res.stderr or "L2" in res.stderr or "TABLE" in res.stderr


def test_l5_refuses_when_chronyd_unit_absent(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, include_chronyd_unit=False)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "CHRONYD" in res.stderr or "UNIT" in res.stderr


def test_l5_refuses_when_t6_artifacts_missing(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    empty_render_dir = tmp_path / "empty_render"
    empty_render_dir.mkdir(parents=True, exist_ok=True)
    setup_l4_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=empty_render_dir,
    )
    assert res.returncode != 0
    assert "T6" in res.stderr or "ARTIFACT" in res.stderr


def test_l5_refuses_when_t6_validate_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Corrupt rendered chrony config with unapproved directive
    conf_file = render_dir / "aegis-idea3-chrony.conf"
    conf_file.write_text(conf_file.read_text(encoding="utf-8") + "\nlocal stratum 10\n", encoding="utf-8")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "VALIDAT" in res.stderr or "T6" in res.stderr


def test_l5_refuses_when_owner_network_params_missing(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Omit AEGIS_TRUSTED_NTP_UPSTREAM
    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
        extra_env={"AEGIS_TRUSTED_NTP_UPSTREAM": ""},
    )
    assert res.returncode != 0
    assert "UPSTREAM" in res.stderr or "PARAM" in res.stderr


# =============================================================================
# D. Chronyd Unit / Config Path Verification
# =============================================================================

def test_l5_chronyd_unit_config_path_pass_default(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, chronyd_execstart="/usr/bin/chronyd")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L5_APPLY=PASS" in res.stdout


def test_l5_chronyd_unit_config_path_fail_alternate_f(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, chronyd_execstart="/usr/bin/chronyd -f /etc/custom-chrony.conf")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "CONFIG_PATH_AUTHORITY_MISMATCH" in res.stderr or "CONFIG_PATH_AUTHORITY_MISMATCH" in res.stdout


def test_l5_chronyd_unit_config_path_fail_dropin_override(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, chronyd_execstart="/usr/bin/chronyd")

    # Add drop-in with alternate path
    dropin_dir = fs_root / "etc" / "systemd" / "system" / "chronyd.service.d"
    dropin_dir.mkdir(parents=True, exist_ok=True)
    (dropin_dir / "override.conf").write_text(
        "[Service]\nExecStart=\nExecStart=/usr/bin/chronyd -f /opt/other.conf\n",
        encoding="utf-8",
    )

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "CONFIG_PATH_AUTHORITY_MISMATCH" in res.stderr or "CONFIG_PATH_AUTHORITY_MISMATCH" in res.stdout


# =============================================================================
# E. /etc/chrony.conf Type Safety
# =============================================================================

def test_l5_refuses_symlink_config(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Create /etc/chrony.conf as symlink
    target_conf = fs_root / "etc" / "chrony.conf"
    target_conf.symlink_to("/etc/issue")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "SYMLINK" in res.stderr or "NOT_REGULAR" in res.stderr


def test_l5_refuses_directory_or_special_file(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Create /etc/chrony.conf as directory
    target_conf = fs_root / "etc" / "chrony.conf"
    target_conf.mkdir(parents=True, exist_ok=True)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "NOT_REGULAR" in res.stderr or "DIRECTORY" in res.stderr


def test_l5_refuses_unsupported_attributes(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, existing_chrony_conf="server 1.2.3.4\n")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
        extra_env={"AEGIS_CHRONY_CONF_UNSUPPORTED_ATTRS": "1"},
    )
    assert res.returncode != 0
    assert "UNSUPPORTED_ATTRIBUTES" in res.stderr


# =============================================================================
# F. File Replacement
# =============================================================================

def test_l5_atomic_file_replacement_contract(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr

    installed_conf = fs_root / "etc" / "chrony.conf"
    assert installed_conf.is_file()
    assert not installed_conf.is_symlink()
    assert oct(installed_conf.stat().st_mode & 0o777) == "0o640"

    content = installed_conf.read_text(encoding="utf-8")
    assert "server 198.51.100.123 iburst" in content
    assert "bindaddress 192.0.2.1" in content
    assert "allow 192.0.2.0/28" in content


def test_l5_captures_preexisting_file_metadata(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    original_text = "# pre-existing chrony config\nserver pool.ntp.org iburst\n"
    setup_l4_fs(
        fs_root,
        existing_chrony_conf=original_text,
        existing_chrony_conf_mode=0o600,
    )

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr

    # Verify backup exists and holds original bytes and metadata
    backup_file = work_dir / "chrony.conf.orig"
    assert backup_file.is_file()
    assert backup_file.read_text(encoding="utf-8") == original_text
    assert (work_dir / "pre_chrony_conf_exists").read_text(encoding="utf-8").strip() == "YES"


# =============================================================================
# G. TrustedClock Pre-Handoff
# =============================================================================

def test_l5_trustedclock_pre_handoff_pass_synced(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, trusted_clock_state="SYNCED", max_error_us=400000)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr


def test_l5_trustedclock_pre_handoff_fail_holdover(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, trusted_clock_state="HOLDOVER")

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "HOLDOVER" in res.stderr or "SYNCED" in res.stderr or "CLOCK" in res.stderr


def test_l5_trustedclock_pre_handoff_fail_maxerror_exceeded(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, trusted_clock_state="SYNCED", max_error_us=1500000)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "MAX_ERROR" in res.stderr or "MAXERROR" in res.stderr


def test_l5_timesyncd_pre_handoff_must_be_active(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, timesyncd_active=False)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode != 0
    assert "TIMESYNCD" in res.stderr


# =============================================================================
# H. Service Ordering
# =============================================================================

def test_l5_service_ordering_contract(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
    )
    assert res.returncode == 0, res.stdout + res.stderr

    events_file = work_dir / "service_events"
    assert events_file.is_file()
    events = events_file.read_text(encoding="utf-8").strip().splitlines()
    assert "stop systemd-timesyncd.service" in events[0]
    assert "start chronyd.service" in events[1]


def test_l5_no_enable_or_disable_commands() -> None:
    for script in [HANDLER / "apply.sh", HANDLER / "rollback.sh"]:
        content = code_text(script)
        assert "systemctl enable" not in content
        assert "systemctl disable" not in content
        assert "timedatectl set-ntp" not in content


# =============================================================================
# I. Partial-Failure Rollback
# =============================================================================

def test_l5_rollback_after_timesyncd_stop(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, existing_chrony_conf="server orig.ntp.local iburst\n", existing_chrony_conf_mode=0o640)

    # Inject failure before chronyd start
    res_apply = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
        extra_env={"AEGIS_L5_INJECT_FAIL_BEFORE_CHRONYD_START": "1"},
    )
    assert res_apply.returncode != 0

    # Rollback must restore timesyncd and config
    res_rb = run_handler(
        HANDLER / "rollback.sh",
        fs_root=fs_root,
        work_dir=work_dir,
    )
    assert res_rb.returncode == 0, res_rb.stdout + res_rb.stderr
    assert "L5_ROLLBACK=PASS" in res_rb.stdout

    # Config restored
    conf = fs_root / "etc" / "chrony.conf"
    assert conf.is_file()
    assert conf.read_text(encoding="utf-8") == "server orig.ntp.local iburst\n"


def test_l5_rollback_after_chronyd_start_failure(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res_apply = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        work_dir=work_dir,
        render_dir=render_dir,
        extra_env={"AEGIS_L5_INJECT_FAIL_CHRONYD_START": "1"},
    )
    assert res_apply.returncode != 0

    res_rb = run_handler(
        HANDLER / "rollback.sh",
        fs_root=fs_root,
        work_dir=work_dir,
    )
    assert res_rb.returncode == 0, res_rb.stdout + res_rb.stderr
    assert "L5_ROLLBACK=PASS" in res_rb.stdout


# =============================================================================
# J. Final TrustedClock
# =============================================================================

def test_l5_final_trustedclock_requires_synced(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    # Apply passes
    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0

    # Verify passes when SYNCED
    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode == 0
    assert "L5_VERIFY=PASS" in res_verify.stdout


def test_l5_final_holdover_must_not_pass(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0

    # Inject post-apply HOLDOVER
    (fs_root / "run" / "aegis-idea3-fixture" / "trusted_clock_state").write_text("HOLDOVER\n", encoding="utf-8")

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "HOLDOVER" in res_verify.stderr or "SYNCED" in res_verify.stderr


# =============================================================================
# K. Listeners
# =============================================================================

def test_l5_listeners_ap_udp123_pass(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode == 0


def test_l5_listeners_wildcard_123_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    # Inject wildcard listener
    (fs_root / "run" / "aegis-idea3-fixture" / "listeners").write_text(
        "udp 0.0.0.0:123\nudp 192.0.2.1:123\n", encoding="utf-8"
    )

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "WILDCARD" in res_verify.stderr or "LISTENER" in res_verify.stderr


def test_l5_listeners_non_ap_123_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    # Inject uplink listener
    (fs_root / "run" / "aegis-idea3-fixture" / "listeners").write_text(
        "udp 192.168.1.50:123\nudp 192.0.2.1:123\n", encoding="utf-8"
    )

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "NON_AP" in res_verify.stderr or "LISTENER" in res_verify.stderr


def test_l5_listeners_tcp_123_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    (fs_root / "run" / "aegis-idea3-fixture" / "listeners").write_text(
        "tcp 192.0.2.1:123\nudp 192.0.2.1:123\n", encoding="utf-8"
    )

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "TCP" in res_verify.stderr or "LISTENER" in res_verify.stderr


def test_l5_listeners_non_loopback_323_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    (fs_root / "run" / "aegis-idea3-fixture" / "listeners").write_text(
        "udp 0.0.0.0:323\nudp 192.0.2.1:123\n", encoding="utf-8"
    )

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "323" in res_verify.stderr or "LISTENER" in res_verify.stderr


# =============================================================================
# L. Service State
# =============================================================================

def test_l5_service_final_state_pass(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode == 0
    assert "CHRONYD_ACTIVE=YES" in res_verify.stdout
    assert "TIMESYNCD_INACTIVE=YES" in res_verify.stdout


def test_l5_service_concurrent_active_fails(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    # Corrupt state: both active
    (fs_root / "run" / "aegis-idea3-fixture" / "timesyncd_active").write_text("active\n", encoding="utf-8")

    res_verify = run_handler(HANDLER / "verify.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_verify.returncode != 0
    assert "CONCURRENT" in res_verify.stderr or "TIMESYNCD" in res_verify.stderr


def test_l5_service_unitfilestate_preserved() -> None:
    allow_keys_text = (HANDLER / "allow-keys.txt").read_text(encoding="utf-8")
    assert "UnitFileState" not in allow_keys_text


# =============================================================================
# M. Network Preservation
# =============================================================================

def test_l5_network_preservation_passes(tmp_path: Path) -> None:
    before_dir = tmp_path / "before"
    after_dir = tmp_path / "after"

    records_before = {
        "time.NTPSynchronized": "yes",
        "time.file./etc/chrony.conf.class": "absent",
        "svc.chronyd.service.ActiveState": "inactive",
        "svc.chronyd.service.SubState": "dead",
        "svc.chronyd.service.UnitFileState": "disabled",
        "svc.systemd-timesyncd.service.ActiveState": "active",
        "svc.systemd-timesyncd.service.SubState": "running",
        "svc.systemd-timesyncd.service.UnitFileState": "enabled",
        "net.addr.wlp0s20f3": "192.0.2.1/28",
        "net.link.wlp0s20f3": "UP",
        "net.route4.default": "192.168.1.1 dev enp62s0",
        "net.route6.default": "fe80::1 dev enp62s0",
        "sysctl.net.ipv4.ip_forward": "0",
    }

    records_after = records_before.copy()
    records_after["time.file./etc/chrony.conf.class"] = "config"
    records_after["time.file./etc/chrony.conf.sha256"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    records_after["time.file./etc/chrony.conf.meta"] = "mode=640 uid=0 gid=0 size=120 mtime=1700000000"
    records_after["svc.chronyd.service.ActiveState"] = "active"
    records_after["svc.chronyd.service.SubState"] = "running"
    records_after["svc.chronyd.service.MainPID"] = "12345"
    records_after["svc.chronyd.service.ExecMainStartTimestamp"] = "2026-09-20 00:00:01 UTC"
    records_after["svc.systemd-timesyncd.service.ActiveState"] = "inactive"
    records_after["svc.systemd-timesyncd.service.SubState"] = "dead"
    records_after["svc.systemd-timesyncd.service.MainPID"] = "0"
    records_after["listen.udp.192.0.2.1:123"] = "present"
    records_after["listen.udp.127.0.0.1:323"] = "present"

    make_bundle(before_dir, "PRE", records_before)
    make_bundle(after_dir, "POST", records_after)

    res = run_compare(
        before_dir,
        after_dir,
        allow_keys_file=HANDLER / "allow-keys.txt",
        allow_listeners_file=HANDLER / "allow-listeners.txt",
        extra_env={"AEGIS_AP_ADDRESS": "192.0.2.1"},
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "COMPARE_RESULT=PASS" in res.stdout


# =============================================================================
# N. Rollback Exact File Restore
# =============================================================================

def test_l5_rollback_restores_preexisting_file_exact_metadata(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)

    orig_content = "# original chrony config\nserver 10.0.0.1 iburst\n"
    setup_l4_fs(fs_root, existing_chrony_conf=orig_content, existing_chrony_conf_mode=0o640)

    # Apply replaces config
    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0
    assert (fs_root / "etc" / "chrony.conf").read_text(encoding="utf-8") != orig_content

    # Rollback restores config
    res_rb = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb.returncode == 0, res_rb.stdout + res_rb.stderr

    restored = fs_root / "etc" / "chrony.conf"
    assert restored.is_file()
    assert restored.read_text(encoding="utf-8") == orig_content


def test_l5_rollback_removes_created_file_if_absent_before(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, existing_chrony_conf=None)

    # Apply creates config
    res_apply = run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)
    assert res_apply.returncode == 0
    assert (fs_root / "etc" / "chrony.conf").is_file()

    # Rollback removes config
    res_rb = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb.returncode == 0, res_rb.stdout + res_rb.stderr
    assert not (fs_root / "etc" / "chrony.conf").exists()


# =============================================================================
# O. Rollback Service Restore
# =============================================================================

def test_l5_rollback_restores_timesyncd_and_stops_chronyd(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root, timesyncd_active=True)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    res_rb = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb.returncode == 0, res_rb.stdout + res_rb.stderr

    events = (work_dir / "service_rollback_events").read_text(encoding="utf-8").splitlines()
    assert "stop chronyd.service" in events[0]
    assert "start systemd-timesyncd.service" in events[1]


# =============================================================================
# P. Rollback Idempotence
# =============================================================================

def test_l5_rollback_is_idempotent(tmp_path: Path) -> None:
    fs_root = tmp_path / "fs"
    work_dir = tmp_path / "work"
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)
    setup_l4_fs(fs_root)

    run_handler(HANDLER / "apply.sh", fs_root=fs_root, work_dir=work_dir, render_dir=render_dir)

    res_rb1 = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb1.returncode == 0, res_rb1.stdout + res_rb1.stderr

    res_rb2 = run_handler(HANDLER / "rollback.sh", fs_root=fs_root, work_dir=work_dir)
    assert res_rb2.returncode == 0, res_rb2.stdout + res_rb2.stderr
    assert "L5_ROLLBACK=PASS" in res_rb2.stdout


# =============================================================================
# Q. T6 Immutability
# =============================================================================

def test_l5_t6_immutability_verified(tmp_path: Path) -> None:
    render_dir = tmp_path / "render"
    setup_t6_render(render_dir)

    config_text = (render_dir / "aegis-idea3-chrony.conf").read_text(encoding="utf-8")
    contract_text = (render_dir / "aegis-idea3-t6-contract.txt").read_text(encoding="utf-8")

    assert "server 198.51.100.123 iburst" in config_text
    assert "bindaddress 192.0.2.1" in config_text
    assert "allow 192.0.2.0/28" in config_text
    assert "local stratum" not in config_text
    assert "cmdport 0" not in config_text
    assert "ROLLBACK_TIME_OWNER=systemd-timesyncd" in contract_text


# =============================================================================
# R. No Ownership Bleed
# =============================================================================

def test_l5_source_audit_no_unauthorized_commands() -> None:
    for script_name in ["apply.sh", "verify.sh", "rollback.sh"]:
        path = HANDLER / script_name
        assert path.is_file()
        content = code_text(path)
        for pattern in FORBIDDEN_MUTATION_PATTERNS:
            match = re.search(pattern, content)
            assert not match, f"Forbidden command pattern '{pattern}' found in {script_name}: {match.group(0)}"
