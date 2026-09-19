// src/lib/vaultTreeLimits.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · client limits
//
// ⚠️ ค่าทุกตัวในไฟล์นี้ "ถูกวัดมา" ไม่ได้เดา — ที่มาคือ Phase 0 ของ PR #157
//    (docs/superpowers/plans/2026-09-19-idea1-private-vault-encrypted-hierarchy-limits.md)
//    และถูกตรึงไว้ด้วย tests/vaultTreeLimits.test.js ซึ่งคัดลอกตารางเดียวกันมาเป๊ะ
//    การเปลี่ยนค่าใดค่าหนึ่งที่นี่โดยไม่แก้ตารางในเทสต์ (และหลักฐานที่มาของค่านั้น) = เทสต์แดง
//    โดยเจตนา: ไม่มีการ "ขยับเพดานเงียบ ๆ" ใน Production
//
// ⚠️ สถานะของค่า ณ G0 คือ MEASURED PROVISIONAL DEVELOPMENT LIMITS — จะกลายเป็นค่าที่
//    ใช้จริงได้ก็ต่อเมื่อ Task 1.6 วัดซ้ำด้วยโมดูลผลิตภัณฑ์จริงแล้วบันทึก G1_LIMIT_VALIDATION=PASS
//
// ⚠️ โมดูลนี้ไม่มี I/O ไม่มี crypto — เป็นตารางตัวเลขล้วน ทุกโมดูลของ tree รับ limits
//    ผ่านพารามิเตอร์ (treeLimitsFrom) เพื่อให้เทสต์ใส่ค่าเล็ก ๆ ได้โดยไม่ต้องพึ่งค่าจริง

const MIB = 1_048_576

/**
 * ตาราง padding bucket (ไบต์) — plaintext ของ manifest ถูกขยายให้เต็ม bucket ที่เล็กที่สุด
 * ที่รับได้ก่อนเข้ารหัส เพื่อไม่ให้ขนาด ciphertext บอกจำนวน node แบบเป๊ะ ๆ
 * เป็นเลขยกกำลังสองล้วน: การเปลี่ยนแปลงภายใน bucket เดียวกัน (rename/move/สร้าง 1 node)
 * จะไม่เปลี่ยนขนาดที่เซิร์ฟเวอร์เห็น ตัวสุดท้าย = maxDecodedBytes
 * ⚠️ เป็นส่วนหนึ่งของ "รูปแบบ" (versioned) — เปลี่ยนตารางแล้ว revision เก่ายังถอดได้
 *    (ความยาวจริงอยู่ใน trailer) แต่ AAD ผูก paddedPlaintextLength ไว้ จึงต้องมีเวอร์ชันใหม่
 */
export const PADDING_BUCKETS = Object.freeze([
  4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288,
  1 * MIB, 2 * MIB, 4 * MIB, 8 * MIB, 16 * MIB,
])

/** ค่าเริ่มต้นฝั่ง client — ดูที่มาของแต่ละค่าในหมายเหตุหลักฐาน (Limits Register) */
export const VAULT_TREE_CLIENT_LIMITS = Object.freeze({
  /** ciphertext ของ manifest หนึ่ง revision: bucket สุดท้าย + GCM tag 16 ไบต์ */
  maxCiphertextBytes: 16 * MIB + 16,
  /** plaintext หลังถอด padding ต้องไม่เกินนี้ — ตรวจจากความยาว "ก่อน" parse ใด ๆ */
  maxDecodedBytes: 16 * MIB,
  /** จำนวน node สูงสุดใน manifest (รวม root) */
  maxNodes: 10_000,
  /** ความลึกสูงสุด (root = 0) */
  maxDepth: 64,
  /** ชื่อ node เป็น UTF-8 ไม่เกินนี้ (600 = 200 อักษรไทย เท่ากับเพดาน 200 ตัวอักษรของ Files) */
  maxNameBytes: 600,
  /** จำนวน operation id ล่าสุดที่เก็บไว้ใน manifest เพื่อกันการ apply ซ้ำ */
  maxRecentOperationIds: 64,
  /** จำนวนครั้งสูงสุดของ semantic rebase ต่อหนึ่ง intent ก่อนยอมแพ้ (REBASE_EXHAUSTED) */
  maxRebaseAttempts: 10,
  /** ความลึกของโครงสร้าง JSON ที่ parser ยอมรับ (manifest → nodes → node → lifecycle/blobRef) */
  maxJsonDepth: 8,
})

const KEYS = Object.freeze(Object.keys(VAULT_TREE_CLIENT_LIMITS))

/**
 * สร้างชุด limits จากค่าเริ่มต้นโดย override ได้เฉพาะ key ที่รู้จัก และค่าต้องเป็นจำนวนเต็มบวก
 * ⚠️ ใช้ Object.hasOwn + ไม่รับ key แปลกปลอม: ค่า limits มาจากโค้ด ไม่ใช่จากผู้ใช้ แต่การ
 *    พิมพ์ผิดชื่อ key แล้วเงียบไป = เพดานนั้นไม่ถูกบังคับโดยไม่มีใครรู้
 * @param {Partial<typeof VAULT_TREE_CLIENT_LIMITS>} [overrides]
 * @returns {Readonly<typeof VAULT_TREE_CLIENT_LIMITS>}
 */
export function treeLimitsFrom(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object') throw new TypeError('tree limits overrides must be an object')
  const out = { ...VAULT_TREE_CLIENT_LIMITS }
  for (const key of Object.keys(overrides)) {
    if (!KEYS.includes(key)) throw new TypeError(`unknown tree limit: ${key}`)
    const value = overrides[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`tree limit ${key} must be a positive safe integer`)
    }
    out[key] = value
  }
  return Object.freeze(out)
}
