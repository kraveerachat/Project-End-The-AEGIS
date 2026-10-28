"""Read-only Core records for the control Desktop's Recovery, Incidents and Audit pages.

Everything here is display data taken from sources the Core already writes:

  * ``recovery-status.json`` (the Core's own RESTORE-readiness state, ``aegis_soc/recovery_view.py``),
  * ``graduated-status.json`` (the Core's graduated-response decisions, read by ``live_purple_control_desktop.read_graduated``),
  * the Core's audit database, opened read-only, for CUT and RESTORE requests and their results.

Every reader is fail-closed and bounded (regular file only, size limit, fixed schema, allowlisted values) and never raises. A source
the Desktop user cannot reach comes back as ``(None, REASON)`` and the page shows ``NOT_AVAILABLE`` with that reason; no old value is
kept. The audit reader selects only the columns and event kinds below, reads only machine fields (event kind, time, result code,
sequence or message id) and never returns the free text of an operator reason. Nothing here can send, write or authorise anything.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import stat
import time
from urllib.parse import quote

MAX_JSON_BYTES = 16 * 1024
AUDIT_LIMIT = 30
# read_audit()'s own `limit = max(1, min(int(limit), 50))` already hard-caps every caller at 50 rows (pinned,
# tested); the Audit page's live feed asks for that same existing cap rather than raising it, so no shared
# safety bound changes for this feature.
AUDIT_LIMIT_FEED = 50
AUDIT_DETAILS_CHARS = 512
RECOVERY_MAX_AGE_SECONDS = 60.0   # the same freshness rule as the Core evidence (live_purple_observer.DESKTOP_MAX_AGE_SECONDS)

# Why a source is not available (codes, never translated).
NOT_CONFIGURED, NOT_FOUND, PERMISSION_DENIED = "NOT_CONFIGURED", "NOT_FOUND", "PERMISSION_DENIED"
NOT_A_REGULAR_FILE, TOO_LARGE, UNREADABLE, MALFORMED, STALE = "NOT_A_REGULAR_FILE", "TOO_LARGE", "UNREADABLE", "MALFORMED", "STALE"

UPLINK_WHY = ("NOT_LOCKDOWN", "COMMANDED_CUT", "CUT_NOT_ACKED", "UNCOMMANDED_AFTER_RESTORE", "NO_COMMAND_RECORD")
AUDIT_KINDS = ("COMMAND_SENT", "ACK_RECEIVED", "CUT_PRE_DISPATCH", "RESTORE_REQUESTED", "RESTORE_REFUSED", "RESTORE_AUTH_LOCKOUT")
ATTEMPT_KINDS = ("RESTORE_REQUESTED", "RESTORE_REFUSED", "RESTORE_AUTH_LOCKOUT")
# The graduated-response decision and alert-ingress kinds (aegis_soc/supervisor.py's _graduated_act,
# aegis_soc/graduated_ingress.py's _audit_accepted/handle) land in the SAME audit_logs table as the kinds
# above, but AUDIT_KINDS has never included them, so they have never been shown anywhere on the Desktop.
# FEED_KINDS is a second, explicit, bounded allowlist (not a passthrough of arbitrary event_type values) for
# the Audit page's live SOC feed only; every existing caller keeps passing AUDIT_KINDS/ATTEMPT_KINDS unchanged.
SECURITY_KINDS = ("GRADUATED_LOW", "GRADUATED_MEDIUM", "GRADUATED_HIGH", "GRADUATED_CRITICAL", "ALERT_ACCEPTED", "ALERT_REFUSED")
FEED_KINDS = AUDIT_KINDS + SECURITY_KINDS
ACTIONS = ("CUT_UPLINK", "RESTORE_UPLINK")

BLOCKERS = (
    "EVIDENCE_NOT_FRESH", "VIEW_UNAVAILABLE", "UPLINK_NOT_LOCKDOWN", "DEVICE_NOT_ONLINE", "BROKER_NOT_CONNECTED",
    "TIME_NOT_TRUSTED", "RESTORE_NOT_SERVED", "COMMAND_AWAITING_ACK", "RESTORE_PENDING", "AUTH_LOCKED_OUT",
)


# ---- bounded file readers ---------------------------------------------------------------------------------------------------

def _open_reason(error: OSError) -> str:
    if isinstance(error, FileNotFoundError):
        return NOT_FOUND
    if isinstance(error, PermissionError):
        return PERMISSION_DENIED
    return UNREADABLE


def read_json(path, max_bytes: int = MAX_JSON_BYTES):
    """``(document, reason)``: one regular file, no symlink, bounded, a JSON object. Never raises."""
    if path is None:
        return None, NOT_CONFIGURED
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            return None, NOT_A_REGULAR_FILE
        if info.st_size > max_bytes:
            return None, TOO_LARGE
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(max_bytes + 1)
        if len(raw) > max_bytes:
            return None, TOO_LARGE
        document = json.loads(raw.decode("utf-8"))
    except OSError as error:
        return None, _open_reason(error)
    except (ValueError, UnicodeError):
        return None, MALFORMED
    return (document, "") if isinstance(document, dict) else (None, MALFORMED)


def file_reason(path) -> str:
    """Why a projection could not be used (for a reader that returns only None): the open reason, else MALFORMED."""
    document, reason = read_json(path, 64 * 1024)
    return reason if document is None else MALFORMED


def _number(value, *, low=0.0, high=1e9):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value) if low <= value <= high else None


def read_recovery_view(path, *, now=None):
    """The Core's ``recovery-status.json`` as ``(view, reason)``. A view older than 60 s is STALE: the Core is not updating it,
    so ``restore_pending`` and the lockout could be out of date and nothing is shown as a fact."""
    document, reason = read_json(path)
    if document is None:
        return None, reason
    if document.get("v") != 1 or document.get("uplink_why") not in UPLINK_WHY:
        return None, MALFORMED
    updated = _number(document.get("updated_at"), low=1e9, high=1e11)
    if updated is None:
        return None, MALFORMED
    current = time.time() if now is None else now
    if current - updated > RECOVERY_MAX_AGE_SECONDS or updated - current > RECOVERY_MAX_AGE_SECONDS:
        return None, STALE
    flags = {name: document.get(name) for name in ("restore_pending", "restore_command_pending", "restore_served")}
    if any(not isinstance(value, bool) for value in flags.values()):
        return None, MALFORMED
    remaining = document.get("restore_pending_remaining_sec")
    remaining = None if remaining is None else _number(remaining, high=3600.0)
    lockout = _number(document.get("lockout_remaining_sec"), high=86400.0)
    if lockout is None or (document.get("restore_pending_remaining_sec") is not None and remaining is None):
        return None, MALFORMED
    last = document.get("last_command")
    if last is not None:
        if (not isinstance(last, dict) or last.get("action") not in ACTIONS
                or any(not isinstance(last.get(name), bool) for name in ("acked", "confirmed", "timed_out"))):
            return None, MALFORMED
        last = {"action": last["action"], "acked": last["acked"], "confirmed": last["confirmed"], "timed_out": last["timed_out"]}
    uplink = document.get("uplink") if document.get("uplink") in ("NORMAL", "LOCKDOWN", "UNKNOWN") else "UNKNOWN"
    device = document.get("device") if document.get("device") in ("ONLINE", "OFFLINE", "UNKNOWN") else "UNKNOWN"
    return {
        "uplink": uplink, "device": device, "uplink_why": document["uplink_why"], "last_command": last,
        **flags, "restore_pending_remaining_sec": remaining, "lockout_remaining_sec": lockout,
    }, ""


# ---- audit records ----------------------------------------------------------------------------------------------------------

_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")
_HEAD_CODE = re.compile(r"^code=([A-Z][A-Z0-9_]{1,40})(?: |$)")
_MSG_ID = re.compile(r"(?:^| )msg_id=([0-9a-f]{32})(?: |$)")
_SEQ_FIELD = re.compile(r"(?:^| )seq=(\d{1,10})(?: |$)")
_ACTION_HEAD = re.compile(r"^(CUT_UPLINK|RESTORE_UPLINK) - ")
_SEQ_TAIL = re.compile(r" seq=(\d{1,10})$")
_ACK = re.compile(r"^([A-Z][A-Z_]{1,30}) - seq (\d{1,10})$")
# aegis_soc/supervisor.py's _graduated_act() and aegis_soc/graduated_ingress.py's handle() build ``details`` as
# space-joined ``key=value`` pairs from controlled, internally-generated values (an IPv4 address, uppercase
# action/kind tokens, a comma list of MITRE technique ids) -- never operator free text -- so these can be
# anchored the same way as the patterns above.
_GRADUATED_ACTION = re.compile(r"(?:^| )action=([A-Z_]{1,30})(?: |$)")
_ATTACKER_IP = re.compile(r"(?:^| )attacker_ip=(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?: |$)")
_MITRE = re.compile(r"(?:^| )mitre=([A-Z0-9,]{0,80})(?: |$)")


def parse_audit_details(kind: str, details) -> tuple[str, str]:
    """``(code, ref)`` from a Core audit row, from the machine fields only. Everything an operator typed (the reason, the free
    ``detail=`` text) is cut off or ignored first, and every pattern is anchored, so text inside a reason can never fake a field."""
    text = details[:AUDIT_DETAILS_CHARS] if isinstance(details, str) else ""
    code = ref = ""
    if kind == "RESTORE_REFUSED":
        head = _HEAD_CODE.match(text)
        code = head.group(1) if head else ""
    elif kind == "CUT_PRE_DISPATCH":
        prefix = text.split(" reason=", 1)[0]
        msg = _MSG_ID.search(prefix)
        seq = _SEQ_FIELD.search(prefix)
        ref = msg.group(1) if msg else (f"seq {seq.group(1)}" if seq else "")
    elif kind == "COMMAND_SENT":
        head = _ACTION_HEAD.match(text)
        tail = _SEQ_TAIL.search(text)
        code = head.group(1) if head else ""
        ref = f"seq {tail.group(1)}" if tail else ""
    elif kind == "ACK_RECEIVED":
        ack = _ACK.match(text)
        if ack:
            code, ref = ack.group(1), f"seq {ack.group(2)}"
    elif kind in ("GRADUATED_LOW", "GRADUATED_MEDIUM", "GRADUATED_HIGH", "GRADUATED_CRITICAL"):
        action = _GRADUATED_ACTION.search(text)
        code = action.group(1) if action else ""
    return code, ref


def parse_security_details(details) -> tuple[str, str]:
    """``(attacker_ip, mitre)`` from a GRADUATED_*/ALERT_ACCEPTED audit row's machine fields, same anchoring
    rules as ``parse_audit_details``; ``("", "")`` for a kind/row that carries neither (e.g. ALERT_REFUSED,
    whose details are only ``code=... uid=... pid=...``, no attacker_ip)."""
    text = details[:AUDIT_DETAILS_CHARS] if isinstance(details, str) else ""
    ip_match = _ATTACKER_IP.search(text)
    mitre_match = _MITRE.search(text)
    ip = ip_match.group(1) if ip_match else ""
    mitre = mitre_match.group(1) if mitre_match and mitre_match.group(1) else ""
    return ip, mitre


def read_audit(path, kinds=AUDIT_KINDS, limit: int = AUDIT_LIMIT):
    """The newest audit rows of the given kinds as ``(rows, reason)``, newest first. Read-only connection, fixed query, bounded."""
    if path is None:
        return None, NOT_CONFIGURED
    kinds = tuple(kind for kind in kinds if kind in FEED_KINDS)
    limit = max(1, min(int(limit), 50))
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            return None, NOT_A_REGULAR_FILE
        if not os.access(path, os.R_OK):
            return None, PERMISSION_DENIED
    except OSError as error:
        return None, _open_reason(error)
    try:
        connection = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=0.5)
    except sqlite3.Error:
        return None, UNREADABLE
    try:
        connection.execute("PRAGMA query_only = ON")
        marks = ",".join("?" for _ in kinds)
        found = connection.execute(
            f"SELECT id, timestamp, event_type, details FROM audit_logs WHERE event_type IN ({marks}) ORDER BY id DESC LIMIT ?",
            (*kinds, limit),
        ).fetchall()
    except sqlite3.Error:
        return None, UNREADABLE
    finally:
        connection.close()
    rows = []
    for row_id, stamp, kind, details in found:
        if not isinstance(row_id, int) or kind not in FEED_KINDS:
            continue
        code, ref = parse_audit_details(kind, details)
        ip, mitre = parse_security_details(details) if kind in SECURITY_KINDS else ("", "")
        at = stamp[:19] if isinstance(stamp, str) and _TIME.match(stamp) else ""
        rows.append({"id": row_id, "at": at, "kind": kind, "code": code, "ref": ref, "ip": ip, "mitre": mitre})
    return rows, ""


def audit_line(row) -> str:
    parts = [row["at"] or "—", f"{row['kind']:<20}"]
    if row["code"]:
        parts.append(row["code"])
    if row["ref"]:
        parts.append(f"[{row['ref']}]")
    return "  ".join(parts)


def feed_line(row) -> str:
    """One console line for the Audit page's live SOC feed: HH:MM:SS  KIND  [code]  [ip]  [mitre]."""
    clock = row["at"][-8:] if len(row["at"]) >= 8 else (row["at"] or "—")
    parts = [clock, f"{row['kind']:<20}"]
    if row["code"]:
        parts.append(row["code"])
    if row["ip"]:
        parts.append(row["ip"])
    if row["ref"]:
        parts.append(f"[{row['ref']}]")
    if row["mitre"]:
        parts.append(f"[{row['mitre']}]")
    return "  ".join(parts)


