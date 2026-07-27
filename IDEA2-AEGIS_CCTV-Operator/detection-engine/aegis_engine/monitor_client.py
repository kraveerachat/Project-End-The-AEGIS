"""
MonitorClient — ship detection/clip/alert events to the AEGIS Monitor backend.

The Detection Engine never talks to Postgres directly. It POSTs to Monitor's
Node backend over HTTP, authenticated with a shared service key
(``X-Detection-Engine-Key``) — Monitor's backend does the actual database
write. This keeps the trust boundary identical to the rest of the system:
only an app's own backend ever touches its own database. If this laptop
(VLAN 20) is compromised, it still holds no database credential.

Resilience
----------
Every call fails **soft**: a network error, timeout, or non-2xx response is
logged and swallowed — it NEVER propagates into the recording/detection
pipeline. This mirrors the existing "NAS ล่ม → Local Cache ชั่วคราว" principle:
a temporarily unreachable Monitor must not crash capture or drop footage. The
authoritative footage is still on local disk / NAS; the DB row is a
best-effort mirror that can be back-filled, not a hard dependency.

Configuration (environment)
---------------------------
``AEGIS_MONITOR_API_BASE``        e.g. ``http://localhost/monitor`` (through the
                                  gateway) or ``http://monitor:8002`` on the LAN.
``AEGIS_DETECTION_ENGINE_API_KEY``the shared key; must equal Monitor's
                                  ``DETECTION_ENGINE_API_KEY``. If unset, the
                                  client is DISABLED (logs once, posts nothing)
                                  — same fail-secure stance as the server.
``AEGIS_MONITOR_HTTP_TIMEOUT_S``  per-request timeout (default 5s).
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, List, Optional

from .logging_setup import get_logger

log = get_logger("MonitorClient")

_HEADER = "X-Detection-Engine-Key"


class MonitorClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ) -> None:
        self._base = (base_url or os.environ.get("AEGIS_MONITOR_API_BASE", "")).rstrip("/")
        self._key = api_key or os.environ.get("AEGIS_DETECTION_ENGINE_API_KEY", "")
        try:
            self._timeout = float(timeout_s if timeout_s is not None
                                  else os.environ.get("AEGIS_MONITOR_HTTP_TIMEOUT_S", "5"))
        except (TypeError, ValueError):
            self._timeout = 5.0
        # One warning, not one per dropped event, if we're not wired up.
        self._warned_disabled = False
        self._warn_lock = threading.Lock()

        self._enabled = bool(self._base and self._key)
        if not self._enabled:
            log.warning(
                "MonitorClient DISABLED — set AEGIS_MONITOR_API_BASE and "
                "AEGIS_DETECTION_ENGINE_API_KEY to persist events to Monitor. "
                "Detection still runs; rows just won't be written."
            )
        else:
            log.info("MonitorClient → %s (events will be persisted to Monitor)", self._base)

    # -- public API: one method per table, all fail-soft -------------------
    def post_detection(
        self, camera_id: str, entities: List[Dict[str, Any]],
        frame_id: Optional[str] = None, at: Optional[str] = None,
    ) -> None:
        """One recognition event (a frame may carry several people)."""
        body: Dict[str, Any] = {"cameraId": camera_id, "entities": entities}
        if frame_id is not None:
            body["frameId"] = frame_id
        if at is not None:
            body["at"] = at
        self._post("/internal/detections", body)

    def post_clip(
        self, camera_id: str, started_at: str, duration_sec: float,
        file_path: str, stored_on_nas: bool,
    ) -> None:
        """A finalized ~segment. Call ONLY after NAS sha256-verify succeeds so
        ``stored_on_nas`` is never set optimistically."""
        self._post("/internal/clips", {
            "cameraId": camera_id,
            "startedAt": started_at,
            "durationSec": duration_sec,
            "filePath": file_path,
            "storedOnNas": bool(stored_on_nas),
        })

    def post_heartbeat(self, camera_id: str, node_id: str, snapshot: Dict[str, Any]) -> None:
        """Liveness + live metrics for one camera.

        This is the ONLY source behind Monitor's ``/api/link``. Before this
        existed the web app's "Edge node: online" pill was a hard-coded
        constant that stayed green while this process was dead. Now silence
        here is what turns the pill amber and then red, purely from the age of
        the last row written — nothing in the web app fabricates it.

        Fails soft like every other call: a heartbeat we could not deliver is
        a heartbeat Monitor correctly treats as missing.
        """
        nas = snapshot.get("nas") or {}
        recorder = snapshot.get("recorder") or {}
        self._post("/internal/heartbeat", {
            "cameraId": camera_id,
            "nodeId": node_id,
            "cameraConnected": bool(snapshot.get("camera_connected")),
            "cameraReconnects": snapshot.get("camera_reconnects"),
            "captureFps": snapshot.get("capture_fps"),
            "detectFps": snapshot.get("detect_fps"),
            "latencyMs": snapshot.get("latency_ms"),
            "latencyMsAvg": snapshot.get("latency_ms_avg"),
            "uptimeS": snapshot.get("uptime_s"),
            "framesCaptured": snapshot.get("frames_captured"),
            "segmentsWritten": recorder.get("segments_written"),
            "nasLastStatus": nas.get("last_status"),
            "nasPending": nas.get("pending"),
        })

    def post_alert(
        self, camera_id: str, severity: str, alert_type: str, title: str,
        snapshot_path: Optional[str], telegram_sent: bool,
    ) -> None:
        """An alert. Persist whether or not Telegram delivery succeeded."""
        self._post("/internal/alerts", {
            "cameraId": camera_id,
            "severity": severity,          # 'amber' | 'red' (already mapped by caller)
            "alertType": alert_type,
            "title": title,
            "snapshotPath": snapshot_path,
            "telegramSent": bool(telegram_sent),
        })

    # -- transport (never raises) ------------------------------------------
    def _post(self, path: str, body: Dict[str, Any]) -> None:
        if not self._enabled:
            self._warn_once()
            return
        try:
            import requests  # lazy import — same pattern as alert_manager
        except Exception:
            log.error("`requests` not installed — cannot reach Monitor")
            return

        url = f"{self._base}{path}"
        try:
            resp = requests.post(
                url,
                json=body,
                headers={_HEADER: self._key},
                timeout=self._timeout,
            )
        except Exception as exc:
            # Network down / DNS / timeout — log and move on. The pipeline
            # keeps recording; footage is safe on disk/NAS regardless.
            log.warning("Monitor unreachable for %s (%s: %s) — event not persisted",
                        path, type(exc).__name__, exc)
            return

        if 200 <= resp.status_code < 300:
            log.debug("posted %s → %s", path, resp.status_code)
            return
        # 4xx/5xx: log the body (truncated) so a shape/auth bug is visible,
        # but still don't raise into the pipeline.
        log.warning("Monitor rejected %s: HTTP %s %s",
                    path, resp.status_code, (resp.text or "")[:300])

    def _warn_once(self) -> None:
        with self._warn_lock:
            if self._warned_disabled:
                return
            self._warned_disabled = True
        log.warning("MonitorClient disabled — dropping events (this warning logs once)")
