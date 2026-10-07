from __future__ import annotations

import pathlib
import sys
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))


from aegis_engine.alert_manager import _format_thailand_time


class TelegramThailandTimeTests(unittest.TestCase):

    def test_utc_timestamp_is_rendered_as_thailand_local_time(self):
        self.assertEqual(
            _format_thailand_time(
                "2026-10-06T04:41:22.025958+00:00"
            ),
            "2026-10-06 11:41:22",
        )

    def test_z_suffix_is_rendered_as_thailand_local_time(self):
        self.assertEqual(
            _format_thailand_time(
                "2026-10-06T04:41:22Z"
            ),
            "2026-10-06 11:41:22",
        )

    def test_invalid_timestamp_fails_soft(self):
        value = "invalid-time"
        self.assertEqual(
            _format_thailand_time(value),
            value,
        )


if __name__ == "__main__":
    unittest.main()
