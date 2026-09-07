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
  it('creates schema version 1, the required tables, WAL storage, and parent directories', () => {
    const database = testDatabase()
    const repository = openRepository({ path: database.path, clock: fixedClock() })

    const inspection = new DatabaseSync(database.path)
    const tables = inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name)
    const schemaRows = inspection.prepare('SELECT singleton, version FROM schema_meta ORDER BY singleton').all()
    const journalMode = inspection.prepare('PRAGMA journal_mode').get().journal_mode
    inspection.close()

    expect(schemaRows).toEqual([{ singleton: 1, version: 1 }])
    expect(tables).toEqual(expect.arrayContaining([
      'schema_meta', 'audit_log', 'alert_acknowledgements', 'incident_notes', 'settings', 'active_operational_errors',
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
      'acknowledgeAlert', 'addIncidentNote', 'apply', 'close', 'queryAudit', 'recordAction', 'recordOperationalErrors', 'updateSettings',
    ])
    repository.recordOperationalErrors([error])
    repository.recordOperationalErrors([error])
    repository.recordOperationalErrors([])
    repository.recordOperationalErrors([error])

    expect(repository.queryAudit({ limit: 10 })).toHaveLength(2)
    expect(() => repository.queryAudit({ limit: 251 })).toThrow(RangeError)
    expect(repository.close()).toBeUndefined()
  })
})
