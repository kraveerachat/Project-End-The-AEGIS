// src/sources.js — AEGIS host telemetry agent · the I/O edge
//
// Every byte this agent ever reads enters through here. Most sources are a
// fixed map of absolute paths built by config.js. CPU package temperature is
// the one bounded discovery source: it lists only /sys/class/thermal and only
// accepts thermal_zone<N> entries. There is no command execution and no path
// derived from a request.
import fspDefault from 'node:fs/promises'

export const THERMAL_CLASS_ROOT = '/sys/class/thermal'
const THERMAL_ZONE_PATTERN = /^thermal_zone\d+$/
const CPU_PACKAGE_SENSOR = 'x86_pkg_temp'

/**
 * Wrap each configured source path in a reader that yields text or null.
 *
 * Returning null instead of throwing keeps the "unknown is not zero" rule at
 * the boundary where it is cheapest to enforce — a permission or hotplug error
 * degrades exactly one metric for exactly one cycle.
 *
 * @param {Record<string, string>} sources name -> absolute path
 * @param {{ readFile?: Function }} [deps]
 * @returns {Record<string, () => Promise<string|null>>}
 */
export function createFileReaders(sources, { readFile = fspDefault.readFile } = {}) {
  const readers = {}
  for (const [name, filePath] of Object.entries(sources)) {
    readers[name] = async () => {
      try {
        return await readFile(filePath, 'utf8')
      } catch {
        return null
      }
    }
  }
  return readers
}

/**
 * Discover the CPU package thermal zone without relying on a boot-dependent
 * zone number. Only the exact x86_pkg_temp sensor is accepted; ACPI and disk
 * temperatures are different physical measurements and are never fallbacks.
 *
 * @param {{ readdir?: Function, readFile?: Function }} [deps]
 * @returns {() => Promise<{sensor: string, millidegreesCelsius: string}|null>}
 */
export function createCpuPackageTemperatureReader({
  readdir = fspDefault.readdir,
  readFile = fspDefault.readFile,
} = {}) {
  return async () => {
    let entries
    try {
      entries = await readdir(THERMAL_CLASS_ROOT)
    } catch {
      return null
    }

    const zones = entries
      .filter((entry) => typeof entry === 'string' && THERMAL_ZONE_PATTERN.test(entry))
      .sort((a, b) => Number(a.slice('thermal_zone'.length)) - Number(b.slice('thermal_zone'.length)))

    for (const zone of zones) {
      const zoneRoot = `${THERMAL_CLASS_ROOT}/${zone}`
      let type
      try {
        type = await readFile(`${zoneRoot}/type`, 'utf8')
      } catch {
        continue
      }
      if (typeof type !== 'string' || type.trim() !== CPU_PACKAGE_SENSOR) continue

      try {
        const millidegreesCelsius = await readFile(`${zoneRoot}/temp`, 'utf8')
        return { sensor: CPU_PACKAGE_SENSOR, millidegreesCelsius }
      } catch {
        return null
      }
    }
    return null
  }
}
