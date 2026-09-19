// server/db/vaultTreeStore.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · opaque coordination store
//
// ⚠️ กติกาที่ห้ามละเมิดทั้งไฟล์ (เหมือน vaultV2Store.js):
//    1. ไม่มีฟังก์ชันใดรับหรือคืน ชื่อ, parent, path, MIME, node id, breadcrumb หรือโครงต้นไม้ —
//       มีแต่ id ทึบ (tree/revision/blob/lease/purge), เวอร์ชัน, generation, ขนาด, IV, กุญแจที่ห่อแล้ว, สถานะ
//    2. ทุกฟังก์ชันรับ userId "บังคับ" และกรองใน SQL เสมอ; ของผู้ใช้อื่นคืน null / TREE_STATE_CONFLICT
//    3. ทุก CAS อยู่ใน transaction เดียว โดยล็อกแถว vault_tree_state ของเจ้าของ (FOR UPDATE) เป็นจุดอนุกรม
//       แล้วจึง UPDATE แบบมีเงื่อนไข — ไม่มี last-writer-wins
//    4. เซิร์ฟเวอร์ "ไม่" ตรวจ cycle/ชื่อชน/สมาชิกโฟลเดอร์ — มันไม่รู้และต้องไม่รู้ (SRV-NOIMPORT-1)
//
// ⚠️ โหมด in-memory fallback มีไว้ให้ชุดทดสอบเดียวกันรันได้ทั้งสองโหมด — รูปร่างของแถวและ
//    ความหมายของทุกสถานะต้องเหมือนโหมด Postgres เป๊ะ (spec เดียวกันใน tests/vaultTreeStore.test.js
//    รันทั้งสองโหมด) แต่หลักฐาน concurrency มีได้เฉพาะจาก Postgres จริงเท่านั้น

import { createHash, randomBytes } from 'node:crypto'
import { query, usingPostgres, withTransaction } from './connection.js'
import { listVaultBlobs } from './store.js'
import { listVaultV2Blobs } from './vaultV2Store.js'

export const PROTOCOL_STATES = Object.freeze(['FLAT', 'MIGRATING_TREE_V1', 'TREE_V1'])
export const REVISION_STATES = Object.freeze(['CREATED', 'PUBLISHED', 'HEAD_COMMITTED', 'SUPERSEDED', 'ORPHANED', 'NON_RECOVERABLE', 'FORENSIC_DELETED'])
export const BLOB_LIFECYCLES = Object.freeze(['UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED'])

/** ข้อผิดพลาดเชิงโปรโตคอลที่ store รายงานเป็นค่า (ไม่โยน) — route แปลเป็น HTTP */
export const STORE_CODE = Object.freeze({
  TREE_STATE_CONFLICT: 'TREE_STATE_CONFLICT',
  TREE_HEAD_CONFLICT: 'TREE_HEAD_CONFLICT',
  TREE_BLOB_STATE_CONFLICT: 'TREE_BLOB_STATE_CONFLICT',
  TREE_ENVELOPE_CONFLICT: 'TREE_ENVELOPE_CONFLICT',
  TREE_IDEMPOTENCY_MISMATCH: 'TREE_IDEMPOTENCY_MISMATCH',
  TREE_REVISION_NOT_PUBLISHED: 'TREE_REVISION_NOT_PUBLISHED',
  TREE_REVISION_NON_RECOVERABLE: 'TREE_REVISION_NON_RECOVERABLE',
  TREE_PURGE_NOT_SUPPORTED: 'TREE_PURGE_NOT_SUPPORTED',
  TREE_LEASE_HELD: 'TREE_LEASE_HELD',
  TREE_LEASE_STALE: 'TREE_LEASE_STALE',
  TREE_INVENTORY_MISMATCH: 'TREE_INVENTORY_MISMATCH',
  TREE_ABANDON_FORBIDDEN: 'TREE_ABANDON_FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
})

const uid = (userId) => {
  if (userId === null || userId === undefined) throw new Error('vaultTreeStore: userId is required')
  return String(userId)
}
const clone = (v) => (v === null || v === undefined ? v : structuredClone(v))
const nowMs = () => Date.now()
const refKey = (r) => `${r.formatVersion}:${r.id}`

/** rollback sentinel สำหรับ transaction ที่ต้องยกเลิกทุกอย่างแล้วคืนผลลัพธ์แบบไม่ ok */
class Abort extends Error { constructor(result) { super('abort'); this.result = result } }
async function txn(fn) {
  try { return await withTransaction(fn) } catch (e) { if (e instanceof Abort) return e.result; throw e }
}

// ── row mappers (PG) ─────────────────────────────────────────────────────────
const ts = (v) => (v === null || v === undefined ? null : new Date(v).getTime())
const mapState = (r) => ({
  userId: String(r.user_id), protocolState: r.protocol_state, minProtocolVersion: Number(r.min_protocol_version),
  headEverCommitted: r.head_ever_committed === true, treeMutationCount: Number(r.tree_mutation_count),
  migrationLeaseId: r.migration_lease_id ?? null, migrationLeaseEpoch: Number(r.migration_lease_epoch),
  migrationLeaseExpiresAt: ts(r.migration_lease_expires_at), frozenInventoryId: r.frozen_inventory_id ?? null,
  frozenInventoryDigest: r.frozen_inventory_digest ?? null, purgeBarrierGeneration: Number(r.purge_barrier_generation),
})
const mapEnvelope = (r) => ({
  userId: String(r.user_id), treeId: r.tree_id, ownerScopeIdB64: r.owner_scope_id_b64,
  keyEnvelopeVersion: Number(r.key_envelope_version), envelopeCasVersion: Number(r.envelope_cas_version),
  primary: { wrappedTrkB64: r.primary_wrapped_trk_b64, wrapIvB64: r.primary_wrap_iv_b64 },
  recovery: { wrappedTrkB64: r.recovery_wrapped_trk_b64, wrapIvB64: r.recovery_wrap_iv_b64 },
})
const mapHead = (r) => ({ userId: String(r.user_id), treeId: r.tree_id, revisionId: r.revision_id, generation: Number(r.generation), updatedAt: ts(r.updated_at) })
const mapRevision = (r) => ({
  revisionId: r.revision_id, userId: String(r.user_id), treeId: r.tree_id, baseRevisionId: r.base_revision_id ?? null,
  generation: Number(r.generation), manifestSchemaVersion: Number(r.manifest_schema_version),
  storageKey: r.storage_key ?? null, ciphertextSize: r.ciphertext_size === null ? null : Number(r.ciphertext_size),
  ciphertextSha256: r.ciphertext_sha256 ?? null, ivB64: r.iv_b64, wrappedManifestDekB64: r.wrapped_manifest_dek_b64,
  wrapIvB64: r.wrap_iv_b64, state: r.state, idempotencyKey: r.idempotency_key,
  createdAt: ts(r.created_at), publishedAt: ts(r.published_at), committedAt: ts(r.committed_at), retiredAt: ts(r.retired_at),
})
const mapBlobState = (r) => ({
  userId: String(r.user_id), formatVersion: Number(r.blob_format_version), id: r.blob_id, lifecycle: r.lifecycle,
  attachedGeneration: r.attached_generation === null ? null : Number(r.attached_generation), purgeId: r.purge_id ?? null,
  createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
})

