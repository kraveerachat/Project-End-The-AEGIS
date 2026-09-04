import { describe, expect, it } from 'vitest'
import { deriveOverallStatus, evaluateFreshness, isCanonicalStatus } from '../../server/domain/status.js'

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
