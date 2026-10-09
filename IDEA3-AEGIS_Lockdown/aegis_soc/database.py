"""
AEGIS IDEA 3 — Database & structured logging
- audit_logs: บันทึกทุกเหตุการณ์ พร้อม "ระดับความรุนแรง" (severity)
- incidents: โมเดลเหตุการณ์ที่มีวงจรชีวิต (OPEN → CONTAINED → CLOSED)
- เขียน log ลงไฟล์แบบหมุนเวียน (RotatingFileHandler) ควบคู่กับ SQLite
"""
import logging
import sqlite3
import threading
import time
from logging.handlers import RotatingFileHandler

from . import comms, config

# ---- ระดับความรุนแรง ----
INFO = "INFO"
WARN = "WARN"
CRITICAL = "CRITICAL"

# เหตุการณ์ที่ให้ยิงเข้า Telegram (ops alert) ด้วย
_OPS_ALERT_EVENTS = {"SECURITY_ALERT", "UFW_BLOCK", "RECOVERY_STEP", "INCIDENT_CLOSED", "RESTORE_BREAK_GLASS_CLAIM"}

# ---- file logger ----
_logger = logging.getLogger("aegis_soc")
_logger.setLevel(logging.INFO)
if not _logger.handlers:
    _h = RotatingFileHandler(config.LOG_PATH, maxBytes=512_000, backupCount=5, encoding="utf-8")
    _h.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-8s | %(message)s"))
    _logger.addHandler(_h)

_LEVEL_MAP = {INFO: logging.INFO, WARN: logging.WARNING, CRITICAL: logging.CRITICAL}

_AUDIT_WRITE_LOCK = threading.Lock()


def _connect():
    return sqlite3.connect(config.DB_PATH)


def init_db():
    conn = _connect()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            level TEXT DEFAULT 'INFO',
            event_type TEXT,
            details TEXT,
            incident_id INTEGER,
            hash TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opened_at TEXT,
            closed_at TEXT,
            state TEXT DEFAULT 'OPEN',
            attacker_ip TEXT,
            summary TEXT
        )
    """)
    conn.commit()
    _ensure_restore_one_shot_index(conn)
    _ensure_break_glass_schema(conn)
    conn.close()


def _ensure_restore_one_shot_index(conn) -> None:
    """At most one RESTORE_REQUESTED audit row per non-null incident (the durable one-shot, enforced by SQLite).

    Historical rows are never rewritten. Rows with a NULL incident_id (the original D4 behaviour) are outside the
    index, so they neither collide nor consume an incident. If old data already violates the invariant the index
    cannot be built; initialization fails closed rather than running without the database-level one-shot invariant.
    Existing audit history is preserved for explicit operator remediation.
    """
    try:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_restore_requested_incident "
            "ON audit_logs (incident_id) WHERE event_type = 'RESTORE_REQUESTED' AND incident_id IS NOT NULL"
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        raise

def _ensure_break_glass_schema(conn) -> None:
    """Durable lockdown episodes and the one-claim-per-episode break-glass records (idempotent, history preserved).

    ``lockdown_episodes`` begins only from an authenticated Protocol-v1 STATUS=LOCKDOWN and is closed only by a later
    authenticated STATUS=NORMAL; the partial unique index allows at most one open episode per device. Every episode
    allows at most one claim (``episode_id`` is UNIQUE), enforced by SQLite across processes and connections. Rows are
    never deleted. If old data already violates an invariant the index cannot be built and initialization fails closed;
    nothing is rewritten.
    """
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS lockdown_episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                opened_at TEXT NOT NULL,
                open_msg_id TEXT NOT NULL,
                closed_at TEXT,
                close_msg_id TEXT
            )
        """)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_lockdown_episode_open ON lockdown_episodes (device_id) "
            "WHERE closed_at IS NULL"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS restore_break_glass_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_id INTEGER NOT NULL UNIQUE REFERENCES lockdown_episodes (id),
                claimed_at TEXT NOT NULL,
                claim_case TEXT NOT NULL CHECK (claim_case IN ('NO_INCIDENT', 'R3_FAILED')),
                incident_id INTEGER,
                reason TEXT NOT NULL,
                dispatched_at TEXT
            )
        """)
        for table in ("lockdown_episodes", "restore_break_glass_claims"):
            conn.execute(
                f"CREATE TRIGGER IF NOT EXISTS trg_{table}_no_delete BEFORE DELETE ON {table} "
                "BEGIN SELECT RAISE(ABORT, 'history is never deleted'); END"
            )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        raise


def record_authenticated_status(device_id, state, msg_id):
    """Apply one AUTHENTICATED Protocol-v1 STATUS to the durable lockdown-episode model.

    LOCKDOWN opens an episode unless one is already open for the device (it never multiplies); NORMAL closes the open
    episode. Returns the open episode id after a LOCKDOWN, otherwise None. Raises on any database failure.
    """
    if state not in ("LOCKDOWN", "NORMAL") or not device_id or not msg_id:
        return None
    t_str = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id FROM lockdown_episodes WHERE device_id = ? AND closed_at IS NULL", (device_id,)
        ).fetchone()
        episode_id = None
        if state == "LOCKDOWN":
            if row:
                episode_id = row[0]
            else:
                episode_id = conn.execute(
                    "INSERT INTO lockdown_episodes (device_id, opened_at, open_msg_id) VALUES (?, ?, ?)",
                    (device_id, t_str, msg_id),
                ).lastrowid
        elif row:
            conn.execute(
                "UPDATE lockdown_episodes SET closed_at = ?, close_msg_id = ? WHERE id = ?", (t_str, msg_id, row[0])
            )
        conn.commit()
        return episode_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_open_lockdown_episode(device_id):
    """The one open durable lockdown episode for a device, or None. Durable identity only: NOT live eligibility."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, opened_at, open_msg_id FROM lockdown_episodes WHERE device_id = ? AND closed_at IS NULL",
            (device_id,),
        ).fetchone()
    finally:
        conn.close()
    return {"id": row[0], "opened_at": row[1], "open_msg_id": row[2]} if row else None


