// server/telemetry/schema.js — AEGIS Drive (IDEA1) · host agent contract
//
// The host telemetry agent is a separate process, running as a separate user,
// outside this container, released on its own cycle. Its output is therefore
// treated exactly like any other untrusted input: validated structurally before
// any of it reaches a screen.
//
// Two rules shape everything below.
//
//   Fail closed. An unexpected shape returns { ok: false, reason } — never a
//   partially repaired snapshot. Repairing untrusted telemetry is how a wrong
//   number acquires the authority of a measured one.
//
//   Extra keys are a rejection, not something to strip. Silently dropping an
//   unknown field would let a future agent (or anything that could impersonate
//   it on the socket) hand Drive data this contract never agreed to carry, and
//   the mismatch would go unnoticed. Refusing makes the drift visible.
//
// Staleness is deliberately NOT part of validation. A snapshot from an hour ago
// is still true about the moment it names; Drive shows it and labels it stale
// rather than blanking the dashboard.

/** The only agent contract version this Drive release understands. */
export const AGENT_SCHEMA_VERSION = 1

/**
 * A host measurement older than this is presented as stale.
 *
 * Sized against the agent's ~5s sampling interval: 15s survives two missed
 * cycles before Drive calls the data old, so a single slow cycle does not
 * flicker the dashboard.
 */
export const STALE_THRESHOLD_SECONDS = 15

/**
 * How far ahead of Drive's clock a measurement may be timestamped.
 *
 * The agent and Drive keep independent clocks, so a small skew is normal. A
 * larger one means the sample is not describing a moment that has happened,
 * and a "measurement" from the future is not a measurement.
 */
export const CLOCK_TOLERANCE_MS = 5_000

const MAX_INTERFACE_LENGTH = 15 // Linux IFNAMSIZ minus the NUL
const INTERFACE_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_.:-]*[A-Za-z0-9])?$/

const TOP_LEVEL_KEYS = ['schemaVersion', 'measuredAt', 'metrics']
const METRIC_NAMES = ['cpu', 'memory', 'network', 'uptime']

const METRIC_KEYS = {
  cpu: ['available', 'percent', 'windowSeconds'],
  memory: ['available', 'usedBytes', 'totalBytes', 'percent'],
  network: ['available', 'interface', 'rxBytesPerSec', 'txBytesPerSec', 'windowSeconds'],
  uptime: ['available', 'hostSeconds'],
}

const fail = (reason) => ({ ok: false, reason })

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isPercent = (value) => isFiniteNumber(value) && value >= 0 && value <= 100
const isByteCount = (value) => isFiniteNumber(value) && value >= 0
const isWindow = (value) => isFiniteNumber(value) && value > 0

/** Reject any key the contract does not name. */
function hasOnlyKeys(object, allowed) {
  return Object.keys(object).every((key) => allowed.includes(key))
}

/**
 * An ISO-8601 instant that round-trips.
 *
 * `Date.parse` accepts a lot of loosely-shaped strings, so the parsed value is
 * re-serialized and compared: that rejects '2026-13-45T99:99:99Z' and anything
 * else the engine merely tolerated.
 */
function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}

/** Validate one metric. Unavailable means exactly `{ available: false }`. */
function validateMetric(name, metric) {
  if (!isPlainObject(metric)) return `metrics.${name}-not-an-object`
  if (!hasOnlyKeys(metric, METRIC_KEYS[name])) return `metrics.${name}-unexpected-key`
  if (metric.available === false) {
    // An unavailable metric carrying a number is the exact failure this whole
    // contract exists to prevent — that number would render as a real reading.
    return Object.keys(metric).length === 1 ? null : `metrics.${name}-unavailable-with-values`
  }
  if (metric.available !== true) return `metrics.${name}-available-not-boolean`

  if (name === 'cpu') {
    if (!isPercent(metric.percent)) return 'metrics.cpu-percent-out-of-range'
    if (!isWindow(metric.windowSeconds)) return 'metrics.cpu-window-not-positive'
    return null
  }

  if (name === 'memory') {
    if (!isByteCount(metric.usedBytes)) return 'metrics.memory-used-invalid'
    if (!isByteCount(metric.totalBytes) || metric.totalBytes <= 0) return 'metrics.memory-total-invalid'
    if (metric.usedBytes > metric.totalBytes) return 'metrics.memory-used-exceeds-total'
    if (!isPercent(metric.percent)) return 'metrics.memory-percent-out-of-range'
    return null
  }

  if (name === 'network') {
    const iface = metric.interface
    if (typeof iface !== 'string' || !iface || iface.length > MAX_INTERFACE_LENGTH) {
      return 'metrics.network-interface-invalid'
    }
    // Validated even though Drive only displays it: the name arrives from
    // another process, and a path-shaped value must never look legitimate.
    if (!INTERFACE_PATTERN.test(iface)) return 'metrics.network-interface-invalid'
    if (!isByteCount(metric.rxBytesPerSec)) return 'metrics.network-rx-invalid'
    if (!isByteCount(metric.txBytesPerSec)) return 'metrics.network-tx-invalid'
    if (!isWindow(metric.windowSeconds)) return 'metrics.network-window-not-positive'
    return null
  }

  if (!isFiniteNumber(metric.hostSeconds) || metric.hostSeconds < 0) {
    return 'metrics.uptime-invalid'
  }
  return null
}

/**
 * Validate a raw host agent response.
 *
 * @param {unknown} raw the parsed JSON body from the agent
 * @param {{ now?: number, clockToleranceMs?: number }} [options]
 * @returns {{ ok: true, snapshot: object } | { ok: false, reason: string }}
 */
export function validateAgentSnapshot(raw, { now = Date.now(), clockToleranceMs = CLOCK_TOLERANCE_MS } = {}) {
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, TOP_LEVEL_KEYS)) return fail('unexpected-top-level-key')
  if (raw.schemaVersion !== AGENT_SCHEMA_VERSION) return fail('unsupported-schema-version')

  const measuredMs = parseInstant(raw.measuredAt)
  if (measuredMs === null) return fail('malformed-measured-at')
  if (measuredMs > now + clockToleranceMs) return fail('measured-in-the-future')

  const metrics = raw.metrics
  if (!isPlainObject(metrics)) return fail('metrics-not-an-object')
  if (!hasOnlyKeys(metrics, METRIC_NAMES)) return fail('unexpected-metric-group')
  for (const name of METRIC_NAMES) {
    if (!(name in metrics)) return fail(`missing-metrics.${name}`)
    const reason = validateMetric(name, metrics[name])
    if (reason) return fail(reason)
  }

  return { ok: true, snapshot: raw }
}

/**
 * Age of a measurement in seconds, or null when it cannot be determined.
 *
 * @param {string} measuredAt
 * @param {number} [now]
 */
export function ageSeconds(measuredAt, now = Date.now()) {
  const ms = parseInstant(measuredAt)
  if (ms === null) return null
  return (now - ms) / 1000
}

/**
 * Is this measurement older than the stale threshold?
 *
 * An unreadable timestamp counts as stale: unknown age is not fresh.
 *
 * @param {string} measuredAt
 * @param {number} [now]
 */
export function isStale(measuredAt, now = Date.now()) {
  const age = ageSeconds(measuredAt, now)
  if (age === null) return true
  return age > STALE_THRESHOLD_SECONDS
}
