import unittest

import numpy as np

from aegis_engine.models import DetectionStatus
from aegis_engine.yolo_sface_admin_recognizer import YoloSFaceAdminRecognizer


class FakeBoxes:
    def __init__(self, xyxy, confidences, class_ids):
        self.xyxy = np.asarray(xyxy, dtype=float)
        self.conf = np.asarray(confidences, dtype=float)
        self.cls = np.asarray(class_ids, dtype=float)


class FakePrediction:
    def __init__(self, boxes):
        self.boxes = boxes


class FakeModel:
    names = {0: "Admin-Face-Scan", 1: "Other"}

    def __init__(self, boxes=None, error=None):
        self._boxes = boxes or FakeBoxes([], [], [])
        self._error = error

    def predict(self, _image, **_kwargs):
        if self._error:
            raise self._error
        return [FakePrediction(self._boxes)]

    def set_boxes(self, boxes):
        self._boxes = boxes


class FakeFaceDetector:
    def __init__(self, faces):
        self._faces = np.asarray(faces, dtype=np.float32)
        self.input_size = None

    def setInputSize(self, value):
        self.input_size = value

    def detect(self, _image):
        return None, self._faces if len(self._faces) else None


class FakeFaceRecognizer:
    def __init__(self, embedding, error=None):
        self._embedding = np.asarray(embedding, dtype=np.float32)
        self._error = error

    def alignCrop(self, _image, face):
        if self._error:
            raise self._error
        return face

    def feature(self, _aligned):
        return self._embedding


def face(x=20, y=20, width=100, height=100, score=0.95):
    # YuNet format: bbox, five (x,y) landmarks, detector score.
    return [x, y, width, height, 30, 40, 80, 40, 55, 60, 35, 85, 75, 85, score]


class YoloSFaceAdminRecognizerTests(unittest.TestCase):
    def _recognizer(self, model, embedding=(1.0, 0.0), faces=None, **kwargs):
        return YoloSFaceAdminRecognizer(
            model_path="unused-in-test.pt",
            face_detector_model_path="",
            face_recognizer_model_path="",
            admin_embeddings_path="",
            model=model,
            face_detector=FakeFaceDetector(faces or [face()]),
            face_recognizer=FakeFaceRecognizer(embedding),
            templates=np.asarray([[1.0, 0.0], [0.99, 0.01], [0.98, 0.02]]),
            face_match_cosine_threshold=0.50,
            **kwargs,
        )

    def test_authorized_requires_overlapping_yolo_and_identity_match(self):
        model = FakeModel(FakeBoxes([[15, 15, 125, 125]], [0.75], [0]))
        entities = self._recognizer(model).recognize(
            np.zeros((400, 400, 3), dtype=np.uint8)
        )

        self.assertEqual(len(entities), 1)
        self.assertIs(entities[0].status, DetectionStatus.AUTHORIZED)
        self.assertEqual(entities[0].name, "Admin")

    def test_yolo_match_with_different_identity_remains_unknown(self):
        model = FakeModel(FakeBoxes([[15, 15, 125, 125]], [0.75], [0]))
        entities = self._recognizer(model, embedding=(0.0, 1.0)).recognize(
            np.zeros((400, 400, 3), dtype=np.uint8)
        )

        self.assertIs(entities[0].status, DetectionStatus.UNKNOWN)
        self.assertIsNone(entities[0].name)

    def test_identity_match_without_yolo_gate_remains_unknown(self):
        entities = self._recognizer(FakeModel()).recognize(
            np.zeros((400, 400, 3), dtype=np.uint8)
        )

        self.assertIs(entities[0].status, DetectionStatus.UNKNOWN)

    def test_recent_overlapping_yolo_gate_smooths_one_missed_frame(self):
        model = FakeModel(FakeBoxes([[15, 15, 125, 125]], [0.75], [0]))
        recognizer = self._recognizer(model)
        image = np.zeros((400, 400, 3), dtype=np.uint8)
        self.assertIs(
            recognizer.recognize(image)[0].status,
            DetectionStatus.AUTHORIZED,
        )

        model.set_boxes(FakeBoxes([], [], []))
        self.assertIs(
            recognizer.recognize(image)[0].status,
            DetectionStatus.AUTHORIZED,
        )

    def test_yolo_failure_is_fail_secure(self):
        entities = self._recognizer(
            FakeModel(error=RuntimeError("model unavailable"))
        ).recognize(np.zeros((400, 400, 3), dtype=np.uint8))

        self.assertIs(entities[0].status, DetectionStatus.UNKNOWN)

    def test_missing_configured_yolo_class_fails_startup(self):
        model = FakeModel()
        model.names = {1: "Other"}

        with self.assertRaisesRegex(ValueError, "was not found"):
            self._recognizer(model)


if __name__ == "__main__":
    unittest.main()
