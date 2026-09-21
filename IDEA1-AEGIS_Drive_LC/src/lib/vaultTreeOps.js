// src/lib/vaultTreeOps.js — AEGIS Drive (IDEA1) · PR #157 Task 5.1 · semantic intents on the encrypted hierarchy
//
// ทุก "ความหมาย" ของโฟลเดอร์ (สร้าง/เปลี่ยนชื่อ/ย้าย/ทิ้ง/กู้/แนบ blob/ลบถาวร) ถูกคำนวณที่นี่ บน manifest ที่ถอดรหัส
// แล้วในหน่วยความจำของ client เท่านั้น — เซิร์ฟเวอร์ไม่เคยเห็น parent, ชื่อ, node id, ปลายทางของการย้าย หรือ
// subtree (design §6, §9) สิ่งเดียวที่ออกจากไฟล์นี้ไปถึงเซิร์ฟเวอร์ (ผ่าน vaultTreeSync) คือ attachBlobRefs/
// purgeBlobRefs ซึ่งเป็น id ทึบของ blob ที่เซิร์ฟเวอร์รู้จักอยู่แล้ว
//
// ── กติกาที่ไม่มีข้อยกเว้น ─────────────────────────────────────────────────────
//   1. apply บน structured clone; input ไม่ถูกแตะ; ล้มเหลว = โยน OpError และ clone ถูกทิ้ง (ไม่มี partial apply)
//   2. ตรวจเงื่อนไขที่มีความหมาย (root/parent/cycle/collision/trashed/limits) "ก่อน" แก้ แล้ว validateManifest
//      ซ้ำทั้งใบหลังแก้เป็นตาข่ายนิรภัย — ผลลัพธ์ที่ออกจากที่นี่คือ manifest ที่ผ่านกฎทุกข้อแล้วเสมอ
//   3. intent แบบหลายโหนด (move/trash/purge) ถูก normalize ให้เหลือ "ราก" ของการเลือกก่อน (ลูกหลานของรากที่เลือก
//      ถูกดึงออก) และถูกปฏิเสธทั้งใบถ้าเงื่อนไขใดล้ม — ไม่มี "ย้ายได้บางส่วน"
//   4. ทิ้ง (trash) แตะเฉพาะรากของ subtree (O(1) ต่อราก): ลูกหลาน "มีผล" ว่าถูกทิ้งผ่าน effectiveState โดยไม่ถูกเขียน
//      กู้ (restore) จึงคืนเฉพาะโหนดที่ไม่มีสถานะทิ้งของตัวเอง — ลูกหลานที่ถูกทิ้งแยกต่างหากยังอยู่ในถัง (OPP-4)
//   5. ทุก apply ที่สำเร็จต่อท้าย operationId ของ intent ใน recentOperationIds (ตัดของเก่าเมื่อเกิน limit) เพื่อให้
//      rebase ตรวจ "ถูกใช้ไปแล้ว" ได้ (RB-7) หลัง response หายกลางทาง
//
// ⚠️ ไม่มี I/O ไม่มี crypto ไม่มี React — pure functions; เซิร์ฟเวอร์ต้อง "ไม่" import ไฟล์นี้ (SRV-NOIMPORT-1)

import { validateManifest, effectiveState, ancestorsOf, isDescendant, activeSiblingCollision, nameProblem, collisionKey } from './vaultTreeManifest.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

export class OpError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'OpError'
    this.code = code
    this.detail = detail
  }
}
/** รหัสของ OpError — ตามแผน + BLOB_ALREADY_REFERENCED (OP-7), NOT_TRASHED (restore/purge ของโหนดที่ไม่อยู่ในถัง), INVALID_INTENT (รูปทรง intent ผิด) */
export const OP_ERROR = Object.freeze([
  'ROOT_IMMUTABLE', 'NOT_FOUND', 'NOT_FOLDER', 'CYCLE', 'COLLISION', 'EFFECTIVELY_TRASHED', 'AMBIGUOUS_SELECTION',
  'NAME_INVALID', 'LIMIT_NODES', 'LIMIT_DEPTH', 'LIMIT_NAME_BYTES', 'BLOB_ALREADY_REFERENCED', 'NOT_TRASHED', 'INVALID_INTENT',
])
const fail = (code, detail) => { throw new OpError(code, detail) }

export const INTENT_TYPES = Object.freeze(['createFolder', 'rename', 'move', 'trash', 'restore', 'attachBlob', 'purge'])

const ID_RE = /^[A-Za-z0-9_-]{22}$/
const isId = (v) => typeof v === 'string' && ID_RE.test(v)

/** id สุ่ม 16 ไบต์ base64url (22 ตัวอักษร) — รูปแบบเดียวกับ nodeId/revisionId ของโปรโตคอล */
export function newOpaqueId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : fail('INVALID_INTENT', 'nodeIds'))

