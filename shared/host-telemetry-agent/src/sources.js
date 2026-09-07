// src/sources.js — AEGIS host telemetry agent · the I/O edge
//
// Almost every byte this agent reads enters through here, from a fixed map of
// absolute paths built by config.js. There is no command execution and no path
// derived from a request: the agent cannot be asked to read something its
// configuration did not already name.
//
// ONE exception, added 2026-09-07 and deliberately kept outside this module:
// CPU package temperature (src/thermal.js) lists /sys/class/thermal, because
// the kernel does not guarantee which thermal_zoneN carries x86_pkg_temp and a
// hardcoded zone number would eventually publish the chassis sensor as the CPU.
// That module does its own bounding — one fixed root, only thermal_zone[0-9]+,
// only the `type` and `temp` files — and still routes each read through an
// injected readFile, so the file surface stays reviewable in one place.
import fspDefault from 'node:fs/promises'

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
