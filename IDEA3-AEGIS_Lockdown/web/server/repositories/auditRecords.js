import { createOperationalError } from '../domain/operationalErrors.js'

const SENSITIVE_KEY = /password|passwd|cookie|session|csrf|secret|credential|authorization|hmac|mqtt|token|key|path|stack|payload/i
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CORRELATION_ID = /^[a-zA-Z0-9._:-]{1,128}$/
const SENSITIVE_NOTE_INDICATOR = /\b(?:api[\s_-]*key|hash|password(?:[\s_-]*hash)?|passwd|token|secret|credential|authorization|cookie|session|csrf(?:[\s_-]*token)?|hmac(?:[\s_-]*credential)?|mqtt(?:[\s_-]*(?:credential|password))?|path|stack(?:[\s_-]*trace)?|raw[\s_-]*payload)\b/i
const UNIX_ABSOLUTE_PATH = /(?:^|[\s"'=(])\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'=(])[a-zA-Z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]+/
const MAX_DETAIL_DEPTH = 6
const MAX_DETAIL_ENTRIES = 50
const MAX_TEXT_LENGTH = 500

export const DEFAULT_SETTINGS = Object.freeze({
  dedupWindowSeconds: 60,
  correlationWindowMinutes: 10,
  escalationThreshold: 3,
  eventRetentionDays: 30,
  auditRetentionDays: 180,
  exportLimit: 1000,
})

export class AuditPersistenceError extends Error {
  constructor(operation, cause) {
    super(`Audit persistence operation failed: ${operation}`, { cause })
    this.name = 'AuditPersistenceError'
    this.code = 'AUDIT_PERSISTENCE_FAILURE'
    this.operation = operation
  }
}

function boundedText(value, fallback) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_TEXT_LENGTH)
    : fallback
}

function sanitizeDetailValue(value, depth, seen) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!value || typeof value !== 'object' || depth >= MAX_DETAIL_DEPTH || seen.has(value)) return undefined

  seen.add(value)
  if (Array.isArray(value)) {
    const safe = value.slice(0, MAX_DETAIL_ENTRIES)
      .map((entry) => sanitizeDetailValue(entry, depth + 1, seen))
      .filter((entry) => entry !== undefined)
    seen.delete(value)
    return safe
  }

  const safe = {}
  for (const [key, nested] of Object.entries(value).slice(0, MAX_DETAIL_ENTRIES)) {
    if (SENSITIVE_KEY.test(key) || PROTOTYPE_KEYS.has(key)) continue
    const sanitized = sanitizeDetailValue(nested, depth + 1, seen)
    if (sanitized !== undefined) safe[key.slice(0, 80)] = sanitized
  }
  seen.delete(value)
  return safe
}

export function sanitizeAuditEntry(entry = {}) {
  const detail = sanitizeDetailValue(entry.detail, 0, new WeakSet())
  return {
    category: boundedText(entry.category, 'UNKNOWN'),
    action: boundedText(entry.action, 'UNKNOWN'),
    outcome: boundedText(entry.outcome, 'UNKNOWN'),
    actorRef: boundedText(entry.actorRef, 'system'),
    resourceType: boundedText(entry.resourceType, 'system'),
    resourceId: boundedText(entry.resourceId, 'unknown'),
    correlationId: typeof entry.correlationId === 'string' && CORRELATION_ID.test(entry.correlationId)
      ? entry.correlationId
      : null,
    detail: detail && !Array.isArray(detail) ? detail : {},
  }
}

export function sanitizeIncidentNote(note) {
  const normalized = typeof note === 'string' ? note.trim().slice(0, MAX_TEXT_LENGTH) : ''
  const sensitive = [SENSITIVE_NOTE_INDICATOR, UNIX_ABSOLUTE_PATH, WINDOWS_ABSOLUTE_PATH]
    .some((pattern) => pattern.test(normalized))
  return normalized && !sensitive
    ? normalized
    : '[REDACTED: sensitive incident note]'
}

export function auditEntryForOperationalError(error) {
  const safe = createOperationalError(error?.code, {
    occurredAt: error?.occurredAt,
    correlationId: error?.correlationId,
    component: error?.component,
  })
  return sanitizeAuditEntry({
    category: safe.category,
    action: safe.code,
    outcome: 'FAILURE',
    actorRef: 'system',
    resourceType: 'operational-error',
    resourceId: safe.component,
    correlationId: safe.correlationId,
    detail: { severity: safe.severity, recoverable: safe.recoverable },
  })
}

export function sanitizedSettings(next = {}) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => (
    Object.hasOwn(DEFAULT_SETTINGS, key) && Number.isSafeInteger(value)
  )))
}

export function validateAuditLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new RangeError('Audit query limit must be an integer from 1 through 250')
  }
  return limit
}
