// tests/vaultChunkCrypto.test.js — AEGIS Drive (IDEA1) · รูปแบบ Private Vault V2 (LFT-V2-B)
//
// ⚠️ ชุดนี้รัน "โมดูลตัวจริง" ด้วย WebCrypto ของ Node — ไม่มี mock ของการเข้ารหัสเลย
//    เพราะสิ่งที่ต้องพิสูจน์คือคุณสมบัติของ AEAD จริง ๆ ไม่ใช่ว่าโค้ดเรียกฟังก์ชันถูกชื่อ
//
// ⚠️ สิ่งที่ชุดนี้พิสูจน์ และเหตุผลที่แต่ละข้อสำคัญ:
//    - หนึ่งไฟล์ = หนึ่ง DEK สุ่ม และ DEK export ไม่ได้ (ต่อให้มี XSS ก็ส่งออกไม่ได้)
//    - ทุก chunk เป็นข้อความ AES-GCM ที่สมบูรณ์ในตัวเอง ถอดเดี่ยว ๆ ได้
//    - IV 96 บิตใหม่ทุกครั้งที่เข้ารหัส — ไม่มีตัวนับ ไม่มีการวนกลับ
//    - AAD ผูก (รูปแบบ, contentId, index, chunkCount) จนสลับ/ตัด/ย้ายก้อนไม่ได้
//    ข้อสุดท้ายคือสิ่งที่ V1 ไม่ต้องมี (ไฟล์เดียว = ข้อความเดียว) และเป็นราคาที่ต้องจ่าย
//    ทันทีที่แยกไฟล์ออกเป็นหลายข้อความ
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VAULT_FORMAT_V2, GCM_TAG_BYTES, IV_BYTES, CONTENT_ID_BYTES,
  AAD_CONTENT_MAGIC, AAD_META_MAGIC, CONTENT_AAD_BYTES, META_AAD_BYTES,
  contentChunkAad, metadataAad, newContentId, planVaultChunks, plaintextRangeFor,
  createVaultV2Envelope, encryptVaultChunk, decryptVaultChunk,
  unwrapVaultV2Dek, decryptVaultV2Meta, decryptVaultV2MetaWithDek,
} from '../src/lib/vaultChunkCrypto.js'
import { b64ToBytes, bytesToB64 } from '../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()

