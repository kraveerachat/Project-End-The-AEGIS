// src/thermal.js — AEGIS host telemetry agent · host package temperature
//
// The one place in this agent that lists a directory. Everywhere else reads a
// fixed map of absolute paths (see sources.js), because a path the agent did
// not already name is a path it must not open. Thermal zones break that rule
// for one unavoidable reason: the kernel does not guarantee which
// `thermal_zoneN` carries which sensor. On the production host `x86_pkg_temp`
// is zone 1 today; a BIOS update, a kernel upgrade, or a different machine can
// renumber it tomorrow. Hardcoding `thermal_zone1` would not be "safer" — it
// would silently start publishing `acpitz` (a ~28 °C chassis reading) as if it
// were the CPU package, which is precisely the wrong-number-with-authority
// failure this whole telemetry design exists to prevent.
//
// So the discovery is allowed, and then bounded to the smallest surface that
// still works:
//
//   • one fixed root, /sys/class/thermal, never derived from a request or env
//   • only entries matching thermal_zone[0-9]+ — nothing else is even stat'ed
//   • only two files per zone, `type` and `temp`
//   • no symlink following into arbitrary targets, no command execution
//
// Selection is exact and never falls back. If no zone reports `x86_pkg_temp`,
// or its temperature fails validation, the metric is `{ available: false }`.
// It never degrades to acpitz, to the SSD's SMART temperature, to another
// arbitrary zone, or to 0 — each of those would render on the dashboard as a
// real CPU reading and none of them is one.

/** The one directory this module may list. Not configurable, by design. */
export const THERMAL_ROOT = '/sys/class/thermal'

/** The only entry names considered. Anchored: `cooling_device0` never matches. */
export const ZONE_PATTERN = /^thermal_zone[0-9]+$/

/** The exact sensor the Dashboard Temperature represents. No synonyms. */
export const TARGET_SENSOR = 'x86_pkg_temp'

/**
 * Plausibility band for a CPU package reading, in degrees Celsius.
 *
 * Lower bound 1: rejects a negative reading, and also rejects the classic
 * unit mix-up where a raw `56` (already degrees, not millidegrees) would
 * otherwise convert to a confident-looking 0.056 °C.
 *
 * Upper bound 150: comfortably above every x86 package critical trip point
 * (~100 °C), while rejecting malformed millidegree values such as `55000000`,
 * which would convert to 55000 °C and be rendered as a measurement.
 */
export const MIN_CELSIUS = 1
export const MAX_CELSIUS = 150

/** The single unavailable shape. Frozen so no caller can bolt a number on. */
const UNAVAILABLE = Object.freeze({ available: false })

/**
 * The sensor name as reported by a zone's `type` file.
 *
 * Bounded and character-restricted because it is published to Drive and
 * rendered: a value arriving from the kernel is still untrusted input here,
 * and a path- or markup-shaped "sensor name" must never reach a screen.
 *
 * @param {unknown} text raw contents of `<zone>/type`
 * @returns {string | null}
 */
export function parseSensorType(text) {
  if (typeof text !== 'string') return null
  const name = text.trim()
  if (!name || name.length > 32) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null
  return name
}

/**
 * Convert a `temp` file's millidegrees Celsius to degrees Celsius.
 *
 * Validation happens BEFORE the division, so a malformed value can never be
 * quietly scaled into a plausible-looking one. Rejects: empty, non-numeric,
 * NaN, Infinity, negative, and anything outside the plausibility band.
 *
 * @param {unknown} text raw contents of `<zone>/temp`
 * @returns {number | null} degrees Celsius rounded to 0.1, or null
 */
export function celsiusFromMilliDegrees(text) {
  if (typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw) return null
  // Explicit integer shape: Number('') is 0 and Number('12abc') is NaN, but
  // Number('  12 ') is 12 — a regex keeps the accepted set to what the kernel
  // actually writes rather than to whatever Number() tolerates.
  if (!/^-?[0-9]+$/.test(raw)) return null

  const milli = Number(raw)
  if (!Number.isFinite(milli)) return null
  if (milli < 0) return null

  const celsius = milli / 1000
  if (!Number.isFinite(celsius)) return null
  if (celsius < MIN_CELSIUS || celsius > MAX_CELSIUS) return null

  // One decimal: the kernel's millidegree precision is not meaningful for a
  // dashboard, and rounding here keeps float noise out of the published JSON.
  return Math.round(celsius * 10) / 10
}

/**
 * Discover the package temperature by reading only `type` and `temp` per zone.
 *
 * Every dependency that touches the filesystem is injected so the selection
 * logic is testable without a real /sys.
 *
 * @param {object} deps
 * @param {() => Promise<string[]>} deps.readdir lists THERMAL_ROOT
 * @param {(path: string, encoding: string) => Promise<string>} deps.readFile
 *   reads one zone file as text; called with 'utf8' so a real fs.readFile
 *   yields a string rather than a Buffer (a Buffer would fail parseSensorType
 *   and silently make every host look sensorless)
 * @param {string} [deps.root] overridden only by tests
 * @returns {Promise<{ available: true, celsius: number, sensor: string } | { available: false }>}
 */
export async function readHostTemperature({ readdir, readFile, root = THERMAL_ROOT }) {
  let entries
  try {
    entries = await readdir(root)
  } catch {
    return UNAVAILABLE // no /sys/class/thermal at all, or not readable
  }
  if (!Array.isArray(entries)) return UNAVAILABLE

  // Filter first, then read. An entry that is not a numbered thermal zone is
  // never opened — the read surface is defined by the pattern, not by whatever
  // the directory happens to contain.
  const zones = entries.filter((entry) => typeof entry === 'string' && ZONE_PATTERN.test(entry))

  for (const zone of zones) {
    // `type` is read first so a zone that is not the target costs exactly one
    // read and its `temp` is never opened.
    let typeText = null
    try {
      typeText = await readFile(`${root}/${zone}/type`, 'utf8')
    } catch {
      continue // an unreadable zone is skipped, not fatal: another may be the target
    }
    if (parseSensorType(typeText) !== TARGET_SENSOR) continue

    let tempText = null
    try {
      tempText = await readFile(`${root}/${zone}/temp`, 'utf8')
    } catch {
      return UNAVAILABLE // the target zone exists but will not answer
    }

    const celsius = celsiusFromMilliDegrees(tempText)
    if (celsius === null) return UNAVAILABLE // present but not trustworthy

    return { available: true, celsius, sensor: TARGET_SENSOR }
  }

  // No zone reported x86_pkg_temp. Deliberately not "the warmest zone" and not
  // acpitz: an approximate answer here is indistinguishable from a real one.
  return UNAVAILABLE
}
