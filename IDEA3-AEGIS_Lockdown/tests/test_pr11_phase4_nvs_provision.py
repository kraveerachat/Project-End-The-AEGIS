from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy/pr11-phase4/p4-nvs-provision.py"


def test_nvs_provision_tool_exists():
    assert TOOL.is_file(), "T8 NVS provisioning tool is missing"


def test_nvs_contract_matches_firmware_schema():
    source = TOOL.read_text(encoding="utf-8")
    assert "aegis-p1" in source
    assert "schema" in source
    assert "device_id" in source
    assert "wifi_ssid" in source
    assert "wifi_psk" in source
    assert "broker" in source
    assert "mqtt_user" in source
    assert "mqtt_pass" in source
    assert "ntp" in source
    assert "k_c2d" in source
    assert "k_d2c" in source
    assert "seq_hi" in source


def test_nvs_fixed_profile_values_are_pinned():
    source = TOOL.read_text(encoding="utf-8")
    assert "NVS_SCHEMA_VERSION = 1" in source
    assert "DEVICE_ID = \"aegis-relay-01\"" in source
    assert "BROKER_HOST = \"mqtt.aegis.home.arpa\"" in source
    assert "MQTT_USER = \"idea3-dev-aegis-relay-01\"" in source
    assert "seq_hi" in source
    assert "SEQ_HI_INITIAL = 0" in source


def _load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location("p4_nvs_provision", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_profile_validation_requires_wifi_ssid_and_ntp():
    tool = _load_tool()

    import pytest

    with pytest.raises(ValueError, match="wifi_ssid"):
        tool.validate_profile("", "192.0.2.1")

    with pytest.raises(ValueError, match="ntp"):
        tool.validate_profile("AEGIS-Lockdown", "")


def test_secret_file_requires_private_regular_nonempty_file(tmp_path):
    import os
    import pytest

    tool = _load_tool()

    secret = tmp_path / "mqtt.pass"
    secret.write_text("repository-test-secret\n", encoding="utf-8")
    os.chmod(secret, 0o600)

    assert tool.read_secret_file(secret) == "repository-test-secret"

    os.chmod(secret, 0o640)
    with pytest.raises(ValueError, match="permissions"):
        tool.read_secret_file(secret)

    empty = tmp_path / "empty"
    empty.write_text("", encoding="utf-8")
    os.chmod(empty, 0o600)

    with pytest.raises(ValueError, match="empty"):
        tool.read_secret_file(empty)


def test_protocol_keys_must_be_independent_private_32_byte_hex():
    import pytest

    tool = _load_tool()

    good_c2d = "11" * 32
    good_d2c = "22" * 32

    c2d, d2c = tool.validate_protocol_keys(good_c2d, good_d2c)

    assert c2d == bytes.fromhex(good_c2d)
    assert d2c == bytes.fromhex(good_d2c)

    with pytest.raises(ValueError):
        tool.validate_protocol_keys("00" * 32, good_d2c)

    with pytest.raises(ValueError):
        tool.validate_protocol_keys(good_c2d, good_c2d)

    with pytest.raises(ValueError):
        tool.validate_protocol_keys("AA" * 32, good_d2c)

    with pytest.raises(ValueError):
        tool.validate_protocol_keys("11" * 31, good_d2c)

    with pytest.raises(ValueError, match="test"):
        tool.validate_protocol_keys(
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            good_d2c,
        )

    with pytest.raises(ValueError, match="test"):
        tool.validate_protocol_keys(
            good_c2d,
            "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
        )


def test_render_csv_is_private_and_refuses_overwrite(tmp_path):
    import os
    import pytest

    tool = _load_tool()

    output = tmp_path / "nvs.csv"

    rows = {
        "schema": 1,
        "device_id": "aegis-relay-01",
        "wifi_ssid": "AEGIS-Lockdown",
        "wifi_psk": "repository-test-psk",
        "broker": "mqtt.aegis.home.arpa",
        "mqtt_user": "idea3-dev-aegis-relay-01",
        "mqtt_pass": "repository-test-mqtt-password",
        "ntp": "192.0.2.1",
        "k_c2d": bytes.fromhex("11" * 32),
        "k_d2c": bytes.fromhex("22" * 32),
        "seq_hi": 0,
    }

    tool.render_nvs_csv(rows, output)

    assert output.is_file()
    assert os.stat(output).st_mode & 0o777 == 0o600

    text = output.read_text(encoding="utf-8")
    assert "aegis-p1,namespace" in text
    assert "k_c2d,data,hex2bin," in text
    assert "k_d2c,data,hex2bin," in text

    with pytest.raises(FileExistsError):
        tool.render_nvs_csv(rows, output)


def test_cli_reads_secrets_from_files_and_does_not_print_them(tmp_path):
    import os
    import subprocess
    import sys

    wifi_psk = tmp_path / "wifi.psk"
    mqtt_pass = tmp_path / "mqtt.pass"
    k_c2d = tmp_path / "k_c2d"
    k_d2c = tmp_path / "k_d2c"
    output = tmp_path / "nvs.csv"

    values = {
        wifi_psk: "repository-test-wifi-psk",
        mqtt_pass: "repository-test-mqtt-password",
        k_c2d: "11" * 32,
        k_d2c: "22" * 32,
    }

    for path, value in values.items():
        path.write_text(value + "\n", encoding="utf-8")
        os.chmod(path, 0o600)

    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            "render",
            "--wifi-ssid",
            "AEGIS-Lockdown",
            "--ntp",
            "192.0.2.1",
            "--wifi-psk-file",
            str(wifi_psk),
            "--mqtt-password-file",
            str(mqtt_pass),
            "--k-c2d-file",
            str(k_c2d),
            "--k-d2c-file",
            str(k_d2c),
            "--output",
            str(output),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert output.is_file()
    assert os.stat(output).st_mode & 0o777 == 0o600
    assert "NVS_CSV_WRITTEN=" in result.stdout

    combined = result.stdout + result.stderr
    for secret in values.values():
        assert secret not in combined


def test_cli_exposes_only_file_based_secret_inputs():
    tool = _load_tool()
    parser = tool.build_parser()

    help_text = parser.format_help()
    assert "--wifi-psk " not in help_text
    assert "--mqtt-password " not in help_text
    assert "--k-c2d " not in help_text
    assert "--k-d2c " not in help_text

    render = next(
        action
        for action in parser._actions
        if action.dest == "command"
    ).choices["render"]

    render_help = render.format_help()
    assert "--wifi-psk-file" in render_help
    assert "--mqtt-password-file" in render_help
    assert "--k-c2d-file" in render_help
    assert "--k-d2c-file" in render_help


def test_protocol_keys_reject_legacy_demo_derived_material():
    import hashlib
    import pytest

    tool = _load_tool()

    legacy = b"AEGIS-DEMO-SHARED-SECRET-change-me"
    forbidden = (
        hashlib.sha256(legacy).hexdigest(),
        legacy[:32].hex(),
    )
    good = "33" * 32

    for bad in forbidden:
        with pytest.raises(ValueError, match="demo|unsafe|test"):
            tool.validate_protocol_keys(bad, good)

        with pytest.raises(ValueError, match="demo|unsafe|test"):
            tool.validate_protocol_keys(good, bad)