/** KEK ปลอมที่ "เป็นกุญแจจริง" — ชุดนี้ไม่ทดสอบ Argon2id (มีชุดของมันเองที่ vaultCrypto) */
async function fakeKek(seed = 7) {
  const raw = new Uint8Array(32).fill(seed)
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const bytes = (n, fill = 0xab) => new Uint8Array(n).fill(fill)

// ── รูปแบบไบต์ของ AAD ต้องตายตัว ────────────────────────────────────────────
// ⚠️ ข้อนี้ไม่ใช่เรื่องสไตล์: AAD คือ "นิยามของรูปแบบ" การเปลี่ยนไบต์ใดไบต์หนึ่งทำให้
//    blob V2 ที่มีอยู่ทั้งหมดถอดไม่ออกตลอดกาล เทสต์นี้จึงตรึงทุกไบต์ ไม่ใช่แค่ความยาว
test('AAD ของ chunk เป็นไบนารีความยาวคงที่ 34 ไบต์ ตามตารางที่บันทึกไว้', () => {
  const contentId = new Uint8Array([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ])
  const aad = contentChunkAad(contentId, 0x01020304, 0x0a0b0c0d)

  assert.equal(CONTENT_AAD_BYTES, 34)
  assert.equal(aad.length, 34)
  assert.equal(new TextDecoder().decode(aad.subarray(0, 10)), 'AEGIS-VLT2')
  assert.equal(AAD_CONTENT_MAGIC, 'AEGIS-VLT2')
  assert.deepEqual([...aad.subarray(10, 26)], [...contentId])
  // big-endian ทั้งสองช่อง — ระบุไว้ชัดเจนเพราะ little-endian จะ "ทำงานได้" บนเครื่อง
  // เดียวกันแต่ไม่ใช่รูปแบบที่บันทึกไว้ และจะพังเมื่อมีผู้ implement ฝั่งอื่น
  assert.deepEqual([...aad.subarray(26, 30)], [0x01, 0x02, 0x03, 0x04])
  assert.deepEqual([...aad.subarray(30, 34)], [0x0a, 0x0b, 0x0c, 0x0d])
  assert.equal(VAULT_FORMAT_V2, 2)
  assert.equal(CONTENT_ID_BYTES, 16)
})

test('AAD ของ metadata ใช้ magic คนละตัวกับของเนื้อไฟล์ จึงสับเปลี่ยนกันไม่ได้', () => {
  const id = newContentId()
  const contentAad = contentChunkAad(id, 0, 1)
  const metaAad = metadataAad(id, 1)
  assert.equal(META_AAD_BYTES, 33)
  assert.equal(metaAad.length, 33)
  assert.equal(new TextDecoder().decode(metaAad.subarray(0, 13)), 'AEGIS-VLT2-MD')
  assert.equal(AAD_META_MAGIC, 'AEGIS-VLT2-MD')
  assert.notDeepEqual([...contentAad], [...metaAad])
})

test('AAD ประกอบจากไบนารีที่กำหนดเอง ไม่ใช่ JSON ที่ลำดับคีย์ไม่ถูกการันตี', () => {
  const id = newContentId()
  const a = contentChunkAad(id, 3, 9)
  const b = contentChunkAad(bytesToB64(id), 3, 9) // รับทั้ง Uint8Array และ base64
  assert.deepEqual([...a], [...b], 'contentId รูปแบบไหนก็ต้องได้ AAD ไบต์เดียวกัน')
  assert.throws(() => contentChunkAad(new Uint8Array(15), 0, 1), /aad-content-id-length/)
})

// ── 1. หนึ่งไฟล์เชิงตรรกะ = หนึ่ง DEK สุ่ม ──────────────────────────────────
test('หนึ่งไฟล์ได้ DEK สุ่มของตัวเอง — สองไฟล์ไม่ใช้กุญแจร่วมกัน', async () => {
  const kek = await fakeKek()
  const a = await createVaultV2Envelope(kek, { name: 'a.bin', size: 10, chunkCount: 1 })
  const b = await createVaultV2Envelope(kek, { name: 'b.bin', size: 10, chunkCount: 1 })

  assert.notEqual(a.wrappedDekB64, b.wrappedDekB64, 'DEK ที่ถูกห่อต้องต่างกันต่อไฟล์')
  assert.notEqual(a.contentIdB64, b.contentIdB64, 'ตัวระบุเนื้อหาต้องต่างกันต่อไฟล์')

  // ⚠️ ข้อพิสูจน์ที่แข็งกว่า "ค่าต่างกัน": ciphertext ของไฟล์ B ถอดด้วย DEK ของไฟล์ A ไม่ได้
  const chunkB = await encryptVaultChunk(b.dek, {
    contentId: b.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(10),
  })
  await assert.rejects(
    decryptVaultChunk(a.dek, {
      contentId: b.contentId, chunkIndex: 0, chunkCount: 1,
      ivB64: chunkB.ivB64, ciphertext: chunkB.ciphertext,
    }),
    /chunk-auth-failed/,
  )
})

// ── 2. DEK ออกจากเบราว์เซอร์ไม่ได้ แม้จะอยากส่ง ─────────────────────────────
test('DEK เป็น CryptoKey ที่ export ไม่ได้ — ไม่มีทาง serialize ลง request ใด ๆ', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 1, chunkCount: 1 })

  assert.equal(env.dek.extractable, false)
  await assert.rejects(subtle.exportKey('raw', env.dek), 'กุญแจที่ export ไม่ได้ต้องโยนเสมอ')

  // สิ่งที่ถูกส่งขึ้น server มีเพียงสี่ช่องนี้ และไม่มีช่องไหนเป็น DEK ดิบ
  const wire = {
    contentIdB64: env.contentIdB64,
    wrappedDekB64: env.wrappedDekB64,
    wrapIvB64: env.wrapIvB64,
    metaIvB64: env.metaIvB64,
    metaB64: env.metaB64,
  }
  // DEK ที่ถูกห่อต้องยาวกว่า 32 ไบต์เสมอ (32 + tag 16) — ถ้าเท่ากับ 32 พอดี แปลว่า
  // มีคนส่ง raw DEK มาโดยไม่ได้ห่อ ซึ่งเป็นความล้มเหลวที่ต้องดังทันที
  assert.equal(b64ToBytes(wire.wrappedDekB64).length, 32 + GCM_TAG_BYTES)
  assert.equal(b64ToBytes(wire.wrapIvB64).length, IV_BYTES)
})

