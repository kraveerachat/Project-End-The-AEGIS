"""Read-only view of the Core audit database for the Alerts panel and the Overview page. Never writes, never sends.

The Desktop must not import the real ``aegis_soc`` package, so ``comms.format_severity_alert`` and its i18n cannot be called
from here. Its small tables and ``tg.*`` strings are mirrored below, and tests/test_live_purple_audit_model.py fails if they drift.
"""

from __future__ import annotations

import os
import re
import sqlite3
import stat
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import quote
from zoneinfo import ZoneInfo

from tools import live_purple_core_records as records

BANGKOK = ZoneInfo("Asia/Bangkok")
ALERT_LIMIT = 20
ACTIVITY_LIMIT = 10
DETAILS_CHARS = 512
AWAITING_KIND = "REMOTE_CUT_AWAITING"
ALERT_KINDS = ("GRADUATED_LOW", "GRADUATED_MEDIUM", "GRADUATED_HIGH", "GRADUATED_CRITICAL")
ACTIVITY_KINDS = ALERT_KINDS + (
    AWAITING_KIND, "COMMAND_SENT", "CUT_PRE_DISPATCH", "CUT_REFUSED",
    "RESTORE_REQUESTED", "RESTORE_REFUSED", "RESTORE_AUTH_LOCKOUT",
)
_RANK = {kind: index for index, kind in enumerate(ALERT_KINDS)}
# Rows are written one after the other by RemoteResponse.observe(), so its awaiting row sits just after its decision.
_AWAITING_MAX_GAP = 3

# Mirrors of aegis_soc/comms.py and aegis_soc/graduated_response.py.
SEVERITY_ICON = {"MEDIUM": "🟡", "HIGH": "🟠", "CRITICAL": "🔴"}
ACTION_KEY = {
    "SOFTWARE_BLOCK": "tg.action.software_block",
    "RECOMMEND_CUT": "tg.action.recommend_cut",
    "AUTO_CUT": "tg.action.auto_cut",
}
OUTCOME_RECOMMENDED = "RECOMMENDED"
MITRE = {
    "port_scan": "T1046", "ssh_brute_force": "T1110", "syn_flood": "T1498",
    "ssh_login_after_failures": "T1078", "distributed_attack": "T1498",
}