/** โรงงาน intent — ทุกใบมี operationId ของตัวเอง (สุ่ม) เพื่อ idempotency ข้าม response loss */
export const intents = Object.freeze({
  createFolder: ({ parentNodeId, name, operationId = newOpaqueId() }) => ({ type: 'createFolder', operationId, parentNodeId, name }),
  rename: ({ nodeId, name, operationId = newOpaqueId() }) => ({ type: 'rename', operationId, nodeId, name }),
  move: ({ nodeIds, destinationNodeId, operationId = newOpaqueId() }) => ({ type: 'move', operationId, nodeIds: idList(nodeIds), destinationNodeId }),
  trash: ({ nodeIds, operationId = newOpaqueId() }) => ({ type: 'trash', operationId, nodeIds: idList(nodeIds) }),
  restore: ({ nodeId, destinationNodeId = null, operationId = newOpaqueId() }) => ({ type: 'restore', operationId, nodeId, destinationNodeId }),
  attachBlob: ({ parentNodeId, name, mediaType = '', plainSize, blobRef, operationId = newOpaqueId() }) => ({
    type: 'attachBlob', operationId, parentNodeId, name, mediaType, plainSize,
    blobRef: blobRef && typeof blobRef === 'object' ? { formatVersion: blobRef.formatVersion, id: String(blobRef.id) } : blobRef,
  }),
  purgeIntent: ({ nodeIds, operationId = newOpaqueId() }) => ({ type: 'purge', operationId, nodeIds: idList(nodeIds) }),
})

// ── selection ────────────────────────────────────────────────────────────────

/**
 * รากของการเลือก: ตัด id ที่เป็นลูกหลานของ id อื่นที่ถูกเลือกด้วย (คงลำดับเดิม, ไม่ซ้ำ)
 * การเลือกที่ปน active กับ trashed (ตามสถานะที่มีผลจริง) → AMBIGUOUS_SELECTION; id ที่ไม่มี → NOT_FOUND
 */
export function normalizeSelectionRoots(index, nodeIds) {
  const ids = idList(nodeIds)
  if (ids.length === 0) return []
  for (const id of ids) if (!index.nodes.has(id)) fail('NOT_FOUND', id)
  const trashed = ids.map((id) => effectiveState(index, id) !== 'active')
  if (trashed.some(Boolean) && !trashed.every(Boolean)) fail('AMBIGUOUS_SELECTION')
  const set = new Set(ids)
  return ids.filter((id) => !ancestorsOf(index, id).some((a) => set.has(a)))
}

// ── helpers on the working clone ─────────────────────────────────────────────

const getNode = (m, id) => (isId(id) && m.nodes.get(id)) || fail('NOT_FOUND', typeof id === 'string' ? undefined : 'nodeId')
const requireFolder = (n) => (n.kind === 'folder' ? n : fail('NOT_FOLDER'))
const requireActive = (index, id) => (effectiveState(index, id) === 'active' ? id : fail('EFFECTIVELY_TRASHED'))
const checkName = (name, limits) => { const p = nameProblem(name, limits); if (p) fail(p === 'LIMIT_NAME_BYTES' ? 'LIMIT_NAME_BYTES' : 'NAME_INVALID') }
const checkCollision = (index, parentId, name, except = null) => { if (activeSiblingCollision(index, parentId, name, except)) fail('COLLISION') }

/** ความสูงของ subtree (0 = ใบ) — iterative */
function subtreeHeight(index, rootId) {
  let height = 0
  const stack = [[rootId, 0]]
  while (stack.length) {
    const [id, d] = stack.pop()
    if (d > height) height = d
    for (const c of index.childrenOf.get(id) ?? []) stack.push([c, d + 1])
  }
  return height
}
/** ทุกโหนดใน subtree รวมราก — iterative */
function subtreeIds(index, rootId) {
  const out = []
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop(); out.push(id)
    for (const c of index.childrenOf.get(id) ?? []) stack.push(c)
  }
  return out
}
const checkDepth = (index, parentId, extra, limits) => { if (index.depthOf.get(parentId) + 1 + extra > limits.maxDepth) fail('LIMIT_DEPTH') }
const checkNodeBudget = (m, added, limits) => { if (m.nodes.size + added > limits.maxNodes) fail('LIMIT_NODES') }

// ── the operations ───────────────────────────────────────────────────────────

