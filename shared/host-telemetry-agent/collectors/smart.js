// collectors/smart.js — AEGIS host disk-health collector · pure smartctl parser
//
// Everything here is a total function over the parsed `smartctl --json` output.
// No filesystem, no clock, no process. The collector runner (disk-health.js)
// is the only place that executes anything, and it hands the parsed object in.
//
// The contract this parser produces is EVIDENCE, not a verdict. It records what
// the device actually reported and which allowlisted warning conditions were
// measured. Turning evidence into HEALTHY / WARNING / CRITICAL / UNKNOWN is
// Drive's job (server/telemetry/diskHealth.js), so the rule set lives in one
// place and is tested against the same fixtures on both sides.
//
// Refusal contract, same as the rest of the agent: a metric the device does
// not report is `null`, never 0. A temperature of 0 °C is a real reading on a
// drive in a cold room; a temperature the firmware never exposed is not.

/**
 * The complete set of warning codes the collector may emit.
 *
 * Each one maps to a specific SMART/NVMe field that was actually read. Nothing
 * is inferred from age, capacity, model, or "typical" values.
 */
export const DISK_WARNING_CODES = Object.freeze([
  'smart-failed',             // smart_status.passed === false
  'attribute-failing-now',    // a prefail attribute is at/below its threshold now
  'attribute-failed-past',    // an attribute was at/below threshold in the past
  'reallocated-sectors',      // ATA id 5 raw > 0
  'pending-sectors',          // ATA id 197 raw > 0
  'offline-uncorrectable',    // ATA id 198 raw > 0
  'reported-uncorrectable',   // ATA id 187 raw > 0
  'temperature-high',         // current temperature >= TEMPERATURE_WARN_CELSIUS
  'nvme-critical-warning',    // NVMe critical_warning bitfield != 0
  'nvme-spare-low',           // NVMe available_spare < available_spare_threshold
  'nvme-wear-high',           // NVMe percentage_used >= NVME_WEAR_WARN_PERCENT
  'smartctl-partial-failure', // smartctl exit bit 2: some SMART command failed
])

/**
 * Warnings that mean the device itself says it is failing. Drive treats any of
 * these as CRITICAL; everything else in DISK_WARNING_CODES is WARNING.
 */
export const DISK_CRITICAL_CODES = Object.freeze([
  'smart-failed',
  'attribute-failing-now',
  'nvme-critical-warning',
])

/**
 * Fixed thresholds, stated here because the device does not always report its
 * own. 60 °C is below every consumer SSD rated maximum (typically 70 °C) and
 * above any normal operating temperature in a ventilated enclosure; a drive
 * sitting at 60 °C is worth a look, not an alarm. 90 % NVMe wear is the point
 * at which the spec percentage_used is telling you to plan a replacement.
 */
export const TEMPERATURE_WARN_CELSIUS = 60
export const NVME_WEAR_WARN_PERCENT = 90

/** smartctl exit-status bits (smartctl(8), EXIT STATUS). */
export const SMARTCTL_EXIT_BITS = Object.freeze({
  COMMAND_LINE: 1 << 0,
  DEVICE_OPEN_FAILED: 1 << 1,
  SMART_COMMAND_FAILED: 1 << 2,
  DISK_FAILING: 1 << 3,
  PREFAIL_BELOW_THRESHOLD: 1 << 4,
  ATTRIBUTES_BELOW_THRESHOLD_PAST: 1 << 5,
  ERROR_LOG_HAS_ERRORS: 1 << 6,
  SELF_TEST_LOG_HAS_ERRORS: 1 << 7,
})

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Finite, non-negative number or null. */
const nonNegativeNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** A printable, bounded model string — or null. Never a serial number. */
export function sanitizeModel(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.slice(0, 64)
}

/** Raw numeric value of an ATA attribute row, or null when not parseable. */
function attributeRaw(row) {
  if (!isPlainObject(row)) return null
  const raw = row.raw
  if (isPlainObject(raw)) {
    const value = nonNegativeNumber(raw.value)
    if (value !== null) return value
    if (typeof raw.string === 'string') {
      const match = /^\d+/.exec(raw.string.trim())
      if (match) return Number(match[0])
    }
  }
  return null
}

/**
 * Derive the ATA-attribute warnings from `ata_smart_attributes.table`.
 *
 * Only four well-known attribute ids are consulted by number, and `when_failed`
 * is consulted for every row. Vendor-specific attributes are ignored: a raw
 * value with an unknown meaning is not evidence of anything.
 */
function ataWarnings(table) {
  const warnings = new Set()
  if (!Array.isArray(table)) return warnings
  const byId = { 5: 'reallocated-sectors', 187: 'reported-uncorrectable', 197: 'pending-sectors', 198: 'offline-uncorrectable' }

  for (const row of table) {
    if (!isPlainObject(row)) continue
    const code = byId[row.id]
    if (code) {
      const raw = attributeRaw(row)
      if (raw !== null && raw > 0) warnings.add(code)
    }
    if (typeof row.when_failed === 'string') {
      const when = row.when_failed.trim().toLowerCase()
      if (when === 'now') warnings.add('attribute-failing-now')
      else if (when === 'past') warnings.add('attribute-failed-past')
    }
  }
  return warnings
}

