import unittest

from aegis_engine.performance_profiler import PerformanceProfiler


class FakeClock:
    def __init__(self):
        self.value = 10.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class FakeCudaEvent:
    def __init__(self, elapsed_ms=7.5):
        self.elapsed_ms = elapsed_ms
        self.recorded = False

    def record(self):
        self.recorded = True

    def elapsed_time(self, other):
        if not self.recorded or not other.recorded:
            raise AssertionError("CUDA events must both be recorded")
        return self.elapsed_ms


class FakeCuda:
    def __init__(self):
        self.sync_devices = []
        self.events = []

    def synchronize(self, device):
        self.sync_devices.append(device)

    def Event(self, *, enable_timing):
        if not enable_timing:
            raise AssertionError("timing events must enable timing")
        event = FakeCudaEvent()
        self.events.append(event)
        return event


class FakeTorch:
    def __init__(self):
        self.cuda = FakeCuda()


class PerformanceProfilerTests(unittest.TestCase):
    def test_disabled_profiler_retains_no_samples(self):
        profiler = PerformanceProfiler(enabled=False)
        profiler.record('camera_acquisition', 12.5)
        self.assertEqual(profiler.snapshot(), {'enabled': False})

    def test_snapshot_has_only_aggregate_bounded_percentiles_and_throughput(self):
        clock = FakeClock()
        profiler = PerformanceProfiler(enabled=True, max_samples=4, clock=clock)
        for duration in [1, 2, 3, 4, 100]:
            profiler.record('yolo_cuda', duration)
            clock.advance(.25)
        stage = profiler.snapshot()['stages']['yolo_cuda']
        self.assertEqual(stage['samples'], 4)
        self.assertEqual(stage['p50_ms'], 3.0)
        self.assertEqual(stage['p95_ms'], 100.0)
        self.assertEqual(stage['p99_ms'], 100.0)
        self.assertGreater(stage['throughput_per_s'], 0)
        self.assertNotIn('raw_samples', stage)

    def test_unknown_stage_is_rejected(self):
        profiler = PerformanceProfiler(enabled=True)
        with self.assertRaises(ValueError):
            profiler.record('identity_name', 1.0)

    def test_measure_records_elapsed_time_without_payload(self):
        clock = FakeClock()
        profiler = PerformanceProfiler(enabled=True, clock=clock)
        with profiler.measure('frame_render'):
            clock.advance(.0125)
        self.assertEqual(
            profiler.snapshot()['stages']['frame_render']['p50_ms'], 12.5
        )

    def test_cuda_measurement_synchronizes_only_in_explicit_profiling_mode(self):
        runtime = FakeTorch()
        profiler = PerformanceProfiler(enabled=True)
        with profiler.measure_cuda('yolo_cuda', runtime, 'cuda:0'):
            pass
        snapshot = profiler.snapshot()
        self.assertEqual(runtime.cuda.sync_devices, ['cuda:0', 'cuda:0'])
        self.assertEqual(snapshot['cuda_synchronized_samples'], 1)
        self.assertEqual(snapshot['stages']['yolo_cuda']['p50_ms'], 7.5)

        disabled_runtime = FakeTorch()
        disabled = PerformanceProfiler(enabled=False)
        with disabled.measure_cuda('yolo_cuda', disabled_runtime, 'cuda:0'):
            pass
        self.assertEqual(disabled_runtime.cuda.sync_devices, [])
        self.assertEqual(disabled.snapshot(), {'enabled': False})

    def test_cpu_yolo_stage_is_distinct_from_cuda_telemetry(self):
        profiler = PerformanceProfiler(enabled=True)
        profiler.record('yolo_cpu', 4.0)
        stages = profiler.snapshot()['stages']
        self.assertIn('yolo_cpu', stages)
        self.assertNotIn('yolo_cuda', stages)


if __name__ == '__main__':
    unittest.main()
