import { describe, expect, it } from 'vitest'
import { DISPATCH_RESPONSE_STATES, dispatchDisplay } from '../../server/domain/dispatch.js'
import { deriveOverallStatus, evaluateFreshness, isCanonicalStatus } from '../../server/domain/status.js'

describe('PR10 S2 dispatch display', () => {
  const NOW = new Date('2026-09-12T08:00:30.000Z')
  const RECENT_CONTACT = new Date('2026-09-12T08:00:20.000Z')
  const PENDING = Object.freeze({
    actionId: '5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f',
    state: 'PENDING_DISPATCH',
    acceptedAt: '2026-09-12T08:00:00.000Z',
    expiresAt: '2026-09-12T08:02:00.000Z',
  })
  const CLAIMED = Object.freeze({ ...PENDING, state: 'CORE_CLAIMED' })
  const EXPIRED = Object.freeze({ ...PENDING, state: 'EXPIRED' })
  const stage = (name, detail = {}) => ({ stage: name, detail })
  const view = (action, evidence = [], { contact = RECENT_CONTACT, now = NOW } = {}) => (
    dispatchDisplay({ action, evidence, lastMachineContactAt: contact, now })
  )
  const boundary = (overrides = {}) => ({
    command_requested: true,
    command_published: false,
    acknowledged: false,
    executed: false,
    physical_evidence: false,
    ...overrides,
  })

  it('W13: shows a pending action as DISPATCH_UNAVAILABLE without machine contact in the last 120 s', () => {
    expect(view(PENDING, [], { contact: null }).responseState).toBe('DISPATCH_UNAVAILABLE')
    expect(view(PENDING).responseState).toBe('DISPATCH_PENDING')
    expect(view(PENDING, [], { contact: new Date('2026-09-12T07:58:29.000Z') }).responseState).toBe('DISPATCH_UNAVAILABLE')
  })

  it('W13: shows a past-due pending action as EXPIRED even before the list or claim sweep', () => {
    expect(view(PENDING, [], { now: new Date(PENDING.expiresAt) }).responseState).toBe('EXPIRED')
    expect(view(EXPIRED).responseState).toBe('EXPIRED')
  })

  it.each([
    ['a claim with no evidence', [], 'CORE_CLAIMED', boundary()],
    ['a dry run only', [stage('DRY_RUN')], 'DRY_RUN_ONLY', boundary()],
    ['a publish', [stage('PUBLISHED')], 'PUBLISHED', boundary({ command_published: true })],
    ['an OK ACK', [stage('PUBLISHED'), stage('ACK', { ackCode: 'OK' })], 'ACK_RECEIVED', boundary({ command_published: true, acknowledged: true })],
    ['a LOCKDOWN STATUS', [stage('PUBLISHED'), stage('ACK', { ackCode: 'OK' }), stage('STATUS', { deviceState: 'LOCKDOWN' })], 'STATUS_CORRELATED', boundary({ command_published: true, acknowledged: true })],
    ['a NORMAL STATUS, which is not a correlation', [stage('PUBLISHED'), stage('ACK', { ackCode: 'OK' }), stage('STATUS', { deviceState: 'NORMAL' })], 'ACK_RECEIVED', boundary({ command_published: true, acknowledged: true })],
    ['a failure', [stage('FAILED', { reasonCode: 'MQTT_UNAVAILABLE' })], 'FAILED', boundary()],
    ['an expiry at the Core', [stage('EXPIRED_AT_CORE')], 'EXPIRED_AT_CORE', boundary()],
  ])('W13: shows %s truthfully', (_case, evidence, responseState, expected) => {
    const display = view(CLAIMED, evidence)

    expect(display.responseState).toBe(responseState)
    expect(display.boundary).toEqual(expected)
    expect(display.humanReviewRequired).toBe(false)
  })

  it('W13: surfaces OUTCOME_UNKNOWN for human review ahead of any earlier progress', () => {
    const display = view(CLAIMED, [stage('PUBLISHED'), stage('ACK', { ackCode: 'OK' }), stage('OUTCOME_UNKNOWN', { reasonCode: 'STATUS_TIMEOUT' })])

    expect(display.responseState).toBe('OUTCOME_UNKNOWN')
    expect(display.humanReviewRequired).toBe(true)
    expect(display.boundary).toEqual(boundary({ command_published: true, acknowledged: true }))
  })

  it('W12/W13: no combination of evidence ever reports execution, physical evidence, or a Contained state', () => {
    const stages = [
      stage('PUBLISHED'), stage('DRY_RUN'), stage('ACK', { ackCode: 'OK' }), stage('STATUS', { deviceState: 'LOCKDOWN' }),
      stage('STATUS', { deviceState: 'NORMAL' }), stage('OUTCOME_UNKNOWN', { reasonCode: 'X' }),
      stage('FAILED', { reasonCode: 'X' }), stage('EXPIRED_AT_CORE'),
    ]
    for (let mask = 0; mask < 2 ** stages.length; mask += 1) {
      const evidence = stages.filter((_entry, index) => mask & (1 << index))
      for (const action of [PENDING, CLAIMED, EXPIRED]) {
        for (const contact of [null, RECENT_CONTACT]) {
          const display = view(action, evidence, { contact })
          expect(DISPATCH_RESPONSE_STATES).toContain(display.responseState)
          expect(display.responseState).not.toMatch(/CONTAIN/)
          expect(display.boundary.command_requested).toBe(true)
          expect(display.boundary.executed).toBe(false)
          expect(display.boundary.physical_evidence).toBe(false)
        }
      }
    }
  })
})

describe('evidence freshness', () => {
  const now = new Date('2026-09-03T00:02:01.000Z')

  it('returns UNKNOWN when evidence is stale', () => {
    expect(evaluateFreshness({
      generatedAt: '2026-09-03T00:00:00.000Z',
      now,
      maxAgeMs: 120_000,
    })).toEqual({ freshness: 'STALE', status: 'UNKNOWN', ageMs: 121_000 })
  })

  it('returns UNKNOWN when evidence is future-dated beyond clock tolerance', () => {
    expect(evaluateFreshness({
      generatedAt: '2026-09-03T00:02:07.000Z',
      now,
      maxAgeMs: 120_000,
    })).toEqual({ freshness: 'FUTURE', status: 'UNKNOWN', ageMs: -6_000 })
  })

  it('accepts evidence inside the freshness window', () => {
    expect(evaluateFreshness({
      generatedAt: '2026-09-03T00:01:31.000Z',
      now,
      maxAgeMs: 120_000,
    })).toEqual({ freshness: 'FRESH', ageMs: 30_000 })
  })

  it('recognizes only the six canonical statuses', () => {
    expect(isCanonicalStatus('HEALTHY')).toBe(true)
    expect(isCanonicalStatus('ONLINE')).toBe(false)
  })
})

describe('overall status', () => {
  it('uses FAILED when any required component has failed', () => {
    expect(deriveOverallStatus(['HEALTHY', 'FAILED', 'UNKNOWN'])).toBe('FAILED')
  })

  it('uses UNKNOWN when no component proves a failure but evidence is unknown', () => {
    expect(deriveOverallStatus(['HEALTHY', 'UNKNOWN'])).toBe('UNKNOWN')
  })

  it('uses DEGRADED ahead of configured non-operational states', () => {
    expect(deriveOverallStatus(['HEALTHY', 'DISABLED', 'DEGRADED'])).toBe('DEGRADED')
  })
})
