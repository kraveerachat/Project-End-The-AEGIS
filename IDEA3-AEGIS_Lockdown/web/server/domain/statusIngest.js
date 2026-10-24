import { evaluateFreshness } from './status.js'
import { sanitizeGraduated } from './graduated.js'

/**
 * Contract for the Core -> Web read-only status push (design: doc/Content/09_LIVE_STATUS_TRANSPORT_DESIGN.md).
 *
 * Nothing here opens a socket, mounts a route, reads a file or touches the clock on its own: the caller passes `now`.
 * The machine route (routes/machineRoutes.js) is the only caller, and only when the status-ingest flag is enabled.
 * The envelope carries only the Core's own allowlisted `safe_status_projection`. Every unknown key is refused rather than
 * ignored, evidence outside the freshness window or from the future is refused, and a replay or reordering (an envelope
 * that is not strictly newer than the stored one) is refused. A refusal never changes the stored record.
 */
export const STATUS_PUSH_SCHEMA = 'aegis.idea3.status-push'
export const STATUS_PUSH_VERSION = 1
export const MAX_STATUS_PUSH_BYTES = 8 * 1024
export const MAX_FUTURE_SKEW_MS = 5_000

const ENVELOPE_KEYS = ['schema', 'version', 'sentAtMs', 'projection']
const PROJECTION_KEYS = ['schemaVersion', 'generatedAt', 'status', 'dispatch', 'components', 'modes', 'issues', 'evidenceSource']
// Optional and additive: the Core's graduated-response display section (see domain/graduated.js). Absent stays absent.
const OPTIONAL_PROJECTION_KEYS = ['graduated']
const COMPONENT_KEYS = ['broker', 'device', 'uplink', 'detector', 'gui', 'preflight']
const MODE_KEYS = ['profile', 'dryRun', 'autoContain', 'armed']
const STATUS_VALUES = new Set(['HEALTHY', 'DEGRADED', 'FAILED', 'UNKNOWN'])
const COMPONENT_VALUES = new Set(['CONNECTED', 'DISCONNECTED', 'ONLINE', 'OFFLINE', 'NORMAL', 'LOCKDOWN', 'RUNNING', 'RESTARTING', 'FAILED', 'STOPPED', 'UNKNOWN'])
const DISPATCH_VALUES = new Set(['DISABLED', 'ACTIVE', 'PAUSED_CREDENTIAL', 'UNAVAILABLE', 'UNKNOWN'])
const ISSUE_VALUES = new Set(['MQTT_DISCONNECTED', 'ESP32_UNAVAILABLE', 'COMPONENT_FAILURE', 'CORE_PROCESS_FAILURE', 'DISPATCH_PAUSED'])
const PROFILE_VALUES = new Set(['development', 'lab', 'production', 'UNKNOWN'])
const ARMED_VALUES = new Set(['ARMED', 'DISARMED', 'MONITOR_ONLY', 'UNKNOWN'])

