// tests/previewIndexConstants.test.js — AEGIS Drive (IDEA1) · D-1 preview-index limit disposition
import test from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../src/lib/vaultPreviewIndexConstants.js'
import * as formats from '../src/lib/preview/formats.js'

const KiB = 1024, MiB = 1024 * KiB

test('PIK-1 versions, markers, write kinds/profile and route base', () => {
  assert.equal(C.PREVIEW_INDEX_SCHEMA_VERSION, 1)
  assert.deepEqual(C.PREVIEW_INDEX_SCHEMA_VERSIONS_READ, [1])
  assert.equal(C.INDEX_ROOT_MARKER, 'application/vnd.aegis.vault-preview-index-root.v1')
  assert.equal(C.INDEX_SHARD_MARKER, 'application/vnd.aegis.vault-preview-index-shard.v1')
  assert.notEqual(C.INDEX_ROOT_MARKER, C.INDEX_SHARD_MARKER)
  assert.deepEqual(C.D1_WRITE_KINDS, ['thumb', 'poster'])
  assert.equal(C.D1_WRITE_PROFILE, 'vp1')
  assert.deepEqual(C.DERIVATIVE_MIMES, ['image/webp', 'image/jpeg'])
  assert.equal(C.PREVIEW_INDEX_UPLOAD_ROUTE_BASE, '/api/vault/tree/preview-index/uploads')
  for (const o of [C.PREVIEW_INDEX_SCHEMA_VERSIONS_READ, C.D1_WRITE_KINDS, C.DERIVATIVE_MIMES, C.PREVIEW_INDEX_LIMITS]) assert.equal(Object.isFrozen(o), true)
})

test('PIK-2 markers never collide with any MIME the app knows', () => {
  const known = JSON.stringify(formats)
  assert.equal(known.includes(C.INDEX_ROOT_MARKER), false)
  assert.equal(known.includes(C.INDEX_SHARD_MARKER), false)
})

test('PIK-3 HG-G approved values stay exact; unapproved keys remain explicit', () => {
  assert.deepEqual({ ...C.PREVIEW_INDEX_LIMITS, shardPaddingBuckets: [...C.PREVIEW_INDEX_LIMITS.shardPaddingBuckets], rootPaddingBuckets: [...C.PREVIEW_INDEX_LIMITS.rootPaddingBuckets] }, {
    initialPrefixBits: 6, maxPrefixBits: 7, maxShards: 128, maxShardDecodedBytes: 192 * KiB,
    shardPaddingBuckets: [16 * KiB, 32 * KiB, 64 * KiB, 128 * KiB, 256 * KiB],
    maxRootDecodedBytes: 16 * KiB - 5, rootPaddingBuckets: [4 * KiB, 8 * KiB, 16 * KiB],
    maxEntriesPerCas: 16, casMaxAttempts: 5, writeQueueMax: 64, backfillMaxPerSession: 50, backfillConcurrency: 1,
    derivativeLaneConcurrency: 6, ciphertextLruBytes: 32 * MiB, maxLiveDecodedShards: 16, generationBudgetMs: 10_000,
    maxJsonDepth: 8,
  })
  assert.deepEqual([...C.APPROVED_KEYS].sort(), [
    'initialPrefixBits', 'maxPrefixBits', 'maxShards', 'maxShardDecodedBytes',
    'maxRootDecodedBytes', 'maxEntriesPerCas', 'ciphertextLruBytes',
  ].sort())
  assert.deepEqual([...C.PROVISIONAL_KEYS].sort(), [
    'shardPaddingBuckets', 'rootPaddingBuckets', 'casMaxAttempts', 'writeQueueMax',
    'backfillMaxPerSession', 'backfillConcurrency', 'derivativeLaneConcurrency',
    'maxLiveDecodedShards', 'generationBudgetMs',
  ].sort())
  assert.deepEqual([...C.APPROVED_KEYS, ...C.PROVISIONAL_KEYS].sort(), Object.keys(C.PREVIEW_INDEX_LIMITS).filter((k) => k !== 'maxJsonDepth').sort())
  assert.equal(C.HG_G_APPROVAL.date, '2026-10-03')
  assert.equal(C.HG_G_APPROVAL.source, 'HG_G_APPROVED / PR #310 / 89da7f84d7279871f6e10df5df3e6b78594e5ef8')
  assert.ok(C.PREVIEW_INDEX_LIMITS.maxShardDecodedBytes + 5 <= C.PREVIEW_INDEX_LIMITS.shardPaddingBuckets.at(-1))
  assert.ok(C.PREVIEW_INDEX_LIMITS.maxRootDecodedBytes + 5 <= C.PREVIEW_INDEX_LIMITS.rootPaddingBuckets.at(-1))
  assert.equal(2 ** C.PREVIEW_INDEX_LIMITS.maxPrefixBits, C.PREVIEW_INDEX_LIMITS.maxShards)
})
