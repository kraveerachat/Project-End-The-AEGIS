// src/lib/vaultTreeManifest.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · manifest rules
//
// กฎของ "ต้นไม้" ทั้งหมดอยู่ที่นี่ และรันในหน่วยความจำของ client ที่ปลดล็อกแล้วเท่านั้น
// (design §9, §13, §14): สคีมา, กราฟ (root เดียว, parent มีจริง/เป็นโฟลเดอร์, reach ได้, ไม่วน,
// ลึกไม่เกิน), ชื่อชนกันในพี่น้อง (NFC → full case folding ตารางตรึงเวอร์ชัน), lifecycle ที่เก็บไว้
// vs. ที่ "มีผลจริง" (ตามบรรพบุรุษ), breadcrumbs
//
// ⚠️ ทุกอย่างที่เข้ามาคือข้อมูลที่ไม่น่าเชื่อถือ (เพิ่งถอดรหัสมา) → ตรวจครบก่อน render/แก้ ทุกความล้มเหลว
//    = โยน ManifestError ทันที ไม่มีการซ่อม ไม่มี partial result
// ⚠️ ไม่มี I/O ไม่มี crypto — pure functions ล้วน; ทุก walk เป็น iterative + visited set
// ⚠️ เซิร์ฟเวอร์ต้องไม่ import ไฟล์นี้ (SRV-NOIMPORT-1): เซิร์ฟเวอร์ไม่มีสิทธิ์รู้กฎเหล่านี้ด้วยซ้ำ

import { caseFold } from './unicodeCaseFold.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'
import { FORMAT_IDS } from './preview/formats.js'
import { PREVIEW_KINDS, MAX_PREVIEWS_PER_NODE, TIMED_PREVIEW_KINDS, PREVIEW_PROFILE_RE, previewProfileBounds } from './vaultPreviewProfiles.js'

const te = new TextEncoder()

// Unified Preview P2a: this build READS schema 1 and 2 but WRITES only 1 (P2A_WRITES_V2=NO).
// Any other version fails secure (UNSUPPORTED_SCHEMA_VERSION) — never "best effort" read a newer schema.
export const MANIFEST_SCHEMA_VERSION_WRITE = 1
export const MANIFEST_SCHEMA_VERSIONS_READ = Object.freeze([1, 2])
/** kept for existing importers — always the WRITE version */
export const MANIFEST_SCHEMA_VERSION = MANIFEST_SCHEMA_VERSION_WRITE
export const NODE_KINDS = Object.freeze(['folder', 'file'])
export const LIFECYCLE_STATES = Object.freeze(['active', 'trashed', 'purge-pending'])
const BLOB_FORMAT_VERSIONS = Object.freeze([1, 2])

const ID_RE = /^[A-Za-z0-9_-]{22}$/
const TOP_KEYS = new Set(['schemaVersion', 'treeId', 'generation', 'revisionId', 'baseRevisionId', 'rootNodeId', 'createdAtClient', 'nodes', 'recentOperationIds'])
const NODE_KEYS = new Set(['nodeId', 'kind', 'parentNodeId', 'name', 'createdAtClient', 'modifiedAtClient', 'lifecycle', 'blobRef', 'mediaType', 'plainSize'])
// schema v2 = v1 node keys + two OPTIONAL file-only keys (spec §8.2); every other level is unchanged
const NODE_KEYS_V2 = new Set([...NODE_KEYS, 'contentFormat', 'previews'])
const PREVIEW_KEYS = new Set(['kind', 'profile', 'blobRef', 'contentId', 'sourceBlobRef', 'mime', 'width', 'height', 'durationMs', 'plainSize', 'createdAtClient'])
const LIFECYCLE_KEYS = new Set(['state', 'trashedAtClient', 'trashedFromParentNodeId'])
const BLOBREF_KEYS = new Set(['formatVersion', 'id'])
const MAX_MEDIA_TYPE_BYTES = 255
const MAX_BLOB_ID_LEN = 128
const MAX_CONTENT_FORMAT_BYTES = 32
/** canonical standard base64 of exactly 16 bytes (the V2 blob envelope's contentId) */
const CONTENT_ID_RE = /^[A-Za-z0-9+/]{21}[AQgw]==$/

export class ManifestError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'ManifestError'
    this.code = code
  }
}
const fail = (code, msg) => { throw new ManifestError(code, msg) }

// ── ชื่อและ collision key ────────────────────────────────────────────────────

