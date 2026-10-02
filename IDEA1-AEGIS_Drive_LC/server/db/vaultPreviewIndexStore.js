// server/db/vaultPreviewIndexStore.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · opaque store
//   PR-A: read + accounting.  PR-C: owner-scoped index CAS (Task C.1) + retained-storage budget enforcement (Task C.7).
//
// ⚠️ Rules for the whole file (same as vaultTreeStore.js):
//    1. No function accepts or returns a name, path, parent, node id, MIME, preview kind or shard prefix —
//       only opaque tree/blob ids, generations, sizes, content ids and lifecycle values.
//    2. Every function requires userId and filters by it in SQL; another owner's rows are simply absent.
//    3. The only writes are: the index CAS (generation row, ATTACHED/SUPERSEDED ref rows, prior generation
//       superseded_at, INDEX_STAGED → INDEX_MANAGED promotion, head upsert) and nothing else.
//    4. Nothing here (or anywhere in D-1) deletes an index object, a generation, a ref row or a V2 row.
//       Initial destructive GC is forbidden. SUPERSEDED_REF=ADVISORY_ONLY: a SUPERSEDED ref row is bookkeeping /
//       measurement only — it changes no lifecycle, schedules nothing, and is never deletion or purge authority
//       (SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO). No code may read SUPERSEDED rows to mutate anything.
//    5. Every mutation serializes on the owner's vault_tree_state row (SELECT … FOR UPDATE) — the same point as the
//       main head CAS and the preview-index upload commit (budget), so the three never interleave per owner.
//
// ⚠️ The in-memory fallback composes the existing V2 and tree stores, so both modes answer from the same
//    facts: a blob is "preview-index owned" iff its vault_tree_blob_state lifecycle is INDEX_STAGED or
//    INDEX_MANAGED. Concurrency evidence can only come from PostgreSQL.

import { query, usingPostgres, withTransaction } from './connection.js'
import { listBlobStates, upsertBlobState, PREVIEW_INDEX_LIFECYCLES, _memTreeRowsSync } from './vaultTreeStore.js'
import { listVaultV2Blobs, _memV2BlobSync } from './vaultV2Store.js'
import { publicVaultV2Blob } from '../routes/vaultUploads.js'

export const MAX_INDEX_BLOB_PAGE = 500

/** protocol outcomes reported as values (never thrown) — the route maps them to HTTP */
export const INDEX_STORE_CODE = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  TREE_STATE_CONFLICT: 'TREE_STATE_CONFLICT',
  PREVIEW_INDEX_CONFLICT: 'PREVIEW_INDEX_CONFLICT',
  PREVIEW_INDEX_IDEMPOTENCY_MISMATCH: 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH',
  PREVIEW_INDEX_BLOB_STATE_CONFLICT: 'PREVIEW_INDEX_BLOB_STATE_CONFLICT',
  PREVIEW_INDEX_ROOT_MISMATCH: 'PREVIEW_INDEX_ROOT_MISMATCH',
  PREVIEW_INDEX_TREE_MISMATCH: 'PREVIEW_INDEX_TREE_MISMATCH',
})

