"""
SegmentRecorder — interval-based disk recording from one raw frame queue.

Strict capture-on-demand recording fans each authorized detector-processed
frame out to independent ``(producer generation, logical alias)`` writers.
The processed frame carries the exact same burned-in face boxes/labels as Live;
positive detection does not start recording because the detector publishes a
frame even when no face is present. Each writer keeps its own 300-second
rollover and measured final partial when that alias's last viewer leaves. The
always-on compatibility path retains its raw configured-camera writer.

Each finalized segment is handed to ``on_segment`` (wired to the NAS worker's
queue by the engine) as a :class:`SegmentInfo`. The recorder never deletes
files — that is the NAS worker's job, and only after a verified transfer.

Threading notes
---------------
Runs in its own thread and consumes :class:`Frame` objects from the record
queue. In strict viewer-demand mode that queue is fed by the detector render
path so Archive and Live use identical geometry; legacy always-on mode keeps
the raw capture queue. The ``cv2.VideoWriter`` is created lazily from the first frame's real
dimensions (so it matches whatever the device actually delivers). Rotation is
checked on every frame *and* on the read-timeout, so an idle/stalled feed still
rolls its file on schedule instead of leaving one segment open forever.
"""

from __future__ import annotations

import os
import queue
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import DetectionResult, Frame, SegmentInfo, utc_now_iso
from .recording_authority import RecordingAuthority
from .stream_hub import annotate_detection_frame

log = get_logger("SegmentRecorder")

SegmentCallback = Callable[[SegmentInfo], None]


@dataclass
class _StrictSegment:
    writer: object
    size: tuple[int, int]
    path: str
    started_monotonic: float
    capture_started_monotonic: float
    started_wall: str
    authority_started_monotonic: float
    frames: int = 0
    last_image: object | None = None


