"""
Thread → asyncio broadcast bridge.

The detection pipeline runs in plain OS threads, but the LocalEventAPI serves
WebSocket clients on an asyncio event loop. :class:`EventHub` is the safe
hand-off between the two worlds:

* Worker threads call :meth:`publish` (thread-safe, non-blocking, fire-and-forget).
* The API's event loop is registered once via :meth:`bind_loop`.
* Each connected WebSocket registers an :class:`asyncio.Queue` via
  :meth:`register` and drains it with :meth:`subscribe`.

Back-pressure policy: if a slow client's queue fills up, we drop the *oldest*
event for that client only — one stalled browser tab can never block the
detection hot-path or other clients.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Optional, Set

from .logging_setup import get_logger

log = get_logger("EventHub")


class EventHub:
    def __init__(self, per_client_queue_size: int = 256) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._clients: "Set[asyncio.Queue]" = set()
        self._lock = threading.Lock()
        self._per_client_queue_size = per_client_queue_size

    # -- lifecycle (called from the API/event-loop thread) ----------------
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Register the event loop that owns the WebSocket clients."""
        self._loop = loop

    # -- producer side (called from ANY worker thread) --------------------
    def publish(self, event: dict) -> None:
        """Broadcast ``event`` to all subscribers. Safe from any thread.

        Never raises and never blocks the caller: if the loop isn't up yet or
        there are no clients, the event is simply dropped.
        """
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._dispatch, event)
        except RuntimeError:
            # loop is shutting down — safe to ignore
            pass

    def _dispatch(self, event: dict) -> None:
        """Runs on the event loop thread: push to every client queue."""
        with self._lock:
            clients = list(self._clients)
        for q in clients:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop the oldest event for this slow client, then enqueue.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass

    # -- consumer side (called from WebSocket handlers) -------------------
    def register(self) -> "asyncio.Queue":
        q: "asyncio.Queue" = asyncio.Queue(maxsize=self._per_client_queue_size)
        with self._lock:
            self._clients.add(q)
        log.debug("client registered (%d total)", len(self._clients))
        return q

    def unregister(self, q: "asyncio.Queue") -> None:
        with self._lock:
            self._clients.discard(q)
        log.debug("client unregistered (%d total)", len(self._clients))

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)
