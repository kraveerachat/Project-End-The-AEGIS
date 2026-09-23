import test from 'node:test'
import assert from 'node:assert/strict'

import { createVaultPreviewBlob } from '../src/lib/vaultPreviewBlob.js'

test('VPB-1 buffered V2 chunks remain binary Blob parts instead of being stringified', async () => {
  const blob = createVaultPreviewBlob([
    new Uint8Array([0, 1, 2]),
    new Uint8Array([253, 254, 255]),
  ], 'video/webm')
  assert.equal(blob.type, 'video/webm')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([0, 1, 2, 253, 254, 255]))
})

test('VPB-2 a single V1 byte array remains a single binary part', async () => {
  const blob = createVaultPreviewBlob(new Uint8Array([9, 8, 7]), 'video/mp4')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([9, 8, 7]))
})
