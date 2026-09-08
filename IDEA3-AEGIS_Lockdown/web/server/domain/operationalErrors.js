import { createHash } from 'node:crypto'

const CATALOG = Object.freeze({
  CORE_PROCESS_FAILURE: ['RUNTIME', 'CRITICAL', 'The core runtime process reported a failure.', 'Runtime', false],
  MQTT_DISCONNECTED: ['CONNECTIVITY', 'HIGH', 'MQTT broker connection is unavailable.', 'MQTT Broker', true],
  MQTT_RECONNECTING: ['CONNECTIVITY', 'WARNING', 'MQTT broker is reconnecting.', 'MQTT Broker', true],
  ESP32_UNAVAILABLE: ['DEVICE', 'HIGH', 'ESP32 device is unavailable.', 'ESP32', true],
  RUNTIME_EVIDENCE_STALE: ['EVIDENCE', 'HIGH', 'Runtime status evidence is stale.', 'Runtime', true],
  MALFORMED_RUNTIME_STATUS: ['EVIDENCE', 'HIGH', 'Runtime status evidence is malformed.', 'Runtime', true],
  COMMAND_SEND_FAILURE: ['COMMAND', 'HIGH', 'Command could not be sent.', 'Command Channel', true],
  COMMAND_TIMEOUT: ['COMMAND', 'HIGH', 'Command timed out.', 'Command Channel', true],
  ACK_TIMEOUT: ['COMMAND', 'HIGH', 'Command acknowledgement timed out.', 'ACK', true],
  STATUS_TIMEOUT: ['EVIDENCE', 'HIGH', 'Status response timed out.', 'Status', true],
  PHYSICAL_CONFIRMATION_TIMEOUT: ['SAFETY', 'CRITICAL', 'Physical confirmation timed out.', 'Physical Confirmation', false],
  PHYSICAL_STATE_MISMATCH: ['SAFETY', 'CRITICAL', 'Physical state did not match the confirmed command.', 'Physical Confirmation', false],
  UNAUTHORIZED_RESTORE: ['AUTHORIZATION', 'CRITICAL', 'Restore attempt was not authorized.', 'Recovery', false],
  AUDIT_PERSISTENCE_FAILURE: ['AUDIT', 'CRITICAL', 'Audit record could not be persisted.', 'Audit Store', false],
  AUTHENTICATION_FAILURE: ['AUTHENTICATION', 'HIGH', 'Authentication failed.', 'Authentication', true],
  SESSION_FAILURE: ['AUTHENTICATION', 'HIGH', 'Session validation failed.', 'Session', true],
  ADAPTER_UNAVAILABLE: ['ADAPTER', 'HIGH', 'Upstream adapter is unavailable.', 'Adapter', true],
  ADAPTER_TIMEOUT: ['ADAPTER', 'HIGH', 'Upstream adapter timed out.', 'Adapter', true],
  ADAPTER_RESPONSE_REJECTED: ['ADAPTER', 'HIGH', 'Upstream adapter response was rejected.', 'Adapter', true],
  ADAPTER_EVIDENCE_STALE: ['EVIDENCE', 'HIGH', 'Upstream adapter evidence is outside the accepted freshness window.', 'Adapter', true],
})

export const OPERATIONAL_ERROR_CODES = Object.freeze(Object.fromEntries(
  Object.entries(CATALOG).map(([code, [category, severity, message, component, recoverable]]) => [code, Object.freeze({ category, severity, message, component, recoverable })]),
))

const sensitiveKey = /password|token|secret|credential|authorization|cookie|hmac|key|path|stack|payload/i
const correlationId = /^[a-zA-Z0-9._:-]{1,128}$/
const serverComponents = new Set(['IDEA1 Adapter', 'IDEA2 Adapter', 'IDEA3 Runtime Adapter'])

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key))
    .map(([key, nested]) => [key, redactSensitive(nested)]))
}

export function createOperationalError(code, fields = {}) {
  const definition = OPERATIONAL_ERROR_CODES[code] ?? OPERATIONAL_ERROR_CODES.CORE_PROCESS_FAILURE
  const safeCorrelationId = typeof fields.correlationId === 'string' && correlationId.test(fields.correlationId)
    ? fields.correlationId
    : null
  const occurredAt = typeof fields.occurredAt === 'string' && Number.isFinite(Date.parse(fields.occurredAt))
    ? new Date(fields.occurredAt).toISOString()
    : new Date().toISOString()
  const component = serverComponents.has(fields.component) ? fields.component : definition.component

  return {
    code: OPERATIONAL_ERROR_CODES[code] ? code : 'CORE_PROCESS_FAILURE',
    category: definition.category,
    severity: definition.severity,
    message: definition.message,
    component,
    occurredAt,
    recoverable: definition.recoverable,
    correlationId: safeCorrelationId,
  }
}

export function operationalErrorFingerprint(error) {
  const safe = createOperationalError(error?.code, {
    occurredAt: error?.occurredAt,
    correlationId: error?.correlationId,
    component: error?.component,
  })
  return createHash('sha256').update([safe.code, safe.category, safe.component, safe.correlationId ?? ''].join('|')).digest('hex')
}
