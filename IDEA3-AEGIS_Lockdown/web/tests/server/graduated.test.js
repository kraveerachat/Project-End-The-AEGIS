import { readFileSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import {
  GRADUATED_ACTIONS, GRADUATED_CURRENT_WINDOW_MS, GRADUATED_KINDS, GRADUATED_LEVELS, GRADUATED_MAX_DECISIONS, GRADUATED_OUTCOMES,
  normalizeGraduated, sanitizeGraduated,
} from '../../server/domain/graduated.js'
import { MAX_STATUS_PUSH_BYTES, createStatusIngestStore, validateStatusPush } from '../../server/domain/statusIngest.js'
import { normalizeRuntimeStatus, unknownRuntime } from '../../server/domain/normalize.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'

// TEST_ONLY: built by the Python status_projection_publisher from a synthetic Core document and graduated file.
const PUSH = JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests/fixtures/core-status-push-graduated.json'), 'utf8'))
const PLAIN = JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests/fixtures/core-status-push.json'), 'utf8'))
const NOW = new Date('2023-11-14T22:15:00.000Z')
const clone = () => structuredClone(PUSH)
const withSection = (change) => { const body = clone(); change(body.projection.graduated); return body }
const BASE = '/api/machine/v1'
const IDENTITY = Object.freeze({ 'X-AEGIS-Client-Verify': 'SUCCESS', 'X-AEGIS-Client-DN': 'CN=idea3-core,O=AEGIS' })

describe('graduated section: Core -> Web push contract', () => {
  it('accepts the Python-built envelope and keeps exactly the allowlisted fields', () => {
    const result = validateStatusPush(clone(), { now: NOW })
    expect(result.ok).toBe(true)
    const section = result.record.projection.graduated
    expect(section).toEqual(PUSH.projection.graduated)
    expect(Object.keys(section).sort()).toEqual(['autoCutLatched', 'cutRecommendedFor', 'decisions', 'highestLevel', 'schemaVersion', 'updatedAt'])
    expect(Object.keys(section.decisions[0]).sort()).toEqual(['action', 'at', 'attackerIp', 'kind', 'level', 'mitre', 'outcome', 'score'])
  })

  it('the section is optional: an envelope without it is accepted and stores none', () => {
    const result = validateStatusPush(structuredClone(PLAIN), { now: NOW })
    expect(result.ok).toBe(true)
    expect(Object.hasOwn(result.record.projection, 'graduated')).toBe(false)
  })

  it('drops unknown fields inside the section and its decisions from the stored copy', () => {
    const body = withSection((section) => {
      section.reasons = ['x']
      section.note = 'free text'
      section.decisions[0].reasons = ['port_scan+30']
      section.decisions[0].corroborated = true
      section.decisions[0].shell = 'rm -rf /'
    })
    const result = validateStatusPush(body, { now: NOW })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.record.projection.graduated)).not.toMatch(/reasons|note|corroborated|shell|rm -rf/)
    expect(result.record.projection.graduated).toEqual(PUSH.projection.graduated)
  })

  it.each([
    ['unknown level', (s) => { s.highestLevel = 'SEVERE' }],
    ['lower-case level', (s) => { s.highestLevel = 'high' }],
    ['decision level', (s) => { s.decisions[0].level = 'SEVERE' }],
    ['RESTORE action', (s) => { s.decisions[0].action = 'RESTORE' }],
    ['RESTORE_UPLINK action', (s) => { s.decisions[0].action = 'RESTORE_UPLINK' }],
    ['unknown outcome', (s) => { s.decisions[0].outcome = 'RESTORED' }],
    ['unknown kind', (s) => { s.decisions[0].kind = 'mass_delete' }],
    ['IPv6 address', (s) => { s.decisions[0].attackerIp = '2001:db8::7' }],
    ['host name', (s) => { s.decisions[0].attackerIp = 'attacker.example.com' }],
    ['octet out of range', (s) => { s.decisions[0].attackerIp = '300.1.1.1' }],
    ['leading zero octet', (s) => { s.decisions[0].attackerIp = '01.2.3.4' }],
    ['address with a suffix', (s) => { s.decisions[0].attackerIp = '203.0.113.7 ; ls' }],
    ['recommended IPv6', (s) => { s.cutRecommendedFor = '2001:db8::1' }],
    ['recommended not a string', (s) => { s.cutRecommendedFor = 7 }],
    ['negative score', (s) => { s.decisions[0].score = -1 }],
    ['score too large', (s) => { s.decisions[0].score = 1001 }],
    ['float score', (s) => { s.decisions[0].score = 30.5 }],
    ['string score', (s) => { s.decisions[0].score = '30' }],
    ['mitre not an array', (s) => { s.decisions[0].mitre = 'T1046' }],
    ['mitre bad id', (s) => { s.decisions[0].mitre = ['T10'] }],
    ['mitre free text', (s) => { s.decisions[0].mitre = ['T1046; DROP'] }],
    ['mitre duplicate', (s) => { s.decisions[0].mitre = ['T1046', 'T1046'] }],
    ['mitre too many', (s) => { s.decisions[0].mitre = ['T1046', 'T1110', 'T1078', 'T1498', 'T1595', 'T1190', 'T1133'] }],
    ['too many decisions', (s) => { s.decisions = Array.from({ length: GRADUATED_MAX_DECISIONS + 1 }, () => ({ ...s.decisions[0] })) }],
    ['decisions not an array', (s) => { s.decisions = {} }],
    ['decision not an object', (s) => { s.decisions = ['x'] }],
    ['missing decision key', (s) => { delete s.decisions[0].outcome }],
    ['missing section key', (s) => { delete s.autoCutLatched }],
    ['bad updatedAt', (s) => { s.updatedAt = 'yesterday' }],
    ['updatedAt not UTC Z', (s) => { s.updatedAt = '2023-11-14T22:14:50+07:00' }],
    ['updatedAt from the future', (s) => { s.updatedAt = '2023-11-14T23:00:00Z' }],
    ['decision time from the future', (s) => { s.decisions[0].at = '2023-11-15T00:00:00Z' }],
    ['latch not boolean', (s) => { s.autoCutLatched = 'true' }],
    ['wrong schemaVersion', (s) => { s.schemaVersion = 2 }],
  ])('refuses the whole push for %s and never repairs it', (_name, change) => {
    const result = validateStatusPush(withSection(change), { now: NOW })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('STATUS_PUSH_INVALID')
    expect(result.record).toBeNull()
  })

  it.each([null, [], 'x', 7, true])('refuses a section that is %j', (value) => {
    const body = clone()
    body.projection.graduated = value
    expect(validateStatusPush(body, { now: NOW }).ok).toBe(false)
  })

  it('a refused section never changes the stored record', () => {
    const store = createStatusIngestStore()
    expect(store.accept(clone(), NOW).ok).toBe(true)
    const before = store.current()
    const bad = clone()
    bad.sentAtMs += 1_000
    bad.projection.graduated.highestLevel = 'SEVERE'
    expect(store.accept(bad, new Date(NOW.getTime() + 1_000)).ok).toBe(false)
    expect(store.current()).toEqual(before)
  })

  it('has no RESTORE anywhere in its vocabulary', () => {
    for (const word of [...GRADUATED_LEVELS, ...GRADUATED_ACTIONS, ...GRADUATED_OUTCOMES, ...GRADUATED_KINDS]) {
      expect(word.toUpperCase()).not.toContain('RESTORE')
    }
  })

  it('the largest valid section still fits the push size bound with room to spare', () => {
    const decision = {
      at: '2023-11-14T22:14:30Z', attackerIp: '255.255.255.255', kind: 'ssh_login_after_failures', level: 'CRITICAL', action: 'RECOMMEND_CUT',
      outcome: 'CUT_REFUSED', score: 1000, mitre: ['T1110.001', 'T1078.003', 'T1498.001', 'T1595.002', 'T1190', 'T1133'],
    }
    const body = clone()
    body.projection.graduated = { ...body.projection.graduated, cutRecommendedFor: '255.255.255.255', autoCutLatched: true, highestLevel: 'CRITICAL', decisions: Array.from({ length: GRADUATED_MAX_DECISIONS }, () => ({ ...decision })) }
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(MAX_STATUS_PUSH_BYTES * 0.6)
    expect(validateStatusPush(body, { now: NOW }).ok).toBe(true)
  })

  it('sanitizeGraduated needs the caller clock and returns null for anything but a plain object', () => {
    expect(sanitizeGraduated(PUSH.projection.graduated, {})).toBeNull()
    expect(sanitizeGraduated(Object.create({ schemaVersion: 1 }), { nowMs: NOW.getTime() })).toBeNull()
  })
})

