import test from 'node:test'
import assert from 'node:assert/strict'

import { GCM_TAG_BYTES } from '../src/lib/vaultChunkCrypto.js'
import { PREVIEW_RANGE_WINDOW_BYTES } from '../src/lib/vaultPreviewRange.js'
import { planPreviewResponse } from '../src/lib/vaultPreviewResponder.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const PLAIN_CHUNK = 32 * MIB

const logicalSession = (plainSize) => ({
  dek: {},
  plainSize,
  contentType: 'video/mp4',
  blob: {
    id: 'b'.repeat(48),
    contentIdB64: 'Y29udGVudA==',
    chunkSize: PLAIN_CHUNK + GCM_TAG_BYTES,
    chunkCount: Math.ceil(plainSize / PLAIN_CHUNK),
  },
})

test('open-ended Chromium ranges stay bounded for 100 MiB, 1.1 GiB, 5 GiB and 32 GiB logical files', () => {
  const sizes = [100 * MIB, Math.floor(1.1 * GIB), 5 * GIB, 32 * GIB]
  for (const size of sizes) {
    const result = planPreviewResponse(logicalSession(size), { rangeHeader: 'bytes=0-' })
    assert.equal(result.status, 206)
    assert.equal(Number(result.headers['Content-Length']), PREVIEW_RANGE_WINDOW_BYTES)
    assert.equal(result.headers['Content-Range'], `bytes 0-${PREVIEW_RANGE_WINDOW_BYTES - 1}/${size}`)
    assert.equal(result.plan.length, 1,
      `logical size ${size} must not affect chunks planned near the start`)
  }
})

test('bounded open-ended range crossing a chunk edge reads exactly two chunks', () => {
  const size = 5 * GIB
  const start = PLAIN_CHUNK - Math.floor(PREVIEW_RANGE_WINDOW_BYTES / 2)
  const result = planPreviewResponse(logicalSession(size), { rangeHeader: `bytes=${start}-` })
  assert.equal(result.plan.length, 2)
  assert.deepEqual(result.plan.map((step) => step.index), [0, 1])
  assert.equal(Number(result.headers['Content-Length']), PREVIEW_RANGE_WINDOW_BYTES)
})

test('finite and suffix ranges remain exact while only open-ended ranges are bounded', () => {
  const size = 32 * GIB
  const finite = planPreviewResponse(logicalSession(size), { rangeHeader: 'bytes=1000000-1999999' })
  assert.equal(finite.headers['Content-Range'], `bytes 1000000-1999999/${size}`)
  assert.equal(finite.headers['Content-Length'], '1000000')

  const suffix = planPreviewResponse(logicalSession(size), { rangeHeader: 'bytes=-1048576' })
  assert.equal(suffix.headers['Content-Range'], `bytes ${size - MIB}-${size - 1}/${size}`)
  assert.equal(suffix.headers['Content-Length'], String(MIB))
})

test('EOF and zero-byte files retain correct 206/416 semantics', () => {
  const size = 100 * MIB
  const eof = planPreviewResponse(logicalSession(size), { rangeHeader: `bytes=${size - 3}-` })
  assert.equal(eof.headers['Content-Length'], '3')
  assert.equal(eof.headers['Content-Range'], `bytes ${size - 3}-${size - 1}/${size}`)

  const empty = planPreviewResponse(logicalSession(0), { rangeHeader: 'bytes=0-' })
  assert.equal(empty.status, 416)
  assert.equal(empty.headers['Content-Range'], 'bytes */0')
})
