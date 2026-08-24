import os
import unittest
from unittest.mock import patch

from aegis_engine.config import EngineConfig


class EngineConfigTests(unittest.TestCase):
    def test_development_defaults_load_without_nas(self):
        with patch.dict(os.environ, {}, clear=True):
            config = EngineConfig.from_env().validate()

        self.assertFalse(config.nas_enabled)
        self.assertIsNone(config.nas_host)
        self.assertIsNone(config.nas_user)
        self.assertIsNone(config.monitor_api_base)
        self.assertIsNone(config.detection_engine_api_key)

    def test_enabled_nas_requires_host_and_user(self):
        with self.assertRaisesRegex(
            ValueError, "AEGIS_NAS_HOST / AEGIS_NAS_USER are unset"
        ):
            EngineConfig(nas_enabled=True).validate()

    def test_enabled_nas_rejects_unverified_success_mode(self):
        with self.assertRaisesRegex(ValueError, "unverified transfers"):
            EngineConfig(
                nas_enabled=True,
                nas_host="nas.local",
                nas_user="aegis",
                nas_verify="none",
            ).validate()

    def test_invalid_environment_value_names_the_setting(self):
        with patch.dict(os.environ, {"AEGIS_TARGET_FPS": "fast"}, clear=True):
            with self.assertRaisesRegex(ValueError, "AEGIS_TARGET_FPS"):
                EngineConfig.from_env()

    def test_service_key_is_redacted_from_startup_logging(self):
        redacted = EngineConfig(
            detection_engine_api_key="do-not-log-me",
            camera_source="rtsp://camera-user:camera-password@camera.local/live",
        ).redacted()
        self.assertEqual(redacted["detection_engine_api_key"], "***set***")
        self.assertNotIn("camera-password", redacted["camera_source"])
        self.assertEqual(
            redacted["camera_source"], "rtsp://***:***@camera.local/live"
        )

    def test_invalid_boolean_names_the_setting(self):
        with patch.dict(os.environ, {"AEGIS_NAS_ENABLED": "sometimes"}, clear=True):
            with self.assertRaisesRegex(ValueError, "AEGIS_NAS_ENABLED"):
                EngineConfig.from_env()

    def test_viewer_demand_requires_stream_and_service_key(self):
        with self.assertRaisesRegex(ValueError, "AEGIS_STREAM_ENABLED"):
            EngineConfig(
                capture_on_demand=True,
                stream_enabled=False,
                detection_engine_api_key="service-key",
            ).validate()

        with self.assertRaisesRegex(ValueError, "AEGIS_DETECTION_ENGINE_API_KEY"):
            EngineConfig(capture_on_demand=True).validate()

        EngineConfig(
            capture_on_demand=True,
            detection_engine_api_key="service-key",
        ).validate()

    def test_stream_startup_and_idle_timeouts_are_independent_and_positive(self):
        with patch.dict(
            os.environ,
            {
                "AEGIS_STREAM_FIRST_FRAME_TIMEOUT_S": "45",
                "AEGIS_STREAM_IDLE_TIMEOUT_S": "15",
            },
            clear=True,
        ):
            config = EngineConfig.from_env().validate()

        self.assertEqual(config.stream_first_frame_timeout_s, 45)
        self.assertEqual(config.stream_idle_timeout_s, 15)

        with self.assertRaisesRegex(
            ValueError, "AEGIS_STREAM_FIRST_FRAME_TIMEOUT_S"
        ):
            EngineConfig(stream_first_frame_timeout_s=0).validate()
        with self.assertRaisesRegex(ValueError, "AEGIS_STREAM_IDLE_TIMEOUT_S"):
            EngineConfig(stream_idle_timeout_s=0).validate()

    def test_yolo_sface_backend_requires_detection_and_identity_models(self):
        with self.assertRaisesRegex(ValueError, "AEGIS_ADMIN_MODEL_PATH"):
            EngineConfig(recognizer_backend="yolo-sface-admin").validate()

        with self.assertRaisesRegex(ValueError, "AEGIS_FACE_DETECTOR_MODEL_PATH"):
            EngineConfig(
                recognizer_backend="yolo-sface-admin",
                admin_model_path="C:/local/admin.pt",
            ).validate()

        EngineConfig(
            recognizer_backend="yolo-sface-admin",
            admin_model_path="C:/local/admin.pt",
            face_detector_model_path="C:/local/yunet.onnx",
            face_recognizer_model_path="C:/local/sface.onnx",
            admin_embeddings_path="C:/local/admin.npz",
        ).validate()

    def test_yolo_only_backend_is_rejected_as_not_identity(self):
        with self.assertRaisesRegex(ValueError, "cannot prove identity"):
            EngineConfig(
                recognizer_backend="yolo-admin",
                admin_model_path="C:/local/admin.pt",
            ).validate()

    def test_unknown_face_ratios_are_fail_fast(self):
        with self.assertRaisesRegex(ValueError, "AEGIS_UNKNOWN face ratios"):
            EngineConfig(
                recognizer_backend="yolo-sface-admin",
                admin_model_path="C:/local/admin.pt",
                face_detector_model_path="C:/local/yunet.onnx",
                face_recognizer_model_path="C:/local/sface.onnx",
                admin_embeddings_path="C:/local/admin.npz",
                unknown_min_face_ratio=0.4,
                unknown_large_face_ratio=0.2,
            ).validate()

    def test_model_path_logs_only_filename(self):
        redacted = EngineConfig(
            recognizer_backend="yolo-sface-admin",
            admin_model_path="C:/Users/example/private/admin.pt",
            face_detector_model_path="C:/Users/example/private/yunet.onnx",
            face_recognizer_model_path="C:/Users/example/private/sface.onnx",
            admin_embeddings_path="C:/Users/example/private/admin.npz",
        ).redacted()
        self.assertEqual(redacted["admin_model_path"], "admin.pt")
        self.assertEqual(redacted["face_detector_model_path"], "yunet.onnx")
        self.assertEqual(redacted["face_recognizer_model_path"], "sface.onnx")
        self.assertEqual(redacted["admin_embeddings_path"], "admin.npz")


if __name__ == "__main__":
    unittest.main()
