// src/lib/vaultTreeRebase.js — AEGIS Drive (IDEA1) · PR #157 Task 5.2 · bounded semantic rebase of one intent onto a newer head
//
// เมื่อ CAS แพ้ (head ขยับไปแล้ว) client ต้องตัดสินว่า intent ที่คิดไว้กับ base "ยังหมายความอย่างเดิม" บน head หรือไม่:
//   AUTO            ใช้ต่อได้กับ head (intent เดิม หรือฉบับตัดแต่ง เช่น trash เฉพาะโหนดที่ยังไม่ถูกทิ้ง)
//   CONFLICT        ผู้ใช้ต้องตัดสิน — เหตุผลระบุชัด ไม่มี last-write-wins โดยเงียบ (design §10)
//   ALREADY_APPLIED operationId ของ intent อยู่ใน head.recentOperationIds แล้ว (response หายหลังเซิร์ฟเวอร์ apply)
//                   หรือผลลัพธ์ที่ต้องการเกิดขึ้นบน head แล้ว (โหนดถูกทิ้ง/ลบ/กู้/แนบไปแล้ว)
//
// ⚠️ deterministic และ pure: input (intent, index, manifest) ไม่ถูกแตะ; ไม่มี I/O; เซิร์ฟเวอร์ต้องไม่ import (SRV-NOIMPORT-1)
// ⚠️ นี่คือการตัดสิน "ความหมาย" เท่านั้น — การตรวจกฎครบถ้วนเกิดตอน applyIntent บน head อีกครั้งเสมอ

import { effectiveState, isDescendant, activeSiblingCollision, collisionKey } from './vaultTreeManifest.js'

export const REBASE_REASONS = Object.freeze([
  'TARGET_DELETED', 'TARGET_RENAMED', 'TARGET_RESTORED', 'DESTINATION_DELETED', 'DESTINATION_TRASHED',
  'COLLISION', 'CYCLE_AFTER_REBASE', 'PARENT_CHANGED', 'RESTORE_COLLISION', 'UNSUPPORTED_INTENT',
])

const AUTO = (intent) => ({ kind: 'AUTO', intent })
const CONFLICT = (reason) => ({ kind: 'CONFLICT', reason })
const ALREADY_APPLIED = () => ({ kind: 'ALREADY_APPLIED' })

const node = (index, id) => index.nodes.get(id) ?? null
const gone = (index, id) => !index.nodes.has(id)
const trashed = (index, id) => effectiveState(index, id) !== 'active'

/** ปลายทาง (โฟลเดอร์ที่จะรับโหนดใหม่/ที่ย้ายมา) ยังใช้ได้ไหม → null หรือเหตุผล */
function destinationProblem(headIndex, destId) {
  const d = node(headIndex, destId)
  if (!d || d.kind !== 'folder') return 'DESTINATION_DELETED'
  if (trashed(headIndex, destId)) return 'DESTINATION_TRASHED'
  return null
}

