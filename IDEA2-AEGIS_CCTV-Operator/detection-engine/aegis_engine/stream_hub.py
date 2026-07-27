"""
StreamHub — hand the newest captured frame to N MJPEG viewers.

Why not just read the detector's queue
--------------------------------------
``detect_queue`` is a ``LATEST_ONLY`` queue of size 1 and every item put on it
is *consumed once*. If the streamer read from it, each frame would go either to
the detector or to a viewer, never both, and inference throughput would halve
the moment somebody opened the live view. So the streamer gets its own sink on
the **existing** VideoCatcher fan-out: no second ``cv2.VideoCapture``, no extra
device handle, no change to how capture works — one more consumer on the
already-existing broadcast.

Why a hub rather than a queue per viewer
----------------------------------------
JPEG encoding is the expensive part. Encoding once per frame and sharing the
bytes with every viewer keeps cost constant no matter how many people are
watching. Viewers never block the pipeline: they read whatever the latest
encoded frame is, and a slow client simply skips frames (correct for live
video — a stale frame is worthless).

Backpressure/liveness contract
------------------------------
* ``latest()`` returns ``(seq, jpeg_bytes)`` or ``None`` if nothing captured yet.
* ``wait_for(after_seq, timeout)`` blocks until a *newer* frame exists, then
  returns it; returns ``None`` on timeout so the caller can emit a keep-alive
  or notice the client vanished.
* When capture stalls, ``wait_for`` times out rather than hanging forever —
  that is what lets the HTTP layer close a dead stream instead of leaking it.
"""

from __future__ import annotations

import queue
import threading
from typing import Optional, Tuple

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .models import Frame

log = get_logger("StreamHub")


class StreamHub(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        frame_queue: "queue.Queue[Frame]",
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(name="StreamHub", daemon=True)
        self._cfg = config
        self._queue = frame_queue
        self._stop_event = stop_event or threading.Event()

        self._cond = threading.Condition()
        self._seq = 0
        self._jpeg: Optional[bytes] = None
        self._viewers = 0
        self._encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(config.stream_jpeg_quality)]

    def stop(self) -> None:
        self._stop_event.set()
        with self._cond:
            self._cond.notify_all()  # unblock any waiting viewer so it can exit

    # -- viewer bookkeeping (drives the "N watching" number in metrics/logs) --
    def add_viewer(self) -> None:
        with self._cond:
            self._viewers += 1
            n = self._viewers
        log.info("viewer connected (%d watching)", n)

    def remove_viewer(self) -> None:
        with self._cond:
            self._viewers = max(0, self._viewers - 1)
            n = self._viewers
        log.info("viewer disconnected (%d watching)", n)

    @property
    def viewers(self) -> int:
        with self._cond:
            return self._viewers

    # -- consumer API ------------------------------------------------------
    def latest(self) -> Optional[Tuple[int, bytes]]:
        with self._cond:
            if self._jpeg is None:
                return None
            return self._seq, self._jpeg

    def wait_for(self, after_seq: int, timeout: float) -> Optional[Tuple[int, bytes]]:
        """Block until a frame newer than ``after_seq`` exists. None on timeout/stop."""
        with self._cond:
            if self._stop_event.is_set():
                return None
            if self._seq > after_seq and self._jpeg is not None:
                return self._seq, self._jpeg
            self._cond.wait(timeout)
            if self._stop_event.is_set():
                return None
            if self._seq > after_seq and self._jpeg is not None:
                return self._seq, self._jpeg
            return None

    # -- producer loop -----------------------------------------------------
    def run(self) -> None:
        log.info(
            "stream hub started · JPEG q=%d · max %.1f fps",
            self._cfg.stream_jpeg_quality,
            self._cfg.stream_max_fps,
        )
        min_interval = 1.0 / self._cfg.stream_max_fps if self._cfg.stream_max_fps > 0 else 0.0
        last_emit = 0.0
        import time as _time
        try:
            while not self._stop_event.is_set():
                try:
                    frame = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                # Nobody is watching -> do not pay for JPEG encoding at all.
                if self.viewers == 0:
                    continue

                now = _time.monotonic()
                if min_interval and (now - last_emit) < min_interval:
                    continue  # throttle: viewers do not need every capture frame
                last_emit = now

                ok, buf = cv2.imencode(".jpg", frame.image, self._encode_params)
                if not ok:
                    continue
                with self._cond:
                    self._seq += 1
                    self._jpeg = buf.tobytes()
                    self._cond.notify_all()
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in stream hub loop")
        finally:
            with self._cond:
                self._cond.notify_all()
            log.info("stream hub stopped")
