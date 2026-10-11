"""PR348 RED contracts for authenticated detection/alert alias attribution."""

from __future__ import annotations

import pathlib
import sys
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))


from aegis_engine.identity_agent_client import IdentityAgentClient
from aegis_engine.models import DetectionResult
from aegis_engine.monitor_client import MonitorClient
from aegis_engine.recording_authority import RecordingAuthority
from aegis_identity_agent.pipe_protocol import (
    decode_request,
    encode_response,
    validate_operation_payload,
)


class RecordingConnector:
    def __init__(self):
        self.calls = []

    def __call__(
        self,
        pipe_name,
        request,
        timeout_s,
        response_limit,
        response_timeout_s,
    ):
        self.calls.append(
            (
                pipe_name,
                request,
                timeout_s,
                response_limit,
                response_timeout_s,
            )
        )
        return encode_response(ok=True, status=201)


class AliasAuthorityBaselineTests(unittest.TestCase):

    def test_same_frame_has_both_authenticated_alias_contexts(self):
        authority = RecordingAuthority()
        authority.activate(51, "CAM-01", 10.0)
        authority.activate(51, "CAM-02", 10.0)

        contexts = authority.intervals_for_frame(11.0)

        self.assertEqual(
            set(contexts),
            {
                (51, "CAM-01"),
                (51, "CAM-02"),
            },
        )

    def test_released_alias_disappears_while_other_alias_survives(self):
        clock = [10.0]

        authority = RecordingAuthority(
            monotonic_clock=lambda: clock[0]
        )

        authority.activate(51, "CAM-01", 10.0)
        authority.activate(51, "CAM-02", 10.0)

        clock[0] = 12.0
        authority.deactivate(51, "CAM-01")

        contexts = authority.intervals_for_frame(13.0)

        self.assertEqual(
            set(contexts),
            {(51, "CAM-02")},
        )


class AliasEventPropagationRedTests(unittest.TestCase):

    def test_detection_result_can_carry_authenticated_generation(self):
        result = DetectionResult(
            camera_id="CAM-02",
            frame_seq=1,
            entities=[],
            processing_ms=1.0,
            producer_generation=51,
        )

        self.assertEqual(result.camera_id, "CAM-02")
        self.assertEqual(result.producer_generation, 51)
        self.assertEqual(
            result.to_dict()["producer_generation"],
            51,
        )

    def test_strict_detection_agent_payload_carries_generation(self):
        connector = RecordingConnector()

        monitor = MonitorClient(
            identity_agent_client=IdentityAgentClient(
                connector=connector
            ),
            ingest_mode="identity_agent",
        )

        monitor.post_detection(
            "CAM-02",
            [
                {
                    "status": "Unknown",
                    "name": None,
                    "confidence": 91.2,
                }
            ],
            frame_id="frame-cam02-51",
            at="2026-10-06T00:21:56.000Z",
            producer_generation=51,
        )

        self.assertEqual(len(connector.calls), 1)

        request = decode_request(
            connector.calls[0][1]
        )

        self.assertEqual(
            request.operation,
            "detection",
        )
        self.assertEqual(
            request.payload["cameraId"],
            "CAM-02",
        )
        self.assertEqual(
            request.payload["producerGeneration"],
            "51",
        )

    def test_strict_alert_agent_payload_carries_generation(self):
        connector = RecordingConnector()

        monitor = MonitorClient(
            identity_agent_client=IdentityAgentClient(
                connector=connector
            ),
            ingest_mode="identity_agent",
        )

        monitor.post_alert(
            "CAM-02",
            "amber",
            "unknown_face",
            "Unknown person detected",
            "snapshot.jpg",
            True,
            producer_generation=51,
        )

        self.assertEqual(len(connector.calls), 1)

        request = decode_request(
            connector.calls[0][1]
        )

        self.assertEqual(
            request.operation,
            "alert",
        )
        self.assertEqual(
            request.payload["cameraId"],
            "CAM-02",
        )
        self.assertEqual(
            request.payload["producerGeneration"],
            "51",
        )

    def test_pipe_protocol_accepts_strict_detection_generation(self):
        operation, payload = validate_operation_payload(
            "detection",
            {
                "cameraId": "CAM-02",
                "entities": [
                    {
                        "status": "Unknown",
                        "confidence": 90.0,
                    }
                ],
                "producerGeneration": "51",
            },
        )

        self.assertEqual(operation, "detection")
        self.assertEqual(
            payload["producerGeneration"],
            "51",
        )

    def test_pipe_protocol_accepts_strict_alert_generation(self):
        operation, payload = validate_operation_payload(
            "alert",
            {
                "cameraId": "CAM-02",
                "severity": "amber",
                "alertType": "unknown_face",
                "title": "Unknown person detected",
                "snapshotPath": "snapshot.jpg",
                "telegramSent": True,
                "producerGeneration": "51",
            },
        )

        self.assertEqual(operation, "alert")
        self.assertEqual(
            payload["producerGeneration"],
            "51",
        )

    def test_static_camera_id_cannot_replace_authenticated_contexts(self):
        authority = RecordingAuthority()

        authority.activate(
            51,
            "CAM-02",
            10.0,
        )

        static_camera_id = "CAM-01"

        contexts = authority.intervals_for_frame(
            11.0
        )

        aliases = {
            alias
            for (_generation, alias) in contexts
        }

        self.assertEqual(
            aliases,
            {"CAM-02"},
        )
        self.assertNotIn(
            static_camera_id,
            aliases,
        )


if __name__ == "__main__":
    unittest.main()