class SegmentRecorder(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        record_queue: "queue.Queue[Frame]",
        on_segment: SegmentCallback,
        stop_event: Optional[threading.Event] = None,
        capture_demand_event: Optional[threading.Event] = None,
        recording_authority: Optional[RecordingAuthority] = None,
        *, monotonic_clock=time.monotonic,
    ) -> None:
        super().__init__(name="SegmentRecorder", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._queue = record_queue
        self._on_segment = on_segment
        self._stop_event = stop_event or threading.Event()
        self._capture_demand_event = capture_demand_event
        self._recording_authority = recording_authority
        self._monotonic_clock = monotonic_clock
        self._strict_contexts: dict[tuple[int, str], _StrictSegment] = {}

        self._writer: "Optional[cv2.VideoWriter]" = None
        self._writer_size: Optional[tuple] = None  # (w, h) the writer was opened at
        self._current_path: Optional[str] = None
        self._segment_started_monotonic = 0.0
        self._segment_capture_started_monotonic = 0.0
        self._segment_started_wall = ""
        self._segment_frames = 0

    def stop(self) -> None:
        self._stop_event.set()

    def submit_detection(self, result: DetectionResult, frame: Frame) -> bool:
        """Feed one exact detector frame into strict archival recording.

        The queue remains bounded and drops its oldest rendered frame if the
        writer falls behind. Raw capture is untouched; legacy recording never
        enters this path.
        """
        if not self._strict_mode or result.frame_seq != frame.seq:
            return False
        annotated = annotate_detection_frame(result, frame)
        try:
            self._queue.put_nowait(annotated)
        except queue.Full:
            try:
                self._queue.get_nowait()
                self._metrics.on_record_drop()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(annotated)
            except queue.Full:
                self._metrics.on_record_drop()
                return False
        return True

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
                    if self._strict_mode:
                        self._reconcile_strict_contexts()
                        self._rotate_strict_contexts()
                        continue
                    # Viewer-demand capture must close the active container when
                    # the last authorized stream ends. A later login starts a
                    # new segment instead of appending across a private gap.
                    if (
                        self._capture_demand_event is not None
                        and not self._capture_demand_event.is_set()
                    ):
                        self._finalize_segment()
                    # No frames right now — still honour the rotation clock.
                    self._maybe_rotate()
                    continue

                self._process_frame(frame)
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in recorder loop")
        finally:
            # Flush whatever is open so the last segment isn't lost on shutdown.
            ended_monotonic = self._monotonic_clock()
            ended_wall = utc_now_iso()
            for key in tuple(self._strict_contexts):
                self._finalize_strict_segment(key, ended_monotonic, ended_wall)
            self._finalize_segment()
            log.info("recorder stopped")

    @property
    def _strict_mode(self) -> bool:
        return self._cfg.capture_on_demand and self._recording_authority is not None

    def _process_frame(self, frame: Frame) -> None:
        if not self._strict_mode:
            self._ensure_writer(frame)
            self._write(frame)
            self._maybe_rotate()
            return
        active = self._reconcile_strict_contexts(frame.captured_at)
        eligible = (self._recording_authority.intervals_for_frame(frame.captured_at)
                    if hasattr(self._recording_authority, "intervals_for_frame") else active)
        for key, started_monotonic in eligible.items():
            generation, alias = key
            if (not isinstance(generation, int) or isinstance(generation, bool)
                    or generation <= 0 or not isinstance(alias, str)
                    or len(alias) > 64 or re.fullmatch(r"CAM-[0-9]+", alias) is None
                    or frame.captured_at <= started_monotonic):
                continue
            self._rotate_strict_contexts(key, frame.captured_at, frame.captured_wall)
            if key not in self._strict_contexts:
                self._open_strict_writer(key, frame)
            segment = self._strict_contexts.get(key)
            if segment is not None:
                self._write_strict_frame(segment, frame)
        if hasattr(self._recording_authority, "discard_closed"):
            self._recording_authority.discard_closed(frame.captured_at)

    def _reconcile_strict_contexts(self, frame_captured_at=None):
        active = self._recording_authority.snapshot()
        ended_monotonic = self._monotonic_clock()
        ended_wall = utc_now_iso()
        for key in tuple(self._strict_contexts):
            started = self._strict_contexts[key].authority_started_monotonic
            still_active = active.get(key) == started
            stopped = self._recording_authority.closed_boundary(key[0], key[1], started)
            queued_before_stop = (frame_captured_at is not None and stopped is not None
                                  and frame_captured_at < stopped[0])
            if not still_active and not queued_before_stop:
                self._finalize_strict_segment(key, ended_monotonic, ended_wall)
        if frame_captured_at is None and hasattr(self._recording_authority, "discard_closed"):
            self._recording_authority.discard_closed()
        return active

    def _rotate_strict_contexts(self, key=None, ended_monotonic=None, ended_wall=None) -> None:
        if ended_monotonic is None:
            ended_monotonic = self._monotonic_clock()
        if ended_wall is None:
            ended_wall = utc_now_iso()
        keys = (key,) if key is not None else tuple(self._strict_contexts)
        for candidate in keys:
            segment = self._strict_contexts.get(candidate)
            if segment and ended_monotonic - segment.started_monotonic >= self._cfg.segment_seconds:
                self._finalize_strict_segment(candidate, ended_monotonic, ended_wall)

    def _open_strict_writer(self, key: tuple[int, str], frame: Frame) -> None:
        generation, alias = key
        frame_intervals = getattr(self._recording_authority, "intervals_for_frame", None)
        started_monotonic = (frame_intervals(frame.captured_at).get(key) if frame_intervals
                             else self._recording_authority.snapshot().get(key))
        if started_monotonic is None or frame.captured_at <= started_monotonic:
            return
        observe_frame = getattr(self._recording_authority, "observe_for_frame", None)
        observed = (observe_frame(generation, alias, started_monotonic, frame.captured_at)
                    if observe_frame else self._recording_authority.observe(generation, alias, started_monotonic))
        if not observed:
            return
        h, w = frame.image.shape[:2]
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"{alias}_{generation}_{timestamp}_{secrets.token_hex(16)}.{self._cfg.segment_extension}"
        path = os.path.join(self._cfg.segment_dir, filename)
        try:
            fourcc = cv2.VideoWriter_fourcc(*self._cfg.segment_fourcc)
            writer = cv2.VideoWriter(path, fourcc, float(self._cfg.target_fps), (w, h))
        except Exception:
            self._recording_authority.unobserve(generation, alias, started_monotonic)
            raise
        if not writer.isOpened():
            self._recording_authority.unobserve(generation, alias, started_monotonic)
            log.error("failed to open attributed VideoWriter at %s", path)
            return
        self._strict_contexts[key] = _StrictSegment(
            writer=writer,
            size=(w, h),
            path=path,
            started_monotonic=float(frame.captured_at),
            capture_started_monotonic=float(frame.captured_at),
            started_wall=frame.captured_wall,
            authority_started_monotonic=started_monotonic,
        )
        self._metrics.on_segment_started(path)

    def _write_strict_frame(self, segment: _StrictSegment, frame: Frame) -> None:
        image = frame.image
        if (image.shape[1], image.shape[0]) != segment.size:
            image = cv2.resize(image, segment.size)
        segment.last_image = image
        elapsed = max(0.0, float(frame.captured_at) - segment.capture_started_monotonic)
        target_total = max(1, int(elapsed * float(self._cfg.target_fps)) + 1)
        try:
            for _ in range(max(0, target_total - segment.frames)):
                segment.writer.write(image)
                segment.frames += 1
                self._metrics.on_frame_recorded()
        except Exception:
            log.exception("failed writing attributed frame to %s", segment.path)

    def _pad_strict_segment(self, segment: _StrictSegment, ended_monotonic: float) -> None:
        """Extend the CFR media timeline to the exact authority/rotation end."""
        if segment.last_image is None:
            return
        elapsed = max(
            0.0,
            float(ended_monotonic) - segment.capture_started_monotonic,
        )
        target_total = max(1, int(elapsed * float(self._cfg.target_fps)) + 1)
        try:
            for _ in range(max(0, target_total - segment.frames)):
                segment.writer.write(segment.last_image)
                segment.frames += 1
                self._metrics.on_frame_recorded()
        except Exception:
            log.exception("failed padding attributed frame to %s", segment.path)

    def _finalize_strict_segment(
        self, key: tuple[int, str], ended_monotonic=None, ended_wall=None
    ) -> None:
        # Capture the authority/rotation end before codec release, filesystem
        # inspection or publication can block. Sibling aliases share the same
        # boundary when one transition closes several contexts.
        if ended_monotonic is None:
            ended_monotonic = self._monotonic_clock()
        if ended_wall is None:
            ended_wall = utc_now_iso()
        segment = self._strict_contexts.pop(key, None)
        if segment is None:
            return
        stopped = self._recording_authority.closed_boundary(
            key[0], key[1], segment.authority_started_monotonic)
        if stopped is not None and stopped[0] <= ended_monotonic:
            ended_monotonic, ended_wall = stopped
        self._pad_strict_segment(segment, ended_monotonic)
        self._recording_authority.unobserve(key[0], key[1], segment.authority_started_monotonic)
        try:
            segment.writer.release()
        except Exception:
            log.exception("error releasing attributed writer for %s", segment.path)
        self._metrics.on_segment_finalized(segment.path)
        if not os.path.exists(segment.path):
            log.warning("finalized attributed segment missing on disk: %s", segment.path)
            return
        size_bytes = os.path.getsize(segment.path)
        if not size_bytes:
            log.warning("finalized attributed segment is empty: %s", segment.path)
            try:
                os.remove(segment.path)
            except OSError:
                pass
            return
        info = SegmentInfo(
            path=os.path.abspath(segment.path),
            camera_id=key[1],
            started_wall=segment.started_wall,
            ended_wall=ended_wall,
            duration_s=max(0.0, ended_monotonic - segment.started_monotonic),
            size_bytes=size_bytes,
            producer_generation=key[0],
        )
        try:
            self._on_segment(info)
        except Exception:  # pragma: no cover - defensive
            log.exception("on_segment callback raised for %s", segment.path)

    # -- writer management -------------------------------------------------
    def _ensure_writer(self, frame: Frame) -> None:
        h, w = frame.image.shape[:2]
        if self._writer is not None and self._writer_size == (w, h):
            return
        if self._writer is not None:
            # Resolution changed mid-stream (e.g. after reconnect) — roll over.
            self._finalize_segment()
        # The camera may ignore CAP_PROP_FPS. Preserve its real monotonic
        # capture timeline and normalize only the recorded CFR representation.
        self._segment_capture_started_monotonic = float(frame.captured_at)
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
        if self._segment_capture_started_monotonic <= 0.0:
            self._segment_capture_started_monotonic = (
                self._segment_started_monotonic
            )
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

        # OpenCV VideoWriter uses a fixed media FPS and does not preserve the
        # timestamps of incoming frames. Physical cameras may ignore the
        # requested CAP_PROP_FPS, so writing every captured frame can make the
        # resulting media duration longer or shorter than real elapsed time.
        #
        # Map the real monotonic capture timeline onto configured target_fps.
        # A source faster than target_fps drops surplus captured frames; a
        # slower source duplicates the latest available frame to preserve
        # elapsed media time.
        capture_elapsed = max(
            0.0,
            float(frame.captured_at)
            - self._segment_capture_started_monotonic,
        )
        target_total_frames = max(
            1,
            int(capture_elapsed * float(self._cfg.target_fps)) + 1,
        )
        writes_needed = target_total_frames - self._segment_frames

        if writes_needed <= 0:
            return

        try:
            for _ in range(writes_needed):
                self._writer.write(img)
                self._segment_frames += 1
                self._metrics.on_frame_recorded()
        except Exception:
            log.exception(
                "failed writing frame to %s",
                self._current_path,
            )

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
        self._segment_capture_started_monotonic = 0.0
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
