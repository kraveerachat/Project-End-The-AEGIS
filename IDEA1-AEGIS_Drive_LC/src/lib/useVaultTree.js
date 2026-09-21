// src/lib/useVaultTree.js — AEGIS Drive (IDEA1) · PR #157 Task 5.5 · the unlocked tree view: reducer, selectors, planners, hook
//
// "มุมมอง" ของต้นไม้ที่ถอดรหัสแล้ว (โฟลเดอร์ปัจจุบัน, active/trash, selection, drag, intent ที่ค้าง, conflict, สถานะกุญแจ)
// อยู่ในหน่วยความจำของ component เท่านั้น — reducer ล้วน (vaultTreeReducer) ทดสอบได้โดยไม่มี DOM; hook (useVaultTree)
// เป็นแค่กาวระหว่าง reducer กับ vaultTreeSync session และ unlockedState (disposer ทิ้ง state ทั้งหมดตอน purge)
//
// ── กติกา ────────────────────────────────────────────────────────────────────
//   • ทุก head ใหม่ (จาก commit ของเรา หรือ refresh) ผ่าน reconcile: selection ที่หายไปถูกตัด, current ที่หาย/ถูกทิ้ง
//     ถอยไปบรรพบุรุษ active ที่ใกล้ที่สุด (หรือ root) และมี announcement ให้ UI ประกาศ (VR-4) — ไม่มี UI ที่ชี้ไปโหนดผี
//   • intent ถูก "วางแผน" กับ head ปัจจุบันก่อนส่ง (planRun/planDrop): ใช้ applyIntent บน clone — ผิดกฎ = ไม่ยิงเน็ตเวิร์ก
//   • conflict จาก session ไม่ถูกแก้เอง: state.conflict + choices (retry / discard / chooseDestination เฉพาะ move/restore)
//     ผู้ใช้ตัดสินเสมอ (design §10: no silent last-write-wins)
//   • กุญแจ DEGRADED = ทุก mutation ปิดด้วย reason KEY_DEGRADED; อ่าน/ดาวน์โหลด/preview ยังได้
//   • ไม่มี storage ใด; ชื่อ/parent/node id ไม่ออกจากไฟล์นี้ไปที่ใดนอกจาก session.commit (ซึ่งเข้ารหัสก่อนส่ง)

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { effectiveState, ancestorsOf, breadcrumbsFor, childrenOf, isDescendant } from './vaultTreeManifest.js'
import { intents, applyIntent, normalizeSelectionRoots, OpError, newOpaqueId } from './vaultTreeOps.js'
import { previewKindFor } from './vaultPreview.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

export const CONFLICT_CHOICES = Object.freeze({ retry: 'retry', discard: 'discard', chooseDestination: 'chooseDestination' })
const DESTINATION_INTENTS = new Set(['move', 'restore'])

export function initialTreeViewState() {
  return { head: null, current: null, view: 'active', selection: new Set(), drag: null, pending: null, conflict: null, keyStatus: 'HEALTHY', keyBadSlot: null, announcement: null }
}

const has = (head, id) => Boolean(head?.index?.nodes?.has(id))
const active = (head, id) => has(head, id) && effectiveState(head.index, id) === 'active'

/** ตำแหน่งที่ยังมีอยู่และ active ใกล้ที่สุดของ id เดิม บน head ใหม่ (id เอง → บรรพบุรุษเดิมทีละชั้น → root) */
function nearestActive(oldHead, newHead, id) {
  if (active(newHead, id)) return id
  const chain = oldHead && has(oldHead, id) ? ancestorsOf(oldHead.index, id) : []
  for (const a of chain) if (active(newHead, a)) return a
  return newHead.manifest.rootNodeId
}

/** head ใหม่ → state ที่สอดคล้อง (VR-4) */
function reconcile(state, head) {
  const droppedSelection = []
  const selection = new Set()
  for (const id of state.selection) {
    const ok = has(head, id) && (state.view === 'trash' ? effectiveState(head.index, id) !== 'active' : active(head, id))
    if (ok) selection.add(id); else droppedSelection.push(id)
  }
  const current = state.current === null ? head.manifest.rootNodeId : nearestActive(state.head, head, state.current)
  const moved = state.current !== null && current !== state.current
  const announcement = state.head && (droppedSelection.length || moved) ? { kind: 'reconciled', droppedSelection, currentMovedTo: moved ? current : null } : null
  return { ...state, head, current, selection, drag: null, announcement }
}

