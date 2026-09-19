// tests/vaultTreeCanonical.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.3 · canonical serialization + padding
//
// ⚠️ นี่คือ "นิยามของรูปแบบ" ของ manifest plaintext: ลำดับ key, การเข้ารหัสสตริง, ตัวเลข, และ padding
//    JSON.parse ถูกใช้ในไฟล์นี้ "เฉพาะเป็น oracle" — โมดูลจริงต้องมี parser ของตัวเองที่ปฏิเสธ key ซ้ำ
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalEncode, canonicalDecode, padToBucket, stripPadding, CanonicalError, PADDING_TRAILER_BYTES,
} from '../src/lib/vaultTreeCanonical.js'
import { treeLimitsFrom, PADDING_BUCKETS } from '../src/lib/vaultTreeLimits.js'

const te = new TextEncoder(), td = new TextDecoder()
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
const LIMITS = treeLimitsFrom({ maxDecodedBytes: 1 << 20, maxJsonDepth: 8 })
const ID = (n) => String(n).padStart(22, 'A')

function node(id, parent, kind = 'file', name = `n${id}`) {
  const base = { nodeId: ID(id), kind, parentNodeId: parent === null ? null : ID(parent), name, createdAtClient: 1_700_000_000_000, modifiedAtClient: 1_700_000_000_001, lifecycle: { state: 'active' } }
  if (kind === 'file') Object.assign(base, { blobRef: { formatVersion: 2, id: `blob-${id}` }, mediaType: 'image/png', plainSize: 12_345 })
  return base
}
function manifest(nodesArr) {
  return {
    schemaVersion: 1, treeId: ID(900), generation: 3, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: 1_700_000_000_000, nodes: new Map(nodesArr.map((n) => [n.nodeId, n])), recentOperationIds: [ID(700), ID(701)],
  }
}
const THREE = manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs'), node(2, 1, 'file', 'a.png')])

test('CN-1 key insertion order never changes the bytes; frozen vector for the 3-node manifest', () => {
  const a = canonicalEncode(THREE, LIMITS)
  const shuffled = { recentOperationIds: THREE.recentOperationIds, nodes: new Map([...THREE.nodes.entries()].reverse()), createdAtClient: THREE.createdAtClient, rootNodeId: THREE.rootNodeId, baseRevisionId: THREE.baseRevisionId, revisionId: THREE.revisionId, generation: THREE.generation, treeId: THREE.treeId, schemaVersion: THREE.schemaVersion }
  assert.equal(hex(canonicalEncode(shuffled, LIMITS)), hex(a))
  // the vector: canonical JSON, sorted keys, no whitespace, nodes as a sorted array of [id, node] pairs
  const text = td.decode(a)
  assert.equal(text.startsWith('{"baseRevisionId":"' + ID(902) + '","createdAtClient":1700000000000,"generation":3,"nodes":[["' + ID(0) + '",{"createdAtClient":1700000000000,"kind":"folder","lifecycle":{"state":"active"},"modifiedAtClient":1700000000001,"name":"","nodeId":"' + ID(0) + '","parentNodeId":null}],["' + ID(1) + '"'), true, text.slice(0, 200))
  assert.equal(text.endsWith('"recentOperationIds":["' + ID(700) + '","' + ID(701) + '"],"revisionId":"' + ID(901) + '","rootNodeId":"' + ID(0) + '","schemaVersion":1,"treeId":"' + ID(900) + '"}'), true)
  assert.doesNotMatch(text, /\s/)
})

test('CN-2 nodes are encoded as a sorted array of [nodeId, node] pairs regardless of Map order', () => {
  const m = manifest([node(2, 0), node(0, null, 'folder', ''), node(1, 0)])
  const decoded = canonicalDecode(canonicalEncode(m, LIMITS), LIMITS)
  assert.deepEqual([...decoded.nodes.keys()], [ID(0), ID(1), ID(2)])
  assert.ok(decoded.nodes instanceof Map)
})

