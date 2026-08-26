// server/telemetry/disk.js — AEGIS Drive (IDEA1) · Data Lake disk telemetry
//
// Disk is the one Server Telemetry metric the host agent does NOT collect.
// Drive already has the Data Lake mounted at STORAGE_ROOT, so statfs from
// inside the container is both sufficient and the least-privilege path — it
// needs no host mount, no extra capability, and no second collector.
//
// This module is a projection, not a second implementation. The numbers come
// from the same filesystemCapacity() that /api/storage and /api/dashboard have
// always used, so the Server Telemetry disk tile and the Storage KPI can never
// drift apart. See tests/dataLakeCapacity.test.js for the pinned semantics:
// total from `blocks`, free from `bavail`, used = total - free (root-reserved
// blocks therefore count as used, and used + free == total exactly).
import { filesystemCapacity } from '../storage/fileStore.js'

/** Scope label: this is the Data Lake mount, not "the server's disks". */
export const DISK_SCOPE = 'datalake'

/**
 * Physical drive health is not observable from here and is never guessed.
 *
 * SMART needs raw device access (CAP_SYS_RAWIO) and RAID needs mdadm; the Drive
 * container has neither, and this feature does not add them. Saying so beats
 * showing a reassuring green "Healthy" that nothing measured.
 */
const HEALTH_UNAVAILABLE = Object.freeze({ available: false, reason: 'smart-not-observable' })

/**
 * Current Data Lake capacity, shaped for the telemetry contract.
 *
 * @param {{ capacity?: () => Promise<object|null> }} [deps]
 * @returns {Promise<object>} always resolves; never throws
 */
export async function dataLakeTelemetry({ capacity = filesystemCapacity } = {}) {
  let reading = null
  try {
    reading = await capacity()
  } catch {
    reading = null // an unreadable mount is unknown, not empty
  }

  if (!reading || !Number.isFinite(reading.totalBytes) || reading.totalBytes <= 0) {
    return { available: false, reason: 'capacity-unreadable', scope: DISK_SCOPE, health: HEALTH_UNAVAILABLE }
  }

  return {
    available: true,
    scope: DISK_SCOPE,
    usedBytes: reading.usedBytes,
    freeBytes: reading.freeBytes,
    totalBytes: reading.totalBytes,
    percent: (reading.usedBytes / reading.totalBytes) * 100,
    health: HEALTH_UNAVAILABLE,
  }
}
