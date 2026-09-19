"""Fail-soft Engine adapter for the local AEGIS Identity Agent pipe."""

from __future__ import annotations

from dataclasses import dataclass
import time

from aegis_identity_agent.pipe_protocol import (
    MAX_RESPONSE_BYTES,
    PipeProtocolError,
    decode_response,
    encode_request,
)
from aegis_identity_agent.pipe_server import (
    DEFAULT_PIPE_NAME,
    FILE_FLAG_OVERLAPPED,
    _read_overlapped_message,
    _cancel_io,
    _write_overlapped_message,
)


@dataclass(frozen=True)
class AgentSubmitResult:
    ok: bool
    status: int | None
    error: str | None = None


def _windows_connector_with_modules(
    pipe_name: str,
    request: bytes,
    timeout_s: float,
    response_limit: int,
    *,
    pywintypes,
    win32con,
    win32event,
    win32file,
    win32pipe,
    monotonic=time.monotonic,
) -> bytes:
    deadline = monotonic() + timeout_s

    def remaining_ms() -> int:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("identity Agent transaction timed out")
        return max(1, int(remaining * 1000))

    # pywin32's BOOLAPI wrapper returns None on success and raises on failure.
    win32pipe.WaitNamedPipe(pipe_name, remaining_ms())
    handle = win32file.CreateFile(
        pipe_name,
        win32con.GENERIC_READ | win32con.GENERIC_WRITE,
        0,
        None,
        win32con.OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED,
        None,
    )
    try:
        win32pipe.SetNamedPipeHandleState(
            handle,
            win32pipe.PIPE_READMODE_MESSAGE,
            None,
            None,
        )
        _write_overlapped_message(
            pywintypes,
            win32event,
            win32file,
            handle=handle,
            data=request,
            timeout_ms=remaining_ms(),
        )
        return _read_overlapped_message(
            pywintypes,
            win32event,
            win32file,
            handle=handle,
            timeout_ms=remaining_ms(),
            max_bytes=response_limit,
        )
    finally:
        try:
            _cancel_io(handle, win32file)
        except Exception:
            pass
        win32file.CloseHandle(handle)


def _windows_connector(pipe_name: str, request: bytes, timeout_s: float, response_limit: int) -> bytes:
    try:
        import pywintypes
        import win32con
        import win32event
        import win32file
        import win32pipe
    except ImportError as exc:  # pragma: no cover - Windows acceptance owns this
        raise BrokenPipeError("pywin32 named-pipe client is unavailable") from exc
    return _windows_connector_with_modules(
        pipe_name,
        request,
        timeout_s,
        response_limit,
        pywintypes=pywintypes,
        win32con=win32con,
        win32event=win32event,
        win32file=win32file,
        win32pipe=win32pipe,
    )


class IdentityAgentClient:
    def __init__(
        self,
        *,
        pipe_name: str = DEFAULT_PIPE_NAME,
        timeout_s: float = 5.0,
        connector=None,
    ):
        if not isinstance(pipe_name, str) or not pipe_name.startswith("\\\\.\\pipe\\"):
            raise ValueError("identity Agent pipe name must be local")
        if not 0.1 <= float(timeout_s) <= 5.0:
            raise ValueError("identity Agent timeout must be between 0.1 and 5 seconds")
        self.pipe_name = pipe_name
        self.timeout_s = float(timeout_s)
        self._connector = connector or _windows_connector
        self.camera_demand_side_effects = 0

    def submit(self, operation: str, payload: dict) -> AgentSubmitResult:
        try:
            request = encode_request(operation, payload)
            raw = self._connector(
                self.pipe_name,
                request,
                self.timeout_s,
                MAX_RESPONSE_BYTES,
            )
            response = decode_response(raw)
        except Exception:
            # IPC is telemetry/ingest only. Any local Agent or decoder failure
            # remains fail-soft and cannot stop capture, recording, or health.
            return AgentSubmitResult(False, None, "AGENT_UNAVAILABLE")
        return AgentSubmitResult(response.ok, response.status, response.error)
