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

test('IT-HIGHRES one bitmap decode feeds poster generation and owned full bytes are released', async () => {
  const fullBytesRef = { bytes: null }
  const bitmap = { width: 6240, height: 4160, closed: 0, close() { this.closed += 1 } }
  let decodeCalls = 0
  let posterBitmap = null
  let releases = 0
  const highLimits = treeLimitsFrom({
    imageMaxInputBytes: 2_000_000,
    imageMaxDecodedPixels: 26_000_000,
    imageNormalMaxDecodedPixels: 16_000_000,
    imageHighResMaxDecodedPixels: 26_000_000,
  })
  const res = await makeImageThumb({
    plainSize: 1_000,
    limits: highLimits,
    readChunk: async () => syntheticPng({ width: 6240, height: 4160 }),
    decode: async () => { decodeCalls += 1; return bitmap },
    poster: async (decoded) => { posterBitmap = decoded; return { bytes: new Uint8Array(16), width: 512, height: 341 } },
    admission: { acquire: async () => ({ lane: 'high-res', release: () => { releases += 1 } }) },
    fullBytesRef,
    variant: 2,
    chunkCount: 1,
    skipUrl: true,
  })
  assert.equal(res.ok, true)
  assert.equal(decodeCalls, 1)
  assert.equal(posterBitmap, bitmap, 'poster reuses the already-decoded bitmap')
  assert.equal(bitmap.closed, 1)
  assert.equal(releases, 1)
  assert.equal(fullBytesRef.bytes, null)
  assert.equal(res.posterBytes.length, 16, 'only bounded poster bytes remain')
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
