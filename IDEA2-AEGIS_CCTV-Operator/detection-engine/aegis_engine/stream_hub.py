"""
StreamHub — hand the newest AI-processed frame to N MJPEG viewers.

Why the detector submits frames
-------------------------------
The raw capture fan-out cannot attach a trustworthy bounding box: detection
finishes asynchronously, after that raw frame may already have been encoded.
The detector therefore submits the exact frame/result pair it just processed.
Stream annotations stay spatially aligned. Strict viewer-demand Archive
recording reuses the same renderer on its own bounded queue, while legacy
always-on recording keeps the untouched capture queue.

Why a hub rather than a queue per viewer
----------------------------------------
JPEG encoding is the expensive part. Encoding once per frame and sharing the
bytes with every viewer keeps cost constant no matter how many people are
watching. Viewers never block the pipeline: they read whatever the latest
encoded frame is, and a slow client simply skips frames (correct for live
video — a stale frame is worthless).

Backpressure/liveness contract
------------------------------
* ``latest()`` returns ``(seq, jpeg_bytes)`` or ``None`` if nothing captured yet.
* ``wait_for(after_seq, timeout)`` blocks until a *newer* frame exists, then
  returns it; returns ``None`` on timeout so the caller can emit a keep-alive
  or notice the client vanished.
* When capture stalls, ``wait_for`` times out rather than hanging forever —
  that is what lets the HTTP layer close a dead stream instead of leaking it.
"""

from __future__ import annotations

import queue
import re
import secrets
import threading
import time
from typing import Optional, Tuple

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .models import DetectionResult, DetectionStatus, Frame
from .demand_grant import DemandGrantError
from .recording_authority import RecordingAuthority

log = get_logger("StreamHub")

_MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807


class StaleProducerGenerationError(ValueError):
    """The requested physical producer generation is no longer authoritative."""


