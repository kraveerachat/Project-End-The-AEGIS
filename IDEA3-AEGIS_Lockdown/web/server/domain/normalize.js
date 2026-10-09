import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { CANONICAL_STATUSES, evaluateFreshness, isCanonicalStatus } from './status.js'
import { OPERATIONAL_ERROR_CODES, createOperationalError } from './operationalErrors.js'

const timestampSchema = z.string().datetime({ offset: true })
const boundedText = z.string().trim().min(1).max(80)
const severitySchema = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL'])
const coreIncidentSchema = z.object({
  id: z.string().regex(/^idea3-core-[1-9][0-9]*$/),
  coreIncidentId: z.number().int().positive(),
  source: z.literal('IDEA3'),
  state: z.enum(['OPEN', 'CONTAINED', 'CLOSED', 'UNKNOWN']),
  openedAt: timestampSchema.nullable(),
  closedAt: timestampSchema.nullable(),
  sourceIp: z.string().ip().nullable(),
  severity: z.literal('UNKNOWN'),
  provenance: z.literal('CORE_SQLITE'),
}).strict()
const coreAuditSchema = z.object({
  counts: z.record(z.string().regex(/^[A-Z_]{1,40}$/), z.number().int().min(0).max(1_000_000)),
  latestAt: timestampSchema.nullable(),
  freshness: z.enum(['FRESH', 'STALE', 'UNKNOWN']),
  provenance: z.literal('CORE_SQLITE'),
}).strict()
const coreDeviceSchema = z.object({
  id: z.string().min(1).max(80),
  broker: z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']),
  status: z.enum(['ONLINE', 'OFFLINE', 'UNKNOWN']),
  uplink: z.enum(['NORMAL', 'LOCKDOWN', 'UNKNOWN']),
  dispatch: z.enum(['DISABLED', 'ACTIVE', 'PAUSED_CREDENTIAL', 'UNAVAILABLE', 'UNKNOWN']),
  lastAuthenticatedStatusAt: timestampSchema.nullable(),
  physicalRelayState: z.literal('NOT_VERIFIED'),
  evidenceFreshness: z.enum(['FRESH', 'STALE', 'UNKNOWN']),
}).strict()
const coreEvidenceSchema = z.object({
  incidents: z.array(coreIncidentSchema).max(100),
  audit: coreAuditSchema,
  device: coreDeviceSchema,
  provenance: z.literal('CORE_SQLITE_READ_ONLY'),
}).strict()

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

const issueCodeMap = Object.freeze({
  PREFLIGHT_FAILED: 'CORE_PROCESS_FAILURE',
  BROKER_DISCONNECTED: 'MQTT_DISCONNECTED',
  DEVICE_OFFLINE: 'ESP32_UNAVAILABLE',
  COMPONENT_FAILED: 'CORE_PROCESS_FAILURE',
  STATUS_STALE: 'RUNTIME_EVIDENCE_STALE',
  SUPERVISOR_FAILED: 'CORE_PROCESS_FAILURE',
  MALFORMED_EVIDENCE: 'MALFORMED_RUNTIME_STATUS',
})

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

function runtimeIssueErrors(issues, occurredAt) {
  if (!Array.isArray(issues)) return []
  return issues.slice(0, 20).flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return []
    const code = issueCodeMap[issue.code] ?? (OPERATIONAL_ERROR_CODES[issue.code] ? issue.code : null)
    if (!code) return []
    const correlationId = typeof issue.correlationId === 'string'
      ? issue.correlationId
      : typeof issue.commandNonce === 'string'
        ? issue.commandNonce
          : null
    return [createOperationalError(code, { occurredAt, correlationId })]
  })
}

function malformedRuntime(raw) {
  return !raw
    || raw.schemaVersion !== 1
    || typeof raw.generatedAt !== 'string'
    || !isCanonicalStatus(raw.status)
    || !raw.components
    || typeof raw.components !== 'object'
    || Array.isArray(raw.components)
}

/**
 * The Core's versioned projection (aegis_soc.runtime.safe_status_projection) speaks the Core's own vocabulary: components broker/device/uplink
 * carry CONNECTED|ONLINE|NORMAL|LOCKDOWN..., armed is a string, issues are bare codes. Translate ONLY those documented values to the canonical
 * statuses. Anything else stays UNKNOWN, and relay, heartbeat and ACK are never inferred (the Core projection carries no physical or per-message
 * evidence for them). Document-supplied canonical component statuses always win, so the original contract is unchanged.
 */
const CORE_COMPONENT_VOCABULARY = Object.freeze({
  broker: Object.freeze({ source: 'broker', values: Object.freeze({ CONNECTED: 'HEALTHY', DISCONNECTED: 'FAILED' }) }),
  esp32: Object.freeze({ source: 'device', values: Object.freeze({ ONLINE: 'HEALTHY', OFFLINE: 'FAILED' }) }),
  uplink: Object.freeze({ source: 'uplink', values: Object.freeze({ NORMAL: 'HEALTHY', LOCKDOWN: 'DEGRADED' }) }),
})