const reject = (state, reason, nodeId) => ({ ...state, drag: null, announcement: { kind: 'rejected', reason, nodeId } })

export function vaultTreeReducer(state, action) {
  switch (action.type) {
    case 'head': return reconcile(state, action.head)
    case 'keyStatus': return { ...state, keyStatus: action.keyStatus, keyBadSlot: action.badSlot ?? null }
    case 'view': return action.view === state.view ? state : { ...state, view: action.view, selection: new Set(), drag: null }
    case 'open': {
      if (!state.head) return state
      const n = state.head.index.nodes.get(action.nodeId)
      if (!n || n.kind !== 'folder') return state
      if (effectiveState(state.head.index, action.nodeId) !== 'active') return reject(state, 'EFFECTIVELY_TRASHED', action.nodeId)
      return { ...state, current: action.nodeId, selection: new Set(), drag: null, announcement: null }
    }
    case 'up': {
      if (!state.head || state.current === state.head.manifest.rootNodeId) return state
      const n = state.head.index.nodes.get(state.current)
      return { ...state, current: n?.parentNodeId ?? state.head.manifest.rootNodeId, selection: new Set(), drag: null }
    }
    case 'select': {
      if (!has(state.head, action.nodeId)) return state
      const selection = new Set(action.additive ? state.selection : [])
      if (action.additive && selection.has(action.nodeId)) selection.delete(action.nodeId); else selection.add(action.nodeId)
      return { ...state, selection }
    }
    case 'setSelection': {
      if (!state.head) return state
      const selection = new Set()
      for (const id of action.nodeIds ?? []) {
        const allowed = has(state.head, id) && (state.view === 'trash' ? effectiveState(state.head.index, id) !== 'active' : active(state.head, id))
        if (allowed) selection.add(id)
      }
      return { ...state, selection }
    }
    case 'clear': return state.selection.size ? { ...state, selection: new Set() } : state
    case 'pending': return { ...state, pending: action.intent, announcement: null }
    case 'committed': return { ...reconcile(state, action.head), pending: null, conflict: null }
    case 'conflict': {
      const c = action.result?.conflict
      const intent = action.result?.intent ?? state.pending
      const choices = [CONFLICT_CHOICES.retry, CONFLICT_CHOICES.discard, ...(DESTINATION_INTENTS.has(intent?.type) ? [CONFLICT_CHOICES.chooseDestination] : [])]
      const next = action.head ? reconcile(state, action.head) : state
      return { ...next, pending: null, conflict: { reason: c?.reason ?? 'CONFLICT', intent, choices } }
    }
    case 'failed': return { ...state, pending: null, announcement: { kind: 'failed', code: action.code ?? 'FAILED' } }
    case 'resolveConflict': {
      const c = state.conflict
      if (!c || !c.choices.includes(action.choice)) return state
      if (action.choice === CONFLICT_CHOICES.discard) return { ...state, conflict: null, pending: null }
      if (action.choice === CONFLICT_CHOICES.retry) return { ...state, conflict: null, pending: c.intent }
      // chooseDestination: intent ใหม่ (operationId ใหม่ — เป็นความตั้งใจใหม่ของผู้ใช้) ไปยังโฟลเดอร์ที่เลือก
      const dest = action.destinationNodeId
      const replacement = c.intent.type === 'move'
        ? intents.move({ nodeIds: c.intent.nodeIds, destinationNodeId: dest })
        : intents.restore({ nodeId: c.intent.nodeId, destinationNodeId: dest })
      return { ...state, conflict: null, pending: replacement }
    }
    case 'dragStart': {
      if (!state.head || !has(state.head, action.nodeId)) return state
      const set = state.selection.has(action.nodeId) ? [...state.selection] : [action.nodeId]
      let nodeIds
      try { nodeIds = normalizeSelectionRoots(state.head.index, set) } catch (e) { return reject(state, e.code ?? 'INVALID', action.nodeId) }
      return { ...state, drag: { nodeIds, from: state.current } }
    }
    case 'dragEnd': return state.drag ? { ...state, drag: null } : state
    case 'drop': {
      const plan = planDrop(state, action.destinationNodeId)
      if (!plan.ok) return plan.reason === 'NO_OP' ? { ...state, drag: null } : reject(state, plan.reason, action.destinationNodeId)
      return { ...state, drag: null, pending: plan.intent, announcement: null }
    }
    case 'announce': return { ...state, announcement: action.announcement ?? null }
    case 'reset': return initialTreeViewState()
    default: return state
  }
}