def annotate_detection_frame(result: DetectionResult, frame: Frame) -> Frame:
    """Return an annotated copy using the exact Live bounding-box style.

    The raw camera frame is never mutated. Archive recording can therefore
    burn the same detector geometry into stored footage without changing
    inference input, alert evidence, or the original capture buffer.
    """
    if result.frame_seq != frame.seq:
        return frame

    image = frame.image.copy()
    height, width = image.shape[:2]
    for entity in result.entities:
        if entity.bbox is None or entity.status is DetectionStatus.NO_FACE:
            continue
        x, y, w, h = entity.bbox
        x1 = max(0, min(int(x), width - 1))
        y1 = max(0, min(int(y), height - 1))
        x2 = max(x1, min(int(x + w), width - 1))
        y2 = max(y1, min(int(y + h), height - 1))
        if x2 <= x1 or y2 <= y1:
            continue

        color = (
            (0, 157, 255)
            if entity.status is DetectionStatus.UNKNOWN
            else (255, 229, 0)
        )
        confidence = f"{float(entity.confidence):.2f}".rstrip("0").rstrip(".")
        identity_label = (
            "UNKNOWN"
            if entity.status is DetectionStatus.UNKNOWN
            else entity.display_name().upper()
        )
        label = f"{identity_label} // {confidence}%"
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
        (text_w, text_h), baseline = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2
        )
        label_top = max(0, y1 - text_h - baseline - 6)
        label_right = min(width - 1, x1 + text_w + 8)
        cv2.rectangle(
            image,
            (x1, label_top),
            (label_right, y1),
            color,
            cv2.FILLED,
        )
        cv2.putText(
            image,
            label,
            (x1 + 4, max(text_h + 1, y1 - baseline - 3)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (20, 20, 20),
            2,
            cv2.LINE_AA,
        )

    return Frame(
        seq=frame.seq,
        image=image,
        captured_at=frame.captured_at,
        captured_wall=frame.captured_wall,
    )


class StreamHub(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        frame_queue: "queue.Queue[Frame]",
        stop_event: Optional[threading.Event] = None,
        capture_demand_event: Optional[threading.Event] = None,
        *, wall_clock=time.time, monotonic_clock=time.monotonic,
        recording_authority: Optional[RecordingAuthority] = None,
    ) -> None:
        super().__init__(name="StreamHub", daemon=True)
        self._cfg = config
        self._queue = frame_queue
        self._stop_event = stop_event or threading.Event()
        self._capture_demand_event = capture_demand_event
        self._recording_authority = recording_authority
        self.producer_boot_id = secrets.token_urlsafe(32)
        self._wall_clock = wall_clock
        self._monotonic_clock = monotonic_clock
        self._clock_origin_wall = wall_clock() * 1000
        self._clock_origin_mono = monotonic_clock()
        self._authority_time_floor = self._clock_origin_wall
        self._grants: dict[str, dict] = {}
        self._demands: dict[tuple[int, str], dict] = {}
        self._viewer_demands: dict[str, tuple[int, str]] = {}
        self._authority_sweeper = None

        self._cond = threading.Condition()
        self._seq = 0
        self._jpeg: Optional[bytes] = None
        self._viewers = 0
        self._current_producer_generation: Optional[int] = None
        self._producer_generation_retired = False
        self._viewer_lease_generation = 0
        self._viewer_leases: dict[str, int] = {}
        self._viewer_aliases: dict[str, Optional[str]] = {}
        self._viewer_started_at = float("inf")
        self._encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(config.stream_jpeg_quality)]

    def submit_detection(self, result: DetectionResult, frame: Frame) -> None:
        """Render one detector frame for direct StreamHub callers."""
        if result.frame_seq != frame.seq:
            return

        with self._cond:
            if (
                self._viewers == 0
                or frame.captured_at <= self._viewer_started_at
            ):
                return

        self.submit_annotated(
            annotate_detection_frame(result, frame)
        )

    def submit_annotated(self, frame: Frame) -> bool:
        """Queue one already-rendered immutable Live frame."""
        with self._cond:
            # A viewer may disconnect while detection/rendering is in flight.
            if (
                self._viewers == 0
                or frame.captured_at <= self._viewer_started_at
            ):
                return False

            try:
                self._queue.put_nowait(frame)
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    pass

                try:
                    self._queue.put_nowait(frame)
                except queue.Full:
                    return False

            return True

    def stop(self) -> None:
        self._stop_event.set()
        with self._cond:
            if self._capture_demand_event is not None:
                self._capture_demand_event.clear()
            self._cond.notify_all()  # unblock any waiting viewer so it can exit

    def authority_now_ms(self):
        # A rollback must not revive a token after its replay entry was swept.
        # Forward steps only shorten authority; process restart changes boot ID.
        with self._cond:
            self._authority_time_floor = max(self._authority_time_floor,
                self._wall_clock() * 1000,
                self._clock_origin_wall + (self._monotonic_clock() - self._clock_origin_mono) * 1000)
            return self._authority_time_floor

    def _deadline(self, claims):
        remaining = (claims["expiresAtMs"] - self.authority_now_ms()) / 1000
        if not 0 < remaining <= 30:
            raise DemandGrantError("invalid demand grant")
        return self._monotonic_clock() + remaining

    def _expired(self, entry):
        return (entry["expiry"] <= self.authority_now_ms()
                or entry["deadline"] <= self._monotonic_clock())

    def _sweep_locked(self):
        for key, entry in list(self._demands.items()):
            if self._expired(entry):
                for viewer, demand in list(self._viewer_demands.items()):
                    if demand == key:
                        self.remove_viewer(viewer, self._viewer_leases[viewer])
                del self._demands[key]
        for jti, entry in list(self._grants.items()):
            if self._expired(entry):
                del self._grants[jti]

    def _sweep_authority(self):
        # Independent of JPEG encoding, network backpressure and body iteration.
        while not self._stop_event.wait(.25):
            with self._cond:
                self._sweep_locked()

    def _ensure_sweeper_locked(self):
        if self._authority_sweeper is None:
            self._authority_sweeper = threading.Thread(
                target=self._sweep_authority, name="DemandExpiry", daemon=True)
            self._authority_sweeper.start()

    @staticmethod
    def _same_demand(left, right):
        return all(left[key] == right[key] for key in (
            "demandOwnerId", "producerGeneration", "logicalCameraId", "nodeId",
            "physicalCameraId", "engineBootId", "userId", "sessionBindingHash"))

    def reserve_demand(self, claims):
        """Called only after complete cryptographic/claim verification by the route."""
        with self._cond:
            self._sweep_locked()
            deadline = self._deadline(claims)
            generation = int(claims["producerGeneration"])
            key = (generation, claims["demandOwnerId"])
            existing = self._demands.get(key)
            if (claims["action"] != "attach" or claims["jti"] in self._grants
                or self._stop_event.is_set()
                or (existing and (existing["revoked"] or not self._same_demand(existing["claims"], claims)))
                or len(self._grants) + len(self._demands) + (1 if existing else 2) > 4096):
                raise DemandGrantError("invalid demand grant")
            self._prepare_producer_generation_locked(generation)
            self._grants[claims["jti"]] = dict(claims=claims, state="reserved",
                expiry=claims["expiresAtMs"], deadline=deadline)
            if not existing:
                self._demands[key] = dict(claims=claims, revoked=False,
                    expiry=claims["expiresAtMs"], deadline=deadline)
            self._ensure_sweeper_locked()
            return claims["jti"]

    def attach_demand(self, reservation):
        with self._cond:
            self._sweep_locked()
            entry = self._grants.get(reservation)
            if not entry or entry["state"] != "reserved":
                raise DemandGrantError("invalid demand grant")
            claims = entry["claims"]
            key = (int(claims["producerGeneration"]), claims["demandOwnerId"])
            demand = self._demands.get(key)
            if not demand or demand["revoked"] or key in self._viewer_demands.values():
                raise DemandGrantError("invalid demand grant")
            self._prepare_producer_generation_locked(key[0])
            entry["state"] = "used"
            lease = self.add_viewer(producer_generation=key[0], logical_camera_id=claims["logicalCameraId"])
            self._viewer_demands[lease[0]] = key
            return lease

    def control_demand(self, claims):
        with self._cond:
            self._sweep_locked()
            deadline = self._deadline(claims)
            generation = int(claims["producerGeneration"])
            key = (generation, claims["demandOwnerId"])
            action = claims["action"]
            demand = self._demands.get(key)
            if action == "retire":
                # A delayed retirement must never disturb a newer epoch.
                if self._current_producer_generation is None or generation > self._current_producer_generation:
                    self._prepare_producer_generation_locked(generation)
                if generation == self._current_producer_generation:
                    self._producer_generation_retired = True
                    if self._recording_authority is not None:
                        self._recording_authority.retire(generation)
                    for viewer in list(self._viewer_leases):
                        self.remove_viewer(viewer, self._viewer_leases[viewer])
                return
            if action not in ("refresh", "revoke") or (demand and not self._same_demand(demand["claims"], claims)):
                raise DemandGrantError("invalid demand grant")
            if action == "revoke":
                current = self._current_producer_generation
                if current is not None and generation < current:
                    return  # Already permanently stale; never disturb the newer epoch.
                if current is None or generation > current:
                    self._prepare_producer_generation_locked(generation)
                if not demand:
                    if len(self._grants) + len(self._demands) >= 4096:
                        raise DemandGrantError("authority capacity exhausted")
                    demand = self._demands[key] = dict(claims=claims)
                demand.update(revoked=True, expiry=self.authority_now_ms() + 30_000,
                              deadline=self._monotonic_clock() + 30)
                for entry in self._grants.values():
                    if self._same_demand(entry["claims"], claims):
                        entry["state"] = "revoked"
                for viewer, owner in list(self._viewer_demands.items()):
                    if owner == key:
                        self.remove_viewer(viewer, self._viewer_leases[viewer])
                self._ensure_sweeper_locked()
                return
            self._prepare_check_only(generation)
            if (not demand or demand["revoked"] or claims["jti"] in self._grants
                or claims["expiresAtMs"] <= demand["expiry"]
                or len(self._grants) + len(self._demands) >= 4096):
                raise DemandGrantError("invalid demand grant")
            self._grants[claims["jti"]] = dict(claims=claims, state="used",
                expiry=claims["expiresAtMs"], deadline=deadline)
            demand.update(expiry=claims["expiresAtMs"], deadline=deadline)

    def _prepare_check_only(self, generation):
        if generation != self._current_producer_generation or self._producer_generation_retired:
            raise StaleProducerGenerationError("stale producer generation")

    # -- viewer bookkeeping (drives the "N watching" number in metrics/logs) --
    @staticmethod
    def _validate_producer_generation(producer_generation: Optional[int]) -> None:
        if producer_generation is None:
            return
        if (
            isinstance(producer_generation, bool)
            or not isinstance(producer_generation, int)
            or not 1 <= producer_generation <= _MAX_POSTGRES_BIGINT
        ):
            raise ValueError("invalid producer generation")

    def _prepare_producer_generation_locked(
        self, producer_generation: Optional[int]
    ) -> None:
        if producer_generation is None:
            if self._current_producer_generation is not None:
                raise StaleProducerGenerationError("stale producer generation")
            return
        current = self._current_producer_generation
        if current is not None and (
            producer_generation < current
            or (producer_generation == current and self._producer_generation_retired)
        ):
            raise StaleProducerGenerationError("stale producer generation")
        if current is None or producer_generation > current:
            if current is not None and self._recording_authority is not None:
                self._recording_authority.retire(current)
            self._current_producer_generation = producer_generation
            self._producer_generation_retired = False
            # Lower-generation envelopes are now permanently invalid, even if
            # their time window remains open. Their replay/tombstone entries
            # are no longer needed and must not block a higher revoke at cap.
            self._grants.clear()
            self._demands.clear()
            self._viewer_lease_generation += 1
            self._viewer_leases.clear()
            self._viewer_aliases.clear()
            self._viewer_demands.clear()
            self._viewers = 0
            if self._capture_demand_event is not None:
                self._capture_demand_event.clear()
            self._jpeg = None
            self._drain_frame_queue()
            self._cond.notify_all()

    def prepare_producer_generation(self, producer_generation: int) -> None:
        """Fail closed before an HTTP stream response accepts stale authority."""
        self._validate_producer_generation(producer_generation)
        with self._cond:
            self._prepare_producer_generation_locked(producer_generation)

    def add_viewer(
        self, *, producer_generation: Optional[int] = None,
        logical_camera_id: Optional[str] = None,
    ) -> tuple[str, int]:
        self._validate_producer_generation(producer_generation)
        if logical_camera_id is not None and (
            producer_generation is None
            or not isinstance(logical_camera_id, str)
            or len(logical_camera_id) > 64
            or re.fullmatch(r"CAM-[0-9]+", logical_camera_id) is None
        ):
            raise ValueError("invalid logical camera id")
        with self._cond:
            self._prepare_producer_generation_locked(producer_generation)
            first_alias_viewer = logical_camera_id is not None and logical_camera_id not in self._viewer_aliases.values()
            owner_id = secrets.token_hex(16)
            lease = (owner_id, self._viewer_lease_generation)
            self._viewer_leases[owner_id] = self._viewer_lease_generation
            self._viewer_aliases[owner_id] = logical_camera_id
            self._viewers = len(self._viewer_leases)
            n = self._viewers
            if first_alias_viewer and self._recording_authority is not None:
                self._recording_authority.activate(
                    producer_generation, logical_camera_id, self._monotonic_clock()
                )
            if n == 1:
                # Never replay a previous session's final frame to a newly
                # authorized viewer while the camera is waking up.
                self._jpeg = None
                self._viewer_started_at = time.monotonic()
                self._drain_frame_queue()
                if self._capture_demand_event is not None:
                    self._capture_demand_event.set()
        log.info("viewer connected (%d watching)", n)
        return lease

    def remove_viewer(self, owner_id: str, lease_generation: int) -> None:
        with self._cond:
            if self._viewer_leases.get(owner_id) != lease_generation:
                return
            del self._viewer_leases[owner_id]
            alias = self._viewer_aliases.pop(owner_id)
            self._viewer_demands.pop(owner_id, None)
            if (alias is not None and alias not in self._viewer_aliases.values()
                    and self._recording_authority is not None):
                self._recording_authority.deactivate(self._current_producer_generation, alias)
            self._viewers = len(self._viewer_leases)
            n = self._viewers
            if n == 0:
                # Local capture idleness is not Monitor's transactional epoch retirement.
                if self._capture_demand_event is not None:
                    self._capture_demand_event.clear()
                self._jpeg = None
                self._drain_frame_queue()
        log.info("viewer disconnected (%d watching)", n)

    def viewer_is_active(self, owner_id: str, lease_generation: int) -> bool:
        with self._cond:
            return self._viewer_leases.get(owner_id) == lease_generation

    def _drain_frame_queue(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    @property
    def viewers(self) -> int:
        with self._cond:
            return self._viewers

    # -- consumer API ------------------------------------------------------
    def latest(self) -> Optional[Tuple[int, bytes]]:
        with self._cond:
            if self._jpeg is None:
                return None
            return self._seq, self._jpeg

    def wait_for(self, after_seq: int, timeout: float) -> Optional[Tuple[int, bytes]]:
        """Block until a frame newer than ``after_seq`` exists. None on timeout/stop."""
        with self._cond:
            if self._stop_event.is_set():
                return None
            if self._seq > after_seq and self._jpeg is not None:
                return self._seq, self._jpeg
            self._cond.wait(timeout)
            if self._stop_event.is_set():
                return None
            if self._seq > after_seq and self._jpeg is not None:
                return self._seq, self._jpeg
            return None

    # -- producer loop -----------------------------------------------------
    def run(self) -> None:
        log.info(
            "stream hub started · JPEG q=%d · max %.1f fps",
            self._cfg.stream_jpeg_quality,
            self._cfg.stream_max_fps,
        )
        min_interval = 1.0 / self._cfg.stream_max_fps if self._cfg.stream_max_fps > 0 else 0.0
        last_emit = 0.0
        import time as _time
        try:
            while not self._stop_event.is_set():
                try:
                    frame = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                # Nobody is watching -> do not pay for JPEG encoding at all.
                if self.viewers == 0:
                    continue

                now = _time.monotonic()
                if min_interval and (now - last_emit) < min_interval:
                    continue  # throttle: viewers do not need every capture frame
                last_emit = now

                ok, buf = cv2.imencode(".jpg", frame.image, self._encode_params)
                if not ok:
                    continue
                with self._cond:
                    if self._viewers == 0 or frame.captured_at <= self._viewer_started_at:
                        continue
                    self._seq += 1
                    self._jpeg = buf.tobytes()
                    self._cond.notify_all()
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in stream hub loop")
        finally:
            with self._cond:
                self._cond.notify_all()
            log.info("stream hub stopped")
