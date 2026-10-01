"""Thread-safe per-session request sequence allocation."""

from __future__ import annotations

import threading


MAX_UINT64 = (1 << 64) - 1


class SequenceExhausted(RuntimeError):
    pass


class SequenceAllocator:
    def __init__(self, *, initial: int = 0):
        if not 0 <= initial <= MAX_UINT64:
            raise ValueError("initial sequence is outside uint64")
        self._current = initial
        self._lock = threading.Lock()

    @property
    def current(self) -> int:
        with self._lock:
            return self._current

    def next(self) -> int:
        with self._lock:
            if self._current >= MAX_UINT64:
                raise SequenceExhausted("Agent request sequence exhausted")
            self._current += 1
            return self._current
