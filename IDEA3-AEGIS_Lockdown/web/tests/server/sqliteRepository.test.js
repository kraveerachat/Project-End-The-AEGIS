import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperationalError } from '../../server/domain/operationalErrors.js'
import { AuditPersistenceError, sanitizeAuditEntry } from '../../server/repositories/auditRecords.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'

const opened = []

function testDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-idea3-audit-'))
  return { directory, path: join(directory, 'nested', 'audit.sqlite') }
}

function fixedClock(iso = '2026-09-08T01:02:03.000Z') {
  return () => new Date(iso)
}

function openRepository(options) {
  const repository = createSqliteRepository(options)
  opened.push(repository)
  return repository
}

function snapshot() {
  return {
    alerts: [{ id: 'alert-1', status: 'UNACKNOWLEDGED' }],
    incidents: [{ id: 'incident-1', analystNote: null }],
    audit: [],
    settings: { policy: { dedupWindowSeconds: 60 } },
  }
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop().close()
    } catch {
      // Tests which intentionally close or break a repository own that state.
    }
  }
})

describe('SQLite audit repository', () => {
  it('creates schema version 2, the required tables, WAL storage, and parent directories', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })

    const inspection = new DatabaseSync(database.path)
    const tables = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name)
    const schemaRows = inspection.prepare('SELECT singleton, version FROM schema_meta ORDER BY singleton').all()
    const journalMode = inspection.prepare('PRAGMA journal_mode').get().journal_mode
    inspection.close()

    expect(schemaRows).toEqual([{ singleton: 1, version: 2 }])
    expect(tables).toEqual(expect.arrayContaining([
      'schema_meta', 'audit_log', 'alert_acknowledgements', 'incident_notes', 'settings', 'active_operational_errors',
      'containment_decisions', 'integration_lifecycle', 'correlated_incidents',
    ]))
    expect(journalMode).toBe('wal')
    expect(repository.queryAudit({ limit: 10 })).toEqual([])
  })

  it('writes safe audit details and reads correlation metadata', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })

    const record = repository.recordAction({
      category: 'COMMAND',
      action: 'REQUESTED',
      outcome: 'DENIED',
      actorRef: 'session-admin',
      resourceType: 'incident',
      resourceId: 'incident-1',
      correlationId: 'command-42',
      detail: { stage: 'VALIDATION', password: 'never-store-this-password' },
    })

    expect(record).toMatchObject({
      id: 'audit-00001',
      timestamp: '2026-09-08T01:02:03.000Z',
      category: 'COMMAND',
      action: 'REQUESTED',
      outcome: 'DENIED',
      actorRef: 'session-admin',
      resourceType: 'incident',
      resourceId: 'incident-1',
      correlationId: 'command-42',
      detail: { stage: 'VALIDATION' },
    })
    expect(repository.queryAudit({ limit: 1 })).toEqual([record])
  })

  it('returns newest records first with stable id ordering when timestamps match', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })

    repository.recordAction({ category: 'TEST', action: 'FIRST', outcome: 'SUCCESS' })
    repository.recordAction({ category: 'TEST', action: 'SECOND', outcome: 'SUCCESS' })

    expect(repository.queryAudit({ limit: 2 }).map(({ id, action }) => ({ id, action }))).toEqual([
      { id: 'audit-00002', action: 'SECOND' },
      { id: 'audit-00001', action: 'FIRST' },
    ])
  })

  it.each([0, 251, 1.5, '10', Number.NaN, null])('rejects an invalid audit query limit: %s', (limit) => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })

    expect(() => repository.queryAudit({ limit })).toThrow(RangeError)
  })

  it('keeps acknowledgements, incident notes, settings, and audit records across restart', () => {
    const database = testDatabase()
    const first = openRepository({ path: database.path, clock: fixedClock() })
    first.acknowledgeAlert('alert-1')
    first.addIncidentNote('incident-1', 'Validated by the duty analyst')
    first.updateSettings({ dedupWindowSeconds: 90, auditRetentionDays: 365 })
    first.close()

    const reopened = openRepository({ path: database.path, clock: fixedClock('2026-09-08T02:03:04.000Z') })
    const applied = reopened.apply(snapshot())

    expect(applied.alerts[0].status).toBe('ACKNOWLEDGED')
    expect(applied.incidents[0].analystNote).toBe('Validated by the duty analyst')
    expect(applied.settings.policy).toMatchObject({ dedupWindowSeconds: 90, auditRetentionDays: 365 })
    expect(applied.audit.map(({ action }) => action)).toEqual(['ADD_NOTE', 'ACKNOWLEDGE'])
  })

  it('records an operational error once per active period and again after recovery', () => {
    const database = testDatabase()
    let repository = openRepository({ path: database.path, clock: fixedClock() })
    const error = createOperationalError('COMMAND_TIMEOUT', {
      occurredAt: '2026-09-08T00:59:00.000Z',
      correlationId: 'command-99',
    })

    repository.recordOperationalErrors([error, error])
    repository.close()
    repository = openRepository({ path: database.path, clock: fixedClock('2026-09-08T02:03:04.000Z') })
    repository.recordOperationalErrors([error])
    expect(repository.queryAudit({ limit: 10 })).toHaveLength(1)

    repository.recordOperationalErrors([])
    repository.recordOperationalErrors([error])

    const records = repository.queryAudit({ limit: 10 })
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.action === 'COMMAND_TIMEOUT')).toBe(true)
    expect(records.every((record) => record.correlationId === 'command-99')).toBe(true)
  })

  it('treats malformed persisted detail JSON as an empty safe object', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })
    repository.recordAction({ category: 'TEST', action: 'MALFORMED_DETAIL', outcome: 'SUCCESS', detail: { safe: true } })

    const mutation = new DatabaseSync(database.path)
    mutation.prepare("UPDATE audit_log SET detail_json = 'not-json' WHERE id = 1").run()
    mutation.close()

    expect(repository.queryAudit({ limit: 1 })[0].detail).toEqual({})
  })

  it('wraps open failures without leaking the database path', () => {
    const database = testDatabase()

    expect(() => createSqliteRepository({ path: database.directory, clock: fixedClock() })).toThrow(AuditPersistenceError)
    try {
      createSqliteRepository({ path: database.directory, clock: fixedClock() })
    } catch (error) {
      expect(error.message).not.toContain(database.directory)
      expect(error.code).toBe('AUDIT_PERSISTENCE_FAILURE')
    }
  })

  it('wraps prepared-statement setup failures from an incompatible existing schema', () => {
    const database = testDatabase()
    const incompatiblePath = join(database.directory, 'incompatible.sqlite')
    const seed = new DatabaseSync(incompatiblePath)
    seed.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY)')
    seed.close()

    expect(() => createSqliteRepository({ path: incompatiblePath, clock: fixedClock() })).toThrow(AuditPersistenceError)
  })

  it('wraps transaction failures and rolls back the durable acknowledgement', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })
    const mutation = new DatabaseSync(database.path)
    mutation.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'forced write failure'); END")

    expect(() => repository.acknowledgeAlert('alert-1')).toThrow(AuditPersistenceError)
    mutation.exec('DROP TRIGGER reject_audit')
    mutation.close()

    expect(repository.apply(snapshot()).alerts[0].status).toBe('UNACKNOWLEDGED')
    expect(repository.queryAudit({ limit: 10 })).toEqual([])
  })

  it('wraps queries attempted after close', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })
    repository.close()

    expect(() => repository.queryAudit({ limit: 1 })).toThrow(AuditPersistenceError)
  })

  it('never writes secret-bearing fields, paths, stacks, or raw payloads to SQLite files', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })
    repository.recordAction({
      category: 'AUDIT', action: 'SANITIZE', outcome: 'SUCCESS',
      password: 'CANARY_PASSWORD_8675309',
      cookie: 'CANARY_COOKIE_8675309',
      session: 'CANARY_SESSION_8675309',
      csrfToken: 'CANARY_CSRF_8675309',
      passwordHash: 'CANARY_HASH_8675309',
      hmacCredential: 'CANARY_HMAC_8675309',
      mqttCredential: 'CANARY_MQTT_8675309',
      path: 'CANARY_PATH_8675309',
      stack: 'CANARY_STACK_8675309',
      rawPayload: 'CANARY_PAYLOAD_8675309',
      detail: {
        safe: 'retained',
        nested: { authorization: 'CANARY_AUTH_8675309', token: 'CANARY_TOKEN_8675309' },
      },
    })
    repository.close()

    const databaseBytes = readdirSync(join(database.directory, 'nested'))
      .map((name) => readFileSync(join(database.directory, 'nested', name)))
      .map((contents) => contents.toString('utf8'))
      .join('')

    expect(databaseBytes).toContain('retained')
    expect(databaseBytes).not.toMatch(/CANARY_(PASSWORD|COOKIE|SESSION|CSRF|HASH|HMAC|MQTT|PATH|STACK|PAYLOAD|AUTH|TOKEN)_8675309/)
  })

  it('redacts an unsafe incident note before SQLite or memory state claims it was persisted', () => {
    const database = testDatabase()
    let repository = openRepository({ path: database.path, clock: fixedClock() })
    const unsafeNotes = [
      ['incident-password', 'password=NOTE_PASSWORD_CANARY_8675309'],
      ['incident-token', 'token=NOTE_TOKEN_CANARY_8675309'],
      ['incident-path', '/srv/NOTE_PATH_CANARY_8675309/private'],
      ['incident-stack', 'stack trace: NOTE_STACK_CANARY_8675309'],
      ['incident-payload', 'rawPayload=NOTE_PAYLOAD_CANARY_8675309'],
      ['incident-api-key', 'apiKey=NOTE_API_KEY_CANARY_8675309'],
      ['incident-hash', 'hash=NOTE_HASH_CANARY_8675309'],
      ['incident-mqtt-password', 'mqttPassword=NOTE_MQTT_PASSWORD_CANARY_8675309'],
      ['incident-windows-path', 'C:\\Aegis\\NOTE_WINDOWS_PATH_CANARY_8675309\\private.txt'],
      ['incident-windows-slash-path', 'C:/Aegis/NOTE_WINDOWS_SLASH_PATH_CANARY_8675309/private.txt'],
      ['incident-windows-unc-path', '\\\\server\\share\\NOTE_WINDOWS_UNC_PATH_CANARY_8675309\\private.txt'],
      ['incident-windows-unc-slash-path', '//server/share/NOTE_WINDOWS_UNC_SLASH_PATH_CANARY_8675309/private.txt'],
      ['incident-windows-root-path', '\\Users\\admin\\NOTE_WINDOWS_ROOT_PATH_CANARY_8675309\\private.txt'],
    ]

    for (const [id, note] of unsafeNotes) repository.addIncidentNote(id, note)
    repository.close()

    const databaseBytes = readdirSync(join(database.directory, 'nested'))
      .map((name) => readFileSync(join(database.directory, 'nested', name)))
      .map((contents) => contents.toString('utf8'))
      .join('')
    expect(databaseBytes).not.toMatch(/NOTE_(PASSWORD|TOKEN|PATH|STACK|PAYLOAD|API_KEY|HASH|MQTT_PASSWORD|WINDOWS_PATH|WINDOWS_SLASH_PATH|WINDOWS_UNC_PATH|WINDOWS_UNC_SLASH_PATH|WINDOWS_ROOT_PATH)_CANARY_8675309/)

    repository = openRepository({ path: database.path, clock: fixedClock() })
    const unsafeSnapshot = { ...snapshot(), incidents: unsafeNotes.map(([id]) => ({ id, analystNote: null })) }
    expect(repository.apply(unsafeSnapshot).incidents.map(({ analystNote }) => analystNote)).toEqual(
      unsafeNotes.map(() => '[REDACTED: sensitive incident note]'),
    )

    const memory = createMemoryRepository({ clock: fixedClock() })
    for (const [id, note] of unsafeNotes) memory.addIncidentNote(id, note)
    expect(memory.apply(unsafeSnapshot).incidents.map(({ analystNote }) => analystNote)).toEqual(
      unsafeNotes.map(() => '[REDACTED: sensitive incident note]'),
    )
  })
})

