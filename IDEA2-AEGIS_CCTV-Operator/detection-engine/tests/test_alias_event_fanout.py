from __future__ import annotations

import pathlib
import sys
import unittest
from types import SimpleNamespace

ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

import aegis_engine.engine as engine_module
from aegis_engine.alert_manager import AlertManager
from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine
from aegis_engine.metrics import MetricsRegistry
from aegis_engine.models import (
    DetectedEntity,
    DetectionResult,
    DetectionStatus,
    Frame,
)
from aegis_engine.recording_authority import RecordingAuthority


def result(camera_id="CAM-01", generation=None):
    return DetectionResult(
        camera_id=camera_id,
        frame_seq=7,
        entities=[
            DetectedEntity(
                status=DetectionStatus.UNKNOWN,
                confidence=91.0,
            )
        ],
        processing_ms=2.0,
        producer_generation=generation,
    )


def frame(captured_at=11.0):
    return Frame(
        seq=7,
        image=None,
        captured_at=captured_at,
    )


class FrameAuthorityFanoutTests(unittest.TestCase):

    def fanout(self, source, captured, authority, strict=True):
        helper = getattr(
            engine_module,
            "_attributed_results_for_frame",
            None,
        )
        self.assertIsNotNone(
            helper,
            "frame attribution helper does not exist",
        )
        return helper(
            source,
            captured,
            authority,
            strict=strict,
        )

    def test_cam02_authenticated_context_overrides_static_cam01(self):
        authority = RecordingAuthority()
        authority.activate(51, "CAM-02", 10.0)

        emitted = self.fanout(
            result(camera_id="CAM-01"),
            frame(11.0),
            authority,
        )

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0].camera_id, "CAM-02")
        self.assertEqual(emitted[0].producer_generation, 51)

    def test_concurrent_aliases_fan_out_deterministically(self):
        authority = RecordingAuthority()
        authority.activate(51, "CAM-02", 10.0)
        authority.activate(51, "CAM-01", 10.0)

        emitted = self.fanout(
            result(camera_id="CAM-99"),
            frame(11.0),
            authority,
        )

        self.assertEqual(
            [
                (item.producer_generation, item.camera_id)
                for item in emitted
            ],
            [
                (51, "CAM-01"),
                (51, "CAM-02"),
            ],
        )

    def test_one_alias_release_leaves_only_remaining_alias(self):
        clock = [10.0]

        authority = RecordingAuthority(
            monotonic_clock=lambda: clock[0]
        )

        authority.activate(51, "CAM-01", 10.0)
        authority.activate(51, "CAM-02", 10.0)

        clock[0] = 12.0
        authority.deactivate(51, "CAM-01")

        emitted = self.fanout(
            result(),
            frame(13.0),
            authority,
        )

        self.assertEqual(
            [(x.producer_generation, x.camera_id) for x in emitted],
            [(51, "CAM-02")],
        )

    def test_no_authenticated_context_fails_closed(self):
        authority = RecordingAuthority()

        emitted = self.fanout(
            result(camera_id="CAM-01"),
            frame(11.0),
            authority,
        )

        self.assertEqual(emitted, ())

    def test_pre_release_frame_processed_after_alias_release_is_not_event_authority(self):
        clock = [10.0]

        authority = RecordingAuthority(
            monotonic_clock=lambda: clock[0]
        )

        authority.activate(51, "CAM-02", 10.0)

        captured = frame(11.0)

        # The frame was captured while authorized, but event processing occurs
        # after logout/release. Recording may retain its closed interval;
        # security events must fail closed once live authority is gone.
        clock[0] = 12.0
        authority.deactivate(51, "CAM-02")

        emitted = self.fanout(
            result(camera_id="CAM-01"),
            captured,
            authority,
        )

        self.assertEqual(emitted, ())

    def test_released_sibling_is_not_emitted_from_pre_release_frame(self):
        clock = [10.0]

        authority = RecordingAuthority(
            monotonic_clock=lambda: clock[0]
        )

        authority.activate(51, "CAM-01", 10.0)
        authority.activate(51, "CAM-02", 10.0)

        captured = frame(11.0)

        clock[0] = 12.0
        authority.deactivate(51, "CAM-01")

        emitted = self.fanout(
            result(camera_id="CAM-99"),
            captured,
            authority,
        )

        self.assertEqual(
            [(x.producer_generation, x.camera_id) for x in emitted],
            [(51, "CAM-02")],
        )

    def test_retired_generation_cannot_publish_new_frame(self):
        clock = [10.0]

        authority = RecordingAuthority(
            monotonic_clock=lambda: clock[0]
        )

        authority.activate(51, "CAM-02", 10.0)

        # Retire at a known monotonic boundary.
        clock[0] = 12.0
        authority.retire(51)

        # A genuinely new frame captured after retirement must not inherit
        # the closed CAM-02 context.
        emitted = self.fanout(
            result(camera_id="CAM-01"),
            frame(20.0),
            authority,
        )

        self.assertEqual(emitted, ())

    def test_legacy_non_strict_path_keeps_static_identity(self):
        emitted = self.fanout(
            result(camera_id="CAM-05"),
            frame(11.0),
            None,
            strict=False,
        )

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0].camera_id, "CAM-05")
        self.assertIsNone(emitted[0].producer_generation)