STRINGS = {
    "tg.level.medium": {"en": "Medium severity", "th": "ความรุนแรงระดับกลาง", "zh": "中等严重性"},
    "tg.level.high": {"en": "High severity", "th": "ความรุนแรงระดับสูง", "zh": "高严重性"},
    "tg.level.critical": {"en": "Critical severity", "th": "ความรุนแรงระดับวิกฤต", "zh": "危急严重性"},
    "tg.label.attacker": {"en": "Attacker", "th": "ผู้โจมตี", "zh": "攻击来源"},
    "tg.label.score": {"en": "Risk score", "th": "คะแนนความเสี่ยง", "zh": "风险评分"},
    "tg.label.evidence": {"en": "Evidence", "th": "หลักฐาน", "zh": "证据"},
    "tg.label.response": {"en": "Response", "th": "การตอบสนอง", "zh": "响应"},
    "tg.label.result": {"en": "Result", "th": "ผลลัพธ์", "zh": "结果"},
    "tg.action.software_block": {
        "en": "Firewall block of the attacker address",
        "th": "บล็อก IP ผู้โจมตีด้วยไฟร์วอลล์",
        "zh": "防火墙封锁攻击地址",
    },
    "tg.action.recommend_cut": {
        "en": "Physical cut recommended — confirm on the Desktop console",
        "th": "แนะนำให้ตัดสายเครือข่าย — ยืนยันที่หน้าจอควบคุม",
        "zh": "建议物理断网——请在桌面控制台确认",
    },
    "tg.action.auto_cut": {
        "en": "Automatic physical uplink cut",
        "th": "ตัดสายเครือข่ายทางกายภาพอัตโนมัติ",
        "zh": "自动物理断开上行链路",
    },
    "tg.outcome.recommended": {"en": "Waiting for an operator decision", "th": "รอผู้ดูแลตัดสินใจ", "zh": "等待操作员决定"},
    "audit_alert.level.low": {"en": "Low severity", "th": "ความรุนแรงระดับต่ำ", "zh": "低严重性"},
    "audit_alert.result_not_recorded": {
        "en": "Not recorded in the audit log", "th": "ไม่มีบันทึกในฐานข้อมูลตรวจสอบ", "zh": "审计日志中没有记录",
    },
    "audit_alert.time": {"en": "Time", "th": "เวลา", "zh": "时间"},
    "audit_alert.audit_record": {"en": "Audit record", "th": "บันทึกตรวจสอบ", "zh": "审计记录"},
    "audit_alert.footer": {
        "en": "Telegram and this window are for notification only. CUT and RESTORE are done on the control page only.",
        "th": "Telegram/หน้าต่างนี้ใช้แจ้งเตือนเท่านั้น สั่ง CUT และ RESTORE ได้ที่หน้าควบคุมเท่านั้น",
        "zh": "Telegram 与此窗口仅用于通知。CUT 与 RESTORE 只能在控制页面执行。",
    },
    "audit_alert.empty": {
        "en": "No graduated-response alerts are recorded.",
        "th": "ยังไม่มีการแจ้งเตือนจากการตอบสนองแบบไล่ระดับ",
        "zh": "尚无分级响应警报记录。",
    },
    "audit_alert.unavailable": {
        "en": "NOT_AVAILABLE — {reason} (the audit database could not be read; nothing is inferred)",
        "th": "NOT_AVAILABLE — {reason} (อ่านฐานข้อมูลตรวจสอบไม่ได้ จึงไม่แสดงการคาดเดาใด ๆ)",
        "zh": "NOT_AVAILABLE — {reason}（无法读取审计数据库，未作任何推断）",
    },
    "audit_alert.today_note": {
        "en": "Graduated alerts recorded today (Asia/Bangkok)",
        "th": "การแจ้งเตือนแบบไล่ระดับที่บันทึกวันนี้ (เวลาไทย)",
        "zh": "今日记录的分级警报（曼谷时间）",
    },
    "audit_alert.incidents_note": {
        "en": "Core incident records not CLOSED. An alert alone does not open one.",
        "th": "เหตุการณ์ใน Core ที่ยังไม่ปิด การแจ้งเตือนอย่างเดียวไม่ได้เปิดเหตุการณ์",
        "zh": "Core 中未关闭的事件记录。仅有警报不会创建事件。",
    },
}

_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")
_FIELDS = {
    "source": re.compile(r"(?:^| )source=([A-Za-z0-9._-]{1,64})(?: |$)"),
    "attacker_ip": re.compile(r"(?:^| )attacker_ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?: |$)"),
    "score": re.compile(r"(?:^| )score=(\d{1,6})(?: |$)"),
    "action": re.compile(r"(?:^| )action=([A-Z_]{1,30})(?: |$)"),
    "reasons": re.compile(r"(?:^| )reasons=([A-Za-z0-9_:+.,-]{1,240})(?: |$)"),
    "mitre": re.compile(r"(?:^| )mitre=([A-Z0-9.,]{1,80})(?: |$)"),
    "target": re.compile(r"(?:^| )target=([A-Z_]{1,40})(?: |$)"),
}
_ORIGIN = re.compile(r"\(origin=([A-Za-z0-9_-]{1,32})\)$")


@dataclass(frozen=True)
class AlertView:
    id: int
    at: str
    level: str
    icon: str
    address: str
    score: str
    evidence: tuple[str, ...]
    mitre: tuple[str, ...]
    action: str
    outcome: str
    audit_record: str


@dataclass(frozen=True)
class ActivityRow:
    time: str
    severity: str
    event: str
    source: str


@dataclass(frozen=True)
class AuditSnapshot:
    reason: str = ""
    alerts: tuple[AlertView, ...] = ()
    activity: tuple[ActivityRow, ...] = ()
    today: int | None = None
    last_24h: int = 0
    highest_24h: str = ""
    open_incidents: int | None = None


def parse_fields(details) -> dict[str, str]:
    """The machine-written ``key=value`` fields of a security row. Each value must match its own strict shape, or it is absent."""
    text = details[:DETAILS_CHARS] if isinstance(details, str) else ""
    found = {name: pattern.search(text) for name, pattern in _FIELDS.items()}
    return {name: match.group(1) for name, match in found.items() if match}


