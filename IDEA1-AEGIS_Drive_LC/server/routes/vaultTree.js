// server/routes/vaultTree.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · opaque tree API
//
// เซิร์ฟเวอร์ในโปรโตคอลนี้เป็นแค่ "ผู้เก็บก้อนทึบ + ผู้ประสาน CAS": มันตรวจ auth, ownership,
// สถานะโปรโตคอล/flag, ขนาด, ไวยากรณ์ของ id ทึบ, idempotency และเงื่อนไข CAS เท่านั้น
// ⚠️ ไม่มี route ใดรับหรือคืนชื่อ, parent, path, MIME, node id, breadcrumb หรือโครงต้นไม้
//    (design §6, §11) และไฟล์นี้ต้องไม่ import กฎของ tree ฝั่ง client (SRV-NOIMPORT-1)
// ⚠️ ทุก 4xx/5xx ตอบ { error, code } และไม่ echo ค่าที่ client ส่งมา (นอกจาก id ทึบ)
// ⚠️ ทุก response เป็น no-store: ไม่มีอะไรในโปรโตคอลนี้ควรถูก cache
//
// Task 2.1: ประตู flag (503 TREE_PROTOCOL_DISABLED)
// Task 2.4: state / head / revisions / head CAS / key-envelope / blobs
// Task 3.1: migration begin/takeover/abandon + genesis   Task 8.1: purge/confirm

import { Router } from 'express'
import { requireAuth } from '../middleware/requireRole.js'
import { recordAudit, sha256Hex } from '../db/connection.js'
import { requestSourceIp } from '../request/sourceIp.js'
import * as tree from '../db/vaultTreeStore.js'
import { writeManifestCiphertext, openManifestCiphertext } from '../storage/vaultManifestStore.js'
import { listVaultInventory } from '../db/vaultInventory.js'

/** รหัสข้อผิดพลาดของ tree API */
export const TREE_ERROR = Object.freeze({
  TREE_PROTOCOL_DISABLED: 'TREE_PROTOCOL_DISABLED',
  TREE_STATE_CONFLICT: 'TREE_STATE_CONFLICT',
  TREE_MIGRATION_IN_PROGRESS: 'TREE_MIGRATION_IN_PROGRESS',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  TREE_HEAD_CONFLICT: 'TREE_HEAD_CONFLICT',
  TREE_BLOB_STATE_CONFLICT: 'TREE_BLOB_STATE_CONFLICT',
  TREE_ENVELOPE_CONFLICT: 'TREE_ENVELOPE_CONFLICT',
  TREE_IDEMPOTENCY_MISMATCH: 'TREE_IDEMPOTENCY_MISMATCH',
  TREE_REVISION_NOT_PUBLISHED: 'TREE_REVISION_NOT_PUBLISHED',
  TREE_REVISION_NON_RECOVERABLE: 'TREE_REVISION_NON_RECOVERABLE',
  TREE_MANIFEST_TOO_LARGE: 'TREE_MANIFEST_TOO_LARGE',
  TREE_PURGE_NOT_SUPPORTED: 'TREE_PURGE_NOT_SUPPORTED',
  TREE_LEASE_HELD: 'TREE_LEASE_HELD',
  TREE_LEASE_STALE: 'TREE_LEASE_STALE',
  TREE_INVENTORY_MISMATCH: 'TREE_INVENTORY_MISMATCH',
  TREE_ABANDON_FORBIDDEN: 'TREE_ABANDON_FORBIDDEN',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
})

const NO_STORE = { 'Cache-Control': 'no-store' }
const fail = (res, status, code, error = code) => res.status(status).set(NO_STORE).json({ error, code })
const ok = (res, status, body) => res.status(status).set(NO_STORE).json(body)

/** อ่าน config ที่ createApp แช่แข็งไว้ (tests inject ผ่าน createApp({ vaultTreeConfig })) */
export const treeConfigOf = (req) => req.app.get('vaultTreeConfig')

/**
 * ประตู flag: โปรโตคอลปิด (หรือสคีมาไม่พร้อม) = 503 fail-closed
 * ⚠️ ประตูนี้ "ไม่" เปิดการแก้ไขแบบ flat กลับให้ใคร — ดู requireVaultProtocolState
 */
export function requireTreeProtocol(req, res, next) {
  const cfg = treeConfigOf(req)
  if (!cfg?.flags?.schemaAvailable || !cfg?.flags?.protocolEnabled) {
    return fail(res, 503, TREE_ERROR.TREE_PROTOCOL_DISABLED, 'Private Vault tree protocol is not enabled')
  }
  return next()
}

