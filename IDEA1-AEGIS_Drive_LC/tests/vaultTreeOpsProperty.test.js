// tests/vaultTreeOpsProperty.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.1 · property tests over random trees (OPP-1..OPP-4)
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRnd, randomTree, ID, NOW, snapshot, freshName } from './helpers/vaultTreeTrees.mjs'
import { validateManifest, effectiveState, isDescendant } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { intents, applyIntent, normalizeSelectionRoots, OpError } from '../src/lib/vaultTreeOps.js'

const LIMITS = treeLimitsFrom({ maxNodes: 400, maxDepth: 24, maxNameBytes: 64, maxRecentOperationIds: 16 })
let seq = 10_000
const newNodeId = () => ID(seq++, 'Q')
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)]
const nonRoot = (m) => [...m.nodes.keys()].filter((id) => id !== m.rootNodeId)
const folders = (m) => [...m.nodes.values()].filter((n) => n.kind === 'folder').map((n) => n.nodeId)

/** intent สุ่มที่ "อาจ" ถูกต้องหรือไม่ก็ได้ — ความหมายของ OPP-1 คือ apply/reject ต้องรักษา invariant ทั้งสองทาง */
function randomIntent(rnd, m, index) {
  const ids = nonRoot(m), fs = folders(m)
  const k = rnd()
  if (k < 0.2) return intents.createFolder({ parentNodeId: pick(rnd, fs), name: rnd() < 0.8 ? freshName(rnd, index, ID(0)) : pick(rnd, [...m.nodes.values()]).name })
  if (k < 0.35) return intents.rename({ nodeId: pick(rnd, ids.length ? ids : [ID(0)]), name: rnd() < 0.8 ? freshName(rnd, index, ID(0)) : pick(rnd, [...m.nodes.values()]).name })
  if (k < 0.55) return intents.move({ nodeIds: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, ids.length ? ids : [ID(0)])), destinationNodeId: rnd() < 0.9 ? pick(rnd, fs) : pick(rnd, ids.length ? ids : [ID(0)]) })
  if (k < 0.7) return intents.trash({ nodeIds: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, ids.length ? ids : [ID(0)])) })
  if (k < 0.82) return intents.restore({ nodeId: pick(rnd, ids.length ? ids : [ID(0)]), destinationNodeId: rnd() < 0.5 ? null : pick(rnd, fs) })
  if (k < 0.92) return intents.attachBlob({ parentNodeId: pick(rnd, fs), name: freshName(rnd, index, ID(0)), mediaType: 'x/y', plainSize: Math.floor(rnd() * 100), blobRef: { formatVersion: 2, id: rnd() < 0.9 ? 'nb' + Math.floor(rnd() * 1e9) : 'b' + Math.floor(rnd() * 60) } })
  return intents.purgeIntent({ nodeIds: [pick(rnd, ids.length ? ids : [ID(0)])] })
}

test('OPP-1 300 random intents over random trees: after every applied intent validateManifest passes; after every rejected intent the manifest is deep-equal to before', () => {
  const rnd = makeRnd(0x51_51)
  let applied = 0, rejected = 0
  const perType = {}
  for (let t = 0; t < 12; t++) {
    let m = randomTree(rnd, { nodes: 5 + Math.floor(rnd() * 40) })
    for (let i = 0; i < 25; i++) {
      const { index } = validateManifest(m, LIMITS)
      const intent = randomIntent(rnd, m, index)
      const before = snapshot(m)
      let r = null, err = null
      try { r = applyIntent(m, intent, { now: NOW + i, newNodeId, limits: LIMITS }) } catch (e) { err = e }
      assert.equal(snapshot(m), before, 'input manifest is never mutated')
      if (err) {
        assert.ok(err instanceof OpError, `${intent.type}: unexpected ${err.name}: ${err.message}`)
        rejected++; perType[intent.type + ':' + err.code] = (perType[intent.type + ':' + err.code] ?? 0) + 1
        continue
      }
      validateManifest(r.manifest, LIMITS)
      assert.equal(r.manifest.recentOperationIds.at(-1), intent.operationId)
      applied++; perType[intent.type + ':ok'] = (perType[intent.type + ':ok'] ?? 0) + 1
      m = r.manifest
    }
  }
  assert.equal(applied + rejected, 300)
  assert.ok(applied > 60 && rejected > 30, `mix: ${JSON.stringify(perType)}`)
  for (const type of ['createFolder', 'rename', 'move', 'trash', 'restore', 'attachBlob', 'purge']) assert.ok(perType[type + ':ok'] > 0, `${type} applied at least once: ${JSON.stringify(perType)}`)
})

