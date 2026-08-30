// tests/vaultPreviewResponder.test.js — AEGIS Drive (IDEA1) · เส้นทาง preview ทั้งเส้น (LFT-V2-E3)
//
// ⚠️ ชุดนี้รันการเข้ารหัส/ถอดรหัสของจริง (vaultChunkCrypto.js) และแทนที่เฉพาะ "ขาเครือข่าย"
//    เหมือนแบบแผนของ vaultChunkedUploadClient.test.js — สิ่งที่พิสูจน์จึงเป็นพฤติกรรมจริง
//    ของโค้ดที่ผู้ใช้รัน ไม่ใช่พฤติกรรมของ mock
//
// ⚠️ สามข้อที่สำคัญที่สุดของไฟล์นี้:
//    1. **ดึงเฉพาะก้อนที่จำเป็น** — เปิด preview วิดีโอใหญ่ต้องไม่กลายเป็นการดาวน์โหลด
//       ทั้งไฟล์เงียบ ๆ เทสต์จึงนับ URL ที่ถูกเรียกจริงทุกครั้ง
//    2. **tag ไม่ผ่าน = ไม่มีไบต์ออกไปเลย** ไม่ข้ามก้อน ไม่ส่งของที่เหลือ
//    3. **ไม่มีจุดใดประกอบ plaintext ทั้งไฟล์** แม้กับคำขอที่ไม่มี Range
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, GCM_TAG_BYTES,
} from '../src/lib/vaultChunkCrypto.js'
import { bytesToB64 } from '../src/lib/vaultCrypto.js'
import {
  planPreviewResponse, createPreviewStream, readPlainChunk,
  chunkUrlFor, PREVIEW_FAILURE,
} from '../src/lib/vaultPreviewResponder.js'

const subtle = globalThis.crypto.subtle
const CHUNK = 1024                    // เล็กเพื่อให้เทสต์เร็ว — ตรรกะไม่ต่างจาก 32 MiB
const BASE = '/drive/'

const fakeKek = (seed = 5) =>
  subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

const sourceBytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) & 0xff
  return b
}

/**
 * สร้าง blob V2 ของจริงหนึ่งใบ พร้อม "เซิร์ฟเวอร์" ที่เสิร์ฟ ciphertext ของมัน
 * @returns {{ session, plain, fetchImpl, fetched: () => string[], corrupt, swap }}
 */
async function makeVaultBlob({ plainSize = CHUNK * 4 + 100, id = 'b'.repeat(48), seed = 5, type = 'video/mp4' } = {}) {
  const kek = await fakeKek(seed)
  const plain = sourceBytes(plainSize)
  const plan = planVaultChunks(plainSize, CHUNK)
  const envelope = await createVaultV2Envelope(kek, {
    name: 'clip.mp4', type, size: plainSize, chunkCount: plan.chunkCount,
  })

  // เข้ารหัสทุกก้อนด้วยกติกาเดียวกับเส้นทางอัปโหลดจริง
  const stored = new Map()
  for (let i = 0; i < plan.chunkCount; i += 1) {
    const start = i * CHUNK
    const slice = plain.subarray(start, Math.min(start + CHUNK, plainSize))
    const enc = await encryptVaultChunk(envelope.dek, {
      contentId: envelope.contentId, chunkIndex: i, chunkCount: plan.chunkCount, plaintext: slice,
    })
    stored.set(i, { ciphertext: enc.ciphertext, ivB64: enc.ivB64 })
  }

  const blob = {
    id,
    contentIdB64: envelope.contentIdB64,
    chunkSize: plan.chunkSize,          // ciphertext ของก้อนเต็ม
    chunkCount: plan.chunkCount,
  }
  const session = { dek: envelope.dek, blob, contentType: type, plainSize }

  const fetched = []
  const fetchImpl = async (url) => {
    fetched.push(url)
    const index = Number(String(url).split('/').pop())
    const entry = stored.get(index)
    if (!entry) return { ok: false, status: 404, headers: { get: () => null } }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? entry.ivB64 : null) },
      arrayBuffer: async () => entry.ciphertext.buffer.slice(
        entry.ciphertext.byteOffset, entry.ciphertext.byteOffset + entry.ciphertext.byteLength,
      ),
    }
  }

  return {
    session, plain, plan, stored, envelope, fetchImpl,
    fetched: () => [...fetched],
    resetFetched: () => { fetched.length = 0 },
  }
}

