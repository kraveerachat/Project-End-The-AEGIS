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
import re
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
    from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import StreamingResponse
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "FastAPI/uvicorn are required for LocalEventAPI "
        "(pip install -r requirements.txt)"
    ) from exc

from .stream_hub import StaleProducerGenerationError, StreamHub
from .demand_grant import DemandGrantError, verify_grant, sign_payload
from .boot_timing_diagnostic import engine_boot_timing

log = get_logger("LocalEventAPI")

# Same shared secret as the engine->Monitor direction. One key for the whole
# engine<->Monitor boundary; the browser never sees it (Monitor proxies).
_KEY_HEADER = "x-detection-engine-key"
_PRODUCER_GENERATION_HEADER = b"x-aegis-producer-generation"
_LOGICAL_CAMERA_ID_HEADER = b"x-aegis-logical-camera-id"
_MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807
_MJPEG_BOUNDARY = "aegisframe"


class _BootTimingResponse(Response):
    """Observe ASGI submission, not receipt by Monitor or a browser."""
    def __init__(self, *args, timing, **kwargs):
        super().__init__(*args, **kwargs)
        self.timing = timing

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        except BaseException:
            self.timing.mark('response_submission')
            self.timing.finish('response_failure')
            raise
        self.timing.mark('response_submission')
        self.timing.finish('submitted')


