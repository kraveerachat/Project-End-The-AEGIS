"""
AEGIS IDEA 3 — Configuration
รวมค่าตั้งทั้งหมดไว้ที่เดียว อ่านจาก environment variable ก่อน (กัน secret หลุดขึ้น GitHub)
"""
import hashlib
import os
import sys

from .paths import RuntimePaths, configuration_path, load_dotenv
from .systemd_credentials import credential_path, read_text_credential


def _env_bool(name, default=False):
    """Parse a boolean environment value without silently accepting typos."""
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be one of: 1/0, true/false, yes/no, on/off")


load_dotenv(configuration_path())

_SYSTEMD_CREDENTIALS_DIRECTORY = os.getenv("CREDENTIALS_DIRECTORY", "").strip()

_RUNTIME_PATHS = (
    RuntimePaths.from_environment()
    if os.getenv("AEGIS_DATA_DIR", "").strip() or sys.platform == "win32"
    else None
)

# ---- MQTT Broker ----
_DEFAULT_BROKER_IP = "192.168.2.174"
_DEFAULT_BROKER_PORT = 8883  # TLS-only MQTT (PR11 Phase 4)
_broker_ip = os.getenv("AEGIS_BROKER_IP")
BROKER_IP = _DEFAULT_BROKER_IP if _broker_ip is None else _broker_ip.strip()
BROKER_CONFIGURED = bool(BROKER_IP)


def _broker_port(value: str | None) -> tuple[int, str | None]:
    """Parse an optional broker port without emitting import-time console text."""
    candidate = "" if value is None else value.strip()
    if not candidate:
        return _DEFAULT_BROKER_PORT, None
    try:
        return int(candidate), None
    except ValueError:
        return _DEFAULT_BROKER_PORT, (
            f"AEGIS_BROKER_PORT is not an integer; using default port {_DEFAULT_BROKER_PORT}"
        )


PORT, _BROKER_PORT_WARNING = _broker_port(os.getenv("AEGIS_BROKER_PORT"))

# ---- Secrets (ตั้งผ่าน environment variable) ----
# ต้องตรงกับ HMAC_SECRET ใน src/main.cpp ของ ESP32 เสมอ
DEMO_SECRET = b"AEGIS-DEMO-SHARED-SECRET-change-me"
DEFAULT_ADMIN_PIN = "1234"
SECRET_KEY = os.getenv("AEGIS_HMAC_SECRET", DEMO_SECRET.decode("utf-8")).encode("utf-8")
if _SYSTEMD_CREDENTIALS_DIRECTORY:
    _ADMIN_PIN = read_text_credential("admin.pin")
else:
    _ADMIN_PIN = os.getenv("AEGIS_ADMIN_PIN", DEFAULT_ADMIN_PIN)
ADMIN_PIN_CONFIGURED = bool(_ADMIN_PIN)
# เก็บ PIN เป็น hash ไม่เก็บ plaintext
ADMIN_PIN_HASH = hashlib.sha256(_ADMIN_PIN.encode("utf-8")).hexdigest()
MAX_PIN_ATTEMPTS = int(os.getenv("AEGIS_MAX_PIN_ATTEMPTS", "5"))

