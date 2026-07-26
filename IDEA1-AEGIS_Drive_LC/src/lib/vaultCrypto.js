// src/lib/vaultCrypto.js — AEGIS Drive (IDEA1) · Zero-Knowledge Private Vault
//
// ⚠️ เข้ารหัสฝั่ง client เท่านั้น — server เก็บได้แค่ ciphertext ที่อ่านไม่ออก แม้แต่ Admin ก็เปิดไม่ได้
//
// ทุกการ derive/เข้ารหัส/ถอดรหัสเกิด "ในเบราว์เซอร์" เท่านั้น:
//   - Passphrase, KEK และ DEK ไม่เคยออกจากเครื่อง ไม่เคยอยู่ใน request body ไม่เคยถูก log
//     และไม่เคยแตะ localStorage/sessionStorage/IndexedDB (อยู่ใน React state จนกดล็อก /
//     หมดเวลา idle / ปิดแท็บ)
//   - Server เห็นเฉพาะ { salt, iv, ciphertext, wrappedDek, wrapIv } — salt/iv เปิดเผยได้
//     โดยไม่ลดทอนความปลอดภัย ส่วน ciphertext ปราศจากกุญแจก็เป็นแค่ noise
//
// ── โครงกุญแจ: Envelope Encryption สองชั้น ────────────────────────────────
//
//   passphrase ──Argon2id(salt)──▶ KEK (256-bit, ไม่เคยออกจาก memory)
//                                   │
//                                   ├─ wrap ──▶ wrappedDek  ─┐
//                                   │                        ├─▶ ส่งขึ้น server
//   getRandomValues() ─▶ DEK (256-bit, ต่อไฟล์) ─ encrypt ──▶ ciphertext ─┘
//
//   ทำไมต้องสองชั้น (ไม่ใช้ KEK เข้ารหัสไฟล์ตรง ๆ):
//     1. เปลี่ยน passphrase = re-wrap DEK เล็ก ๆ ต่อไฟล์ ไม่ต้องอ่าน/เข้ารหัสไฟล์ใหม่ทั้งคลัง
//     2. จำกัดปริมาณข้อมูลต่อกุญแจหนึ่งดอก — AES-GCM มีเพดานความปลอดภัยต่อกุญแจ
//        การใช้ DEK ใหม่ทุกไฟล์ทำให้ไม่มีวันเข้าใกล้เพดานนั้น และ IV ชนกันข้ามไฟล์ไม่มีผล
//     3. แชร์ไฟล์รายชิ้นในอนาคตทำได้โดย re-wrap DEK ด้วยกุญแจผู้รับ ไม่ต้องยกกุญแจหลักให้
//
// ── พารามิเตอร์ (เหตุผลกำกับ — ผู้ตรวจดูตรงนี้) ───────────────────────────
//   - Argon2id: memory-hard KDF ที่ชนะ Password Hashing Competition — ต่างจาก PBKDF2
//     ตรงที่ "แพงทั้ง RAM และเวลา" ทำให้ ASIC/GPU cracking rig เสียเปรียบมหาศาล
//     (PBKDF2 แพงแต่เวลาอย่างเดียว → GPU ขนานได้เป็นหมื่นสาย)
//   - m=64MiB, t=3, p=1: ตาม OWASP Password Storage Cheat Sheet (แนวทาง m=46MiB,t=1
//     ขึ้นไป) — เลือกสูงกว่าขั้นต่ำเพราะ derive เกิดแค่ครั้งเดียวตอนปลดล็อก
//     ⚠️ 64MiB ถูกเลือกให้เข้ากับ Beelink 8GB ที่รันหลาย container: เป็น allocation
//        ชั่วคราวในแท็บของ "ผู้ใช้" (ไม่ใช่ฝั่งเซิร์ฟเวอร์) จึงไม่แย่ RAM ของ service อื่น
//   - Salt 16 ไบต์ สุ่มต่อ vault: กัน rainbow table / กันผู้ใช้สอง passphrase ซ้ำได้กุญแจเดียวกัน
//   - AES-256-GCM, IV 12 ไบต์ "สุ่มใหม่ทุกครั้งที่เข้ารหัส": GCM เป็น authenticated
//     encryption — ถอดด้วยกุญแจผิดจะ throw ทันที (ใช้เป็นตัวตรวจ passphrase ไปในตัว
//     ไม่ต้องเก็บ hash ของ passphrase ที่ไหนเลย) และห้าม reuse IV กับกุญแจเดิมเด็ดขาด
//   - CryptoKey ทุกดอกถูก import แบบ non-extractable: ต่อให้มี XSS ก็ export ออกไม่ได้

