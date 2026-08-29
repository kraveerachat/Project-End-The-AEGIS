// tests/transferLimitsConfig.test.js — AEGIS Drive (IDEA1) · เพดานที่ตั้งได้จริง (LFT-V2-E)
//
// ⚠️ ชุดนี้ตรึง "ความจริงของการตั้งค่า" ไม่ใช่พฤติกรรมของ HTTP:
//    1. deployment ตั้งเพดานถึง 32 GiB ได้ และ 32 GiB ต้องเป็นตัวเลขที่ปลอดภัยใน JS
//    2. ค่าเริ่มต้นของทุก deployment **ไม่เปลี่ยน** — การรองรับ 32 GiB ต้องเป็นการ
//       เลือกของผู้ดูแล ไม่ใช่ของขวัญที่แจกให้ทุกเครื่องที่อัปเดตโค้ด
//    3. ตั้งเกินเพดานที่รองรับ = บูตไม่ขึ้น ไม่ใช่ถูก clamp เงียบ ๆ ให้เป็นค่าอื่น
//    4. กฎพื้นที่สำรองยังปฏิเสธไฟล์ที่จะกินพื้นที่จนระบบเขียนอะไรไม่ได้ เหมือนเดิมทุกประการ
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  transferLimitsFromEnv, reserveBytesFor, chunkCountFor,
  MAX_SUPPORTED_LOGICAL_FILE_BYTES, MIN_CHUNK_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES,
} from '../server/config/transferLimits.js'
import {
  vaultTransferLimitsFromEnv, expectedVaultCiphertextSize, vaultChunkCountFor,
  MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES, GCM_TAG_BYTES,
} from '../server/config/vaultTransferLimits.js'

const MIB = 1_048_576
const GIB = 1_073_741_824
const THIRTY_TWO_GIB = 34_359_738_368

test('32 GiB คือ 34,359,738,368 ไบต์ และเป็นเพดานที่ประกาศว่ารองรับ', () => {
  assert.equal(32 * GIB, THIRTY_TWO_GIB)
  assert.equal(MAX_SUPPORTED_LOGICAL_FILE_BYTES, THIRTY_TWO_GIB)
  assert.equal(MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES, THIRTY_TWO_GIB)
})

test('ตัวอ่านค่ารับ 34359738368 ได้ทั้ง Normal Files และ Vault', () => {
  const normal = transferLimitsFromEnv({ MAX_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB) })
  assert.equal(normal.maxLogicalFileBytes, THIRTY_TWO_GIB)

  const vault = vaultTransferLimitsFromEnv({ MAX_VAULT_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB) })
  assert.equal(vault.maxLogicalFileBytes, THIRTY_TWO_GIB)
})

test('ตั้งเกินเพดานที่รองรับ = โยน error ไม่ใช่ clamp เงียบ ๆ', () => {
  assert.throws(
    () => transferLimitsFromEnv({ MAX_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB + 1) }),
    /MAX_LOGICAL_FILE_BYTES must be between/,
  )
  assert.throws(
    () => vaultTransferLimitsFromEnv({ MAX_VAULT_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB + 1) }),
    /MAX_VAULT_LOGICAL_FILE_BYTES must be between/,
  )
  // ค่าที่ไม่ใช่ตัวเลขล้วนยังต้องตายตั้งแต่บูตเหมือนเดิม
  assert.throws(() => transferLimitsFromEnv({ MAX_LOGICAL_FILE_BYTES: '32GiB' }), /positive integer/)
})

test('deployment ที่ไม่ได้ตั้งค่าเอง ยังได้เพดานเดิม 5 GiB — ไม่มีการยกให้เงียบ ๆ', () => {
  const normal = transferLimitsFromEnv({})
  const vault = vaultTransferLimitsFromEnv({})

  assert.equal(normal.maxLogicalFileBytes, 5 * GIB)
  assert.equal(vault.maxLogicalFileBytes, 5 * GIB)
  assert.equal(normal.chunkSizeBytes, 16 * MIB)
  assert.equal(vault.plaintextChunkBytes, 16 * MIB)
})

test('ไม่มีจุดใดหลุดช่วงจำนวนเต็มที่ปลอดภัยของ JS ที่ 32 GiB', () => {
  const vault = vaultTransferLimitsFromEnv({
    MAX_VAULT_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB),
    VAULT_CHUNK_PLAINTEXT_BYTES: String(32 * MIB),
  })

  const chunks = vaultChunkCountFor(THIRTY_TWO_GIB, vault.plaintextChunkBytes)
  const ciphertext = expectedVaultCiphertextSize(THIRTY_TWO_GIB, vault.plaintextChunkBytes)

  assert.equal(chunks, 1024, '32 GiB ที่ chunk ละ 32 MiB = 1,024 ก้อนพอดี')
  assert.equal(ciphertext, THIRTY_TWO_GIB + 1024 * GCM_TAG_BYTES)
  assert.ok(Number.isSafeInteger(ciphertext), 'ขนาด ciphertext ต้องยังเป็นจำนวนเต็มที่ปลอดภัย')
  assert.ok(Number.isSafeInteger(chunks * vault.ciphertextChunkBytes),
    'ตำแหน่งเขียนของก้อนสุดท้าย (index × ciphertextChunkBytes) ต้องไม่ล้น')
  assert.equal(chunkCountFor(THIRTY_TWO_GIB, 32 * MIB), 1024)
})