/** อ่านสตรีมจนจบ แล้วต่อเป็นไบต์ชุดเดียว (เฉพาะในเทสต์ — โค้ดจริงไม่ทำแบบนี้) */
async function drain(stream) {
  const reader = stream.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const streamFor = (fixture, plan, onFailure) => createPreviewStream(fixture.session, plan, {
  fetchImpl: fixture.fetchImpl, base: BASE, onFailure,
})

// ── header และสถานะ ────────────────────────────────────────────────────────
test('คำขอแบบมี Range ตอบ 206 พร้อม header ครบและถูกต้องทุกตัว', async () => {
  const fx = await makeVaultBlob({ plainSize: 4196 })
  const res = planPreviewResponse(fx.session, { rangeHeader: 'bytes=100-199' })

  assert.equal(res.status, 206)
  assert.equal(res.headers['Content-Type'], 'video/mp4')
  assert.equal(res.headers['Content-Length'], '100')
  assert.equal(res.headers['Content-Range'], 'bytes 100-199/4196')
  assert.equal(res.headers['Accept-Ranges'], 'bytes')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.streamable, true)
})

test('คำขอที่ไม่มี Range ตอบ 200 และยังต้องเป็นแผนแบบสตรีม ไม่ใช่ก้อนเดียว', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 4 + 100 })
  const res = planPreviewResponse(fx.session, { rangeHeader: null })

  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Length'], String(CHUNK * 4 + 100))
  assert.equal(res.headers['Content-Range'], undefined)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  // ★ แผนมีหลายก้อน = ไบต์จะถูกปล่อยทีละก้อน ไม่ใช่ประกอบทั้งไฟล์ก่อนส่ง
  assert.equal(res.plan.length, 5)
  assert.equal(res.streamable, true)
})

test('ช่วงที่ชี้นอกไฟล์ตอบ 416 พร้อม Content-Range แบบ */total', async () => {
  const fx = await makeVaultBlob({ plainSize: 500 })
  const res = planPreviewResponse(fx.session, { rangeHeader: 'bytes=9000-9100' })

  assert.equal(res.status, 416)
  assert.equal(res.headers['Content-Range'], 'bytes */500')
  assert.equal(res.streamable, false)
  assert.equal(res.plan, null)
})

test('HEAD ได้ header ครบแต่ไม่มีไบต์ และเมธอดอื่นถูกปฏิเสธ', async () => {
  const fx = await makeVaultBlob({ plainSize: 500 })

  const head = planPreviewResponse(fx.session, { method: 'HEAD', rangeHeader: null })
  assert.equal(head.status, 200)
  assert.equal(head.headers['Content-Length'], '500')
  assert.equal(head.streamable, false)
  assert.deepEqual(head.plan, [])

  const post = planPreviewResponse(fx.session, { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.streamable, false)
})

// ── ไบต์ที่ส่งออกไปถูกต้องจริง ────────────────────────────────────────────
test('ไบต์ที่ถอดได้ตรงกับต้นฉบับเป๊ะสำหรับทุกช่วงที่สำคัญ', async () => {
  const plainSize = CHUNK * 3 + 250
  const fx = await makeVaultBlob({ plainSize })

  const cases = [
    ['ไบต์แรก', 0, 0],
    ['กลางก้อนเดียว', CHUNK + 10, CHUNK + 109],
    ['คร่อมสองก้อน', CHUNK - 5, CHUNK + 4],
    ['ก้อนสุดท้ายทั้งก้อน', CHUNK * 3, plainSize - 1],
    ['ไบต์สุดท้าย', plainSize - 1, plainSize - 1],
    ['ทั้งไฟล์', 0, plainSize - 1],
  ]

  for (const [label, start, end] of cases) {
    const res = planPreviewResponse(fx.session, { rangeHeader: `bytes=${start}-${end}` })
    const bytes = await drain(streamFor(fx, res.plan))
    assert.deepEqual(bytes, fx.plain.subarray(start, end + 1), `ช่วง "${label}" ไม่ตรงต้นฉบับ`)
    assert.equal(bytes.length, Number(res.headers['Content-Length']),
      `ช่วง "${label}": จำนวนไบต์จริงต้องตรงกับ Content-Length ที่ประกาศไว้`)
  }
})

// ── ดึงเฉพาะก้อนที่จำเป็น — เหตุผลทั้งหมดของงานนี้ ────────────────────────
test('เปิด preview แล้วขอช่วงเล็ก ๆ ต้องดึงแค่ก้อนที่เกี่ยวข้อง ไม่ใช่ทั้งไฟล์', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 20 })   // 20 ก้อน

  const res = planPreviewResponse(fx.session, { rangeHeader: `bytes=${CHUNK * 7 + 50}-${CHUNK * 7 + 149}` })
  await drain(streamFor(fx, res.plan))

  const urls = fx.fetched()
  assert.equal(urls.length, 1, `ต้องดึงก้อนเดียว แต่ดึงไป ${urls.length} ก้อน`)
  assert.equal(urls[0], chunkUrlFor(BASE, fx.session.blob.id, 7))
})

