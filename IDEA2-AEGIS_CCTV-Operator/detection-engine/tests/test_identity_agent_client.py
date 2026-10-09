import os
import pathlib
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_engine.config import EngineConfig
from aegis_engine.engine import DetectionEngine
from aegis_engine.identity_agent_client import IdentityAgentClient, _windows_connector_with_modules
from aegis_engine.monitor_client import MonitorClient
from aegis_identity_agent.pipe_protocol import decode_request, decode_response, encode_response


class RecordingConnector:
    def __init__(self, response=None, error=None):
        self.response = response or encode_response(ok=True, status=201)
        self.error = error
        self.calls = []

    def __call__(self, pipe_name, request, timeout_s, response_limit, response_timeout_s):
        self.calls.append((pipe_name, request, timeout_s, response_limit, response_timeout_s))
        if self.error:
            raise self.error
        return self.response


class IdentityAgentClientTests(unittest.TestCase):
    def _exercise_acquisition(self, *, waits=(), opens=(), wait_advance=0.0,
                              write_error=None, read_error=None):
        """Exercise the real connector with scripted Win32 acquisition outcomes."""
        class Win32Failure(OSError):
            def __init__(self, code):
                super().__init__(f"Win32 {code}")
                self.winerror = code

        class Clock:
            value = 0.0

            @classmethod
            def monotonic(cls):
                return cls.value

            @classmethod
            def sleep(cls, seconds):
                cls.value += seconds

        request = b"{}\n"
        response = encode_response(ok=True, status=200)
        buffer = bytearray(4097)
        buffer[:len(response)] = response
        outcomes = {"wait": iter(waits), "open": iter(opens)}
        calls = {"wait": [], "open": [], "write": [], "read": [], "close": [], "sleep": []}
        transfers = iter((len(request), len(response)))

        def wait_pipe(_name, timeout_ms):
            calls["wait"].append(timeout_ms)
            Clock.value += wait_advance
            code = next(outcomes["wait"], None)
            if code is not None:
                raise Win32Failure(code)

        def open_pipe(*_args):
            calls["open"].append(Clock.value)
            code = next(outcomes["open"], None)
            if code is not None:
                raise Win32Failure(code)
            return "pipe"

        def write_pipe(_handle, data, _overlapped):
            calls["write"].append(data)
            if write_error is not None:
                raise Win32Failure(write_error)
            return (0, len(data))

        def read_pipe(_handle, _buffer, _overlapped):
            calls["read"].append(True)
            if read_error is not None:
                raise Win32Failure(read_error)
            return (0, buffer)

        def sleep(seconds):
            calls["sleep"].append(seconds)
            Clock.sleep(seconds)

        fake_file = SimpleNamespace(
            CreateFile=open_pipe,
            WriteFile=write_pipe,
            ReadFile=read_pipe,
            AllocateReadBuffer=lambda _size: buffer,
            GetOverlappedResult=lambda *_args: next(transfers),
            CancelIoEx=lambda *_args: None,
            CloseHandle=lambda handle: calls["close"].append(handle),
        )
        fake_pipe = SimpleNamespace(
            PIPE_READMODE_MESSAGE=2,
            WaitNamedPipe=wait_pipe,
            SetNamedPipeHandleState=lambda *_args: None,
        )
        fake_con = SimpleNamespace(
            GENERIC_READ=1, GENERIC_WRITE=2, OPEN_EXISTING=3,
        )
        fake_event = SimpleNamespace(CreateEvent=lambda *_args: "event")
        fake_pywintypes = SimpleNamespace(OVERLAPPED=lambda: SimpleNamespace(hEvent=None))
        with patch("aegis_engine.identity_agent_client.time.sleep", side_effect=sleep):
            try:
                result = _windows_connector_with_modules(
                    r"\\.\pipe\AEGIS.IdentityAgent.v1", request, 5.0, 4096, 30.0,
                    pywintypes=fake_pywintypes, win32con=fake_con,
                    win32event=fake_event, win32file=fake_file, win32pipe=fake_pipe,
                    monotonic=Clock.monotonic,
                )
                return calls, Clock.value, result, None
            except Exception as exc:
                return calls, Clock.value, None, exc

    def test_transient_no_instance_before_write_retries_within_local_budget(self):
        calls, elapsed, result, error = self._exercise_acquisition(waits=(2, 2, None))
        self.assertIsNone(error)
        self.assertEqual(200, decode_response(result).status)
        self.assertEqual(3, len(calls["wait"]))
        self.assertEqual(1, len(calls["open"]))
        self.assertEqual([b"{}\n"], calls["write"])
        self.assertEqual(["pipe"], calls["close"])
        self.assertLess(elapsed, 5.0)
        self.assertTrue(calls["sleep"])

    def test_transient_pipe_busy_wait_retries_before_write(self):
        calls, _, result, error = self._exercise_acquisition(waits=(231, None))
        self.assertIsNone(error)
        self.assertEqual(200, decode_response(result).status)
        self.assertEqual(2, len(calls["wait"]))
        self.assertEqual(1, len(calls["open"]))
        self.assertEqual([b"{}\n"], calls["write"])

    def test_transient_busy_or_no_instance_after_wait_retries_before_write(self):
        for code in (2, 231):
            with self.subTest(code=code):
                calls, _, result, error = self._exercise_acquisition(
                    waits=(None, None), opens=(code, None),
                )
                self.assertIsNone(error)
                self.assertEqual(200, decode_response(result).status)
                self.assertEqual(2, len(calls["open"]))
                self.assertEqual([b"{}\n"], calls["write"])

    def test_unavailable_pipe_exhausts_local_budget_without_response_budget(self):
        calls, elapsed, result, error = self._exercise_acquisition(waits=(2,) * 300)
        self.assertIsNone(result)
        self.assertIsInstance(error, TimeoutError)
        self.assertLessEqual(elapsed, 5.0)
        self.assertEqual([], calls["open"])
        self.assertEqual([], calls["write"])
        self.assertLessEqual(len(calls["wait"]), 252)

    def test_wait_consuming_local_budget_does_not_attempt_open_or_write(self):
        calls, elapsed, result, error = self._exercise_acquisition(
            waits=(None,), wait_advance=5.0,
        )
        self.assertIsNone(result)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(5.0, elapsed)
        self.assertEqual([], calls["open"])
        self.assertEqual([], calls["write"])

    def test_unrelated_access_denied_is_not_retried(self):
        calls, _, result, error = self._exercise_acquisition(waits=(5,))
        self.assertIsNone(result)
        self.assertEqual(5, error.winerror)
        self.assertEqual(1, len(calls["wait"]))
        self.assertEqual([], calls["sleep"])
        self.assertEqual([], calls["write"])

    def test_win32_wait_timeout_is_not_retried(self):
        calls, _, result, error = self._exercise_acquisition(waits=(121,))
        self.assertIsNone(result)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(1, len(calls["wait"]))
        self.assertEqual([], calls["sleep"])

    def test_post_handle_write_or_read_failure_never_replays_request(self):
        for boundary in ("write_error", "read_error"):
            with self.subTest(boundary=boundary):
                calls, _, result, error = self._exercise_acquisition(**{boundary: 2})
                self.assertIsNone(result)
                self.assertEqual(2, error.winerror)
                self.assertEqual(1, len(calls["open"]))
                self.assertEqual(1, len(calls["write"]))
                self.assertEqual([], calls["sleep"])
                self.assertEqual(["pipe"], calls["close"])

    def test_native_connector_accepts_agent_response_after_local_five_second_window(self):
        """A completed local write must not spend the Agent's HTTPS response budget."""
        class Overlapped:
            hEvent = None

        class FakeClock:
            value = 100.0

            @classmethod
            def monotonic(cls):
                return cls.value

        request = b"{}\n"
        response = encode_response(ok=True, status=200)
        buffer = bytearray(4097)
        buffer[:len(response)] = response
        waits = []
        closed = []
        transfers = iter((len(request), len(response)))

        def wait_for_response(_event, timeout_ms):
            waits.append(timeout_ms)
            if timeout_ms < 6000:
                return 258
            FakeClock.value += 6.0
            return 0

        def write_request(_handle, data, _overlapped):
            self.assertEqual(request, data)
            FakeClock.value += 4.0  # completed within the local 5-second budget
            return (0, len(data))

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0, WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=wait_for_response,
        )
        fake_file = SimpleNamespace(
            CreateFile=lambda *_args: "pipe",
            AllocateReadBuffer=lambda _size: buffer,
            WriteFile=write_request,
            ReadFile=lambda *_args: (997, buffer),
            GetOverlappedResult=lambda *_args: next(transfers),
            CancelIoEx=lambda *_args: None,
            CloseHandle=lambda handle: closed.append(handle),
        )
        fake_pipe = SimpleNamespace(
            PIPE_READMODE_MESSAGE=2,
            WaitNamedPipe=lambda _name, timeout_ms: self.assertLessEqual(timeout_ms, 5000),
            SetNamedPipeHandleState=lambda *_args: None,
        )
        fake_con = SimpleNamespace(
            GENERIC_READ=1, GENERIC_WRITE=2, OPEN_EXISTING=3,
            FILE_FLAG_OVERLAPPED=0x40000000,
        )

        actual = _windows_connector_with_modules(
            r"\\.\pipe\AEGIS.IdentityAgent.v1", request, 5.0, 4096, 17.0,
            pywintypes=SimpleNamespace(OVERLAPPED=Overlapped),
            win32con=fake_con, win32event=fake_event,
            win32file=fake_file, win32pipe=fake_pipe,
            monotonic=FakeClock.monotonic,
        )
        self.assertEqual(response, actual)
        self.assertEqual(200, decode_response(actual).status)
        self.assertEqual(["pipe"], closed)
        self.assertGreaterEqual(waits[0], 16_000)
        self.assertLessEqual(waits[0], 17_000)

    def test_missing_pipe_does_not_receive_the_agent_response_budget(self):
        waits = []

        def unavailable(_name, timeout_ms):
            waits.append(timeout_ms)
            raise FileNotFoundError("local Agent pipe not published")

        with self.assertRaises(FileNotFoundError):
            _windows_connector_with_modules(
                r"\\.\pipe\AEGIS.IdentityAgent.v1", b"{}\n", 5.0, 4096,
                pywintypes=SimpleNamespace(),
                win32con=SimpleNamespace(),
                win32event=SimpleNamespace(),
                win32file=SimpleNamespace(),
                win32pipe=SimpleNamespace(WaitNamedPipe=unavailable),
            )
        self.assertEqual(1, len(waits))
        self.assertLessEqual(waits[0], 5000)

    def test_complete_agent_response_survives_client_handle_close_error(self):
        response = encode_response(ok=True, status=200)
        buffer = bytearray(4097)
        buffer[:len(response)] = response
        transfers = iter((len(b"{}\n"), len(response)))
        closed = []

        class CloseFailure(Exception):
            winerror = "private-winerror-marker"

        def close_with_error(handle):
            closed.append(handle)
            raise CloseFailure("private response content must not be logged")

        with self.assertLogs("aegis_engine.identity_agent_client", level="WARNING") as captured:
            actual = _windows_connector_with_modules(
                r"\\.\pipe\AEGIS.IdentityAgent.v1", b"{}\n", 5.0, 4096,
                pywintypes=SimpleNamespace(OVERLAPPED=lambda: SimpleNamespace(hEvent=None)),
                win32con=SimpleNamespace(GENERIC_READ=1, GENERIC_WRITE=2, OPEN_EXISTING=3),
                win32event=SimpleNamespace(CreateEvent=lambda *_args: "event"),
                win32file=SimpleNamespace(
                    CreateFile=lambda *_args: "pipe",
                    WriteFile=lambda *_args: (0, 0),
                    AllocateReadBuffer=lambda _size: buffer,
                    ReadFile=lambda *_args: (0, buffer),
                    GetOverlappedResult=lambda *_args: next(transfers),
                    CancelIoEx=lambda *_args: None,
                    CloseHandle=close_with_error,
                ),
                win32pipe=SimpleNamespace(
                    PIPE_READMODE_MESSAGE=2,
                    WaitNamedPipe=lambda *_args: None,
                    SetNamedPipeHandleState=lambda *_args: None,
                ),
            )
        self.assertEqual(200, decode_response(actual).status)
        self.assertEqual(["pipe"], closed)
        self.assertIn("winerror=none", " ".join(captured.output))
        self.assertNotIn("private response content", " ".join(captured.output))
        self.assertNotIn("private-winerror-marker", " ".join(captured.output))

    def test_distinct_budgets_reach_injected_connector_without_camera_authority(self):
        connector = RecordingConnector(response=encode_response(ok=True, status=200))
        client = IdentityAgentClient(timeout_s=5, response_timeout_s=17, connector=connector)

        result = client.submit("heartbeat", {"cameraConnected": False})

        self.assertTrue(result.ok)
        self.assertEqual((5, 17), (connector.calls[0][2], connector.calls[0][4]))
        self.assertEqual(0, client.camera_demand_side_effects)

    def test_engine_wires_configured_response_budget_to_real_agent_client(self):
        engine = DetectionEngine(
            config=EngineConfig(
                monitor_ingest_mode="identity_agent",
                identity_agent_timeout_s=5,
                identity_agent_response_timeout_s=17,
            )
        )
        agent = engine._monitor._agent
        self.assertIsInstance(agent, IdentityAgentClient)
        self.assertEqual(5, agent.timeout_s)
        self.assertEqual(17, agent.response_timeout_s)
        self.assertEqual(0, agent.camera_demand_side_effects)

    def test_unauthorized_and_malformed_agent_responses_remain_fail_closed(self):
        unauthorized = IdentityAgentClient(
            connector=RecordingConnector(
                response=encode_response(ok=False, status=None, error="UNAUTHORIZED_CALLER")
            )
        )
        denied = unauthorized.submit("heartbeat", {"cameraConnected": False})
        self.assertFalse(denied.ok)
        self.assertEqual("UNAUTHORIZED_CALLER", denied.error)
        self.assertEqual(0, unauthorized.camera_demand_side_effects)

        malformed = IdentityAgentClient(connector=RecordingConnector(response=b"not-json"))
        invalid = malformed.submit("heartbeat", {"cameraConnected": False})
        self.assertFalse(invalid.ok)
        self.assertEqual("AGENT_UNAVAILABLE", invalid.error)
        self.assertEqual(0, malformed.camera_demand_side_effects)

    def test_client_import_stays_lazy_and_fail_soft_without_pywin32(self):
        script = (
            "import sys\n"
            "from aegis_engine.identity_agent_client import IdentityAgentClient\n"
            "assert not any(name in sys.modules for name in "
            "('pywintypes', 'win32con', 'win32event', 'win32file', 'win32pipe'))\n"
            "client = IdentityAgentClient()\n"
            "result = client.submit('heartbeat', {'cameraConnected': False})\n"
            "assert not result.ok and result.error == 'AGENT_UNAVAILABLE'\n"
            "assert client.camera_demand_side_effects == 0\n"
        )
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ENGINE_ROOT)
        completed = subprocess.run(
            [sys.executable, "-S", "-B", "-c", script],
            cwd=ENGINE_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)

    def test_all_four_operations_use_bounded_local_pipe_requests(self):
        connector = RecordingConnector()
        client = IdentityAgentClient(
            pipe_name=r"\\.\pipe\AEGIS.IdentityAgent.v1",
            timeout_s=5,
            connector=connector,
        )
        payloads = {
            "heartbeat": {"cameraConnected": False},
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
        self.assertTrue(all(call[4] == 30 for call in connector.calls))

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
                    "heartbeat", {"cameraConnected": False}
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
            {"camera_connected": False},
            camera_id="CAM-01",
            node_id="forged-node",
            stream_url="http://attacker.invalid/stream",
        )
        requests = [decode_request(call[1]) for call in connector.calls]
        self.assertEqual(["detection", "clip", "alert", "heartbeat"], [r.operation for r in requests])
        for request in requests:
            self.assertNotIn("nodeId", request.payload)
            self.assertNotIn("physicalCameraId", request.payload)
            self.assertNotIn("streamUrl", request.payload)
        self.assertNotIn("cameraId", requests[-1].payload)
        self.assertEqual("", monitor._key)
        self.assertEqual("", monitor._base)

    def test_strict_physical_heartbeat_is_identical_for_both_account_aliases(self):
        connector = RecordingConnector()
        monitor = MonitorClient(
            identity_agent_client=IdentityAgentClient(connector=connector),
            ingest_mode="identity_agent",
        )
        snapshot = {"camera_connected": False}

        monitor.post_heartbeat(snapshot, camera_id="CAM-01", node_id="forged-a")
        monitor.post_heartbeat(snapshot, camera_id="CAM-02", node_id="forged-b")

        payloads = [decode_request(call[1]).payload for call in connector.calls]
        self.assertEqual(payloads[0], payloads[1])
        self.assertNotIn("cameraId", payloads[0])
        self.assertNotIn("nodeId", payloads[0])
        self.assertNotIn("physicalCameraId", payloads[0])

    def test_agent_unavailable_never_raises_or_imports_camera_demand_boundaries(self):
        agent = IdentityAgentClient(connector=RecordingConnector(error=BrokenPipeError()))
        monitor = MonitorClient(identity_agent_client=agent, ingest_mode="identity_agent")
        original_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name in {"aegis_engine.local_api", "aegis_engine.stream_hub"}:
                self.fail(f"strict ingest imported camera-demand boundary {name}")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=guarded_import):
            monitor.post_heartbeat(
                {"camera_connected": False}, camera_id="CAM-01", node_id="edge-a"
            )
            monitor.post_detection("CAM-01", [])

    def test_strict_configuration_has_no_shared_key_downgrade(self):
        with patch.dict(
            "os.environ",
            {
                "AEGIS_MONITOR_INGEST_MODE": "identity_agent",
                "AEGIS_IDENTITY_AGENT_PIPE_NAME": r"\\.\pipe\AEGIS.IdentityAgent.v1",
                "AEGIS_IDENTITY_AGENT_TIMEOUT_S": "5",
                "AEGIS_IDENTITY_AGENT_RESPONSE_TIMEOUT_S": "18",
                "AEGIS_DETECTION_ENGINE_API_KEY": "legacy-stream-key",
            },
            clear=True,
        ):
            cfg = EngineConfig.from_env().validate()
        self.assertEqual("identity_agent", cfg.monitor_ingest_mode)
        self.assertEqual(r"\\.\pipe\AEGIS.IdentityAgent.v1", cfg.identity_agent_pipe_name)
        self.assertEqual(5, cfg.identity_agent_timeout_s)
        self.assertEqual(18, cfg.identity_agent_response_timeout_s)
        self.assertNotEqual("legacy_shared_key", cfg.monitor_ingest_mode)

    def test_response_budget_defaults_to_thirty_and_rejects_unbounded_values(self):
        with patch.dict("os.environ", {}, clear=True):
            cfg = EngineConfig.from_env().validate()
        self.assertEqual(5, cfg.identity_agent_timeout_s)
        self.assertEqual(30, cfg.identity_agent_response_timeout_s)
        for value in (0, -1, 30.1, float("inf"), float("nan")):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "AEGIS_IDENTITY_AGENT_RESPONSE_TIMEOUT_S"):
                    EngineConfig(identity_agent_response_timeout_s=value).validate()

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