// ── in-memory fallback ───────────────────────────────────────────────────────
const mem = {
  state: new Map(),      // userId → state row
  frozen: new Map(),     // userId → Map(frozenInventoryId → [{formatVersion,id}])
  envelope: new Map(),   // userId → envelope row
  heads: new Map(),      // userId → head row
  revisions: new Map(),  // revisionId → revision row
  blobStates: new Map(), // userId → Map(refKey → blob state row)
  purge: new Map(),      // userId → [candidate rows] (Phase 8)
}
function memState(userId) {
  const u = uid(userId)
  if (!mem.state.has(u)) {
    const now = nowMs()
    mem.state.set(u, {
      userId: u, protocolState: 'FLAT', minProtocolVersion: 1, headEverCommitted: false, treeMutationCount: 0,
      migrationLeaseId: null, migrationLeaseEpoch: 0, migrationLeaseExpiresAt: null, frozenInventoryId: null,
      frozenInventoryDigest: null, purgeBarrierGeneration: 0, createdAt: now, updatedAt: now,
    })
  }
  return mem.state.get(u)
}
const memBlobMap = (userId) => { const u = uid(userId); if (!mem.blobStates.has(u)) mem.blobStates.set(u, new Map()); return mem.blobStates.get(u) }

// ── protocol state ───────────────────────────────────────────────────────────

/** สถานะโปรโตคอลของเจ้าของ — สร้างแถว FLAT ให้เมื่อยังไม่มี (lazy) */
export async function getTreeState(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    await query(`INSERT INTO vault_tree_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u])
    const { rows } = await query(`SELECT * FROM vault_tree_state WHERE user_id = $1`, [u])
    return mapState(rows[0])
  }
  const { createdAt, updatedAt, ...row } = memState(u)
  return clone(row)
}

/** อ่านสถานะโดย "ไม่สร้าง" แถว — ใช้กับด่านกั้น route เก่า (แถวไม่มี = FLAT) */
export async function peekTreeState(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_tree_state WHERE user_id = $1`, [u])
    return rows.length ? mapState(rows[0]) : null
  }
  if (!mem.state.has(u)) return null
  const { createdAt, updatedAt, ...row } = mem.state.get(u)
  return clone(row)
}

// ── key envelope ─────────────────────────────────────────────────────────────

export async function getKeyEnvelope(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_tree_key_envelope WHERE user_id = $1`, [u])
    return rows.length ? mapEnvelope(rows[0]) : null
  }
  return clone(mem.envelope.get(u) ?? null)
}

/**
 * CAS ของซองกุญแจ: แทนที่สองช่องเมื่อ envelope_cas_version ตรงกับที่คาด — ใช้ทั้งหมุน passphrase และซ่อมช่อง
 * ไม่แตะ revision ใด ๆ
 */
export async function casKeyEnvelope(userId, { expectedEnvelopeCasVersion, primary, recovery }) {
  const u = uid(userId)
  if (!primary?.wrappedTrkB64 || !primary?.wrapIvB64 || !recovery?.wrappedTrkB64 || !recovery?.wrapIvB64) return { ok: false, code: STORE_CODE.NOT_FOUND }
  if (primary.wrapIvB64 === recovery.wrapIvB64) return { ok: false, code: STORE_CODE.TREE_ENVELOPE_CONFLICT }
  if (usingPostgres) {
    return txn(async (c) => {
      await c.query(`SELECT 1 FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      const { rows } = await c.query(
        `UPDATE vault_tree_key_envelope
            SET envelope_cas_version = envelope_cas_version + 1,
                primary_wrapped_trk_b64 = $3, primary_wrap_iv_b64 = $4,
                recovery_wrapped_trk_b64 = $5, recovery_wrap_iv_b64 = $6, updated_at = now()
          WHERE user_id = $1 AND envelope_cas_version = $2
          RETURNING envelope_cas_version`,
        [u, expectedEnvelopeCasVersion, primary.wrappedTrkB64, primary.wrapIvB64, recovery.wrappedTrkB64, recovery.wrapIvB64],
      )
      if (!rows.length) {
        const { rows: cur } = await c.query(`SELECT envelope_cas_version FROM vault_tree_key_envelope WHERE user_id = $1`, [u])
        return { ok: false, code: cur.length ? STORE_CODE.TREE_ENVELOPE_CONFLICT : STORE_CODE.NOT_FOUND, current: cur.length ? Number(cur[0].envelope_cas_version) : null }
      }
      return { ok: true, envelopeCasVersion: Number(rows[0].envelope_cas_version) }
    })
  }
  const env = mem.envelope.get(u)
  if (!env) return { ok: false, code: STORE_CODE.NOT_FOUND, current: null }
  if (env.envelopeCasVersion !== expectedEnvelopeCasVersion) return { ok: false, code: STORE_CODE.TREE_ENVELOPE_CONFLICT, current: env.envelopeCasVersion }
  env.envelopeCasVersion += 1
  env.primary = { ...primary }; env.recovery = { ...recovery }
  return { ok: true, envelopeCasVersion: env.envelopeCasVersion }
}

// ── head ─────────────────────────────────────────────────────────────────────