describe('shared audit contract', () => {
  it('sanitizes audit entries by allowlist and recursively removes sensitive detail keys', () => {
    expect(sanitizeAuditEntry({
      category: 'AUTH', action: 'LOGIN', outcome: 'FAILURE', actorRef: 'anonymous',
      resourceType: 'session', resourceId: 'current', correlationId: 'login-1',
      password: 'private',
      detail: { attempt: 1, rawPayload: { password: 'private' }, nested: { safe: true, cookie: 'private' } },
    })).toEqual({
      category: 'AUTH', action: 'LOGIN', outcome: 'FAILURE', actorRef: 'anonymous',
      resourceType: 'session', resourceId: 'current', correlationId: 'login-1',
      detail: { attempt: 1, nested: { safe: true } },
    })
  })

  it('does not allow persisted detail keys to alter object prototypes', () => {
    const detail = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')

    const sanitized = sanitizeAuditEntry({ detail })

    expect(sanitized.detail).toEqual({})
    expect(sanitized.detail.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(sanitized.detail)).toBe(Object.prototype)
  })

  it('keeps the memory repository at interface parity with bounded audit and active-error recurrence', () => {
    const repository = createMemoryRepository({ clock: fixedClock() })
    const error = createOperationalError('MQTT_DISCONNECTED', { occurredAt: '2026-09-08T00:59:00.000Z' })

    expect(Object.keys(repository).sort()).toEqual([
      'acknowledgeAlert', 'addIncidentNote', 'apply', 'close', 'queryAudit', 'readContainmentDecision',
      'recordAction', 'recordContainmentDecision', 'recordIntegrationOutcome', 'recordOperationalErrors',
      'updateSettings',
    ])
    repository.recordOperationalErrors([error])
    repository.recordOperationalErrors([error])
    repository.recordOperationalErrors([])
    repository.recordOperationalErrors([error])

    expect(repository.queryAudit({ limit: 10 })).toHaveLength(2)
    expect(() => repository.queryAudit({ limit: 251 })).toThrow(RangeError)
    expect(repository.close()).toBeUndefined()
  })

  it('orders memory audit by timestamp descending and numeric sequence descending on ties', () => {
    const timestamps = [
      '2026-09-08T03:00:00.000Z',
      '2026-09-08T01:00:00.000Z',
      '2026-09-08T03:00:00.000Z',
    ]
    const repository = createMemoryRepository({ clock: () => new Date(timestamps.shift()) })
    repository.recordAction({ category: 'TEST', action: 'LATEST_EARLIER_SEQUENCE', outcome: 'SUCCESS' })
    repository.recordAction({ category: 'TEST', action: 'OLDEST', outcome: 'SUCCESS' })
    repository.recordAction({ category: 'TEST', action: 'LATEST_LATER_SEQUENCE', outcome: 'SUCCESS' })

    expect(repository.queryAudit({ limit: 3 }).map(({ id, action }) => ({ id, action }))).toEqual([
      { id: 'audit-00003', action: 'LATEST_LATER_SEQUENCE' },
      { id: 'audit-00001', action: 'LATEST_EARLIER_SEQUENCE' },
      { id: 'audit-00002', action: 'OLDEST' },
    ])
  })
})