import { argon2id } from 'hash-wasm'

// globalThis.crypto ไม่ใช่ window.crypto — โมดูลนี้ต้องรันได้ทั้งในเบราว์เซอร์และใน
// Node (node:test) เพื่อให้ "โค้ดที่ทดสอบ" เป็นโค้ดตัวเดียวกับที่ผู้ใช้รันจริง
const subtle = globalThis.crypto.subtle
const getRandomValues = (arr) => globalThis.crypto.getRandomValues(arr)

const te = new TextEncoder()
const td = new TextDecoder()

// ค่าคงที่ของ verifier — ข้อความรู้กันล่วงหน้า ไม่ใช่ความลับ ความปลอดภัยอยู่ที่
// "ถอดได้/ไม่ได้" ไม่ใช่ที่เนื้อความ
const VERIFIER_PLAINTEXT = 'aegis-vault-verifier-v1'

/** พารามิเตอร์ Argon2id เริ่มต้น — บันทึกคู่กับ salt ฝั่ง server เพื่อให้ปรับขึ้นภายหลังได้
 *  โดยที่ vault เก่ายังเปิดได้ด้วยพารามิเตอร์เดิมที่บันทึกไว้ */
export const ARGON2_DEFAULTS = Object.freeze({
  memorySizeKiB: 65_536, // 64 MiB
  iterations: 3,
  parallelism: 1,
})

export const KEY_BYTES = 32 // 256-bit
const IV_BYTES = 12
const SALT_BYTES = 16

// ── base64 helpers ────────────────────────────────────────────────────
// แปลงทีละก้อน — String.fromCharCode(...bytes) กับไฟล์หลาย MB จะ RangeError
// (spread ดันอาร์กิวเมนต์เป็นแสนตัวลง call stack)
const CHUNK = 0x8000

export function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const randomBytes = (n) => getRandomValues(new Uint8Array(n))

/** import raw 32 ไบต์ → CryptoKey (AES-GCM) แบบ non-extractable */
async function importAesKey(rawBytes) {
  return subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * เข้ารหัส bytes ด้วยกุญแจ + IV สุ่มใหม่ → { ivB64, dataB64 }
 * ⚠️ IV สุ่มใหม่ "ทุกครั้ง" — reuse IV กับกุญแจเดิมทำลายความปลอดภัยของ GCM ทั้งหมด
 */
async function encryptBytes(key, bytes) {
  const iv = randomBytes(IV_BYTES)
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
  return { ivB64: bytesToB64(iv), dataB64: bytesToB64(data) }
}

/** ถอดรหัส → Uint8Array; กุญแจผิด/ciphertext ถูกแก้ → throw 'wrong-key' */
async function decryptBytes(key, ivB64, cipherBytes) {
  let plain
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, cipherBytes)
  } catch {
    // ทางเดียวที่รู้ว่าผิดคือถอดไม่ออก — ไม่มี oracle อื่นให้เดา และข้อความ error
    // เหมือนกันหมดไม่ว่าจะผิดเพราะกุญแจหรือเพราะ ciphertext ถูกแก้
    throw new Error('wrong-key')
  }
  return new Uint8Array(plain)
}

// ── ชั้นที่ 1: KEK จาก passphrase ────────────────────────────────────────

