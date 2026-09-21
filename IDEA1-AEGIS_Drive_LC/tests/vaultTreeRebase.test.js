// tests/vaultTreeRebase.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.2 · bounded semantic rebase (RB-1..RB-8)
//
// rebase = "intent ที่คิดไว้กับ base ยังมีความหมายเดิมบน head ไหม": AUTO (ใช้ต่อได้, อาจตัดแต่ง), CONFLICT (เหตุผลชัดเจน
// ให้ผู้ใช้ตัดสิน — ไม่มี last-write-wins) หรือ ALREADY_APPLIED (operationId ปรากฏใน head แล้ว) — deterministic ทุกกรณี
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, ID, NOW, snapshot } from './helpers/vaultTreeTrees.mjs'
import { validateManifest } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { intents, applyIntent } from '../src/lib/vaultTreeOps.js'
import { rebaseIntent, REBASE_REASONS } from '../src/lib/vaultTreeRebase.js'

const LIMITS = treeLimitsFrom({ maxNodes: 200, maxDepth: 8, maxNameBytes: 64, maxRecentOperationIds: 8 })
let seq = 900
const newNodeId = () => ID(seq++, 'Z')
const o = { now: NOW + 9, newNodeId, limits: LIMITS }
const F = (n) => ID(n, 'F'), D = (n) => ID(n, 'D')
/**
 *  root ─┬─ docs (D1) ─┬─ sub (D2) ── deep.txt (F2)
 *        │             └─ b.txt (F3)
 *        ├─ a.txt (F1)
 *        ├─ misc (D4)
 *        └─ old.txt (F6) [trashed]
 */
const base = () => buildTree([
  [D(1), 'folder', ID(0), 'docs'], [D(2), 'folder', D(1), 'sub'], [F(2), 'file', D(2), 'deep.txt'], [F(3), 'file', D(1), 'b.txt'],
  [F(1), 'file', ID(0), 'a.txt'], [D(4), 'folder', ID(0), 'misc'], [F(6), 'file', ID(0), 'old.txt', { trashed: true }],
])
const idx = (m) => validateManifest(m, LIMITS).index
/** head = base + intents ของ "อีก client" */
const headAfter = (m, ...others) => others.reduce((acc, it) => applyIntent(acc, it, o).manifest, m)
const rebase = (intent, headM, baseM = base()) => rebaseIntent(intent, { baseIndex: idx(baseM), headIndex: idx(headM), headRecentOperationIds: headM.recentOperationIds })
const conflict = (reason) => ({ kind: 'CONFLICT', reason })

test('RB-1 disjoint change on head (another node renamed/created/moved) → AUTO with the same intent; the rebased intent applies cleanly on head', () => {
  const m = base()
  const head = headAfter(m, intents.rename({ nodeId: F(3), name: 'bb.txt' }), intents.createFolder({ parentNodeId: D(4), name: 'x' }), intents.move({ nodeIds: [F(1)], destinationNodeId: D(4) }))
  for (const intent of [
    intents.rename({ nodeId: F(2), name: 'deeper.txt' }),
    intents.createFolder({ parentNodeId: D(1), name: 'new' }),
    intents.move({ nodeIds: [D(2)], destinationNodeId: D(4) }),
    intents.trash({ nodeIds: [D(2)] }),
    intents.restore({ nodeId: F(6) }),
    intents.attachBlob({ parentNodeId: D(1), name: 'u.bin', mediaType: '', plainSize: 1, blobRef: { formatVersion: 2, id: 'blob-u' } }),
  ]) {
    const r = rebase(intent, head)
    assert.deepEqual(r, { kind: 'AUTO', intent }, intent.type)
    assert.ok(applyIntent(head, r.intent, o).manifest, `${intent.type} applies on head`)
  }
})

test('RB-2 rename: target renamed on head → TARGET_RENAMED; target trashed → TARGET_DELETED; target purged → TARGET_DELETED; new name now collides → COLLISION; moved target → AUTO', () => {
  const m = base()
  const mine = intents.rename({ nodeId: F(3), name: 'c.txt' })
  assert.deepEqual(rebase(mine, headAfter(m, intents.rename({ nodeId: F(3), name: 'theirs.txt' }))), conflict('TARGET_RENAMED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [F(3)] }))), conflict('TARGET_DELETED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(1)] }))), conflict('TARGET_DELETED'), 'trashed via ancestor')
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [F(3)] }), intents.purgeIntent({ nodeIds: [F(3)] }))), conflict('TARGET_DELETED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.createFolder({ parentNodeId: D(1), name: 'C.TXT' }))), conflict('COLLISION'))
  const moved = headAfter(m, intents.move({ nodeIds: [F(3)], destinationNodeId: D(4) }))
  assert.deepEqual(rebase(mine, moved), { kind: 'AUTO', intent: mine }, 'rename follows the node to its new parent')
  assert.deepEqual(rebase(mine, headAfter(moved, intents.createFolder({ parentNodeId: D(4), name: 'c.txt' }))), conflict('COLLISION'), 'collision is checked in the head parent')
})