describe('durable containment decisions and additive schema v2', () => {
  const decision = Object.freeze({
    incidentId: 'inc-0123456789abcd',
    decision: 'ACCEPT',
    state: 'CONTAINMENT_ACCEPTED',
    correlationKey: 'zone-a-incident-42',
    evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
    severity: 'HIGH',
  })

  it('stores a decision durably and returns it unchanged after reopening the database', () => {
    const { path } = testDatabase()
    const first = openRepository({ path, clock: fixedClock() })

    const recorded = first.recordContainmentDecision(decision)
    first.close()
    const reopened = openRepository({ path, clock: fixedClock() })

    expect(recorded).toEqual(expect.objectContaining({ status: 'RECORDED', state: 'CONTAINMENT_ACCEPTED' }))
    expect(reopened.readContainmentDecision(decision.incidentId)).toEqual(expect.objectContaining({
      incidentId: decision.incidentId,
      decision: 'ACCEPT',
      state: 'CONTAINMENT_ACCEPTED',
      correlationKey: 'zone-a-incident-42',
    }))
    expect(reopened.queryAudit({ limit: 10 }).filter((row) => row.action === 'CONTAINMENT_ACCEPTED')).toHaveLength(1)
  })

  it('is idempotent for the same decision and conflicts on the opposite one', () => {
    const { path } = testDatabase()
    const repository = openRepository({ path, clock: fixedClock() })

    repository.recordContainmentDecision(decision)
    const repeated = repository.recordContainmentDecision(decision)
    const reversed = repository.recordContainmentDecision({ ...decision, decision: 'REJECT', state: 'CONTAINMENT_REJECTED' })

    expect(repeated).toEqual(expect.objectContaining({ status: 'UNCHANGED', state: 'CONTAINMENT_ACCEPTED' }))
    expect(reversed).toEqual(expect.objectContaining({ status: 'CONFLICT', state: 'CONTAINMENT_ACCEPTED' }))
    expect(repository.queryAudit({ limit: 50 }).filter((row) => row.action === 'CONTAINMENT_ACCEPTED')).toHaveLength(1)
    expect(repository.queryAudit({ limit: 50 }).filter((row) => row.action === 'CONTAINMENT_REJECTED')).toHaveLength(0)
  })

  it('never stores raw upstream payloads, credentials, or human names with a decision', () => {
    const { path } = testDatabase()
    const repository = openRepository({ path, clock: fixedClock() })

    repository.recordContainmentDecision({
      ...decision,
      rawEvent: { subject: 'Alice Example', token: 'must-not-leak' },
      snapshotPath: '/var/aegis/snapshots/cam-02.jpg',
    })
    repository.close()

    const stored = readFileSync(path, 'utf8')
    expect(stored).not.toMatch(/Alice Example|must-not-leak|cam-02\.jpg/)
  })

  it('migrates a schema v1 database to v2 additively and keeps every v1 audit row', () => {
    const { path } = testDatabase()
    const legacy = openRepository({ path, clock: fixedClock() })
    legacy.recordAction({ category: 'ALERT', action: 'LEGACY_V1_ROW', outcome: 'SUCCESS' })
    legacy.close()

    const database = new DatabaseSync(path)
    database.exec('DROP TABLE IF EXISTS containment_decisions')
    database.prepare('UPDATE schema_meta SET version = 1 WHERE singleton = 1').run()
    database.close()

    const migrated = openRepository({ path, clock: fixedClock() })

    expect(migrated.queryAudit({ limit: 10 }).map((row) => row.action)).toContain('LEGACY_V1_ROW')
    expect(migrated.recordContainmentDecision(decision)).toEqual(expect.objectContaining({ status: 'RECORDED' }))
    expect(migrated.schemaVersion()).toBe(2)
  })

  it('reports no decision for an incident that has never been decided', () => {
    const { path } = testDatabase()
    expect(openRepository({ path, clock: fixedClock() }).readContainmentDecision('inc-never-decided')).toBeNull()
  })

  it('keeps the in-memory repository behaviour identical for containment decisions', () => {
    const repository = createMemoryRepository({ clock: fixedClock() })

    const recorded = repository.recordContainmentDecision(decision)
    const repeated = repository.recordContainmentDecision(decision)
    const reversed = repository.recordContainmentDecision({ ...decision, decision: 'REJECT', state: 'CONTAINMENT_REJECTED' })

    expect(recorded.status).toBe('RECORDED')
    expect(repeated.status).toBe('UNCHANGED')
    expect(reversed).toEqual(expect.objectContaining({ status: 'CONFLICT', state: 'CONTAINMENT_ACCEPTED' }))
    expect(repository.readContainmentDecision(decision.incidentId).state).toBe('CONTAINMENT_ACCEPTED')
  })
})

