"""
AEGIS IDEA 3 — UI localization (pure, no tkinter dependency).

Centralizes every static UI-chrome string (window title, brand text,
navigation labels, Overview cards, section titles, buttons, dialogs, empty
states, footer text, and the visible parts of the Incident Recovery Wizard)
behind one translate() lookup, instead of scattering literals across
gui.py/wizard.py.

Scope boundary (deliberate, not an oversight):
  - Localized: static UI chrome as listed above.
  - NOT localized: the dynamic operational log lines passed to
    AegisAdminGUI.log_message()/IncidentRecoveryWizard._log(), and every
    argument passed to database.log_event(). Those are already English
    literals in the pre-existing audit-log call sites (e.g. "System ARMED"),
    kept as a single stable-language record for forensic consistency;
    retrofitting per-language audit text is a materially different, riskier
    change than localizing UI chrome and is out of scope for this pass.
  - The literal confirmation word "CONFIRM" typed into the CUT_UPLINK dialog
    is never translated: it is compared verbatim in code
    (aegis_soc/gui.py::on_cut_clicked), and localizing it would silently
    change what an operator must type to authorize a destructive action.

This module has no tkinter import so it can be unit-tested without a
display or a tkinter installation, exactly like presentation.py.
"""
import json
import os

from . import config

LANGUAGE_EN = "en"
LANGUAGE_TH = "th"
LANGUAGE_ZH = "zh"
LANGUAGES = (LANGUAGE_EN, LANGUAGE_TH, LANGUAGE_ZH)

LANGUAGE_NATIVE_NAMES = {
    LANGUAGE_EN: "English",
    LANGUAGE_TH: "ไทย",
    LANGUAGE_ZH: "中文",
}

DEFAULT_LANGUAGE = LANGUAGE_EN

