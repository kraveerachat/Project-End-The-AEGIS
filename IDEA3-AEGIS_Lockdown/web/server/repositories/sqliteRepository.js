import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { operationalErrorFingerprint } from '../domain/operationalErrors.js'
import {
  AuditPersistenceError,
  DEFAULT_SETTINGS,
  auditEntryForOperationalError,
  sanitizeAuditEntry,
  containmentAuditEntry,
  safeContainmentDecision,
  sanitizeIncidentNote,
  sanitizedSettings,
  validateAuditLimit,
} from './auditRecords.js'

const SCHEMA_VERSION = 2
// v1 -> v2 is purely additive: it introduces containment_decisions and leaves
// every v1 table and audit row untouched.
const MIGRATABLE_VERSIONS = new Set([1])

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_ref TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    correlation_id TEXT,
    detail_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_acknowledgements (
    alert_id TEXT PRIMARY KEY,
    acknowledged_at TEXT NOT NULL,
    audit_id INTEGER NOT NULL REFERENCES audit_log(id)
  );
  CREATE TABLE IF NOT EXISTS incident_notes (
    incident_id TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    audit_id INTEGER NOT NULL REFERENCES audit_log(id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS active_operational_errors (
    fingerprint TEXT PRIMARY KEY,
    activated_at TEXT NOT NULL,
    audit_id INTEGER NOT NULL REFERENCES audit_log(id)
  );
  CREATE TABLE IF NOT EXISTS containment_decisions (
    incident_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT')),
    state TEXT NOT NULL CHECK (state IN ('CONTAINMENT_ACCEPTED', 'CONTAINMENT_REJECTED')),
    correlation_key TEXT,
    severity TEXT NOT NULL,
    evidence_ids_json TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    audit_id INTEGER NOT NULL REFERENCES audit_log(id)
  );
`

function wrap(operation, error) {
  return error instanceof AuditPersistenceError ? error : new AuditPersistenceError(operation, error)
}

function parseDetail(value) {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitizeAuditEntry({ detail: parsed }).detail
  } catch {
    return {}
  }
}

function auditRecord(row) {
  return {
    id: `audit-${String(row.id).padStart(5, '0')}`,
    timestamp: row.occurred_at,
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    actorRef: row.actor_ref,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    correlationId: row.correlation_id,
    detail: parseDetail(row.detail_json),
  }
}

function nowIso(clock) {
  const now = clock()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Repository clock must return a valid Date')
  }
  return now.toISOString()
}

export function createSqliteRepository({ path, clock = () => new Date() }) {
  let database
  let insertAudit
  let closed = false

  try {
    if (typeof path !== 'string' || path.length === 0) throw new TypeError('A SQLite path is required')
    const databasePath = path === ':memory:' ? path : resolve(path)
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    database = new DatabaseSync(databasePath)
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(SCHEMA)
      database.prepare('INSERT OR IGNORE INTO schema_meta (singleton, version) VALUES (1, ?)').run(SCHEMA_VERSION)
      const metadata = database.prepare('SELECT version FROM schema_meta WHERE singleton = 1').get()
      const storedVersion = Number(metadata?.version)
      if (storedVersion !== SCHEMA_VERSION) {
        if (!MIGRATABLE_VERSIONS.has(storedVersion)) throw new Error('Unsupported audit schema version')
        database.prepare('UPDATE schema_meta SET version = ? WHERE singleton = 1').run(SCHEMA_VERSION)
      }
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      throw error
    }
    insertAudit = database.prepare(`
      INSERT INTO audit_log (
        occurred_at, category, action, outcome, actor_ref, resource_type, resource_id, correlation_id, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  } catch (error) {
    try { database?.close() } catch {}
    throw wrap('open', error)
  }

  function transaction(operation, callback) {
    try {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = callback()
        database.exec('COMMIT')
        return result
      } catch (error) {
        try { database.exec('ROLLBACK') } catch {}
        throw error
      }
    } catch (error) {
      throw wrap(operation, error)
    }
  }

  function insertAuditRecord(entry, occurredAt) {
    const safe = sanitizeAuditEntry(entry)
    const result = insertAudit.run(
      occurredAt,
      safe.category,
      safe.action,
      safe.outcome,
      safe.actorRef,
      safe.resourceType,
      safe.resourceId,
      safe.correlationId,
      JSON.stringify(safe.detail),
    )
    return {
      databaseId: Number(result.lastInsertRowid),
      record: {
        id: `audit-${String(result.lastInsertRowid).padStart(5, '0')}`,
        timestamp: occurredAt,
        ...safe,
      },
    }
  }

  function recordAction(entry) {
    return transaction('record action', () => insertAuditRecord(entry, nowIso(clock)).record)
  }

  function acknowledgeAlert(id) {
    return transaction('acknowledge alert', () => {
      const occurredAt = nowIso(clock)
      const audit = insertAuditRecord({
        category: 'ALERT', action: 'ACKNOWLEDGE', outcome: 'SUCCESS', actorRef: 'session-admin',
        resourceType: 'alert', resourceId: id,
      }, occurredAt)
      database.prepare(`
        INSERT INTO alert_acknowledgements (alert_id, acknowledged_at, audit_id) VALUES (?, ?, ?)
        ON CONFLICT(alert_id) DO UPDATE SET acknowledged_at = excluded.acknowledged_at, audit_id = excluded.audit_id
      `).run(id, occurredAt, audit.databaseId)
      return audit.record
    })
  }

  function addIncidentNote(id, note) {
    return transaction('add incident note', () => {
      const occurredAt = nowIso(clock)
      const safeNote = sanitizeIncidentNote(note)
      const audit = insertAuditRecord({
        category: 'INCIDENT', action: 'ADD_NOTE', outcome: 'SUCCESS', actorRef: 'session-admin',
        resourceType: 'incident', resourceId: id,
      }, occurredAt)
      database.prepare(`
        INSERT INTO incident_notes (incident_id, note, updated_at, audit_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(incident_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at, audit_id = excluded.audit_id
      `).run(id, safeNote, occurredAt, audit.databaseId)
      return audit.record
    })
  }

  function containmentDecisionRow(row) {
    let evidenceIds = []
    try {
      const parsed = JSON.parse(row.evidence_ids_json)
      if (Array.isArray(parsed)) evidenceIds = parsed.filter((id) => typeof id === 'string')
    } catch {
      evidenceIds = []
    }
    return {
      incidentId: row.incident_id,
      decision: row.decision,
      state: row.state,
      correlationKey: row.correlation_key,
      severity: row.severity,
      evidenceIds,
    }
  }

  function readContainmentDecision(incidentId) {
    try {
      const row = database.prepare('SELECT * FROM containment_decisions WHERE incident_id = ?').get(incidentId)
      return row ? containmentDecisionRow(row) : null
    } catch (error) {
      throw wrap('read containment decision', error)
    }
  }

  /**
   * Record one durable Admin containment decision.
   *
   * Repeating the same decision is idempotent and writes no second audit row; the
   * opposite decision conflicts and leaves the stored decision unchanged, so an
   * accepted candidate can never be silently reversed.
   */
  function recordContainmentDecision(decision) {
    return transaction('record containment decision', () => {
      const safe = safeContainmentDecision(decision)
      const existing = database.prepare('SELECT * FROM containment_decisions WHERE incident_id = ?').get(safe.incidentId)
      if (existing) {
        const stored = containmentDecisionRow(existing)
        return { status: stored.decision === safe.decision ? 'UNCHANGED' : 'CONFLICT', ...stored, audit: null }
      }

      const occurredAt = nowIso(clock)
      const audit = insertAuditRecord(containmentAuditEntry(safe), occurredAt)
      database.prepare(`
        INSERT INTO containment_decisions (
          incident_id, decision, state, correlation_key, severity, evidence_ids_json, decided_at, audit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        safe.incidentId,
        safe.decision,
        safe.state,
        safe.correlationKey,
        safe.severity,
        JSON.stringify(safe.evidenceIds),
        occurredAt,
        audit.databaseId,
      )
      return { status: 'RECORDED', ...safe, audit: audit.record }
    })
  }

  function schemaVersion() {
    try {
      return Number(database.prepare('SELECT version FROM schema_meta WHERE singleton = 1').get()?.version)
    } catch (error) {
      throw wrap('read schema version', error)
    }
  }

  function updateSettings(next) {
    return transaction('update settings', () => {
      const occurredAt = nowIso(clock)
      const safe = sanitizedSettings(next)
      const statement = database.prepare(`
        INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      for (const [key, value] of Object.entries(safe)) statement.run(key, JSON.stringify(value), occurredAt)
      return readSettings()
    })
  }

  function recordOperationalErrors(errors) {
    return transaction('record operational errors', () => {
      const occurredAt = nowIso(clock)
      const unique = new Map()
      for (const error of Array.isArray(errors) ? errors : []) {
        unique.set(operationalErrorFingerprint(error), error)
      }
      const active = new Set(database.prepare('SELECT fingerprint FROM active_operational_errors').all().map(({ fingerprint }) => fingerprint))
      const current = new Set(unique.keys())
      const remove = database.prepare('DELETE FROM active_operational_errors WHERE fingerprint = ?')
      for (const fingerprint of active) {
        if (!current.has(fingerprint)) remove.run(fingerprint)
      }

      const activate = database.prepare('INSERT INTO active_operational_errors (fingerprint, activated_at, audit_id) VALUES (?, ?, ?)')
      const recorded = []
      for (const [fingerprint, error] of unique) {
        if (active.has(fingerprint)) continue
        const audit = insertAuditRecord(auditEntryForOperationalError(error), occurredAt)
        activate.run(fingerprint, occurredAt, audit.databaseId)
        recorded.push(audit.record)
      }
      return recorded
    })
  }

  function queryAudit({ limit = 100 } = {}) {
    validateAuditLimit(limit)
    try {
      return database.prepare(`
        SELECT id, occurred_at, category, action, outcome, actor_ref, resource_type, resource_id, correlation_id, detail_json
        FROM audit_log
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `).all(limit).map(auditRecord)
    } catch (error) {
      throw wrap('query audit', error)
    }
  }

  function readSettings() {
    const stored = Object.fromEntries(database.prepare('SELECT key, value_json FROM settings ORDER BY key').all().flatMap(({ key, value_json }) => {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return []
      try {
        const value = JSON.parse(value_json)
        return Number.isSafeInteger(value) ? [[key, value]] : []
      } catch {
        return []
      }
    }))
    return { ...DEFAULT_SETTINGS, ...stored }
  }

  function apply(snapshot) {
    try {
      const acknowledgements = new Set(database.prepare('SELECT alert_id FROM alert_acknowledgements').all().map(({ alert_id }) => alert_id))
      const notes = new Map(database.prepare('SELECT incident_id, note FROM incident_notes').all().map(({ incident_id, note }) => [incident_id, note]))
      return {
        ...snapshot,
        alerts: snapshot.alerts.map((alert) => acknowledgements.has(alert.id) ? { ...alert, status: 'ACKNOWLEDGED' } : alert),
        incidents: snapshot.incidents.map((incident) => notes.has(incident.id) ? { ...incident, analystNote: notes.get(incident.id) } : incident),
        audit: [...queryAudit({ limit: 250 }), ...snapshot.audit],
        settings: { ...snapshot.settings, policy: { ...snapshot.settings.policy, ...readSettings() } },
      }
    } catch (error) {
      throw wrap('apply durable state', error)
    }
  }

  function close() {
    if (closed) return
    try {
      database.close()
      closed = true
    } catch (error) {
      throw wrap('close', error)
    }
  }

  return {
    recordAction,
    acknowledgeAlert,
    addIncidentNote,
    recordContainmentDecision,
    readContainmentDecision,
    schemaVersion,
    updateSettings,
    recordOperationalErrors,
    queryAudit,
    apply,
    close,
  }
}
