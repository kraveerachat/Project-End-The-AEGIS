// src/twingateHealth.js — AEGIS host telemetry agent · Twingate connector evidence reader
//
// The agent never talks to the Docker daemon. It reads ONE file that the
// separate, bounded collector (collectors/twingate-health.js) writes on a timer,
// validates it as untrusted input, and republishes an allowlisted projection on
// /internal/twingate-connector.
//
// Keeping the daemon out of this process is the whole point of the split. The
// Docker socket is root-equivalent: a long-running service that holds it is a
// service that can be turned into host takeover. This module can do exactly one
// thing — read a small JSON file — and that property is enforced by the tests in
// tests/agent.test.js, which forbid this directory from referencing any process
// or listener primitive at all.
//
// Validating here, inside the agent, is deliberate even though Drive validates
// again: the file is written by a different user under a different unit, and a
// corrupted or half-migrated file must degrade to an explicit `unavailable` at
// the first boundary it crosses, not be forwarded as-is.
import {
  TWINGATE_HEALTH_SCHEMA_VERSION,
  RUNTIME_STATE_VALUES,
  CONNECTOR_HEALTH_VALUES,
} from '../collectors/twingate.js'

export { TWINGATE_HEALTH_SCHEMA_VERSION }

/** Keys the agent may emit at the top level of /internal/twingate-connector. */
export const TWINGATE_TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'measuredAt', 'connector'])

/**
 * Keys an available `connector` object may carry.
 *
 * There is no id, no image, no name, no address, no mount, no label, and no
 * environment here — and there cannot be, because the collector never obtained
 * them (see the Docker format template) and this allowlist would drop them if
 * it somehow had.
 */
export const TWINGATE_CONNECTOR_KEYS = Object.freeze([
  'available', 'runtimeState', 'health', 'restartCount', 'startedAt',
])

/** Reasons the agent itself may produce (the collector has its own set). */
export const AGENT_TWINGATE_REASONS = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  NO_EVIDENCE: 'collector-not-run',
  INVALID: 'invalid-evidence',
})

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnlyKeys = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))
const isNonNegativeIntegerOrNull = (value) =>
  value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)

/** An ISO-8601 instant that round-trips, or null. */
function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}

/**
 * Validate one parsed evidence document.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, evidence: object } | { ok: false, reason: string }}
 */
export function validateTwingateEvidence(raw) {
  const fail = (reason) => ({ ok: false, reason })
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, TWINGATE_TOP_LEVEL_KEYS)) return fail('unexpected-top-level-key')
  if (raw.schemaVersion !== TWINGATE_HEALTH_SCHEMA_VERSION) return fail('unsupported-schema-version')
  if (parseInstant(raw.measuredAt) === null) return fail('malformed-measured-at')

  const connector = raw.connector
  if (!isPlainObject(connector)) return fail('connector-not-an-object')
  if (connector.available === false) {
    // Unavailable carries exactly one explanation and nothing else — no state,
    // no count, and no timestamp may ride along with "we could not measure it".
    const keys = Object.keys(connector).sort()
    if (keys.length !== 2 || keys[0] !== 'available' || keys[1] !== 'reason') {
      return fail('connector-unavailable-with-values')
    }
    if (typeof connector.reason !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(connector.reason)) {
      return fail('connector-reason-invalid')
    }
    return { ok: true, evidence: raw }
  }
  if (connector.available !== true) return fail('connector-available-not-boolean')
  if (!hasOnlyKeys(connector, TWINGATE_CONNECTOR_KEYS)) return fail('connector-unexpected-key')
  if (!RUNTIME_STATE_VALUES.includes(connector.runtimeState)) return fail('connector-runtime-state-invalid')
  if (!CONNECTOR_HEALTH_VALUES.includes(connector.health)) return fail('connector-health-invalid')
  if (!isNonNegativeIntegerOrNull(connector.restartCount)) return fail('connector-restart-count-invalid')
  if (connector.startedAt !== null && parseInstant(connector.startedAt) === null) {
    return fail('connector-started-at-invalid')
  }
  return { ok: true, evidence: raw }
}

/**
 * Parse the evidence file text. Null text means the collector has not written
 * anything yet; unparseable text is a corrupt file. Both are unavailable, with
 * different reasons, because the operator fixes them differently.
 *
 * @param {string | null} text
 * @param {{ now?: () => number, configured?: boolean }} [options]
 * @returns {object} an evidence document, always valid by construction
 */
export function twingateHealthFromFileText(text, { now = Date.now, configured = true } = {}) {
  const unavailable = (reason) => ({
    schemaVersion: TWINGATE_HEALTH_SCHEMA_VERSION,
    measuredAt: new Date(now()).toISOString(),
    connector: { available: false, reason },
  })
  if (!configured) return unavailable(AGENT_TWINGATE_REASONS.NOT_CONFIGURED)
  if (typeof text !== 'string' || !text.trim()) return unavailable(AGENT_TWINGATE_REASONS.NO_EVIDENCE)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return unavailable(AGENT_TWINGATE_REASONS.INVALID)
  }
  const validated = validateTwingateEvidence(parsed)
  return validated.ok ? validated.evidence : unavailable(AGENT_TWINGATE_REASONS.INVALID)
}

/**
 * Rebuild the wire body from the allowlist only, so a future key added to the
 * evidence file cannot leak through the agent by accident.
 *
 * @param {object} evidence a document from twingateHealthFromFileText()
 */
export function projectTwingateHealth(evidence) {
  const connector = evidence.connector
  const projected = connector.available === true
    ? {
      available: true,
      runtimeState: connector.runtimeState,
      health: connector.health,
      restartCount: connector.restartCount ?? null,
      startedAt: connector.startedAt ?? null,
    }
    : { available: false, reason: connector.reason }
  return {
    schemaVersion: TWINGATE_HEALTH_SCHEMA_VERSION,
    measuredAt: evidence.measuredAt,
    connector: projected,
  }
}
