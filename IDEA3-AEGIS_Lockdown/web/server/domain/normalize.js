import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { CANONICAL_STATUSES, evaluateFreshness, isCanonicalStatus } from './status.js'

const timestampSchema = z.string().datetime({ offset: true })
const boundedText = z.string().trim().min(1).max(80)
const severitySchema = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])

const idea1Schema = z.object({
  timestamp: timestampSchema,
  action: boundedText,
  result: z.enum(['DENIED', 'BLOCKED']),
  source_ip: boundedText,
}).passthrough()

const idea2Schema = z.object({
  timestamp: timestampSchema,
  type: z.enum(['PERSON_DETECTED', 'UNKNOWN_PERSON', 'LINE_CROSSING', 'CAMERA_TAMPER']),
  severity: severitySchema,
  source_ip: boundedText,
  target: boundedText,
  result: z.enum(['DETECTED', 'CONFIRMED', 'CLEARED']),
}).passthrough()

const issueCodes = new Set([
  'PREFLIGHT_FAILED', 'BROKER_DISCONNECTED', 'DEVICE_OFFLINE', 'ACK_TIMEOUT',
  'COMPONENT_FAILED', 'STATUS_STALE', 'SUPERVISOR_FAILED', 'MALFORMED_EVIDENCE',
  'ADAPTER_UNAVAILABLE', 'ADAPTER_TIMEOUT', 'ADAPTER_RESPONSE_REJECTED',
])

const componentNames = Object.freeze({
  runtime: 'Supervisor',
  broker: 'MQTT Broker',
  esp32: 'ESP32',
  relay: 'Relay',
  uplink: 'Uplink',
  heartbeat: 'Heartbeat',
  ack: 'ACK',
})

function stableId(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}

function validIp(value) {
  return isIP(value) ? value : null
}

export function normalizeIdea1Event(raw) {
  const parsed = idea1Schema.safeParse(raw)
  if (!parsed.success) return null
  const sourceIp = validIp(parsed.data.source_ip)
  if (!sourceIp) return null
  const severity = parsed.data.result === 'BLOCKED' ? 'HIGH' : 'WARNING'

  return {
    id: stableId('i1', [parsed.data.timestamp, parsed.data.action, parsed.data.result, sourceIp]),
    timestamp: parsed.data.timestamp,
    source: 'IDEA1',
    action: parsed.data.action,
    type: 'ACCESS_CONTROL',
    result: parsed.data.result,
    sourceIp,
    target: 'AEGIS Drive',
    severity,
  }
}

export function normalizeIdea2Event(raw) {
  const parsed = idea2Schema.safeParse(raw)
  if (!parsed.success) return null
  const sourceIp = validIp(parsed.data.source_ip)
  if (!sourceIp) return null

  return {
    id: stableId('i2', [parsed.data.timestamp, parsed.data.type, sourceIp, parsed.data.target]),
    timestamp: parsed.data.timestamp,
    source: 'IDEA2',
    type: parsed.data.type,
    severity: parsed.data.severity,
    sourceIp,
    target: parsed.data.target,
    result: parsed.data.result,
  }
}

function normalizeIssues(issues) {
  if (!Array.isArray(issues)) return []
  return issues.slice(0, 20).flatMap((issue) => {
    if (!issue || !issueCodes.has(issue.code)) return []
    const component = typeof issue.component === 'string' ? issue.component.slice(0, 40) : 'runtime'
    const severity = severitySchema.safeParse(issue.severity).success ? issue.severity : 'WARNING'
    const firstSeen = timestampSchema.safeParse(issue.firstSeen).success ? issue.firstSeen : null
    const lastSeen = timestampSchema.safeParse(issue.lastSeen).success ? issue.lastSeen : null
    const count = Number.isSafeInteger(issue.count) ? Math.min(Math.max(issue.count, 1), 1_000_000) : 1
    return [{ code: issue.code, component, severity, firstSeen, lastSeen, count }]
  })
}

export function normalizeRuntimeStatus(raw, { now = new Date(), maxAgeMs = 120_000 } = {}) {
  if (!raw || raw.schemaVersion !== 1 || typeof raw.generatedAt !== 'string') {
    return unknownRuntime('MALFORMED')
  }

  const freshness = evaluateFreshness({ generatedAt: raw.generatedAt, now, maxAgeMs })
  const forceUnknown = freshness.status === 'UNKNOWN'
  const status = !forceUnknown && isCanonicalStatus(raw.status) ? raw.status : 'UNKNOWN'
  const components = Object.entries(componentNames).map(([id, name]) => ({
    id,
    name,
    status: forceUnknown || !isCanonicalStatus(raw.components?.[id]) ? 'UNKNOWN' : raw.components[id],
  }))

  return {
    schemaVersion: 1,
    generatedAt: raw.generatedAt,
    evidenceAgeMs: freshness.ageMs,
    freshness: freshness.freshness,
    status,
    components,
    modes: {
      monitorOnly: raw.modes?.monitorOnly === true,
      dryRun: raw.modes?.dryRun === true,
      armed: raw.modes?.armed === true,
      autoContain: raw.modes?.autoContain === true,
      recoveryAuthorized: raw.modes?.recoveryAuthorized === true,
    },
    issues: normalizeIssues(raw.issues),
    evidenceSource: typeof raw.evidenceSource === 'string'
      ? raw.evidenceSource.slice(0, 80)
      : 'unknown',
  }
}

export function unknownRuntime(freshness = 'ABSENT') {
  return {
    schemaVersion: 1,
    generatedAt: null,
    evidenceAgeMs: null,
    freshness,
    status: 'UNKNOWN',
    components: Object.entries(componentNames).map(([id, name]) => ({ id, name, status: 'UNKNOWN' })),
    modes: { monitorOnly: true, dryRun: true, armed: false, autoContain: false, recoveryAuthorized: false },
    issues: [],
    evidenceSource: 'unavailable',
  }
}

export { CANONICAL_STATUSES }
