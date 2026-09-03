// Read-only bridge to the atomic IDEA3 supervisor status file.
//
// The browser never receives the raw file. The operator chooses one server-side
// path, and only the fixed non-secret schema below can cross the API boundary.
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_STATUS_BYTES = 64 * 1024
const DEFAULT_STALE_SECONDS = 30
const MAX_STALE_SECONDS = 3600
const MAX_FUTURE_SKEW_MS = 5_000

const RUNTIME_STATES = new Set([
  'INIT', 'PREFLIGHT', 'WAIT_BROKER', 'WAIT_DEVICE', 'RUNNING',
  'DEGRADED', 'LOCKDOWN', 'FAILED', 'SHUTDOWN',
])
const PROFILES = new Set(['development', 'lab', 'production'])
const CONNECTION_STATES = new Set(['UNKNOWN', 'CONNECTED', 'DISCONNECTED'])
const DEVICE_STATES = new Set(['UNKNOWN', 'ONLINE', 'OFFLINE'])
const UPLINK_STATES = new Set(['UNKNOWN', 'NORMAL', 'LOCKDOWN'])
const ARM_STATES = new Set(['MONITOR_ONLY', 'ARMED'])

const enumValue = (value, allowed) => allowed.has(value) ? value : 'UNKNOWN'

function staleAfterSeconds() {
  const parsed = Number(process.env.AEGIS_IDEA3_STATUS_STALE_SEC)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_STALE_SECONDS)
    : DEFAULT_STALE_SECONDS
}

function emptyStatus({ available = false, reason, updatedAt = null, ageSeconds = null } = {}) {
  return {
    available,
    fresh: false,
    reason,
    state: 'UNKNOWN',
    profile: 'UNKNOWN',
    dryRun: null,
    broker: 'UNKNOWN',
    device: 'UNKNOWN',
    uplink: 'UNKNOWN',
    armed: 'UNKNOWN',
    updatedAt,
    ageSeconds,
  }
}

/**
 * Read and sanitize the atomic status.json written by AEGIS IDEA3.
 * Missing, malformed, oversized, future-dated, or stale input never becomes a
 * current healthy state. The file handle is checked and read as one object to
 * avoid a stat/read path race.
 */
export async function readIdea3Status() {
  const configuredPath = process.env.AEGIS_IDEA3_STATUS_PATH?.trim()
  if (!configuredPath) return emptyStatus({ reason: 'NOT_CONFIGURED' })

  let handle
  try {
    handle = await fs.open(path.resolve(configuredPath), 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STATUS_BYTES) {
      return emptyStatus({ reason: 'INVALID_STATUS_FILE' })
    }

    const parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyStatus({ reason: 'INVALID_STATUS_FILE' })
    }

    const updatedSeconds = Number(parsed.updated_at)
    if (!Number.isFinite(updatedSeconds) || updatedSeconds <= 0) {
      return emptyStatus({ reason: 'INVALID_TIMESTAMP' })
    }

    const updatedAt = Math.trunc(updatedSeconds * 1000)
    const ageMs = Date.now() - updatedAt
    if (ageMs < -MAX_FUTURE_SKEW_MS) {
      return emptyStatus({ reason: 'INVALID_TIMESTAMP' })
    }

    const ageSeconds = Math.max(0, Math.floor(ageMs / 1000))
    if (ageSeconds > staleAfterSeconds()) {
      return emptyStatus({ available: true, reason: 'STALE', updatedAt, ageSeconds })
    }

    return {
      available: true,
      fresh: true,
      reason: null,
      state: enumValue(parsed.state, RUNTIME_STATES),
      profile: enumValue(parsed.profile, PROFILES),
      dryRun: typeof parsed.dry_run === 'boolean' ? parsed.dry_run : null,
      broker: enumValue(parsed.broker, CONNECTION_STATES),
      device: enumValue(parsed.device, DEVICE_STATES),
      uplink: enumValue(parsed.uplink, UPLINK_STATES),
      armed: enumValue(parsed.armed, ARM_STATES),
      updatedAt,
      ageSeconds,
    }
  } catch {
    return emptyStatus({ reason: 'UNAVAILABLE' })
  } finally {
    await handle?.close().catch(() => {})
  }
}
