import unittest
from unittest.mock import patch

import numpy as np

from aegis_engine.alert_manager import AlertManager
from aegis_engine.config import EngineConfig
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import (
    DetectedEntity,
    DetectionResult,
    DetectionStatus,
    Frame,
)


class AlertPolicyTests(unittest.TestCase):
    def setUp(self):
        self.manager = AlertManager(
            EngineConfig(alert_cooldown_s=0),
            MetricsRegistry(),
        )
        self.frame = Frame(seq=1, image=np.zeros((20, 20, 3), dtype=np.uint8))

    def _result(self, status):
        return DetectionResult(
            camera_id="CAM-01",
            frame_seq=1,
            entities=[
                DetectedEntity(
                    status=status,
                    confidence=90,
                    name="Admin" if status is DetectionStatus.AUTHORIZED else None,
                    bbox=(1, 1, 10, 10),
                )
            ],
            processing_ms=1,
        )

    def test_authorized_only_result_never_queues_telegram_alert(self):
        self.manager.submit(self._result(DetectionStatus.AUTHORIZED), self.frame)

        self.assertTrue(self.manager._queue.empty())

    def test_unknown_result_queues_alert(self):
        with patch.object(
            self.manager,
            "_make_snapshot",
            return_value=(b"jpeg", "snapshot.jpg"),
        ):
            self.manager.submit(self._result(DetectionStatus.UNKNOWN), self.frame)

        self.assertEqual(self.manager._queue.qsize(), 1)


if __name__ == "__main__":
    unittest.main()
