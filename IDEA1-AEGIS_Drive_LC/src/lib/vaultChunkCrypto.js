// src/lib/vaultChunkCrypto.js — AEGIS Drive (IDEA1) · Private Vault format V2
//
// ⚠️ เข้ารหัสฝั่ง client เท่านั้น เหมือน V1 ทุกประการ — server เก็บได้แค่ ciphertext
//    ที่อ่านไม่ออก passphrase / KEK / DEK ไม่เคยออกจากเบราว์เซอร์ ไม่เคยอยู่ใน request
//    body ไม่เคยถูก log และไม่เคยแตะ localStorage/sessionStorage/IndexedDB
//
// ── ทำไมต้องมีรูปแบบที่สอง (สิ่งที่ V1 ทำไม่ได้ และเลี่ยงไม่ได้ด้วยการปรับตัวเลข) ──
//   V1 = ไฟล์หนึ่งไฟล์ → ข้อความ AES-GCM หนึ่งข้อความ ซึ่งแปลว่าเบราว์เซอร์ต้องถือ
//   plaintext ทั้งไฟล์ + ciphertext ทั้งไฟล์ไว้ในหน่วยความจำพร้อมกัน และต้องส่งทั้งก้อน
//   ในคำขอเดียว เพดาน 64 MiB ของ V1 จึงเป็น "ผลลัพธ์" ของสถาปัตยกรรมนั้น ไม่ใช่สาเหตุ
//   การยกค่านั้นขึ้นไม่ได้แก้อะไรเลย มันแค่ย้ายจุดที่แท็บจะหมดหน่วยความจำ
//
//   V2 = ไฟล์หนึ่งไฟล์ → **หลายข้อความ AES-GCM ที่สมบูรณ์ในตัวเอง** แต่ละก้อนมี IV
//   ของตัวเอง มี tag ของตัวเอง และถอด/ตรวจได้เดี่ยว ๆ
//
//   ⚠️ สิ่งที่ **ห้าม** ทำและไม่ได้ทำที่นี่: ตัด ciphertext ของ V1 หนึ่งก้อนออกเป็นชิ้น ๆ
//      GCM tag รับรอง "หนึ่งข้อความ" ไม่ใช่ "เศษของข้อความ" การหั่นชิ้นแล้วส่งทีละชิ้น
//      ทำให้ไม่มีชิ้นไหนตรวจสอบได้เลยจนกว่าจะได้ครบทุกชิ้น = ไม่ได้แก้ปัญหาหน่วยความจำ
//      และทำลายคุณสมบัติ authenticated encryption ไปพร้อมกัน
//
// ── ราคาที่ต้องจ่ายเมื่อแยกเป็นหลายข้อความ และวิธีจ่าย ─────────────────────────
//   ข้อความอิสระหลายก้อนภายใต้กุญแจเดียวกันเปิดช่องใหม่ที่ V1 ไม่มี: ผู้ที่ควบคุมพื้นที่
//   เก็บ (หรือเส้นทาง) สามารถ **สลับลำดับ / ตัดทิ้ง / ทำซ้ำ / ย้ายก้อนข้ามไฟล์** ได้
//   โดยที่ทุกก้อนยังผ่าน tag ของตัวเอง เพราะ tag รับรองแค่ "ก้อนนี้ไม่ถูกแก้"
//   ไม่ได้รับรองว่า "ก้อนนี้เป็นก้อนที่ N ของไฟล์นี้"
//
//   AAD (Additional Authenticated Data) คือคำตอบ: มันคือข้อมูลที่ถูก "รับรอง" โดย tag
//   แต่ไม่ถูกเข้ารหัส เราผูกตัวตนและตำแหน่งของก้อนไว้ในนั้น ถ้าอะไรในนั้นไม่ตรงตอนถอด
//   GCM จะล้มเหลว ไม่ใช่คืนข้อมูลผิด ๆ
//
// ── รูปแบบไบต์ของ AAD (ตายตัว — มีเทสต์ตรึงทุกไบต์) ──────────────────────────
//
//   AAD ของ chunk เนื้อไฟล์ = 34 ไบต์
//     offset  ขนาด  ความหมาย
//     0       10    ASCII "AEGIS-VLT2"  ← magic + หมายเลขรูปแบบในตัวอักษรสุดท้าย
//     10      16    contentId (ไบต์ดิบ)
//     26      4     chunkIndex  uint32 big-endian
//     30      4     chunkCount  uint32 big-endian
//
//   AAD ของ metadata = 33 ไบต์
//     0       13    ASCII "AEGIS-VLT2-MD"
//     13      16    contentId (ไบต์ดิบ)
//     29      4     chunkCount  uint32 big-endian
//
//   ⚠️ เป็น **binary ที่ต่อกันตายตัว** ไม่ใช่ JSON โดยเจตนา: ลำดับคีย์ของ JSON ไม่ใช่
//      สิ่งที่ภาษาการันตี การเปลี่ยน engine หรือแค่ปรับโค้ดให้สร้าง object คนละลำดับ
//      จะเปลี่ยนไบต์ของ AAD และทำให้ไฟล์เก่าทั้งคลังถอดไม่ออก โดยไม่มีใครแก้อะไรเลย
//   ⚠️ หมายเลขรูปแบบอยู่ในตัวอักษรสุดท้ายของ magic ("...VLT2") รูปแบบถัดไปจะเป็น
//      "AEGIS-VLT3" ซึ่งเป็นคนละไบต์ — ciphertext ข้ามรุ่นจึงถอดข้ามกันไม่ได้ตั้งแต่
//      ชั้น AEAD ไม่ต้องพึ่งการตรวจเวอร์ชันในโค้ดที่อาจถูกลืม
//   ⚠️ chunkCount ถูกผูกไว้ด้วย ไม่ใช่แค่ chunkIndex — ถ้าผูกแค่ index ผู้ที่ควบคุมพื้นที่
//      เก็บจะ "ตัดหางไฟล์ทิ้ง" ได้เงียบ ๆ ทุกก้อนที่เหลือยังถอดผ่านหมด และผู้ใช้ได้ไฟล์
//      ที่สั้นลงโดยไม่มีสัญญาณอะไรเลย
//
// ── ความปลอดภัยของ IV (ข้อที่พังแล้วพังหมด) ────────────────────────────────
//   AES-GCM ที่ใช้ IV ซ้ำกับกุญแจเดิม **สำหรับ plaintext คนละชุด** ทำให้ keystream ถูก
//   นำกลับมาใช้ซ้ำ (กู้ plaintext ได้จากการ XOR) และทำให้ authentication key รั่ว
//   (ปลอม tag ได้) — ไม่ใช่การอ่อนลง แต่คือการล่มสลายของทั้งระบบ
//
//   กติกาที่นี่จึงเรียบง่ายที่สุดเท่าที่จะทำได้ เพราะกติกาที่ซับซ้อนคือกติกาที่จะถูกทำผิด:
//   **ทุกครั้งที่เรียก encryptVaultChunk() จะสุ่ม IV 12 ไบต์ใหม่เสมอ** ไม่มีตัวนับ
//   ไม่มีการ derive จาก index ไม่มีสถานะที่ต้องจำข้ามการ retry และไม่มีอะไรที่ "วนกลับ"
//   ได้เมื่อไฟล์ใหญ่พอ
//
//   ⚠️ การส่งซ้ำจึงปลอดภัยสองแบบเท่านั้น และทั้งสองแบบถูกต้อง:
//      A. ส่ง ciphertext ก้อนเดิมซ้ำ (IV เดิม + plaintext เดิม → ปลอดภัยตามนิยาม)
//      B. เข้ารหัสก้อนเดิมใหม่ด้วย IV ใหม่ (ทิ้ง ciphertext เก่าไป)
//      โมดูลนี้เลือกแบบ B เสมอ เพราะมันไม่ต้องเก็บ ciphertext ก้อนเก่าไว้ในหน่วยความจำ
//      ระหว่างรอ retry — ซึ่งจะย้อนแย้งกับเป้าหมายเรื่องหน่วยความจำของทั้ง V2
//      สิ่งที่ห้ามเด็ดขาดคือ "IV เดิม + plaintext ต่าง" ซึ่งเกิดไม่ได้ที่นี่โดยโครงสร้าง
//
// ⚠️ CryptoKey ทุกดอกถูก import แบบ non-extractable เหมือน V1 — ต่อให้มี XSS ก็ export
//    ออกไปไม่ได้
import { bytesToB64, b64ToBytes, KEY_BYTES } from './vaultCrypto.js'

