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

import {
  uploadVaultFileChunked, cancelVaultUploadSession,
  resolveUploadConcurrency, DEFAULT_UPLOAD_CONCURRENCY,
} from '../src/lib/vaultChunkedUpload.js'
import { decryptVaultChunk, unwrapVaultV2Dek, planVaultChunks, GCM_TAG_BYTES } from '../src/lib/vaultChunkCrypto.js'
import { b64ToBytes } from '../src/lib/vaultCrypto.js'

// ⚠️ เทสต์ที่ต้องการ "ลำดับที่แน่นอน" ตรึง concurrency: 1 ไว้เสมอโดยเจตนา — นั่นคือ
//    สัญญาว่าโหมดเรียงลำดับเดิมยังทำงานเหมือนเดิมทุกประการ ส่วนพฤติกรรมของหลายก้อน
//    พร้อมกันถูกพิสูจน์แยกในหมวด "ความพร้อมกันแบบมีขอบเขต" ท้ายไฟล์
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

test('concurrency 1 · ก้อนที่ล้มเกินจำนวนครั้งที่ลอง ทำให้หยุดค้างแบบทำต่อได้ ไม่ใช่ล้มทั้งไฟล์', async () => {
  const kek = await fakeKek()
  const srv = fakeServer({ chunkFailures: new Map([[1, 99]]) })
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 3)), plaintextChunkBytes: CHUNK,
    concurrency: 1,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, false)
  assert.equal(res.stage, 'paused', 'ต้องเป็นสถานะที่ทำต่อได้ ไม่ใช่ failed')
  assert.equal(res.reason, 'network')
  assert.ok(res.resume?.upload?.uploadId, 'ต้องคืนสถานะที่ใช้ทำต่อได้')
  assert.equal(srv.state.committed, false, 'ไม่มีการ commit ไฟล์ที่ยังไม่ครบ')
  // ⚠️ ที่ concurrency 1 การล้มที่ก้อน 1 หยุดทุกอย่างทันที ก้อน 2 จึงไม่ถูกแตะเลย
  //    (ที่ concurrency > 1 ก้อน 2 อาจสำเร็จไปแล้ว — ดูหมวดความพร้อมกันท้ายไฟล์)
  assert.deepEqual([...srv.state.chunks.keys()], [0])
})

