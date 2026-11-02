"""Live, read-only launcher for the human-accepted purple Python Desktop.

The dirty PYTHONUI package supplies the real AegisAdminGUI, LoginView, theme,
and page builders. This entrypoint supplies only a Core status projection and
fail-closed local fakes for every operational dependency.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import tkinter as tk
from pathlib import Path
from types import ModuleType, SimpleNamespace

from tools import graceful_exit
from tools import purple_design as design
from tools.preview_purple_desktop import PYTHONUI_ROOT as ACCEPTED_PURPLE_SOURCE
from tools.preview_purple_desktop import _install_import_isolation, _preview_gui_class

PYTHONUI_ROOT = Path(ACCEPTED_PURPLE_SOURCE).resolve()
LIVE_TITLE = "AEGIS IDEA3 — PURPLE LIVE READ-ONLY OBSERVER — CORE EVIDENCE"
EVIDENCE_POLL_MS = 2000
# The Desktop marks Core evidence STALE when the Core's status document is older than this: the ESP32 dead-man window (config.DEADMAN_TIMEOUT_SEC,
# pinned equal by a test). It is deliberately separate from observer.DEFAULT_MAX_AGE_SECONDS (120 s), which the status sidecar and
# push client use for a different purpose; a literal here keeps this module free of the Core's config import.
DESKTOP_MAX_AGE_SECONDS = 60.0
STATIC_EVIDENCE_PAGES = ("devices", "lockdown")  # pages whose facts are built once from the evidence; see _refresh_live_evidence


def _load_reader():
    reader_path = Path(__file__).resolve().parents[1] / "aegis_soc" / "observer.py"
    spec = importlib.util.spec_from_file_location("aegis_observer_reader", reader_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load read-only Core observer: {reader_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_observer_reader"] = module
    spec.loader.exec_module(module)
    return module


reader = _load_reader()


def _load_containment():
    path = Path(__file__).resolve().parents[1] / "aegis_soc" / "ip_containment.py"
    spec = importlib.util.spec_from_file_location("aegis_containment_reader", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load read-only containment client: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_containment_reader"] = module
    spec.loader.exec_module(module)
    return module


containment = _load_containment()

CONTAINMENT_HEALTHY = "HEALTHY"
CONTAINMENT_NOT_CONFIGURED = "NOT_CONFIGURED"
CONTAINMENT_BLOCKED_CAP = 64

# Diagnostics-page containment strings, added to the purple i18n table by both entry points (see
# register_observer_strings), so this reads the same way whether the window is the pure observer or the
# full control Desktop.
OBSERVER_STRINGS = {
    # Shared operational-page vocabulary. These keys live in the IDEA3-owned integration layer so the
    # accepted i18n.py snapshot remains byte-identical; register_observer_strings() adds them without ever
    # replacing a key already owned by the pinned source.
    "overview.live_evidence.section": {
        "en": "LIVE CORE EVIDENCE — READ ONLY", "th": "หลักฐานสดจาก Core — อ่านอย่างเดียว",
        "zh": "Core 实时证据 — 只读",
    },
    "overview.live_evidence.core": {
        "en": "CORE & POLICY", "th": "Core และนโยบาย", "zh": "Core 与策略",
    },
    "overview.live_evidence.connectivity": {
        "en": "CONNECTIVITY & DEVICE", "th": "การเชื่อมต่อและอุปกรณ์", "zh": "连接与设备",
    },
    "devices.summary.section": {
        "en": "DEVICE HEALTH SUMMARY", "th": "สรุปสุขภาพอุปกรณ์", "zh": "设备健康摘要",
    },
    "devices.evidence.section": {
        "en": "CONNECTIVITY & HEARTBEAT EVIDENCE", "th": "หลักฐานการเชื่อมต่อและ heartbeat",
        "zh": "连接与心跳证据",
    },
    "devices.physical_limit.section": {
        "en": "REPORTED STATE & PHYSICAL LIMIT", "th": "สถานะที่รายงานและข้อจำกัดทางกายภาพ",
        "zh": "上报状态与物理限制",
    },
    "lockdown.current.section": {
        "en": "CURRENT LOCKDOWN STATE", "th": "สถานะล็อกดาวน์ปัจจุบัน", "zh": "当前锁定状态",
    },
    "lockdown.controls.section": {
        "en": "OPERATOR CONTROLS", "th": "การควบคุมของผู้ปฏิบัติงาน", "zh": "操作员控制",
    },
    "lockdown.controls.observer_note": {
        "en": "CUT and RESTORE are disabled in read-only observer mode.",
        "th": "CUT และ RESTORE ถูกปิดใช้งานในโหมดสังเกตการณ์แบบอ่านอย่างเดียว",
        "zh": "在只读观察模式下，CUT 与 RESTORE 均已禁用。",
    },
    "settings.language.label": {"en": "Interface language", "th": "ภาษาของอินเทอร์เฟซ", "zh": "界面语言"},
    "settings.theme.label": {"en": "Appearance", "th": "ธีม", "zh": "外观"},
    "settings.autosave.note": {
        "en": "Changes apply immediately and keep the existing persistence behavior.",
        "th": "การเปลี่ยนแปลงมีผลทันทีและใช้การบันทึกค่าแบบเดิมของระบบ",
        "zh": "更改会立即生效，并保留现有的持久化行为。",
    },
    "settings.feedback.language": {
        "en": "Language updated successfully.", "th": "อัปเดตภาษาเรียบร้อยแล้ว", "zh": "语言已成功更新。",
    },
    "settings.feedback.theme": {
        "en": "Appearance updated successfully.", "th": "อัปเดตรูปแบบการแสดงผลเรียบร้อยแล้ว", "zh": "外观已成功更新。",
    },
    "devices.field.heartbeat": {
        "en": "Heartbeat", "th": "สัญญาณ heartbeat", "zh": "心跳信号",
    },
    "devices.field.reported_uplink": {
        "en": "Reported uplink", "th": "สถานะ uplink ที่รายงาน", "zh": "上报的上行链路状态",
    },
    "devices.field.physical_relay": {
        "en": "Physical relay", "th": "รีเลย์ทางกายภาพ", "zh": "物理继电器",
    },
    "devices.physical.not_proven": {
        "en": "NOT PROVEN — software evidence does not verify the relay or network path.",
        "th": "ยังไม่พิสูจน์ — หลักฐานซอฟต์แวร์ไม่ยืนยันรีเลย์หรือเส้นทางเครือข่ายจริง",
        "zh": "尚未证明 — 软件证据不能验证继电器或实际网络路径。",
    },
    "devices.summary.note": {
        "en": "These values are what the Core reports. Reported is not the same as physically verified.",
        "th": "ค่าเหล่านี้คือสิ่งที่ Core รายงาน — สิ่งที่รายงานไม่เท่ากับการตรวจสอบทางกายภาพ",
        "zh": "这些数值是 Core 上报的内容。上报并不等同于经过物理验证。",
    },
    "devices.metrics.note": {
        "en": "NOT_AVAILABLE means the device did not report this value to this Desktop. It does not mean the device is faulty.",
        "th": "NOT_AVAILABLE หมายถึงอุปกรณ์ไม่ได้รายงานค่านี้มายัง Desktop — ไม่ได้หมายความว่าอุปกรณ์ขัดข้อง",
        "zh": "NOT_AVAILABLE 表示设备未向本 Desktop 上报该数值，并不表示设备故障。",
    },
    "devices.physical.ack_note": {
        "en": "A software ACK from the ESP32 shows it acknowledged a command. It is not proof of physical cable continuity.",
        "th": "ACK ทางซอฟต์แวร์จาก ESP32 แสดงว่าอุปกรณ์ตอบรับคำสั่งแล้วเท่านั้น — ไม่ใช่หลักฐานว่าสายเคเบิลเชื่อมต่อทางกายภาพ",
        "zh": "ESP32 的软件 ACK 只表示设备已确认收到命令，并不证明线缆在物理上保持连通。",
    },
    "overview.metric.deadman_note": {
        "en": "Not provided by the Core status document", "th": "Core ไม่ได้ให้ข้อมูลนี้ในเอกสารสถานะ",
        "zh": "Core 状态文档未提供此项",
    },
    "overview.metric.incidents_note": {
        "en": "No open-incident count here — see the Incidents page", "th": "ไม่มีจำนวนเหตุการณ์ที่เปิดอยู่ที่นี่ — ดูที่หน้าเหตุการณ์",
        "zh": "此处无未结事件数量 — 请查看“事件”页面",
    },
    "overview.metric.today_note": {
        "en": "No daily event count is provided to this Desktop", "th": "Desktop ไม่ได้รับจำนวนเหตุการณ์รายวัน",
        "zh": "本 Desktop 未获得每日事件数量",
    },
    "overview.banner_unavailable_title": {
        "en": "Incident Status Unavailable", "th": "ไม่ทราบสถานะเหตุการณ์", "zh": "事件状态不可用",
    },
    "overview.banner_unavailable_message": {
        "en": "No readable incident data source — the current incident status cannot be determined. This does not mean there are no incidents.",
        "th": "ไม่มีแหล่งข้อมูลเหตุการณ์ที่อ่านได้ — ยังสรุปสถานะเหตุการณ์ปัจจุบันไม่ได้ ไม่ได้หมายความว่าไม่มีเหตุการณ์",
        "zh": "没有可读取的事件数据源 — 暂时无法判断当前事件状态。这并不表示没有事件。",
    },
    "overview.banner_none_found_title": {
        "en": "No Events Found", "th": "ไม่พบเหตุการณ์ในแหล่งข้อมูล", "zh": "未发现事件",
    },
    "overview.banner_decisions_title": {
        "en": "Core Decisions Recorded", "th": "มีการตัดสินใจของ Core ที่บันทึกไว้", "zh": "Core 已记录决策",
    },
    "overview.banner_decisions_message": {
        "en": "Highest level: {level}. Open the Incidents page for details.",
        "th": "ระดับสูงสุด: {level} — ดูรายละเอียดที่หน้าเหตุการณ์",
        "zh": "最高级别：{level}。详情请查看“事件”页面。",
    },
    "devices.field.broker": {"en": "MQTT broker", "th": "โบรกเกอร์ MQTT", "zh": "MQTT 代理"},
    "devices.field.device": {"en": "ESP32 presence", "th": "การเชื่อมต่อ ESP32", "zh": "ESP32 在线状态"},
    "devices.field.freshness": {"en": "Evidence freshness", "th": "ความสดของหลักฐาน", "zh": "证据新鲜度"},
    "devices.field.timestamp": {"en": "Last evidence", "th": "หลักฐานล่าสุด", "zh": "最新证据时间"},
    "devices.field.rssi": {"en": "Wi-Fi signal (RSSI)", "th": "สัญญาณ Wi-Fi (RSSI)", "zh": "Wi-Fi 信号（RSSI）"},
    "devices.field.heap": {"en": "Free heap", "th": "หน่วยความจำ heap ที่ว่าง", "zh": "可用堆内存"},
    "lockdown.field.armed": {
        "en": "Armed state", "th": "สถานะพร้อมทำงาน", "zh": "布防状态",
    },
    "lockdown.field.dispatch": {
        "en": "Dispatch state", "th": "สถานะการส่งคำสั่ง", "zh": "命令分发状态",
    },
    "lockdown.field.auto_contain": {
        "en": "Automatic containment", "th": "การกักกันอัตโนมัติ", "zh": "自动遏制",
    },
    "lockdown.field.software_containment": {
        "en": "Software containment", "th": "การกักกันด้วยซอฟต์แวร์", "zh": "软件遏制",
    },
    "lockdown.control.cut_reason": {
        "en": "CUT requests remain Core-authenticated and require an operator reason.",
        "th": "คำขอ CUT ยังต้องผ่านการยืนยันของ Core และระบุเหตุผลโดยผู้ปฏิบัติงาน",
        "zh": "CUT 请求仍由 Core 认证，并要求操作员填写原因。",
    },
    "lockdown.control.restore_reason": {
        "en": "RESTORE remains separately authorized and never runs automatically.",
        "th": "RESTORE ต้องได้รับอนุญาตแยกต่างหากและจะไม่ทำงานอัตโนมัติ",
        "zh": "RESTORE 仍需单独授权，且绝不会自动执行。",
    },
    "diagnostics.containment": {
        "en": "Containment helper", "th": "ตัวช่วยกักกัน (containment helper)", "zh": "遏制助手",
    },
    "diagnostics.containment_blocks": {
        "en": "Active software blocks", "th": "การบล็อกทางซอฟต์แวร์ที่ใช้งานอยู่", "zh": "当前生效的软件封锁数",
    },
    # Diagnostics redesign (health-dashboard groups, field labels and verified-accurate one-line meanings).
    # Every meaning below is checked against aegis_soc/observer.py's actual state sets and the pinned
    # gui.py's own documented status logic before being written -- see the task's requirement to verify,
    # never guess. State codes (RUNNING, SYNCED, FRESH, TRUE/FALSE, HEALTHY, ...) are never translated.
    "diagnostics.health.title": {"en": "OVERALL HEALTH", "th": "สรุปสุขภาพโดยรวม", "zh": "整体健康状态"},
    "diagnostics.health.normal": {"en": "NORMAL", "th": "ปกติ", "zh": "正常"},
    "diagnostics.health.normal_detail": {
        "en": "Every checked item below is in its expected state.",
        "th": "ทุกรายการที่ตรวจสอบด้านล่างอยู่ในสถานะปกติ", "zh": "下方每一项检查均处于预期状态。"},
    "diagnostics.health.attention": {"en": "NEEDS ATTENTION", "th": "ต้องดู", "zh": "需要关注"},
    "diagnostics.group.core": {"en": "CORE", "th": "ระบบหลัก (Core)", "zh": "核心系统"},
    "diagnostics.group.time_evidence": {"en": "TIME & EVIDENCE", "th": "เวลา & หลักฐาน", "zh": "时间与证据"},
    "diagnostics.group.containment": {"en": "CONTAINMENT", "th": "การกักกัน (Containment)", "zh": "遏制"},
    "diagnostics.group.audit": {"en": "AUDIT HISTORY", "th": "ประวัติการตรวจสอบ", "zh": "审计历史"},
    "diagnostics.field.runtime": {"en": "Runtime state", "th": "สถานะการทำงาน", "zh": "运行状态"},
    "diagnostics.field.runtime_meaning": {
        "en": "The Core's current state -- normal is RUNNING; anything else means starting up, degraded, or locked down.",
        "th": "สถานะปัจจุบันของ Core — ปกติคือ RUNNING ค่าอื่นหมายถึงกำลังเริ่มระบบ ทำงานบกพร่อง หรืออยู่ในโหมดล็อกดาวน์",
        "zh": "Core 当前的状态——正常为 RUNNING，其他值表示正在启动、运行异常或处于锁定状态。"},
    "diagnostics.field.profile": {"en": "Profile", "th": "โปรไฟล์", "zh": "配置"},
    "diagnostics.field.profile_meaning": {
        "en": "Which environment the Core is running as (lab/production/development) -- informational, not a health check.",
        "th": "สภาพแวดล้อมที่ Core กำลังรันอยู่ (lab/production/development) เป็นข้อมูลบอกบริบท ไม่ใช่ค่าสุขภาพ",
        "zh": "Core 所运行的环境（lab/production/development）——仅供参考，不是健康检查项。"},
    "diagnostics.field.dry_run": {"en": "Dry-run", "th": "โหมดทดสอบ (Dry-run)", "zh": "演练模式"},
    "diagnostics.field.dry_run_meaning": {
        "en": "TRUE: commands are only simulated, nothing is really cut. The expected value in live use is FALSE.",
        "th": "TRUE = คำสั่งจะถูกจำลองเท่านั้น ไม่มีการตัดสายจริง — ค่าที่ควรเป็นเมื่อใช้งานจริงคือ FALSE",
        "zh": "TRUE 表示命令仅为模拟，不会真正执行切断；实际使用时应为 FALSE。"},
    "diagnostics.field.auto_contain": {"en": "AUTO_CONTAIN mode", "th": "บล็อก IP อัตโนมัติ (AUTO_CONTAIN)", "zh": "自动遏制（AUTO_CONTAIN）"},
    "diagnostics.field.auto_contain_meaning": {
        "en": "TRUE: the Core auto-blocks a high-severity attacker's IP by software. Recommended to stay on (TRUE).",
        "th": "TRUE = ระบบจะบล็อก IP ของผู้โจมตีด้วยซอฟต์แวร์โดยอัตโนมัติเมื่อภัยคุกคามสูง — แนะนำให้เปิดไว้ (TRUE)",
        "zh": "TRUE 表示当威胁等级较高时，Core 会通过软件自动封锁攻击者 IP；建议保持开启（TRUE）。"},
    "diagnostics.field.trusted_time": {"en": "Trusted time", "th": "เวลาที่เชื่อถือได้", "zh": "可信时间"},
    "diagnostics.field.trusted_time_meaning": {
        "en": "The Core clock's sync state -- normal is SYNCED; HOLDOVER/UNTRUSTED means it cannot currently be trusted.",
        "th": "สถานะการซิงก์นาฬิกาของ Core — ปกติคือ SYNCED ส่วน HOLDOVER/UNTRUSTED หมายถึงเวลาปัจจุบันเชื่อถือไม่ได้เต็มที่",
        "zh": "Core 时钟的同步状态——正常为 SYNCED；HOLDOVER/UNTRUSTED 表示当前时间不完全可信。"},
    "diagnostics.field.freshness": {"en": "Evidence freshness", "th": "ความสดของหลักฐาน", "zh": "证据新鲜度"},
    "diagnostics.field.freshness_meaning": {
        "en": "How current this read evidence is -- normal is FRESH; anything else means the Core's status could not be read cleanly just now.",
        "th": "ความใหม่ของข้อมูลที่อ่านได้ตอนนี้ — ปกติคือ FRESH ค่าอื่นหมายถึงอ่านสถานะของ Core ไม่ได้อย่างสมบูรณ์ในขณะนี้",
        "zh": "本次读取证据的新鲜程度——正常为 FRESH，其他值表示当前无法完整读取 Core 的状态。"},
    "diagnostics.field.timestamp": {"en": "Evidence timestamp", "th": "เวลาบันทึกล่าสุด", "zh": "证据时间戳"},
    "diagnostics.field.timestamp_meaning": {
        "en": "When the Core last wrote this status document, shown in local Desktop time.",
        "th": "เวลาที่ Core เขียนสถานะชุดนี้ล่าสุด แสดงตามเวลาท้องถิ่นของเครื่อง Desktop",
        "zh": "Core 最近一次写入此状态文档的时间，按 Desktop 本地时间显示。"},
    "diagnostics.field.containment": {"en": "Containment helper", "th": "ตัวช่วยกักกัน", "zh": "遏制助手"},
    "diagnostics.field.containment_meaning": {
        "en": "The automatic IP-blocking helper's own status -- HEALTHY means it answered normally; NOT_CONFIGURED means this host has no socket set up; UNAVAILABLE means it failed to answer.",
        "th": "สถานะของบริการบล็อก IP อัตโนมัติเอง — HEALTHY คือตอบกลับปกติ, NOT_CONFIGURED คือเครื่องนี้ยังไม่ได้ตั้งค่า, UNAVAILABLE คือเรียกใช้งานไม่สำเร็จ",
        "zh": "自动封锁 IP 助手自身的状态——HEALTHY 表示应答正常，NOT_CONFIGURED 表示本机尚未配置，UNAVAILABLE 表示调用失败。"},
    "diagnostics.field.containment_blocks": {"en": "Active software blocks", "th": "จำนวน IP ที่บล็อกอยู่", "zh": "当前封锁的 IP 数"},
    "diagnostics.field.containment_blocks_meaning": {
        "en": "How many IPs the containment helper is currently blocking by software right now.",
        "th": "จำนวน IP ที่ตัวช่วยกักกันกำลังบล็อกด้วยซอฟต์แวร์อยู่ ณ ขณะนี้",
        "zh": "遏制助手当前通过软件正在封锁的 IP 数量。"},
    "diagnostics.field.containment_blocks_unknown": {
        "en": "UNKNOWN: the containment helper did not answer, so the number of blocked IPs cannot be stated. This is not zero.",
        "th": "ไม่ทราบ: ตัวช่วยกักกันไม่ตอบกลับ จึงยืนยันจำนวน IP ที่บล็อกอยู่ไม่ได้ — ไม่ได้หมายความว่าเป็นศูนย์",
        "zh": "未知：遏制助手未应答，因此无法确认被封锁的 IP 数量。这并不表示为零。"},
    "diagnostics.field.audit": {"en": "Audit/database history", "th": "ประวัติการตรวจสอบ", "zh": "审计/数据库历史"},
    "diagnostics.field.audit_meaning": {
        "en": "The most recent records readable from the Core's own audit database (reasons and secrets are never shown).",
        "th": "จำนวนรายการล่าสุดที่อ่านได้จากฐานข้อมูลตรวจสอบ (audit) ของ Core เอง (ไม่แสดงเหตุผลหรือรหัสลับ)",
        "zh": "从 Core 自身审计数据库中可读取到的最新记录（从不显示原因或密钥）。"},
}


def register_observer_strings(i18n_module) -> None:
    """Add the strings above to the purple i18n table; a key that already exists is never replaced."""
    for key, entry in OBSERVER_STRINGS.items():
        i18n_module.STRINGS.setdefault(key, dict(entry))


def containment_status():
    """Read-only containment helper status as ``(status_text, blocked_ips)``.

    Issues only ``op=list`` over the configured Unix socket (``AEGIS_CONTAINMENT_SOCKET``) — the same read
    ``collect-evidence.sh`` already performs — and never ``block``/``unblock``. Fails closed: a missing
    socket configuration, an unreachable helper, or a malformed reply is reported as a value; this never
    raises, so a Diagnostics/Recovery page render can never crash on it."""
    socket_path = os.environ.get(containment.SOCKET_ENV, "").strip()
    if not socket_path:
        return CONTAINMENT_NOT_CONFIGURED, []
    try:
        response = containment.ContainmentClient().list()
    except Exception as error:  # the helper, its socket, or the OS can fail in many ways; never crash the page
        return f"UNAVAILABLE — {type(error).__name__}", []
    if not isinstance(response, dict) or response.get("ok") is not True or response.get("operation") != "list":
        reason = response.get("reason_code") if isinstance(response, dict) else "MALFORMED_RESPONSE"
        return f"UNAVAILABLE — {reason or 'MALFORMED_RESPONSE'}", []
    blocked = response.get("blocked")
    if not isinstance(blocked, list):
        return "UNAVAILABLE — MALFORMED_RESPONSE", []
    return CONTAINMENT_HEALTHY, [str(ip) for ip in blocked][:CONTAINMENT_BLOCKED_CAP]


def blocked_count_text(status_text, blocked):
    """The blocked-IP count for display: only a HEALTHY helper that really answered ``op=list`` has a count (an empty
    list is then a true "0"); UNAVAILABLE / NOT_CONFIGURED / failed reads carry ``[]`` and must read UNKNOWN, not "0"."""
    return str(len(blocked)) if status_text == CONTAINMENT_HEALTHY else "UNKNOWN"


class LiveMQTT:
    """Non-transport object exposing only the real GUI's read accessor."""

    def __init__(self):
        self.last_attacker_ip = None
        self.protocol = None
        self.device_state = reader.UNKNOWN
        self.start_calls = 0
        self.connect_calls = 0
        self.publish_calls = 0

    def seconds_since_device(self):
        if self.device_state == "ONLINE":
            return 0.0
        if self.device_state == "OFFLINE":
            return 999999.0
        return None

    def start(self):
        self.start_calls += 1
        raise AssertionError("live observer attempted MQTT startup")

    def connect(self, *args, **kwargs):
        self.connect_calls += 1
        raise AssertionError("live observer attempted an MQTT connection")

    def publish(self, *args, **kwargs):
        self.publish_calls += 1
        raise AssertionError("live observer attempted MQTT publication")

    def stop(self):
        return None


