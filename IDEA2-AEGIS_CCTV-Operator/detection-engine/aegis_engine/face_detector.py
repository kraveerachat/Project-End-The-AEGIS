"""
FaceDetectorProcessor — the AI seam of the whole engine.

╔══════════════════════════════════════════════════════════════════════════╗
║  >>> THIS IS WHERE THE AI TEAM PLUGS IN THE FACE-RECOGNITION MODEL <<<     ║
╚══════════════════════════════════════════════════════════════════════════╝

The processor thread owns the *orchestration* (pull latest frame, throttle,
time the inference, emit results, handle errors). It knows **nothing** about
how recognition actually happens. That lives behind the tiny
:class:`FaceRecognizer` interface below.

To integrate a real model, your teammate only has to:

1. Implement a class with a single method::

       class MyModel:
           def recognize(self, image_bgr) -> list[DetectedEntity]:
               # image_bgr: HxWx3 uint8 numpy array (OpenCV BGR order)
               # return one DetectedEntity per face found. Map your model's
               # verdict onto DetectionStatus.AUTHORIZED / UNKNOWN and fill in
               # confidence (0-100), name (if authorized) and bbox (x,y,w,h).
               ...

   (load weights in __init__ / a load() method — the `.pt` / `.h5` files live
   in this same folder and are git-ignored.)

2. Pass an instance in:  ``FaceDetectorProcessor(..., recognizer=MyModel())``.

That's it — capture, recording, alerting, NAS sync and the API keep working
unchanged. Until a real model is supplied, a :class:`PlaceholderRecognizer`
runs so the full pipeline is exercisable end-to-end today.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Callable, List, Optional, Protocol, runtime_checkable

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import DetectedEntity, DetectionResult, DetectionStatus, Frame

log = get_logger("FaceDetector")


# ---------------------------------------------------------------------------
# The contract the AI model must satisfy.
# ---------------------------------------------------------------------------
@runtime_checkable
class FaceRecognizer(Protocol):
    """Structural interface for a face-recognition backend.

    Any object with a compatible ``recognize`` method qualifies — no base
    class or import from this package is required on the model side.
    """

    def recognize(self, image_bgr) -> List[DetectedEntity]:  # noqa: D401
        """Return one :class:`DetectedEntity` per detected face (possibly [])."""
        ...


# ---------------------------------------------------------------------------
# Default stand-in so the pipeline runs before the real model exists.
# ---------------------------------------------------------------------------
class PlaceholderRecognizer:
    """A deliberately dumb stand-in — **replace me with the real model.**

    It uses OpenCV's bundled Haar cascade purely to find face *boxes* (no
    identity whatsoever) and labels every face ``Unknown``. That is enough to
    drive the recorder, alerting, metrics and API through realistic code paths,
    while making it obvious in logs/UI that no real recognition is wired up yet.
    """

    def __init__(self, min_confidence: float = 60.0) -> None:
        self._min_confidence = min_confidence
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        self._cascade = cv2.CascadeClassifier(cascade_path)
        if self._cascade.empty():
            log.warning(
                "Haar cascade failed to load at %s — placeholder will report "
                "no faces. This does not affect the real-model integration.",
                cascade_path,
            )

    def recognize(self, image_bgr) -> List[DetectedEntity]:
        if self._cascade.empty():
            return []
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        faces = self._cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=5)
        results: List[DetectedEntity] = []
        for (x, y, w, h) in faces:
            # Placeholder confidence scaled by face size — NOT a real score.
            conf = min(99.0, 70.0 + (w * h) / (image_bgr.shape[0] * image_bgr.shape[1]) * 400)
            results.append(
                DetectedEntity(
                    status=DetectionStatus.UNKNOWN,
                    confidence=round(conf, 1),
                    name=None,
                    bbox=(int(x), int(y), int(w), int(h)),
                )
            )
        return results


# Callback invoked for every processed frame. Receives the result plus the
# originating frame so the engine can route the raw image to the AlertManager
# (for snapshots) without the detector needing to know about alerts.
ResultCallback = Callable[[DetectionResult, Frame], None]


class FaceDetectorProcessor(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        detect_queue: "queue.Queue[Frame]",
        on_result: ResultCallback,
        recognizer: Optional[FaceRecognizer] = None,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(name="FaceDetector", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._queue = detect_queue
        self._on_result = on_result
        # >>> AI INJECTION POINT: swap PlaceholderRecognizer for the real model.
        self._recognizer: FaceRecognizer = recognizer or PlaceholderRecognizer(
            min_confidence=config.detect_min_confidence
        )
        self._stop_event = stop_event or threading.Event()
        self._frame_counter = 0
        if isinstance(self._recognizer, PlaceholderRecognizer):
            log.warning(
                "running with PlaceholderRecognizer — NO real face recognition. "
                "Inject a FaceRecognizer to enable identity matching."
            )

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        log.info("detector loop started (throttle: every %d frame(s))",
                 self._cfg.detect_every_n_frames)
        try:
            while not self._stop_event.is_set():
                try:
                    frame = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                self._frame_counter += 1
                if self._frame_counter % self._cfg.detect_every_n_frames != 0:
                    continue  # throttled — skip inference on this frame

                self._process_one(frame)
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in detector loop")
        finally:
            log.info("detector loop stopped")

    def _process_one(self, frame: Frame) -> None:
        started = time.monotonic()
        try:
            # ================= AI INFERENCE HAPPENS HERE =================
            entities = self._recognizer.recognize(frame.image)
            # ============================================================
        except Exception:
            # A model blow-up must never kill the pipeline. Log, emit an empty
            # result so downstream FPS/latency still tick, and move on.
            log.exception("recognizer.recognize() raised; skipping frame %d", frame.seq)
            entities = []

        processing_ms = (time.monotonic() - started) * 1000.0

        # Drop sub-threshold detections defensively (real models may already do this).
        entities = [
            e
            for e in entities
            if e.status is not DetectionStatus.UNKNOWN
            or e.confidence >= self._cfg.detect_min_confidence
        ]

        result = DetectionResult(
            camera_id=self._cfg.camera_id,
            frame_seq=frame.seq,
            entities=entities,
            processing_ms=processing_ms,
        )

        self._metrics.on_detection(result.to_dict(), processing_ms)
        try:
            self._on_result(result, frame)
        except Exception:  # pragma: no cover - defensive
            log.exception("on_result callback raised for frame %d", frame.seq)