# ---------------------------------------------------------------------------
# String table
# ---------------------------------------------------------------------------
STRINGS = {
    # --- App shell / brand ---
    "app.title": {
        "en": "AEGIS IDEA 3 — Security Operations Console",
        "th": "AEGIS IDEA 3 — ศูนย์ปฏิบัติการความปลอดภัย",
        "zh": "AEGIS IDEA 3 — 安全运营控制台",
    },
    "brand.name": {"en": "AEGIS / IDEA3", "th": "AEGIS / IDEA3", "zh": "AEGIS / IDEA3"},
    "brand.subtitle": {
        "en": "Security Operations Console",
        "th": "ศูนย์ปฏิบัติการความปลอดภัย",
        "zh": "安全运营控制台",
    },
    "language.label": {"en": "Language", "th": "ภาษา", "zh": "语言"},

    # --- Navigation ---
    "nav.overview": {"en": "Overview", "th": "ภาพรวม", "zh": "概览"},
    "nav.incidents": {"en": "Incidents", "th": "เหตุการณ์", "zh": "事件"},
    "nav.devices": {"en": "Devices", "th": "อุปกรณ์", "zh": "设备"},
    "nav.lockdown": {"en": "Lockdown", "th": "ล็อกดาวน์", "zh": "锁定"},
    "nav.recovery": {"en": "Recovery", "th": "การกู้คืน", "zh": "恢复"},
    "nav.audit": {"en": "Audit Log", "th": "บันทึกการตรวจสอบ", "zh": "审计日志"},
    "nav.diagnostics": {"en": "Diagnostics", "th": "การวินิจฉัย", "zh": "诊断"},
    "nav.soon_suffix": {"en": "  · soon", "th": "  · เร็วๆ นี้", "zh": "  · 即将推出"},

    # --- Header badges (static prefixes; the value word is translated
    #     separately via status.* keys) ---
    "badge.broker_prefix": {"en": "BROKER: ", "th": "บรอกเกอร์: ", "zh": "代理: "},
    "badge.esp32_prefix": {"en": "ESP32: ", "th": "ESP32: ", "zh": "ESP32: "},

    # --- Status value vocabulary (shared across badges and metric cards;
    #     translating the display word only -- the underlying semantic
    #     status key used for color/logic is unchanged) ---
    "status.healthy": {"en": "HEALTHY", "th": "ปกติ", "zh": "健康"},
    "status.degraded": {"en": "DEGRADED", "th": "เสื่อมสภาพ", "zh": "降级"},
    "status.unknown": {"en": "UNKNOWN", "th": "ไม่ทราบ", "zh": "未知"},
    "status.connected": {"en": "CONNECTED", "th": "เชื่อมต่อแล้ว", "zh": "已连接"},
    "status.disconnected": {"en": "DISCONNECTED", "th": "ขาดการเชื่อมต่อ", "zh": "已断开"},
    "status.online": {"en": "ONLINE", "th": "ออนไลน์", "zh": "在线"},
    "status.offline": {"en": "OFFLINE", "th": "ออฟไลน์", "zh": "离线"},
    "status.normal": {"en": "NORMAL", "th": "ปกติ", "zh": "正常"},
    "status.lockdown": {"en": "LOCKDOWN", "th": "ล็อกดาวน์", "zh": "锁定"},
    "status.armed": {"en": "ARMED", "th": "พร้อมเฝ้าระวัง", "zh": "戒备中"},
    "status.disarmed": {"en": "DISARMED", "th": "ปิดการเฝ้าระวัง", "zh": "已解除"},
    "status.dry_run": {"en": "DRY RUN", "th": "โหมดทดสอบ", "zh": "演练模式"},
    "status.live": {"en": "LIVE", "th": "ใช้งานจริง", "zh": "实时"},

    # --- Overview page ---
    "overview.title": {"en": "AEGIS IDEA3", "th": "AEGIS IDEA3", "zh": "AEGIS IDEA3"},
    "overview.subtitle": {
        "en": "Security Operations Console",
        "th": "ศูนย์ปฏิบัติการความปลอดภัย",
        "zh": "安全运营控制台",
    },
    "overview.dry_run_note": {
        "en": "Hardware commands will not be published.",
        "th": "คำสั่งจะไม่ถูกส่งไปยังอุปกรณ์จริง",
        "zh": "硬件命令将不会被发布。",
    },
    "metric.health": {"en": "System Health", "th": "สถานะระบบ", "zh": "系统健康"},
    "metric.uplink": {"en": "Uplink", "th": "อัปลิงก์", "zh": "上行链路"},
    "metric.broker": {"en": "MQTT Broker", "th": "MQTT Broker", "zh": "MQTT 代理"},
    "metric.esp32": {"en": "ESP32", "th": "ESP32", "zh": "ESP32"},
    "metric.mode": {"en": "System Mode", "th": "โหมดระบบ", "zh": "系统模式"},
    "metric.deadman": {"en": "Dead Man", "th": "Dead Man's Switch", "zh": "死人开关"},
    "metric.incidents": {"en": "Open Incidents", "th": "เหตุการณ์ที่เปิดอยู่", "zh": "未结事件"},
    "metric.today": {"en": "Today", "th": "วันนี้", "zh": "今日"},

    # --- Operational controls ---
    "controls.section_title": {"en": "Operational Controls", "th": "การควบคุมการทำงาน", "zh": "操作控制"},
    "controls.arm_to_disarm": {
        "en": "Switch to DISARMED (maintenance)",
        "th": "สลับเป็นโหมดซ่อมบำรุง (DISARMED)",
        "zh": "切换到解除状态（维护模式）",
    },
    "controls.arm_to_arm": {
        "en": "Switch to ARMED (return to watch)",
        "th": "กลับสู่โหมดเฝ้าระวัง (ARMED)",
        "zh": "切换到戒备状态（恢复监视）",
    },
    "controls.recovery_button": {
        "en": "Open Incident Recovery Wizard",
        "th": "เปิดตัวช่วยกู้คืนเหตุการณ์",
        "zh": "打开事件恢复向导",
    },
    "controls.cut_button": {
        "en": "CUT_UPLINK (emergency isolation)",
        "th": "CUT_UPLINK (ตัดเน็ตฉุกเฉิน)",
        "zh": "CUT_UPLINK（紧急隔离）",
    },
    "controls.restore_button": {"en": "RESTORE_UPLINK", "th": "RESTORE_UPLINK", "zh": "RESTORE_UPLINK"},
    "controls.hint": {
        "en": "CUT/RESTORE require PIN authentication and typed CONFIRM; behavior is unchanged from the previous console.",
        "th": "CUT/RESTORE ต้องยืนยันตัวตนด้วย PIN และพิมพ์ CONFIRM เพื่อยืนยัน พฤติกรรมไม่เปลี่ยนแปลงจากคอนโซลก่อนหน้า",
        "zh": "CUT/RESTORE 需要 PIN 验证并输入 CONFIRM 确认；行为与旧版控制台保持一致。",
    },

    # --- Recent activity ---
    "activity.section_title": {"en": "Recent Activity", "th": "กิจกรรมล่าสุด", "zh": "最近活动"},
    "activity.col_time": {"en": "TIME", "th": "เวลา", "zh": "时间"},
    "activity.col_severity": {"en": "SEVERITY", "th": "ระดับ", "zh": "级别"},
    "activity.col_event": {"en": "EVENT", "th": "เหตุการณ์", "zh": "事件"},
    "activity.col_source": {"en": "SOURCE", "th": "แหล่งที่มา", "zh": "来源"},
    "activity.empty": {"en": "No activity recorded yet.", "th": "ยังไม่มีกิจกรรมที่บันทึกไว้", "zh": "尚无活动记录。"},

    # --- Full log ---
    "log.section_title": {"en": "Full Activity Log", "th": "บันทึกกิจกรรมทั้งหมด", "zh": "完整活动日志"},
    "log.filter_label": {"en": "Filter:", "th": "กรอง:", "zh": "筛选："},
    "log.filter_all": {"en": "All", "th": "ทั้งหมด", "zh": "全部"},
    "log.filter_warn": {"en": "Warning & above", "th": "WARN ขึ้นไป", "zh": "警告及以上"},
    "log.filter_crit": {"en": "Critical only", "th": "เฉพาะ CRITICAL", "zh": "仅严重"},
    "log.verify_button": {"en": "Verify Log Integrity", "th": "ตรวจสอบความสมบูรณ์ของบันทึก", "zh": "验证日志完整性"},
    "log.ready_placeholder": {"en": "[SOC] Ready.", "th": "[SOC] พร้อมทำงาน", "zh": "[SOC] 就绪。"},
    "log.integrity_title": {"en": "Log Integrity", "th": "ความสมบูรณ์ของบันทึก", "zh": "日志完整性"},
    "log.integrity_tamper_title": {"en": "Tamper Detected", "th": "ตรวจพบการแก้ไข", "zh": "检测到篡改"},

    # --- Empty state (nav placeholders) ---
    "empty.message": {
        "en": "This view is not implemented in this slice. It will arrive in a later Slice of the IDEA3 Python UX/UI refresh.",
        "th": "ยังไม่มีหน้านี้ในเวอร์ชันปัจจุบัน จะเพิ่มในสไลซ์ถัดไปของการปรับปรุง UX/UI ของ IDEA3 Python",
        "zh": "此视图在本切片中尚未实现，将在 IDEA3 Python UX/UI 改进的后续切片中提供。",
    },

    # --- Footer ---
    "footer.safety_line": {
        "en": "HMAC-SHA256 · Nonce Anti-Replay · 30s Timestamp Window · Dead Man's Switch (60s) · ACK-tracked",
        "th": "HMAC-SHA256 · ป้องกัน Replay ด้วย Nonce · หน้าต่างเวลา 30 วินาที · Dead Man's Switch (60 วินาที) · ติดตาม ACK",
        "zh": "HMAC-SHA256 · Nonce 防重放 · 30 秒时间戳窗口 · 死人开关 (60 秒) · ACK 追踪",
    },
    "footer.brand": {"en": "AEGIS IDEA 3", "th": "AEGIS IDEA 3", "zh": "AEGIS IDEA 3"},

    # --- Shared dialogs (gui.py + wizard.py) ---
    "dialog.admin_auth_title": {"en": "Admin Authentication", "th": "ยืนยันตัวตนผู้ดูแลระบบ", "zh": "管理员身份验证"},
    "dialog.pin_prompt_mode": {
        "en": "Enter PIN to switch system mode:",
        "th": "ใส่ PIN เพื่อสลับโหมดระบบ:",
        "zh": "输入 PIN 以切换系统模式：",
    },
    "dialog.pin_prompt_default": {
        "en": "Enter Admin PIN:",
        "th": "กรุณาใส่ Admin PIN:",
        "zh": "请输入管理员 PIN：",
    },
    "dialog.access_denied_title": {"en": "Access Denied", "th": "ปฏิเสธการเข้าถึง", "zh": "访问被拒绝"},
    "dialog.wrong_pin_simple": {"en": "Incorrect PIN", "th": "PIN ไม่ถูกต้อง", "zh": "PIN 不正确"},
    "dialog.wrong_pin_remaining": {
        "en": "Incorrect PIN ({remaining} attempt(s) remaining)",
        "th": "PIN ไม่ถูกต้อง (เหลืออีก {remaining} ครั้ง)",
        "zh": "PIN 不正确（还剩 {remaining} 次尝试）",
    },
    "dialog.locked_title": {"en": "Locked", "th": "ถูกล็อก", "zh": "已锁定"},
    "dialog.locked_message": {
        "en": "PIN entered incorrectly more than {max_attempts} times.\nControls locked for 60 seconds.",
        "th": "ใส่ PIN ผิดเกิน {max_attempts} ครั้ง\nระบบล็อกการควบคุม 60 วินาที",
        "zh": "PIN 输入错误超过 {max_attempts} 次。\n控制已锁定 60 秒。",
    },
    "dialog.locked_wait": {
        "en": "Controls are locked. Please wait.",
        "th": "ระบบล็อกการควบคุมอยู่ กรุณารอ",
        "zh": "控制已锁定，请稍候。",
    },
    "dialog.disarmed_title": {"en": "DISARMED", "th": "DISARMED", "zh": "已解除"},
    "dialog.disarmed_message": {
        "en": "System is in maintenance mode — switch to ARMED before issuing a cut.",
        "th": "ระบบอยู่ในโหมดซ่อมบำรุง — สลับเป็น ARMED ก่อนจึงจะสั่งตัดได้",
        "zh": "系统处于维护模式——请先切换到戒备状态才能执行切断。",
    },
    "dialog.confirm_cut_title": {"en": "Confirm Dangerous Command", "th": "ยืนยันคำสั่งอันตราย", "zh": "确认危险命令"},
    "dialog.confirm_cut_message": {
        "en": "This command will really disconnect the network.\nType CONFIRM to proceed:",
        "th": "คำสั่งนี้จะตัดการเชื่อมต่อเครือข่ายจริง\nพิมพ์ CONFIRM เพื่อยืนยัน:",
        "zh": "此命令将真正断开网络连接。\n请输入 CONFIRM 以继续：",
    },
    "dialog.mqtt_not_ready_title": {"en": "MQTT Not Ready", "th": "MQTT ไม่พร้อม", "zh": "MQTT 未就绪"},
    "dialog.mqtt_not_ready_message": {
        "en": "Not connected to the broker yet — the command could not be sent.",
        "th": "ยังไม่ได้เชื่อมต่อ broker จึงส่งคำสั่งไม่ได้",
        "zh": "尚未连接到代理，无法发送命令。",
    },
    "dialog.ufw_prompt_title": {"en": "UFW Containment", "th": "UFW Containment", "zh": "UFW 遏制"},
    "dialog.ufw_prompt_message": {
        "en": "Enter attacker IP (leave blank to skip):",
        "th": "ระบุ IP ผู้บุกรุก (เว้นว่าง = ข้าม):",
        "zh": "输入攻击者 IP（留空以跳过）：",
    },
    "dialog.invalid_ip_title": {"en": "Invalid IP", "th": "IP ไม่ถูกต้อง", "zh": "无效的 IP"},
    "dialog.invalid_ip_message": {
        "en": "'{ip}' is not a valid IP address",
        "th": "'{ip}' ไม่ใช่ IP ที่ถูกต้อง",
        "zh": "“{ip}” 不是有效的 IP 地址",
    },

    # --- Incident Recovery Wizard ---
    "recovery.window_title": {
        "en": "Incident Recovery — Post-Incident Restoration",
        "th": "Incident Recovery — กู้คืนระบบหลังเหตุการณ์",
        "zh": "事件恢复 — 事后系统复原",
    },
    "recovery.heading": {"en": "Incident Recovery Checklist", "th": "รายการตรวจสอบการกู้คืนเหตุการณ์", "zh": "事件恢复清单"},
    "recovery.subheading": {
        "en": "Incident #{incident_id} · Follow the steps in order per doc §5.4",
        "th": "Incident #{incident_id} · ไล่ทำตามลำดับตามเอกสารข้อ 5.4",
        "zh": "事件 #{incident_id} · 按文档第 5.4 节顺序执行",
    },
    "recovery.status_pending": {"en": "Pending", "th": "รอดำเนินการ", "zh": "待处理"},
    "recovery.status_done": {"en": "Done", "th": "เสร็จสิ้น", "zh": "已完成"},
    "recovery.step1_title": {"en": "1. Out-of-band Access", "th": "1. เข้าถึงผ่านช่องทางสำรอง", "zh": "1. 带外访问"},
    "recovery.step1_desc": {
        "en": "Access via a Management VLAN that was not cut, to reach the NAS outside the normal path (out-of-band).",
        "th": "เข้าระบบผ่าน Management VLAN ที่ไม่ถูกตัด เพื่อเข้าถึง NAS นอกเส้นทางปกติ (Out-of-band)",
        "zh": "通过未被切断的管理 VLAN，在正常路径之外访问 NAS（带外访问）。",
    },
    "recovery.step1_button": {
        "en": "Confirm Management VLAN access",
        "th": "ยืนยันว่าเข้าถึงผ่าน Management VLAN แล้ว",
        "zh": "确认已通过管理 VLAN 访问",
    },
    "recovery.step2_title": {"en": "2. Block Attacker IP (UFW)", "th": "2. บล็อก IP ผู้บุกรุก (UFW)", "zh": "2. 封禁攻击者 IP（UFW）"},
    "recovery.step2_desc": {
        "en": "Take the IP seen in Telegram/Log and permanently ban it in UFW before physical unlock.",
        "th": "นำ IP ที่เห็นใน Telegram/Log ไปแบนถาวรใน UFW ก่อนปลดล็อกกายภาพ",
        "zh": "在物理解锁之前，将 Telegram/日志中看到的 IP 在 UFW 中永久封禁。",
    },
    "recovery.step2_placeholder": {"en": "e.g. 203.0.113.42", "th": "เช่น 203.0.113.42", "zh": "例如 203.0.113.42"},
    "recovery.step2_button": {"en": "Block Permanently", "th": "บล็อกถาวร", "zh": "永久封禁"},
    "recovery.step2_missing_ip_title": {"en": "IP Required", "th": "ต้องระบุ IP", "zh": "需要 IP"},
    "recovery.step2_missing_ip_message": {
        "en": "Please enter the IP to block first",
        "th": "กรุณาใส่ IP ที่ต้องการบล็อกก่อน",
        "zh": "请先输入要封禁的 IP",
    },
    "recovery.step3_title": {"en": "3. Restore Physical Uplink", "th": "3. คืนค่าอัปลิงก์ทางกายภาพ", "zh": "3. 恢复物理上行链路"},
    "recovery.step3_desc": {
        "en": "Send an MQTT command (new nonce) for the ESP32 to reconnect the uplink circuit.",
        "th": "สั่ง MQTT (nonce ใหม่) ให้ ESP32 ต่อวงจร Uplink กลับ",
        "zh": "发送 MQTT 命令（新 nonce），让 ESP32 重新接通上行链路电路。",
    },
    "recovery.step3_button": {"en": "Send RESTORE_UPLINK", "th": "ส่ง RESTORE_UPLINK", "zh": "发送 RESTORE_UPLINK"},
    "recovery.step4_title": {"en": "4. Reopen Services (UFW)", "th": "4. เปิดบริการอีกครั้ง (UFW)", "zh": "4. 重新开放服务（UFW）"},
    "recovery.step4_desc": {
        "en": "Open ports/reload UFW so users and teams can operate normally again.",
        "th": "เปิดพอร์ต/รีโหลด UFW ให้ผู้ใช้และทีมใช้งานได้ตามปกติ",
        "zh": "开放端口/重新加载 UFW，使用户和团队恢复正常使用。",
    },
    "recovery.step4_button": {"en": "Reload UFW", "th": "รีโหลด UFW", "zh": "重新加载 UFW"},
    "recovery.step5_title": {"en": "5. Lessons Learned", "th": "5. สรุปบทเรียน", "zh": "5. 经验总结"},
    "recovery.step5_desc": {
        "en": "Summarize the incident back into the log to close the loop (Closed-Loop) and link back to IDEA 1.",
        "th": "สรุปเหตุการณ์กลับเข้า Log ปิดวงจร (Closed-Loop) และโยงกลับ IDEA 1",
        "zh": "将事件总结写回日志以形成闭环（Closed-Loop），并关联回 IDEA 1。",
    },
    "recovery.step5_button": {"en": "Save and Close Incident", "th": "บันทึกและปิดเหตุการณ์", "zh": "保存并关闭事件"},
    "recovery.step5_missing_title": {"en": "Not Filled In Yet", "th": "ยังไม่ได้กรอก", "zh": "尚未填写"},
    "recovery.step5_missing_message": {
        "en": "Please summarize the lessons learned before closing the incident",
        "th": "กรุณาสรุปบทเรียนก่อนปิดเหตุการณ์",
        "zh": "请先总结经验教训，然后再关闭事件",
    },
    "recovery.closed_title": {"en": "Incident Closed", "th": "ปิดเหตุการณ์แล้ว", "zh": "事件已关闭"},
    "recovery.closed_message": {
        "en": "Incident #{incident_id} closed successfully",
        "th": "ปิด Incident #{incident_id} เรียบร้อยแล้ว",
        "zh": "事件 #{incident_id} 已成功关闭",
    },
}


