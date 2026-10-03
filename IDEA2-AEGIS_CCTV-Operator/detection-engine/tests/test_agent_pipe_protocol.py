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
    _wait_for_client_close,
    _wait_for_overlapped,
    _write_overlapped_message,
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
    @staticmethod
    def _idle_accept_modules(calls):
        class CancelledOperation(Exception):
            winerror = 995

        class Overlapped:
            hEvent = None

        class SecurityAttributes:
            SECURITY_DESCRIPTOR = None

        def create_pipe(name, open_mode, pipe_mode, *_args):
            handle = f"pipe-{len(calls['created']) + 1}"
            calls["created"].append((handle, name, open_mode, pipe_mode))
            return handle

        def drain_cancelled(handle, _overlapped, wait):
            calls["drained"].append((handle, wait))
            raise CancelledOperation("overlapped operation cancelled")

        return {
            "pywintypes": SimpleNamespace(OVERLAPPED=Overlapped, SECURITY_ATTRIBUTES=SecurityAttributes, error=OSError),
            "win32api": SimpleNamespace(),
            "win32con": SimpleNamespace(),
            "win32event": SimpleNamespace(
                WAIT_OBJECT_0=0,
                WAIT_TIMEOUT=258,
                CreateEvent=lambda *_args: "event",
                WaitForSingleObject=lambda *_args: 258,
            ),
            "win32file": SimpleNamespace(
                CancelIoEx=lambda handle, _overlapped: calls["cancelled"].append(handle),
                GetOverlappedResult=drain_cancelled,
                CloseHandle=lambda handle: calls["closed"].append(handle),
            ),
            "win32pipe": SimpleNamespace(
                PIPE_ACCESS_DUPLEX=3,
                PIPE_TYPE_MESSAGE=4,
                PIPE_READMODE_MESSAGE=8,
                PIPE_WAIT=16,
                PIPE_REJECT_REMOTE_CLIENTS=32,
                CreateNamedPipe=create_pipe,
                ConnectNamedPipe=lambda _handle, _overlapped: 997,
            ),
            "win32security": SimpleNamespace(
                SDDL_REVISION_1=1,
                ConvertStringSecurityDescriptorToSecurityDescriptor=lambda sddl, _revision: sddl,
            ),
        }

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
        class CancelledOperation(Exception):
            winerror = 995

        def drain_cancelled(handle, overlapped, wait):
            calls.append(("result", handle, overlapped, wait))
            raise CancelledOperation("overlapped operation cancelled")

        fake_event = SimpleNamespace(
            WAIT_TIMEOUT=258,
            WAIT_OBJECT_0=0,
            WaitForSingleObject=lambda event, timeout: calls.append(("wait", event, timeout)) or 258,
        )
        fake_file = SimpleNamespace(
            CancelIoEx=lambda handle, overlapped: calls.append(("cancel", handle, overlapped)),
            GetOverlappedResult=drain_cancelled,
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

    def test_failed_wait_cancels_and_drains_pending_overlapped_before_error(self):
        calls = []

        class CancelledOperation(Exception):
            winerror = 995

        def drained(handle, _overlapped, wait):
            calls.append(("drain", handle, wait))
            raise CancelledOperation()

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0, WAIT_TIMEOUT=258,
            WaitForSingleObject=lambda *_args: 0xFFFFFFFF,
        )
        fake_file = SimpleNamespace(
            CancelIoEx=lambda handle, _overlapped: calls.append(("cancel", handle)),
            GetOverlappedResult=drained,
        )
        with self.assertRaisesRegex(RuntimeError, "wait failed"):
            _wait_for_overlapped(
                fake_event, fake_file, handle="pipe",
                overlapped=SimpleNamespace(hEvent="event"), timeout_ms=50,
            )
        self.assertEqual([("cancel", "pipe"), ("drain", "pipe", True)], calls)

    def test_cancel_failure_still_drains_pending_overlapped_and_fails_closed(self):
        calls = []

        class CancellationFailure(Exception):
            winerror = 5

        class CancelledOperation(Exception):
            winerror = 995

        def failed_cancel(handle, _overlapped):
            calls.append(("cancel", handle))
            raise CancellationFailure()

        def drained(handle, _overlapped, wait):
            calls.append(("drain", handle, wait))
            raise CancelledOperation()

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0, WAIT_TIMEOUT=258,
            WaitForSingleObject=lambda *_args: 258,
        )
        fake_file = SimpleNamespace(
            CancelIoEx=failed_cancel,
            GetOverlappedResult=drained,
        )
        with self.assertRaises(CancellationFailure):
            _wait_for_overlapped(
                fake_event, fake_file, handle="pipe",
                overlapped=SimpleNamespace(hEvent="event"), timeout_ms=50,
            )
        self.assertEqual([("cancel", "pipe"), ("drain", "pipe", True)], calls)

    def test_unexpected_accept_drain_failure_is_not_classified_as_idle(self):
        calls = {"created": [], "cancelled": [], "drained": [], "closed": []}
        modules = self._idle_accept_modules(calls)

        class DrainFailure(Exception):
            winerror = 5

        def fail_drain(handle, _overlapped, wait):
            calls["drained"].append((handle, wait))
            raise DrainFailure("unexpected overlapped drain failure")

        modules["win32file"].GetOverlappedResult = fail_drain
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111",
            engine_sid="S-1-5-21-222",
            read_timeout_s=0.1,
        )

        with patch.dict(sys.modules, modules), self.assertRaises(DrainFailure):
            server.serve_once()

        self.assertEqual([("pipe-1", True)], calls["drained"])
        self.assertEqual(["pipe-1"], calls["closed"])
        self.assertIsNone(server._active_handle)

    def test_pipe_failure_diagnostic_reports_phase_and_code_without_exception_text(self):
        calls = {"created": [], "cancelled": [], "drained": [], "closed": []}
        modules = self._idle_accept_modules(calls)

        class Win32Failure(OSError):
            winerror = 5

        def denied_read(*_args):
            raise Win32Failure("sensitive-request-marker")

        modules["win32pipe"].ConnectNamedPipe = lambda *_args: 535
        modules["win32file"].AllocateReadBuffer = lambda size: bytearray(size)
        modules["win32file"].ReadFile = denied_read
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111", engine_sid="S-1-5-21-222",
            read_timeout_s=0.1,
        )

        with patch.dict(sys.modules, modules):
            with self.assertLogs("aegis_identity_agent.pipe_server", level="WARNING") as captured:
                with self.assertRaises(Win32Failure):
                    server.serve_once()

        log_text = "\n".join(captured.output)
        self.assertIn("phase=request-read", log_text)
        self.assertIn("exception=Win32Failure", log_text)
        self.assertIn("winerror=5", log_text)
        self.assertNotIn("sensitive-request-marker", log_text)
        self.assertEqual(["pipe-1"], calls["closed"])
        self.assertIsNone(server._active_handle)

    def test_pipe_publish_failure_reports_safe_phase_without_secret_text(self):
        calls = {"created": [], "cancelled": [], "drained": [], "closed": []}
        modules = self._idle_accept_modules(calls)

        class PublishFailure(Exception):
            winerror = 5

        def denied_publish(*_args):
            raise PublishFailure("private-key-marker")

        modules["win32pipe"].CreateNamedPipe = denied_publish
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111", engine_sid="S-1-5-21-222",
            read_timeout_s=0.1,
        )
        with patch.dict(sys.modules, modules):
            with self.assertLogs("aegis_identity_agent.pipe_server", level="WARNING") as captured:
                with self.assertRaises(PublishFailure):
                    server.serve_once()
        log_text = "\n".join(captured.output)
        self.assertIn("phase=publish", log_text)
        self.assertIn("exception=PublishFailure", log_text)
        self.assertIn("winerror=5", log_text)
        self.assertNotIn("private-key-marker", log_text)
        self.assertIsNone(server._active_handle)
        self.assertEqual([], calls["closed"])

    def test_idle_accept_timeout_is_normal_and_closes_the_cancelled_instance(self):
        calls = {"created": [], "cancelled": [], "drained": [], "closed": []}
        modules = self._idle_accept_modules(calls)
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111",
            engine_sid="S-1-5-21-222",
            read_timeout_s=0.1,
        )

        with patch.dict(sys.modules, modules):
            self.assertIsNone(server.serve_once())

        self.assertEqual(["pipe-1"], calls["cancelled"])
        self.assertEqual([("pipe-1", True)], calls["drained"])
        self.assertEqual(["pipe-1"], calls["closed"])
        self.assertIsNone(server._active_handle)
        _, name, open_mode, pipe_mode = calls["created"][0]
        self.assertEqual(server.pipe_name, name)
        self.assertTrue(open_mode & FILE_FLAG_FIRST_PIPE_INSTANCE)
        self.assertTrue(open_mode & FILE_FLAG_OVERLAPPED)
        self.assertTrue(pipe_mode & modules["win32pipe"].PIPE_REJECT_REMOTE_CLIENTS)
        self.assertEqual(0, server.handler.camera_demand_side_effects)

    def test_idle_accept_republishes_without_service_retry_backoff(self):
        from aegis_identity_agent.windows_service import IdentityAgentServiceHost

        calls = {"created": [], "cancelled": [], "drained": [], "closed": []}
        modules = self._idle_accept_modules(calls)
        server = WindowsNamedPipeServer(
            PipeRequestHandler(RecordingTransport(), allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111",
            engine_sid="S-1-5-21-222",
            read_timeout_s=0.1,
        )

        class StopAfterTwoAccepts:
            waits = []

            def is_set(self):
                return len(calls["created"]) >= 2

            def wait(self, delay):
                self.waits.append(delay)

        stop = StopAfterTwoAccepts()
        host = IdentityAgentServiceHost(
            run_once=server.serve_once,
            stop_event=stop,
            interval_s=0.05,
            retry_max_s=1.0,
            wait_after_success=False,
        )
        with patch.dict(sys.modules, modules):
            host.run()

        self.assertEqual(2, len(calls["created"]))
        self.assertEqual([], stop.waits)
        self.assertEqual(["pipe-1", "pipe-2"], calls["cancelled"])
        self.assertEqual(["pipe-1", "pipe-2"], calls["closed"])
        self.assertEqual(0, host.camera_demand_side_effects)

    def test_connected_read_and_write_timeouts_still_fail_closed(self):
        calls = []
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 258,
        )
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: bytearray(size),
            ReadFile=lambda *_args: (997, None),
            WriteFile=lambda *_args: (997, None),
            CancelIoEx=lambda handle, _overlapped: calls.append(("cancel", handle)),
            GetOverlappedResult=lambda handle, _overlapped, wait: calls.append(("drain", handle, wait)) or 0,
        )

        class Overlapped:
            hEvent = None

        pywintypes = SimpleNamespace(OVERLAPPED=Overlapped)
        with self.assertRaises(TimeoutError):
            _read_overlapped_message(pywintypes, fake_event, fake_file, handle="connected", timeout_ms=50)
        with self.assertRaises(TimeoutError):
            _write_overlapped_message(pywintypes, fake_event, fake_file, handle="connected", data=b"response", timeout_ms=50)
        self.assertEqual(2, calls.count(("cancel", "connected")))
        self.assertEqual(2, calls.count(("drain", "connected", True)))

    def test_post_response_peer_close_accepts_only_disconnected_peer_states(self):
        class Win32Failure(Exception):
            def __init__(self, code):
                self.winerror = code
                super().__init__(f"Win32 error {code}")

        class Overlapped:
            hEvent = None

        fake_pywin = SimpleNamespace(OVERLAPPED=Overlapped, error=Win32Failure)
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 0,
        )

        def fail(code):
            raise Win32Failure(code)

        for phase in ("initial_exception", "initial_result", "pending_result", "immediate_result"):
            for code in (109, 232, 233):
                with self.subTest(phase=phase, code=code):
                    read = (
                        (lambda *_args: fail(code)) if phase == "initial_exception"
                        else (lambda *_args: (code, None)) if phase == "initial_result"
                        else (lambda *_args: (997, None)) if phase == "pending_result"
                        else (lambda *_args: (0, None))
                    )
                    fake_file = SimpleNamespace(
                        AllocateReadBuffer=lambda size: bytearray(size),
                        ReadFile=read,
                        GetOverlappedResult=lambda *_args: fail(code),
                    )
                    self.assertIsNone(_wait_for_client_close(
                        fake_pywin, fake_event, fake_file, handle="response-written", timeout_ms=50,
                    ))

        for phase in ("initial_exception", "initial_result", "pending_result", "immediate_result"):
            for code in (5, 87):
                with self.subTest(unrelated_code=code, phase=phase):
                    read = (
                        (lambda *_args: fail(code)) if phase == "initial_exception"
                        else (lambda *_args: (code, None)) if phase == "initial_result"
                        else (lambda *_args: (997, None)) if phase == "pending_result"
                        else (lambda *_args: (0, None))
                    )
                    fake_file = SimpleNamespace(
                        AllocateReadBuffer=lambda size: bytearray(size),
                        ReadFile=read,
                        GetOverlappedResult=lambda *_args: fail(code),
                    )
                    with self.assertRaises((Win32Failure, RuntimeError)) as raised:
                        _wait_for_client_close(
                            fake_pywin, fake_event, fake_file,
                            handle="response-written", timeout_ms=50,
                        )
                    if isinstance(raised.exception, Win32Failure):
                        self.assertEqual(code, raised.exception.winerror)
                    else:
                        self.assertIn(str(code), str(raised.exception))

    def test_post_response_close_timeout_remains_failure(self):
        class CancelledOperation(Exception):
            winerror = 995

        class Overlapped:
            hEvent = None

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 258,
        )
        calls = []
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: bytearray(size),
            ReadFile=lambda *_args: (997, None),
            CancelIoEx=lambda handle, _overlapped: calls.append(("cancel", handle)),
            GetOverlappedResult=lambda *_args: (_ for _ in ()).throw(CancelledOperation()),
        )
        with self.assertRaises(TimeoutError):
            _wait_for_client_close(
                SimpleNamespace(OVERLAPPED=Overlapped, error=Exception),
                fake_event, fake_file, handle="response-written", timeout_ms=50,
            )
        self.assertEqual([("cancel", "response-written")], calls)

    def test_close_timeout_drain_accepts_only_an_observed_peer_close(self):
        class Win32Failure(Exception):
            def __init__(self, code):
                self.winerror = code
                super().__init__(f"Win32 error {code}")

        class Overlapped:
            hEvent = None

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 258,
        )
        for code in (109, 232, 233):
            with self.subTest(code=code):
                calls = []

                def drain(handle, _overlapped, wait):
                    calls.append(("drain", handle, wait))
                    raise Win32Failure(code)

                fake_file = SimpleNamespace(
                    AllocateReadBuffer=lambda size: bytearray(size),
                    ReadFile=lambda *_args: (997, None),
                    CancelIoEx=lambda handle, _overlapped: calls.append(("cancel", handle)),
                    GetOverlappedResult=drain,
                )
                args = (
                    SimpleNamespace(OVERLAPPED=Overlapped, error=Win32Failure),
                    fake_event, fake_file,
                )
                self.assertIsNone(_wait_for_client_close(
                    *args, handle="response-written", timeout_ms=50,
                ))
                self.assertEqual(
                    [("cancel", "response-written"), ("drain", "response-written", True)],
                    calls,
                )

    def test_post_response_trailing_data_still_fails_closed(self):
        class Overlapped:
            hEvent = None

        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 0,
        )
        for read_result in (0, 997):
            with self.subTest(read_result=read_result):
                fake_file = SimpleNamespace(
                    AllocateReadBuffer=lambda size: bytearray(size),
                    ReadFile=lambda *_args: (read_result, None),
                    GetOverlappedResult=lambda *_args: 1,
                )
                with self.assertRaisesRegex(RuntimeError, "trailing protocol data"):
                    _wait_for_client_close(
                        SimpleNamespace(OVERLAPPED=Overlapped, error=OSError),
                        fake_event, fake_file,
                        handle="response-written", timeout_ms=50,
                    )

    def test_post_response_zero_byte_completion_is_not_trailing_data(self):
        class Overlapped:
            hEvent = None

        fake_event = SimpleNamespace(CreateEvent=lambda *_args: "event")
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: bytearray(size),
            ReadFile=lambda *_args: (0, None),
            GetOverlappedResult=lambda *_args: 0,
        )
        self.assertIsNone(_wait_for_client_close(
            SimpleNamespace(OVERLAPPED=Overlapped, error=OSError),
            fake_event, fake_file, handle="response-written", timeout_ms=50,
        ))

    def test_post_response_timeout_race_observes_zero_byte_close_but_not_trailing_data(self):
        class Overlapped:
            hEvent = None

        fake_pywin = SimpleNamespace(OVERLAPPED=Overlapped, error=OSError)
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0, WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 258,
        )
        cancelled = []
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: bytearray(size),
            ReadFile=lambda *_args: (997, None),
            CancelIoEx=lambda handle, _overlapped: cancelled.append(handle),
            GetOverlappedResult=lambda *_args: 0,
        )
        self.assertIsNone(_wait_for_client_close(
            fake_pywin, fake_event, fake_file, handle="response-written", timeout_ms=50,
        ))
        self.assertEqual(["response-written"], cancelled)
        fake_file.GetOverlappedResult = lambda *_args: 1
        with self.assertRaisesRegex(RuntimeError, "trailing protocol data"):
            _wait_for_client_close(
                fake_pywin, fake_event, fake_file, handle="response-written", timeout_ms=50,
            )

    def test_pre_response_error_233_is_never_a_successful_transaction(self):
        class Win32Failure(Exception):
            winerror = 233

        class Overlapped:
            hEvent = None

        fake_pywin = SimpleNamespace(OVERLAPPED=Overlapped, error=Win32Failure)
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0, WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 0,
        )
        fake_file = SimpleNamespace(
            AllocateReadBuffer=lambda size: bytearray(size),
            ReadFile=lambda *_args: (233, None),
            WriteFile=lambda *_args: (233, None),
        )
        with self.assertRaisesRegex(RuntimeError, "connect failed.*233"):
            _connect_overlapped(
                fake_pywin, fake_event, fake_file,
                SimpleNamespace(ConnectNamedPipe=lambda *_args: 233),
                handle="pipe", timeout_ms=50,
            )
        with self.assertRaisesRegex(RuntimeError, "read failed.*233"):
            _read_overlapped_message(
                fake_pywin, fake_event, fake_file, handle="pipe", timeout_ms=50,
            )
        with self.assertRaisesRegex(RuntimeError, "write failed.*233"):
            _write_overlapped_message(
                fake_pywin, fake_event, fake_file,
                handle="pipe", data=b"complete-response", timeout_ms=50,
            )

    def test_response_write_errors_are_not_classified_as_successful_peer_close(self):
        class Win32Failure(Exception):
            def __init__(self, code):
                self.winerror = code
                super().__init__(f"Win32 error {code}")

        class Overlapped:
            hEvent = None

        fake_pywin = SimpleNamespace(OVERLAPPED=Overlapped, error=Win32Failure)
        fake_event = SimpleNamespace(
            WAIT_OBJECT_0=0,
            WAIT_TIMEOUT=258,
            CreateEvent=lambda *_args: "event",
            WaitForSingleObject=lambda *_args: 0,
        )
        for code in (109, 232, 233):
            with self.subTest(code=code, path="WriteFile exception"):
                fake_file = SimpleNamespace(
                    WriteFile=lambda *_args: (_ for _ in ()).throw(Win32Failure(code)),
                )
                with self.assertRaises(Win32Failure):
                    _write_overlapped_message(
                        fake_pywin, fake_event, fake_file,
                        handle="connected", data=b"response", timeout_ms=50,
                    )
            with self.subTest(code=code, path="immediate result"):
                fake_file = SimpleNamespace(
                    WriteFile=lambda *_args: (0, None),
                    GetOverlappedResult=lambda *_args: (_ for _ in ()).throw(Win32Failure(code)),
                )
                with self.assertRaises(Win32Failure):
                    _write_overlapped_message(
                        fake_pywin, fake_event, fake_file,
                        handle="connected", data=b"response", timeout_ms=50,
                    )
            with self.subTest(code=code, path="pending result"):
                fake_file = SimpleNamespace(
                    WriteFile=lambda *_args: (997, None),
                    GetOverlappedResult=lambda *_args: (_ for _ in ()).throw(Win32Failure(code)),
                )
                with self.assertRaises(Win32Failure):
                    _write_overlapped_message(
                        fake_pywin, fake_event, fake_file,
                        handle="connected", data=b"response", timeout_ms=50,
                    )
        fake_file = SimpleNamespace(
            WriteFile=lambda *_args: (0, None),
            GetOverlappedResult=lambda *_args: len(b"response") - 1,
        )
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            _write_overlapped_message(
                fake_pywin, fake_event, fake_file,
                handle="connected", data=b"response", timeout_ms=50,
            )
        for invalid_count in (None, "8", 8.0, True):
            with self.subTest(invalid_count=invalid_count):
                fake_file.GetOverlappedResult = lambda *_args: invalid_count
                with self.assertRaisesRegex(RuntimeError, "incomplete"):
                    _write_overlapped_message(
                        fake_pywin, fake_event, fake_file,
                        handle="connected", data=b"response", timeout_ms=50,
                    )

    def test_successful_close_republishes_same_first_instance_without_service_backoff(self):
        from aegis_identity_agent.windows_service import IdentityAgentServiceHost

        class Win32Failure(Exception):
            winerror = 233

        class Overlapped:
            hEvent = None

        class SecurityAttributes:
            SECURITY_DESCRIPTOR = None

        pipe_name = r"\\.\pipe\AEGIS.IdentityAgent.SequentialTest"
        request = encode_request("heartbeat", samples()["heartbeat"])
        created, closed, responses, last_operation, waits = [], [], [], {}, []

        def create_pipe(name, open_mode, pipe_mode, *_args):
            self.assertEqual(pipe_name, name)
            self.assertTrue(open_mode & FILE_FLAG_FIRST_PIPE_INSTANCE)
            self.assertEqual(len(created), len(closed), "previous instance must close before republish")
            handle = f"pipe-{len(created) + 1}"
            created.append(handle)
            return handle

        def read_file(handle, buffer, _overlapped):
            if len(buffer) == 1:
                raise Win32Failure("client closed after complete response")
            buffer[:len(request)] = request
            last_operation[handle] = ("read", len(request))
            return 0, None

        def write_file(handle, data, _overlapped):
            responses.append(decode_response(data))
            last_operation[handle] = ("write", len(data))
            return 0, None

        modules = {
            "pywintypes": SimpleNamespace(OVERLAPPED=Overlapped, SECURITY_ATTRIBUTES=SecurityAttributes, error=Win32Failure),
            "win32api": SimpleNamespace(GetCurrentThread=lambda: "thread"),
            "win32con": SimpleNamespace(TOKEN_QUERY=1),
            "win32event": SimpleNamespace(CreateEvent=lambda *_args: "event"),
            "win32file": SimpleNamespace(
                AllocateReadBuffer=lambda size: bytearray(size),
                ReadFile=read_file,
                WriteFile=write_file,
                GetOverlappedResult=lambda handle, *_args: last_operation[handle][1],
                CloseHandle=lambda handle: closed.append(handle),
            ),
            "win32pipe": SimpleNamespace(
                PIPE_ACCESS_DUPLEX=3,
                PIPE_TYPE_MESSAGE=4,
                PIPE_READMODE_MESSAGE=8,
                PIPE_WAIT=16,
                PIPE_REJECT_REMOTE_CLIENTS=32,
                CreateNamedPipe=create_pipe,
                ConnectNamedPipe=lambda *_args: 535,
            ),
            "win32security": SimpleNamespace(
                SDDL_REVISION_1=1,
                TokenUser=1,
                ConvertStringSecurityDescriptorToSecurityDescriptor=lambda sddl, _revision: sddl,
                ImpersonateNamedPipeClient=lambda _handle: None,
                OpenThreadToken=lambda *_args: "token",
                GetTokenInformation=lambda *_args: ("sid", None),
                ConvertSidToStringSid=lambda _sid: "S-1-5-21-222",
                RevertToSelf=lambda: None,
            ),
        }
        transport = RecordingTransport(result=SimpleNamespace(ok=True, status=200, error=None))
        server = WindowsNamedPipeServer(
            PipeRequestHandler(transport, allowed_caller_sids={"S-1-5-21-222"}),
            service_sid="S-1-5-80-111", engine_sid="S-1-5-21-222",
            pipe_name=pipe_name, read_timeout_s=0.1,
        )

        class StopAfterThree:
            def is_set(self):
                return len(created) >= 3 or bool(waits)

            def wait(self, delay):
                waits.append(delay)

        errors = []

        def run_once():
            try:
                server.serve_once()
            except Exception as exc:
                errors.append(exc)
                raise

        host = IdentityAgentServiceHost(
            run_once=run_once,
            stop_event=StopAfterThree(),
            interval_s=0.05, retry_max_s=1,
            wait_after_success=False,
        )
        with patch.dict(sys.modules, modules):
            host.run()

        self.assertEqual([], errors)
        self.assertEqual(["pipe-1", "pipe-2", "pipe-3"], created)
        self.assertEqual(created, closed)
        self.assertEqual([], waits, "a normal client close must not trigger retry/backoff")
        self.assertEqual(3, len(transport.calls))
        self.assertTrue(all(response.ok and response.status == 200 for response in responses))
        self.assertIsNone(server._active_handle)
        self.assertEqual(0, server.handler.camera_demand_side_effects)
        self.assertEqual(0, host.camera_demand_side_effects)

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
    def test_native_idle_accept_republishes_for_real_engine_authorized_client(self):
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
        pipe_name = rf"\\.\pipe\AEGIS.IdentityAgent.IdleTest.{uuid.uuid4().hex}"
        transport = RecordingTransport()
        server = WindowsNamedPipeServer(
            PipeRequestHandler(transport, allowed_caller_sids={sid}),
            service_sid=sid,
            engine_sid=sid,
            pipe_name=pipe_name,
            read_timeout_s=2,
        )
        self.addCleanup(server.close)

        # No client arrives for the first bounded accept. It must leave no
        # active handle and must not prevent reusing the same first-instance name.
        self.assertIsNone(server.serve_once())
        self.assertIsNone(server._active_handle)
        self.assertEqual([], transport.calls)

        server_errors = []

        def serve_again():
            try:
                server.serve_once()
            except Exception as exc:
                server_errors.append(exc)

        worker = threading.Thread(target=serve_again)
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
                    self.fail("replacement pipe instance did not become available")
                time.sleep(0.01)

        response = _windows_connector(
            pipe_name,
            encode_request("heartbeat", samples()["heartbeat"]),
            2,
            MAX_RESPONSE_BYTES,
        )
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual([], server_errors)
        self.assertTrue(decode_response(response).ok)
        self.assertEqual(1, len(transport.calls))
        self.assertEqual(0, server.handler.camera_demand_side_effects)

    def _run_native_sequential_responses(self, rounds):
        win32pipe_spec = importlib.util.find_spec("win32pipe")
        dependency_root = pathlib.Path(win32pipe_spec.origin).parent.parent
        dll_cookie = os.add_dll_directory(str(dependency_root / "pywin32_system32"))
        self.addCleanup(dll_cookie.close)
        import win32api
        import win32con
        import win32pipe
        import win32security

        from aegis_engine.identity_agent_client import _windows_connector
        from aegis_identity_agent.windows_service import IdentityAgentServiceHost

        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32con.TOKEN_QUERY
        )
        sid = win32security.ConvertSidToStringSid(
            win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        )
        pipe_name = rf"\\.\pipe\AEGIS.IdentityAgent.SequentialTest.{uuid.uuid4().hex}"
        transport = RecordingTransport(result=SimpleNamespace(ok=True, status=200, error=None))
        server = WindowsNamedPipeServer(
            PipeRequestHandler(transport, allowed_caller_sids={sid}),
            service_sid=sid, engine_sid=sid,
            pipe_name=pipe_name, read_timeout_s=2,
        )
        self.addCleanup(server.close)
        errors = []
        waits = []
        completed = 0

        class StopOnInjectedFailure:
            stopped = False

            def is_set(self):
                return self.stopped

            def wait(self, delay):
                waits.append(delay)
                self.stopped = True

        stop_event = StopOnInjectedFailure()

        def run_once():
            nonlocal completed
            if completed == rounds:
                raise RuntimeError("injected non-pipe service failure")
            before = len(transport.calls)
            try:
                server.serve_once()
            except Exception as exc:
                errors.append(exc)
                raise
            if len(transport.calls) > before:
                completed += 1

        host = IdentityAgentServiceHost(
            run_once=run_once,
            stop_event=stop_event,
            interval_s=0.05,
            retry_max_s=1,
            wait_after_success=False,
        )
        worker = threading.Thread(target=host.run, daemon=True)
        worker.start()
        try:
            for round_number in range(rounds):
                # WaitNamedPipe can return immediately between one-shot pipe
                # instances; this proves eventual republish, not gap-free
                # acquisition of every unsynchronised heartbeat.
                deadline = time.monotonic() + 5
                while True:
                    try:
                        win32pipe.WaitNamedPipe(pipe_name, 50)
                        break
                    except Exception:
                        if errors or waits or time.monotonic() >= deadline:
                            self.fail(f"same-name pipe was not republished at {round_number}: {errors!r}")
                        time.sleep(0.01)
                response = _windows_connector(
                    pipe_name,
                    encode_request("heartbeat", samples()["heartbeat"]),
                    2,
                    MAX_RESPONSE_BYTES,
                    2,
                )
                result = decode_response(response)
                self.assertTrue(result.ok)
                self.assertEqual(200, result.status)
                self.assertEqual(round_number + 1, len(transport.calls))
        finally:
            worker.join(3)
            if worker.is_alive():
                server.close()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual([], errors)
        self.assertEqual(rounds, completed)
        self.assertEqual(rounds, len(transport.calls))
        self.assertEqual(1, len(waits), "successes must not back off; injected failure must")
        self.assertGreaterEqual(waits[0], 0.05)
        self.assertIsNone(server._active_handle)
        self.assertEqual(0, server.handler.camera_demand_side_effects)
        self.assertEqual(0, host.camera_demand_side_effects)

    @unittest.skipUnless(
        os.name == "nt" and importlib.util.find_spec("win32pipe") is not None,
        "native pywin32 acceptance dependency is unavailable",
    )
    def test_native_fifty_sequential_responses_republish_without_service_backoff(self):
        self._run_native_sequential_responses(50)

    @unittest.skipUnless(
        os.name == "nt" and importlib.util.find_spec("win32pipe") is not None,
        "native pywin32 acceptance dependency is unavailable",
    )
    def test_native_hundred_sequential_responses_republish_without_service_backoff(self):
        self._run_native_sequential_responses(100)

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
                0.1,  # short response budget is explicit; local wait stays separate
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