def fetch_lockdown_episodes(device_id=None):
    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        sql = "SELECT id, device_id, opened_at, open_msg_id, closed_at, close_msg_id FROM lockdown_episodes"
        rows = conn.execute(sql + (" WHERE device_id = ?" if device_id else "") + " ORDER BY id", (device_id,) if device_id else ()).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def break_glass_claim_for_episode(episode_id):
    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM restore_break_glass_claims WHERE episode_id = ?", (episode_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def claim_break_glass(episode_id, claim_case, incident_id, reason, details):
    """Spend the one break-glass claim of an OPEN episode and append its dedicated audit row, in ONE transaction.

    Raises ``sqlite3.IntegrityError`` when the episode already has a claim (the database-level uniqueness), or when it
    is no longer open. The audit row is ``RESTORE_BREAK_GLASS_CLAIM`` with a NULL incident_id on purpose: it is neither a
    normal ``RESTORE_REQUESTED`` (R4 / one-shot) nor an incident-bound R5 publication. Returns the claim id.
    """
    t_str = time.strftime("%Y-%m-%d %H:%M:%S")
    with _AUDIT_WRITE_LOCK:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            open_row = conn.execute(
                "SELECT 1 FROM lockdown_episodes WHERE id = ? AND closed_at IS NULL", (episode_id,)
            ).fetchone()
            if open_row is None:
                raise sqlite3.IntegrityError("lockdown episode is not open")
            claim_id = conn.execute(
                "INSERT INTO restore_break_glass_claims (episode_id, claimed_at, claim_case, incident_id, reason) "
                "VALUES (?, ?, ?, ?, ?)",
                (episode_id, t_str, claim_case, incident_id, reason),
            ).lastrowid
            full = f"claim_id={claim_id} episode_id={episode_id} case={claim_case} {details}"
            prev_hash = _get_last_hash(conn)
            conn.execute(
                "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) "
                "VALUES (?, ?, ?, ?, NULL, ?)",
                (t_str, CRITICAL, "RESTORE_BREAK_GLASS_CLAIM", full,
                 _compute_hash(t_str, CRITICAL, "RESTORE_BREAK_GLASS_CLAIM", full, prev_hash)),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    try:  # notification is after durability; it never unspends or retries the claim
        _emit_event("RESTORE_BREAK_GLASS_CLAIM", full, CRITICAL)
    except Exception:
        pass
    return claim_id


HISTORICAL_DISPOSITION_EVENT = "INCIDENT_DISPOSED_HISTORICAL"


def dispose_historical_incident_atomic(plan_fn, *, summary, level=None):
    """R1D: the historical-incident disposition as ONE all-or-nothing transaction (modelled on ``claim_break_glass``).

    ``plan_fn(conn)`` runs INSIDE the write transaction: it re-reads and re-checks the complete eligibility predicate
    and returns ``{"incident_id": int, "details": str}`` or raises to refuse. Then, in the same transaction, the
    database-level one-shot index is ensured, ONE ``INCIDENT_DISPOSED_HISTORICAL`` audit row is appended with the
    chain hash computed from the same transaction, and exactly one eligible incident goes OPEN -> CLOSED (a rowcount
    other than 1 fails the whole transaction). Any failure rolls the audit row and the transition back together.
    Notification/log emission happens only after the durable commit and never undoes or repeats the disposition.
    """
    level = INFO if level is None else level
    t_str = time.strftime("%Y-%m-%d %H:%M:%S")
    with _AUDIT_WRITE_LOCK:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            plan = plan_fn(conn)
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_historical_disposition ON audit_logs (event_type) "
                "WHERE event_type = 'INCIDENT_DISPOSED_HISTORICAL'"
            )
            prev_hash = _get_last_hash(conn)
            conn.execute(
                "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) VALUES (?, ?, ?, ?, ?, ?)",
                (t_str, level, HISTORICAL_DISPOSITION_EVENT, plan["details"], plan["incident_id"],
                 _compute_hash(t_str, level, HISTORICAL_DISPOSITION_EVENT, plan["details"], prev_hash)),
            )
            cursor = conn.execute(
                "UPDATE incidents SET state='CLOSED', closed_at=?, summary=? WHERE id=? AND state != 'CLOSED'",
                (t_str, summary, plan["incident_id"]),
            )
            if cursor.rowcount != 1:
                raise sqlite3.IntegrityError("the historical incident transition did not affect exactly one eligible incident")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    try:  # after durability only; it never rolls back or repeats the disposition
        _emit_event(HISTORICAL_DISPOSITION_EVENT, plan["details"], level)
    except Exception:
        pass
    return plan["incident_id"]