// globalThis.crypto ไม่ใช่ window.crypto — โมดูลนี้ต้องรันได้ทั้งในเบราว์เซอร์และใน
// Node (node:test) เพื่อให้ "โค้ดที่ทดสอบ" เป็นโค้ดตัวเดียวกับที่ผู้ใช้รันจริง
const subtle = globalThis.crypto.subtle
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

const te = new TextEncoder()
const td = new TextDecoder()

/** หมายเลขรูปแบบของ blob ที่โมดูลนี้ผลิต */
export const VAULT_FORMAT_V2 = 2

/** ขนาด GCM authentication tag — ต่อ "หนึ่ง chunk" ไม่ใช่ต่อไฟล์ */
export const GCM_TAG_BYTES = 16
export const IV_BYTES = 12
export const CONTENT_ID_BYTES = 16

/** magic + เวอร์ชันของ AAD เนื้อไฟล์ — ห้ามเปลี่ยนโดยไม่ขึ้นเวอร์ชันรูปแบบ */
export const AAD_CONTENT_MAGIC = 'AEGIS-VLT2'
/** magic ของ AAD ที่คุ้ม metadata — ต่างจากของเนื้อไฟล์เพื่อให้สับเปลี่ยนกันไม่ได้ */
export const AAD_META_MAGIC = 'AEGIS-VLT2-MD'