class _DisconnectAwareStreamingResponse(StreamingResponse):
    """Cancel the stream producer as soon as ASGI reports a client disconnect.

    Recent ASGI servers may advertise spec 2.4, where Starlette relies on a
    failed socket write instead of listening for ``http.disconnect``.  Some
    Windows/browser combinations close cleanly without making that write fail,
    which leaves the MJPEG generator (and its camera demand lease) alive.  This
    response keeps an explicit disconnect listener so the generator's
    ``finally`` block always releases the viewer.
    """

    async def __call__(self, scope, receive, send) -> None:
        stream_task = asyncio.create_task(self.stream_response(send))
        disconnect_task = asyncio.create_task(self.listen_for_disconnect(receive))
        tasks = {stream_task, disconnect_task}
        try:
            done, pending = await asyncio.wait(
                tasks,
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            if stream_task in done:
                try:
                    await stream_task
                except OSError:
                    # A failed write is the other valid disconnect signal.
                    pass
            if disconnect_task in done:
                try:
                    await disconnect_task
                except OSError:
                    pass
        finally:
            # Server shutdown can cancel the response itself before either
            # child wins the race; do not leave the generator/viewer alive.
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            # A failed send can leave the async generator suspended at yield.
            # Closing it explicitly releases its viewer even in that case.
            close = getattr(self.body_iterator, "aclose", None)
            if close is not None:
                await close()

        if self.background is not None:
            await self.background()


def _part(jpeg: bytes) -> bytes:
    """One multipart/x-mixed-replace part. Content-Length matters: without it
    some clients wait for the next boundary before painting, adding a frame of
    latency to every single frame."""
    return (
        b"--" + _MJPEG_BOUNDARY.encode() + b"\r\n"
        b"Content-Type: image/jpeg\r\n"
        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
        + jpeg + b"\r\n"
    )


def _stream_wait_limit(config: EngineConfig, has_sent_frame: bool) -> int:
    """Select the startup or steady-state timeout for an MJPEG viewer."""
    return (
        config.stream_idle_timeout_s
        if has_sent_frame
        else config.stream_first_frame_timeout_s
    )


class LocalEventAPI:
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        event_hub: Optional[EventHub] = None,
        stream_hub: Optional["StreamHub"] = None,
        capture_demand_event: Optional[threading.Event] = None,
    ) -> None:
        self._cfg = config
        self._metrics = metrics
        self._hub = event_hub or EventHub()
        self._stream = stream_hub
        self._capture_demand_event = capture_demand_event
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
        capture_demand_event = self._capture_demand_event

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
            allow_headers=["Content-Type"],
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
            demanded = (
                capture_demand_event is None
                or capture_demand_event.is_set()
            )
            return {
                "status": (
                    "degraded" if snap["accelerator_failure"]
                    else "ok" if connected
                    else "idle" if cfg.capture_on_demand and not demanded
                    else "degraded"
                ),
                "camera_connected": connected,
                "camera_demanded": demanded,
                "stream_viewers": self._stream.viewers if self._stream else 0,
                "recognizer_backend": cfg.recognizer_backend,
                "gpu_required": snap["gpu_required"],
                "requested_inference_device": snap["requested_inference_device"],
                "yolo_actual_device": snap["yolo_actual_device"],
                "successful_gpu_inference_samples": snap["successful_gpu_inference_samples"],
                "accelerator_active": snap["accelerator_active"],
                "accelerator_failure": snap["accelerator_failure"],
                "yunet_backend": snap["yunet_backend"],
                "sface_backend": snap["sface_backend"],
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

        # ── Live MJPEG ────────────────────────────────────────────────────
        # multipart/x-mixed-replace is what an <img> tag speaks natively, so the
        # browser needs no player code — but the browser never reaches here: it
        # asks Monitor, Monitor authenticates the user and checks
        # camera_assignment, and only then does Monitor pull this stream.
        #
        # ⚠️ Auth is mandatory and fail-secure, exactly like Monitor's
        #    requireDetectionEngineKey: no key configured server-side -> the
        #    endpoint is closed (503), never "open for convenience".
        stream_hub = self._stream

        def _authorized(req: "Request") -> Optional[Response]:
            expected = cfg.detection_engine_api_key or ""
            if not expected:
                return Response(status_code=503, content='{"error":"stream disabled"}',
                                media_type="application/json")
            provided = req.headers.get(_KEY_HEADER, "")
            import hmac
            if not provided or not hmac.compare_digest(provided, expected):
                return Response(status_code=401, content='{"error":"unauthorized"}',
                                media_type="application/json")
            return None

        def _producer_generation(req: "Request") -> int | None | Response:
            values = [
                value
                for name, value in req.scope.get("headers", ())
                if name.lower() == _PRODUCER_GENERATION_HEADER
            ]
            if not values:
                # Always-on development engines preserve the bounded legacy
                # Monitor path. A capture-on-demand deployment must carry
                # explicit server-owned producer authority and fails closed.
                if not cfg.capture_on_demand:
                    return None
                return Response(
                    status_code=400,
                    content='{"error":"invalid producer generation"}',
                    media_type="application/json",
                )
            if len(values) != 1:
                return Response(
                    status_code=400,
                    content='{"error":"invalid producer generation"}',
                    media_type="application/json",
                )
            raw = values[0]
            if (
                not raw
                or len(raw) > 19
                or not raw.isascii()
                or not 49 <= raw[0] <= 57
                or any(not 48 <= char <= 57 for char in raw[1:])
            ):
                return Response(
                    status_code=400,
                    content='{"error":"invalid producer generation"}',
                    media_type="application/json",
                )
            value = int(raw)
            if value > _MAX_POSTGRES_BIGINT:
                return Response(
                    status_code=400,
                    content='{"error":"invalid producer generation"}',
                    media_type="application/json",
                )
            return value

        def _logical_camera_id(req: "Request", generation: int | None) -> str | None | Response:
            values = [
                value for name, value in req.scope.get("headers", ())
                if name.lower() == _LOGICAL_CAMERA_ID_HEADER
            ]
            if not values and generation is None and not cfg.capture_on_demand:
                return None
            if (
                generation is None
                or len(values) != 1
                or len(values[0]) > 64
                or re.fullmatch(rb"CAM-[0-9]+", values[0]) is None
            ):
                return Response(
                    status_code=400,
                    content='{"error":"invalid logical camera id"}',
                    media_type="application/json",
                )
            return values[0].decode("ascii")

        def _grant(req):
            values = [value for name, value in req.scope.get("headers", ())
                      if name.lower() == b"x-aegis-demand-grant"]
            if len(values) != 1 or stream_hub is None:
                raise DemandGrantError("invalid demand grant")
            return verify_grant(values[0], secret=cfg.detection_engine_api_key,
                boot_id=stream_hub.producer_boot_id, node_id=cfg.node_id,
                now_ms=int(stream_hub.authority_now_ms()))

        @app.get("/producer/boot")
        async def producer_boot(request: "Request"):
            # Capture handler entry monotonically without logging untrusted input.
            from time import monotonic
            entry_ms = monotonic() * 1000
            denied = _authorized(request)
            if denied is not None:
                return denied
            timing = engine_boot_timing.begin(request.scope.get('headers', ()))
            if timing.controller:
                timing.start = entry_ms
            timing.mark('authentication')
            values = [value for name, value in request.scope.get("headers", ())
                      if name.lower() == b"x-aegis-clock-nonce"]
            if stream_hub is None or len(values) != 1 or re.fullmatch(rb"[0-9a-f]{64}", values[0]) is None:
                timing.finish('request_rejection')
                return Response(status_code=403)
            try:
                payload = {"engineBootId": stream_hub.producer_boot_id,
                           "nodeId": cfg.node_id, "nonce": values[0].decode(),
                           "engineNowMs": int(stream_hub.authority_now_ms())}
                timing.mark('authority_clock')
                content = sign_payload(payload, cfg.detection_engine_api_key, b"aegis-producer-clock-v1\n")
                timing.mark('signing')
                return _BootTimingResponse(content=content, media_type="text/plain", timing=timing,
                                           headers={"Cache-Control": "no-store"})
            except BaseException:
                timing.finish('handler_failure')
                raise

        @app.post("/producer/control")
        async def producer_control(request: "Request"):
            denied = _authorized(request)
            if denied is not None:
                return denied
            try:
                claims = _grant(request)
                if claims["action"] == "attach":
                    raise DemandGrantError("invalid demand grant")
                stream_hub.control_demand(claims)
                return Response(status_code=204)
            except DemandGrantError:
                return Response(status_code=403)
            except StaleProducerGenerationError:
                return Response(status_code=409)

        @app.get("/stream.mjpg")
        async def stream_mjpg(request: "Request"):
            denied = _authorized(request)
            if denied is not None:
                return denied
            producer_generation = _producer_generation(request)
            if isinstance(producer_generation, Response):
                return producer_generation
            logical_camera_id = _logical_camera_id(request, producer_generation)
            if isinstance(logical_camera_id, Response):
                return logical_camera_id
            if stream_hub is None:
                return Response(status_code=503, content='{"error":"stream not enabled"}',
                                media_type="application/json")
            if producer_generation is not None:
                try:
                    claims = _grant(request)
                    if (claims["producerGeneration"] != str(producer_generation)
                        or claims["logicalCameraId"] != logical_camera_id):
                        raise DemandGrantError("invalid demand grant")
                    reservation = stream_hub.reserve_demand(claims)
                except DemandGrantError:
                    return Response(status_code=403, content='{"error":"invalid demand grant"}',
                                    media_type="application/json")
                except StaleProducerGenerationError:
                    return Response(
                        status_code=409,
                        content='{"error":"stale producer generation"}',
                        media_type="application/json",
                    )

            async def frames():
                loop = asyncio.get_running_loop()
                last = -1
                idle = 0
                has_sent_frame = False
                try:
                    lease = stream_hub.attach_demand(reservation) if producer_generation is not None else stream_hub.add_viewer(
                        producer_generation=producer_generation,
                        logical_camera_id=logical_camera_id,
                    )
                except (StaleProducerGenerationError, DemandGrantError):
                    # A newer producer can supersede this request after route
                    # preflight but before Starlette begins iterating the body.
                    # End the already-created response without demand or an
                    # unhandled body-iterator exception.
                    log.info(
                        "closing stream (producer superseded before lease acquisition)"
                    )
                    return
                try:
                    # Prime immediately with whatever is current so the <img>
                    # paints on connect instead of staying blank for one period.
                    cur = stream_hub.latest()
                    if cur is not None and stream_hub.viewer_is_active(*lease):
                        last = cur[0]
                        has_sent_frame = True
                        yield _part(cur[1])
                    while True:
                        if not stream_hub.viewer_is_active(*lease):
                            break
                        # Block off-loop so the event loop stays responsive.
                        got = await loop.run_in_executor(
                            None, stream_hub.wait_for, last, 1.0
                        )
                        if not stream_hub.viewer_is_active(*lease):
                            break
                        if got is None:
                            # Capture stalled or engine stopping. Bounded wait so
                            # a dead stream is closed rather than hanging open.
                            idle += 1
                            limit = _stream_wait_limit(cfg, has_sent_frame)
                            if idle >= limit:
                                phase = "idle" if has_sent_frame else "first frame"
                                log.info(
                                    "closing stream (%s unavailable for %ds)",
                                    phase,
                                    idle,
                                )
                                break
                            continue
                        idle = 0
                        last, jpeg = got
                        has_sent_frame = True
                        yield _part(jpeg)
                finally:
                    stream_hub.remove_viewer(*lease)

            return _DisconnectAwareStreamingResponse(
                frames(),
                media_type=f"multipart/x-mixed-replace; boundary={_MJPEG_BOUNDARY}",
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate",
                    "Pragma": "no-cache",
                    "Connection": "close",
                    "X-Accel-Buffering": "no",  # never let a proxy buffer a live stream
                },
            )

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