export async function getHead(userId) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_tree_heads WHERE user_id = $1`, [u])
    return rows.length ? mapHead(rows[0]) : null
  }
  return clone(mem.heads.get(u) ?? null)
}

// ── revisions ────────────────────────────────────────────────────────────────

/**
 * สร้าง revision ในสถานะ CREATED (ยังไม่มี ciphertext) — idempotent ด้วย (userId, idempotencyKey):
 * key เดิม + revisionId เดิม → คืนแถวเดิม; key เดิม + revisionId อื่น → TREE_IDEMPOTENCY_MISMATCH
 */
export async function createRevision(userId, meta) {
  const u = uid(userId)
  const { revisionId, treeId, baseRevisionId = null, generation, manifestSchemaVersion, ivB64, wrappedManifestDekB64, wrapIvB64, idempotencyKey } = meta
  if (usingPostgres) {
    return txn(async (c) => {
      await c.query(`SELECT 1 FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      const { rows: existing } = await c.query(`SELECT * FROM vault_tree_revisions WHERE user_id = $1 AND (idempotency_key = $2 OR revision_id = $3)`, [u, idempotencyKey, revisionId])
      if (existing.length) {
        const same = existing.find((r) => r.revision_id === revisionId && r.idempotency_key === idempotencyKey)
        if (same && existing.length === 1) return { ok: true, replay: true, revision: mapRevision(same) }
        return { ok: false, code: STORE_CODE.TREE_IDEMPOTENCY_MISMATCH }
      }
      const { rows } = await c.query(
        `INSERT INTO vault_tree_revisions
           (revision_id, user_id, tree_id, base_revision_id, generation, manifest_schema_version,
            iv_b64, wrapped_manifest_dek_b64, wrap_iv_b64, state, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CREATED',$10) RETURNING *`,
        [revisionId, u, treeId, baseRevisionId, generation, manifestSchemaVersion, ivB64, wrappedManifestDekB64, wrapIvB64, idempotencyKey],
      )
      return { ok: true, replay: false, revision: mapRevision(rows[0]) }
    })
  }
  const existing = [...mem.revisions.values()].filter((r) => r.userId === u && (r.idempotencyKey === idempotencyKey || r.revisionId === revisionId))
  if (existing.length) {
    const same = existing.find((r) => r.revisionId === revisionId && r.idempotencyKey === idempotencyKey)
    if (same && existing.length === 1) return { ok: true, replay: true, revision: clone(same) }
    return { ok: false, code: STORE_CODE.TREE_IDEMPOTENCY_MISMATCH }
  }
  const row = {
    revisionId, userId: u, treeId, baseRevisionId, generation: Number(generation), manifestSchemaVersion: Number(manifestSchemaVersion),
    storageKey: null, ciphertextSize: null, ciphertextSha256: null, ivB64, wrappedManifestDekB64, wrapIvB64,
    state: 'CREATED', idempotencyKey, createdAt: nowMs(), publishedAt: null, committedAt: null, retiredAt: null,
  }
  mem.revisions.set(revisionId, row)
  return { ok: true, replay: false, revision: clone(row) }
}

/** CREATED → PUBLISHED: ตั้ง identity ของ ciphertext ครั้งเดียว (trigger ใน PG บังคับ; ที่นี่ตรวจสถานะให้ตรงกัน) */
export async function markRevisionPublished(userId, revisionId, { storageKey, ciphertextSize, sha256 }) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(
      `UPDATE vault_tree_revisions
          SET state = 'PUBLISHED', storage_key = $3, ciphertext_size = $4, ciphertext_sha256 = $5, published_at = now()
        WHERE revision_id = $1 AND user_id = $2 AND state = 'CREATED'
        RETURNING *`,
      [revisionId, u, storageKey, ciphertextSize, sha256],
    )
    if (!rows.length) {
      const cur = await getRevision(u, revisionId)
      return { ok: false, code: cur ? STORE_CODE.TREE_REVISION_NOT_PUBLISHED : STORE_CODE.NOT_FOUND, state: cur?.state ?? null }
    }
    return { ok: true, revision: mapRevision(rows[0]) }
  }
  const row = mem.revisions.get(revisionId)
  if (!row || row.userId !== u) return { ok: false, code: STORE_CODE.NOT_FOUND, state: null }
  if (row.state !== 'CREATED') return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED, state: row.state }
  Object.assign(row, { state: 'PUBLISHED', storageKey, ciphertextSize: Number(ciphertextSize), ciphertextSha256: sha256, publishedAt: nowMs() })
  return { ok: true, revision: clone(row) }
}