def _mitre_for(fields) -> tuple[str, ...]:
    if fields.get("mitre"):
        return tuple(item for item in fields["mitre"].split(",") if item)
    names = (item.split("+", 1)[0] for item in fields.get("reasons", "").split(","))
    return tuple(sorted({MITRE[name] for name in names if name in MITRE}))


def _shown_action(action: str, remote: bool) -> str:
    """The wording rule of ``supervisor._remote_notify``: the Core neither blocks nor auto-cuts for a remote source."""
    if remote and action == "AUTO_CUT":
        return "RECOMMEND_CUT"
    if remote and action == "SOFTWARE_BLOCK":
        return ""
    return action if action in ACTION_KEY else ""


def alert_view(row_id, stamp, kind, details, *, awaiting=None) -> AlertView:
    fields = parse_fields(details)
    level = kind[len("GRADUATED_"):]
    source = fields.get("source", "")
    action = _shown_action(fields.get("action", ""), bool(source))
    evidence = [item for item in fields.get("reasons", "").split(",") if item]
    if source:
        evidence.append(f"source:{source}")
    outcome = OUTCOME_RECOMMENDED if awaiting is not None else ""
    record = ""
    if awaiting is not None:
        target = parse_fields(awaiting).get("target", "")
        record = f"{AWAITING_KIND} target={target}" if target else AWAITING_KIND
    return AlertView(
        id=row_id, at=stamp[:19] if isinstance(stamp, str) and _TIMESTAMP.match(stamp) else "",
        level=level, icon=SEVERITY_ICON.get(level, "⚪"), address=fields.get("attacker_ip", ""),
        score=fields.get("score", ""), evidence=tuple(evidence), mitre=_mitre_for(fields),
        action=action, outcome=outcome, audit_record=record,
    )


def build_alerts(rows, limit: int = ALERT_LIMIT) -> tuple[AlertView, ...]:
    """``rows`` are ``(id, timestamp, event_type, details)``, newest first. An awaiting row is attached to the decision that caused it."""
    rows = list(rows)
    attached: dict[int, str] = {}
    for row_id, _stamp, kind, details in rows:
        if kind != AWAITING_KIND:
            continue
        wanted = parse_fields(details)
        for other_id, _other_stamp, other_kind, other_details in rows:
            if other_kind == "GRADUATED_CRITICAL" and 0 < row_id - other_id <= _AWAITING_MAX_GAP:
                fields = parse_fields(other_details)
                if (fields.get("source"), fields.get("attacker_ip")) == (wanted.get("source"), wanted.get("attacker_ip")):
                    attached[other_id] = details
                    break
    views = [alert_view(row_id, stamp, kind, details, awaiting=attached.get(row_id))
             for row_id, stamp, kind, details in rows if kind in _RANK]
    return tuple(views[:limit])


def alert_lines(view: AlertView, translate) -> tuple[str, tuple[str, ...]]:
    """``(heading, lines)`` in the Telegram alert's order, using its labels. Pure, so each language can be pinned by a test."""
    level_key = "audit_alert.level.low" if view.level == "LOW" else f"tg.level.{view.level.lower()}"
    heading = f"{view.icon} {translate(level_key)} · {view.level}"
    lines = [
        f"{translate('tg.label.attacker')}: {view.address or '—'}",
        f"{translate('tg.label.score')}: {view.score or '—'}",
        f"{translate('tg.label.evidence')}: {', '.join(view.evidence) or '—'}",
    ]
    if view.mitre:
        lines.append(f"MITRE ATT&CK: {', '.join(view.mitre)}")
    if view.action:
        lines.append(f"{translate('tg.label.response')}: {translate(ACTION_KEY[view.action])}")
    if view.outcome:
        lines.append(f"{translate('tg.label.result')}: {translate('tg.outcome.recommended')}")
    elif view.action == "AUTO_CUT":
        lines.append(f"{translate('tg.label.result')}: {translate('audit_alert.result_not_recorded')}")
    if view.audit_record:
        lines.append(f"{translate('audit_alert.audit_record')}: {view.audit_record}")
    lines.append(f"{translate('audit_alert.time')}: {view.at or '—'}")
    return heading, tuple(lines)


def _activity_time(stamp, today: str) -> str:
    if not isinstance(stamp, str) or not _TIMESTAMP.match(stamp):
        return "--:--:--"
    return stamp[11:19] if stamp[:10] == today else f"{stamp[5:10]} {stamp[11:16]}"


