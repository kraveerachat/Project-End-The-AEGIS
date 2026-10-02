import test from 'node:test'
import assert from 'node:assert/strict'
import { createThumbScheduler } from '../src/lib/vaultThumbScheduler.js'
import { createDerivativeTileLane, createDerivativeFirstScheduler } from '../src/lib/vaultPreviewIndexTileLane.js'

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('PIL-1 slow derivative work has a separate bound and does not occupy original slots', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let originalLoads = 0, derivativeLoads = 0
  const original = createThumbScheduler({
    limits: { maxConcurrentJobs: 4, maxRetainedObjectUrls: 8, memoryCeilingBytes: 16 * 1024 * 1024 },
    load: async () => { originalLoads++; await gate; return { width: 1, height: 1, bytes: new Uint8Array([1]) } },
    createObjectUrl: () => 'blob:original', revokeObjectUrl: () => {},
  })
  const lane = createDerivativeTileLane({
    maxConcurrentJobs: 2,
    tryTile: async () => { derivativeLoads++; await gate; return null },
    onFallback: (key, opts) => original.observe(key, opts),
    onReady: () => {},
  })
  lane.observe('d1', { folderId: 'root', estimateBytes: 10_000_000 })
  lane.observe('d2', { folderId: 'root', estimateBytes: 10_000_000 })
  lane.observe('d3', { folderId: 'root', estimateBytes: 10_000_000 })
  original.observe('independent', { estimateBytes: 1 })
  await tick()
  assert.equal(lane.stats().running, 2)
  assert.equal(lane.stats().queued, 1)
  assert.equal(derivativeLoads, 2)
  assert.equal(originalLoads, 1, 'original lane starts while derivative reads are blocked')
  release(); await tick()
  assert.equal(derivativeLoads, 3)
  await lane.releaseAll(); await original.releaseAll()
})

test('PIL-2 verified derivative publishes once; a miss enters original lane once', async () => {
  const ready = [], fallback = []
  const lane = createDerivativeTileLane({
    maxConcurrentJobs: 2,
    tryTile: async (key) => key === 'hit' ? { width: 2, height: 2, bytes: new Uint8Array([4]) } : null,
    onReady: (key) => ready.push(key),
    onFallback: (key) => fallback.push(key),
  })
  lane.observe('hit', { folderId: 'root', estimateBytes: 100_000_000 })
  lane.observe('miss', { folderId: 'root', estimateBytes: 100_000_000 })
  await tick()
  assert.deepEqual(ready, ['hit'])
  assert.deepEqual(fallback, ['miss'])
  assert.equal(lane.take('hit').bytes[0], 4)
  assert.equal(lane.take('hit'), null)
  await lane.releaseAll()
})

test('PIL-3 canceled in-flight result is wiped and never published', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const bytes = new Uint8Array([7, 8, 9])
  let published = 0
  const lane = createDerivativeTileLane({
    maxConcurrentJobs: 1,
    tryTile: async () => { await gate; return { bytes } },
    onReady: () => { published++ },
    onFallback: () => { published++ },
  })
  lane.observe('stale')
  await tick()
  lane.cancel('stale')
  release(); await tick()
  assert.deepEqual([...bytes], [0, 0, 0])
  assert.equal(published, 0)
  await lane.releaseAll()
})

