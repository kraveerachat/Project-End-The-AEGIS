// server/telemetry/twingateHealthSchema.js — AEGIS Drive (IDEA1) · local connector contract
//
// The host agent's /internal/twingate-connector body is validated here exactly
// as the V1 telemetry snapshot is validated in schema.js and the disk-health
// document in diskHealthSchema.js: fail closed, refuse unknown keys, never
// repair. The evidence is then turned into one deterministic status.
//
// ⚠️ SCOPE. Everything in this file describes the connector CONTAINER running on
//    the AEGIS host. It is local runtime evidence — Docker's view of a process
//    on this machine — and it is NOT the Twingate control plane's view of that
//    connector. The two can disagree: a container can be up and healthy here
//    while the control plane considers the connector disconnected (expired
//    token, revoked resource, network partition upstream). Drive therefore
//    reports them as two separate rows and never merges them into one "Online".
//    Nothing in this module, in the agent, or in the collector ever contacts
//    Twingate.
//
// The rules are stated once, here, and pinned by tests on both sides:
//
//   no usable evidence                    -> UNKNOWN (with the reason)
//   evidence older than STALE_THRESHOLD   -> UNKNOWN (reason 'stale')
//   RESTARTING                            -> RESTARTING
//   STOPPED                               -> STOPPED
//   RUNNING + HEALTHY                     -> HEALTHY
//   RUNNING + STARTING                    -> STARTING
//   RUNNING + UNHEALTHY                   -> UNHEALTHY
//   RUNNING + NOT_CONFIGURED              -> NOT_CONFIGURED  (never HEALTHY)
//   anything else                         -> UNKNOWN
//
// UNKNOWN and NOT_CONFIGURED are never promoted to HEALTHY by any path.

export const TWINGATE_SCHEMA_VERSION = 1

/**
 * The collector runs every 60 s (deploy/aegis-twingate-health.timer) with
 * AccuracySec=15s, so the worst-case gap between two runs is about 75 s. Five
 * minutes is roughly four consecutive missed runs — long enough that one late
 * timer never shows as a fault, short enough that a dead collector stops
 * presenting a stale RUNNING as the current state within a few minutes.
 */
export const TWINGATE_STALE_THRESHOLD_SECONDS = 300

/** How far ahead of Drive's clock the agent may timestamp the evidence. */
export const CLOCK_TOLERANCE_MS = 5_000

/** The runtime states the collector may publish (mirrors collectors/twingate.js). */
export const RUNTIME_STATES = Object.freeze(['RUNNING', 'STOPPED', 'RESTARTING', 'UNKNOWN'])

/** The health values the collector may publish (mirrors collectors/twingate.js). */
export const CONNECTOR_HEALTHS = Object.freeze([
  'HEALTHY', 'UNHEALTHY', 'STARTING', 'NOT_CONFIGURED', 'UNKNOWN',
])

/** The one derived value the UI renders for the LOCAL connector. */
export const CONNECTOR_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  STARTING: 'STARTING',
  UNHEALTHY: 'UNHEALTHY',
  STOPPED: 'STOPPED',
  RESTARTING: 'RESTARTING',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN',
})

const TOP_LEVEL_KEYS = ['schemaVersion', 'measuredAt', 'connector']
const CONNECTOR_KEYS = ['available', 'runtimeState', 'health', 'restartCount', 'startedAt']
const REASON_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

const fail = (reason) => ({ ok: false, reason })
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnlyKeys = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))
const isNonNegativeIntegerOrNull = (value) =>
  value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)

function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}

/**
 * Validate a raw /internal/twingate-connector body.
 *
 * @param {unknown} raw
 * @param {{ now?: number, clockToleranceMs?: number }} [options]
 * @returns {{ ok: true, document: object } | { ok: false, reason: string }}
 */