/**
 * Derive KEK (256-bit) จาก passphrase + salt ด้วย Argon2id
 * ใช้เวลา/แรมจงใจ — เรียกครั้งเดียวตอนปลดล็อก แล้วถือ CryptoKey ไว้ใน memory
 * @param {string} passphrase ไม่เคยถูกส่งออกนอกฟังก์ชันนี้
 * @param {string} saltB64
 * @param {{memorySizeKiB?:number, iterations?:number, parallelism?:number}} params
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM key
 */
export async function deriveKek(passphrase, saltB64, params = ARGON2_DEFAULTS) {
  // ⚠️ passphrase ว่าง → 'wrong-key' เหมือนกรณีถอดไม่ผ่านทุกประการ ไม่ใช่ error คนละชนิด
  //    ถ้าปล่อยให้ hash-wasm โยน 'Password must be specified' ออกไป UI จะมีสองเส้นทาง
  //    error ที่แยกแยะได้ — เท่ากับบอกผู้โจมตีว่า "อันนี้ไม่ถึงขั้นตอนตรวจกุญแจด้วยซ้ำ"
  //    ความล้มเหลวทุกแบบต้องหน้าตาเหมือนกันหมด
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('wrong-key')

  const p = { ...ARGON2_DEFAULTS, ...params }
  const raw = await argon2id({
    password: passphrase,
    salt: b64ToBytes(saltB64),
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memorySizeKiB,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  })
  const key = await importAesKey(raw)
  raw.fill(0) // ล้าง raw KEK ออกจาก heap ทันทีที่ import เสร็จ — เหลือแค่ CryptoKey ที่ export ไม่ได้
  return key
}

/**
 * สร้าง vault ใหม่ (ครั้งแรก): salt สุ่ม + verifier ที่เข้ารหัสด้วย KEK
 * ⚠️ ผลลัพธ์นี้คือ "ทั้งหมด" ที่ถูกส่งขึ้น server — ไม่มีชิ้นไหนเปิดเผย passphrase
 *    server เก็บ salt/params/verifier ก็ยัง brute-force ต้องจ่ายค่า Argon2id เต็มราคา
 * @returns {Promise<{saltB64:string, params:object, verifier:{ivB64:string,dataB64:string}, kek:CryptoKey}>}
 */
export async function createVaultSetup(passphrase, params = ARGON2_DEFAULTS) {
  const saltB64 = bytesToB64(randomBytes(SALT_BYTES))
  const kek = await deriveKek(passphrase, saltB64, params)
  const verifier = await encryptBytes(kek, te.encode(VERIFIER_PLAINTEXT))
  return { saltB64, params: { ...ARGON2_DEFAULTS, ...params }, verifier, kek }
}

/**
 * พิสูจน์ passphrase โดยลองถอด verifier — ทั้งหมดเกิดในเบราว์เซอร์
 * ไม่มี network round-trip และไม่มี oracle ฝั่ง server ให้ยิงเดา
 * @throws {Error} 'wrong-key' เมื่อ passphrase ผิด
 */
export async function verifyKek(kek, verifier) {
  const plain = await decryptBytes(kek, verifier.ivB64, b64ToBytes(verifier.dataB64))
  if (td.decode(plain) !== VERIFIER_PLAINTEXT) throw new Error('wrong-key')
  return true
}

/** ปลดล็อก: derive + พิสูจน์ในขั้นตอนเดียว — คืน KEK เมื่อผ่านเท่านั้น */
export async function unlockVault(passphrase, { saltB64, params, verifier }) {
  const kek = await deriveKek(passphrase, saltB64, params)
  await verifyKek(kek, verifier) // ผิด → throw 'wrong-key'
  return kek
}

// ── ชั้นที่ 2: DEK ต่อไฟล์ + envelope ────────────────────────────────────

