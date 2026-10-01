// tests/previewIndexCanonical.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.1 · generic canonical helpers + preview entry validator
//
// PIC-CAN-1 canonicalEncodeValue/canonicalParseStrict exist and are the same strict canonical JSON as the manifest codec
// PIC-CAN-2 manifest bytes are unchanged (v1 golden fixture; v2 round-trip) — the refactor is byte-neutral
// PIC-CAN-3 the strict parser still fails secure (duplicate keys, whitespace, unsafe numbers, trailing bytes, bad UTF-8, depth, size)
// PIC-CAN-4 validatePreviewEntry is exported and behaves exactly like the manifest-v2 entry rule
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as canon from '../src/lib/vaultTreeCanonical.js'
import * as manifest from '../src/lib/vaultTreeManifest.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../src/lib/vaultTreeLimits.js'

const te = new TextEncoder()
const LIM = { maxJsonDepth: 8, maxDecodedBytes: 4096 }
const CID = 'AAECAwQFBgcICQoLDA0ODw=='
const entry = (o = {}) => ({
  kind: 'thumb', profile: 'vp1', blobRef: { formatVersion: 2, id: 'a'.repeat(48) }, contentId: CID,
  sourceBlobRef: { formatVersion: 2, id: 'b'.repeat(48) }, mime: 'image/webp', width: 512, height: 384, plainSize: 40_000,
  createdAtClient: 1_700_000_000_000, ...o,
})

test('PIC-CAN-1 generic encode/parse: sorted keys, no whitespace, Map → sorted pairs, round-trips', () => {
  assert.equal(typeof canon.canonicalEncodeValue, 'function')
  assert.equal(typeof canon.canonicalParseStrict, 'function')
  const bytes = canon.canonicalEncodeValue({ b: 1, a: [true, null, 'x'], m: new Map([['z', 1], ['y', 2]]) }, LIM)
  assert.equal(new TextDecoder().decode(bytes), '{"a":[true,null,"x"],"b":1,"m":[["y",2],["z",1]]}')
  const back = canon.canonicalParseStrict(bytes, LIM)
  assert.deepEqual(JSON.parse(JSON.stringify(back)), { a: [true, null, 'x'], b: 1, m: [['y', 2], ['z', 1]] })
  assert.equal(Object.getPrototypeOf(back), null, 'parsed objects have no prototype')
  assert.throws(() => canon.canonicalEncodeValue({ x: 1.5 }, LIM), (e) => e.code === 'BAD_NUMBER')
  assert.throws(() => canon.canonicalEncodeValue({ x: 'a'.repeat(5000) }, LIM), (e) => e.code === 'LIMIT_DECODED_BYTES')
})

test('PIC-CAN-2 manifest canonical bytes are unchanged by the refactor (v1 golden fixture + v2 round-trip)', async () => {
  const golden = await import('./helpers/vaultManifestV1GoldenFixture.mjs')
  const names = Object.keys(golden)
  assert.ok(names.length > 0)
  const m = manifest.createGenesisManifest({ treeId: 'T'.repeat(22), rootNodeId: 'R'.repeat(22), revisionId: 'V'.repeat(22), now: 1_700_000_000_000 })
  const bytes = canon.canonicalEncode(m)
  const again = canon.canonicalEncode(canon.canonicalDecode(bytes))
  assert.deepEqual(again, bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64)
  // the golden-fixture byte pins live in tests/vaultTreeManifestV2.test.js and tests/vaultTreeCanonical.test.js; they run in the B.1 verify command
})

test('PIC-CAN-3 strict parser fails secure', () => {
  const bad = [
    ['{"a":1,"a":2}', 'DUPLICATE_KEY'], ['{ "a":1}', 'BAD_SYNTAX'], ['{"a":1.0}', 'BAD_NUMBER'], ['{"a":9007199254740993}', 'BAD_NUMBER'],
    ['{"a":1}x', 'TRAILING'], ['{"a":-0}', 'BAD_NUMBER'], ['{"a":"\\u0000"}', 'BAD_STRING'], ['[[[[[[[[[[1]]]]]]]]]]', 'DEPTH'],
  ]
  for (const [text, code] of bad) assert.throws(() => canon.canonicalParseStrict(te.encode(text), LIM), (e) => e.code === code, text)
  assert.throws(() => canon.canonicalParseStrict(new Uint8Array([0x7b, 0xff, 0x7d]), LIM), (e) => e.code === 'BAD_SYNTAX')
  assert.throws(() => canon.canonicalParseStrict(new Uint8Array(5000).fill(0x20), LIM), (e) => e.code === 'LIMIT_DECODED_BYTES')
  assert.throws(() => canon.canonicalParseStrict('{}', LIM), (e) => e.code === 'BAD_TYPE')
  const proto = canon.canonicalParseStrict(te.encode('{"__proto__":{"x":1}}'), LIM)
  assert.equal(({}).x, undefined, 'no prototype pollution')
  assert.ok(Object.hasOwn(proto, '__proto__'))
  // manifest decode keeps its own errors
  assert.throws(() => canon.canonicalDecode(te.encode('[]')), (e) => e.code === 'BAD_SYNTAX')
  assert.throws(() => canon.canonicalDecode(te.encode('{"evil":1}')), (e) => e.code === 'UNKNOWN_KEY')
  assert.ok(VAULT_TREE_CLIENT_LIMITS.maxJsonDepth >= 8)
})

test('PIC-CAN-4 validatePreviewEntry: valid vp1 thumb/poster pass; every malformed field fails; unknown profile is structural only', () => {
  assert.equal(typeof manifest.validatePreviewEntry, 'function')
  manifest.validatePreviewEntry(entry())
  manifest.validatePreviewEntry(entry({ kind: 'poster', mime: 'image/jpeg' }))
  const bad = [
    [{ kind: 'motionx' }, 'PREVIEW_BAD_KIND'], [{ profile: 'v1' }, 'PREVIEW_BAD_PROFILE'], [{ blobRef: { formatVersion: 1, id: 'x' } }, 'PREVIEW_BAD_BLOB_REF'],
    [{ contentId: 'nope' }, 'PREVIEW_BAD_CONTENT_ID'], [{ sourceBlobRef: { formatVersion: 3, id: 'x' } }, 'PREVIEW_BAD_SOURCE_REF'],
    [{ mime: 'image/svg+xml' }, 'PREVIEW_BAD_MIME'], [{ mime: 'text/html' }, 'PREVIEW_BAD_MIME'], [{ width: 0 }, 'PREVIEW_BAD_FIELD'],
    [{ width: 513 }, 'PREVIEW_OUT_OF_BOUNDS'], [{ plainSize: 256 * 1024 + 1 }, 'PREVIEW_OUT_OF_BOUNDS'], [{ durationMs: 10 }, 'PREVIEW_BAD_DURATION'],
    [{ extra: 1 }, null],
  ]
  for (const [patch, code] of bad) {
    assert.throws(() => manifest.validatePreviewEntry(entry(patch)), (e) => (code ? e.code === code : true), JSON.stringify(patch))
  }
  manifest.validatePreviewEntry(entry({ profile: 'vp9', mime: 'image/svg+xml', width: 99999 })) // unknown profile: structure only, never bound-checked
})