class LiveController:
    def __init__(self):
        self.issue_calls = 0

    def issue(self, *args, **kwargs):
        self.issue_calls += 1
        raise AssertionError("live observer attempted a control-plane command")


def _install_database_isolation() -> None:
    """Prevent the operational GUI from opening or writing any database."""

    module = ModuleType("aegis_soc.database")
    module.INFO = "INFO"
    module.WARN = "WARN"
    module.CRITICAL = "CRITICAL"
    module.init_db = lambda: None
    module.log_event = lambda *args, **kwargs: None
    module.log_to_file_only = lambda *args, **kwargs: None
    module.fetch_incidents = lambda **kwargs: []
    module.fetch_all_logs = list
    module.get_open_incident = lambda: None
    module.count_incidents_today = lambda: 0
    module.create_incident = lambda *args, **kwargs: None
    module.verify_chain = lambda: (False, "NOT_AVAILABLE")
    sys.modules["aegis_soc.database"] = module


def _format_evidence_timestamp(raw):
    """A Core evidence timestamp (a unix epoch float, or UNKNOWN) as a human-readable local date-time.
    Anything that cannot be parsed as a real timestamp falls back to UNKNOWN rather than showing it raw."""
    if raw == reader.UNKNOWN:
        return reader.UNKNOWN
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(raw)))
    except (TypeError, ValueError, OverflowError, OSError):
        return reader.UNKNOWN