/** revision ของเจ้าของนี้ — null ถ้าไม่ใช่ของเขา; NON_RECOVERABLE/FORENSIC_DELETED ถูกรายงานเป็น nonRecoverable */
export async function getRevision(userId, revisionId) {
  const u = uid(userId)
  let row
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM vault_tree_revisions WHERE revision_id = $1 AND user_id = $2`, [revisionId, u])
    row = rows.length ? mapRevision(rows[0]) : null
  } else {
    const r = mem.revisions.get(revisionId)
    row = r && r.userId === u ? clone(r) : null
  }
  if (!row) return null
  return { ...row, nonRecoverable: row.state === 'NON_RECOVERABLE' || row.state === 'FORENSIC_DELETED' }
}

// ── head CAS ─────────────────────────────────────────────────────────────────

/**
 * จุด commit เดียวของโปรโตคอล: เลื่อน head จาก (expectedGeneration, expectedRevisionId) ไป revisionId
 * พร้อมโปรโมต blob ที่แนบมาจาก UNREFERENCED → TREE_MANAGED แบบอะตอมมิก
 *   - ผู้แพ้ CAS: revision ผู้สมัคร → ORPHANED, head ไม่เปลี่ยน, คืน TREE_HEAD_CONFLICT + head ปัจจุบัน
 *   - blob ที่แนบไม่ได้อยู่ใน UNREFERENCED (หรือไม่ใช่ของเจ้าของ) → TREE_BLOB_STATE_CONFLICT และ rollback ทั้งหมด
 *   - idempotency: revision ที่ commit แล้วด้วย key เดิม → คืนผลเดิม; key ไม่ตรงกับ revision → TREE_IDEMPOTENCY_MISMATCH
 * purgeBlobRefs ถูกรับไว้เพื่อ Phase 8 — ตอนนี้ต้องว่าง (TREE_PURGE_NOT_SUPPORTED)
 */
export async function casHead(userId, { expectedGeneration, expectedRevisionId, revisionId, attachBlobRefs = [], purgeBlobRefs = [], idempotencyKey }) {
  const u = uid(userId)
  if (purgeBlobRefs.length) return { ok: false, code: STORE_CODE.TREE_PURGE_NOT_SUPPORTED }
  if (usingPostgres) {
    return txn(async (c) => {
      const { rows: st } = await c.query(`SELECT * FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      if (!st.length || st[0].protocol_state !== 'TREE_V1') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: st[0]?.protocol_state ?? 'FLAT' }
      const { rows: rv } = await c.query(`SELECT * FROM vault_tree_revisions WHERE revision_id = $1 AND user_id = $2 FOR UPDATE`, [revisionId, u])
      if (!rv.length) return { ok: false, code: STORE_CODE.NOT_FOUND }
      const rev = mapRevision(rv[0])
      if (rev.idempotencyKey !== idempotencyKey) return { ok: false, code: STORE_CODE.TREE_IDEMPOTENCY_MISMATCH }
      const { rows: hd } = await c.query(`SELECT * FROM vault_tree_heads WHERE user_id = $1 FOR UPDATE`, [u])
      const head = hd.length ? mapHead(hd[0]) : null
      if (['HEAD_COMMITTED', 'SUPERSEDED', 'NON_RECOVERABLE', 'FORENSIC_DELETED'].includes(rev.state)) {
        return { ok: true, replay: true, generation: rev.generation, revisionId: rev.revisionId, purgeBarrierGeneration: Number(st[0].purge_barrier_generation) }
      }
      if (rev.state === 'ORPHANED') return { ok: false, replay: true, code: STORE_CODE.TREE_HEAD_CONFLICT, current: head && { generation: head.generation, revisionId: head.revisionId } }
      if (rev.state !== 'PUBLISHED') return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED, state: rev.state }
      const matches = head && head.generation === Number(expectedGeneration) && head.revisionId === expectedRevisionId
        && rev.generation === head.generation + 1 && rev.baseRevisionId === head.revisionId && rev.treeId === head.treeId
      if (!matches) {
        await c.query(`UPDATE vault_tree_revisions SET state = 'ORPHANED', retired_at = now() WHERE revision_id = $1`, [revisionId])
        return { ok: false, code: STORE_CODE.TREE_HEAD_CONFLICT, current: head && { generation: head.generation, revisionId: head.revisionId } }
      }
      for (const ref of attachBlobRefs) {
        const { rows: bs } = await c.query(
          `SELECT lifecycle FROM vault_tree_blob_state WHERE user_id = $1 AND blob_format_version = $2 AND blob_id = $3 FOR UPDATE`,
          [u, ref.formatVersion, String(ref.id)],
        )
        if (!bs.length || bs[0].lifecycle !== 'UNREFERENCED') throw new Abort({ ok: false, code: STORE_CODE.TREE_BLOB_STATE_CONFLICT, ref: { formatVersion: ref.formatVersion, id: String(ref.id) } })
        await c.query(
          `UPDATE vault_tree_blob_state SET lifecycle = 'TREE_MANAGED', attached_generation = $4, updated_at = now()
            WHERE user_id = $1 AND blob_format_version = $2 AND blob_id = $3`,
          [u, ref.formatVersion, String(ref.id), rev.generation],
        )
      }
      await c.query(`UPDATE vault_tree_revisions SET state = 'SUPERSEDED' WHERE revision_id = $1 AND state = 'HEAD_COMMITTED'`, [head.revisionId])
      await c.query(`UPDATE vault_tree_revisions SET state = 'HEAD_COMMITTED', committed_at = now() WHERE revision_id = $1`, [revisionId])
      await c.query(`UPDATE vault_tree_heads SET revision_id = $2, generation = $3, updated_at = now() WHERE user_id = $1`, [u, revisionId, rev.generation])
      await c.query(`UPDATE vault_tree_state SET tree_mutation_count = tree_mutation_count + 1, updated_at = now() WHERE user_id = $1`, [u])
      return { ok: true, replay: false, generation: rev.generation, revisionId, purgeBarrierGeneration: Number(st[0].purge_barrier_generation) }
    })
  }
  // memory: single-threaded critical section — no await inside
  const st = mem.state.get(u)
  if (!st || st.protocolState !== 'TREE_V1') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: st?.protocolState ?? 'FLAT' }
  const rev = mem.revisions.get(revisionId)
  if (!rev || rev.userId !== u) return { ok: false, code: STORE_CODE.NOT_FOUND }
  if (rev.idempotencyKey !== idempotencyKey) return { ok: false, code: STORE_CODE.TREE_IDEMPOTENCY_MISMATCH }
  const head = mem.heads.get(u) ?? null
  if (['HEAD_COMMITTED', 'SUPERSEDED', 'NON_RECOVERABLE', 'FORENSIC_DELETED'].includes(rev.state)) {
    return { ok: true, replay: true, generation: rev.generation, revisionId: rev.revisionId, purgeBarrierGeneration: st.purgeBarrierGeneration }
  }
  if (rev.state === 'ORPHANED') return { ok: false, replay: true, code: STORE_CODE.TREE_HEAD_CONFLICT, current: head && { generation: head.generation, revisionId: head.revisionId } }
  if (rev.state !== 'PUBLISHED') return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED, state: rev.state }
  const matches = head && head.generation === Number(expectedGeneration) && head.revisionId === expectedRevisionId
    && rev.generation === head.generation + 1 && rev.baseRevisionId === head.revisionId && rev.treeId === head.treeId
  if (!matches) {
    rev.state = 'ORPHANED'; rev.retiredAt = nowMs()
    return { ok: false, code: STORE_CODE.TREE_HEAD_CONFLICT, current: head && { generation: head.generation, revisionId: head.revisionId } }
  }
  const blobs = memBlobMap(u)
  const toAttach = []
  for (const ref of attachBlobRefs) {
    const row = blobs.get(refKey({ formatVersion: ref.formatVersion, id: String(ref.id) }))
    if (!row || row.lifecycle !== 'UNREFERENCED') return { ok: false, code: STORE_CODE.TREE_BLOB_STATE_CONFLICT, ref: { formatVersion: ref.formatVersion, id: String(ref.id) } }
    toAttach.push(row)
  }
  const now = nowMs()
  for (const row of toAttach) Object.assign(row, { lifecycle: 'TREE_MANAGED', attachedGeneration: rev.generation, updatedAt: now })
  const prev = mem.revisions.get(head.revisionId)
  if (prev && prev.state === 'HEAD_COMMITTED') prev.state = 'SUPERSEDED'
  rev.state = 'HEAD_COMMITTED'; rev.committedAt = now
  Object.assign(head, { revisionId, generation: rev.generation, updatedAt: now })
  st.treeMutationCount += 1; st.updatedAt = now
  return { ok: true, replay: false, generation: rev.generation, revisionId, purgeBarrierGeneration: st.purgeBarrierGeneration }
}

// ── blob lifecycle ───────────────────────────────────────────────────────────