// ── 3. round trip ของ chunk ────────────────────────────────────────────────
test('chunk เข้ารหัส/ถอดรหัสกลับได้ตรงทุกไบต์ และ ciphertext = plaintext + 16', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 1024, chunkCount: 1 })
  const plaintext = bytes(1024, 0x5a)

  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext,
  })
  assert.equal(enc.ciphertext.length, plaintext.length + GCM_TAG_BYTES)

  const back = await decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1,
    ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  })
  assert.deepEqual([...back], [...plaintext])
})

test('ไฟล์ว่างยังได้หนึ่ง chunk ที่มี tag ให้ตรวจ ไม่ใช่ศูนย์ chunk', async () => {
  const plan = planVaultChunks(0, 8 * 1024 * 1024)
  assert.equal(plan.chunkCount, 1, 'ไฟล์ 0 ไบต์ต้องมีหนึ่งข้อความ AEAD เสมอ')
  assert.equal(plan.ciphertextSize, GCM_TAG_BYTES)

  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'empty', size: 0, chunkCount: 1 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: new Uint8Array(0),
  })
  assert.equal(enc.ciphertext.length, GCM_TAG_BYTES)
  const back = await decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  })
  assert.equal(back.length, 0)
})

// ── 4–6. ความปลอดภัยของ IV ─────────────────────────────────────────────────
test('ทุกการเข้ารหัสได้ IV ขนาด 96 บิต และไม่มี IV ซ้ำเลยใน 200 ครั้ง', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 4 })
  const seen = new Set()

  for (let i = 0; i < 200; i += 1) {
    const enc = await encryptVaultChunk(env.dek, {
      contentId: env.contentId, chunkIndex: i % 4, chunkCount: 4, plaintext: bytes(16, i & 0xff),
    })
    const iv = b64ToBytes(enc.ivB64)
    assert.equal(iv.length, IV_BYTES, 'IV ของ AES-GCM ต้องเป็น 12 ไบต์ (96 บิต) เสมอ')
    assert.equal(seen.has(enc.ivB64), false, 'IV ต้องไม่ซ้ำภายใต้กุญแจเดียวกัน')
    seen.add(enc.ivB64)
  }
  assert.equal(seen.size, 200)
})

test('การส่งซ้ำได้ IV ใหม่เสมอ — ไม่มีเส้นทางที่ใช้ IV เดิมกับ plaintext ที่ต่างออกไป', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 32, chunkCount: 1 })

  // แบบ A ที่ยอมรับได้: ส่ง ciphertext ก้อนเดิมซ้ำ — IV เดิมคู่กับ plaintext เดิมเสมอ
  const first = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(32, 1),
  })
  const resendIdentical = { ivB64: first.ivB64, ciphertext: first.ciphertext }
  assert.equal(resendIdentical.ivB64, first.ivB64)
  assert.deepEqual([...resendIdentical.ciphertext], [...first.ciphertext])

  // แบบ B ที่โมดูลนี้เลือกใช้: เข้ารหัสก้อนเดิมใหม่ → IV ใหม่เสมอ
  const retry = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(32, 1),
  })
  assert.notEqual(retry.ivB64, first.ivB64, 'การเข้ารหัสรอบใหม่ต้องได้ IV ใหม่')

  // และของต้องห้าม: IV เดิม + plaintext ต่าง — พิสูจน์ว่า API ไม่เปิดช่องให้ทำเลย
  // (ไม่มีพารามิเตอร์ iv ให้ผู้เรียกกำหนด ถ้ามีวันหนึ่งจะมีคนใช้)
  const differentPlaintext = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(32, 2),
  })
  assert.notEqual(differentPlaintext.ivB64, first.ivB64)
  assert.notEqual(differentPlaintext.ivB64, retry.ivB64)
})

