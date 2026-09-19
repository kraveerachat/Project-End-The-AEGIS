"""
MonitorClient — ship detection/clip/alert events to the AEGIS Monitor backend.

The Detection Engine never talks to Postgres directly. It POSTs to Monitor's
Node backend either through the local Identity Agent (strict Ed25519 mode) or
the explicitly selected transitional shared-key path. Monitor's backend does
the actual database write; the Engine never receives a database credential or
the Agent private key/session.

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
``AEGIS_MONITOR_INGEST_MODE``     ``identity_agent`` (strict) or the explicit
                                  transitional ``legacy_shared_key`` mode.
``AEGIS_MONITOR_API_BASE``        legacy-mode Monitor base URL.
``AEGIS_DETECTION_ENGINE_API_KEY``legacy-mode shared key; never used as a
                                  fallback in ``identity_agent`` mode.
``AEGIS_IDENTITY_AGENT_PIPE_NAME``local strict-mode pipe endpoint.
``AEGIS_MONITOR_HTTP_TIMEOUT_S``  legacy per-request timeout (default 5s).
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, List, Optional

from .logging_setup import get_logger

log = get_logger("MonitorClient")

_HEADER = "X-Detection-Engine-Key"
_UNSET = object()


class MonitorClient:
    def __init__(
        self,
        base_url: object = _UNSET,
        api_key: object = _UNSET,
        timeout_s: Optional[float] = None,
        identity_agent_client=None,
        ingest_mode: str = "legacy_shared_key",
    ) -> None:
        self._ingest_mode = str(ingest_mode).strip().lower()
        if self._ingest_mode not in {"legacy_shared_key", "identity_agent"}:
            raise ValueError("unsupported Monitor ingest mode")
        if self._ingest_mode == "identity_agent":
            # Strict ingest has no Monitor destination or application key. The
            # local Agent owns both. The existing Engine API key remains a
            # separate inbound stream-demand credential until that boundary is
            # replaced by its later lifecycle task.
            self._base = ""
            self._key = ""
        else:
            self._base = (
                base_url if base_url is not _UNSET
                else os.environ.get("AEGIS_MONITOR_API_BASE", "")
            )
            self._base = str(self._base or "").rstrip("/")
            self._key = (
                api_key if api_key is not _UNSET
                else os.environ.get("AEGIS_DETECTION_ENGINE_API_KEY", "")
            )
            self._key = str(self._key or "")
        try:
            self._timeout = float(timeout_s if timeout_s is not None
                                  else os.environ.get("AEGIS_MONITOR_HTTP_TIMEOUT_S", "5"))
        except (TypeError, ValueError):
            self._timeout = 5.0
        # One warning, not one per dropped event, if we're not wired up.
        self._warned_disabled = False
        self._warn_lock = threading.Lock()
        self._agent = identity_agent_client

        self._enabled = (
            self._agent is not None
            if self._ingest_mode == "identity_agent"
            else bool(self._base and self._key)
        )
        if not self._enabled:
            requirement = (
                "a reachable local Identity Agent"
                if self._ingest_mode == "identity_agent"
                else "AEGIS_MONITOR_API_BASE and AEGIS_DETECTION_ENGINE_API_KEY"
            )
            log.warning(
                "MonitorClient DISABLED — configure %s to persist events to Monitor. "
                "Detection still runs; rows just won't be written.",
                requirement,
            )
        else:
            destination = "local Identity Agent" if self._agent is not None else self._base
            log.info("MonitorClient → %s (events will be persisted to Monitor)", destination)

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
        self._post("detection", "/internal/detections", body)

    def post_clip(
        self, camera_id: str, started_at: str, duration_sec: float,
        file_path: str, stored_on_nas: bool,
    ) -> None:
        """A finalized ~segment. Call ONLY after NAS sha256-verify succeeds so
        ``stored_on_nas`` is never set optimistically."""
        self._post("clip", "/internal/clips", {
            "cameraId": camera_id,
            "startedAt": started_at,
            "durationSec": duration_sec,
            "filePath": file_path,
            "storedOnNas": bool(stored_on_nas),
        })

    def post_heartbeat(
        self, camera_id: str, node_id: str, snapshot: Dict[str, Any],
        stream_url: Optional[str] = None, camera_device_name: Optional[str] = None,
    ) -> None:
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
        body = {
            "cameraId": camera_id,
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
            "cameraDeviceName": camera_device_name,
        }
        if self._ingest_mode == "legacy_shared_key":
            body["nodeId"] = node_id
            body["streamUrl"] = stream_url
        self._post("heartbeat", "/internal/heartbeat", body)

    def post_alert(
        self, camera_id: str, severity: str, alert_type: str, title: str,
        snapshot_path: Optional[str], telegram_sent: bool,
    ) -> None:
        """An alert. Persist whether or not Telegram delivery succeeded."""
        self._post("alert", "/internal/alerts", {
            "cameraId": camera_id,
            "severity": severity,          # 'amber' | 'red' (already mapped by caller)
            "alertType": alert_type,
            "title": title,
            "snapshotPath": snapshot_path,
            "telegramSent": bool(telegram_sent),
        })

    # -- transport (never raises) ------------------------------------------
    def _post(self, operation: str, path: str, body: Dict[str, Any]) -> None:
        if not self._enabled:
            self._warn_once()
            return
        if self._ingest_mode == "identity_agent":
            result = self._agent.submit(operation, body)
            if not result.ok:
                log.warning("Identity Agent rejected %s (%s)", operation, result.error)
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
