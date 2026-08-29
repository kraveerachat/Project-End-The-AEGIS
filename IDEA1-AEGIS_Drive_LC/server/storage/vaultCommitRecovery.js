// server/storage/vaultCommitRecovery.js — AEGIS Drive (IDEA1) · กู้คืน commit ของ Vault V2
//
// ⚠️ บทเรียนของ LFT-V2-A ถูกนำมาใช้ "ตั้งแต่ต้น" ที่นี่ ไม่ใช่เป็น follow-up:
//    การ commit จองสิทธิ์ด้วยสถานะ 'committing' ซึ่งทั้งงานเก็บกวาดและปุ่มยกเลิกถูกสั่ง
//    ห้ามแตะ — ถูกต้องขณะที่ commit ยังทำงาน และผิดทันทีที่โปรเซสของมันตาย ถ้าไม่มี
//    สัญญาเช่ากับงานกู้คืน session จะค้างถาวร: commit ซ้ำไม่ได้ ยกเลิกไม่ได้ เก็บกวาดไม่ได้
//
// ── เจตนาแยกจากงานเก็บกวาดอย่างชัดเจน ────────────────────────────────────────
//    vaultUploadCleanup.js  = session ที่ "ผู้ใช้ทิ้ง" — open/aborted และเลย expires_at
//    vaultCommitRecovery.js = commit ที่ "โปรเซสของมันตาย" — committing และเลยสัญญาเช่า
//    เงื่อนไข status ของสองงานนี้ไม่ทับกันเลย และไฟล์นี้ไม่ลบอะไรแบบ recursive
//
// ── สถานะปลายทางที่รับได้หลังกู้คืน (ต้องบรรจบเป็นหนึ่งในสามเสมอ) ─────────────
//    OPEN      ciphertext ที่พักไว้ครบ → commit ใหม่ได้อย่างปลอดภัย
//    COMMITTED metadata กับไบต์ปลายทางตรงกันจริง
//    ABORTED   พิสูจน์แล้วว่าไปต่อไม่ได้ และไม่มี metadata ชี้ไปยังไบต์ที่หายไป
//
// ⚠️ ไม่มีสถานะ 'recovering' โดยเจตนา — มันจะสร้างปัญหา "แถวค้างที่ไม่มีใครกู้" ซ้ำอีก
//    ชั้นหนึ่ง ส่วน row lock หลุดเองเมื่อ connection ของ worker ที่ตายขาดไป
import { VAULT_TRANSFER_LIMITS } from '../config/vaultTransferLimits.js'
import * as v2 from '../db/vaultV2Store.js'
import { finalVaultKeyExists, restoreStagedVaultPart, stagedVaultPartSize } from './vaultStaging.js'

/**
 * กู้คืนหนึ่งรอบ — วนจนไม่เหลือ session ที่เลยสัญญาเช่า
 * ⚠️ เรียกซ้ำได้ (idempotent) และเรียกพร้อมกันหลายตัวได้ (FOR UPDATE SKIP LOCKED
 *    ในชั้น SQL ทำให้หนึ่งแถวมีผู้กู้ได้เพียงรายเดียว)
 * @returns {Promise<{ reopened: number, committed: number, aborted: number, scanned: number }>}
 */
export async function recoverStaleVaultCommits({
  leaseMs = VAULT_TRANSFER_LIMITS.commitLeaseMs,
  maxPasses = 200,
} = {}) {
  const tally = { reopened: 0, committed: 0, aborted: 0, scanned: 0 }

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const outcome = await v2.withStaleVaultV2CommitLease(leaseMs, async (session, ctx) => {
      tally.scanned += 1
      return recoverOne(session, ctx)
    })
    if (outcome === null) break
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
  if (!key) {
    return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
  }

  // ── (ข) มีแถว blob ชี้ไปยัง key ปลายทางแล้วหรือยัง ─────────────────────────
  // ตามการออกแบบต้องไม่มีทางเป็นจริง (metadata ทั้งชุด + status อยู่ใน transaction
  // เดียว) แต่ตรวจไว้เพราะการตัดสินผิดด้านนี้จะสร้าง blob ซ้ำ ซึ่งแพงกว่าการตรวจมาก
  const published = await ctx.findBlobByStorageKey(key)
  if (published) {
    if (await finalVaultKeyExists(key)) {
      await ctx.markCommitted(published.id)
      return 'committed'
    }
    // metadata มี แต่ไบต์หาย — ไม่แตะแถว blob (ไม่ใช่หน้าที่ของงานกู้คืน) และไม่
    // ประกาศว่าสำเร็จ ปิด session อย่างซื่อสัตย์
    return abort(ctx)
  }

  // ── (ค) ไบต์ถูก rename ไปที่ key ปลายทางแล้ว แต่ metadata ยังไม่ถูกเขียน ───
  // ย้ายกลับมาเป็นไฟล์ที่พักไว้ แล้วเปิด session ให้ commit ใหม่ได้ — ไม่ต้อง
  // เข้ารหัสและอัปโหลดใหม่ทั้งไฟล์ (ซึ่งใน Vault แพงเป็นสองเท่า: encrypt + upload)
  if (await finalVaultKeyExists(key)) {
    if (await restoreStagedVaultPart(session.uploadId, key)) {
      return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
    }
    return abort(ctx)
  }

  // ── (ง) ยังไม่ถึงขั้น rename — ไบต์ควรยังอยู่ในพื้นที่พัก ──────────────────
  return (await stagedBytesUsable(session)) ? reopen(ctx) : abort(ctx)
}

/**
 * ไบต์ที่พักไว้ยังครบตามขนาด ciphertext ที่ประกาศไว้ไหม
 * ⚠️ ขนาดครบไม่ได้แปลว่า chunk ครบ: ช่องที่ค้างสถานะ 'writing' ยังไม่นับว่ารับแล้ว
 *    commit รอบถัดไปจะถูกบล็อกด้วย UPLOAD_INCOMPLETE ซึ่งถูกต้อง — เงื่อนไขที่นี่คือ
 *    "ไฟล์ part ยังใช้ต่อได้ไหม" ไม่ใช่ "commit ได้เลยไหม"
 */
async function stagedBytesUsable(session) {
  const size = await stagedVaultPartSize(session.uploadId)
  return size === session.ciphertextSize
}

async function reopen(ctx) { await ctx.reopen(); return 'reopened' }
async function abort(ctx) { await ctx.abort(); return 'aborted' }

/**
 * ตั้งรอบกู้คืนของโปรเซสที่เปิดพอร์ต — ไม่ใช้ในชุดทดสอบ (เทสต์เรียกรอบเดียวตรง ๆ)
 * ⚠️ unref() เพื่อไม่ให้ timer กันโปรเซสไม่ให้ปิด และ error ถูกกลืนโดยเจตนา
 */
export function scheduleVaultCommitRecovery({ intervalMs = 5 * 60 * 1000 } = {}) {
  const run = () => {
    recoverStaleVaultCommits().catch((err) => {
      console.error('[aegis-drive] vault commit recovery failed:', err.message)
    })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return timer
}
