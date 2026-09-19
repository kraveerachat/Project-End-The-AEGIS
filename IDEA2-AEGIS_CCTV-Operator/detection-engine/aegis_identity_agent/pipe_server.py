"""Bounded local named-pipe request boundary for the Identity Agent."""

from __future__ import annotations

import re
import threading

from .pipe_protocol import PipeProtocolError, decode_request, encode_response


DEFAULT_PIPE_NAME = r"\\.\pipe\AEGIS.IdentityAgent.v1"
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
FILE_FLAG_OVERLAPPED = 0x40000000
ERROR_IO_PENDING = 997
ERROR_PIPE_CONNECTED = 535
ERROR_NOT_FOUND = 1168
ERROR_BROKEN_PIPE = 109
_SID_RE = re.compile(r"^S-[0-9]+(?:-[0-9]+)+$")


def pipe_open_mode(win32pipe) -> int:
    """Create one fail-closed, cancellable first pipe instance."""
    return (
        win32pipe.PIPE_ACCESS_DUPLEX
        | FILE_FLAG_FIRST_PIPE_INSTANCE
        | FILE_FLAG_OVERLAPPED
    )


def _cancel_io(handle, win32file) -> None:
    cancel = getattr(win32file, "CancelIoEx", None)
    if cancel is not None:
        cancel(handle, None)
        return
    # pywin32 312 exposes CancelIo but not CancelIoEx. The latter is required
    # for service-control-thread shutdown, so call the Windows API with a NULL
    # OVERLAPPED pointer: each connection owns at most one pending operation.
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CancelIoEx.argtypes = (wintypes.HANDLE, wintypes.LPVOID)
    kernel32.CancelIoEx.restype = wintypes.BOOL
    if not kernel32.CancelIoEx(int(handle), None):
        error = ctypes.get_last_error()
        if error != ERROR_NOT_FOUND:
            raise OSError(error, "CancelIoEx failed")


def _wait_for_overlapped(
    win32event,
    win32file,
    *,
    handle,
    overlapped,
    timeout_ms: int,
):
    state = win32event.WaitForSingleObject(overlapped.hEvent, timeout_ms)
    if state == win32event.WAIT_OBJECT_0:
        return win32file.GetOverlappedResult(handle, overlapped, False)
    if state == win32event.WAIT_TIMEOUT:
        try:
            _cancel_io(handle, win32file)
        except Exception as exc:
            if getattr(exc, "winerror", None) != ERROR_NOT_FOUND:
                raise
        try:
            # CancelIoEx only requests cancellation. Keep the OVERLAPPED and
            # any attached buffer alive until Windows reports completion;
            # ERROR_OPERATION_ABORTED is the expected result.
            win32file.GetOverlappedResult(handle, overlapped, True)
        except Exception:
            pass
        raise TimeoutError("named-pipe operation timed out")
    raise RuntimeError("named-pipe wait failed")


def _new_overlapped(pywintypes, win32event):
    overlapped = pywintypes.OVERLAPPED()
    overlapped.hEvent = win32event.CreateEvent(None, True, False, None)
    return overlapped


def _connect_overlapped(
    pywintypes,
    win32event,
    win32file,
    win32pipe,
    *,
    handle,
    timeout_ms: int,
) -> None:
    overlapped = _new_overlapped(pywintypes, win32event)
    try:
        result = win32pipe.ConnectNamedPipe(handle, overlapped)
    except pywintypes.error as exc:
        result = getattr(exc, "winerror", None)
    if result in (None, 0, ERROR_PIPE_CONNECTED):
        return
    if result == ERROR_IO_PENDING:
        _wait_for_overlapped(
            win32event,
            win32file,
            handle=handle,
            overlapped=overlapped,
            timeout_ms=timeout_ms,
        )
        return
    raise RuntimeError(f"named-pipe connect failed with error {result}")


def _read_overlapped_message(
    pywintypes,
    win32event,
    win32file,
    *,
    handle,
    timeout_ms: int,
    max_bytes: int = 64 * 1024,
) -> bytes:
    overlapped = _new_overlapped(pywintypes, win32event)
    buffer = win32file.AllocateReadBuffer(max_bytes + 1)
    error_code, _ = win32file.ReadFile(handle, buffer, overlapped)
    if error_code == ERROR_IO_PENDING:
        transferred = _wait_for_overlapped(
            win32event,
            win32file,
            handle=handle,
            overlapped=overlapped,
            timeout_ms=timeout_ms,
        )
    elif error_code in (None, 0):
        transferred = win32file.GetOverlappedResult(handle, overlapped, False)
    else:
        raise RuntimeError(f"named-pipe read failed with error {error_code}")
    if not isinstance(transferred, int) or not 0 < transferred <= max_bytes:
        raise RuntimeError("named-pipe message size is invalid")
    return bytes(buffer[:transferred])