describe('graduated section: runtime view', () => {
  const raw = () => structuredClone(validateStatusPush(clone(), { now: NOW }).record.projection)

  it('normalizes through the existing adapter: newest decision first, current while inside the scoring window', () => {
    const runtime = normalizeRuntimeStatus(raw(), { now: NOW })
    expect(runtime.freshness).toBe('FRESH')
    const view = runtime.graduated
    expect(view.provenance).toBe('CORE_PROJECTION')
    expect(view.highestLevel).toBe('HIGH')
    expect(view.cutRecommendedFor).toBe('203.0.113.7')
    expect(view.decisions.map((d) => d.kind)).toEqual(['ssh_brute_force', 'port_scan'])
    expect(view.ageMs).toBe(10_000)
    expect(view.current).toBe(true)
    expect(view.decisions[0].mitre).toEqual(['T1110'])
  })

  it('an older section is shown as historical, never as a live reading', () => {
    const later = new Date(NOW.getTime() + GRADUATED_CURRENT_WINDOW_MS + 5_000)
    const projection = raw()
    projection.generatedAt = later.toISOString()
    const view = normalizeRuntimeStatus(projection, { now: later }).graduated
    expect(view.current).toBe(false)
    expect(view.highestLevel).toBe('HIGH')
  })

  it('is null when the section is absent, invalid, or the Core evidence is not fresh', () => {
    expect(normalizeRuntimeStatus(structuredClone(PLAIN.projection), { now: NOW }).graduated).toBeNull()
    const bad = raw()
    bad.graduated.highestLevel = 'SEVERE'
    expect(normalizeRuntimeStatus(bad, { now: NOW }).graduated).toBeNull()
    const stale = new Date(NOW.getTime() + 10 * 60_000)
    expect(normalizeRuntimeStatus(raw(), { now: stale }).graduated).toBeNull()
    expect(unknownRuntime().graduated).toBeNull()
    expect(normalizeGraduated(undefined, { now: NOW })).toBeNull()
    expect(normalizeGraduated(raw().graduated, { now: NOW, forceUnknown: true })).toBeNull()
  })

  it('a polled (non-push) runtime document is sanitized the same way', () => {
    const polled = raw()
    polled.graduated.decisions[0].attackerIp = 'not-an-ip'
    expect(normalizeRuntimeStatus(polled, { now: NOW }).graduated).toBeNull()
  })
})

