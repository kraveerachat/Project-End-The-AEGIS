// src/lib/vaultTreeSync.js — AEGIS Drive (IDEA1) · PR #157 Task 5.3 · the mutation protocol session
//
// หนึ่ง session = "หัวต้นไม้ที่ถอดรหัสแล้วในหน่วยความจำ + วิธีเปลี่ยนมันอย่างปลอดภัย":
//   loadHead   GET head → GET revision bytes → unwrap TRK (KEK, สองช่อง) → unwrap Manifest DEK (TRK) → decrypt → validate
//   commit     applyIntent (client) → encrypt revision ใหม่ (generation+1, base = head) → publish → put → CAS
//              CAS แพ้ → refetch head → rebaseIntent → AUTO = ลองใหม่ (ไม่เกิน limits.maxRebaseAttempts) / CONFLICT = คืนให้
//              ผู้ใช้ตัดสิน (candidate ถูกทิ้งเป็น ORPHANED ฝั่งเซิร์ฟเวอร์ ไม่มีการลบ) / ALREADY_APPLIED = สำเร็จแล้ว
//              response หาย → refetch head; head ชี้ candidate = สำเร็จ; ไม่ขยับ = replay CAS เดิมด้วย idempotencyKey เดิม
//              (ไม่เคยส่ง "ความหมาย" ซ้ำ: candidate เดิม ไบต์เดิม กุญแจเดิม)
//
// ── สิ่งที่เซิร์ฟเวอร์เห็นจากไฟล์นี้ ─────────────────────────────────────────────
//   revision descriptor ทึบ (id, generation, IV, wrapped DEK), ciphertext, และ attachBlobIds/purgeBlobIds ทึบ — เท่านั้น
//   ชื่อ, parent, node id, ปลายทางการย้าย, breadcrumb, manifest ไม่เคยอยู่ใน body ใด (NO-LEAK-5)
//
// ⚠️ ความปลอดภัยของวงจรชีวิต: session ผูกกับ unlockedState (Task 5.4) — purge = abort fetch ที่ค้าง, ทิ้ง head/manifest/
//    TRK, และ "token" ของ session ตาย: promise chain ที่ยังวิ่งอยู่จะได้ ABORTED ไม่ใช่ commit หลังล็อก (SY-9/SY-11)
// ⚠️ กุญแจเสียหนึ่งช่อง (DEGRADED) = อ่านได้ แก้ไม่ได้ จนกว่า repairKeyEnvelope() จะสำเร็จ (SY-8) — ไม่มีเส้นทาง KEK→DEK ตรง
// ⚠️ ไม่มี storage ใดในไฟล์นี้; manifest plaintext อยู่ในหน่วยความจำของ session เท่านั้น

