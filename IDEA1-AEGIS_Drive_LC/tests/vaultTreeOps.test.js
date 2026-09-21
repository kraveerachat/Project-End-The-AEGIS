// tests/vaultTreeOps.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.1 · semantic intents (OP-1..OP-9)
//
// ⚠️ ทุก intent ทำงานบน clone: input ไม่ถูกแตะ (snapshot เท่ากันก่อน/หลัง) และทุกการปฏิเสธไม่ทิ้งร่องรอย
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, ID, NOW, snapshot } from './helpers/vaultTreeTrees.mjs'
import { validateManifest, effectiveState } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { intents, applyIntent, normalizeSelectionRoots, OpError } from '../src/lib/vaultTreeOps.js'

const LIMITS = treeLimitsFrom({ maxNodes: 12, maxDepth: 4, maxNameBytes: 24, maxRecentOperationIds: 3 })
let seq = 500
const newNodeId = () => ID(seq++, 'Z')
const opts = (o = {}) => ({ now: NOW + 5, newNodeId, limits: LIMITS, ...o })
const F = (n) => ID(n, 'F'), D = (n) => ID(n, 'D')

/**
 *  root ─┬─ docs (D1) ─┬─ sub (D2) ── deep.txt (F2)
 *        │             └─ b.txt (F3)
 *        ├─ a.txt (F1)
 *        ├─ pics (D3) [trashed] ─┬─ cat.png (F4)            (effectively trashed via D3)
 *        │                       └─ dog.png (F5) [trashed itself]
 *        └─ old.txt (F6) [trashed]
 */
const base = () => buildTree([
  [D(1), 'folder', ID(0), 'docs'], [D(2), 'folder', D(1), 'sub'], [F(2), 'file', D(2), 'deep.txt'], [F(3), 'file', D(1), 'b.txt'],
  [F(1), 'file', ID(0), 'a.txt'],
  [D(3), 'folder', ID(0), 'pics', { trashed: true }], [F(4), 'file', D(3), 'cat.png'], [F(5), 'file', D(3), 'dog.png', { trashed: true }],
  [F(6), 'file', ID(0), 'old.txt', { trashed: true }],
])
const indexOf = (m) => validateManifest(m, LIMITS).index
function rejects(m, intent, code, o = opts()) {
  const before = snapshot(m)
  let thrown = null
  try { applyIntent(m, intent, o) } catch (e) { thrown = e }
  assert.ok(thrown instanceof OpError, `expected OpError ${code}, got ${thrown?.name ?? 'no error'}: ${thrown?.message ?? ''}`)
  assert.equal(thrown.code, code)
  assert.equal(snapshot(m), before, `rejected ${intent.type} must not touch the input`)
}
function apply(m, intent, o = opts()) {
  const before = snapshot(m)
  const r = applyIntent(m, intent, o)
  assert.equal(snapshot(m), before, 'input untouched')
  validateManifest(r.manifest, o.limits)
  return r
}