/** key สำหรับตรวจชื่อชนกันในพี่น้อง: NFC แล้ว full case folding ด้วยตารางที่ตรึงเวอร์ชัน (ชื่อที่แสดงคงเดิม) */
export function collisionKey(name) {
  return caseFold(String(name).normalize('NFC'))
}

/**
 * ชื่อ node ที่ยอมรับ: ไม่ว่าง, ไม่ใช่ช่องว่างล้วน, ไม่มี NUL/ตัวคั่น path, ไม่ใช่ "." หรือ ".."
 * และไม่เกิน limits.maxNameBytes (UTF-8) — คืน code ของปัญหา หรือ null ถ้าผ่าน
 */
export function nameProblem(name, limits = VAULT_TREE_CLIENT_LIMITS) {
  if (typeof name !== 'string') return 'NAME_INVALID'
  if (name.length === 0 || name.trim().length === 0) return 'NAME_INVALID'
  if (name === '.' || name === '..') return 'NAME_INVALID'
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return 'NAME_INVALID' // control, DEL, '/', '\\'
  }
  if (te.encode(name).length > limits.maxNameBytes) return 'LIMIT_NAME_BYTES'
  return null
}

// ── genesis ──────────────────────────────────────────────────────────────────

/** manifest แรกของ tree: generation 1, ไม่มี base, root โฟลเดอร์เดียว ชื่อว่าง */
export function createGenesisManifest({ treeId, rootNodeId, revisionId, now }) {
  const root = { nodeId: rootNodeId, kind: 'folder', parentNodeId: null, name: '', createdAtClient: now, modifiedAtClient: now, lifecycle: { state: 'active' } }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION, treeId, generation: 1, revisionId, baseRevisionId: null, rootNodeId,
    createdAtClient: now, nodes: new Map([[rootNodeId, root]]), recentOperationIds: [],
  }
}

// ── validation ───────────────────────────────────────────────────────────────

const isId = (v) => typeof v === 'string' && ID_RE.test(v)
const isTs = (v) => Number.isSafeInteger(v) && v >= 0
const checkKeys = (obj, allowed, where) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('BAD_FIELD', where)
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail('UNKNOWN_KEY', `${where}.${k}`)
}

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isBlobRef = (r, versions) => versions.includes(r.formatVersion) && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= MAX_BLOB_ID_LEN

/** one manifest-v2 preview entry (spec §8.2) — structure always, profile bounds only for profiles this build knows */
function validatePreview(p) {
  if (!isObj(p)) fail('PREVIEW_BAD_FIELD', 'preview entry')
  checkKeys(p, PREVIEW_KEYS, 'node.previews[]')
  if (!PREVIEW_KINDS.includes(p.kind)) fail('PREVIEW_BAD_KIND')
  if (typeof p.profile !== 'string' || !PREVIEW_PROFILE_RE.test(p.profile)) fail('PREVIEW_BAD_PROFILE')
  if (!isObj(p.blobRef)) fail('PREVIEW_BAD_BLOB_REF')
  checkKeys(p.blobRef, BLOBREF_KEYS, 'node.previews[].blobRef')
  if (!isBlobRef(p.blobRef, [2])) fail('PREVIEW_BAD_BLOB_REF') // a derivative is always a V2 blob
  if (typeof p.contentId !== 'string' || !CONTENT_ID_RE.test(p.contentId)) fail('PREVIEW_BAD_CONTENT_ID')
  if (!isObj(p.sourceBlobRef)) fail('PREVIEW_BAD_SOURCE_REF')
  checkKeys(p.sourceBlobRef, BLOBREF_KEYS, 'node.previews[].sourceBlobRef')
  if (!isBlobRef(p.sourceBlobRef, BLOB_FORMAT_VERSIONS)) fail('PREVIEW_BAD_SOURCE_REF')
  if (typeof p.mime !== 'string' || p.mime.length === 0 || te.encode(p.mime).length > MAX_MEDIA_TYPE_BYTES) fail('PREVIEW_BAD_MIME')
  if (!isPosInt(p.width) || !isPosInt(p.height) || !isPosInt(p.plainSize) || !isTs(p.createdAtClient)) fail('PREVIEW_BAD_FIELD')
  if (TIMED_PREVIEW_KINDS.includes(p.kind) ? !isPosInt(p.durationMs) : p.durationMs !== undefined) fail('PREVIEW_BAD_DURATION')
  const b = previewProfileBounds(p.profile, p.kind)
  if (!b) return // unknown (future) profile: effectivePreviews() ignores it
  if (!b.mimes.includes(p.mime)) fail('PREVIEW_BAD_MIME')
  const long = Math.max(p.width, p.height), short = Math.min(p.width, p.height)
  if (long > b.maxLongEdge || short > b.maxShortEdge || p.plainSize > b.maxPlainSize) fail('PREVIEW_OUT_OF_BOUNDS')
  if (b.maxDurationMs !== null && p.durationMs > b.maxDurationMs) fail('PREVIEW_OUT_OF_BOUNDS')
}

