import { describe, expect, it } from 'vitest'
import {
  normalizeIdea1Event,
  normalizeIdea2Event,
  normalizeRuntimeStatus,
} from '../../server/domain/normalize.js'
import {
  fixedNow,
  futureRuntimeRaw,
  healthyRuntimeRaw,
  idea1DeniedRaw,
  idea2DetectionRaw,
} from '../fixtures/evidence.js'

describe('upstream evidence normalization', () => {
  it('allows only the four approved IDEA1 producer fields plus server-owned fields', () => {
    const normalized = normalizeIdea1Event({
      ...idea1DeniedRaw,
      token: 'private',
      raw_request: '/private/path',
    })

    expect(normalized).toEqual({
      id: expect.stringMatching(/^i1-/),
      timestamp: '2026-09-03T00:09:10.000Z',
      source: 'IDEA1',
      action: 'LOGIN',
      type: 'ACCESS_CONTROL',
      result: 'DENIED',
      sourceIp: '10.30.0.24',
      target: 'AEGIS Drive',
      severity: 'WARNING',
    })
    expect(JSON.stringify(normalized)).not.toMatch(/token|raw_request|private\/path/)
  })

  it('drops media, biometric, and credential fields from IDEA2 evidence', () => {
    const normalized = normalizeIdea2Event(idea2DetectionRaw)

    expect(normalized).toEqual({
      id: expect.stringMatching(/^i2-/),
      timestamp: '2026-09-03T00:12:02.000Z',
      source: 'IDEA2',
      type: 'PERSON_DETECTED',
      severity: 'HIGH',
      sourceIp: '10.30.0.24',
      target: 'CAM-02',
      result: 'DETECTED',
    })
    expect(JSON.stringify(normalized)).not.toMatch(/base64|embedding|face_name|password|private-person/)
  })

  it('rejects malformed IP evidence instead of guessing an address', () => {
    expect(normalizeIdea1Event({ ...idea1DeniedRaw, source_ip: '999.2.3.4' })).toBeNull()
    expect(normalizeIdea2Event({ ...idea2DetectionRaw, source_ip: 'not-an-ip' })).toBeNull()
  })

  it('marks future runtime evidence UNKNOWN and removes raw fields', () => {
    const normalized = normalizeRuntimeStatus(futureRuntimeRaw, { now: fixedNow, maxAgeMs: 120_000 })
    expect(normalized.status).toBe('UNKNOWN')
    expect(normalized.freshness).toBe('FUTURE')
    expect(normalized.components.every((component) => component.status === 'UNKNOWN')).toBe(true)
    expect(JSON.stringify(normalized)).not.toMatch(/rawLog|mqttPassword|must not be returned/)
  })

  it('preserves allowed runtime state when evidence is fresh', () => {
    const normalized = normalizeRuntimeStatus(healthyRuntimeRaw, { now: fixedNow, maxAgeMs: 120_000 })
    expect(normalized.status).toBe('HEALTHY')
    expect(normalized.freshness).toBe('FRESH')
    expect(normalized.components).toContainEqual({ id: 'esp32', name: 'ESP32', status: 'HEALTHY' })
    expect(normalized.modes.monitorOnly).toBe(true)
  })
})
