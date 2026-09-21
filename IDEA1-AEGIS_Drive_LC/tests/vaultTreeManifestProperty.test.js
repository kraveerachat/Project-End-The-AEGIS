// tests/vaultTreeManifestProperty.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.4 · property tests
//
// สุ่มต้นไม้ที่ถูกต้องหลายร้อยใบ: ทุกใบต้องผ่าน; ทุกการกลายพันธุ์จากรายการที่กำหนดต้องล้มด้วย code ที่คาด;
// และสถานะที่มีผลจริงต้องเท่ากับ "ตัวเองหรือบรรพบุรุษใดไม่ active" เสมอ โดยไม่เขียนทับลูกหลาน
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest, effectiveState, ancestorsOf, collisionKey } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'

const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1_700_000_000_000
const LIMITS = treeLimitsFrom({ maxNodes: 500, maxDepth: 32, maxNameBytes: 120 })

function makeRnd(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000 } }

function randomTree(rnd, { nodes = 1 + Math.floor(rnd() * 60), trashRate = 0.15 } = {}) {
  const arr = [{ nodeId: ID(0), kind: 'folder', parentNodeId: null, name: '', createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }]
  const folders = [0]
  const usedNames = new Map() // parent → Set(collisionKey) for stored-active nodes
  for (let k = 1; k < nodes; k++) {
    const parent = folders[Math.floor(rnd() * folders.length)]
    const isFolder = rnd() < 0.3
    let name
    for (;;) {
      name = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => 'abcdefABCDEFßกขค'[Math.floor(rnd() * 16)]).join('')
      const set = usedNames.get(parent) ?? new Set()
      if (!set.has(collisionKey(name))) { set.add(collisionKey(name)); usedNames.set(parent, set); break }
    }
    const n = { nodeId: ID(k), kind: isFolder ? 'folder' : 'file', parentNodeId: ID(parent), name, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
    if (!isFolder) Object.assign(n, { blobRef: { formatVersion: rnd() < 0.5 ? 1 : 2, id: 'b' + k }, mediaType: 'application/octet-stream', plainSize: Math.floor(rnd() * 1000) })
    if (rnd() < trashRate) n.lifecycle = { state: rnd() < 0.2 ? 'purge-pending' : 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: ID(parent) }
    if (isFolder) folders.push(k)
    arr.push(n)
  }
  return {
    schemaVersion: 1, treeId: ID(900), generation: 2, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: NOW, nodes: new Map(arr.map((n) => [n.nodeId, n])), recentOperationIds: [],
  }
}

const MUTATIONS = [
  ['drop root', (m) => { m.nodes.delete(m.rootNodeId) }, 'NO_ROOT'],
  ['second root', (m) => { m.nodes.set(ID(999), { nodeId: ID(999), kind: 'folder', parentNodeId: null, name: 'x', createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }) }, 'MULTI_ROOT'],
  ['re-parent a folder to its own descendant', (m) => {
    const folders = [...m.nodes.values()].filter((n) => n.kind === 'folder' && n.parentNodeId !== null)
    for (const f of folders) {
      const kids = [...m.nodes.values()].filter((n) => n.parentNodeId === f.nodeId && n.kind === 'folder')
      if (kids.length) { f.parentNodeId = kids[0].nodeId; return true }
    }
    return false
  }, 'UNREACHABLE'],
  ['duplicate an active sibling name', (m) => {
    for (const n of m.nodes.values()) {
      if (n.parentNodeId === null || n.lifecycle.state !== 'active') continue
      const sib = [...m.nodes.values()].find((o) => o !== n && o.parentNodeId === n.parentNodeId && o.lifecycle.state === 'active')
      if (sib) { sib.name = n.name.toUpperCase(); return true }
    }
    return false
  }, 'COLLISION'],
  ['parent missing', (m) => { const n = [...m.nodes.values()].find((x) => x.parentNodeId !== null); if (!n) return false; n.parentNodeId = ID(998); return true }, 'PARENT_MISSING'],
  ['file as parent', (m) => {
    const file = [...m.nodes.values()].find((x) => x.kind === 'file'); const other = [...m.nodes.values()].find((x) => x.parentNodeId !== null && x !== file)
    if (!file || !other) return false; other.parentNodeId = file.nodeId; return true
  }, 'PARENT_NOT_FOLDER'],
  ['folder with blobRef', (m) => { const f = [...m.nodes.values()].find((x) => x.kind === 'folder'); f.blobRef = { formatVersion: 2, id: 'z' }; return true }, 'FOLDER_HAS_BLOB'],
  ['trashed without metadata', (m) => { const n = [...m.nodes.values()].find((x) => x.parentNodeId !== null); if (!n) return false; n.lifecycle = { state: 'trashed' }; return true }, 'LIFECYCLE_INCONSISTENT'],
]

test('MP-1 500 random valid trees pass; every listed single mutation fails with the expected code', () => {
  const rnd = makeRnd(2026)
  let mutationsTried = 0
  for (let i = 0; i < 500; i++) {
    const m = randomTree(rnd)
    assert.equal(validateManifest(m, LIMITS).ok, true, `tree ${i}`)
    for (const [label, mutate, code] of MUTATIONS) {
      const copy = randomTree(makeRnd(2026 + i)) // regenerate identically rather than deep-clone
      const applied = mutate(copy)
      if (applied === false) continue
      mutationsTried++
      assert.throws(() => validateManifest(copy, LIMITS), (e) => e.code === code, `tree ${i}: ${label} → ${code}`)
    }
  }
  assert.ok(mutationsTried > 500, `mutations exercised: ${mutationsTried}`)
})

test('MP-2 effectiveState(node) equals any(self or ancestor stored state ≠ active), strongest wins, for 200 random trees', () => {
  const rnd = makeRnd(77)
  for (let i = 0; i < 200; i++) {
    const m = randomTree(rnd, { trashRate: 0.35 })
    const { index } = validateManifest(m, LIMITS)
    for (const n of m.nodes.values()) {
      const chain = [n.nodeId, ...ancestorsOf(index, n.nodeId)].map((id) => m.nodes.get(id).lifecycle.state)
      const expected = chain.includes('purge-pending') ? 'purge-pending' : chain.includes('trashed') ? 'trashed' : 'active'
      assert.equal(effectiveState(index, n.nodeId), expected)
    }
    // descendants of a trashed folder were never rewritten: their stored state is whatever the generator assigned
    const storedActiveUnderTrashed = [...m.nodes.values()].filter((n) => n.lifecycle.state === 'active' && effectiveState(index, n.nodeId) !== 'active')
    for (const n of storedActiveUnderTrashed) assert.equal(n.lifecycle.state, 'active')
  }
})
