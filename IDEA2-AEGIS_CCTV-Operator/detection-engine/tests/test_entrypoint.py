import contextlib
import io
import unittest
from unittest.mock import patch

import run


class EntrypointTests(unittest.TestCase):
    def test_startup_failure_is_operator_readable(self):
        stderr = io.StringIO()
        with patch.object(
            run.EngineConfig,
            "from_env",
            side_effect=ValueError("AEGIS_TARGET_FPS must be > 0"),
        ), contextlib.redirect_stderr(stderr):
            code = run.main()

        self.assertEqual(code, 1)
        self.assertIn("failed to start", stderr.getvalue())
        self.assertIn("AEGIS_TARGET_FPS must be > 0", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
