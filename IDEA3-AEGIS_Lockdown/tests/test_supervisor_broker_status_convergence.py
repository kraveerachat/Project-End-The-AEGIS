"""L7 #5 regression: the persisted broker status must converge on the MQTT callback."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import replace
from types import SimpleNamespace

import pytest

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


@pytest.mark.parametrize("in_flight_write", ["transition", "set_armed"])
def test_an_older_in_flight_status_write_cannot_regress_a_connected_broker(tmp_path, monkeypatch, in_flight_write):
    """An older supervisor write is mid-flight (snapshot taken, replace pending) when the MQTT
    callback persists CONNECTED; the older write finishing afterwards must not restore UNKNOWN.

    Deterministic seam: the first os.replace (the older write) parks until the callback's
    replace has happened. If persistence is serialized the callback cannot replace first, so
    the parked write is released by a bounded safety timeout and still lands before CONNECTED.
    """
    supervisor = _supervisor(tmp_path)
    real_replace = os.replace
    older_in_flight = threading.Event()
    callback_replaced = threading.Event()
    calls = []
    calls_lock = threading.Lock()

    def replace(src, dst):
        with calls_lock:
            calls.append(threading.current_thread().name)
            is_older = len(calls) == 1
        if is_older:
            older_in_flight.set()
            callback_replaced.wait(timeout=2.0)  # safety bound only; never gates correctness
            real_replace(src, dst)
        else:
            real_replace(src, dst)
            callback_replaced.set()

    monkeypatch.setattr(os, "replace", replace)

    if in_flight_write == "transition":
        older = threading.Thread(target=supervisor.transition, args=("WAIT_DEVICE", "startup"), name="older")
    else:
        older = threading.Thread(target=supervisor.set_armed, args=(True,), name="older")
    older.start()
    assert older_in_flight.wait(timeout=5.0)
    assert supervisor.status.broker == "UNKNOWN"  # the older snapshot was taken while UNKNOWN

    callback = threading.Thread(target=supervisor._on_connection, args=(True,), name="callback")
    callback.start()
    callback.join(timeout=10.0)
    older.join(timeout=10.0)
    assert not callback.is_alive() and not older.is_alive()

    assert _persisted_broker(supervisor) == "CONNECTED"