test('OP-1 createFolder: under root / under folder; COLLISION; NOT_FOLDER; EFFECTIVELY_TRASHED; NAME_INVALID; LIMIT_NAME_BYTES; LIMIT_NODES; LIMIT_DEPTH', () => {
  const m = base()
  const r1 = apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'new' }))
  const id1 = r1.changedNodeIds[0]
  assert.deepEqual(r1.manifest.nodes.get(id1), { nodeId: id1, kind: 'folder', parentNodeId: ID(0), name: 'new', createdAtClient: NOW + 5, modifiedAtClient: NOW + 5, lifecycle: { state: 'active' } })
  assert.deepEqual({ attach: r1.attachBlobRefs, purge: r1.purgeBlobRefs, changed: r1.changedNodeIds.length }, { attach: [], purge: [], changed: 1 })
  assert.equal(r1.manifest.nodes.size, m.nodes.size + 1)
  const r2 = apply(m, intents.createFolder({ parentNodeId: D(2), name: 'nested' }))
  assert.equal(r2.manifest.nodes.get(r2.changedNodeIds[0]).parentNodeId, D(2))
  rejects(m, intents.createFolder({ parentNodeId: ID(0), name: 'DOCS' }), 'COLLISION')
  rejects(m, intents.createFolder({ parentNodeId: ID(0), name: 'a.TXT' }), 'COLLISION')
  assert.equal(apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'pics' })).changedNodeIds.length, 1, 'a trashed sibling does not block the name')
  rejects(m, intents.createFolder({ parentNodeId: F(1), name: 'x' }), 'NOT_FOLDER')
  rejects(m, intents.createFolder({ parentNodeId: D(3), name: 'x' }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.createFolder({ parentNodeId: ID(404), name: 'x' }), 'NOT_FOUND')
  for (const name of ['', '   ', 'a\u0000b', 'a/b', '.', '..', 'tab\tname', 7]) rejects(m, intents.createFolder({ parentNodeId: ID(0), name }), 'NAME_INVALID')
  rejects(m, intents.createFolder({ parentNodeId: ID(0), name: 'x'.repeat(25) }), 'LIMIT_NAME_BYTES')
  rejects(m, intents.createFolder({ parentNodeId: ID(0), name: 'ก'.repeat(9) }), 'LIMIT_NAME_BYTES') // 27 UTF-8 bytes > 24
  // LIMIT_NODES: 10 nodes now; limit 12 → two more fit, the third fails
  const a = apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'n1' }))
  const b = apply(a.manifest, intents.createFolder({ parentNodeId: ID(0), name: 'n2' }))
  rejects(b.manifest, intents.createFolder({ parentNodeId: ID(0), name: 'n3' }), 'LIMIT_NODES')
  // LIMIT_DEPTH (maxDepth 4, node budget widened so depth is the only limit hit): root(0) > docs(1) > sub(2) > x(3) > y(4) > z(5) ✗
  const roomy = opts({ limits: treeLimitsFrom({ maxNodes: 100, maxDepth: 4, maxNameBytes: 24, maxRecentOperationIds: 3 }) })
  const x = apply(m, intents.createFolder({ parentNodeId: D(2), name: 'x' }), roomy)
  const y = apply(x.manifest, intents.createFolder({ parentNodeId: x.changedNodeIds[0], name: 'y' }), roomy)
  rejects(y.manifest, intents.createFolder({ parentNodeId: y.changedNodeIds[0], name: 'z' }), 'LIMIT_DEPTH', roomy)
})

test('OP-2 rename: only name + modifiedAtClient change; ROOT_IMMUTABLE; COLLISION; case-only rename of itself allowed; trashed → EFFECTIVELY_TRASHED', () => {
  const m = base()
  const r = apply(m, intents.rename({ nodeId: F(3), name: 'c.txt' }))
  assert.deepEqual(r.manifest.nodes.get(F(3)), { ...m.nodes.get(F(3)), name: 'c.txt', modifiedAtClient: NOW + 5 })
  assert.deepEqual(r.changedNodeIds, [F(3)])
  rejects(m, intents.rename({ nodeId: ID(0), name: 'root' }), 'ROOT_IMMUTABLE')
  rejects(m, intents.rename({ nodeId: D(2), name: 'B.TXT' }), 'COLLISION')
  assert.equal(apply(m, intents.rename({ nodeId: F(3), name: 'DEEP.TXT' })).manifest.nodes.get(F(3)).name, 'DEEP.TXT', 'a name used in another folder is free')
  assert.equal(apply(m, intents.rename({ nodeId: F(3), name: 'B.TXT' })).manifest.nodes.get(F(3)).name, 'B.TXT', 'case-only rename of itself')
  assert.equal(apply(m, intents.rename({ nodeId: F(1), name: 'old.txt' })).manifest.nodes.get(F(1)).name, 'old.txt', 'a trashed sibling does not block')
  rejects(m, intents.rename({ nodeId: F(3), name: '' }), 'NAME_INVALID')
  rejects(m, intents.rename({ nodeId: F(6), name: 'x' }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.rename({ nodeId: F(4), name: 'x' }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.rename({ nodeId: ID(404), name: 'x' }), 'NOT_FOUND')
})

test('OP-3 move: single and bulk; CYCLE (self/descendant); NOT_FOUND; NOT_FOLDER; EFFECTIVELY_TRASHED; COLLISION rejects the whole intent; depth', () => {
  const m = base()
  const single = apply(m, intents.move({ nodeIds: [F(1)], destinationNodeId: D(2) }))
  assert.deepEqual(single.manifest.nodes.get(F(1)), { ...m.nodes.get(F(1)), parentNodeId: D(2), modifiedAtClient: NOW + 5 })
  const bulk = apply(m, intents.move({ nodeIds: [F(1), D(2), F(2)], destinationNodeId: ID(0) }))
  assert.deepEqual(bulk.changedNodeIds, [F(1), D(2)], 'descendant of a moved folder is dropped from the roots; F1 already under root is a no-op move')
  assert.equal(bulk.manifest.nodes.get(D(2)).parentNodeId, ID(0)); assert.equal(bulk.manifest.nodes.get(F(2)).parentNodeId, D(2))
  rejects(m, intents.move({ nodeIds: [D(1)], destinationNodeId: D(1) }), 'CYCLE')
  rejects(m, intents.move({ nodeIds: [D(1)], destinationNodeId: D(2) }), 'CYCLE')
  rejects(m, intents.move({ nodeIds: [F(1), D(1)], destinationNodeId: D(2) }), 'CYCLE')
  rejects(m, intents.move({ nodeIds: [F(1)], destinationNodeId: ID(404) }), 'NOT_FOUND')
  rejects(m, intents.move({ nodeIds: [ID(404)], destinationNodeId: D(1) }), 'NOT_FOUND')
  rejects(m, intents.move({ nodeIds: [F(1)], destinationNodeId: F(3) }), 'NOT_FOLDER')
  rejects(m, intents.move({ nodeIds: [F(1)], destinationNodeId: D(3) }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.move({ nodeIds: [F(6)], destinationNodeId: D(1) }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.move({ nodeIds: [ID(0)], destinationNodeId: D(1) }), 'ROOT_IMMUTABLE')
  // collision in destination: one of the bulk set collides → nothing applied
  const withB = apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'B.txt' })).manifest
  rejects(withB, intents.move({ nodeIds: [F(1), F(3)], destinationNodeId: ID(0) }), 'COLLISION')
  // two moved nodes colliding with each other
  const twoSame = apply(m, intents.createFolder({ parentNodeId: D(2), name: 'A.TXT' }))
  rejects(twoSame.manifest, intents.move({ nodeIds: [F(1), twoSame.changedNodeIds[0]], destinationNodeId: D(1) }), 'COLLISION')
  // depth: moving docs (height 2) under a folder at depth 2 → 2+1+2 = 5 > 4
  const deep = apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'k' }))
  const deeper = apply(deep.manifest, intents.createFolder({ parentNodeId: deep.changedNodeIds[0], name: 'kk' }))
  rejects(deeper.manifest, intents.move({ nodeIds: [D(1)], destinationNodeId: deeper.changedNodeIds[0] }), 'LIMIT_DEPTH')
  rejects(m, intents.move({ nodeIds: [], destinationNodeId: D(1) }), 'INVALID_INTENT')
})