describe('graduated section: through the machine route and the live provider', () => {
  const SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'
  const NOW_AFTER_PUSH = new Date(PUSH.sentAtMs + 5_000)
  const env = { NODE_ENV: 'test', SESSION_SECRET, AEGIS_ALLOW_DEV_LOGIN: 'true', AEGIS_IDEA3_ADMIN_USER: 'admin', AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple', AEGIS_IDEA3_DISPATCH_PORT: '18103', AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1', AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core', AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }

  function machine() {
    const config = loadConfig(env)
    const clock = () => NOW_AFTER_PUSH
    const statusStore = createStatusIngestStore({ maxAgeMs: config.maxEvidenceAgeMs })
    const app = createMachineApp({ config, repository: createMemoryRepository({ clock }), contact: createMachineContactTracker({ clock }), statusStore, clock })
    const provider = createLiveProvider({ config, clock, statusStore, fetchImpl: async () => { throw new Error('no fetch when ingest is enabled') } })
    return { app, provider, statusStore }
  }

  it('a pushed section reaches the snapshot runtime and an invalid one is refused with the stored section unchanged', async () => {
    const { app, provider, statusStore } = machine()
    const ok = await request(app).post(`${BASE}/status`).set(IDENTITY).send(clone())
    expect(ok.status).toBe(200)
    const snapshot = await provider.getSnapshot()
    expect(snapshot.runtime.graduated.highestLevel).toBe('HIGH')
    expect(snapshot.runtime.graduated.decisions).toHaveLength(2)

    const before = statusStore.current()
    const bad = clone()
    bad.sentAtMs += 1_000
    bad.projection.graduated.decisions[0].action = 'RESTORE'
    const refused = await request(app).post(`${BASE}/status`).set(IDENTITY).send(bad)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(statusStore.current()).toEqual(before)
  })

  it('without a pushed section the snapshot carries no graduated view', async () => {
    const { app, provider } = machine()
    const plain = { ...structuredClone(PLAIN), sentAtMs: PUSH.sentAtMs }
    expect((await request(app).post(`${BASE}/status`).set(IDENTITY).send(plain)).status).toBe(200)
    expect((await provider.getSnapshot()).runtime.graduated).toBeNull()
  })

  it('adds no command path: the machine app has no graduated, cut or restore route', async () => {
    const { app } = machine()
    for (const route of ['graduated', 'cut', 'restore', 'command', 'uplink']) {
      for (const method of ['get', 'post', 'put']) {
        const response = await request(app)[method](`${BASE}/${route}`).set(IDENTITY).send({})
        expect(response.status, `${method} ${route}`).toBe(404)
      }
    }
  })
})

describe('graduated section: demo data', () => {
  it('is clearly labelled demo data with documentation addresses only', async () => {
    const provider = createDemoProvider({ clock: () => NOW })
    const snapshot = await provider.getSnapshot()
    const view = snapshot.runtime.graduated
    expect(view.demo).toBe(true)
    expect(view.provenance).toBe('DEMO')
    expect(view.decisions.every((d) => d.attackerIp.startsWith('203.0.113.'))).toBe(true)
    expect(view.cutRecommendedFor.startsWith('203.0.113.')).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/RESTORE/)
  })
})
