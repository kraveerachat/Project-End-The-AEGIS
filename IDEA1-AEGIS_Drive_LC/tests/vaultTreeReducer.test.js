// tests/vaultTreeReducer.test.js — AEGIS Drive (IDEA1) · PR #157 Task 5.5 · tree view reducer (VR-1..VR-7)
//
// reducer ล้วน (vaultTreeReducer) + hook บาง ๆ (useVaultTree) — ทดสอบผ่าน reducer และ effect helpers โดยตรง:
// ไม่มี React DOM ที่นี่ (Phase 6 คือ UI); สิ่งที่ต้องพิสูจน์คือความหมายของ current/selection/capabilities/conflict/drag
// และว่าการรีเฟรช head ทำให้ selection/current "สอดคล้อง" กับ manifest ใหม่เสมอ (VR-4)
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, ID, NOW } from './helpers/vaultTreeTrees.mjs'
import { validateManifest } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { intents, applyIntent } from '../src/lib/vaultTreeOps.js'
import { vaultTreeReducer, initialTreeViewState, viewSelectors, planRun, planDrop } from '../src/lib/useVaultTree.js'

const LIMITS = treeLimitsFrom({ maxNodes: 200, maxDepth: 8, maxNameBytes: 64 })
const F = (n) => ID(n, 'F'), D = (n) => ID(n, 'D')
/**
 *  root ─┬─ docs (D1) ─┬─ sub (D2) ── deep.txt (F2)
 *        │             └─ b.txt (F3)
 *        ├─ a.mp4 (F1)  (video → previewable)
 *        ├─ misc (D4)
 *        ├─ old.txt (F6) [trashed]
 *        └─ bin (D5) [trashed]
 */
const base = () => buildTree([
  [D(1), 'folder', ID(0), 'docs'], [D(2), 'folder', D(1), 'sub'], [F(2), 'file', D(2), 'deep.txt'], [F(3), 'file', D(1), 'b.txt'],
  [F(1), 'file', ID(0), 'a.mp4', { mediaType: 'video/mp4' }], [D(4), 'folder', ID(0), 'misc'], [F(6), 'file', ID(0), 'old.txt', { trashed: true }],
  [D(5), 'folder', ID(0), 'bin', { trashed: true }],
])
const headOf = (m, generation = 2) => ({ generation, revisionId: ID(generation, 'R'), manifest: m, index: validateManifest(m, LIMITS).index })
let seq = 700
const newNodeId = () => ID(seq++, 'Z')
const advance = (m, ...its) => its.reduce((acc, it) => applyIntent(acc, it, { now: NOW + 1, newNodeId, limits: LIMITS }).manifest, m)
const load = (m) => vaultTreeReducer(initialTreeViewState(), { type: 'head', head: headOf(m) })
const r = (s, a) => vaultTreeReducer(s, a)

test('VR-1 initial state: current = rootNodeId, view active, selection empty, no conflict, breadcrumbs = [root], children = active children of root', () => {
  const s0 = initialTreeViewState()
  assert.deepEqual({ current: s0.current, view: s0.view, sel: [...s0.selection], conflict: s0.conflict, head: s0.head, drag: s0.drag }, { current: null, view: 'active', sel: [], conflict: null, head: null, drag: null })
  const s = load(base())
  assert.equal(s.current, ID(0)); assert.equal(s.view, 'active'); assert.equal(s.selection.size, 0)
  const sel = viewSelectors(s)
  assert.deepEqual(sel.breadcrumbs.map((n) => n.nodeId), [ID(0)])
  assert.deepEqual(sel.children.map((n) => n.nodeId).sort(), [D(1), F(1), D(4)].sort(), 'trashed old.txt is not an active child')
  assert.equal(sel.keyDegraded, false)
})