// ── ไวยากรณ์ของค่าทึบ — ตรวจรูปแบบเท่านั้น เซิร์ฟเวอร์ตรวจเนื้อในไม่ได้และไม่ควรได้ ─────
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const isId = (v) => typeof v === 'string' && ID_RE.test(v)
const isIv = (v) => typeof v === 'string' && v.length === 16 && B64_RE.test(v)
const isB64 = (v, max = 4_096) => typeof v === 'string' && v.length > 0 && v.length <= max && B64_RE.test(v)
const isGen = (v) => Number.isSafeInteger(v) && v >= 1
const isBlobRef = (r) => r && typeof r === 'object' && (r.formatVersion === 1 || r.formatVersion === 2)
  && (typeof r.id === 'string' || Number.isSafeInteger(r.id)) && String(r.id).length > 0 && String(r.id).length <= 128
const strictKeys = (obj, allowed) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => allowed.includes(k))
const SLOT_KEYS = ['wrappedTrkB64', 'wrapIvB64']
const isSlot = (s) => strictKeys(s, SLOT_KEYS) && isB64(s.wrappedTrkB64, 256) && isIv(s.wrapIvB64)

const auditAct = (req, action, target, result = 'OK') =>
  recordAudit({
    actorId: req.user.id, actorLabel: req.user.username, role: req.user.role,
    action, targetHash: target ? sha256Hex(String(target)) : null, result, sourceIp: requestSourceIp(req),
  })

const publicEnvelope = (env) => env && ({
  ownerScopeIdB64: env.ownerScopeIdB64, keyEnvelopeVersion: env.keyEnvelopeVersion, envelopeCasVersion: env.envelopeCasVersion,
  primary: env.primary, recovery: env.recovery,
})

/**
 * ด่านกั้น route เก่า (POST/DELETE /api/vault/blobs, POST/PUT/commit ของ /api/vault/uploads) ตามสถานะโปรโตคอลของเจ้าของ
 *   - ไม่มีแถว หรือ FLAT → ผ่าน (พฤติกรรมเดิมเป๊ะ)
 *   - MIGRATING_TREE_V1 → 409 TREE_MIGRATION_IN_PROGRESS
 *   - TREE_V1 → 426 UPGRADE_REQUIRED (ถาวร)
 * Task 4.1: ครอบครัว tree-aware ใช้ด่านเดียวกันด้วย allow: ['TREE_V1'] — เมื่อ allow ไม่มี FLAT ทุกสถานะที่ไม่ผ่าน
 *   ตอบ 409 TREE_STATE_CONFLICT (รหัส MIGRATION_IN_PROGRESS/UPGRADE_REQUIRED มีความหมายเฉพาะกับการแก้ไขแบบ flat)
 * ⚠️ อ่านจาก "สถานะของเจ้าของ" ไม่ใช่จาก flag — การปิด flag ของ tree ไม่เคยเปิดการแก้ไขแบบ flat กลับ
 * ⚠️ peek ไม่สร้างแถว: route เก่าต้องไม่ทิ้งร่องรอย tree ไว้ให้เจ้าของที่ไม่เคยแตะมัน
 * ⚠️ วางหลัง requireAuth เสมอ (ต้องมี req.user)
 */
export function requireVaultProtocolState({ allow = ['FLAT'] } = {}) {
  return async (req, res, next) => {
    try {
      const st = await tree.peekTreeState(req.user.id)
      const state = st?.protocolState ?? 'FLAT'
      if (allow.includes(state)) return next()
      if (!allow.includes('FLAT')) return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Tree-aware mutation requires the encrypted hierarchy protocol state')
      if (state === 'MIGRATING_TREE_V1') return fail(res, 409, TREE_ERROR.TREE_MIGRATION_IN_PROGRESS, 'Private Vault is migrating to the encrypted hierarchy; legacy mutation is fenced')
      if (state === 'TREE_V1') return fail(res, 426, TREE_ERROR.UPGRADE_REQUIRED, 'This Private Vault uses the encrypted hierarchy; legacy mutation is no longer available')
      return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT)
    } catch (err) { return next(err) }
  }
}

export const vaultTreeRouter = Router()
vaultTreeRouter.use(requireAuth, requireTreeProtocol)

