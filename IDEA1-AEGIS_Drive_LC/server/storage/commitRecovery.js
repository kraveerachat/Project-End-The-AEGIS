// server/storage/commitRecovery.js — AEGIS Drive (IDEA1) · กู้คืน commit ที่โปรเซสตายกลางคัน
//
// ⚠️ ปัญหาที่ไฟล์นี้แก้ (merge blocker ของ LFT-V2-A):
//    การ commit จองสิทธิ์ด้วยสถานะ 'committing' แล้วงานเก็บกวาดกับปุ่มยกเลิกก็ถูกสั่งให้
//    "ห้ามแตะ" สถานะนั้น — ซึ่งถูกต้องขณะที่ commit ยังทำงานอยู่ แต่ถ้า **โปรเซสตาย**
//    ระหว่างนั้น จะไม่มีใครพา session ออกจากสถานะนี้ได้อีกเลย: ผู้ใช้ commit ซ้ำไม่ได้
//    (สถานะไม่ใช่ open) ยกเลิกไม่ได้ และเก็บกวาดไม่ได้ = ค้างถาวร ขัดกับเป้าหมาย
//    "ทนต่อ restart" ของ LFT-V2-A เอง
//
// ── เจตนาแยกจากงานเก็บกวาดอย่างชัดเจน ────────────────────────────────────────
//    uploadCleanup.js  = session ที่ "ผู้ใช้ทิ้ง" — สถานะ open/aborted และเลย expires_at
//    commitRecovery.js = commit ที่ "โปรเซสของมันตาย" — สถานะ committing และเลยสัญญาเช่า
//    เงื่อนไข status ของสองงานนี้ไม่ทับกันเลย จึงไม่มีทางแตะงานของกันและกัน
//    และไฟล์นี้ **ไม่ลบอะไรแบบ recursive** เลย — มันย้ายไบต์กลับ หรือปล่อยไว้เฉย ๆ
//
// ── สถานะปลายทางที่รับได้หลังกู้คืน (ต้องบรรจบเป็นหนึ่งในสามเสมอ) ─────────────
//    OPEN      ไบต์ที่พักไว้ครบ → commit ใหม่ได้อย่างปลอดภัย
//    COMMITTED metadata กับไบต์ปลายทางตรงกันจริง
//    ABORTED   พิสูจน์แล้วว่าไปต่อไม่ได้ และไม่มี metadata ชี้ไปยังไบต์ที่หายไป
//
// ── ทำไมเคส "ตายหลังเขียน metadata แต่ก่อนตั้ง committed" ไม่อยู่ในรายการ ────
//    เพราะมันเกิดไม่ได้: finishUploadCommit() เขียนแถว files, บันทึก committed_file_id
//    และตั้ง status='committed' ใน **transaction เดียวกัน** แถวที่ยัง committing จึง
//    แปลว่า metadata ยังไม่ถูกเขียนแน่นอน — ข้อสรุปนี้มาจากโครงสร้าง ไม่ใช่การเดา
//    (งานกู้คืนยังตรวจซ้ำด้วย findFileByStorageKey เพื่อไม่ให้ต้องเชื่อคำอธิบายนี้ลอย ๆ)
import { TRANSFER_LIMITS } from '../config/transferLimits.js'
import * as store from '../db/store.js'
import { finalKeyExists, restoreStagedPart, stagedPartSize } from './uploadStaging.js'

/**
 * กู้คืนหนึ่งรอบ — วนจนไม่เหลือ session ที่เลยสัญญาเช่า
 *
 * ⚠️ ปลอดภัยที่จะเรียกซ้ำ (idempotent): รอบที่สองไม่เจอแถวที่สถานะ committing แล้ว
 *    จึงไม่ทำอะไรเลย และปลอดภัยที่จะเรียกพร้อมกันหลายตัว (FOR UPDATE SKIP LOCKED
 *    ในชั้น SQL ทำให้หนึ่งแถวมีผู้กู้ได้เพียงรายเดียว)
 *
 * @param {{ leaseMs?: number, maxPasses?: number }} [options]
 * @returns {Promise<{ reopened: number, committed: number, aborted: number, scanned: number }>}
 */
