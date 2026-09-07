import { describe, expect, it } from 'vitest'
import {
  OPERATIONAL_ERROR_CODES,
  createOperationalError,
  operationalErrorFingerprint,
  redactSensitive,
} from '../../server/domain/operationalErrors.js'

describe('operational error contract', () => {
  it('creates a safe, catalogued error and ignores untrusted message fields', () => {
    const error = createOperationalError('MQTT_DISCONNECTED', {
      occurredAt: '2026-09-03T00:12:24.000Z',
      correlationId: 'nonce-abc123',
      message: 'password=private',
      token: 'private',
    })

    expect(error).toEqual({
      code: 'MQTT_DISCONNECTED',
      category: 'CONNECTIVITY',
      severity: 'HIGH',
      message: 'MQTT broker connection is unavailable.',
      component: 'MQTT Broker',
      occurredAt: '2026-09-03T00:12:24.000Z',
      recoverable: true,
      correlationId: 'nonce-abc123',
    })
    expect(Object.keys(error)).toEqual(['code', 'category', 'severity', 'message', 'component', 'occurredAt', 'recoverable', 'correlationId'])
  })

  it('falls back from unknown codes without retaining arbitrary input', () => {
    expect(createOperationalError('private stack trace', {
      occurredAt: '2026-09-03T00:12:24.000Z',
      correlationId: 'correlation-42',
      message: '/srv/private/token',
    })).toEqual({
      code: 'CORE_PROCESS_FAILURE',
      category: 'RUNTIME',
      severity: 'CRITICAL',
      message: 'The core runtime process reported a failure.',
      component: 'Runtime',
      occurredAt: '2026-09-03T00:12:24.000Z',
      recoverable: false,
      correlationId: 'correlation-42',
    })
  })

  it('redacts nested sensitive values before they can be used in an error', () => {
    expect(redactSensitive({
      state: 'unavailable',
      password: 'private',
      nested: { hmac: 'signature', safe: 'retained' },
      payload: { raw: 'private' },
    })).toEqual({ state: 'unavailable', nested: { safe: 'retained' } })
  })

  it('provides a stable fingerprint from the safe error contract', () => {
    const error = createOperationalError('ADAPTER_TIMEOUT', {
      occurredAt: '2026-09-03T00:12:24.000Z', correlationId: 'corr-1',
    })
    expect(operationalErrorFingerprint(error)).toMatch(/^[a-f0-9]{64}$/)
    expect(operationalErrorFingerprint(error)).toBe(operationalErrorFingerprint({ ...error, message: 'untrusted message' }))
  })

  it('publishes all required operational codes', () => {
    expect(Object.keys(OPERATIONAL_ERROR_CODES)).toEqual(expect.arrayContaining([
      'CORE_PROCESS_FAILURE', 'MQTT_DISCONNECTED', 'MQTT_RECONNECTING', 'ESP32_UNAVAILABLE',
      'RUNTIME_EVIDENCE_STALE', 'MALFORMED_RUNTIME_STATUS', 'COMMAND_SEND_FAILURE', 'COMMAND_TIMEOUT',
      'ACK_TIMEOUT', 'STATUS_TIMEOUT', 'PHYSICAL_CONFIRMATION_TIMEOUT', 'PHYSICAL_STATE_MISMATCH',
      'UNAUTHORIZED_RESTORE', 'AUDIT_PERSISTENCE_FAILURE', 'AUTHENTICATION_FAILURE', 'SESSION_FAILURE',
      'ADAPTER_UNAVAILABLE', 'ADAPTER_TIMEOUT', 'ADAPTER_RESPONSE_REJECTED',
    ]))
  })
})
