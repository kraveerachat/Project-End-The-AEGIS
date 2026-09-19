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

/**
 * @returns {Promise<boolean | { blocked: 'FOLDER_HAS_CHILDREN' } | { busy: true }>}
 *   true = ลบแล้ว · false = ไม่พบ/ถูกกู้ไปแล้ว/ยังไม่หมดอายุ (= ไม่มีอะไรให้ทำ)
 *   blocked = โฟลเดอร์ยังมีแถวลูกอ้างถึง · busy = อีกคำขอกำลังถือล็อกของรายการนี้อยู่
 *
 * ⚠️ busy กับ false ต้องแยกกัน: false แปลว่า "ไม่มีอะไรให้ทำแล้ว" ส่วน busy แปลว่า
 *    "ยังมีอยู่ แต่ตอนนี้แตะไม่ได้" การยุบสองอย่างนี้เป็น false ทำให้ล้างถังนับรายการ
 *    ที่ยังอยู่ว่าหายไปแล้ว แล้วประกาศว่าถังว่างทั้งที่แถวยังอยู่
 */
export async function purgeTrashRecord(file, userId = null) {
  if (!file?.id || file.deletedAt == null) return false
  const ownerId = userId ?? file.ownerId
  if (ownerId == null) return false
  const result = await withTrashFileLock(file.id, async () => {
    // Re-read after taking the lock. A restore that won the race must never have
    // its bytes removed by a purge worker holding a stale candidate snapshot.
    const current = await store.findTrashedFile(file.id, ownerId, { includeExpired: true })
    if (!current || (userId == null && current.purgeAt > Date.now())) return false
    // ⚠️ โฟลเดอร์ที่ยังมีลูกอ้างถึง (แม้ลูกจะอยู่ในถัง) ลบไม่ได้เพราะ FK RESTRICT —
    //    ตรวจ "ก่อน" แตะไบต์ใด ๆ โฟลเดอร์ไม่มีไบต์อยู่แล้ว แต่สัญญาเรื่องลำดับ
    //    (ไบต์ → metadata) ต้องชัดเจนและไม่มีข้อยกเว้นให้ใครสับสนทีหลัง
    if (current.kind === 'folder' && (await store.countReferencingChildren(current.id)) > 0) {
      return { blocked: 'FOLDER_HAS_CHILDREN' }
    }
    await removeRecordBytes(current)
    return store.hardDeleteTrashedFile(current.id, userId)
  })
  return result.acquired ? result.value : { busy: true }
}

/**
 * ล้างถังทั้งใบของผู้ใช้คนเดียว โดยลบ **ลูกก่อนพ่อ** เสมอ
 *
 * ⚠️ ห้ามพึ่งลำดับ deleted_at: ผู้ใช้ทิ้งลูกก่อนพ่อก็จริง แต่การเรียงตามเวลาไม่ใช่
 *    หลักประกันเชิงโครงสร้าง (นาฬิกาเท่ากันได้ การกู้แล้วทิ้งใหม่สลับลำดับได้)
 *    กลยุทธ์นี้คือ "รอบใบไม้": แต่ละรอบลบเฉพาะแถวที่ไม่มีลูกเหลืออ้างถึงแล้ว วนจนกว่า
 *    จะไม่มีอะไรเหลือหรือไม่มีความคืบหน้า — ถ้าหยุดโดยยังมีของค้าง ให้รายงานตามจริง
 *    ไม่ใช่อ้างว่าล้างหมด
 */
export async function emptyTrashForUser(userId) {
  let deletedCount = 0
  let remaining = await store.listTrash(userId, { includeExpired: true })
  // ⚠️ ขอบเขตต้องถูก "ตรึง" ก่อนเริ่มวน — ห้ามผูกกับ remaining.length ที่หดลงทุกครั้งที่
  //    ลบสำเร็จ ขอบเขตแบบหดตัวทำให้โซ่ 4 โหนดหยุดที่ 4→3→2→1 แล้วรอบถัดไปถูกตัดทิ้ง
  //    ทั้งที่รากเพิ่งกลายเป็นใบที่ลบได้ โซ่ลึก N ชั้นต้องการอย่างมาก N รอบ (ใบหลุด
  //    หนึ่งชั้นต่อรอบ) ดังนั้น initial + 1 คือเพดานที่พิสูจน์ได้และไม่มีวันวนไม่รู้จบ
  const maxPasses = remaining.length + 1
  let busyCount = 0
  let blockedCount = 0

  for (let pass = 0; remaining.length > 0 && pass < maxPasses; pass += 1) {
    const before = remaining.length
    const carry = []
    busyCount = 0
    blockedCount = 0
    for (const file of remaining) {
      const outcome = await purgeTrashRecord(file, userId)
      if (outcome === true) { deletedCount += 1; continue }
      // ⚠️ busy = ยังอยู่ ยังต้องนับเป็นของค้าง ไม่ใช่ทิ้งออกจาก remaining เงียบ ๆ
      if (outcome && outcome.busy) { busyCount += 1; carry.push(file); continue }
      if (outcome && outcome.blocked) { blockedCount += 1; carry.push(file); continue }
      // false = ไม่มีอะไรให้ทำแล้ว (ถูกกู้/ลบโดยคำขออื่น) — ไม่ใช่ของค้าง
    }
    remaining = carry
    if (remaining.length === before) break // ไม่มีความคืบหน้าเลย = ค้างจริง ไม่ใช่แค่ยังไม่ถึงคิว
  }

  // ⚠️ ความจริงสุดท้ายมาจากการอ่านถังจริงอีกครั้ง ไม่ใช่จากตัวนับที่สะสมระหว่างทาง —
  //    รายการที่ busy อาจถูกคำขออื่นลบ/กู้ไปแล้ว หรือมีของใหม่ถูกทิ้งเข้ามาระหว่างที่เราวน
  const residual = await store.listTrash(userId, { includeExpired: true })
  return {
    deletedCount,
    blockedCount,
    busyCount,
    remainingCount: residual.length,
  }
}

export async function runTrashAutoPurge({ limit = DEFAULT_BATCH } = {}) {
  const candidates = await store.listExpiredTrash(limit)
  let purged = 0
  let blocked = 0
  for (const file of candidates) {
    const outcome = await purgeTrashRecord(file)
    // ⚠️ พ่อที่ยังมีลูกค้างอยู่ถูก "ข้าม" ไม่ใช่ทำให้ทั้งชุดล้ม — แถวอื่นที่ไม่เกี่ยวกัน
    //    ต้องยังถูกลบตามกำหนด ลูกจะหมดอายุในรอบถัดไปแล้วพ่อจึงหลุดตามในรอบต่อจากนั้น
    if (outcome && outcome.blocked) { blocked += 1; continue }
    if (outcome !== true) continue // false (ไม่มีอะไรให้ทำ) หรือ busy (คำขออื่นถือล็อก) — รอบหน้าค่อยว่ากัน
    purged += 1
    await recordAudit({
      actorLabel: 'system', action: 'FILE_TRASH_AUTO_PURGE',
      targetHash: sha256Hex(file.name), result: 'OK', sourceIp: null,
    })
  }
  return { examined: candidates.length, purged, blocked }
}

let timer = null
export function scheduleTrashAutoPurge(run = runTrashAutoPurge) {
  if (timer) return timer
  timer = setInterval(() => {
    run().catch((error) => {
      console.error('[aegis-drive] trash auto-purge failed:', error.message)
    })
  }, HOUR_MS)
  timer.unref?.()
  return timer
}

export const trashCleanupConfig = Object.freeze({ HOUR_MS, DEFAULT_BATCH })