describe('durable integration lifecycle storage', () => {
  const failing = { sources: [{ source: 'IDEA1', status: 'UNKNOWN', code: 'ADAPTER_TIMEOUT', rejectedCount: 0 }] }
  const healthy = { sources: [{ source: 'IDEA1', status: 'HEALTHY', code: null, rejectedCount: 0 }] }

  it('keeps an active failure period across a reopen instead of re-reporting it', () => {
    const { path } = testDatabase()
    const first = openRepository({ path, clock: fixedClock() })

    expect(first.recordIntegrationOutcome(failing).map((row) => row.action)).toEqual(['ADAPTER_FAILURE'])
    first.close()

    const reopened = openRepository({ path, clock: fixedClock() })
    expect(reopened.recordIntegrationOutcome(failing)).toEqual([])
    expect(reopened.recordIntegrationOutcome(healthy).map((row) => row.action)).toEqual(['ADAPTER_RECOVERED'])
    expect(reopened.recordIntegrationOutcome(failing).map((row) => row.action)).toEqual(['ADAPTER_FAILURE'])
  })

  it('remembers a correlated incident permanently so it is audited once', () => {
    const { path } = testDatabase()
    const incident = { id: 'inc-0123456789abcd', correlationKey: 'zone-a-incident-42', severity: 'HIGH', idea1Count: 1, idea2Count: 1, evidenceIds: ['IDEA1:a', 'IDEA2:b'] }
    const first = openRepository({ path, clock: fixedClock() })

    expect(first.recordIntegrationOutcome({ incidents: [incident] }).map((row) => row.action)).toEqual(['INCIDENT_CORRELATED'])
    first.close()

    expect(openRepository({ path, clock: fixedClock() }).recordIntegrationOutcome({ incidents: [incident] })).toEqual([])
  })

  it('ignores an unconfigured source entirely', () => {
    const { path } = testDatabase()
    const repository = openRepository({ path, clock: fixedClock() })

    expect(repository.recordIntegrationOutcome({ sources: [{ source: 'IDEA2', status: 'NOT_CONFIGURED', code: 'NOT_CONFIGURED' }] })).toEqual([])
  })
})