test('concurrency 1 · ทำต่อจากสถานะที่ค้าง ส่งเฉพาะก้อนที่ขาด ไม่ส่งซ้ำก้อนที่เซิร์ฟเวอร์รับแล้ว', async () => {
  const kek = await fakeKek()
  const failures = new Map([[1, 99]])
  const srv = fakeServer({ chunkFailures: failures })
  const file = hostileFile(sourceBytes(CHUNK * 3))

  const first = await uploadVaultFileChunked({
    kek, file, plaintextChunkBytes: CHUNK, concurrency: 1,
    fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(first.stage, 'paused')
  const putsBefore = srv.state.putLog.length

  failures.set(1, 0) // เครือข่ายกลับมาแล้ว
  const second = await uploadVaultFileChunked({
    kek, file, resume: first.resume, plaintextChunkBytes: CHUNK, concurrency: 1,
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

// ─────────────────────────────────────────────────────────────────────────────
// ความพร้อมกันแบบมีขอบเขต (LFT-V2-E2)
//
// ⚠️ สิ่งที่ต้องพิสูจน์ที่นี่ไม่ใช่ "เร็วขึ้น" (วัดด้วยเทสต์ไม่ได้และไม่ควรอ้าง) แต่คือ
//    **ความปลอดภัยไม่ลดลงเลยเมื่อมีหลายก้อนวิ่งพร้อมกัน**: ไม่มี index ซ้ำ ไม่เกินเพดาน
//    ที่ตั้งไว้ ไม่มี IV ซ้ำ ไม่นับไบต์ซ้ำ และการล้มหนึ่งก้อนต้องหยุดการแจกงานใหม่
// ─────────────────────────────────────────────────────────────────────────────

/** fakeServer ที่ "ถือ" ทุก PUT ไว้จนกว่าเทสต์จะสั่งปล่อย — วัดจำนวนที่วิ่งพร้อมกันได้จริง */
function gatedServer(base) {
  const live = new Set()
  let peak = 0
  const gates = []
  const order = []

  const sendUpload = async (path, opts) => {
    const index = Number(path.split('/').pop())
    live.add(index)
    peak = Math.max(peak, live.size)
    order.push(index)
    await new Promise((resolve) => { gates.push({ index, resolve }) })
    live.delete(index)
    return base.sendUpload(path, opts)
  }

  return {
    sendUpload,
    peak: () => peak,
    live: () => [...live],
    order: () => [...order],
    /** ปล่อยคำขอที่ค้างอยู่ทั้งหมด แล้วรอให้ worker หมุนต่อ */
    async releaseAll() {
      for (let guard = 0; guard < 200; guard += 1) {
        const pending = gates.splice(0, gates.length)
        if (pending.length === 0) {
          await new Promise((r) => setImmediate(r))
          if (gates.length === 0) return
          continue
        }
        for (const g of pending) g.resolve()
        await new Promise((r) => setImmediate(r))
      }
    },
  }
}

test('concurrency 2 · ส่งสอง index ที่ต่างกันพร้อมกันจริง และไม่เกินเพดานที่ตั้งไว้', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const gated = gatedServer(srv)

  const running = uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 6)), plaintextChunkBytes: CHUNK,
    concurrency: 2, fetchJson: srv.fetchJson, sendUpload: gated.sendUpload,
  })

  // ให้ worker ทั้งสองไปถึง PUT ของตัวเอง
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r))

  const live = gated.live()
  assert.equal(live.length, 2, 'ต้องมีสองก้อนวิ่งพร้อมกันจริง ไม่ใช่ทีละก้อน')
  assert.equal(new Set(live).size, 2, 'สองก้อนที่วิ่งอยู่ต้องเป็นคนละ index')

  await gated.releaseAll()
  const res = await running

  assert.equal(res.ok, true)
  assert.ok(gated.peak() <= 2, `ห้ามเกินเพดานที่ตั้งไว้ — จุดสูงสุดที่วัดได้คือ ${gated.peak()}`)
  assert.equal(srv.state.chunks.size, 6, 'ทุกก้อนต้องถึงเซิร์ฟเวอร์ครบ')
  assert.equal(srv.state.committed, true)
})

test('concurrency 4 · จุดสูงสุดที่วัดได้ต้องไม่เกิน 4 และไม่มี index ถูกส่งซ้ำโดยสองผู้เขียน', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const gated = gatedServer(srv)

  const running = uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 9)), plaintextChunkBytes: CHUNK,
    concurrency: 4, fetchJson: srv.fetchJson, sendUpload: gated.sendUpload,
  })
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r))
  assert.equal(gated.live().length, 4)

  await gated.releaseAll()
  assert.equal((await running).ok, true)

  assert.ok(gated.peak() <= 4, `จุดสูงสุด ${gated.peak()} เกินเพดาน 4`)
  // ★ ข้อพิสูจน์ "หนึ่ง index หนึ่งผู้เขียน": ไม่มี PUT ที่สำเร็จซ้ำ index เดิมเลย
  const sentIndexes = srv.state.putLog.map((p) => p.index)
  assert.equal(new Set(sentIndexes).size, sentIndexes.length,
    'ไม่มี index ใดถูกส่งมากกว่าหนึ่งครั้งเมื่อไม่มีความล้มเหลว')
  assert.deepEqual([...srv.state.chunks.keys()].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('ค่าที่ตั้งเกินช่วง 1–4 ถูกบีบเข้าช่วง ไม่ใช่ทำให้อัปโหลดล้ม', async () => {
  assert.equal(resolveUploadConcurrency(1), 1)
  assert.equal(resolveUploadConcurrency(4), 4)
  assert.equal(resolveUploadConcurrency(99), 4, 'ค่าสูงเกินไปถูกบีบลงมาที่เพดาน')
  assert.equal(resolveUploadConcurrency(0), DEFAULT_UPLOAD_CONCURRENCY)
  assert.equal(resolveUploadConcurrency(-3), DEFAULT_UPLOAD_CONCURRENCY)
  assert.equal(resolveUploadConcurrency('two'), DEFAULT_UPLOAD_CONCURRENCY)
  assert.equal(resolveUploadConcurrency(undefined), DEFAULT_UPLOAD_CONCURRENCY)
  assert.equal(resolveUploadConcurrency(2.9), 2, 'เศษถูกตัดลง ไม่ใช่ปัดขึ้น')

  // และค่าประหลาดจาก /limits ต้องไม่ทำให้แท็บอัปโหลดไม่ได้
  const kek = await fakeKek()
  const srv = fakeServer()
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 3)), plaintextChunkBytes: CHUNK,
    concurrency: 9999, fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)
})