test('OPP-2 normalizeSelectionRoots never returns a pair (a, b) with isDescendant(b, a); every input root survives', () => {
  const rnd = makeRnd(0x52_52)
  for (let t = 0; t < 200; t++) {
    const m = randomTree(rnd, { nodes: 3 + Math.floor(rnd() * 50), trashRate: 0 })
    const { index } = validateManifest(m, LIMITS)
    const ids = [...m.nodes.keys()]
    const sel = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pick(rnd, ids))
    const roots = normalizeSelectionRoots(index, sel)
    for (const a of roots) for (const b of roots) if (a !== b) assert.equal(isDescendant(index, b, a), false)
    for (const id of new Set(sel)) assert.ok(roots.some((r) => r === id || isDescendant(index, id, r)), 'every selected node is covered by a root')
  }
})

test('OPP-3 move into self or a descendant is rejected with CYCLE for every folder of 100 random trees; move to an unrelated active folder is accepted', () => {
  const rnd = makeRnd(0x53_53)
  let checks = 0
  for (let t = 0; t < 100; t++) {
    const m = randomTree(rnd, { nodes: 4 + Math.floor(rnd() * 30), trashRate: 0, folderRate: 0.5 })
    const { index } = validateManifest(m, LIMITS)
    for (const f of folders(m)) {
      if (f === m.rootNodeId) continue
      const stack = [f]
      while (stack.length) {
        const d = stack.pop()
        if (m.nodes.get(d).kind === 'folder') {
          assert.throws(() => applyIntent(m, intents.move({ nodeIds: [f], destinationNodeId: d }), { now: NOW, newNodeId, limits: LIMITS }), (e) => e.code === 'CYCLE')
          checks++
        }
        for (const c of index.childrenOf.get(d) ?? []) stack.push(c)
      }
    }
  }
  assert.ok(checks > 300, String(checks))
})

test('OPP-4 trash then restore of a subtree root restores exactly the nodes that had no own trashed state', () => {
  const rnd = makeRnd(0x54_54)
  let cases = 0
  for (let t = 0; t < 150; t++) {
    const m = randomTree(rnd, { nodes: 4 + Math.floor(rnd() * 40), trashRate: 0.25, folderRate: 0.5 })
    const { index } = validateManifest(m, LIMITS)
    const candidates = nonRoot(m).filter((id) => effectiveState(index, id) === 'active' && m.nodes.get(id).kind === 'folder')
    if (!candidates.length) continue
    const root = pick(rnd, candidates)
    const ownTrashedBefore = new Set([...m.nodes.values()].filter((n) => n.lifecycle.state !== 'active').map((n) => n.nodeId))
    const stateBefore = new Map([...m.nodes.keys()].map((id) => [id, effectiveState(index, id)]))
    const trashed = applyIntent(m, intents.trash({ nodeIds: [root] }), { now: NOW + 1, newNodeId, limits: LIMITS }).manifest
    const ti = validateManifest(trashed, LIMITS).index
    // whole subtree effectively trashed; nothing else changed
    for (const id of trashed.nodes.keys()) assert.equal(effectiveState(ti, id), id === root || isDescendant(ti, id, root) ? (ownTrashedBefore.has(id) ? stateBefore.get(id) : 'trashed') : stateBefore.get(id))
    const restored = applyIntent(trashed, intents.restore({ nodeId: root }), { now: NOW + 2, newNodeId, limits: LIMITS }).manifest
    const ri = validateManifest(restored, LIMITS).index
    for (const id of restored.nodes.keys()) assert.equal(effectiveState(ri, id), stateBefore.get(id), `${id} back to its pre-trash effective state`)
    for (const [id, n] of restored.nodes) assert.equal(n.lifecycle.state !== 'active', ownTrashedBefore.has(id), 'own stored state identical to before')
    cases++
  }
  assert.ok(cases > 100, String(cases))
})