const CONTENT_MAGIC_BYTES = te.encode(AAD_CONTENT_MAGIC)
const META_MAGIC_BYTES = te.encode(AAD_META_MAGIC)

/** ความยาวคงที่ของ AAD ทั้งสองชนิด — เทสต์ตรึงค่านี้ไว้ */
export const CONTENT_AAD_BYTES = CONTENT_MAGIC_BYTES.length + CONTENT_ID_BYTES + 4 + 4 // 34
export const META_AAD_BYTES = META_MAGIC_BYTES.length + CONTENT_ID_BYTES + 4           // 33

const u32 = (value) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error('aad-field-out-of-range')
  return n
}

const asContentId = (contentId) => {
  const bytes = contentId instanceof Uint8Array ? contentId : b64ToBytes(String(contentId))
  if (bytes.length !== CONTENT_ID_BYTES) throw new Error('aad-content-id-length')
  return bytes
}

/**
 * AAD ของ chunk เนื้อไฟล์ — 34 ไบต์ตามตารางด้านบน
 * ⚠️ ฟังก์ชันนี้คือ "นิยามของรูปแบบ" ไม่ใช่ helper — การแก้ไบต์ใดไบต์หนึ่งที่นี่ทำให้
 *    blob V2 ที่มีอยู่ทั้งหมดถอดไม่ออกตลอดกาล
 */
export function contentChunkAad(contentId, chunkIndex, chunkCount) {
  const id = asContentId(contentId)
  const out = new Uint8Array(CONTENT_AAD_BYTES)
  out.set(CONTENT_MAGIC_BYTES, 0)
  out.set(id, CONTENT_MAGIC_BYTES.length)
  const view = new DataView(out.buffer)
  view.setUint32(CONTENT_MAGIC_BYTES.length + CONTENT_ID_BYTES, u32(chunkIndex), false)      // big-endian
  view.setUint32(CONTENT_MAGIC_BYTES.length + CONTENT_ID_BYTES + 4, u32(chunkCount), false)  // big-endian
  return out
}

