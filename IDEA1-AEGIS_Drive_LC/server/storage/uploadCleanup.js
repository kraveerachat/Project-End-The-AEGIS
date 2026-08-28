// server/storage/uploadCleanup.js — AEGIS Drive (IDEA1) · เก็บกวาดการอัปโหลดที่ถูกทิ้ง
//
// การอัปโหลดที่ผู้ใช้เปิดค้างไว้แล้วไม่กลับมาทำต่อ (ปิดแท็บ, เปลี่ยนใจ, เครื่องดับ)
// ทิ้งไบต์ไว้ใน .staging/uploads/ ถ้าไม่มีใครเก็บกวาด พื้นที่จะถูกกินไปเรื่อย ๆ โดยที่
// ไม่มีจอไหนแสดงมันเลย — เป็นพื้นที่ที่ "หายไป" ในสายตาทั้งผู้ใช้และผู้ดูแล
//
// ⚠️ กฎเหล็กสองข้อของงานเก็บกวาดนี้ (มีชุดทดสอบตรึงไว้ทั้งคู่):
//    1. **แตะได้เฉพาะ session ที่ยังไม่ commit และหมดอายุแล้วเท่านั้น** — ไฟล์ที่
//       commit สำเร็จคือข้อมูลของผู้ใช้จริง ไม่ใช่ของชั่วคราว
//    2. **ไม่แตะ uploads/ และ versions/ เลยแม้แต่ไบต์เดียว** — ขอบเขตของมันคือ
//       โฟลเดอร์ .staging/uploads/<id>/ ที่ id ตรงรูปแบบเท่านั้น
//
// ⚠️ ของกำพร้าฝั่งดิสก์ถูกเก็บกวาดด้วย โดยเทียบกับ "รายการ id ที่ยังมีแถวอยู่จริง"
//    ไม่ใช่ด้วยเวลาแก้ไขไฟล์ — โฟลเดอร์ที่ไม่มีแถวอ้างถึงคือของที่ไม่มีทางทำต่อได้อีก
//    (แถวหายไปเพราะบัญชีถูกลบ → ON DELETE CASCADE, หรือ commit ที่ล้มกลางคัน)
import * as store from '../db/store.js'
import { listOrphanStagedSessions, removeStagedSession } from './uploadStaging.js'

/**
 * เก็บกวาดหนึ่งรอบ — ปลอดภัยที่จะเรียกซ้ำและเรียกพร้อมกันกับการอัปโหลดที่ทำงานอยู่
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ expired: number, orphans: number }>} จำนวนที่เก็บกวาดไปจริง
 */
export async function cleanupAbandonedUploads({ now = Date.now() } = {}) {
  let expired = 0
  for (const session of await store.listExpiredUploadSessions(now)) {
    await removeStagedSession(session.uploadId)
    // deleteUploadSessionUnscoped มีเงื่อนไข status <> 'committed' อยู่ใน SQL เอง —
    // ถึงรายการด้านบนจะผิดพลาด แถวที่ commit แล้วก็ยังลบไม่ได้อยู่ดี (ป้องกันสองชั้น)
    if (await store.deleteUploadSessionUnscoped(session.uploadId)) expired += 1
  }

  const liveIds = new Set(await store.listAllUploadSessionIds())
  let orphans = 0
  for (const uploadId of await listOrphanStagedSessions(liveIds)) {
    await removeStagedSession(uploadId)
    orphans += 1
  }

  return { expired, orphans }
}

/**
 * ตั้งรอบเก็บกวาดของโปรเซสที่เปิดพอร์ต — ไม่ใช้ในชุดทดสอบ (เทสต์เรียกรอบเดียวตรง ๆ)
 * ⚠️ unref() เพื่อไม่ให้ timer กันโปรเซสไม่ให้ปิด และ error ถูกกลืนโดยเจตนา:
 *    งานเก็บกวาดที่ล้มเหลวหนึ่งรอบต้องไม่ทำให้ทั้งเซิร์ฟเวอร์ล้ม รอบถัดไปลองใหม่เอง
 */
export function scheduleUploadCleanup({ intervalMs = 60 * 60 * 1000 } = {}) {
  const run = () => {
    cleanupAbandonedUploads().catch((err) => {
      console.error('[aegis-drive] upload cleanup failed:', err.message)
    })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return timer
}
