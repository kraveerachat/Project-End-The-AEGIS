"""
Thread-safe metrics registry.

Every worker reports into a single :class:`MetricsRegistry`; the
:class:`~aegis_engine.local_api.LocalEventAPI` reads a consistent snapshot out
of it for the Monitoring Web App (the FPS / latency / heartbeat / "last NAS
sync" fields in the Operator HUD all come from here).

All access is guarded by one lock. Methods are cheap and non-blocking so
hot-path callers (catcher, detector) never stall on metrics.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Deque, Dict, Optional


class _RollingRate:
    """Counts events over a sliding time window to derive a per-second rate."""

    def __init__(self, window_s: float = 5.0) -> None:
        self._window_s = window_s
        self._events: Deque[float] = deque()

    def tick(self, now: Optional[float] = None) -> None:
        now = now if now is not None else time.monotonic()
        self._events.append(now)
        self._trim(now)

    def rate(self, now: Optional[float] = None) -> float:
        now = now if now is not None else time.monotonic()
        self._trim(now)
        if len(self._events) < 2:
            return 0.0
        span = now - self._events[0]
        if span <= 0:
            return 0.0
        return (len(self._events) - 1) / span

    def _trim(self, now: float) -> None:
        cutoff = now - self._window_s
        while self._events and self._events[0] < cutoff:
            self._events.popleft()


class _RollingAvg:
    """Fixed-size rolling average, e.g. for processing latency in ms."""

    def __init__(self, maxlen: int = 120) -> None:
        self._vals: Deque[float] = deque(maxlen=maxlen)

    def add(self, v: float) -> None:
        self._vals.append(v)

    def avg(self) -> float:
        return sum(self._vals) / len(self._vals) if self._vals else 0.0

    def last(self) -> float:
        return self._vals[-1] if self._vals else 0.0


class MetricsRegistry:
    """Single source of truth for live operational metrics.

    Thread-safe: one lock protects all fields. Snapshotting returns a plain
    dict copy so callers can serialize it without holding the lock.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_monotonic = time.monotonic()

        # rates & latencies
        self._capture_fps = _RollingRate()
        self._detect_fps = _RollingRate()
        self._detect_latency = _RollingAvg()

        # counters
        self._frames_captured = 0
        self._frames_recorded = 0
        self._frames_dropped_record = 0
        self._frames_dropped_detect = 0
        self._faces_seen = 0
        self._unknowns_seen = 0
        self._alerts_sent = 0

        # last-known status blocks
        self._camera_connected = False
        self._camera_reconnects = 0
        self._last_detection: Optional[dict] = None
        self._recorder: Dict[str, object] = {"active_segment": None, "segments_written": 0}
        self._nas: Dict[str, object] = {
            "last_sync_wall": None,
            "last_status": "idle",  # idle | ok | failed
            "pending": 0,
            "synced_total": 0,
            "failed_total": 0,
        }

    # -- capture -----------------------------------------------------------
    def on_frame_captured(self) -> None:
        with self._lock:
            self._frames_captured += 1
            self._capture_fps.tick()

    def on_camera_state(self, connected: bool, reconnect: bool = False) -> None:
        with self._lock:
            self._camera_connected = connected
            if reconnect:
                self._camera_reconnects += 1

    def on_record_drop(self) -> None:
        with self._lock:
            self._frames_dropped_record += 1

    def on_detect_drop(self) -> None:
        with self._lock:
            self._frames_dropped_detect += 1

    def on_frame_recorded(self) -> None:
        with self._lock:
            self._frames_recorded += 1

    # -- detection ---------------------------------------------------------
    def on_detection(self, result_dict: dict, processing_ms: float) -> None:
        with self._lock:
            self._detect_fps.tick()
            self._detect_latency.add(processing_ms)
            self._faces_seen += int(result_dict.get("face_count", 0))
            if result_dict.get("has_unknown"):
                self._unknowns_seen += 1
            self._last_detection = result_dict

    # -- alerts ------------------------------------------------------------
    def on_alert_sent(self) -> None:
        with self._lock:
            self._alerts_sent += 1

    # -- recorder ----------------------------------------------------------
    def on_segment_started(self, path: str) -> None:
        with self._lock:
            self._recorder["active_segment"] = path

    def on_segment_finalized(self) -> None:
        with self._lock:
            self._recorder["active_segment"] = None
            self._recorder["segments_written"] = int(self._recorder["segments_written"]) + 1

    # -- NAS ---------------------------------------------------------------
    def on_nas_pending(self, pending: int) -> None:
        with self._lock:
            self._nas["pending"] = pending

    def on_nas_result(self, ok: bool, when_wall: str) -> None:
        with self._lock:
            self._nas["last_status"] = "ok" if ok else "failed"
            self._nas["last_sync_wall"] = when_wall
            if ok:
                self._nas["synced_total"] = int(self._nas["synced_total"]) + 1
            else:
                self._nas["failed_total"] = int(self._nas["failed_total"]) + 1

    # -- snapshot ----------------------------------------------------------
    def snapshot(self) -> dict:
        """Return a consistent, JSON-serializable copy of all metrics."""
        now = time.monotonic()
        with self._lock:
            return {
                "type": "metrics",
                "uptime_s": round(now - self._started_monotonic, 1),
                "camera_connected": self._camera_connected,
                "camera_reconnects": self._camera_reconnects,
                "capture_fps": round(self._capture_fps.rate(now), 1),
                "detect_fps": round(self._detect_fps.rate(now), 1),
                "latency_ms": round(self._detect_latency.last(), 1),
                "latency_ms_avg": round(self._detect_latency.avg(), 1),
                "frames_captured": self._frames_captured,
                "frames_recorded": self._frames_recorded,
                "frames_dropped_record": self._frames_dropped_record,
                "frames_dropped_detect": self._frames_dropped_detect,
                "faces_seen": self._faces_seen,
                "unknowns_seen": self._unknowns_seen,
                "alerts_sent": self._alerts_sent,
                "recorder": dict(self._recorder),
                "nas": dict(self._nas),
                "last_detection": self._last_detection,
            }
