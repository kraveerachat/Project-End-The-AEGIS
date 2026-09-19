// src/lib/vaultTreeMigration.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · client genesis migration
//
// แผนการย้าย FLAT → TREE_V1 ทั้งหมดเกิดฝั่ง client เท่านั้น (Architecture B):
//   planMigration    ถอด metadata ของทุกซองด้วย KEK → entries รายโหนด + กลุ่มชื่อชนกัน (ไม่มีการเดาชื่อ)
//   resolveCollisions ผู้ใช้ตั้งชื่อใหม่เองเท่านั้น — ไม่มีตัวสร้างชื่ออัตโนมัติในไฟล์นี้เด็ดขาด
//   runGenesis       begin/lease → plan จาก frozen blobs → TRK + slots → genesis manifest
//                    → publish revision → PUT ciphertext → commitGenesis
//
// ⚠️ เส้นทางนี้ไม่เข้ารหัส/อัปโหลดเนื้อหาไฟล์ใหม่ และไม่ลบ blob ใด ๆ — ciphertext เดิมคงเดิมทุกไบต์
//    (PM-9/PM-10) ทุกขั้นตอน fail closed: ล้มกลางทางแล้วเซิร์ฟเวอร์ยังอยู่ FLAT พร้อม lease ให้เริ่มใหม่
// ⚠️ ไม่มี cache, ไม่มี storage, ไม่มี log ของ plaintext ในไฟล์นี้

import { decryptBlobMeta } from './vaultCrypto.js'
import { decryptVaultV2Meta } from './vaultChunkCrypto.js'
import { generateTrkBytes, importTrk, wrapTrkSlots } from './vaultTreeKeys.js'
import { createGenesisManifest, collisionKey, nameProblem } from './vaultTreeManifest.js'
import { encryptManifestRevision } from './vaultTreeManifestCrypto.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'
import { treeApiErrorFrom } from './vaultTreeApi.js'

const ID_RE = /^[A-Za-z0-9_-]{22}$/

export class MigrationError extends Error {
  /** @param {'ENVELOPE_UNDECRYPTABLE'|'COLLISION_UNRESOLVED'|'LEASE_STALE'|'INVENTORY_MISMATCH'|'BOUNDS'|'ABORTED'|'TREE_STATE_CONFLICT'} code */
  constructor(code, details = {}, message = undefined) {
    super(message ?? code)
    this.name = 'MigrationError'
    this.code = code
    Object.assign(this, details)
  }
}

