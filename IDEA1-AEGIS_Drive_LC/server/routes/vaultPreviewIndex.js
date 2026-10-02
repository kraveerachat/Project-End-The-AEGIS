// server/routes/vaultPreviewIndex.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · API
//   PR-A: read-only routes.  PR-C: write-gated POST /head (index CAS) and the preview-index upload family.
//
// The server is only a holder of opaque ciphertext and an owner-scoped coordinator. Every route here:
//   - requires auth, the tree protocol flag chain, AND VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE + _READ_ENABLED (503 otherwise)
//   - mutating routes additionally require VAULT_PREVIEW_INDEX_WRITE_ENABLED (503 PREVIEW_INDEX_WRITE_DISABLED, checked
//     before the body is read and before any store call)
//   - requires the caller to be in TREE_V1 (409 TREE_STATE_CONFLICT otherwise)
//   - answers only from the caller's own rows; another owner's data is simply absent / 404 (never 403)
//   - answers { error, code } on failure and never echoes client input (except opaque ids already validated)
//   - is Cache-Control: no-store
// ⚠️ No route accepts or returns a name, path, parent, node id, MIME, preview kind or shard prefix.
// ⚠️ There is no PUT/PATCH/DELETE here and no store function that deletes anything. Nothing in D-1 deletes an index
//    object; client-declared superseded ids are advisory bookkeeping only (never deletion authority).
// ⚠️ This file must not import client tree rules from src/ (SRV-NOIMPORT-1).

import { Router } from 'express'
import { createHash } from 'node:crypto'
import { requireAuth } from '../middleware/requireRole.js'
import { requireTreeProtocol, treeConfigOf } from './vaultTree.js'
import { recordAudit, sha256Hex } from '../db/connection.js'
import { requestSourceIp } from '../request/sourceIp.js'
import * as tree from '../db/vaultTreeStore.js'
import * as pindex from '../db/vaultPreviewIndexStore.js'
import { isValidContentIdB64 } from '../db/vaultV2Store.js'
import { isValidVaultBlobId } from '../storage/vaultStaging.js'

export const PREVIEW_INDEX_ERROR = Object.freeze({
  PREVIEW_INDEX_DISABLED: 'PREVIEW_INDEX_DISABLED',
  PREVIEW_INDEX_WRITE_DISABLED: 'PREVIEW_INDEX_WRITE_DISABLED',
  PREVIEW_INDEX_NOT_FOUND: 'PREVIEW_INDEX_NOT_FOUND',
  PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED: 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED',
  PREVIEW_INDEX_CONFLICT: 'PREVIEW_INDEX_CONFLICT',
  PREVIEW_INDEX_IDEMPOTENCY_MISMATCH: 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH',
  PREVIEW_INDEX_BLOB_STATE_CONFLICT: 'PREVIEW_INDEX_BLOB_STATE_CONFLICT',
  PREVIEW_INDEX_ROOT_MISMATCH: 'PREVIEW_INDEX_ROOT_MISMATCH',
  PREVIEW_INDEX_TREE_MISMATCH: 'PREVIEW_INDEX_TREE_MISMATCH',
  TREE_STATE_CONFLICT: 'TREE_STATE_CONFLICT',
  INVALID_INPUT: 'INVALID_INPUT',
})

const NO_STORE = { 'Cache-Control': 'no-store' }
const fail = (res, status, code, error = code) => res.status(status).set(NO_STORE).json({ error, code })
const ok = (res, body) => res.status(200).set(NO_STORE).json(body)

/** read gate: the preview-index schema AND reader flag must both be on (503 fail-closed) */
export function requirePreviewIndexRead(req, res, next) {
  const flags = treeConfigOf(req)?.flags
  if (!flags?.previewIndexSchemaAvailable || !flags?.previewIndexReadEnabled) {
    return fail(res, 503, PREVIEW_INDEX_ERROR.PREVIEW_INDEX_DISABLED, 'Private Vault preview index is not enabled')
  }
  return next()
}

