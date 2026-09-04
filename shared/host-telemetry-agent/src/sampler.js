// src/sampler.js — AEGIS host telemetry agent · background sampler
//
// Why a sampler at all: CPU and network are rates, and a rate needs two reads
// separated by a real window. Measuring at request time would make every Drive
// telemetry call block for the whole window. Instead this loop runs on its own
// interval and keeps one normalized snapshot in memory; the socket handler
// answers from that snapshot synchronously.
//
// Failure policy, applied per metric and never per snapshot: a source that
// cannot be read or parsed becomes `{ available: false }` with no other keys.
// It never becomes 0. A metric object carrying numbers is therefore always a
// real measurement, which is what the Drive schema and the dashboard rely on.
import { diskHealthFromFileText } from './diskHealth.js'
import { twingateHealthFromFileText } from './twingateHealth.js'
import { cpuPercentFromDelta, networkRateFromDelta, parseMemInfo, parseNetworkCounter, parseProcStat, parseUptime } from './parsers.js'

/** The single unavailable shape. Frozen so no caller can bolt a zero onto it. */
const UNAVAILABLE = Object.freeze({ available: false })

/** Read a source without letting an I/O or permission error escape the cycle. */
async function readOrNull(reader) {
  try {
    const value = await reader()
    return typeof value === 'string' ? value : null
  } catch {
    return null // EACCES / ENOENT / EIO are all "unknown", never "zero"
  }
}

/**
 * Create the background sampler.
 *
 * Every dependency that touches the outside world is injected so the sampler's
 * state machine can be tested without a real /proc or a real five seconds.
 *
 * @param {object} options
 * @param {number} [options.intervalMs] sampling period; ~5s in production
 * @param {string} options.interfaceName the one explicitly configured NIC
 * @param {object} options.readers procStat/memInfo/networkRx/networkTx/uptime
 * @param {() => number} [options.now] epoch milliseconds
 * @param {Function} [options.setTimer] setInterval-compatible
 * @param {Function} [options.clearTimer] clearInterval-compatible
 */
export function createSampler({
  intervalMs = 5000,
  interfaceName,
  readers,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  if (!interfaceName) throw new Error('interfaceName is required')
  if (!readers) throw new Error('readers are required')

  let latest = null       // last published snapshot (null until the first cycle)
  let latestDisk = null   // last disk-health evidence document (separate contract)
  let latestTwingate = null // last local Twingate connector evidence (another contract)
  let previousCpu = null  // last usable /proc/stat counters
  let previousNet = null  // last usable interface counters + their timestamp
  let handle = null

  // Disk health is a separate, versioned contract from the V1 telemetry
  // snapshot. It is read on the same cycle for simplicity, but it is never
  // merged into `latest`: adding a key there would break every Drive that
  // validates the V1 allowlist, in production, on the next poll.
  const diskConfigured = typeof readers.diskHealth === 'function'
  // Local Twingate connector health is a third contract, read on the same cycle
  // and merged into neither of the other two for exactly the same reason.
  const twingateConfigured = typeof readers.twingateHealth === 'function'

  async function sampleOnce() {
    const atMs = now()
    const [statText, memText, rxText, txText, uptimeText, diskText, twingateText] = await Promise.all([
      readOrNull(readers.procStat),
      readOrNull(readers.memInfo),
      readOrNull(readers.networkRx),
      readOrNull(readers.networkTx),
      readOrNull(readers.uptime),
      diskConfigured ? readOrNull(readers.diskHealth) : Promise.resolve(null),
      twingateConfigured ? readOrNull(readers.twingateHealth) : Promise.resolve(null),
    ])

    latestDisk = diskHealthFromFileText(diskText, { now: () => atMs, configured: diskConfigured })
    latestTwingate = twingateHealthFromFileText(twingateText, { now: () => atMs, configured: twingateConfigured })

    // ── CPU ───────────────────────────────────────────────────────────
    // A window is only valid between two *usable* reads, so an unparseable
    // cycle drops the baseline instead of silently widening the next window.
    const currentCpu = parseProcStat(statText)
    const cpuPercent = cpuPercentFromDelta(previousCpu, currentCpu)
    const cpuWindowSeconds = previousCpu && currentCpu ? (atMs - previousCpu.atMs) / 1000 : null
    const cpu = cpuPercent !== null && Number.isFinite(cpuWindowSeconds) && cpuWindowSeconds > 0
      ? { available: true, percent: cpuPercent, windowSeconds: cpuWindowSeconds }
      : UNAVAILABLE
    previousCpu = currentCpu ? { ...currentCpu, atMs } : null

    // ── Memory ────────────────────────────────────────────────────────
    const mem = parseMemInfo(memText)
    const memory = mem
      ? {
        available: true,
        usedBytes: mem.usedBytes,
        totalBytes: mem.totalBytes,
        percent: mem.percent,
      }
      : UNAVAILABLE

    // ── Network ───────────────────────────────────────────────────────
    const rxBytes = parseNetworkCounter(rxText)
    const txBytes = parseNetworkCounter(txText)
    const currentNet = rxBytes !== null && txBytes !== null ? { rxBytes, txBytes, atMs } : null
    const rate = networkRateFromDelta(previousNet, currentNet)
    const network = rate
      ? {
        available: true,
        interface: interfaceName,
        rxBytesPerSec: rate.rxBytesPerSec,
        txBytesPerSec: rate.txBytesPerSec,
        windowSeconds: rate.windowSeconds,
      }
      : UNAVAILABLE
    previousNet = currentNet

    // ── Uptime ────────────────────────────────────────────────────────
    const hostSeconds = parseUptime(uptimeText)
    const uptime = hostSeconds !== null
      ? { available: true, hostSeconds }
      : UNAVAILABLE

    // Timestamped even when every source failed: a fully unavailable snapshot
    // is still evidence, and Drive needs the age to decide staleness.
    latest = {
      schemaVersion: 1,
      measuredAt: new Date(atMs).toISOString(),
      metrics: { cpu, memory, network, uptime },
    }
    return latest
  }

  return {
    /** Latest snapshot, or null before the first cycle completes. Synchronous. */
    snapshot: () => latest,
    /** Latest disk-health evidence document, or null before the first cycle. */
    diskHealth: () => latestDisk,
    /** Latest local Twingate connector evidence, or null before the first cycle. */
    twingateHealth: () => latestTwingate,
    sampleOnce,
    /** Idempotent: a second start while running must not stack timers. */
    start() {
      if (handle !== null) return
      // Kick one cycle immediately so the first snapshot does not wait a full
      // interval; the promise is intentionally not awaited by start().
      void sampleOnce()
      handle = setTimer(() => { void sampleOnce() }, intervalMs)
      if (typeof handle?.unref === 'function') handle.unref()
    },
    /** Idempotent: stopping an already-stopped sampler clears nothing. */
    stop() {
      if (handle === null) return
      clearTimer(handle)
      handle = null
    },
    get intervalMs() { return intervalMs },
  }
}