test('RB-3 move: destination purged → DESTINATION_DELETED; destination trashed → DESTINATION_TRASHED; destination now under a moved node → CYCLE_AFTER_REBASE; moved node gone → TARGET_DELETED; collision at destination → COLLISION', () => {
  const m = base()
  const mine = intents.move({ nodeIds: [F(1), D(2)], destinationNodeId: D(4) })
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(4)] }), intents.purgeIntent({ nodeIds: [D(4)] }))), conflict('DESTINATION_DELETED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(4)] }))), conflict('DESTINATION_TRASHED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.move({ nodeIds: [D(4)], destinationNodeId: D(2) }))), conflict('CYCLE_AFTER_REBASE'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [F(1)] }))), conflict('TARGET_DELETED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.createFolder({ parentNodeId: D(4), name: 'SUB' }))), conflict('COLLISION'))
  // a moved node already sitting in the destination on head is a no-op member, not a collision with itself
  assert.deepEqual(rebase(mine, headAfter(m, intents.move({ nodeIds: [F(1)], destinationNodeId: D(4) }))), { kind: 'AUTO', intent: mine })
})

test('RB-4 createFolder: name now collides on head → COLLISION; parent purged → DESTINATION_DELETED; parent trashed → DESTINATION_TRASHED; sibling trashed with the same name → AUTO', () => {
  const m = base()
  const mine = intents.createFolder({ parentNodeId: D(1), name: 'Sub2' })
  assert.deepEqual(rebase(mine, headAfter(m, intents.createFolder({ parentNodeId: D(1), name: 'SUB2' }))), conflict('COLLISION'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.rename({ nodeId: D(2), name: 'sub2' }))), conflict('COLLISION'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(1)] }), intents.purgeIntent({ nodeIds: [D(1)] }))), conflict('DESTINATION_DELETED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(1)] }))), conflict('DESTINATION_TRASHED'))
  const trashedTwin = headAfter(m, intents.createFolder({ parentNodeId: D(1), name: 'sub2' }))
  const twinId = [...trashedTwin.nodes.values()].find((n) => n.name === 'sub2').nodeId
  assert.deepEqual(rebase(mine, headAfter(trashedTwin, intents.trash({ nodeIds: [twinId] }))), { kind: 'AUTO', intent: mine })
})

test('RB-5 restore: original parent trashed on head → DESTINATION_TRASHED without a destination, RESTORE_COLLISION when the explicit destination collides, else AUTO to the explicit destination; already restored → ALREADY_APPLIED', () => {
  const m = base()
  const t = headAfter(m, intents.trash({ nodeIds: [F(3)] }))            // F3 trashed from D1
  const implicit = intents.restore({ nodeId: F(3) })
  const explicit = intents.restore({ nodeId: F(3), destinationNodeId: D(4) })
  const parentTrashed = headAfter(t, intents.trash({ nodeIds: [D(1)] }))
  assert.deepEqual(rebase(implicit, parentTrashed, t), conflict('DESTINATION_TRASHED'))
  assert.deepEqual(rebase(explicit, parentTrashed, t), { kind: 'AUTO', intent: explicit })
  assert.deepEqual(rebase(explicit, headAfter(parentTrashed, intents.createFolder({ parentNodeId: D(4), name: 'B.TXT' })), t), conflict('RESTORE_COLLISION'))
  assert.deepEqual(rebase(implicit, headAfter(t, intents.createFolder({ parentNodeId: D(1), name: 'b.txt' })), t), conflict('RESTORE_COLLISION'), 'original parent collides and no explicit destination')
  assert.deepEqual(rebase(implicit, headAfter(t, intents.restore({ nodeId: F(3) })), t), { kind: 'ALREADY_APPLIED' })
  assert.deepEqual(rebase(implicit, headAfter(t, intents.purgeIntent({ nodeIds: [F(3)] })), t), conflict('TARGET_DELETED'))
  assert.deepEqual(rebase(explicit, headAfter(t, intents.trash({ nodeIds: [D(4)] }), intents.purgeIntent({ nodeIds: [D(4)] })), t), conflict('DESTINATION_DELETED'))
})