/** id 22 ตัวอักษร base64url จากความสุ่ม 16 ไบต์ (เหมือนฝั่ง product) — ใช้กับ tree/ownerScope/root/revision */
function randomTreeId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function computeCollisions(entries) {
  const groups = new Map()
  for (const e of entries) {
    const key = collisionKey(e.name)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  const out = []
  for (const key of [...groups.keys()].sort()) {
    const members = groups.get(key)
    if (members.length > 1) out.push({ key, entries: members })
  }
  return out
}

/**
 * ถอด metadata ของซองทุกใบ (V1/V2) ด้วย KEK → แผนรายโหนด
 * - ซองใดพิสูจน์ไม่ผ่าน → ENVELOPE_UNDECRYPTABLE พร้อม opaque blob id; ไม่คืนแผนบางส่วน
 * - ขอบเขต (จำนวนโหนด/ความยาวชื่อ) ตรวจก่อนยิงเน็ตเวิร์กใด ๆ
 * @returns {Promise<{entries:Array, collisions:Array, blobIds:Array, limits:object}>}
 */
export async function planMigration({ kek, inventory, limits = VAULT_TREE_CLIENT_LIMITS }) {
  if (!Array.isArray(inventory)) throw new MigrationError('BOUNDS', { reason: 'INVENTORY_NOT_LIST' })
  if (inventory.length > limits.maxNodes) throw new MigrationError('BOUNDS', { reason: 'LIMIT_NODES', count: inventory.length })
  const entries = []
  const blobIds = []
  for (const blob of inventory) {
    const blobId = blob?.id ?? null
    let meta
    try {
      if (blob?.formatVersion === 1) meta = await decryptBlobMeta(kek, blob)
      else if (blob?.formatVersion === 2) meta = await decryptVaultV2Meta(kek, blob)
      else throw new Error('unsupported formatVersion')
    } catch {
      throw new MigrationError('ENVELOPE_UNDECRYPTABLE', { blobId })
    }
    const name = typeof meta?.name === 'string' ? meta.name : ''
    const problem = nameProblem(name, limits)
    if (problem) throw new MigrationError('BOUNDS', { blobId, reason: problem })
    entries.push({
      name,
      mediaType: typeof meta.type === 'string' ? meta.type : '',
      plainSize: Number.isSafeInteger(meta.plainSize) ? meta.plainSize : Number.isSafeInteger(meta.size) ? meta.size : null,
      blobRef: { formatVersion: blob.formatVersion, id: blobId },
    })
    blobIds.push(blobId)
  }
  return { entries, collisions: computeCollisions(entries), blobIds, limits }
}

/**
 * ใช้ชื่อที่ผู้ใช้พิมพ์เองกับ entry ที่ส่งมาใน decisions (Map: entry → ชื่อใหม่)
 * ไม่เคยเปลี่ยนชื่อเอง — ชื่อใหม่ผ่าน nameProblem ไม่ได้ → BOUNDS; ถ้ายังชนกันอยู่ กลุ่มจะคงอยู่
 * ให้ runGenesis ปฏิเสธต่อ
 */
export function resolveCollisions(plan, decisions) {
  const limits = plan?.limits ?? VAULT_TREE_CLIENT_LIMITS
  const entries = (plan?.entries ?? []).map((e) => {
    if (!decisions || !decisions.has(e)) return e
    const name = decisions.get(e)
    const problem = nameProblem(name, limits)
    if (problem) throw new MigrationError('BOUNDS', { reason: problem })
    return { ...e, name }
  })
  return { ...plan, entries, collisions: computeCollisions(entries) }
}

function failLeaseStale(stateLease, ts) {
  throw new MigrationError('LEASE_STALE', {
    expiresAt: stateLease.expiresAt,
    retryAfterMs: Math.max(0, stateLease.expiresAt - ts),
  })
}

/** ผ่านเฉพาะคำตอบปกติ: คำตอบดิบ { ok: false } (เช่นจากเทสต์ mock) แมปเป็น TreeApiError ตรง ๆ
 * และคลี่ซอง { ok: true, data } ของ mock ออกเป็น data — คำตอบจาก vaultTreeApi จริง (data แล้ว) ผ่านทะลุ */
function responseOk(r) {
  if (r && r.ok === false) throw treeApiErrorFrom(r)
  return r && r.ok === true ? r.data : r
}

/**
 * เดิน genesis ให้จบหนึ่งรอบ:
 *   อ่าน state → เคลียร์ lease (begin / ใช้ของเรา / takeover) → แผน (จาก frozen blobs ของ lease)
 *   → TRK + wrap สอง slot → genesis manifest → publish → PUT ciphertext → commitGenesis
 * ตรวจ abort/purge ระหว่างทุกขั้น; commitGenesis ชน 409 TREE_LEASE_STALE จะโผล่ตรง ๆ (ไม่มี retry ในชั้นนี้)
 * @param {object} p
 * @param {object} p.kek KEK ที่ปลดล็อกแล้ว
 * @param {object} p.api ชุดฟังก์ชันจาก vaultTreeApi.js (ฉีดได้เพื่อเทสต์)
 * @param {object|null} [p.plan] แผนที่เตรียมไว้แล้ว (resume); ไม่ส่ง = สร้างจาก blobs ของ lease
 * @param {object|null} [p.unlockedState] ต้องมี isPurged() เมื่อส่งมา — true = ยกเลิกทันที
 * @param {AbortSignal|null} [p.signal]
 * @param {object|null} [p.lease] lease ที่เราถืออยู่ (จาก begin/takeover ครั้งก่อน)
 * @param {number|function} [p.now] เวลาปัจจุบัน (ms) — ฉีดเพื่อเทสต์
 * @returns {Promise<{treeId:string, generation:number, revisionId:string}>}
 */
export async function runGenesis({ kek, api, plan = null, unlockedState = null, signal = null, lease = null, now = Date.now() }) {
  const ts = typeof now === 'function' ? now() : now
  const chk = () => {
    if (signal?.aborted) throw new MigrationError('ABORTED')
    if (unlockedState?.isPurged?.()) throw new MigrationError('ABORTED')
  }
  chk()

  const st = responseOk(await api.getTreeState({ signal }))
  chk()
  const stateLease = st?.lease ?? null
  let leaseObj
  if (st?.protocolState === 'FLAT') {
    leaseObj = responseOk(await api.beginMigration({ signal }))
  } else if (st?.protocolState === 'MIGRATING_TREE_V1') {
    if (lease) {
      if (stateLease && stateLease.epoch > lease.epoch) failLeaseStale(stateLease, ts)
      if (!stateLease || stateLease.expiresAt <= ts) leaseObj = responseOk(await api.takeoverMigration({ signal }))
      else leaseObj = lease
    } else {
      if (stateLease && stateLease.expiresAt > ts) failLeaseStale(stateLease, ts)
      leaseObj = responseOk(await api.takeoverMigration({ signal }))
    }
  } else {
    throw new MigrationError('TREE_STATE_CONFLICT', { protocolState: st?.protocolState ?? null })
  }
  chk()

  let thePlan = plan
  if (!thePlan) {
    thePlan = await planMigration({ kek, inventory: leaseObj?.blobs ?? [], limits: VAULT_TREE_CLIENT_LIMITS })
  } else {
    const leaseIds = (leaseObj?.blobs ?? []).map((b) => b?.id).sort()
    const planIds = [...(thePlan.blobIds ?? [])].sort()
    if (leaseIds.length !== planIds.length || leaseIds.some((id, i) => id !== planIds[i])) {
      throw new MigrationError('INVENTORY_MISMATCH')
    }
  }
  if (thePlan.collisions.length > 0) throw new MigrationError('COLLISION_UNRESOLVED', { plan: thePlan })
  chk()

  const treeId = randomTreeId()
  const ownerScopeId = randomTreeId()
  const rootNodeId = randomTreeId()
  const revisionId = randomTreeId()
  const idempotencyKey = randomTreeId()

  const trkBytes = generateTrkBytes()
  // ต้อง wrap ก่อน — wrapTrkSlots/importTrk ต่างเติมศูนย์บัฟเฟอร์ที่ได้รับ จึงให้สำเนาของตัวเองแก่ import
  const trk = await importTrk(trkBytes.slice())
  const keyEnvelope = await wrapTrkSlots(kek, trkBytes, { ownerScopeId, treeId, protocolVersion: 1, keyEnvelopeVersion: 1 })
  chk()

  const manifest = createGenesisManifest({ treeId, rootNodeId, revisionId, now: ts })
  for (const e of thePlan.entries) {
    const nodeId = randomTreeId()
    manifest.nodes.set(nodeId, {
      nodeId,
      kind: 'file',
      parentNodeId: rootNodeId,
      name: e.name,
      createdAtClient: ts,
      modifiedAtClient: ts,
      lifecycle: { state: 'active' },
      blobRef: e.blobRef,
      mediaType: e.mediaType,
      plainSize: e.plainSize,
    })
  }
  const manifestCtx = { treeId, revisionId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1 }
  const enc = await encryptManifestRevision(trk, manifest, manifestCtx, VAULT_TREE_CLIENT_LIMITS)
  chk()

  const publishMeta = {
    revisionId,
    baseRevisionId: null,
    generation: 1,
    ivB64: enc.ivB64,
    wrappedManifestDekB64: enc.wrappedManifestDekB64,
    wrapIvB64: enc.wrapIvB64,
    manifestSchemaVersion: 1,
    idempotencyKey,
  }
  responseOk(await api.publishRevision(publishMeta, { signal }))
  chk()
  responseOk(await api.putRevisionCiphertext(revisionId, enc.ciphertext, { signal }))
  chk()

  const commitBody = {
    leaseId: leaseObj.leaseId,
    epoch: leaseObj.epoch,
    frozenInventoryId: leaseObj.frozenInventoryId,
    treeId,
    ownerScopeIdB64: ownerScopeId,
    keyEnvelope,
    revision: {
      revisionId,
      ivB64: enc.ivB64,
      wrappedManifestDekB64: enc.wrappedManifestDekB64,
      wrapIvB64: enc.wrapIvB64,
      manifestSchemaVersion: 1,
    },
    idempotencyKey,
  }
  const out = responseOk(await api.commitGenesis(commitBody, { signal }))
  return { treeId: out?.treeId ?? treeId, generation: out?.generation ?? 1, revisionId: out?.revisionId ?? revisionId }
}

export { ID_RE as TREE_ID_RE }
