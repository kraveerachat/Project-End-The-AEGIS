"""
AEGIS IDEA 3 — Communications
- Telegram: แจ้งเตือน LOCKDOWN/RESTORED (สองภาษา) + เหตุการณ์ปฏิบัติการ (ops)
- UFW: บล็อก IP ผู้โจมตีผ่าน pkexec
หมายเหตุ: โมดูลนี้ import แค่ config เท่านั้น เพื่อไม่ให้เกิด circular import
"""
import json
import subprocess
import threading
import time
import urllib.request

from . import config

# Delivery bounds. A cellular tether answered in ~1.7 s in the lab, so the old 3 s limit left almost no margin and one
# RESTORED notification was lost. The send runs off the safety-critical path, so a longer bound costs nothing there.
TELEGRAM_TIMEOUT_SEC = 10
TELEGRAM_ATTEMPTS = 2
TELEGRAM_RETRY_DELAY_SEC = 1.0


def _post_telegram(text):
    url = f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = json.dumps({"chat_id": config.TELEGRAM_CHAT_ID, "text": text,
                          "parse_mode": "Markdown"}).encode("utf-8")
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    urllib.request.urlopen(req, timeout=TELEGRAM_TIMEOUT_SEC)


def _failure_reason(error):
    """A secret-free reason token: the exception type, plus the HTTP status for an HTTP error. Never the message text,
    which can carry the bot URL (and so the token) or the chat id."""
    status = getattr(error, "code", None)
    if isinstance(status, int):
        return f"{type(error).__name__} status={status}"
    reason = getattr(error, "reason", None)
    if isinstance(reason, BaseException):
        return f"{type(error).__name__}/{type(reason).__name__}"
    return type(error).__name__


def _deliver(text):
    """At most TELEGRAM_ATTEMPTS sends. A rejected message (HTTP 4xx) is not retried: it would fail the same way."""
    for attempt in range(1, TELEGRAM_ATTEMPTS + 1):
        try:
            _post_telegram(text)
            return True
        except Exception as error:  # delivery is best effort and must never raise into the caller
            reason = _failure_reason(error)
            status = getattr(error, "code", None)
            final = attempt == TELEGRAM_ATTEMPTS or (isinstance(status, int) and 400 <= status < 500)
            print(f"Telegram notification delivery failed (attempt {attempt}/{TELEGRAM_ATTEMPTS}, {reason})"
                  + ("" if final else "; retrying"))
            if final:
                return False
            time.sleep(TELEGRAM_RETRY_DELAY_SEC)
    return False


def _dispatch_telegram(text):
    """Send outside the caller's safety-critical path without leaking secrets."""
    def _send():
        _deliver(text)

    try:
        threading.Thread(target=_send, daemon=True).start()
    except Exception:
        print("Telegram notification delivery failed")


def send_webhook_alert(state, reason, rssi=None, heap=None, attacker_ip=None):
    """แจ้งเตือนหลักเมื่อ Uplink ถูกตัด/คืนค่า"""
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        return
    try:
        is_lockdown = (state == "LOCKDOWN")
        ts_str = time.strftime('%d %b %Y, %H:%M:%S')
        lines = [
            "🛡️ *AEGIS IDEA 3 — SECURITY OPERATIONS CENTER*",
            "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬",
            "🔴 *UPLINK LOCKDOWN TRIGGERED*" if is_lockdown else "🟢 *UPLINK RESTORED*",
            "_ระบบตัดการเชื่อมต่อ Uplink แล้ว_" if is_lockdown else "_ระบบเชื่อมต่อ Uplink กลับสู่ปกติแล้ว_",
            "",
            "*Reason / เหตุผล:*",
            f"`{reason}`",
            "",
            f"🕐 {ts_str}",
        ]
        if rssi is not None and heap is not None:
            lines.append(f"📶 RSSI: `{rssi} dBm`   💾 Heap: `{heap} B`")
        if is_lockdown and attacker_ip:
            lines.append(f"🎯 *Attacker IP:* `{attacker_ip}`")
        lines.append("")
        if is_lockdown:
            lines.append("⚠️ *EN:* Physical uplink cut. Admin action required via Management VLAN.")
            lines.append("⚠️ *TH:* ตัดสาย Uplink ทางกายภาพแล้ว กรุณาเข้าผ่าน Management VLAN เพื่อตรวจสอบและกู้คืน")
        else:
            lines.append("✅ *EN:* System back online and operating normally.")
            lines.append("✅ *TH:* ระบบกลับมาออนไลน์และทำงานปกติแล้ว")
        _dispatch_telegram("\n".join(lines))
    except Exception:
        print("Telegram notification delivery failed")


_OPS_LABELS = {
    "SECURITY_ALERT": ("🚨 SECURITY ALERT", "แจ้งเตือนความปลอดภัย (พยายามใช้งานโดยไม่ได้รับอนุญาต)"),
    "UFW_BLOCK": ("🧱 UFW CONTAINMENT", "การบล็อก IP ด้วย UFW"),
    "RECOVERY_STEP": ("🧯 RECOVERY PROGRESS", "ความคืบหน้าการกู้คืนระบบ"),
    "INCIDENT_CLOSED": ("✅ INCIDENT CLOSED", "ปิดเหตุการณ์ (บันทึกบทเรียนแล้ว)"),
}


