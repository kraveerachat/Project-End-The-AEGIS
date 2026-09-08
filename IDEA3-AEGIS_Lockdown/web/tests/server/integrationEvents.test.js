import { describe, expect, it } from 'vitest'
import {
  deduplicateIntegrationEvents,
  normalizeIntegrationEvent,
} from '../../server/domain/integrationEvents.js'

const receivedAt = new Date('2026-09-08T08:00:00Z')

const rawIdea1Event = Object.freeze({
  source: 'IDEA1',
  event_id: 'drive-audit-17',
  event_type: 'ACCESS_DENIED',
  severity: 'WARNING',
  occurred_at: '2026-09-08T07:59:55+00:00',
  resource: 'AEGIS Drive',
  subject: 'session-7b',
  confidence: 91.5,
  correlation_key: 'zone-a-incident-42',
  evidence: {
    result: 'DENIED',
    count: 2,
    password: 'must-not-leak',
    token: 'must-not-leak',
    embedding: 'must-not-leak',
    snapshot_path: '/private/camera.jpg',
  },
})

function normalize(raw = rawIdea1Event, source = 'IDEA1') {
  return normalizeIntegrationEvent(raw, { source, receivedAt, maxAgeMs: 120_000 })
}

function normalizedEvent(overrides = {}) {
  const result = normalize({ ...rawIdea1Event, ...overrides })
  expect(result.ok).toBe(true)
  return result.event
}

describe('canonical cross-IDEA event normalization', () => {
  it('normalizes required fields and derives IDEA3-owned receipt and freshness metadata', () => {
    const result = normalize()

    expect(result).toEqual({
      ok: true,
      event: {
        source: 'IDEA1',
        event_id: 'drive-audit-17',
        event_type: 'ACCESS_DENIED',
        severity: 'WARNING',
        occurred_at: '2026-09-08T07:59:55.000Z',
        received_at: '2026-09-08T08:00:00.000Z',
        resource: 'AEGIS Drive',
        subject: null,
        confidence: 91.5,
        evidence: { result: 'DENIED' },
        evidence_completeness: 'PARTIAL',
        freshness: 'FRESH',
        correlation_key: 'zone-a-incident-42',
        containment_eligible: true,
      },
    })
    expect(JSON.stringify(result.event)).not.toMatch(/password|token|embedding|snapshot_path|camera\.jpg/i)
  })

  it('keeps unknown severity visible but makes it ineligible for containment', () => {
    const result = normalize({ ...rawIdea1Event, severity: 'UNKNOWN' })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      event: expect.objectContaining({ severity: 'UNKNOWN', containment_eligible: false }),
    }))
  })

  it.each(['CAMERA_TAMPER', 'UNREVIEWED_EVENT'])('rejects the unreviewed %s type before it can become containment-eligible', (eventType) => {
    const result = normalize({ ...rawIdea1Event, event_type: eventType, severity: 'HIGH' })

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_EVENT' }) })
    expect(result.event).toBeUndefined()
  })

  it.each(['Alice Example', 'session-7b'])('does not retain the unreviewed subject %j in normalized output', (subject) => {
    const result = normalize({ ...rawIdea1Event, subject })

    expect(result).toEqual(expect.objectContaining({ ok: true, event: expect.objectContaining({ subject: null }) }))
    expect(JSON.stringify(result.event)).not.toContain(subject)
  })

  it('rejects invalid producer fields instead of returning an empty source', () => {
    const invalidTimestamp = normalize({ ...rawIdea1Event, occurred_at: 'not-a-timestamp' })
    const mismatchedSource = normalize({ ...rawIdea1Event, source: 'IDEA2' })

    expect(invalidTimestamp).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_EVENT' }) })
    expect(mismatchedSource).toEqual({ ok: false, error: expect.objectContaining({ code: 'INVALID_EVENT' }) })
  })

  it('marks stale and future but otherwise valid evidence as observable and containment-ineligible', () => {
    const stale = normalize({ ...rawIdea1Event, occurred_at: '2026-09-08T07:57:59Z' })
    const future = normalize({ ...rawIdea1Event, occurred_at: '2026-09-08T08:00:06Z' })

    expect(stale).toEqual(expect.objectContaining({ ok: true, event: expect.objectContaining({ freshness: 'STALE', containment_eligible: false }) }))
    expect(future).toEqual(expect.objectContaining({ ok: true, event: expect.objectContaining({ freshness: 'FUTURE', containment_eligible: false }) }))
  })
})

describe('canonical cross-IDEA event deduplication', () => {
  it('deduplicates repeated stable source:event_id evidence with a bounded count', () => {
    const first = normalizedEvent()
    const duplicate = { ...normalizedEvent(), received_at: '2026-09-08T08:00:30.000Z' }

    expect(deduplicateIntegrationEvents([first, duplicate])).toEqual({
      events: [{ ...first, dedup_count: 2 }],
      conflicts: [],
    })
  })

  it('rejects every occurrence of a stable ID when canonical content conflicts', () => {
    const first = normalizedEvent()
    const conflict = normalizedEvent({ resource: 'Different protected resource' })

    expect(deduplicateIntegrationEvents([first, conflict])).toEqual({
      events: [],
      conflicts: [{ code: 'EVENT_ID_CONFLICT', source: 'IDEA1', event_id: 'drive-audit-17' }],
    })
  })
})