test('ความคืบหน้าไม่นับไบต์ซ้ำเมื่อมีหลายก้อนวิ่งพร้อมกัน และไม่เกินขนาดไฟล์', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const FILE_SIZE = CHUNK * 6
  const seen = []

  // รายงานความคืบหน้าครึ่งก้อนก่อน แล้วค่อยเต็มก้อน — จำลอง onProgress ที่มาเป็นระยะ
  const sendUpload = async (path, opts) => {
    const size = (await opts.body.arrayBuffer()).byteLength
    opts.onProgress?.({ loadedBytes: Math.floor(size / 2), totalBytes: size })
    opts.onProgress?.({ loadedBytes: size, totalBytes: size })
    return srv.sendUpload(path, opts)
  }

  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(FILE_SIZE)), plaintextChunkBytes: CHUNK,
    concurrency: 2, fetchJson: srv.fetchJson, sendUpload,
    onProgress: (p) => seen.push(p),
  })

  assert.equal(res.ok, true)
  assert.ok(seen.length > 0)
  for (const p of seen) {
    assert.ok(p.transferredBytes <= FILE_SIZE,
      `นับเกินขนาดไฟล์ = นับก้อนซ้ำ: ${p.transferredBytes} > ${FILE_SIZE}`)
    assert.ok(p.transferredBytes >= 0)
    assert.ok(p.percent <= 100)
    assert.ok(p.inflightChunks <= 2, 'จำนวนก้อนที่วิ่งอยู่ต้องไม่เกินเพดาน')
  }
  assert.equal(seen[seen.length - 1].transferredBytes, FILE_SIZE,
    'เมื่อทุกก้อนยืนยันแล้ว ตัวเลขต้องลงตัวพอดีกับขนาดไฟล์')
})

test('ก้อนที่ล้มถาวรหยุดการแจกงานใหม่ — ไม่ใช่ปล่อยให้ worker ไล่ส่งจนหมดไฟล์', async () => {
  const kek = await fakeKek()
  // ก้อน 1 ล้มตลอด; ไฟล์มี 8 ก้อน ถ้าไม่หยุดแจกงาน ก้อน 3–7 จะถูกส่งไปด้วย
  const srv = fakeServer({ chunkFailures: new Map([[1, 99]]) })
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 8)), plaintextChunkBytes: CHUNK,
    concurrency: 2, fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })

  assert.equal(res.stage, 'paused')
  assert.equal(res.reason, 'network')
  assert.equal(srv.state.committed, false)

  const stored = [...srv.state.chunks.keys()].sort((a, b) => a - b)
  assert.ok(stored.length < 8, 'ต้องไม่ส่งครบทั้งไฟล์หลังจากมีก้อนที่ล้มถาวร')
  // ★ ก้อนที่ออกไปแล้วก่อนความล้มเหลวถูกยืนยัน ยัง settle ได้ตามปกติ — นั่นถูกต้อง
  //    สิ่งที่ต้องไม่เกิดคือการ "หยิบงานใหม่" ต่อไปเรื่อย ๆ หลังรู้ว่าล้มแล้ว
  assert.ok(stored.includes(0))
  assert.equal(stored.includes(1), false, 'ก้อนที่ล้มต้องไม่ถูกบันทึก')
})