test('VR-2 open(folder) pushes; up() pops; open(file) ignored; open(effectively trashed) rejected with a reason; breadcrumbs follow', () => {
  let s = load(base())
  s = r(s, { type: 'open', nodeId: D(1) })
  assert.equal(s.current, D(1)); assert.deepEqual(viewSelectors(s).breadcrumbs.map((n) => n.name), ['', 'docs'])
  s = r(s, { type: 'open', nodeId: D(2) })
  assert.equal(s.current, D(2)); assert.deepEqual(viewSelectors(s).children.map((n) => n.nodeId), [F(2)])
  const beforeFile = s
  s = r(s, { type: 'open', nodeId: F(2) })
  assert.equal(s, beforeFile, 'opening a file is a no-op (same state object)')
  const t = load(advance(base(), intents.trash({ nodeIds: [D(1)] })))
  const rejected = r(t, { type: 'open', nodeId: D(2) })
  assert.equal(rejected.current, ID(0)); assert.deepEqual(rejected.announcement, { kind: 'rejected', reason: 'EFFECTIVELY_TRASHED', nodeId: D(2) })
  s = r(s, { type: 'up' }); assert.equal(s.current, D(1))
  s = r(s, { type: 'up' }); assert.equal(s.current, ID(0))
  s = r(s, { type: 'up' }); assert.equal(s.current, ID(0), 'up at root stays at root')
  // trash view lists trashed subtree roots regardless of current
  const tv = r(t, { type: 'view', view: 'trash' })
  assert.deepEqual(viewSelectors(tv).children.map((n) => n.nodeId).sort(), [D(1), D(5), F(6)].sort())
  assert.equal(tv.selection.size, 0, 'switching view clears the selection')
})

test('VR-3 select: additive toggles, non-additive replaces, range is not required; clear(); selecting an unknown id is ignored', () => {
  let s = load(base())
  s = r(s, { type: 'select', nodeId: F(1) }); assert.deepEqual([...s.selection], [F(1)])
  s = r(s, { type: 'select', nodeId: D(1), additive: true }); assert.deepEqual([...s.selection], [F(1), D(1)])
  s = r(s, { type: 'select', nodeId: F(1), additive: true }); assert.deepEqual([...s.selection], [D(1)], 'additive toggles off')
  s = r(s, { type: 'select', nodeId: D(4) }); assert.deepEqual([...s.selection], [D(4)], 'non-additive replaces')
  s = r(s, { type: 'select', nodeId: ID(404), additive: true }); assert.deepEqual([...s.selection], [D(4)])
  s = r(s, { type: 'setSelection', nodeIds: [F(1), D(1), ID(404)] }); assert.deepEqual([...s.selection], [F(1), D(1)], 'bulk selection keeps only nodes in the loaded manifest')
  s = r(s, { type: 'clear' }); assert.equal(s.selection.size, 0)
})

test('VR-4 head refresh removes selected/current nodes → selection reconciled (dropped ids reported), current falls back to the nearest existing active ancestor or root; breadcrumbs recomputed', () => {
  let s = load(base())
  s = r(s, { type: 'open', nodeId: D(1) }); s = r(s, { type: 'open', nodeId: D(2) })
  s = r(s, { type: 'select', nodeId: F(2) }); s = r(s, { type: 'select', nodeId: F(3), additive: true })
  // another client purges sub (D2 + F2) and renames docs
  const next = advance(base(), intents.trash({ nodeIds: [D(2)] }), intents.purgeIntent({ nodeIds: [D(2)] }), intents.rename({ nodeId: D(1), name: 'documents' }))
  s = r(s, { type: 'head', head: headOf(next, 3) })
  assert.equal(s.current, D(1), 'nearest existing active ancestor')
  assert.deepEqual([...s.selection], [F(3)])
  assert.deepEqual(s.announcement, { kind: 'reconciled', droppedSelection: [F(2)], currentMovedTo: D(1) })
  assert.deepEqual(viewSelectors(s).breadcrumbs.map((n) => n.name), ['', 'documents'])
  // current folder trashed by someone → fall back to root; selection inside it dropped
  let u = load(base()); u = r(u, { type: 'open', nodeId: D(1) }); u = r(u, { type: 'select', nodeId: F(3) })
  u = r(u, { type: 'head', head: headOf(advance(base(), intents.trash({ nodeIds: [D(1)] })), 3) })
  assert.equal(u.current, ID(0)); assert.equal(u.selection.size, 0)
  // unchanged head → no announcement, same current/selection
  let v = load(base()); v = r(v, { type: 'select', nodeId: F(1) })
  v = r(v, { type: 'head', head: headOf(base(), 3) })
  assert.equal(v.announcement, null); assert.deepEqual([...v.selection], [F(1)])
})