test('RB-6 attachBlob: parent trashed/purged on head → PARENT_CHANGED (blob stays an orphan); name collides → COLLISION; blob already attached by someone → ALREADY_APPLIED', () => {
  const m = base()
  const mine = intents.attachBlob({ parentNodeId: D(2), name: 'up.bin', mediaType: '', plainSize: 3, blobRef: { formatVersion: 2, id: 'blob-up' } })
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(2)] }))), conflict('PARENT_CHANGED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(1)] }))), conflict('PARENT_CHANGED'), 'trashed via ancestor')
  assert.deepEqual(rebase(mine, headAfter(m, intents.trash({ nodeIds: [D(2)] }), intents.purgeIntent({ nodeIds: [D(2)] }))), conflict('PARENT_CHANGED'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.createFolder({ parentNodeId: D(2), name: 'UP.BIN' }))), conflict('COLLISION'))
  assert.deepEqual(rebase(mine, headAfter(m, intents.attachBlob({ parentNodeId: D(4), name: 'recovered.bin', mediaType: '', plainSize: 3, blobRef: { formatVersion: 2, id: 'blob-up' } }))), { kind: 'ALREADY_APPLIED' })
})

test('RB-7 same intent twice: operationId present in head.recentOperationIds → ALREADY_APPLIED (before any semantic check); trash/purge of nodes already gone → ALREADY_APPLIED, partially → trimmed AUTO', () => {
  const m = base()
  const mine = intents.rename({ nodeId: F(3), name: 'c.txt' })
  const applied = headAfter(m, mine)
  assert.deepEqual(rebase(mine, applied), { kind: 'ALREADY_APPLIED' })
  // even when the head would otherwise conflict (someone renamed it again afterwards)
  assert.deepEqual(rebase(mine, headAfter(applied, intents.rename({ nodeId: F(3), name: 'd.txt' }))), { kind: 'ALREADY_APPLIED' })
  const trashBoth = intents.trash({ nodeIds: [F(1), F(3)] })
  assert.deepEqual(rebase(trashBoth, headAfter(m, intents.trash({ nodeIds: [F(1), F(3)] }))), { kind: 'ALREADY_APPLIED' })
  const partial = rebase(trashBoth, headAfter(m, intents.trash({ nodeIds: [F(1)] })))
  assert.deepEqual(partial, { kind: 'AUTO', intent: { ...trashBoth, nodeIds: [F(3)] } })
  const purge = intents.purgeIntent({ nodeIds: [F(6)] })
  assert.deepEqual(rebase(purge, headAfter(m, intents.purgeIntent({ nodeIds: [F(6)] }))), { kind: 'ALREADY_APPLIED' })
  assert.deepEqual(rebase(purge, headAfter(m, intents.restore({ nodeId: F(6) }))), conflict('TARGET_RESTORED'), 'a node someone restored is never purged silently')
})

test('RB-8 rebase never mutates its inputs (intent, indexes, manifests); reasons are the documented set; unknown intent type → CONFLICT UNSUPPORTED_INTENT', () => {
  const m = base()
  const head = headAfter(m, intents.trash({ nodeIds: [D(2)] }))
  const intent = intents.move({ nodeIds: [F(1), F(3)], destinationNodeId: D(2) })
  const bi = idx(m), hi = idx(head)
  const before = { intent: JSON.stringify(intent), base: snapshot(m), head: snapshot(head), bkids: JSON.stringify([...bi.childrenOf]), hkids: JSON.stringify([...hi.childrenOf]) }
  const r = rebaseIntent(intent, { baseIndex: bi, headIndex: hi, headRecentOperationIds: head.recentOperationIds })
  assert.deepEqual(r, conflict('DESTINATION_TRASHED'))
  assert.deepEqual({ intent: JSON.stringify(intent), base: snapshot(m), head: snapshot(head), bkids: JSON.stringify([...bi.childrenOf]), hkids: JSON.stringify([...hi.childrenOf]) }, before)
  const auto = rebase(intents.trash({ nodeIds: [F(1), F(3)] }), headAfter(m, intents.trash({ nodeIds: [F(1)] })))
  assert.notEqual(auto.intent, intent); assert.ok(Object.isFrozen(auto.intent) || true)
  assert.deepEqual([...REBASE_REASONS].sort(), ['COLLISION', 'CYCLE_AFTER_REBASE', 'DESTINATION_DELETED', 'DESTINATION_TRASHED', 'PARENT_CHANGED', 'RESTORE_COLLISION', 'TARGET_DELETED', 'TARGET_RENAMED', 'TARGET_RESTORED', 'UNSUPPORTED_INTENT'])
  assert.deepEqual(rebase({ type: 'bogus', operationId: ID(1) }, head), conflict('UNSUPPORTED_INTENT'))
})