function adaptCoreProjection(raw) {
  const components = { ...raw.components }
  for (const [id, { source, values }] of Object.entries(CORE_COMPONENT_VOCABULARY)) {
    if (isCanonicalStatus(components[id])) continue
    const mapped = Object.hasOwn(values, raw.components[source]) ? values[raw.components[source]] : undefined
    if (mapped) components[id] = mapped
  }
  if (!isCanonicalStatus(components.runtime) && raw.evidenceSource === 'RUNTIME_STATUS_FILE') components.runtime = raw.status
  const modes = { ...raw.modes }
  if (typeof modes.armed === 'string') {
    modes.monitorOnly = modes.monitorOnly === true || modes.armed === 'MONITOR_ONLY'
    modes.armed = modes.armed === 'ARMED'
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.map((issue) => (typeof issue === 'string' ? { code: issue } : issue)) : raw.issues
  return { ...raw, components, modes, issues }
}

function normalizeCoreEvidence(raw, { forceUnknown }) {
  const parsed = coreEvidenceSchema.safeParse(raw)
  if (!parsed.success || forceUnknown) return { incidents: [], audit: null, device: null, provenance: 'unavailable' }
  const { incidents, audit, device } = parsed.data
  const normalizedIncidents = incidents.map((incident) => ({
    ...incident,
    firstSeen: incident.openedAt,
    lastSeen: incident.closedAt || incident.openedAt,
    sourceIp: incident.sourceIp || 'UNKNOWN',
    title: `IDEA3 Core incident #${incident.coreIncidentId}`,
    summary: `Authoritative IDEA3 Core incident ${incident.state}`,
    responseState: incident.state === 'CLOSED' ? 'CLOSED' : 'NOT_REQUESTED',
    idea1Count: 0,
    idea2Count: 0,
    evidenceStages: [
      { stage: 'CORE INCIDENT', timestamp: incident.openedAt, status: incident.state === 'CLOSED' ? 'HEALTHY' : 'DEGRADED' },
      { stage: 'PHYSICAL STATE', timestamp: incident.closedAt || incident.openedAt, status: 'UNKNOWN' },
    ],
  }))
  return {
    incidents: [...new Map(normalizedIncidents.map((incident) => [incident.id, incident])).values()],
    audit,
    device: {
      id: device.id,
      type: 'ESP32 / Relay Controller',
      status: device.status === 'ONLINE' ? 'HEALTHY' : device.status === 'OFFLINE' ? 'FAILED' : 'UNKNOWN',
      lastSeen: device.lastAuthenticatedStatusAt,
      heartbeat: 'UNKNOWN',
      ack: 'UNKNOWN',
      relay: 'UNKNOWN',
      requestedRelayState: device.uplink,
      physicalRelayState: device.physicalRelayState,
      firmwareVersion: 'UNKNOWN',
      evidenceAgeMs: null,
      broker: device.broker,
      dispatch: device.dispatch,
    },
    provenance: 'CORE_SQLITE_READ_ONLY',
  }
}

export function normalizeRuntimeStatus(rawInput, { now = new Date(), maxAgeMs = 120_000 } = {}) {
  if (malformedRuntime(rawInput)) {
    return unknownRuntime('MALFORMED', [createOperationalError('MALFORMED_RUNTIME_STATUS', { occurredAt: now.toISOString() })])
  }
  const raw = adaptCoreProjection(rawInput)

  const freshness = evaluateFreshness({ generatedAt: raw.generatedAt, now, maxAgeMs })
  const forceUnknown = freshness.status === 'UNKNOWN'
  const operationalErrors = [
    ...(freshness.freshness === 'STALE'
      ? [createOperationalError('RUNTIME_EVIDENCE_STALE', { occurredAt: raw.generatedAt })]
      : []),
    ...(freshness.freshness === 'MALFORMED'
      ? [createOperationalError('MALFORMED_RUNTIME_STATUS', { occurredAt: now.toISOString() })]
      : []),
    ...runtimeIssueErrors(raw.issues, raw.generatedAt),
  ]
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
    operationalErrors,
    evidenceSource: typeof raw.evidenceSource === 'string'
      ? raw.evidenceSource.slice(0, 80)
      : 'unknown',
    coreEvidence: normalizeCoreEvidence(raw.evidence, { forceUnknown }),
  }
}

export function unknownRuntime(freshness = 'ABSENT', operationalErrors = []) {
  return {
    schemaVersion: 1,
    generatedAt: null,
    evidenceAgeMs: null,
    freshness,
    status: 'UNKNOWN',
    components: Object.entries(componentNames).map(([id, name]) => ({ id, name, status: 'UNKNOWN' })),
    modes: { monitorOnly: true, dryRun: true, armed: false, autoContain: false, recoveryAuthorized: false },
    issues: [],
    operationalErrors,
    evidenceSource: 'unavailable',
    coreEvidence: { incidents: [], audit: null, device: null, provenance: 'unavailable' },
  }
}

export { CANONICAL_STATUSES }
