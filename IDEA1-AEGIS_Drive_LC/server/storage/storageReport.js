// server/storage/storageReport.js — AEGIS Drive (IDEA1) · the /api/storage document
//
// One place assembles the Storage & Backup page's data from its three sources,
// each with a different trust level and kept visibly separate:
//
//   Drive local   capacity (statfs on the mount Drive has) and usage by kind
//                 (sums over its own tables) — store.storageStatus(), unchanged
//                 and production-verified.
//   host agent    physical disk health — evidence from the bounded collector,
//                 validated by Drive, status derived here (telemetry/diskHealth.js).
//   backup agent  backup state, job history, risk — validated, derived
//                 (backup/derive.js).
//   static        RAID: no array exists in this deployment. Declared, not measured.
//
// `unavailable` keeps the same keys it always had so the screen's honest
// "not measurable, and why" rendering keeps working; a key is present only
// while its source is actually unavailable and carries the current reason.
import * as store from '../db/store.js'
import { hostDiskHealth } from '../telemetry/diskHealth.js'
import { backupReport } from '../backup/index.js'
import { STORAGE_ROOT } from './fileStore.js'
import { TRANSFER_LIMITS, reserveBytesFor } from '../config/transferLimits.js'

/** RAID: not configured. There is no array to read, and nothing is guessed. */
export const RAID_NOT_CONFIGURED = Object.freeze({
  available: false,
  status: 'NOT_CONFIGURED',
  reason: 'no-array-configured',
})

/**
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.storageStatus]
 * @param {() => Promise<object>} [deps.diskHealth]
 * @param {() => Promise<object>} [deps.backup]
 * @param {() => object} [deps.maintenance] sanitized freeze snapshot
 * @param {string} [deps.storageRoot] configured mount root (authenticated UI only)
 * @param {(totalBytes: number) => number} [deps.reserveFor] upload reserve rule
 */
export async function buildStorageReport({
  storageStatus = store.storageStatus,
  diskHealth = hostDiskHealth,
  backup = backupReport,
  maintenance = () => null,
  storageRoot = STORAGE_ROOT,
  reserveFor = (totalBytes) => reserveBytesFor(totalBytes, TRANSFER_LIMITS),
} = {}) {
  const [base, disk, backupState] = await Promise.all([
    storageStatus(),
    diskHealth().catch(() => ({ available: false, status: 'UNKNOWN', reason: 'agent-unreachable' })),
    backup().catch(() => ({ available: false, state: 'UNKNOWN', risk: 'UNKNOWN', reason: 'agent-unreachable' })),
  ])

  const unavailable = { raid: 'not-configured' }
  if (!disk.available) unavailable.diskHealth = disk.reason
  if (!backupState.available) unavailable.backups = backupState.reason
  else if (backupState.state !== 'READY' && backupState.state !== 'RUNNING') unavailable.backups = 'not-configured'

  const reserveBytes = base.capacityBytes ? reserveFor(base.capacityBytes.totalBytes) : null

  return {
    capacityBytes: base.capacityBytes,
    storage: {
      root: storageRoot,
      reserveBytes,
      usableBytes: base.capacityBytes ? Math.max(0, base.capacityBytes.freeBytes - reserveBytes) : null,
    },
    usage: base.usage,
    unaccountedBytes: base.unaccountedBytes,
    diskHealth: disk,
    raid: { ...RAID_NOT_CONFIGURED },
    backup: backupState,
    maintenance: maintenance(),
    unavailable,
  }
}
