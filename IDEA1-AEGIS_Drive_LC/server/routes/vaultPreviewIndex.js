// server/routes/vaultPreviewIndex.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · read-only API (PR-A)
//
// The server is only a holder of opaque ciphertext and an owner-scoped coordinator. Every route here:
//   - requires auth, the tree protocol flag chain, AND VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE + _READ_ENABLED (503 otherwise)
//   - requires the caller to be in TREE_V1 (409 TREE_STATE_CONFLICT otherwise)
//   - answers only from the caller's own rows; another owner's data is simply absent / 404 (never 403)
//   - answers { error, code } on failure and never echoes client input (except opaque ids already validated)
//   - is Cache-Control: no-store
// ⚠️ No route accepts or returns a name, path, parent, node id, MIME, preview kind or shard prefix.
// ⚠️ PR-A is READ-ONLY: there is no POST/PUT/DELETE here. The index CAS, the preview-index upload family and the
//    per-owner retained-storage budget enforcement arrive in PR-C behind VAULT_PREVIEW_INDEX_WRITE_ENABLED.
//    Nothing in D-1 deletes an index object.
// ⚠️ This file must not import client tree rules from src/ (SRV-NOIMPORT-1).

import { Router } from 'express'
import { requireAuth } from '../middleware/requireRole.js'
import { requireTreeProtocol, treeConfigOf } from './vaultTree.js'
import * as tree from '../db/vaultTreeStore.js'
import * as pindex from '../db/vaultPreviewIndexStore.js'
import { isValidVaultBlobId } from '../storage/vaultStaging.js'

export const PREVIEW_INDEX_ERROR = Object.freeze({
  PREVIEW_INDEX_DISABLED: 'PREVIEW_INDEX_DISABLED',
  PREVIEW_INDEX_WRITE_DISABLED: 'PREVIEW_INDEX_WRITE_DISABLED',
  PREVIEW_INDEX_NOT_FOUND: 'PREVIEW_INDEX_NOT_FOUND',
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
