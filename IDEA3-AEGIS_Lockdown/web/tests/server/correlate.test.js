import { describe, expect, it } from 'vitest'
import { correlateIncidents } from '../../server/domain/correlate.js'

const CORRELATION_KEY = 'zone-a-incident-42'

function event(source, overrides = {}) {
  return {
    source,
    event_id: `${source.toLowerCase()}-event-1`,
    event_type: 'ACCESS_DENIED',
    severity: source === 'IDEA1' ? 'WARNING' : 'HIGH',
    occurred_at: source === 'IDEA1' ? '2026-09-08T07:55:00.000Z' : '2026-09-08T08:00:00.000Z',
    received_at: '2026-09-08T08:00:00.000Z',
    resource: source === 'IDEA1' ? 'AEGIS Drive' : 'CAM-02',
    subject: null,
    confidence: null,
    evidence: { result: 'DENIED' },
    evidence_completeness: 'COMPLETE',
    freshness: 'FRESH',
    correlation_key: CORRELATION_KEY,
    containment_eligible: true,
    dedup_count: 1,
    ...overrides,
  }
}

const idea1 = event('IDEA1')
const idea2 = event('IDEA2')

describe('deterministic cross-IDEA correlation', () => {
  it('correlates one eligible IDEA1 and one eligible IDEA2 event sharing a correlation key', () => {
    const incidents = correlateIncidents([idea1, idea2])

    expect(incidents).toEqual([{
      id: expect.stringMatching(/^inc-[0-9a-f]{14}$/),
      state: 'CONTAINMENT_CANDIDATE',
      severity: 'HIGH',
      correlationKey: CORRELATION_KEY,
      firstSeen: '2026-09-08T07:55:00.000Z',
      lastSeen: '2026-09-08T08:00:00.000Z',
      idea1Count: 1,
      idea2Count: 1,
      evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
      responseState: 'NOT_REQUESTED',
    }])
  })

  it.each([
    ['IDEA1-only evidence', [idea1]],
    ['IDEA2-only evidence', [idea2]],
    ['no evidence at all', []],
  ])('produces no incident from %s', (_case, events) => {
    expect(correlateIncidents(events)).toEqual([])
  })

  it('does not correlate unrelated or absent correlation keys', () => {
    expect(correlateIncidents([idea1, event('IDEA2', { correlation_key: 'other-key' })])).toEqual([])
    expect(correlateIncidents([idea1, event('IDEA2', { correlation_key: null })])).toEqual([])
    expect(correlateIncidents([event('IDEA1', { correlation_key: null }), event('IDEA2', { correlation_key: null })])).toEqual([])
  })

  it('correlates at the window boundary and rejects evidence outside it', () => {
    const atBoundary = event('IDEA2', { occurred_at: '2026-09-08T08:05:00.000Z' })
    const outside = event('IDEA2', { occurred_at: '2026-09-08T08:05:00.001Z' })

    expect(correlateIncidents([idea1, atBoundary], 600_000)).toHaveLength(1)
    expect(correlateIncidents([idea1, outside], 600_000)).toEqual([])
  })

  it.each([
    ['a stale IDEA2 event', { freshness: 'STALE', containment_eligible: false }],
    ['a future IDEA2 event', { freshness: 'FUTURE', containment_eligible: false }],
    ['an unknown-severity IDEA2 event', { severity: 'UNKNOWN', containment_eligible: false }],
    ['an explicitly ineligible IDEA2 event', { containment_eligible: false }],
  ])('produces no incident from %s', (_case, overrides) => {
    expect(correlateIncidents([idea1, event('IDEA2', overrides)])).toEqual([])
  })

  it('does not inflate evidence counts from duplicated producer evidence', () => {
    const incidents = correlateIncidents([idea1, idea1, idea2, idea2])

    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toEqual(expect.objectContaining({ idea1Count: 1, idea2Count: 1, evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'] }))
  })

  it('produces an identical result for out-of-order input', () => {
    const extraIdea1 = event('IDEA1', { event_id: 'idea1-event-0', occurred_at: '2026-09-08T07:56:00.000Z' })

    expect(correlateIncidents([idea2, extraIdea1, idea1])).toEqual(correlateIncidents([idea1, extraIdea1, idea2]))
  })

  it('gives one stable incident ID per correlation key regardless of input order or repetition', () => {
    const first = correlateIncidents([idea1, idea2])[0].id
    const second = correlateIncidents([idea2, idea1, idea2])[0].id

    expect(first).toBe(second)
    expect(correlateIncidents([event('IDEA1', { correlation_key: 'zone-b' }), event('IDEA2', { correlation_key: 'zone-b' })])[0].id)
      .not.toBe(first)
  })

  it('reports the maximum known severity and ignores UNKNOWN for the incident severity', () => {
    const critical = correlateIncidents([event('IDEA1', { severity: 'CRITICAL' }), idea2])
    const informational = correlateIncidents([event('IDEA1', { severity: 'INFO' }), event('IDEA2', { severity: 'INFO' })])

    expect(critical[0].severity).toBe('CRITICAL')
    expect(informational[0].severity).toBe('INFO')
  })

  it('groups every eligible event that shares one correlation key into a single incident', () => {
    const incidents = correlateIncidents([
      idea1,
      event('IDEA1', { event_id: 'idea1-event-2', occurred_at: '2026-09-08T07:57:00.000Z' }),
      idea2,
    ])

    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toEqual(expect.objectContaining({
      idea1Count: 2,
      idea2Count: 1,
      evidenceIds: ['IDEA1:idea1-event-1', 'IDEA1:idea1-event-2', 'IDEA2:idea2-event-1'],
      firstSeen: '2026-09-08T07:55:00.000Z',
      lastSeen: '2026-09-08T08:00:00.000Z',
    }))
  })

  it('never advances an incident past the containment-candidate boundary', () => {
    const [incident] = correlateIncidents([idea1, idea2])

    expect(incident.state).toBe('CONTAINMENT_CANDIDATE')
    expect(JSON.stringify(incident)).not.toMatch(/COMMAND|PUBLISHED|ACK|EXECUTED|PHYSICAL/i)
  })

  it('ignores malformed timestamps instead of guessing a correlation window', () => {
    expect(correlateIncidents([event('IDEA1', { occurred_at: 'not-a-timestamp' }), idea2])).toEqual([])
  })
})