/** Derive NVMe warnings from `nvme_smart_health_information_log`. */
function nvmeWarnings(log) {
  const warnings = new Set()
  if (!isPlainObject(log)) return warnings
  const critical = nonNegativeNumber(log.critical_warning)
  if (critical !== null && critical !== 0) warnings.add('nvme-critical-warning')
  const spare = nonNegativeNumber(log.available_spare)
  const spareThreshold = nonNegativeNumber(log.available_spare_threshold)
  if (spare !== null && spareThreshold !== null && spare < spareThreshold) warnings.add('nvme-spare-low')
  const used = nonNegativeNumber(log.percentage_used)
  if (used !== null && used >= NVME_WEAR_WARN_PERCENT) warnings.add('nvme-wear-high')
  return warnings
}

/**
 * Turn parsed `smartctl --json` output into the collector evidence shape.
 *
 * @param {unknown} report parsed JSON from smartctl
 * @param {{ exitStatus?: number }} [options] the process exit status, when known
 * @returns {{ available: true, model: string|null,
 *             smart: { supported: boolean|null, enabled: boolean|null, passed: boolean|null },
 *             temperatureCelsius: number|null, powerOnHours: number|null,
 *             capacityBytes: number|null, warnings: string[] }
 *          | { available: false, reason: string }}
 */
export function evidenceFromSmartctl(report, { exitStatus = 0 } = {}) {
  if (!isPlainObject(report)) return { available: false, reason: 'unsupported-output' }

  const status = Number.isInteger(exitStatus) ? exitStatus : 0
  if (status & SMARTCTL_EXIT_BITS.COMMAND_LINE) return { available: false, reason: 'smartctl-usage-error' }
  if (status & SMARTCTL_EXIT_BITS.DEVICE_OPEN_FAILED) return { available: false, reason: 'device-open-failed' }

  // A report without a device block is not smartctl output for a device.
  if (!isPlainObject(report.device)) return { available: false, reason: 'unsupported-output' }

  const smartSupport = isPlainObject(report.smart_support) ? report.smart_support : null
  const supported = smartSupport && typeof smartSupport.available === 'boolean' ? smartSupport.available : null
  const enabled = smartSupport && typeof smartSupport.enabled === 'boolean' ? smartSupport.enabled : null
  const passed = isPlainObject(report.smart_status) && typeof report.smart_status.passed === 'boolean'
    ? report.smart_status.passed
    : null

  // "SMART not supported" is a real, useful fact — a USB bridge that hides the
  // drive, or a virtual disk. It is unavailable evidence, not a healthy disk.
  if (supported === false) return { available: false, reason: 'smart-unsupported' }
  if (enabled === false) return { available: false, reason: 'smart-disabled' }

  const temperature = isPlainObject(report.temperature) ? nonNegativeNumber(report.temperature.current) : null
  const powerOnHours = isPlainObject(report.power_on_time) ? nonNegativeNumber(report.power_on_time.hours) : null
  const capacityBytes = isPlainObject(report.user_capacity) ? nonNegativeNumber(report.user_capacity.bytes) : null

  const warnings = new Set()
  if (passed === false) warnings.add('smart-failed')
  for (const code of ataWarnings(report.ata_smart_attributes?.table)) warnings.add(code)
  for (const code of nvmeWarnings(report.nvme_smart_health_information_log)) warnings.add(code)
  if (temperature !== null && temperature >= TEMPERATURE_WARN_CELSIUS) warnings.add('temperature-high')
  if (status & SMARTCTL_EXIT_BITS.SMART_COMMAND_FAILED) warnings.add('smartctl-partial-failure')
  // Exit bits 3/4/5 duplicate what the attribute table already says, but the
  // table can be absent (NVMe, or -A not run). The bit is still evidence.
  if (status & SMARTCTL_EXIT_BITS.DISK_FAILING) warnings.add('smart-failed')
  if (status & SMARTCTL_EXIT_BITS.PREFAIL_BELOW_THRESHOLD) warnings.add('attribute-failing-now')
  if (status & SMARTCTL_EXIT_BITS.ATTRIBUTES_BELOW_THRESHOLD_PAST) warnings.add('attribute-failed-past')

  return {
    available: true,
    model: sanitizeModel(report.model_name),
    smart: { supported, enabled, passed },
    temperatureCelsius: temperature,
    powerOnHours,
    capacityBytes,
    // Deterministic order so two collectors reading the same disk agree byte-for-byte.
    warnings: DISK_WARNING_CODES.filter((code) => warnings.has(code)),
  }
}
