import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import {
  DISPATCH_ACTIONS,
  DISPATCH_ACTION_STATES,
  DISPATCH_EVIDENCE_STAGES,
  DISPATCH_TTL_MS,
  dispatchDisplay,
  safeDispatchEvidence,
} from '../../server/domain/dispatch.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'

// The shared Web <-> Core dispatch contract; the Core suite reads the same file.
// Vitest runs from the web/ directory, as the other server tests assume.
const contract = JSON.parse(readFileSync(join(process.cwd(), '..', 'tests', 'fixtures', 'dispatch-contract.json'), 'utf8'))
const route = contract.machineRoute
const ACTION_ID_PATTERN = new RegExp(contract.action.actionIdPattern)
const TIMESTAMP_PATTERN = new RegExp(contract.timestamps.pattern)
const REASON_CODE_PATTERN = new RegExp(contract.evidence.detailAllowlist.reasonCodePattern)
const OBSERVED_AT = contract.timestamps.valid[0]
const ACCEPTED_AT = '2026-09-12T08:00:00.000Z'
const DECISION = Object.freeze({
  incidentId: 'inc-0123456789abcd',
  decision: 'ACCEPT',
  state: 'CONTAINMENT_ACCEPTED',
  correlationKey: 'zone-a-incident-42',
  evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
  severity: 'HIGH',
})
const directories = []
const opened = []

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

// Local test fixtures only; the loopback trusted peer is not the Production topology.
function dispatchConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
    AEGIS_IDEA3_DISPATCH_PORT: '18103',
    AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
    AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    ...overrides,
  })
}

const IDENTITY = Object.freeze({
  [route.edgeIdentityHeaders.verify]: route.edgeIdentityHeaders.verifySuccess,
  [route.edgeIdentityHeaders.subjectDn]: 'CN=idea3-core,O=AEGIS',
})

function mutableClock(iso = ACCEPTED_AT) {
  let now = new Date(iso)
  const clock = () => new Date(now)
  clock.set = (value) => { now = new Date(value) }
  return clock
}

function machine({ repository, clock = mutableClock(), config = dispatchConfig() } = {}) {
  const repo = repository ?? createMemoryRepository({ clock })
  const app = createMachineApp({ config, repository: repo, contact: createMachineContactTracker({ clock }) })
  return { app, repository: repo, clock }
}

function mint(repository, incidentId = DECISION.incidentId) {
  return repository.recordContainmentDecision({ ...DECISION, incidentId }, { mintDispatch: true }).dispatch
}

function actionPath(template, actionId, basePath = route.basePath) {
  return `${basePath}${template.replace('{actionId}', actionId)}`
}

function claim(app, actionId, headers = IDENTITY) {
  return request(app)[route.claim.method.toLowerCase()](actionPath(route.claim.path, actionId)).set(headers).send(route.claim.requestBody)
}

function report(app, actionId, entry) {
  return request(app)[route.report.method.toLowerCase()](actionPath(route.report.path, actionId)).set(IDENTITY).send(entry)
}

function evidence(item, sequence = contract.evidence.sequence.min) {
  return { sequence, stage: item.stage, observedAt: OBSERVED_AT, detail: item.detail }
}

