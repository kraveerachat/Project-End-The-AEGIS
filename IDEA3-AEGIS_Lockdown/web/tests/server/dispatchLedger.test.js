import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DISPATCH_ACTIONS,
  DISPATCH_ACTION_STATES,
  DISPATCH_EVIDENCE_STAGES,
  DISPATCH_TTL_MS,
  assertDispatchable,
} from '../../server/domain/dispatch.js'
import { AuditPersistenceError } from '../../server/repositories/auditRecords.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { AUDIT_SCHEMA_VERSION, createSqliteRepository } from '../../server/repositories/sqliteRepository.js'

const opened = []
const directories = []

const DECISION = Object.freeze({
  incidentId: 'inc-0123456789abcd',
  decision: 'ACCEPT',
  state: 'CONTAINMENT_ACCEPTED',
  correlationKey: 'zone-a-incident-42',
  evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
  severity: 'HIGH',
})
const SECOND_DECISION = Object.freeze({ ...DECISION, incidentId: 'inc-0123456789abce' })
const ACTION_ID = '5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f'
const ACCEPTED_AT = '2026-09-12T08:00:00.000Z'
const EXPIRES_AT = '2026-09-12T08:02:00.000Z'

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-idea3-dispatch-'))
  directories.push(directory)
  return join(directory, 'audit.sqlite')
}

function open(path, iso = ACCEPTED_AT) {
  const repository = createSqliteRepository({ path, clock: () => new Date(iso) })
  opened.push(repository)
  return repository
}

function inspect(path, callback) {
  const database = new DatabaseSync(path)
  try {
    return callback(database)
  } finally {
    database.close()
  }
}

function durableRows(path) {
  return inspect(path, (database) => ({
    version: database.prepare('SELECT version FROM schema_meta WHERE singleton = 1').get().version,
    audit: database.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    decisions: database.prepare('SELECT * FROM containment_decisions ORDER BY incident_id').all(),
    acknowledgements: database.prepare('SELECT * FROM alert_acknowledgements ORDER BY alert_id').all(),
  }))
}