def consume_break_glass_claim(claim_id, episode_id) -> bool:
    """Atomically mark a real, spent claim as dispatched exactly once (a forged or reused basis cannot pass)."""
    t_str = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = _connect()
    try:
        cursor = conn.execute(
            "UPDATE restore_break_glass_claims SET dispatched_at = ? "
            "WHERE id = ? AND episode_id = ? AND dispatched_at IS NULL",
            (t_str, claim_id, episode_id),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()


import hashlib


def _get_last_hash(conn):
    """ดึง hash ของแถวล่าสุดจาก connection/transaction เดียวกับ writer"""
    c = conn.cursor()
    c.execute("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1")
    row = c.fetchone()
    return row[0] if row and row[0] else "GENESIS"

def _compute_hash(timestamp, level, event_type, details, prev_hash):
    """คำนวณลายนิ้วมือของแถวนี้ = hash(ข้อมูลแถวนี้ + hash แถวก่อน)"""
    data = f"{timestamp}|{level}|{event_type}|{details}|{prev_hash}"
    return hashlib.sha256(data.encode("utf-8")).hexdigest()

def _append_event(event_type, details, level=INFO, incident_id=None):
    t_str = time.strftime("%Y-%m-%d %H:%M:%S")
    with _AUDIT_WRITE_LOCK:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            prev_hash = _get_last_hash(conn)
            row_hash = _compute_hash(t_str, level, event_type, details, prev_hash)
            conn.execute(
                "INSERT INTO audit_logs "
                "(timestamp, level, event_type, details, incident_id, hash) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (t_str, level, event_type, details, incident_id, row_hash),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _emit_event(event_type, details, level):

    _logger.log(
        _LEVEL_MAP.get(level, logging.INFO),
        f"[{event_type}] {details}",
    )

    if event_type in _OPS_ALERT_EVENTS:
        comms.send_ops_alert(event_type, details)


def log_event_strict(event_type, details, level=INFO, incident_id=None):
    """Append a durable audit row or raise before the caller takes action."""
    _append_event(event_type, details, level, incident_id)
    _emit_event(event_type, details, level)


def log_event(event_type, details, level=INFO, incident_id=None):
    """Best-effort legacy logger; safety gates use ``log_event_strict``."""
    try:
        _append_event(event_type, details, level, incident_id)
    except Exception as error:
        print(f"DB Error: {error}")
    _emit_event(event_type, details, level)

def verify_chain():
    """ตรวจสอบความสมบูรณ์ของ hash chain ทั้งหมด
    คืน (is_valid, message) — ถ้าถูกแก้จะบอกว่าแถวไหน"""
    conn = _connect()
    c = conn.cursor()
    c.execute("SELECT id, timestamp, level, event_type, details, hash "
              "FROM audit_logs ORDER BY id ASC")
    rows = c.fetchall()
    conn.close()

    prev_hash = "GENESIS"
    for row in rows:
        rid, ts, level, etype, details, stored_hash = row
        # คำนวณ hash ใหม่จากข้อมูลแถวนี้ + hash แถวก่อน
        expected = _compute_hash(ts, level, etype, details, prev_hash)
        if expected != stored_hash:
            return (False, f"⚠️ พบการแก้ไขที่แถว id={rid} ({etype}) — hash ไม่ตรง")
        prev_hash = stored_hash   # เลื่อนไปเป็นข้อต่อของแถวถัดไป

    return (True, f"✅ ตรวจสอบ {len(rows)} รายการ — ลูกโซ่สมบูรณ์ ไม่มีการแก้ไข")

def log_to_file_only(message, level=INFO):
    """เขียนลงไฟล์ log อย่างเดียว (ไม่แตะ DB) — ใช้กับข้อความที่ขึ้นจอทุกบรรทัด"""
    _logger.log(_LEVEL_MAP.get(level, logging.INFO), message)


# ---------------- Incident lifecycle ----------------
def create_incident(attacker_ip=None):
    """เปิดเหตุการณ์ใหม่ คืน incident_id (ถ้ามีเหตุการณ์เปิดค้างอยู่แล้ว คืนอันนั้นแทน)"""
    existing = get_open_incident()
    if existing:
        if attacker_ip and not existing.get("attacker_ip"):
            set_incident_ip(existing["id"], attacker_ip)
        return existing["id"]
    t_str = time.strftime('%Y-%m-%d %H:%M:%S')
    conn = _connect()
    c = conn.cursor()
    c.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)",
              (t_str, attacker_ip))
    iid = c.lastrowid
    conn.commit()
    conn.close()
    return iid


