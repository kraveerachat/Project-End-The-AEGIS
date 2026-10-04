import queue
import threading
import unittest

import numpy as np

from aegis_engine.config import EngineConfig
from aegis_engine.face_detector import FaceDetectorProcessor
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import Frame


class FailingGpuRecognizer:
    def inference_status(self):
        return {
            "gpu_required": True,
            "requested_inference_device": "cuda:0",
            "yolo_actual_device": "cuda:0",
            "successful_gpu_inference_samples": 0,
            "accelerator_active": False,
            "yunet_backend": "opencv-cpu",
            "sface_backend": "opencv-cpu",
        }

    def recognize(self, _image):
        raise RuntimeError("CUDA execution failed")


class FailingGpuStatus(FailingGpuRecognizer):
    def __init__(self):
        self.status_calls = 0

    def inference_status(self):
        self.status_calls += 1
        if self.status_calls > 1:
            raise RuntimeError("GPU status unavailable")
        return super().inference_status()

    def recognize(self, _image):
        return []


class GpuInferenceRuntimeTests(unittest.TestCase):
    def test_required_gpu_failure_stops_worker_and_does_not_emit_result(self):
        cfg = EngineConfig(gpu_required=True, inference_device="cuda:0",
                           recognizer_backend="yolo-sface-admin")
        metrics = MetricsRegistry()
        stop = threading.Event()
        emitted = []
        worker = FaceDetectorProcessor(cfg, metrics, queue.Queue(),
                                       lambda result, frame: emitted.append(result),
                                       recognizer=FailingGpuRecognizer(), stop_event=stop)
        worker._process_one(Frame(seq=1, image=np.zeros((8, 8, 3), dtype=np.uint8)))
        self.assertTrue(stop.is_set())
        self.assertEqual(emitted, [])
        snapshot = metrics.snapshot()
        self.assertTrue(snapshot["accelerator_failure"])
        self.assertFalse(snapshot["accelerator_active"])
        self.assertEqual(snapshot["successful_gpu_inference_samples"], 0)

    def test_gpu_status_is_only_active_after_successful_sample(self):
        metrics = MetricsRegistry()
        metrics.on_inference_status(FailingGpuRecognizer().inference_status())
        self.assertFalse(metrics.snapshot()["accelerator_active"])
        status = FailingGpuRecognizer().inference_status()
        status["successful_gpu_inference_samples"] = 1
        status["accelerator_active"] = True
        metrics.on_inference_status(status)
        snapshot = metrics.snapshot()
        self.assertEqual(snapshot["requested_inference_device"], "cuda:0")
        self.assertEqual(snapshot["yolo_actual_device"], "cuda:0")
        self.assertEqual(snapshot["successful_gpu_inference_samples"], 1)
        self.assertEqual(snapshot["yunet_backend"], "opencv-cpu")
        self.assertEqual(snapshot["sface_backend"], "opencv-cpu")
        self.assertTrue(snapshot["accelerator_active"])
        metrics.on_accelerator_failure()
        self.assertFalse(metrics.snapshot()["accelerator_active"])

    def test_required_gpu_status_failure_also_stops_engine(self):
        cfg = EngineConfig(gpu_required=True, inference_device="cuda:0",
                           recognizer_backend="yolo-sface-admin")
        metrics = MetricsRegistry()
        stop = threading.Event()
        emitted = []
        worker = FaceDetectorProcessor(cfg, metrics, queue.Queue(),
                                       lambda result, frame: emitted.append(result),
                                       recognizer=FailingGpuStatus(), stop_event=stop)
        worker._process_one(Frame(seq=1, image=np.zeros((8, 8, 3), dtype=np.uint8)))
        self.assertTrue(stop.is_set())
        self.assertTrue(metrics.snapshot()["accelerator_failure"])
        self.assertEqual(emitted, [])


if __name__ == "__main__":
    unittest.main()