/** thrown inside the preview-index upload commit transaction (→ ROLLBACK) when the owner's budget would be exceeded */
export class IndexBudgetExceeded extends Error {
  constructor() { super('preview-index retained-storage budget exceeded'); this.name = 'IndexBudgetExceeded'; this.code = 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED' }
}

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
const mem = {
  heads: new Map(),       // userId → head row
  generations: new Map(), // userId → [generation rows] (append-only)
  refs: new Map(),        // userId → [{ indexGeneration, blobId, role }] (append-only)
}
const memList = (m, u) => { if (!m.has(u)) m.set(u, []); return m.get(u) }

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

// ── retained-storage budget enforcement (PR-C Task C.7) ─────────────────────

/** memory mode: the same sum as getRetainedIndexBytes, computed synchronously from the live rows */
function memRetainedSync(u) {
  let total = 0
  for (const s of _memTreeRowsSync(u).blobs.values()) {
    if (s.formatVersion !== 2 || !PREVIEW_INDEX_LIFECYCLES.includes(s.lifecycle)) continue
    const b = _memV2BlobSync(u, s.id)
    if (b) total += Number(b.size)
  }
  return total
}

const validBudget = (addBytes, maxBytes) => Number.isSafeInteger(addBytes) && addBytes >= 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0

/**
 * Authoritative budget check, called INSIDE the preview-index upload commit transaction: locks the owner's
 * vault_tree_state row FOR UPDATE (the same serialization point as the main and index CAS), sums the owner's committed
 * INDEX_STAGED + INDEX_MANAGED ciphertext, and throws IndexBudgetExceeded (→ ROLLBACK) when retained + addBytes > maxBytes.
 * The blob being committed has no lifecycle row yet, so it is not part of `retained`.
 */
export async function assertIndexBudgetWithinCommit(client, userId, { addBytes, maxBytes }) {
  const u = uid(userId)
  if (!validBudget(addBytes, maxBytes)) throw new IndexBudgetExceeded() // fail closed on a missing/invalid budget
  if (usingPostgres) {
    if (!client) throw new Error('vaultPreviewIndexStore: budget check needs the commit transaction client')
    await client.query(`SELECT 1 FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
    const retained = await getRetainedIndexBytes(u, { client })
    if (retained + addBytes > maxBytes) throw new IndexBudgetExceeded()
    return
  }
  if (memRetainedSync(u) + addBytes > maxBytes) throw new IndexBudgetExceeded()
}

/**
 * The previewIndex commit hook: budget check + lifecycle INDEX_STAGED in the blob transaction.
 * Memory mode does both without yielding (no await between check and write), mirroring the PG row lock.
 */
export async function stageIndexBlobWithinBudget(client, userId, blobId, { addBytes, maxBytes }) {
  const ref = { formatVersion: 2, id: String(blobId) }
  if (usingPostgres) {
    await assertIndexBudgetWithinCommit(client, userId, { addBytes, maxBytes })
    return upsertBlobState(userId, ref, 'INDEX_STAGED', { client })
  }
  const u = uid(userId)
  if (!validBudget(addBytes, maxBytes) || memRetainedSync(u) + addBytes > maxBytes) throw new IndexBudgetExceeded()
  return upsertBlobState(userId, ref, 'INDEX_STAGED') // memory branch writes synchronously before its first await
}

// ── index CAS (PR-C Task C.1) ────────────────────────────────────────────────

const BLOB_ID_RE = /^[0-9a-f]{48}$/
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{22}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const CONTENT_ID_RE = /^[A-Za-z0-9+/]{22}==$/
const isGen = (v) => Number.isSafeInteger(v) && v >= 0
const idList = (v, { min }) => Array.isArray(v) && v.length >= min && v.every((x) => typeof x === 'string' && BLOB_ID_RE.test(x)) && new Set(v).size === v.length

/** structural validation only (the route validates HTTP shape first); every failure → INVALID_INPUT before any write */
function validCasInput(b) {
  if (!b || typeof b !== 'object') return false
  if (!isGen(b.expectedGeneration)) return false
  if ((b.expectedGeneration === 0) !== (b.expectedRootBlobId === null)) return false
  if (b.expectedRootBlobId !== null && (typeof b.expectedRootBlobId !== 'string' || !BLOB_ID_RE.test(b.expectedRootBlobId))) return false
  if (typeof b.rootBlobId !== 'string' || !BLOB_ID_RE.test(b.rootBlobId)) return false
  if (typeof b.rootContentIdB64 !== 'string' || !CONTENT_ID_RE.test(b.rootContentIdB64)) return false
  if (!idList(b.attachBlobIds, { min: 1 }) || !idList(b.supersededBlobIds, { min: 0 })) return false
  if (typeof b.idempotencyKey !== 'string' || !OPAQUE_ID_RE.test(b.idempotencyKey)) return false
  return typeof b.requestDigest === 'string' && DIGEST_RE.test(b.requestDigest)
}

/** rollback sentinel: abort the transaction and report a non-ok result */
class Abort extends Error { constructor(result) { super('abort'); this.result = result } }

const conflict = (code) => ({ ok: false, code })
const currentOf = (h) => (h ? { indexGeneration: h.indexGeneration, rootBlobId: h.rootBlobId } : null)

/**
 * Owner-scoped preview-index head CAS: advance (expectedGeneration, expectedRootBlobId) → generation + 1 at rootBlobId.
 *   - attachBlobIds: must include rootBlobId; each must be the caller's V2 blob with lifecycle INDEX_STAGED;
 *     all are promoted to INDEX_MANAGED atomically with the head move (any failure → full rollback).
 *   - supersededBlobIds: SUPERSEDED_REF=ADVISORY_ONLY — each must be the caller's INDEX_MANAGED blob; recorded as
 *     role='SUPERSEDED' rows and NOTHING else (no lifecycle change, no purge candidate, budget still counts them).
 *   - idempotency: same (owner, key) + same requestDigest → the original result (replay); different digest → mismatch.
 * Nothing is ever deleted.
 */
export async function casIndexHead(userId, input) {
  const u = uid(userId)
  if (!validCasInput(input)) return conflict(INDEX_STORE_CODE.INVALID_INPUT)
  const { expectedGeneration, expectedRootBlobId, rootBlobId, rootContentIdB64, idempotencyKey, requestDigest } = input
  const attach = [...input.attachBlobIds].sort()
  const superseded = [...input.supersededBlobIds].sort()
  if (!attach.includes(rootBlobId) || superseded.some((id) => attach.includes(id))) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT)
  const nextGeneration = expectedGeneration + 1

  if (usingPostgres) {
    try {
      return await withTransaction(async (c) => {
        // 1. owner serialization point (same row as main head CAS and the preview-index upload commit)
        const { rows: st } = await c.query(`SELECT protocol_state FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
        if (!st.length || st[0].protocol_state !== 'TREE_V1') return conflict(INDEX_STORE_CODE.TREE_STATE_CONFLICT)
        const { rows: mh } = await c.query(`SELECT tree_id FROM vault_tree_heads WHERE user_id = $1`, [u])
        if (!mh.length) return conflict(INDEX_STORE_CODE.TREE_STATE_CONFLICT)
        const treeId = mh[0].tree_id
        // 2. idempotency (answered even after the head moved on, so a lost response can be recovered)
        const { rows: prior } = await c.query(
          `SELECT index_generation, root_blob_id, request_digest FROM vault_preview_index_generations WHERE user_id = $1 AND idempotency_key = $2`,
          [u, idempotencyKey],
        )
        if (prior.length) {
          if (prior[0].request_digest !== requestDigest) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_IDEMPOTENCY_MISMATCH)
          return { ok: true, replay: true, indexGeneration: Number(prior[0].index_generation), rootBlobId: prior[0].root_blob_id }
        }
        // 3. head expectation
        const { rows: hd } = await c.query(`SELECT * FROM vault_preview_index_heads WHERE user_id = $1 FOR UPDATE`, [u])
        const head = hd.length ? mapHead(hd[0]) : null
        if ((head?.indexGeneration ?? 0) !== expectedGeneration || (head?.rootBlobId ?? null) !== expectedRootBlobId) {
          return { ok: false, code: INDEX_STORE_CODE.PREVIEW_INDEX_CONFLICT, current: currentOf(head) }
        }
        // a main treeId is fixed at genesis, so this is unreachable today; if it ever happens the index head is
        // deliberately frozen (fail closed, reader shows 404) — replacing it needs its own reviewed migration path
        if (head && head.treeId !== treeId) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_TREE_MISMATCH)
        // 4. attach: the caller's committed INDEX_STAGED V2 blobs (locked; sorted ids → stable lock order)
        const { rows: att } = await c.query(
          `SELECT s.blob_id, s.lifecycle, b.content_id_b64 FROM vault_tree_blob_state s
             JOIN vault_v2_blobs b ON b.user_id = s.user_id AND b.id = s.blob_id
            WHERE s.user_id = $1 AND s.blob_format_version = 2 AND s.blob_id = ANY($2::text[])
            ORDER BY s.blob_id FOR UPDATE OF s`,
          [u, attach],
        )
        if (att.length !== attach.length || att.some((r) => r.lifecycle !== 'INDEX_STAGED')) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT)
        if (att.find((r) => r.blob_id === rootBlobId).content_id_b64 !== rootContentIdB64) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_ROOT_MISMATCH)
        // 5. superseded: advisory rows only; each must be the caller's INDEX_MANAGED blob
        if (superseded.length) {
          const { rows: sup } = await c.query(
            `SELECT s.blob_id, s.lifecycle FROM vault_tree_blob_state s
               JOIN vault_v2_blobs b ON b.user_id = s.user_id AND b.id = s.blob_id
              WHERE s.user_id = $1 AND s.blob_format_version = 2 AND s.blob_id = ANY($2::text[])
              ORDER BY s.blob_id FOR SHARE OF s`,
            [u, superseded],
          )
          if (sup.length !== superseded.length || sup.some((r) => r.lifecycle !== 'INDEX_MANAGED')) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT)
        }
        // 6. commit the generation (append-only), its refs, the prior generation's superseded_at, promotion, head
        await c.query(
          `INSERT INTO vault_preview_index_generations
             (user_id, index_generation, tree_id, base_generation, root_blob_id, root_content_id_b64, idempotency_key, request_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u, nextGeneration, treeId, expectedGeneration, rootBlobId, rootContentIdB64, idempotencyKey, requestDigest],
        )
        await c.query(
          `INSERT INTO vault_preview_index_blob_refs (user_id, index_generation, blob_id, role)
           SELECT $1, $2, x.id, x.role FROM unnest($3::text[], $4::text[]) AS x(id, role)`,
          [u, nextGeneration, [...attach, ...superseded], [...attach.map(() => 'ATTACHED'), ...superseded.map(() => 'SUPERSEDED')]],
        )
        if (expectedGeneration > 0) {
          await c.query(`UPDATE vault_preview_index_generations SET superseded_at = now() WHERE user_id = $1 AND index_generation = $2 AND superseded_at IS NULL`, [u, expectedGeneration])
        }
        const { rowCount } = await c.query(
          `UPDATE vault_tree_blob_state SET lifecycle = 'INDEX_MANAGED', updated_at = now()
            WHERE user_id = $1 AND blob_format_version = 2 AND blob_id = ANY($2::text[]) AND lifecycle = 'INDEX_STAGED'`,
          [u, attach],
        )
        if (rowCount !== attach.length) throw new Abort(conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT))
        await c.query(
          `INSERT INTO vault_preview_index_heads (user_id, tree_id, index_generation, root_blob_id, root_content_id_b64)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET tree_id = EXCLUDED.tree_id, index_generation = EXCLUDED.index_generation,
             root_blob_id = EXCLUDED.root_blob_id, root_content_id_b64 = EXCLUDED.root_content_id_b64, updated_at = now()`,
          [u, treeId, nextGeneration, rootBlobId, rootContentIdB64],
        )
        return { ok: true, replay: false, indexGeneration: nextGeneration, rootBlobId }
      })
    } catch (e) { if (e instanceof Abort) return e.result; throw e }
  }

  // ── memory CAS critical section: begin (synchronous: check and mutate with no interleaving) ──
  const { state, head: mainHead, blobs } = _memTreeRowsSync(u)
  if (state?.protocolState !== 'TREE_V1' || !mainHead) return conflict(INDEX_STORE_CODE.TREE_STATE_CONFLICT)
  const gens = memList(mem.generations, u)
  const prior = gens.find((g) => g.idempotencyKey === idempotencyKey)
  if (prior) {
    if (prior.requestDigest !== requestDigest) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_IDEMPOTENCY_MISMATCH)
    return { ok: true, replay: true, indexGeneration: prior.indexGeneration, rootBlobId: prior.rootBlobId }
  }
  const head = mem.heads.get(u) ?? null
  if ((head?.indexGeneration ?? 0) !== expectedGeneration || (head?.rootBlobId ?? null) !== expectedRootBlobId) {
    return { ok: false, code: INDEX_STORE_CODE.PREVIEW_INDEX_CONFLICT, current: currentOf(head) }
  }
  if (head && head.treeId !== mainHead.treeId) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_TREE_MISMATCH)
  const stateOf = (id) => (_memV2BlobSync(u, id) ? blobs.get(`2:${id}`) ?? null : null)
  const attachRows = attach.map(stateOf)
  if (attachRows.some((r) => r?.lifecycle !== 'INDEX_STAGED')) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT)
  if (_memV2BlobSync(u, rootBlobId).contentIdB64 !== rootContentIdB64) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_ROOT_MISMATCH)
  if (superseded.map(stateOf).some((r) => r?.lifecycle !== 'INDEX_MANAGED')) return conflict(INDEX_STORE_CODE.PREVIEW_INDEX_BLOB_STATE_CONFLICT)
  const now = Date.now()
  const prev = gens.find((g) => g.indexGeneration === expectedGeneration)
  if (prev && prev.supersededAt === null) prev.supersededAt = now
  gens.push({ indexGeneration: nextGeneration, baseGeneration: expectedGeneration, treeId: mainHead.treeId, rootBlobId, rootContentIdB64, idempotencyKey, requestDigest, committedAt: now, supersededAt: null })
  const refs = memList(mem.refs, u)
  for (const id of attach) refs.push({ indexGeneration: nextGeneration, blobId: id, role: 'ATTACHED' })
  for (const id of superseded) refs.push({ indexGeneration: nextGeneration, blobId: id, role: 'SUPERSEDED' })
  for (const r of attachRows) Object.assign(r, { lifecycle: 'INDEX_MANAGED', updatedAt: now })
  mem.heads.set(u, { treeId: mainHead.treeId, indexGeneration: nextGeneration, rootBlobId, rootContentIdB64, updatedAt: now })
  return { ok: true, replay: false, indexGeneration: nextGeneration, rootBlobId }
  // ── memory CAS critical section: end
}

/** this owner's committed generations, ascending (opaque; read-only — diagnostics and tests) */
export async function listIndexGenerations(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT index_generation, base_generation, tree_id, root_blob_id, committed_at, superseded_at
         FROM vault_preview_index_generations WHERE user_id = $1 ORDER BY index_generation`,
      [u],
    )
    return rows.map((r) => ({
      indexGeneration: Number(r.index_generation), baseGeneration: Number(r.base_generation), treeId: r.tree_id,
      rootBlobId: r.root_blob_id, committedAt: ts(r.committed_at), supersededAt: ts(r.superseded_at),
    }))
  }
  return memList(mem.generations, u).map((g) => ({
    indexGeneration: g.indexGeneration, baseGeneration: g.baseGeneration, treeId: g.treeId,
    rootBlobId: g.rootBlobId, committedAt: g.committedAt, supersededAt: g.supersededAt,
  }))
}