/** ประตู flag ชั้นที่สอง: การย้าย/genesis ปิดอยู่ = 503 fail-closed (flag นี้ต่อจาก protocolEnabled — ดู vaultTreeConfigFromEnv) */
function requireGenesisMigration(req, res, next) {
  if (!treeConfigOf(req)?.flags?.genesisMigrationEnabled) return fail(res, 503, TREE_ERROR.TREE_PROTOCOL_DISABLED, 'Private Vault genesis migration is not enabled')
  return next()
}

// ── state ────────────────────────────────────────────────────────────────────
vaultTreeRouter.get('/state', async (req, res, next) => {
  try {
    const cfg = treeConfigOf(req)
    const st = await tree.getTreeState(req.user.id)
    const head = st.protocolState === 'TREE_V1' ? await tree.getHead(req.user.id) : null
    return ok(res, 200, {
      protocolState: st.protocolState,
      minProtocolVersion: st.minProtocolVersion,
      protocolVersion: cfg.protocolVersion,
      flags: { ...cfg.flags },
      lease: st.migrationLeaseId ? { held: st.migrationLeaseExpiresAt > Date.now(), expiresAt: st.migrationLeaseExpiresAt, epoch: st.migrationLeaseEpoch } : null,
      head: head ? { treeId: head.treeId, revisionId: head.revisionId, generation: head.generation } : null,
      purgeBarrierGeneration: st.purgeBarrierGeneration,
    })
  } catch (err) { return next(err) }
})

// ── head ─────────────────────────────────────────────────────────────────────
vaultTreeRouter.get('/head', async (req, res, next) => {
  try {
    const st = await tree.getTreeState(req.user.id)
    if (st.protocolState !== 'TREE_V1') return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'No tree head in this protocol state')
    const [head, env] = await Promise.all([tree.getHead(req.user.id), tree.getKeyEnvelope(req.user.id)])
    if (!head || !env) return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Tree head unavailable')
    const rev = await tree.getRevision(req.user.id, head.revisionId)
    if (!rev) return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Head revision unavailable')
    return ok(res, 200, {
      treeId: head.treeId, revisionId: rev.revisionId, baseRevisionId: rev.baseRevisionId, generation: head.generation,
      ivB64: rev.ivB64, wrappedManifestDekB64: rev.wrappedManifestDekB64, wrapIvB64: rev.wrapIvB64,
      manifestSchemaVersion: rev.manifestSchemaVersion, ciphertextSize: rev.ciphertextSize,
      purgeBarrierGeneration: st.purgeBarrierGeneration,
      keyEnvelope: publicEnvelope(env),
    })
  } catch (err) { return next(err) }
})

// ── revisions ────────────────────────────────────────────────────────────────
const REVISION_KEYS = ['revisionId', 'baseRevisionId', 'generation', 'ivB64', 'wrappedManifestDekB64', 'wrapIvB64', 'manifestSchemaVersion', 'idempotencyKey', 'treeId']

vaultTreeRouter.post('/revisions', async (req, res, next) => {
  try {
    const b = req.body
    if (!strictKeys(b, REVISION_KEYS) || !isId(b.revisionId) || !isId(b.idempotencyKey) || !isGen(b.generation)
      || !(b.baseRevisionId === null || isId(b.baseRevisionId)) || !isIv(b.ivB64) || !isIv(b.wrapIvB64) || !isB64(b.wrappedManifestDekB64, 256)
      || b.manifestSchemaVersion !== 1 || (b.generation === 1) !== (b.baseRevisionId === null) || (b.treeId !== undefined && !isId(b.treeId))) {
      return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Invalid revision descriptor')
    }
    const st = await tree.getTreeState(req.user.id)
    // TREE_V1 → the revision belongs to the current tree (treeId in the body, if given, must match);
    // MIGRATING_TREE_V1 → only the genesis revision (generation 1) may be staged and it must name its new treeId
    let treeId = null
    if (st.protocolState === 'TREE_V1' && b.generation > 1) {
      const head = await tree.getHead(req.user.id)
      if (b.treeId !== undefined && b.treeId !== head?.treeId) return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Revision belongs to another tree')
      treeId = head?.treeId ?? null
    } else if (st.protocolState === 'MIGRATING_TREE_V1' && b.generation === 1 && isId(b.treeId)) {
      treeId = b.treeId
    }
    if (!treeId) return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Revisions cannot be staged in this protocol state')
    const { treeId: _ignored, ...meta } = b
    const r = await tree.createRevision(req.user.id, { ...meta, treeId })
    if (!r.ok) return fail(res, 409, r.code)
    await auditAct(req, 'VAULT_TREE_REVISION_STAGE', r.revision.revisionId)
    return ok(res, r.replay ? 200 : 201, { revisionId: r.revision.revisionId, state: r.revision.state })
  } catch (err) { return next(err) }
})