def feed_record(row) -> tuple[str, str, str]:
    """Project one safe audit row into the Audit table's time, event and detail columns.

    ``read_audit()`` has already reduced the database record to allowlisted machine fields. This helper
    deliberately consumes only those fields, so operator reasons and other free text cannot reach the UI.
    """
    at = row.get("at", "")
    clock = at[-8:] if isinstance(at, str) and len(at) >= 8 else "—"
    event = str(row.get("kind") or "—")
    details = [str(row.get(name)) for name in ("code", "ip", "ref", "mitre") if row.get(name)]
    return clock, event, " · ".join(details) or "—"


# ---- facts for the pages ----------------------------------------------------------------------------------------------------

def readiness_blockers(evidence, view, freshness) -> list[str]:
    """Codes that stand in the way of a RESTORE, from the Core's own state. Advice only: the Core's gate decides."""
    blockers = []
    if freshness not in (None, "FRESH"):
        blockers.append("EVIDENCE_NOT_FRESH")
    if view is None:
        blockers.append("VIEW_UNAVAILABLE")
    if evidence.get("uplink") != "LOCKDOWN":
        blockers.append("UPLINK_NOT_LOCKDOWN")
    if evidence.get("device") != "ONLINE":
        blockers.append("DEVICE_NOT_ONLINE")
    if evidence.get("broker") != "CONNECTED":
        blockers.append("BROKER_NOT_CONNECTED")
    if evidence.get("trusted_time") != "SYNCED":
        blockers.append("TIME_NOT_TRUSTED")
    if view is not None:
        if not view["restore_served"]:
            blockers.append("RESTORE_NOT_SERVED")
        if view["restore_command_pending"]:
            blockers.append("COMMAND_AWAITING_ACK")
        if view["restore_pending"]:
            blockers.append("RESTORE_PENDING")
        if view["lockout_remaining_sec"] > 0:
            blockers.append("AUTH_LOCKED_OUT")
    return blockers


