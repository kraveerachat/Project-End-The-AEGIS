import { describe, expect, it } from 'vitest'
import { countsTrusted, domainView, evidenceCount, strictEvidenceStatus, zeroAwareStatus } from '../../src/lib/evidence.js'

const fresh = { status: 'HEALTHY', freshness: 'FRESH', generatedAt: '2026-01-01T00:00:00.000Z' }

describe('strictEvidenceStatus', () => {
  it('never reports HEALTHY without FRESH freshness and a valid timestamp', () => {
    expect(strictEvidenceStatus(fresh)).toBe('HEALTHY')
    expect(strictEvidenceStatus({ ...fresh, freshness: 'ABSENT' })).toBe('UNKNOWN')
    expect(strictEvidenceStatus({ ...fresh, generatedAt: 'nope' })).toBe('UNKNOWN')
    expect(strictEvidenceStatus({ ...fresh, freshness: 'STALE' })).toBe('STALE')
  })

  it('maps unrecognised values and missing domains to UNKNOWN', () => {
    expect(strictEvidenceStatus({ status: 'GREAT' })).toBe('UNKNOWN')
    expect(strictEvidenceStatus()).toBe('UNKNOWN')
    expect(strictEvidenceStatus(null)).toBe('UNKNOWN')
  })
})

describe('count trust', () => {
  it('trusts counts only from a healthy or degraded source', () => {
    for (const status of ['HEALTHY', 'DEGRADED']) expect(countsTrusted(status)).toBe(true)
    for (const status of ['UNKNOWN', 'STALE', 'FAILED', 'NOT_CONFIGURED', 'DISABLED', undefined]) expect(countsTrusted(status)).toBe(false)
  })

  it('shows a dash instead of a zero the source cannot vouch for', () => {
    expect(evidenceCount(0, false)).toBe('—')
    expect(evidenceCount(undefined, true)).toBe('—')
    expect(evidenceCount(0, true)).toBe('0')
    expect(evidenceCount(7, false)).toBe('7')
  })

  it('does not turn a zero into a HEALTHY badge from an untrusted source', () => {
    expect(zeroAwareStatus(0, false, 'STALE', 'DEGRADED')).toBe('STALE')
    expect(zeroAwareStatus(0, true, 'HEALTHY', 'DEGRADED')).toBe('HEALTHY')
    expect(zeroAwareStatus(3, true, 'HEALTHY', 'DEGRADED')).toBe('DEGRADED')
    expect(zeroAwareStatus(3, false, 'UNKNOWN', 'DEGRADED')).toBe('DEGRADED')
  })
})

describe('domainView', () => {
  it('survives an adapter failure that leaves no domain object', () => {
    const view = domainView(undefined)
    expect(view.status).toBe('UNKNOWN')
    expect(view.events).toEqual([])
    expect(view.summary).toEqual({})
    expect(view.trusted).toBe(false)
  })

  it('exposes events and summary of a healthy domain', () => {
    const view = domainView({ ...fresh, events: [{ id: 1 }], summary: { denied: 2 } })
    expect(view.trusted).toBe(true)
    expect(view.events).toHaveLength(1)
    expect(view.summary.denied).toBe(2)
  })
})

describe('evidenceAgeAt', () => {
  it('measures against the snapshot time and reports unknown for bad timestamps', async () => {
    const { evidenceAgeAt } = await import('../../src/lib/evidence.js')
    expect(evidenceAgeAt('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z', 'en')).toBe('30 seconds ago')
    expect(evidenceAgeAt(null, '2026-01-01T00:00:30.000Z', 'en')).toBe(evidenceAgeAt('bad', 'bad', 'en'))
  })
})
