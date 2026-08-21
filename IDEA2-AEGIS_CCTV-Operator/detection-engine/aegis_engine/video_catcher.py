"""
VideoCatcher — the only thread that ever touches the camera.

Grabbing frames from a webcam is a blocking I/O call. If the recorder or the AI
model read the camera directly, a slow model would stall capture and the whole
pipeline would judder. So capture is isolated in this dedicated thread whose
*only* job is to pull frames as fast as the device allows and hand them off.

Fan-out and back-pressure
-------------------------
Each downstream consumer gets its own :class:`~queue.Queue` "sink" with an
explicit overflow policy:

* ``DROP_OLDEST`` — recorder: keep the stream flowing; if the writer briefly
  falls behind, drop the oldest frame rather than growing memory unbounded.
* ``LATEST_ONLY`` — detector: only ever hold the *freshest* frame (queue size
  1). Inference on a stale frame is worthless for a live security feed, so we
  overwrite instead of backing up.

Resilience
----------
If the device drops (unplugged webcam, RTSP hiccup) the catcher reconnects
with exponential backoff and reports camera state into the metrics registry —
that drives the "disconnects today" / heartbeat fields in the Operator HUD.
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "OpenCV (opencv-python) is required for the Detection Engine. "
        "Install it with: pip install -r requirements.txt"
    ) from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import Frame

log = get_logger("VideoCatcher")


class OverflowPolicy(Enum):
    DROP_OLDEST = "drop_oldest"  # keep newest N, drop oldest when full
    LATEST_ONLY = "latest_only"  # queue of size 1, always overwrite


@dataclass
class Sink:
    """A downstream queue plus how to behave when it's full."""

    name: str
    queue: "queue.Queue[Frame]"
    policy: OverflowPolicy


class VideoCatcher(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        sinks: List[Sink],
        stop_event: Optional[threading.Event] = None,
        capture_demand_event: Optional[threading.Event] = None,
    ) -> None:
        super().__init__(name="VideoCatcher", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._sinks = sinks
        # NB: attribute is deliberately NOT named ``_stop`` — that shadows
        # ``threading.Thread._stop`` (an internal method used by join()).
        self._stop_event = stop_event or threading.Event()
        self._capture_demand_event = capture_demand_event
        self._cap: "Optional[cv2.VideoCapture]" = None
        self._seq = 0

    # -- public API --------------------------------------------------------
    def stop(self) -> None:
        self._stop_event.set()

    # -- camera plumbing ---------------------------------------------------
    def _open_source(self):
        """Coerce the configured source to int index or leave as URL string."""
        src = self._cfg.camera_source
        try:
            return int(src)
        except (TypeError, ValueError):
            return src

    def _open_camera(self) -> bool:
        source = self._open_source()
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            cap.release()
            return False
        # Best-effort hints; devices may ignore them.
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._cfg.frame_width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._cfg.frame_height)
        cap.set(cv2.CAP_PROP_FPS, self._cfg.target_fps)
        # Small internal buffer keeps latency low on the live feed.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        self._cap = cap
        return True

    def _connect_with_backoff(self) -> bool:
        """Block (interruptibly) until the camera opens or we're told to stop."""
        delay = self._cfg.capture_reconnect_delay_s
        first = True
        while not self._stop_event.is_set() and self._capture_is_demanded():
            if self._open_camera():
                w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or self._cfg.frame_width
                h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self._cfg.frame_height
                log.info("camera %s opened (%dx%d)", self._cfg.camera_source, w, h)
                self._metrics.on_camera_state(connected=True, reconnect=not first)
                return True
            log.warning(
                "camera %s unavailable; retrying in %.1fs",
                self._cfg.camera_source,
                delay,
            )
            self._metrics.on_camera_state(connected=False)
            first = False
            if not self._wait_while_demanded(delay):
                break
            delay = min(delay * 2, self._cfg.capture_max_reconnect_delay_s)
        return False

    def _capture_is_demanded(self) -> bool:
        """Always-on mode has implicit demand; viewer mode uses the shared event."""
        return (
            self._capture_demand_event is None
            or self._capture_demand_event.is_set()
        )

    def _wait_for_demand(self) -> bool:
        if self._capture_demand_event is None:
            return not self._stop_event.is_set()
        while not self._stop_event.is_set():
            if self._capture_demand_event.wait(0.25):
                return True
        return False

    def _wait_while_demanded(self, timeout_s: float) -> bool:
        """Backoff that stops promptly when the last viewer disconnects."""
        deadline = time.monotonic() + timeout_s
        while not self._stop_event.is_set() and self._capture_is_demanded():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True
            self._stop_event.wait(min(remaining, 0.25))
        return False

    # -- fan-out -----------------------------------------------------------
    def _dispatch(self, frame: Frame) -> None:
        for sink in self._sinks:
            if sink.policy is OverflowPolicy.LATEST_ONLY:
                self._put_latest(sink, frame)
            else:
                self._put_drop_oldest(sink, frame)

    def _put_latest(self, sink: Sink, frame: Frame) -> None:
        """Keep only the newest frame; overwrite whatever is queued."""
        while True:
            try:
                sink.queue.put_nowait(frame)
                return
            except queue.Full:
                try:
                    sink.queue.get_nowait()  # discard stale frame
                    self._count_drop(sink)
                except queue.Empty:
                    # drained by the consumer between calls — retry the put
                    continue

    def _put_drop_oldest(self, sink: Sink, frame: Frame) -> None:
        try:
            sink.queue.put_nowait(frame)
        except queue.Full:
            try:
                sink.queue.get_nowait()
                self._count_drop(sink)
                sink.queue.put_nowait(frame)
            except queue.Empty:
                sink.queue.put_nowait(frame)
            except queue.Full:
                self._count_drop(sink)

    def _count_drop(self, sink: Sink) -> None:
        if sink.name == "record":
            self._metrics.on_record_drop()
        elif sink.name == "detect":
            self._metrics.on_detect_drop()

    # -- main loop ---------------------------------------------------------
    def run(self) -> None:
        mode = "viewer-demand" if self._capture_demand_event is not None else "always-on"
        log.info("starting capture loop for %s (%s)", self._cfg.camera_id, mode)
        try:
            while not self._stop_event.is_set():
                if not self._wait_for_demand():
                    break
                if not self._connect_with_backoff():
                    continue

                consecutive_failures = 0
                while (
                    not self._stop_event.is_set()
                    and self._capture_is_demanded()
                ):
                    ok, image = self._cap.read()
                    if not ok or image is None:
                        consecutive_failures += 1
                        log.warning(
                            "frame grab failed (%d in a row)", consecutive_failures
                        )
                        # A few misses can be transient; a run of them means the
                        # device is gone — tear down and reconnect.
                        if consecutive_failures >= 15:
                            self._metrics.on_camera_state(connected=False)
                            self._release_camera()
                            if not self._connect_with_backoff():
                                break
                            consecutive_failures = 0
                        else:
                            time.sleep(0.05)
                        continue

                    consecutive_failures = 0
                    self._seq += 1
                    frame = Frame(seq=self._seq, image=image)
                    self._metrics.on_frame_captured()
                    self._dispatch(frame)

                if self._capture_demand_event is not None:
                    self._release_camera()
                    self._metrics.on_camera_state(connected=False)
                    log.info("camera released (no authenticated viewers)")
        except Exception:  # pragma: no cover - defensive catch-all
            log.exception("unhandled error in capture loop")
        finally:
            self._release_camera()
            self._metrics.on_camera_state(connected=False)
            log.info("capture loop stopped (%d frames captured)", self._seq)

    def _release_camera(self) -> None:
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