test('ช่วงที่คร่อมสองก้อนดึงสองก้อนพอดี ไม่ใช่สามหรือทั้งไฟล์', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 20 })

  const res = planPreviewResponse(fx.session, { rangeHeader: `bytes=${CHUNK * 5 - 3}-${CHUNK * 5 + 2}` })
  await drain(streamFor(fx, res.plan))

  assert.deepEqual(fx.fetched(), [
    chunkUrlFor(BASE, fx.session.blob.id, 4),
    chunkUrlFor(BASE, fx.session.blob.id, 5),
  ])
})

test('การวางแผนคำตอบเพียงอย่างเดียวไม่ทำให้เกิดคำขอเครือข่ายเลย', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 20 })
  // ★ เปิดกล่อง preview = สร้างแผน ยังไม่ใช่การดาวน์โหลด ผู้เล่นเป็นคนขอไบต์เอง
  planPreviewResponse(fx.session, { rangeHeader: 'bytes=0-99' })
  planPreviewResponse(fx.session, { rangeHeader: null })
  assert.deepEqual(fx.fetched(), [], 'ยังไม่มีการอ่านสตรีม = ต้องไม่มีคำขอใดถูกยิงออกไป')
})

test('ยกเลิกสตรีมกลางคันหยุดดึงก้อนที่เหลือทันที', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 20 })
  const res = planPreviewResponse(fx.session, { rangeHeader: null })
  const stream = streamFor(fx, res.plan)

  const reader = stream.getReader()
  await reader.read()          // ก้อนแรก
  await reader.cancel()        // ผู้ใช้กระโดดไปตำแหน่งอื่น / ปิดวิดีโอ

  const after = fx.fetched().length
  assert.ok(after <= 2, `หลังยกเลิกต้องไม่ไล่ดึงต่อ แต่ดึงไป ${after} ก้อนจาก 20`)
})

// ── ความถูกต้องเชิงเข้ารหัส ────────────────────────────────────────────────
test('ไบต์ที่ถูกแก้ = หยุดส่งทันที ไม่มี plaintext หลุดออกไป และรายงานสาเหตุตามจริง', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 4 })
  // แก้หนึ่งไบต์ในก้อนที่ 2 (พลิกบิต ไม่ใช่เขียนค่าคงที่ทับ ซึ่งอาจไม่เปลี่ยนอะไร)
  const target = fx.stored.get(2)
  target.ciphertext[5] ^= 0xff

  const reasons = []
  const res = planPreviewResponse(fx.session, { rangeHeader: null })
  const stream = streamFor(fx, res.plan, (r) => reasons.push(r))

  await assert.rejects(drain(stream), /chunk auth failed/)
  assert.deepEqual(reasons, [PREVIEW_FAILURE.INTEGRITY])
})

test('ก้อนที่ถูกสลับตำแหน่งภายในไฟล์เดียวกันก็ยังถอดไม่ผ่าน (AAD ผูก index ไว้)', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 4 })
  const a = fx.stored.get(1)
  const b = fx.stored.get(2)
  fx.stored.set(1, b)
  fx.stored.set(2, a)

  const reasons = []
  const res = planPreviewResponse(fx.session, { rangeHeader: `bytes=${CHUNK}-${CHUNK + 10}` })
  await assert.rejects(drain(streamFor(fx, res.plan, (r) => reasons.push(r))))
  assert.deepEqual(reasons, [PREVIEW_FAILURE.INTEGRITY])
})

test('ก้อนจากไฟล์อื่นถอดไม่ผ่าน แม้ทุกอย่างอื่นจะถูกต้อง (AAD ผูก contentId ไว้)', async () => {
  const mine = await makeVaultBlob({ plainSize: CHUNK * 4, id: 'a'.repeat(48) })
  const other = await makeVaultBlob({ plainSize: CHUNK * 4, id: 'c'.repeat(48), seed: 9 })

  // ก้อนของไฟล์อื่น ถูกวางไว้ที่ตำแหน่งเดียวกันของไฟล์นี้
  mine.stored.set(1, other.stored.get(1))

  const reasons = []
  const res = planPreviewResponse(mine.session, { rangeHeader: `bytes=${CHUNK}-${CHUNK + 10}` })
  await assert.rejects(drain(streamFor(mine, res.plan, (r) => reasons.push(r))))
  assert.deepEqual(reasons, [PREVIEW_FAILURE.INTEGRITY])
})

test('ก้อนที่ขาด IV header ถูกปฏิเสธ ไม่ใช่เดา IV เอง', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 2 })
  const noIvFetch = async (url) => {
    const res = await fx.fetchImpl(url)
    return { ...res, headers: { get: () => null } }
  }

  await assert.rejects(
    readPlainChunk(fx.session, 0, { fetchImpl: noIvFetch, base: BASE }),
    (err) => err.previewFailure === PREVIEW_FAILURE.MISSING_IV,
  )
})

