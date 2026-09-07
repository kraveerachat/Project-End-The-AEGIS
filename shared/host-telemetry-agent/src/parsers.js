// src/parsers.js — AEGIS host telemetry agent · pure parsers
//
// Everything here is a total function over a string: no filesystem, no clock,
// no process state. That separation is what lets the sampler be tested without
// a real /proc, and it keeps the blast radius of a malformed kernel line to a
// single `null` instead of a crashed agent.
//
// The shared refusal contract: an unparseable or nonsensical source returns
// `null`, never 0. A zero here would be indistinguishable from "the host is
// idle", and the whole point of this agent is that unavailable stays visible.

/** Finite, non-negative number or null — the only accepted numeric shape. */
const nonNegative = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null

/**
 * Parse the aggregate `cpu` row of /proc/stat into cumulative jiffie counters.
 *
 * Only the first eight fields are summed (user, nice, system, idle, iowait,
 * irq, softirq, steal). guest and guest_nice are excluded on purpose: the
 * kernel already counts them inside user and nice, so adding them would inflate
 * the denominator and understate CPU usage on virtualised hosts.
 *
 * @param {string} text raw /proc/stat contents
 * @returns {{ idleJiffies: number, totalJiffies: number } | null}
 */
export function parseProcStat(text) {
  if (typeof text !== 'string') return null
  const row = text.split('\n').find((line) => /^cpu\s/.test(line))
  if (!row) return null

  const fields = row.trim().split(/\s+/).slice(1, 9).map(Number)
  if (fields.length < 5) return null // need at least through iowait
  if (fields.some((value) => nonNegative(value) === null)) return null

  const idle = fields[3] + fields[4] // idle + iowait
  const total = fields.reduce((sum, value) => sum + value, 0)
  if (nonNegative(idle) === null || nonNegative(total) === null) return null

  return { idleJiffies: idle, totalJiffies: total }
}

/**
 * CPU busy percentage across the window between two /proc/stat samples.
 *
 * A zero or negative total delta means the window is not measurable (identical
 * samples, or a counter reset after a reboot/rollover). That returns null: the
 * caller must report CPU as unavailable rather than publish a fabricated 0%.
 *
 * The 0..100 clamp applies only to an otherwise valid window — idle can move by
 * a jiffie against total because the fields are not read atomically.
 *
 * @param {{ idleJiffies: number, totalJiffies: number } | null} previous
 * @param {{ idleJiffies: number, totalJiffies: number } | null} next
 * @returns {number | null} percent in 0..100, or null when not measurable
 */
export function cpuPercentFromDelta(previous, next) {
  if (!previous || !next) return null

  const totalDelta = Number(next.totalJiffies) - Number(previous.totalJiffies)
  const idleDelta = Number(next.idleJiffies) - Number(previous.idleJiffies)
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta)) return null
  if (totalDelta <= 0) return null

  const percent = ((totalDelta - idleDelta) / totalDelta) * 100
  if (!Number.isFinite(percent)) return null
  return Math.min(100, Math.max(0, percent))
}

/** /proc/meminfo reports kibibytes; the whole contract downstream is bytes. */
const KIB = 1024

/**
 * Parse /proc/meminfo into the memory shape the agent publishes.
 *
 * MemAvailable is the kernel's own estimate of what a new allocation could
 * actually get, which is why it is required rather than MemFree: MemFree
 * excludes reclaimable page cache and would make every healthy host look
 * nearly out of memory.
 *
 * used = total - available, so `used` includes cache the kernel would have to
 * evict. The invariant 0 <= used <= total is asserted, not assumed.
 *
 * @param {string} text raw /proc/meminfo contents
 * @returns {{ totalBytes: number, availableBytes: number, usedBytes: number,
 *             percent: number } | null}
 */
export function parseMemInfo(text) {
  if (typeof text !== 'string') return null

  // Scanned line by line rather than with a built regex: the key name is the
  // only variable part, and a literal comparison cannot be tricked by a name
  // that happens to contain regex metacharacters.
  const lines = text.split('\n')
  const field = (name) => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}:`))
    if (!line) return null
    const rest = line.slice(name.length + 1).trim()
    const match = /^(-?\d+)\s*kB$/.exec(rest)
    if (!match) return null
    return nonNegative(Number(match[1]) * KIB)
  }

  const totalBytes = field('MemTotal')
  const availableBytes = field('MemAvailable')
  if (totalBytes === null || availableBytes === null) return null
  if (totalBytes <= 0) return null // a zero-sized host is not a measurement
  if (availableBytes > totalBytes) return null

  const usedBytes = totalBytes - availableBytes
  const percent = (usedBytes / totalBytes) * 100
  if (!Number.isFinite(percent)) return null

  return { totalBytes, availableBytes, usedBytes, percent }
}

/**
 * Parse one /sys/class/net/<iface>/statistics/<counter> file.
 *
 * These are monotonically increasing unsigned integers; anything else means the
 * configured interface is wrong or the file was truncated mid-read.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseNetworkCounter(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return nonNegative(Number(trimmed))
}

/**
 * Bytes-per-second across the window between two interface counter samples.
 *
 * A negative byte delta means the counter reset (interface down/up, or a 32-bit
 * rollover) and a non-positive time delta means there is no window at all.
 * Both return null so the sampler reports network as unavailable instead of
 * publishing a fabricated 0 B/s, which reads as "the link is idle".
 *
 * @param {{ rxBytes: number, txBytes: number, atMs: number } | null} previous
 * @param {{ rxBytes: number, txBytes: number, atMs: number } | null} next
 * @returns {{ rxBytesPerSec: number, txBytesPerSec: number,
 *             windowSeconds: number } | null}
 */
export function networkRateFromDelta(previous, next) {
  if (!previous || !next) return null

  const windowSeconds = (Number(next.atMs) - Number(previous.atMs)) / 1000
  const rxDelta = Number(next.rxBytes) - Number(previous.rxBytes)
  const txDelta = Number(next.txBytes) - Number(previous.txBytes)
  if (![windowSeconds, rxDelta, txDelta].every(Number.isFinite)) return null
  if (windowSeconds <= 0) return null
  if (rxDelta < 0 || txDelta < 0) return null

  const rxBytesPerSec = rxDelta / windowSeconds
  const txBytesPerSec = txDelta / windowSeconds
  if (!Number.isFinite(rxBytesPerSec) || !Number.isFinite(txBytesPerSec)) return null

  return { rxBytesPerSec, txBytesPerSec, windowSeconds }
}

/**
 * Parse the first field of /proc/uptime — seconds since boot.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseUptime(text) {
  if (typeof text !== 'string') return null
  const first = text.trim().split(/\s+/)[0]
  if (!/^\d+(\.\d+)?$/.test(first ?? '')) return null
  return nonNegative(Number(first))
}
