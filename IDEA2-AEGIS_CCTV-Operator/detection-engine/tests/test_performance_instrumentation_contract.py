import pathlib
import os
import unittest
from unittest.mock import patch

from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry


ROOT = pathlib.Path(__file__).resolve().parents[1]


class PerformanceInstrumentationContractTests(unittest.TestCase):
    def test_profiling_is_disabled_by_default_and_bounded(self):
        cfg = EngineConfig().validate()
        self.assertFalse(cfg.performance_profiling_enabled)
        self.assertGreaterEqual(cfg.performance_profiling_max_samples, 10)
        self.assertLessEqual(cfg.performance_profiling_max_samples, 10_000)

    def test_profiling_requires_explicit_environment_opt_in(self):
        with patch.dict(os.environ, {
            'AEGIS_PERFORMANCE_PROFILING_ENABLED': 'true',
            'AEGIS_PERFORMANCE_PROFILING_MAX_SAMPLES': '120',
        }, clear=True):
            cfg = EngineConfig.from_env().validate()
        self.assertTrue(cfg.performance_profiling_enabled)
        self.assertEqual(cfg.performance_profiling_max_samples, 120)

        with self.assertRaisesRegex(ValueError, 'AEGIS_PERFORMANCE_PROFILING_MAX_SAMPLES'):
            EngineConfig(performance_profiling_max_samples=9).validate()

    def test_metrics_publish_only_aggregate_profile(self):
        metrics = MetricsRegistry(performance_profiling_enabled=True,
                                  performance_profiling_max_samples=20)
        metrics.profiler.record('jpeg_encode', 8.0)
        profile = metrics.snapshot()['performance_profile']
        self.assertTrue(profile['enabled'])
        self.assertEqual(profile['stages']['jpeg_encode']['samples'], 1)
        self.assertNotIn('frames', repr(profile).lower())
        self.assertNotIn('identity', repr(profile).lower())

    def test_all_required_stage_boundaries_are_wired(self):
        sources = '\n'.join((ROOT / path).read_text(encoding='utf-8') for path in [
            'aegis_engine/video_catcher.py',
            'aegis_engine/face_detector.py',
            'aegis_engine/yolo_sface_admin_recognizer.py',
            'aegis_engine/engine.py',
            'aegis_engine/stream_hub.py',
        ])
        for stage in [
            'camera_acquisition', 'detector_queue_wait', 'image_preprocess',
            'yunet_cpu', 'yolo_cuda', 'sface_cpu', 'frame_render',
            'callback_recording', 'jpeg_encode', 'stream_delivery',
        ]:
            self.assertTrue(
                f'"{stage}"' in sources or f"'{stage}'" in sources,
                f"missing instrumentation boundary for {stage}",
            )

    def test_cuda_stage_uses_explicit_synchronization_only_when_enabled(self):
        source = (ROOT / 'aegis_engine/performance_profiler.py').read_text(encoding='utf-8')
        self.assertIn('cuda.synchronize', source)
        self.assertIn('if not self.enabled', source)


if __name__ == '__main__':
    unittest.main()