/**
 * เข้ารหัสไฟล์หนึ่งไฟล์แบบ envelope — ทุกอย่างเกิดก่อน network call ใด ๆ
 *
 * @param {CryptoKey} kek
 * @param {{name:string, type?:string, size:number, bytes:Uint8Array}} file
 * @returns {Promise<{ciphertext:Uint8Array, ivB64:string, wrappedDekB64:string,
 *                    wrapIvB64:string, metaIvB64:string, metaB64:string, plainSize:number}>}
 *   ciphertext = เนื้อของไฟล์ .aegisenc; ที่เหลือคือ metadata ที่ server เก็บเป็นคอลัมน์
 */
export async function encryptFileEnvelope(kek, { name, type = '', size, bytes }) {
  // 1. DEK สุ่มใหม่ต่อไฟล์ — ไม่ derive จากอะไรเลย เป็น CSPRNG ล้วน
  const dekRaw = randomBytes(KEY_BYTES)
  const dek = await importAesKey(dekRaw)

  // 2. เข้ารหัสเนื้อไฟล์ด้วย DEK
  const content = await encryptBytes(dek, bytes)

  // 3. เข้ารหัส metadata (ชื่อไฟล์/ชนิด) ด้วย DEK เช่นกัน — ชื่อไฟล์คือข้อมูล
  //    ("resignation-letter.pdf" บอกเรื่องได้มากกว่าเนื้อไฟล์บางที) server จึงไม่เห็น
  //    แม้แต่ชื่อ เห็นได้แค่ id + ขนาด ciphertext ตามที่ UI สัญญาไว้
  const meta = await encryptBytes(dek, te.encode(JSON.stringify({ name, type, size })))

  // 4. ห่อ DEK ด้วย KEK — นี่คือชิ้นเดียวที่ผูกไฟล์เข้ากับ passphrase
  const wrapped = await encryptBytes(kek, dekRaw)
  dekRaw.fill(0) // ล้าง raw DEK ทันที — เหลือแค่ฉบับที่ถูกห่อไว้แล้ว

  return {
    ciphertext: b64ToBytes(content.dataB64),
    ivB64: content.ivB64,
    wrappedDekB64: wrapped.dataB64,
    wrapIvB64: wrapped.ivB64,
    metaIvB64: meta.ivB64,
    metaB64: meta.dataB64,
    plainSize: size,
  }
}

/**
 * แกะ DEK ออกจากซองด้วย KEK — ใช้ทั้งตอนอ่าน metadata และตอนถอดเนื้อไฟล์
 * @throws {Error} 'wrong-key'
 */
export async function unwrapDek(kek, { wrappedDekB64, wrapIvB64 }) {
  const raw = await decryptBytes(kek, wrapIvB64, b64ToBytes(wrappedDekB64))
  const dek = await importAesKey(raw)
  raw.fill(0)
  return dek
}

/**
 * ถอด metadata ของไฟล์ (ชื่อ/ชนิด/ขนาดจริง) — เรียกตอนปลดล็อกเพื่อแสดงรายการ
 * ยังไม่ต้องดาวน์โหลด ciphertext ของเนื้อไฟล์ (ซึ่งอาจใหญ่มาก)
 */
export async function decryptBlobMeta(kek, blob) {
  const dek = await unwrapDek(kek, blob)
  const plain = await decryptBytes(dek, blob.metaIvB64, b64ToBytes(blob.metaB64))
  return JSON.parse(td.decode(plain))
}

/**
 * ถอดเนื้อไฟล์ — รับ ciphertext ที่เพิ่งดาวน์โหลดมา คืน bytes ต้นฉบับ
 * ⚠️ GCM ตรวจ integrity ให้ในตัว: ถ้า server (หรือใครก็ตามระหว่างทาง) แก้ ciphertext
 *    แม้แต่บิตเดียว การถอดจะ throw ไม่ใช่คืนข้อมูลเพี้ยน
 */
export async function decryptFileContent(kek, blob, ciphertext) {
  const dek = await unwrapDek(kek, blob)
  return decryptBytes(dek, blob.ivB64, ciphertext)
}

/** อ่าน File/Blob ของเบราว์เซอร์เป็น Uint8Array (ก่อนเข้ารหัส) */
export async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}
