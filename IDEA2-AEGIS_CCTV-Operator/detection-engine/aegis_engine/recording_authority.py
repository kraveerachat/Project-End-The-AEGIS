"""Short-lock snapshot of strict recording contexts published by StreamHub.

The recorder reads copied snapshots and never takes StreamHub's condition.
No writer, queue or filesystem operation occurs under this authority lock.
"""

from __future__ import annotations

import threading
import time
from types import MappingProxyType

from .models import utc_now_iso


class RecordingAuthority:
    def __init__(self, *, monotonic_clock=time.monotonic, wall_clock=utc_now_iso) -> None:
        self._lock = threading.Lock()
        self._monotonic_clock = monotonic_clock
        self._wall_clock = wall_clock
        self._active: dict[tuple[int, str], float] = {}
        # Keep closed intervals until the recorder passes their capture-time
        # boundary (or its FIFO queue becomes empty). This also preserves a
        # short authorized session whose every frame was queued at release.
        self._observed: set[tuple[int, str, float]] = set()
        self._closed: dict[tuple[int, str, float], tuple[float, str]] = {}

    def activate(self, generation: int, alias: str, started_monotonic: float) -> None:
        with self._lock:
            self._active[(generation, alias)] = started_monotonic

    def deactivate(self, generation: int, alias: str) -> None:
        with self._lock:
            self._close_locked((generation, alias))

    def retire(self, generation: int) -> None:
        with self._lock:
            for key in tuple(self._active):
                if key[0] == generation:
                    self._close_locked(key)

    def _close_locked(self, key: tuple[int, str]) -> None:
        started = self._active.pop(key, None)
        if started is None:
            return
        self._closed[(*key, started)] = (self._monotonic_clock(), self._wall_clock())

    def observe(self, generation: int, alias: str, started_monotonic: float) -> bool:
        """Register an opening writer only while this exact activation is live."""
        with self._lock:
            key = (generation, alias)
            if self._active.get(key) != started_monotonic:
                return False
            self._observed.add((*key, started_monotonic))
            return True

    def observe_for_frame(self, generation: int, alias: str,
                          started_monotonic: float, captured_at: float) -> bool:
        """Register a writer for an active or queued, pre-release frame."""
        with self._lock:
            key = (generation, alias)
            closed = self._closed.get((*key, started_monotonic))
            if not (started_monotonic < captured_at and
                    (self._active.get(key) == started_monotonic or
                     (closed is not None and captured_at < closed[0]))):
                return False
            self._observed.add((*key, started_monotonic))
            return True

    def intervals_for_frame(self, captured_at: float):
        """Return only activations that authorized this captured frame."""
        with self._lock:
            result = {key: started for key, started in self._active.items()
                      if started < captured_at}
            for (generation, alias, started), (ended, _wall) in self._closed.items():
                if started < captured_at < ended:
                    result[(generation, alias)] = started
            return MappingProxyType(result)

    def discard_closed(self, through: float | None = None) -> None:
        """FIFO recorder acknowledgement; observed writers retain their end."""
        with self._lock:
            for identity, (ended, _wall) in tuple(self._closed.items()):
                if identity not in self._observed and (through is None or ended <= through):
                    del self._closed[identity]

    def closed_boundary(self, generation: int, alias: str, started_monotonic: float):
        with self._lock:
            return self._closed.get((generation, alias, started_monotonic))

    def unobserve(self, generation: int, alias: str, started_monotonic: float) -> None:
        with self._lock:
            observed = (generation, alias, started_monotonic)
            self._observed.discard(observed)
            # A 300-second rollover can finalize one writer while the FIFO
            # still holds later frames captured before this interval closed.
            # Only the recorder's frame/queue-drain acknowledgement may prune
            # the closed interval.

    def snapshot(self):
        with self._lock:
            return MappingProxyType(self._active.copy())
