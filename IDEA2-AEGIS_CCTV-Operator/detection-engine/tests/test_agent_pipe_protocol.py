import importlib.util
import json
import os
import pathlib
import sys
import threading
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.pipe_protocol import (
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    PIPE_OPERATIONS,
    PipeProtocolError,
    decode_request,
    decode_response,
    encode_request,
    encode_response,
)
from aegis_identity_agent.pipe_server import (
    FILE_FLAG_FIRST_PIPE_INSTANCE,
    FILE_FLAG_OVERLAPPED,
    PipeRequestHandler,
    WindowsNamedPipeServer,
    _connect_overlapped,
    _read_overlapped_message,
    _wait_for_overlapped,
    pipe_open_mode,
    pipe_security_sddl,
)


def samples():
    return {
        "heartbeat": {
            "cameraConnected": False,
            "cameraReconnects": 0,
            "captureFps": 0.0,
            "detectFps": 0.0,
            "latencyMs": None,
            "latencyMsAvg": None,
            "uptimeS": 12.5,
            "framesCaptured": 0,
            "segmentsWritten": 0,
            "nasLastStatus": None,
            "nasPending": 0,
            "cameraDeviceName": "Camera A",
        },
        "detection": {
            "cameraId": "CAM-01",
            "entities": [{"status": "Unknown", "name": None, "confidence": 84.5}],
            "frameId": "frame-1",
            "at": "2026-09-19T00:00:00.000Z",
        },
        "alert": {
            "cameraId": "CAM-01",
            "severity": "amber",
            "alertType": "unknown_face",
            "title": "Unknown person detected",
            "snapshotPath": "snapshots/frame-1.jpg",
            "telegramSent": False,
        },
        "clip": {
            "cameraId": "CAM-01",
            "startedAt": "2026-09-19T00:00:00.000Z",
            "durationSec": 10.0,
            "filePath": "segments/clip-1.mp4",
            "storedOnNas": True,
        },
    }


class RecordingTransport:
    def __init__(self, result=None, entered=None, release=None):
        self.calls = []
        self.result = result or SimpleNamespace(ok=True, status=201, error=None)
        self.entered = entered
        self.release = release

    def submit(self, operation, payload):
        self.calls.append((operation, payload))
        if self.entered:
            self.entered.set()
        if self.release:
            self.release.wait(1)
        return self.result