function refuse(code) {
  return { ok: false, code, record: null }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function validProjection(projection) {
  if (!isPlainObject(projection) || !hasOnlyKeys(projection, [...PROJECTION_KEYS, ...OPTIONAL_PROJECTION_KEYS])) return false
  if (!PROJECTION_KEYS.every((key) => key in projection)) return false
  if (projection.schemaVersion !== 1 || typeof projection.generatedAt !== 'string') return false
  if (projection.evidenceSource !== 'RUNTIME_STATUS_FILE') return false
  if (!STATUS_VALUES.has(projection.status) || !DISPATCH_VALUES.has(projection.dispatch)) return false
  const { components, modes, issues } = projection
  if (!isPlainObject(components) || !hasOnlyKeys(components, COMPONENT_KEYS)) return false
  if (!['broker', 'device', 'uplink'].every((key) => key in components)) return false
  if (!Object.values(components).every((value) => COMPONENT_VALUES.has(value))) return false
  if (!isPlainObject(modes) || !hasOnlyKeys(modes, MODE_KEYS) || !MODE_KEYS.every((key) => key in modes)) return false
  if (!PROFILE_VALUES.has(modes.profile) || !ARMED_VALUES.has(modes.armed)) return false
  if (typeof modes.dryRun !== 'boolean' || typeof modes.autoContain !== 'boolean') return false
  return Array.isArray(issues) && issues.length <= ISSUE_VALUES.size && issues.every((issue) => ISSUE_VALUES.has(issue))
}

/**
 * Validate one pushed envelope.
 * @param body parsed JSON body
 * @param options.now Date supplied by the caller
 * @param options.maxAgeMs freshness window for the Core evidence and for the push itself
 * @param options.previous record returned by an earlier accepted push, or null
 * @param options.allowedProfiles when set, the only Core profiles accepted (Production accepts only `production`, so
 *   LAB/development evidence is never taken as genuine Production Core evidence)
 */
export function validateStatusPush(body, { now, maxAgeMs = 120_000, previous = null, allowedProfiles = null } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return refuse('STATUS_PUSH_INVALID')
  if (!isPlainObject(body) || !hasOnlyKeys(body, ENVELOPE_KEYS) || !ENVELOPE_KEYS.every((key) => key in body)) {
    return refuse('STATUS_PUSH_INVALID')
  }
  if (body.schema !== STATUS_PUSH_SCHEMA || body.version !== STATUS_PUSH_VERSION) return refuse('STATUS_PUSH_UNSUPPORTED')
  if (!Number.isSafeInteger(body.sentAtMs) || body.sentAtMs <= 0) return refuse('STATUS_PUSH_INVALID')
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_STATUS_PUSH_BYTES) return refuse('STATUS_PUSH_INVALID')
  if (!validProjection(body.projection)) return refuse('STATUS_PUSH_INVALID')
  if (allowedProfiles && !allowedProfiles.includes(body.projection.modes.profile)) return refuse('STATUS_PUSH_PROFILE')

  // The optional graduated section is validated strictly; unknown fields inside it are dropped from the stored copy, and a
  // section that does not validate refuses the whole push (nothing is repaired or invented).
  let projection = body.projection
  if (Object.hasOwn(projection, 'graduated')) {
    const graduated = sanitizeGraduated(projection.graduated, { nowMs: now.getTime() })
    if (!graduated) return refuse('STATUS_PUSH_INVALID')
    projection = { ...projection, graduated }
  }

  const sentAge = now.getTime() - body.sentAtMs
  if (sentAge < -MAX_FUTURE_SKEW_MS) return refuse('STATUS_PUSH_FUTURE')
  if (sentAge > maxAgeMs) return refuse('STATUS_PUSH_STALE')

  const evidence = evaluateFreshness({ generatedAt: body.projection.generatedAt, now, maxAgeMs })
  if (evidence.freshness === 'FUTURE') return refuse('STATUS_PUSH_FUTURE')
  if (evidence.freshness === 'STALE') return refuse('STATUS_PUSH_STALE')
  if (evidence.freshness !== 'FRESH') return refuse('STATUS_PUSH_INVALID')

  if (previous) {
    const newerEnvelope = body.sentAtMs > previous.sentAtMs
    const notOlderEvidence = Date.parse(body.projection.generatedAt) >= Date.parse(previous.projection.generatedAt)
    if (!newerEnvelope || !notOlderEvidence) return refuse('STATUS_PUSH_REPLAY')
  }
  return {
    ok: true,
    code: null,
    record: Object.freeze({ sentAtMs: body.sentAtMs, receivedAt: now.toISOString(), projection: structuredClone(projection) }),
  }
}

/** In-memory holder for the latest accepted record. It stores nothing durable and never invents evidence. */
export function createStatusIngestStore({ maxAgeMs = 120_000, allowedProfiles = null } = {}) {
  let latest = null
  return {
    accept(body, now) {
      const result = validateStatusPush(body, { now, maxAgeMs, previous: latest, allowedProfiles })
      if (result.ok) latest = result.record
      return { ok: result.ok, code: result.code }
    },
    /** The last accepted projection, or null. Freshness is re-evaluated by the normal adapter, never by this store. */
    current() {
      return latest ? structuredClone(latest.projection) : null
    },
  }
}
