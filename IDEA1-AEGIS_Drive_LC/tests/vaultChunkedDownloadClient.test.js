// tests/vaultChunkedDownloadClient.test.js — AEGIS Drive (IDEA1) · ตัวขับดาวน์โหลด Vault V2
//
// ⚠️ ชุดนี้รันโมดูลตัวจริง (vaultChunkedDownload.js + vaultChunkCrypto.js) แทนที่เฉพาะ
//    ขาเครือข่าย ciphertext ทุกก้อนที่ "เซิร์ฟเวอร์จำลอง" ส่งกลับมาถูกเข้ารหัสด้วย
//    โมดูลจริง จึงยืนยันได้ว่าเส้นทางถอดรหัสของจอทำงานกับของจริง ไม่ใช่กับของปลอม
//
// ⚠️ ข้อพิสูจน์ที่สำคัญที่สุดสองข้อของไฟล์นี้:
//    (1) **หน่วยความจำเป็น O(ขนาด chunk)** — วัดจาก sink ที่นับไบต์ที่ยังถูกถือไว้จริง
//        ไม่ใช่จากการอ่านโค้ดแล้วเชื่อ
//    (2) **ความล้มเหลวใด ๆ ต้องไม่ส่งมอบไฟล์** — close() ต้องไม่ถูกเรียก และ abort()
//        ต้องถูกเรียก ไฟล์ครึ่ง ๆ ที่เปิดได้คือความเสียหายที่ผู้ใช้จะไม่มีทางรู้ตัว
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  downloadVaultV2, createBufferedSink, createFileSystemSink, supportsStreamingFileSink,
  estimatedPlainSize, MAX_BUFFERED_PLAINTEXT_BYTES,
} from '../src/lib/vaultChunkedDownload.js'
import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, plaintextRangeFor,
  newContentId, GCM_TAG_BYTES,
} from '../src/lib/vaultChunkCrypto.js'
import { bytesToB64 } from '../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
const CHUNK = 1024 // เล็กเพื่อให้เทสต์เร็ว — ตรรกะไม่ต่างจาก 16 MiB

async function fakeKek(seed = 7) {
  return subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function pattern(n, seed = 1) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed * 17) & 0xff
  return out
}

/**
 * สร้าง blob V2 หนึ่งก้อน "อย่างที่เซิร์ฟเวอร์เก็บจริง": แถว metadata ที่ไม่มี plaintext
 * อะไรเลย + ciphertext ทีละก้อนพร้อม IV ของก้อนนั้น
 */
async function publishV2(kek, plainBytes, {
  name = 'invoice-2026.pdf', type = 'application/pdf',
  plaintextChunkBytes = CHUNK, contentId, id = 'a1'.repeat(24),
} = {}) {
  const plan = planVaultChunks(plainBytes.length, plaintextChunkBytes)
  const env = await createVaultV2Envelope(kek, {
    name, type, size: plainBytes.length, chunkCount: plan.chunkCount, contentId,
  })

  const chunks = []
  for (let i = 0; i < plan.chunkCount; i += 1) {
    const range = plaintextRangeFor(i, plainBytes.length, plan.plaintextChunkBytes)
    chunks.push(await encryptVaultChunk(env.dek, {
      contentId: env.contentId,
      chunkIndex: i,
      chunkCount: plan.chunkCount,
      plaintext: plainBytes.subarray(range.start, range.end),
    }))
  }

  const blob = {
    id,
    formatVersion: 2,
    size: plan.ciphertextSize,
    createdAt: 1_756_000_000_000,
    contentIdB64: env.contentIdB64,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    wrappedDekB64: env.wrappedDekB64,
    wrapIvB64: env.wrapIvB64,
    metaIvB64: env.metaIvB64,
    metaB64: env.metaB64,
  }
  return { blob, chunks, dek: env.dek, contentId: env.contentId, plan }
}

/**
 * ขาเครือข่ายจำลอง — บันทึกทุกคำขอ และวัด "จำนวนคำขอที่ค้างอยู่พร้อมกัน"
 * เพื่อให้ยืนยันได้ว่าจอขอทีละก้อนจริง ไม่ใช่ยิงขนานแล้วรอ Promise.all
 */
