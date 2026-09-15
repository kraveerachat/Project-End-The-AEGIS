"""Protocol migration gate: Production has no silent legacy fallback (OD-3/OD-4)."""

from aegis_soc import config
from aegis_soc.controller import AegisCommandController
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.runtime import RuntimeSettings


class FakeMQTT:
    def __init__(self):
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, payload))
        return True


class FakePaho:
    def __init__(self):
        self.subscriptions = []

    def subscribe(self, topics):
        self.subscriptions.append(topics)


def _settings(tmp_path, profile, monkeypatch):
    monkeypatch.setenv("AEGIS_RUNTIME_DIR", str(tmp_path / "run"))
    monkeypatch.setenv("AEGIS_RUNTIME_LOG_DIR", str(tmp_path / "log"))
    return RuntimeSettings.from_profile(
        profile, dry_run=True, auto_contain=False, start_detector=False, start_gui=False
    )


def test_protocol_v1_is_the_default():
    assert config.PROTOCOL_MODE_V1 == "v1"
    assert config.PROTOCOL_MODE == "v1"


def test_explicit_legacy_mode_is_lab_only(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROTOCOL_MODE", "legacy-v0-lab")
    errors, warnings = _settings(tmp_path, "lab", monkeypatch).preflight()
    assert errors == []
    assert any("lab protocol" in warning for warning in warnings)


def test_production_refuses_legacy_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROTOCOL_MODE", "legacy-v0-lab")
    errors, _ = _settings(tmp_path, "production", monkeypatch).preflight()
    assert any("production refuses the legacy v0 protocol" in error for error in errors)


def test_preflight_refuses_unknown_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROTOCOL_MODE", "v2")
    errors, _ = _settings(tmp_path, "lab", monkeypatch).preflight()
    assert "AEGIS_PROTOCOL_MODE must be v1 or legacy-v0-lab" in errors


def test_v1_never_calls_the_legacy_payload_signer(monkeypatch):
    def legacy_called(*_args, **_kwargs):
        raise AssertionError("legacy signer reached from Protocol v1")

    monkeypatch.setattr("aegis_soc.controller.security.create_secure_payload", legacy_called)
    result = AegisCommandController(
        FakeMQTT(), protocol_mode="v1", protocol=None, audit_log=lambda *_args: None
    ).issue("CUT_UPLINK", "migration gate", origin="test")
    assert result.ok is False
    assert result.sent is False


def test_v1_production_subscription_set_excludes_attacker_ip():
    client = FakePaho()
    manager = MQTTManager(protocol=None, client_factory=lambda: client, protocol_mode="v1")
    manager._on_connect(client, None, None, 0)
    assert config.TOPIC_ATTACKER_IP not in {
        topic for subscription in client.subscriptions for topic, _qos in subscription
    }
    assert manager.attacker_callback is None
