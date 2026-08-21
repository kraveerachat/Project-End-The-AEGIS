import unittest
from unittest.mock import patch

import cv2
import numpy as np


class FakeCascade:
    def empty(self):
        return False

    def detectMultiScale(self, _gray, **_kwargs):
        return [(10, 20, 30, 40)]


from aegis_engine.face_detector import PlaceholderRecognizer
from aegis_engine.models import DetectionStatus


class PlaceholderRecognitionSafetyTests(unittest.TestCase):
    def test_placeholder_can_only_return_unknown_without_identity(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)

        with patch.object(cv2, "CascadeClassifier", return_value=FakeCascade()):
            entities = PlaceholderRecognizer().recognize(image)

        self.assertEqual(len(entities), 1)
        self.assertTrue(all(entity.status is DetectionStatus.UNKNOWN for entity in entities))
        self.assertTrue(all(entity.name is None for entity in entities))
        self.assertNotIn("Authorized", [entity.status.value for entity in entities])
        self.assertNotIn("Admin", [entity.name for entity in entities])

    def test_placeholder_remains_the_identity_free_default(self):
        from aegis_engine.config import EngineConfig
        from aegis_engine.yolo_sface_admin_recognizer import (
            build_configured_recognizer,
        )

        self.assertIsNone(build_configured_recognizer(EngineConfig()))


if __name__ == "__main__":
    unittest.main()
