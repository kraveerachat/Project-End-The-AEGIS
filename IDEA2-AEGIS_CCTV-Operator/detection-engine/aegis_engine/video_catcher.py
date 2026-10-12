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

* ``DROP_OLDEST`` — legacy always-on recorder: keep the stream flowing; if
  the writer briefly falls behind, drop the oldest raw frame rather than growing
  memory unbounded. Strict viewer-demand Archive recording is fed later from the
  detector-render path so stored footage can match Live annotations.
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
from typing import Callable, List, Optional

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
        capture_authority_check: Optional[Callable[[], bool]] = None,
    ) -> None:
        super().__init__(name="VideoCatcher", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._sinks = sinks
        # NB: attribute is deliberately NOT named ``_stop`` — that shadows
        # ``threading.Thread._stop`` (an internal method used by join()).
        self._stop_event = stop_event or threading.Event()
        self._capture_demand_event = capture_demand_event
        self._capture_authority_check = capture_authority_check
        self._cap: "Optional[cv2.VideoCapture]" = None
        self._seq = 0
        self._read_state_lock = threading.Lock()
        self._read_started_at: Optional[float] = None
        self._read_generation = 0
        self._read_has_frame_since_open = False
        self._read_watchdog_stop = threading.Event()

    # -- public API --------------------------------------------------------
    def stop(self) -> None:
        self._stop_event.set()

    def _reset_read_state_for_open(self) -> None:
        with self._read_state_lock:
            self._read_started_at = None
            self._read_generation += 1
            self._read_has_frame_since_open = False

    def _begin_read(self) -> None:
        with self._read_state_lock:
            self._read_generation += 1
            self._read_started_at = time.monotonic()

    def _finish_read(self, delivered: bool) -> None:
        with self._read_state_lock:
            self._read_started_at = None
            if delivered:
                self._read_has_frame_since_open = True

    def _read_watchdog_loop(self) -> None:
        """Fail the process closed when native VideoCapture.read() never returns.

        Python cannot safely cancel a C/C++ camera read that is blocked inside
        an OpenCV backend. The Engine supervisor already owns process recovery,
        so a bounded stall requests normal Engine shutdown instead of leaking a
        wedged camera handle or pretending the camera remains connected.
        """
        while not self._stop_event.is_set():
            if self._read_watchdog_stop.wait(0.25):
                return

            with self._read_state_lock:
                started_at = self._read_started_at
                generation = self._read_generation
                has_frame = self._read_has_frame_since_open

            if started_at is None:
                continue

            limit = float(
                self._cfg.stream_idle_timeout_s
                if has_frame
                else self._cfg.stream_first_frame_timeout_s
            )
            limit = max(1.0, limit)
            elapsed = time.monotonic() - started_at

            if elapsed < limit:
                continue

            # The native read may have completed after our snapshot and the
            # capture thread may already be executing a newer read. Revalidate
            # the exact read generation before escalating to Engine shutdown.
            with self._read_state_lock:
                if (
                    self._read_generation != generation
                    or self._read_started_at != started_at
                ):
                    continue

                # Latch this timeout so no later watchdog iteration can
                # escalate the same native read twice.
                self._read_started_at = None

            log.error(
                "camera %s read blocked for %.1fs (limit %.1fs); "
                "requesting Engine shutdown for supervisor recovery",
                self._cfg.camera_source,
                elapsed,
                limit,
            )
            self._metrics.on_camera_state(connected=False)
            self._stop_event.set()
            return

    def _start_read_watchdog(self) -> threading.Thread:
        self._read_watchdog_stop.clear()
        watchdog = threading.Thread(
            target=self._read_watchdog_loop,
            name="VideoCatcherReadWatchdog",
            daemon=True,
        )
        watchdog.start()
        return watchdog

    # -- camera plumbing ---------------------------------------------------
    def _open_source(self):
        """Coerce the configured source to int index or leave as URL string."""
        src = self._cfg.camera_source
        try:
            return int(src)
        except (TypeError, ValueError):
            return src

    def _set_camera_hint(self, cap, prop, value, label: str) -> None:
        """Apply one non-authoritative backend hint without killing capture.

        OpenCV camera backends may reject or throw while applying width,
        height, FPS or buffer hints. Those settings are best-effort and must
        never terminate the sole long-lived VideoCatcher worker.
        """
        try:
            accepted = cap.set(prop, value)
            if accepted is False:
                log.warning(
                    "camera %s ignored %s hint",
                    self._cfg.camera_source,
                    label,
                )
        except Exception:
            log.warning(
                "camera %s rejected %s hint; continuing with backend defaults",
                self._cfg.camera_source,
                label,
                exc_info=True,
            )

    def _open_camera(self) -> bool:
        source = self._open_source()
        cap = None
        try:
            cap = cv2.VideoCapture(source)
            if not cap.isOpened():
                cap.release()
                return False

            self._set_camera_hint(
                cap,
                cv2.CAP_PROP_FRAME_WIDTH,
                self._cfg.frame_width,
                "width",
            )
            self._set_camera_hint(
                cap,
                cv2.CAP_PROP_FRAME_HEIGHT,
                self._cfg.frame_height,
                "height",
            )
            self._set_camera_hint(
                cap,
                cv2.CAP_PROP_FPS,
                self._cfg.target_fps,
                "fps",
            )
            self._set_camera_hint(
                cap,
                cv2.CAP_PROP_BUFFERSIZE,
                1,
                "buffer-size",
            )

            self._cap = cap
            self._reset_read_state_for_open()
            return True
        except Exception:
            log.exception(
                "camera %s open attempt raised; treating camera as unavailable",
                self._cfg.camera_source,
            )
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            return False

    def _connect_with_backoff(self) -> bool:
        """Block (interruptibly) until the camera opens or we're told to stop."""
        delay = self._cfg.capture_reconnect_delay_s
        first = True
        while not self._stop_event.is_set() and self._capture_is_demanded():
            try:
                opened = self._open_camera()
            except Exception:
                # Defensive boundary: even an unexpected open-path exception
                # becomes an ordinary reconnect attempt, never a dead worker.
                log.exception(
                    "camera %s open cycle failed; retrying",
                    self._cfg.camera_source,
                )
                self._release_camera()
                opened = False

            if opened:
                try:
                    w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or self._cfg.frame_width
                except Exception:
                    w = self._cfg.frame_width
                try:
                    h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self._cfg.frame_height
                except Exception:
                    h = self._cfg.frame_height
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
        if self._capture_authority_check is not None:
            return bool(self._capture_authority_check())
        return (
            self._capture_demand_event is None
            or self._capture_demand_event.is_set()
        )

    def _wait_for_demand(self) -> bool:
        if self._capture_demand_event is None:
            return not self._stop_event.is_set()
        while not self._stop_event.is_set():
            if self._capture_authority_check is not None:
                if self._capture_is_demanded():
                    return True
                self._stop_event.wait(0.25)
                continue
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
        watchdog = self._start_read_watchdog()
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
                    self._begin_read()
                    try:
                        ok, image = self._cap.read()
                    except Exception:
                        self._finish_read(False)
                        log.exception(
                            "camera %s read raised; reconnecting",
                            self._cfg.camera_source,
                        )
                        self._metrics.on_camera_state(connected=False)
                        self._release_camera()
                        if not self._connect_with_backoff():
                            break
                        consecutive_failures = 0
                        continue

                    self._finish_read(bool(ok and image is not None))

                    if not self._capture_is_demanded():
                        break
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
            # A terminal capture-worker failure must never leave the API
            # advertising a healthy Engine without a physical producer.
            log.exception("unhandled error in capture loop")
            self._stop_event.set()
        finally:
            self._read_watchdog_stop.set()
            if (
                watchdog is not threading.current_thread()
                and watchdog.is_alive()
            ):
                watchdog.join(timeout=1.0)
            self._release_camera()
            self._metrics.on_camera_state(connected=False)
            log.info("capture loop stopped (%d frames captured)", self._seq)

    def _release_camera(self) -> None:
        with self._read_state_lock:
            self._read_started_at = None
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
