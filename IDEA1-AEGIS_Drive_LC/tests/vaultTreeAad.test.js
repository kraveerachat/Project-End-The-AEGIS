// tests/vaultTreeAad.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.1 · domain-separated AAD encoders
//
// ⚠️ AAD คือ "นิยามของรูปแบบ" — TA-1 ตรึงทุกไบต์ของทั้งสามชั้นด้วย hex literal
//    การเปลี่ยนไบต์ใดหลัง genesis = manifest revision ทุกตัวถอดไม่ออกตลอดกาล
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AAD_LAYOUT_VERSION, TRK_WRAP_LABEL, MANIFEST_DEK_WRAP_LABEL, MANIFEST_CIPHERTEXT_LABEL,
  trkWrapAad, manifestDekWrapAad, manifestCiphertextAad,
} from '../src/lib/vaultTreeAad.js'

const te = new TextEncoder()
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')

// 22-char base64url ids (16 random bytes) — fixed for the vectors
const OWNER = 'AAAAAAAAAAAAAAAAAAAAAA'
const TREE = 'dHJlZS1pZC10ZXN0LTAwMQ'
const REV = 'cmV2LWlkLXRlc3QtMDAwMD'
const BASE = 'YmFzZS1pZC10ZXN0LTAwMD'

const TRK_CTX = { ownerScopeId: OWNER, treeId: TREE, protocolVersion: 1, keyEnvelopeVersion: 1, slot: 'primary' }
const DEK_CTX = { treeId: TREE, revisionId: REV, baseRevisionId: BASE, generation: 7, manifestSchemaVersion: 1 }
const CT_CTX = { ...DEK_CTX, paddedPlaintextLength: 65_536 }

/** independent re-implementation of the wire layout used only as an oracle: parses tag/len/value triples */
function parseAad(u8) {
  assert.equal(u8[0], AAD_LAYOUT_VERSION)
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const labelLen = view.getUint16(1, false)
  const label = new TextDecoder().decode(u8.subarray(3, 3 + labelLen))
  const fields = []
  let o = 3 + labelLen
  while (o < u8.length) {
    const tag = u8[o]; const len = view.getUint32(o + 1, false)
    fields.push({ tag, bytes: u8.subarray(o + 5, o + 5 + len) })
    o += 5 + len
  }
  assert.equal(o, u8.length, 'no trailing bytes')
  return { label, fields }
}
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b }

test('TA-1 frozen vectors: every encoder equals its hex literal', () => {
  // Built by hand from the documented layout: 01 ‖ u16 labelLen ‖ label ‖ (tag ‖ u32 len ‖ value)*
  const lbl = (s) => '01' + te.encode(s).length.toString(16).padStart(4, '0') + hex(te.encode(s))
  const f = (tag, bytes) => tag.toString(16).padStart(2, '0') + bytes.length.toString(16).padStart(8, '0') + hex(bytes)
  const trkExpected = lbl(TRK_WRAP_LABEL) + f(1, te.encode(OWNER)) + f(2, te.encode(TREE)) + f(3, u64(1)) + f(4, u64(1)) + f(5, te.encode('primary'))
  assert.equal(hex(trkWrapAad(TRK_CTX)), trkExpected)
  const dekExpected = lbl(MANIFEST_DEK_WRAP_LABEL) + f(1, te.encode(TREE)) + f(2, te.encode(REV)) + f(3, te.encode(BASE)) + f(4, u64(7)) + f(5, u64(1))
  assert.equal(hex(manifestDekWrapAad(DEK_CTX)), dekExpected)
  const ctExpected = lbl(MANIFEST_CIPHERTEXT_LABEL) + f(1, te.encode(TREE)) + f(2, te.encode(REV)) + f(3, te.encode(BASE)) + f(4, u64(7)) + f(5, u64(1)) + f(6, u64(65_536))
  assert.equal(hex(manifestCiphertextAad(CT_CTX)), ctExpected)
  // the literal prefix of the TRK vector, spelled out so a label edit is caught even if the helper above changes
  assert.equal(hex(trkWrapAad(TRK_CTX)).slice(0, 6 + 2 * TRK_WRAP_LABEL.length), '01001c' + hex(te.encode('AEGIS-Vault-Tree-TRK-Wrap-v1')))
})

