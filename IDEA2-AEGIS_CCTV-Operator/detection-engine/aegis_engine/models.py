"""
Shared, thread-safe-by-value data types passed between workers.

These are plain, immutable-ish dataclasses (no OpenCV / numpy types leak into
the public shape except the raw frame buffer). Keeping the contract here means
the AI teammate integrating the model, and the web-app team consuming the API,
have a single source of truth for the JSON shape.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, List, Optional, Tuple

# ``numpy.ndarray`` is only used as a type hint for the frame buffer; importing
# it lazily keeps this module import-light for tests that don't touch frames.
try:  # pragma: no cover
    from numpy import ndarray as _NDArray
except Exception:  # pragma: no cover
    _NDArray = Any  # type: ignore


def utc_now_iso() -> str:
    """ISO-8601 UTC timestamp, e.g. ``2026-07-18T07:22:07.123456+00:00``."""
    return datetime.now(timezone.utc).isoformat()


class DetectionStatus(str, Enum):
    """The recognition verdict for a single detected face.

    Mirrors the ``bboxState`` enum in the Operator web UI (authorized/unknown)
    plus an explicit NO_FACE sentinel for frames with nothing to report.
    """

    AUTHORIZED = "Authorized"
    UNKNOWN = "Unknown"
    NO_FACE = "NoFace"


@dataclass
class Frame:
    """A single captured frame flowing through the queues.

    ``image`` is a BGR ``numpy.ndarray`` exactly as returned by OpenCV. It is
    passed by reference through the queues — workers must treat it as read-only
    to stay thread-safe (never mutate a frame in place downstream).
    """

    seq: int
    """Monotonically increasing frame counter assigned by the VideoCatcher."""

    image: "_NDArray"
    """BGR image buffer (H, W, 3)."""

    captured_at: float = field(default_factory=time.monotonic)
    """``time.monotonic()`` at capture — used for latency math, not wall time."""

    captured_wall: str = field(default_factory=utc_now_iso)
    """Wall-clock ISO timestamp at capture — used for logs and payloads."""


@dataclass
class DetectedEntity:
    """One recognised (or unrecognised) face.

    This is exactly the object the AI model must yield. The two canonical
    shapes from the brief map cleanly onto these fields::

        {"status": "Unknown",    "confidence": 95, "timestamp": "..."}
        {"status": "Authorized", "name": "M. REYES", ...}
    """

    status: DetectionStatus
    confidence: float = 0.0
    name: Optional[str] = None
    # bounding box in pixels: (x, y, w, h). Optional so the placeholder and
    # simple models can omit it; the web UI draws the box when present.
    bbox: Optional[Tuple[int, int, int, int]] = None
    track_id: Optional[str] = None
    timestamp: str = field(default_factory=utc_now_iso)

    def is_unknown(self) -> bool:
        return self.status is DetectionStatus.UNKNOWN

    def display_name(self) -> str:
        return self.name or ("Unknown" if self.is_unknown() else "—")

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "confidence": round(float(self.confidence), 2),
            "name": self.name,
            "bbox": list(self.bbox) if self.bbox else None,
            "track_id": self.track_id,
            "timestamp": self.timestamp,
        }


@dataclass
class DetectionResult:
    """The full outcome of running the detector on one frame.

    Emitted by :class:`~aegis_engine.face_detector.FaceDetectorProcessor` and
    fanned out to the metrics registry, the alert manager and the event hub.
    """

    camera_id: str
    frame_seq: int
    entities: List[DetectedEntity]
    processing_ms: float
    timestamp: str = field(default_factory=utc_now_iso)

    @property
    def has_unknown(self) -> bool:
        return any(e.is_unknown() for e in self.entities)

    @property
    def face_count(self) -> int:
        return sum(1 for e in self.entities if e.status is not DetectionStatus.NO_FACE)

    def to_dict(self) -> dict:
        return {
            "type": "detection",
            "camera_id": self.camera_id,
            "frame_seq": self.frame_seq,
            "processing_ms": round(self.processing_ms, 2),
            "face_count": self.face_count,
            "has_unknown": self.has_unknown,
            "entities": [e.to_dict() for e in self.entities],
            "timestamp": self.timestamp,
        }


@dataclass
class SegmentInfo:
    """Metadata for a finalized ~10-minute recording segment."""

    path: str
    camera_id: str
    started_wall: str
    ended_wall: str
    duration_s: float
    size_bytes: int

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "camera_id": self.camera_id,
            "started_wall": self.started_wall,
            "ended_wall": self.ended_wall,
            "duration_s": round(self.duration_s, 1),
            "size_bytes": self.size_bytes,
        }
