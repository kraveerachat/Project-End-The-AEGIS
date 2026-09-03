// server/telemetry/diskHealthSchema.js — AEGIS Drive (IDEA1) · disk-health contract
//
// The host agent's /internal/disk-health body is validated here exactly as
// the V1 telemetry snapshot is validated in schema.js: fail closed, refuse
// unknown keys, never repair. The evidence is then turned into one of four
// deterministic statuses.
//
// The rules are stated once, here, and pinned by tests against the same
// smartctl fixtures the agent's own parser is tested with:
//
//   no usable evidence                          -> UNKNOWN  (with the reason)
//   evidence older than STALE_THRESHOLD         -> UNKNOWN  (reason 'stale')
//   any critical warning, or SMART passed=false -> CRITICAL
//   SMART passed=true and warnings present      -> WARNING
//   SMART passed=true and no warning            -> HEALTHY
//   SMART status not reported                   -> UNKNOWN  (never HEALTHY)
//
// UNKNOWN is never promoted to HEALTHY by any path.

export const DISK_HEALTH_SCHEMA_VERSION = 1

/**
 * The collector runs every 10 minutes (deploy/aegis-disk-health.timer). Three
 * missed runs make the last reading old enough that a PASS from it should
 * no longer be shown as a current HEALTHY.
 */
export const DISK_STALE_THRESHOLD_SECONDS = 30 * 60

/** How far ahead of Drive's clock the agent may timestamp the evidence. */
export const CLOCK_TOLERANCE_MS = 5_000

export const DISK_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN',
})

/** Mirrors the collector's allowlist (shared/host-telemetry-agent/collectors/smart.js). */
export const DISK_WARNING_CODES = Object.freeze([
  'smart-failed', 'attribute-failing-now', 'attribute-failed-past',
  'reallocated-sectors', 'pending-sectors', 'offline-uncorrectable', 'reported-uncorrectable',
  'temperature-high', 'nvme-critical-warning', 'nvme-spare-low', 'nvme-wear-high', 'smartctl-partial-failure',
])
export const DISK_CRITICAL_CODES = Object.freeze(['smart-failed', 'attribute-failing-now', 'nvme-critical-warning'])

const TOP_LEVEL_KEYS = ['schemaVersion', 'measuredAt', 'device', 'disk']
const DISK_KEYS = ['available', 'model', 'smart', 'temperatureCelsius', 'powerOnHours', 'capacityBytes', 'warnings']
const SMART_KEYS = ['supported', 'enabled', 'passed']
const DEVICE_PATTERN = /^(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2}|mmcblk[0-9]{1,2})$/
const REASON_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

const fail = (reason) => ({ ok: false, reason })
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnlyKeys = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))
const isBooleanOrNull = (value) => value === null || typeof value === 'boolean'
const isNonNegativeOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}

/**
 * Validate a raw /internal/disk-health body.
 *
 * @param {unknown} raw
 * @param {{ now?: number, clockToleranceMs?: number }} [options]
 * @returns {{ ok: true, document: object } | { ok: false, reason: string }}
 */
export function validateDiskHealthResponse(raw, { now = Date.now(), clockToleranceMs = CLOCK_TOLERANCE_MS } = {}) {
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, TOP_LEVEL_KEYS)) return fail('unexpected-top-level-key')
  if (raw.schemaVersion !== DISK_HEALTH_SCHEMA_VERSION) return fail('unsupported-schema-version')
  const measuredMs = parseInstant(raw.measuredAt)
  if (measuredMs === null) return fail('malformed-measured-at')
  if (measuredMs > now + clockToleranceMs) return fail('measured-in-the-future')
  if (raw.device !== null && (typeof raw.device !== 'string' || !DEVICE_PATTERN.test(raw.device))) return fail('device-invalid')

  const disk = raw.disk
  if (!isPlainObject(disk)) return fail('disk-not-an-object')
  if (disk.available === false) {
    const keys = Object.keys(disk).sort()
    if (keys.length !== 2 || keys[0] !== 'available' || keys[1] !== 'reason') return fail('disk-unavailable-with-values')
    if (typeof disk.reason !== 'string' || !REASON_PATTERN.test(disk.reason)) return fail('disk-reason-invalid')
    return { ok: true, document: raw }
  }
  if (disk.available !== true) return fail('disk-available-not-boolean')
  if (!hasOnlyKeys(disk, DISK_KEYS)) return fail('disk-unexpected-key')
  for (const key of DISK_KEYS) if (!(key in disk)) return fail(`disk-missing-${key}`)
  if (disk.model !== null && (typeof disk.model !== 'string' || !disk.model || disk.model.length > 64)) return fail('disk-model-invalid')
  if (!isPlainObject(disk.smart) || !hasOnlyKeys(disk.smart, SMART_KEYS)) return fail('disk-smart-invalid')
  for (const key of SMART_KEYS) if (!isBooleanOrNull(disk.smart[key])) return fail('disk-smart-invalid')
  if (!isNonNegativeOrNull(disk.temperatureCelsius)) return fail('disk-temperature-invalid')
  if (!isNonNegativeOrNull(disk.powerOnHours)) return fail('disk-power-on-hours-invalid')
  if (!isNonNegativeOrNull(disk.capacityBytes)) return fail('disk-capacity-invalid')
  if (!Array.isArray(disk.warnings) || !disk.warnings.every((code) => DISK_WARNING_CODES.includes(code))) return fail('disk-warnings-invalid')
  return { ok: true, document: raw }
}

/**
 * Deterministic status from validated evidence.
 *
 * @param {object} disk the `disk` object of a validated document
 * @param {{ stale?: boolean }} [options]
 * @returns {{ status: string, reason: string|null }}
 */
export function deriveDiskStatus(disk, { stale = false } = {}) {
  if (!disk || disk.available !== true) return { status: DISK_STATUS.UNKNOWN, reason: disk?.reason ?? 'no-evidence' }
  if (stale) return { status: DISK_STATUS.UNKNOWN, reason: 'stale' }
  const warnings = Array.isArray(disk.warnings) ? disk.warnings : []
  if (disk.smart.passed === false || warnings.some((code) => DISK_CRITICAL_CODES.includes(code))) {
    return { status: DISK_STATUS.CRITICAL, reason: null }
  }
  if (disk.smart.passed !== true) return { status: DISK_STATUS.UNKNOWN, reason: 'smart-status-not-reported' }
  if (warnings.length > 0) return { status: DISK_STATUS.WARNING, reason: null }
  return { status: DISK_STATUS.HEALTHY, reason: null }
}

/** Age in seconds, or null when the timestamp is unreadable. */
export function diskEvidenceAgeSeconds(measuredAt, now = Date.now()) {
  const ms = parseInstant(measuredAt)
  return ms === null ? null : (now - ms) / 1000
}