def get_open_incident():
    conn = _connect()
    c = conn.cursor()
    c.execute("SELECT id, opened_at, state, attacker_ip FROM incidents "
              "WHERE state != 'CLOSED' ORDER BY id DESC LIMIT 1")
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    return {"id": row[0], "opened_at": row[1], "state": row[2], "attacker_ip": row[3]}


def count_open_incidents():
    """Number of incidents that are not CLOSED (Recovery requires exactly one before it allows a RESTORE)."""
    conn = _connect()
    try:
        return conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]
    finally:
        conn.close()


def set_incident_state(incident_id, state):
    conn = _connect()
    c = conn.cursor()
    c.execute("UPDATE incidents SET state=? WHERE id=?", (state, incident_id))
    conn.commit()
    conn.close()


def set_incident_ip(incident_id, ip):
    conn = _connect()
    c = conn.cursor()
    c.execute("UPDATE incidents SET attacker_ip=? WHERE id=?", (ip, incident_id))
    conn.commit()
    conn.close()


def close_incident(incident_id, summary):
    t_str = time.strftime('%Y-%m-%d %H:%M:%S')
    conn = _connect()
    c = conn.cursor()
    c.execute("UPDATE incidents SET state='CLOSED', closed_at=?, summary=? WHERE id=?",
              (t_str, summary, incident_id))
    conn.commit()
    conn.close()


def count_incidents_today():
    today = time.strftime('%Y-%m-%d')
    conn = _connect()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM incidents WHERE opened_at LIKE ?", (today + '%',))
    n = c.fetchone()[0]
    conn.close()
    return n



def fetch_incidents(limit=100):
    """Return the newest incident records for read-only operator views."""
    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, opened_at, closed_at, state, attacker_ip, summary "
            "FROM incidents ORDER BY id DESC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def ping() -> bool:
    """Bounded, read-only self-check: can this process open and query its own audit database."""
    try:
        conn = _connect()
        try:
            conn.execute("SELECT 1").fetchone()
            return True
        finally:
            conn.close()
    except sqlite3.Error:
        return False


def restore_attempt_exists(incident_id) -> bool:
    """True when a durable RESTORE_REQUESTED audit row is bound to this incident (a spent R5 attempt)."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT 1 FROM audit_logs WHERE event_type = 'RESTORE_REQUESTED' AND incident_id = ? LIMIT 1",
            (incident_id,),
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def fetch_incident_events(incident_id, event_types, limit=20):
    """Newest-first audit rows bound to one incident for the given event types (read-only)."""
    types = tuple(event_types)
    if not types:
        return []
    conn = _connect()
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, timestamp, level, event_type, details FROM audit_logs "
            f"WHERE incident_id = ? AND event_type IN ({','.join('?' * len(types))}) ORDER BY id DESC LIMIT ?",
            (incident_id, *types, max(1, int(limit))),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def fetch_all_logs():
    conn = _connect()
    c = conn.cursor()
    c.execute("SELECT id, timestamp, level, event_type, details, incident_id "
              "FROM audit_logs ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return rows