/** write gate (used by PR-C routes only): VAULT_PREVIEW_INDEX_WRITE_ENABLED, default false */
export function requirePreviewIndexWrite(req, res, next) {
  if (!treeConfigOf(req)?.flags?.previewIndexWriteEnabled) {
    return fail(res, 503, PREVIEW_INDEX_ERROR.PREVIEW_INDEX_WRITE_DISABLED, 'Private Vault preview index writing is not enabled')
  }
  return next()
}

/** the caller must already be in TREE_V1 (peek: never creates a state row) */
async function requireTreeV1(req, res, next) {
  try {
    const st = await tree.peekTreeState(req.user.id)
    if (st?.protocolState !== 'TREE_V1') return fail(res, 409, PREVIEW_INDEX_ERROR.TREE_STATE_CONFLICT, 'No preview index in this protocol state')
    return next()
  } catch (err) { return next(err) }
}

/** a query parameter that must appear at most once as a plain string */
function singleParam(v) {
  if (v === undefined) return undefined
  return typeof v === 'string' ? v : null
}

export const vaultPreviewIndexRouter = Router()
vaultPreviewIndexRouter.use(requireAuth, requireTreeProtocol, requirePreviewIndexRead)

// ── head ─────────────────────────────────────────────────────────────────────
// 404 is the normal "no index" answer: the client renders original-derived tiles.
vaultPreviewIndexRouter.get('/head', requireTreeV1, async (req, res, next) => {
  try {
    const [head, mainHead] = await Promise.all([pindex.getIndexHead(req.user.id), tree.getHead(req.user.id)])
    if (!head || !mainHead || head.treeId !== mainHead.treeId) return fail(res, 404, PREVIEW_INDEX_ERROR.PREVIEW_INDEX_NOT_FOUND)
    return ok(res, {
      treeId: head.treeId, indexGeneration: head.indexGeneration,
      rootBlobRef: { formatVersion: 2, id: head.rootBlobId }, rootContentIdB64: head.rootContentIdB64,
    })
  } catch (err) { return next(err) }
})

// ── envelopes of INDEX_* blobs (bounded batch) ───────────────────────────────
// Index/derivative envelopes are excluded from GET /api/vault, so the reader fetches them here, a few at a time.
vaultPreviewIndexRouter.get('/envelopes', requireTreeV1, async (req, res, next) => {
  try {
    const raw = singleParam(req.query.ids)
    if (!raw) return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid envelope request')
    const ids = raw.split(',')
    const max = treeConfigOf(req).limits.maxPreviewIndexEnvelopeBatch
    if (ids.length > max || !ids.every((id) => isValidVaultBlobId(id)) || new Set(ids).size !== ids.length) {
      return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid envelope request')
    }
    return ok(res, { blobs: await pindex.listIndexEnvelopes(req.user.id, ids) })
  } catch (err) { return next(err) }
})

// ── opaque INDEX_* blob listing (paginated; diagnostics/reachability reports) ─
vaultPreviewIndexRouter.get('/blobs', requireTreeV1, async (req, res, next) => {
  try {
    const rawLimit = singleParam(req.query.limit)
    const rawAfter = singleParam(req.query.after)
    if (rawLimit === null || rawAfter === null) return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid listing request')
    const limit = rawLimit === undefined ? 100 : (/^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > pindex.MAX_INDEX_BLOB_PAGE) return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid listing request')
    if (rawAfter !== undefined && !isValidVaultBlobId(rawAfter)) return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid listing request')
    return ok(res, await pindex.listIndexBlobs(req.user.id, { after: rawAfter ?? null, limit }))
  } catch (err) { return next(err) }
})

// ── index head CAS (PR-C Task C.3; write-gated; audited) ────────────────────
// Body keys are a closed set; ids are opaque. requestDigest is computed HERE (never trusted from the client) as
// SHA-256 of the canonical JSON of the validated body with sorted id arrays, so a retry with the same content in a
// different id order is the same request. supersededBlobIds are SUPERSEDED_REF=ADVISORY_ONLY (never deletion authority).

