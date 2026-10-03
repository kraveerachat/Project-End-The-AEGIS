"""Fail-soft Engine adapter for the local AEGIS Identity Agent pipe."""

from __future__ import annotations

from dataclasses import dataclass
import logging
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


_LOG = logging.getLogger(__name__)


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
    response_timeout_s: float = 30.0,
    *,
    pywintypes,
    win32con,
    win32event,
    win32file,
    win32pipe,
    monotonic=time.monotonic,
) -> bytes:
    # The local pipe acquisition/write budget must not be spent waiting for
    # the Agent's separately bounded HTTPS transaction after a valid write.
    deadline = monotonic() + timeout_s

    def remaining_ms() -> int:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("identity Agent transaction timed out")
        return max(1, int(remaining * 1000))

    # A server can close its last instance between sequential transactions,
    # and an available instance can disappear between WaitNamedPipe/CreateFile.
    # Retry only before acquiring a handle or writing request bytes; a retry
    # after either point could replay an Agent-owned HTTPS transaction.
    while True:
        try:
            # pywin32's BOOLAPI wrapper returns None on success and raises on failure.
            win32pipe.WaitNamedPipe(pipe_name, remaining_ms())
            remaining_ms()  # The wait must not consume the budget before open.
            handle = win32file.CreateFile(
                pipe_name,
                win32con.GENERIC_READ | win32con.GENERIC_WRITE,
                0,
                None,
                win32con.OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            )
            break
        except Exception as exc:
            code = getattr(exc, "winerror", None)
            if code == 121:  # ERROR_SEM_TIMEOUT
                raise TimeoutError("identity Agent local pipe timed out") from exc
            if code not in (2, 231):  # ERROR_FILE_NOT_FOUND / ERROR_PIPE_BUSY
                raise
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError("identity Agent local pipe timed out") from exc
            time.sleep(min(0.02, remaining))
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
        response_deadline = monotonic() + response_timeout_s

        def response_remaining_ms() -> int:
            remaining = response_deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError("identity Agent response timed out")
            return max(1, int(remaining * 1000))

        return _read_overlapped_message(
            pywintypes,
            win32event,
            win32file,
            handle=handle,
            timeout_ms=response_remaining_ms(),
            max_bytes=response_limit,
        )
    finally:
        try:
            _cancel_io(handle, win32file)
        except Exception:
            pass
        try:
            win32file.CloseHandle(handle)
        except Exception as exc:
            # Cleanup must not replace a completed Agent response (or mask the
            # original transaction failure). Never log the exception message.
            code = getattr(exc, "winerror", None)
            _LOG.warning(
                "identity Agent pipe handle close failed: type=%s winerror=%s",
                type(exc).__name__, code if isinstance(code, int) else "none",
            )


def _windows_connector(
    pipe_name: str,
    request: bytes,
    timeout_s: float,
    response_limit: int,
    response_timeout_s: float = 30.0,
) -> bytes:
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
        response_timeout_s,
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
        response_timeout_s: float = 30.0,
        connector=None,
    ):
        if not isinstance(pipe_name, str) or not pipe_name.startswith("\\\\.\\pipe\\"):
            raise ValueError("identity Agent pipe name must be local")
        if not 0.1 <= float(timeout_s) <= 5.0:
            raise ValueError("identity Agent timeout must be between 0.1 and 5 seconds")
        if not 0.1 <= float(response_timeout_s) <= 30.0:
            raise ValueError("identity Agent response timeout must be between 0.1 and 30 seconds")
        self.pipe_name = pipe_name
        self.timeout_s = float(timeout_s)
        self.response_timeout_s = float(response_timeout_s)
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
                self.response_timeout_s,
            )
            response = decode_response(raw)
        except Exception:
            # IPC is telemetry/ingest only. Any local Agent or decoder failure
            # remains fail-soft and cannot stop capture, recording, or health.
            return AgentSubmitResult(False, None, "AGENT_UNAVAILABLE")
        return AgentSubmitResult(response.ok, response.status, response.error)
