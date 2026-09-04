// src/diskHealth.js — AEGIS host telemetry agent · disk-health evidence reader
//
// The agent never runs smartctl. It reads ONE file that the separate,
// privileged-but-bounded collector (collectors/disk-health.js) writes on a
// timer, validates it as untrusted input, and republishes an allowlisted
// projection on /internal/disk-health.
//
// Validating here, inside the agent, is deliberate even though Drive validates
// again: the file is written by a different user under a different unit, and
// a corrupted or half-migrated file must degrade to an explicit `unavailable`
// at the first boundary it crosses, not be forwarded as-is.
import { DISK_WARNING_CODES } from '../collectors/smart.js'

export const DISK_HEALTH_SCHEMA_VERSION = 1

/** Keys the agent may emit at the top level of /internal/disk-health. */
export const DISK_HEALTH_TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'measuredAt', 'device', 'disk'])

/** Keys an available `disk` object may carry. No serial, no paths, no raw attributes. */
export const DISK_HEALTH_DISK_KEYS = Object.freeze([
  'available', 'model', 'smart', 'temperatureCelsius', 'powerOnHours', 'capacityBytes', 'warnings',
])

export const DISK_HEALTH_SMART_KEYS = Object.freeze(['supported', 'enabled', 'passed'])

/** Reasons the agent itself may produce (the collector has its own set). */
export const AGENT_DISK_REASONS = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  NO_EVIDENCE: 'collector-not-run',
  INVALID: 'invalid-evidence',
})

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isBooleanOrNull = (value) => value === null || typeof value === 'boolean'
const isNonNegativeOrNull = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const hasOnlyKeys = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key))

/** An ISO-8601 instant that round-trips, or null. */
function parseInstant(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  if (new Date(ms).toISOString() !== new Date(value).toISOString()) return null
  return ms
}

const DEVICE_PATTERN = /^(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2}|mmcblk[0-9]{1,2})$/

/**
 * Validate one parsed evidence document.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, evidence: object } | { ok: false, reason: string }}
 */
export function validateDiskHealthEvidence(raw) {
  const fail = (reason) => ({ ok: false, reason })
  if (!isPlainObject(raw)) return fail('not-an-object')
  if (!hasOnlyKeys(raw, DISK_HEALTH_TOP_LEVEL_KEYS)) return fail('unexpected-top-level-key')
  if (raw.schemaVersion !== DISK_HEALTH_SCHEMA_VERSION) return fail('unsupported-schema-version')
  if (parseInstant(raw.measuredAt) === null) return fail('malformed-measured-at')
  if (typeof raw.device !== 'string' || !DEVICE_PATTERN.test(raw.device)) return fail('device-invalid')

  const disk = raw.disk
  if (!isPlainObject(disk)) return fail('disk-not-an-object')
  if (disk.available === false) {
    // Unavailable carries exactly one explanation and nothing else — no number
    // may ride along with "we could not measure this".
    const keys = Object.keys(disk).sort()
    if (keys.length !== 2 || keys[0] !== 'available' || keys[1] !== 'reason') return fail('disk-unavailable-with-values')
    if (typeof disk.reason !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(disk.reason)) return fail('disk-reason-invalid')
    return { ok: true, evidence: raw }
  }
  if (disk.available !== true) return fail('disk-available-not-boolean')
  if (!hasOnlyKeys(disk, DISK_HEALTH_DISK_KEYS)) return fail('disk-unexpected-key')
  if (disk.model !== null && (typeof disk.model !== 'string' || disk.model.length > 64)) return fail('disk-model-invalid')
  if (!isPlainObject(disk.smart) || !hasOnlyKeys(disk.smart, DISK_HEALTH_SMART_KEYS)) return fail('disk-smart-invalid')
  for (const key of DISK_HEALTH_SMART_KEYS) {
    if (!isBooleanOrNull(disk.smart[key])) return fail('disk-smart-invalid')
  }
  if (!isNonNegativeOrNull(disk.temperatureCelsius)) return fail('disk-temperature-invalid')
  if (!isNonNegativeOrNull(disk.powerOnHours)) return fail('disk-power-on-hours-invalid')
  if (!isNonNegativeOrNull(disk.capacityBytes)) return fail('disk-capacity-invalid')
  if (!Array.isArray(disk.warnings) || !disk.warnings.every((code) => DISK_WARNING_CODES.includes(code))) {
    return fail('disk-warnings-invalid')
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
export function diskHealthFromFileText(text, { now = Date.now, configured = true } = {}) {
  const unavailable = (reason) => ({
    schemaVersion: DISK_HEALTH_SCHEMA_VERSION,
    measuredAt: new Date(now()).toISOString(),
    device: null,
    disk: { available: false, reason },
  })
  if (!configured) return unavailable(AGENT_DISK_REASONS.NOT_CONFIGURED)
  if (typeof text !== 'string' || !text.trim()) return unavailable(AGENT_DISK_REASONS.NO_EVIDENCE)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return unavailable(AGENT_DISK_REASONS.INVALID)
  }
  const validated = validateDiskHealthEvidence(parsed)
  return validated.ok ? validated.evidence : unavailable(AGENT_DISK_REASONS.INVALID)
}

/**
 * Rebuild the wire body from the allowlist only, so a future key added to the
 * evidence file cannot leak through the agent by accident.
 *
 * @param {object} evidence a document from diskHealthFromFileText()
 */
export function projectDiskHealth(evidence) {
  const disk = evidence.disk
  const projectedDisk = disk.available === true
    ? {
      available: true,
      model: disk.model ?? null,
      smart: {
        supported: disk.smart.supported ?? null,
        enabled: disk.smart.enabled ?? null,
        passed: disk.smart.passed ?? null,
      },
      temperatureCelsius: disk.temperatureCelsius ?? null,
      powerOnHours: disk.powerOnHours ?? null,
      capacityBytes: disk.capacityBytes ?? null,
      warnings: [...disk.warnings],
    }
    : { available: false, reason: disk.reason }
  return {
    schemaVersion: DISK_HEALTH_SCHEMA_VERSION,
    measuredAt: evidence.measuredAt,
    device: evidence.device ?? null,
    disk: projectedDisk,
  }
}
