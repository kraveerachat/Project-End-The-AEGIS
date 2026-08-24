"""
Central configuration for the Detection Engine.

Everything is driven by environment variables (12-factor style) so the same
image/build runs on any edge node without code changes. See ``.env.example``
for the full list. If ``python-dotenv`` is installed, a local ``.env`` file is
loaded automatically; otherwise real environment variables are used as-is.

Nothing secret is ever hard-coded here — tokens, hosts and credentials come
from the environment only.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, fields
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

try:  # optional convenience only — never a hard dependency
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional
    pass


def _env_str(key: str, default: str) -> str:
    val = os.environ.get(key)
    return val if val is not None and val != "" else default


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"Environment variable {key!r}={raw!r} is not a valid int")


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"Environment variable {key!r}={raw!r} is not a valid float")


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on", "y"}:
        return True
    if normalized in {"0", "false", "no", "off", "n"}:
        return False
    raise ValueError(
        f"Environment variable {key!r}={raw!r} is not a valid boolean"
    )


def _env_opt(key: str) -> Optional[str]:
    val = os.environ.get(key)
    return val if val else None


def _redact_url_credentials(value: str) -> str:
    """Mask URL userinfo while preserving a useful host/path for diagnostics."""
    try:
        parsed = urlsplit(value)
        if not parsed.scheme or "@" not in parsed.netloc:
            return value
        host = parsed.netloc.rsplit("@", 1)[1]
        return urlunsplit(
            (parsed.scheme, f"***:***@{host}", parsed.path, parsed.query, parsed.fragment)
        )
    except ValueError:
        return "***redacted-url***"


@dataclass(frozen=True)
class EngineConfig:
    """Immutable, fully-resolved runtime configuration.

    Build one with :meth:`from_env` at process start and pass it down to every
    worker. Being frozen, it is safe to share across threads.
    """

    # --- Identity ---------------------------------------------------------
    node_id: str = "edge-node-01"
    camera_id: str = "CAM-05"
    camera_label: str = "Reception"
    camera_device_name: Optional[str] = None

    # --- Capture (VideoCatcher) ------------------------------------------
    # camera_source is passed straight to cv2.VideoCapture: an int index
    # ("0") for a local webcam, or a URL ("rtsp://...") for an IP camera.
    camera_source: str = "0"
    frame_width: int = 1280
    frame_height: int = 720
    target_fps: int = 24
    capture_reconnect_delay_s: float = 2.0
    capture_max_reconnect_delay_s: float = 30.0
    # Keep the API/heartbeat process available while releasing the physical
    # camera whenever no authenticated Monitor stream is being consumed.
    capture_on_demand: bool = False

    # --- Queues -----------------------------------------------------------
    record_queue_size: int = 240  # ~10s of headroom @ 24fps before dropping
    detect_queue_size: int = 1  # detector always processes the freshest frame

    # --- Detection (FaceDetectorProcessor) -------------------------------
    detect_every_n_frames: int = 1  # throttle inference (e.g. 2 = every other)
    detect_min_confidence: float = 60.0
    # Placeholder is deliberately the safe default. The production candidate
    # keeps the trained YOLO model, but requires SFace identity verification;
    # a one-class object detector is never sufficient to authorize a person.
    recognizer_backend: str = "placeholder"  # placeholder | yolo-sface-admin
    admin_model_path: Optional[str] = None
    admin_class_name: str = "Admin-Face-Scan"
    admin_display_name: str = "Admin"
    admin_min_confidence: float = 50.0
    face_detector_model_path: Optional[str] = None
    face_recognizer_model_path: Optional[str] = None
    admin_embeddings_path: Optional[str] = None
    face_match_cosine_threshold: float = 0.50
    face_detector_score_threshold: float = 0.60
    face_detector_max_side: int = 640
    yolo_gate_ttl_s: float = 2.0
    unknown_min_face_ratio: float = 0.12
    unknown_large_face_ratio: float = 0.22

    # --- Recording (SegmentRecorder) -------------------------------------
    segment_seconds: int = 600  # ~10 minutes per file
    segment_dir: str = "./segments"
    segment_fourcc: str = "mp4v"
    segment_extension: str = "mp4"

    # --- Alerts (AlertManager / Telegram) --------------------------------
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    alert_cooldown_s: float = 30.0  # min seconds between alerts for same status
    alert_snapshot_dir: str = "./snapshots"
    alert_http_timeout_s: float = 10.0

    # --- Monitor integration --------------------------------------------
    # Optional in development. When either URL or key is absent the client is
    # explicitly disabled and the core capture/recording runtime continues.
    monitor_api_base: Optional[str] = None
    detection_engine_api_key: Optional[str] = None
    monitor_http_timeout_s: float = 5.0

    # --- NAS sync (NASSyncWorker) ----------------------------------------
    # Development must start without production NAS infrastructure. Enabling
    # NAS opts into strict host/user/integrity validation below.
    nas_enabled: bool = False
    nas_method: str = "rsync"  # "rsync" | "scp"
    nas_user: Optional[str] = None
    nas_host: Optional[str] = None
    nas_dest_dir: str = "/volume1/aegis/segments"
    nas_ssh_port: int = 22
    nas_ssh_key: Optional[str] = None  # path to private key, else agent/default
    nas_verify: str = "checksum"  # "checksum" | "size"; unverified success forbidden
    nas_delete_after_sync: bool = True
    nas_max_retries: int = 3
    nas_retry_backoff_s: float = 5.0
    nas_transfer_timeout_s: float = 600.0

    # --- Local API (LocalEventAPI) ---------------------------------------
    api_host: str = "0.0.0.0"
    api_port: int = 8077
    api_metrics_interval_s: float = 1.0  # push cadence for metrics on the WS
    api_recent_events: int = 100

    # --- Live MJPEG stream (StreamHub + LocalEventAPI /stream.mjpg) ------
    # The stream is served by the engine and consumed ONLY by Monitor's backend,
    # which proxies it to the browser. It is authenticated with the same shared
    # service key as /internal/* on Monitor's side (X-Detection-Engine-Key), so
    # there is one secret for the whole engine<->Monitor boundary, not two.
    stream_enabled: bool = True
    stream_jpeg_quality: int = 70   # 1-100; 70 is a sane quality/bandwidth point
    stream_max_fps: float = 12.0    # cap independent of capture fps
    # Advertised to Monitor in each heartbeat so the proxy knows where to pull
    # from. Blank -> derived from api_host/api_port (localhost is rewritten to
    # 127.0.0.1 since 0.0.0.0 is not dialable).
    stream_public_url: Optional[str] = None
    # A cold YOLO+SFace worker can take materially longer than a normal frame
    # interval to load models and publish its first annotated JPEG. Keep this
    # separate from the steady-state idle timeout so startup is patient while
    # an already-running stream still fails fast when frames stop.
    stream_first_frame_timeout_s: int = 45
    # Close a stream that has produced no frames for this long (capture died,
    # camera unplugged). Without it a viewer holds an open socket forever.
    stream_idle_timeout_s: int = 15

    # --- Heartbeat to Monitor (HeartbeatWorker) --------------------------
    # How often to POST /internal/heartbeat. Monitor ages the last row into
    # online -> degraded (>15s) -> lost (>45s), so this must stay well under
    # 15s. 0 or negative disables the worker entirely.
    heartbeat_interval_s: float = 5.0

    # --- Logging ----------------------------------------------------------
    log_level: str = "INFO"
    log_json: bool = False

    @classmethod
    def from_env(cls) -> "EngineConfig":
        """Construct configuration purely from environment variables."""
        return cls(
            node_id=_env_str("AEGIS_NODE_ID", cls.node_id),
            camera_id=_env_str("AEGIS_CAMERA_ID", cls.camera_id),
            camera_label=_env_str("AEGIS_CAMERA_LABEL", cls.camera_label),
            camera_device_name=_env_opt("AEGIS_CAMERA_DEVICE_NAME"),
            camera_source=_env_str("AEGIS_CAMERA_SOURCE", cls.camera_source),
            frame_width=_env_int("AEGIS_FRAME_WIDTH", cls.frame_width),
            frame_height=_env_int("AEGIS_FRAME_HEIGHT", cls.frame_height),
            target_fps=_env_int("AEGIS_TARGET_FPS", cls.target_fps),
            capture_reconnect_delay_s=_env_float(
                "AEGIS_CAPTURE_RECONNECT_DELAY_S", cls.capture_reconnect_delay_s
            ),
            capture_max_reconnect_delay_s=_env_float(
                "AEGIS_CAPTURE_MAX_RECONNECT_DELAY_S",
                cls.capture_max_reconnect_delay_s,
            ),
            capture_on_demand=_env_bool(
                "AEGIS_CAPTURE_ON_DEMAND", cls.capture_on_demand
            ),
            record_queue_size=_env_int("AEGIS_RECORD_QUEUE_SIZE", cls.record_queue_size),
            detect_queue_size=_env_int("AEGIS_DETECT_QUEUE_SIZE", cls.detect_queue_size),
            detect_every_n_frames=_env_int(
                "AEGIS_DETECT_EVERY_N_FRAMES", cls.detect_every_n_frames
            ),
            detect_min_confidence=_env_float(
                "AEGIS_DETECT_MIN_CONFIDENCE", cls.detect_min_confidence
            ),
            recognizer_backend=_env_str(
                "AEGIS_RECOGNIZER_BACKEND", cls.recognizer_backend
            ).strip().lower(),
            admin_model_path=_env_opt("AEGIS_ADMIN_MODEL_PATH"),
            admin_class_name=_env_str(
                "AEGIS_ADMIN_CLASS_NAME", cls.admin_class_name
            ),
            admin_display_name=_env_str(
                "AEGIS_ADMIN_DISPLAY_NAME", cls.admin_display_name
            ),
            admin_min_confidence=_env_float(
                "AEGIS_ADMIN_MIN_CONFIDENCE", cls.admin_min_confidence
            ),
            face_detector_model_path=_env_opt("AEGIS_FACE_DETECTOR_MODEL_PATH"),
            face_recognizer_model_path=_env_opt("AEGIS_FACE_RECOGNIZER_MODEL_PATH"),
            admin_embeddings_path=_env_opt("AEGIS_ADMIN_EMBEDDINGS_PATH"),
            face_match_cosine_threshold=_env_float(
                "AEGIS_FACE_MATCH_COSINE_THRESHOLD",
                cls.face_match_cosine_threshold,
            ),
            face_detector_score_threshold=_env_float(
                "AEGIS_FACE_DETECTOR_SCORE_THRESHOLD",
                cls.face_detector_score_threshold,
            ),
            face_detector_max_side=_env_int(
                "AEGIS_FACE_DETECTOR_MAX_SIDE", cls.face_detector_max_side
            ),
            yolo_gate_ttl_s=_env_float(
                "AEGIS_YOLO_GATE_TTL_S", cls.yolo_gate_ttl_s
            ),
            unknown_min_face_ratio=_env_float(
                "AEGIS_UNKNOWN_MIN_FACE_RATIO", cls.unknown_min_face_ratio
            ),
            unknown_large_face_ratio=_env_float(
                "AEGIS_UNKNOWN_LARGE_FACE_RATIO", cls.unknown_large_face_ratio
            ),
            segment_seconds=_env_int("AEGIS_SEGMENT_SECONDS", cls.segment_seconds),
            segment_dir=_env_str("AEGIS_SEGMENT_DIR", cls.segment_dir),
            segment_fourcc=_env_str("AEGIS_SEGMENT_FOURCC", cls.segment_fourcc),
            segment_extension=_env_str("AEGIS_SEGMENT_EXTENSION", cls.segment_extension),
            telegram_bot_token=_env_opt("AEGIS_TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=_env_opt("AEGIS_TELEGRAM_CHAT_ID"),
            alert_cooldown_s=_env_float("AEGIS_ALERT_COOLDOWN_S", cls.alert_cooldown_s),
            alert_snapshot_dir=_env_str("AEGIS_ALERT_SNAPSHOT_DIR", cls.alert_snapshot_dir),
            alert_http_timeout_s=_env_float(
                "AEGIS_ALERT_HTTP_TIMEOUT_S", cls.alert_http_timeout_s
            ),
            monitor_api_base=_env_opt("AEGIS_MONITOR_API_BASE"),
            detection_engine_api_key=_env_opt("AEGIS_DETECTION_ENGINE_API_KEY"),
            monitor_http_timeout_s=_env_float(
                "AEGIS_MONITOR_HTTP_TIMEOUT_S", cls.monitor_http_timeout_s
            ),
            nas_enabled=_env_bool("AEGIS_NAS_ENABLED", cls.nas_enabled),
            nas_method=_env_str("AEGIS_NAS_METHOD", cls.nas_method),
            nas_user=_env_opt("AEGIS_NAS_USER"),
            nas_host=_env_opt("AEGIS_NAS_HOST"),
            nas_dest_dir=_env_str("AEGIS_NAS_DEST_DIR", cls.nas_dest_dir),
            nas_ssh_port=_env_int("AEGIS_NAS_SSH_PORT", cls.nas_ssh_port),
            nas_ssh_key=_env_opt("AEGIS_NAS_SSH_KEY"),
            nas_verify=_env_str("AEGIS_NAS_VERIFY", cls.nas_verify),
            nas_delete_after_sync=_env_bool(
                "AEGIS_NAS_DELETE_AFTER_SYNC", cls.nas_delete_after_sync
            ),
            nas_max_retries=_env_int("AEGIS_NAS_MAX_RETRIES", cls.nas_max_retries),
            nas_retry_backoff_s=_env_float(
                "AEGIS_NAS_RETRY_BACKOFF_S", cls.nas_retry_backoff_s
            ),
            nas_transfer_timeout_s=_env_float(
                "AEGIS_NAS_TRANSFER_TIMEOUT_S", cls.nas_transfer_timeout_s
            ),
            api_host=_env_str("AEGIS_API_HOST", cls.api_host),
            api_port=_env_int("AEGIS_API_PORT", cls.api_port),
            api_metrics_interval_s=_env_float(
                "AEGIS_API_METRICS_INTERVAL_S", cls.api_metrics_interval_s
            ),
            api_recent_events=_env_int("AEGIS_API_RECENT_EVENTS", cls.api_recent_events),
            stream_enabled=_env_bool("AEGIS_STREAM_ENABLED", cls.stream_enabled),
            stream_jpeg_quality=_env_int("AEGIS_STREAM_JPEG_QUALITY", cls.stream_jpeg_quality),
            stream_max_fps=_env_float("AEGIS_STREAM_MAX_FPS", cls.stream_max_fps),
            stream_public_url=_env_opt("AEGIS_STREAM_PUBLIC_URL"),
            stream_first_frame_timeout_s=_env_int(
                "AEGIS_STREAM_FIRST_FRAME_TIMEOUT_S",
                cls.stream_first_frame_timeout_s,
            ),
            stream_idle_timeout_s=_env_int(
                "AEGIS_STREAM_IDLE_TIMEOUT_S", cls.stream_idle_timeout_s
            ),
            heartbeat_interval_s=_env_float(
                "AEGIS_HEARTBEAT_INTERVAL_S", cls.heartbeat_interval_s
            ),
            log_level=_env_str("AEGIS_LOG_LEVEL", cls.log_level).upper(),
            log_json=_env_bool("AEGIS_LOG_JSON", cls.log_json),
        )

    def validate(self) -> "EngineConfig":
        """Fail fast on nonsensical configuration. Returns self for chaining."""
        if self.target_fps <= 0:
            raise ValueError("AEGIS_TARGET_FPS must be > 0")
        if self.segment_seconds <= 0:
            raise ValueError("AEGIS_SEGMENT_SECONDS must be > 0")
        if self.detect_every_n_frames <= 0:
            raise ValueError("AEGIS_DETECT_EVERY_N_FRAMES must be > 0")
        if not 0 < self.detect_min_confidence <= 100:
            raise ValueError("AEGIS_DETECT_MIN_CONFIDENCE must be between 0 and 100")
        if self.recognizer_backend not in {"placeholder", "yolo-sface-admin"}:
            raise ValueError(
                "AEGIS_RECOGNIZER_BACKEND must be placeholder or "
                "yolo-sface-admin; yolo-admin alone cannot prove identity"
            )
        if self.recognizer_backend == "yolo-sface-admin":
            if not self.admin_model_path:
                raise ValueError(
                    "AEGIS_ADMIN_MODEL_PATH is required when "
                    "AEGIS_RECOGNIZER_BACKEND=yolo-sface-admin"
                )
            required_identity_paths = {
                "AEGIS_FACE_DETECTOR_MODEL_PATH": self.face_detector_model_path,
                "AEGIS_FACE_RECOGNIZER_MODEL_PATH": self.face_recognizer_model_path,
                "AEGIS_ADMIN_EMBEDDINGS_PATH": self.admin_embeddings_path,
            }
            missing = [name for name, value in required_identity_paths.items() if not value]
            if missing:
                raise ValueError(
                    "Identity verification requires: " + ", ".join(missing)
                )
            if not self.admin_class_name.strip() or not self.admin_display_name.strip():
                raise ValueError(
                    "AEGIS_ADMIN_CLASS_NAME and AEGIS_ADMIN_DISPLAY_NAME must not be empty"
                )
            if not 0 < self.admin_min_confidence <= 100:
                raise ValueError(
                    "AEGIS_ADMIN_MIN_CONFIDENCE must be between 0 and 100"
                )
            if not 0 < self.face_match_cosine_threshold <= 1:
                raise ValueError(
                    "AEGIS_FACE_MATCH_COSINE_THRESHOLD must be between 0 and 1"
                )
            if not 0 < self.face_detector_score_threshold <= 1:
                raise ValueError(
                    "AEGIS_FACE_DETECTOR_SCORE_THRESHOLD must be between 0 and 1"
                )
            if self.face_detector_max_side < 320:
                raise ValueError("AEGIS_FACE_DETECTOR_MAX_SIDE must be >= 320")
            if not 0 <= self.yolo_gate_ttl_s <= 10:
                raise ValueError("AEGIS_YOLO_GATE_TTL_S must be between 0 and 10")
            if not (
                0 < self.unknown_min_face_ratio
                <= self.unknown_large_face_ratio
                <= 1
            ):
                raise ValueError(
                    "AEGIS_UNKNOWN face ratios must satisfy 0 < min <= large <= 1"
                )
        if self.record_queue_size <= 0 or self.detect_queue_size <= 0:
            raise ValueError("AEGIS_RECORD_QUEUE_SIZE and AEGIS_DETECT_QUEUE_SIZE must be > 0")
        if self.nas_enabled:
            if self.nas_method not in {"rsync", "scp"}:
                raise ValueError("AEGIS_NAS_METHOD must be 'rsync' or 'scp' when NAS is enabled")
            if self.nas_verify not in {"checksum", "size"}:
                raise ValueError(
                    "AEGIS_NAS_VERIFY must be 'checksum' or 'size' when NAS is enabled; "
                    "unverified transfers cannot be reported as successful"
                )
            if not self.nas_host or not self.nas_user:
                raise ValueError(
                    "NAS sync is enabled but AEGIS_NAS_HOST / AEGIS_NAS_USER are unset"
                )
            if self.nas_max_retries <= 0:
                raise ValueError("AEGIS_NAS_MAX_RETRIES must be > 0 when NAS is enabled")
        if not (1 <= self.stream_jpeg_quality <= 100):
            raise ValueError("AEGIS_STREAM_JPEG_QUALITY must be between 1 and 100")
        if self.capture_on_demand and not self.stream_enabled:
            raise ValueError(
                "AEGIS_CAPTURE_ON_DEMAND requires AEGIS_STREAM_ENABLED=true"
            )
        if self.capture_on_demand and not self.detection_engine_api_key:
            raise ValueError(
                "AEGIS_CAPTURE_ON_DEMAND requires AEGIS_DETECTION_ENGINE_API_KEY; "
                "an unauthenticated viewer must never activate the camera"
            )
        if self.stream_first_frame_timeout_s <= 0:
            raise ValueError("AEGIS_STREAM_FIRST_FRAME_TIMEOUT_S must be > 0")
        if self.stream_idle_timeout_s <= 0:
            raise ValueError("AEGIS_STREAM_IDLE_TIMEOUT_S must be > 0")
        return self

    def resolved_stream_url(self) -> Optional[str]:
        """Absolute URL Monitor's proxy should pull MJPEG from, or None if disabled.

        ``api_host`` is a *bind* address; 0.0.0.0 (and ::) mean "all interfaces"
        and cannot be dialled, so they are rewritten to a loopback address. Set
        AEGIS_STREAM_PUBLIC_URL explicitly when Monitor lives on another host.
        """
        if not self.stream_enabled:
            return None
        if self.stream_public_url:
            return self.stream_public_url.rstrip("/")
        host = self.api_host
        if host in ("0.0.0.0", "::", ""):
            host = "127.0.0.1"
        return f"http://{host}:{self.api_port}/stream.mjpg"

    def redacted(self) -> dict:
        """Config as a dict with secrets masked — safe to log at startup."""
        out = {}
        secret = {"telegram_bot_token", "detection_engine_api_key", "nas_ssh_key"}
        for f in fields(self):
            val = getattr(self, f.name)
            if f.name in secret and val:
                val = "***set***"
            elif (
                f.name in {"camera_source", "monitor_api_base", "stream_public_url"}
                and val
            ):
                val = _redact_url_credentials(str(val))
            elif f.name in {
                "admin_model_path",
                "face_detector_model_path",
                "face_recognizer_model_path",
                "admin_embeddings_path",
            } and val:
                # Logs need the selected filename, not a user's absolute path.
                val = os.path.basename(str(val))
            out[f.name] = val
        return out
