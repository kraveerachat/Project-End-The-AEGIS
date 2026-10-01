// server/db/vaultPreviewIndexStore.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · opaque store (PR-A: read + accounting)
//
// ⚠️ Rules for the whole file (same as vaultTreeStore.js):
//    1. No function accepts or returns a name, path, parent, node id, MIME, preview kind or shard prefix —
//       only opaque tree/blob ids, generations, sizes, content ids and lifecycle values.
//    2. Every function requires userId and filters by it in SQL; another owner's rows are simply absent.
//    3. PR-A is read-only: nothing here creates, updates, promotes, deletes or purges anything.
//       The index CAS and the retained-storage budget enforcement arrive in PR-C (plan Tasks C.1, C.7).
//    4. Nothing here (or anywhere in D-1) deletes an index object. Initial destructive GC is forbidden.
//
// ⚠️ The in-memory fallback composes the existing V2 and tree stores, so both modes answer from the same
//    facts: a blob is "preview-index owned" iff its vault_tree_blob_state lifecycle is INDEX_STAGED or
//    INDEX_MANAGED. Concurrency evidence can only come from PostgreSQL.

import { query, usingPostgres } from './connection.js'
import { listBlobStates, PREVIEW_INDEX_LIFECYCLES } from './vaultTreeStore.js'
import { listVaultV2Blobs } from './vaultV2Store.js'
import { publicVaultV2Blob } from '../routes/vaultUploads.js'

export const MAX_INDEX_BLOB_PAGE = 500

const uid = (userId) => {
  if (userId === null || userId === undefined) throw new Error('vaultPreviewIndexStore: userId is required')
  return String(userId)
}
const ts = (v) => (v === null || v === undefined ? null : new Date(v).getTime())
const mapHead = (r) => ({
  treeId: r.tree_id, indexGeneration: Number(r.index_generation), rootBlobId: r.root_blob_id,
  rootContentIdB64: r.root_content_id_b64, updatedAt: ts(r.updated_at),
})

// ── in-memory fallback ───────────────────────────────────────────────────────
const mem = { heads: new Map() } // userId → head row

/** V2 blob ids of this owner whose tree lifecycle is INDEX_* (memory mode), with their lifecycle and createdAt */
async function memIndexStates(u) {
  return (await listBlobStates(u))
    .filter((s) => s.formatVersion === 2 && PREVIEW_INDEX_LIFECYCLES.includes(s.lifecycle))
}

// ── head ─────────────────────────────────────────────────────────────────────

/** the owner's optional preview-index head, or null (normal: no index means original-derived tiles) */
export async function getIndexHead(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_preview_index_heads WHERE user_id = $1`, [u])
    return rows.length ? mapHead(rows[0]) : null
  }
  const h = mem.heads.get(u)
  return h ? { ...h } : null
}

// ── opaque index blobs ───────────────────────────────────────────────────────

/**
 * Public V2 envelopes of the requested ids that are this owner's preview-index blobs (INDEX_*).
 * Ids that are user files, unknown, or another owner's are silently absent (no existence oracle).
 */
export async function listIndexEnvelopes(userId, ids) {
  const u = uid(userId)
  const wanted = [...new Set((ids ?? []).map(String))]
  if (!wanted.length) return []
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT b.* FROM vault_v2_blobs b
         JOIN vault_tree_blob_state s ON s.user_id = b.user_id AND s.blob_format_version = 2 AND s.blob_id = b.id
        WHERE b.user_id = $1 AND b.id = ANY($2::text[]) AND s.lifecycle = ANY($3::text[])
        ORDER BY b.id`,
      [u, wanted, PREVIEW_INDEX_LIFECYCLES],
    )
    return rows.map((r) => publicVaultV2Blob({
      id: r.id, size: Number(r.ciphertext_size), createdAt: ts(r.created_at), contentIdB64: r.content_id_b64,
      chunkSize: Number(r.chunk_size), chunkCount: Number(r.chunk_count), wrappedDekB64: r.wrapped_dek_b64,
      wrapIvB64: r.wrap_iv_b64, metaIvB64: r.meta_iv_b64, metaB64: r.meta_b64,
    }))
  }
  const owned = new Set((await memIndexStates(u)).map((s) => s.id))
  return (await listVaultV2Blobs(u))
    .filter((b) => wanted.includes(b.id) && owned.has(b.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(publicVaultV2Blob)
}

/** paginated opaque listing of this owner's INDEX_* blobs, ordered by id (`after` = last id of the previous page) */
export async function listIndexBlobs(userId, { after = null, limit = 100 } = {}) {
  const u = uid(userId)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INDEX_BLOB_PAGE) throw new Error(`vaultPreviewIndexStore: limit must be 1..${MAX_INDEX_BLOB_PAGE}`)
  const cursor = after === null || after === undefined ? null : String(after)
  let rows
  if (usingPostgres) {
    const r = await query(
      `SELECT s.blob_id, s.lifecycle, s.created_at FROM vault_tree_blob_state s
         JOIN vault_v2_blobs b ON b.user_id = s.user_id AND b.id = s.blob_id
        WHERE s.user_id = $1 AND s.blob_format_version = 2 AND s.lifecycle = ANY($2::text[])
          AND ($3::text IS NULL OR s.blob_id > $3::text)
        ORDER BY s.blob_id LIMIT $4`,
      [u, PREVIEW_INDEX_LIFECYCLES, cursor, limit + 1],
    )
    rows = r.rows.map((x) => ({ id: x.blob_id, lifecycle: x.lifecycle, createdAt: ts(x.created_at) }))
  } else {
    const present = new Set((await listVaultV2Blobs(u)).map((b) => b.id))
    rows = (await memIndexStates(u))
      .filter((s) => present.has(s.id) && (cursor === null || s.id > cursor))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit + 1)
      .map((s) => ({ id: s.id, lifecycle: s.lifecycle, createdAt: s.createdAt }))
  }
  const page = rows.slice(0, limit)
  return { blobs: page, next: rows.length > limit ? page[page.length - 1].id : null }
}