class PipeProtocolTests(unittest.TestCase):
    def test_exact_four_operation_allowlist_has_no_generic_signing(self):
        self.assertEqual({"heartbeat", "detection", "alert", "clip"}, PIPE_OPERATIONS)
        for operation, payload in samples().items():
            decoded = decode_request(encode_request(operation, payload))
            self.assertEqual(operation, decoded.operation)
            self.assertEqual(payload, decoded.payload)
        for operation in ("sign", "request", "proxy", "camera-demand"):
            with self.subTest(operation=operation), self.assertRaises(PipeProtocolError):
                encode_request(operation, {})

    def test_request_is_capped_and_duplicate_json_keys_are_rejected(self):
        with self.assertRaisesRegex(PipeProtocolError, "size"):
            decode_request(b"{" + b" " * MAX_REQUEST_BYTES + b"}")
        duplicate = b'{"version":1,"operation":"heartbeat","operation":"alert","payload":{}}'
        with self.assertRaisesRegex(PipeProtocolError, "duplicate"):
            decode_request(duplicate)

    def test_envelope_and_operation_schemas_are_closed(self):
        raw = json.dumps({
            "version": 1,
            "operation": "heartbeat",
            "payload": samples()["heartbeat"],
            "url": "https://evil.invalid",
        }).encode()
        with self.assertRaises(PipeProtocolError):
            decode_request(raw)
        payload = dict(samples()["clip"], bytes="not-allowed")
        with self.assertRaises(PipeProtocolError):
            encode_request("clip", payload)

    def test_engine_cannot_supply_any_heartbeat_url(self):
        payload = dict(samples()["heartbeat"], streamUrl="http://127.0.0.1:8077/stream.mjpg")
        with self.assertRaises(PipeProtocolError):
            encode_request("heartbeat", payload)

    def test_engine_cannot_supply_logical_or_physical_heartbeat_authority(self):
        for field, value in (
            ("cameraId", "CAM-01"),
            ("nodeId", "forged-node"),
            ("physicalCameraId", 999),
        ):
            with self.subTest(field=field), self.assertRaises(PipeProtocolError):
                encode_request("heartbeat", dict(samples()["heartbeat"], **{field: value}))

    def test_identity_signing_and_transport_authority_fields_are_rejected_recursively(self):
        forbidden = (
            "nodeId", "physicalCameraId", "sessionId", "signature",
            "requestNonce", "canonicalPayload", "privateKey", "method", "path", "headers",
        )
        for field in forbidden:
            payload = dict(samples()["detection"])
            payload["entities"] = [{"status": "Unknown", field: "forged"}]
            with self.subTest(field=field), self.assertRaises(PipeProtocolError):
                encode_request("detection", payload)

    def test_response_is_bounded_and_contains_only_non_secret_result_fields(self):
        encoded = encode_response(ok=True, status=201)
        self.assertLessEqual(len(encoded), MAX_RESPONSE_BYTES)
        result = decode_response(encoded)
        self.assertTrue(result.ok)
        self.assertEqual(201, result.status)
        rendered = encoded.decode("utf-8")
        for field in ("signature", "privateKey", "sessionId", "requestNonce"):
            self.assertNotIn(field, rendered)
        with self.assertRaisesRegex(PipeProtocolError, "size"):
            decode_response(b"{" + b" " * MAX_RESPONSE_BYTES + b"}")

    def test_handler_requires_exact_authorized_caller_sid_and_dacl_is_closed(self):
        service_sid = "S-1-5-80-111"
        engine_sid = "S-1-5-21-222"
        sddl = pipe_security_sddl(service_sid, engine_sid)
        self.assertIn(service_sid, sddl)
        self.assertIn(engine_sid, sddl)
        self.assertNotIn(";;;WD", sddl)
        self.assertNotIn(";;;AU", sddl)

        transport = RecordingTransport()
        handler = PipeRequestHandler(transport, allowed_caller_sids={engine_sid})
        raw = encode_request("heartbeat", samples()["heartbeat"])
        denied = decode_response(handler.handle(raw, caller_sid="S-1-5-21-999"))
        self.assertFalse(denied.ok)
        self.assertEqual("UNAUTHORIZED_CALLER", denied.error)
        self.assertEqual([], transport.calls)
        accepted = decode_response(handler.handle(raw, caller_sid=engine_sid))
        self.assertTrue(accepted.ok)
        self.assertEqual(1, len(transport.calls))

    def test_handler_rejects_excess_concurrency_without_unbounded_queueing(self):
        entered = threading.Event()
        release = threading.Event()
        transport = RecordingTransport(entered=entered, release=release)
        handler = PipeRequestHandler(transport, allowed_caller_sids={"engine"}, max_concurrent=1)
        raw = encode_request("heartbeat", samples()["heartbeat"])
        first = threading.Thread(target=lambda: handler.handle(raw, caller_sid="engine"))
        first.start()
        self.assertTrue(entered.wait(1))
        busy = decode_response(handler.handle(raw, caller_sid="engine"))
        self.assertFalse(busy.ok)
        self.assertEqual("BUSY", busy.error)
        release.set()
        first.join(1)
        self.assertFalse(first.is_alive())

    def test_pipe_open_mode_requires_first_instance_and_overlapped_io(self):
        fake_pipe = SimpleNamespace(PIPE_ACCESS_DUPLEX=0x00000003)
        mode = pipe_open_mode(fake_pipe)
        self.assertEqual(FILE_FLAG_FIRST_PIPE_INSTANCE, mode & FILE_FLAG_FIRST_PIPE_INSTANCE)
        self.assertEqual(FILE_FLAG_OVERLAPPED, mode & FILE_FLAG_OVERLAPPED)

    def test_overlapped_timeout_cancels_handle_and_drains_operation_completion(self):
        calls = []
        fake_event = SimpleNamespace(
            WAIT_TIMEOUT=258,
            WAIT_OBJECT_0=0,
            WaitForSingleObject=lambda event, timeout: calls.append(("wait", event, timeout)) or 258,
        )
        fake_file = SimpleNamespace(
            CancelIoEx=lambda handle, overlapped: calls.append(("cancel", handle, overlapped)),
            GetOverlappedResult=lambda handle, overlapped, wait: calls.append(
                ("result", handle, overlapped, wait)
            ),
        )
        with self.assertRaises(TimeoutError):
            _wait_for_overlapped(
                fake_event,
                fake_file,
                handle="pipe",
                overlapped=SimpleNamespace(hEvent="event"),
                timeout_ms=50,
            )
        cancel = next(call for call in calls if call[0] == "cancel")
        result = next(call for call in calls if call[0] == "result")
        self.assertEqual(("cancel", "pipe", None), cancel)
        self.assertEqual(("result", "pipe"), result[:2])
        self.assertTrue(result[3], "cancelled OVERLAPPED must remain alive until completion")
        self.assertEqual(1, len([call for call in calls if call[0] == "wait"]))

    def test_overlapped_read_decodes_only_the_completed_prefix(self):
        message = encode_request("heartbeat", samples()["heartbeat"])
        allocated = bytearray(MAX_REQUEST_BYTES + 1)
        allocated[:len(message)] = message
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: allocated,
            ReadFile=lambda handle, buffer, overlapped: (997, buffer),
            GetOverlappedResult=lambda handle, overlapped, wait: len(message),
            CancelIoEx=lambda handle, overlapped: None,
        )
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *args: "event",
            WaitForSingleObject=lambda event, timeout: 0,
        )

        class Overlapped:
            hEvent = None

        raw = _read_overlapped_message(
            SimpleNamespace(OVERLAPPED=Overlapped),
            fake_event,
            fake_file,
            handle="pipe",
            timeout_ms=50,
        )
        self.assertEqual(message, raw)
        self.assertEqual("heartbeat", decode_request(raw).operation)

    def test_connect_treats_client_before_connect_as_already_connected(self):
        waits = []
        fake_pipe = SimpleNamespace(
            ConnectNamedPipe=lambda handle, overlapped: 535,
        )
        fake_event = SimpleNamespace(
            CreateEvent=lambda *args: "event",
            WaitForSingleObject=lambda *args: waits.append(args) or 0,
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
        )
        fake_file = SimpleNamespace()

        class Overlapped:
            hEvent = None

        _connect_overlapped(
            SimpleNamespace(OVERLAPPED=Overlapped, error=OSError),
            fake_event,
            fake_file,
            fake_pipe,
            handle="pipe",
            timeout_ms=50,
        )
        self.assertEqual([], waits)

    def test_close_cancels_but_operation_owner_closes_active_handle(self):
        calls = []
        fake_file = SimpleNamespace(
            CancelIoEx=lambda handle, overlapped: calls.append(("cancel", handle, overlapped)),
            CloseHandle=lambda handle: calls.append(("close", handle)),
        )
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"engine"}),
            service_sid="S-1-5-80-111",
            engine_sid="S-1-5-21-222",
        )
        server._active_handle = "pipe"
        with patch.dict(sys.modules, {"win32file": fake_file}):
            server.close()
        self.assertIn(("cancel", "pipe", None), calls)
        self.assertNotIn(("close", "pipe"), calls)

    def test_server_source_has_no_unbounded_named_pipe_flush(self):
        source = (ENGINE_ROOT / "aegis_identity_agent" / "pipe_server.py").read_text(encoding="utf-8")
        self.assertNotIn("FlushFileBuffers", source)

    @unittest.skipUnless(
        os.name == "nt" and importlib.util.find_spec("win32pipe") is not None,
        "native pywin32 acceptance dependency is unavailable",
    )
    def test_native_windows_pipe_round_trip_uses_real_acl_and_overlapped_io(self):
        win32pipe_spec = importlib.util.find_spec("win32pipe")
        dependency_root = pathlib.Path(win32pipe_spec.origin).parent.parent
        dll_cookie = os.add_dll_directory(str(dependency_root / "pywin32_system32"))
        self.addCleanup(dll_cookie.close)
        import win32api
        import win32con
        import win32pipe
        import win32security

        from aegis_engine.identity_agent_client import _windows_connector

        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32con.TOKEN_QUERY
        )
        sid = win32security.ConvertSidToStringSid(
            win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        )
        pipe_name = rf"\\.\pipe\AEGIS.IdentityAgent.Task6.{uuid.uuid4().hex}"
        transport = RecordingTransport()
        server = WindowsNamedPipeServer(
            PipeRequestHandler(transport, allowed_caller_sids={sid}),
            service_sid=sid,
            engine_sid=sid,
            pipe_name=pipe_name,
            read_timeout_s=1,
        )
        server_errors = []

        def serve():
            try:
                server.serve_once()
            except Exception as exc:
                server_errors.append(exc)

        worker = threading.Thread(target=serve)
        worker.start()
        deadline = time.monotonic() + 1
        while True:
            try:
                win32pipe.WaitNamedPipe(pipe_name, 50)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    server.close()
                    worker.join(1)
                    self.fail("native pipe instance did not become available")
                time.sleep(0.01)

        client_error = None
        raw_response = None
        try:
            raw_response = _windows_connector(
                pipe_name,
                encode_request("heartbeat", samples()["heartbeat"]),
                1,
                MAX_RESPONSE_BYTES,
            )
        except Exception as exc:
            client_error = exc
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual([], server_errors)
        if client_error is not None:
            raise client_error
        result = decode_response(raw_response)
        self.assertTrue(result.ok)
        self.assertEqual(201, result.status)
        self.assertEqual(1, len(transport.calls))

    @unittest.skipUnless(
        os.name == "nt" and importlib.util.find_spec("win32pipe") is not None,
        "native pywin32 acceptance dependency is unavailable",
    )
    def test_native_windows_client_timeout_cancels_stalled_transaction(self):
        win32pipe_spec = importlib.util.find_spec("win32pipe")
        dependency_root = pathlib.Path(win32pipe_spec.origin).parent.parent
        dll_cookie = os.add_dll_directory(str(dependency_root / "pywin32_system32"))
        self.addCleanup(dll_cookie.close)
        import win32api
        import win32con
        import win32pipe
        import win32security

        from aegis_engine.identity_agent_client import _windows_connector

        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32con.TOKEN_QUERY
        )
        sid = win32security.ConvertSidToStringSid(
            win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        )
        pipe_name = rf"\\.\pipe\AEGIS.IdentityAgent.Task6.{uuid.uuid4().hex}"
        entered = threading.Event()
        release = threading.Event()
        transport = RecordingTransport(entered=entered, release=release)
        server = WindowsNamedPipeServer(
            PipeRequestHandler(transport, allowed_caller_sids={sid}),
            service_sid=sid,
            engine_sid=sid,
            pipe_name=pipe_name,
            read_timeout_s=1,
        )
        server_errors = []

        def serve():
            try:
                server.serve_once()
            except Exception as exc:
                server_errors.append(exc)

        worker = threading.Thread(target=serve)
        worker.start()
        deadline = time.monotonic() + 1
        while True:
            try:
                win32pipe.WaitNamedPipe(pipe_name, 50)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    server.close()
                    worker.join(1)
                    self.fail("native pipe instance did not become available")
                time.sleep(0.01)

        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            _windows_connector(
                pipe_name,
                encode_request("heartbeat", samples()["heartbeat"]),
                0.1,
                MAX_RESPONSE_BYTES,
            )
        elapsed = time.monotonic() - started
        self.assertTrue(entered.wait(1))
        release.set()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertLess(elapsed, 1.0)
        self.assertTrue(
            not server_errors
            or getattr(server_errors[0], "winerror", None) in {109, 232},
            server_errors,
        )


if __name__ == "__main__":
    unittest.main()