test('PIL-4 completed keys do not replay; source replacement and removal invalidate staged or ready results', async () => {
  let combined
  let derivativeLoads = 0
  const original = createThumbScheduler({
    limits: { maxConcurrentJobs: 4, maxRetainedObjectUrls: 8, memoryCeilingBytes: 16 * 1024 * 1024 },
    load: async (key) => combined.take(key) ?? { width: 1, height: 1, bytes: new Uint8Array([1]) },
    createObjectUrl: () => 'blob:tile', revokeObjectUrl: () => {},
  })
  combined = createDerivativeFirstScheduler({
    original, maxConcurrentJobs: 2,
    tryTile: async () => { derivativeLoads++; return { width: 2, height: 2, bytes: new Uint8Array([2]) } },
  })
  combined.observe('a', { sourceBlobId: 'blob-a', folderId: 'root', estimateBytes: 1 })
  combined.observe('b', { sourceBlobId: 'blob-b', folderId: 'root', estimateBytes: 1 })
  await tick()
  assert.equal(original.snapshot().get('a')?.state, 'ready')
  assert.equal(original.snapshot().get('b')?.state, 'ready')
  assert.equal(derivativeLoads, 2)
  for (let i = 0; i < 5; i++) combined.observe('a', { sourceBlobId: 'blob-a', folderId: 'root', estimateBytes: 1 })
  combined.observe('c', { sourceBlobId: 'blob-c', folderId: 'root', estimateBytes: 1 })
  await tick()
  assert.equal(derivativeLoads, 3, 'refresh does not replay completed keys')
  assert.equal(combined.derivativeStats().staged, 0)
  assert.equal(original.snapshot().get('c')?.state, 'ready')

  combined.observe('a', { sourceBlobId: 'blob-a2', folderId: 'root', estimateBytes: 1 })
  await tick()
  assert.equal(derivativeLoads, 4, 'replacement invalidates previous ready result')
  combined.reconcileVisible(new Set(['a', 'c']))
  assert.equal(original.snapshot().has('b'), false, 'removed/trashed tile is released')
  await combined.releaseAll()
})

test('PIL-5 source replacement while derivative is staged discards old bytes before publication', async () => {
  let combined
  let releaseOriginal
  const blocker = new Promise((resolve) => { releaseOriginal = resolve })
  const originals = []
  const original = createThumbScheduler({
    limits: { maxConcurrentJobs: 1, maxRetainedObjectUrls: 8, memoryCeilingBytes: 16 * 1024 * 1024 },
    load: async (key) => {
      if (key === 'blocker') { await blocker; return { width: 1, height: 1, bytes: new Uint8Array([1]) } }
      const result = combined.take(key)
      originals.push(result?.bytes?.[0] ?? 0)
      return result ?? { width: 1, height: 1, bytes: new Uint8Array([1]) }
    },
    createObjectUrl: () => 'blob:tile', revokeObjectUrl: () => {},
  })
  original.observe('blocker', { estimateBytes: 1 })
  const oldBytes = new Uint8Array([8])
  let calls = 0
  combined = createDerivativeFirstScheduler({
    original, maxConcurrentJobs: 2,
    tryTile: async () => (++calls === 1 ? { width: 2, height: 2, bytes: oldBytes } : { width: 2, height: 2, bytes: new Uint8Array([9]) }),
  })
  combined.observe('tile', { sourceBlobId: 'old', folderId: 'root', estimateBytes: 1 })
  await tick()
  assert.equal(combined.derivativeStats().staged, 1)
  combined.observe('tile', { sourceBlobId: 'new', folderId: 'root', estimateBytes: 1 })
  assert.deepEqual([...oldBytes], [0], 'old staged derivative wiped on replacement')
  releaseOriginal(); await tick()
  assert.deepEqual(originals, [9], 'only replacement derivative reaches renderer')
  await combined.releaseAll()
})

test('PIL-6 refresh while staged retains derivative-size admission, even for an oversized original', async () => {
  let combined, releaseOriginal
  const blocker = new Promise((resolve) => { releaseOriginal = resolve })
  const original = createThumbScheduler({
    limits: { maxConcurrentJobs: 1, maxRetainedObjectUrls: 8, memoryCeilingBytes: 1024 * 1024 },
    load: async (key) => {
      if (key === 'blocker') { await blocker; return { width: 1, height: 1, bytes: new Uint8Array([1]) } }
      return combined.take(key) ?? { width: 1, height: 1, bytes: new Uint8Array([1]) }
    },
    createObjectUrl: () => 'blob:tile', revokeObjectUrl: () => {},
  })
  original.observe('blocker', { estimateBytes: 1 })
  combined = createDerivativeFirstScheduler({
    original, maxConcurrentJobs: 1,
    tryTile: async () => ({ width: 2, height: 2, bytes: new Uint8Array([2]) }),
  })
  const huge = { sourceBlobId: 'source', folderId: 'root', estimateBytes: 300 * 1024 * 1024 }
  combined.observe('tile', huge)
  await tick()
  assert.equal(combined.derivativeStats().staged, 1)
  combined.observe('tile', huge)
  releaseOriginal(); await tick()
  assert.equal(original.snapshot().get('tile')?.state, 'ready')
  assert.equal(combined.derivativeStats().staged, 0)
  await combined.releaseAll()
})
