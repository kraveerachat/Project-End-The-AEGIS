// server/telemetry/diskHealth.js — AEGIS Drive (IDEA1) · physical disk health projection
//
// The Drive container still has no raw-device access and never will under this
// design (see storage/store.js "why smartctl cannot run here"). What changed is
// that a separate, bounded host collector now measures the boot/storage device
// and the unprivileged telemetry agent republishes that evidence on its socket.
// Drive fetches it, validates it as untrusted input, and derives a status.
//
// The projection keeps three things separate: whether evidence exists, how old
// it is, and what it says. A stale PASS renders as UNKNOWN with the last known
// readings still visible — an operator can see "it was fine 3 hours ago, and
// nothing has measured it since", which is exactly the true state.
import { fetchHostDiskHealth } from './client.js'
import { agentSocketPath } from './index.js'
import { DISK_STALE_THRESHOLD_SECONDS, DISK_STATUS, deriveDiskStatus, diskEvidenceAgeSeconds } from './diskHealthSchema.js'

/** Reason attached when the host agent cannot be reached at all. */
export const AGENT_UNREACHABLE = 'agent-unreachable'

/** The one shape for "no evidence". No number rides along. */
function unavailable(reason) {
  return {
    available: false,
    status: DISK_STATUS.UNKNOWN,
    reason,
    stale: false,
    device: null,
    model: null,
    smart: null,
    temperatureCelsius: null,
    powerOnHours: null,
    capacityBytes: null,
    warnings: [],
    measuredAt: null,
    ageSeconds: null,
    maxAgeSeconds: DISK_STALE_THRESHOLD_SECONDS,
  }
}

/**
 * Current physical disk health, shaped for /api/storage.
 *
 * Never throws. Never returns HEALTHY without a fresh, explicit SMART pass.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.fetch] host agent disk-health client
 * @param {number} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export async function hostDiskHealth({ fetch, now = Date.now(), env = process.env } = {}) {
  const read = fetch ?? (() => fetchHostDiskHealth({ socketPath: agentSocketPath(env), now }))
  const result = await read().catch(() => ({ ok: false, reason: AGENT_UNREACHABLE }))
  if (!result?.ok) {
    // Contract failures keep their specific reason; transport failures collapse
    // to one word the UI can explain ("the host agent is not connected").
    const transport = ['unreachable', 'timeout', 'invalid-socket-path', 'malformed-json', 'response-too-large']
    const reason = typeof result?.reason === 'string' && !transport.includes(result.reason) && !result.reason.startsWith('agent-status-')
      ? result.reason
      : AGENT_UNREACHABLE
    return unavailable(reason)
  }

  const { document } = result
  if (document.disk.available !== true) return unavailable(document.disk.reason)

  const ageSeconds = diskEvidenceAgeSeconds(document.measuredAt, now)
  const stale = ageSeconds === null || ageSeconds > DISK_STALE_THRESHOLD_SECONDS
  const { status, reason } = deriveDiskStatus(document.disk, { stale })

  return {
    available: true,
    status,
    reason,
    stale,
    device: document.device,
    model: document.disk.model,
    smart: { ...document.disk.smart },
    temperatureCelsius: document.disk.temperatureCelsius,
    powerOnHours: document.disk.powerOnHours,
    capacityBytes: document.disk.capacityBytes,
    warnings: [...document.disk.warnings],
    measuredAt: document.measuredAt,
    ageSeconds: ageSeconds === null ? null : Math.max(0, Math.round(ageSeconds)),
    maxAgeSeconds: DISK_STALE_THRESHOLD_SECONDS,
  }
}