/** ตรวจ intent กับ head ปัจจุบันบน clone — ok:false ไม่ยิงเน็ตเวิร์ก */
export function planRun(state, intent, { limits = VAULT_TREE_CLIENT_LIMITS } = {}) {
  if (!state.head) return { ok: false, error: { code: 'NOT_LOADED' } }
  if (state.keyStatus === 'DEGRADED') return { ok: false, error: { code: 'KEY_DEGRADED' } }
  try {
    applyIntent(state.head.manifest, intent, { limits })
    return { ok: true, intent }
  } catch (e) {
    return { ok: false, error: { code: e instanceof OpError ? e.code : 'INVALID', detail: e.message } }
  }
}

/** drop ปัจจุบันลงโฟลเดอร์ปลายทาง → move intent หรือเหตุผลที่ปฏิเสธ (ไม่แตะ state) */
export function planDrop(state, destinationNodeId, { limits = VAULT_TREE_CLIENT_LIMITS } = {}) {
  if (!state.head || !state.drag) return { ok: false, reason: 'NO_DRAG' }
  const index = state.head.index
  const dest = index.nodes.get(destinationNodeId)
  if (!dest) return { ok: false, reason: 'NOT_FOUND' }
  if (dest.kind !== 'folder') return { ok: false, reason: 'NOT_FOLDER' }
  if (effectiveState(index, destinationNodeId) !== 'active') return { ok: false, reason: 'EFFECTIVELY_TRASHED' }
  for (const id of state.drag.nodeIds) if (id === destinationNodeId || isDescendant(index, destinationNodeId, id)) return { ok: false, reason: 'CYCLE' }
  if (state.drag.nodeIds.every((id) => index.nodes.get(id)?.parentNodeId === destinationNodeId)) return { ok: false, reason: 'NO_OP' }
  const intent = intents.move({ nodeIds: state.drag.nodeIds, destinationNodeId })
  const plan = planRun({ ...state, keyStatus: 'HEALTHY' }, intent, { limits })
  if (!plan.ok) return { ok: false, reason: plan.error.code }
  if (state.keyStatus === 'DEGRADED') return { ok: false, reason: 'KEY_DEGRADED' }
  return { ok: true, intent }
}

const NONE = Object.freeze({ preview: false, download: false, rename: false, move: false, details: false, trash: false, open: false, restore: false, permanentDelete: false, disabledReason: null })

/** ค่าที่ UI ต้องการจาก state: breadcrumbs, children ตามมุมมอง, capabilities ของ selection (VR-5) */
export function viewSelectors(state) {
  const head = state.head
  if (!head) return { breadcrumbs: [], children: [], capabilities: NONE, keyDegraded: state.keyStatus === 'DEGRADED', selected: [] }
  const index = head.index
  const breadcrumbs = state.view === 'active' && has(head, state.current) ? breadcrumbsFor(index, state.current) : [index.nodes.get(head.manifest.rootNodeId)]
  const children = state.view === 'trash' ? childrenOf(index, null, { view: 'trash' }) : childrenOf(index, state.current, { view: 'active' })
  const selected = [...state.selection].filter((id) => has(head, id)).map((id) => index.nodes.get(id))
  const degraded = state.keyStatus === 'DEGRADED'
  let caps = NONE
  if (selected.length === 1) {
    const n = selected[0]
    const isFile = n.kind === 'file'
    if (state.view === 'trash') caps = { ...NONE, details: true, restore: !degraded, permanentDelete: !degraded }
    else caps = { ...NONE, preview: isFile && previewKindFor(n.mediaType) !== null, download: isFile, rename: !degraded, move: !degraded, details: true, trash: !degraded, open: !isFile }
  } else if (selected.length > 1) {
    if (state.view === 'trash') caps = { ...NONE, restore: !degraded, permanentDelete: !degraded }
    else caps = { ...NONE, download: selected.some((n) => n.kind === 'file'), move: !degraded, trash: !degraded }
  }
  if (degraded && selected.length) caps = { ...caps, disabledReason: 'KEY_DEGRADED' }
  return { breadcrumbs, children, capabilities: caps, keyDegraded: degraded, selected }
}

