"""
AEGIS IDEA 3 — Configuration
รวมค่าตั้งทั้งหมดไว้ที่เดียว อ่านจาก environment variable ก่อน (กัน secret หลุดขึ้น GitHub)
"""
import hashlib
import os


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


def _load_dotenv(path=".env"):
    """โหลดค่าจากไฟล์ .env เข้า environment ก่อนอ่านค่าทั้งหมด"""
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as e:
        print(f"[.env] อ่านไฟล์ไม่สำเร็จ: {e}")


_load_dotenv()      # ← บรรทัดนี้สำคัญสุด: เรียกใช้ก่อนอ่านค่า

# ---- MQTT Broker ----
BROKER_IP = os.getenv("AEGIS_BROKER_IP", "192.168.2.174")
try:
    PORT = int(os.getenv("AEGIS_BROKER_PORT", "1883"))
except ValueError:
    PORT = 1883
    print("[config] AEGIS_BROKER_PORT ไม่ใช่ตัวเลข — ใช้ค่า default 1883")

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
DB_PATH = os.getenv("AEGIS_DB_PATH", "aegis_audit.db")
LOG_PATH = os.getenv("AEGIS_LOG_PATH", "aegis_soc.log")
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

    # ตรวจรูปแบบ broker IP
    import ipaddress
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
