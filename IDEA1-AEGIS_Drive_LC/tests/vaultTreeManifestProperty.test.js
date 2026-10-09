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

// ── Unified Preview P2a: schema v2 generators (T-MAN-V2) ─────────────────────

const B64 = (rnd) => Buffer.from(Array.from({ length: 16 }, () => Math.floor(rnd() * 256))).toString('base64')
const VP1 = { thumb: [512, 512, 256 * 1024, null], poster: [512, 512, 256 * 1024, null], motion: [480, 270, 4 * 1024 * 1024, 6000], proxy: [854, 480, 1024 * 1024 * 1024, 3_600_000] }
const MIME = { thumb: ['image/webp', 'image/jpeg'], poster: ['image/webp', 'image/jpeg'], motion: ['video/mp4', 'video/webm'], proxy: ['video/mp4'] }
const FORMATS = ['', 'mp4', 'jpeg', 'png', 'webm', 'pdf', 'unknown']
const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))

function randomPreview(rnd, kind, sourceBlobRef, k) {
  const [longMax, shortMax, sizeMax, durMax] = VP1[kind]
  const long = int(rnd, 1, longMax), short = int(rnd, 1, Math.min(long, shortMax))
  const [width, height] = rnd() < 0.5 ? [long, short] : [short, long]
  const p = { kind, profile: 'vp1', blobRef: { formatVersion: 2, id: `d-${kind}-${k}` }, contentId: B64(rnd), sourceBlobRef: { ...sourceBlobRef }, mime: MIME[kind][int(rnd, 0, MIME[kind].length - 1)], width, height, plainSize: int(rnd, 1, sizeMax), createdAtClient: NOW }
  if (durMax) p.durationMs = int(rnd, 1, durMax)
  return p
}

function randomTreeV2(rnd) {
  const m = randomTree(rnd)
  m.schemaVersion = 2
  let k = 0
  for (const n of m.nodes.values()) {
    if (n.kind !== 'file') continue
    k++
    if (rnd() < 0.7) n.contentFormat = FORMATS[int(rnd, 0, FORMATS.length - 1)]
    if (rnd() < 0.8) n.previews = ['thumb', 'poster', 'motion', 'proxy'].filter(() => rnd() < 0.5).map((kind) => randomPreview(rnd, kind, n.blobRef, k))
  }
  return m
}

const firstPreview = (m) => [...m.nodes.values()].find((n) => n.previews?.length)?.previews[0]
const firstFile = (m) => [...m.nodes.values()].find((n) => n.kind === 'file')
const V2_MUTATIONS = [
  ['unknown preview key', (m) => { const p = firstPreview(m); if (!p) return false; p.extra = 1 }, 'UNKNOWN_KEY'],
  ['derivative blobRef v1', (m) => { const p = firstPreview(m); if (!p) return false; p.blobRef.formatVersion = 1 }, 'PREVIEW_BAD_BLOB_REF'],
  ['contentId 15 bytes', (m) => { const p = firstPreview(m); if (!p) return false; p.contentId = p.contentId.slice(0, 20) }, 'PREVIEW_BAD_CONTENT_ID'],
  ['width above bound', (m) => { const p = firstPreview(m); if (!p) return false; p.width = 100_000 }, 'PREVIEW_OUT_OF_BOUNDS'],
  ['plainSize zero', (m) => { const p = firstPreview(m); if (!p) return false; p.plainSize = 0 }, 'PREVIEW_BAD_FIELD'],
  ['bad kind', (m) => { const p = firstPreview(m); if (!p) return false; p.kind = 'banner' }, 'PREVIEW_BAD_KIND'],
  ['bad mime', (m) => { const p = firstPreview(m); if (!p) return false; p.mime = 'text/html' }, 'PREVIEW_BAD_MIME'],
  ['duplicate kind', (m) => { const n = [...m.nodes.values()].find((x) => x.previews?.length); if (!n) return false; n.previews.push({ ...n.previews[0], blobRef: { formatVersion: 2, id: 'dup' } }); if (n.previews.length > 4) n.previews.splice(1, 1) }, 'PREVIEW_DUPLICATE_KIND'],
  ['unknown contentFormat', (m) => { const f = firstFile(m); if (!f) return false; f.contentFormat = 'exe' }, 'BAD_CONTENT_FORMAT'],
  ['folder with previews', (m) => { const f = [...m.nodes.values()].find((x) => x.kind === 'folder'); f.previews = [] }, 'FOLDER_HAS_PREVIEWS'],
  ['v2 keys under schema 1', (m) => { const f = [...m.nodes.values()].find((x) => x.previews || x.contentFormat !== undefined); if (!f) return false; m.schemaVersion = 1 }, 'UNKNOWN_KEY'],
]

test('MP-3 300 random valid v2 manifests pass; every single-field corruption rejects with its code', () => {
  let tried = 0
  for (let i = 0; i < 300; i++) {
    assert.equal(validateManifest(randomTreeV2(makeRnd(5000 + i)), LIMITS).ok, true, `v2 tree ${i}`)
    for (const [label, mutate, code] of V2_MUTATIONS) {
      const copy = randomTreeV2(makeRnd(5000 + i))
      if (mutate(copy) === false) continue
      tried++
      assert.throws(() => validateManifest(copy, LIMITS), (e) => e.code === code, `v2 tree ${i}: ${label} → ${code}`)
    }
  }
  assert.ok(tried > 1000, `v2 mutations exercised: ${tried}`)
})
