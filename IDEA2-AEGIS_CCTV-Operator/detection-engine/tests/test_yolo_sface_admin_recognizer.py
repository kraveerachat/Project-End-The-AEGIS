import unittest
from types import SimpleNamespace

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

    def __init__(self, boxes=None, error=None, stay_on_cpu=False):
        self._boxes = boxes or FakeBoxes([], [], [])
        self._error = error
        self.device = "cpu"
        self.stay_on_cpu = stay_on_cpu
        self.move_calls = []
        self.predict_calls = []

    def to(self, device):
        self.move_calls.append(device)
        if not self.stay_on_cpu:
            self.device = device
        return self

    def predict(self, _image, **_kwargs):
        self.predict_calls.append(_kwargs)
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
    def _recognizer(self, model, embedding=(1.0, 0.0), faces=None,
                    sface_error=None, **kwargs):
        return YoloSFaceAdminRecognizer(
            model_path="unused-in-test.pt",
            face_detector_model_path="",
            face_recognizer_model_path="",
            admin_embeddings_path="",
            model=model,
            face_detector=FakeFaceDetector(faces if faces is not None else [face()]),
            face_recognizer=FakeFaceRecognizer(embedding, error=sface_error),
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

    def test_cpu_development_predicts_explicitly_on_cpu(self):
        model = FakeModel()
        recognizer = self._recognizer(model)
        recognizer.recognize(np.zeros((400, 400, 3), dtype=np.uint8))
        self.assertEqual(model.predict_calls[0]["device"], "cpu")
        self.assertEqual(recognizer.inference_status()["successful_gpu_inference_samples"], 0)

    def test_required_cuda_unavailable_refuses_before_model_move(self):
        model = FakeModel()
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: False, device_count=lambda: 0,
        ))
        with self.assertRaisesRegex(RuntimeError, "CUDA"):
            self._recognizer(model, gpu_required=True,
                             inference_device="cuda:0", torch_runtime=torch_runtime)
        self.assertEqual(model.move_calls, [])

    def test_required_cuda_index_must_exist(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        with self.assertRaisesRegex(RuntimeError, "cuda:1"):
            self._recognizer(FakeModel(), gpu_required=True,
                             inference_device="cuda:1", torch_runtime=torch_runtime)

    def test_required_model_move_and_prediction_use_verified_cuda(self):
        model = FakeModel()
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        recognizer = self._recognizer(model, gpu_required=True,
                                      inference_device="cuda:0",
                                      torch_runtime=torch_runtime)
        self.assertEqual(model.move_calls, ["cuda:0"])
        before = recognizer.inference_status()
        self.assertEqual(before["yolo_actual_device"], "cuda:0")
        self.assertFalse(before["accelerator_active"])
        self.assertEqual(before["successful_gpu_inference_samples"], 0)
        recognizer.recognize(np.zeros((400, 400, 3), dtype=np.uint8))
        self.assertEqual(model.predict_calls[0]["device"], "cuda:0")
        after = recognizer.inference_status()
        self.assertEqual(after["successful_gpu_inference_samples"], 1)
        self.assertTrue(after["accelerator_active"])
        self.assertEqual(after["yunet_backend"], "opencv-cpu")
        self.assertEqual(after["sface_backend"], "opencv-cpu")

    def test_required_model_that_remains_on_cpu_fails_startup(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        with self.assertRaisesRegex(RuntimeError, "actual.*CPU|actual.*cpu"):
            self._recognizer(FakeModel(stay_on_cpu=True), gpu_required=True,
                             inference_device="cuda:0", torch_runtime=torch_runtime)

    def test_required_cuda_runtime_failure_is_not_swallowed_or_counted(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        recognizer = self._recognizer(FakeModel(error=RuntimeError("cuda lost")),
                                      gpu_required=True, inference_device="cuda:0",
                                      torch_runtime=torch_runtime)
        with self.assertRaisesRegex(RuntimeError, "cuda lost"):
            recognizer.recognize(np.zeros((400, 400, 3), dtype=np.uint8))
        self.assertEqual(recognizer.inference_status()["successful_gpu_inference_samples"], 0)

    def test_malformed_cuda_prediction_is_not_counted_as_success(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        model = FakeModel()
        recognizer = self._recognizer(model, gpu_required=True,
                                      inference_device="cuda:0", torch_runtime=torch_runtime)
        model.predict = lambda *_args, **_kwargs: [SimpleNamespace(boxes=SimpleNamespace(
            xyxy=object(), conf=object(), cls=object(),
        ))]
        with self.assertRaises(Exception):
            recognizer.recognize(np.zeros((400, 400, 3), dtype=np.uint8))
        self.assertEqual(recognizer.inference_status()["successful_gpu_inference_samples"], 0)

    def test_sface_failure_stays_unknown_in_required_cuda_mode(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        model = FakeModel(FakeBoxes([[15, 15, 125, 125]], [0.75], [0]))
        recognizer = self._recognizer(model, gpu_required=True,
                                      inference_device="cuda:0", torch_runtime=torch_runtime,
                                      sface_error=RuntimeError("SFace failure"))
        result = recognizer.recognize(np.zeros((400, 400, 3), dtype=np.uint8))
        self.assertIs(result[0].status, DetectionStatus.UNKNOWN)
        self.assertEqual(recognizer.inference_status()["successful_gpu_inference_samples"], 1)

    def test_yunet_failure_is_fail_secure_without_gpu_stop(self):
        torch_runtime = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, device_count=lambda: 1,
        ))
        recognizer = self._recognizer(FakeModel(), gpu_required=True,
                                      inference_device="cuda:0", torch_runtime=torch_runtime)

        def fail(_image):
            raise RuntimeError("YuNet failed")

        recognizer._face_detector.detect = fail
        self.assertEqual(recognizer.recognize(np.zeros((8, 8, 3), dtype=np.uint8)), [])
        self.assertFalse(recognizer.inference_status()["accelerator_active"])

    def test_missing_configured_yolo_class_fails_startup(self):
        model = FakeModel()
        model.names = {1: "Other"}

        with self.assertRaisesRegex(ValueError, "was not found"):
            self._recognizer(model)


if __name__ == "__main__":
    unittest.main()