function opCreateFolder(m, index, it, ctx) {
  const parent = requireFolder(getNode(m, it.parentNodeId))
  requireActive(index, parent.nodeId)
  checkName(it.name, ctx.limits)
  checkCollision(index, parent.nodeId, it.name)
  checkNodeBudget(m, 1, ctx.limits)
  checkDepth(index, parent.nodeId, 0, ctx.limits)
  const nodeId = ctx.newNodeId()
  if (!isId(nodeId) || m.nodes.has(nodeId)) fail('INVALID_INTENT', 'newNodeId')
  m.nodes.set(nodeId, { nodeId, kind: 'folder', parentNodeId: parent.nodeId, name: it.name, createdAtClient: ctx.now, modifiedAtClient: ctx.now, lifecycle: { state: 'active' } })
  return { changedNodeIds: [nodeId] }
}

function opRename(m, index, it, ctx) {
  const n = getNode(m, it.nodeId)
  if (n.nodeId === m.rootNodeId) fail('ROOT_IMMUTABLE')
  requireActive(index, n.nodeId)
  checkName(it.name, ctx.limits)
  checkCollision(index, n.parentNodeId, it.name, n.nodeId)
  n.name = it.name
  n.modifiedAtClient = ctx.now
  return { changedNodeIds: [n.nodeId] }
}

function opMove(m, index, it, ctx) {
  const dest = requireFolder(getNode(m, it.destinationNodeId))
  requireActive(index, dest.nodeId)
  const roots = normalizeSelectionRoots(index, it.nodeIds)
  if (roots.length === 0) fail('INVALID_INTENT', 'nodeIds')
  const incoming = new Set()
  for (const id of roots) {
    const n = getNode(m, id)
    if (id === m.rootNodeId) fail('ROOT_IMMUTABLE')
    requireActive(index, id)
    if (id === dest.nodeId || isDescendant(index, dest.nodeId, id)) fail('CYCLE')
    checkCollision(index, dest.nodeId, n.name, id)
    const key = collisionKey(n.name)
    if (incoming.has(key)) fail('COLLISION')
    incoming.add(key)
    checkDepth(index, dest.nodeId, subtreeHeight(index, id), ctx.limits)
  }
  for (const id of roots) {
    const n = m.nodes.get(id)
    n.parentNodeId = dest.nodeId
    n.modifiedAtClient = ctx.now
  }
  return { changedNodeIds: roots }
}

function opTrash(m, index, it, ctx) {
  const roots = normalizeSelectionRoots(index, it.nodeIds)
  if (roots.length === 0) fail('INVALID_INTENT', 'nodeIds')
  for (const id of roots) {
    if (id === m.rootNodeId) fail('ROOT_IMMUTABLE')
    requireActive(index, id)
  }
  for (const id of roots) {
    const n = m.nodes.get(id)
    n.lifecycle = { state: 'trashed', trashedAtClient: ctx.now, trashedFromParentNodeId: n.parentNodeId }
    n.modifiedAtClient = ctx.now
  }
  return { changedNodeIds: roots }
}

function opRestore(m, index, it, ctx) {
  const n = getNode(m, it.nodeId)
  if (n.nodeId === m.rootNodeId) fail('ROOT_IMMUTABLE')
  if (n.lifecycle.state !== 'trashed') {
    // ทิ้งผ่านบรรพบุรุษ = ต้องกู้บรรพบุรุษ; ไม่ได้อยู่ในถังเลย = ไม่มีอะไรให้กู้
    fail(effectiveState(index, n.nodeId) === 'active' ? 'NOT_TRASHED' : 'EFFECTIVELY_TRASHED')
  }
  const explicit = it.destinationNodeId !== null && it.destinationNodeId !== undefined
  const destId = explicit ? it.destinationNodeId : n.lifecycle.trashedFromParentNodeId
  const dest = requireFolder(getNode(m, destId))
  // cycle ก่อนสถานะปลายทาง: ปลายทางที่อยู่ใต้ตัวเองย่อม "ถูกทิ้งผ่านตัวเอง" อยู่แล้ว — CYCLE คือเหตุผลที่แท้จริง
  if (dest.nodeId === n.nodeId || isDescendant(index, dest.nodeId, n.nodeId)) fail('CYCLE')
  requireActive(index, dest.nodeId)
  checkCollision(index, dest.nodeId, n.name, n.nodeId)
  checkDepth(index, dest.nodeId, subtreeHeight(index, n.nodeId), ctx.limits)
  n.lifecycle = { state: 'active' }
  n.parentNodeId = dest.nodeId
  n.modifiedAtClient = ctx.now
  return { changedNodeIds: [n.nodeId] }
}