/** V2 ids of this owner's INDEX_* blobs — used to keep them out of user inventories (GET /api/vault, /tree/blobs) */
export async function excludeIndexBlobIds(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT blob_id FROM vault_tree_blob_state WHERE user_id = $1 AND blob_format_version = 2 AND lifecycle = ANY($2::text[])`,
      [u, PREVIEW_INDEX_LIFECYCLES],
    )
    return new Set(rows.map((r) => r.blob_id))
  }
  return new Set((await memIndexStates(u)).map((s) => s.id))
}

// ── retained-storage accounting ──────────────────────────────────────────────

/**
 * Committed ciphertext bytes of this owner's preview-index blobs (INDEX_STAGED + INDEX_MANAGED: roots, shards,
 * derivatives — including lost-CAS and superseded ones, because they still exist). Ordinary user files are
 * excluded by construction. PR-A only reports; the budget is enforced at preview-index upload commit in PR-C.
 * @param {string|number} userId
 * @param {{ client?: { query: Function } | null }} [o] optional transaction client (PR-C commit-time check)
 */
export async function getRetainedIndexBytes(userId, { client = null } = {}) {
  const u = uid(userId)
  if (usingPostgres) {
    const q = client ? client.query.bind(client) : query
    const { rows } = await q(
      `SELECT COALESCE(SUM(b.ciphertext_size), 0)::bigint AS bytes
         FROM vault_tree_blob_state s
         JOIN vault_v2_blobs b ON b.user_id = s.user_id AND b.id = s.blob_id
        WHERE s.user_id = $1 AND s.blob_format_version = 2 AND s.lifecycle = ANY($2::text[])`,
      [u, PREVIEW_INDEX_LIFECYCLES],
    )
    return Number(rows[0].bytes)
  }
  const owned = new Set((await memIndexStates(u)).map((s) => s.id))
  let total = 0
  for (const b of await listVaultV2Blobs(u)) if (owned.has(b.id)) total += Number(b.size)
  return total
}

// ── tests only ───────────────────────────────────────────────────────────────

/** tests only: install a head (PostgreSQL: writes the generation row it must reference). Never routed. */
export async function __seedIndexHeadForTests(userId, { treeId, indexGeneration = 1, rootBlobId, rootContentIdB64 }) {
  const u = uid(userId)
  if (usingPostgres) {
    for (let g = 1; g <= indexGeneration; g++) {
      await query(
        `INSERT INTO vault_preview_index_generations
           (user_id, index_generation, tree_id, base_generation, root_blob_id, root_content_id_b64, idempotency_key, request_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [u, g, treeId, g - 1, rootBlobId, rootContentIdB64, `seed-${u}-${g}`, '0'.repeat(64)],
      )
    }
    await query(
      `INSERT INTO vault_preview_index_heads (user_id, tree_id, index_generation, root_blob_id, root_content_id_b64)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET tree_id = EXCLUDED.tree_id, index_generation = EXCLUDED.index_generation,
         root_blob_id = EXCLUDED.root_blob_id, root_content_id_b64 = EXCLUDED.root_content_id_b64, updated_at = now()`,
      [u, treeId, indexGeneration, rootBlobId, rootContentIdB64],
    )
    return
  }
  mem.heads.set(u, { treeId, indexGeneration, rootBlobId, rootContentIdB64, updatedAt: Date.now() })
}

/** tests only (memory mode): forget every head. PostgreSQL generations are undeletable by design — PG tests isolate by owner. */
export async function __resetPreviewIndexForTests() {
  if (usingPostgres) return
  mem.heads.clear()
}
