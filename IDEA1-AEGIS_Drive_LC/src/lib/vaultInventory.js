// src/lib/vaultInventory.js — Private Vault opaque blob inventory
//
// ⚠️ ทุกอย่างในไฟล์นี้ทำงานกับ "blob ทึบ" เท่านั้น: id, ขนาด ciphertext และ
//    envelope ที่ยังเข้ารหัสอยู่ ไม่มีฟังก์ชันใดในนี้ถอดรหัส อ่านชื่อไฟล์ หรือ
//    แตะ KEK/DEK เลย — มันคือบัญชีรายการ ไม่ใช่ชั้นเข้ารหัส
//
// ทำไมต้องมีชั้นนี้ (บั๊กจริงจาก production):
//   ปลดล็อก → อัปโหลด → กด Lock ทันที → จอขึ้น "Empty Vault"
//   เพราะโหมดล็อกอ่านรายการจาก `vaultApi.data.blobs` (ผลของ GET ครั้งก่อน)
//   ส่วนอัปโหลดที่สำเร็จไปแก้แค่ `entries` ที่ถอดรหัสแล้ว การ refetch เป็น
//   asynchronous ผู้ใช้จึงกด Lock ชนะการ refetch ได้เสมอ
//
//   บัญชีรายการจึงต้องเป็น "server + สิ่งที่รู้แน่จากผลลัพธ์ของ request ที่สำเร็จ
//   แล้ว" ไม่ใช่ผลของ GET ล่าสุดเพียงอย่างเดียว
//
// สัญญาของโมดูลนี้:
//   - deterministic: ผลลัพธ์ขึ้นกับ input เท่านั้น ไม่มี state ซ่อน ไม่มี I/O
//   - dedupe เข้มงวดด้วย blob id — GET ที่ตามมาทีหลังจะไม่ทำให้เกิดการ์ดซ้ำ
//   - tombstone: id ที่ลบสำเร็จแล้ว (HTTP 204) จะไม่ถูก GET เก่าปลุกคืนมา

/** id ของ blob ในรูปแบบเดียวเสมอ — server อาจส่ง number, local state ถือ string */
export const vaultBlobId = (blob) => (blob?.id === undefined || blob?.id === null ? null : String(blob.id))

const asIdSet = (ids) => (ids instanceof Set ? ids : new Set([...(ids ?? [])].map((id) => String(id))))

/**
 * รวมบัญชีรายการ blob ทึบที่จอ Vault ควรแสดง ณ ขณะนี้
 *
 * @param {object} input
 * @param {Array}  input.serverBlobs  ผลของ GET /api/vault ล่าสุด (อาจล้าสมัย)
 * @param {Array}  input.localBlobs   blob ที่ POST สำเร็จแล้วในเซสชันนี้ (ใหม่สุดอยู่หน้า)
 * @param {Set|Array} input.removedIds id ที่ DELETE ตอบ 204 แล้ว
 * @returns {Array} รายการ blob ทึบ ไม่ซ้ำ id เรียงใหม่สุดก่อน
 */
export function reconcileVaultInventory({ serverBlobs = [], localBlobs = [], removedIds } = {}) {
  const removed = asIdSet(removedIds)
  const seen = new Set()
  const out = []
  // local มาก่อน: ไฟล์ที่เพิ่งอัปโหลดต้องอยู่บนสุด และสำเนาของมันจาก GET ที่ตามมา
  // ทีหลังจะถูก dedupe ทิ้ง (ไม่ใช่กลายเป็นการ์ดใบที่สอง)
  for (const blob of [...localBlobs, ...serverBlobs]) {
    const id = vaultBlobId(blob)
    if (id === null || removed.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(blob)
  }
  return out
}

/**
 * เพิ่ม blob ที่ POST สำเร็จเข้าบัญชีท้องถิ่นทันที (ไม่รอ GET)
 * เรียกได้ซ้ำอย่างปลอดภัย — id เดิมจะถูกแทนที่ ไม่ใช่เพิ่มซ้ำ
 */
export function addLocalVaultBlob(localBlobs = [], blob) {
  const id = vaultBlobId(blob)
  if (id === null) return localBlobs
  return [blob, ...localBlobs.filter((b) => vaultBlobId(b) !== id)]
}

/** ถอด blob ออกจากบัญชีท้องถิ่น (ใช้คู่กับ tombstone หลัง DELETE สำเร็จ) */
export function removeLocalVaultBlob(localBlobs = [], id) {
  const target = String(id)
  return localBlobs.filter((b) => vaultBlobId(b) !== target)
}

/**
 * ป้ายหลุมศพของ id ที่ลบสำเร็จแล้ว
 * ⚠️ เก็บตลอดอายุของหน้าจอโดยเจตนา: GET ที่ค้างอยู่ในสายอาจตอบกลับหลัง DELETE
 *    ถ้าไม่มีป้ายนี้ การ์ดที่ผู้ใช้ลบไปแล้วจะโผล่กลับมาหลอกเขาว่ายังลบไม่สำเร็จ
 */
export function tombstoneVaultBlob(removedIds, id) {
  const next = new Set(asIdSet(removedIds))
  next.add(String(id))
  return next
}

/**
 * มุมมอง "ล็อกอยู่" ของ blob — สิ่งที่ระบบเห็นจริงโดยไม่ต้องมี KEK
 * ⚠️ ห้ามเติมฟิลด์ใดที่มาจาก plaintext ลงในค่าที่คืนจากฟังก์ชันนี้
 */
export const lockedVaultEntry = (blob) => ({ id: vaultBlobId(blob), name: null, size: blob?.size ?? 0, blob })
