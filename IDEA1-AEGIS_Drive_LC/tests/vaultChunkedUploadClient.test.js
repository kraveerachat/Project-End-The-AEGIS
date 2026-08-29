// tests/vaultChunkedUploadClient.test.js — AEGIS Drive (IDEA1) · ตัวขับอัปโหลด Vault V2
//
// ⚠️ ชุดนี้รันโมดูลตัวจริง (vaultChunkedUpload.js + vaultChunkCrypto.js) โดยแทนที่เฉพาะ
//    "ขาเครือข่าย" เท่านั้น — การเข้ารหัสทุกก้อนเป็นของจริง จึงยืนยันได้ทั้งพฤติกรรมของ
//    โปรโตคอลและคุณสมบัติของ ciphertext ที่ถูกส่งออกไปจริง ๆ
//
// ⚠️ ข้อพิสูจน์ที่สำคัญที่สุดของไฟล์นี้คือ **ไฟล์ที่ arrayBuffer() ทั้งก้อนโยน error
//    ยังอัปโหลดสำเร็จ** นั่นคือวิธีเดียวที่จะพิสูจน์ว่า "ไม่ได้อ่านทั้งไฟล์เข้าหน่วยความจำ"
//    ได้อย่างแท้จริง — การอ่านโค้ดแล้วเชื่อว่าไม่มีใครเรียกนั้นพังทันทีที่มีคนเพิ่มบรรทัด
import test from 'node:test'
import assert from 'node:assert/strict'

import { uploadVaultFileChunked, cancelVaultUploadSession } from '../src/lib/vaultChunkedUpload.js'
import { decryptVaultChunk, unwrapVaultV2Dek, planVaultChunks, GCM_TAG_BYTES } from '../src/lib/vaultChunkCrypto.js'
import { b64ToBytes } from '../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
const CHUNK = 1024 // เล็กเพื่อให้เทสต์เร็ว — ตรรกะของขนาดไม่ต่างจาก 16 MiB

async function fakeKek(seed = 3) {
  return subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * ไฟล์ที่ "อ่านทั้งก้อนไม่ได้" — arrayBuffer() ของทั้งไฟล์โยนทันที
 * ⚠️ นี่คือกับดักโดยเจตนา: ถ้าวันหนึ่งมีใครเพิ่ม file.arrayBuffer() หรือเรียก
 *    fileToBytes() ของ V1 เข้ามาในเส้นทาง V2 เทสต์ทุกตัวในไฟล์นี้จะล้มทันที
 */
function hostileFile(bytes, { name = 'big.bin', type = 'application/octet-stream' } = {}) {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer() {
      throw new Error('whole-file arrayBuffer() must never be called on the V2 upload path')
    },
    slice(start, end) {
      const part = bytes.subarray(start, end)
      return {
        size: part.length,
        async arrayBuffer() {
          return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        },
      }
    },
  }
}

/** เซิร์ฟเวอร์จำลองที่จำทุกอย่างที่ได้รับ — เพื่อให้ยืนยัน "สิ่งที่ส่งออกไปจริง" ได้ */
function fakeServer({ chunkFailures = new Map(), sessionResponse } = {}) {
  const state = {
    session: null,
    chunks: new Map(),     // index → { ciphertext, ivB64 }
    putLog: [],            // ทุกครั้งที่ PUT ถูกเรียก (รวมครั้งที่ล้มเหลว)
    sliceRanges: [],
    committed: false,
    createBody: null,
  }

  const fetchJson = async (path, opts = {}) => {
    if (path === '/api/vault/uploads' && opts.method === 'POST') {
      if (sessionResponse) return sessionResponse
      state.createBody = opts.body
      state.session = {
        uploadId: 'a'.repeat(48),
        formatVersion: 2,
        contentIdB64: opts.body.contentIdB64,
        ciphertextSize: opts.body.ciphertextSize,
        chunkSize: opts.body.chunkSize,
        chunkCount: opts.body.chunkCount,
        status: 'open',
        expiresAt: Date.now() + 3_600_000,
        received: [],
        missing: [...Array(opts.body.chunkCount).keys()],
        receivedBytes: 0,
      }
      return { ok: true, status: 201, data: { upload: view() }, errorKind: null }
    }
    if (/\/commit$/.test(path)) {
      if (view().missing.length > 0) {
        return { ok: false, status: 409, data: { code: 'UPLOAD_INCOMPLETE', upload: view() }, errorKind: 'server' }
      }
      state.committed = true
      return { ok: true, status: 201, data: { blob: { id: 'b'.repeat(48), formatVersion: 2 } }, errorKind: null }
    }
    if (opts.method === 'DELETE') return { ok: true, status: 200, data: { ok: true }, errorKind: null }
    // GET status (resume)
    return { ok: true, status: 200, data: { upload: view() }, errorKind: null }
  }

  function view() {
    const received = [...state.chunks.keys()].sort((a, b) => a - b)
    const missing = []
    for (let i = 0; i < state.session.chunkCount; i += 1) if (!state.chunks.has(i)) missing.push(i)
    return { ...state.session, received, missing, receivedBytes: received.reduce((n, i) => n + state.chunks.get(i).ciphertext.length, 0) }
  }

  const sendUpload = async (path, opts = {}) => {
    const index = Number(path.split('/').pop())
    const ivB64 = opts.headers['X-Vault-Chunk-IV']
    const ciphertext = new Uint8Array(await opts.body.arrayBuffer())
    state.putLog.push({ index, ivB64, size: ciphertext.length })

    const remaining = chunkFailures.get(index) ?? 0
    if (remaining > 0) {
      chunkFailures.set(index, remaining - 1)
      return { ok: false, status: 0, data: null, errorKind: 'network' }
    }
    state.chunks.set(index, { ciphertext, ivB64 })
    opts.onProgress?.({ loadedBytes: ciphertext.length, totalBytes: ciphertext.length, percent: 100 })
    return { ok: true, status: 200, data: { index, size: ciphertext.length, upload: view() }, errorKind: null }
  }

  return { state, fetchJson, sendUpload, view }
}

const sourceBytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 7 + 13) & 0xff
  return b
}

// ── ข้อพิสูจน์หลัก ─────────────────────────────────────────────────────────
test('ไฟล์ที่ arrayBuffer() ทั้งก้อนโยน error ยังอัปโหลด V2 สำเร็จครบทุกก้อน', async () => {
  const kek = await fakeKek()
  const src = sourceBytes(CHUNK * 3 + 111)
  const file = hostileFile(src)
  const srv = fakeServer()

  const stages = []
  const res = await uploadVaultFileChunked({
    kek, file, plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
    onStage: (s) => stages.push(s),
  })

  assert.equal(res.ok, true, res.reason)
  assert.equal(srv.state.committed, true)
  const plan = planVaultChunks(src.length, CHUNK)
  assert.equal(srv.state.chunks.size, plan.chunkCount)
  assert.deepEqual(stages.at(-1), 'complete')
  // สถานะที่ผู้ใช้เห็นต้องเดินผ่านทั้งการเข้ารหัสและการส่ง ไม่ใช่กระโดดจาก preparing ไป complete
  assert.ok(stages.includes('encrypting'))
  assert.ok(stages.includes('uploading'))
  assert.ok(stages.includes('committing'))
})

test('ทุกก้อนที่ส่งออกไปถอดกลับได้ตรงไบต์ ด้วย DEK ที่แกะจากซองเท่านั้น', async () => {
  const kek = await fakeKek()
  const src = sourceBytes(CHUNK * 2 + 5)
  const srv = fakeServer()

  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(src), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)

  const body = srv.state.createBody
  const dek = await unwrapVaultV2Dek(kek, body)
  const out = new Uint8Array(src.length)
  let offset = 0
  for (let i = 0; i < body.chunkCount; i += 1) {
    const c = srv.state.chunks.get(i)
    const part = await decryptVaultChunk(dek, {
      contentId: body.contentIdB64, chunkIndex: i, chunkCount: body.chunkCount,
      ivB64: c.ivB64, ciphertext: c.ciphertext,
    })
    out.set(part, offset)
    offset += part.length
  }
  assert.equal(offset, src.length)
  assert.deepEqual(Buffer.from(out).toString('hex'), Buffer.from(src).toString('hex'))
})