def activity_row(stamp, level, kind, details, *, today: str) -> ActivityRow:
    """Machine fields only: operator free text inside a command's details never reaches the table."""
    severity = level if level in ("INFO", "WARN", "CRITICAL") else "INFO"
    if kind in _RANK or kind == AWAITING_KIND:
        fields = parse_fields(details)
        parts = [kind, fields.get("attacker_ip", "")]
        parts.append(f"score={fields['score']}" if fields.get("score") else "")
        parts.append(f"target={fields['target']}" if fields.get("target") else "")
        source = fields.get("source", "").upper() or "SYSTEM"
    else:
        code, ref = records.parse_audit_details(kind, details)
        parts = [kind, code, ref]
        origin = _ORIGIN.search(details) if isinstance(details, str) else None
        source = origin.group(1).upper() if origin else "SYSTEM"
    return ActivityRow(_activity_time(stamp, today), severity, " ".join(part for part in parts if part), source)


def _connect(path) -> tuple[sqlite3.Connection | None, str]:
    if path is None:
        return None, records.NOT_CONFIGURED
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            return None, records.NOT_A_REGULAR_FILE
        if not os.access(path, os.R_OK):
            return None, records.PERMISSION_DENIED
    except OSError as error:
        return None, records._open_reason(error)
    try:
        connection = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=0.5)
        connection.execute("PRAGMA query_only = ON")
    except sqlite3.Error:
        return None, records.UNREADABLE
    return connection, ""


def _marks(kinds) -> str:
    return ",".join("?" for _ in kinds)


def read_snapshot(path, *, now: datetime | None = None, alert_limit: int = ALERT_LIMIT,
                  activity_limit: int = ACTIVITY_LIMIT) -> AuditSnapshot:
    """Everything the panel and Overview show, from one read-only connection. Any failure returns only the reason."""
    connection, reason = _connect(path)
    if connection is None:
        return AuditSnapshot(reason=reason)
    moment = (now or datetime.now(BANGKOK)).astimezone(BANGKOK)
    today = moment.strftime("%Y-%m-%d")
    since = (moment - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    decision_kinds = (*ALERT_KINDS, AWAITING_KIND)
    try:
        alert_rows = connection.execute(
            f"SELECT id, timestamp, event_type, details FROM audit_logs WHERE event_type IN ({_marks(decision_kinds)}) "
            "ORDER BY id DESC LIMIT ?",
            (*decision_kinds, alert_limit * 2),
        ).fetchall()
        activity_rows = connection.execute(
            f"SELECT timestamp, level, event_type, details FROM audit_logs WHERE event_type IN ({_marks(ACTIVITY_KINDS)}) "
            "ORDER BY id DESC LIMIT ?",
            (*ACTIVITY_KINDS, activity_limit),
        ).fetchall()
        today_count = connection.execute(
            f"SELECT COUNT(*) FROM audit_logs WHERE event_type IN ({_marks(ALERT_KINDS)}) AND timestamp >= ? AND timestamp <= ?",
            (*ALERT_KINDS, f"{today} 00:00:00", f"{today} 23:59:59"),
        ).fetchone()[0]
        recent = connection.execute(
            f"SELECT event_type, COUNT(*) FROM audit_logs WHERE event_type IN ({_marks(ALERT_KINDS)}) AND timestamp >= ? "
            "GROUP BY event_type",
            (*ALERT_KINDS, since),
        ).fetchall()
    except sqlite3.Error:
        connection.close()
        return AuditSnapshot(reason=records.UNREADABLE)
    try:
        # The Core's own definition: database.count_open_incidents().
        open_incidents = connection.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]
    except sqlite3.Error:
        open_incidents = None
    finally:
        connection.close()
    highest = max((kind for kind, _count in recent), key=_RANK.__getitem__, default="")
    return AuditSnapshot(
        alerts=build_alerts(alert_rows, alert_limit),
        activity=tuple(activity_row(*row, today=today) for row in activity_rows),
        today=today_count,
        last_24h=sum(count for _kind, count in recent),
        highest_24h=highest[len("GRADUATED_"):],
        open_incidents=open_incidents,
    )


def register_strings(i18n_module) -> None:
    """Add the strings to the purple i18n table; a key that already exists is never replaced."""
    for key, entry in STRINGS.items():
        i18n_module.STRINGS.setdefault(key, dict(entry))
