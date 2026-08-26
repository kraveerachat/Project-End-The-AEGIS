// src/sources.js — AEGIS host telemetry agent · the I/O edge
//
// Every byte this agent ever reads enters through here, from a fixed map of
// absolute paths built by config.js. There is no command execution, no
// directory listing, and no path derived from a request: the agent cannot be
// asked to read something its configuration did not already name.
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