// ── 7–13. AAD ผูกตัวตนและตำแหน่ง ───────────────────────────────────────────
test('แก้ chunk index ใน AAD แล้วถอดไม่ผ่าน — ก้อนที่สลับตำแหน่งจึงใช้ไม่ได้', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 4 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 2, chunkCount: 4, plaintext: bytes(16),
  })
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 3, chunkCount: 4, ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  }), /chunk-auth-failed/)
})

test('แก้ chunkCount ใน AAD แล้วถอดไม่ผ่าน — การตัดหางไฟล์ทิ้งจึงถูกจับได้', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 4 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 4, plaintext: bytes(16),
  })
  // ⚠️ ถ้า AAD ผูกแค่ index ก้อนนี้จะยังถอดผ่านในไฟล์ที่ถูกตัดเหลือ 3 ก้อน
  //    ผู้ใช้จะได้ไฟล์ที่สั้นลงโดยไม่มีสัญญาณอะไรเลย
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 3, ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  }), /chunk-auth-failed/)
})

test('แก้ contentId ใน AAD แล้วถอดไม่ผ่าน — ก้อนจากไฟล์อื่นจึงใช้แทนกันไม่ได้', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 2 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 2, plaintext: bytes(16),
  })
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: newContentId(), chunkIndex: 0, chunkCount: 2, ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  }), /chunk-auth-failed/)
})

test('แก้ ciphertext แม้บิตเดียวแล้วถอดไม่ผ่าน', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 1 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(64),
  })
  const tampered = Uint8Array.from(enc.ciphertext)
  tampered[0] ^= 0x01
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, ivB64: enc.ivB64, ciphertext: tampered,
  }), /chunk-auth-failed/)
})

test('DEK ผิดถอดไม่ผ่าน และ IV ผิดก็ถอดไม่ผ่าน', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 64, chunkCount: 1 })
  const other = await createVaultV2Envelope(kek, { name: 'y', size: 64, chunkCount: 1 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: bytes(64),
  })

  await assert.rejects(decryptVaultChunk(other.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  }), /chunk-auth-failed/)

  const wrongIv = bytesToB64(new Uint8Array(IV_BYTES).fill(9))
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, ivB64: wrongIv, ciphertext: enc.ciphertext,
  }), /chunk-auth-failed/)
})

test('การสลับลำดับ chunk ทั้งไฟล์ถูกจับได้ทุกก้อน ไม่ใช่แค่ก้อนแรก', async () => {
  const kek = await fakeKek()
  const chunkCount = 3
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 48, chunkCount })
  const parts = []
  for (let i = 0; i < chunkCount; i += 1) {
    parts.push(await encryptVaultChunk(env.dek, {
      contentId: env.contentId, chunkIndex: i, chunkCount, plaintext: bytes(16, i + 1),
    }))
  }
  // สลับก้อน 0 กับ 2 แล้วถอดตามลำดับที่ควรจะเป็น — ต้องล้มทั้งสองตำแหน่ง
  const swapped = [parts[2], parts[1], parts[0]]
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount, ivB64: swapped[0].ivB64, ciphertext: swapped[0].ciphertext,
  }), /chunk-auth-failed/)
  await assert.rejects(decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 2, chunkCount, ivB64: swapped[2].ivB64, ciphertext: swapped[2].ciphertext,
  }), /chunk-auth-failed/)
  // ก้อนกลางอยู่ตำแหน่งเดิมจึงยังถอดได้ — เทสต์นี้ตั้งใจแสดงว่าการตรวจเป็น "รายก้อน"
  const middle = await decryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 1, chunkCount, ivB64: swapped[1].ivB64, ciphertext: swapped[1].ciphertext,
  })
  assert.deepEqual([...middle], [...bytes(16, 2)])
})