def _seconds(value) -> str:
    return f"{math.ceil(value)} s"


def recovery_facts(evidence, view, view_reason, graduated, attempts, attempts_reason, freshness, translate):
    """The Recovery page's rows as ``(label, value, level)``; ``level`` is a colour hint (LOW=neutral, HIGH=warning, None=unknown)."""
    t = translate
    rows = []
    if freshness not in (None, "FRESH"):
        rows.append((t("severity.evidence"), f"{freshness} — {t('severity.evidence_stale')}", "HIGH"))
    blockers = readiness_blockers(evidence, view, freshness)
    ready = not blockers
    rows.append((t("recovery.ready"), t("recovery.ready_yes") if ready else
                 f"{t('recovery.ready_no')} — {', '.join(blockers)}", "LOW" if ready else "HIGH"))
    rows.append((t("recovery.uplink"), evidence.get("uplink", "UNKNOWN"), "HIGH" if evidence.get("uplink") == "LOCKDOWN" else None))
    if view is None:
        unavailable = t("recovery.unavailable", reason=view_reason or UNREADABLE)
        for key in ("recovery.why", "recovery.pending", "recovery.lockout"):
            rows.append((t(key), unavailable, None))
    else:
        rows.append((t("recovery.why"), f"{view['uplink_why']} — {t('recovery.why.' + view['uplink_why'])}",
                     "HIGH" if view["uplink_why"] in ("UNCOMMANDED_AFTER_RESTORE", "NO_COMMAND_RECORD") else None))
        if view["restore_pending"]:
            pending = t("recovery.pending_yes", seconds=_seconds(view["restore_pending_remaining_sec"] or 0))
        elif view["restore_command_pending"]:
            pending = t("recovery.pending_ack")
        else:
            pending = t("recovery.pending_no")
        rows.append((t("recovery.pending"), pending, "HIGH" if view["restore_pending"] or view["restore_command_pending"] else "LOW"))
        locked = view["lockout_remaining_sec"] > 0
        rows.append((t("recovery.lockout"), t("recovery.lockout_yes", seconds=_seconds(view["lockout_remaining_sec"])) if locked
                     else t("recovery.lockout_no"), "HIGH" if locked else "LOW"))
    rows.append((t("recovery.device"), evidence.get("device", "UNKNOWN"), "HIGH" if evidence.get("device") != "ONLINE" else "LOW"))
    rows.append((t("recovery.time"), evidence.get("trusted_time", "UNKNOWN"), "HIGH" if evidence.get("trusted_time") != "SYNCED" else "LOW"))
    rows.append((t("recovery.broker"), evidence.get("broker", "UNKNOWN"), "HIGH" if evidence.get("broker") != "CONNECTED" else "LOW"))
    if graduated is None:
        rows.append((t("recovery.graduated"), t("severity.unavailable"), None))
    else:
        latch = f" — {t('recovery.latched')}" if graduated["auto_cut_latched"] else ""
        rows.append((t("recovery.graduated"), f"{graduated['highest_level']}{latch}", graduated["highest_level"]))
    if attempts is None:
        rows.append((t("recovery.attempts"), t("recovery.unavailable", reason=attempts_reason or UNREADABLE), None))
    elif not attempts:
        rows.append((t("recovery.attempts"), t("recovery.attempts_none"), "LOW"))
    return rows


# Labels recovery_facts() computes that also get a quick-glance tile (see recovery_tile_facts below); the
# Desktop uses this to leave the full-detail row out of the "cause" card where a tile already shows it, so
# the same value is not printed twice. "recovery.ready" is NOT here on purpose: the tile shows a short
# READY/NOT READY, but the full row (with the blocker list) stays in the detail card -- nothing is dropped.
RECOVERY_TILE_ONLY_LABEL_KEYS = ("recovery.uplink", "recovery.device", "recovery.broker", "recovery.time", "recovery.graduated")

# The exact order recovery_tile_facts() returns its six tiles in -- the Desktop builds its six MetricCard
# labels from this (a MetricCard's label is set once, at construction; only the value/status are updated on
# each refresh tick), so the GUI's tile order and this function's row order can never drift apart.
RECOVERY_TILE_LABEL_KEYS = ("recovery.ready", "recovery.uplink", "recovery.device", "recovery.broker", "recovery.time", "recovery.graduated")


def recovery_tile_facts(evidence, view, graduated, freshness, translate) -> list[tuple[str, str, str | None]]:
    """The Recovery page's six quick-glance tiles -- Ready?, Uplink, ESP32, Broker, Time, Graduated response
    -- as ``(label, short_value, level)``. Every value and condition here is the exact same one
    ``recovery_facts`` already computes for its fact rows; this only re-packages them for tile display, so a
    tile and the equivalent detail row (when one still exists) never disagree."""
    t = translate
    blockers = readiness_blockers(evidence, view, freshness)
    ready = not blockers
    tiles = [
        (t("recovery.ready"), t("recovery.ready_yes_short") if ready else t("recovery.ready_no_short"), "LOW" if ready else "HIGH"),
        (t("recovery.uplink"), evidence.get("uplink", "UNKNOWN"), "HIGH" if evidence.get("uplink") == "LOCKDOWN" else None),
        (t("recovery.device"), evidence.get("device", "UNKNOWN"), "HIGH" if evidence.get("device") != "ONLINE" else "LOW"),
        (t("recovery.broker"), evidence.get("broker", "UNKNOWN"), "HIGH" if evidence.get("broker") != "CONNECTED" else "LOW"),
        (t("recovery.time"), evidence.get("trusted_time", "UNKNOWN"), "HIGH" if evidence.get("trusted_time") != "SYNCED" else "LOW"),
    ]
    if graduated is None:
        tiles.append((t("recovery.graduated"), "NOT_AVAILABLE", None))   # the state code only; its meaning is the tile helper
    else:
        tiles.append((t("recovery.graduated"), graduated["highest_level"], graduated["highest_level"]))
    return tiles