const CAS_KEYS = ['expectedGeneration', 'expectedRootBlobId', 'rootBlobId', 'rootContentIdB64', 'attachBlobIds', 'supersededBlobIds', 'idempotencyKey']
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{22}$/
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isGen = (v) => Number.isSafeInteger(v) && v >= 0
const idArray = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((x) => isValidVaultBlobId(x)) && new Set(v).size === v.length

/** the validated body, or null (→ 400 INVALID_INPUT, nothing echoed) */
function parseCasBody(b, limits) {
  if (!isObj(b)) return null
  const keys = Object.keys(b)
  if (keys.length !== CAS_KEYS.length || !keys.every((k) => CAS_KEYS.includes(k))) return null
  if (!isGen(b.expectedGeneration)) return null
  if (b.expectedGeneration === 0 ? b.expectedRootBlobId !== null : !isValidVaultBlobId(b.expectedRootBlobId)) return null
  if (!isValidVaultBlobId(b.rootBlobId) || !isValidContentIdB64(b.rootContentIdB64)) return null
  if (typeof b.idempotencyKey !== 'string' || !OPAQUE_ID_RE.test(b.idempotencyKey)) return null
  if (!idArray(b.attachBlobIds, 1, limits.maxPreviewIndexAttachPerCas)) return null
  if (!idArray(b.supersededBlobIds, 0, limits.maxPreviewIndexSupersededPerCas)) return null
  if (!b.attachBlobIds.includes(b.rootBlobId) || b.supersededBlobIds.some((id) => b.attachBlobIds.includes(id))) return null
  return {
    expectedGeneration: b.expectedGeneration, expectedRootBlobId: b.expectedRootBlobId, rootBlobId: b.rootBlobId,
    rootContentIdB64: b.rootContentIdB64, attachBlobIds: [...b.attachBlobIds].sort(), supersededBlobIds: [...b.supersededBlobIds].sort(),
    idempotencyKey: b.idempotencyKey,
  }
}

/** SHA-256 hex of the canonical (sorted-key) JSON of the validated body — the server's own request digest */
export function casRequestDigest(v) {
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])))
  return createHash('sha256').update(canonical).digest('hex')
}

const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(target) : null, result, sourceIp: requestSourceIp(req),
  })

const CAS_STATUS = Object.freeze({
  [pindex.INDEX_STORE_CODE.TREE_STATE_CONFLICT]: 409,
  [pindex.INDEX_STORE_CODE.PREVIEW_INDEX_IDEMPOTENCY_MISMATCH]: 409,
  [pindex.INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT]: 409,
  [pindex.INDEX_STORE_CODE.PREVIEW_INDEX_ROOT_MISMATCH]: 409,
  [pindex.INDEX_STORE_CODE.PREVIEW_INDEX_TREE_MISMATCH]: 409,
  [pindex.INDEX_STORE_CODE.INVALID_INPUT]: 400,
})

vaultPreviewIndexRouter.post('/head', requirePreviewIndexWrite, requireTreeV1, async (req, res, next) => {
  try {
    const v = parseCasBody(req.body, treeConfigOf(req).limits)
    if (!v) return fail(res, 400, PREVIEW_INDEX_ERROR.INVALID_INPUT, 'Invalid preview index CAS request')
    const r = await pindex.casIndexHead(req.user.id, { ...v, requestDigest: casRequestDigest(v) })
    if (!r.ok) {
      await auditAct(req, 'VAULT_PREVIEW_INDEX_CAS', v.rootBlobId, 'DENIED')
      if (r.code === pindex.INDEX_STORE_CODE.PREVIEW_INDEX_CONFLICT) {
        return res.status(409).set(NO_STORE).json({
          error: 'Preview index changed', code: PREVIEW_INDEX_ERROR.PREVIEW_INDEX_CONFLICT,
          currentGeneration: r.current?.indexGeneration ?? null, currentRootBlobId: r.current?.rootBlobId ?? null,
        })
      }
      return fail(res, CAS_STATUS[r.code] ?? 409, r.code)
    }
    if (!r.replay) await auditAct(req, 'VAULT_PREVIEW_INDEX_CAS', r.rootBlobId)
    return ok(res, { indexGeneration: r.indexGeneration, rootBlobId: r.rootBlobId })
  } catch (err) { return next(err) }
})
