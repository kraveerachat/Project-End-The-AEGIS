"""PR11 Phase 4 T6 — repository-only local trusted NTP contract tests."""

import subprocess
import sys
from pathlib import Path

import pytest

LOCKDOWN = Path(__file__).resolve().parents[1]
RENDERER = LOCKDOWN / "deploy" / "pr11-phase4" / "p4-ntp.py"
TEMPLATE = LOCKDOWN / "deploy" / "chrony" / "aegis-idea3-chrony.conf.example"


def test_t6_ntp_renderer_exists():
    assert RENDERER.is_file(), f"T6 NTP renderer missing: {RENDERER}"


def test_chrony_template_defers_owner_supplied_trusted_upstream():
    text = TEMPLATE.read_text(encoding="utf-8")
    assert "server <AEGIS_TRUSTED_NTP_UPSTREAM> iburst" in text


DEFAULTS = {
    "ap_address": "192.0.2.1",
    "ap_subnet": "192.0.2.0/28",
    "trusted_upstream": "time.example.invalid",
}


def render_argv(output_dir: Path, **overrides: str) -> list[str]:
    values = DEFAULTS | overrides
    return [
        sys.executable,
        str(RENDERER),
        "render",
        "--ap-address", values["ap_address"],
        "--ap-subnet", values["ap_subnet"],
        "--trusted-upstream", values["trusted_upstream"],
        "--output-dir", str(output_dir),
    ]