/**
 * The manifest-v2 preview entry rule, exported unchanged for the D-1 preview-index shard codec:
 * structure always; vp1 bounds (MIME, edges, size, duration) only for profiles this build knows.
 * Throws ManifestError (PREVIEW_*); an unknown profile passes structurally and must be ignored by readers.
 */
export const validatePreviewEntry = validatePreview

/** v2-only file keys; a folder may carry neither */
function validateNodeV2Fields(n) {
  if (n.kind !== 'file') {
    if (n.contentFormat !== undefined || n.previews !== undefined) fail('FOLDER_HAS_PREVIEWS')
    return
  }
  if (n.contentFormat !== undefined) {
    const f = n.contentFormat
    if (typeof f !== 'string' || te.encode(f).length > MAX_CONTENT_FORMAT_BYTES || !(f === '' || FORMAT_IDS.includes(f))) fail('BAD_CONTENT_FORMAT')
  }
  if (n.previews === undefined) return
  if (!Array.isArray(n.previews)) fail('PREVIEW_BAD_FIELD', 'previews')
  if (n.previews.length > MAX_PREVIEWS_PER_NODE) fail('LIMIT_PREVIEWS')
  const kinds = new Set()
  for (const p of n.previews) {
    validatePreview(p)
    if (kinds.has(p.kind)) fail('PREVIEW_DUPLICATE_KIND')
    kinds.add(p.kind)
  }
}

function validateNode(id, n, limits, rootNodeId, schemaVersion) {
  checkKeys(n, schemaVersion === 2 ? NODE_KEYS_V2 : NODE_KEYS, 'node')
  if (n.nodeId !== id || !isId(id)) fail('DUP_NODE', 'map key must equal nodeId')
  if (!NODE_KINDS.includes(n.kind)) fail('BAD_FIELD', 'kind')
  if (!(n.parentNodeId === null || isId(n.parentNodeId))) fail('BAD_FIELD', 'parentNodeId')
  if (!isTs(n.createdAtClient) || !isTs(n.modifiedAtClient)) fail('BAD_FIELD', 'timestamps')
  checkKeys(n.lifecycle, LIFECYCLE_KEYS, 'node.lifecycle')
  if (!LIFECYCLE_STATES.includes(n.lifecycle.state)) fail('BAD_FIELD', 'lifecycle.state')
  const isRoot = id === rootNodeId
  if (isRoot) {
    if (n.parentNodeId !== null) fail('ROOT_PARENT')
    if (n.kind !== 'folder') fail('BAD_FIELD', 'root must be a folder')
    if (n.name !== '') fail('BAD_FIELD', 'root name must be empty')
    if (n.lifecycle.state !== 'active') fail('ROOT_IMMUTABLE')
  } else {
    if (n.parentNodeId === null) fail('MULTI_ROOT')
    const problem = nameProblem(n.name, limits)
    if (problem) fail(problem, 'name')
  }
  if (n.lifecycle.state === 'active') {
    if ('trashedAtClient' in n.lifecycle || 'trashedFromParentNodeId' in n.lifecycle) fail('LIFECYCLE_INCONSISTENT')
  } else {
    if (!isTs(n.lifecycle.trashedAtClient)) fail('LIFECYCLE_INCONSISTENT', 'trashedAtClient')
    if (!isId(n.lifecycle.trashedFromParentNodeId)) fail('LIFECYCLE_INCONSISTENT', 'trashedFromParentNodeId')
  }
  if (n.kind === 'file') {
    if (n.blobRef === undefined) fail('FILE_BLOB_REQUIRED')
    checkKeys(n.blobRef, BLOBREF_KEYS, 'node.blobRef')
    if (!BLOB_FORMAT_VERSIONS.includes(n.blobRef.formatVersion)) fail('BAD_BLOB_REF', 'formatVersion')
    if (typeof n.blobRef.id !== 'string' || n.blobRef.id.length === 0 || n.blobRef.id.length > MAX_BLOB_ID_LEN) fail('BAD_BLOB_REF', 'id')
    if (typeof n.mediaType !== 'string' || te.encode(n.mediaType).length > MAX_MEDIA_TYPE_BYTES) fail('BAD_FIELD', 'mediaType')
    if (!isTs(n.plainSize)) fail('BAD_FIELD', 'plainSize')
  } else {
    if (n.blobRef !== undefined) fail('FOLDER_HAS_BLOB')
    if (n.mediaType !== undefined || n.plainSize !== undefined) fail('BAD_FIELD', 'folder has file fields')
  }
  if (schemaVersion === 2) validateNodeV2Fields(n)
}

