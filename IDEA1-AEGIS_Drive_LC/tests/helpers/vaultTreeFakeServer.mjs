// tests/helpers/vaultTreeFakeServer.mjs — PR #157 · in-memory tree backend behind fetchJson/fetchBytes (route plan §"Route plan")
//
// จำลองเฉพาะสิ่งที่เซิร์ฟเวอร์จริง "รู้": head pointer, revision rows (CREATED→PUBLISHED→HEAD_COMMITTED/SUPERSEDED/ORPHANED),
// blob lifecycle, key envelope + CAS version, idempotency replay — ไม่มี manifest plaintext ไม่มีชื่อ ไม่มีโครงต้นไม้
// ใช้กับ vaultTreeApi.js จริง (ฉีด fetchJson/fetchBytes) เพื่อให้ session ถูกพิสูจน์ผ่าน wrapper จริงทั้งชุด
import { createGenesisManifest } from '../../src/lib/vaultTreeManifest.js'
import { encryptManifestRevision } from '../../src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, importTrk, wrapTrkSlots } from '../../src/lib/vaultTreeKeys.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../../src/lib/vaultTreeLimits.js'
import * as treeApi from '../../src/lib/vaultTreeApi.js'
import { randomId } from './vaultTreeFixtures.mjs'

const res = (status, data) => ({ ok: status >= 200 && status < 400, status, data, errorKind: status >= 200 && status < 400 ? null : status === 0 ? 'network' : 'server' })
const err = (status, code, extra = {}) => res(status, { error: code, code, ...extra })

/**
 * @param {{ kek: CryptoKey, limits?: object, now?: () => number }} p
 * สร้าง TREE_V1 ที่ generation 1 (genesis) ให้ทันที; คืน { fetchJson, fetchBytes, api, state, trk, hooks }
 */