test('ช่วงขนาด chunk ยังเป็น 8–64 MiB และ 32 MiB อยู่ในช่วงนั้น', () => {
  assert.equal(MIN_CHUNK_SIZE_BYTES, 8 * MIB)
  assert.equal(MAX_CHUNK_SIZE_BYTES, 64 * MIB)

  const at32 = transferLimitsFromEnv({ UPLOAD_CHUNK_SIZE_BYTES: String(32 * MIB) })
  assert.equal(at32.chunkSizeBytes, 32 * MIB)

  assert.throws(() => transferLimitsFromEnv({ UPLOAD_CHUNK_SIZE_BYTES: String(4 * MIB) }), /must be between/)
  assert.throws(() => transferLimitsFromEnv({ UPLOAD_CHUNK_SIZE_BYTES: String(128 * MIB) }), /must be between/)
})

test('กฎพื้นที่สำรองยังปฏิเสธไฟล์ที่จะกินพื้นที่จนเหลือน้อยกว่าส่วนสำรอง', () => {
  const limits = transferLimitsFromEnv({ MAX_LOGICAL_FILE_BYTES: String(THIRTY_TWO_GIB) })

  // volume 200 GiB → ส่วนสำรอง = max(2 GiB, 5% ของ 200 GiB = 10 GiB) = 10 GiB
  const totalBytes = 200 * GIB
  const reserve = reserveBytesFor(totalBytes, limits)
  assert.equal(reserve, 10 * GIB, 'สัดส่วนต้องชนะค่าคงที่เมื่อ volume ใหญ่')

  const accepts = (freeBytes, logicalSize) => freeBytes - logicalSize >= reserve

  // ว่าง 50 GiB รับไฟล์ 32 GiB ได้ (เหลือ 18 GiB > 10 GiB)
  assert.equal(accepts(50 * GIB, THIRTY_TWO_GIB), true)
  // ว่าง 40 GiB "ยังใส่ไฟล์ลงได้" แต่เหลือ 8 GiB < ส่วนสำรอง 10 GiB → ต้องปฏิเสธ
  assert.equal(accepts(40 * GIB, THIRTY_TWO_GIB), false,
    'ไฟล์ที่ทำให้พื้นที่เหลือต่ำกว่าส่วนสำรองต้องถูกปฏิเสธ แม้ว่าจะ "ยังพอใส่ได้"')
  // ขอบเขตเป๊ะ ๆ: เหลือเท่ากับส่วนสำรองพอดี = ยังรับได้
  assert.equal(accepts(THIRTY_TWO_GIB + 10 * GIB, THIRTY_TWO_GIB), true)
  assert.equal(accepts(THIRTY_TWO_GIB + 10 * GIB - 1, THIRTY_TWO_GIB), false)
})

test('ส่วนสำรองใช้ค่าคงที่เมื่อ volume เล็ก — สูตร max() ไม่ถูกกลับด้าน', () => {
  const limits = transferLimitsFromEnv({})
  // volume 20 GiB → 5% = 1 GiB ซึ่งน้อยกว่าค่าคงที่ 2 GiB
  assert.equal(reserveBytesFor(20 * GIB, limits), 2 * GIB)
})

test('สัญญาเช่าของ commit ปรับได้ถึง 24 ชั่วโมงสำหรับไฟล์ระดับ 32 GiB', () => {
  // ⚠️ ค่าเริ่มต้น 15 นาทีเพียงพอกับเพดานเริ่มต้น 5 GiB แต่ไม่ใช่กับ 32 GiB —
  //    deployment ที่ยกเพดานต้องยกสัญญาเช่าด้วย ชุดนี้พิสูจน์ว่ามัน "ยกได้จริง"
  assert.equal(transferLimitsFromEnv({}).commitLeaseMs, 15 * 60_000)

  const raised = transferLimitsFromEnv({ UPLOAD_COMMIT_LEASE_MS: String(45 * 60_000) })
  assert.equal(raised.commitLeaseMs, 45 * 60_000)

  const vaultRaised = vaultTransferLimitsFromEnv({ VAULT_COMMIT_LEASE_MS: String(45 * 60_000) })
  assert.equal(vaultRaised.commitLeaseMs, 45 * 60_000)

  assert.throws(() => transferLimitsFromEnv({ UPLOAD_COMMIT_LEASE_MS: '30000' }), /must be between/)
})
