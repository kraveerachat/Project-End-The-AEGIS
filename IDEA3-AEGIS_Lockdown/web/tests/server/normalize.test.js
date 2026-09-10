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
import { createLiveProvider } from '../../server/providers/liveProvider.js'

const adapterConfig = Object.freeze({
  adapters: Object.freeze({ idea1Url: 'https://idea1.test/status', idea2Url: 'https://idea2.test/status', runtimeUrl: 'https://runtime.test/status' }),
  adapterTimeoutMs: 5,
  maxEvidenceAgeMs: 120_000,
})

function jsonResponse(body, { ok = true } = {}) {
  return { ok, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
}

function providerFor(runtimeResponse) {
  return createLiveProvider({
    config: adapterConfig,
    clock: () => fixedNow,
    fetchImpl: async (url) => url === adapterConfig.adapters.runtimeUrl
      ? runtimeResponse()
      : jsonResponse({ events: [] }),
  })
}

function providerWithFetch(fetchImpl) {
  return createLiveProvider({ config: adapterConfig, clock: () => fixedNow, fetchImpl })
}

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

  it.each(['ERROR', 'STALE', 'UNAVAILABLE', 'TIMEOUT', 'UNKNOWN'])('never promotes %s runtime evidence to HEALTHY', (state) => {
    const normalized = normalizeRuntimeStatus({
      ...healthyRuntimeRaw,
      status: state,
      components: { ...healthyRuntimeRaw.components, broker: state },
    }, { now: fixedNow, maxAgeMs: 120_000 })

    expect(normalized.status).toBe('UNKNOWN')
    expect(normalized.components.find((component) => component.id === 'broker')?.status).toBe('UNKNOWN')
  })

  it('fails closed and records a safe error for stale or malformed runtime evidence', () => {
    const stale = normalizeRuntimeStatus({ ...healthyRuntimeRaw, generatedAt: '2026-09-03T00:00:00.000Z' }, { now: fixedNow, maxAgeMs: 120_000 })
    const malformed = normalizeRuntimeStatus({ schemaVersion: 1, generatedAt: fixedNow.toISOString(), status: 'HEALTHY' }, { now: fixedNow, maxAgeMs: 120_000 })

    expect(stale.status).toBe('UNKNOWN')
    expect(stale.components.every((component) => component.status === 'UNKNOWN')).toBe(true)
    expect(stale.operationalErrors).toContainEqual(expect.objectContaining({ code: 'RUNTIME_EVIDENCE_STALE' }))
    expect(malformed.status).toBe('UNKNOWN')
    expect(malformed.operationalErrors).toContainEqual(expect.objectContaining({ code: 'MALFORMED_RUNTIME_STATUS' }))
  })

  it('maps runtime broker and command distinctions without retaining secret fields', async () => {
    const snapshot = await providerFor(() => jsonResponse({
      ...healthyRuntimeRaw,
      issues: [
        { code: 'BROKER_DISCONNECTED', correlationId: 'nonce-100', password: 'private' },
        { code: 'MQTT_RECONNECTING', nonce: 'nonce-101', payload: { token: 'private' } },
        { code: 'COMMAND_TIMEOUT', commandNonce: 'command-302', nonce: 'dropped', correlation_id: 'dropped', authorization: 'private' },
        { code: 'ACK_TIMEOUT' }, { code: 'STATUS_TIMEOUT' },
        { code: 'PHYSICAL_CONFIRMATION_TIMEOUT' }, { code: 'PHYSICAL_STATE_MISMATCH' },
      ],
    })).getSnapshot()

    expect(snapshot.operationalErrors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'MQTT_DISCONNECTED', 'MQTT_RECONNECTING', 'COMMAND_TIMEOUT', 'ACK_TIMEOUT', 'STATUS_TIMEOUT',
      'PHYSICAL_CONFIRMATION_TIMEOUT', 'PHYSICAL_STATE_MISMATCH',
    ]))
    expect(snapshot.operationalErrors.find((error) => error.code === 'MQTT_DISCONNECTED')?.correlationId).toBe('nonce-100')
    expect(snapshot.operationalErrors.find((error) => error.code === 'COMMAND_TIMEOUT')?.correlationId).toBe('command-302')
    expect(JSON.stringify(snapshot.operationalErrors)).not.toMatch(/password|token|authorization|private|payload/)
  })

  it('accepts only commandNonce and correlationId for command-stage correlation', () => {
    const normalized = normalizeRuntimeStatus({
      ...healthyRuntimeRaw,
      issues: [
        { code: 'COMMAND_TIMEOUT', commandNonce: 'command-303', nonce: 'dropped', correlation_id: 'dropped' },
        { code: 'ACK_TIMEOUT', nonce: 'dropped', correlation_id: 'dropped' },
      ],
    }, { now: fixedNow, maxAgeMs: 120_000 })

    expect(normalized.operationalErrors.find((error) => error.code === 'COMMAND_TIMEOUT')?.correlationId).toBe('command-303')
    expect(normalized.operationalErrors.find((error) => error.code === 'ACK_TIMEOUT')?.correlationId).toBeNull()
  })

  it.each([
    ['times out', () => { const error = new Error('token=private'); error.name = 'AbortError'; throw error }, 'ADAPTER_TIMEOUT'],
    ['is unavailable', () => { throw new Error('password=private') }, 'ADAPTER_UNAVAILABLE'],
    ['rejects response', () => jsonResponse({ token: 'private' }, { ok: false }), 'ADAPTER_RESPONSE_REJECTED'],
  ])('records a safe error when the runtime adapter %s', async (_description, runtimeResponse, code) => {
    const snapshot = await providerFor(runtimeResponse).getSnapshot()
    expect(snapshot.operationalErrors).toContainEqual(expect.objectContaining({ code }))
    expect(JSON.stringify(snapshot.operationalErrors)).not.toMatch(/token|password|private/)
  })

  it('maps malformed runtime responses into a safe status error', async () => {
    const snapshot = await providerFor(() => jsonResponse('{not-json')).getSnapshot()
    expect(snapshot.runtime.status).toBe('UNKNOWN')
    expect(snapshot.operationalErrors).toContainEqual(expect.objectContaining({ code: 'MALFORMED_RUNTIME_STATUS' }))
  })

  it('keeps simultaneous adapter timeouts separate by server-controlled source component', async () => {
    const snapshot = await providerWithFetch(async (url) => {
      if (url === adapterConfig.adapters.runtimeUrl) return jsonResponse(healthyRuntimeRaw)
      const error = new Error('timeout')
      error.name = 'AbortError'
      throw error
    }).getSnapshot()

    expect(snapshot.operationalErrors.filter((error) => error.code === 'ADAPTER_TIMEOUT')).toEqual([
      expect.objectContaining({ component: 'IDEA1 Adapter' }),
      expect.objectContaining({ component: 'IDEA2 Adapter' }),
    ])
  })
})