import { TreeApiError } from './vaultTreeApi.js'
import { unwrapTrkSlots, repairTrkSlot } from './vaultTreeKeys.js'
import { encryptManifestRevision, decryptManifestRevision } from './vaultTreeManifestCrypto.js'
import { validateManifest, MANIFEST_SCHEMA_VERSION } from './vaultTreeManifest.js'
import { applyIntent, newOpaqueId, OpError } from './vaultTreeOps.js'
import { rebaseIntent } from './vaultTreeRebase.js'
import { VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

export const SYNC_ERROR = Object.freeze(['STALE_HEAD', 'REBASE_EXHAUSTED', 'CONFLICT', 'PROTOCOL_DISABLED', 'ABORTED', 'KEY_DEGRADED', 'NOT_LOADED', 'TRANSPORT'])

export class SyncError extends Error {
  constructor(code, detail = null, cause = undefined) {
    super(detail ? `${code}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : code, cause ? { cause } : undefined)
    this.name = 'SyncError'
    this.code = code
    this.detail = detail
  }
}

const PROTOCOL_VERSION = 1
const MAX_REPLAYS = 3
const isAbort = (e) => e?.name === 'AbortError' || e?.code === 'ABORTED'
const isTransportLoss = (e) => e instanceof TreeApiError && e.status === 0
const isDisabled = (e) => e instanceof TreeApiError && (e.code === 'TREE_PROTOCOL_DISABLED' || e.status === 503)

/** แปล TreeApiError/abort ให้เป็น SyncError ที่ผู้เรียกตัดสินได้ */
function syncErrorFrom(e) {
  if (e instanceof SyncError) return e
  if (isAbort(e)) return new SyncError('ABORTED', null, e)
  if (isDisabled(e)) return new SyncError('PROTOCOL_DISABLED', null, e)
  if (e instanceof TreeApiError) return new SyncError('TRANSPORT', { code: e.code, status: e.status }, e)
  return e
}

/**
 * @param {{ kek?: CryptoKey, trk?: CryptoKey, api: object, limits?: object, unlockedState?: object, now?: () => number, newId?: () => string }} p
 */
export function createTreeSession({ kek = null, trk = null, api, limits = VAULT_TREE_CLIENT_LIMITS, unlockedState = null, now = () => Date.now(), newId = newOpaqueId }) {
  if (!api) throw new Error('createTreeSession: api is required')
  if (!kek && !trk) throw new Error('createTreeSession: kek or trk is required')

  let head = null                 // { treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion, ciphertextSize, manifest, index }
  let keyStatus = trk ? 'HEALTHY' : null
  let keyBadSlot = null
  let keyUnwrap = null            // ผลของ unwrapTrkSlots (ซองเดิม) สำหรับ repair
  let keyEnvelope = null          // { ownerScopeIdB64, keyEnvelopeVersion, envelopeCasVersion, primary, recovery }
  let treeId = null
  let alive = true
  const inflight = new Set()

  const keyRef = { trk }
  unlockedState?.registerKey?.(keyRef)
  unlockedState?.registerDisposer?.(() => invalidate())

  function invalidate() {
    alive = false
    for (const c of inflight) c.abort()
    inflight.clear()
    head = null
    keyRef.trk = null
    keyUnwrap = null
  }
  const dead = () => !alive || unlockedState?.isPurged?.() === true
  const chk = () => { if (dead()) { invalidate(); throw new SyncError('ABORTED') } }

  /** AbortController ต่อหนึ่งงาน: รวม signal ภายนอก + ลงทะเบียนกับ unlocked state; ปลดเมื่อจบ */
  function scope(signal) {
    const ctrl = new AbortController()
    if (signal?.aborted) ctrl.abort()
    else signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
    inflight.add(ctrl)
    unlockedState?.registerAbort?.(ctrl)
    // guard = ตายแล้ว (purge/close) หรือถูกยกเลิก (signal) → ABORTED; ใช้หลังทุก await ในขอบเขตนี้
    const guard = () => { chk(); if (ctrl.signal.aborted) throw new SyncError('ABORTED') }
    return { signal: ctrl.signal, guard, done: () => inflight.delete(ctrl) }
  }

  const trkCtx = () => ({ ownerScopeId: keyEnvelope.ownerScopeIdB64, treeId, protocolVersion: PROTOCOL_VERSION, keyEnvelopeVersion: keyEnvelope.keyEnvelopeVersion ?? 1 })
  const revCtx = (r) => ({ treeId: r.treeId ?? treeId, revisionId: r.revisionId, baseRevisionId: r.baseRevisionId, generation: r.generation, manifestSchemaVersion: r.manifestSchemaVersion ?? MANIFEST_SCHEMA_VERSION })

  async function fetchHead(signal) {
    let h
    try { h = await api.getTreeHead({ signal }) } catch (e) { throw syncErrorFrom(e) }
    chk()
    treeId = h.treeId
    keyEnvelope = h.keyEnvelope
    if (!keyRef.trk) {
      let u
      try { u = await unwrapTrkSlots(kek, keyEnvelope, trkCtx()) } catch (e) { throw new SyncError('KEY_DEGRADED', e?.code ?? 'TRK_UNRECOVERABLE', e) }
      keyRef.trk = u.trk; keyStatus = u.status; keyBadSlot = u.badSlot; keyUnwrap = u
    }
    let bytes
    try { bytes = await api.getRevisionCiphertext(h.revisionId, { signal }) } catch (e) { throw syncErrorFrom(e) }
    chk()
    const manifest = await decryptManifestRevision(keyRef.trk, { ciphertext: bytes, ivB64: h.ivB64, wrappedManifestDekB64: h.wrappedManifestDekB64, wrapIvB64: h.wrapIvB64 }, revCtx(h), limits)
    chk()
    const { index } = validateManifest(manifest, limits)
    return { treeId: h.treeId, revisionId: h.revisionId, baseRevisionId: h.baseRevisionId, generation: h.generation, manifestSchemaVersion: h.manifestSchemaVersion ?? MANIFEST_SCHEMA_VERSION, ciphertextSize: h.ciphertextSize ?? bytes.length, manifest, index }
  }

  async function loadHead({ signal } = {}) {
    chk()
    const sc = scope(signal)
    try {
      const h = await fetchHead(sc.signal)
      sc.guard()
      head = h
      return head
    } finally { sc.done() }
  }

  /** ผลลัพธ์ของ CAS ที่สำเร็จ → head ใหม่ในหน่วยความจำ */
  function adopt(candidate, r) {
    head = { treeId, revisionId: candidate.revisionId, baseRevisionId: candidate.baseRevisionId, generation: r?.generation ?? candidate.generation, manifestSchemaVersion: MANIFEST_SCHEMA_VERSION, ciphertextSize: candidate.ciphertextSize, manifest: candidate.manifest, index: candidate.index }
  }

  async function commit(intent, { signal } = {}) {
    chk()
    if (!head) throw new SyncError('NOT_LOADED')
    if (keyStatus === 'DEGRADED') throw new SyncError('KEY_DEGRADED', keyBadSlot)
    const sc = scope(signal)
    try {
      let base = head
      let current = intent
      let rebased = 0
      let replayed = 0
      for (;;) {
        sc.guard()
        // ── apply (client-side semantics) ─────────────────────────────────────
        let applied
        try {
          applied = applyIntent(base.manifest, current, { now: now(), newNodeId: newId, limits })
        } catch (e) {
          if (e instanceof OpError && rebased > 0) return { conflict: { kind: 'CONFLICT', reason: e.code }, intent: current }
          throw e
        }
        const m = applied.manifest
        m.generation = base.generation + 1
        m.revisionId = newId()
        m.baseRevisionId = base.revisionId
        const { index } = validateManifest(m, limits)
        const ctx = { treeId, revisionId: m.revisionId, baseRevisionId: m.baseRevisionId, generation: m.generation, manifestSchemaVersion: MANIFEST_SCHEMA_VERSION }
        const enc = await encryptManifestRevision(keyRef.trk, m, ctx, limits, { skipValidation: true })
        sc.guard()
        const candidate = { revisionId: m.revisionId, baseRevisionId: m.baseRevisionId, generation: m.generation, manifest: m, index, ciphertextSize: enc.ciphertext.length }
        const idempotencyKey = newId() // สดใหม่ต่อหนึ่ง candidate (SY-6)
        const casBody = {
          expectedGeneration: base.generation, expectedRevisionId: base.revisionId, revisionId: m.revisionId,
          attachBlobIds: applied.attachBlobRefs, purgeBlobIds: applied.purgeBlobRefs, idempotencyKey,
        }
        // ── publish + put ────────────────────────────────────────────────────
        try {
          await api.publishRevision({ revisionId: m.revisionId, baseRevisionId: m.baseRevisionId, generation: m.generation, ivB64: enc.ivB64, wrappedManifestDekB64: enc.wrappedManifestDekB64, wrapIvB64: enc.wrapIvB64, manifestSchemaVersion: MANIFEST_SCHEMA_VERSION, idempotencyKey }, { signal: sc.signal })
          sc.guard()
          await api.putRevisionCiphertext(m.revisionId, enc.ciphertext, { signal: sc.signal })
        } catch (e) { throw syncErrorFrom(e) }
        sc.guard()
        // ── CAS (+ response-loss replay of the exact same candidate) ─────────
        let outcome = null   // { ok: true, r } | { ok: false, conflict: true }
        for (let replay = 0; outcome === null; replay++) {
          try {
            const r = await api.casHead(casBody, { signal: sc.signal })
            sc.guard() // ล็อกระหว่างรอคำตอบ: เซิร์ฟเวอร์อาจ apply แล้ว แต่ session นี้ต้องไม่ถือ plaintext ต่อ (SY-9)
            outcome = { ok: true, r }
          } catch (e) {
            sc.guard()
            if (e instanceof TreeApiError && e.code === 'TREE_HEAD_CONFLICT') { outcome = { ok: false }; break }
            if (!isTransportLoss(e)) throw syncErrorFrom(e)
            // response lost — เซิร์ฟเวอร์อาจ apply แล้วหรือยัง: ดูจาก head จริงเท่านั้น
            const fresh = await fetchHead(sc.signal)
            sc.guard()
            if (fresh.revisionId === candidate.revisionId) { outcome = { ok: true, r: { generation: fresh.generation, revisionId: fresh.revisionId }, recovered: true }; break }
            if (fresh.revisionId !== base.revisionId) { head = fresh; outcome = { ok: false, fresh }; break }
            if (replay + 1 >= MAX_REPLAYS) throw new SyncError('TRANSPORT', { code: e.code, replays: replay + 1 }, e)
            replayed += 1
          }
        }
        if (outcome.ok) {
          adopt(candidate, outcome.r)
          return { generation: head.generation, revisionId: head.revisionId, manifest: head.manifest, changedNodeIds: applied.changedNodeIds, nodeId: applied.changedNodeIds[0] ?? null, operationId: applied.operationId, rebased, replayed, recoveredFromResponseLoss: outcome.recovered === true }
        }
        // ── conflict: refetch, rebase, bounded retry ─────────────────────────
        const fresh = outcome.fresh ?? await fetchHead(sc.signal)
        sc.guard()
        head = fresh
        const rb = rebaseIntent(current, { baseIndex: base.index, headIndex: fresh.index, headRecentOperationIds: fresh.manifest.recentOperationIds })
        if (rb.kind === 'ALREADY_APPLIED') return { generation: fresh.generation, revisionId: fresh.revisionId, manifest: fresh.manifest, changedNodeIds: [], nodeId: null, operationId: current.operationId ?? null, rebased, replayed, alreadyApplied: true }
        if (rb.kind === 'CONFLICT') return { conflict: rb, intent: current }
        rebased += 1
        if (rebased > limits.maxRebaseAttempts) throw new SyncError('REBASE_EXHAUSTED', { attempts: rebased - 1 })
        base = fresh
        current = rb.intent
      }
    } finally { sc.done() }
  }

  async function refreshHead({ signal } = {}) {
    return loadHead({ signal })
  }

  /** ซ่อมช่องกุญแจที่เสียแล้ว CAS ซองใหม่ — เฉพาะเมื่อ DEGRADED; ซองบนเซิร์ฟเวอร์ขยับไปแล้ว → CONFLICT (ให้ loadHead ใหม่) */
  async function repairKeyEnvelope({ signal } = {}) {
    chk()
    if (keyStatus !== 'DEGRADED' || !keyUnwrap) return { envelopeCasVersion: keyEnvelope?.envelopeCasVersion ?? null, repaired: false }
    if (!kek) throw new SyncError('KEY_DEGRADED', 'repair requires the KEK')
    const sc = scope(signal)
    try {
      const repaired = await repairTrkSlot(kek, keyUnwrap, trkCtx())
      sc.guard()
      let r
      try {
        r = await api.casKeyEnvelope({ expectedEnvelopeCasVersion: keyEnvelope.envelopeCasVersion, primary: repaired.primary, recovery: repaired.recovery }, { signal: sc.signal })
      } catch (e) {
        if (e instanceof TreeApiError && e.code === 'TREE_ENVELOPE_CONFLICT') throw new SyncError('CONFLICT', { envelope: true, current: e.data?.currentEnvelopeCasVersion ?? null }, e)
        throw syncErrorFrom(e)
      }
      sc.guard()
      keyEnvelope = { ...keyEnvelope, primary: repaired.primary, recovery: repaired.recovery, envelopeCasVersion: r.envelopeCasVersion }
      keyStatus = 'HEALTHY'; keyBadSlot = null; keyUnwrap = null
      return { envelopeCasVersion: r.envelopeCasVersion, repaired: true }
    } finally { sc.done() }
  }

  function close() { invalidate() }

  return {
    loadHead, commit, refreshHead, repairKeyEnvelope, close,
    get head() { return head },
    get keyStatus() { return keyStatus },
    get keyBadSlot() { return keyBadSlot },
    get treeId() { return treeId },
    get alive() { return alive && !dead() },
  }
}
