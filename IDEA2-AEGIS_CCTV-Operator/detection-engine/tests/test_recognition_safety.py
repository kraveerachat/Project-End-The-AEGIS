import sys
import types
import unittest
from pathlib import Path

import numpy as np


class FakeCascade:
    def empty(self):
        return False

    def detectMultiScale(self, _gray, **_kwargs):
        return [(10, 20, 30, 40)]


fake_cv2 = types.ModuleType("cv2")
fake_cv2.data = types.SimpleNamespace(haarcascades="/fake/")
fake_cv2.COLOR_BGR2GRAY = 1
fake_cv2.CascadeClassifier = lambda _path: FakeCascade()
fake_cv2.cvtColor = lambda image, _mode: image[:, :, 0]
sys.modules["cv2"] = fake_cv2

from aegis_engine.face_detector import PlaceholderRecognizer
from aegis_engine.models import DetectionStatus


class PlaceholderRecognitionSafetyTests(unittest.TestCase):
    def test_placeholder_can_only_return_unknown_without_identity(self):
        image = np.zeros((100, 100, 3), dtype=np.uint8)

        entities = PlaceholderRecognizer().recognize(image)

        self.assertEqual(len(entities), 1)
        self.assertTrue(all(entity.status is DetectionStatus.UNKNOWN for entity in entities))
        self.assertTrue(all(entity.name is None for entity in entities))
        self.assertNotIn("Authorized", [entity.status.value for entity in entities])
        self.assertNotIn("Admin", [entity.name for entity in entities])

    def test_modular_runtime_has_no_yolo_authorization_path(self):
        engine_root = Path(__file__).resolve().parents[1]
        runtime_source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted((engine_root / "aegis_engine").glob("*.py"))
        )
        self.assertNotIn("from ultralytics", runtime_source)
        self.assertNotIn("YOLO(", runtime_source)


if __name__ == "__main__":
    unittest.main()