/** raw ciphertext — เพดานจาก config (ไม่ใช่ 16 KiB ของ JSON ทั่วไป) และบังคับซ้ำระหว่างสตรีมใน storage */
vaultTreeRouter.put('/revisions/:revisionId/ciphertext', (req, res, next) => {
  const limit = treeConfigOf(req).limits.maxManifestCiphertextBytes
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return fail(res, 413, TREE_ERROR.TREE_MANIFEST_TOO_LARGE)
  return next()
}, async (req, res, next) => {
  try {
    const { revisionId } = req.params
    if (!isId(revisionId)) return fail(res, 400, TREE_ERROR.INVALID_INPUT)
    if (!/^application\/octet-stream\b/.test(String(req.headers['content-type'] ?? ''))) return fail(res, 415, TREE_ERROR.INVALID_INPUT, 'Expected application/octet-stream')
    const rev = await tree.getRevision(req.user.id, revisionId)
    if (!rev) return fail(res, 404, TREE_ERROR.NOT_FOUND)
    if (rev.state !== 'CREATED') return fail(res, 409, TREE_ERROR.TREE_REVISION_NOT_PUBLISHED, 'Revision ciphertext already published')
    let written
    try {
      written = await writeManifestCiphertext(req, { limitBytes: treeConfigOf(req).limits.maxManifestCiphertextBytes })
    } catch (e) {
      if (e?.code === 'TREE_MANIFEST_TOO_LARGE') return fail(res, 413, TREE_ERROR.TREE_MANIFEST_TOO_LARGE)
      throw e
    }
    const r = await tree.markRevisionPublished(req.user.id, revisionId, { storageKey: written.storageKey, ciphertextSize: written.size, sha256: written.sha256 })
    if (!r.ok) return fail(res, 409, r.code)
    await auditAct(req, 'VAULT_TREE_REVISION_PUBLISH', revisionId)
    return ok(res, 200, { revisionId, state: 'PUBLISHED', ciphertextSize: written.size })
  } catch (err) { return next(err) }
})

vaultTreeRouter.get('/revisions/:revisionId', async (req, res, next) => {
  try {
    const { revisionId } = req.params
    if (!isId(revisionId)) return fail(res, 400, TREE_ERROR.INVALID_INPUT)
    const rev = await tree.getRevision(req.user.id, revisionId)
    if (!rev) return fail(res, 404, TREE_ERROR.NOT_FOUND)
    if (rev.nonRecoverable) return fail(res, 410, TREE_ERROR.TREE_REVISION_NON_RECOVERABLE)
    const st = await tree.getTreeState(req.user.id)
    if (rev.generation < st.purgeBarrierGeneration) return fail(res, 410, TREE_ERROR.TREE_REVISION_NON_RECOVERABLE)
    if (!['PUBLISHED', 'HEAD_COMMITTED', 'SUPERSEDED'].includes(rev.state) || !rev.storageKey) return fail(res, 404, TREE_ERROR.NOT_FOUND)
    const stream = openManifestCiphertext(rev.storageKey)
    if (!stream) return fail(res, 404, TREE_ERROR.NOT_FOUND)
    res.status(200).set({ ...NO_STORE, 'Content-Type': 'application/octet-stream', 'Content-Length': String(rev.ciphertextSize) })
    stream.on('error', next)
    return stream.pipe(res)
  } catch (err) { return next(err) }
})

