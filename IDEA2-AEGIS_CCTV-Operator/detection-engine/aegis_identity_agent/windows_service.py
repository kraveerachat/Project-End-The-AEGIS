"""Windows service shell for the camera-independent Identity Agent."""

from __future__ import annotations

import threading


SERVICE_NAME = "AEGISIdentityAgent"
SERVICE_DISPLAY_NAME = "AEGIS Identity Agent"
SERVICE_ACCOUNT = r"NT SERVICE\AEGISIdentityAgent"


class IdentityAgentServiceHost:
    def __init__(
        self,
        *,
        run_once,
        stop_event=None,
        interval_s=5.0,
        retry_max_s=30.0,
        wait_after_success=True,
        on_start=None,
        on_stop=None,
    ):
        self._run_once = run_once
        self._stop_event = stop_event or threading.Event()
        self._interval_s = max(0.001, float(interval_s))
        self._retry_max_s = max(self._interval_s, float(retry_max_s))
        self._wait_after_success = bool(wait_after_success)
        self._on_start = on_start
        self._on_stop = on_stop
        self.last_retry_delay_s = self._interval_s
        self.camera_demand_side_effects = 0

    def run(self):
        if self._on_start is not None:
            self._on_start()
        delay = self._interval_s
        while not self._stop_event.is_set():
            try:
                self._run_once()
                delay = self._interval_s
                if not self._wait_after_success:
                    continue
            except Exception:
                delay = min(self._retry_max_s, max(self._interval_s, delay * 2))
            self.last_retry_delay_s = delay
            self._stop_event.wait(delay)

    def stop(self):
        self._stop_event.set()
        if self._on_stop is not None:
            self._on_stop()


def build_pywin32_service(host_factory, *, maintenance_action=None):
    """Create the pywin32 class lazily so non-Windows tests can import safely."""
    try:
        import win32event
        import win32service
        import win32serviceutil
    except ImportError as exc:
        raise RuntimeError("pywin32 service support is unavailable") from exc

    class AEGISIdentityAgentService(win32serviceutil.ServiceFramework):
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = SERVICE_DISPLAY_NAME
        _svc_description_ = "AEGIS Ed25519 machine identity and authenticated ingest agent"

        def __init__(self, args):
            super().__init__(args)
            self._stop_handle = win32event.CreateEvent(None, 0, 0, None)
            self._maintenance_action = maintenance_action
            self._host = None if maintenance_action is not None else host_factory()

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            if self._host is not None:
                self._host.stop()
            win32event.SetEvent(self._stop_handle)

        def SvcDoRun(self):
            if self._maintenance_action is None:
                self._host.run()
                return
            # The inherited pywin32 SvcRun/native host owns final service
            # status. Returning reports a clean stop; propagating an exception
            # reports ERROR_SERVICE_SPECIFIC_ERROR without a duplicate STOPPED.
            self._maintenance_action()

    return AEGISIdentityAgentService
