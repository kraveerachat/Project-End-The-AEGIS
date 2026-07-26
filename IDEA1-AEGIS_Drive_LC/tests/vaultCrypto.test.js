// tests/vaultCrypto.test.js — AEGIS Drive (IDEA1) · Private Vault, ชั้นการเข้ารหัส
//
// ทดสอบ "โมดูลตัวเดียวกับที่เบราว์เซอร์รันจริง" (src/lib/vaultCrypto.js) ไม่ใช่ของจำลอง —
// เป็นไปได้เพราะโมดูลนั้นใช้ globalThis.crypto (WebCrypto) ซึ่ง Node 20+ มีให้ครบ
//
// สิ่งที่ชุดนี้พิสูจน์:
//   1. passphrase ผิด → ปลดล็อกไม่ได้ (และ error แยกไม่ออกจากกรณี ciphertext ถูกแก้)
//   2. รอบ unlock → lock → unlock ทำงานถูกต้อง
//   3. upload → download ได้ไบต์เดิมเป๊ะ (envelope ครบวงจร)
//   4. envelope ที่จะถูกส่งขึ้น server ไม่มีร่องรอยของ plaintext หรือกุญแจ
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVaultSetup, unlockVault, deriveKek, verifyKek,
  encryptFileEnvelope, decryptBlobMeta, decryptFileContent, unwrapDek,
  b64ToBytes, bytesToB64, ARGON2_DEFAULTS, KEY_BYTES,
} from '../src/lib/vaultCrypto.js'

// พารามิเตอร์เบาสำหรับชุดทดสอบ — พิสูจน์ "ความถูกต้องของกลไก" ไม่ใช่ "ค่าความแข็งแรง"
// (ค่าจริงที่ผู้ใช้ได้คือ ARGON2_DEFAULTS ซึ่งถูกทดสอบแยกด้านล่างหนึ่งเคส)
const FAST = { memorySizeKiB: 8_192, iterations: 2, parallelism: 1 }

const PASS = 'correct-horse-battery-staple'
const WRONG = 'correct-horse-battery-stapl3'

const utf8 = (s) => new TextEncoder().encode(s)

// getRandomValues รับได้ครั้งละ 65536 ไบต์ — เติมทีละก้อนสำหรับ fixture ขนาดใหญ่
function randomFixture(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, n)))
  return out
}

test('ARGON2_DEFAULTS ตรงตามที่ประกาศไว้ในเอกสาร (m=64MiB, t=3, p=1)', () => {
  assert.equal(ARGON2_DEFAULTS.memorySizeKiB, 65_536)
  assert.equal(ARGON2_DEFAULTS.iterations, 3)
  assert.equal(ARGON2_DEFAULTS.parallelism, 1)
  assert.equal(KEY_BYTES, 32) // 256-bit KEK
})

test('setup: salt สุ่มใหม่ทุกครั้ง และ verifier ต่างกันแม้ passphrase เดียวกัน', async () => {
  const a = await createVaultSetup(PASS, FAST)
  const b = await createVaultSetup(PASS, FAST)
  assert.notEqual(a.saltB64, b.saltB64, 'salt ซ้ำ = rainbow table ใช้ได้')
  assert.notEqual(a.verifier.dataB64, b.verifier.dataB64)
  assert.equal(b64ToBytes(a.saltB64).length, 16)
  assert.equal(b64ToBytes(a.verifier.ivB64).length, 12) // GCM IV 12 ไบต์
})

test('passphrase ผิด → ปลดล็อกไม่สำเร็จ (โยน wrong-key)', async () => {
  const { saltB64, params, verifier } = await createVaultSetup(PASS, FAST)
  await assert.rejects(
    () => unlockVault(WRONG, { saltB64, params, verifier }),
    (err) => err.message === 'wrong-key',
    'passphrase ผิดต้องถูกปฏิเสธ',
  )
})

test('passphrase ผิดแม้ต่างกันตัวเดียว ก็ยังถูกปฏิเสธ', async () => {
  const { saltB64, params, verifier } = await createVaultSetup(PASS, FAST)
  for (const bad of [PASS + ' ', ' ' + PASS, PASS.toUpperCase(), PASS.slice(0, -1), '']) {
    await assert.rejects(() => unlockVault(bad, { saltB64, params, verifier }), /wrong-key/)
  }
})

