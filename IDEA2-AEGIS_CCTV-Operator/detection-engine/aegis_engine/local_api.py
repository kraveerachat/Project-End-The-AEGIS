"""
LocalEventAPI — the read-only window the Monitoring Web App consumes.

A lightweight FastAPI server (+ WebSocket) that runs on the edge node and
exposes, over the LAN:

* ``GET  /health``             — liveness + camera/engine state
* ``GET  /metrics``            — full metrics snapshot (FPS, latency, NAS, …)
* ``GET  /detections/recent``  — ring buffer of the latest detection/alert events
* ``WS   /ws/events``          — real-time stream of detections, alerts, and a
                                 periodic metrics heartbeat

This is a **push channel only**; it never accepts commands and never writes to
the database. The web app's authoritative history comes from the shared DB; this
API is the low-latency live layer (the Operator HUD's live FPS/latency spark,
event stream, and "AI engine: running" pills).

The server runs on its own thread with its own asyncio loop. Detection/metrics
events are produced by worker threads and bridged onto that loop by
:class:`~aegis_engine.event_hub.EventHub`.
"""

from __future__ import annotations

import asyncio
import threading
from collections import deque
from contextlib import asynccontextmanager
from typing import Deque, List, Optional

from .config import EngineConfig
from .event_hub import EventHub
from .logging_setup import get_logger
from .metrics import MetricsRegistry

# Imported at module scope (not inside _build_app) on purpose: this module uses
# ``from __future__ import annotations``, so FastAPI resolves the string
# annotation ``"WebSocket"`` on the endpoint via THIS module's globals. If the
# name isn't here, FastAPI misreads the ws param as a query param and rejects
# every handshake with HTTP 403.
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "FastAPI/uvicorn are required for LocalEventAPI "
        "(pip install -r requirements.txt)"
    ) from exc

log = get_logger("LocalEventAPI")


class LocalEventAPI:
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        event_hub: Optional[EventHub] = None,
    ) -> None:
        self._cfg = config
        self._metrics = metrics
        self._hub = event_hub or EventHub()
        self._recent: "Deque[dict]" = deque(maxlen=config.api_recent_events)
        self._recent_lock = threading.Lock()
        self._server = None  # uvicorn.Server
        self._thread: Optional[threading.Thread] = None
        self._app = self._build_app()

    @property
    def hub(self) -> EventHub:
        return self._hub

    # -- producer API (called from worker threads via the engine) ----------
    def publish_event(self, event: dict) -> None:
        """Record an event to the ring buffer and broadcast it live.

        Thread-safe and non-blocking. Used for detection results and alerts.
        """
        with self._recent_lock:
            self._recent.append(event)
        self._hub.publish(event)

    def _recent_events(self) -> List[dict]:
        with self._recent_lock:
            return list(self._recent)

    # -- app wiring --------------------------------------------------------
    def _build_app(self):
        metrics = self._metrics
        hub = self._hub
        cfg = self._cfg
        recent_events = self._recent_events

        @asynccontextmanager
        async def lifespan(app):
            # Runs on the server's own event loop: bind it so worker threads
            # can publish, and start the metrics heartbeat task.
            loop = asyncio.get_running_loop()
            hub.bind_loop(loop)
            task = asyncio.create_task(_metrics_heartbeat())
            log.info("API up on http://%s:%d", cfg.api_host, cfg.api_port)
            try:
                yield
            finally:
                task.cancel()

        async def _metrics_heartbeat():
            """Periodically broadcast a metrics snapshot to all WS clients."""
            try:
                while True:
                    await asyncio.sleep(cfg.api_metrics_interval_s)
                    hub.publish(metrics.snapshot())
            except asyncio.CancelledError:  # pragma: no cover
                pass

        app = FastAPI(title="AEGIS Detection Engine · Local Event API",
                      version="0.1.0", lifespan=lifespan)

        # The web app is served from a different origin (the Beelink) — allow it.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["GET"],
            allow_headers=["*"],
        )

        @app.get("/")
        async def root():
            return {
                "service": "aegis-detection-engine",
                "node_id": cfg.node_id,
                "camera_id": cfg.camera_id,
                "camera_label": cfg.camera_label,
                "endpoints": ["/health", "/metrics", "/detections/recent", "/ws/events"],
            }

        @app.get("/health")
        async def health():
            snap = metrics.snapshot()
            connected = snap["camera_connected"]
            return {
                "status": "ok" if connected else "degraded",
                "camera_connected": connected,
                "uptime_s": snap["uptime_s"],
                "capture_fps": snap["capture_fps"],
                "detect_fps": snap["detect_fps"],
            }

        @app.get("/metrics")
        async def get_metrics():
            return metrics.snapshot()

        @app.get("/detections/recent")
        async def detections_recent(limit: int = 50):
            events = recent_events()
            return {"count": len(events), "events": events[-max(1, min(limit, len(events) or 1)):]}

        @app.websocket("/ws/events")
        async def ws_events(ws: WebSocket):
            await ws.accept()
            q = hub.register()
            log.info("WS client connected (%d total)", hub.client_count)
            try:
                # Prime the client with current state + recent history.
                await ws.send_json({"type": "hello", "node_id": cfg.node_id,
                                    "camera_id": cfg.camera_id})
                await ws.send_json(metrics.snapshot())
                for ev in recent_events():
                    await ws.send_json(ev)
                # Then stream live events as they arrive.
                while True:
                    event = await q.get()
                    await ws.send_json(event)
            except WebSocketDisconnect:
                pass
            except Exception:  # pragma: no cover - client vanished mid-send
                log.debug("WS send failed; dropping client", exc_info=True)
            finally:
                hub.unregister(q)
                log.info("WS client disconnected (%d total)", hub.client_count)

        return app

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        import uvicorn

        config = uvicorn.Config(
            self._app,
            host=self._cfg.api_host,
            port=self._cfg.api_port,
            log_level="warning",
            loop="asyncio",
            ws_ping_interval=20,
            ws_ping_timeout=20,
        )
        self._server = uvicorn.Server(config)
        # uvicorn skips signal-handler install when not on the main thread.
        self._thread = threading.Thread(
            target=self._server.run, name="LocalEventAPI", daemon=True
        )
        self._thread.start()
        log.info("API server thread started")

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)