def evidence_values(evidence):
    """Return only display values from the bounded evidence projection."""

    if not evidence.valid:
        return {
            "runtime": reader.UNKNOWN,
            "profile": reader.UNKNOWN,
            "broker": reader.UNKNOWN,
            "device": reader.UNKNOWN,
            "uplink": reader.UNKNOWN,
            "armed": reader.UNKNOWN,
            "dispatch": reader.UNKNOWN,
            "trusted_time": reader.UNKNOWN,
            "dry_run": reader.UNKNOWN,
            "auto_contain": reader.UNKNOWN,
            "freshness": evidence.freshness,
            "timestamp": reader.UNKNOWN,
        }
    return {
        "runtime": evidence.runtime_state,
        "profile": evidence.profile,
        "broker": evidence.broker,
        "device": evidence.device,
        "uplink": evidence.uplink,
        "armed": evidence.armed,
        "dispatch": evidence.dispatch,
        "trusted_time": evidence.trusted_time,
        "dry_run": evidence.dry_run,
        "auto_contain": evidence.auto_contain,
        "freshness": evidence.freshness,
        "timestamp": _format_evidence_timestamp(evidence.evidence_timestamp),
    }


def _status(gui, value):
    if value in {"CONNECTED", "ONLINE", "SYNCED", "NORMAL", "RUNNING", "ACTIVE", "FRESH", "FALSE"}:
        return gui.pres.STATUS_HEALTHY
    if value in {"DISCONNECTED", "OFFLINE", "FAILED"}:
        return gui.pres.STATUS_CRITICAL
    if value in {"LOCKDOWN", "ARMED", "DISARMED", "HOLDOVER", "STALE", "UNAVAILABLE", "NOT_VERIFIED", "NOT_AVAILABLE"}:
        return gui.pres.STATUS_WARNING
    return gui.pres.STATUS_UNKNOWN