function serve(chunks, { override, headerless = new Set(), fail = new Map() } = {}) {
  const log = []
  let inFlight = 0
  let maxInFlight = 0

  const fetchBytes = async (path, opts = {}) => {
    const index = Number(path.slice(path.lastIndexOf('/') + 1))
    log.push({ path, index })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await new Promise((r) => { setTimeout(r, 0) }) // ให้โอกาสการขนานได้เกิดถ้ามันมีจริง
      if (opts.signal?.aborted) return { ok: false, status: 0, bytes: null, headers: null, errorKind: 'network' }
      if (fail.has(index)) {
        const f = fail.get(index)
        return { ok: false, status: f.status ?? 500, bytes: null, headers: null, errorKind: f.errorKind ?? 'server' }
      }
      const served = override?.(index, chunks) ?? chunks[index]
      const headers = new Headers()
      if (!headerless.has(index)) headers.set('X-Vault-Chunk-IV', served.ivB64)
      headers.set('X-Vault-Chunk-Index', String(index))
      return { ok: true, status: 200, bytes: served.ciphertext, headers, errorKind: null }
    } finally {
      inFlight -= 1
    }
  }

  return { fetchBytes, log, maxInFlight: () => maxInFlight }
}

/** sink ที่บันทึกทุกอย่างที่จอทำกับปลายทาง — รวมถึงว่ามัน "ปิด" หรือ "ทิ้ง" */
function recordingSink({ onWrite } = {}) {
  const parts = []
  const events = []
  return {
    parts,
    events,
    async write(bytes) {
      events.push({ kind: 'write', length: bytes.length })
      onWrite?.(bytes, parts.length)
      parts.push(bytes.slice())
    },
    async close() { events.push({ kind: 'close' }); return parts },
    async abort() { events.push({ kind: 'abort' }) },
    joined() {
      const total = parts.reduce((n, p) => n + p.length, 0)
      const out = new Uint8Array(total)
      let at = 0
      for (const p of parts) { out.set(p, at); at += p.length }
      return out
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 38 — ขอทีละก้อน ตามลำดับ ไม่ขนาน
// ─────────────────────────────────────────────────────────────────────────────
test('การดาวน์โหลดขอ chunk ทีละก้อนตามลำดับ ไม่ยิงขนานทั้งไฟล์', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 4 + 300)
  const { blob, chunks } = await publishV2(kek, plain)
  const net = serve(chunks)
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, true)
  assert.equal(net.maxInFlight(), 1, 'ต้องมีคำขอค้างอยู่ไม่เกินหนึ่งคำขอ ณ เวลาใด ๆ')
  assert.deepEqual(net.log.map((r) => r.index), [0, 1, 2, 3, 4])
  for (let i = 0; i < blob.chunkCount; i += 1) {
    assert.equal(net.log[i].path, `/api/vault/blobs/${blob.id}/chunks/${i}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 39 — คำขอที่ถูกปฏิเสธ (เช่น 404 ของเจ้าของคนอื่น) หยุดทั้งการดาวน์โหลด
// ─────────────────────────────────────────────────────────────────────────────
test('chunk ที่เซิร์ฟเวอร์ตอบ 404 (blob ของเจ้าของคนอื่น) หยุดทันทีและไม่ส่งมอบไฟล์', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 3))
  const net = serve(chunks, { fail: new Map([[0, { status: 404, errorKind: 'server' }]]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'fetch')
  assert.equal(res.bytesWritten, 0)
  assert.equal(net.log.length, 1, 'ต้องไม่ขอก้อนถัดไปหลังถูกปฏิเสธ')
  assert.ok(sink.events.some((e) => e.kind === 'abort'))
  assert.ok(!sink.events.some((e) => e.kind === 'close'))
})

test('เครือข่ายล่มระหว่างทางถูกแยกออกจากความล้มเหลวของเซิร์ฟเวอร์', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 3))
  const net = serve(chunks, { fail: new Map([[1, { status: 0, errorKind: 'network' }]]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'network')
  assert.equal(res.chunksRead, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 40 — ทุกก้อนถูกตรวจ AEAD ของตัวเอง
// ─────────────────────────────────────────────────────────────────────────────
test('ทุกก้อนถูกตรวจ AEAD แยกกัน — แก้ไบต์เดียวในก้อนกลางก็ล้ม', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 4))
  const net = serve(chunks, {
    override: (index, all) => {
      if (index !== 2) return all[index]
      const bent = all[index].ciphertext.slice()
      bent[5] ^= 0x01 // หนึ่งบิต
      return { ivB64: all[index].ivB64, ciphertext: bent }
    },
  })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
  assert.equal(res.chunksRead, 2, 'สองก้อนแรกผ่าน แสดงว่าการตรวจเป็นรายก้อนจริง')
  assert.ok(sink.events.some((e) => e.kind === 'abort'))
  assert.ok(!sink.events.some((e) => e.kind === 'close'))
})

test('แก้ tag ท้ายก้อนสุดท้ายก็ยังล้ม — ไม่มีก้อนไหนถูกยกเว้นการตรวจ', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 2 + 11))
  const last = blob.chunkCount - 1
  const net = serve(chunks, {
    override: (index, all) => {
      if (index !== last) return all[index]
      const bent = all[index].ciphertext.slice()
      bent[bent.length - 1] ^= 0x80
      return { ivB64: all[index].ivB64, ciphertext: bent }
    },
  })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
})

// ─────────────────────────────────────────────────────────────────────────────
// 41 — ไบต์ที่ออกมาตรงกับต้นฉบับเป๊ะ
// ─────────────────────────────────────────────────────────────────────────────
test('ไฟล์ที่ประกอบเสร็จตรงกับต้นฉบับทุกไบต์ รวมก้อนสุดท้ายที่ไม่เต็ม', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 5 + 137, 9)
  const { blob, chunks } = await publishV2(kek, plain)
  const net = serve(chunks)
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, true)
  assert.equal(res.bytesWritten, plain.length)
  assert.deepEqual(sink.joined(), plain)
  assert.equal(res.meta.name, 'invoice-2026.pdf')
  assert.equal(res.meta.type, 'application/pdf')
  assert.equal(res.meta.plainSize, plain.length)
})

test('ไฟล์ขนาดเท่ากับ chunk พอดี และไฟล์ว่าง ก็ออกมาตรงเป๊ะเช่นกัน', async () => {
  const kek = await fakeKek()

  const exact = pattern(CHUNK * 3, 4)
  const a = await publishV2(kek, exact)
  const sinkA = recordingSink()
  const resA = await downloadVaultV2({ kek, blob: a.blob, sink: sinkA, fetchBytes: serve(a.chunks).fetchBytes })
  assert.equal(resA.ok, true)
  assert.equal(a.blob.chunkCount, 3)
  assert.deepEqual(sinkA.joined(), exact)

  const empty = new Uint8Array(0)
  const b = await publishV2(kek, empty, { name: 'empty.txt', type: 'text/plain' })
  const sinkB = recordingSink()
  const resB = await downloadVaultV2({ kek, blob: b.blob, sink: sinkB, fetchBytes: serve(b.chunks).fetchBytes })
  assert.equal(resB.ok, true)
  assert.equal(b.blob.chunkCount, 1, 'ไฟล์ว่างยังต้องมีหนึ่ง AEAD message ให้ตรวจ')
  assert.equal(resB.bytesWritten, 0)
  assert.ok(sinkB.events.some((e) => e.kind === 'close'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 42 — sink ได้รับก้อนแบบทยอย ไม่ใช่ทีเดียวตอนจบ
// ─────────────────────────────────────────────────────────────────────────────
test('sink ได้รับก้อนทยอยระหว่างทาง และ close() ถูกเรียกครั้งเดียวตอนจบ', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 4)
  const { blob, chunks } = await publishV2(kek, plain)
  const net = serve(chunks)

  const writesWhenRequested = []
  const sink = recordingSink()
  const wrapped = {
    ...sink,
    async write(bytes) {
      // ณ ตอนที่ก้อนที่ i ถูกเขียน จอต้องยังไม่ได้ขอก้อนที่ i+2 (คือไม่อ่านล่วงหน้าทั้งไฟล์)
      writesWhenRequested.push(net.log.length)
      return sink.write(bytes)
    },
  }

  const res = await downloadVaultV2({ kek, blob, sink: wrapped, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, true)
  assert.deepEqual(writesWhenRequested, [1, 2, 3, 4], 'เขียนก้อนที่ i หลังขอเพียง i+1 คำขอ')
  assert.equal(sink.events.filter((e) => e.kind === 'close').length, 1)
  assert.equal(sink.events.filter((e) => e.kind === 'write').length, 4)

  const progress = []
  const sink2 = recordingSink()
  await downloadVaultV2({
    kek, blob, sink: sink2, fetchBytes: serve(chunks).fetchBytes, onProgress: (p) => progress.push(p),
  })
  assert.equal(progress.length, 4)
  assert.deepEqual(progress.map((p) => p.chunkIndex), [0, 1, 2, 3])
  assert.deepEqual(progress.map((p) => p.bytesWritten), [CHUNK, CHUNK * 2, CHUNK * 3, CHUNK * 4])
  assert.equal(progress.at(-1).percent, 100)
  assert.equal(progress.at(-1).totalBytes, plain.length)
})

// ─────────────────────────────────────────────────────────────────────────────
// 43 — ไม่มี plaintext ทั้งไฟล์อยู่ในหน่วยความจำพร้อมกัน
// ─────────────────────────────────────────────────────────────────────────────
test('หน่วยความจำระหว่างดาวน์โหลดเป็น O(ขนาด chunk) ไม่ใช่ O(ขนาดไฟล์)', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 12, 5)
  const { blob, chunks } = await publishV2(kek, plain)

  // sink แบบสตรีมของจริงไม่เก็บอะไรไว้ — วัด "ไบต์ที่ยังถือไว้" ตามจริง
  let held = 0
  let peak = 0
  const streamingSink = {
    async write(bytes) {
      held += bytes.length
      peak = Math.max(peak, held)
      held -= bytes.length // ไบต์ถูกส่งต่อลงดิสก์แล้ว ไม่ถูกเก็บไว้
    },
    async close() { return null },
    async abort() {},
  }

  const res = await downloadVaultV2({ kek, blob, sink: streamingSink, fetchBytes: serve(chunks).fetchBytes })

  assert.equal(res.ok, true)
  assert.equal(res.chunksRead, 12)
  assert.ok(peak <= CHUNK, `ยอดหน่วยความจำสูงสุด ${peak} ต้องไม่เกินขนาดหนึ่ง chunk (${CHUNK})`)
  assert.ok(peak < plain.length, 'ต้องไม่เคยมี plaintext ทั้งไฟล์อยู่พร้อมกัน')
})

test('ทางเลือกสำรองที่บัฟเฟอร์ใน RAM มีเพดานบังคับ และเกินเพดาน = ล้มเหลวอย่างซื่อสัตย์', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 6, 2)
  const { blob, chunks } = await publishV2(kek, plain)

  const sink = createBufferedSink({ limitBytes: CHUNK * 3 })
  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: serve(chunks).fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'too-large-for-memory')
  assert.deepEqual(sink.result(), [], 'บัฟเฟอร์ต้องถูกทิ้ง ไม่ค้างอยู่ในหน่วยความจำ')

  // ใต้เพดาน sink เดียวกันต้องยังทำงานได้ปกติ
  const ok = createBufferedSink({ limitBytes: CHUNK * 10 })
  const res2 = await downloadVaultV2({ kek, blob, sink: ok, fetchBytes: serve(chunks).fetchBytes })
  assert.equal(res2.ok, true)
  assert.equal(res2.bytesWritten, plain.length)
})

test('เพดานปริยายของ sink สำรองคือเพดานเดิมของ V1 พอดี ไม่มากกว่านั้น', () => {
  assert.equal(MAX_BUFFERED_PLAINTEXT_BYTES, 64 * 1024 * 1024)
})

// ─────────────────────────────────────────────────────────────────────────────
// 44 — ก้อนกลางล้ม = ไม่มีไฟล์ที่อ้างว่าสมบูรณ์
// ─────────────────────────────────────────────────────────────────────────────
test('ก้อนกลางที่ล้มทำให้ปลายทางถูกทิ้ง ไม่ใช่ถูกปิดเป็นไฟล์ที่ดูสมบูรณ์', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 5))

  const writes = []
  const aborts = []
  const closes = []
  const writable = {
    async write(b) { writes.push(b.length) },
    async close() { closes.push(1) },
    async abort() { aborts.push(1) },
  }
  const sink = createFileSystemSink(writable)

  const net = serve(chunks, { fail: new Map([[2, { status: 500, errorKind: 'server' }]]) })
  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.chunksRead, 2)
  assert.equal(writes.length, 2, 'เขียนไปแล้วสองก้อน — แต่ไฟล์ต้องไม่ถูกส่งมอบ')
  assert.equal(closes.length, 0, 'close() ห้ามถูกเรียกเมื่อไฟล์ไม่ครบ')
  assert.equal(aborts.length, 1, 'ปลายทางที่เขียนค้างต้องถูกทิ้ง')
})

test('ก้อนที่ไม่มี IV มาด้วยหยุดการดาวน์โหลด แทนที่จะเดา IV', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 3))
  const net = serve(chunks, { headerless: new Set([1]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'missing-iv')
  assert.ok(!sink.events.some((e) => e.kind === 'close'))
})

test('การยกเลิกระหว่างทางหยุดทันทีและทิ้งปลายทาง', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 6))
  const ctrl = new AbortController()
  const sink = recordingSink({ onWrite: (_b, written) => { if (written === 1) ctrl.abort() } })

  const res = await downloadVaultV2({
    kek, blob, sink, signal: ctrl.signal, fetchBytes: serve(chunks).fetchBytes,
  })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'cancelled')
  assert.ok(res.chunksRead < blob.chunkCount)
  assert.ok(sink.events.some((e) => e.kind === 'abort'))
  assert.ok(!sink.events.some((e) => e.kind === 'close'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 45 — IV ผิด
// ─────────────────────────────────────────────────────────────────────────────
test('IV ที่ไม่ตรงกับก้อน (แม้เป็น IV จริงของก้อนอื่นในไฟล์เดียวกัน) ทำให้ถอดไม่ผ่าน', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 4))

  // สลับเฉพาะ IV ของก้อน 1 ไปใช้ IV ของก้อน 2 — ciphertext ยังเป็นของก้อน 1
  const swapped = serve(chunks, {
    override: (index, all) => (index === 1
      ? { ivB64: all[2].ivB64, ciphertext: all[1].ciphertext }
      : all[index]),
  })
  const sink = recordingSink()
  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: swapped.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
  assert.equal(res.chunksRead, 1)

  // IV สุ่มล้วนที่ไม่เคยถูกใช้ก็ต้องล้มเหมือนกัน
  const bogus = serve(chunks, {
    override: (index, all) => (index === 0
      ? { ivB64: bytesToB64(new Uint8Array(12).fill(0xaa)), ciphertext: all[0].ciphertext }
      : all[index]),
  })
  const sink2 = recordingSink()
  const res2 = await downloadVaultV2({ kek, blob, sink: sink2, fetchBytes: bogus.fetchBytes })
  assert.equal(res2.ok, false)
  assert.equal(res2.reason, 'auth-failed')
  assert.equal(res2.chunksRead, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 46 — AAD ผิด (สลับตำแหน่ง / ข้ามไฟล์ / จำนวนก้อนไม่ตรง)
// ─────────────────────────────────────────────────────────────────────────────
test('ก้อนที่ถูกสลับตำแหน่งถอดไม่ผ่าน เพราะ AAD ผูก chunkIndex ไว้', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 4))

  // เสิร์ฟก้อน 3 (พร้อม IV ที่ถูกต้องของมัน) ที่ตำแหน่ง 1 — ทุกอย่างถูกยกเว้นตำแหน่ง
  const net = serve(chunks, { override: (index, all) => (index === 1 ? all[3] : all[index]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
  assert.equal(res.chunksRead, 1)
})

test('ก้อนจากไฟล์อื่นที่ผู้ใช้คนเดียวกันเป็นเจ้าของก็ถอดไม่ผ่าน เพราะ AAD ผูก contentId', async () => {
  const kek = await fakeKek()
  const mine = await publishV2(kek, pattern(CHUNK * 3, 1), { id: 'b2'.repeat(24) })
  const other = await publishV2(kek, pattern(CHUNK * 3, 2), { id: 'c3'.repeat(24) })

  const net = serve(mine.chunks, { override: (index, all) => (index === 1 ? other.chunks[1] : all[index]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob: mine.blob, sink, fetchBytes: net.fetchBytes })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
})

test('การแก้ chunkCount ในแถวของเซิร์ฟเวอร์ล้มตั้งแต่ metadata — ก่อนขอ ciphertext ก้อนแรก', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 4))
  const net = serve(chunks)
  const sink = recordingSink()

  // เซิร์ฟเวอร์ (หรือคนกลาง) อ้างว่าไฟล์นี้มี 3 ก้อน ทั้งที่ซองถูกผูกไว้กับ 4
  const res = await downloadVaultV2({
    kek, blob: { ...blob, chunkCount: 3 }, sink, fetchBytes: net.fetchBytes,
  })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'wrong-key', 'metadata AAD ผูก chunkCount ไว้ จึงล้มที่ชั้นซอง')
  assert.equal(net.log.length, 0, 'ต้องไม่ขอ ciphertext เลยเมื่อซองไม่ผ่าน')
})

test('การสลับซอง metadata ข้ามไฟล์ถูกจับได้ ก่อนเริ่มดาวน์โหลด', async () => {
  const kek = await fakeKek()
  const mine = await publishV2(kek, pattern(CHUNK * 2, 1))
  const other = await publishV2(kek, pattern(CHUNK * 2, 2), { name: 'other.pdf' })
  const net = serve(mine.chunks)
  const sink = recordingSink()

  const res = await downloadVaultV2({
    kek,
    blob: { ...mine.blob, metaIvB64: other.blob.metaIvB64, metaB64: other.blob.metaB64 },
    sink,
    fetchBytes: net.fetchBytes,
  })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'wrong-key')
  assert.equal(net.log.length, 0)
})

test('ก้อนที่ถอดผ่านแต่ขนาดไม่ตรงกับแผนของไฟล์ถูกปฏิเสธ', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 3 + 10)
  const { blob, chunks, dek, contentId } = await publishV2(kek, plain)

  // ก้อน 0 ที่ "ถูกต้องตาม AEAD ทุกประการ" แต่สั้นกว่าที่แผนกำหนด
  const short = await encryptVaultChunk(dek, {
    contentId, chunkIndex: 0, chunkCount: blob.chunkCount, plaintext: plain.subarray(0, 16),
  })
  const net = serve(chunks, { override: (index, all) => (index === 0 ? short : all[index]) })
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek, blob, sink, fetchBytes: net.fetchBytes })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'chunk-size-mismatch')
  assert.ok(!sink.events.some((e) => e.kind === 'close'))
})

// ─────────────────────────────────────────────────────────────────────────────
// กุญแจและความสามารถของเบราว์เซอร์
// ─────────────────────────────────────────────────────────────────────────────
test('passphrase ผิด (KEK คนละดอก) หยุดตั้งแต่แกะซอง ไม่ขอ ciphertext เลย', async () => {
  const kek = await fakeKek(7)
  const wrong = await fakeKek(8)
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK * 3))
  const net = serve(chunks)
  const sink = recordingSink()

  const res = await downloadVaultV2({ kek: wrong, blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'wrong-key')
  assert.equal(net.log.length, 0)
  assert.ok(sink.events.some((e) => e.kind === 'abort'))
})

test('ไม่มีกุญแจเลย (ตู้ถูกล็อกไปแล้ว) = ปฏิเสธทันที ไม่ใช่ดาวน์โหลดของที่ถอดไม่ได้', async () => {
  const kek = await fakeKek()
  const { blob, chunks } = await publishV2(kek, pattern(CHUNK))
  const net = serve(chunks)
  const sink = recordingSink()

  const res = await downloadVaultV2({ blob, sink, fetchBytes: net.fetchBytes })

  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no-key')
  assert.equal(net.log.length, 0)
})

test('DEK ที่แกะไว้แล้วใช้ต่อได้โดยไม่ต้องมี KEK — เส้นทางเดียวกัน ผลลัพธ์เดียวกัน', async () => {
  const kek = await fakeKek()
  const plain = pattern(CHUNK * 2 + 5)
  const { blob, chunks, dek } = await publishV2(kek, plain)
  const sink = recordingSink()

  const res = await downloadVaultV2({ dek, blob, sink, fetchBytes: serve(chunks).fetchBytes })

  assert.equal(res.ok, true)
  assert.deepEqual(sink.joined(), plain)
})

test('การตรวจความสามารถของเบราว์เซอร์ดูจากฟังก์ชันจริง ไม่ใช่จาก user agent', () => {
  assert.equal(supportsStreamingFileSink({}), false)
  assert.equal(supportsStreamingFileSink({ showSaveFilePicker: 'not-a-function' }), false)
  assert.equal(supportsStreamingFileSink({ showSaveFilePicker: () => {} }), true)
})

test('ขนาด plaintext ที่ประเมินได้หัก tag ออกก้อนละ 16 ไบต์', () => {
  assert.equal(estimatedPlainSize({ size: 1024 + 16, chunkCount: 1 }), 1024)
  assert.equal(estimatedPlainSize({ size: CHUNK * 4 + 4 * GCM_TAG_BYTES, chunkCount: 4 }), CHUNK * 4)
  assert.equal(estimatedPlainSize({ size: 16, chunkCount: 1 }), 0)
  assert.equal(estimatedPlainSize({ size: 0, chunkCount: 1 }), 0, 'ต้องไม่คืนค่าติดลบ')
})

test('contentId ที่สร้างใหม่ยาว 16 ไบต์และไม่ซ้ำกัน', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const id = newContentId()
    assert.equal(id.length, 16)
    seen.add(bytesToB64(id))
  }
  assert.equal(seen.size, 200)
})
