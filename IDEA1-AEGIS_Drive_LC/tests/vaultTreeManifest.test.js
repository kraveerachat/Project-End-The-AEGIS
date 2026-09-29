// tests/vaultTreeManifest.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.4 · manifest schema, graph, lifecycle
//
// ⚠️ ทุกฟิลด์หลังถอดรหัสคือข้อมูลที่ไม่น่าเชื่อถือ — validateManifest ต้อง fail closed ทุกกรณี
//    และไม่มีการ "ซ่อม" ให้ (ไม่มี auto-rename, ไม่มี re-parent, ไม่มี drop node)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANIFEST_SCHEMA_VERSION, createGenesisManifest, validateManifest, collisionKey, effectiveState,
  ancestorsOf, childrenOf, breadcrumbsFor, isDescendant, activeSiblingCollision, ManifestError,
} from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { CASE_FOLD_UNICODE_VERSION } from '../src/lib/unicodeCaseFold.js'

const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1_700_000_000_000
const LIMITS = treeLimitsFrom({ maxNodes: 1_000, maxDepth: 16, maxNameBytes: 60, maxRecentOperationIds: 8 })

function node(id, parent, kind = 'file', name = `n${id}`, extra = {}) {
  const base = { nodeId: ID(id), kind, parentNodeId: parent === null ? null : ID(parent), name, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
  if (kind === 'file') Object.assign(base, { blobRef: { formatVersion: 2, id: `blob-${id}` }, mediaType: 'image/png', plainSize: 1 })
  return Object.assign(base, extra)
}
const trashed = (parent) => ({ lifecycle: { state: 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: parent === null ? null : ID(parent) } })
function manifest(nodesArr, extra = {}) {
  return {
    schemaVersion: 1, treeId: ID(900), generation: 3, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: NOW, nodes: new Map(nodesArr.map((n) => [n.nodeId, n])), recentOperationIds: [ID(700)], ...extra,
  }
}
const FIVE = () => manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs'), node(2, 1, 'file', 'a.png'), node(3, 1, 'folder', 'sub'), node(4, 3, 'file', 'b.png')])
const rejects = (m, code, msg) => assert.throws(() => validateManifest(m, LIMITS), (e) => e instanceof ManifestError && e.code === code, msg ?? code)

test('MF-1 createGenesisManifest: schema 1, generation 1, null base, one root folder, empty ops', () => {
  const g = createGenesisManifest({ treeId: ID(900), rootNodeId: ID(0), revisionId: ID(901), now: NOW })
  assert.equal(g.schemaVersion, MANIFEST_SCHEMA_VERSION); assert.equal(MANIFEST_SCHEMA_VERSION, 1)
  assert.equal(g.generation, 1); assert.equal(g.baseRevisionId, null); assert.equal(g.revisionId, ID(901))
  assert.equal(g.nodes.size, 1)
  const root = g.nodes.get(ID(0))
  assert.equal(root.kind, 'folder'); assert.equal(root.parentNodeId, null); assert.equal(root.name, '')
  assert.deepEqual(g.recentOperationIds, [])
  assert.doesNotThrow(() => validateManifest(g, LIMITS))
})

test('MF-2 a valid 5-node tree validates and yields an index (children, depth, parent)', () => {
  const { ok, index } = validateManifest(FIVE(), LIMITS)
  assert.equal(ok, true)
  assert.deepEqual([...index.childrenOf.get(ID(1))].sort(), [ID(2), ID(3)])
  assert.equal(index.depthOf.get(ID(4)), 3); assert.equal(index.depthOf.get(ID(0)), 0)
  assert.equal(index.nodes.get(ID(4)).parentNodeId, ID(3))
  assert.equal(index.rootNodeId, ID(0))
})

test('MF-3 structural rejections each carry a distinct code', () => {
  rejects(manifest([node(1, null, 'folder', 'x')], { rootNodeId: ID(0) }), 'NO_ROOT')
  rejects(manifest([node(0, null, 'folder', ''), node(1, null, 'folder', 'x')]), 'MULTI_ROOT')
  rejects(manifest([node(0, 0, 'folder', '')]), 'ROOT_PARENT')
  rejects(manifest([node(0, null, 'folder', ''), node(1, 9, 'file')]), 'PARENT_MISSING')
  rejects(manifest([node(0, null, 'folder', ''), node(1, 0, 'file'), node(2, 1, 'file')]), 'PARENT_NOT_FOLDER')
  const dup = FIVE(); dup.nodes.set(ID(5), node(4, 3, 'file', 'c.png')); rejects(dup, 'DUP_NODE') // map key ≠ nodeId
  const cyc = manifest([node(0, null, 'folder', ''), node(1, 2, 'folder', 'a'), node(2, 3, 'folder', 'b'), node(3, 1, 'folder', 'c')]); rejects(cyc, 'UNREACHABLE')
  const self = manifest([node(0, null, 'folder', ''), node(1, 1, 'folder', 'a')]); rejects(self, 'UNREACHABLE')
  // a cycle that is reachable from the root is impossible (each node has one parent), so cycles surface as UNREACHABLE; CYCLE is reserved for walks
  const m = FIVE(); m.nodes.get(ID(1)).parentNodeId = ID(3) // 1→3→1 detached from root
  rejects(m, 'UNREACHABLE')
})

test('MF-4 field rejections: blobRef presence per kind, format version, sizes, media type, timestamps', () => {
  const noBlob = FIVE(); delete noBlob.nodes.get(ID(2)).blobRef; rejects(noBlob, 'FILE_BLOB_REQUIRED')
  const folderBlob = FIVE(); folderBlob.nodes.get(ID(1)).blobRef = { formatVersion: 2, id: 'x' }; rejects(folderBlob, 'FOLDER_HAS_BLOB')
  const fv = FIVE(); fv.nodes.get(ID(2)).blobRef.formatVersion = 3; rejects(fv, 'BAD_BLOB_REF')
  const neg = FIVE(); neg.nodes.get(ID(2)).plainSize = -1; rejects(neg, 'BAD_FIELD')
  const mt = FIVE(); mt.nodes.get(ID(2)).mediaType = 'x'.repeat(256); rejects(mt, 'BAD_FIELD')
  const ts = FIVE(); ts.nodes.get(ID(2)).createdAtClient = 1.5; rejects(ts, 'BAD_FIELD')
  const ts2 = FIVE(); ts2.nodes.get(ID(2)).modifiedAtClient = -1; rejects(ts2, 'BAD_FIELD')
  const kind = FIVE(); kind.nodes.get(ID(2)).kind = 'symlink'; rejects(kind, 'BAD_FIELD')
  const badId = FIVE(); badId.nodes.get(ID(2)).blobRef.id = ''; rejects(badId, 'BAD_BLOB_REF')
  const schema = FIVE(); schema.schemaVersion = 2; rejects(schema, 'BAD_SCHEMA')
  const gen = FIVE(); gen.generation = 0; rejects(gen, 'BAD_FIELD')
  const ids = FIVE(); ids.treeId = 'short'; rejects(ids, 'BAD_FIELD')
  const rootName = FIVE(); rootName.nodes.get(ID(0)).name = 'root'; rejects(rootName, 'BAD_FIELD')
  const emptyName = FIVE(); emptyName.nodes.get(ID(2)).name = ''; rejects(emptyName, 'NAME_INVALID')
  const ws = FIVE(); ws.nodes.get(ID(2)).name = '   '; rejects(ws, 'NAME_INVALID')
  const nul = FIVE(); nul.nodes.get(ID(2)).name = 'a\u0000b'; rejects(nul, 'NAME_INVALID')
  const slash = FIVE(); slash.nodes.get(ID(2)).name = 'a/b'; rejects(slash, 'NAME_INVALID')
  const dot = FIVE(); dot.nodes.get(ID(2)).name = '..'; rejects(dot, 'NAME_INVALID')
})

test('MF-5 sibling collisions use NFC + pinned full case folding; trashed siblings do not collide', () => {
  assert.equal(CASE_FOLD_UNICODE_VERSION, '16.0.0')
  assert.equal(collisionKey('Report.PDF'), collisionKey('report.pdf'))
  assert.equal(collisionKey('Straße'), collisionKey('STRASSE'))
  assert.equal(collisionKey('école'), collisionKey('école')) // NFD vs NFC
  assert.notEqual(collisionKey('a'), collisionKey('b'))
  const c1 = manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'Report.PDF'), node(2, 0, 'file', 'report.pdf')]); rejects(c1, 'COLLISION')
  const c2 = manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'ß'), node(2, 0, 'file', 'ss')]); rejects(c2, 'COLLISION')
  const c3 = manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'é'), node(2, 0, 'file', 'é')]); rejects(c3, 'COLLISION')
  const ok = manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'Report.PDF'), node(2, 0, 'file', 'report.pdf', trashed(0))])
  assert.doesNotThrow(() => validateManifest(ok, LIMITS))
  // different parents never collide
  assert.doesNotThrow(() => validateManifest(manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'a'), node(2, 0, 'file', 'x'), node(3, 1, 'file', 'X')]), LIMITS))
})

