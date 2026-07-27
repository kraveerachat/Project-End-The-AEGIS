"""
HeartbeatWorker — publish this node's liveness to AEGIS Monitor.

The engine already measures everything the Operator HUD wants to show (camera
connected/reconnects, capture & detect FPS, inference latency, NAS backlog) in
:class:`~aegis_engine.metrics.MetricsRegistry`. Until this worker existed those
numbers only ever reached the *local* FastAPI endpoint on the edge node, which
the web app never calls — so Monitor had no way to know whether this process
was alive, and its "Edge node: online" pill was a hard-coded string.

This thread closes that loop: every ``heartbeat_interval_s`` it takes a metrics
snapshot and POSTs it to ``/internal/heartbeat``. Monitor stores one row per
camera and derives link status purely from how old that row is.

Design notes
------------
* **Silence is the signal.** We never post "I am down". If this process dies,
  the network drops, or the camera never opens, rows simply stop arriving and
  Monitor ages the status to ``degraded`` then ``lost`` on its own. That is
  what makes the status trustworthy — it cannot be faked by a live process.
* **Fail-soft, like every other Monitor call.** A failed heartbeat is logged by
  the client and dropped; it must never disturb capture or recording.
* **Interruptible sleep** via the shared stop event, so shutdown is prompt.
"""

from __future__ import annotations

import threading
from typing import Optional

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .monitor_client import MonitorClient

log = get_logger("HeartbeatWorker")


class HeartbeatWorker(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        monitor: MonitorClient,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(name="HeartbeatWorker", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._monitor = monitor
        self._stop_event = stop_event or threading.Event()
        self._sent = 0

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        interval = self._cfg.heartbeat_interval_s
        if interval <= 0:
            log.info("heartbeat disabled (interval <= 0)")
            return
        log.info(
            "heartbeat worker started · every %.1fs for %s",
            interval,
            self._cfg.camera_id,
        )
        try:
            # Send one immediately so Monitor flips to online without waiting a
            # full interval on startup.
            self._beat()
            while not self._stop_event.wait(interval):
                self._beat()
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in heartbeat loop")
        finally:
            log.info("heartbeat worker stopped (%d sent)", self._sent)

    def _beat(self) -> None:
        try:
            snapshot = self._metrics.snapshot()
            self._monitor.post_heartbeat(
                camera_id=self._cfg.camera_id,
                node_id=self._cfg.node_id,
                snapshot=snapshot,
                # Where Monitor's proxy should pull MJPEG for this camera. Sent
                # every beat rather than configured on Monitor, so a node that
                # moves or changes port self-heals on the next heartbeat, and a
                # node that dies takes its stream URL out of service with it.
                stream_url=self._cfg.resolved_stream_url(),
            )
            self._sent += 1
        except Exception:  # pragma: no cover - client already fails soft
            log.exception("heartbeat send raised unexpectedly")