/** AAD ของ metadata — 33 ไบต์ ผูก contentId และจำนวน chunk ไว้กับซอง metadata */
export function metadataAad(contentId, chunkCount) {
  const id = asContentId(contentId)
  const out = new Uint8Array(META_AAD_BYTES)
  out.set(META_MAGIC_BYTES, 0)
  out.set(id, META_MAGIC_BYTES.length)
  new DataView(out.buffer).setUint32(META_MAGIC_BYTES.length + CONTENT_ID_BYTES, u32(chunkCount), false)
  return out
}

/** ตัวระบุเนื้อหาใหม่ — 16 ไบต์จาก CSPRNG ล้วน ไม่ derive จากอะไรทั้งสิ้น */
export function newContentId() {
  return randomBytes(CONTENT_ID_BYTES)
}

/** import raw 32 ไบต์ → CryptoKey (AES-GCM) แบบ non-extractable */
async function importAesKey(rawBytes) {
  return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * แผนการแบ่งไฟล์ — จำนวน chunk, ขนาด ciphertext ต่อก้อน และขนาด ciphertext รวม
 *
 * ⚠️ ไฟล์ว่าง (0 ไบต์) ได้ **1 chunk ไม่ใช่ 0** โดยเจตนา: chunk คือข้อความ AEAD
 *    หนึ่งข้อความ ไฟล์ที่ไม่มี chunk เลยคือไฟล์ที่ไม่มี tag ให้ตรวจ = ไฟล์ที่ใครก็สร้าง
 *    ขึ้นมาแทนได้โดยไม่ต้องมีกุญแจ
 * @param {number} plainSize ขนาดไฟล์ต้นฉบับ
 * @param {number} plaintextChunkBytes ขนาด plaintext ต่อก้อน (เซิร์ฟเวอร์เป็นคนแนะนำ)
 */
export function planVaultChunks(plainSize, plaintextChunkBytes) {
  const size = Math.max(0, Number(plainSize))
  const plainChunk = Number(plaintextChunkBytes)
  if (!Number.isSafeInteger(plainChunk) || plainChunk <= 0) throw new Error('invalid-chunk-size')
  const chunkCount = size === 0 ? 1 : Math.ceil(size / plainChunk)
  const lastPlain = size === 0 ? 0 : size - (chunkCount - 1) * plainChunk
  return {
    chunkCount,
    plaintextChunkBytes: plainChunk,
    // ขนาด ciphertext ของก้อน "เต็ม" — เซิร์ฟเวอร์ใช้ค่านี้คำนวณตำแหน่งบนดิสก์
    chunkSize: plainChunk + GCM_TAG_BYTES,
    lastChunkSize: lastPlain + GCM_TAG_BYTES,
    ciphertextSize: size + chunkCount * GCM_TAG_BYTES,
  }
}

/** ช่วง [start, end) ของ plaintext ที่ chunk ลำดับนี้ครอบคลุม — ใช้กับ file.slice() */
export function plaintextRangeFor(index, plainSize, plaintextChunkBytes) {
  const start = index * plaintextChunkBytes
  return { start, end: Math.min(start + plaintextChunkBytes, Math.max(0, plainSize)) }
}

/**
 * สร้างซอง V2 ของไฟล์หนึ่งไฟล์ — DEK สุ่มใหม่ต่อไฟล์ + metadata ที่เข้ารหัสแล้ว
 *
 * ⚠️ โครงกุญแจไม่เปลี่ยนจาก V1 เลย: passphrase →Argon2id→ KEK, DEK สุ่มต่อไฟล์,
 *    DEK ถูกห่อด้วย KEK ไม่มี "กุญแจเนื้อหาของผู้ใช้หนึ่งดอก" และ KEK ไม่เคยเข้ารหัส
 *    เนื้อไฟล์เอง เหตุผลเดิมทุกข้อ (เปลี่ยน passphrase = re-wrap เล็ก ๆ, จำกัดปริมาณ
 *    ข้อมูลต่อกุญแจ, แชร์รายชิ้นในอนาคต) ยังใช้ได้และไม่ถูกแตะ
 * ⚠️ metadata ยังเข้ารหัสด้วย DEK เหมือน V1 แต่เพิ่ม AAD ที่ผูก contentId + chunkCount
 *    ทำให้ซอง metadata ของไฟล์หนึ่งถูกนำไปแปะกับ ciphertext ของอีกไฟล์ไม่ได้
 * ⚠️ ไม่มีชื่อไฟล์/MIME ออกไปนอกฟังก์ชันนี้ในรูป plaintext — ทั้งคู่จบอยู่ใน metaB64
 *
 * @returns {Promise<{ dek: CryptoKey, contentId: Uint8Array, contentIdB64: string,
 *                     wrappedDekB64: string, wrapIvB64: string,
 *                     metaIvB64: string, metaB64: string }>}
 */
export async function createVaultV2Envelope(kek, { name, type = '', size, chunkCount, contentId }) {
  const id = contentId ?? newContentId()

  // 1. DEK สุ่มใหม่ต่อไฟล์ — CSPRNG ล้วน ไม่ derive จากอะไรเลย
  const dekRaw = randomBytes(KEY_BYTES)
  const dek = await importAesKey(dekRaw)

  // 2. metadata (ชื่อ/ชนิด/ขนาดจริง) เข้ารหัสด้วย DEK + AAD ที่ผูกตัวตนของไฟล์
  const metaIv = randomBytes(IV_BYTES)
  const metaPlain = te.encode(JSON.stringify({ name, type, plainSize: size }))
  const metaCipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: metaIv, additionalData: metadataAad(id, chunkCount) }, dek, metaPlain,
  )

  // 3. ห่อ DEK ด้วย KEK — รูปแบบเดียวกับ V1 เป๊ะ (ไม่มี AAD) เพื่อให้ชั้นซองของทั้ง
  //    สองรูปแบบยังเป็นสิ่งเดียวกัน และการเปลี่ยน passphrase ในอนาคตทำได้ทางเดียว
  const wrapIv = randomBytes(IV_BYTES)
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dekRaw)
  dekRaw.fill(0) // ล้าง raw DEK ทันที — เหลือแค่ CryptoKey ที่ export ไม่ได้ กับฉบับที่ถูกห่อ

  return {
    dek,
    contentId: id,
    contentIdB64: bytesToB64(id),
    wrappedDekB64: bytesToB64(wrapped),
    wrapIvB64: bytesToB64(wrapIv),
    metaIvB64: bytesToB64(metaIv),
    metaB64: bytesToB64(metaCipher),
  }
}

