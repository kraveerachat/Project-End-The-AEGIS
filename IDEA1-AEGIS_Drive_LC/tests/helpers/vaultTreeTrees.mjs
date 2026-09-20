// tests/helpers/vaultTreeTrees.mjs — PR #157 · deterministic + random manifest builders for the Phase 5 suites
//
// ทุก manifest ที่สร้างที่นี่ผ่าน validateManifest — ชุดทดสอบใช้มันเป็น "สถานะก่อน" แล้วพิสูจน์ผลของ intent/rebase
import { collisionKey } from '../../src/lib/vaultTreeManifest.js'

export const NOW = 1_700_000_000_000
export const ID = (n, tag = 'A') => String(n).padStart(22, tag)

/** xorshift32 — ผลซ้ำได้จาก seed */
export function makeRnd(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000 } }

/**
 * ต้นไม้จาก spec ย่อ: `[['id', 'folder'|'file', parentId, name, { trashed?: true }], ...]` (root = ID(0), ชื่อว่าง)
 * ไฟล์ได้ blobRef { formatVersion: 2, id: 'blob-<id>' } เว้นแต่ระบุ
 */
export function buildTree(spec, { treeId = ID(900), generation = 2, revisionId = ID(901), baseRevisionId = ID(902) } = {}) {
  const root = { nodeId: ID(0), kind: 'folder', parentNodeId: null, name: '', createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
  const nodes = new Map([[ID(0), root]])
  for (const [id, kind, parent, name, opts = {}] of spec) {
    const n = { nodeId: id, kind, parentNodeId: parent, name, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
    if (kind === 'file') Object.assign(n, { blobRef: opts.blobRef ?? { formatVersion: 2, id: `blob-${id.replace(/^(.)\1+/, '')}` }, mediaType: opts.mediaType ?? 'application/octet-stream', plainSize: opts.plainSize ?? 10 })
    if (opts.trashed) n.lifecycle = { state: 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: opts.trashedFrom ?? parent }
    if (opts.purgePending) n.lifecycle = { state: 'purge-pending', trashedAtClient: NOW, trashedFromParentNodeId: opts.trashedFrom ?? parent }
    nodes.set(id, n)
  }
  return { schemaVersion: 1, treeId, generation, revisionId, baseRevisionId: generation === 1 ? null : baseRevisionId, rootNodeId: ID(0), createdAtClient: NOW, nodes, recentOperationIds: [] }
}

/** ต้นไม้สุ่มที่ถูกต้อง (root = ID(0)); ชื่อไม่ชนกันในพี่น้อง; บางโหนดถูกทิ้ง */
export function randomTree(rnd, { nodes = 1 + Math.floor(rnd() * 60), trashRate = 0.15, folderRate = 0.3, purgePendingRate = 0 } = {}) {
  const arr = [{ nodeId: ID(0), kind: 'folder', parentNodeId: null, name: '', createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }]
  const folders = [0]
  const usedNames = new Map()
  for (let k = 1; k < nodes; k++) {
    const parent = folders[Math.floor(rnd() * folders.length)]
    const isFolder = rnd() < folderRate
    let name
    for (;;) {
      name = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => 'abcdefABCDEFßกขค'[Math.floor(rnd() * 16)]).join('')
      const set = usedNames.get(parent) ?? new Set()
      if (!set.has(collisionKey(name))) { set.add(collisionKey(name)); usedNames.set(parent, set); break }
    }
    const n = { nodeId: ID(k), kind: isFolder ? 'folder' : 'file', parentNodeId: ID(parent), name, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
    if (!isFolder) Object.assign(n, { blobRef: { formatVersion: rnd() < 0.5 ? 1 : 2, id: 'b' + k }, mediaType: 'application/octet-stream', plainSize: Math.floor(rnd() * 1000) })
    if (rnd() < trashRate) n.lifecycle = { state: rnd() < purgePendingRate ? 'purge-pending' : 'trashed', trashedAtClient: NOW, trashedFromParentNodeId: ID(parent) }
    if (isFolder) folders.push(k)
    arr.push(n)
  }
  return {
    schemaVersion: 1, treeId: ID(900), generation: 2, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: NOW, nodes: new Map(arr.map((n) => [n.nodeId, n])), recentOperationIds: [],
  }
}

/** deep-equal ของ manifest (Map → entries) — ใช้พิสูจน์ "input ไม่ถูกแตะ" */
export const snapshot = (m) => JSON.stringify({ ...m, nodes: [...m.nodes.entries()] })

/** ชื่อสุ่มที่ไม่ชนกับพี่น้อง active ใต้ parent */
export function freshName(rnd, index, parentId) {
  for (let i = 0; i < 100; i++) {
    const name = 'n' + Math.floor(rnd() * 1e9).toString(36)
    const kids = index.childrenOf.get(parentId) ?? []
    if (!kids.some((c) => index.nodes.get(c).lifecycle.state === 'active' && collisionKey(index.nodes.get(c).name) === collisionKey(name))) return name
  }
  return 'n' + Date.now()
}
