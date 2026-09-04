// collectors/twingate.js — AEGIS Twingate connector collector · pure projection
//
// Everything here is a total function over the small JSON object Docker renders
// from the fixed template in twingate-health.js. No filesystem, no clock, no
// process, and — the load-bearing part — nothing that can reach the Docker
// daemon. The collector runner is the only place that executes anything, and it
// hands the parsed object in.
//
// This module is deliberately separate from twingate-health.js so the telemetry
// AGENT can import these enums and mappers without pulling the Docker-executing
// module into its process. The same split exists for disk health (smart.js is
// pure; disk-health.js is the privileged edge).
//
// The contract produced here is EVIDENCE, not a verdict: it records what Docker
// reported about the LOCAL container. Turning that into what an operator reads
// on screen is Drive's job (server/telemetry/twingateHealthSchema.js), so the
// rule set lives in one place and is tested on both sides.
//
// Refusal contract, same as the rest of the agent: a value Docker did not
// report is `null`, never 0, and a container Docker never health-checked is
// NOT_CONFIGURED, never HEALTHY.

/** The Twingate connector evidence contract version. */
export const TWINGATE_HEALTH_SCHEMA_VERSION = 1

/** Runtime states this collector may publish. */
export const RUNTIME_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  RESTARTING: 'RESTARTING',
  UNKNOWN: 'UNKNOWN',
})

/** Health values this collector may publish. */
export const CONNECTOR_HEALTH = Object.freeze({
  HEALTHY: 'HEALTHY',
  UNHEALTHY: 'UNHEALTHY',
  STARTING: 'STARTING',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN',
})

export const RUNTIME_STATE_VALUES = Object.freeze(Object.values(RUNTIME_STATE))
export const CONNECTOR_HEALTH_VALUES = Object.freeze(Object.values(CONNECTOR_HEALTH))

/**
 * The complete set of reasons that may appear on unavailable evidence.
 *
 * Fixed enums, not free text: a reason built from a Docker error message would
 * carry daemon paths, container ids, and whatever else the daemon chose to say
 * into a document that crosses two trust boundaries.
 */
export const TWINGATE_UNAVAILABLE_REASONS = Object.freeze([
  'connector-not-found',
  'docker-unavailable',
  'inspect-failed',
  'invalid-evidence',
  'collector-not-run',
  'not-configured',
])

/** Docker's own `State.Status` vocabulary for a container that is not running. */
const STOPPED_STATUSES = new Set(['created', 'exited', 'dead', 'paused', 'removing'])

/**
 * Docker renders a never-started container's StartedAt as the Go zero time.
 * Publishing that as a timestamp would put "01 Jan 0001" on the Settings screen.
 */
const ZERO_TIME_PREFIX = '0001-01-01'

/**
 * Map Docker's runtime fields onto the published enum.
 *
 * Restarting is tested first because a crash-looping container reports
 * `Running: true` between restarts — reporting that as RUNNING would present a
 * connector that never stays up as a connector that is up.
 */
export function runtimeStateFrom({ status, running, restarting } = {}) {
  if (restarting === true || status === 'restarting') return RUNTIME_STATE.RESTARTING
  if (running === true && status === 'running') return RUNTIME_STATE.RUNNING
  if (typeof status === 'string' && STOPPED_STATUSES.has(status)) return RUNTIME_STATE.STOPPED
  return RUNTIME_STATE.UNKNOWN
}

/**
 * Map Docker's healthcheck status onto the published enum.
 *
 * A container with no HEALTHCHECK is NOT_CONFIGURED, never HEALTHY: Docker has
 * not checked anything, and "we did not look" must not read as "we looked and
 * it was fine".
 */
export function connectorHealthFrom(health) {
  if (health === null || health === undefined || health === '' || health === 'none') {
    return CONNECTOR_HEALTH.NOT_CONFIGURED
  }
  if (health === 'healthy') return CONNECTOR_HEALTH.HEALTHY
  if (health === 'unhealthy') return CONNECTOR_HEALTH.UNHEALTHY
  if (health === 'starting') return CONNECTOR_HEALTH.STARTING
  return CONNECTOR_HEALTH.UNKNOWN
}

/** An ISO instant, or null when Docker reported the zero time or nonsense. */
export function normalizeStartedAt(value) {
  if (typeof value !== 'string' || !value || value.startsWith(ZERO_TIME_PREFIX)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/** A non-negative integer restart count, or null when Docker reported nonsense. */
export function normalizeRestartCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * Reduce one parsed Docker projection to the published connector evidence.
 *
 * Only the six fields the template asked for are read, and only four values are
 * produced. A key Docker might add to the template output in a future release
 * is simply never looked at, so it cannot travel onward.
 *
 * @param {unknown} parsed
 * @returns {object} the `connector` half of the evidence document
 */
export function connectorFromDockerProjection(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { available: false, reason: 'inspect-failed' }
  }
  return {
    available: true,
    runtimeState: runtimeStateFrom({
      status: parsed.status,
      running: parsed.running,
      restarting: parsed.restarting,
    }),
    health: connectorHealthFrom(parsed.health),
    restartCount: normalizeRestartCount(parsed.restartCount),
    startedAt: normalizeStartedAt(parsed.startedAt),
  }
}