test('salt ที่ถูกสลับ → passphrase ที่ถูกต้องก็เปิดไม่ได้ (กุญแจผูกกับ salt จริง)', async () => {
  const a = await createVaultSetup(PASS, FAST)
  const b = await createVaultSetup(PASS, FAST)
  await assert.rejects(
    () => unlockVault(PASS, { saltB64: b.saltB64, params: a.params, verifier: a.verifier }),
    /wrong-key/,
  )
})

test('passphrase ถูก → ปลดล็อกได้ และวนรอบ unlock/lock/unlock ซ้ำได้', async () => {
  const { saltB64, params, verifier } = await createVaultSetup(PASS, FAST)

  const k1 = await unlockVault(PASS, { saltB64, params, verifier })
  assert.ok(k1, 'ปลดล็อกครั้งแรกต้องได้ KEK')
  assert.equal(k1.extractable, false, 'KEK ต้อง export ไม่ได้ แม้จาก console/XSS')

  // "ล็อก" ในแอปคือทิ้ง reference ของ KEK — จำลองด้วยการลืมตัวแปร แล้วปลดใหม่
  const k2 = await unlockVault(PASS, { saltB64, params, verifier })
  assert.ok(await verifyKek(k2, verifier), 'ปลดล็อกรอบสองต้องได้ KEK ที่ใช้งานได้จริง')

  // KEK จาก passphrase+salt เดิม ต้องใช้แทนกันได้ (deterministic derivation)
  const env = await encryptFileEnvelope(k1, { name: 'a.txt', size: 3, bytes: utf8('abc') })
  const meta = await decryptBlobMeta(k2, env)
  assert.equal(meta.name, 'a.txt', 'KEK รอบสองต้องถอดของที่รอบแรกเข้ารหัสไว้ได้')
})

test('upload → download: ไบต์ที่ได้กลับมาเหมือนต้นฉบับทุกไบต์', async () => {
  const { kek } = await createVaultSetup(PASS, FAST)

  // ครอบคลุมทั้งข้อความ, ไบนารีสุ่ม, ไฟล์ว่าง และไฟล์ที่ใหญ่กว่า chunk ของ base64 helper
  const cases = [
    { name: 'notes.txt', bytes: utf8('สวัสดี AEGIS — mixed ascii/ไทย/emoji 🔐') },
    { name: 'empty.bin', bytes: new Uint8Array(0) },
    { name: 'random.bin', bytes: randomFixture(4096) },
    { name: 'big.bin', bytes: randomFixture(200_000) }, // > CHUNK (32768) ของ base64 helper
  ]

  for (const c of cases) {
    const env = await encryptFileEnvelope(kek, { name: c.name, type: 'application/octet-stream', size: c.bytes.length, bytes: c.bytes })

    // สิ่งที่ "เดินทางกลับมาจาก server" คือ ciphertext + envelope metadata
    const roundTripped = await decryptFileContent(kek, env, env.ciphertext)
    assert.deepEqual(roundTripped, c.bytes, `round trip เพี้ยนที่ ${c.name}`)

    const meta = await decryptBlobMeta(kek, env)
    assert.equal(meta.name, c.name)
    assert.equal(meta.size, c.bytes.length)
  }
})

test('envelope: DEK ต่างกันทุกไฟล์ และ IV ไม่ซ้ำ', async () => {
  const { kek } = await createVaultSetup(PASS, FAST)
  const bytes = utf8('same content every time')

  const envs = []
  for (let i = 0; i < 5; i++) {
    envs.push(await encryptFileEnvelope(kek, { name: 'same.txt', size: bytes.length, bytes }))
  }

  const ivs = new Set(envs.map((e) => e.ivB64))
  const wrapIvs = new Set(envs.map((e) => e.wrapIvB64))
  const wrapped = new Set(envs.map((e) => e.wrappedDekB64))
  const cts = new Set(envs.map((e) => bytesToB64(e.ciphertext)))

  assert.equal(ivs.size, 5, 'IV ซ้ำกับกุญแจเดิม = ทำลายความปลอดภัยของ GCM')
  assert.equal(wrapIvs.size, 5)
  assert.equal(wrapped.size, 5, 'DEK ต้องสุ่มใหม่ต่อไฟล์')
  assert.equal(cts.size, 5, 'เนื้อเดียวกันต้องได้ ciphertext ต่างกัน (ไม่มี deterministic leak)')
})