export async function listBlobStates(userId, { lifecycle = null } = {}) {
  const u = uid(userId)
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_tree_blob_state WHERE user_id = $1 ${lifecycle ? 'AND lifecycle = $2' : ''} ORDER BY created_at, blob_id`,
      lifecycle ? [u, lifecycle] : [u],
    )
    return rows.map(mapBlobState)
  }
  return [...memBlobMap(u).values()].filter((r) => !lifecycle || r.lifecycle === lifecycle).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(clone)
}

/** สร้าง/ตั้ง lifecycle ของ blob ทึบหนึ่งชิ้น (ใช้โดย tree-aware commit และ genesis; ไม่ตรวจ transition — ผู้เรียกรับผิดชอบ) */
export async function upsertBlobState(userId, ref, lifecycle, { attachedGeneration = null, client = null } = {}) {
  const u = uid(userId)
  if (!BLOB_LIFECYCLES.includes(lifecycle)) throw new Error('vaultTreeStore: bad lifecycle')
  if (usingPostgres) {
    const q = client ? client.query.bind(client) : query
    const { rows } = await q(
      `INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle, attached_generation)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, blob_format_version, blob_id)
       DO UPDATE SET lifecycle = EXCLUDED.lifecycle, attached_generation = EXCLUDED.attached_generation, updated_at = now()
       RETURNING *`,
      [u, ref.formatVersion, String(ref.id), lifecycle, attachedGeneration],
    )
    return mapBlobState(rows[0])
  }
  const map = memBlobMap(u)
  const key = refKey({ formatVersion: ref.formatVersion, id: String(ref.id) })
  const now = nowMs()
  const row = map.get(key) ?? { userId: u, formatVersion: Number(ref.formatVersion), id: String(ref.id), createdAt: now }
  Object.assign(row, { lifecycle, attachedGeneration, purgeId: row.purgeId ?? null, updatedAt: now })
  map.set(key, row)
  return clone(row)
}

// ── orphan revisions (GC) ────────────────────────────────────────────────────

/** revision ที่แพ้ CAS หรือไม่เคยถูก CAS (ORPHANED / CREATED / PUBLISHED ที่ค้าง) เก่ากว่า olderThanMs */
export async function listOrphanRevisions({ olderThanMs, now = nowMs() }) {
  const cutoff = now - olderThanMs
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM vault_tree_revisions
        WHERE (state = 'ORPHANED' AND retired_at < to_timestamp($1 / 1000.0))
           OR (state IN ('CREATED', 'PUBLISHED') AND created_at < to_timestamp($1 / 1000.0))
        ORDER BY created_at`,
      [cutoff],
    )
    return rows.map(mapRevision)
  }
  return [...mem.revisions.values()].filter((r) => (r.state === 'ORPHANED' && r.retiredAt < cutoff) || (['CREATED', 'PUBLISHED'].includes(r.state) && r.createdAt < cutoff)).map(clone)
}

/**
 * ปลด revision ออก: ORPHANED → ลบแถว (trigger อนุญาตเฉพาะ ORPHANED/FORENSIC_DELETED);
 * CREATED/PUBLISHED ที่ค้าง → ORPHANED ก่อนแล้วจึงลบ; คืน storageKey ให้ผู้เรียกลบไฟล์
 */
export async function retireRevision(revisionId) {
  if (usingPostgres) {
    return txn(async (c) => {
      const { rows } = await c.query(`SELECT * FROM vault_tree_revisions WHERE revision_id = $1 FOR UPDATE`, [revisionId])
      if (!rows.length) return { ok: false, code: STORE_CODE.NOT_FOUND }
      const rev = mapRevision(rows[0])
      if (['CREATED', 'PUBLISHED'].includes(rev.state)) await c.query(`UPDATE vault_tree_revisions SET state = 'ORPHANED', retired_at = now() WHERE revision_id = $1`, [revisionId])
      else if (rev.state !== 'ORPHANED') return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED, state: rev.state }
      await c.query(`DELETE FROM vault_tree_revisions WHERE revision_id = $1`, [revisionId])
      return { ok: true, storageKey: rev.storageKey }
    })
  }
  const rev = mem.revisions.get(revisionId)
  if (!rev) return { ok: false, code: STORE_CODE.NOT_FOUND }
  if (!['CREATED', 'PUBLISHED', 'ORPHANED'].includes(rev.state)) return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED, state: rev.state }
  mem.revisions.delete(revisionId)
  return { ok: true, storageKey: rev.storageKey }
}

// ── migration lease / frozen inventory (Task 3.1) ────────────────────────────
// FLAT → MIGRATING_TREE_V1 คือ CAS ของสถานะ: จอง lease สุ่ม + epoch ที่เพิ่มขึ้นเสมอ + แช่แข็งบัญชี blob ทึบ
// ของขณะนั้น (แถวใน vault_tree_frozen_inventory + digest sha256 ของรายการที่เรียงแล้ว) ตั้งแต่ commit นี้
// route เก่าถูกกั้น (requireVaultProtocolState) — lease หมดอายุ "ไม่" ปลดรั้ว: ทำได้แค่ takeover หรือ abandon
const newLeaseId = () => randomBytes(24).toString('hex')
const newOpaqueId = () => randomBytes(16).toString('base64url')
/** digest ของบัญชีที่แช่แข็ง — เรียง "v:id" แล้ว sha256 (id ทึบล้วน ไม่มีชื่อ/โครงสร้าง) */
export const inventoryDigest = (refs) => createHash('sha256').update(refs.map(refKey).sort().join('\n')).digest('hex')
const normRefs = (inventory) => inventory.map((b) => ({ formatVersion: Number(b.formatVersion), id: String(b.id) }))
/** id ทึบของ blob V1+V2 ที่ "ยังมีอยู่จริง" ของเจ้าของ — ใช้ตรวจว่า frozen inventory ไม่ถูกลบออกนอกช่องทาง (เช่น operator ลบใน SQL) */
const liveInventoryKeys = async (u) => {
  const [v1, v2] = await Promise.all([listVaultBlobs(u), listVaultV2Blobs(u)])
  return new Set([...v1.map((b) => refKey({ formatVersion: 1, id: String(b.id) })), ...v2.map((b) => refKey({ formatVersion: 2, id: String(b.id) }))])
}

export async function listFrozenInventory(userId, frozenInventoryId, { client = null } = {}) {
  const u = uid(userId)
  if (usingPostgres) {
    const q = client ? client.query.bind(client) : query
    const { rows } = await q(`SELECT blob_format_version, blob_id FROM vault_tree_frozen_inventory WHERE user_id = $1 AND frozen_inventory_id = $2 ORDER BY blob_format_version, blob_id`, [u, String(frozenInventoryId)])
    return rows.map((r) => ({ formatVersion: Number(r.blob_format_version), id: r.blob_id }))
  }
  return clone(mem.frozen.get(u)?.get(frozenInventoryId) ?? [])
}

/**
 * FLAT → MIGRATING_TREE_V1: lease ใหม่, epoch+1, แช่แข็ง inventory ที่ route ส่งมา (อ่านจาก listVaultInventory ใน request เดียวกัน)
 * @returns {Promise<{ok:true, leaseId, epoch, expiresAt, frozenInventoryId}|{ok:false, code, protocolState}>}
 */