// ── migration lease / frozen inventory / genesis (Task 3.1) ──────────────────
// เซิร์ฟเวอร์เห็นแค่ id ทึบของ blob ที่แช่แข็ง: การตั้งชื่อ/แก้ collision/สร้าง manifest เกิดบน client ทั้งหมด
// lease ที่หมดอายุ "ไม่" ปลดรั้ว route เก่า — ทางออกมีแค่ takeover (ต่อ lease) หรือ abandon (พิสูจน์ได้ว่าไม่เคยมี head)
const LEASE_RE = /^[0-9a-f]{48}$/
const isLeaseId = (v) => typeof v === 'string' && LEASE_RE.test(v)
const leaseBody = (r, blobs) => ({ leaseId: r.leaseId, epoch: r.epoch, expiresAt: r.expiresAt, frozenInventoryId: r.frozenInventoryId, blobs })
const frozenEnvelopes = async (userId, frozenInventoryId) => {
  // envelope ชุดเดียวกับ GET /api/vault แต่จำกัดเฉพาะ blob ที่ถูกแช่แข็งใน lease นี้ (blob ที่โผล่มาทีหลังไม่อยู่ใน genesis)
  const [envelopes, frozen] = await Promise.all([listVaultInventory(userId), tree.listFrozenInventory(userId, frozenInventoryId)])
  const keys = new Set(frozen.map((b) => `${b.formatVersion}:${b.id}`))
  return envelopes.filter((b) => keys.has(`${b.formatVersion}:${String(b.id)}`))
}

vaultTreeRouter.post('/migration/begin', requireGenesisMigration, async (req, res, next) => {
  try {
    if (!strictKeys(req.body ?? {}, [])) return fail(res, 400, TREE_ERROR.INVALID_INPUT)
    const inventory = await listVaultInventory(req.user.id)
    const r = await tree.beginMigration(req.user.id, { leaseMs: treeConfigOf(req).limits.migrationLeaseMs, inventory: inventory.map((b) => ({ formatVersion: b.formatVersion, id: String(b.id) })) })
    if (!r.ok) { await auditAct(req, 'VAULT_TREE_MIGRATION_BEGIN', null, 'DENIED'); return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Migration can begin only from the flat protocol state') }
    await auditAct(req, 'VAULT_TREE_MIGRATION_BEGIN', r.frozenInventoryId)
    return ok(res, 201, leaseBody(r, await frozenEnvelopes(req.user.id, r.frozenInventoryId)))
  } catch (err) { return next(err) }
})

vaultTreeRouter.post('/migration/takeover', requireGenesisMigration, async (req, res, next) => {
  try {
    if (!strictKeys(req.body ?? {}, [])) return fail(res, 400, TREE_ERROR.INVALID_INPUT)
    const r = await tree.takeoverMigration(req.user.id, { leaseMs: treeConfigOf(req).limits.migrationLeaseMs })
    if (!r.ok) {
      await auditAct(req, 'VAULT_TREE_MIGRATION_TAKEOVER', null, 'DENIED')
      if (r.code === tree.STORE_CODE.TREE_LEASE_HELD) return res.status(409).set(NO_STORE).json({ error: 'Migration lease is still held', code: TREE_ERROR.TREE_LEASE_HELD, expiresAt: r.expiresAt })
      return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'No migration to take over in this protocol state')
    }
    await auditAct(req, 'VAULT_TREE_MIGRATION_TAKEOVER', r.frozenInventoryId)
    return ok(res, 200, leaseBody(r, await frozenEnvelopes(req.user.id, r.frozenInventoryId)))
  } catch (err) { return next(err) }
})

vaultTreeRouter.post('/migration/abandon', requireGenesisMigration, async (req, res, next) => {
  try {
    const b = req.body
    if (!strictKeys(b, ['leaseId']) || !isLeaseId(b.leaseId)) return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Invalid abandon request')
    const r = await tree.abandonMigration(req.user.id, { leaseId: b.leaseId })
    if (!r.ok) { await auditAct(req, 'VAULT_TREE_MIGRATION_ABANDON', null, 'DENIED'); return fail(res, 409, TREE_ERROR.TREE_ABANDON_FORBIDDEN, 'Migration cannot be abandoned in this state') }
    await auditAct(req, 'VAULT_TREE_MIGRATION_ABANDON', null)
    return ok(res, 200, { protocolState: r.protocolState })
  } catch (err) { return next(err) }
})

const GENESIS_KEYS = ['leaseId', 'epoch', 'frozenInventoryId', 'treeId', 'ownerScopeIdB64', 'keyEnvelope', 'revision', 'idempotencyKey']
const GENESIS_REVISION_KEYS = ['revisionId', 'ivB64', 'wrappedManifestDekB64', 'wrapIvB64', 'manifestSchemaVersion']

