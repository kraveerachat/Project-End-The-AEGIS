// server/storage/vaultUploadCleanup.js — AEGIS Drive (IDEA1) · เก็บกวาด Vault V2 ที่ถูกทิ้ง
//
// เหตุผลเดียวกับ uploadCleanup.js ของ Normal Files: session ที่ผู้ใช้เปิดค้างแล้วไม่กลับมา
// (ปิดแท็บ, กดล็อกกลางคัน, เครื่องดับ) ทิ้ง ciphertext ไว้ใน .staging/vault/ ถ้าไม่มีใคร
// เก็บกวาด พื้นที่จะถูกกินไปเรื่อย ๆ โดยไม่มีจอไหนแสดงมันเลย
//
// ⚠️ กฎเหล็กสองข้อ (มีชุดทดสอบตรึงไว้ทั้งคู่):
//    1. แตะได้เฉพาะ session ที่ยังไม่ commit และหมดอายุแล้ว — 'committing' ไม่อยู่ใน
//       allow-list เพราะนั่นคือ commit ที่กำลังอ่านไบต์ชุดนั้นอยู่ (งานของ
//       vaultCommitRecovery.js ต่างหาก)
//    2. ไม่แตะ vault/ เลยแม้แต่ไบต์เดียว — ขอบเขตคือ .staging/vault/<id>/ ที่ id ตรง
//       รูปแบบเท่านั้น ciphertext ที่เผยแพร่แล้วเป็นข้อมูลของผู้ใช้ ไม่ใช่ของชั่วคราว
//
// ⚠️ แยกไฟล์จาก uploadCleanup.js ไม่ใช่เพื่อความเป็นระเบียบ: ถ้ารวมกัน งานเก็บกวาดของ
//    Normal Files จะมีเส้นทางที่เดินเข้าไปในโฟลเดอร์ของ Vault ได้ ซึ่งเป็นสิ่งที่ไม่ควร
//    มีอยู่เลยแม้จะเขียนถูกในวันนี้
import * as v2 from '../db/vaultV2Store.js'
import { listOrphanStagedVaultSessions, removeStagedVaultSession } from './vaultStaging.js'

/**
 * เก็บกวาดหนึ่งรอบ — ปลอดภัยที่จะเรียกซ้ำและเรียกพร้อมกันกับการอัปโหลดที่ทำงานอยู่
 * @returns {Promise<{ expired: number, orphans: number }>}
 */
export async function cleanupAbandonedVaultUploads({ now = Date.now() } = {}) {
  let expired = 0
  for (const session of await v2.listExpiredVaultV2Sessions(now)) {
    await removeStagedVaultSession(session.uploadId)
    // allow-list ของสถานะอยู่ใน SQL ของ deleteVaultV2SessionUnscoped ด้วย —
    // ถึงรายการด้านบนจะผิดพลาด แถวที่ commit แล้วก็ยังลบไม่ได้อยู่ดี (ป้องกันสองชั้น)
    if (await v2.deleteVaultV2SessionUnscoped(session.uploadId)) expired += 1
  }

  const liveIds = new Set(await v2.listAllVaultV2SessionIds())
  let orphans = 0
  for (const uploadId of await listOrphanStagedVaultSessions(liveIds)) {
    await removeStagedVaultSession(uploadId)
    orphans += 1
  }

  return { expired, orphans }
}

/** ตั้งรอบเก็บกวาดของโปรเซสที่เปิดพอร์ต — error ถูกกลืน รอบถัดไปลองใหม่เอง */
export function scheduleVaultUploadCleanup({ intervalMs = 60 * 60 * 1000 } = {}) {
  const run = () => {
    cleanupAbandonedVaultUploads().catch((err) => {
      console.error('[aegis-drive] vault upload cleanup failed:', err.message)
    })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return timer
}
