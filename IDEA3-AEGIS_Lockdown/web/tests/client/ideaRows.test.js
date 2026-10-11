import { describe, expect, it } from 'vitest'
import { ideaRows } from '../../src/lib/idea.js'

const event = (overrides = {}) => ({
  source: 'IDEA1', event_id: 'e1', event_type: 'ACCESS_DENIED', severity: 'HIGH', occurred_at: '2026-01-01T00:00:00.000Z',
  received_at: '2026-01-01T00:00:01.000Z', resource: 'drive', subject: null, confidence: null, evidence: { result: 'DENIED' },
  evidence_completeness: 'COMPLETE', freshness: 'FRESH', correlation_key: null, containment_eligible: true, dedup_count: 2, ...overrides,
})

describe('ideaRows', () => {
  it('prefers dedicated rows when they exist', () => {
    const dedicated = [{ id: 'd1' }]
    const view = ideaRows({ idea1: { events: dedicated, summary: { denied: 9 } }, integration: { events: [event()] } }, 'IDEA1')
    expect(view.origin).toBe('DEDICATED')
    expect(view.rows).toBe(dedicated)
    expect(view.summary.denied).toBe(9)
  })

  it('falls back to normalized integration events filtered by source', () => {
    const snapshot = { idea1: { events: [] }, idea2: { events: [] }, integration: { events: [event(), event({ source: 'IDEA2', event_id: 'e2' })] } }
    const one = ideaRows(snapshot, 'IDEA1')
    const two = ideaRows(snapshot, 'IDEA2')
    expect(one.origin).toBe('INTEGRATION')
    expect(one.rows.map((row) => row.id)).toEqual(['IDEA1:e1'])
    expect(two.rows.map((row) => row.id)).toEqual(['IDEA2:e2'])
  })

  it('never invents a source IP and keeps per-row freshness', () => {
    const [row] = ideaRows({ integration: { events: [event({ freshness: 'FUTURE' })] } }, 'IDEA1').rows
    expect(row.sourceIp).toBeUndefined()
    expect(row.freshness).toBe('FUTURE')
    expect(row.dedupCount).toBe(2)
  })

  it('counts only FRESH rows and leaves uncountable figures undefined', () => {
    const rows = [event(), event({ event_id: 'e2', freshness: 'STALE' }), event({ event_id: 'e3', evidence: { result: 'BLOCKED' } })]
    const { summary } = ideaRows({ integration: { events: rows } }, 'IDEA1')
    expect(summary).toEqual({ denied: 1, blocked: 1 })
    expect(summary.uniqueSourceIps).toBeUndefined()
  })

  it('returns an empty NONE view with no feed at all or malformed input', () => {
    expect(ideaRows({}, 'IDEA2')).toMatchObject({ origin: 'NONE', rows: [] })
    expect(ideaRows(undefined, 'IDEA1')).toMatchObject({ origin: 'NONE', rows: [] })
    expect(ideaRows({ integration: { events: [null, {}] } }, 'IDEA1').origin).toBe('NONE')
  })
})