const REBASERS = {
  createFolder(intent, { headIndex }) {
    const problem = destinationProblem(headIndex, intent.parentNodeId)
    if (problem) return CONFLICT(problem)
    if (activeSiblingCollision(headIndex, intent.parentNodeId, intent.name)) return CONFLICT('COLLISION')
    return AUTO(intent)
  },

  rename(intent, { baseIndex, headIndex }) {
    const h = node(headIndex, intent.nodeId)
    if (!h || trashed(headIndex, intent.nodeId)) return CONFLICT('TARGET_DELETED')
    const b = node(baseIndex, intent.nodeId)
    if (b && h.name !== b.name) return CONFLICT('TARGET_RENAMED')
    if (activeSiblingCollision(headIndex, h.parentNodeId, intent.name, intent.nodeId)) return CONFLICT('COLLISION')
    return AUTO(intent)
  },

  move(intent, { headIndex }) {
    const problem = destinationProblem(headIndex, intent.destinationNodeId)
    if (problem) return CONFLICT(problem)
    const incoming = new Set()
    for (const id of intent.nodeIds) {
      if (gone(headIndex, id) || trashed(headIndex, id)) return CONFLICT('TARGET_DELETED')
      if (id === intent.destinationNodeId || isDescendant(headIndex, intent.destinationNodeId, id)) return CONFLICT('CYCLE_AFTER_REBASE')
    }
    for (const id of intent.nodeIds) {
      const n = node(headIndex, id)
      if (activeSiblingCollision(headIndex, intent.destinationNodeId, n.name, id)) return CONFLICT('COLLISION')
      const key = collisionKey(n.name)
      if (incoming.has(key)) return CONFLICT('COLLISION')
      incoming.add(key)
    }
    return AUTO(intent)
  },

  trash(intent, { headIndex }) {
    for (const id of intent.nodeIds) if (gone(headIndex, id)) return CONFLICT('TARGET_DELETED')
    const remaining = intent.nodeIds.filter((id) => !trashed(headIndex, id))
    if (remaining.length === 0) return ALREADY_APPLIED()
    return remaining.length === intent.nodeIds.length ? AUTO(intent) : AUTO({ ...intent, nodeIds: remaining })
  },

  restore(intent, { headIndex }) {
    const h = node(headIndex, intent.nodeId)
    if (!h) return CONFLICT('TARGET_DELETED')
    if (h.lifecycle.state !== 'trashed') return trashed(headIndex, intent.nodeId) ? CONFLICT('TARGET_DELETED') : ALREADY_APPLIED()
    const explicit = intent.destinationNodeId !== null && intent.destinationNodeId !== undefined
    const destId = explicit ? intent.destinationNodeId : h.lifecycle.trashedFromParentNodeId
    const problem = destinationProblem(headIndex, destId)
    if (problem) return CONFLICT(problem)
    if (destId === intent.nodeId || isDescendant(headIndex, destId, intent.nodeId)) return CONFLICT('CYCLE_AFTER_REBASE')
    if (activeSiblingCollision(headIndex, destId, h.name, intent.nodeId)) return CONFLICT('RESTORE_COLLISION')
    return AUTO(intent)
  },

  attachBlob(intent, { headIndex }) {
    const ref = intent.blobRef
    for (const n of headIndex.nodes.values()) {
      if (n.blobRef && n.blobRef.formatVersion === ref.formatVersion && n.blobRef.id === ref.id) return ALREADY_APPLIED()
    }
    const p = node(headIndex, intent.parentNodeId)
    if (!p || p.kind !== 'folder' || trashed(headIndex, intent.parentNodeId)) return CONFLICT('PARENT_CHANGED')
    if (activeSiblingCollision(headIndex, intent.parentNodeId, intent.name)) return CONFLICT('COLLISION')
    return AUTO(intent)
  },

  purge(intent, { headIndex }) {
    const remaining = []
    for (const id of intent.nodeIds) {
      if (gone(headIndex, id)) continue
      if (!trashed(headIndex, id)) return CONFLICT('TARGET_RESTORED')
      remaining.push(id)
    }
    if (remaining.length === 0) return ALREADY_APPLIED()
    return remaining.length === intent.nodeIds.length ? AUTO(intent) : AUTO({ ...intent, nodeIds: remaining })
  },
}

/**
 * @param {object} intent intent ที่สร้างกับ base (จาก vaultTreeOps.intents)
 * @param {{ baseIndex: object, headIndex: object, headRecentOperationIds?: string[] }} ctx
 * @returns {{ kind: 'AUTO', intent } | { kind: 'CONFLICT', reason } | { kind: 'ALREADY_APPLIED' }}
 */
export function rebaseIntent(intent, { baseIndex, headIndex, headRecentOperationIds = [] }) {
  if (intent?.operationId && headRecentOperationIds.includes(intent.operationId)) return ALREADY_APPLIED()
  const fn = intent && REBASERS[intent.type]
  if (!fn) return CONFLICT('UNSUPPORTED_INTENT')
  return fn(intent, { baseIndex, headIndex })
}
