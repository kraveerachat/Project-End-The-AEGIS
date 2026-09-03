// server/storage/trashCleanup.js — crash-tolerant Protected Trash byte purge
//
// Bytes are removed before metadata. removeKey is idempotent, so a process crash
// between those steps leaves a discoverable trash row that the next pass safely
// finishes instead of an active row pointing at missing bytes.
import { usingPostgres, withAdvisoryLock, recordAudit, sha256Hex } from '../db/connection.js'
import * as store from '../db/store.js'
import { removeKey } from './fileStore.js'

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_BATCH = 25
const TRASH_LOCK_NAMESPACE = 0x54524153 // "TRAS"
const memoryLocks = new Set()

async function removeRecordBytes(file) {
  const versions = file.type === 'Folder' ? [] : await store.listFileVersions(file.id)
  if (file.type !== 'Folder') await removeKey(file.path)
  for (const version of versions) await removeKey(version.storageKey)
}

export async function withTrashFileLock(fileId, work) {
  if (usingPostgres) {
    const id = Number(fileId)
    if (!Number.isSafeInteger(id)) return { acquired: false, value: null }
    return withAdvisoryLock(TRASH_LOCK_NAMESPACE, id, work)
  }
  const key = String(fileId)
  if (memoryLocks.has(key)) return { acquired: false, value: null }
  memoryLocks.add(key)
  try { return { acquired: true, value: await work() } } finally { memoryLocks.delete(key) }
}

export async function purgeTrashRecord(file, userId = null) {
  if (!file?.id || file.deletedAt == null) return false
  const ownerId = userId ?? file.ownerId
  if (ownerId == null) return false
  const result = await withTrashFileLock(file.id, async () => {
    // Re-read after taking the lock. A restore that won the race must never have
    // its bytes removed by a purge worker holding a stale candidate snapshot.
    const current = await store.findTrashedFile(file.id, ownerId, { includeExpired: true })
    if (!current || (userId == null && current.purgeAt > Date.now())) return false
    await removeRecordBytes(current)
    return store.hardDeleteTrashedFile(current.id, userId)
  })
  return result.acquired ? result.value : false
}

export async function runTrashAutoPurge({ limit = DEFAULT_BATCH } = {}) {
  const candidates = await store.listExpiredTrash(limit)
  let purged = 0
  for (const file of candidates) {
    if (!(await purgeTrashRecord(file))) continue
    purged += 1
    await recordAudit({
      actorLabel: 'system', action: 'FILE_TRASH_AUTO_PURGE',
      targetHash: sha256Hex(file.name), result: 'OK', sourceIp: null,
    })
  }
  return { examined: candidates.length, purged }
}

let timer = null
export function scheduleTrashAutoPurge() {
  if (timer) return timer
  timer = setInterval(() => {
    runTrashAutoPurge().catch((error) => {
      console.error('[aegis-drive] trash auto-purge failed:', error.message)
    })
  }, HOUR_MS)
  timer.unref?.()
  return timer
}

export const trashCleanupConfig = Object.freeze({ HOUR_MS, DEFAULT_BATCH })