def _write_overlapped_message(
    pywintypes,
    win32event,
    win32file,
    *,
    handle,
    data: bytes,
    timeout_ms: int,
) -> None:
    overlapped = _new_overlapped(pywintypes, win32event)
    error_code, _ = win32file.WriteFile(handle, data, overlapped)
    if error_code == ERROR_IO_PENDING:
        transferred = _wait_for_overlapped(
            win32event,
            win32file,
            handle=handle,
            overlapped=overlapped,
            timeout_ms=timeout_ms,
        )
    elif error_code in (None, 0):
        transferred = win32file.GetOverlappedResult(handle, overlapped, False)
    else:
        raise RuntimeError(f"named-pipe write failed with error {error_code}")
    if transferred != len(data):
        raise RuntimeError("named-pipe response write was incomplete")


def _wait_for_client_close(
    pywintypes,
    win32event,
    win32file,
    *,
    handle,
    timeout_ms: int,
) -> None:
    """Boundedly retain the response until the one-shot client closes."""
    overlapped = _new_overlapped(pywintypes, win32event)
    buffer = win32file.AllocateReadBuffer(1)
    try:
        error_code, _ = win32file.ReadFile(handle, buffer, overlapped)
    except pywintypes.error as exc:
        if getattr(exc, "winerror", None) == ERROR_BROKEN_PIPE:
            return
        raise
    if error_code == ERROR_BROKEN_PIPE:
        return
    if error_code == ERROR_IO_PENDING:
        try:
            transferred = _wait_for_overlapped(
                win32event,
                win32file,
                handle=handle,
                overlapped=overlapped,
                timeout_ms=timeout_ms,
            )
        except pywintypes.error as exc:
            if getattr(exc, "winerror", None) == ERROR_BROKEN_PIPE:
                return
            raise
    elif error_code in (None, 0):
        try:
            transferred = win32file.GetOverlappedResult(handle, overlapped, False)
        except pywintypes.error as exc:
            if getattr(exc, "winerror", None) == ERROR_BROKEN_PIPE:
                return
            raise
    else:
        raise RuntimeError(f"named-pipe close wait failed with error {error_code}")
    if transferred:
        raise RuntimeError("named-pipe client sent trailing protocol data")


def resolve_account_sid(account_name: str) -> str:
    try:
        import win32security
    except ImportError as exc:  # pragma: no cover - Windows acceptance owns this
        raise RuntimeError("pywin32 account lookup is unavailable") from exc
    sid, _, _ = win32security.LookupAccountName(None, account_name)
    return win32security.ConvertSidToStringSid(sid)


def pipe_security_sddl(service_sid: str, engine_sid: str) -> str:
    """DACL: protected, full Agent control, read/write Engine access, no ambient ACE."""
    if _SID_RE.fullmatch(service_sid) is None or _SID_RE.fullmatch(engine_sid) is None:
        raise ValueError("pipe ACL requires canonical SID strings")
    return f"D:P(A;;GA;;;{service_sid})(A;;GRGW;;;{engine_sid})"


class PipeRequestHandler:
    def __init__(self, transport, *, allowed_caller_sids, max_concurrent: int = 4):
        allowed = frozenset(str(item) for item in allowed_caller_sids)
        if not allowed or any(not item for item in allowed):
            raise ValueError("at least one caller SID is required")
        if not isinstance(max_concurrent, int) or not 1 <= max_concurrent <= 16:
            raise ValueError("max_concurrent must be between 1 and 16")
        self._transport = transport
        self._allowed = allowed
        self._slots = threading.BoundedSemaphore(max_concurrent)
        self.camera_demand_side_effects = 0

    def handle(self, raw: bytes, *, caller_sid: str) -> bytes:
        if caller_sid not in self._allowed:
            return encode_response(ok=False, status=None, error="UNAUTHORIZED_CALLER")
        if not self._slots.acquire(blocking=False):
            return encode_response(ok=False, status=None, error="BUSY")
        try:
            try:
                request = decode_request(raw)
            except PipeProtocolError as exc:
                return encode_response(ok=False, status=None, error=exc.code)
            try:
                result = self._transport.submit(request.operation, request.payload)
            except Exception:
                return encode_response(ok=False, status=None, error="AGENT_UNAVAILABLE")
            if result.ok:
                return encode_response(ok=True, status=result.status)
            error = result.error if result.error in {
                "AGENT_UNAVAILABLE", "MONITOR_REJECTED", "SESSION_EXHAUSTED",
            } else "MONITOR_REJECTED"
            return encode_response(ok=False, status=result.status, error=error)
        finally:
            self._slots.release()