export async function createFakeTreeServer({ kek, limits = VAULT_TREE_CLIENT_LIMITS, now = () => Date.now(), blobs = [] } = {}) {
  const treeId = randomId(), rootNodeId = randomId(), ownerScopeIdB64 = randomId(), revisionId = randomId()
  const trkBytes = generateTrkBytes()
  const keyEnvelope = await wrapTrkSlots(kek, new Uint8Array(trkBytes), { ownerScopeId: ownerScopeIdB64, treeId, protocolVersion: 1, keyEnvelopeVersion: 1 })
  const trk = await importTrk(trkBytes)
  const genesis = createGenesisManifest({ treeId, rootNodeId, revisionId, now: now() })
  const enc = await encryptManifestRevision(trk, genesis, { treeId, revisionId, baseRevisionId: null, generation: 1, manifestSchemaVersion: 1 }, limits)

  const state = {
    protocolEnabled: true,
    treeId, rootNodeId, ownerScopeIdB64,
    envelope: { ...keyEnvelope, ownerScopeIdB64, keyEnvelopeVersion: 1, envelopeCasVersion: 1 },
    head: { revisionId, generation: 1 },
    revisions: new Map([[revisionId, { revisionId, baseRevisionId: null, generation: 1, ivB64: enc.ivB64, wrappedManifestDekB64: enc.wrappedManifestDekB64, wrapIvB64: enc.wrapIvB64, manifestSchemaVersion: 1, state: 'HEAD_COMMITTED', bytes: enc.ciphertext, idempotencyKey: randomId() }]]),
    blobStates: new Map(blobs.map((b) => [`${b.formatVersion}:${b.id}`, { ...b, lifecycle: 'UNREFERENCED' }])),
    casOutcomes: new Map(), // idempotencyKey → response (replay)
    log: [],               // every request: { method, path, body }
    purgeBarrierGeneration: 0,
  }
  /** hooks: dropNextCasResponse = true → CAS ถูก apply แล้วโยน network error (SY-5); beforeCas = fn เรียกก่อน apply */
  const hooks = { dropNextCasResponse: false, dropNextCasBeforeApply: false, beforeCas: null, failNextPut: false }

  const bodyText = (body) => (body instanceof Uint8Array ? `<${body.length} bytes>` : JSON.stringify(body ?? null))

  async function fetchJson(path, opts = {}) {
    const method = opts.method ?? 'GET'
    state.log.push({ method, path, body: bodyText(opts.body) })
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!state.protocolEnabled) return err(503, 'TREE_PROTOCOL_DISABLED')
    const b = opts.body ?? {}
    if (method === 'GET' && path === '/api/vault/tree/head') {
      const rev = state.revisions.get(state.head.revisionId)
      return res(200, { treeId, revisionId: rev.revisionId, baseRevisionId: rev.baseRevisionId, generation: rev.generation, ivB64: rev.ivB64, wrappedManifestDekB64: rev.wrappedManifestDekB64, wrapIvB64: rev.wrapIvB64, manifestSchemaVersion: 1, ciphertextSize: rev.bytes.length, keyEnvelope: { ownerScopeIdB64: state.envelope.ownerScopeIdB64, keyEnvelopeVersion: 1, envelopeCasVersion: state.envelope.envelopeCasVersion, primary: state.envelope.primary, recovery: state.envelope.recovery } })
    }
    if (method === 'POST' && path === '/api/vault/tree/revisions') {
      const existing = [...state.revisions.values()].find((r) => r.idempotencyKey === b.idempotencyKey)
      if (existing) return res(200, { revisionId: existing.revisionId, state: existing.state })
      if (!b.revisionId || !b.baseRevisionId || b.generation < 2 || !b.ivB64 || !b.wrappedManifestDekB64 || !b.wrapIvB64 || b.manifestSchemaVersion !== 1) return err(400, 'INVALID_INPUT')
      state.revisions.set(b.revisionId, { ...b, state: 'CREATED', bytes: null })
      return res(201, { revisionId: b.revisionId, state: 'CREATED' })
    }
    const put = path.match(/^\/api\/vault\/tree\/revisions\/([^/]+)\/ciphertext$/)
    if (method === 'PUT' && put) {
      if (hooks.failNextPut) { hooks.failNextPut = false; return res(0, null) }
      const rev = state.revisions.get(decodeURIComponent(put[1]))
      if (!rev) return err(404, 'NOT_FOUND')
      if (rev.state !== 'CREATED') return err(409, 'TREE_REVISION_NOT_PUBLISHED')
      rev.bytes = new Uint8Array(opts.body); rev.state = 'PUBLISHED'
      return res(200, { revisionId: rev.revisionId, state: 'PUBLISHED', ciphertextSize: rev.bytes.length })
    }
    if (method === 'POST' && path === '/api/vault/tree/head') {
      const allowed = ['expectedGeneration', 'expectedRevisionId', 'revisionId', 'attachBlobIds', 'purgeBlobIds', 'idempotencyKey']
      if (Object.keys(b).some((k) => !allowed.includes(k))) return err(400, 'INVALID_INPUT')
      if (state.casOutcomes.has(b.idempotencyKey)) return state.casOutcomes.get(b.idempotencyKey)
      if (hooks.dropNextCasBeforeApply) { hooks.dropNextCasBeforeApply = false; return res(0, null) }
      hooks.beforeCas?.()
      const rev = state.revisions.get(b.revisionId)
      let out
      if (!rev || rev.state !== 'PUBLISHED') out = err(409, 'TREE_REVISION_NOT_PUBLISHED')
      else if (b.expectedGeneration !== state.head.generation || b.expectedRevisionId !== state.head.revisionId || rev.generation !== state.head.generation + 1 || rev.baseRevisionId !== state.head.revisionId) {
        rev.state = 'ORPHANED'
        out = err(409, 'TREE_HEAD_CONFLICT', { currentGeneration: state.head.generation, currentRevisionId: state.head.revisionId })
      } else if ((b.purgeBlobIds ?? []).length) out = err(501, 'TREE_PURGE_NOT_SUPPORTED')
      else {
        const refs = (b.attachBlobIds ?? []).map((r) => `${r.formatVersion}:${r.id}`)
        if (refs.some((k) => state.blobStates.get(k)?.lifecycle !== 'UNREFERENCED')) out = err(409, 'TREE_BLOB_STATE_CONFLICT')
        else {
          for (const k of refs) Object.assign(state.blobStates.get(k), { lifecycle: 'TREE_MANAGED', attachedGeneration: rev.generation })
          state.revisions.get(state.head.revisionId).state = 'SUPERSEDED'
          rev.state = 'HEAD_COMMITTED'
          state.head = { revisionId: rev.revisionId, generation: rev.generation }
          out = res(200, { generation: rev.generation, revisionId: rev.revisionId, purgeBarrierGeneration: state.purgeBarrierGeneration, purgeId: null })
        }
      }
      state.casOutcomes.set(b.idempotencyKey, out)
      if (hooks.dropNextCasResponse) { hooks.dropNextCasResponse = false; return res(0, null) }
      return out
    }
    if (method === 'POST' && path === '/api/vault/tree/key-envelope') {
      if (b.expectedEnvelopeCasVersion !== state.envelope.envelopeCasVersion) return err(409, 'TREE_ENVELOPE_CONFLICT', { currentEnvelopeCasVersion: state.envelope.envelopeCasVersion })
      state.envelope = { ...state.envelope, primary: b.primary, recovery: b.recovery, envelopeCasVersion: state.envelope.envelopeCasVersion + 1 }
      return res(200, { envelopeCasVersion: state.envelope.envelopeCasVersion })
    }
    if (method === 'GET' && path.startsWith('/api/vault/tree/blobs')) {
      const lifecycle = new URL(path, 'http://x').searchParams.get('lifecycle')
      return res(200, { blobs: [...state.blobStates.values()].filter((s) => !lifecycle || s.lifecycle === lifecycle), orphanRetentionMs: 2_592_000_000 })
    }
    return err(404, 'NOT_FOUND')
  }
  async function fetchBytes(path, opts = {}) {
    state.log.push({ method: 'GET', path, body: 'null' })
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!state.protocolEnabled) return err(503, 'TREE_PROTOCOL_DISABLED')
    const m = path.match(/^\/api\/vault\/tree\/revisions\/([^/]+)$/)
    const rev = m && state.revisions.get(decodeURIComponent(m[1]))
    if (!rev || !['PUBLISHED', 'HEAD_COMMITTED', 'SUPERSEDED'].includes(rev.state)) return err(404, 'NOT_FOUND')
    return { ok: true, status: 200, bytes: new Uint8Array(rev.bytes), errorKind: null }
  }
  /** vaultTreeApi จริง ผูกกับ transport จำลอง (wrapper ชัดเจนต่อฟังก์ชัน) */
  const t = (o = {}) => ({ ...o, fetchJson, fetchBytes })
  const api = {
    getTreeState: (o) => treeApi.getTreeState(t(o)),
    getTreeHead: (o) => treeApi.getTreeHead(t(o)),
    getRevisionCiphertext: (id, o) => treeApi.getRevisionCiphertext(id, t(o)),
    publishRevision: (meta, o) => treeApi.publishRevision(meta, t(o)),
    putRevisionCiphertext: (id, bytes, o) => treeApi.putRevisionCiphertext(id, bytes, t(o)),
    casHead: (body, o) => treeApi.casHead(body, t(o)),
    casKeyEnvelope: (body, o) => treeApi.casKeyEnvelope(body, t(o)),
    listTreeBlobs: (o) => treeApi.listTreeBlobs(t(o)),
  }
  return { fetchJson, fetchBytes, api, state, trk, hooks, treeId, rootNodeId }
}