test('chunk จากไฟล์อื่นที่ตำแหน่งเดียวกันยังถอดไม่ผ่าน', async () => {
  const kek = await fakeKek()
  const a = await createVaultV2Envelope(kek, { name: 'a', size: 32, chunkCount: 2 })
  const b = await createVaultV2Envelope(kek, { name: 'b', size: 32, chunkCount: 2 })
  const fromB = await encryptVaultChunk(b.dek, {
    contentId: b.contentId, chunkIndex: 1, chunkCount: 2, plaintext: bytes(16),
  })
  // แม้จะใช้ DEK ของ B ก็ยังผิด เพราะ AAD ที่ผู้ถอดสร้างขึ้นใช้ contentId ของ A
  await assert.rejects(decryptVaultChunk(b.dek, {
    contentId: a.contentId, chunkIndex: 1, chunkCount: 2, ivB64: fromB.ivB64, ciphertext: fromB.ciphertext,
  }), /chunk-auth-failed/)
})

// ── 14. metadata ยังเป็นความลับ ────────────────────────────────────────────
test('ชื่อไฟล์และ MIME ไม่ปรากฏใน envelope ที่ส่งขึ้น server เลย', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, {
    name: 'resignation-letter.pdf', type: 'application/pdf', size: 4096, chunkCount: 1,
  })
  const wire = JSON.stringify({
    contentIdB64: env.contentIdB64, wrappedDekB64: env.wrappedDekB64,
    wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
  })
  assert.equal(wire.includes('resignation'), false)
  assert.equal(wire.includes('pdf'), false)
  // และ base64 ที่ decode แล้วก็ต้องไม่มีชื่อไฟล์ (กันกรณีเข้ารหัสไม่ทำงานจริง)
  assert.equal(Buffer.from(env.metaB64, 'base64').toString('latin1').includes('resignation'), false)

  const back = await decryptVaultV2Meta(kek, {
    wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64,
    metaIvB64: env.metaIvB64, metaB64: env.metaB64,
    contentIdB64: env.contentIdB64, chunkCount: 1,
  })
  assert.deepEqual(back, { name: 'resignation-letter.pdf', type: 'application/pdf', plainSize: 4096 })
})

test('ซอง metadata ของไฟล์หนึ่งถูกนำไปแปะกับอีกไฟล์ไม่ได้ (AAD ผูก contentId + chunkCount)', async () => {
  const kek = await fakeKek()
  const a = await createVaultV2Envelope(kek, { name: 'a.txt', size: 10, chunkCount: 1 })
  const dekA = await unwrapVaultV2Dek(kek, a)

  // contentId ผิด
  await assert.rejects(decryptVaultV2MetaWithDek(dekA, {
    metaIvB64: a.metaIvB64, metaB64: a.metaB64,
    contentIdB64: bytesToB64(newContentId()), chunkCount: 1,
  }), /wrong-key/)

  // chunkCount ผิด
  await assert.rejects(decryptVaultV2MetaWithDek(dekA, {
    metaIvB64: a.metaIvB64, metaB64: a.metaB64,
    contentIdB64: a.contentIdB64, chunkCount: 2,
  }), /wrong-key/)
})

test('KEK ผิดแกะ DEK ไม่ออก และรายงานเป็น wrong-key เหมือนกันทุกสาเหตุ', async () => {
  const kek = await fakeKek(1)
  const wrong = await fakeKek(2)
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 1, chunkCount: 1 })
  await assert.rejects(unwrapVaultV2Dek(wrong, env), /wrong-key/)
})