def recovery_tile_helpers(graduated, translate) -> list[str]:
    """One short supporting line per Recovery tile, in ``RECOVERY_TILE_LABEL_KEYS`` order ("" = none). READY is
    Core-side eligibility only (see ``readiness_blockers``): it never says the cable or relay was verified."""
    t = translate
    return [t("recovery.ready_note"), "", "", "", "", t("recovery.graduated_unavailable_note") if graduated is None else ""]


def incident_facts(graduated, reason, translate):
    """Header rows of the Incidents page from the Core's graduated decisions; the decision lines are printed by the page."""
    t = translate
    if graduated is None:
        return [(t("incidents.view.source"), t("incidents.view.unavailable", reason=reason or UNREADABLE), None)]
    rows = [(t("severity.highest"), graduated["highest_level"], graduated["highest_level"]),
            (t("incidents.view.count"), str(len(graduated["decisions"])), "LOW")]
    if graduated["cut_recommended_for"]:
        rows.append((t("severity.cut_recommended"), t("severity.cut_recommended_value", target=graduated["cut_recommended_for"]), "HIGH"))
    if graduated["auto_cut_latched"]:
        rows.append((t("severity.auto_cut"), t("severity.auto_cut_value"), "CRITICAL"))
    return rows


# The 4 graduated-response levels, in order, for the Incidents page's always-visible legend -- the exact level
# codes the Core writes (aegis_soc/graduated_response.py), never translated; only the explanation is.
INCIDENT_LEVEL_ORDER = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
INCIDENT_LEVEL_EXPLAIN_KEYS = {
    "LOW": "incidents.legend.low", "MEDIUM": "incidents.legend.medium",
    "HIGH": "incidents.legend.high", "CRITICAL": "incidents.legend.critical",
}

# Raw kind/action strings the Core actually writes (aegis_soc/graduated_detector.py, aegis_soc/graduated_response.py)
# mapped to a friendly, translated label. A kind or action this map does not recognise (e.g. a future detector
# addition, or a test fixture's placeholder value) is shown as its own raw value, never hidden -- every
# underlying value stays visible even when this page cannot explain it yet.
INCIDENT_KIND_KEYS = {
    "port_scan": "incidents.kind.port_scan", "ssh_brute_force": "incidents.kind.ssh_brute_force",
    "syn_flood": "incidents.kind.syn_flood", "ssh_login_after_failures": "incidents.kind.ssh_login_after_failures",
}
INCIDENT_ACTION_KEYS = {
    "NONE": "incidents.action.none", "SOFTWARE_BLOCK": "incidents.action.software_block",
    "RECOMMEND_CUT": "incidents.action.recommend_cut", "AUTO_CUT": "incidents.action.auto_cut",
}


def incident_kind_label(kind, translate):
    key = INCIDENT_KIND_KEYS.get(kind)
    return translate(key) if key else kind


def incident_action_label(action, translate):
    key = INCIDENT_ACTION_KEYS.get(action)
    return translate(key) if key else (action or "—")


def incident_legend_rows(translate):
    """The always-visible "what does each level mean" legend -- 4 rows, level code + friendly explanation,
    using the same level codes/colors every other page already uses (no new color)."""
    t = translate
    return [(level, t(INCIDENT_LEVEL_EXPLAIN_KEYS[level]), level) for level in INCIDENT_LEVEL_ORDER]


def incident_empty_state(graduated, reason, translate):
    """The Incidents page's "nothing to list" headline plus its muted detail, by what is actually known:

    * a valid projection with zero decisions -> a verified empty list, worded as "none found in this source" and
      explicitly NOT as proof that no attack happened (the source only lists decisions the Core recorded);
    * NOT_FOUND / STALE -> their own sentences;
    * any other unreadable source -> "source unavailable".
    An unreadable source never says "no events / the system is watching": that would read as an all-clear when
    the page simply cannot see the Core's decisions. The technical reason code (never the file path) stays as the
    secondary line, returned as ``(title, reason_code)``; a valid-empty list returns ``(title, None)``."""
    t = translate
    if graduated is not None:
        return t("incidents.empty.title"), None
    code = reason or UNREADABLE
    if code == NOT_FOUND:
        return t("incidents.empty.not_found"), code
    if code == STALE:
        return t("incidents.empty.stale"), code
    return t("incidents.empty.unavailable"), code


def incident_decision_rows(item, translate):
    """One decision -> the Incidents page's per-card (label, value, status) rows, friendly labels, every
    underlying value kept (nothing dropped, nothing reworded in the data itself -- only how it's labelled)."""
    t = translate
    when = time.strftime("%H:%M:%S", time.localtime(item["at"])) if item.get("at") else "—"
    mitre = ", ".join(item["mitre"]) if item["mitre"] else "—"
    corroborated = item.get("corroborated")
    return [
        (t("incidents.field.time"), when, None),
        (t("incidents.field.ip"), item["attacker_ip"] or "—", None),
        (t("incidents.field.kind"), incident_kind_label(item["kind"], t), None),
        (t("incidents.field.level"), item["level"], item["level"]),
        (t("incidents.field.score"), str(item["score"]), None),
        (t("incidents.field.action"), incident_action_label(item["action"], t), None),
        (t("incidents.field.outcome"), item["outcome"] or "—", None),
        (t("incidents.field.mitre"), mitre, None),
        (t("incidents.field.corroborated"), t("incidents.field.yes") if corroborated else t("incidents.field.no"), None),
    ]


def incident_card_title(item):
    """One decision card's title bar -- time, level code and attacker IP, state codes never translated."""
    when = time.strftime("%H:%M:%S", time.localtime(item["at"])) if item.get("at") else "—"
    ip = item["attacker_ip"] or "—"
    return f"{when} · {item['level']} · {ip}"


def incident_summary_tiles(graduated, reason, translate):
    """The Incidents page's 3 top summary cards: (highest_level, latest_event, data_source), each as
    (label, value, level_or_None). ``data_source`` is a 4th item on its own -- a plain bool, never folded
    into a fake level -- so the caller decides its color explicitly (HEALTHY/WARNING) instead of this
    unavailable state being routed through the LOW..CRITICAL level palette it has nothing to do with.

    CRITICAL: when the source is unavailable, its value is always the TRUE raw reason code (e.g.
    NOT_FOUND) -- never silently shown as "0 events" or any other value that would read as "nothing
    happened" when the real state is "this page cannot see the Core's decisions at all"."""
    t = translate
    if graduated is None:
        highest = (t("incidents.summary.highest"), t("incidents.summary.unknown"), None)
        latest = (t("incidents.summary.latest"), t("incidents.summary.unknown"), None)   # unknown, never "none yet"
        source = (t("incidents.summary.source"), reason or UNREADABLE, False)
        return highest, latest, source
    decisions = graduated["decisions"]
    highest = (t("incidents.summary.highest"), graduated["highest_level"], graduated["highest_level"])
    if decisions:
        latest_item = decisions[-1]
        latest = (t("incidents.summary.latest"), incident_kind_label(latest_item["kind"], t), latest_item["level"])
    else:
        latest = (t("incidents.summary.latest"), t("incidents.summary.none"), None)
    source = (t("incidents.summary.source"), t("incidents.summary.available"), True)
    return highest, latest, source


