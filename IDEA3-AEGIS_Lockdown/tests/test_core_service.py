"""Phase 3 Core-only systemd and external-path contracts."""

from __future__ import annotations

import configparser
import shlex
from pathlib import Path

from aegis_soc.paths import RuntimePaths, configuration_path, load_dotenv
from aegis_soc.supervisor import build_parser, settings_from_args

ROOT = Path(__file__).resolve().parent.parent
UNIT_PATH = ROOT / "deploy" / "aegis-idea3-core.service.example"
ENV_PATH = ROOT / "deploy" / "aegis-idea3-core.env.example"
HISTORICAL_UNIT_PATH = ROOT / "deploy" / "aegis-idea3.service.example"
HISTORICAL_RUNTIME_PATH = ROOT / "aegis_soc" / "production_runtime.py"
IDEA2_UNITS = {
    "aegis-detection-engine.service",
    "aegis-detection-tunnel.service",
}


def _unit() -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.optionxform = str
    with UNIT_PATH.open(encoding="utf-8") as handle:
        parser.read_file(handle)
    return parser


def _core_environment() -> dict[str, str]:
    values: dict[str, str] = {}
    load_dotenv(ENV_PATH, values)
    return values


def test_p3_c1_core_service_executes_only_the_headless_supervisor():
    unit = _unit()
    tokens = shlex.split(unit["Service"]["ExecStart"])

    assert tokens[1:3] == ["-m", "aegis_soc.supervisor"]
    args = build_parser().parse_args(tokens[3:])
    settings = settings_from_args(args)

    assert settings.profile == "production"
    assert settings.dry_run is False
    assert settings.start_gui is False
    assert settings.start_detector is False
    assert settings.voice_enabled is False
    assert "node" not in tokens
    assert "production_runtime" not in tokens


def test_p3_c6_c7_core_service_uses_system_roots_without_a_login_session():
    unit = _unit()

    assert unit["Service"]["User"] == "aegis-idea3"
    assert unit["Service"]["Group"] == "aegis-idea3"
    assert unit["Service"]["WorkingDirectory"] == "/opt/aegis-idea3/current"
    assert unit["Service"]["EnvironmentFile"] == "/etc/aegis-idea3/core.env"
    assert unit["Service"]["StateDirectory"] == "aegis-idea3"
    assert unit["Service"]["RuntimeDirectory"] == "aegis-idea3"
    assert unit["Service"]["LogsDirectory"] == "aegis-idea3"
    assert unit["Install"]["WantedBy"] == "multi-user.target"
    assert "graphical" not in " ".join(
        value for section in unit.values() for value in section.values()
    ).lower()


def test_p3_c8_core_service_has_no_idea2_chain_and_sets_no_unmeasured_quota():
    unit = _unit()
    relationships = " ".join(
        unit[section].get(key, "")
        for section, key in (
            ("Unit", "Requires"),
            ("Unit", "Wants"),
            ("Unit", "BindsTo"),
            ("Unit", "PartOf"),
            ("Unit", "After"),
            ("Unit", "Before"),
        )
    )

    assert all(name not in relationships for name in IDEA2_UNITS)
    every_value = " ".join(
        value for section in unit.values() for value in section.values()
    )
    assert all(name not in every_value for name in IDEA2_UNITS)
    assert "aegis-detection" not in every_value
    # systemd 261 removed CPUAccounting= and ignores it; CPU accounting comes
    # from the unified cgroup hierarchy, so the obsolete directive stays absent.
    assert "CPUAccounting" not in unit["Service"]
    assert unit["Service"]["MemoryAccounting"] == "true"
    assert unit["Service"]["TasksAccounting"] == "true"
    assert unit["Service"]["IOAccounting"] == "true"
    for quota in ("CPUQuota", "MemoryMax", "MemoryHigh", "TasksMax", "IOWeight"):
        assert quota not in unit["Service"]


def test_p3_c6_core_environment_resolves_durable_and_ephemeral_roots_separately():
    values = _core_environment()
    paths = RuntimePaths.from_environment(env=values, platform="linux")

    assert paths.root == Path("/var/lib/aegis-idea3")
    assert paths.core_db == Path("/var/lib/aegis-idea3/data/core-audit.sqlite3")
    assert paths.dispatch_db == Path(
        "/var/lib/aegis-idea3/data/core-dispatch.sqlite3"
    )
    assert paths.runtime_dir == Path("/run/aegis-idea3")
    assert paths.log_dir == Path("/var/log/aegis-idea3")
    assert configuration_path(env=values, platform="linux") == Path(
        "/etc/aegis-idea3/core.env"
    )
    assert paths.config_file == Path("/etc/aegis-idea3/core.env")
    assert not paths.dispatch_db.is_relative_to(paths.runtime_dir)
    assert not paths.dispatch_db.is_relative_to(Path("/opt/aegis-idea3/current"))
    assert values["AEGIS_CORE_DISPATCH_DB_PATH"] == str(paths.dispatch_db)
    assert values["AEGIS_CORE_DISPATCH_ENABLED"] == "0"


def test_p3_c1_historical_pr9_compatibility_artifacts_remain_present():
    assert HISTORICAL_UNIT_PATH.is_file()
    assert HISTORICAL_RUNTIME_PATH.is_file()
