"""
DetectionEngine — the orchestrator that wires every worker together.

This module owns the Queues and the shared stop :class:`threading.Event`, builds
each worker, connects them with callbacks, and manages start-up / graceful
shutdown. It is the only place that knows the full topology; individual workers
stay decoupled and independently testable.

Data flow (see the package docstring for the diagram)::

    VideoCatcher ─┬─(record_queue, drop-oldest)─▶ SegmentRecorder ─▶ NASSyncWorker
                  └─(detect_queue, latest-only)─▶ FaceDetectorProcessor
                                                        │ on_result(result, frame)
                                                        ├─▶ LocalEventAPI.publish_event
                                                        └─▶ AlertManager.submit

Injecting a real face-recognition model::

    from aegis_engine.engine import DetectionEngine
    engine = DetectionEngine(recognizer=MyModel())   # <-- your model here
    engine.run_forever()
"""

from __future__ import annotations

import queue
import signal
import threading
import uuid
from typing import Optional

from .alert_manager import AlertManager
from .config import EngineConfig
from .event_hub import EventHub
from .face_detector import FaceDetectorProcessor, FaceRecognizer
from .heartbeat_worker import HeartbeatWorker
from .local_api import LocalEventAPI
from .logging_setup import configure as configure_logging, get_logger
from .metrics import MetricsRegistry
from .models import DetectionResult, DetectionStatus, Frame
from .monitor_client import MonitorClient
from .nas_sync import NASSyncWorker
from .segment_recorder import SegmentRecorder
from .video_catcher import OverflowPolicy, Sink, VideoCatcher

log = get_logger("Engine")


class DetectionEngine:
    def __init__(
        self,
        config: Optional[EngineConfig] = None,
        recognizer: Optional[FaceRecognizer] = None,
    ) -> None:
        self._cfg = (config or EngineConfig.from_env()).validate()
        configure_logging(self._cfg.log_level, self._cfg.log_json)

        self._stop = threading.Event()
        self._metrics = MetricsRegistry()
        self._hub = EventHub()

        # One shared client to Monitor's backend — persists detections/clips/alerts
        # to the shared DB over HTTP (never a direct Postgres connection). All calls
        # fail soft: if Monitor is unreachable, the pipeline keeps running.
        self._monitor = MonitorClient()

        # Queues bridging the threads.
        self._record_queue: "queue.Queue[Frame]" = queue.Queue(
            maxsize=self._cfg.record_queue_size
        )
        self._detect_queue: "queue.Queue[Frame]" = queue.Queue(
            maxsize=self._cfg.detect_queue_size
        )

        # Live API (owns the event hub so REST + WS + heartbeat share one bus).
        self._api = LocalEventAPI(self._cfg, self._metrics, event_hub=self._hub)

        # Alert manager publishes onto the same live stream.
        self._alerts = AlertManager(
            self._cfg, self._metrics, stop_event=self._stop,
            publish=self._api.publish_event, monitor=self._monitor,
        )

        # NAS off-load worker; the recorder hands finalized segments to it.
        self._nas = NASSyncWorker(
            self._cfg, self._metrics, stop_event=self._stop, monitor=self._monitor,
        )

        # Continuous segment recorder.
        self._recorder = SegmentRecorder(
            self._cfg, self._metrics, self._record_queue,
            on_segment=self._nas.submit, stop_event=self._stop,
        )

        # AI processor — the model injection point.
        self._detector = FaceDetectorProcessor(
            self._cfg, self._metrics, self._detect_queue,
            on_result=self._on_detection, recognizer=recognizer,
            stop_event=self._stop,
        )

        # Capture thread fans frames out to both queues.
        self._catcher = VideoCatcher(
            self._cfg, self._metrics,
            sinks=[
                Sink("record", self._record_queue, OverflowPolicy.DROP_OLDEST),
                Sink("detect", self._detect_queue, OverflowPolicy.LATEST_ONLY),
            ],
            stop_event=self._stop,
        )

        # Liveness publisher — the only source behind Monitor's /api/link.
        # Started last, stopped first, so the final heartbeat reflects a
        # running pipeline rather than one mid-teardown.
        self._heartbeat = HeartbeatWorker(
            self._cfg, self._metrics, self._monitor, stop_event=self._stop,
        )

        self._threads = [
            self._catcher, self._detector, self._recorder, self._alerts, self._nas,
            self._heartbeat,
        ]

    # -- detection fan-out callback ---------------------------------------
    def _on_detection(self, result: DetectionResult, frame: Frame) -> None:
        """Runs on the FaceDetector thread for every processed frame."""
        # 1) Stream the detection JSON to the web app (live + ring buffer).
        self._api.publish_event(result.to_dict())
        # 2) Consider it for alerting (AlertManager applies the cooldown).
        self._alerts.submit(result, frame)
        # 3) Persist the recognition event to the shared DB via Monitor's backend.
        #    One frame with several people → one event carrying several entities
        #    (Monitor writes one `detections` row per person, sharing a frame_id).
        #    Only frames that actually contain a face are persisted — an empty
        #    frame (NO_FACE only) has nothing to record. Fails soft (see client).
        entities = [
            {"status": e.status.value, "name": e.name, "confidence": e.confidence}
            for e in result.entities
            if e.status is not DetectionStatus.NO_FACE
        ]
        if entities:
            self._monitor.post_detection(
                camera_id=result.camera_id,
                entities=entities,
                frame_id=uuid.uuid4().hex,
                at=result.timestamp,
            )

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        log.info("AEGIS Detection Engine starting")
        for k, v in self._cfg.redacted().items():
            log.info("  config · %s = %s", k, v)
        # Start the API first so its event loop is ready to accept publishes.
        self._api.start()
        for t in self._threads:
            t.start()
        log.info("all workers started")

    def stop(self) -> None:
        log.info("shutdown requested — stopping workers")
        self._stop.set()
        # Join in a sensible order: stop producing, flush recorder, then the rest.
        for t in (self._heartbeat, self._catcher, self._recorder, self._detector,
                  self._alerts, self._nas):
            t.join(timeout=15.0)
            if t.is_alive():
                log.warning("worker %s did not stop within timeout", t.name)
        self._api.stop()
        self._api.join(timeout=10.0)
        log.info("engine stopped")

    def run_forever(self) -> None:
        """Start everything and block until SIGINT/SIGTERM, then shut down."""
        self._install_signal_handlers()
        self.start()
        try:
            # Wait on the stop event so Ctrl-C is handled promptly on all OSes.
            while not self._stop.is_set():
                self._stop.wait(1.0)
        except KeyboardInterrupt:  # pragma: no cover
            pass
        finally:
            self.stop()

    def _install_signal_handlers(self) -> None:
        def _handler(signum, _frame):
            log.info("received signal %s", signum)
            self._stop.set()

        for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None)):
            if sig is None:
                continue
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):  # pragma: no cover
                # Not in the main thread, or unsupported on this platform.
                log.debug("could not install handler for signal %s", sig)