def _elapsed_since(at, *, now=None) -> str:
    current = time.time() if now is None else now
    seconds = max(0.0, current - at)
    if seconds < 90:
        return f"{int(seconds)} s"
    minutes = seconds / 60
    if minutes < 90:
        return f"{int(minutes)} m"
    return f"{int(minutes / 60)} h"


def lockdown_cause_facts(evidence, graduated, translate, *, now=None) -> list[tuple[str, str, str | None]]:
    """Rows naming the graduated-response decision most likely to have caused the current LOCKDOWN, and how long
    ago it was made. ``graduated-status.json`` is itself an append-only decision log, so its most recent entry is
    the best read-only proxy for "the cause" the Core exposes today; it is not a separate, authoritative
    cause field (the Core does not write one), so the label says "most recent decision", not "the cause"."""
    t = translate
    if evidence.get("uplink") != "LOCKDOWN":
        return [(t("recovery.cause"), t("recovery.cause_none"), "LOW")]
    if graduated is None or not graduated["decisions"]:
        return [(t("recovery.cause"), t("severity.unavailable"), None)]
    item = graduated["decisions"][-1]
    rows = [
        (t("recovery.cause"), t("recovery.cause_value", ip=item["attacker_ip"] or "—", level=item["level"]), item["level"]),
        (t("recovery.cause_reasons"), ", ".join(item["reasons"]) if item["reasons"] else "—", None),
        (t("recovery.cause_mitre"), ", ".join(item["mitre"]) if item["mitre"] else "—", None),
        (t("recovery.cause_action"), f"{item['action']} → {item['outcome']}" if item["outcome"] else (item["action"] or "—"), None),
    ]
    if item["at"]:
        rows.append((t("recovery.since"), t("recovery.since_value", elapsed=_elapsed_since(item["at"], now=now)), None))
    else:
        rows.append((t("recovery.since"), t("recovery.since_unknown"), None))
    return rows


def blocked_ip_facts(blocked, translate, *, known=True) -> list[tuple[str, str, str | None]]:
    """The read-only containment-helper list (``live_purple_observer.containment_status``) as the Recovery page's
    one fact row; the IPs themselves are printed as lines by the page, the same way attempts/decisions are.
    ``known`` is False when the list operation did not genuinely succeed: the count is then UNKNOWN, never "none"."""
    t = translate
    if not known:
        return [(t("recovery.blocked_count"), "UNKNOWN", None)]
    if not blocked:
        return [(t("recovery.blocked_count"), t("recovery.blocked_none"), "LOW")]
    return [(t("recovery.blocked_count"), str(len(blocked)), "HIGH")]


RUNBOOK_STEPS = (
    "recovery.runbook.1", "recovery.runbook.2", "recovery.runbook.3", "recovery.runbook.4",
    "recovery.runbook.5", "recovery.runbook.6", "recovery.runbook.7", "recovery.runbook.8",
)


def audit_facts(rows, reason, translate):
    t = translate
    if rows is None:
        return [(t("audit.view.source"), t("audit.view.unavailable", reason=reason or UNREADABLE), None)]
    return [(t("audit.view.source"), t("audit.view.count", count=len(rows)), "LOW" if rows else None)]


