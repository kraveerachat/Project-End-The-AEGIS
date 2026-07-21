"""
SegmentRecorder — continuous, interval-based disk recording.

Records the feed **continuously** and rolls to a new file on a fixed wall-clock
interval (default ~600 s / 10 minutes). This is deliberately *interval-based,
not detection-triggered*: the archive is a complete, gap-free record, and the
Operator "Archival footage" grid expects evenly-sized ~10-minute clips.

Each finalized segment is handed to ``on_segment`` (wired to the NAS worker's
queue by the engine) as a :class:`SegmentInfo`. The recorder never deletes
files — that is the NAS worker's job, and only after a verified transfer.

Threading notes
---------------
Runs in its own thread and consumes :class:`Frame` objects from the record
queue. The ``cv2.VideoWriter`` is created lazily from the first frame's real
dimensions (so it matches whatever the device actually delivers). Rotation is
checked on every frame *and* on the read-timeout, so an idle/stalled feed still
rolls its file on schedule instead of leaving one segment open forever.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from datetime import datetime
from typing import Callable, Optional

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import Frame, SegmentInfo, utc_now_iso

log = get_logger("SegmentRecorder")

SegmentCallback = Callable[[SegmentInfo], None]


class SegmentRecorder(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        record_queue: "queue.Queue[Frame]",
        on_segment: SegmentCallback,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(name="SegmentRecorder", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._queue = record_queue
        self._on_segment = on_segment
        self._stop_event = stop_event or threading.Event()

        self._writer: "Optional[cv2.VideoWriter]" = None
        self._writer_size: Optional[tuple] = None  # (w, h) the writer was opened at
        self._current_path: Optional[str] = None
        self._segment_started_monotonic = 0.0
        self._segment_started_wall = ""
        self._segment_frames = 0

    def stop(self) -> None:
        self._stop_event.set()

    # -- lifecycle ---------------------------------------------------------
    def run(self) -> None:
        os.makedirs(self._cfg.segment_dir, exist_ok=True)
        log.info(
            "recorder started · %ds segments · dir=%s",
            self._cfg.segment_seconds,
            os.path.abspath(self._cfg.segment_dir),
        )
        try:
            while not self._stop_event.is_set():
                try:
                    frame = self._queue.get(timeout=0.5)
                except queue.Empty:
                    # No frames right now — still honour the rotation clock.
                    self._maybe_rotate()
                    continue

                self._ensure_writer(frame)
                self._write(frame)
                self._maybe_rotate()
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in recorder loop")
        finally:
            # Flush whatever is open so the last segment isn't lost on shutdown.
            self._finalize_segment()
            log.info("recorder stopped")

    # -- writer management -------------------------------------------------
    def _ensure_writer(self, frame: Frame) -> None:
        h, w = frame.image.shape[:2]
        if self._writer is not None and self._writer_size == (w, h):
            return
        if self._writer is not None:
            # Resolution changed mid-stream (e.g. after reconnect) — roll over.
            self._finalize_segment()
        self._open_writer(w, h)

    def _open_writer(self, w: int, h: int) -> None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{self._cfg.camera_id}_{ts}.{self._cfg.segment_extension}"
        path = os.path.join(self._cfg.segment_dir, filename)
        fourcc = cv2.VideoWriter_fourcc(*self._cfg.segment_fourcc)
        writer = cv2.VideoWriter(path, fourcc, float(self._cfg.target_fps), (w, h))
        if not writer.isOpened():
            log.error(
                "failed to open VideoWriter at %s (fourcc=%s). Check codec "
                "availability for .%s files.",
                path,
                self._cfg.segment_fourcc,
                self._cfg.segment_extension,
            )
            self._writer = None
            self._writer_size = None
            return
        self._writer = writer
        self._writer_size = (w, h)
        self._current_path = path
        self._segment_started_monotonic = time.monotonic()
        self._segment_started_wall = utc_now_iso()
        self._segment_frames = 0
        self._metrics.on_segment_started(path)
        log.info("recording new segment: %s (%dx%d)", filename, w, h)

    def _write(self, frame: Frame) -> None:
        if self._writer is None:
            return
        img = frame.image
        if (img.shape[1], img.shape[0]) != self._writer_size:
            img = cv2.resize(img, self._writer_size)
        try:
            self._writer.write(img)
            self._segment_frames += 1
            self._metrics.on_frame_recorded()
        except Exception:
            log.exception("failed writing frame to %s", self._current_path)

    def _maybe_rotate(self) -> None:
        if self._writer is None:
            return
        elapsed = time.monotonic() - self._segment_started_monotonic
        if elapsed >= self._cfg.segment_seconds:
            self._finalize_segment()

    def _finalize_segment(self) -> None:
        if self._writer is None:
            return
        path = self._current_path
        started_wall = self._segment_started_wall
        duration = time.monotonic() - self._segment_started_monotonic
        frames = self._segment_frames

        try:
            self._writer.release()
        except Exception:
            log.exception("error releasing writer for %s", path)
        self._writer = None
        self._writer_size = None
        self._current_path = None
        self._metrics.on_segment_finalized()

        if not path or not os.path.exists(path):
            log.warning("finalized segment missing on disk: %s", path)
            return

        size_bytes = os.path.getsize(path)
        if size_bytes == 0:
            log.warning("finalized segment is 0 bytes, discarding: %s", path)
            try:
                os.remove(path)
            except OSError:
                pass
            return

        info = SegmentInfo(
            path=os.path.abspath(path),
            camera_id=self._cfg.camera_id,
            started_wall=started_wall,
            ended_wall=utc_now_iso(),
            duration_s=duration,
            size_bytes=size_bytes,
        )
        log.info(
            "segment finalized: %s (%.1fs, %d frames, %.1f MB)",
            os.path.basename(path),
            duration,
            frames,
            size_bytes / 1e6,
        )
        try:
            self._on_segment(info)
        except Exception:  # pragma: no cover - defensive
            log.exception("on_segment callback raised for %s", path)