test('OP-4 normalizeSelectionRoots drops descendants of selected ancestors; dedupes; keeps order; mixed active/trashed → AMBIGUOUS_SELECTION; unknown → NOT_FOUND', () => {
  const index = indexOf(base())
  assert.deepEqual(normalizeSelectionRoots(index, [F(2), D(1), F(3), D(2), F(1), D(1)]), [D(1), F(1)])
  assert.deepEqual(normalizeSelectionRoots(index, [D(3), F(4), F(5), F(6)]), [D(3), F(6)], 'a trashed selection normalizes the same way')
  assert.deepEqual(normalizeSelectionRoots(index, []), [])
  assert.throws(() => normalizeSelectionRoots(index, [F(1), F(6)]), (e) => e.code === 'AMBIGUOUS_SELECTION')
  assert.throws(() => normalizeSelectionRoots(index, [F(1), F(4)]), (e) => e.code === 'AMBIGUOUS_SELECTION', 'effectively trashed counts as trashed')
  assert.throws(() => normalizeSelectionRoots(index, [F(1), ID(404)]), (e) => e.code === 'NOT_FOUND')
})

test('OP-5 trash sets state/trashedAtClient/trashedFromParentNodeId on subtree roots only; descendants untouched; already trashed → EFFECTIVELY_TRASHED; root → ROOT_IMMUTABLE', () => {
  const m = base()
  const r = apply(m, intents.trash({ nodeIds: [D(1), F(2)] }))
  assert.deepEqual(r.changedNodeIds, [D(1)], 'O(1) edit per root')
  assert.deepEqual(r.manifest.nodes.get(D(1)).lifecycle, { state: 'trashed', trashedAtClient: NOW + 5, trashedFromParentNodeId: ID(0) })
  assert.equal(r.manifest.nodes.get(D(1)).parentNodeId, ID(0), 'node stays under its parent while in the trash')
  for (const id of [D(2), F(2), F(3)]) assert.deepEqual(r.manifest.nodes.get(id), m.nodes.get(id), 'descendants are byte-identical')
  const idx = indexOf(r.manifest)
  for (const id of [D(1), D(2), F(2), F(3)]) assert.equal(effectiveState(idx, id), 'trashed')
  rejects(m, intents.trash({ nodeIds: [F(6)] }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.trash({ nodeIds: [F(4)] }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.trash({ nodeIds: [ID(0)] }), 'ROOT_IMMUTABLE')
  rejects(m, intents.trash({ nodeIds: [F(1), F(6)] }), 'AMBIGUOUS_SELECTION')
  rejects(m, intents.trash({ nodeIds: [] }), 'INVALID_INTENT')
})

test('OP-6 restore: to the original parent when it exists, is active and free of collision; else needs destinationNodeId; COLLISION; cycle re-validated; not trashed → NOT_TRASHED', () => {
  const m = base()
  const r = apply(m, intents.restore({ nodeId: F(6) }))
  assert.deepEqual(r.manifest.nodes.get(F(6)), { ...m.nodes.get(F(6)), lifecycle: { state: 'active' }, modifiedAtClient: NOW + 5 })
  // original parent now holds an active sibling with the same name → COLLISION; explicit destination works
  const taken = apply(m, intents.createFolder({ parentNodeId: ID(0), name: 'OLD.TXT' })).manifest
  rejects(taken, intents.restore({ nodeId: F(6) }), 'COLLISION')
  const elsewhere = apply(taken, intents.restore({ nodeId: F(6), destinationNodeId: D(1) }))
  assert.equal(elsewhere.manifest.nodes.get(F(6)).parentNodeId, D(1))
  // original parent trashed → EFFECTIVELY_TRASHED unless an explicit active destination is given
  rejects(m, intents.restore({ nodeId: F(5) }), 'EFFECTIVELY_TRASHED')
  assert.equal(apply(m, intents.restore({ nodeId: F(5), destinationNodeId: D(2) })).manifest.nodes.get(F(5)).parentNodeId, D(2))
  // restoring the folder brings its non-trashed descendants back; F5 keeps its own trashed state
  const pics = apply(m, intents.restore({ nodeId: D(3) }))
  const idx = indexOf(pics.manifest)
  assert.deepEqual([effectiveState(idx, D(3)), effectiveState(idx, F(4)), effectiveState(idx, F(5))], ['active', 'active', 'trashed'])
  // cycle: restore a trashed folder into its own descendant
  const t = apply(m, intents.trash({ nodeIds: [D(1)] })).manifest
  rejects(t, intents.restore({ nodeId: D(1), destinationNodeId: D(2) }), 'CYCLE')
  rejects(t, intents.restore({ nodeId: D(1), destinationNodeId: D(1) }), 'CYCLE')
  rejects(m, intents.restore({ nodeId: F(4) }), 'EFFECTIVELY_TRASHED', opts()) // trashed via ancestor: restore the ancestor
  rejects(m, intents.restore({ nodeId: F(1) }), 'NOT_TRASHED')
  rejects(m, intents.restore({ nodeId: ID(0) }), 'ROOT_IMMUTABLE')
  rejects(m, intents.restore({ nodeId: F(6), destinationNodeId: F(1) }), 'NOT_FOLDER')
  rejects(m, intents.restore({ nodeId: F(6), destinationNodeId: ID(404) }), 'NOT_FOUND')
})

test('OP-7 attachBlob creates a file node with blobRef and reports attachBlobRefs; duplicate blobRef → BLOB_ALREADY_REFERENCED; malformed → INVALID_INTENT', () => {
  const m = base()
  const it = intents.attachBlob({ parentNodeId: D(1), name: 'up.bin', mediaType: 'application/octet-stream', plainSize: 42, blobRef: { formatVersion: 2, id: 'new-blob' } })
  const r = apply(m, it)
  const id = r.changedNodeIds[0]
  assert.deepEqual(r.manifest.nodes.get(id), { nodeId: id, kind: 'file', parentNodeId: D(1), name: 'up.bin', createdAtClient: NOW + 5, modifiedAtClient: NOW + 5, lifecycle: { state: 'active' }, blobRef: { formatVersion: 2, id: 'new-blob' }, mediaType: 'application/octet-stream', plainSize: 42 })
  assert.deepEqual(r.attachBlobRefs, [{ formatVersion: 2, id: 'new-blob' }]); assert.deepEqual(r.purgeBlobRefs, [])
  rejects(m, intents.attachBlob({ parentNodeId: D(1), name: 'again.bin', mediaType: '', plainSize: 1, blobRef: { formatVersion: 2, id: 'blob-2' } }), 'BLOB_ALREADY_REFERENCED')
  rejects(m, intents.attachBlob({ parentNodeId: D(1), name: 'again.bin', mediaType: '', plainSize: 1, blobRef: { formatVersion: 2, id: 'blob-5' } }), 'BLOB_ALREADY_REFERENCED', opts()) // referenced by a trashed node still counts
  rejects(m, intents.attachBlob({ parentNodeId: D(1), name: 'B.TXT', mediaType: '', plainSize: 1, blobRef: { formatVersion: 1, id: '9' } }), 'COLLISION')
  rejects(m, intents.attachBlob({ parentNodeId: D(3), name: 'x', mediaType: '', plainSize: 1, blobRef: { formatVersion: 1, id: '9' } }), 'EFFECTIVELY_TRASHED')
  rejects(m, intents.attachBlob({ parentNodeId: F(1), name: 'x', mediaType: '', plainSize: 1, blobRef: { formatVersion: 1, id: '9' } }), 'NOT_FOLDER')
  rejects(m, intents.attachBlob({ parentNodeId: D(1), name: 'x', mediaType: '', plainSize: -1, blobRef: { formatVersion: 1, id: '9' } }), 'INVALID_INTENT')
  rejects(m, intents.attachBlob({ parentNodeId: D(1), name: 'x', mediaType: '', plainSize: 1, blobRef: { formatVersion: 3, id: '9' } }), 'INVALID_INTENT')
  rejects(m, { type: 'attachBlob', operationId: ID(1), parentNodeId: D(1), name: 'x', mediaType: '', plainSize: 1 }, 'INVALID_INTENT')
  rejects(m, { type: 'nope', operationId: ID(1) }, 'INVALID_INTENT')
})

test('OP-8 purgeIntent removes the complete effective subtree of each root and returns every file blob in it (including independently trashed descendants); root → ROOT_IMMUTABLE; active → NOT_TRASHED', () => {
  const m = base()
  const r = apply(m, intents.purgeIntent({ nodeIds: [D(3), F(5), F(6)] }))
  assert.deepEqual([...r.changedNodeIds].sort(), [D(3), F(4), F(5), F(6)].sort())
  assert.deepEqual(r.purgeBlobRefs.map((b) => b.id).sort(), ['blob-4', 'blob-5', 'blob-6'])
  for (const id of [D(3), F(4), F(5), F(6)]) assert.equal(r.manifest.nodes.has(id), false)
  assert.equal(r.manifest.nodes.size, m.nodes.size - 4)
  rejects(m, intents.purgeIntent({ nodeIds: [ID(0)] }), 'ROOT_IMMUTABLE')
  rejects(m, intents.purgeIntent({ nodeIds: [D(1)] }), 'NOT_TRASHED')
  rejects(m, intents.purgeIntent({ nodeIds: [F(6), F(1)] }), 'AMBIGUOUS_SELECTION')
  // a trashed folder holding an active-stored subtree: the whole effective subtree goes
  const t = apply(m, intents.trash({ nodeIds: [D(1)] })).manifest
  const p = apply(t, intents.purgeIntent({ nodeIds: [D(1)] }))
  assert.deepEqual([...p.changedNodeIds].sort(), [D(1), D(2), F(2), F(3)].sort())
  assert.deepEqual(p.purgeBlobRefs.map((b) => b.id).sort(), ['blob-2', 'blob-3'])
})

test('OP-9 recentOperationIds: every applyIntent appends the intent operationId, bounded to limits.maxRecentOperationIds (oldest dropped); explicit ids are honoured', () => {
  let m = base()
  const ids = []
  for (let i = 0; i < 5; i++) {
    const it = intents.createFolder({ parentNodeId: ID(0), name: `f${i}` })
    assert.match(it.operationId, /^[A-Za-z0-9_-]{22}$/)
    ids.push(it.operationId)
    const r = apply(m, it, opts({ limits: treeLimitsFrom({ maxNodes: 100, maxDepth: 4, maxNameBytes: 24, maxRecentOperationIds: 3 }) }))
    assert.equal(r.operationId, it.operationId)
    m = r.manifest
  }
  assert.deepEqual(m.recentOperationIds, ids.slice(2), 'bounded to 3, oldest dropped')
  const explicit = intents.rename({ nodeId: F(1), name: 'renamed', operationId: ID(77, 'O') })
  assert.deepEqual(apply(m, explicit, opts({ limits: treeLimitsFrom({ maxNodes: 100, maxDepth: 4, maxNameBytes: 24, maxRecentOperationIds: 3 }) })).manifest.recentOperationIds, [...ids.slice(3), ID(77, 'O')])
  rejects(base(), { ...intents.rename({ nodeId: F(1), name: 'x' }), operationId: 'short' }, 'INVALID_INTENT')
})
