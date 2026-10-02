// tests/helpers/previewIndexWriterFakeServer.mjs — D-1 PR-D · TEST HARNESS ONLY
//
// In-memory imitation of the preview-index server surface the writer talks to, layered on the PR-B fake V2 upload
// transport: GET/POST /preview-index/head (CAS with idempotency replay), GET /preview-index/envelopes, the
// /preview-index/uploads family (commit → INDEX_STAGED), per-owner retained-storage budget (507), and fault hooks
// (concurrent writer before a CAS, dropped CAS responses, budget at create/commit). It mirrors the server contract
// pinned by PR-C tests; it is never imported by src/ or server/.
import { createPreviewIndexFakeTransport } from './previewIndexFakeTransport.mjs'
import { TREE_ID } from './previewIndexFixture.mjs'

export const PI = '/api/vault/tree/preview-index'
export const BUDGET = 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED'

const parse = (body) => (typeof body === 'string' ? JSON.parse(body) : body)
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, data, errorKind: status >= 200 && status < 300 ? null : 'server' })
const network = () => ({ ok: false, status: 0, data: null, errorKind: 'network' })

export function createWriterFakeServer({ treeId = TREE_ID, budgetBytes = Infinity, writeEnabled = true } = {}) {
  const t = createPreviewIndexFakeTransport()
  const lifecycle = new Map() // blob id → 'INDEX_STAGED' | 'INDEX_MANAGED'
  const generations = []
  const idem = new Map()
  const log = [] // every JSON request: { method, path, body }
  const state = { head: null, budgetBytes, writeEnabled }
  const hooks = {
    /** async (body) => void — runs before the CAS is evaluated (e.g. another writer commits first) */
    beforeCas: null,
    /** number of CAS responses to drop AFTER the CAS applied (lost-response simulation) */
    dropCasResponses: 0,
    /** (n) => boolean — answer 507 at the n-th upload create (1-based) */
    budgetAtCreate: null,
    /** (n) => boolean — answer 507 at the n-th upload commit (1-based), rolling back the staged blob */
    budgetAtCommit: null,
    /** async (blobId) => void — after a successful upload commit */
    afterCommit: null,
  }
  let creates = 0, commits = 0

  const retained = () => [...lifecycle.keys()].reduce((n, id) => n + (t.blobs.get(id)?.envelope.size ?? 0), 0)

  async function cas(raw) {
    if (!state.writeEnabled) return reply(503, { error: 'disabled', code: 'PREVIEW_INDEX_WRITE_DISABLED' })
    const b = parse(raw)
    if (hooks.beforeCas) await hooks.beforeCas(b)
    const digest = JSON.stringify({ ...b, attachBlobIds: [...b.attachBlobIds].sort(), supersededBlobIds: [...b.supersededBlobIds].sort() })
    if (idem.has(b.idempotencyKey)) {
      const prior = idem.get(b.idempotencyKey)
      if (prior.digest !== digest) return reply(409, { error: 'x', code: 'PREVIEW_INDEX_IDEMPOTENCY_MISMATCH' })
      return reply(200, { indexGeneration: prior.indexGeneration, rootBlobId: prior.rootBlobId })
    }
    const curGen = state.head?.indexGeneration ?? 0
    const curRoot = state.head?.rootBlobRef.id ?? null
    if (b.expectedGeneration !== curGen || b.expectedRootBlobId !== curRoot) {
      return reply(409, { error: 'x', code: 'PREVIEW_INDEX_CONFLICT', currentGeneration: curGen, currentRootBlobId: curRoot })
    }
    if (!b.attachBlobIds.includes(b.rootBlobId)) return reply(400, { error: 'x', code: 'INVALID_INPUT' })
    for (const id of b.attachBlobIds) if (lifecycle.get(id) !== 'INDEX_STAGED') return reply(409, { error: 'x', code: 'PREVIEW_INDEX_BLOB_STATE_CONFLICT' })
    if (t.envelopeOf(b.rootBlobId)?.contentIdB64 !== b.rootContentIdB64) return reply(409, { error: 'x', code: 'PREVIEW_INDEX_ROOT_MISMATCH' })
    for (const id of b.supersededBlobIds) if (lifecycle.get(id) !== 'INDEX_MANAGED') return reply(409, { error: 'x', code: 'PREVIEW_INDEX_BLOB_STATE_CONFLICT' })
    for (const id of b.attachBlobIds) lifecycle.set(id, 'INDEX_MANAGED')
    const indexGeneration = curGen + 1
    state.head = { treeId, indexGeneration, rootBlobRef: { formatVersion: 2, id: b.rootBlobId }, rootContentIdB64: b.rootContentIdB64 }
    generations.push({ indexGeneration, attach: [...b.attachBlobIds], superseded: [...b.supersededBlobIds] })
    idem.set(b.idempotencyKey, { digest, indexGeneration, rootBlobId: b.rootBlobId })
    if (hooks.dropCasResponses > 0) { hooks.dropCasResponses--; return network() }
    return reply(200, { indexGeneration, rootBlobId: b.rootBlobId })
  }

  async function fetchJson(path, opts = {}) {
    const method = opts.method ?? 'GET'
    log.push({ method, path, body: opts.body === undefined ? null : parse(opts.body) })
    if (opts.signal?.aborted) return network()
    if (path === `${PI}/head` && method === 'GET') return state.head ? reply(200, structuredClone(state.head)) : reply(404, { error: 'x', code: 'PREVIEW_INDEX_NOT_FOUND' })
    if (path === `${PI}/head` && method === 'POST') return cas(opts.body)
    if (path.startsWith(`${PI}/envelopes?ids=`) && method === 'GET') {
      const ids = decodeURIComponent(path.slice(`${PI}/envelopes?ids=`.length)).split(',')
      return reply(200, { blobs: ids.filter((id) => lifecycle.has(id)).map((id) => t.envelopeOf(id)) })
    }
    if (path.startsWith(`${PI}/uploads`) && method === 'POST') {
      if (!state.writeEnabled) return reply(503, { error: 'disabled', code: 'PREVIEW_INDEX_WRITE_DISABLED' })
      if (/\/commit$/.test(path)) {
        commits++
        const r = await t.fetchJson(path, opts)
        if (!r.ok) return r
        const id = r.data.blob.id
        const size = t.blobs.get(id).envelope.size
        if (hooks.budgetAtCommit?.(commits) || retained() + size > state.budgetBytes) {
          t.blobs.delete(id) // the commit transaction rolled back: no blob row, no lifecycle row
          return reply(507, { error: 'x', code: BUDGET })
        }
        lifecycle.set(id, 'INDEX_STAGED')
        if (hooks.afterCommit) await hooks.afterCommit(id)
        return r
      }
      creates++
      const body = parse(opts.body)
      if (hooks.budgetAtCreate?.(creates) || retained() + Number(body.ciphertextSize) > state.budgetBytes) return reply(507, { error: 'x', code: BUDGET })
      return t.fetchJson(path, opts)
    }
    return reply(404, { error: 'x', code: 'NOT_FOUND' })
  }

  const transport = { fetchJson, sendUpload: (...a) => t.sendUpload(...a), fetchBytes: (...a) => t.fetchBytes(...a) }
  return {
    transport, state, hooks, log, lifecycle, generations, t,
    retained,
    /** every byte that left the client: JSON bodies, chunk bodies, paths, headers */
    wire() {
      const parts = []
      for (const r of log) parts.push(r.path, r.body === null ? '' : JSON.stringify(r.body))
      for (const r of t.requests) { parts.push(r.path, JSON.stringify(r.headers)); parts.push(Buffer.from(r.body).toString('latin1')) }
      return parts.join('\n')
    },
    casPosts: () => log.filter((r) => r.method === 'POST' && r.path === `${PI}/head`),
    uploadCalls: () => log.filter((r) => r.path.startsWith(`${PI}/uploads`)).length + t.requests.filter((r) => r.transport === 'upload').length,
  }
}