class WindowsNamedPipeServer:
    """One-request-per-connection Windows pipe server with a closed DACL.

    pywin32 is imported lazily so Linux and non-service test environments can
    import the Agent package. The source-only checkpoint is followed by an
    explicit real-Windows ACL and timeout acceptance gate.
    """

    def __init__(
        self,
        handler: PipeRequestHandler,
        *,
        service_sid: str,
        engine_sid: str,
        pipe_name: str = DEFAULT_PIPE_NAME,
        read_timeout_s: float = 5.0,
    ):
        if not 0.1 <= float(read_timeout_s) <= 5.0:
            raise ValueError("pipe read timeout must be between 0.1 and 5 seconds")
        self.handler = handler
        self.service_sid = service_sid
        self.engine_sid = engine_sid
        self.pipe_name = pipe_name
        self.read_timeout_s = float(read_timeout_s)
        self.sddl = pipe_security_sddl(service_sid, engine_sid)
        self._closed = threading.Event()
        self._handle_lock = threading.Lock()
        self._active_handle = None

    def close(self):
        self._closed.set()
        with self._handle_lock:
            handle = self._active_handle
            self._active_handle = None
        if handle is not None:
            try:
                import win32file
                _cancel_io(handle, win32file)
            except Exception:
                pass

    def serve_once(self):
        if self._closed.is_set():
            return
        try:
            import pywintypes
            import win32api
            import win32con
            import win32event
            import win32file
            import win32pipe
            import win32security
        except ImportError as exc:  # pragma: no cover - Windows acceptance owns this
            raise RuntimeError("pywin32 named-pipe support is unavailable") from exc

        descriptor = win32security.ConvertStringSecurityDescriptorToSecurityDescriptor(
            self.sddl,
            win32security.SDDL_REVISION_1,
        )
        attributes = pywintypes.SECURITY_ATTRIBUTES()
        attributes.SECURITY_DESCRIPTOR = descriptor
        handle = win32pipe.CreateNamedPipe(
            self.pipe_name,
            pipe_open_mode(win32pipe),
            win32pipe.PIPE_TYPE_MESSAGE
            | win32pipe.PIPE_READMODE_MESSAGE
            | win32pipe.PIPE_WAIT
            | win32pipe.PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            64 * 1024,
            int(self.read_timeout_s * 1000),
            attributes,
        )
        with self._handle_lock:
            if self._closed.is_set():
                win32file.CloseHandle(handle)
                return
            self._active_handle = handle
        try:
            timeout_ms = int(self.read_timeout_s * 1000)
            _connect_overlapped(
                pywintypes,
                win32event,
                win32file,
                win32pipe,
                handle=handle,
                timeout_ms=timeout_ms,
            )
            # Windows permits named-pipe impersonation only after the server
            # has read client data. The read remains bounded and no payload is
            # decoded or submitted before the caller SID is validated.
            data = _read_overlapped_message(
                pywintypes,
                win32event,
                win32file,
                handle=handle,
                timeout_ms=timeout_ms,
            )
            win32security.ImpersonateNamedPipeClient(handle)
            try:
                token = win32security.OpenThreadToken(
                    win32api.GetCurrentThread(), win32con.TOKEN_QUERY, True
                )
                caller_sid = win32security.ConvertSidToStringSid(
                    win32security.GetTokenInformation(token, win32security.TokenUser)[0]
                )
            finally:
                win32security.RevertToSelf()

            response = self.handler.handle(data, caller_sid=caller_sid)
            _write_overlapped_message(
                pywintypes,
                win32event,
                win32file,
                handle=handle,
                data=response,
                timeout_ms=timeout_ms,
            )
            _wait_for_client_close(
                pywintypes,
                win32event,
                win32file,
                handle=handle,
                timeout_ms=timeout_ms,
            )
        finally:
            with self._handle_lock:
                if self._active_handle == handle:
                    self._active_handle = None
            try:
                win32file.CloseHandle(handle)
            except Exception:
                pass
