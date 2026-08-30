import test from 'node:test'
import assert from 'node:assert/strict'

import { createPreviewDiagnostics } from '../src/lib/vaultPreviewDiagnostics.js'

test('diagnostics are disabled by default and emit only allowlisted operational metrics', () => {
  const disabled = []
  createPreviewDiagnostics({ emit: (entry) => disabled.push(entry) }).record('range', { requestNumber: 1 })
  assert.deepEqual(disabled, [])

  const emitted = []
  const diagnostics = createPreviewDiagnostics({ enabled: true, emit: (entry) => emitted.push(entry) })
  diagnostics.record('range', {
    requestNumber: 7,
    requestStart: 0,
    requestEnd: 99,
    responseStart: 0,
    responseEnd: 99,
    chunkIndexes: [0, 1],
    cacheHits: 1,
    cacheMisses: 2,
    fetchDurationMs: 4,
    decryptDurationMs: 3,
    queueWaitDurationMs: 2,
    responseDurationMs: 9,
    plaintextBytes: 2_000_000,
    effectivePlaintextMBps: 222.22,
    prefetchHits: 1,
    prefetchMisses: 2,
    activeLoadCount: 2,
    demandChunkIndex: 12,
    prefetchedChunkIndex: 13,
    rehydrationCount: 1,
    failureCategory: 'network',
    token: 'secret-token',
    dek: 'secret-key',
    filename: 'private.mp4',
    plaintext: 'private bytes',
    authorization: 'Bearer secret',
  })

  assert.equal(emitted.length, 1)
  const serialised = JSON.stringify(emitted[0])
  for (const secret of ['secret-token', 'secret-key', 'private.mp4', 'private bytes', 'Bearer secret']) {
    assert.equal(serialised.includes(secret), false)
  }
  assert.deepEqual(emitted[0].chunkIndexes, [0, 1])
  assert.equal(emitted[0].requestNumber, 7)
  assert.equal(emitted[0].queueWaitDurationMs, 2)
  assert.equal(emitted[0].effectivePlaintextMBps, 222.22)
  assert.equal(emitted[0].prefetchHits, 1)
  assert.equal(emitted[0].prefetchMisses, 2)
  assert.equal(emitted[0].activeLoadCount, 2)
  assert.equal(emitted[0].demandChunkIndex, 12)
  assert.equal(emitted[0].prefetchedChunkIndex, 13)
})
