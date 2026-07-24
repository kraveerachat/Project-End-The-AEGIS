"""
AlertManager — asynchronous "Unknown face" notifier.

Listens for ``Unknown`` detections coming off the processor and pushes an alert
(a JPEG snapshot + a JSON payload) to a Telegram bot. Everything happens on a
**dedicated worker thread** with its own bounded queue, so the detection
hot-path never blocks on the network:

    detector ──submit()──▶ [alert_queue] ──▶ AlertManager thread ──▶ Telegram

Noise control
-------------
Security feeds produce the same "Unknown" verdict many times per second while a
stranger stands in frame. A per-camera **cooldown** collapses that into at most
one alert every ``alert_cooldown_s`` seconds. Snapshots are always written to
disk locally (even in dry-run), so nothing is lost if Telegram is unreachable.

Configuration
-------------
Set ``AEGIS_TELEGRAM_BOT_TOKEN`` and ``AEGIS_TELEGRAM_CHAT_ID``. If either is
missing the manager runs in **dry-run** mode: it still logs and saves snapshots,
but sends nothing — handy for local development.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import DetectionResult, DetectionStatus, Frame, utc_now_iso

log = get_logger("AlertManager")

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendPhoto"


@dataclass
class _AlertJob:
    payload: dict
    jpeg: bytes
    snapshot_path: str


class AlertManager(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        stop_event: Optional[threading.Event] = None,
        max_queue: int = 64,
        publish: Optional[Callable[[dict], None]] = None,
        monitor: Optional[object] = None,
    ) -> None:
        super().__init__(name="AlertManager", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._stop_event = stop_event or threading.Event()
        self._queue: "queue.Queue[_AlertJob]" = queue.Queue(maxsize=max_queue)
        self._last_alert_at: dict = {}  # cooldown key -> monotonic timestamp
        # Optional sink so alerts also appear on the live API stream / web app.
        self._publish = publish
        # Optional MonitorClient — persist an `alerts` row after each send
        # attempt, success OR failure (see _handle). Fails soft.
        self._monitor = monitor
        self._dry_run = not (config.telegram_bot_token and config.telegram_chat_id)
        if self._dry_run:
            log.warning(
                "Telegram not configured — AlertManager runs in DRY-RUN "
                "(snapshots saved, nothing sent)."
            )

    def stop(self) -> None:
        self._stop_event.set()

    # -- producer side (called from the detector callback) -----------------
    def submit(self, result: DetectionResult, frame: Frame) -> None:
        """Consider a detection result for alerting. Non-blocking, thread-safe.

        Applies the cooldown, encodes a snapshot, and enqueues the send job.
        Called from the FaceDetector thread — must be cheap and never raise.
        """
        if not result.has_unknown:
            return

        key = f"{result.camera_id}:unknown"
        now = time.monotonic()
        last = self._last_alert_at.get(key, 0.0)
        if now - last < self._cfg.alert_cooldown_s:
            return  # within cooldown window — suppress
        self._last_alert_at[key] = now

        try:
            jpeg, snapshot_path = self._make_snapshot(result, frame)
        except Exception:
            log.exception("failed to build snapshot for alert")
            return

        payload = self._build_payload(result, snapshot_path)
        try:
            self._queue.put_nowait(_AlertJob(payload, jpeg, snapshot_path))
        except queue.Full:
            log.warning("alert queue full — dropping alert for %s", result.camera_id)

    def _build_payload(self, result: DetectionResult, snapshot_path: str) -> dict:
        unknowns = [e for e in result.entities if e.status is DetectionStatus.UNKNOWN]
        top_conf = max((e.confidence for e in unknowns), default=0.0)
        return {
            "type": "alert",
            "severity": "warning",
            "reason": "unknown_face",
            "node_id": self._cfg.node_id,
            "camera_id": result.camera_id,
            "camera_label": self._cfg.camera_label,
            "unknown_count": len(unknowns),
            "confidence": round(top_conf, 1),
            "frame_seq": result.frame_seq,
            "snapshot": os.path.abspath(snapshot_path),
            "timestamp": utc_now_iso(),
        }

    def _make_snapshot(self, result: DetectionResult, frame: Frame):
        """Draw boxes on a copy of the frame, encode JPEG, and persist it."""
        img = frame.image.copy()
        for e in result.entities:
            if e.bbox is None:
                continue
            x, y, w, h = e.bbox
            amber = (0, 157, 255)  # BGR ~ #FF9D00, matches the HUD "unknown"
            teal = (255, 229, 0)  # BGR ~ #00E5FF
            color = amber if e.status is DetectionStatus.UNKNOWN else teal
            cv2.rectangle(img, (x, y), (x + w, y + h), color, 2)
            label = e.display_name()
            cv2.putText(
                img, label, (x, max(0, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA,
            )

        os.makedirs(self._cfg.alert_snapshot_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        fname = f"{result.camera_id}_unknown_{ts}_{frame.seq}.jpg"
        path = os.path.join(self._cfg.alert_snapshot_dir, fname)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            raise RuntimeError("cv2.imencode failed for snapshot")
        jpeg = buf.tobytes()
        with open(path, "wb") as fh:
            fh.write(jpeg)
        return jpeg, path

    # -- consumer side (dedicated thread) ----------------------------------
    def run(self) -> None:
        log.info("alert manager started (dry_run=%s)", self._dry_run)
        try:
            while not self._stop_event.is_set():
                try:
                    job = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue
                self._handle(job)
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in alert loop")
        finally:
            log.info("alert manager stopped")

    def _handle(self, job: _AlertJob) -> None:
        # Surface the alert on the live API stream regardless of delivery
        # outcome — the web app should see the event even if Telegram is down.
        if self._publish is not None:
            try:
                self._publish(job.payload)
            except Exception:  # pragma: no cover - defensive
                log.exception("alert publish callback raised")

        caption = (
            f"🚨 UNKNOWN FACE\n"
            f"Camera: {job.payload['camera_id']} · {job.payload['camera_label']}\n"
            f"Node: {job.payload['node_id']}\n"
            f"Count: {job.payload['unknown_count']} · "
            f"Conf: {job.payload['confidence']}%\n"
            f"Time: {job.payload['timestamp']}"
        )
        telegram_sent = False
        if self._dry_run:
            log.warning("[DRY-RUN] alert (snapshot %s): %s",
                        job.snapshot_path, caption.replace("\n", " | "))
            self._metrics.on_alert_sent()
        elif self._send_telegram(job.jpeg, caption):
            telegram_sent = True
            self._metrics.on_alert_sent()
            log.info("alert sent for %s", job.payload["camera_id"])
        else:
            log.error("alert delivery failed for %s", job.payload["camera_id"])

        # Persist the alert regardless of the Telegram outcome — the record must
        # survive even if Telegram is unreachable (don't lose the event).
        self._persist_alert(job.payload, telegram_sent)

    def _persist_alert(self, payload: dict, telegram_sent: bool) -> None:
        if self._monitor is None:
            return
        # Map the engine's severity onto Monitor's schema CHECK ('amber' | 'red').
        sev = str(payload.get("severity", "warning")).lower()
        severity = "red" if sev in ("red", "critical") else "amber"
        self._monitor.post_alert(
            camera_id=payload.get("camera_id"),
            severity=severity,
            alert_type=payload.get("reason", "unknown_face"),
            title="Unknown person detected",
            snapshot_path=payload.get("snapshot"),
            telegram_sent=telegram_sent,
        )

    def _send_telegram(self, jpeg: bytes, caption: str) -> bool:
        """POST a photo to Telegram with a small retry loop. Never raises."""
        try:
            import requests  # imported lazily so the dep is optional at import
        except Exception:
            log.error("`requests` not installed — cannot deliver Telegram alert")
            return False

        url = _TELEGRAM_API.format(token=self._cfg.telegram_bot_token)
        for attempt in range(1, 4):
            if self._stop_event.is_set():
                return False
            try:
                resp = requests.post(
                    url,
                    data={"chat_id": self._cfg.telegram_chat_id, "caption": caption},
                    files={"photo": ("snapshot.jpg", jpeg, "image/jpeg")},
                    timeout=self._cfg.alert_http_timeout_s,
                )
                if resp.status_code == 200 and resp.json().get("ok"):
                    return True
                log.warning(
                    "telegram attempt %d failed: HTTP %s %s",
                    attempt, resp.status_code, resp.text[:200],
                )
            except Exception as exc:
                log.warning("telegram attempt %d raised: %s", attempt, exc)
            self._stop_event.wait(min(2.0 * attempt, 5.0))  # backoff, interruptible
        return False