/** opaque { blobId, role } rows of one generation, sorted (read-only — diagnostics and tests; never deletion input) */
export async function listIndexBlobRefs(userId, indexGeneration) {
  const u = uid(userId)
  const order = (a, b) => (a.blobId < b.blobId ? -1 : a.blobId > b.blobId ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT blob_id, role FROM vault_preview_index_blob_refs WHERE user_id = $1 AND index_generation = $2`,
      [u, Number(indexGeneration)],
    )
    return rows.map((r) => ({ blobId: r.blob_id, role: r.role })).sort(order)
  }
  return memList(mem.refs, u).filter((r) => r.indexGeneration === Number(indexGeneration)).map((r) => ({ blobId: r.blobId, role: r.role })).sort(order)
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
  const now = Date.now()
  const gens = memList(mem.generations, u)
  for (let g = 1; g <= indexGeneration; g++) {
    if (!gens.some((x) => x.indexGeneration === g)) {
      gens.push({ indexGeneration: g, baseGeneration: g - 1, treeId, rootBlobId, rootContentIdB64, idempotencyKey: `seed-${u}-${g}`, requestDigest: '0'.repeat(64), committedAt: now, supersededAt: null })
    }
  }
  mem.heads.set(u, { treeId, indexGeneration, rootBlobId, rootContentIdB64, updatedAt: now })
}

/** tests only (memory mode): forget every head/generation/ref. PostgreSQL generations are undeletable by design — PG tests isolate by owner. */
export async function __resetPreviewIndexForTests() {
  if (usingPostgres) return
  for (const m of Object.values(mem)) m.clear()
}