/**
 * hook: ผูก reducer เข้ากับ session (vaultTreeSync) และ unlockedState — run(intent) = plan → pending → session.commit →
 * committed | conflict | failed; ทุก dispatch หลัง purge ถูกละเลย (state ถูก reset โดย disposer)
 */
export function useVaultTree({ session, unlockedState = null, limits = VAULT_TREE_CLIENT_LIMITS }) {
  const [state, dispatch] = useReducer(vaultTreeReducer, undefined, initialTreeViewState)
  const alive = useRef(true)
  const sessionRef = useRef(session); sessionRef.current = session
  const safeDispatch = useCallback((a) => { if (alive.current && !(unlockedState?.isPurged?.())) dispatch(a) }, [unlockedState])

  useEffect(() => {
    alive.current = true
    let off = null
    try { off = unlockedState?.registerDisposer?.(() => { alive.current = false; dispatch({ type: 'reset' }) }) ?? null } catch { alive.current = false }
    return () => { alive.current = false; void off }
  }, [unlockedState])

  useEffect(() => {
    const s = sessionRef.current
    if (!s?.head) return
    safeDispatch({ type: 'head', head: s.head })
    safeDispatch({ type: 'keyStatus', keyStatus: s.keyStatus ?? 'HEALTHY', badSlot: s.keyBadSlot ?? null })
  }, [session, safeDispatch])

  const run = useCallback(async (intent) => {
    const plan = planRun(state, intent, { limits })
    if (!plan.ok) { safeDispatch({ type: 'announce', announcement: { kind: 'rejected', reason: plan.error.code, nodeId: null } }); return plan }
    safeDispatch({ type: 'pending', intent: plan.intent })
    const s = sessionRef.current
    try {
      const res = await s.commit(plan.intent)
      if (res?.conflict) safeDispatch({ type: 'conflict', result: res, head: s.head })
      else safeDispatch({ type: 'committed', result: res, head: s.head })
      return res
    } catch (e) {
      safeDispatch({ type: 'failed', code: e?.code ?? 'FAILED' })
      throw e
    }
  }, [state, limits, safeDispatch])

  const selectors = useMemo(() => viewSelectors(state), [state])
  return {
    state, ...selectors,
    view: state.view, current: state.current, selection: state.selection, conflict: state.conflict, pending: state.pending, drag: state.drag, announcement: state.announcement,
    select: (nodeId, { additive = false } = {}) => safeDispatch({ type: 'select', nodeId, additive }),
    setSelection: (nodeIds) => safeDispatch({ type: 'setSelection', nodeIds: [...(nodeIds ?? [])] }),
    clear: () => safeDispatch({ type: 'clear' }),
    open: (nodeId) => safeDispatch({ type: 'open', nodeId }),
    up: () => safeDispatch({ type: 'up' }),
    setView: (view) => safeDispatch({ type: 'view', view }),
    dragStart: (nodeId) => safeDispatch({ type: 'dragStart', nodeId }),
    dragEnd: () => safeDispatch({ type: 'dragEnd' }),
    drop: (destinationNodeId) => safeDispatch({ type: 'drop', destinationNodeId }),
    resolveConflict: (choice, extra = {}) => safeDispatch({ type: 'resolveConflict', choice, ...extra }),
    refreshHead: (head) => safeDispatch({ type: 'head', head }),
    setKeyStatus: (keyStatus, badSlot = null) => safeDispatch({ type: 'keyStatus', keyStatus, badSlot }),
    run,
    capabilities: () => selectors.capabilities,
    newNodeId: newOpaqueId,
  }
}
