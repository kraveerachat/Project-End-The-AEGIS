// tests/previewIndexRouting.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.3 · hashed shard routing
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { routingBits, prefixOf, assertPrefixFree, resolveShardDescriptor, IndexCodecError } from '../src/lib/vaultPreviewIndexRouting.js'

const BOUNDS = { minBits: 6, maxBits: 7 }
const id22 = () => randomBytes(16).toString('base64url')

test('PIR-1 routingBits: deterministic, 32 bytes, domain-separated from a plain SHA-256 of the node id; known vectors', async () => {
  const a = await routingBits('AAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(a.length, 32)
  assert.deepEqual(await routingBits('AAAAAAAAAAAAAAAAAAAAAA'), a)
  assert.equal(Buffer.from(a).toString('hex').slice(0, 8), 'a24d6f6a')
  assert.equal(prefixOf(a, 8), '10100010')
  assert.equal(prefixOf(a, 6), '101000')
  const plain = createHash('sha256').update('AAAAAAAAAAAAAAAAAAAAAA').digest()
  assert.notDeepEqual(Buffer.from(a), plain)
  const independent = createHash('sha256').update('AEGIS-VPI-ROUTE-v1:' + 'AAAAAAAAAAAAAAAAAAAAAA').digest()
  assert.deepEqual(Buffer.from(a), independent)
  for (const bad of ['', 'short', 'A'.repeat(23), 'A'.repeat(21) + '!', null, 42]) await assert.rejects(routingBits(bad), IndexCodecError, String(bad))
})

test('PIR-2 prefixOf extracts MSB-first bits; rejects bad lengths', async () => {
  const bits = new Uint8Array([0b10110000, 0xff])
  assert.equal(prefixOf(bits, 1), '1')
  assert.equal(prefixOf(bits, 4), '1011')
  assert.equal(prefixOf(bits, 9), '101100001')
  assert.throws(() => prefixOf(bits, 0), IndexCodecError)
  assert.throws(() => prefixOf(bits, 17), IndexCodecError)
})

test('PIR-3 assertPrefixFree rejects duplicates, nesting, wrong lengths, non-binary and unsorted sets', () => {
  assertPrefixFree([], BOUNDS)
  assertPrefixFree(['000000', '000001', '0000100', '0000101', '111111'], BOUNDS)
  const bad = [
    ['000000', '000000'], ['010101', '0101010'], ['01010', '111111'], ['01010101'], ['01010a'], ['111111', '000000'], [123],
  ]
  for (const set of bad) assert.throws(() => assertPrefixFree(set, BOUNDS), (e) => e instanceof IndexCodecError && e.code === 'BAD_PREFIX_SET', JSON.stringify(set))
})

test('PIR-4 resolveShardDescriptor returns the unique covering descriptor or null for a sparse prefix', async () => {
  const root = { shards: [{ prefix: '000000' }, { prefix: '1010000' }, { prefix: '1010001' }, { prefix: '111111' }] }
  const bits = await routingBits('AAAAAAAAAAAAAAAAAAAAAA') // 1010 0010 …
  assert.equal(resolveShardDescriptor(root, bits).prefix, '1010001', 'split child covering 1010001')
  assert.equal(resolveShardDescriptor({ shards: [{ prefix: '000000' }, { prefix: '1010000' }, { prefix: '111111' }] }, bits), null, 'sparse: 1010001 has no shard')
  const root2 = { shards: [{ prefix: '101000' }] }
  assert.equal(resolveShardDescriptor(root2, bits).prefix, '101000')
  const root3 = { shards: [{ prefix: '1010001' }] }
  assert.equal(resolveShardDescriptor(root3, bits).prefix, '1010001')
  assert.equal(resolveShardDescriptor({ shards: [] }, bits), null)
})

test('PIR-5 uniformity sanity: 10,000 random ids over 64 prefixes stay within 2× the mean (sanity only — not a capacity claim)', async () => {
  const counts = new Map()
  for (let i = 0; i < 10_000; i++) { const p = prefixOf(await routingBits(id22()), 6); counts.set(p, (counts.get(p) ?? 0) + 1) }
  assert.equal(counts.size, 64)
  const mean = 10_000 / 64
  assert.ok(Math.max(...counts.values()) <= 2 * mean, `max ${Math.max(...counts.values())}`)
  assert.ok(Math.min(...counts.values()) >= mean / 2, `min ${Math.min(...counts.values())}`)
})
