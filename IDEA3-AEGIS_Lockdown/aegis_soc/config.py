"""
AEGIS IDEA 3 — Configuration
รวมค่าตั้งทั้งหมดไว้ที่เดียว อ่านจาก environment variable ก่อน (กัน secret หลุดขึ้น GitHub)
"""
import hashlib
import os
import sys

from .paths import RuntimePaths, configuration_path, load_dotenv


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

_RUNTIME_PATHS = (
    RuntimePaths.from_environment()
    if os.getenv("AEGIS_DATA_DIR", "").strip() or sys.platform == "win32"
    else None
)

# ---- MQTT Broker ----
_DEFAULT_BROKER_IP = "192.168.2.174"
_DEFAULT_BROKER_PORT = 1883
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
            "AEGIS_BROKER_PORT is not an integer; using default port 1883"
        )


PORT, _BROKER_PORT_WARNING = _broker_port(os.getenv("AEGIS_BROKER_PORT"))

# ---- Secrets (ตั้งผ่าน environment variable) ----
# ต้องตรงกับ HMAC_SECRET ใน src/main.cpp ของ ESP32 เสมอ
DEMO_SECRET = b"AEGIS-DEMO-SHARED-SECRET-change-me"
DEFAULT_ADMIN_PIN = "1234"
SECRET_KEY = os.getenv("AEGIS_HMAC_SECRET", DEMO_SECRET.decode("utf-8")).encode("utf-8")
_ADMIN_PIN = os.getenv("AEGIS_ADMIN_PIN", DEFAULT_ADMIN_PIN)
ADMIN_PIN_CONFIGURED = bool(_ADMIN_PIN)
# เก็บ PIN เป็น hash ไม่เก็บ plaintext
ADMIN_PIN_HASH = hashlib.sha256(_ADMIN_PIN.encode("utf-8")).hexdigest()
MAX_PIN_ATTEMPTS = int(os.getenv("AEGIS_MAX_PIN_ATTEMPTS", "5"))

TELEGRAM_BOT_TOKEN = os.getenv("AEGIS_TG_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("AEGIS_TG_CHAT", "")

# ---- MQTT Topics ----
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
MQTT_PASS = os.getenv("AEGIS_MQTT_PASS", "")

# ---- Runtime safety ----
# Existing standalone GUI behavior remains live unless explicitly placed in dry-run.
# Autonomous profiles override this conservatively in the supervisor layer.
DRY_RUN = _env_bool("AEGIS_DRY_RUN", False)
AUTO_CONTAIN = _env_bool("AEGIS_AUTO_CONTAIN", False)


def validate_config():
    """ตรวจค่าตั้งตอนเริ่มโปรแกรม — คืน list ของคำเตือน (ไม่ถึงกับ error แต่ควรรู้)"""
    warnings = []
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        warnings.append("ยังไม่ได้ตั้ง AEGIS_TG_TOKEN / AEGIS_TG_CHAT — ระบบจะไม่ส่งแจ้งเตือน Telegram")
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