export async function beginMigration(userId, { leaseMs, inventory, now = nowMs() }) {
  const u = uid(userId)
  const refs = normRefs(inventory)
  const leaseId = newLeaseId(), frozenInventoryId = newOpaqueId(), digest = inventoryDigest(refs), expiresAt = now + leaseMs
  if (usingPostgres) {
    return txn(async (c) => {
      await c.query(`INSERT INTO vault_tree_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u])
      const { rows } = await c.query(`SELECT protocol_state FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      if (rows[0].protocol_state !== 'FLAT') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: rows[0].protocol_state }
      for (const r of refs) await c.query(`INSERT INTO vault_tree_frozen_inventory (user_id, frozen_inventory_id, blob_format_version, blob_id) VALUES ($1,$2,$3,$4)`, [u, frozenInventoryId, r.formatVersion, r.id])
      const { rows: st } = await c.query(
        `UPDATE vault_tree_state SET protocol_state = 'MIGRATING_TREE_V1', migration_lease_id = $2, migration_lease_epoch = migration_lease_epoch + 1,
                migration_lease_expires_at = $3, frozen_inventory_id = $4, frozen_inventory_digest = $5, updated_at = now()
          WHERE user_id = $1 RETURNING migration_lease_epoch`,
        [u, leaseId, new Date(expiresAt), frozenInventoryId, digest],
      )
      return { ok: true, leaseId, epoch: Number(st[0].migration_lease_epoch), expiresAt, frozenInventoryId }
    })
  }
  const st = memState(u)
  if (st.protocolState !== 'FLAT') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: st.protocolState }
  if (!mem.frozen.has(u)) mem.frozen.set(u, new Map())
  mem.frozen.get(u).set(frozenInventoryId, refs)
  Object.assign(st, { protocolState: 'MIGRATING_TREE_V1', migrationLeaseId: leaseId, migrationLeaseEpoch: st.migrationLeaseEpoch + 1, migrationLeaseExpiresAt: expiresAt, frozenInventoryId, frozenInventoryDigest: digest, updatedAt: now })
  return { ok: true, leaseId, epoch: st.migrationLeaseEpoch, expiresAt, frozenInventoryId }
}

