"""Transactional startup and cooperative shutdown for the detection runtime.

The orchestrator owns many independently testable workers. This small module
keeps their lifecycle deterministic: the API starts first, workers start in
declared order, and any partial startup is rolled back before an actionable
error is returned to the operator.
"""

from __future__ import annotations

import threading
from typing import Iterable, List, Optional

from .logging_setup import get_logger

log = get_logger("RuntimeLifecycle")


class RuntimeLifecycle:
    """Start and stop API/worker components exactly once."""

    def __init__(
        self,
        *,
        api: object,
        workers: Iterable[object],
        shutdown_order: Iterable[object],
        stop_event: threading.Event,
        worker_join_timeout_s: float = 15.0,
        api_join_timeout_s: float = 10.0,
    ) -> None:
        self._api = api
        self._workers = list(workers)
        self._shutdown_order = list(shutdown_order)
        self._stop_event = stop_event
        self._worker_join_timeout_s = worker_join_timeout_s
        self._api_join_timeout_s = api_join_timeout_s
        self._started_workers: List[object] = []
        self._api_started = False
        self._started_once = False
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._started_once:
                raise RuntimeError("Detection Engine lifecycle cannot be started more than once")
            self._started_once = True

            component = "LocalEventAPI"
            try:
                self._api.start()
                self._api_started = True
                for worker in self._workers:
                    component = getattr(worker, "name", type(worker).__name__)
                    # Track the worker before start() so a partial start failure is
                    # still included in the same rollback and bounded join path.
                    self._started_workers.append(worker)
                    worker.start()
            except Exception as exc:
                self._stop_event.set()
                self._stop_started_components()
                raise RuntimeError(
                    f"Detection Engine startup failed while starting {component}: {exc}"
                ) from exc

    def stop(self) -> None:
        with self._lock:
            self._stop_event.set()
            self._stop_started_components()

    def _stop_started_components(self) -> None:
        started_ids = {id(worker) for worker in self._started_workers}
        ordered = [
            worker for worker in self._shutdown_order if id(worker) in started_ids
        ]
        ordered_ids = {id(item) for item in ordered}
        for worker in self._started_workers:
            if id(worker) not in ordered_ids:
                ordered.append(worker)
                ordered_ids.add(id(worker))

        for worker in ordered:
            name = getattr(worker, "name", type(worker).__name__)
            try:
                worker.join(timeout=self._worker_join_timeout_s)
                if worker.is_alive():
                    log.warning("worker %s did not stop within timeout", name)
            except RuntimeError as exc:
                log.warning("worker %s could not be joined: %s", name, exc)

        self._started_workers.clear()
        if self._api_started:
            try:
                self._api.stop()
                self._api.join(timeout=self._api_join_timeout_s)
            finally:
                self._api_started = False