test('VR-5 capabilities(selection): single file / single folder / multi / trash view / degraded key', () => {
  const s = load(base())
  const caps = (state) => viewSelectors(state).capabilities
  const single = r(s, { type: 'select', nodeId: F(1) })
  assert.deepEqual(caps(single), { preview: true, download: true, rename: true, move: true, details: true, trash: true, open: false, restore: false, permanentDelete: false, disabledReason: null })
  const textFile = r(r(s, { type: 'open', nodeId: D(1) }), { type: 'select', nodeId: F(3) })
  assert.equal(caps(textFile).preview, false, 'text/octet-stream is not previewable')
  const folder = r(s, { type: 'select', nodeId: D(1) })
  assert.deepEqual(caps(folder), { preview: false, download: false, rename: true, move: true, details: true, trash: true, open: true, restore: false, permanentDelete: false, disabledReason: null })
  const multi = r(r(s, { type: 'select', nodeId: F(1) }), { type: 'select', nodeId: D(1), additive: true })
  assert.deepEqual(caps(multi), { preview: false, download: true, rename: false, move: true, details: false, trash: true, open: false, restore: false, permanentDelete: false, disabledReason: null })
  assert.equal(caps(s).trash, false, 'empty selection has no mutation')
  const trashView = r(r(s, { type: 'view', view: 'trash' }), { type: 'select', nodeId: F(6) })
  assert.deepEqual(caps(trashView), { preview: false, download: false, rename: false, move: false, details: true, trash: false, open: false, restore: true, permanentDelete: true, disabledReason: null })
  const degraded = r(single, { type: 'keyStatus', keyStatus: 'DEGRADED', badSlot: 'primary' })
  assert.deepEqual(caps(degraded), { preview: true, download: true, rename: false, move: false, details: true, trash: false, open: false, restore: false, permanentDelete: false, disabledReason: 'KEY_DEGRADED' })
  assert.equal(viewSelectors(degraded).keyDegraded, true)
})

test('VR-6 run(intent): planRun validates against the live head before committing; a conflict result sets state.conflict; resolveConflict retry/discard/chooseDestination', async () => {
  let s = load(base())
  const commits = []
  const session = { commit: async (intent) => { commits.push(intent); return session.next(intent) }, next: () => ({ generation: 3, revisionId: ID(3, 'R'), manifest: base() }) }
  // a valid intent → committed; the reducer records pending → head
  const plan = planRun(s, intents.rename({ nodeId: F(1), name: 'b.mp4' }))
  assert.equal(plan.ok, true)
  s = r(s, { type: 'pending', intent: plan.intent })
  assert.deepEqual(s.pending?.type, 'rename')
  const res = await session.commit(plan.intent)
  s = r(s, { type: 'committed', result: res, head: headOf(res.manifest, 3) })
  assert.equal(s.pending, null); assert.equal(s.head.generation, 3)
  // an invalid intent never reaches the session
  const bad = planRun(s, intents.move({ nodeIds: [D(1)], destinationNodeId: D(2) }))
  assert.deepEqual({ ok: bad.ok, code: bad.error?.code }, { ok: false, code: 'CYCLE' }); assert.equal(commits.length, 1)
  // conflict from the session
  const conflict = { kind: 'CONFLICT', reason: 'DESTINATION_TRASHED' }
  session.next = () => ({ conflict, intent: intents.move({ nodeIds: [F(1)], destinationNodeId: D(4) }) })
  const p2 = planRun(s, intents.move({ nodeIds: [F(1)], destinationNodeId: D(4) }))
  s = r(s, { type: 'pending', intent: p2.intent })
  const res2 = await session.commit(p2.intent)
  s = r(s, { type: 'conflict', result: res2, head: headOf(advance(base(), intents.trash({ nodeIds: [D(4)] })), 4) })
  assert.deepEqual(s.conflict, { reason: 'DESTINATION_TRASHED', intent: res2.intent, choices: ['retry', 'discard', 'chooseDestination'] })
  assert.equal(s.pending, null)
  // resolve: discard → conflict cleared, nothing pending
  const discarded = r(s, { type: 'resolveConflict', choice: 'discard' })
  assert.equal(discarded.conflict, null); assert.equal(discarded.pending, null)
  // resolve: chooseDestination → a new move intent to the chosen folder is pending (same nodeIds, new operationId)
  const chosen = r(s, { type: 'resolveConflict', choice: 'chooseDestination', destinationNodeId: D(1) })
  assert.equal(chosen.conflict, null)
  assert.deepEqual({ type: chosen.pending.type, nodeIds: chosen.pending.nodeIds, destinationNodeId: chosen.pending.destinationNodeId }, { type: 'move', nodeIds: [F(1)], destinationNodeId: D(1) })
  assert.notEqual(chosen.pending.operationId, res2.intent.operationId)
  // resolve: retry → the same intent (same operationId) is pending again
  const retried = r(s, { type: 'resolveConflict', choice: 'retry' })
  assert.equal(retried.pending.operationId, res2.intent.operationId); assert.equal(retried.conflict, null)
  // a rename conflict cannot chooseDestination
  const rc = r(s, { type: 'conflict', result: { conflict: { kind: 'CONFLICT', reason: 'TARGET_RENAMED' }, intent: intents.rename({ nodeId: F(1), name: 'x' }) }, head: s.head })
  assert.deepEqual(rc.conflict.choices, ['retry', 'discard'])
  assert.equal(r(rc, { type: 'resolveConflict', choice: 'chooseDestination', destinationNodeId: D(1) }).conflict, rc.conflict, 'unsupported choice is ignored')
})

