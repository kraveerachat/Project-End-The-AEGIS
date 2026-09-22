from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HANDLER = DEPLOY / "stages" / "L2"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
RENDERER = DEPLOY / "p4-ap-network.py"

REQUIRED_HANDLER_FILES = {
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
}


def render_t5_material(tmp_path: Path) -> Path:
    output = tmp_path / "rendered"

    result = subprocess.run(
        [
            sys.executable,
            str(RENDERER),
            "render",
            "--interface",
            "wlan-test0",
            "--ssid-label",
            "AEGIS_TEST",
            "--channel",
            "6",
            "--country",
            "TH",
            "--ap-address",
            "192.0.2.1",
            "--ap-subnet",
            "192.0.2.0/28",
            "--dhcp-start",
            "192.0.2.2",
            "--dhcp-end",
            "192.0.2.10",
            "--broker-hostname",
            "mqtt.aegis.invalid",
            "--output-dir",
            str(output),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    return output


def run_handler(
    script: Path,
    *,
    fs_root: Path,
    render_dir: Path,
    work_dir: Path,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(
        {
            "AEGIS_P4_FS_ROOT": str(fs_root),
            "AEGIS_L2_RENDER_DIR": str(render_dir),
            "AEGIS_L2_WORK_DIR": str(work_dir),
            "AEGIS_AP_INTERFACE": "wlan-test0",
        }
    )

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


def test_l2_handler_contract_files_exist() -> None:
    assert HANDLER.is_dir()

    actual = {
        path.name
        for path in HANDLER.iterdir()
        if path.is_file()
    }

    assert actual == REQUIRED_HANDLER_FILES


def test_l0_capture_tracks_l2_persistence_unit() -> None:
    text = CAPTURE.read_text(encoding="utf-8")

    assert "aegis-idea3-nftables-load.service" in text


def test_l2_allow_listener_contract_is_empty() -> None:
    path = HANDLER / "allow-listeners.txt"

    active = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    assert active == []


def test_l2_apply_has_fixture_and_live_authorization_guards() -> None:
    text = code_text(HANDLER / "apply.sh")

    assert "AEGIS_P4_FS_ROOT" in text
    assert "AEGIS_L2_LIVE_AUTHORIZED" in text
    assert "LIVE_AUTHORIZATION_FLAG_REQUIRED" in text
    assert "ROOT_REQUIRED" in text
    assert "IDEA3_PARENT_DIR_REQUIRED" in text


def test_l2_live_apply_requires_existing_non_symlink_parent_directory() -> None:
    text = code_text(HANDLER / "apply.sh")

    match = re.search(
        r'if\s+\[\s+-z\s+"\$ROOT"\s*\];\s*then(.*?)\bfi\b',
        text,
        re.DOTALL,
    )
    assert match is not None
    live_block = match.group(1)

    assert "IDEA3_PARENT_DIR_REQUIRED" in live_block
    assert re.search(
        r'\[\s+-d\s+["\']?/etc/aegis-idea3["\']?\s*\]\s*&&\s*\[\s*!\s+-L\s+["\']?/etc/aegis-idea3["\']?\s*\]',
        live_block,
    ) is not None


def test_l2_handlers_never_flush_ruleset_or_create_nat_bridge() -> None:
    combined = "\n".join(
        code_text(HANDLER / name)
        for name in ("apply.sh", "verify.sh", "rollback.sh")
    )

    forbidden = (
        r"flush\s+ruleset",
        r"\bmasquerade\b",
        r"\bsnat\b",
        r"\bdnat\b",
        r"\bbrctl\b",
        r"ip\s+link\s+add.*\bbridge\b",
    )

    for pattern in forbidden:
        assert re.search(pattern, combined, re.IGNORECASE) is None, pattern


def test_l2_fixture_apply_verify_rollback_roundtrip(tmp_path: Path) -> None:
    render_dir = render_t5_material(tmp_path)

    fs_root = tmp_path / "root"
    work_dir = tmp_path / "work"

    sentinel = fs_root / "etc" / "unrelated.conf"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("KEEP\n", encoding="utf-8")

    apply_result = run_handler(
        HANDLER / "apply.sh",
        fs_root=fs_root,
        render_dir=render_dir,
        work_dir=work_dir,
    )

    assert apply_result.returncode == 0, (
        apply_result.stdout + apply_result.stderr
    )
    assert "L2_APPLY=PASS" in apply_result.stdout

    nft = fs_root / "etc/aegis-idea3/aegis-idea3.nft"
    unit = (
        fs_root
        / "etc/systemd/system/aegis-idea3-nftables-load.service"
    )
    sysctl = (
        fs_root
        / "etc/sysctl.d/90-aegis-idea3-forwarding.conf"
    )

    assert nft.is_file()
    assert unit.is_file()
    assert sysctl.is_file()

    assert "table inet aegis_idea3" in nft.read_text(encoding="utf-8")
    assert "flush ruleset" not in nft.read_text(encoding="utf-8").lower()
    assert "masquerade" not in nft.read_text(encoding="utf-8").lower()

    verify_result = run_handler(
        HANDLER / "verify.sh",
        fs_root=fs_root,
        render_dir=render_dir,
        work_dir=work_dir,
    )

    assert verify_result.returncode == 0, (
        verify_result.stdout + verify_result.stderr
    )
    assert "L2_VERIFY=PASS" in verify_result.stdout

    rollback_result = run_handler(
        HANDLER / "rollback.sh",
        fs_root=fs_root,
        render_dir=render_dir,
        work_dir=work_dir,
    )

    assert rollback_result.returncode == 0, (
        rollback_result.stdout + rollback_result.stderr
    )
    assert "L2_ROLLBACK=PASS" in rollback_result.stdout

    assert not nft.exists()
    assert not unit.exists()
    assert not sysctl.exists()

    assert sentinel.read_text(encoding="utf-8") == "KEEP\n"


CONTAINMENT_ARTIFACTS = (
    "etc/systemd/system/aegis-idea3-containment.socket",
    "etc/systemd/system/aegis-idea3-containment.service",
    "etc/aegis-idea3/containment.env",
)


def test_renderer_emits_containment_helper_material(tmp_path: Path) -> None:
    render_dir = render_t5_material(tmp_path)

    socket_unit = (render_dir / "aegis-idea3-containment.socket").read_text(encoding="utf-8")
    service_unit = (render_dir / "aegis-idea3-containment.service").read_text(encoding="utf-8")
    env = (render_dir / "aegis-idea3-containment.env").read_text(encoding="utf-8")
    nft = (render_dir / "aegis-idea3-nftables.conf").read_text(encoding="utf-8")

    assert "ListenStream=/run/aegis-idea3-containment/containment.sock" in socket_unit
    assert "CapabilityBoundingSet=CAP_NET_ADMIN" in service_unit
    assert "AEGIS_CONTAINMENT_PROTECTED_CIDRS=192.0.2.0/28" in env.splitlines()
    assert "set blocked_ipv4 {" in nft
    assert "ip saddr @blocked_ipv4 drop" in nft


def test_l2_owns_containment_unit_lifecycle() -> None:
    apply_text = code_text(HANDLER / "apply.sh")
    verify_text = code_text(HANDLER / "verify.sh")
    rollback_text = code_text(HANDLER / "rollback.sh")

    assert "aegis-idea3-containment.socket" in apply_text
    assert "CONTAINMENT_PROTECTION_INVALID" in apply_text
    assert "aegis-idea3-containment.socket" in verify_text
    assert "aegis-idea3-containment.service" in rollback_text

    # The helper is stopped before L2 deletes the table it depends on.
    assert rollback_text.index("CONTAINMENT_UNIT_STOP_FAILED") < rollback_text.index("nft delete table")


def test_l2_allow_keys_cover_containment_artifacts() -> None:
    keys = set((HANDLER / "allow-keys.txt").read_text(encoding="utf-8").split())
    for unit in ("aegis-idea3-containment.socket", "aegis-idea3-containment.service"):
        for prop in ("LoadState", "ActiveState", "UnitFileState"):
            assert f"svc.{unit}.{prop}" in keys
    assert "host.aegis_idea3.file./etc/aegis-idea3/containment.env.meta" in keys
    assert "aegis-idea3-containment.socket" in CAPTURE.read_text(encoding="utf-8")


def test_l2_apply_refuses_empty_containment_protection(tmp_path: Path) -> None:
    render_dir = render_t5_material(tmp_path)
    (render_dir / "aegis-idea3-containment.env").write_text(
        "AEGIS_CONTAINMENT_PROTECTED_CIDRS=\n", encoding="utf-8"
    )

    result = run_handler(
        HANDLER / "apply.sh",
        fs_root=tmp_path / "root",
        render_dir=render_dir,
        work_dir=tmp_path / "work",
    )

    assert result.returncode != 0
    assert "CONTAINMENT_PROTECTION_INVALID" in result.stderr


def test_l2_fixture_roundtrip_manages_containment_and_rollback_is_idempotent(tmp_path: Path) -> None:
    render_dir = render_t5_material(tmp_path)
    fs_root = tmp_path / "root"
    work_dir = tmp_path / "work"

    kwargs = {"fs_root": fs_root, "render_dir": render_dir, "work_dir": work_dir}

    assert run_handler(HANDLER / "apply.sh", **kwargs).returncode == 0
    for artifact in CONTAINMENT_ARTIFACTS:
        assert (fs_root / artifact).is_file(), artifact
    assert run_handler(HANDLER / "verify.sh", **kwargs).returncode == 0

    (fs_root / CONTAINMENT_ARTIFACTS[0]).write_text("tampered\n", encoding="utf-8")
    tampered = run_handler(HANDLER / "verify.sh", **kwargs)
    assert tampered.returncode != 0
    assert "CONTAINMENT" in tampered.stderr

    for _ in range(2):
        result = run_handler(HANDLER / "rollback.sh", **kwargs)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "L2_ROLLBACK=PASS" in result.stdout

    for artifact in CONTAINMENT_ARTIFACTS:
        assert not (fs_root / artifact).exists(), artifact


def test_l2_fixture_apply_installs_exactly_the_idea3_owned_artifacts(tmp_path: Path) -> None:
    render_dir = render_t5_material(tmp_path)
    fs_root = tmp_path / "root"
    result = run_handler(
        HANDLER / "apply.sh", fs_root=fs_root, render_dir=render_dir, work_dir=tmp_path / "work"
    )
    assert result.returncode == 0, result.stdout + result.stderr

    installed = sorted(str(p.relative_to(fs_root)) for p in fs_root.rglob("*") if p.is_file())
    assert installed == sorted([
        "etc/aegis-idea3/aegis-idea3.nft",
        "etc/aegis-idea3/containment.env",
        "etc/sysctl.d/90-aegis-idea3-forwarding.conf",
        "etc/systemd/system/aegis-idea3-containment.service",
        "etc/systemd/system/aegis-idea3-containment.socket",
        "etc/systemd/system/aegis-idea3-nftables-load.service",
    ])


def test_l2_handlers_never_touch_routes_or_other_tables() -> None:
    combined = "\n".join(
        code_text(HANDLER / name) for name in ("apply.sh", "verify.sh", "rollback.sh")
    )
    assert re.search(r"\bip\s+(-[46]\s+)?route\b", combined) is None
    mutations = re.findall(r"nft\s+(?:add|delete|flush|insert|replace|create)\b[^\n|]*", combined)
    assert mutations
    for mutation in mutations:
        assert [t.strip("\"") for t in mutation.split()[:5]] == ["nft", "delete", "table", "inet", "aegis_idea3"], mutation
    assert "sysctl -w \"$key=0\"" in combined
    assert re.search(r"sysctl\s+-w\s+\S+=1", combined) is None