/** MIGRATING_TREE_V1 + lease หมดอายุแล้วเท่านั้น → lease ใหม่ epoch+1 บน inventory ที่แช่แข็งเดิม (รั้วยังปิด) */
export async function takeoverMigration(userId, { leaseMs, now = nowMs() }) {
  const u = uid(userId)
  const leaseId = newLeaseId(), expiresAt = now + leaseMs
  if (usingPostgres) {
    return txn(async (c) => {
      const { rows } = await c.query(`SELECT * FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      if (!rows.length || rows[0].protocol_state !== 'MIGRATING_TREE_V1') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: rows[0]?.protocol_state ?? 'FLAT' }
      const heldUntil = ts(rows[0].migration_lease_expires_at)
      if (heldUntil > now) return { ok: false, code: STORE_CODE.TREE_LEASE_HELD, expiresAt: heldUntil }
      const { rows: st } = await c.query(
        `UPDATE vault_tree_state SET migration_lease_id = $2, migration_lease_epoch = migration_lease_epoch + 1, migration_lease_expires_at = $3, updated_at = now()
          WHERE user_id = $1 RETURNING migration_lease_epoch, frozen_inventory_id`,
        [u, leaseId, new Date(expiresAt)],
      )
      return { ok: true, leaseId, epoch: Number(st[0].migration_lease_epoch), expiresAt, frozenInventoryId: st[0].frozen_inventory_id }
    })
  }
  const st = mem.state.get(u)
  if (!st || st.protocolState !== 'MIGRATING_TREE_V1') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: st?.protocolState ?? 'FLAT' }
  if (st.migrationLeaseExpiresAt > now) return { ok: false, code: STORE_CODE.TREE_LEASE_HELD, expiresAt: st.migrationLeaseExpiresAt }
  Object.assign(st, { migrationLeaseId: leaseId, migrationLeaseEpoch: st.migrationLeaseEpoch + 1, migrationLeaseExpiresAt: expiresAt, updatedAt: now })
  return { ok: true, leaseId, epoch: st.migrationLeaseEpoch, expiresAt, frozenInventoryId: st.frozenInventoryId }
}

/**
 * การย้อนกลับที่แคบและพิสูจน์ได้: MIGRATING_TREE_V1 + ไม่เคยมี head + tree_mutation_count = 0
 * + (lease หมดอายุ หรือ leaseId ตรงกับ lease ปัจจุบัน) → FLAT: ล้างฟิลด์ migration, ลบแถว frozen inventory, epoch คงไว้
 * TREE_V1 ไม่มีวันย้อนกลับ
 */
export async function abandonMigration(userId, { leaseId, now = nowMs() }) {
  const u = uid(userId)
  const may = (st) => Boolean(st) && st.protocolState === 'MIGRATING_TREE_V1' && !st.headEverCommitted && st.treeMutationCount === 0
    && (st.migrationLeaseExpiresAt <= now || (typeof leaseId === 'string' && leaseId.length > 0 && leaseId === st.migrationLeaseId))
  if (usingPostgres) {
    return txn(async (c) => {
      const { rows } = await c.query(`SELECT * FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      const st = rows.length ? mapState(rows[0]) : null
      const { rows: heads } = await c.query(`SELECT 1 FROM vault_tree_heads WHERE user_id = $1`, [u])
      if (!may(st) || heads.length) return { ok: false, code: STORE_CODE.TREE_ABANDON_FORBIDDEN, protocolState: st?.protocolState ?? 'FLAT' }
      await c.query(`DELETE FROM vault_tree_frozen_inventory WHERE user_id = $1`, [u])
      await c.query(`UPDATE vault_tree_state SET protocol_state = 'FLAT', migration_lease_id = NULL, migration_lease_expires_at = NULL, frozen_inventory_id = NULL, frozen_inventory_digest = NULL, updated_at = now() WHERE user_id = $1`, [u])
      return { ok: true, protocolState: 'FLAT' }
    })
  }
  const st = mem.state.get(u) ?? null
  if (!may(st) || mem.heads.has(u)) return { ok: false, code: STORE_CODE.TREE_ABANDON_FORBIDDEN, protocolState: st?.protocolState ?? 'FLAT' }
  mem.frozen.delete(u)
  Object.assign(st, { protocolState: 'FLAT', migrationLeaseId: null, migrationLeaseExpiresAt: null, frozenInventoryId: null, frozenInventoryDigest: null, updatedAt: now })
  return { ok: true, protocolState: 'FLAT' }
}

/**
 * Genesis อะตอมมิก: ตรวจ lease/epoch/หมดอายุ (TREE_LEASE_STALE) → ตรวจ frozen inventory id + digest ของแถวที่แช่แข็งไว้
 * (TREE_INVENTORY_MISMATCH) → _applyGenesis (ซองกุญแจ, revision g1 HEAD_COMMITTED, head, โปรโมต blob ที่แช่แข็ง "เป๊ะ",
 * TREE_V1 + ล้างฟิลด์ migration + ลบแถว frozen) ใน transaction เดียว — ไม่มี genesis ครึ่งเดียว
 * idempotency: key ของ genesis = key ที่ stage revision g1; replay ด้วย key เดิมหลัง TREE_V1 → ผลลัพธ์เดิม; key อื่น → TREE_STATE_CONFLICT
 */
// ⚠️ ส่ง userId ดั้งเดิม (ไม่ stringify): store เก่าในโหมดหน่วยความจำเทียบ userId แบบเข้มงวดตามชนิดที่ route ให้มา
const frozenStillLive = async (userId, frozen) => { const live = await liveInventoryKeys(userId); return frozen.every((r) => live.has(refKey(r))) }
export async function commitGenesis(userId, { leaseId, epoch, frozenInventoryId, treeId, ownerScopeIdB64, keyEnvelope, revisionId, idempotencyKey, now = nowMs() }) {
  const u = uid(userId)
  const settled = (st, head, rev) => {
    const replay = st.protocolState === 'TREE_V1' && head && head.generation === 1 && head.treeId === treeId && head.revisionId === revisionId
      && rev && rev.userId === u && rev.idempotencyKey === idempotencyKey
    return replay
      ? { ok: true, replay: true, treeId, generation: 1, revisionId, protocolState: 'TREE_V1' }
      : { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: st.protocolState }
  }
  const stale = (st) => st.migrationLeaseId !== leaseId || st.migrationLeaseEpoch !== Number(epoch) || st.migrationLeaseExpiresAt <= now
  const revOk = (rev) => rev && rev.userId === u && rev.state === 'PUBLISHED' && rev.generation === 1 && rev.treeId === treeId && rev.idempotencyKey === idempotencyKey
  if (usingPostgres) {
    return txn(async (c) => {
      const { rows } = await c.query(`SELECT * FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      if (!rows.length) return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: 'FLAT' }
      const st = mapState(rows[0])
      const { rows: rv } = await c.query(`SELECT * FROM vault_tree_revisions WHERE revision_id = $1 AND user_id = $2 FOR UPDATE`, [revisionId, u])
      const rev = rv.length ? mapRevision(rv[0]) : null
      if (st.protocolState !== 'MIGRATING_TREE_V1') {
        const { rows: hd } = await c.query(`SELECT * FROM vault_tree_heads WHERE user_id = $1`, [u])
        return settled(st, hd.length ? mapHead(hd[0]) : null, rev)
      }
      if (stale(st)) return { ok: false, code: STORE_CODE.TREE_LEASE_STALE }
      if (st.frozenInventoryId !== frozenInventoryId) return { ok: false, code: STORE_CODE.TREE_INVENTORY_MISMATCH }
      const frozen = await listFrozenInventory(u, frozenInventoryId, { client: c })
      if (inventoryDigest(frozen) !== st.frozenInventoryDigest || !(await frozenStillLive(userId, frozen))) return { ok: false, code: STORE_CODE.TREE_INVENTORY_MISMATCH }
      if (!revOk(rev)) return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED }
      await _applyGenesis(c, u, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs: frozen, now })
      return { ok: true, replay: false, treeId, generation: 1, revisionId, protocolState: 'TREE_V1' }
    })
  }
  const st = mem.state.get(u)
  if (!st) return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT, protocolState: 'FLAT' }
  const rev = mem.revisions.get(revisionId) ?? null
  if (st.protocolState !== 'MIGRATING_TREE_V1') return settled(st, mem.heads.get(u) ?? null, rev)
  if (stale(st)) return { ok: false, code: STORE_CODE.TREE_LEASE_STALE }
  if (st.frozenInventoryId !== frozenInventoryId) return { ok: false, code: STORE_CODE.TREE_INVENTORY_MISMATCH }
  const frozen = await listFrozenInventory(u, frozenInventoryId)
  if (inventoryDigest(frozen) !== st.frozenInventoryDigest || !(await frozenStillLive(userId, frozen))) return { ok: false, code: STORE_CODE.TREE_INVENTORY_MISMATCH }
  if (!revOk(rev)) return { ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED }
  try { await _applyGenesis(null, u, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs: frozen, now }) } catch (e) { if (e instanceof Abort) return e.result; throw e }
  return { ok: true, replay: false, treeId, generation: 1, revisionId, protocolState: 'TREE_V1' }
}

/** ชุดทดสอบเท่านั้น: ทำให้ lease ปัจจุบันหมดอายุทันที (จำลองเวลาเดินโดยไม่ต้องรอ) */
export async function __expireLeaseForTests(userId) {
  const u = uid(userId)
  if (usingPostgres) { await query(`UPDATE vault_tree_state SET migration_lease_expires_at = now() - interval '1 second' WHERE user_id = $1 AND protocol_state = 'MIGRATING_TREE_V1'`, [u]); return }
  const st = mem.state.get(u); if (st && st.protocolState === 'MIGRATING_TREE_V1') st.migrationLeaseExpiresAt = nowMs() - 1_000
}

// ── genesis writer (shared by Task 3.1 commitGenesis and the test seed) ─────
// เขียนซองกุญแจ + revision HEAD_COMMITTED (generation 1) + head + โปรโมต blob ที่ระบุเป็น TREE_MANAGED
// + state TREE_V1 (ล้างฟิลด์ migration ทุกตัว, เก็บ epoch) ใน transaction เดียว
export async function _applyGenesis(c, u, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs, now = nowMs() }) {
  if (usingPostgres) {
    await c.query(
      `INSERT INTO vault_tree_key_envelope (user_id, tree_id, owner_scope_id_b64, primary_wrapped_trk_b64, primary_wrap_iv_b64, recovery_wrapped_trk_b64, recovery_wrap_iv_b64)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u, treeId, ownerScopeIdB64, keyEnvelope.primary.wrappedTrkB64, keyEnvelope.primary.wrapIvB64, keyEnvelope.recovery.wrappedTrkB64, keyEnvelope.recovery.wrapIvB64],
    )
    const { rowCount } = await c.query(`UPDATE vault_tree_revisions SET state = 'HEAD_COMMITTED', committed_at = now() WHERE revision_id = $1 AND user_id = $2 AND state = 'PUBLISHED' AND generation = 1 AND tree_id = $3`, [revisionId, u, treeId])
    if (rowCount !== 1) throw new Abort({ ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED })
    await c.query(`INSERT INTO vault_tree_heads (user_id, tree_id, revision_id, generation) VALUES ($1,$2,$3,1)`, [u, treeId, revisionId])
    for (const ref of blobRefs) {
      await c.query(
        `INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle, attached_generation) VALUES ($1,$2,$3,'TREE_MANAGED',1)
         ON CONFLICT (user_id, blob_format_version, blob_id) DO UPDATE SET lifecycle = 'TREE_MANAGED', attached_generation = 1, updated_at = now()`,
        [u, ref.formatVersion, String(ref.id)],
      )
    }
    await c.query(`DELETE FROM vault_tree_frozen_inventory WHERE user_id = $1`, [u])
    await c.query(
      `UPDATE vault_tree_state SET protocol_state = 'TREE_V1', head_ever_committed = true,
              migration_lease_id = NULL, migration_lease_expires_at = NULL, frozen_inventory_id = NULL, frozen_inventory_digest = NULL,
              updated_at = now()
        WHERE user_id = $1`,
      [u],
    )
    return
  }
  const rev = mem.revisions.get(revisionId)
  if (!rev || rev.userId !== u || rev.state !== 'PUBLISHED' || rev.generation !== 1 || rev.treeId !== treeId) throw new Abort({ ok: false, code: STORE_CODE.TREE_REVISION_NOT_PUBLISHED })
  mem.envelope.set(u, { userId: u, treeId, ownerScopeIdB64, keyEnvelopeVersion: 1, envelopeCasVersion: 1, primary: { ...keyEnvelope.primary }, recovery: { ...keyEnvelope.recovery } })
  rev.state = 'HEAD_COMMITTED'; rev.committedAt = now
  mem.heads.set(u, { userId: u, treeId, revisionId, generation: 1, updatedAt: now })
  const blobs = memBlobMap(u)
  for (const ref of blobRefs) {
    const key = refKey({ formatVersion: ref.formatVersion, id: String(ref.id) })
    const row = blobs.get(key) ?? { userId: u, formatVersion: Number(ref.formatVersion), id: String(ref.id), createdAt: now, purgeId: null }
    Object.assign(row, { lifecycle: 'TREE_MANAGED', attachedGeneration: 1, updatedAt: now })
    blobs.set(key, row)
  }
  mem.frozen.delete(u)
  const st = memState(u)
  Object.assign(st, { protocolState: 'TREE_V1', headEverCommitted: true, migrationLeaseId: null, migrationLeaseExpiresAt: null, frozenInventoryId: null, frozenInventoryDigest: null, updatedAt: now })
}

/**
 * ชุดทดสอบเท่านั้น: สร้าง tree ที่ TREE_V1 โดยตรง (ข้าม lease) — ใช้ตั้ง fixture ให้เทสต์ของ head/CAS/route
 * revision ต้องถูกสร้างและ publish ผ่าน createRevision/markRevisionPublished ก่อน
 */
export async function __seedTreeV1ForTests(userId, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs = [] }) {
  const u = uid(userId)
  if (usingPostgres) {
    return txn(async (c) => {
      await c.query(`INSERT INTO vault_tree_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u])
      const { rows } = await c.query(`SELECT protocol_state FROM vault_tree_state WHERE user_id = $1 FOR UPDATE`, [u])
      if (rows[0].protocol_state !== 'FLAT') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT }
      await _applyGenesis(c, u, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs })
      return { ok: true }
    })
  }
  const st = memState(u)
  if (st.protocolState !== 'FLAT') return { ok: false, code: STORE_CODE.TREE_STATE_CONFLICT }
  try { await _applyGenesis(null, u, { treeId, ownerScopeIdB64, keyEnvelope, revisionId, blobRefs }) } catch (e) { if (e instanceof Abort) return e.result; throw e }
  return { ok: true }
}

/**
 * ชุดทดสอบเท่านั้น: ตั้งสถานะโปรโตคอลของเจ้าของโดยตรง (เติมฟิลด์ที่ invariant ของแต่ละสถานะบังคับ)
 * ใช้พิสูจน์ด่านกั้น route เก่าโดยไม่ต้องเดินขั้นตอน lease/genesis ทั้งชุด
 */
export async function __setProtocolStateForTests(userId, protocolState, { leaseMs = 60_000 } = {}) {
  const u = uid(userId)
  const fields = protocolState === 'FLAT'
    ? { migrationLeaseId: null, migrationLeaseExpiresAt: null, frozenInventoryId: null, frozenInventoryDigest: null, headEverCommitted: false }
    : protocolState === 'MIGRATING_TREE_V1'
      ? { migrationLeaseId: 'test-lease', migrationLeaseExpiresAt: nowMs() + leaseMs, frozenInventoryId: 'test-inventory', frozenInventoryDigest: '0'.repeat(64), headEverCommitted: false }
      : { migrationLeaseId: null, migrationLeaseExpiresAt: null, frozenInventoryId: null, frozenInventoryDigest: null, headEverCommitted: true }
  if (usingPostgres) {
    await query(`INSERT INTO vault_tree_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u])
    await query(
      `UPDATE vault_tree_state SET protocol_state = $2, migration_lease_id = $3, migration_lease_expires_at = $4, frozen_inventory_id = $5,
              frozen_inventory_digest = $6, head_ever_committed = $7, updated_at = now() WHERE user_id = $1`,
      [u, protocolState, fields.migrationLeaseId, fields.migrationLeaseExpiresAt === null ? null : new Date(fields.migrationLeaseExpiresAt), fields.frozenInventoryId, fields.frozenInventoryDigest, fields.headEverCommitted],
    )
    return
  }
  Object.assign(memState(u), { protocolState, ...fields, updatedAt: nowMs() })
}

/** ล้าง state ของ tree ทั้งหมด — ชุดทดสอบเท่านั้น (DELETE ไม่ใช่ TRUNCATE: drive_app มีแค่ DML) */
export async function __resetVaultTreeForTests() {
  if (usingPostgres) {
    await query('DELETE FROM vault_tree_purge_candidates')
    await query('DELETE FROM vault_tree_blob_state')
    await query('DELETE FROM vault_tree_heads')
    await query(`UPDATE vault_tree_revisions SET state = 'ORPHANED', retired_at = now() WHERE state IN ('CREATED','PUBLISHED')`)
    // committed rows cannot be deleted by design; retire them through the allowed edges first
    await query(`UPDATE vault_tree_revisions SET state = 'NON_RECOVERABLE', retired_at = now() WHERE state IN ('HEAD_COMMITTED','SUPERSEDED')`)
    await query(`UPDATE vault_tree_revisions SET state = 'FORENSIC_DELETED', retired_at = now() WHERE state = 'NON_RECOVERABLE'`)
    await query('DELETE FROM vault_tree_revisions')
    await query('DELETE FROM vault_tree_key_envelope')
    await query('DELETE FROM vault_tree_frozen_inventory')
    await query('DELETE FROM vault_tree_state')
    return
  }
  for (const m of Object.values(mem)) m.clear()
}
