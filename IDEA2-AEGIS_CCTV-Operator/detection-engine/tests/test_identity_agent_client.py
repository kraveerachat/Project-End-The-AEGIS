import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_engine.config import EngineConfig
from aegis_engine.identity_agent_client import IdentityAgentClient, _windows_connector_with_modules
from aegis_engine.monitor_client import MonitorClient
from aegis_identity_agent.pipe_protocol import decode_request, encode_response


class RecordingConnector:
    def __init__(self, response=None, error=None):
        self.response = response or encode_response(ok=True, status=201)
        self.error = error
        self.calls = []

    def __call__(self, pipe_name, request, timeout_s, response_limit):
        self.calls.append((pipe_name, request, timeout_s, response_limit))
        if self.error:
            raise self.error
        return self.response


class IdentityAgentClientTests(unittest.TestCase):
    def test_all_four_operations_use_bounded_local_pipe_requests(self):
        connector = RecordingConnector()
        client = IdentityAgentClient(
            pipe_name=r"\\.\pipe\AEGIS.IdentityAgent.v1",
            timeout_s=5,
            connector=connector,
        )
        payloads = {
            "heartbeat": {"cameraId": "CAM-01", "cameraConnected": False},
            "detection": {"cameraId": "CAM-01", "entities": []},
            "alert": {
                "cameraId": "CAM-01", "severity": "amber", "alertType": "unknown_face",
                "title": "Unknown", "snapshotPath": None, "telegramSent": False,
            },
            "clip": {
                "cameraId": "CAM-01", "startedAt": "2026-09-19T00:00:00Z",
                "durationSec": 10, "filePath": "clip.mp4", "storedOnNas": False,
            },
        }
        for operation, payload in payloads.items():
            self.assertTrue(client.submit(operation, payload).ok)
        self.assertEqual(list(payloads), [decode_request(call[1]).operation for call in connector.calls])
        self.assertTrue(all(call[2] == 5 for call in connector.calls))

    def test_timeout_broken_pipe_and_oversized_response_fail_soft(self):
        cases = (
            RecordingConnector(error=TimeoutError()),
            RecordingConnector(error=BrokenPipeError()),
            RecordingConnector(error=RuntimeError("unexpected local IPC failure")),
            RecordingConnector(response=b"{" + b" " * 4096 + b"}"),
        )
        for connector in cases:
            with self.subTest(error=connector.error):
                result = IdentityAgentClient(connector=connector).submit(
                    "heartbeat", {"cameraId": "CAM-01", "cameraConnected": False}
                )
                self.assertFalse(result.ok)
                self.assertEqual("AGENT_UNAVAILABLE", result.error)

    def test_strict_monitor_client_routes_all_ingest_to_agent_without_shared_key_fallback(self):
        connector = RecordingConnector()
        agent = IdentityAgentClient(connector=connector)
        monitor = MonitorClient(
            base_url="https://monitor.invalid",
            api_key="legacy-key-must-not-be-used",
            identity_agent_client=agent,
            ingest_mode="identity_agent",
        )
        monitor.post_detection("CAM-01", [], frame_id="frame-1")
        monitor.post_clip("CAM-01", "2026-09-19T00:00:00Z", 10, "clip.mp4", False)
        monitor.post_alert("CAM-01", "amber", "unknown_face", "Unknown", None, False)
        monitor.post_heartbeat(
            "CAM-01",
            "forged-node",
            {"camera_connected": False},
            stream_url="http://attacker.invalid/stream",
        )
        requests = [decode_request(call[1]) for call in connector.calls]
        self.assertEqual(["detection", "clip", "alert", "heartbeat"], [r.operation for r in requests])
        for request in requests:
            self.assertNotIn("nodeId", request.payload)
            self.assertNotIn("physicalCameraId", request.payload)
            self.assertNotIn("streamUrl", request.payload)
        self.assertEqual("", monitor._key)
        self.assertEqual("", monitor._base)

    def test_agent_unavailable_never_raises_or_imports_camera_demand_boundaries(self):
        agent = IdentityAgentClient(connector=RecordingConnector(error=BrokenPipeError()))
        monitor = MonitorClient(identity_agent_client=agent, ingest_mode="identity_agent")
        original_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name in {"aegis_engine.local_api", "aegis_engine.stream_hub"}:
                self.fail(f"strict ingest imported camera-demand boundary {name}")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded_import):
            monitor.post_heartbeat("CAM-01", "edge-a", {"camera_connected": False})
            monitor.post_detection("CAM-01", [])

    def test_strict_configuration_has_no_shared_key_downgrade(self):
        with patch.dict(
            "os.environ",
            {
                "AEGIS_MONITOR_INGEST_MODE": "identity_agent",
                "AEGIS_IDENTITY_AGENT_PIPE_NAME": r"\\.\pipe\AEGIS.IdentityAgent.v1",
                "AEGIS_IDENTITY_AGENT_TIMEOUT_S": "5",
                "AEGIS_DETECTION_ENGINE_API_KEY": "legacy-stream-key",
            },
            clear=True,
        ):
            cfg = EngineConfig.from_env().validate()
        self.assertEqual("identity_agent", cfg.monitor_ingest_mode)
        self.assertEqual(r"\\.\pipe\AEGIS.IdentityAgent.v1", cfg.identity_agent_pipe_name)
        self.assertEqual(5, cfg.identity_agent_timeout_s)
        self.assertNotEqual("legacy_shared_key", cfg.monitor_ingest_mode)

    def test_native_connector_bounds_an_established_pipe_transaction(self):
        calls = []

        class Overlapped:
            hEvent = None

        class FakeClock:
            value = 100.0

            @classmethod
            def monotonic(cls):
                return cls.value

        response = encode_response(ok=True, status=201)
        read_buffer = bytearray(4097)
        read_buffer[:len(response)] = response
        wait_states = iter((0, 258, 0))
        result_sizes = iter((3, len(response), 0))
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *args: "event",
            WaitForSingleObject=lambda event, timeout: calls.append(("wait", timeout)) or next(wait_states),
        )
        fake_file = SimpleNamespace(
            CreateFile=lambda *args: "pipe",
            AllocateReadBuffer=lambda size: read_buffer,
            WriteFile=lambda handle, data, overlapped: (997, 0),
            ReadFile=lambda handle, buffer, overlapped: (997, buffer),
            GetOverlappedResult=lambda handle, overlapped, wait: next(result_sizes),
            CancelIoEx=lambda handle, overlapped: calls.append(("cancel", handle, overlapped)),
            CloseHandle=lambda handle: calls.append(("close", handle)),
        )
        fake_pipe = SimpleNamespace(
            PIPE_READMODE_MESSAGE=2,
            WaitNamedPipe=lambda name, timeout: True,
            SetNamedPipeHandleState=lambda *args: None,
        )
        fake_con = SimpleNamespace(
            GENERIC_READ=1,
            GENERIC_WRITE=2,
            OPEN_EXISTING=3,
            FILE_FLAG_OVERLAPPED=0x40000000,
        )

        with self.assertRaises(TimeoutError):
            _windows_connector_with_modules(
                r"\\.\pipe\AEGIS.IdentityAgent.v1",
                b"{}\n",
                0.05,
                4096,
                pywintypes=SimpleNamespace(OVERLAPPED=Overlapped),
                win32con=fake_con,
                win32event=fake_event,
                win32file=fake_file,
                win32pipe=fake_pipe,
                monotonic=FakeClock.monotonic,
            )
        self.assertTrue(any(call[0] == "cancel" for call in calls))
        self.assertIn(("close", "pipe"), calls)


if __name__ == "__main__":
    unittest.main()