test('TA-2 layout: version byte, big-endian label length, label, then tag/len/value in table order', () => {
  const t = parseAad(trkWrapAad(TRK_CTX))
  assert.equal(t.label, 'AEGIS-Vault-Tree-TRK-Wrap-v1')
  assert.deepEqual(t.fields.map((x) => x.tag), [1, 2, 3, 4, 5])
  assert.deepEqual([...t.fields[2].bytes], [...u64(1)])
  assert.equal(new TextDecoder().decode(t.fields[4].bytes), 'primary')
  const d = parseAad(manifestDekWrapAad(DEK_CTX))
  assert.equal(d.label, 'AEGIS-Vault-Tree-Manifest-DEK-Wrap-v1')
  assert.deepEqual(d.fields.map((x) => x.tag), [1, 2, 3, 4, 5])
  const c = parseAad(manifestCiphertextAad(CT_CTX))
  assert.equal(c.label, 'AEGIS-Vault-Tree-Manifest-Ciphertext-v1')
  assert.deepEqual(c.fields.map((x) => x.tag), [1, 2, 3, 4, 5, 6])
  assert.deepEqual([...c.fields[5].bytes], [...u64(65_536)])
})

test('TA-3 domain separation: layers never collide; primary vs recovery differ only in the slot field', () => {
  const a = hex(trkWrapAad(TRK_CTX)), b = hex(manifestDekWrapAad(DEK_CTX)), c = hex(manifestCiphertextAad(CT_CTX))
  assert.notEqual(a, b); assert.notEqual(b, c); assert.notEqual(a, c)
  const p = parseAad(trkWrapAad(TRK_CTX)), r = parseAad(trkWrapAad({ ...TRK_CTX, slot: 'recovery' }))
  for (let i = 0; i < 4; i++) assert.deepEqual([...p.fields[i].bytes], [...r.fields[i].bytes])
  assert.notDeepEqual([...p.fields[4].bytes], [...r.fields[4].bytes])
})

test('TA-4 baseRevisionId null encodes as an empty field; undefined is rejected', () => {
  const g = parseAad(manifestDekWrapAad({ ...DEK_CTX, baseRevisionId: null }))
  assert.equal(g.fields[2].tag, 3); assert.equal(g.fields[2].bytes.length, 0)
  assert.throws(() => manifestDekWrapAad({ ...DEK_CTX, baseRevisionId: undefined }), /baseRevisionId/)
  const { baseRevisionId, ...missing } = DEK_CTX
  assert.throws(() => manifestDekWrapAad(missing), /baseRevisionId/)
})

test('TA-5 rejects malformed inputs', () => {
  assert.throws(() => trkWrapAad({ ...TRK_CTX, treeId: 'not base64url!' }), /treeId/)
  assert.throws(() => trkWrapAad({ ...TRK_CTX, treeId: TREE.slice(0, 21) }), /treeId/)
  assert.throws(() => trkWrapAad({ ...TRK_CTX, ownerScopeId: OWNER + 'A' }), /ownerScopeId/)
  assert.throws(() => trkWrapAad({ ...TRK_CTX, slot: 'backup' }), /slot/)
  assert.throws(() => trkWrapAad({ ...TRK_CTX, protocolVersion: 0 }), /protocolVersion/)
  assert.throws(() => manifestDekWrapAad({ ...DEK_CTX, generation: -1 }), /generation/)
  assert.throws(() => manifestDekWrapAad({ ...DEK_CTX, generation: 2 ** 53 }), /generation/)
  assert.throws(() => manifestDekWrapAad({ ...DEK_CTX, generation: 1.5 }), /generation/)
  assert.throws(() => manifestDekWrapAad({ ...DEK_CTX, revisionId: 'x'.repeat(22) + '=' }), /revisionId/)
  assert.throws(() => manifestCiphertextAad({ ...CT_CTX, paddedPlaintextLength: 1.5 }), /paddedPlaintextLength/)
  assert.throws(() => manifestCiphertextAad({ ...CT_CTX, paddedPlaintextLength: -1 }), /paddedPlaintextLength/)
  assert.throws(() => manifestCiphertextAad({ ...CT_CTX, manifestSchemaVersion: 0 }), /manifestSchemaVersion/)
})

test('TA-6 no string concatenation: an id that spells the label does not shift parsing', () => {
  // 22 base64url chars that happen to look label-ish; the parser must still find 5 fields with exact lengths
  const tricky = 'AEGIS-Vault-Tree-TRK-W'
  const p = parseAad(trkWrapAad({ ...TRK_CTX, treeId: tricky }))
  assert.equal(p.fields.length, 5)
  assert.equal(new TextDecoder().decode(p.fields[1].bytes), tricky)
  assert.equal(p.fields[1].bytes.length, 22)
  // every call returns a fresh buffer
  const x = trkWrapAad(TRK_CTX), y = trkWrapAad(TRK_CTX)
  assert.notEqual(x.buffer, y.buffer)
  assert.deepEqual([...x], [...y])
})