describe('PR10 S2 shared dispatch contract — Web side', () => {
  it('pins the dispatch vocabulary and expiry the Web implements', () => {
    expect(DISPATCH_ACTIONS).toEqual(contract.action.dispatchable)
    for (const action of contract.action.neverDispatchable) expect(DISPATCH_ACTIONS).not.toContain(action)
    expect(DISPATCH_ACTION_STATES).toEqual(contract.serverStates)
    expect(DISPATCH_EVIDENCE_STAGES).toEqual(contract.evidence.stages)
    expect(DISPATCH_TTL_MS).toBe(contract.action.ttlMs)
  })

  it('accepts every evidence entry the Core can emit, at every allowed sequence and timestamp', () => {
    const { min, max } = contract.evidence.sequence
    for (const item of contract.evidence.coreEmitted) {
      expect(contract.evidence.stages).toContain(item.stage)
      for (const sequence of [min, max]) {
        expect(safeDispatchEvidence(evidence(item, sequence))).toEqual(evidence(item, sequence))
      }
      if (item.detail.reasonCode) expect(item.detail.reasonCode).toMatch(REASON_CODE_PATTERN)
    }
    for (const observedAt of contract.timestamps.valid) {
      expect(observedAt).toMatch(TIMESTAMP_PATTERN)
      expect(safeDispatchEvidence({ ...evidence(contract.evidence.coreEmitted[0]), observedAt })).not.toBeNull()
    }
  })

  it('refuses the invalid evidence, sequences, and timestamps the contract names', () => {
    const { min, max } = contract.evidence.sequence
    const valid = evidence(contract.evidence.coreEmitted[0])
    for (const entry of contract.evidence.invalidEntries) expect(safeDispatchEvidence(entry)).toBeNull()
    for (const sequence of [min - 1, max + 1]) expect(safeDispatchEvidence({ ...valid, sequence })).toBeNull()
    for (const observedAt of contract.timestamps.invalid) expect(safeDispatchEvidence({ ...valid, observedAt })).toBeNull()
  })

  it('never lets Core-reported evidence imply execution or physical evidence', () => {
    const action = { state: 'CORE_CLAIMED', acceptedAt: ACCEPTED_AT, expiresAt: '2026-09-12T08:02:00.000Z' }
    const now = new Date('2026-09-12T08:00:30.000Z')
    const evidenceSets = [...contract.evidence.coreEmitted.map((item) => [item]), contract.evidence.coreEmitted]
    for (const entries of evidenceSets) {
      const { boundary } = dispatchDisplay({ action, evidence: entries, now })
      for (const flag of contract.neverImpliedByEvidence) expect(boundary[flag]).toBe(false)
    }
  })

  it('serves the pinned list and claim shapes, identifiers, timestamps, and expiry', async () => {
    const { app, repository } = machine()
    const minted = mint(repository)

    const listed = await request(app)[route.listPending.method.toLowerCase()](`${route.basePath}${route.listPending.path}`).set(IDENTITY)
    const claimed = await claim(app, minted.actionId)

    expect(listed.status).toBe(200)
    expect(Object.keys(listed.body).sort()).toEqual([...route.listPending.responseKeys].sort())
    const [action] = listed.body.actions
    expect(Object.keys(action).sort()).toEqual([...route.listPending.actionKeys].sort())
    expect(action.actionId).toMatch(ACTION_ID_PATTERN)
    expect(contract.action.dispatchable).toContain(action.action)
    for (const key of ['acceptedAt', 'expiresAt']) expect(action[key]).toMatch(TIMESTAMP_PATTERN)
    expect(Date.parse(action.expiresAt) - Date.parse(action.acceptedAt)).toBe(contract.action.ttlMs)

    expect(claimed.status).toBe(route.claim.successStatus)
    expect(Object.keys(claimed.body).sort()).toEqual([...route.claim.successKeys].sort())
    expect(claimed.body.state).toBe(route.claim.successState)
    for (const key of ['claimedAt', 'expiresAt']) expect(claimed.body[key]).toMatch(TIMESTAMP_PATTERN)
  })

  it('serves the same route under the production base path', async () => {
    const { app, repository } = machine({ config: dispatchConfig({ AEGIS_WEB_BASE_PATH: '/security' }) })
    mint(repository)

    const listed = await request(app).get(`${route.productionBasePath}${route.listPending.path}`).set(IDENTITY)

    expect(listed.status).toBe(200)
    expect(listed.body.actions).toHaveLength(1)
  })

  it('answers each claim refusal with the pinned status and code', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aegis-idea3-contract-'))
    directories.push(directory)
    const path = join(directory, 'audit.sqlite')
    const clock = mutableClock()
    const repository = createSqliteRepository({ path, clock })
    opened.push(repository)
    const { app } = machine({ repository, clock })
    const alreadyClaimed = mint(repository, 'inc-contract-claimed')
    const expired = mint(repository, 'inc-contract-expired')
    await claim(app, alreadyClaimed.actionId)
    repository.recordContainmentDecision({ ...DECISION, incidentId: 'inc-contract-restore' })
    const notDispatchable = contract.action.validActionIds[0]
    // Bypass the schema CHECK only to reach the claim path's own CUT_UPLINK re-check.
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA ignore_check_constraints = 1')
    const auditId = raw.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get().id
    raw.prepare(`
      INSERT INTO dispatch_actions (action_id, incident_id, action, state, accepted_at, expires_at, audit_id)
      VALUES (?, 'inc-contract-restore', ?, 'PENDING_DISPATCH', ?, '2026-09-12T08:02:00.000Z', ?)
    `).run(notDispatchable, contract.action.neverDispatchable[0], ACCEPTED_AT, auditId)
    raw.close()

    const byCode = {
      ACTION_ALREADY_CLAIMED: await claim(app, alreadyClaimed.actionId),
      ACTION_NOT_DISPATCHABLE: await claim(app, notDispatchable),
      ACTION_NOT_FOUND: await claim(app, '5b0e3c1e-0000-4000-8000-000000000000'),
    }
    clock.set('2026-09-12T08:02:00.000Z')
    byCode.ACTION_EXPIRED = await claim(app, expired.actionId)

    expect(Object.keys(byCode).sort()).toEqual(route.claim.refusals.map(({ code }) => code).sort())
    for (const refusal of route.claim.refusals) {
      expect(byCode[refusal.code].status).toBe(refusal.status)
      expect(byCode[refusal.code].body.error.code).toBe(refusal.code)
    }
  })

  it('answers each report outcome with the pinned status and code', async () => {
    const { app, repository } = machine()
    const claimed = mint(repository, 'inc-contract-report')
    const unclaimed = mint(repository, 'inc-contract-unclaimed')
    await claim(app, claimed.actionId)
    const entry = evidence(contract.evidence.coreEmitted[0])

    const responses = [
      await report(app, claimed.actionId, entry),
      await report(app, claimed.actionId, entry),
      await report(app, claimed.actionId, { ...entry, stage: 'DRY_RUN' }),
      await report(app, unclaimed.actionId, entry),
      await report(app, '5b0e3c1e-0000-4000-8000-000000000000', entry),
      await report(app, claimed.actionId, contract.evidence.invalidEntries[0]),
    ]

    expect(responses).toHaveLength(route.report.outcomes.length)
    route.report.outcomes.forEach((outcome, index) => {
      expect(responses[index].status).toBe(outcome.status)
      if (outcome.serverStatus) expect(responses[index].body.status).toBe(outcome.serverStatus)
      if (outcome.code) expect(responses[index].body.error.code).toBe(outcome.code)
    })
  })

  it('refuses a failed machine identity and a malformed action id with the pinned answers', async () => {
    const { app, repository } = machine()
    const minted = mint(repository)

    const rejected = await claim(app, minted.actionId, { ...IDENTITY, [route.edgeIdentityHeaders.verify]: 'NONE' })

    expect(rejected.status).toBe(route.identityRejected.status)
    expect(rejected.body.error.code).toBe(route.identityRejected.code)
    for (const actionId of contract.action.validActionIds) expect(actionId).toMatch(ACTION_ID_PATTERN)
    for (const actionId of contract.action.invalidActionIds) {
      expect(actionId).not.toMatch(ACTION_ID_PATTERN)
      const response = await claim(app, encodeURIComponent(actionId))
      expect(response.status).toBe(400)
    }
  })
})