export async function recoverStaleCommits({
  leaseMs = TRANSFER_LIMITS.commitLeaseMs,
  maxPasses = 200,
} = {}) {
  const tally = { reopened: 0, committed: 0, aborted: 0, scanned: 0 }

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const outcome = await store.withStaleCommitLease(leaseMs, async (session, ctx) => {
      tally.scanned += 1
      return recoverOne(session, ctx)
    })
    if (outcome === null) break // ไม่มีแถวที่ต้องกู้แล้ว
    tally[outcome] += 1
  }

  return tally
}

/**
 * ตัดสินสถานะปลายทางของ session หนึ่งอัน จาก "สิ่งที่อยู่บนดิสก์และในตารางจริง"
 * ⚠️ ไม่เดาจากเวลา ไม่เดาจากลำดับ — อ่านสถานะจริงทุกครั้ง
 * @returns {Promise<'reopened'|'committed'|'aborted'>}
 */
async function recoverOne(session, ctx) {
  const key = session.commitStorageKey

  // ── (ก) ไม่มี commit intent บันทึกไว้เลย ────────────────────────────────────
  // แถวจากรุ่นก่อนหน้าที่ commit ค้างไว้ก่อนอัปเกรด — ตัดสินจากไบต์ที่พักไว้อย่างเดียว
  if (!key) {
    return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
  }

  // ── (ข) มีแถวใน files ชี้ไปยัง key ปลายทางแล้วหรือยัง ──────────────────────
  // ตามการออกแบบต้องไม่มีทางเป็นจริง (metadata กับ status อยู่ใน transaction เดียว)
  // แต่ตรวจไว้เพราะการกู้คืนที่ตัดสินผิดด้านนี้จะสร้างไฟล์ซ้ำ — ราคาแพงกว่าการตรวจมาก
  const published = await ctx.findFileByStorageKey(key)
  if (published) {
    // ไบต์ต้องมีอยู่จริงด้วย ไม่งั้นเราจะกำลังยืนยัน metadata ที่ชี้ไปยังของที่หายไป
    if (await finalKeyExists(key)) {
      await ctx.markCommitted(published.id)
      return 'committed'
    }
    // metadata มี แต่ไบต์หาย — ไม่แตะแถว files (ไม่ใช่หน้าที่ของงานกู้คืน) และไม่
    // ประกาศว่าสำเร็จ ปิด session อย่างซื่อสัตย์แล้วให้เส้นทางตรวจ integrity รายงานต่อ
    return abort(ctx)
  }

  // ── (ค) ไบต์ถูก rename ไปที่ key ปลายทางแล้ว แต่ metadata ยังไม่ถูกเขียน ───
  // ย้ายกลับมาเป็นไฟล์ที่พักไว้ แล้วเปิด session ให้ commit ใหม่ได้ — ไม่ต้องอัปโหลดซ้ำ
  if (await finalKeyExists(key)) {
    if (await restoreStagedPart(session.uploadId, key)) {
      return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
    }
    // ย้ายกลับไม่ได้ = ไบต์ชุดนั้นเชื่อถือไม่ได้แล้ว ไม่มี metadata ชี้ถึงมันอยู่แล้ว
    return abort(ctx)
  }

  // ── (ง) ยังไม่ถึงขั้น rename — ไบต์ควรยังอยู่ในพื้นที่พัก ──────────────────
  return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
}

/** ไบต์ที่พักไว้ยังครบตามขนาดที่ประกาศไว้ไหม — เงื่อนไขเดียวที่ทำให้ commit ใหม่ได้ */
async function stagedBytesUsable(session) {
  const size = await stagedPartSize(session.uploadId)
  return size === session.logicalSize
}

async function reopen(ctx) { await ctx.reopen(); return 'reopened' }
async function abort(ctx) { await ctx.abort(); return 'aborted' }

/**
 * ตั้งรอบกู้คืนของโปรเซสที่เปิดพอร์ต — ไม่ใช้ในชุดทดสอบ (เทสต์เรียกรอบเดียวตรง ๆ)
 * ⚠️ unref() เพื่อไม่ให้ timer กันโปรเซสไม่ให้ปิด และ error ถูกกลืนโดยเจตนา:
 *    งานกู้คืนที่ล้มหนึ่งรอบต้องไม่ทำให้เซิร์ฟเวอร์ล้ม รอบถัดไปลองใหม่เอง
 */
export function scheduleCommitRecovery({ intervalMs = 5 * 60 * 1000 } = {}) {
  const run = () => {
    recoverStaleCommits().catch((err) => {
      console.error('[aegis-drive] commit recovery failed:', err.message)
    })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return timer
}