export function validateTwingateResponse(raw, { now = Date.now(), clockToleranceMs = CLOCK_TOLERANCE_MS } = {}) {
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, TOP_LEVEL_KEYS)) return fail('unexpected-top-level-key')
  if (raw.schemaVersion !== TWINGATE_SCHEMA_VERSION) return fail('unsupported-schema-version')
  const measuredMs = parseInstant(raw.measuredAt)
  if (measuredMs === null) return fail('malformed-measured-at')
  // Evidence stamped in the future is a clock problem, not a reading. Accepting
  // it would make the staleness check meaningless in the wrong direction.
  if (measuredMs > now + clockToleranceMs) return fail('measured-in-the-future')

  const connector = raw.connector
  if (!isPlainObject(connector)) return fail('connector-not-an-object')

  if (connector.available === false) {
    // Unavailable carries exactly one explanation and nothing else — no state
    // and no count may ride along with "we could not measure this".
    const keys = Object.keys(connector).sort()
    if (keys.length !== 2 || keys[0] !== 'available' || keys[1] !== 'reason') {
      return fail('connector-unavailable-with-values')
    }
    if (typeof connector.reason !== 'string' || !REASON_PATTERN.test(connector.reason)) {
      return fail('connector-reason-invalid')
    }
    return { ok: true, document: raw }
  }

  if (connector.available !== true) return fail('connector-available-not-boolean')
  if (!hasOnlyKeys(connector, CONNECTOR_KEYS)) return fail('connector-unexpected-key')
  for (const key of CONNECTOR_KEYS) if (!(key in connector)) return fail(`connector-missing-${key}`)
  if (!RUNTIME_STATES.includes(connector.runtimeState)) return fail('connector-runtime-state-invalid')
  if (!CONNECTOR_HEALTHS.includes(connector.health)) return fail('connector-health-invalid')
  if (!isNonNegativeIntegerOrNull(connector.restartCount)) return fail('connector-restart-count-invalid')
  if (connector.startedAt !== null && parseInstant(connector.startedAt) === null) {
    return fail('connector-started-at-invalid')
  }
  return { ok: true, document: raw }
}

/** Age of the evidence in seconds, or null when the timestamp is unusable. */
export function twingateEvidenceAgeSeconds(measuredAt, now = Date.now()) {
  const ms = parseInstant(measuredAt)
  if (ms === null) return null
  return (now - ms) / 1000
}

/**
 * Turn validated connector evidence into the one status the UI renders.
 *
 * @param {object} connector the validated, available connector object
 * @param {{ stale?: boolean }} [options]
 * @returns {{ status: string, reason: string | null }}
 */
export function deriveConnectorStatus(connector, { stale = false } = {}) {
  // A reading nobody has refreshed is not a current reading. Reporting a stale
  // RUNNING would tell an operator the connector is up when the only honest
  // statement is that it was up when something last looked.
  if (stale) return { status: CONNECTOR_STATUS.UNKNOWN, reason: 'stale' }

  if (connector.runtimeState === 'RESTARTING') return { status: CONNECTOR_STATUS.RESTARTING, reason: null }
  if (connector.runtimeState === 'STOPPED') return { status: CONNECTOR_STATUS.STOPPED, reason: null }
  if (connector.runtimeState !== 'RUNNING') return { status: CONNECTOR_STATUS.UNKNOWN, reason: 'runtime-state-unknown' }

  switch (connector.health) {
    case 'HEALTHY': return { status: CONNECTOR_STATUS.HEALTHY, reason: null }
    case 'STARTING': return { status: CONNECTOR_STATUS.STARTING, reason: null }
    case 'UNHEALTHY': return { status: CONNECTOR_STATUS.UNHEALTHY, reason: null }
    // Running with no healthcheck: Docker has not checked anything, so there is
    // nothing to call healthy. The container is up; its health is unknown to us.
    case 'NOT_CONFIGURED': return { status: CONNECTOR_STATUS.NOT_CONFIGURED, reason: 'no-healthcheck' }
    default: return { status: CONNECTOR_STATUS.UNKNOWN, reason: 'health-unknown' }
  }
}