test('CN-3 duplicate keys at any depth are rejected', () => {
  const dupTop = te.encode('{"schemaVersion":1,"schemaVersion":1}')
  assert.throws(() => canonicalDecode(dupTop, LIMITS), (e) => e instanceof CanonicalError && e.code === 'DUPLICATE_KEY')
  const dupNested = te.encode('{"nodes":[["' + ID(0) + '",{"kind":"folder","kind":"file"}]]}')
  assert.throws(() => canonicalDecode(dupNested, LIMITS), (e) => e.code === 'DUPLICATE_KEY')
  // JSON.parse would silently accept both — the oracle proves the strict parser is stricter
  assert.doesNotThrow(() => JSON.parse(td.decode(dupTop)))
})

test('CN-4 numbers must be safe integers in plain decimal', () => {
  for (const bad of ['1.5', 'NaN', 'Infinity', '-0', '1e3', '9007199254740993', '-9007199254740993', '01', '+1', '.5']) {
    assert.throws(() => canonicalDecode(te.encode('{"generation":' + bad + '}'), LIMITS), (e) => e.code === 'BAD_NUMBER', bad)
  }
  assert.equal(canonicalDecode(te.encode('{"generation":-5}'), LIMITS).generation, -5)
  assert.equal(canonicalDecode(te.encode('{"generation":0}'), LIMITS).generation, 0)
  assert.throws(() => canonicalEncode({ generation: 1.5 }, LIMITS), (e) => e.code === 'BAD_NUMBER')
  assert.throws(() => canonicalEncode({ generation: 2 ** 53 }, LIMITS), (e) => e.code === 'BAD_NUMBER')
})

test('CN-5 depth, trailing bytes and unknown top-level keys are rejected', () => {
  const deep = '{"a":'.repeat(9) + '1' + '}'.repeat(9)
  assert.throws(() => canonicalDecode(te.encode(deep), treeLimitsFrom({ maxJsonDepth: 8 })), (e) => e.code === 'DEPTH')
  assert.throws(() => canonicalDecode(te.encode('{"generation":1} '), LIMITS), (e) => e.code === 'TRAILING')
  assert.throws(() => canonicalDecode(te.encode('{"generation":1}{}'), LIMITS), (e) => e.code === 'TRAILING')
  assert.throws(() => canonicalDecode(te.encode('{"generation":1,"extra":true}'), LIMITS), (e) => e.code === 'UNKNOWN_KEY')
  assert.throws(() => canonicalDecode(te.encode('{"__proto__":{}}'), LIMITS), (e) => e.code === 'UNKNOWN_KEY')
  assert.throws(() => canonicalDecode(te.encode('{"nodes":[["' + ID(0) + '",{"constructor":1}]]}'), LIMITS), (e) => e.code === 'UNKNOWN_KEY')
  assert.throws(() => canonicalDecode(te.encode('[1]'), LIMITS), (e) => e.code === 'BAD_SYNTAX')
  assert.throws(() => canonicalDecode(te.encode('{"generation":1,}'), LIMITS), (e) => e.code === 'BAD_SYNTAX')
  assert.throws(() => canonicalDecode(te.encode(''), LIMITS), (e) => e.code === 'BAD_SYNTAX')
})

test('CN-6 decoded byte limit is checked on length before any parsing', () => {
  const small = treeLimitsFrom({ maxDecodedBytes: 64 })
  const big = te.encode('{"treeId":"' + 'x'.repeat(80) + '"}')
  assert.throws(() => canonicalDecode(big, small), (e) => e.code === 'LIMIT_DECODED_BYTES')
  // an equally long but syntactically broken input still reports the limit first
  assert.throws(() => canonicalDecode(new Uint8Array(100).fill(0x7b), small), (e) => e.code === 'LIMIT_DECODED_BYTES')
  assert.throws(() => canonicalEncode(manifest([node(0, null, 'folder', 'x'.repeat(200))]), small), (e) => e.code === 'LIMIT_DECODED_BYTES')
})