// ── แผนการแบ่งไฟล์ ─────────────────────────────────────────────────────────
test('แผนการแบ่งไฟล์คำนวณ chunk, ขนาด และ overhead ต่อก้อนได้ถูกต้อง', () => {
  const MIB = 1024 * 1024
  const plan = planVaultChunks(40 * MIB, 16 * MIB)
  assert.equal(plan.chunkCount, 3)
  assert.equal(plan.chunkSize, 16 * MIB + GCM_TAG_BYTES)
  assert.equal(plan.lastChunkSize, 8 * MIB + GCM_TAG_BYTES)
  // ⚠️ overhead คือ 16 ไบต์ "ต่อ chunk" ไม่ใช่ต่อไฟล์ — เป็นจุดที่พลาดกันบ่อยและ
  //    ทำให้การจองพื้นที่ว่างคลาดเคลื่อนสะสมในไฟล์ใหญ่
  assert.equal(plan.ciphertextSize, 40 * MIB + 3 * GCM_TAG_BYTES)

  assert.deepEqual(plaintextRangeFor(0, 40 * MIB, 16 * MIB), { start: 0, end: 16 * MIB })
  assert.deepEqual(plaintextRangeFor(2, 40 * MIB, 16 * MIB), { start: 32 * MIB, end: 40 * MIB })
})

test('ไฟล์เต็มก้อนพอดีไม่สร้าง chunk เปล่าเพิ่ม', () => {
  const plan = planVaultChunks(32, 16)
  assert.equal(plan.chunkCount, 2)
  assert.equal(plan.lastChunkSize, 16 + GCM_TAG_BYTES)
})

// ── ทั้งไฟล์ประกอบกลับได้ตรงไบต์ ───────────────────────────────────────────
test('ไฟล์หลายก้อนเข้ารหัสแล้วประกอบกลับได้ตรงทุกไบต์', async () => {
  const kek = await fakeKek()
  const CHUNK = 1024
  const source = new Uint8Array(CHUNK * 2 + 37)
  globalThis.crypto.getRandomValues(source.subarray(0, 32768))
  for (let i = 32768; i < source.length; i += 1) source[i] = i & 0xff

  const plan = planVaultChunks(source.length, CHUNK)
  const env = await createVaultV2Envelope(kek, {
    name: 'big.bin', type: 'application/octet-stream', size: source.length, chunkCount: plan.chunkCount,
  })

  const wire = []
  for (let i = 0; i < plan.chunkCount; i += 1) {
    const r = plaintextRangeFor(i, source.length, CHUNK)
    wire.push(await encryptVaultChunk(env.dek, {
      contentId: env.contentId, chunkIndex: i, chunkCount: plan.chunkCount,
      plaintext: source.subarray(r.start, r.end),
    }))
  }
  assert.equal(wire.reduce((n, c) => n + c.ciphertext.length, 0), plan.ciphertextSize)

  // ถอดด้วย DEK ที่ "แกะจากซอง" เหมือนเส้นทางดาวน์โหลดจริง ไม่ใช่ตัวที่ถืออยู่แล้ว
  const dek = await unwrapVaultV2Dek(kek, env)
  const out = new Uint8Array(source.length)
  let offset = 0
  for (let i = 0; i < plan.chunkCount; i += 1) {
    const part = await decryptVaultChunk(dek, {
      contentId: env.contentIdB64, chunkIndex: i, chunkCount: plan.chunkCount,
      ivB64: wire[i].ivB64, ciphertext: wire[i].ciphertext,
    })
    out.set(part, offset)
    offset += part.length
  }
  assert.equal(offset, source.length)
  assert.deepEqual(Buffer.from(out).toString('hex'), Buffer.from(source).toString('hex'))
})

test('AAD ที่ประกอบจาก contentId แบบ base64 ให้ผลเดียวกับไบต์ดิบ (เส้นทางดาวน์โหลดใช้แบบ base64)', async () => {
  const kek = await fakeKek()
  const env = await createVaultV2Envelope(kek, { name: 'x', size: 16, chunkCount: 1 })
  const enc = await encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: 0, chunkCount: 1, plaintext: te.encode('hello vault v2!!'),
  })
  const back = await decryptVaultChunk(env.dek, {
    contentId: env.contentIdB64, chunkIndex: 0, chunkCount: 1,
    ivB64: enc.ivB64, ciphertext: enc.ciphertext,
  })
  assert.equal(new TextDecoder().decode(back), 'hello vault v2!!')
})
