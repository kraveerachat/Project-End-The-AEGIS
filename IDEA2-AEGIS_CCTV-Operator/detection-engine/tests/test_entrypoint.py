import contextlib
import io
import unittest
from unittest.mock import patch

import run


class EntrypointTests(unittest.TestCase):
    def test_entrypoint_uses_configured_model_and_never_silently_falls_back(self):
        from aegis_engine.config import EngineConfig
        config = EngineConfig()
        model = object()
        with patch.object(run.EngineConfig, 'from_env', return_value=config), \
                patch.object(run, 'build_configured_recognizer', return_value=model) as build, \
                patch.object(run, 'DetectionEngine') as engine:
            self.assertEqual(run.main(), 0)
            build.assert_called_once_with(config)
            engine.assert_called_once_with(config=config, recognizer=model)
            engine.return_value.run_forever.assert_called_once()

        with patch.object(run.EngineConfig, 'from_env', return_value=config), \
                patch.object(run, 'build_configured_recognizer', side_effect=ValueError('model missing')), \
                patch.object(run, 'DetectionEngine') as engine, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(run.main(), 1)
            engine.assert_not_called()

    def test_startup_failure_is_operator_readable(self):
        stderr = io.StringIO()
        with patch.object(
            run, "DetectionEngine", side_effect=ValueError("AEGIS_TARGET_FPS must be > 0")
        ), contextlib.redirect_stderr(stderr):
            code = run.main()

        self.assertEqual(code, 1)
        self.assertIn("failed to start", stderr.getvalue())
        self.assertIn("AEGIS_TARGET_FPS must be > 0", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