test('CN-7 strings: UTF-8 as given (NFC preserved), control characters escaped, bad strings rejected', () => {
  const thai = 'รายงาน́' // NFD-ish combining mark kept as given
  const m = manifest([node(0, null, 'folder', ''), node(1, 0, 'file', thai + '\t"q"\\')])
  const bytes = canonicalEncode(m, LIMITS)
  const text = td.decode(bytes)
  assert.ok(text.includes('"name":"' + thai + '\\t\\"q\\"\\\\"'))
  assert.equal(canonicalDecode(bytes, LIMITS).nodes.get(ID(1)).name, thai + '\t"q"\\')
  for (const bad of ['\u0000', ' x', 'a\ud800b']) {
    assert.throws(() => canonicalEncode(manifest([node(0, null, 'folder', bad)]), LIMITS), (e) => e.code === 'BAD_STRING', JSON.stringify(bad))
  }
  // raw control byte in input is rejected by the parser; \u escapes decode
  assert.throws(() => canonicalDecode(te.encode('{"treeId":"a\u0001b"}'), LIMITS), (e) => e.code === 'BAD_SYNTAX')
  assert.equal(canonicalDecode(te.encode('{"treeId":"a\\u0041\\n"}'), LIMITS).treeId, 'aA\n')
  assert.throws(() => canonicalDecode(te.encode('{"treeId":"\\u0000"}'), LIMITS), (e) => e.code === 'BAD_STRING')
  assert.throws(() => canonicalDecode(te.encode('{"treeId":"\\ud800"}'), LIMITS), (e) => e.code === 'BAD_STRING')
})

test('CN-8 padToBucket picks the smallest bucket that fits input + trailer; stripPadding returns the exact bytes', () => {
  const buckets = [64, 128, 256]
  const input = te.encode('{"generation":1}')
  const { padded, paddedLength } = padToBucket(input, buckets)
  assert.equal(paddedLength, 64); assert.equal(padded.length, 64)
  assert.deepEqual([...stripPadding(padded)], [...input])
  const edge = new Uint8Array(64 - PADDING_TRAILER_BYTES).fill(0x41)
  assert.equal(padToBucket(edge, buckets).paddedLength, 64)
  assert.equal(padToBucket(new Uint8Array(64 - PADDING_TRAILER_BYTES + 1).fill(0x41), buckets).paddedLength, 128)
  assert.throws(() => padToBucket(new Uint8Array(300), buckets), (e) => e.code === 'LIMIT_DECODED_BYTES')
  // default table = the frozen product buckets
  assert.equal(padToBucket(input).paddedLength, PADDING_BUCKETS[0])
  // fill bytes are zero (nothing from the previous buffer leaks)
  const zeros = padded.subarray(input.length, 64 - PADDING_TRAILER_BYTES)
  assert.ok(zeros.every((b) => b === 0))
})

test('CN-9 padding trailer tamper is rejected', () => {
  const { padded } = padToBucket(te.encode('{"generation":1}'), [64])
  const badLen = new Uint8Array(padded); new DataView(badLen.buffer).setUint32(64 - 4, 61, false)
  assert.throws(() => stripPadding(badLen), (e) => e.code === 'BAD_PADDING')
  const badFill = new Uint8Array(padded); badFill[40] = 1
  assert.throws(() => stripPadding(badFill), (e) => e.code === 'BAD_PADDING')
  assert.throws(() => stripPadding(new Uint8Array(3)), (e) => e.code === 'BAD_PADDING')
  const badVersion = new Uint8Array(padded); badVersion[64 - PADDING_TRAILER_BYTES] ^= 0xff
  assert.throws(() => stripPadding(badVersion), (e) => e.code === 'BAD_PADDING')
})

test('CN-10 determinism: encode(decode(encode(m))) === encode(m) for 200 random manifests', () => {
  let seed = 12345
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x1_0000_0000 }
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(rnd() * 30)
    const nodes = [node(0, null, 'folder', '')]
    for (let k = 1; k < n; k++) {
      const parent = Math.floor(rnd() * k)
      const name = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => String.fromCharCode(0x20 + Math.floor(rnd() * 0x5e))).join('') + (rnd() < 0.3 ? 'ไทย' : '')
      const nd = node(k, parent, rnd() < 0.3 ? 'folder' : 'file', name)
      if (rnd() < 0.2) nd.lifecycle = { state: 'trashed', trashedAtClient: 1, trashedFromParentNodeId: ID(parent) }
      nodes.push(nd)
    }
    const m = manifest(nodes.sort(() => rnd() - 0.5))
    const a = canonicalEncode(m, LIMITS)
    const b = canonicalEncode(canonicalDecode(a, LIMITS), LIMITS)
    assert.equal(hex(b), hex(a))
    // and the oracle agrees on the data model
    const oracle = JSON.parse(td.decode(a))
    assert.equal(oracle.nodes.length, n)
  }
})