RECORD_STRINGS = {
    "recovery.ready": {"en": "Ready for a RESTORE", "th": "พร้อมสำหรับ RESTORE", "zh": "可执行 RESTORE"},
    "recovery.ready_yes": {"en": "READY — every Core-side check below is met (the Core still decides; the physical cable is not verified)",
                           "th": "READY — ผ่านทุกข้อฝั่ง Core ด้านล่าง (Core เป็นผู้ตัดสินขั้นสุดท้าย; ยังไม่ได้ตรวจสายกายภาพ)",
                           "zh": "READY — 以下 Core 侧各项检查均已满足（最终由 Core 决定；物理线缆未经验证）"},
    "recovery.ready_note": {
        "en": "Core-side RESTORE eligibility only. It does not prove the cable or relay is reconnected — verify pin 2 physically.",
        "th": "หมายถึงความพร้อมของ RESTORE ฝั่ง Core เท่านั้น ไม่ได้ยืนยันว่าสายหรือรีเลย์เชื่อมต่อแล้ว — ต้องตรวจพิน 2 ทางกายภาพแยกต่างหาก",
        "zh": "仅表示 Core 侧具备 RESTORE 条件，并不证明线缆或继电器已重新连接 — 须另行物理核实第 2 针。"},
    "recovery.graduated_unavailable_note": {
        "en": "No graduated-response summary from Core",
        "th": "ไม่มีข้อมูลสรุปการตอบสนองแบบไล่ระดับจาก Core",
        "zh": "Core 未提供分级响应摘要"},
    "recovery.ready_no": {"en": "NOT READY", "th": "NOT READY — ยังไม่พร้อม", "zh": "NOT READY — 尚未就绪"},
    "recovery.ready_yes_short": {"en": "READY", "th": "READY", "zh": "READY"},
    "recovery.ready_no_short": {"en": "NOT READY", "th": "NOT READY", "zh": "NOT READY"},
    "recovery.uplink": {"en": "Uplink state", "th": "สถานะอัปลิงก์", "zh": "上行链路状态"},
    "recovery.why": {"en": "Why the uplink is in LOCKDOWN", "th": "สาเหตุที่อัปลิงก์อยู่ใน LOCKDOWN", "zh": "上行链路处于 LOCKDOWN 的原因"},
    "recovery.why.NOT_LOCKDOWN": {"en": "the uplink is not in LOCKDOWN", "th": "อัปลิงก์ไม่ได้อยู่ใน LOCKDOWN",
                                  "zh": "上行链路不在 LOCKDOWN 状态"},
    "recovery.why.COMMANDED_CUT": {"en": "the Core sent a CUT and the device ACKed it", "th": "Core สั่ง CUT และอุปกรณ์ตอบ ACK แล้ว",
                                   "zh": "Core 发送了 CUT，设备已确认 ACK"},
    "recovery.why.CUT_NOT_ACKED": {"en": "the Core sent a CUT; no ACK has been recorded", "th": "Core สั่ง CUT แล้ว แต่ยังไม่มีบันทึก ACK",
                                   "zh": "Core 已发送 CUT，尚未记录到 ACK"},
    "recovery.why.UNCOMMANDED_AFTER_RESTORE": {
        "en": "not commanded by the Core: the last command was a RESTORE (dead-man's switch, power loss or a frozen Core)",
        "th": "Core ไม่ได้สั่ง: คำสั่งล่าสุดคือ RESTORE (dead-man's switch ไฟดับ หรือ Core ค้าง)",
        "zh": "并非 Core 指令：最后一条指令是 RESTORE（死人开关、断电或 Core 冻结）"},
    "recovery.why.NO_COMMAND_RECORD": {
        "en": "not commanded by this Core process: no command since it started (dead-man's switch, power loss, or a CUT before a Core restart)",
        "th": "Core นี้ไม่ได้สั่ง: ยังไม่มีคำสั่งตั้งแต่เริ่มทำงาน (dead-man's switch ไฟดับ หรือ CUT ก่อน Core รีสตาร์ท)",
        "zh": "并非本 Core 进程的指令：启动后尚无指令（死人开关、断电，或 Core 重启前的 CUT）"},
    "recovery.pending": {"en": "A RESTORE is pending", "th": "มี RESTORE ค้างอยู่", "zh": "存在待处理的 RESTORE"},
    "recovery.pending_no": {"en": "no", "th": "ไม่มี", "zh": "否"},
    "recovery.pending_yes": {"en": "yes — awaiting device status evidence, blocks a new RESTORE for {seconds} more",
                             "th": "มี — รอหลักฐานสถานะจากอุปกรณ์ และจะบล็อก RESTORE ใหม่อีก {seconds}",
                             "zh": "是 — 等待设备状态证据，还将阻止新的 RESTORE {seconds}"},
    "recovery.pending_ack": {"en": "a command is awaiting its ACK", "th": "มีคำสั่งที่กำลังรอ ACK", "zh": "有指令正在等待 ACK"},
    "recovery.lockout": {"en": "RESTORE lockout", "th": "การล็อกการยืนยันตัวตน RESTORE", "zh": "RESTORE 认证锁定"},
    "recovery.lockout_no": {"en": "none", "th": "ไม่มี", "zh": "无"},
    "recovery.lockout_yes": {"en": "locked after repeated wrong secrets — {seconds} remaining",
                             "th": "ถูกล็อกหลังใส่รหัสผิดซ้ำ — เหลืออีก {seconds}", "zh": "多次输入错误密钥后锁定 — 剩余 {seconds}"},
    "recovery.device": {"en": "ESP32 device", "th": "อุปกรณ์ ESP32", "zh": "ESP32 设备"},
    "recovery.time": {"en": "Trusted time", "th": "เวลาที่เชื่อถือได้", "zh": "可信时间"},
    "recovery.broker": {"en": "Broker", "th": "โบรกเกอร์", "zh": "代理服务器"},
    "recovery.graduated": {"en": "Graduated response", "th": "การตอบสนองแบบไล่ระดับ", "zh": "分级响应"},
    "recovery.latched": {"en": "automatic CUT latched", "th": "CUT อัตโนมัติถูกล็อกไว้", "zh": "自动 CUT 已锁存"},
    "recovery.attempts": {"en": "Last RESTORE attempts", "th": "ความพยายาม RESTORE ล่าสุด", "zh": "最近的 RESTORE 尝试"},
    "recovery.attempts_none": {"en": "none recorded", "th": "ไม่มีบันทึก", "zh": "无记录"},
    "recovery.unavailable": {"en": "NOT_AVAILABLE — {reason}", "th": "NOT_AVAILABLE — {reason}", "zh": "NOT_AVAILABLE — {reason}"},
    "recovery.section": {"en": "RESTORE READINESS — READ ONLY", "th": "ความพร้อมสำหรับ RESTORE — อ่านอย่างเดียว",
                         "zh": "RESTORE 就绪情况 — 只读"},
    "recovery.attempts_section": {"en": "LAST RESTORE ATTEMPTS (CORE AUDIT RECORDS)", "th": "ความพยายาม RESTORE ล่าสุด (บันทึกตรวจสอบของ Core)",
                                  "zh": "最近的 RESTORE 尝试（Core 审计记录）"},
    "recovery.hint": {
        "en": "This page only shows the Core's state. RESTORE is performed on the Lockdown page, with the Core-verified secret; there is no RESTORE control here.",
        "th": "หน้านี้แสดงสถานะของ Core เท่านั้น การ RESTORE ทำที่หน้า Lockdown ด้วยรหัสลับที่ Core ตรวจสอบ ไม่มีปุ่ม RESTORE ในหน้านี้",
        "zh": "本页仅显示 Core 的状态。RESTORE 请在“锁定”页面使用由 Core 验证的密钥执行；本页没有 RESTORE 控件。"},
    "recovery.go_lockdown": {"en": "Go to the Lockdown page", "th": "ไปที่หน้า Lockdown", "zh": "前往“锁定”页面"},
    "incidents.view.section": {"en": "CORE GRADUATED-RESPONSE DECISIONS — READ ONLY", "th": "การตัดสินใจตอบสนองแบบไล่ระดับของ Core — อ่านอย่างเดียว",
                               "zh": "Core 分级响应决策 — 只读"},
    "incidents.view.source": {"en": "Decisions source", "th": "แหล่งข้อมูลการตัดสินใจ", "zh": "决策来源"},
    "incidents.view.count": {"en": "Decisions recorded", "th": "จำนวนการตัดสินใจที่บันทึก", "zh": "已记录的决策数"},
    "incidents.view.unavailable": {
        "en": "NOT_AVAILABLE — {reason} (the Core writes graduated-status.json only when graduated response is ON and a decision is made)",
        "th": "NOT_AVAILABLE — {reason} (Core เขียน graduated-status.json เมื่อเปิดการตอบสนองแบบไล่ระดับและมีการตัดสินใจเท่านั้น)",
        "zh": "NOT_AVAILABLE — {reason}（仅当分级响应开启且产生决策时，Core 才会写入 graduated-status.json）"},
    "incidents.view.none": {"en": "No decisions recorded yet.", "th": "ยังไม่มีการตัดสินใจที่บันทึก", "zh": "尚无决策记录。"},
    "incidents.intro": {
        "en": "This page shows detected security events and the Core's graduated response decisions, from LOW up to CRITICAL.",
        "th": "หน้านี้แสดงเหตุการณ์ความปลอดภัยที่ตรวจพบ และการตัดสินใจตอบสนองแบบไล่ระดับของ Core ตั้งแต่ LOW จนถึง CRITICAL",
        "zh": "本页显示检测到的安全事件，以及 Core 从 LOW 到 CRITICAL 的分级响应决策。"},
    "incidents.legend.title": {"en": "RESPONSE LEVELS", "th": "ระดับการตอบสนอง", "zh": "响应级别"},
    "incidents.legend.low": {"en": "Log / audit only", "th": "บันทึก/ตรวจสอบเท่านั้น", "zh": "仅记录 / 审计"},
    "incidents.legend.medium": {"en": "Software IP block", "th": "บล็อก IP ด้วยซอฟต์แวร์", "zh": "软件封锁该 IP"},
    "incidents.legend.high": {"en": "Recommends a physical CUT (an operator decides)",
                              "th": "แนะนำให้ตัดสายกายภาพ (ผู้ปฏิบัติงานเป็นผู้ตัดสินใจ)", "zh": "建议执行物理 CUT（由操作员决定）"},
    "incidents.legend.critical": {"en": "Automatic CUT (once corroborated)",
                                  "th": "ตัดสายอัตโนมัติ (เมื่อมีการยืนยันซ้ำ)", "zh": "自动执行 CUT（经多重佐证后）"},
    "incidents.empty.title": {
        "en": "No events found in the available data source right now.",
        "th": "ไม่พบเหตุการณ์จากแหล่งข้อมูลที่ใช้ได้ในขณะนี้",
        "zh": "当前可用数据源中未发现事件。"},
    "incidents.empty.valid_note": {
        "en": "This does not prove that no attack occurred: the source lists only the decisions the Core has recorded.",
        "th": "ไม่ได้พิสูจน์ว่าไม่มีการโจมตี — แหล่งข้อมูลนี้แสดงเฉพาะการตัดสินใจที่ Core บันทึกไว้",
        "zh": "这并不证明没有发生攻击：该数据源仅列出 Core 已记录的决策。"},
    "incidents.empty.not_found": {
        "en": "Incident data source not found — the current incident status cannot be determined.",
        "th": "ไม่พบแหล่งข้อมูลเหตุการณ์ — ยังสรุปสถานะเหตุการณ์ปัจจุบันไม่ได้",
        "zh": "未找到事件数据源 — 暂时无法判断当前事件状态。"},
    "incidents.empty.unavailable": {
        "en": "Incident data source unavailable — the current incident status cannot be determined.",
        "th": "แหล่งข้อมูลเหตุการณ์ใช้งานไม่ได้ — ยังสรุปสถานะเหตุการณ์ปัจจุบันไม่ได้",
        "zh": "事件数据源不可用 — 暂时无法判断当前事件状态。"},
    "incidents.empty.stale": {
        "en": "Incident data is stale — it may not show current events.",
        "th": "ข้อมูลเหตุการณ์เก่าเกินไป — อาจไม่สะท้อนเหตุการณ์ปัจจุบัน",
        "zh": "事件数据已过期 — 可能未反映当前事件。"},
    "incidents.empty.reason": {"en": "Data source status: {reason}", "th": "สถานะแหล่งข้อมูล: {reason}", "zh": "数据来源状态：{reason}"},
    "incidents.field.time": {"en": "Time", "th": "เวลา", "zh": "时间"},
    "incidents.field.ip": {"en": "Attacker IP", "th": "IP ผู้โจมตี", "zh": "攻击者 IP"},
    "incidents.field.kind": {"en": "Attack type", "th": "ชนิดการโจมตี", "zh": "攻击类型"},
    "incidents.field.level": {"en": "Level", "th": "ระดับ", "zh": "级别"},
    "incidents.field.score": {"en": "Score", "th": "คะแนน", "zh": "分数"},
    "incidents.field.action": {"en": "Action", "th": "การกระทำ", "zh": "处置动作"},
    "incidents.field.outcome": {"en": "Outcome", "th": "ผล", "zh": "结果"},
    "incidents.field.mitre": {"en": "MITRE ATT&CK", "th": "MITRE ATT&CK", "zh": "MITRE ATT&CK"},
    "incidents.field.corroborated": {"en": "Corroborated", "th": "ยืนยันซ้ำ (corroboration)", "zh": "是否已佐证"},
    "incidents.field.yes": {"en": "YES", "th": "ใช่", "zh": "是"},
    "incidents.field.no": {"en": "no", "th": "ไม่", "zh": "否"},
    "incidents.kind.port_scan": {"en": "Port scan", "th": "การสแกนพอร์ต", "zh": "端口扫描"},
    "incidents.kind.ssh_brute_force": {"en": "SSH brute force", "th": "การสุ่มรหัสผ่าน SSH", "zh": "SSH 暴力破解"},
    "incidents.kind.syn_flood": {"en": "SYN flood", "th": "SYN flood", "zh": "SYN 洪泛攻击"},
    "incidents.kind.ssh_login_after_failures": {"en": "SSH login after repeated failures",
                                                "th": "เข้า SSH สำเร็จหลังพยายามผิดซ้ำ ๆ", "zh": "多次失败后成功登录 SSH"},
    "incidents.action.none": {"en": "none (log/audit only)", "th": "ไม่มี (บันทึก/ตรวจสอบเท่านั้น)", "zh": "无（仅记录/审计）"},
    "incidents.action.software_block": {"en": "software IP block", "th": "บล็อก IP ด้วยซอฟต์แวร์", "zh": "软件封锁 IP"},
    "incidents.action.recommend_cut": {"en": "recommend physical CUT", "th": "แนะนำให้ตัดสายกายภาพ", "zh": "建议执行物理 CUT"},
    "incidents.action.auto_cut": {"en": "automatic CUT", "th": "ตัดสายอัตโนมัติ", "zh": "自动 CUT"},
    "incidents.summary.highest": {"en": "Highest level right now", "th": "ระดับภัยสูงสุดปัจจุบัน", "zh": "当前最高级别"},
    "incidents.summary.latest": {"en": "Latest event", "th": "เหตุการณ์ล่าสุด", "zh": "最新事件"},
    "incidents.summary.source": {"en": "Data source status", "th": "สถานะแหล่งข้อมูล", "zh": "数据来源状态"},
    "incidents.summary.unknown": {"en": "UNKNOWN", "th": "ไม่ทราบ", "zh": "未知"},
    "incidents.summary.none": {"en": "none yet", "th": "ยังไม่มี", "zh": "尚无"},
    "incidents.summary.available": {"en": "AVAILABLE", "th": "พร้อมใช้งาน", "zh": "可用"},
    "audit.view.section": {"en": "CORE AUDIT — CUT AND RESTORE REQUESTS AND RESULTS (READ ONLY)",
                           "th": "การตรวจสอบของ Core — คำขอและผลของ CUT และ RESTORE (อ่านอย่างเดียว)",
                           "zh": "Core 审计 — CUT 与 RESTORE 请求及结果（只读）"},
    "audit.view.source": {"en": "Audit source", "th": "แหล่งข้อมูลการตรวจสอบ", "zh": "审计来源"},
    "audit.view.count": {"en": "{count} newest records shown (reasons and secrets are never shown)",
                         "th": "แสดง {count} รายการล่าสุด (ไม่แสดงเหตุผลและรหัสลับ)", "zh": "显示最新 {count} 条记录（从不显示原因与密钥）"},
    "audit.view.unavailable": {
        "en": "NOT_AVAILABLE — {reason} (set AEGIS_DESKTOP_AUDIT_DB to the Core audit database the Desktop user may read)",
        "th": "NOT_AVAILABLE — {reason} (ตั้งค่า AEGIS_DESKTOP_AUDIT_DB เป็นฐานข้อมูลตรวจสอบของ Core ที่ผู้ใช้ Desktop อ่านได้)",
        "zh": "NOT_AVAILABLE — {reason}（请将 AEGIS_DESKTOP_AUDIT_DB 设置为 Desktop 用户可读的 Core 审计数据库）"},
    "audit.view.none": {"en": "No CUT or RESTORE records.", "th": "ไม่มีบันทึก CUT หรือ RESTORE", "zh": "没有 CUT 或 RESTORE 记录。"},
    "audit.table.time": {"en": "TIME", "th": "เวลา", "zh": "时间"},
    "audit.table.event": {"en": "EVENT", "th": "เหตุการณ์", "zh": "事件"},
    "audit.table.details": {"en": "DETAILS", "th": "รายละเอียด", "zh": "详情"},
    "recovery.cause_section": {"en": "CAUSE OF CURRENT LOCKDOWN", "th": "สาเหตุของการ LOCKDOWN ในปัจจุบัน", "zh": "当前 LOCKDOWN 的原因"},
    "recovery.cause": {"en": "Most recent decision (likely cause)", "th": "การตัดสินใจล่าสุด (สาเหตุที่เป็นไปได้)",
                       "zh": "最近一次决策（可能的原因）"},
    "recovery.cause_none": {"en": "no active lockdown", "th": "ไม่มีการตัดที่ค้างอยู่", "zh": "当前无锁定"},
    "recovery.cause_value": {"en": "{ip} — {level}", "th": "{ip} — {level}", "zh": "{ip} — {level}"},
    "recovery.cause_reasons": {"en": "Reason tokens", "th": "โทเค็นสาเหตุ", "zh": "原因标记"},
    "recovery.cause_mitre": {"en": "MITRE ATT&CK", "th": "MITRE ATT&CK", "zh": "MITRE ATT&CK"},
    "recovery.cause_action": {"en": "Action → outcome", "th": "การดำเนินการ → ผลลัพธ์", "zh": "处置动作 → 结果"},
    "recovery.since": {"en": "Time since lockdown", "th": "ระยะเวลาตั้งแต่ LOCKDOWN", "zh": "锁定已持续时间"},
    "recovery.since_value": {"en": "{elapsed} ago", "th": "{elapsed} ที่แล้ว", "zh": "{elapsed}前"},
    "recovery.since_unknown": {"en": "UNKNOWN — the causing decision has no timestamp",
                               "th": "UNKNOWN — การตัดสินใจที่เป็นสาเหตุไม่มีการบันทึกเวลา",
                               "zh": "UNKNOWN — 该决策没有时间戳"},
    "recovery.blocked_section": {"en": "ACTIVE SOFTWARE BLOCKS — CONTAINMENT HELPER (READ ONLY)",
                                 "th": "การบล็อกทางซอฟต์แวร์ที่ใช้งานอยู่ — ตัวช่วยกักกัน (อ่านอย่างเดียว)",
                                 "zh": "当前生效的软件封锁 — 遏制助手（只读）"},
    "recovery.blocked_count": {"en": "Active software blocks", "th": "การบล็อกทางซอฟต์แวร์ที่ใช้งานอยู่", "zh": "当前生效的软件封锁数"},
    "recovery.blocked_none": {"en": "none", "th": "ไม่มี", "zh": "无"},
    "recovery.runbook_section": {"en": "RECOVERY RUNBOOK — READ-ONLY PREVIEW", "th": "ขั้นตอนการกู้คืน — ตัวอย่างอ่านอย่างเดียว",
                                 "zh": "恢复操作手册 — 只读预览"},
    "recovery.runbook.1": {"en": "1. Verify the threat is over — the attacker activity that caused this episode has stopped.",
                           "th": "1. ยืนยันว่าภัยคุกคามสิ้นสุดแล้ว — กิจกรรมของผู้โจมตีที่ทำให้เกิดเหตุการณ์นี้หยุดลงแล้ว",
                           "zh": "1. 确认威胁已结束 — 引发本次事件的攻击活动已停止。"},
    "recovery.runbook.2": {"en": "2. Check that the ESP32 device, the MQTT broker, and trusted time are all healthy.",
                           "th": "2. ตรวจสอบว่าอุปกรณ์ ESP32, โบรกเกอร์ MQTT และเวลาที่เชื่อถือได้ ทำงานปกติทั้งหมด",
                           "zh": "2. 检查 ESP32 设备、MQTT 代理与可信时间是否均正常。"},
    "recovery.runbook.3": {"en": "3. Confirm there is no RESTORE already pending and no RESTORE-secret lockout in effect.",
                           "th": "3. ยืนยันว่าไม่มี RESTORE ที่ค้างอยู่ และไม่มีการล็อกรหัสลับ RESTORE อยู่",
                           "zh": "3. 确认没有待处理的 RESTORE，也没有正在生效的 RESTORE 密钥锁定。"},
    "recovery.runbook.4": {"en": "4. On the Lockdown page, the operator performs RESTORE with a reason, the typed "
                                 "confirmation and the RESTORE secret.",
                           "th": "4. ที่หน้า Lockdown ผู้ปฏิบัติงานทำ RESTORE โดยระบุเหตุผล พิมพ์คำยืนยัน และใส่รหัสลับ RESTORE",
                           "zh": "4. 在“锁定”页面，操作员填写原因、输入确认文字并提供 RESTORE 密钥以执行 RESTORE。"},
    "recovery.runbook.5": {"en": "5. Confirm the Core reports DEVICE_REPORTED_NORMAL and the uplink state is NORMAL.",
                           "th": "5. ยืนยันว่า Core รายงาน DEVICE_REPORTED_NORMAL และสถานะอัปลิงก์เป็น NORMAL",
                           "zh": "5. 确认 Core 报告 DEVICE_REPORTED_NORMAL，且上行链路状态为 NORMAL。"},
    "recovery.runbook.6": {"en": "6. VERIFY PIN 2 ON THE CABLE TESTER PHYSICALLY — no software signal can prove the "
                                 "physical link is actually reconnected; this step is mandatory.",
                           "th": "6. ตรวจสอบพิน 2 บนเครื่องทดสอบสายทางกายภาพด้วยตนเอง — ไม่มีสัญญาณซอฟต์แวร์ใดพิสูจน์ได้ว่าสายกายภาพเชื่อมต่อจริง "
                                 "ขั้นนี้จำเป็นเสมอ",
                           "zh": "6. 必须亲自在线缆测试仪上核实第 2 针 — 任何软件信号都无法证明物理链路已真正重新连接，此步骤不可省略。"},
    "recovery.runbook.7": {"en": "7. Watch for a repeat detection before standing the incident down.",
                           "th": "7. เฝ้าสังเกตว่าจะมีการตรวจพบซ้ำหรือไม่ ก่อนปิดเหตุการณ์",
                           "zh": "7. 在解除事件之前，观察是否再次出现检测告警。"},
    "recovery.runbook.8": {"en": "8. Close the incident and record the outcome.",
                           "th": "8. ปิดเหตุการณ์และบันทึกผลลัพธ์",
                           "zh": "8. 关闭事件并记录处理结果。"},
}


def register_record_strings(i18n_module) -> None:
    """Add the strings to the purple i18n table; a key that already exists is never replaced."""
    for key, entry in RECORD_STRINGS.items():
        i18n_module.STRINGS.setdefault(key, dict(entry))