def send_ops_alert(event_type, details):
    """แจ้งเหตุการณ์ปฏิบัติการเข้า Telegram (ยิงใน background thread)"""
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        return
    if event_type not in _OPS_LABELS:
        return

    title_en, title_th = _OPS_LABELS[event_type]
    ts_str = time.strftime('%d %b %Y, %H:%M:%S')
    _dispatch_telegram(f"🛡️ *AEGIS IDEA 3 — SOC*\n{title_en}\n_{title_th}_\n\n"
                       f"`{details}`\n\n🕐 {ts_str}")


# -- IDEA3 graduated response notifications (notification only; Telegram never carries CUT/RESTORE authority) -------------
_SEVERITY_ICON = {"MEDIUM": "🟡", "HIGH": "🟠", "CRITICAL": "🔴"}
_ACTION_KEY = {
    "SOFTWARE_BLOCK": "tg.action.software_block",
    "RECOMMEND_CUT": "tg.action.recommend_cut",
    "AUTO_CUT": "tg.action.auto_cut",
}
_OUTCOME_KEY = {
    "BLOCKED": "tg.outcome.blocked",
    "BLOCK_FAILED": "tg.outcome.block_failed",
    "CUT_SENT": "tg.outcome.cut_sent",
    "CUT_REFUSED": "tg.outcome.cut_refused",
    "CUT_QUEUED": "tg.outcome.cut_queued",
    "CUT_DISARMED": "tg.outcome.cut_disarmed",
    "DRY_RUN": "tg.outcome.dry_run",
    "RECOMMENDED": "tg.outcome.recommended",
}


def _safe_token(value, limit=64):
    """Telegram Markdown is fragile: only allow characters that cannot open or close an entity."""
    text = str(value)[:limit]
    return "".join(ch for ch in text if ch.isalnum() or ch in ".:+-_/ ,")


def format_severity_alert(*, level, action, outcome, address, score, reasons, mitre, language):
    """Build the localized message. Pure (no network), so tests can pin the exact text per language."""
    from . import i18n

    lang = language if language in i18n.LANGUAGES else i18n.DEFAULT_LANGUAGE

    def t(key, **kwargs):
        return i18n.translate_in(lang, key, **kwargs)

    icon = _SEVERITY_ICON.get(level, "⚪")
    lines = [
        f"🛡️ *{t('tg.title')}*",
        f"{icon} *{t('tg.level.' + level.lower())}* · `{_safe_token(level)}`",
        "",
        f"{t('tg.label.attacker')}: `{_safe_token(address)}`",
        f"{t('tg.label.score')}: `{int(score)}`",
        f"{t('tg.label.evidence')}: `{_safe_token(', '.join(reasons), 160)}`",
    ]
    if mitre:
        lines.append(f"MITRE ATT&CK: `{_safe_token(', '.join(mitre))}`")
    lines.append("")
    action_key = _ACTION_KEY.get(action)
    if action_key:
        lines.append(f"{t('tg.label.response')}: {t(action_key)}")
    outcome_key = _OUTCOME_KEY.get(outcome)
    if outcome_key:
        lines.append(f"{t('tg.label.result')}: {t(outcome_key)}")
    lines.append("")
    lines.append(f"ℹ️ {t('tg.footer.console_only')}")
    lines.append(f"🕐 {time.strftime('%d %b %Y, %H:%M:%S')}")
    return "\n".join(lines)


def send_severity_alert(**fields):
    """Fire-and-forget localized severity notification. Silent when Telegram is not configured."""
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        return
    try:
        _dispatch_telegram(format_severity_alert(language=config.TELEGRAM_LANGUAGE, **fields))
    except Exception:
        print("Telegram notification delivery failed")


def ufw_exec(args, timeout=30):
    """เรียก ufw ผ่าน pkexec — คืน (success: bool, output: str)"""
    try:
        result = subprocess.run(["pkexec", "ufw"] + args, capture_output=True,
                                text=True, timeout=timeout, check=False)
        ok = (result.returncode == 0)
        out = ((result.stdout or "") + (result.stderr or "")).strip()
        return ok, out
    except FileNotFoundError:
        return False, "ไม่พบ pkexec หรือ ufw บนระบบนี้"
    except subprocess.TimeoutExpired:
        return False, "หมดเวลารอการยืนยันตัวตน (ไม่กดยืนยัน popup ทันเวลา)"
    except Exception as e:
        return False, str(e)


def send_telegram_reply(text):
    """ส่งข้อความกลับไป Telegram (ใช้ตอบคำสั่งสองทาง)"""
    if not config.TELEGRAM_BOT_TOKEN or not config.TELEGRAM_CHAT_ID:
        return
    try:
        _post_telegram(text)
    except Exception:
        print("[TG] reply delivery failed")