test('MF-LIMIT-NODES / MF-LIMIT-DEPTH / MF-LIMIT-NAME / MF-LIMIT-OPS enforce injected limits with their own codes', () => {
  const small = treeLimitsFrom({ maxNodes: 5, maxDepth: 2, maxNameBytes: 6, maxRecentOperationIds: 1 })
  const throws = (m, code) => assert.throws(() => validateManifest(m, small), (e) => e.code === code, code)
  throws(manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'a'), node(2, 0, 'file', 'b'), node(3, 0, 'file', 'c'), node(4, 0, 'file', 'd'), node(5, 0, 'file', 'e')]), 'LIMIT_NODES')
  throws(manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'a'), node(2, 1, 'folder', 'b'), node(3, 2, 'file', 'c')]), 'LIMIT_DEPTH') // root=0, a=1, b=2, c=3 > 2
  assert.doesNotThrow(() => validateManifest(manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'a'), node(2, 1, 'file', 'b')]), small))
  throws(manifest([node(0, null, 'folder', ''), node(1, 0, 'file', 'ไทย')]), 'LIMIT_NAME_BYTES') // 9 UTF-8 bytes > 6
  throws(manifest([node(0, null, 'folder', '')], { recentOperationIds: [ID(1), ID(2)] }), 'LIMIT_OPS')
})