test('ขนาดที่ประกาศตอนเปิด session ตรงกับ ciphertext ที่ส่งจริงทุกก้อน', async () => {
  const kek = await fakeKek()
  const src = sourceBytes(CHUNK * 2 + 7)
  const srv = fakeServer()
  await uploadVaultFileChunked({
    kek, file: hostileFile(src), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  const body = srv.state.createBody
  const total = [...srv.state.chunks.values()].reduce((n, c) => n + c.ciphertext.length, 0)
  assert.equal(total, body.ciphertextSize)
  assert.equal(body.chunkSize, CHUNK + GCM_TAG_BYTES)
  // ⚠️ ก้อนที่ไม่ใช่ก้อนสุดท้ายต้องมีขนาดเท่ากันเป๊ะ — เซิร์ฟเวอร์คำนวณตำแหน่งบนดิสก์
  //    จากสมมติฐานนี้ ถ้าผิดแม้ก้อนเดียว ไฟล์จะประกอบผิดโดยไม่มีใครรู้
  for (let i = 0; i < body.chunkCount - 1; i += 1) {
    assert.equal(srv.state.chunks.get(i).ciphertext.length, body.chunkSize)
  }
})

test('ไม่มีชื่อไฟล์หรือ MIME อยู่ในสิ่งที่ถูกส่งขึ้น server เลย', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  await uploadVaultFileChunked({
    kek,
    file: hostileFile(sourceBytes(64), { name: 'payroll-2026.xlsx', type: 'application/vnd.ms-excel' }),
    plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  const wire = JSON.stringify(srv.state.createBody)
  assert.equal(wire.includes('payroll'), false)
  assert.equal(wire.includes('xlsx'), false)
  assert.equal(wire.includes('excel'), false)
  assert.equal('name' in srv.state.createBody, false, 'ไม่มีช่องชื่อไฟล์ให้ใส่ตั้งแต่แรก')
  assert.equal('plainSize' in srv.state.createBody, false, 'ไม่มีช่องขนาด plaintext ที่ client แจ้งเอง')
})

// ── IV ────────────────────────────────────────────────────────────────────
test('ทุก PUT พก IV 96 บิตของตัวเอง และไม่มี IV ซ้ำกันเลยทั้งไฟล์', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 4)), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  const ivs = srv.state.putLog.map((p) => p.ivB64)
  assert.equal(ivs.length, 4)
  for (const iv of ivs) assert.equal(b64ToBytes(iv).length, 12)
  assert.equal(new Set(ivs).size, ivs.length, 'IV ต้องไม่ซ้ำข้าม chunk ภายใต้ DEK เดียวกัน')
})

test('การส่งซ้ำหลังเน็ตหลุดใช้ IV ใหม่ ไม่ใช่ IV เดิมกับ ciphertext ใหม่', async () => {
  const kek = await fakeKek()
  // ก้อนที่ 1 ล้มเหลวหนึ่งครั้งก่อนสำเร็จ
  const srv = fakeServer({ chunkFailures: new Map([[1, 1]]) })
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 3)), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)

  const attemptsForOne = srv.state.putLog.filter((p) => p.index === 1)
  assert.equal(attemptsForOne.length, 2, 'ก้อนที่ล้มต้องถูกส่งซ้ำ')
  // ⚠️ หัวใจของข้อนี้: IV ของสองครั้งต้อง "ต่างกัน" การใช้ IV เดิมกับ ciphertext ที่
  //    เข้ารหัสรอบใหม่คือ IV reuse ภายใต้กุญแจเดิม ซึ่งทำลาย GCM ทั้งระบบ
  assert.notEqual(attemptsForOne[0].ivB64, attemptsForOne[1].ivB64)
  // และก้อนอื่นต้องไม่ถูกส่งซ้ำเพราะก้อนหนึ่งล้ม
  assert.equal(srv.state.putLog.filter((p) => p.index === 0).length, 1)
  assert.equal(srv.state.putLog.filter((p) => p.index === 2).length, 1)
})

test('ก้อนที่ล้มเกินจำนวนครั้งที่ลอง ทำให้หยุดค้างแบบทำต่อได้ ไม่ใช่ล้มทั้งไฟล์', async () => {
  const kek = await fakeKek()
  const srv = fakeServer({ chunkFailures: new Map([[1, 99]]) })
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 3)), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, false)
  assert.equal(res.stage, 'paused', 'ต้องเป็นสถานะที่ทำต่อได้ ไม่ใช่ failed')
  assert.equal(res.reason, 'network')
  assert.ok(res.resume?.upload?.uploadId, 'ต้องคืนสถานะที่ใช้ทำต่อได้')
  assert.equal(srv.state.committed, false, 'ไม่มีการ commit ไฟล์ที่ยังไม่ครบ')
  // ก้อนที่ 0 ที่ส่งสำเร็จไปแล้วต้องยังนับอยู่ — นั่นคือเหตุผลทั้งหมดของ resume
  assert.deepEqual([...srv.state.chunks.keys()], [0])
})