test('ทุกครั้งที่ retry เข้ารหัสใหม่ด้วย IV ใหม่ แม้ในโหมดหลายก้อนพร้อมกัน', async () => {
  const kek = await fakeKek()
  const srv = fakeServer({ chunkFailures: new Map([[0, 2], [2, 1]]) })
  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 4)), plaintextChunkBytes: CHUNK,
    concurrency: 2, fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)

  const ivs = srv.state.putLog.map((p) => p.ivB64)
  assert.equal(new Set(ivs).size, ivs.length,
    'IV ซ้ำแม้ครั้งเดียวคือการล่มสลายของ AES-GCM ทั้งไฟล์ ไม่ใช่การอ่อนลง')
  for (const iv of ivs) assert.equal(b64ToBytes(iv).length, 12)

  // ก้อน 0 ถูกส่งสามครั้ง (ล้ม 2 ครั้ง) — ทั้งสามครั้งต้องมี IV คนละอัน
  const chunk0 = srv.state.putLog.filter((p) => p.index === 0)
  assert.equal(chunk0.length, 3)
  assert.equal(new Set(chunk0.map((p) => p.ivB64)).size, 3)
})

test('หน่วยความจำยังมีขอบเขต: ไฟล์ที่ arrayBuffer() ทั้งก้อนโยน error ก็ยังสำเร็จที่ concurrency 4', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const bytes = sourceBytes(CHUNK * 12)
  const reads = []

  // ★ ข้อพิสูจน์เดียวกับโหมดเรียงลำดับ ยกระดับขึ้นหนึ่งขั้น: นอกจาก arrayBuffer() ของ
  //   ทั้งไฟล์ที่โยน error แล้ว ยังบันทึกทุกช่วงที่ถูกอ่านจริง — ความพร้อมกันต้องไม่เปิด
  //   ทางให้ใครอ่านช่วงที่กว้างกว่าหนึ่ง chunk
  const base = hostileFile(bytes)
  const file = {
    name: base.name,
    type: base.type,
    size: base.size,
    arrayBuffer: base.arrayBuffer,
    slice(start, end) {
      reads.push({ start, end })
      return base.slice(start, end)
    },
  }

  const res = await uploadVaultFileChunked({
    kek, file, plaintextChunkBytes: CHUNK,
    concurrency: 4, fetchJson: srv.fetchJson, sendUpload: srv.sendUpload,
  })
  assert.equal(res.ok, true)
  assert.equal(srv.state.chunks.size, 12)

  assert.ok(reads.length >= 12, 'ต้องอ่านอย่างน้อยหนึ่งครั้งต่อหนึ่งก้อน')
  for (const r of reads) {
    assert.ok(r.end - r.start <= CHUNK, 'อ่านช่วงกว้างเกินหนึ่ง chunk: ' + (r.end - r.start))
  }
  // เพดานหน่วยความจำที่อ้างได้จริง = 2 × ขนาด chunk × ความพร้อมกัน (plaintext + ciphertext)
  assert.ok(2 * CHUNK * 4 < bytes.length,
    'สัญญาเรื่องหน่วยความจำต้องเป็นค่าคงที่ที่เล็กกว่าไฟล์ ไม่ใช่ค่าที่โตตามขนาดไฟล์')
})

test('ยกเลิกระหว่างที่มีหลายก้อนวิ่งอยู่ ไม่ commit และไม่ทิ้ง error ปลอม', async () => {
  const kek = await fakeKek()
  const srv = fakeServer()
  const ctrl = new AbortController()

  const sendUpload = async (path, opts) => {
    ctrl.abort() // ยกเลิกทันทีที่ก้อนแรกเริ่มเดินทาง
    return srv.sendUpload(path, opts)
  }

  const res = await uploadVaultFileChunked({
    kek, file: hostileFile(sourceBytes(CHUNK * 6)), plaintextChunkBytes: CHUNK,
    concurrency: 2, signal: ctrl.signal, fetchJson: srv.fetchJson, sendUpload,
  })

  assert.equal(res.ok, false)
  assert.equal(res.stage, 'cancelled')
  assert.equal(srv.state.committed, false, 'การยกเลิกต้องไม่ commit อะไรเลย')
})