/**
 * เข้ารหัส chunk หนึ่งก้อน → ข้อความ AES-GCM ที่สมบูรณ์ในตัวเอง
 * ⚠️ IV ถูกสุ่มใหม่ "ทุกครั้ง" ที่ฟังก์ชันนี้ถูกเรียก — ไม่มีเส้นทางใดในโมดูลนี้ที่นำ IV
 *    กลับมาใช้ซ้ำ และไม่มีพารามิเตอร์ให้ผู้เรียกกำหนด IV เองด้วย (ถ้ามี วันหนึ่งจะมีคนใช้)
 * @returns {Promise<{ ivB64: string, ciphertext: Uint8Array }>}
 */
export async function encryptVaultChunk(dek, { contentId, chunkIndex, chunkCount, plaintext }) {
  const iv = randomBytes(IV_BYTES)
  const aad = contentChunkAad(contentId, chunkIndex, chunkCount)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, plaintext)
  return { ivB64: bytesToB64(iv), ciphertext: new Uint8Array(ct) }
}

/**
 * ถอด chunk หนึ่งก้อน — ล้มเหลว = throw เสมอ ไม่มีทางคืนข้อมูลที่ "เกือบถูก"
 *
 * ⚠️ นี่คือ CLIENT_AEAD_PLAINTEXT_AUTHENTICATION: การผ่านของ tag คือหลักฐานว่า
 *    (ก) ไบต์ก้อนนี้ไม่ถูกแก้แม้แต่บิตเดียว และ (ข) มันคือก้อนที่ index นี้ ของไฟล์
 *    contentId นี้ ในไฟล์ที่มี chunkCount ก้อน — เพราะทั้งสามอยู่ใน AAD
 *    เซิร์ฟเวอร์พิสูจน์ข้อไหนไม่ได้เลย และไม่เคยอ้างว่าพิสูจน์
 * ⚠️ ข้อความ error เหมือนกันหมดทุกสาเหตุ (กุญแจผิด / ciphertext ถูกแก้ / ตำแหน่งผิด)
 *    — ไม่มี oracle ให้ผู้โจมตีแยกแยะ แบบแผนเดียวกับ decryptBytes() ของ V1
 */