def _live_gui_class(gui):
    PreviewBase = _preview_gui_class(gui)

    class LivePurpleObserverGUI(PreviewBase):
        live_observer = True

        def __init__(self, root, mqtt_manager, command_controller, *, status_path, max_age_seconds):
            self._status_path = Path(status_path)
            self._max_age_seconds = max_age_seconds
            self.latest = reader.ObserverEvidence(False, "UNAVAILABLE", "Core evidence not read")
            self._observer_page = None
            self._evidence_section_snapshot_value = None
            self._settings_feedback_key = None
            super().__init__(root, mqtt_manager, command_controller=command_controller)
            self.root.title(LIVE_TITLE)

        # -- scroll-position preservation, shared by every launcher built on this class (observer, incident,
        # cut, control): a periodic refresh that destroys and rebuilds part or all of a ScrollFrame-based
        # page would otherwise reset the operator's scroll position to the top on every rebuild.
        def _scroll_yview(self, anchor):
            """The enclosing ScrollFrame and its current vertical view fraction, from any widget inside it
            (the same ``_aegis_scroll_frame`` lookup the accepted mouse-wheel dispatcher already uses) --
            or None when there is no anchor, no enclosing ScrollFrame, or its canvas is already gone."""
            if anchor is None:
                return None
            frame = gui.ui_theme._scroll_frame_at(anchor)
            if frame is None or not frame.canvas.winfo_exists():
                return None
            return frame, frame.canvas.yview()[0]

        def _restore_scroll_yview(self, saved):
            if saved is None:
                return
            frame, position = saved
            # The rebuild only *schedules* the inner frame's <Configure> handler that recomputes the canvas
            # scrollregion (theme.ScrollFrame binds it, and Tk defers it to the next idle pass); without
            # flushing it here first, yview_moveto() below runs against the stale pre-rebuild scrollregion,
            # and the real recompute -- which fires later, during whatever root.update() the caller does
            # next -- then reinterprets that position against the new scrollregion and silently throws the
            # restore away. Flushing first fixes the ordering.
            frame.canvas.update_idletasks()
            if frame.canvas.winfo_exists():
                frame.canvas.yview_moveto(position)

        def _workspace_scroll_frame(self):
            """The page's ScrollFrame instance currently in self.workspace (_new_page's sole child there), or
            None. ``_scroll_yview``'s ``_aegis_scroll_frame`` lookup is set on the ScrollFrame's *canvas*, a
            child of it, not on the ScrollFrame object itself -- so it must be reached through ``.inner``
            (also a child of that canvas), never by passing the ScrollFrame object directly."""
            children = self.workspace.winfo_children()
            if not children or not hasattr(children[0], "inner"):
                return None
            return children[0]

        def _workspace_scroll_fraction(self):
            """The scroll fraction of whichever ScrollFrame-based page is currently in self.workspace, or
            None. Used around a full self._show_page(...) rebuild (which replaces the page's ScrollFrame
            object entirely, not just a body's children), where the _scroll_yview anchor used before the
            rebuild would itself be destroyed, so only the plain fraction -- not the (now dead) frame
            reference -- can be carried across to _restore_workspace_scroll_fraction after it."""
            scroll = self._workspace_scroll_frame()
            saved = self._scroll_yview(scroll.inner) if scroll is not None else None
            return None if saved is None else saved[1]

        def _restore_workspace_scroll_fraction(self, fraction):
            if fraction is None:
                return
            scroll = self._workspace_scroll_frame()
            if scroll is None:
                return
            frame = gui.ui_theme._scroll_frame_at(scroll.inner)
            if frame is None or not frame.canvas.winfo_exists():
                return
            frame.canvas.update_idletasks()
            frame.canvas.yview_moveto(fraction)

        def _emit_startup_warnings(self):
            return None

        def _on_authenticated(self):
            self._refresh_live_evidence()
            super()._on_authenticated()
            self._refresh_header_evidence()   # the pinned shell just built its chips from local state, not from the evidence
            self.root.title(LIVE_TITLE)
            self._schedule_evidence_poll()

        def _rebuild_ui(self):
            result = super()._rebuild_ui()   # a language/theme change rebuilds the shell and resets the chips again
            if self.session.authenticated:
                self._refresh_header_evidence()
            return result

        def _show_page(self, key):
            if key != "settings":
                self._settings_feedback_key = None
            result = super()._show_page(key)
            self._apply_environment_badge()
            return result

        def _environment_badge_state(self):
            """``(text, status, show_dry_run_note)`` for the page-header environment badge, from the Core's own
            reported ``profile`` and ``dry_run``. The pinned badge reads this Desktop process's local AEGIS_DRY_RUN
            flag and otherwise says LIVE (green), which would claim live/production operation whatever the Core
            reports. Live *data* is not production *readiness*: the profile code is shown as reported, never green."""
            values = evidence_values(self.latest)
            profile = values["profile"]
            if profile == reader.UNKNOWN:
                return reader.UNKNOWN, gui.pres.STATUS_UNKNOWN, False
            if values["dry_run"] == "TRUE":
                return f"{profile.upper()} · {gui.i18n.t('status.dry_run')}", gui.pres.STATUS_WARNING, True
            return profile.upper(), gui.pres.STATUS_NEUTRAL, False

        def _apply_environment_badge(self):
            """Correct the built PageHeader badge(s) in place; only touches a badge whose text differs, so a refresh
            tick never rebuilds or flickers anything."""
            workspace = getattr(self, "workspace", None)
            if workspace is None or not workspace.winfo_exists():
                return
            text, status, show_note = self._environment_badge_state()
            note_text = gui.i18n.t("overview.dry_run_note")

            def walk(widget):
                for child in widget.winfo_children():
                    yield child
                    yield from walk(child)

            for header in [w for w in walk(workspace) if isinstance(w, gui.ui_theme.PageHeader)]:
                for part in list(walk(header)):   # materialised first: a note may be destroyed while we go
                    if not part.winfo_exists():
                        continue
                    if isinstance(part, gui.ui_theme.StatusBadge) and part._label.cget("text") != text:
                        part.update_status(text, status)
                    elif part.winfo_class() == "Label" and part.cget("text") == note_text and not show_note:
                        part.destroy()   # the pinned note is tied to the local flag, not to what the Core reports

        def _set_language(self, code):
            # The pinned callback still owns persistence and the full UI rebuild. This flag merely lets the
            # rebuilt Settings page acknowledge that completed action in the newly selected language.
            self._settings_feedback_key = "settings.feedback.language"
            return super()._set_language(code)

        def _set_theme(self, name):
            # Keep theme_state, palette synchronization and dialog restyling entirely in the pinned callback.
            self._settings_feedback_key = "settings.feedback.theme"
            return super()._set_theme(name)

        def _schedule_evidence_poll(self):
            if self.root.winfo_exists():
                self.root.after(EVIDENCE_POLL_MS, self._poll_evidence)

        def _poll_evidence(self):
            if self.session.authenticated:
                self._refresh_live_evidence()
            self._schedule_evidence_poll()

        def _evidence_page_key(self):
            """What the evidence-built pages show. The ever-changing timestamp is left out, so a page is rebuilt only on a real change."""
            return tuple(sorted((key, value) for key, value in evidence_values(self.latest).items() if key != "timestamp"))

        def _refresh_live_evidence(self):
            previous_page_key = self._evidence_page_key()
            self.latest = reader.read_observer_status(
                self._status_path,
                max_age_seconds=self._max_age_seconds,
            )
            self.mqtt.device_state = self.latest.device if self.latest.valid else reader.UNKNOWN
            self._broker_connected = (
                True if self.latest.broker == "CONNECTED" and self.latest.valid
                else False if self.latest.broker == "DISCONNECTED" and self.latest.valid
                else None
            )
            self._last_uplink_state = self.latest.uplink if self.latest.valid else None
            self._last_rssi = None
            self._last_heap = None
            self.armed = self.latest.armed == "ARMED" if self.latest.valid else False
            self._refresh_overview_metrics()
            self._refresh_header_evidence()
            if self._observer_page is not None and self._observer_page.winfo_exists():
                self._render_evidence_section()
            # The Devices and Lockdown pages are built once from the evidence at the time they are shown. Without this, a page that is
            # open while the Core stops updating would keep showing the last uplink and device state as if it were current.
            # Already skip-aware (the key comparison above excludes the ever-changing timestamp, so this only runs on a real
            # evidence change); it previously reset the operator's scroll position to the top on every such change, since
            # _show_page rebuilds the whole page's ScrollFrame, not just a body's children -- preserved below.
            shown = getattr(self, "active_page", None)
            if shown in STATIC_EVIDENCE_PAGES and self.session.authenticated and self._evidence_page_key() != previous_page_key:
                fraction = self._workspace_scroll_fraction()
                self._show_page(shown)
                self._restore_workspace_scroll_fraction(fraction)

        def _refresh_header_evidence(self):
            values = evidence_values(self.latest)
            if hasattr(self, "badge_mode") and self.badge_mode.winfo_exists():
                self.badge_mode.update_status(values["armed"], _status(gui, values["armed"]))
            if hasattr(self, "badge_broker") and self.badge_broker.winfo_exists():
                self.badge_broker.update_status("MQTT: " + values["broker"], _status(gui, values["broker"]))
            if hasattr(self, "badge_esp32") and self.badge_esp32.winfo_exists():
                self.badge_esp32.update_status("ESP32: " + values["device"], _status(gui, values["device"]))

        def _refresh_overview_metrics(self):
            if not self.session.authenticated:
                return
            design.ensure_fonts(self.root)
            values = evidence_values(self.latest)
            metrics = {
                "health": values["runtime"],
                "uplink": values["uplink"],
                "broker": values["broker"],
                "esp32": values["device"],
                "mode": values["armed"],
                "deadman": "NOT_AVAILABLE",
                "incidents": "NOT_AVAILABLE",
                "today": "NOT_AVAILABLE",
            }
            t = gui.i18n.t
            # These three are never supplied to this Desktop, so each says what is missing; the shared
            # "evidence is fresh and consistent" reason describes the Core document, not these metrics.
            own_notes = {"deadman": t("overview.metric.deadman_note"), "incidents": t("overview.metric.incidents_note"),
                         "today": t("overview.metric.today_note")}
            for key, value in metrics.items():
                card = self.metric_cards.get(key)
                if card is not None and card.winfo_exists():
                    helper = own_notes.get(key) or (self.latest.reason if value in {reader.UNKNOWN, "NOT_AVAILABLE"} else "Core-reported evidence")
                    card.update(value, _status(gui, value), helper)
                    # A long state code at the full metric size is cut off on a 4-across card at 1366 px
                    # ("NOT_AVAILABL"): use the compact size for it, only when the font actually differs.
                    wanted = design.font("metric_compact") if len(value) > 10 else gui.ui_theme.FONT_METRIC_VALUE
                    if str(card._value_label.cget("font")) != str(wanted):
                        card._value_label.config(font=wanted)
            self._apply_environment_badge()

        def _incident_banner_state(self):
            """``(state, highest_level)`` for the Overview banner. The pinned banner reads the open-incident table,
            which this Desktop isolates (always None), so "No Active Incidents" would be shown whatever the truth is.
            Without a readable incident source the honest state is "unavailable"; the control Desktop overrides this
            with the Core's graduated projection."""
            return "unavailable", None

        def _refresh_incident_banner_widget(self):
            if not hasattr(self, "incident_banner_slot") or not self.incident_banner_slot.winfo_exists():
                return
            t = gui.i18n.t
            state, level = self._incident_banner_state()
            snapshot = (state, level, gui.i18n.get_language())
            if snapshot == getattr(self.incident_banner_slot, "_aegis_banner_snapshot", None) and self.incident_banner_slot.winfo_children():
                return   # unchanged: no destroy/rebuild per refresh tick
            self.incident_banner_slot._aegis_banner_snapshot = snapshot
            for child in self.incident_banner_slot.winfo_children():
                child.destroy()
            if state == "decisions":
                title, message = t("overview.banner_decisions_title"), t("overview.banner_decisions_message", level=level)
            elif state == "none_found":
                title, message = t("overview.banner_none_found_title"), f"{t('incidents.empty.title')} {t('incidents.empty.valid_note')}"
            else:
                title, message = t("overview.banner_unavailable_title"), t("overview.banner_unavailable_message")
            section = gui.Section(self.incident_banner_slot, title)
            section.pack(fill="x")
            gui.EmptyState(section.body, "", message, compact=True).pack(anchor="w")

        def _build_overview_page(self, parent):
            super()._build_overview_page(parent)
            scroll = next(child for child in parent.winfo_children() if hasattr(child, "inner"))
            self._observer_page = scroll.inner
            # The pinned "Operational Summary"/"Recent Activity" sections have no override point to build
            # with design.style_section_title() directly; restyle their already-built title Labels in
            # place instead (border/divider/body/every fact row inside them untouched).
            design.ensure_fonts(self.root)
            design.restyle_section_titles(self._observer_page, gui=gui)
            # A fresh page (first show, or a reshow after navigating away and back) has no evidence section
            # of its own yet, regardless of what the last rendered snapshot was for the previous instance of
            # this page -- so that stale value must not make the render below skip building this one's.
            self._evidence_section_snapshot_value = None
            self._render_evidence_section()

        def _evidence_section_snapshot(self):
            """Everything _render_evidence_section shows, read-only -- no widget touched. Compared on every
            tick (see _render_evidence_section) so the section is rebuilt only when this actually changes,
            the same no-flicker pattern used elsewhere. "Evidence timestamp" is itself one of the displayed
            rows here (unlike Recovery/Incidents/Audit, which never show the raw Core timestamp), so it
            stays part of the comparison on purpose: while the Core keeps writing a fresh one, this section
            keeps refreshing to show it, which is the intended clock-like behavior, not leftover flicker."""
            values = evidence_values(self.latest)
            t = gui.i18n.t
            rows = tuple(
                (t(label_key), values[key], _status(gui, values[key]))
                for label_key, key in (
                    ("diagnostics.field.runtime", "runtime"), ("diagnostics.field.profile", "profile"),
                    ("devices.field.broker", "broker"), ("devices.field.device", "device"),
                    ("devices.field.reported_uplink", "uplink"), ("lockdown.field.armed", "armed"),
                    ("lockdown.field.dispatch", "dispatch"), ("diagnostics.field.trusted_time", "trusted_time"),
                    ("devices.field.freshness", "freshness"), ("devices.field.timestamp", "timestamp"),
                )
            )
            return rows + (
                (t("devices.field.physical_relay"), self.latest.physical_observation, gui.pres.STATUS_UNKNOWN),
                (t("devices.physical.not_proven"), "OPERATOR OBSERVATION", gui.pres.STATUS_UNKNOWN),
                ("Python verification", "NOT_VERIFIED", gui.pres.STATUS_WARNING),
            )

        def _render_evidence_section(self):
            if self._observer_page is None or not self._observer_page.winfo_exists():
                return
            snapshot = self._evidence_section_snapshot()
            if snapshot == self._evidence_section_snapshot_value:
                return
            self._evidence_section_snapshot_value = snapshot
            saved = self._scroll_yview(self._observer_page)
            if hasattr(self, "_observer_evidence_section") and self._observer_evidence_section.winfo_exists():
                self._observer_evidence_section.destroy()
            section = gui.Section(self._observer_page, gui.i18n.t("overview.live_evidence.section"))
            section.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(section)
            palette = gui.ui_theme.get_palette()
            # Same rows, same order, same values/colors as before -- just in two columns
            # (the pinned _reflow_columns fact-grid, the same responsive mechanism the
            # Recovery page's cause/attempts cards use) instead of one tall stack, so this
            # section is about half as high and needs far less scrolling to read.
            grid = tk.Frame(section.body, bg=section.body.cget("bg"))
            grid.pack(fill="x")
            half = (len(snapshot) + 1) // 2
            columns = []
            for rows in (snapshot[:half], snapshot[half:]):
                column = tk.Frame(grid, bg=grid.cget("bg"))
                for label, value, status in rows:
                    design.info_row(column, label, value, palette=palette, status=status)
                columns.append(column)
            self._reflow_columns(grid, columns)
            self._observer_evidence_section = section
            self._restore_scroll_yview(saved)

        def _build_devices_page(self, parent):
            page = self._new_page(parent, "devices.title", "devices.subtitle")
            design.ensure_fonts(self.root)
            palette = gui.ui_theme.get_palette()
            t = gui.i18n.t
            values = evidence_values(self.latest)

            summary = gui.Section(page, t("devices.summary.section"))
            summary.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(summary)
            for label_key, key in (("devices.field.broker", "broker"), ("devices.field.device", "device"),
                                   ("devices.field.reported_uplink", "uplink")):
                design.info_row(summary.body, t(label_key), values[key], palette=palette, status=_status(gui, values[key]))
            design.section_note(summary.body, t("devices.summary.note"), palette=palette).pack(
                fill="x", pady=(design.SPACE_SM, 0))

            columns = tk.Frame(page, bg=page.cget("bg"))
            columns.pack(fill="x", padx=16, pady=(0, 20))
            evidence = gui.Section(columns, t("devices.evidence.section"))
            design.style_section_title(evidence)
            for label_key, key in (("devices.field.heartbeat", "device"), ("devices.field.freshness", "freshness"),
                                   ("devices.field.timestamp", "timestamp")):
                design.info_row(evidence.body, t(label_key), values[key], palette=palette, status=_status(gui, values[key]))
            design.info_row(evidence.body, t("devices.field.rssi"), "NOT_AVAILABLE", palette=palette,
                            status=gui.pres.STATUS_WARNING)
            design.info_row(evidence.body, t("devices.field.heap"), "NOT_AVAILABLE", palette=palette,
                            status=gui.pres.STATUS_WARNING)
            design.section_note(evidence.body, t("devices.metrics.note"), palette=palette).pack(
                fill="x", pady=(design.SPACE_SM, 0))

            physical = gui.Section(columns, t("devices.physical_limit.section"), accent=gui.COLOR_WARN_HL)
            design.style_section_title(physical)
            design.info_row(physical.body, t("devices.field.reported_uplink"), values["uplink"], palette=palette,
                            status=_status(gui, values["uplink"]))
            design.info_row(physical.body, t("devices.field.physical_relay"), "NOT_VERIFIED", palette=palette,
                            status=gui.pres.STATUS_WARNING)
            design.section_note(physical.body, t("devices.physical.not_proven"), palette=palette).pack(
                fill="x", pady=(design.SPACE_SM, 0))
            design.section_note(physical.body, t("devices.physical.ack_note"), palette=palette).pack(
                fill="x", pady=(design.SPACE_SM, 0))
            self._reflow_columns(columns, (evidence, physical))

        def _build_lockdown_page(self, parent):
            page = self._new_page(parent, "lockdown.title", "lockdown.subtitle", badge=True)
            design.ensure_fonts(self.root)
            palette = gui.ui_theme.get_palette()
            t = gui.i18n.t
            section = gui.Section(page, t("lockdown.current.section"))
            section.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(section)
            values = evidence_values(self.latest)
            rows = [
                (label, values[key], _status(gui, values[key]))
                for label, key in (
                    (t("lockdown.field.armed"), "armed"), (t("devices.field.reported_uplink"), "uplink"),
                    (t("lockdown.field.dispatch"), "dispatch"), (t("lockdown.field.auto_contain"), "auto_contain"),
                    (t("devices.field.freshness"), "freshness"),
                )
            ]
            containment_state, _blocked = containment_status()
            rows.append((t("lockdown.field.software_containment"), containment_state,
                         gui.pres.STATUS_HEALTHY if containment_state == CONTAINMENT_HEALTHY else gui.pres.STATUS_WARNING))
            # Same rows, same order/values/colors as before -- two columns (the pinned _reflow_columns
            # fact-grid used on Recovery/Overview) instead of one tall stack, so this section is about
            # half as high. The page itself is already rebuilt whole on every evidence change and its
            # scroll position preserved by fraction (see _workspace_scroll_fraction), so this needs no
            # extra wiring: any resulting change is picked up by that existing mechanism automatically.
            grid = tk.Frame(section.body, bg=section.body.cget("bg"))
            grid.pack(fill="x")
            half = (len(rows) + 1) // 2
            columns = []
            for chunk in (rows[:half], rows[half:]):
                column = tk.Frame(grid, bg=grid.cget("bg"))
                for label, value, status in chunk:
                    design.info_row(column, label, value, palette=palette, status=status)
                columns.append(column)
            self._reflow_columns(grid, columns)
            controls = gui.Section(page, t("lockdown.controls.section"), accent=gui.COLOR_WARN_HL)
            controls.pack(fill="x", padx=16, pady=(0, 20))
            design.style_section_title(controls)
            design.section_note(
                controls.body, t("lockdown.controls.observer_note"), palette=palette,
            ).pack(fill="x", pady=(0, design.SPACE_MD))
            tk.Button(
                controls.body,
                text="CUT NETWORK — DISABLED",
                state=tk.DISABLED,
                font=gui.ui_theme.FONT_BTN,
                fg="white",
                bg=gui.ui_theme.COLOR_DANGER,
                disabledforeground=gui.ui_theme.COLOR_MUTED,
                bd=0,
                height=2,
            ).pack(fill="x", pady=(0, 6))
            design.info_row(
                controls.body,
                t("lockdown.control.cut_reason"),
                "DISABLED — no authorized Core-owned manual CUT request interface",
                palette=palette, status=gui.pres.STATUS_WARNING,
            )
            tk.Button(
                controls.body,
                text="RESTORE NETWORK — DISABLED",
                state=tk.DISABLED,
                font=gui.ui_theme.FONT_BTN,
                fg="white",
                bg=gui.ui_theme.COLOR_SUCCESS,
                disabledforeground=gui.ui_theme.COLOR_MUTED,
                bd=0,
                height=2,
            ).pack(fill="x", pady=(8, 6))
            design.info_row(
                controls.body,
                t("lockdown.control.restore_reason"),
                "DISABLED — owner-only D4 terminal Recovery; no live authorization",
                palette=palette, status=gui.pres.STATUS_WARNING,
            )

        def _build_unavailable_observer_page(self, parent, title_key, subtitle_key):
            page = self._new_page(parent, title_key, subtitle_key)
            section = gui.Section(page, "OBSERVER DATA AVAILABILITY")
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._add_fact(section.body, "Panel evidence", "NOT_AVAILABLE", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Operational actions", "DISABLED — observer mode", status=gui.pres.STATUS_WARNING)

        def _build_incidents_page(self, parent):
            self._build_unavailable_observer_page(parent, "incidents.title", "incidents.subtitle")

        def _build_recovery_page(self, parent):
            page = self._new_page(parent, "recovery.page_title", "recovery.page_subtitle")
            section = gui.Section(page, "RECOVERY READINESS — READ ONLY", accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._add_fact(section.body, "Recovery readiness", "BLOCKED", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Blocking condition", "D4 owner-only terminal Recovery; no live authorization", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "RESTORE NETWORK", "DISABLED — observer mode", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Attempt state", "NOT_CONSUMED — no attempt started by this observer", status=gui.pres.STATUS_UNKNOWN)
            gui.make_hint(section.body, "This page never stores D4 secrets, invokes Recovery, or creates a second authority path.").pack(anchor="w", pady=(8, 0))

        def _build_audit_page(self, parent):
            self._build_unavailable_observer_page(parent, "audit.title", "audit.subtitle")

        def _build_settings_page(self, parent):
            """Presentation-only settings layout; selector callbacks and persistence remain the pinned ones."""
            page = self._new_page(parent, "settings.title", "settings.subtitle")
            design.ensure_fonts(self.root)
            palette = gui.ui_theme.get_palette()
            t = gui.i18n.t
            if self._settings_feedback_key is not None:
                design.feedback_banner(
                    page, t(self._settings_feedback_key), palette=palette, status=gui.pres.STATUS_HEALTHY,
                ).pack(fill="x", padx=16, pady=(0, design.SPACE_MD))
            grid = tk.Frame(page, bg=page.cget("bg"))
            grid.pack(fill="x", padx=16, pady=(0, 20))

            preferences = gui.Section(grid, t("settings.preferences_title"))
            design.style_section_title(preferences)
            language_row = tk.Frame(preferences.body, bg=preferences.body.cget("bg"))
            language_row.pack(fill="x", pady=(0, design.SPACE_MD))
            tk.Label(language_row, text=t("settings.language.label"), font=design.font("body"),
                     fg=palette.text, bg=language_row.cget("bg"), anchor="w", justify="left").pack(side="left", fill="x", expand=True)
            language_control = tk.Frame(language_row, bg=language_row.cget("bg"))
            language_control.pack(side="right")
            self._build_language_selector(language_control)

            theme_row = tk.Frame(preferences.body, bg=preferences.body.cget("bg"))
            theme_row.pack(fill="x")
            tk.Label(theme_row, text=t("settings.theme.label"), font=design.font("body"),
                     fg=palette.text, bg=theme_row.cget("bg"), anchor="w", justify="left").pack(side="left", fill="x", expand=True)
            theme_control = tk.Frame(theme_row, bg=theme_row.cget("bg"))
            theme_control.pack(side="right")
            self._build_theme_selector(theme_control)
            design.section_note(preferences.body, t("settings.autosave.note"), palette=palette).pack(
                fill="x", pady=(design.SPACE_MD, 0))

            session = gui.Section(grid, t("settings.session_title"))
            design.style_section_title(session)
            design.info_row(session.body, t("settings.admin_id"), self.session.admin_id or "—", palette=palette)
            signed_in = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.session.authenticated_at or 0))
            design.info_row(session.body, t("settings.signed_in"), signed_in, palette=palette)

            about = gui.Section(grid, t("settings.about_title"))
            design.style_section_title(about)
            design.info_row(about.body, t("settings.product"), "AEGIS IDEA3", palette=palette)
            design.section_note(about.body, t("settings.about_text"), palette=palette).pack(
                fill="x", pady=(design.SPACE_SM, 0))
            self._reflow_columns(grid, (preferences, session, about))

        def _diagnostics_audit_row(self):
            """(value, status) for the Diagnostics "Database / audit history" row. The pure observer has no audit
            source at all; a subclass with one (the control Desktop) overrides this to read it the same way the
            Recovery/Audit pages already do, instead of a second, inconsistent hardcoded placeholder."""
            return "NOT_AVAILABLE — observer mode", gui.pres.STATUS_WARNING

        def _diagnostics_health(self, values, audit_value):
            """(is_normal, issues) for the health-summary card -- every rule verified against the real
            field semantics (aegis_soc/observer.py's state sets; the pinned gui.py's own documented
            DRY_RUN/AUTO_CONTAIN status logic; containment_status()'s own docstring) before being written,
            never guessed. When the evidence itself could not be read (freshness != FRESH), runtime/
            dry_run/auto_contain/trusted_time are all UNKNOWN placeholders too (see evidence_values), so
            only the one freshness issue is listed instead of repeating UNKNOWN five times."""
            t = gui.i18n.t
            issues = []
            if values["freshness"] != "FRESH":
                issues.append(f"{t('diagnostics.field.freshness')}: {values['freshness']}")
            else:
                if values["runtime"] != "RUNNING":
                    issues.append(f"{t('diagnostics.field.runtime')}: {values['runtime']}")
                if values["dry_run"] == "TRUE":
                    issues.append(t("diagnostics.field.dry_run"))
                if values["auto_contain"] == "FALSE":
                    issues.append(t("diagnostics.field.auto_contain"))
                if values["trusted_time"] != "SYNCED":
                    issues.append(f"{t('diagnostics.field.trusted_time')}: {values['trusted_time']}")
            status_text, _blocked = containment_status()
            if status_text != CONTAINMENT_HEALTHY:
                issues.append(f"{t('diagnostics.field.containment')}: {status_text}")
            if audit_value.startswith("NOT_AVAILABLE"):   # a genuinely unreadable source, not merely "0 records"
                issues.append(t("diagnostics.field.audit"))
            return not issues, issues

        def _build_diagnostics_page(self, parent):
            page = self._new_page(parent, "diagnostics.title", "diagnostics.subtitle")
            design.ensure_fonts(self.root)
            palette = gui.ui_theme.get_palette()
            t = gui.i18n.t
            values = evidence_values(self.latest)
            audit_value, audit_status = self._diagnostics_audit_row()
            status_text, blocked = containment_status()
            healthy_containment = status_text == CONTAINMENT_HEALTHY
            is_normal, issues = self._diagnostics_health(values, audit_value)

            # 1. Overall health summary -- derived truthfully from the real states checked below; never
            # says normal when something is not (and always names what, by reusing the exact same labels
            # as the field rows further down).
            summary = gui.Section(page, t("diagnostics.health.title"), accent=None if is_normal else gui.COLOR_WARN_HL)
            summary.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(summary)
            design.severity_badge(
                summary.body, t("diagnostics.health.normal") if is_normal else t("diagnostics.health.attention"),
                palette=palette, status=gui.pres.STATUS_HEALTHY if is_normal else gui.pres.STATUS_WARNING,
            ).pack(anchor="w")
            if is_normal:
                tk.Label(summary.body, text=t("diagnostics.health.normal_detail"), anchor="w", justify="left",
                        font=design.font("note"), fg=palette.muted, bg=summary.body.cget("bg"),
                        ).pack(anchor="w", pady=(design.SPACE_SM, 0))
            else:
                for issue in issues:
                    tk.Label(summary.body, text="• " + issue, anchor="w", justify="left", wraplength=1100,
                            font=design.font("body"), fg=palette.text, bg=summary.body.cget("bg"),
                            ).pack(anchor="w", pady=(2, 0))

            # 2. The same fields, grouped into plain-Thai health cards with a verified one-line meaning
            # per field -- same values, same colors as the summary above was computed from; nothing
            # hidden, nothing reworded in the data itself.
            grid = tk.Frame(page, bg=page.cget("bg"))
            grid.pack(fill="x", padx=16, pady=(0, 20))

            core = gui.Section(grid, t("diagnostics.group.core"))
            design.style_section_title(core)
            design.explained_row(core.body, t("diagnostics.field.runtime"), values["runtime"],
                                 t("diagnostics.field.runtime_meaning"), palette=palette, status=_status(gui, values["runtime"]))
            design.explained_row(core.body, t("diagnostics.field.profile"), values["profile"],
                                 t("diagnostics.field.profile_meaning"), palette=palette, status=_status(gui, values["profile"]))
            design.explained_row(core.body, t("diagnostics.field.dry_run"), values["dry_run"],
                                 t("diagnostics.field.dry_run_meaning"), palette=palette, status=_status(gui, values["dry_run"]))
            design.explained_row(core.body, t("diagnostics.field.auto_contain"), values["auto_contain"],
                                 t("diagnostics.field.auto_contain_meaning"), palette=palette, status=_status(gui, values["auto_contain"]))

            time_card = gui.Section(grid, t("diagnostics.group.time_evidence"))
            design.style_section_title(time_card)
            design.explained_row(time_card.body, t("diagnostics.field.trusted_time"), values["trusted_time"],
                                 t("diagnostics.field.trusted_time_meaning"), palette=palette, status=_status(gui, values["trusted_time"]))
            design.explained_row(time_card.body, t("diagnostics.field.freshness"), values["freshness"],
                                 t("diagnostics.field.freshness_meaning"), palette=palette, status=_status(gui, values["freshness"]))
            design.explained_row(time_card.body, t("diagnostics.field.timestamp"), values["timestamp"],
                                 t("diagnostics.field.timestamp_meaning"), palette=palette, status=_status(gui, values["timestamp"]))

            containment_card = gui.Section(grid, t("diagnostics.group.containment"))
            design.style_section_title(containment_card)
            design.explained_row(containment_card.body, t("diagnostics.field.containment"), status_text,
                                 t("diagnostics.field.containment_meaning"), palette=palette,
                                 status=gui.pres.STATUS_HEALTHY if healthy_containment else gui.pres.STATUS_WARNING)
            design.explained_row(containment_card.body, t("diagnostics.field.containment_blocks"),
                                 blocked_count_text(status_text, blocked),
                                 t("diagnostics.field.containment_blocks_meaning" if healthy_containment
                                   else "diagnostics.field.containment_blocks_unknown"), palette=palette,
                                 status=gui.pres.STATUS_NEUTRAL if healthy_containment else gui.pres.STATUS_UNKNOWN)

            audit_card = gui.Section(grid, t("diagnostics.group.audit"))
            design.style_section_title(audit_card)
            design.explained_row(audit_card.body, t("diagnostics.field.audit"), audit_value,
                                 t("diagnostics.field.audit_meaning"), palette=palette, status=audit_status)

            self._reflow_columns(grid, (core, time_card, containment_card, audit_card))

        def _sync_arm_controls(self):
            return None

    return LivePurpleObserverGUI


def create_live_app(root, *, status_path=reader.STATUS_PATH, max_age_seconds=DESKTOP_MAX_AGE_SECONDS):
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("live observer must start without an imported aegis_soc package")
    sys.path.insert(0, str(PYTHONUI_ROOT))
    _install_import_isolation()
    _install_database_isolation()
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(str(PYTHONUI_ROOT)):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    register_observer_strings(gui.i18n)
    app_class = _live_gui_class(gui)
    mqtt = LiveMQTT()
    controller = LiveController()
    app = app_class(
        root,
        mqtt,
        controller,
        status_path=Path(status_path),
        max_age_seconds=max_age_seconds,
    )
    return app, SimpleNamespace(mqtt=mqtt, controller=controller)


def main():
    root = tk.Tk()
    app, _isolation = create_live_app(root)
    graceful_exit.install(root, app)
    root.mainloop()
    return app


if __name__ == "__main__":
    main()
