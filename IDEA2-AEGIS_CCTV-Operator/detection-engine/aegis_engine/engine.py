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
from dataclasses import dataclass, replace
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


def annotate_detection_frame(result: DetectionResult, frame: Frame) -> Frame:
    """Render one copy for strict Live + Archive fan-out."""
    from .stream_hub import annotate_detection_frame as render_detection_frame

    return render_detection_frame(result, frame)


def _attributed_results_for_frame(
    result: DetectionResult,
    frame: Frame,
    recording_authority,
    *,
    strict: bool,
) -> tuple[DetectionResult, ...]:
    """Bind one physical inference result to frame-time logical authority.

    Strict capture-on-demand mode never trusts the static AEGIS_CAMERA_ID for
    event identity. The same physical frame may legitimately belong to more
    than one authenticated logical alias, so emit one immutable result per
    authorized (generation, alias) context in deterministic order.

    No authority means no attributed event.
    """
    if not strict:
        return (result,)

    if recording_authority is None:
        return ()

    contexts = recording_authority.active_intervals_for_frame(
        frame.captured_at
    )

    return tuple(
        replace(
            result,
            camera_id=alias,
            producer_generation=generation,
        )
        for generation, alias in sorted(contexts)
    )


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
        self._metrics = MetricsRegistry(
            performance_profiling_enabled=self._cfg.performance_profiling_enabled,
            performance_profiling_max_samples=self._cfg.performance_profiling_max_samples,
        )
        self._metrics.on_inference_status({
            "gpu_required": self._cfg.gpu_required,
            "requested_inference_device": self._cfg.inference_device,
        })
        if recognizer is not None and hasattr(recognizer, "inference_status"):
            self._metrics.on_inference_status(recognizer.inference_status())
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
        from .identity_agent_client import IdentityAgentClient
        from .local_api import LocalEventAPI
        from .monitor_client import MonitorClient
        from .nas_sync import NASSyncWorker
        from .recording_authority import RecordingAuthority
        from .segment_recorder import SegmentRecorder
        from .stream_hub import StreamHub
        from .video_catcher import OverflowPolicy, Sink, VideoCatcher

        cfg = context.config
        metrics = context.metrics
        stop_event = context.stop_event
        # Legacy always-on recording retains its configured buffer.
        # Strict Archive holds only a small number of rendered full frames.
        record_queue_size = (
            min(cfg.record_queue_size, 2)
            if cfg.capture_on_demand
            else cfg.record_queue_size
        )
        record_queue: "queue.Queue[Frame]" = queue.Queue(
            maxsize=record_queue_size
        )
        detect_queue: "queue.Queue[Frame]" = queue.Queue(
            maxsize=cfg.detect_queue_size
        )
        stream_queue: "queue.Queue[Frame]" = queue.Queue(maxsize=1)
        capture_demand = threading.Event() if cfg.capture_on_demand else None
        recording_authority = RecordingAuthority() if cfg.capture_on_demand else None

        # Monitor owns persistence. The edge runtime never receives a DB credential.
        identity_agent = (
            IdentityAgentClient(
                pipe_name=cfg.identity_agent_pipe_name,
                timeout_s=cfg.identity_agent_timeout_s,
                response_timeout_s=cfg.identity_agent_response_timeout_s,
            )
            if cfg.monitor_ingest_mode == "identity_agent" else None
        )
        monitor = MonitorClient(
            base_url=cfg.monitor_api_base,
            api_key=(
                cfg.detection_engine_api_key
                if cfg.monitor_ingest_mode == "legacy_shared_key" else None
            ),
            timeout_s=cfg.monitor_http_timeout_s,
            identity_agent_client=identity_agent,
            ingest_mode=cfg.monitor_ingest_mode,
        )
        stream = (
            StreamHub(
                cfg,
                stream_queue,
                stop_event=stop_event,
                capture_demand_event=capture_demand,
                recording_authority=recording_authority,
                performance_profiler=metrics.profiler,
            )
            if cfg.stream_enabled else None
        )
        nas = NASSyncWorker(cfg, metrics, stop_event=stop_event, monitor=monitor)
        recorder = SegmentRecorder(
            cfg,
            metrics,
            record_queue,
            on_segment=nas.submit,
            stop_event=stop_event,
            capture_demand_event=capture_demand,
            recording_authority=recording_authority,
        )

        def publish_detection(result: DetectionResult, frame: Frame) -> None:
            # Detection geometry is meaningful only for the exact frame that
            # produced it. Fail closed before Live, Archive or event fan-out.
            if result.frame_seq != frame.seq:
                log.warning(
                    "dropping mismatched detection/frame pair "
                    "(result_seq=%d frame_seq=%d)",
                    result.frame_seq,
                    frame.seq,
                )
                return

            # Strict Live + Archive share one rendered full-frame copy.
            # The original detector frame remains untouched for inference,
            # alerts, evidence and authority attribution.
            if cfg.capture_on_demand:
                with metrics.profiler.measure("frame_render"):
                    annotated = annotate_detection_frame(result, frame)
                recorder.submit_annotated(annotated)
                if stream is not None:
                    stream.submit_annotated(annotated)
            elif stream is not None:
                stream.submit_detection(result, frame)

            # Security/event identity remains a separate authority fan-out; the
            # recorder render path cannot create or override logical authority.
            for attributed in _attributed_results_for_frame(
                result,
                frame,
                recording_authority,
                strict=cfg.capture_on_demand,
            ):
                context.on_detection(attributed, frame)

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
        detector = FaceDetectorProcessor(
            cfg,
            metrics,
            detect_queue,
            on_result=publish_detection,
            recognizer=recognizer,
            stop_event=stop_event,
        )
        # Strict viewer-demand recording is detector-rendered so Archive video
        # matches Live. Legacy always-on recording keeps the independent raw
        # capture sink for backward compatibility.
        sinks = [Sink("detect", detect_queue, OverflowPolicy.LATEST_ONLY)]
        if not cfg.capture_on_demand:
            sinks.insert(0, Sink("record", record_queue, OverflowPolicy.DROP_OLDEST))
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
                producer_generation=result.producer_generation,
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
        if self._metrics.snapshot()["accelerator_failure"]:
            raise RuntimeError("GPU-required inference failed; Engine stopped")

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