function opAttachBlob(m, index, it, ctx) {
  const parent = requireFolder(getNode(m, it.parentNodeId))
  requireActive(index, parent.nodeId)
  checkName(it.name, ctx.limits)
  const ref = it.blobRef
  if (!ref || typeof ref !== 'object' || ![1, 2].includes(ref.formatVersion) || typeof ref.id !== 'string' || ref.id.length === 0) fail('INVALID_INTENT', 'blobRef')
  if (!Number.isSafeInteger(it.plainSize) || it.plainSize < 0) fail('INVALID_INTENT', 'plainSize')
  if (typeof it.mediaType !== 'string') fail('INVALID_INTENT', 'mediaType')
  for (const n of m.nodes.values()) if (n.blobRef && n.blobRef.formatVersion === ref.formatVersion && n.blobRef.id === ref.id) fail('BLOB_ALREADY_REFERENCED')
  checkCollision(index, parent.nodeId, it.name)
  checkNodeBudget(m, 1, ctx.limits)
  checkDepth(index, parent.nodeId, 0, ctx.limits)
  const nodeId = ctx.newNodeId()
  if (!isId(nodeId) || m.nodes.has(nodeId)) fail('INVALID_INTENT', 'newNodeId')
  m.nodes.set(nodeId, {
    nodeId, kind: 'file', parentNodeId: parent.nodeId, name: it.name, createdAtClient: ctx.now, modifiedAtClient: ctx.now,
    lifecycle: { state: 'active' }, blobRef: { formatVersion: ref.formatVersion, id: ref.id }, mediaType: it.mediaType, plainSize: it.plainSize,
  })
  return { changedNodeIds: [nodeId], attachBlobRefs: [{ formatVersion: ref.formatVersion, id: ref.id }] }
}

function opPurge(m, index, it) {
  const roots = normalizeSelectionRoots(index, it.nodeIds)
  if (roots.length === 0) fail('INVALID_INTENT', 'nodeIds')
  for (const id of roots) {
    if (id === m.rootNodeId) fail('ROOT_IMMUTABLE')
    if (effectiveState(index, id) === 'active') fail('NOT_TRASHED')
  }
  const removed = []
  const purgeBlobRefs = []
  for (const root of roots) {
    for (const id of subtreeIds(index, root)) {
      const n = m.nodes.get(id)
      if (!n) continue
      if (n.blobRef) purgeBlobRefs.push({ formatVersion: n.blobRef.formatVersion, id: n.blobRef.id })
      m.nodes.delete(id); removed.push(id)
    }
  }
  return { changedNodeIds: removed, purgeBlobRefs }
}

const OPS = { createFolder: opCreateFolder, rename: opRename, move: opMove, trash: opTrash, restore: opRestore, attachBlob: opAttachBlob, purge: opPurge }

/** แปล ManifestError จากการตรวจซ้ำหลังแก้ให้เป็น OpError ด้วยรหัสเดียวกัน (ตาข่ายนิรภัย — ปกติเงื่อนไขข้างบนจับได้ก่อน) */
const MANIFEST_TO_OP = { COLLISION: 'COLLISION', LIMIT_NODES: 'LIMIT_NODES', LIMIT_DEPTH: 'LIMIT_DEPTH', LIMIT_NAME_BYTES: 'LIMIT_NAME_BYTES', NAME_INVALID: 'NAME_INVALID', CYCLE: 'CYCLE', PARENT_NOT_FOLDER: 'NOT_FOLDER', PARENT_MISSING: 'NOT_FOUND' }

/**
 * ใช้ intent หนึ่งใบกับ manifest (บน clone) แล้วคืน manifest ใหม่ที่ผ่านการตรวจครบ
 * @returns {{ manifest, changedNodeIds: string[], attachBlobRefs: Array, purgeBlobRefs: Array, operationId: string }}
 */
export function applyIntent(manifest, intent, { now = Date.now(), newNodeId = newOpaqueId, limits = VAULT_TREE_CLIENT_LIMITS } = {}) {
  if (!intent || typeof intent !== 'object' || !INTENT_TYPES.includes(intent.type)) fail('INVALID_INTENT', 'type')
  const operationId = intent.operationId ?? newOpaqueId()
  if (!isId(operationId)) fail('INVALID_INTENT', 'operationId')
  const m = structuredClone(manifest)
  const { index } = validateManifest(m, limits)
  const result = OPS[intent.type](m, index, intent, { now, newNodeId, limits })
  m.recentOperationIds = [...m.recentOperationIds, operationId]
  while (m.recentOperationIds.length > limits.maxRecentOperationIds) m.recentOperationIds.shift()
  try {
    validateManifest(m, limits)
  } catch (e) {
    if (e?.name === 'ManifestError') fail(MANIFEST_TO_OP[e.code] ?? e.code, e.message)
    throw e
  }
  return { manifest: m, changedNodeIds: result.changedNodeIds, attachBlobRefs: result.attachBlobRefs ?? [], purgeBlobRefs: result.purgeBlobRefs ?? [], operationId }
}
