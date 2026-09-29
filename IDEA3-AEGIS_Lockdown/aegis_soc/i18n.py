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
    "theme.dark": {"en": "Dark", "th": "มืด", "zh": "深色"},
    "theme.light": {"en": "Light", "th": "สว่าง", "zh": "浅色"},
    "login.brand_tagline": {
        "en": "CYBER-PHYSICAL DEFENSE",
        "th": "การป้องกันไซเบอร์–กายภาพ",
        "zh": "网络物理防御",
    },
    "login.brand_description": {
        "en": "A dedicated operations console for verified containment, device evidence, and controlled recovery.",
        "th": "คอนโซลปฏิบัติการสำหรับการกักกันที่ตรวจสอบได้ หลักฐานอุปกรณ์ และการกู้คืนที่ควบคุมอย่างรัดกุม",
        "zh": "用于可验证遏制、设备证据和受控恢复的专用运营控制台。",
    },
    "login.title": {"en": "Admin Login", "th": "เข้าสู่ระบบผู้ดูแล", "zh": "管理员登录"},
    "login.window_title": {
        "en": "AEGIS IDEA3 — Admin Login",
        "th": "AEGIS IDEA3 — เข้าสู่ระบบผู้ดูแล",
        "zh": "AEGIS IDEA3 — 管理员登录",
    },
    "login.subtitle": {
        "en": "Authenticate to open the local IDEA3 operations workspace.",
        "th": "ยืนยันตัวตนเพื่อเปิดพื้นที่ปฏิบัติการ IDEA3 ภายในเครื่อง",
        "zh": "验证身份以打开本地 IDEA3 运营工作区。",
    },
    "login.admin_id": {"en": "Admin ID", "th": "รหัสผู้ดูแล", "zh": "管理员 ID"},
    "login.pin": {"en": "PIN", "th": "PIN", "zh": "PIN"},
    "login.sign_in": {"en": "Sign In", "th": "เข้าสู่ระบบ", "zh": "登录"},
    "login.failure": {
        "en": "Unable to sign in. Check your credentials and try again.",
        "th": "ไม่สามารถเข้าสู่ระบบได้ โปรดตรวจสอบข้อมูลแล้วลองอีกครั้ง",
        "zh": "无法登录。请检查凭据后重试。",
    },
    "login.security_note": {
        "en": "Local authentication only. Command authorization remains a separate checkpoint.",
        "th": "ยืนยันตัวตนภายในเครื่องเท่านั้น การอนุมัติคำสั่งยังเป็นด่านแยกต่างหาก",
        "zh": "仅限本地身份验证。命令授权仍是独立检查点。",
    },
    "session.logout": {"en": "Logout", "th": "ออกจากระบบ", "zh": "退出登录"},

    # --- Navigation ---
    "nav.overview": {"en": "Overview", "th": "ภาพรวม", "zh": "概览"},
    "nav.incidents": {"en": "Incidents", "th": "เหตุการณ์", "zh": "事件"},
    "nav.devices": {"en": "Devices", "th": "อุปกรณ์", "zh": "设备"},
    "nav.lockdown": {"en": "Lockdown", "th": "ล็อกดาวน์", "zh": "锁定"},
    "nav.recovery": {"en": "Recovery", "th": "การกู้คืน", "zh": "恢复"},
    "nav.audit": {"en": "Audit Log", "th": "บันทึกการตรวจสอบ", "zh": "审计日志"},
    "nav.diagnostics": {"en": "Diagnostics", "th": "การวินิจฉัย", "zh": "诊断"},
    "nav.settings": {"en": "Settings", "th": "การตั้งค่า", "zh": "设置"},
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
    "overview.summary_title": {"en": "Operational Summary", "th": "สรุปการปฏิบัติงาน", "zh": "运营摘要"},
    "overview.command_evidence": {"en": "Command lifecycle", "th": "วงจรคำสั่ง", "zh": "命令生命周期"},
    "overview.no_pending": {"en": "No command awaiting ACK", "th": "ไม่มีคำสั่งรอ ACK", "zh": "没有等待 ACK 的命令"},
    "overview.pending_ack": {"en": "Published; awaiting ACK", "th": "ส่งแล้ว กำลังรอ ACK", "zh": "已发布，正在等待 ACK"},
    "overview.physical_evidence": {"en": "Physical network verification", "th": "การยืนยันเครือข่ายทางกายภาพ", "zh": "物理网络验证"},
    "overview.physical_unknown": {"en": "NO EVIDENCE", "th": "ไม่มีหลักฐาน", "zh": "无证据"},
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
    "log.export_button": {"en": "Export CSV", "th": "ส่งออก CSV", "zh": "导出 CSV"},
    "log.ready_placeholder": {"en": "[SOC] Ready.", "th": "[SOC] พร้อมทำงาน", "zh": "[SOC] 就绪。"},
    "log.integrity_title": {"en": "Log Integrity", "th": "ความสมบูรณ์ของบันทึก", "zh": "日志完整性"},
    "log.integrity_tamper_title": {"en": "Tamper Detected", "th": "ตรวจพบการแก้ไข", "zh": "检测到篡改"},
    "log.export_success_title": {"en": "Export Complete", "th": "ส่งออกสำเร็จ", "zh": "导出完成"},
    "log.export_success_message": {
        "en": "Created aegis_security_report.csv.",
        "th": "สร้างไฟล์ aegis_security_report.csv แล้ว",
        "zh": "已创建 aegis_security_report.csv。",
    },
    "log.export_error_title": {"en": "Export Error", "th": "ส่งออกไม่สำเร็จ", "zh": "导出错误"},
    "log.export_error_message": {
        "en": "The audit log could not be exported: {error}",
        "th": "ไม่สามารถส่งออกบันทึกการตรวจสอบได้: {error}",
        "zh": "无法导出审计日志：{error}",
    },

    # --- Empty state (nav placeholders) ---
    "empty.message": {
        "en": "This view is not implemented in this slice. It will arrive in a later Slice of the IDEA3 Python UX/UI refresh.",
        "th": "ยังไม่มีหน้านี้ในเวอร์ชันปัจจุบัน จะเพิ่มในสไลซ์ถัดไปของการปรับปรุง UX/UI ของ IDEA3 Python",
        "zh": "此视图在本切片中尚未实现，将在 IDEA3 Python UX/UI 改进的后续切片中提供。",
    },

    # --- Authenticated operational workspaces ---
    "incidents.title": {"en": "Incidents", "th": "เหตุการณ์", "zh": "事件"},
    "incidents.subtitle": {
        "en": "Recorded security events and their closed-loop lifecycle.",
        "th": "เหตุการณ์ความปลอดภัยที่บันทึกไว้และวงจรการจัดการแบบครบวงจร",
        "zh": "已记录的安全事件及其闭环生命周期。",
    },
    "incidents.section_title": {"en": "Incident Register", "th": "ทะเบียนเหตุการณ์", "zh": "事件登记"},
    "incidents.col_opened": {"en": "OPENED", "th": "เริ่ม", "zh": "开始"},
    "incidents.col_state": {"en": "STATE", "th": "สถานะ", "zh": "状态"},
    "incidents.col_evidence": {"en": "EVIDENCE / SUMMARY", "th": "หลักฐาน / สรุป", "zh": "证据 / 摘要"},
    "incidents.col_id": {"en": "ID", "th": "ID", "zh": "ID"},
    "incidents.empty": {
        "en": "No incidents have been recorded.",
        "th": "ยังไม่มีเหตุการณ์ที่บันทึกไว้",
        "zh": "尚未记录任何事件。",
    },
    "incidents.details_title": {"en": "Selected Incident Details", "th": "รายละเอียดเหตุการณ์ที่เลือก", "zh": "所选事件详情"},
    "incidents.detail_id": {"en": "Incident ID", "th": "รหัสเหตุการณ์", "zh": "事件 ID"},
    "incidents.detail_severity": {"en": "Severity", "th": "ระดับความรุนแรง", "zh": "严重级别"},
    "incidents.detail_state": {"en": "State", "th": "สถานะ", "zh": "状态"},
    "incidents.detail_opened": {"en": "Opened", "th": "เริ่มเมื่อ", "zh": "开始时间"},
    "incidents.detail_closed": {"en": "Closed", "th": "ปิดเมื่อ", "zh": "关闭时间"},
    "incidents.detail_ip": {"en": "Attacker IP evidence", "th": "หลักฐาน IP ผู้โจมตี", "zh": "攻击者 IP 证据"},
    "incidents.detail_summary": {"en": "Summary", "th": "สรุป", "zh": "摘要"},
    "incidents.severity_unrecorded": {"en": "NOT RECORDED", "th": "ไม่ได้บันทึก", "zh": "未记录"},
    "incidents.no_evidence": {"en": "NO EVIDENCE", "th": "ไม่มีหลักฐาน", "zh": "无证据"},
    "incidents.timeline_title": {"en": "Linked Audit Timeline", "th": "ไทม์ไลน์บันทึกที่เชื่อมโยง", "zh": "关联审计时间线"},
    "incidents.timeline_empty": {"en": "No audit events are linked to this incident.", "th": "ไม่มีบันทึกการตรวจสอบที่เชื่อมกับเหตุการณ์นี้", "zh": "没有与此事件关联的审计记录。"},
    "devices.title": {"en": "Devices", "th": "อุปกรณ์", "zh": "设备"},
    "devices.subtitle": {
        "en": "Live connectivity and last-observed device evidence.",
        "th": "การเชื่อมต่อสดและหลักฐานล่าสุดจากอุปกรณ์",
        "zh": "实时连接和最近观测到的设备证据。",
    },
    "devices.evidence_title": {"en": "Device Evidence", "th": "หลักฐานอุปกรณ์", "zh": "设备证据"},
    "devices.last_seen": {"en": "Last device message", "th": "ข้อความล่าสุดจากอุปกรณ์", "zh": "最近设备消息"},
    "devices.heap": {"en": "Free heap", "th": "หน่วยความจำว่าง", "zh": "可用堆内存"},
    "lockdown.title": {"en": "Lockdown Control", "th": "ควบคุมล็อกดาวน์", "zh": "锁定控制"},
    "lockdown.subtitle": {
        "en": "High-consequence isolation controls with independent command authorization.",
        "th": "การควบคุมการแยกระบบที่มีผลกระทบสูง พร้อมการอนุมัติคำสั่งแยกต่างหาก",
        "zh": "高影响隔离控制，命令授权独立进行。",
    },
    "lockdown.readiness_title": {"en": "Command Readiness", "th": "ความพร้อมของคำสั่ง", "zh": "命令就绪状态"},
    "lockdown.evidence_note": {
        "en": "Broker, device, ACK, relay, and physical-network evidence remain distinct. UNKNOWN is not failure.",
        "th": "หลักฐานจากบรอกเกอร์ อุปกรณ์ ACK รีเลย์ และเครือข่ายจริงแยกจากกัน สถานะไม่ทราบไม่ใช่ความล้มเหลว",
        "zh": "代理、设备、ACK、继电器和物理网络证据彼此独立；未知不等于失败。",
    },
    "recovery.page_title": {"en": "Recovery", "th": "การกู้คืน", "zh": "恢复"},
    "recovery.page_subtitle": {
        "en": "Guided containment recovery with an auditable five-step closeout.",
        "th": "การกู้คืนหลังการกักกันแบบมีขั้นตอน พร้อมการปิดงานที่ตรวจสอบย้อนหลังได้ 5 ขั้น",
        "zh": "通过可审计的五步流程完成遏制恢复。",
    },
    "audit.title": {"en": "Audit Log", "th": "บันทึกการตรวจสอบ", "zh": "审计日志"},
    "audit.subtitle": {
        "en": "Tamper-evident operational evidence, filtering, verification, and export.",
        "th": "หลักฐานการปฏิบัติงานแบบตรวจจับการแก้ไข พร้อมการกรอง ตรวจสอบ และส่งออก",
        "zh": "可检测篡改的运营证据，支持筛选、验证和导出。",
    },
    "audit.structured_title": {"en": "Structured Events", "th": "เหตุการณ์แบบมีโครงสร้าง", "zh": "结构化事件"},
    "diagnostics.title": {"en": "Diagnostics", "th": "การวินิจฉัย", "zh": "诊断"},
    "diagnostics.subtitle": {
        "en": "Safe runtime readiness facts without revealing secret values.",
        "th": "ข้อเท็จจริงความพร้อมของระบบโดยไม่เปิดเผยค่าความลับ",
        "zh": "不泄露机密值的安全运行时就绪信息。",
    },
    "diagnostics.runtime_title": {"en": "Runtime Readiness", "th": "ความพร้อมของระบบ", "zh": "运行时就绪状态"},
    "diagnostics.profile": {"en": "Runtime profile", "th": "โปรไฟล์รันไทม์", "zh": "运行时配置"},
    "diagnostics.dry_run": {"en": "Dry-run safeguards", "th": "การป้องกันโหมดทดสอบ", "zh": "演练保护"},
    "diagnostics.auto_contain": {"en": "Automatic containment", "th": "การกักกันอัตโนมัติ", "zh": "自动遏制"},
    "diagnostics.broker_config": {"en": "Broker endpoint", "th": "ปลายทางบรอกเกอร์", "zh": "代理端点"},
    "diagnostics.mqtt_auth": {"en": "MQTT credentials", "th": "ข้อมูลยืนยัน MQTT", "zh": "MQTT 凭据"},
    "diagnostics.hmac": {"en": "HMAC secret", "th": "ความลับ HMAC", "zh": "HMAC 密钥"},
    "diagnostics.admin_pin": {"en": "Admin PIN", "th": "PIN ผู้ดูแล", "zh": "管理员 PIN"},
    "diagnostics.database": {"en": "Runtime database", "th": "ฐานข้อมูลรันไทม์", "zh": "运行时数据库"},
    "diagnostics.audit_chain": {"en": "Audit hash chain", "th": "ลูกโซ่แฮชบันทึก", "zh": "审计哈希链"},
    "diagnostics.audit_valid": {"en": "VALID", "th": "สมบูรณ์", "zh": "有效"},
    "diagnostics.audit_invalid": {"en": "INVALID", "th": "ไม่สมบูรณ์", "zh": "无效"},
    "diagnostics.configured": {"en": "CONFIGURED", "th": "ตั้งค่าแล้ว", "zh": "已配置"},
    "diagnostics.not_configured": {"en": "NOT CONFIGURED", "th": "ยังไม่ตั้งค่า", "zh": "未配置"},
    "diagnostics.no_secrets": {
        "en": "Only configuration presence is shown; secret values never appear in this view.",
        "th": "หน้านี้แสดงเฉพาะว่ามีการตั้งค่าหรือไม่ โดยไม่แสดงค่าความลับ",
        "zh": "此视图仅显示配置是否存在，绝不显示机密值。",
    },
    "settings.title": {"en": "Settings", "th": "การตั้งค่า", "zh": "设置"},
    "settings.subtitle": {
        "en": "Local display preferences and the active admin session.",
        "th": "การตั้งค่าการแสดงผลภายในเครื่องและเซสชันผู้ดูแลที่ใช้งานอยู่",
        "zh": "本地显示偏好和当前管理员会话。",
    },
    "settings.preferences_title": {"en": "Display Preferences", "th": "การแสดงผล", "zh": "显示偏好"},
    "settings.persist_note": {
        "en": "Language and theme are stored locally beside the runtime database.",
        "th": "ภาษาและธีมจะถูกบันทึกภายในเครื่องข้างฐานข้อมูลรันไทม์",
        "zh": "语言和主题保存在运行时数据库旁的本地文件中。",
    },
    "settings.session_title": {"en": "Active Session", "th": "เซสชันที่ใช้งาน", "zh": "当前会话"},
    "settings.admin_id": {"en": "Admin ID", "th": "รหัสผู้ดูแล", "zh": "管理员 ID"},
    "settings.signed_in": {"en": "Signed in", "th": "เข้าสู่ระบบเมื่อ", "zh": "登录时间"},
    "settings.about_title": {"en": "Branding & About", "th": "แบรนด์และข้อมูลผลิตภัณฑ์", "zh": "品牌与关于"},
    "settings.product": {"en": "Product", "th": "ผลิตภัณฑ์", "zh": "产品"},
    "settings.about_text": {
        "en": "AEGIS IDEA3 is the local cyber-physical containment and recovery console.",
        "th": "AEGIS IDEA3 คือคอนโซลภายในเครื่องสำหรับการกักกันและกู้คืนระบบไซเบอร์–กายภาพ",
        "zh": "AEGIS IDEA3 是本地网络物理遏制与恢复控制台。",
    },
    "common.yes": {"en": "YES", "th": "ใช่", "zh": "是"},
    "common.no": {"en": "NO", "th": "ไม่", "zh": "否"},

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

    # --- Notification center (header bell + panel + toast) ---
    "notif.button_label": {"en": "Alerts", "th": "แจ้งเตือน", "zh": "警报"},
    "notif.panel_title": {"en": "Notifications", "th": "การแจ้งเตือน", "zh": "通知"},
    "notif.empty": {
        "en": "No unread notifications.",
        "th": "ไม่มีการแจ้งเตือนที่ยังไม่ได้อ่าน",
        "zh": "没有未读通知。",
    },
    "notif.unread_count": {"en": "{count} unread", "th": "ยังไม่อ่าน {count} รายการ", "zh": "{count} 条未读"},
    "notif.ack_button": {"en": "Acknowledge", "th": "รับทราบ", "zh": "确认"},
    "notif.ack_all_button": {"en": "Acknowledge All", "th": "รับทราบทั้งหมด", "zh": "全部确认"},
    "notif.close_button": {"en": "Close", "th": "ปิด", "zh": "关闭"},
    "notif.severity_info": {"en": "INFO", "th": "ข้อมูล", "zh": "信息"},
    "notif.severity_warning": {"en": "WARNING", "th": "คำเตือน", "zh": "警告"},
    "notif.severity_critical": {"en": "CRITICAL", "th": "วิกฤต", "zh": "严重"},
    "notif.go_to_lockdown_button": {"en": "Go to Lockdown", "th": "ไปที่ล็อกดาวน์", "zh": "前往锁定页面"},
    "notif.open_incidents_button": {"en": "Open Incidents", "th": "เปิดหน้าล่าเหตุการณ์", "zh": "打开事件页面"},
    "notif.review_audit_button": {"en": "Review Audit Log", "th": "ตรวจสอบบันทึกการตรวจสอบ", "zh": "查看审计日志"},
    "notif.containment_manual_note": {
        "en": "Automatic containment is disabled. Containment requires a manual operator action.",
        "th": "การกักกันอัตโนมัติปิดอยู่ ต้องดำเนินการกักกันด้วยตนเองโดยผู้ปฏิบัติงาน",
        "zh": "自动遏制已禁用。遏制需要操作员手动执行。",
    },
    "notif.containment_label": {"en": "Containment:", "th": "การกักกัน:", "zh": "遏制方式："},
    "notif.containment_manual": {"en": "Manual", "th": "ด้วยตนเอง", "zh": "手动"},
    "notif.containment_automatic": {"en": "Automatic", "th": "อัตโนมัติ", "zh": "自动"},
    "notif.toast_timestamp_label": {"en": "Detection evidence received", "th": "ได้รับหลักฐานการตรวจจับ", "zh": "收到检测证据"},
    "notif.toast_source_label": {"en": "Source IP", "th": "IP ต้นทาง", "zh": "来源 IP"},
    "notif.source_unknown": {"en": "UNKNOWN", "th": "ไม่ทราบ", "zh": "未知"},
    "notif.broker_disconnected_title": {
        "en": "MQTT Broker Disconnected",
        "th": "การเชื่อมต่อ MQTT Broker ขาดหาย",
        "zh": "MQTT 代理已断开",
    },
    "notif.broker_disconnected_message": {
        "en": "The console lost its connection to the MQTT broker.",
        "th": "คอนโซลขาดการเชื่อมต่อกับ MQTT Broker",
        "zh": "控制台与 MQTT 代理的连接已断开。",
    },
    "notif.esp32_offline_title": {"en": "ESP32 Evidence Stale", "th": "หลักฐาน ESP32 ไม่เป็นปัจจุบัน", "zh": "ESP32 证据已过期"},
    "notif.esp32_offline_message": {
        "en": "No message has been received from the ESP32 within the configured offline threshold.",
        "th": "ไม่ได้รับข้อความจาก ESP32 ภายในเวลาที่กำหนดว่าออฟไลน์",
        "zh": "在设定的离线阈值时间内未收到来自 ESP32 的消息。",
    },
    "notif.security_alert_title": {"en": "Security Alert", "th": "การแจ้งเตือนความปลอดภัย", "zh": "安全警报"},
    "notif.security_alert_message": {
        "en": "Detection evidence received. Source IP: {source_ip}",
        "th": "ได้รับหลักฐานการตรวจจับ IP ต้นทาง: {source_ip}",
        "zh": "已收到检测证据。来源 IP：{source_ip}",
    },
    "notif.security_alert_message_unknown": {
        "en": "Detection evidence received. Source IP is not known.",
        "th": "ได้รับหลักฐานการตรวจจับ แต่ไม่ทราบ IP ต้นทาง",
        "zh": "已收到检测证据，但来源 IP 未知。",
    },
    "notif.lockdown_engaged_title": {"en": "Uplink Lockdown Reported", "th": "รายงานล็อกดาวน์อัปลิงก์", "zh": "报告上行链路锁定"},
    "notif.lockdown_engaged_message": {
        "en": "The device reported an uplink state transition to LOCKDOWN.",
        "th": "อุปกรณ์รายงานการเปลี่ยนสถานะอัปลิงก์เป็น LOCKDOWN",
        "zh": "设备报告上行链路状态转为 LOCKDOWN。",
    },
    "notif.normal_restored_title": {"en": "Uplink Normal Reported", "th": "รายงานอัปลิงก์กลับสู่ปกติ", "zh": "报告上行链路恢复正常"},
    "notif.normal_restored_message": {
        "en": "The device reported an uplink state transition to NORMAL.",
        "th": "อุปกรณ์รายงานการเปลี่ยนสถานะอัปลิงก์เป็น NORMAL",
        "zh": "设备报告上行链路状态转为 NORMAL。",
    },
    "notif.audit_invalid_title": {"en": "Audit Chain Integrity Failure", "th": "ลูกโซ่บันทึกตรวจสอบไม่สมบูรณ์", "zh": "审计链完整性失败"},
    "notif.audit_invalid_message": {
        "en": "The audit hash chain failed verification. Review the Audit Log immediately.",
        "th": "การตรวจสอบลูกโซ่แฮชของบันทึกล้มเหลว กรุณาตรวจสอบบันทึกการตรวจสอบทันที",
        "zh": "审计哈希链验证失败。请立即查看审计日志。",
    },

    # --- Overview: active security incident banner ---
    "overview.banner_active_title": {"en": "ACTIVE SECURITY INCIDENT", "th": "เหตุการณ์ความปลอดภัยที่กำลังเกิดขึ้น", "zh": "活跃安全事件"},
    "overview.banner_incident_label": {"en": "Incident", "th": "เหตุการณ์", "zh": "事件"},
    "overview.banner_source_ip_label": {"en": "Source IP", "th": "IP ต้นทาง", "zh": "来源 IP"},
    "overview.banner_state_label": {"en": "State", "th": "สถานะ", "zh": "状态"},
    "overview.banner_opened_label": {"en": "Opened", "th": "เปิดเมื่อ", "zh": "开启时间"},
    "overview.banner_open_incident_button": {"en": "Open Incident", "th": "เปิดดูเหตุการณ์", "zh": "打开事件"},
    "overview.banner_review_evidence_button": {"en": "Review Evidence", "th": "ตรวจสอบหลักฐาน", "zh": "查看证据"},
    "overview.banner_go_lockdown_button": {"en": "Go to Lockdown", "th": "ไปที่ล็อกดาวน์", "zh": "前往锁定页面"},
    "overview.banner_empty_title": {"en": "No Active Incidents", "th": "ไม่มีเหตุการณ์ที่กำลังเกิดขึ้น", "zh": "没有活跃事件"},
    "overview.banner_empty_message": {
        "en": "No open security incident is currently recorded.",
        "th": "ขณะนี้ไม่มีเหตุการณ์ความปลอดภัยที่เปิดอยู่ในบันทึก",
        "zh": "当前没有记录的未结安全事件。",
    },
    "overview.section_system": {"en": "System", "th": "ระบบ", "zh": "系统"},
    "overview.section_connectivity": {"en": "Connectivity", "th": "การเชื่อมต่อ", "zh": "连接状态"},
    "overview.section_safety": {"en": "Safety", "th": "ความปลอดภัย", "zh": "安全性"},

    # --- Devices: staleness presentation ---
    "devices.last_seen_age": {"en": "Evidence age", "th": "อายุของหลักฐาน", "zh": "证据时效"},
    "devices.last_seen_seconds_ago": {"en": "{seconds:.0f}s ago", "th": "{seconds:.0f} วินาทีที่แล้ว", "zh": "{seconds:.0f} 秒前"},
    "devices.stale_badge": {"en": "STALE", "th": "ไม่เป็นปัจจุบัน", "zh": "已过期"},

    # --- Incidents: improved empty state ---
    "incidents.empty_title": {"en": "NO ACTIVE INCIDENTS", "th": "ไม่มีเหตุการณ์ที่กำลังเกิดขึ้น", "zh": "没有活跃事件"},
    "incidents.empty_hint": {
        "en": "Security alerts and incident evidence will appear here when detected.",
        "th": "การแจ้งเตือนความปลอดภัยและหลักฐานเหตุการณ์จะปรากฏที่นี่เมื่อตรวจพบ",
        "zh": "检测到安全警报和事件证据时将显示在此处。",
    },
    "incidents.empty_review_audit_button": {"en": "Review Audit Log", "th": "ตรวจสอบบันทึกการตรวจสอบ", "zh": "查看审计日志"},

    # --- Lockdown: readiness disclaimer + additional facts ---
    "lockdown.readiness_disclaimer": {
        "en": "Containment readiness summarizes available evidence. It does not guarantee physical isolation.",
        "th": "ความพร้อมด้านการกักกันสรุปจากหลักฐานที่มีอยู่ ไม่ได้รับประกันการแยกระบบทางกายภาพ",
        "zh": "遏制就绪状态基于现有证据总结，并不保证物理隔离。",
    },
    "lockdown.active_incident_label": {"en": "Active Incident", "th": "เหตุการณ์ที่กำลังเกิดขึ้น", "zh": "活跃事件"},
    "lockdown.no_active_incident": {"en": "NONE", "th": "ไม่มี", "zh": "无"},
    "lockdown.pending_command_label": {"en": "Pending Command", "th": "คำสั่งที่รอดำเนินการ", "zh": "待处理命令"},
    "lockdown.no_pending_command": {"en": "NONE", "th": "ไม่มี", "zh": "无"},

    # --- Metric helper lines ---
    # presentation.py deliberately stays English-only (its exact strings are
    # asserted by tests and it has no i18n dependency), so the display layer
    # localizes these the same way it already localizes status values.
    "helper.insufficient_evidence": {
        "en": "Insufficient evidence", "th": "หลักฐานไม่เพียงพอ", "zh": "证据不足",
    },
    "helper.no_broker_evidence": {
        "en": "No broker evidence yet", "th": "ยังไม่มีหลักฐานจากบรอกเกอร์", "zh": "尚无代理证据",
    },
    "helper.no_device_evidence": {
        "en": "No device evidence yet", "th": "ยังไม่มีหลักฐานจากอุปกรณ์", "zh": "尚无设备证据",
    },
    "helper.no_status_evidence": {
        "en": "No status evidence yet", "th": "ยังไม่มีหลักฐานสถานะ", "zh": "尚无状态证据",
    },
    "helper.last_seen_ago": {
        "en": "last seen {seconds}s ago", "th": "พบล่าสุดเมื่อ {seconds} วินาทีที่แล้ว", "zh": "最近 {seconds} 秒前出现",
    },
    "helper.rssi": {"en": "RSSI {rssi} dBm", "th": "RSSI {rssi} dBm", "zh": "RSSI {rssi} dBm"},
    "helper.heap": {"en": "heap {heap} B", "th": "หน่วยความจำว่าง {heap} B", "zh": "堆内存 {heap} B"},

    # --- Navigation grouping captions ---
    "nav.group_monitor": {"en": "Monitor", "th": "เฝ้าระวัง", "zh": "监控"},
    "nav.group_respond": {"en": "Respond", "th": "ตอบสนอง", "zh": "响应"},
    "nav.group_system": {"en": "System", "th": "ระบบ", "zh": "系统"},

    # --- Diagnostics: grouped sections ---
    "diagnostics.section_connectivity": {"en": "Connectivity Configuration", "th": "การตั้งค่าการเชื่อมต่อ", "zh": "连接配置"},
    "diagnostics.section_security": {"en": "Security Configuration", "th": "การตั้งค่าความปลอดภัย", "zh": "安全配置"},
    "diagnostics.section_data": {"en": "Data Integrity", "th": "ความสมบูรณ์ของข้อมูล", "zh": "数据完整性"},
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