// Minting arrives with Task 2; until then the fixture writes the row exactly as minting will.
function insertPendingActionFixture(path) {
  inspect(path, (database) => {
    const auditId = database.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get().id
    database.prepare(`
      INSERT INTO dispatch_actions (action_id, incident_id, action, state, accepted_at, expires_at, audit_id)
      VALUES (?, ?, 'CUT_UPLINK', 'PENDING_DISPATCH', ?, ?, ?)
    `).run(ACTION_ID, DECISION.incidentId, ACCEPTED_AT, EXPIRES_AT, auditId)
  })
}

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop().close()
    } catch {
      // A test that closes its own repository owns that state.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PR10 S2 dispatch schema v3', () => {
  it('W1: creates a fresh database at v3 with the dispatch tables', () => {
    const path = databasePath()
    const repository = open(path)

    expect(AUDIT_SCHEMA_VERSION).toBe(3)
    expect(repository.schemaVersion()).toBe(3)
    inspect(path, (database) => {
      const columns = (table) => database.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name)
      expect(columns('dispatch_actions')).toEqual([
        'action_id', 'incident_id', 'action', 'state', 'accepted_at', 'expires_at', 'claimed_at', 'claimed_by', 'audit_id',
      ])
      expect(columns('dispatch_evidence')).toEqual([
        'id', 'action_id', 'sequence', 'stage', 'observed_at', 'received_at', 'detail_json',
      ])
    })
  })

  it('W1: takes the schema vocabulary from the single dispatch domain module', () => {
    const path = databasePath()
    open(path)
    const sql = inspect(path, (database) => database.prepare(
      "SELECT group_concat(sql, ' ') AS sql FROM sqlite_master WHERE name IN ('dispatch_actions', 'dispatch_evidence')",
    ).get().sql)

    expect(DISPATCH_ACTIONS).toEqual(['CUT_UPLINK'])
    expect(DISPATCH_ACTION_STATES).toEqual(['PENDING_DISPATCH', 'CORE_CLAIMED', 'EXPIRED'])
    expect(DISPATCH_EVIDENCE_STAGES).toEqual([
      'PUBLISHED', 'DRY_RUN', 'ACK', 'STATUS', 'OUTCOME_UNKNOWN', 'EXPIRED_AT_CORE', 'FAILED',
    ])
    expect(DISPATCH_TTL_MS).toBe(120_000)
    for (const list of [DISPATCH_ACTIONS, DISPATCH_ACTION_STATES, DISPATCH_EVIDENCE_STAGES]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
    for (const value of [...DISPATCH_ACTIONS, ...DISPATCH_ACTION_STATES, ...DISPATCH_EVIDENCE_STAGES]) {
      expect(sql).toContain(`'${value}'`)
    }
    expect(sql).not.toContain("'RESTORE_UPLINK'")
  })

  it('W1: enforces one action per decision, CUT_UPLINK only, the vocabulary, and unique evidence sequences', () => {
    const path = databasePath()
    const repository = open(path)
    repository.recordContainmentDecision(DECISION)
    repository.recordContainmentDecision(SECOND_DECISION)
    repository.close()

    inspect(path, (database) => {
      database.exec('PRAGMA foreign_keys = ON')
      const auditId = database.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get().id
      const action = database.prepare(`
        INSERT INTO dispatch_actions (action_id, incident_id, action, state, accepted_at, expires_at, audit_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      action.run(ACTION_ID, DECISION.incidentId, 'CUT_UPLINK', 'PENDING_DISPATCH', ACCEPTED_AT, EXPIRES_AT, auditId)

      expect(() => action.run('second-action', DECISION.incidentId, 'CUT_UPLINK', 'PENDING_DISPATCH', ACCEPTED_AT, EXPIRES_AT, auditId))
        .toThrow(/UNIQUE/)
      expect(() => action.run('restore-action', SECOND_DECISION.incidentId, 'RESTORE_UPLINK', 'PENDING_DISPATCH', ACCEPTED_AT, EXPIRES_AT, auditId))
        .toThrow(/CHECK/)
      expect(() => action.run('contained-action', SECOND_DECISION.incidentId, 'CUT_UPLINK', 'CONTAINED', ACCEPTED_AT, EXPIRES_AT, auditId))
        .toThrow(/CHECK/)
      expect(() => action.run('orphan-action', 'inc-never-decided', 'CUT_UPLINK', 'PENDING_DISPATCH', ACCEPTED_AT, EXPIRES_AT, auditId))
        .toThrow(/FOREIGN KEY/)

      const evidence = database.prepare(`
        INSERT INTO dispatch_evidence (action_id, sequence, stage, observed_at, received_at, detail_json)
        VALUES (?, ?, ?, ?, ?, '{}')
      `)
      evidence.run(ACTION_ID, 1, 'PUBLISHED', ACCEPTED_AT, ACCEPTED_AT)

      expect(() => evidence.run(ACTION_ID, 1, 'ACK', ACCEPTED_AT, ACCEPTED_AT)).toThrow(/UNIQUE/)
      expect(() => evidence.run(ACTION_ID, 2, 'CONTAINED', ACCEPTED_AT, ACCEPTED_AT)).toThrow(/CHECK/)
      expect(() => evidence.run(ACTION_ID, 0, 'ACK', ACCEPTED_AT, ACCEPTED_AT)).toThrow(/CHECK/)
      expect(() => evidence.run(ACTION_ID, 1001, 'ACK', ACCEPTED_AT, ACCEPTED_AT)).toThrow(/CHECK/)
      expect(() => evidence.run('unknown-action', 1, 'ACK', ACCEPTED_AT, ACCEPTED_AT)).toThrow(/FOREIGN KEY/)
    })
  })

  it('W2: upgrades a populated v2 database to v3 additively, and reopening changes nothing', () => {
    const path = databasePath()
    const first = open(path)
    first.recordAction({ category: 'ALERT', action: 'LEGACY_V2_ROW', outcome: 'SUCCESS' })
    first.recordContainmentDecision(DECISION)
    first.acknowledgeAlert('alert-1')
    first.close()
    // Put the file back into the exact v2 shape: no dispatch tables and version 2.
    inspect(path, (database) => {
      database.exec('DROP TABLE IF EXISTS dispatch_evidence')
      database.exec('DROP TABLE IF EXISTS dispatch_actions')
      database.prepare('UPDATE schema_meta SET version = 2 WHERE singleton = 1').run()
    })
    const v2Rows = durableRows(path)

    const migrated = open(path)
    expect(migrated.schemaVersion()).toBe(3)
    expect(migrated.readContainmentDecision(DECISION.incidentId)).toEqual(expect.objectContaining({
      decision: 'ACCEPT', state: 'CONTAINMENT_ACCEPTED',
    }))
    migrated.close()
    const v3Rows = durableRows(path)

    expect(v2Rows.version).toBe(2)
    expect(v3Rows).toEqual({ ...v2Rows, version: 3 })
    expect(inspect(path, (database) => database.prepare('SELECT count(*) AS n FROM dispatch_actions').get().n)).toBe(0)

    open(path).close()
    expect(durableRows(path)).toEqual(v3Rows)
  })

  it('W14: keeps a pending dispatch action unchanged across close and reopen before it expires', () => {
    const path = databasePath()
    const first = open(path)
    first.recordContainmentDecision(DECISION)
    first.close()
    insertPendingActionFixture(path)
    const pendingRow = () => inspect(path, (database) => (
      database.prepare('SELECT * FROM dispatch_actions WHERE action_id = ?').get(ACTION_ID)
    ))
    const beforeRestart = pendingRow()

    // Reopen one minute after acceptance, inside the 120 s TTL. Expiry itself is W8 (Task 2).
    open(path, '2026-09-12T08:01:00.000Z').close()

    expect(beforeRestart).toEqual(expect.objectContaining({
      action_id: ACTION_ID,
      incident_id: DECISION.incidentId,
      action: 'CUT_UPLINK',
      state: 'PENDING_DISPATCH',
      accepted_at: ACCEPTED_AT,
      expires_at: EXPIRES_AT,
      claimed_at: null,
      claimed_by: null,
    }))
    expect(pendingRow()).toEqual(beforeRestart)
  })
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REJECTION = Object.freeze({ ...SECOND_DECISION, decision: 'REJECT', state: 'CONTAINMENT_REJECTED' })

function mutableClock(iso = ACCEPTED_AT) {
  let now = new Date(iso)
  const clock = () => new Date(now)
  clock.set = (value) => { now = new Date(value) }
  return clock
}

function at(offsetMs) {
  return new Date(Date.parse(ACCEPTED_AT) + offsetMs).toISOString()
}

function dispatchAudit(repository, action) {
  return repository.queryAudit({ limit: 250 }).filter((row) => row.category === 'DISPATCH' && row.action === action)
}

const REPOSITORIES = [
  ['SQLite', (clock) => {
    const repository = createSqliteRepository({ path: databasePath(), clock })
    opened.push(repository)
    return repository
  }],
  ['memory', (clock) => createMemoryRepository({ clock })],
]

describe.each(REPOSITORIES)('PR10 S2 dispatch minting — %s repository', (_name, create) => {
  it('W4: mints exactly one CUT_UPLINK action with a 120 s expiry for an enabled acceptance', () => {
    const repository = create(mutableClock())

    const stored = repository.recordContainmentDecision(DECISION, { mintDispatch: true })

    expect(stored.status).toBe('RECORDED')
    expect(stored.dispatch).toEqual({
      actionId: expect.stringMatching(UUID_V4),
      incidentId: DECISION.incidentId,
      action: 'CUT_UPLINK',
      state: 'PENDING_DISPATCH',
      acceptedAt: ACCEPTED_AT,
      expiresAt: EXPIRES_AT,
      claimedAt: null,
      claimedBy: null,
    })
    expect(stored.dispatch.actionId).not.toBe(DECISION.incidentId)
    expect(repository.readDispatchAction(stored.dispatch.actionId)).toEqual(stored.dispatch)
    expect(repository.listPendingDispatchActions()).toEqual([stored.dispatch])
    expect(dispatchAudit(repository, 'ACTION_MINTED')).toEqual([expect.objectContaining({
      outcome: 'SUCCESS',
      actorRef: 'session-admin',
      resourceType: 'dispatch_action',
      resourceId: stored.dispatch.actionId,
    })])
  })

  it('W4: mints nothing for a rejection or while dispatch is not enabled', () => {
    const repository = create(mutableClock())

    expect(repository.recordContainmentDecision(DECISION).dispatch).toBeNull()
    expect(repository.recordContainmentDecision(REJECTION, { mintDispatch: true }).dispatch).toBeNull()
    expect(repository.listPendingDispatchActions()).toEqual([])
    expect(dispatchAudit(repository, 'ACTION_MINTED')).toEqual([])
  })

  it('W5: returns the same action for a repeated or conflicting decision and never mints a second one', () => {
    const repository = create(mutableClock())

    const first = repository.recordContainmentDecision(DECISION, { mintDispatch: true })
    const repeated = repository.recordContainmentDecision(DECISION, { mintDispatch: true })
    const reversed = repository.recordContainmentDecision({ ...DECISION, decision: 'REJECT', state: 'CONTAINMENT_REJECTED' }, { mintDispatch: true })

    expect(repeated).toEqual(expect.objectContaining({ status: 'UNCHANGED', dispatch: first.dispatch }))
    expect(reversed).toEqual(expect.objectContaining({ status: 'CONFLICT', dispatch: first.dispatch }))
    expect(repository.listPendingDispatchActions()).toEqual([first.dispatch])
    expect(dispatchAudit(repository, 'ACTION_MINTED')).toHaveLength(1)
  })

  it('W5: never mints late for an acceptance that was recorded while dispatch was disabled', () => {
    const repository = create(mutableClock())

    repository.recordContainmentDecision(DECISION)
    const retried = repository.recordContainmentDecision(DECISION, { mintDispatch: true })

    expect(retried).toEqual(expect.objectContaining({ status: 'UNCHANGED', dispatch: null }))
    expect(repository.listPendingDispatchActions()).toEqual([])
  })

  it('W8: keeps an action pending before 120 s and expires it at 120 s, auditing the expiry once', () => {
    const clock = mutableClock()
    const repository = create(clock)
    const { dispatch } = repository.recordContainmentDecision(DECISION, { mintDispatch: true })

    clock.set(at(DISPATCH_TTL_MS - 1))
    expect(repository.listPendingDispatchActions().map(({ actionId }) => actionId)).toEqual([dispatch.actionId])

    clock.set(at(DISPATCH_TTL_MS))
    expect(repository.listPendingDispatchActions()).toEqual([])
    expect(repository.readDispatchAction(dispatch.actionId).state).toBe('EXPIRED')

    clock.set(at(DISPATCH_TTL_MS + 1))
    expect(repository.listPendingDispatchActions()).toEqual([])
    expect(dispatchAudit(repository, 'ACTION_EXPIRED')).toEqual([expect.objectContaining({
      outcome: 'SUCCESS', resourceType: 'dispatch_action', resourceId: dispatch.actionId,
    })])
  })

  it('W8: lists only unexpired pending actions, oldest first, at most ten', () => {
    const clock = mutableClock()
    const repository = create(clock)
    const minted = []
    for (let index = 0; index < 13; index += 1) {
      clock.set(at(index * 1_000))
      const incidentId = `inc-${String(index).padStart(4, '0')}-dispatch`
      minted.push(repository.recordContainmentDecision({ ...DECISION, incidentId }, { mintDispatch: true }).dispatch.actionId)
    }

    // At 121.5 s the first two actions (accepted at 0 s and 1 s) are past due.
    clock.set(at(DISPATCH_TTL_MS + 1_500))
    const listed = repository.listPendingDispatchActions()

    expect(listed.map(({ actionId }) => actionId)).toEqual(minted.slice(2, 12))
    expect(listed.every(({ state }) => state === 'PENDING_DISPATCH')).toBe(true)
    expect(minted.slice(0, 2).map((actionId) => repository.readDispatchAction(actionId).state)).toEqual(['EXPIRED', 'EXPIRED'])
    for (const limit of [0, 11, 1.5]) {
      expect(() => repository.listPendingDispatchActions({ limit })).toThrow(RangeError)
    }
  })

  it('reports no action for an unknown action id', () => {
    expect(create(mutableClock()).readDispatchAction('5b0e3c1e-0000-4000-8000-000000000000')).toBeNull()
  })
})

describe('PR10 S2 dispatch minting — CUT_UPLINK only', () => {
  it('W11: the domain guard accepts CUT_UPLINK and refuses RESTORE_UPLINK or anything else', () => {
    expect(() => assertDispatchable('CUT_UPLINK')).not.toThrow()
    for (const action of ['RESTORE_UPLINK', 'cut_uplink', '', undefined, null]) {
      expect(() => assertDispatchable(action)).toThrow(/CUT_UPLINK/)
    }
  })
})

describe('PR10 S2 dispatch minting — SQLite atomicity and restart', () => {
  it('W4: an injected minting failure writes neither the decision nor the action, and a clean retry mints once', () => {
    const path = databasePath()
    const repository = open(path)
    const mutation = new DatabaseSync(path)
    mutation.exec("CREATE TRIGGER reject_dispatch BEFORE INSERT ON dispatch_actions BEGIN SELECT RAISE(ABORT, 'forced mint failure'); END")

    expect(() => repository.recordContainmentDecision(DECISION, { mintDispatch: true })).toThrow(AuditPersistenceError)
    mutation.exec('DROP TRIGGER reject_dispatch')
    mutation.close()

    expect(repository.readContainmentDecision(DECISION.incidentId)).toBeNull()
    expect(repository.queryAudit({ limit: 10 })).toEqual([])
    expect(repository.listPendingDispatchActions()).toEqual([])
    expect(repository.recordContainmentDecision(DECISION, { mintDispatch: true }).status).toBe('RECORDED')
    expect(repository.listPendingDispatchActions()).toHaveLength(1)
  })

  it('W14/W5: a minted action survives restarts, is re-read rather than re-minted, and stays pending until it expires', () => {
    const path = databasePath()
    const clock = mutableClock()
    const first = createSqliteRepository({ path, clock })
    opened.push(first)
    const { dispatch } = first.recordContainmentDecision(DECISION, { mintDispatch: true })
    first.close()

    clock.set(at(60_000))
    const reopened = createSqliteRepository({ path, clock })
    opened.push(reopened)
    expect(reopened.readDispatchAction(dispatch.actionId)).toEqual(dispatch)
    expect(reopened.recordContainmentDecision(DECISION, { mintDispatch: true })).toEqual(expect.objectContaining({
      status: 'UNCHANGED', dispatch,
    }))
    expect(reopened.listPendingDispatchActions()).toEqual([dispatch])
    reopened.close()

    clock.set(at(DISPATCH_TTL_MS + 1))
    const later = createSqliteRepository({ path, clock })
    opened.push(later)
    expect(later.listPendingDispatchActions()).toEqual([])
    expect(later.readDispatchAction(dispatch.actionId).state).toBe('EXPIRED')
    expect(dispatchAudit(later, 'ACTION_MINTED')).toHaveLength(1)
  })
})
