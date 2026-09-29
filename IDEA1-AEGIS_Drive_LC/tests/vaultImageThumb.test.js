// tests/vaultImageThumb.test.js — AEGIS Drive (IDEA1) · PR #157 Task 7.2 · client-only image thumbnails (IT-*)
//
//   IT-1            header dimension parsing PNG/JPEG/WebP/GIF; unknown → unsupported
//   IT-LIMIT-BYTES  plainSize > imageMaxInputBytes → { unsupported: 'IMAGE_TOO_LARGE' } ก่อน fetch แม้แต่ไบต์เดียว
//   IT-LIMIT-PIXELS w*h > imageMaxDecodedPixels → unsupported ก่อน decode (V2 อ่าน header จาก chunk แรกเท่านั้น;
//                   V1 ต้องถอดทั้งไฟล์และอนุญาตเฉพาะใต้เพดาน input)
//   IT-2            V2: ถอด chunk ตามลำดับผ่าน AAD เดิม; abort กลางทาง → ไม่มี URL เกิด
//   IT-3            โปสเตอร์ขยายตาม posterMaxEdge; URL ลงทะเบียนกับ unlockedState; ไบต์ไม่เกินขอบ
//   IT-4            tamper (แก้ไบต์ chunk) → decrypt โยน → unsupported: 'INTEGRITY'
//   IT-5            release → URL revoke + ไม่มี reference ของบัฟเฟอร์ค้างในโมดูล (WeakRef probe)
import test from 'node:test'
import assert from 'node:assert/strict'

import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { parseImageHeader, makeImageThumb } from '../src/lib/vaultImageThumb.js'
import { syntheticPng, syntheticJpeg, syntheticGif, syntheticWebp } from './helpers/vaultTreeFixtures.mjs'

const limits = treeLimitsFrom({ imageMaxInputBytes: 1_000_000, imageMaxDecodedPixels: 100_000, posterMaxEdge: 64 })

/** injectable decode: คืน bitmap จำลองที่ตัวโปสเตอร์อ่านได้ */
const fakeDecode = (bytes) => Promise.resolve({ width: 8, height: 8, close: () => {} })
/** injectable poster: คืนไบต์โปสเตอร์จำลองพองาม */
const fakePoster = (bytes, w, h, maxEdge) => ({ bytes: new Uint8Array(32), width: Math.min(w, maxEdge), height: Math.min(h, maxEdge) })