test('ทำต่อจากสถานะที่ค้าง ส่งเฉพาะก้อนที่ขาด ไม่ส่งซ้ำก้อนที่เซิร์ฟเวอร์รับแล้ว', async () => {
  const kek = await fakeKek()
  const failures = new Map([[1, 99]])
  const srv = fakeServer({ chunkFailures: failures })
  const file = hostileFile(sourceBytes(CHUNK * 3))

  const first = await uploadVaultFileChunked({
    kek, file, plaintextChunkBytes: CHUNK, fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(first.stage, 'paused')
  const putsBefore = srv.state.putLog.length

  failures.set(1, 0) // เครือข่ายกลับมาแล้ว
  const second = await uploadVaultFileChunked({
    kek, file, resume: first.resume, plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(second.ok, true)
  assert.equal(srv.state.committed, true)

  const putsAfter = srv.state.putLog.slice(putsBefore)
  assert.deepEqual([...new Set(putsAfter.map((p) => p.index))].sort(), [1, 2],
    'รอบที่สองต้องส่งเฉพาะก้อนที่ยังขาด (1 และ 2) ไม่ใช่เริ่มไฟล์ใหม่ทั้งก้อน')
  assert.equal(putsAfter.some((p) => p.index === 0), false, 'ก้อนที่ 0 ต้องไม่ถูกส่งซ้ำ')
})

// ── ยกเลิก / ล็อกระหว่างทาง ────────────────────────────────────────────────
test('ยกเลิกกลางคันหยุดการเข้ารหัสทันทีและไม่ commit อะไรเลย', async () => {
  const kek = await fakeKek()
  const ctrl = new AbortController()
  const srv = fakeServer()
  const sendUpload = async (path, opts) => {
    const out = await srv.sendUpload(path, opts)
    ctrl.abort() // จำลอง "ผู้ใช้กดล็อก" ทันทีหลังก้อนแรกถึงเซิร์ฟเวอร์
    return out
  }

  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 4)), plaintextChunkBytes: CHUNK,
    fetchJson: srv.fetchJson, sendUpload, signal: ctrl.signal,
  })

  assert.equal(res.ok, false)
  assert.equal(res.stage, 'cancelled')
  assert.equal(srv.state.committed, false)
  assert.equal(srv.state.putLog.length, 1, 'ต้องไม่มีก้อนใหม่ถูกเข้ารหัสหรือส่งหลังการยกเลิก')
})

// ── การปฏิเสธจากเซิร์ฟเวอร์ถูกแปลเป็นเหตุผลที่จอแสดงได้ตรง ─────────────────
test('เพดานขนาดและพื้นที่ไม่พอถูกแปลเป็นเหตุผลคนละอย่าง ไม่ใช่ error ก้อนเดียว', async () => {
  const kek = await fakeKek()
  const tooLarge = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(64)), plaintextChunkBytes: CHUNK,
    fetchJson: async () => ({ ok: false, status: 413, data: { code: 'LOGICAL_LIMIT_EXCEEDED' }, errorKind: 'server' }),
    sendUpload: async () => ({ ok: true }),
  })
  assert.equal(tooLarge.reason, 'tooLarge')

  const noSpace = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(64)), plaintextChunkBytes: CHUNK,
    fetchJson: async () => ({ ok: false, status: 507, data: { code: 'INSUFFICIENT_STORAGE' }, errorKind: 'server' }),
    sendUpload: async () => ({ ok: true }),
  })
  assert.equal(noSpace.reason, 'noSpace')

  const notConfigured = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(64)), plaintextChunkBytes: CHUNK,
    fetchJson: async () => ({ ok: false, status: 409, data: { error: 'Vault not configured' }, errorKind: 'server' }),
    sendUpload: async () => ({ ok: true }),
  })
  assert.equal(notConfigured.reason, 'notConfigured')
})

test('ขนาด chunk ถูกถามจากเซิร์ฟเวอร์เมื่อผู้เรียกไม่ได้กำหนด — ไม่มีค่าคงที่ใน bundle', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const paths = []
  const fetchJson = async (path, opts) => {
    paths.push(path)
    if (path === '/api/vault/uploads/limits') {
      return { ok: true, status: 200, data: { plaintextChunkBytes: CHUNK }, errorKind: null }
    }
    return srv.fetchJson(path, opts)
  }
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 2)), fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)
  assert.equal(paths[0], '/api/vault/uploads/limits')
  assert.equal(srv.state.createBody.chunkSize, CHUNK + GCM_TAG_BYTES)
})

test('การยกเลิก session คืนพื้นที่พักผ่าน DELETE ของเส้นทาง V2', async () => {
  const seen = []
  const ok = await cancelVaultUploadSession('c'.repeat(48), {
    fetchJson: async (path, opts) => { seen.push([path, opts.method]); return { ok: true } },
  })
  assert.equal(ok, true)
  assert.deepEqual(seen, [[`/api/vault/uploads/${'c'.repeat(48)}`, 'DELETE']])
})