test('VR-7 drag: dragging a selected node drags the normalized selected set; dropping on self/descendant/file/trashed is rejected with an announcement and produces no intent', () => {
  let s = load(base())
  s = r(s, { type: 'select', nodeId: D(1) }); s = r(s, { type: 'select', nodeId: F(3), additive: true }); s = r(s, { type: 'select', nodeId: F(1), additive: true })
  s = r(s, { type: 'dragStart', nodeId: D(1) })
  assert.deepEqual(s.drag, { nodeIds: [D(1), F(1)], from: ID(0) }, 'F3 (inside D1) is normalized away')
  // dragging an unselected node drags only that node
  const solo = r(r(s, { type: 'dragEnd' }), { type: 'dragStart', nodeId: D(4) })
  assert.deepEqual(solo.drag, { nodeIds: [D(4)], from: ID(0) })
  for (const [target, reason] of [[D(1), 'CYCLE'], [D(2), 'CYCLE'], [F(3), 'NOT_FOLDER'], [F(6), 'NOT_FOLDER'], [D(5), 'EFFECTIVELY_TRASHED'], [ID(404), 'NOT_FOUND']]) {
    const drop = planDrop(s, target)
    assert.deepEqual({ ok: drop.ok, reason: drop.reason }, { ok: false, reason }, target)
    const after = r(s, { type: 'drop', destinationNodeId: target })
    assert.equal(after.pending, null); assert.deepEqual(after.announcement, { kind: 'rejected', reason, nodeId: target }); assert.equal(after.drag, null)
  }
  const ok = planDrop(s, D(4))
  assert.equal(ok.ok, true); assert.deepEqual({ type: ok.intent.type, nodeIds: ok.intent.nodeIds, destinationNodeId: ok.intent.destinationNodeId }, { type: 'move', nodeIds: [D(1), F(1)], destinationNodeId: D(4) })
  const dropped = r(s, { type: 'drop', destinationNodeId: D(4) })
  assert.equal(dropped.pending.type, 'move'); assert.equal(dropped.drag, null)
  // dropping into the folder the nodes already live in is a no-op, not a collision
  const same = planDrop(s, ID(0))
  assert.deepEqual({ ok: same.ok, reason: same.reason }, { ok: false, reason: 'NO_OP' })
})