/**
 * ตรวจ manifest ทั้งใบ (สคีมา + กราฟ + ชื่อ + lifecycle + ขอบเขต) แล้วสร้าง index สำหรับ query
 * @returns {{ok:true, index:{nodes:Map, rootNodeId:string, childrenOf:Map<string,string[]>, depthOf:Map<string,number>, limits:object}}}
 */
export function validateManifest(m, limits = VAULT_TREE_CLIENT_LIMITS) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('BAD_FIELD', 'manifest')
  if (!MANIFEST_SCHEMA_VERSIONS_READ.includes(m.schemaVersion)) fail('UNSUPPORTED_SCHEMA_VERSION', String(m.schemaVersion))
  checkKeys(m, TOP_KEYS, 'manifest')
  if (!isId(m.treeId) || !isId(m.revisionId) || !isId(m.rootNodeId)) fail('BAD_FIELD', 'ids')
  if (!(m.baseRevisionId === null || isId(m.baseRevisionId))) fail('BAD_FIELD', 'baseRevisionId')
  if (!Number.isSafeInteger(m.generation) || m.generation < 1) fail('BAD_FIELD', 'generation')
  if (m.generation === 1 ? m.baseRevisionId !== null : m.baseRevisionId === null) fail('BAD_FIELD', 'genesis must have null base; later revisions must have a base')
  if (!isTs(m.createdAtClient)) fail('BAD_FIELD', 'createdAtClient')
  if (!(m.nodes instanceof Map)) fail('BAD_FIELD', 'nodes must be a Map')
  if (!Array.isArray(m.recentOperationIds)) fail('BAD_FIELD', 'recentOperationIds')
  if (m.recentOperationIds.length > limits.maxRecentOperationIds) fail('LIMIT_OPS')
  for (const op of m.recentOperationIds) if (!isId(op)) fail('BAD_FIELD', 'recentOperationIds entry')
  if (m.nodes.size > limits.maxNodes) fail('LIMIT_NODES')
  if (!m.nodes.has(m.rootNodeId)) fail('NO_ROOT')

  const childrenOf = new Map()
  for (const [id, n] of m.nodes) {
    validateNode(id, n, limits, m.rootNodeId, m.schemaVersion)
    if (n.parentNodeId === null) continue
    const p = m.nodes.get(n.parentNodeId)
    if (!p) fail('PARENT_MISSING')
    if (p.kind !== 'folder') fail('PARENT_NOT_FOLDER')
    if (!childrenOf.has(n.parentNodeId)) childrenOf.set(n.parentNodeId, [])
    childrenOf.get(n.parentNodeId).push(id)
  }
  // reachability + depth: iterative DFS from root; every node must be visited exactly once
  const depthOf = new Map([[m.rootNodeId, 0]])
  const stack = [m.rootNodeId]
  let seen = 0
  while (stack.length) {
    const id = stack.pop(); seen++
    const d = depthOf.get(id)
    if (d > limits.maxDepth) fail('LIMIT_DEPTH')
    for (const c of childrenOf.get(id) ?? []) {
      if (depthOf.has(c)) fail('CYCLE')
      depthOf.set(c, d + 1); stack.push(c)
    }
  }
  if (seen !== m.nodes.size) fail('UNREACHABLE')
  // trashedFromParentNodeId must name an existing folder
  for (const n of m.nodes.values()) {
    if (n.lifecycle.state !== 'active') {
      const from = m.nodes.get(n.lifecycle.trashedFromParentNodeId)
      if (!from || from.kind !== 'folder') fail('LIFECYCLE_INCONSISTENT', 'trashedFromParentNodeId')
    }
  }
  // sibling collisions among *stored-active* nodes only (trashed nodes keep their names without blocking)
  for (const [parentId, kids] of childrenOf) {
    const keys = new Set()
    for (const c of kids) {
      const n = m.nodes.get(c)
      if (n.lifecycle.state !== 'active') continue
      const k = collisionKey(n.name)
      if (keys.has(k)) fail('COLLISION', parentId)
      keys.add(k)
    }
  }
  return { ok: true, index: { nodes: m.nodes, rootNodeId: m.rootNodeId, childrenOf, depthOf, limits } }
}