test('envelope: wrapped DEK เป็นขนาดที่ถูกต้อง และแกะได้ด้วย KEK เท่านั้น', async () => {
  const setupA = await createVaultSetup(PASS, FAST)
  const setupB = await createVaultSetup('a-completely-different-key', FAST)

  const env = await encryptFileEnvelope(setupA.kek, { name: 'x', size: 1, bytes: utf8('x') })

  // 32 ไบต์ DEK + 16 ไบต์ GCM tag = 48
  assert.equal(b64ToBytes(env.wrappedDekB64).length, KEY_BYTES + 16)

  assert.ok(await unwrapDek(setupA.kek, env), 'KEK ที่ถูกต้องต้องแกะ DEK ได้')
  await assert.rejects(() => unwrapDek(setupB.kek, env), /wrong-key/, 'KEK คนอื่นต้องแกะไม่ได้')
  await assert.rejects(() => decryptFileContent(setupB.kek, env, env.ciphertext), /wrong-key/)
})

test('GCM integrity: ciphertext ที่ถูกแก้แม้บิตเดียว → ถอดไม่ผ่าน (ไม่คืนข้อมูลเพี้ยน)', async () => {
  const { kek } = await createVaultSetup(PASS, FAST)
  const bytes = utf8('integrity matters')
  const env = await encryptFileEnvelope(kek, { name: 'i.txt', size: bytes.length, bytes })

  const tampered = Uint8Array.from(env.ciphertext)
  tampered[0] ^= 0x01 // พลิกหนึ่งบิต
  await assert.rejects(() => decryptFileContent(kek, env, tampered), /wrong-key/)

  // แก้ metadata ก็ต้องจับได้เช่นกัน
  const badMeta = b64ToBytes(env.metaB64)
  badMeta[0] ^= 0x01
  await assert.rejects(
    () => decryptBlobMeta(kek, { ...env, metaB64: bytesToB64(badMeta) }),
    /wrong-key/,
  )
})

test('ไม่มี plaintext หรือกุญแจหลงอยู่ในสิ่งที่จะถูกส่งขึ้น server', async () => {
  const secretName = 'resignation-letter-FINAL.pdf'
  const secretBody = 'Dear board, effective immediately I resign. — Veerachat'
  const { kek, saltB64, verifier } = await createVaultSetup(PASS, FAST)

  const env = await encryptFileEnvelope(kek, {
    name: secretName, type: 'application/pdf',
    size: utf8(secretBody).length, bytes: utf8(secretBody),
  })

  // ทุกอย่างที่ออกจากเบราว์เซอร์ รวมเป็นสายอักขระเดียวแล้วค้นหาความลับในนั้น
  const onTheWire = JSON.stringify({
    saltB64, verifier,
    ivB64: env.ivB64, wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64,
    metaIvB64: env.metaIvB64, metaB64: env.metaB64,
    ciphertext: bytesToB64(env.ciphertext),
  })

  for (const secret of [PASS, secretName, secretBody, 'resignation', 'Veerachat', 'pdf']) {
    assert.equal(onTheWire.includes(secret), false, `พบ "${secret}" ใน payload ที่ส่งขึ้น server`)
  }

  // เนื้อไฟล์ในรูป raw bytes ก็ต้องไม่โผล่ใน ciphertext
  const ctText = Buffer.from(env.ciphertext).toString('latin1')
  assert.equal(ctText.includes('resign'), false)

  // ขนาด ciphertext = ขนาด plaintext + 16 (GCM tag) — ยืนยันว่าไม่มี header/metadata
  // ที่เป็น plaintext แนบมาด้วย
  assert.equal(env.ciphertext.length, utf8(secretBody).length + 16)
})

test('deriveKek กับพารามิเตอร์จริง (m=64MiB) ทำงานได้และคืนกุญแจที่ใช้ได้', async () => {
  // เคสเดียวที่ใช้ค่าจริง — ยืนยันว่าค่าที่ผู้ใช้ได้รับจริงไม่ได้พังหรือช้าจนใช้ไม่ได้
  const t0 = Date.now()
  const setup = await createVaultSetup(PASS) // ← ไม่ส่ง params = ใช้ ARGON2_DEFAULTS
  const kek = await deriveKek(PASS, setup.saltB64, setup.params)
  const elapsed = Date.now() - t0

  assert.ok(await verifyKek(kek, setup.verifier))
  // เพดานหลวม ๆ กัน regression ที่ทำให้ derive ช้าจนผู้ใช้ทิ้งจอไป (2 derive ในนี้)
  assert.ok(elapsed < 30_000, `derive ช้าเกินไป: ${elapsed}ms`)
})