def run_render(tmp_path: Path, *, output_name: str = "out", **overrides: str):
    output_dir = tmp_path / output_name
    result = subprocess.run(
        render_argv(output_dir, **overrides),
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


def test_valid_render_is_deterministic_and_has_exact_artifacts(tmp_path):
    first, first_dir = run_render(tmp_path, output_name="first")
    second, second_dir = run_render(tmp_path, output_name="second")

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr

    first_tree = rendered_tree(first_dir)
    second_tree = rendered_tree(second_dir)

    assert set(first_tree) == {
        "aegis-idea3-chrony.conf",
        "aegis-idea3-t6-contract.txt",
    }
    assert first_tree == second_tree


def test_rendered_chrony_uses_exact_owner_inputs(tmp_path):
    result, output_dir = run_render(tmp_path)

    assert result.returncode == 0, result.stderr
    config = output_dir / "aegis-idea3-chrony.conf"
    assert config.is_file()

    text = config.read_text(encoding="utf-8")
    assert "server time.example.invalid iburst" in text
    assert "bindaddress 192.0.2.1" in text
    assert "allow 192.0.2.0/28" in text
    assert "<AEGIS_" not in text


@pytest.mark.parametrize(
    "missing_flag",
    ["--ap-address", "--ap-subnet", "--trusted-upstream"],
)
def test_required_render_inputs_fail_closed(tmp_path, missing_flag):
    output_dir = tmp_path / "out"
    argv = render_argv(output_dir)
    index = argv.index(missing_flag)
    del argv[index:index + 2]

    result = subprocess.run(
        argv,
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )

    assert_clean_cli_rejection(result)
    assert rendered_tree(output_dir) == {}


def test_rejects_ap_address_outside_supplied_subnet(tmp_path):
    result, output_dir = run_render(
        tmp_path,
        ap_address="198.51.100.1",
    )

    assert_clean_cli_rejection(result)
    assert rendered_tree(output_dir) == {}

def assert_clean_cli_rejection(result) -> None:
    assert result.returncode != 0
    assert "Traceback" not in result.stderr
    assert "NameError" not in result.stderr


@pytest.mark.parametrize(
    "trusted_upstream",
    [
        "time.example.invalid\nlocal stratum 10",
        "time.example.invalid iburst",
        "time.example.invalid;local",
        " time.example.invalid",
        "<AEGIS_TRUSTED_NTP_UPSTREAM>",
    ],
)

def test_rejects_unsafe_trusted_upstream(tmp_path, trusted_upstream):
    result, output_dir = run_render(
        tmp_path,
        trusted_upstream=trusted_upstream,
    )

    assert_clean_cli_rejection(result)
    assert rendered_tree(output_dir) == {}


@pytest.mark.parametrize(
    ("ap_address", "ap_subnet"),
    [
        ("0.0.0.0", "0.0.0.0/0"),
        ("192.0.2.1", "0.0.0.0/0"),
    ],
)
def test_rejects_wildcard_or_broad_ap_scope(
    tmp_path,
    ap_address,
    ap_subnet,
):
    result, output_dir = run_render(
        tmp_path,
        ap_address=ap_address,
        ap_subnet=ap_subnet,
    )

    assert_clean_cli_rejection(result)
    assert rendered_tree(output_dir) == {}


def test_existing_empty_output_directory_is_allowed(tmp_path):
    output_dir = tmp_path / "out"
    output_dir.mkdir()

    result = subprocess.run(
        render_argv(output_dir),
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert set(rendered_tree(output_dir)) == {
        "aegis-idea3-chrony.conf",
        "aegis-idea3-t6-contract.txt",
    }


def test_non_empty_output_directory_is_refused_without_mutation(tmp_path):
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    sentinel = output_dir / "keep.txt"
    sentinel.write_text("KEEP\n", encoding="utf-8")

    before = rendered_tree(output_dir)

    result = subprocess.run(
        render_argv(output_dir),
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )

    assert_clean_cli_rejection(result)
    assert rendered_tree(output_dir) == before

def test_rendered_contract_keeps_live_stage_unclaimed(tmp_path):
    result, output_dir = run_render(tmp_path)

    assert result.returncode == 0, result.stderr

    contract = (
        output_dir / "aegis-idea3-t6-contract.txt"
    ).read_text(encoding="utf-8")

    required = {
        "T6_REPOSITORY_RENDER=YES",
        "PRODUCTION_MUTATION=NO",
        "NTP_SERVER_LIVE=NO",
        "TIMESYNCD_HANDOFF_LIVE=NO",
        "L5=NOT_RUN",
    }

    assert required <= set(contract.splitlines())


def run_validate(input_dir: Path):
    return subprocess.run(
        [
            sys.executable,
            str(RENDERER),
            "validate",
            "--input-dir",
            str(input_dir),
        ],
        cwd=LOCKDOWN,
        text=True,
        capture_output=True,
        check=False,
    )


def test_validate_accepts_valid_rendered_artifacts(tmp_path):
    render_result, output_dir = run_render(tmp_path)
    assert render_result.returncode == 0, render_result.stderr

    validate_result = run_validate(output_dir)

    assert validate_result.returncode == 0, validate_result.stderr


def test_renderer_contains_no_host_mutation_commands():
    text = RENDERER.read_text(encoding="utf-8").lower()

    forbidden = (
        "subprocess",
        "os.system",
        "systemctl",
        "timedatectl",
        "pacman",
        "sudo ",
        "nft ",
        "ip link",
        "chronyd",
    )

    for token in forbidden:
        assert token not in text

def mutate_rendered_config(
    tmp_path: Path,
    old: str,
    new: str,
):
    render_result, output_dir = run_render(tmp_path)
    assert render_result.returncode == 0, render_result.stderr

    config = output_dir / "aegis-idea3-chrony.conf"
    text = config.read_text(encoding="utf-8")

    if old not in text:
        raise AssertionError(f"expected config text missing: {old!r}")

    config.write_text(
        text.replace(old, new, 1),
        encoding="utf-8",
    )

    return run_validate(output_dir)


def test_contract_declares_trustedclock_handoff_invariants(tmp_path):
    result, output_dir = run_render(tmp_path)
    assert result.returncode == 0, result.stderr

    lines = set(
        (
            output_dir / "aegis-idea3-t6-contract.txt"
        ).read_text(encoding="utf-8").splitlines()
    )

    required = {
        "TRUSTEDCLOCK_PRE_HANDOFF=SYNCED",
        "TRUSTEDCLOCK_POST_HANDOFF=SYNCED",
        "TRUSTEDCLOCK_MAX_ERROR_US=1000000",
        "TRUSTEDCLOCK_HOLDOVER_SEC=300",
        "TRUSTEDCLOCK_FINAL_HOLDOVER_PASS=NO",
        "ROLLBACK_TIME_OWNER=systemd-timesyncd",
    }

    assert required <= lines


def test_validate_rejects_local_clock_fallback(tmp_path):
    result = mutate_rendered_config(
        tmp_path,
        "allow 192.0.2.0/28",
        "allow 192.0.2.0/28\nlocal stratum 10",
    )

    assert_clean_cli_rejection(result)


def test_validate_rejects_allow_all(tmp_path):
    result = mutate_rendered_config(
        tmp_path,
        "allow 192.0.2.0/28",
        "allow all",
    )

    assert_clean_cli_rejection(result)


def test_validate_rejects_wildcard_bind(tmp_path):
    result = mutate_rendered_config(
        tmp_path,
        "bindaddress 192.0.2.1",
        "bindaddress 0.0.0.0",
    )

    assert_clean_cli_rejection(result)


def test_validate_rejects_additional_upstream(tmp_path):
    result = mutate_rendered_config(
        tmp_path,
        "server time.example.invalid iburst",
        "server time.example.invalid iburst\n"
        "server backup.example.invalid iburst",
    )

    assert_clean_cli_rejection(result)


def test_validate_rejects_wrong_allow_subnet(tmp_path):
    result = mutate_rendered_config(
        tmp_path,
        "allow 192.0.2.0/28",
        "allow 192.0.2.0/24",
    )

    assert_clean_cli_rejection(result)

