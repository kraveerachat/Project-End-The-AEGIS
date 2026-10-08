"""Opt-in aggregate-only performance measurements for the Engine pipeline."""

from __future__ import annotations

import contextlib
import math
import threading
import time
from collections import deque


PROFILE_STAGES = frozenset({
    "camera_acquisition",
    "detector_queue_wait",
    "image_preprocess",
    "yunet_cpu",
    "yolo_cuda",
    "yolo_cpu",
    "sface_cpu",
    "frame_render",
    "callback_recording",
    "jpeg_encode",
    "stream_delivery",
})


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


class PerformanceProfiler:
    """Bounded timing aggregates; accepts no payload or identity fields."""

    def __init__(self, *, enabled: bool = False, max_samples: int = 600,
                 clock=time.monotonic) -> None:
        self.enabled = bool(enabled)
        self._clock = clock
        self._lock = threading.Lock()
        self._durations = {
            stage: deque(maxlen=max_samples) for stage in PROFILE_STAGES
        }
        self._completed_at = {
            stage: deque(maxlen=max_samples) for stage in PROFILE_STAGES
        }
        self._cuda_synchronized_samples = 0

    def record(self, stage: str, duration_ms: float) -> None:
        if stage not in PROFILE_STAGES:
            raise ValueError(f"unsupported performance stage: {stage}")
        if not self.enabled:
            return
        value = max(0.0, float(duration_ms))
        with self._lock:
            self._durations[stage].append(value)
            self._completed_at[stage].append(self._clock())

    @contextlib.contextmanager
    def measure(self, stage: str):
        if stage not in PROFILE_STAGES:
            raise ValueError(f"unsupported performance stage: {stage}")
        if not self.enabled:
            yield
            return
        started = self._clock()
        try:
            yield
        finally:
            self.record(stage, (self._clock() - started) * 1000.0)

    @contextlib.contextmanager
    def measure_cuda(self, stage: str, torch_runtime, device: str):
        """Synchronize CUDA only in explicit profiling mode for true elapsed time."""
        if not self.enabled or not device.startswith("cuda:"):
            with self.measure(stage):
                yield
            return
        cuda = torch_runtime.cuda
        cuda.synchronize(device)
        started = cuda.Event(enable_timing=True)
        ended = cuda.Event(enable_timing=True)
        started.record()
        try:
            yield
        finally:
            ended.record()
            cuda.synchronize(device)
            self.record(stage, float(started.elapsed_time(ended)))
            with self._lock:
                self._cuda_synchronized_samples += 1

    def snapshot(self) -> dict:
        if not self.enabled:
            return {"enabled": False}
        with self._lock:
            output = {}
            for stage in sorted(PROFILE_STAGES):
                values = list(self._durations[stage])
                if not values:
                    continue
                completed = list(self._completed_at[stage])
                span = completed[-1] - completed[0] if len(completed) > 1 else 0.0
                output[stage] = {
                    "samples": len(values),
                    "p50_ms": round(_percentile(values, .50), 3),
                    "p95_ms": round(_percentile(values, .95), 3),
                    "p99_ms": round(_percentile(values, .99), 3),
                    "throughput_per_s": round((len(completed) - 1) / span, 3)
                    if span > 0 else 0.0,
                }
            return {
                "enabled": True,
                "aggregate_only": True,
                "cuda_timing": "synchronized-events",
                "cuda_synchronized_samples": self._cuda_synchronized_samples,
                "stages": output,
            }
