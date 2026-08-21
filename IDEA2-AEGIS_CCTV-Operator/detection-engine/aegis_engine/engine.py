"""Canonical modular Detection Engine orchestrator.

This module validates configuration, builds the capture/detection/recording
components, and owns their transactional startup and clean shutdown. Heavy
camera/API dependencies are imported only by the default component factory so
configuration and lifecycle behavior can be tested with lightweight doubles.
"""

from __future__ import annotations

import signal
import threading
import uuid
from dataclasses import dataclass
from typing import Callable, Optional, Sequence, TYPE_CHECKING

from .config import EngineConfig
from .event_hub import EventHub
from .lifecycle import RuntimeLifecycle
from .logging_setup import configure as configure_logging, get_logger
from .metrics import MetricsRegistry
from .models import DetectionResult, DetectionStatus, Frame

if TYPE_CHECKING:
    from .face_detector import FaceRecognizer

log = get_logger("Engine")


@dataclass(frozen=True)
class EngineContext:
    """Dependency-light state supplied to a runtime component factory."""

    config: EngineConfig
    metrics: MetricsRegistry
    event_hub: EventHub
    stop_event: threading.Event
    on_detection: Callable[[DetectionResult, Frame], None]


@dataclass(frozen=True)
class EngineComponents:
    """Concrete components managed by :class:`DetectionEngine`."""

    monitor: object
    api: object
    alerts: object
    workers: Sequence[object]
    shutdown_order: Sequence[object]


ComponentFactory = Callable[
    [EngineContext, Optional["FaceRecognizer"]], EngineComponents
]


class DetectionEngine:
    """Wire and run one camera's canonical modular detection pipeline."""

    def __init__(
        self,
        config: Optional[EngineConfig] = None,
        recognizer: Optional["FaceRecognizer"] = None,
        component_factory: Optional[ComponentFactory] = None,
    ) -> None:
        self._cfg = (config or EngineConfig.from_env()).validate()
        configure_logging(self._cfg.log_level, self._cfg.log_json)

        self._stop = threading.Event()
        self._metrics = MetricsRegistry()
        self._hub = EventHub()
        context = EngineContext(
            config=self._cfg,
            metrics=self._metrics,
            event_hub=self._hub,
            stop_event=self._stop,
            on_detection=self._on_detection,
        )
        components = (component_factory or self._build_default_components)(
            context, recognizer
        )
        self._monitor = components.monitor
        self._api = components.api
        self._alerts = components.alerts
        self._threads = list(components.workers)
        self._lifecycle = RuntimeLifecycle(
            api=self._api,
            workers=self._threads,
            shutdown_order=components.shutdown_order,
            stop_event=self._stop,
        )

    @staticmethod
    def _build_default_components(
        context: EngineContext,
        recognizer: Optional["FaceRecognizer"],
    ) -> EngineComponents:
        """Build camera/API components after configuration has validated."""
        import queue

        from .alert_manager import AlertManager
        from .face_detector import FaceDetectorProcessor
        from .heartbeat_worker import HeartbeatWorker
        from .local_api import LocalEventAPI
        from .monitor_client import MonitorClient
        from .nas_sync import NASSyncWorker
        from .segment_recorder import SegmentRecorder
        from .stream_hub import StreamHub
        from .video_catcher import OverflowPolicy, Sink, VideoCatcher

        cfg = context.config
        metrics = context.metrics
        stop_event = context.stop_event
        record_queue: "queue.Queue[Frame]" = queue.Queue(maxsize=cfg.record_queue_size)
        detect_queue: "queue.Queue[Frame]" = queue.Queue(maxsize=cfg.detect_queue_size)
        stream_queue: "queue.Queue[Frame]" = queue.Queue(maxsize=1)
        capture_demand = threading.Event() if cfg.capture_on_demand else None

        # Monitor owns persistence. The edge runtime never receives a DB credential.
        monitor = MonitorClient(
            base_url=cfg.monitor_api_base,
            api_key=cfg.detection_engine_api_key,
            timeout_s=cfg.monitor_http_timeout_s,
        )
        stream = (
            StreamHub(
                cfg,
                stream_queue,
                stop_event=stop_event,
                capture_demand_event=capture_demand,
            )
            if cfg.stream_enabled else None
        )

        def publish_detection(result: DetectionResult, frame: Frame) -> None:
            # Stream the exact frame that produced these boxes. The capture
            # fan-out keeps recording raw frames on its independent queue.
            if stream is not None:
                stream.submit_detection(result, frame)
            context.on_detection(result, frame)

        api = LocalEventAPI(
            cfg,
            metrics,
            event_hub=context.event_hub,
            stream_hub=stream,
            capture_demand_event=capture_demand,
        )
        alerts = AlertManager(
            cfg,
            metrics,
            stop_event=stop_event,
            publish=api.publish_event,
            monitor=monitor,
        )
        nas = NASSyncWorker(cfg, metrics, stop_event=stop_event, monitor=monitor)
        recorder = SegmentRecorder(
            cfg,
            metrics,
            record_queue,
            on_segment=nas.submit,
            stop_event=stop_event,
            capture_demand_event=capture_demand,
        )
        detector = FaceDetectorProcessor(
            cfg,
            metrics,
            detect_queue,
            on_result=publish_detection,
            recognizer=recognizer,
            stop_event=stop_event,
        )
        sinks = [
            Sink("record", record_queue, OverflowPolicy.DROP_OLDEST),
            Sink("detect", detect_queue, OverflowPolicy.LATEST_ONLY),
        ]
        catcher = VideoCatcher(
            cfg,
            metrics,
            sinks=sinks,
            stop_event=stop_event,
            capture_demand_event=capture_demand,
        )
        heartbeat = HeartbeatWorker(cfg, metrics, monitor, stop_event=stop_event)

        workers = [catcher, detector, recorder, alerts, nas, heartbeat]
        # Stop liveness first, then the producer, flush the recorder, and finish
        # consumers. Stream stops after its producer has stopped.
        shutdown_order = [heartbeat, catcher, recorder, detector, alerts, nas]
        if stream is not None:
            workers.append(stream)
            shutdown_order.append(stream)
        return EngineComponents(
            monitor=monitor,
            api=api,
            alerts=alerts,
            workers=workers,
            shutdown_order=shutdown_order,
        )

    def _on_detection(self, result: DetectionResult, frame: Frame) -> None:
        """Fan one processed frame out to live API, alerts, and Monitor."""
        self._api.publish_event(result.to_dict())
        self._alerts.submit(result, frame)
        entities = [
            {"status": entity.status.value, "name": entity.name,
             "confidence": entity.confidence}
            for entity in result.entities
            if entity.status is not DetectionStatus.NO_FACE
        ]
        if entities:
            self._monitor.post_detection(
                camera_id=result.camera_id,
                entities=entities,
                frame_id=uuid.uuid4().hex,
                at=result.timestamp,
            )

    def start(self) -> None:
        log.info("AEGIS Detection Engine starting")
        for key, value in self._cfg.redacted().items():
            log.info("  config · %s = %s", key, value)
        self._lifecycle.start()
        log.info("all workers started")

    def stop(self) -> None:
        log.info("shutdown requested — stopping workers")
        self._lifecycle.stop()
        log.info("engine stopped")

    def run_forever(self) -> None:
        """Start everything and block until SIGINT/SIGTERM, then shut down."""
        self._install_signal_handlers()
        self.start()
        try:
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
                log.debug("could not install handler for signal %s", sig)