export async function decryptVaultChunk(dek, { contentId, chunkIndex, chunkCount, ivB64, ciphertext }) {
  const aad = contentChunkAad(contentId, chunkIndex, chunkCount)
  let plain
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ivB64), additionalData: aad }, dek, ciphertext,
    )
  } catch {
    throw new Error('chunk-auth-failed')
  }
  return new Uint8Array(plain)
}

/**
 * ถอด metadata ของ blob V2 — ต้องแกะ DEK จากซองก่อน
 * ⚠️ ไม่รับ dek ตรง ๆ โดยเจตนา: ผู้เรียกที่ถือ KEK อยู่แล้วไม่ควรต้องรู้ว่าจะแกะ DEK
 *    อย่างไร และเส้นทางที่มี DEK ลอยอยู่ในโค้ดจอคือเส้นทางที่จะมีคนเผลอส่งมันไปที่อื่น
 */
export async function decryptVaultV2Meta(kek, blob) {
  const dek = await unwrapVaultV2Dek(kek, blob)
  return decryptVaultV2MetaWithDek(dek, blob)
}

/** เหมือนด้านบน แต่ใช้ DEK ที่แกะไว้แล้ว — ใช้ระหว่างดาวน์โหลดที่ถือ DEK อยู่แล้ว */
export async function decryptVaultV2MetaWithDek(dek, blob) {
  const aad = metadataAad(blob.contentIdB64, blob.chunkCount)
  let plain
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(blob.metaIvB64), additionalData: aad }, dek,
      b64ToBytes(blob.metaB64),
    )
  } catch {
    throw new Error('wrong-key')
  }
  return JSON.parse(td.decode(new Uint8Array(plain)))
}

/**
 * แกะ DEK ออกจากซองด้วย KEK
 * ⚠️ รูปแบบการห่อเหมือน V1 เป๊ะ (AES-GCM, ไม่มี AAD) — แยกฟังก์ชันไว้เพื่อไม่ให้
 *    เส้นทาง V2 ต้อง import ชั้นในของ V1 แต่พฤติกรรมต้องเหมือนกันเสมอ มีเทสต์ตรึงไว้
 * @throws {Error} 'wrong-key'
 */
export async function unwrapVaultV2Dek(kek, { wrappedDekB64, wrapIvB64 }) {
  let raw
  try {
    raw = await subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(wrapIvB64) }, kek, b64ToBytes(wrappedDekB64),
    )
  } catch {
    throw new Error('wrong-key')
  }
  const rawBytes = new Uint8Array(raw)
  const dek = await importAesKey(rawBytes)
  rawBytes.fill(0)
  return dek
}