test('MF-6 effectiveState follows the nearest trashed/purge-pending ancestor', () => {
  const m = manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs', trashed(0)), node(2, 1, 'file', 'a.png'), node(3, 1, 'file', 'b.png', { lifecycle: { state: 'purge-pending', trashedAtClient: NOW, trashedFromParentNodeId: ID(1) } }), node(4, 0, 'file', 'c.png')])
  const { index } = validateManifest(m, LIMITS)
  assert.equal(effectiveState(index, ID(1)), 'trashed')
  assert.equal(effectiveState(index, ID(2)), 'trashed') // own state active, ancestor trashed
  assert.equal(effectiveState(index, ID(3)), 'purge-pending') // own state wins when stronger
  assert.equal(effectiveState(index, ID(4)), 'active')
  assert.equal(effectiveState(index, ID(0)), 'active')
  // restoring the parent (own state active) reactivates 2 but not 3
  m.nodes.get(ID(1)).lifecycle = { state: 'active' }
  const { index: i2 } = validateManifest(m, LIMITS)
  assert.equal(effectiveState(i2, ID(2)), 'active'); assert.equal(effectiveState(i2, ID(3)), 'purge-pending')
})

test('MF-7 childrenOf active view hides effectively trashed nodes; trash view lists only trashed subtree roots', () => {
  const m = manifest([node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs', trashed(0)), node(2, 1, 'file', 'a.png'), node(3, 1, 'file', 'b.png', trashed(1)), node(4, 0, 'file', 'c.png'), node(5, 0, 'file', 'd.png', trashed(0))])
  const { index } = validateManifest(m, LIMITS)
  assert.deepEqual(childrenOf(index, ID(0), { view: 'active' }).map((n) => n.nodeId), [ID(4)])
  assert.deepEqual(childrenOf(index, ID(1), { view: 'active' }), []) // inside a trashed folder nothing is active
  const trashRoots = childrenOf(index, null, { view: 'trash' }).map((n) => n.nodeId).sort()
  assert.deepEqual(trashRoots, [ID(1), ID(5)]) // 3 is trashed but under a trashed ancestor → not listed twice
})

test('MF-8 breadcrumbsFor walks to the root with a visited set; corrupted parent chains throw instead of looping', () => {
  const { index } = validateManifest(FIVE(), LIMITS)
  assert.deepEqual(breadcrumbsFor(index, ID(4)).map((n) => n.nodeId), [ID(0), ID(1), ID(3), ID(4)])
  assert.deepEqual(breadcrumbsFor(index, ID(0)).map((n) => n.nodeId), [ID(0)])
  assert.deepEqual(ancestorsOf(index, ID(4)), [ID(3), ID(1), ID(0)])
  assert.equal(isDescendant(index, ID(4), ID(1)), true); assert.equal(isDescendant(index, ID(1), ID(4)), false); assert.equal(isDescendant(index, ID(1), ID(1)), false)
  // corrupt the index after validation (simulates a bug elsewhere): a 2-cycle must throw CYCLE, never spin
  const corrupt = { ...index, nodes: new Map(index.nodes) }
  corrupt.nodes.set(ID(1), { ...index.nodes.get(ID(1)), parentNodeId: ID(3) })
  assert.throws(() => breadcrumbsFor(corrupt, ID(4)), (e) => e.code === 'CYCLE')
  assert.throws(() => ancestorsOf(corrupt, ID(4)), (e) => e.code === 'CYCLE')
  assert.throws(() => breadcrumbsFor(index, ID(99)), (e) => e.code === 'NOT_FOUND')
})

test('MF-9 lifecycle consistency: trashed needs trashedAtClient + trashedFromParentNodeId; active must not carry them', () => {
  const t1 = FIVE(); t1.nodes.get(ID(2)).lifecycle = { state: 'trashed' }; rejects(t1, 'LIFECYCLE_INCONSISTENT')
  const t2 = FIVE(); t2.nodes.get(ID(2)).lifecycle = { state: 'trashed', trashedAtClient: NOW }; rejects(t2, 'LIFECYCLE_INCONSISTENT')
  const a1 = FIVE(); a1.nodes.get(ID(2)).lifecycle = { state: 'active', trashedAtClient: NOW }; rejects(a1, 'LIFECYCLE_INCONSISTENT')
  const bad = FIVE(); bad.nodes.get(ID(2)).lifecycle = { state: 'deleted' }; rejects(bad, 'BAD_FIELD')
  const rootTrash = FIVE(); rootTrash.nodes.get(ID(0)).lifecycle = { state: 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: null }; rejects(rootTrash, 'ROOT_IMMUTABLE')
  const from = FIVE(); from.nodes.get(ID(2)).lifecycle = { state: 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: ID(99) }; rejects(from, 'LIFECYCLE_INCONSISTENT')
  const ok = FIVE(); ok.nodes.get(ID(2)).lifecycle = { state: 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: ID(1) }
  assert.doesNotThrow(() => validateManifest(ok, LIMITS))
})

test('MF-10 untrusted input: prototype keys are rejected, never assigned; non-Map nodes rejected', () => {
  // simulate a decoded object carrying a suspicious own key
  const decoded = Object.create(null); Object.assign(decoded, node(2, 1)); decoded.constructor = 1
  const m2 = FIVE(); m2.nodes.set(ID(2), decoded); rejects(m2, 'UNKNOWN_KEY')
  const m3 = FIVE(); m3.nodes = { [ID(0)]: node(0, null, 'folder', '') }; rejects(m3, 'BAD_FIELD')
  const m4 = FIVE(); m4.extra = 1; rejects(m4, 'UNKNOWN_KEY')
  assert.equal(Object.prototype.plainSize, undefined)
})