vaultTreeRouter.post('/genesis', requireGenesisMigration, async (req, res, next) => {
  try {
    const b = req.body
    const rv = b?.revision
    if (!strictKeys(b, GENESIS_KEYS) || !isLeaseId(b.leaseId) || !isGen(b.epoch) || !isId(b.frozenInventoryId) || !isId(b.treeId) || !isId(b.ownerScopeIdB64) || !isId(b.idempotencyKey)
      || !strictKeys(b.keyEnvelope, ['primary', 'recovery']) || !isSlot(b.keyEnvelope.primary) || !isSlot(b.keyEnvelope.recovery) || b.keyEnvelope.primary.wrapIvB64 === b.keyEnvelope.recovery.wrapIvB64
      || !strictKeys(rv, GENESIS_REVISION_KEYS) || !isId(rv.revisionId) || !isIv(rv.ivB64) || !isIv(rv.wrapIvB64) || !isB64(rv.wrappedManifestDekB64, 256) || rv.manifestSchemaVersion !== 1) {
      return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Invalid genesis request')
    }
    // the staged generation-1 revision must be exactly the descriptor the client believes it published
    const staged = await tree.getRevision(req.user.id, rv.revisionId)
    if (staged && (staged.ivB64 !== rv.ivB64 || staged.wrapIvB64 !== rv.wrapIvB64 || staged.wrappedManifestDekB64 !== rv.wrappedManifestDekB64 || staged.generation !== 1 || staged.treeId !== b.treeId)) {
      return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Genesis revision descriptor does not match the staged revision')
    }
    const r = await tree.commitGenesis(req.user.id, {
      leaseId: b.leaseId, epoch: b.epoch, frozenInventoryId: b.frozenInventoryId, treeId: b.treeId, ownerScopeIdB64: b.ownerScopeIdB64,
      keyEnvelope: { primary: { ...b.keyEnvelope.primary }, recovery: { ...b.keyEnvelope.recovery } }, revisionId: rv.revisionId, idempotencyKey: b.idempotencyKey,
    })
    if (!r.ok) {
      await auditAct(req, 'VAULT_TREE_GENESIS', b.treeId, 'DENIED')
      if (r.code === tree.STORE_CODE.TREE_LEASE_STALE) return fail(res, 409, TREE_ERROR.TREE_LEASE_STALE, 'Migration lease is stale')
      if (r.code === tree.STORE_CODE.TREE_INVENTORY_MISMATCH) return fail(res, 409, TREE_ERROR.TREE_INVENTORY_MISMATCH, 'Frozen inventory no longer matches')
      if (r.code === tree.STORE_CODE.TREE_REVISION_NOT_PUBLISHED) return fail(res, 409, TREE_ERROR.TREE_REVISION_NOT_PUBLISHED, 'Genesis revision is not published')
      return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Genesis is not possible in this protocol state')
    }
    if (!r.replay) await auditAct(req, 'VAULT_TREE_GENESIS', b.treeId)
    return ok(res, 201, { treeId: r.treeId, generation: r.generation, revisionId: r.revisionId, protocolState: r.protocolState })
  } catch (err) { return next(err) }
})

// ── head CAS ─────────────────────────────────────────────────────────────────
const CAS_KEYS = ['expectedGeneration', 'expectedRevisionId', 'revisionId', 'attachBlobIds', 'purgeBlobIds', 'idempotencyKey']

vaultTreeRouter.post('/head', async (req, res, next) => {
  try {
    const cfg = treeConfigOf(req)
    const b = req.body
    const attach = b?.attachBlobIds ?? [], purge = b?.purgeBlobIds ?? []
    if (!strictKeys(b, CAS_KEYS) || !isGen(b.expectedGeneration) || !isId(b.expectedRevisionId) || !isId(b.revisionId) || !isId(b.idempotencyKey)
      || !Array.isArray(attach) || !Array.isArray(purge) || !attach.every(isBlobRef) || !purge.every(isBlobRef)) {
      return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Invalid head CAS request')
    }
    if (attach.length > cfg.limits.maxAttachBlobIdsPerCas) return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Too many attachBlobIds')
    if (purge.length > cfg.limits.maxPurgeBlobIdsPerRequest) return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Too many purgeBlobIds')
    const r = await tree.casHead(req.user.id, {
      expectedGeneration: b.expectedGeneration, expectedRevisionId: b.expectedRevisionId, revisionId: b.revisionId,
      attachBlobRefs: attach.map((x) => ({ formatVersion: x.formatVersion, id: String(x.id) })),
      purgeBlobRefs: purge.map((x) => ({ formatVersion: x.formatVersion, id: String(x.id) })),
      idempotencyKey: b.idempotencyKey,
    })
    if (!r.ok) {
      await auditAct(req, 'VAULT_TREE_HEAD_CAS', b.revisionId, 'DENIED')
      if (r.code === tree.STORE_CODE.NOT_FOUND) return fail(res, 404, TREE_ERROR.NOT_FOUND)
      if (r.code === tree.STORE_CODE.TREE_HEAD_CONFLICT) return res.status(409).set(NO_STORE).json({ error: 'Head changed', code: TREE_ERROR.TREE_HEAD_CONFLICT, currentGeneration: r.current?.generation ?? null, currentRevisionId: r.current?.revisionId ?? null })
      return fail(res, r.code === tree.STORE_CODE.TREE_PURGE_NOT_SUPPORTED ? 501 : 409, r.code)
    }
    if (!r.replay) await auditAct(req, 'VAULT_TREE_HEAD_CAS', b.revisionId)
    return ok(res, 200, { generation: r.generation, revisionId: r.revisionId, purgeBarrierGeneration: r.purgeBarrierGeneration, purgeId: r.purgeId ?? null })
  } catch (err) { return next(err) }
})