test('คำขอก้อนที่ล้มเหลวถูกรายงานเป็น fetch ไม่ใช่ integrity — สองเรื่องนี้ต่างกัน', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 2 })
  const failing = async () => ({ ok: false, status: 503, headers: { get: () => null } })

  await assert.rejects(
    readPlainChunk(fx.session, 0, { fetchImpl: failing, base: BASE }),
    (err) => err.previewFailure === PREVIEW_FAILURE.FETCH,
  )
})

test('ก้อนที่ถอดผ่านแต่ขนาดผิดถูกปฏิเสธ — GCM ไม่ได้รับรองความยาวที่ถูกต้องของไฟล์', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 3 })
  // อ้างว่าไฟล์สั้นกว่าความจริง → ก้อนสุดท้ายที่ถอดได้จะยาวกว่าที่แผนของไฟล์นี้อนุญาต
  // (ก้อนนั้นถอดผ่านทุกประการ tag ถูก AAD ถูก — สิ่งที่ผิดคือ "ความยาว" เท่านั้น)
  const lying = { ...fx.session, plainSize: CHUNK * 2 + 500 }

  await assert.rejects(
    readPlainChunk(lying, 2, { fetchImpl: fx.fetchImpl, base: BASE }),
    (err) => err.previewFailure === PREVIEW_FAILURE.SIZE_MISMATCH,
  )
})

// ── หน่วยความจำ ────────────────────────────────────────────────────────────
test('สตรีมปล่อยไบต์ทีละก้อน — ไม่มีจังหวะใดที่ทั้งไฟล์อยู่ในมือพร้อมกัน', async () => {
  const CHUNKS = 12
  const fx = await makeVaultBlob({ plainSize: CHUNK * CHUNKS })
  const res = planPreviewResponse(fx.session, { rangeHeader: null })
  const reader = streamFor(fx, res.plan).getReader()

  let largestPiece = 0
  let pieces = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pieces += 1
    largestPiece = Math.max(largestPiece, value.length)
    // ★ ณ จุดนี้ ผู้ดึงถือไบต์ของ "หนึ่งก้อน" เท่านั้น ไม่ใช่สะสมไว้ทั้งหมด
    assert.ok(value.length <= CHUNK, `ชิ้นเดียวใหญ่เกินหนึ่งก้อน: ${value.length}`)
  }

  assert.equal(pieces, CHUNKS, 'ต้องปล่อยทีละก้อน ไม่ใช่ก้อนเดียวรวด')
  assert.ok(largestPiece <= CHUNK)
  assert.ok(largestPiece < CHUNK * CHUNKS, 'ไม่มีชิ้นใดมีขนาดเท่าทั้งไฟล์')
})

test('ขนาด ciphertext ต่อก้อนสอดคล้องกับ plaintext บวก tag เสมอ', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 2 + 77 })
  assert.equal(fx.session.blob.chunkSize, CHUNK + GCM_TAG_BYTES)
  assert.equal(fx.stored.get(0).ciphertext.length, CHUNK + GCM_TAG_BYTES)
  assert.equal(fx.stored.get(2).ciphertext.length, 77 + GCM_TAG_BYTES)
})

test('URL ของก้อนถูกสร้างจาก base ของ worker และ id ถูก encode', () => {
  assert.equal(chunkUrlFor('/drive/', 'abc', 3), '/drive/api/vault/blobs/abc/chunks/3')
  assert.equal(chunkUrlFor('/', 'a b', 0), '/api/vault/blobs/a%20b/chunks/0')
})

test('IV ของทุกก้อนต่างกัน — สมบัติที่เส้นทาง preview พึ่งพาแต่ไม่ได้เป็นคนสร้าง', async () => {
  const fx = await makeVaultBlob({ plainSize: CHUNK * 6 })
  const ivs = [...fx.stored.values()].map((c) => c.ivB64)
  assert.equal(new Set(ivs).size, ivs.length)
  assert.equal(bytesToB64(new Uint8Array(12)).length, ivs[0].length)
})

test('completed response diagnostics report delivered plaintext throughput without sensitive content', async () => {
  const diagnostics = []
  const times = [1_000, 2_000]
  const stream = createPreviewStream(
    { dek: {}, blob: {}, plainSize: 2_000_000, contentType: 'video/mp4' },
    [{ index: 4, sliceStart: 0, sliceEnd: 2_000_000 }],
    {
      readChunk: async () => new Uint8Array(2_000_000),
      onDiagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
      now: () => times.shift(),
    },
  )
  await drain(stream)

  assert.deepEqual(diagnostics, [{
    event: 'response-complete',
    responseDurationMs: 1_000,
    plaintextBytes: 2_000_000,
    effectivePlaintextMBps: 2,
  }])
})