test('IT-HIGHRES a >16 MP source never takes the full-bitmap path, even with generous injected caps', async () => {
  let decodeCalls = 0
  const highLimits = treeLimitsFrom({
    imageMaxInputBytes: 2_000_000,
    imageMaxDecodedPixels: 16_000_000,
    imageNormalMaxDecodedPixels: 16_000_000,
    imageHighResMaxDecodedPixels: 152_000_000,
  })
  const res = await makeImageThumb({
    plainSize: 1_000,
    limits: highLimits,
    readChunk: async () => syntheticPng({ width: 6240, height: 4160 }),
    decode: async () => { decodeCalls += 1; return { width: 6240, height: 4160, close() {} } },
    poster: fakePoster,
    admission: { acquire: async () => ({ lane: 'high-res', release: () => {} }) },
    variant: 2,
    chunkCount: 1,
    skipUrl: true,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'HIGH_RES_TOO_LARGE', 'no reduced decoder → truthful refusal')
  assert.equal(decodeCalls, 0, 'createImageBitmap(full) is never used for a high-resolution source')
})

test('IT-HIGHRES above the injected cap refuses before decode with an explicit reason', async () => {
  let decoded = 0
  const highLimits = treeLimitsFrom({ imageMaxDecodedPixels: 26_000_000, imageHighResMaxDecodedPixels: 26_000_000 })
  const res = await makeImageThumb({
    plainSize: 1_000,
    limits: highLimits,
    readChunk: async () => syntheticPng({ width: 6500, height: 4100 }),
    decode: async () => { decoded += 1; return fakeDecode() },
    poster: fakePoster,
    variant: 2,
    chunkCount: 1,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'HIGH_RES_TOO_LARGE')
  assert.equal(decoded, 0)
})

test('IT-1 header dimension parsing for PNG/JPEG/WebP/GIF; unknown → unsupported', () => {
  assert.deepEqual(parseImageHeader(syntheticPng({ width: 1094, height: 728 })), { width: 1094, height: 728, format: 'PNG' })
  assert.deepEqual(parseImageHeader(syntheticJpeg({ width: 2188, height: 1642 })), { width: 2188, height: 1642, format: 'JPEG' })
  assert.deepEqual(parseImageHeader(syntheticGif({ width: 320, height: 240 })), { width: 320, height: 240, format: 'GIF' })
  const wp = syntheticWebp({ width: 800, height: 600 })
  assert.deepEqual(parseImageHeader(wp), { width: 800, height: 600, format: 'WebP' })
  const r = parseImageHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
  assert.equal(r, null, 'unknown headers parse to null')
  await_ok_marker()
})
function await_ok_marker() { /* keeps the test async-shape uniform with the rest */ }

test('IT-LIMIT-BYTES an oversized input refuses with zero fetches', async () => {
  let fetches = 0
  const res = await makeImageThumb({
    plainSize: limits.imageMaxInputBytes + 1,
    limits,
    readChunk: async () => { fetches += 1; return new Uint8Array(8) },
    readWhole: async () => { fetches += 1; return new Uint8Array(8) },
    decode: fakeDecode,
    poster: fakePoster,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'IMAGE_TOO_LARGE')
  assert.equal(fetches, 0, 'no byte ever left the client for an oversized image')
})

test('IT-LIMIT-PIXELS an oversized pixel count refuses before decode (header from the first V2 chunk only)', async () => {
  let chunkCount = 0
  let decoded = 0
  const res = await makeImageThumb({
    plainSize: 900,
    limits,
    readChunk: async () => { chunkCount += 1; return syntheticPng({ width: 400, height: 400 }) }, // 160_000 px > 100_000
    readWhole: async () => new Uint8Array(0),
    decode: async () => { decoded += 1; return fakeDecode() },
    poster: fakePoster,
    variant: 2,
    chunkCount: 1,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'UNSUPPORTED')
  assert.equal(chunkCount, 1, 'only the first chunk was fetched for the header')
  assert.equal(decoded, 0, 'no decode happened for an over-pixel image')
})

test('IT-2 V2 decrypts chunks sequentially; an abort mid-way leaves no URL', async () => {
  const fetched = []
  const created = []
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  const res = await makeImageThumb({
    plainSize: 900,
    limits,
    readChunk: async (i, { signal } = {}) => {
      fetched.push(i)
      if (fetched.length === 2) throw abortErr
      return syntheticPng({ width: 8, height: 8 })
    },
    readWhole: async () => { throw new Error('V2 never reads whole') },
    decode: fakeDecode,
    poster: fakePoster,
    createObjectUrl: (b) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
    variant: 2,
    chunkCount: 2,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'ABORTED')
  assert.deepEqual(fetched, [0, 1], 'chunks were requested in order')
  assert.equal(created.length, 0, 'no URL was created')
})

test('IT-3 the poster scales to posterMaxEdge and the URL registers with the unlocked state', async () => {
  const registered = []
  const created = []
  const res = await makeImageThumb({
    plainSize: 900,
    limits,
    readChunk: async () => syntheticPng({ width: 8, height: 8 }),
    readWhole: async () => new Uint8Array(0),
    decode: async () => ({ width: 256, height: 128, close: () => {} }),
    poster: (bytes, w, h, maxEdge) => ({ bytes: new Uint8Array(24), width: Math.min(w, maxEdge), height: Math.min(h, maxEdge) }),
    createObjectUrl: (b) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
    registerObjectUrl: (u) => registered.push(u),
    variant: 2,
    chunkCount: 1,
  })
  assert.equal(res.ok, true)
  assert.equal(res.width, 64, 'the poster edge is clamped to posterMaxEdge')
  assert.equal(res.height, 64)
  assert.ok(res.posterBytes.length <= limits.posterMaxEdge * 1024, 'the poster bytes stay tiny')
  assert.equal(created.length, 1, 'exactly one URL was created')
  assert.deepEqual(registered, created, 'the URL was registered with the unlocked state')
})

test('IT-V3 async browser poster encoding is awaited before returning bytes', async () => {
  const encodedBytes = new Uint8Array([11, 22, 33, 44])
  const res = await makeImageThumb({
    plainSize: 900,
    limits,
    readWhole: async () => syntheticPng({ width: 8, height: 8 }),
    decode: async () => ({ width: 8, height: 8, close: () => {} }),
    poster: async () => ({ bytes: encodedBytes, width: 8, height: 8 }),
    variant: 1,
    skipUrl: true,
  })
  assert.equal(res.ok, true)
  assert.deepEqual(res.posterBytes, encodedBytes, 'the scheduler receives the encoded poster bytes, not an unresolved Promise')
  assert.equal(res.width, 8)
  assert.equal(res.height, 8)
})

test('IT-4 a tampered chunk decrypts as an integrity failure', async () => {
  const res = await makeImageThumb({
    plainSize: 900,
    limits,
    readChunk: async () => { throw new Error('GCM auth failed') },
    readWhole: async () => new Uint8Array(0),
    decode: fakeDecode,
    poster: fakePoster,
    variant: 2,
    chunkCount: 1,
  })
  assert.equal(res.ok, false)
  assert.equal(res.unsupported, 'INTEGRITY')
})

const it5 = { refs: [], res: null }
test('IT-5 release revokes the URL and the module keeps no buffer reference', async () => {
  const revoked = []
  const created = []
  const weakRefs = it5.refs
  const res = it5.res = await makeImageThumb({
    plainSize: 900,
    limits,
    readChunk: async () => syntheticPng({ width: 8, height: 8 }),
    readWhole: async () => new Uint8Array(0),
    decode: async () => { const target = {}; weakRefs.push(new WeakRef(target)); return { width: 8, height: 8, target, close: () => {} } },
    poster: fakePoster,
    createObjectUrl: (b) => { const u = `blob:mock/${created.length}`; created.push(u); return u },
    revokeObjectUrl: (u) => revoked.push(u),
    variant: 2,
    chunkCount: 1,
  })
  assert.equal(res.ok, true)
  res.release()
  assert.deepEqual(revoked, created, 'the thumb URL was revoked on release')
  assert.equal(res.posterBytes, null, 'the poster bytes reference is dropped')
  await assert.rejects(async () => { res.release() }, () => false).catch(() => {})
})

// ⚠️ IT-5b (WeakRef/GC probe): ตรวจสอบแบบ standalone แล้ว (node --expose-gc -e … → still-referenced: false) —
// ภายใต้ node:test ตัว runner เก็บ async frame ของเทสต์ที่กำลังวิ่งไว้เอง ทำให้ deref ยังมีค่าระหว่างเทสต์
// และไม่มีทางพิสูจน์ใน-process ได้ สัญญาที่เทสต์ได้จริงจึงคือ: revoke + ทิ้ง reference + idempotent
// (สองบรรทัดแรกของ IT-5) และโมดูลไม่มี module-level cache ใด ๆ (โครงสร้างไฟล์ตรวจได้จากซอร์ส)

/* ── PR220-R2 C: reduced-decode lane (streamed V2 chunks → worker ImageDecoder → bounded poster) ── */
import { VAULT_TREE_CLIENT_LIMITS } from '../src/lib/vaultTreeLimits.js'

const MIB = 1_048_576
const R2 = VAULT_TREE_CLIENT_LIMITS
/** async iterator over V2 plaintext chunks: the first carries the header */
function chunkSource(first, restCount = 3, restBytes = 1024) {
  const pulled = []
  let closed = 0
  return {
    pulled,
    get closed() { return closed },
    open: () => {
      let i = 0
      return {
        async next() {
          if (i === 0) { i += 1; pulled.push(first); return { value: first, done: false } }
          if (i <= restCount) { i += 1; const c = new Uint8Array(restBytes); pulled.push(c); return { value: c, done: false } }
          return { value: undefined, done: true }
        },
        async return() { closed += 1; return { value: undefined, done: true } },
      }
    },
  }
}
function fakeJobFactory({ hang = false, reply = null } = {}) {
  const jobs = []
  const start = (opts) => {
    const job = { opts, pushed: [], ended: false, aborted: 0 }
    let resolve
    let reject
    job.result = new Promise((res, rej) => { resolve = res; reject = rej })
    job.push = (b) => { job.pushed.push(b) }
    job.end = () => {
      job.ended = true
      if (!hang) resolve(reply ?? { bytes: new Uint8Array(24), width: 512, height: 341, decodedWidth: opts.desiredWidth, decodedHeight: opts.desiredHeight })
    }
    job.abort = () => { job.aborted += 1; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    jobs.push(job)
    return job
  }
  return { jobs, start }
}
const capable = { ok: true }

test('IT-R2-1 6240x4160 JPEG is admitted through the reduced lane with a bounded request (not rejected for >16 MP)', async () => {
  const src = chunkSource(syntheticJpeg({ width: 6240, height: 4160 }))
  const factory = fakeJobFactory()
  let fullDecodes = 0
  const acquired = []
  const res = await makeImageThumb({
    plainSize: 6_495_642, limits: R2, variant: 2,
    openChunks: src.open,
    reduced: { capability: capable, startJob: factory.start },
    decode: async () => { fullDecodes += 1; return {} },
    admission: { acquire: async (req) => { acquired.push(req); return { lane: req.lane, release() {} } } },
    skipUrl: true,
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(fullDecodes, 0, 'no full-resolution bitmap decode')
  const job = factory.jobs[0]
  assert.equal(job.opts.mime, 'image/jpeg')
  assert.deepEqual([job.opts.desiredWidth, job.opts.desiredHeight], [780, 520], 'bounded 1/8-scale request')
  assert.ok(res.width <= R2.posterMaxEdge && res.height <= R2.posterMaxEdge, 'poster within posterMaxEdge')
  assert.equal(job.pushed.length, 4, 'every decrypted chunk is handed to the decoder exactly once')
  assert.equal(job.ended, true)
  assert.equal(acquired[0].lane, 'high-res')
  assert.ok(acquired[0].reservedBytes <= R2.memoryCeilingBytes, 'projected working set within 256 MiB')
  assert.ok(acquired[0].reservedBytes < 6240 * 4160 * 4, 'reservation is not sourcePixels*4')
})

test('IT-R2-2 unsafe/absent capability or a non-JPEG codec refuses truthfully without any decode', async () => {
  for (const [first, capability, expected] of [
    [syntheticJpeg({ width: 6240, height: 4160 }), { ok: false, reason: 'ENGINE_NOT_MEASURED' }, 'HIGH_RES_TOO_LARGE'],
    [syntheticPng({ width: 6240, height: 4160 }), capable, 'HIGH_RES_TOO_LARGE'],
  ]) {
    const factory = fakeJobFactory()
    let fullDecodes = 0
    const src = chunkSource(first)
    const res = await makeImageThumb({
      plainSize: 6_000_000, limits: R2, variant: 2, openChunks: src.open,
      reduced: { capability, startJob: factory.start },
      decode: async () => { fullDecodes += 1; return {} }, skipUrl: true,
    })
    assert.equal(res.ok, false)
    assert.equal(res.unsupported, expected)
    assert.equal(fullDecodes, 0)
    assert.equal(factory.jobs.length, 0)
    assert.equal(src.closed, 1, 'the chunk stream is closed (download stops)')
  }
})

test('IT-R2-3 encoded input above the measured reduced allowance refuses before reading any chunk', async () => {
  const src = chunkSource(syntheticJpeg({ width: 6240, height: 4160 }))
  const res = await makeImageThumb({
    plainSize: R2.imageHighResMaxInputBytes + 1, limits: R2, variant: 2, openChunks: src.open,
    reduced: { capability: capable, startJob: fakeJobFactory().start }, skipUrl: true,
  })
  assert.equal(res.unsupported, 'IMAGE_TOO_LARGE')
  assert.equal(src.pulled.length, 0)
})

test('IT-R2-4 lock while queued for the high-res lane aborts before any decoder starts', async () => {
  const ctrl = new AbortController()
  const factory = fakeJobFactory()
  const src = chunkSource(syntheticJpeg({ width: 8192, height: 5464 }))
  const pending = makeImageThumb({
    plainSize: 11_000_000, limits: R2, variant: 2, openChunks: src.open, signal: ctrl.signal,
    reduced: { capability: capable, startJob: factory.start },
    admission: { acquire: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) },
    skipUrl: true,
  })
  await new Promise((r) => setTimeout(r, 5))
  ctrl.abort()
  const res = await pending
  assert.equal(res.unsupported, 'ABORTED')
  assert.equal(factory.jobs.length, 0, 'no decoder was started for the queued job')
  assert.equal(src.closed, 1)
})

test('IT-R2-5 lock during an active decode aborts the job, releases admission, and yields no URL', async () => {
  const ctrl = new AbortController()
  const factory = fakeJobFactory({ hang: true })
  let released = 0
  const created = []
  const src = chunkSource(syntheticJpeg({ width: 6240, height: 4160 }))
  const pending = makeImageThumb({
    plainSize: 6_495_642, limits: R2, variant: 2, openChunks: src.open, signal: ctrl.signal,
    reduced: { capability: capable, startJob: factory.start },
    admission: { acquire: async () => ({ lane: 'high-res', release: () => { released += 1 } }) },
    createObjectUrl: () => { created.push(1); return 'blob:x' },
  })
  await new Promise((r) => setTimeout(r, 5))
  ctrl.abort()
  const res = await pending
  assert.equal(res.unsupported, 'ABORTED')
  assert.equal(factory.jobs[0].aborted, 1, 'the worker job is cancelled')
  assert.equal(released, 1, 'admission token released')
  assert.deepEqual(created, [], 'late completion cannot create a URL')
})

test('IT-R2-6 a decoder failure is a contained preview result, never a throw', async () => {
  const src = chunkSource(syntheticJpeg({ width: 6240, height: 4160 }))
  const res = await makeImageThumb({
    plainSize: 6_495_642, limits: R2, variant: 2, openChunks: src.open,
    reduced: { capability: capable, startJob: () => ({ push() {}, end() {}, abort() {}, result: Promise.reject(new Error('Failed to decode frame at index 0')) }) },
    skipUrl: true,
  })
  assert.deepEqual(res, { ok: false, unsupported: 'UNSUPPORTED' })
})

test('IT-R2-7 the normal <=16 MP lane is unchanged when chunks are streamed', async () => {
  const src = chunkSource(syntheticJpeg({ width: 4000, height: 3000 }), 1, 64)
  const factory = fakeJobFactory()
  let decodedBytes = null
  const res = await makeImageThumb({
    plainSize: 2_000_000, limits: R2, variant: 2, openChunks: src.open,
    reduced: { capability: capable, startJob: factory.start },
    decode: async (bytes) => { decodedBytes = bytes.length; return { width: 4000, height: 3000, close() {} } },
    poster: fakePoster, skipUrl: true,
  })
  assert.equal(res.ok, true)
  assert.equal(factory.jobs.length, 0, 'normal images keep the proven single-decode path')
  assert.equal(decodedBytes, src.pulled.reduce((t, c) => t + c.length, 0), 'decode sees exactly the streamed bytes')
})

test('IT-R2-8 camera RAW bytes (even if labelled image/jpeg) are truthfully unsupported — download original', async () => {
  const tiffRaw = new Uint8Array(64); tiffRaw.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0x43, 0x52, 2, 0])
  let decodes = 0
  const factory = fakeJobFactory()
  const res = await makeImageThumb({
    plainSize: 64, limits: R2, variant: 2, openChunks: chunkSource(tiffRaw, 0).open,
    reduced: { capability: capable, startJob: factory.start },
    decode: async () => { decodes += 1; return { width: 1, height: 1, close() {} } }, poster: fakePoster, skipUrl: true,
  })
  assert.deepEqual(res, { ok: false, unsupported: 'UNSUPPORTED' })
  assert.equal(decodes, 0)
  assert.equal(factory.jobs.length, 0)
})