// ── derived views (index จาก validateManifest) ───────────────────────────────

const NO_PREVIEWS = Object.freeze([])

/**
 * preview entries that may be used for this file node right now: the entry's sourceBlobRef equals the
 * node's current blobRef (a replaced file never shows a stale preview) AND this build knows its profile.
 * Anything else is ignored — never an error (spec §8.2, §10). Expects a node from a validated manifest.
 */
export function effectivePreviews(node) {
  if (!node || node.kind !== 'file' || !Array.isArray(node.previews) || !node.blobRef) return NO_PREVIEWS
  const { formatVersion, id } = node.blobRef
  return Object.freeze(node.previews.filter((p) => p?.sourceBlobRef?.formatVersion === formatVersion && p.sourceBlobRef.id === id && previewProfileBounds(p.profile, p.kind) !== null))
}

/** ไล่ parent ขึ้นไปจนถึง root (ไม่รวมตัวเอง) — มี visited set และเพดานความลึก */
export function ancestorsOf(index, nodeId) {
  const out = []
  const visited = new Set([nodeId])
  let cur = index.nodes.get(nodeId)
  if (!cur) fail('NOT_FOUND')
  while (cur.parentNodeId !== null) {
    const pid = cur.parentNodeId
    if (visited.has(pid) || out.length > index.limits.maxDepth) fail('CYCLE')
    visited.add(pid); out.push(pid)
    cur = index.nodes.get(pid)
    if (!cur) fail('PARENT_MISSING')
  }
  return out
}

/**
 * สถานะที่มีผลจริง: 'purge-pending' ถ้าตัวเองหรือบรรพบุรุษใดเป็น purge-pending, ไม่งั้น 'trashed'
 * ถ้าตัวเองหรือบรรพบุรุษใดถูกทิ้ง, ไม่งั้น 'active' — ลูกหลานไม่ต้องถูกเขียนทับตอนทิ้งโฟลเดอร์
 */
export function effectiveState(index, nodeId) {
  const own = index.nodes.get(nodeId)
  if (!own) fail('NOT_FOUND')
  let state = own.lifecycle.state
  if (state === 'purge-pending') return state
  for (const a of ancestorsOf(index, nodeId)) {
    const s = index.nodes.get(a).lifecycle.state
    if (s === 'purge-pending') return s
    if (s === 'trashed') state = 'trashed'
  }
  return state
}

/**
 * ลูกของโฟลเดอร์ตามมุมมอง: 'active' = ลูกที่มีผลจริงเป็น active; 'trash' (parentNodeId ละเว้นได้)
 * = raก subtree ที่ถูกทิ้ง คือ node ที่ state ของตัวเองไม่ active และบรรพบุรุษทุกตัว active
 */
export function childrenOf(index, parentNodeId, { view = 'active' } = {}) {
  if (view === 'trash') {
    const out = []
    for (const n of index.nodes.values()) {
      if (n.lifecycle.state === 'active') continue
      if (parentNodeId !== null && parentNodeId !== undefined && n.parentNodeId !== parentNodeId) continue
      const ancestorsActive = ancestorsOf(index, n.nodeId).every((a) => index.nodes.get(a).lifecycle.state === 'active')
      if (ancestorsActive) out.push(n)
    }
    return out
  }
  const kids = index.childrenOf.get(parentNodeId) ?? []
  return kids.map((id) => index.nodes.get(id)).filter((n) => effectiveState(index, n.nodeId) === 'active')
}

/** [root, …, node] */
export function breadcrumbsFor(index, nodeId) {
  const self = index.nodes.get(nodeId)
  if (!self) fail('NOT_FOUND')
  return [...ancestorsOf(index, nodeId).reverse().map((id) => index.nodes.get(id)), self]
}

/** nodeId อยู่ใต้ ancestorId หรือไม่ (ตัวเองไม่นับ) */
export function isDescendant(index, nodeId, ancestorId) {
  if (nodeId === ancestorId) return false
  return ancestorsOf(index, nodeId).includes(ancestorId)
}

/** มี node พี่น้องที่ stored-active ใต้ parent ที่ชื่อชนกับ name หรือไม่ (ยกเว้น exceptNodeId) → nodeId หรือ null */
export function activeSiblingCollision(index, parentNodeId, name, exceptNodeId = null) {
  const key = collisionKey(name)
  for (const id of index.childrenOf.get(parentNodeId) ?? []) {
    if (id === exceptNodeId) continue
    const n = index.nodes.get(id)
    if (n.lifecycle.state === 'active' && collisionKey(n.name) === key) return id
  }
  return null
}
