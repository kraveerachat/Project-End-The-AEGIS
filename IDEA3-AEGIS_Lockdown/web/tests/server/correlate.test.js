import { describe, expect, it } from 'vitest'
import { correlateIncidents, deduplicateEvents } from '../../server/domain/correlate.js'

const idea1 = {
  id: 'i1-a', timestamp: '2026-09-03T00:00:00.000Z', source: 'IDEA1', type: 'ACCESS_CONTROL',
  action: 'LOGIN', result: 'DENIED', sourceIp: '10.30.0.24', target: 'AEGIS Drive', severity: 'WARNING',
}
const idea2 = {
  id: 'i2-a', timestamp: '2026-09-03T00:09:59.000Z', source: 'IDEA2', type: 'PERSON_DETECTED',
  result: 'DETECTED', sourceIp: '10.30.0.24', target: 'CAM-02', severity: 'HIGH',
}

describe('event derivation', () => {
  it('deduplicates matching evidence inside the window and exposes the bounded count', () => {
    const duplicate = { ...idea1, id: 'i1-b', timestamp: '2026-09-03T00:00:20.000Z' }
    const result = deduplicateEvents([idea1, duplicate], 60_000)
    expect(result).toEqual([{ ...idea1, dedupCount: 2, lastSeen: duplicate.timestamp }])
  })

  it('correlates approved IDEA1 and IDEA2 evidence for the same IP within ten minutes', () => {
    const incidents = correlateIncidents([idea1, idea2], 600_000)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      id: expect.stringMatching(/^inc-/),
      severity: 'HIGH',
      state: 'ACTIVE',
      sourceIp: '10.30.0.24',
      idea1Count: 1,
      idea2Count: 1,
      responseState: 'NOT_REQUESTED',
    })
  })

  it('does not correlate different IPs or evidence outside the window', () => {
    expect(correlateIncidents([idea1, { ...idea2, sourceIp: '10.30.0.25' }], 600_000)).toEqual([])
    expect(correlateIncidents([idea1, { ...idea2, timestamp: '2026-09-03T00:10:01.000Z' }], 600_000)).toEqual([])
  })

  it('does not create duplicate incidents from duplicated producer evidence', () => {
    const incidents = correlateIncidents([idea1, idea1, idea2, idea2], 600_000)
    expect(incidents).toHaveLength(1)
  })
})
