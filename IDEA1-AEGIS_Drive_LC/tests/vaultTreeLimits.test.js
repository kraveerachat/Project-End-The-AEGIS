// tests/vaultTreeLimits.test.js — AEGIS Drive (IDEA1) · PR #157 Task 0.3 · frozen client tree limits
//
// ⚠️ This test IS the freeze. The literal table below is copied from the Limits
//    Register of docs/superpowers/plans/2026-09-19-idea1-private-vault-encrypted-hierarchy.md
//    (values selected at gate G0 from the Phase 0 evidence note). Changing a
//    product default without changing this table — or vice versa — fails here.
//    G0 values are MEASURED PROVISIONAL DEVELOPMENT LIMITS until Task 1.6
//    records G1_LIMIT_VALIDATION=PASS; that status is documentation, not code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { VAULT_TREE_CLIENT_LIMITS, PADDING_BUCKETS, treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'

const MIB = 1_048_576

// Limits Register → selected provisional defaults (G0, 2026-09-19)
const REGISTER = Object.freeze({
  maxCiphertextBytes: 16 * MIB + 16,   // 16 MiB padded plaintext + one 16-byte GCM tag
  maxDecodedBytes: 16 * MIB,           // last padding bucket
  maxNodes: 10_000,
  maxDepth: 64,
  maxNameBytes: 600,
  maxRecentOperationIds: 64,
  maxRebaseAttempts: 10,
  maxJsonDepth: 8,                     // manifest → nodes → node → lifecycle/blobRef (+ headroom)
  // Phase 7 media previews (Task 0.2 bench → G1-validated)
  imageMaxInputBytes: 16 * MIB,
  imageMaxDecodedPixels: 16_000_000,
  imageNormalMaxDecodedPixels: 16_000_000,
  imageHighResMaxDecodedPixels: 16_000_000,
  imageHighResMaxConcurrentJobs: 1,
  gifMaxFullPlayBytes: 8 * MIB,
  posterMaxEdge: 512,
  maxConcurrentJobs: 4,
  maxRetainedObjectUrls: 256,
  memoryCeilingBytes: 256 * MIB,
})

test('LM-HIGHRES the active cap stays 16 MP until native browser measurement promotes it', () => {
  assert.equal(VAULT_TREE_CLIENT_LIMITS.imageNormalMaxDecodedPixels, 16_000_000)
  assert.equal(VAULT_TREE_CLIENT_LIMITS.imageHighResMaxDecodedPixels, 16_000_000)
  assert.equal(VAULT_TREE_CLIENT_LIMITS.imageHighResMaxConcurrentJobs, 1)
  assert.equal(VAULT_TREE_CLIENT_LIMITS.memoryCeilingBytes, 256 * MIB)
})

// Smallest genesis manifest measured in Task 0.1 was 28 676 bytes at 100 nodes; an
// empty Vault's genesis (root only) is a few hundred bytes, so the table starts at 4 KiB.
const BUCKETS = Object.freeze([
  4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288,
  1 * MIB, 2 * MIB, 4 * MIB, 8 * MIB, 16 * MIB,
])

test('LM-1 VAULT_TREE_CLIENT_LIMITS is deep-frozen and equals the Limits Register table', () => {
  assert.equal(Object.isFrozen(VAULT_TREE_CLIENT_LIMITS), true)
  assert.equal(Object.isFrozen(PADDING_BUCKETS), true)
  assert.deepEqual({ ...VAULT_TREE_CLIENT_LIMITS }, REGISTER)
  assert.throws(() => { VAULT_TREE_CLIENT_LIMITS.maxNodes = 1 }, TypeError)
})

test('LM-2 treeLimitsFrom overrides one key and keeps the rest', () => {
  const l = treeLimitsFrom({ maxNodes: 5 })
  assert.equal(l.maxNodes, 5)
  for (const k of Object.keys(REGISTER)) if (k !== 'maxNodes') assert.equal(l[k], REGISTER[k], k)
  assert.equal(Object.isFrozen(l), true)
  assert.deepEqual({ ...treeLimitsFrom() }, REGISTER)
})

test('LM-3 treeLimitsFrom rejects non-integer, zero, negative and unknown keys', () => {
  assert.throws(() => treeLimitsFrom({ maxNodes: 1.5 }), TypeError)
  assert.throws(() => treeLimitsFrom({ maxNodes: 0 }), TypeError)
  assert.throws(() => treeLimitsFrom({ maxDepth: -1 }), TypeError)
  assert.throws(() => treeLimitsFrom({ maxNodes: '10' }), TypeError)
  assert.throws(() => treeLimitsFrom({ maxNodes: Number.MAX_SAFE_INTEGER + 2 }), TypeError)
  assert.throws(() => treeLimitsFrom({ nope: 1 }), TypeError)
  // an inherited (prototype) key is not an own override: it is ignored, never applied
  assert.equal(treeLimitsFrom({ __proto__: { maxNodes: 1 }, maxDepth: 2 }).maxNodes, REGISTER.maxNodes)
})

test('LM-4 padding bucket table is strictly increasing, starts at 4 KiB and ends at maxDecodedBytes', () => {
  assert.deepEqual([...PADDING_BUCKETS], BUCKETS)
  for (let i = 1; i < PADDING_BUCKETS.length; i++) assert.ok(PADDING_BUCKETS[i] > PADDING_BUCKETS[i - 1])
  assert.equal(PADDING_BUCKETS[0], 4_096)
  assert.equal(PADDING_BUCKETS.at(-1), VAULT_TREE_CLIENT_LIMITS.maxDecodedBytes)
  // every bucket is a power of two — a bucket hides node-count deltas up to its size
  for (const b of PADDING_BUCKETS) assert.equal(b & (b - 1), 0, `${b} is a power of two`)
})