TELEGRAM_BOT_TOKEN = os.getenv("AEGIS_TG_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("AEGIS_TG_CHAT", "")

# ---- Protocol v1 (PR11 Phase 4) ----
# v1 is the default everywhere. The legacy v0 wire format is reachable only
# through this explicit lab opt-in, which production preflight refuses.
PROTOCOL_MODE_V1 = "v1"
PROTOCOL_MODE_LEGACY_LAB = "legacy-v0-lab"
PROTOCOL_MODE = os.getenv("AEGIS_PROTOCOL_MODE", PROTOCOL_MODE_V1).strip() or PROTOCOL_MODE_V1
P1_DEVICE_ID = os.getenv("AEGIS_P1_DEVICE_ID", "").strip()
if _SYSTEMD_CREDENTIALS_DIRECTORY:
    P1_C2D_KEY_FILE = str(credential_path("k_c2d"))
    P1_D2C_KEY_FILE = str(credential_path("k_d2c"))
else:
    P1_C2D_KEY_FILE = os.getenv("AEGIS_P1_C2D_KEY_FILE", "").strip()
    P1_D2C_KEY_FILE = os.getenv("AEGIS_P1_D2C_KEY_FILE", "").strip()
CORE_PROTOCOL_DB_PATH = os.getenv("AEGIS_CORE_PROTOCOL_DB_PATH", "").strip()
RESTORE_CREDENTIAL_FILE = os.getenv("AEGIS_RESTORE_CREDENTIAL_FILE", "").strip()

# ---- MQTT Topics (legacy v0 lab mode only; v1 topics come from protocol_v1) ----
TOPIC_CMD = "aegis/lockdown/cmd"
TOPIC_ACK = "aegis/lockdown/ack"
TOPIC_HEARTBEAT = "aegis/heartbeat"
TOPIC_STATUS = "aegis/status"
TOPIC_ATTACKER_IP = "aegis/attacker_ip"

# ---- Timing (วินาที) ----
HEARTBEAT_INTERVAL_SEC = 15
DEADMAN_TIMEOUT_SEC = 60          # ต้องตรงกับ DEADMAN_TIMEOUT_MS ใน src/main.cpp
ACK_TIMEOUT_SEC = 8               # ส่งคำสั่งแล้วรอ ACK ภายในกี่วินาที ก่อนเตือน
PHYSICAL_CONFIRM_TIMEOUT_SEC = 8  # ACK แล้วรอสถานะทางกายภาพที่คาดไว้
DEVICE_OFFLINE_SEC = 45           # ไม่ได้รับข้อความจาก ESP32 นานเกินนี้ = ถือว่าออฟไลน์

# ---- Files ----
DB_PATH = os.getenv(
    "AEGIS_DB_PATH",
    str(_RUNTIME_PATHS.core_db) if _RUNTIME_PATHS else "aegis_audit.db",
)
LOG_PATH = os.getenv(
    "AEGIS_LOG_PATH",
    str(_RUNTIME_PATHS.log_dir / "aegis_soc.log") if _RUNTIME_PATHS else "aegis_soc.log",
)
SOUND_LOCKDOWN = os.getenv("AEGIS_SOUND_LOCKDOWN", "detect.wav")       # เสียงตอนตัด
SOUND_RESTORE = os.getenv("AEGIS_SOUND_RESTORE", "connect.wav")        # เสียงตอนคืน
MQTT_USER = os.getenv("AEGIS_MQTT_USER", "")
if _SYSTEMD_CREDENTIALS_DIRECTORY:
    MQTT_PASS = read_text_credential("mqtt-core.pass")
else:
    MQTT_PASS = os.getenv("AEGIS_MQTT_PASS", "")
# TLS is on unless explicitly disabled; production preflight refuses disabling it.
MQTT_TLS = _env_bool("AEGIS_MQTT_TLS", True)
MQTT_CA_FILE = os.getenv("AEGIS_MQTT_CA_FILE", "").strip()
# DNS name the broker certificate is verified against when it differs from the connect address. The L6 broker certificate
# profile is DNS-only (no IP SAN) while the Core connects to the broker IP; empty keeps verification against the connect host.
MQTT_TLS_SERVER_NAME = os.getenv("AEGIS_MQTT_TLS_SERVER_NAME", "").strip()
MQTT_CLIENT_ID = "idea3-core"  # fixed Core broker identity; ESP32 identities are idea3-dev-<device_id>

# ---- Runtime safety ----
# Existing standalone GUI behavior remains live unless explicitly placed in dry-run.
# Autonomous profiles override this conservatively in the supervisor layer.
DRY_RUN = _env_bool("AEGIS_DRY_RUN", False)
AUTO_CONTAIN = _env_bool("AEGIS_AUTO_CONTAIN", False)

# ---- Core-mediated Recovery (R1-R8) ----
# Probe targets are non-secret and unset means NOT_CONFIGURED, never a passing check. The Core runs the probes;
# no desktop process supplies or executes them.
RECOVERY_MANAGEMENT_PROBE_TARGET = os.getenv("AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET", "").strip()
RECOVERY_NETWORK_PROBE_TARGETS = os.getenv("AEGIS_RECOVERY_NETWORK_PROBE_TARGETS", "").strip()
RECOVERY_WEB_READINESS_URL = os.getenv("AEGIS_RECOVERY_WEB_READINESS_URL", "").strip()


def _optional_int(name):
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


# The Recovery AF_UNIX server starts only when an operator uid is configured (production profile only); unset or
# invalid keeps it disabled. The socket group is optional and only widens the file mode to 0660 for that group;
# the SO_PEERCRED uid check remains the authority.
RECOVERY_OPERATOR_UID = _optional_int("AEGIS_RECOVERY_OPERATOR_UID")
RECOVERY_SOCKET_GID = _optional_int("AEGIS_RECOVERY_SOCKET_GID")
RECOVERY_SOCKET = os.getenv("AEGIS_RECOVERY_SOCKET", "").strip()

# F1: the Core-local production alert ingress (R1 source). One numeric uid (the account running the detector) may submit
# an IPv4 attacker candidate over the dedicated F1 socket below. Unset or invalid keeps the channel disabled (fail closed).
ALERT_SOURCE_UID = _optional_int("AEGIS_ALERT_SOURCE_UID")
# R1D: the historical-incident disposition channel is INERT by default: it exists only when this flag is exactly YES (and the
# profile is production, a detector authority is configured and no disposition has ever been recorded). The peer must be uid 0.
R1D_DISPOSITION_ENABLED = os.getenv("AEGIS_R1D_DISPOSITION_ENABLED", "")
# Manual CUT channel for the Python Desktop: INERT unless exactly YES. CUT only; it carries no RESTORE authority.
LOCAL_CUT_ENABLED = os.getenv("AEGIS_LOCAL_CUT_ENABLED", "")
# It additionally needs a dedicated absolute socket path (pre-provisioned, Core-owned directory), ONE operator uid (never 0) and an
# optional transport gid. Any of them missing keeps the channel disabled (fail closed).
LOCAL_CUT_SOCKET = os.getenv("AEGIS_LOCAL_CUT_SOCKET", "").strip()
LOCAL_CUT_OPERATOR_UID = _optional_int("AEGIS_LOCAL_CUT_OPERATOR_UID")
LOCAL_CUT_SOCKET_GID = _optional_int("AEGIS_LOCAL_CUT_SOCKET_GID")
# Core-held CUT credential (scrypt, mode 0600, Core-owned). A separate policy domain from the D4 RESTORE credential: it must be a
# different file and a different hash. There is deliberately no default and no inline value; unset keeps the channel disabled.
LOCAL_CUT_CREDENTIAL_FILE = os.getenv("AEGIS_LOCAL_CUT_CREDENTIAL_FILE", "").strip()
# OD-F1-DEPLOY-01: the dedicated F1 alert transport. Constants on purpose (no environment override): the general runtime
# directory and the Recovery runtime are never an alert path. The group is filesystem reachability only; the uid is the authority.
ALERT_RUNTIME_DIR = "/run/aegis-idea3-alert"
ALERT_SOCKET_PATH = ALERT_RUNTIME_DIR + "/alert.sock"
ALERT_GROUP = "aegis-idea3-alert"


def validate_config():
    """ตรวจค่าตั้งตอนเริ่มโปรแกรม — คืน list ของคำเตือน (ไม่ถึงกับ error แต่ควรรู้)"""
    warnings = []
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        warnings.append("ยังไม่ได้ตั้ง AEGIS_TG_TOKEN / AEGIS_TG_CHAT — ระบบจะไม่ส่งแจ้งเตือน Telegram")
    # The shared legacy secret matters only in legacy lab mode; Protocol v1 uses
    # per-device key files that runtime preflight validates.
    if PROTOCOL_MODE == PROTOCOL_MODE_LEGACY_LAB:
        if SECRET_KEY == DEMO_SECRET:
            warnings.append("ใช้ HMAC secret ค่า default — ควรตั้ง AEGIS_HMAC_SECRET ให้ตรงกับ ESP32 ก่อนใช้งานจริง")
        elif not SECRET_KEY:
            warnings.append("ยังไม่ได้ตั้ง AEGIS_HMAC_SECRET")
    if _ADMIN_PIN == DEFAULT_ADMIN_PIN:
        warnings.append("ใช้ Admin PIN ค่า default (1234) — ควรตั้ง AEGIS_ADMIN_PIN ก่อนใช้งานจริง")
    elif not ADMIN_PIN_CONFIGURED:
        warnings.append("ยังไม่ได้ตั้ง AEGIS_ADMIN_PIN")
    if not AUTO_CONTAIN:
        warnings.append("AEGIS_AUTO_CONTAIN ปิดอยู่ — detector จะรายงานเหตุการณ์แต่ไม่ตัด uplink อัตโนมัติ")
    if DRY_RUN:
        warnings.append("AEGIS_DRY_RUN เปิดอยู่ — คำสั่ง relay จะถูกบันทึกเป็น WOULD_SEND และไม่ publish")

    if _BROKER_PORT_WARNING:
        warnings.append(_BROKER_PORT_WARNING)
    if not BROKER_CONFIGURED:
        warnings.append("MQTT broker is not configured; MQTT actuation is unavailable")

    # ตรวจรูปแบบ broker IP
    import ipaddress
    if BROKER_CONFIGURED:
        try:
            ipaddress.ip_address(BROKER_IP)
        except ValueError:
            if BROKER_IP not in ("localhost",):
                warnings.append(f"AEGIS_BROKER_IP '{BROKER_IP}' ไม่ใช่ IP ที่ถูกต้อง")

    # ตรวจ port อยู่ในช่วงที่ใช้ได้
    if not (1 <= PORT <= 65535):
        warnings.append(f"AEGIS_BROKER_PORT {PORT} อยู่นอกช่วง 1-65535")

    return warnings


def verify_pin(entered_pin: str) -> bool:
    """ตรวจ PIN โดยเทียบกับ hash (ไม่มี plaintext ในหน่วยความจำ)"""
    if entered_pin is None:
        return False
    return hashlib.sha256(entered_pin.encode("utf-8")).hexdigest() == ADMIN_PIN_HASH