class EventPropagationTests(unittest.TestCase):

    def test_engine_monitor_detection_receives_generation(self):
        monitor_calls = []

        class API:
            def publish_event(self, event):
                pass

        class Alerts:
            def submit(self, result, frame):
                pass

        class Monitor:
            def post_detection(self, **kwargs):
                monitor_calls.append(kwargs)

        fake_engine = SimpleNamespace(
            _api=API(),
            _alerts=Alerts(),
            _monitor=Monitor(),
        )

        DetectionEngine._on_detection(
            fake_engine,
            result(
                camera_id="CAM-02",
                generation=51,
            ),
            frame(),
        )

        self.assertEqual(len(monitor_calls), 1)
        self.assertEqual(
            monitor_calls[0]["camera_id"],
            "CAM-02",
        )
        self.assertEqual(
            monitor_calls[0]["producer_generation"],
            51,
        )

    def test_strict_alert_label_cannot_reuse_static_physical_label(self):
        cfg = EngineConfig(
            camera_id="CAM-01",
            camera_label="Main entrance",
        )

        manager = AlertManager(
            cfg,
            MetricsRegistry(),
        )

        payload = manager._build_payload(
            result(
                camera_id="CAM-02",
                generation=51,
            ),
            "snapshot.jpg",
        )

        self.assertEqual(payload["camera_id"], "CAM-02")
        self.assertEqual(payload["camera_label"], "CAM-02")
        self.assertNotEqual(payload["camera_label"], "Main entrance")

    def test_legacy_alert_keeps_configured_camera_label(self):
        cfg = EngineConfig(
            camera_id="CAM-01",
            camera_label="Main entrance",
        )

        manager = AlertManager(
            cfg,
            MetricsRegistry(),
        )

        payload = manager._build_payload(
            result(
                camera_id="CAM-01",
                generation=None,
            ),
            "snapshot.jpg",
        )

        self.assertEqual(payload["camera_id"], "CAM-01")
        self.assertEqual(payload["camera_label"], "Main entrance")

    def test_alert_payload_and_persistence_keep_generation(self):
        calls = []

        class Monitor:
            def post_alert(self, **kwargs):
                calls.append(kwargs)

        manager = AlertManager(
            EngineConfig(),
            MetricsRegistry(),
            monitor=Monitor(),
        )

        payload = manager._build_payload(
            result(
                camera_id="CAM-02",
                generation=51,
            ),
            "snapshot.jpg",
        )

        self.assertEqual(payload["camera_id"], "CAM-02")
        self.assertEqual(payload["producer_generation"], 51)

        manager._persist_alert(payload, True)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["camera_id"], "CAM-02")
        self.assertEqual(calls[0]["producer_generation"], 51)


if __name__ == "__main__":
    unittest.main()
