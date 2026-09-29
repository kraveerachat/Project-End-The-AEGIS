"""L7 #5 regression: the persisted broker status must converge on the MQTT callback."""

from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

from aegis_soc.runtime import RuntimeSettings
from aegis_soc.supervisor import AegisSupervisor


def _supervisor(tmp_path) -> AegisSupervisor:
    settings = replace(
        RuntimeSettings.from_profile("development", dry_run=True, start_detector=False, start_gui=False),
        runtime_dir=tmp_path / "runtime",
        log_dir=tmp_path / "logs",
    )
    return AegisSupervisor(settings, mqtt_manager=SimpleNamespace(stop=lambda: None), protocol=None, dispatch_worker=None)


def _persisted_broker(supervisor: AegisSupervisor) -> str | None:
    path = supervisor.settings.status_path
    return json.loads(path.read_text(encoding="utf-8")).get("broker") if path.exists() else None


def test_connect_callback_persists_broker_connected_without_a_health_loop_pass(tmp_path):
    supervisor = _supervisor(tmp_path)
    supervisor.transition("WAIT_DEVICE", "startup")
    assert _persisted_broker(supervisor) != "CONNECTED"  # the live race: verifier sees a stale state

    supervisor._on_connection(True)

    assert supervisor.mqtt.is_connected is True
    assert _persisted_broker(supervisor) == "CONNECTED"


def test_disconnect_callback_persists_broker_disconnected_promptly(tmp_path):
    supervisor = _supervisor(tmp_path)
    supervisor._on_connection(True)
    supervisor._on_connection(False)

    assert supervisor.mqtt.is_connected is False
    assert _persisted_broker(supervisor) == "DISCONNECTED"


def test_a_status_write_failure_never_breaks_the_connection_callback(tmp_path, monkeypatch):
    supervisor = _supervisor(tmp_path)

    def boom(_path):
        raise OSError("disk full")

    monkeypatch.setattr(supervisor.status, "write", boom)
    supervisor._on_connection(True)  # must not raise into the MQTT network thread

    assert supervisor.mqtt.is_connected is True
    assert supervisor.status.broker == "CONNECTED"