// ── key envelope CAS ─────────────────────────────────────────────────────────

vaultTreeRouter.post('/key-envelope', async (req, res, next) => {
  try {
    const b = req.body
    if (!strictKeys(b, ['expectedEnvelopeCasVersion', 'primary', 'recovery']) || !isGen(b.expectedEnvelopeCasVersion) || !isSlot(b.primary) || !isSlot(b.recovery) || b.primary.wrapIvB64 === b.recovery.wrapIvB64) {
      return fail(res, 400, TREE_ERROR.INVALID_INPUT, 'Invalid key envelope')
    }
    const st = await tree.getTreeState(req.user.id)
    if (st.protocolState !== 'TREE_V1') return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT)
    const r = await tree.casKeyEnvelope(req.user.id, { expectedEnvelopeCasVersion: b.expectedEnvelopeCasVersion, primary: b.primary, recovery: b.recovery })
    if (!r.ok) {
      await auditAct(req, 'VAULT_TREE_KEY_ENVELOPE_CAS', null, 'DENIED')
      return r.code === tree.STORE_CODE.NOT_FOUND ? fail(res, 404, TREE_ERROR.NOT_FOUND) : res.status(409).set(NO_STORE).json({ error: 'Key envelope changed', code: TREE_ERROR.TREE_ENVELOPE_CONFLICT, currentEnvelopeCasVersion: r.current })
    }
    await auditAct(req, 'VAULT_TREE_KEY_ENVELOPE_CAS', null)
    return ok(res, 200, { envelopeCasVersion: r.envelopeCasVersion })
  } catch (err) { return next(err) }
})

// ── opaque blob inventory with lifecycle ─────────────────────────────────────
// envelope ชุดเดียวกับ GET /api/vault + lifecycle ของ tree ต่อ blob (UNREFERENCED เมื่อไม่มีแถว = orphan ที่กู้ได้)
vaultTreeRouter.get('/blobs', async (req, res, next) => {
  try {
    const st = await tree.getTreeState(req.user.id)
    if (st.protocolState === 'FLAT') return fail(res, 409, TREE_ERROR.TREE_STATE_CONFLICT, 'Tree inventory exists only after the migration fence')
    const lifecycle = req.query.lifecycle === undefined ? null : String(req.query.lifecycle)
    if (lifecycle !== null && !tree.BLOB_LIFECYCLES.includes(lifecycle)) return fail(res, 400, TREE_ERROR.INVALID_INPUT)
    const [envelopes, states] = await Promise.all([listVaultInventory(req.user.id), tree.listBlobStates(req.user.id)])
    const byKey = new Map(states.map((s) => [`${s.formatVersion}:${s.id}`, s]))
    const blobs = envelopes.map((b) => {
      const s = byKey.get(`${b.formatVersion}:${String(b.id)}`)
      return { ...b, lifecycle: s?.lifecycle ?? 'UNREFERENCED', attachedGeneration: s?.attachedGeneration ?? null, orphanSince: s?.lifecycle === 'UNREFERENCED' || !s ? (s?.createdAt ?? b.createdAt ?? null) : null }
    }).filter((b) => lifecycle === null || b.lifecycle === lifecycle)
    return ok(res, 200, { blobs })
  } catch (err) { return next(err) }
})
