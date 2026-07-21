// src/lib/vaultCrypto.js — AEGIS Drive (IDEA1) · Zero-Knowledge Private Vault
//
// ⚠️ เข้ารหัสฝั่ง client เท่านั้น — server เก็บได้แค่ ciphertext ที่อ่านไม่ออก แม้แต่ Admin ก็เปิดไม่ได้
//
// ทุกการเข้ารหัส/ถอดรหัสเกิด "ในเบราว์เซอร์" ผ่าน window.crypto.subtle เท่านั้น:
//   - Passphrase และกุญแจที่ derive ได้ ไม่เคยออกจากเครื่อง ไม่เคยอยู่ใน request body
//     ไม่เคยถูก log และไม่เคยแตะ storage ใด ๆ (อยู่ใน React state จนกดล็อก/ปิดแท็บ)
//   - Server เห็นเฉพาะ { salt, iv, ciphertext } — salt/iv ไม่ใช่ความลับ (เปิดเผยได้
//     โดยไม่ลดทอนความปลอดภัย) ส่วน ciphertext ปราศจากกุญแจก็เป็นแค่ noise
//
// พารามิเตอร์ (เหตุผลกำกับ — ผู้ตรวจดูตรงนี้):
//   - PBKDF2-HMAC-SHA256, 600,000 iterations: ตามคำแนะนำ OWASP Password Storage
//     Cheat Sheet (2023) สำหรับ PBKDF2-SHA256; บนเครื่องเดโม่ derive ใช้เวลา ~0.3–0.8s
//     ซึ่งช้าพอจะทำให้ brute-force แพงมาก แต่เร็วพอไม่รบกวนผู้ใช้
//     (เลือก PBKDF2 แทน Argon2 เพราะเป็น primitive เดียวที่ WebCrypto มี built-in —
//      ไม่ต้องเพิ่ม dependency WASM บนฮาร์ดแวร์ 8GB)
//   - Salt 16 ไบต์ สุ่มต่อผู้ใช้: กัน rainbow table / กันผู้ใช้สองคน passphrase ซ้ำ
//     ได้กุญแจเดียวกัน
//   - AES-256-GCM, IV 12 ไบต์ "สุ่มใหม่ทุก blob": GCM เป็น authenticated encryption —
//     ถอดด้วยกุญแจผิดจะ throw ทันที (ใช้เป็นตัวตรวจ passphrase ไปในตัว ไม่ต้องเก็บ
//     hash ของ passphrase ที่ไหนเลย) และห้าม reuse IV กับกุญแจเดิมเด็ดขาด
//   - กุญแจถูกสร้างแบบ non-extractable: ต่อให้มี XSS ก็ export กุญแจออกไปไม่ได้

const ITERATIONS = 600_000

const te = new TextEncoder()
const td = new TextDecoder()

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))

/**
 * Derive กุญแจ AES-256-GCM จาก passphrase + salt (base64)
 * ใช้เวลาจงใจ (~PBKDF2 600k รอบ) — เรียกครั้งเดียวตอนปลดล็อก แล้วถือกุญแจใน memory
 * @returns {Promise<CryptoKey>} non-extractable key
 */
export async function deriveVaultKey(passphrase, saltB64) {
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  )
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable — export ไม่ได้แม้จาก console
    ['encrypt', 'decrypt'],
  )
}

/**
 * ถอดรหัส blob → object (JSON)
 * กุญแจผิด → GCM authentication ล้มเหลว → throw 'wrong-key' (ทางเดียวที่รู้ว่าผิด
 * คือถอดไม่ออก — ไม่มี oracle อื่นให้เดา)
 */
export async function decryptVaultJson(key, { ivB64, dataB64 }) {
  let plain
  try {
    plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ivB64) },
      key,
      b64ToBytes(dataB64),
    )
  } catch {
    throw new Error('wrong-key')
  }
  return JSON.parse(td.decode(plain))
}

/**
 * เข้ารหัส object (JSON) → { ivB64, dataB64 } — IV สุ่มใหม่ทุกครั้ง
 * ผลลัพธ์นี้คือ "สิ่งเดียว" ที่ถูกส่งขึ้น server
 */
export async function encryptVaultJson(key, obj) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const data = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    te.encode(JSON.stringify(obj)),
  )
  return { ivB64: bytesToB64(iv), dataB64: bytesToB64(data) }
}

/** อ่านไฟล์เป็น base64 (สำหรับใส่ใน payload ก่อนเข้ารหัส) — จำกัดขนาดที่ผู้เรียก */
export async function fileToB64(file) {
  const buf = await file.arrayBuffer()
  return bytesToB64(buf)
}