def _validate_language(code):
    return code if code in LANGUAGES else DEFAULT_LANGUAGE


def _preference_path():
    """Store the language preference next to the existing audit DB file, so
    no new configuration surface or protected-file change is needed."""
    db_dir = os.path.dirname(os.path.abspath(config.DB_PATH)) or "."
    return os.path.join(db_dir, "ui_language.json")


def _load_persisted_language():
    env_override = (os.environ.get("AEGIS_UI_LANGUAGE") or "").strip().lower()
    if env_override in LANGUAGES:
        return env_override
    try:
        with open(_preference_path(), encoding="utf-8") as f:
            data = json.load(f)
        return _validate_language(data.get("language"))
    except Exception:
        return DEFAULT_LANGUAGE


_state = {"language": _load_persisted_language()}


def get_language():
    return _state["language"]


def set_language(code):
    """Set the active language and persist it best-effort. Returns the
    language actually applied (falls back to DEFAULT_LANGUAGE for an
    unrecognized code rather than raising)."""
    resolved = _validate_language(code)
    _state["language"] = resolved
    try:
        os.makedirs(os.path.dirname(_preference_path()) or ".", exist_ok=True)
        with open(_preference_path(), "w", encoding="utf-8") as f:
            json.dump({"language": resolved}, f)
    except Exception:
        pass  # Persistence is best-effort; the in-memory language still applies.
    return resolved


def available_languages():
    """Ordered (code, native_name) pairs for building a language selector."""
    return [(code, LANGUAGE_NATIVE_NAMES[code]) for code in LANGUAGES]


def translate(key, **kwargs):
    """Look up `key` in the current language, falling back to English, then
    to the raw key itself if truly missing (never raises -- a missing
    translation must not crash the GUI, it should just be visibly obvious
    during development)."""
    entry = STRINGS.get(key)
    if entry is None:
        return key
    text = entry.get(_state["language"]) or entry.get(DEFAULT_LANGUAGE) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except Exception:
            return text
    return text


# Short alias used throughout gui.py/wizard.py.
t = translate
