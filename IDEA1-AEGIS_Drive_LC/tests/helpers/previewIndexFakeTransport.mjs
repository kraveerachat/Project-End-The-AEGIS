// tests/helpers/previewIndexFakeTransport.mjs — D-1 PR-B · TEST HARNESS ONLY
//
// ⚠️ This is an in-memory imitation of the V2 upload family (create → PUT chunk → commit) mounted at any routeBase,
//    plus the existing chunk read GET /api/vault/blobs/:id/chunks/:i. It exists only so client seal/open/read code can be
//    tested before PR-C ships the real write-gated preview-index upload route. Nothing in src/ or server/ imports it,
//    and PR-B adds no server write route.
// It records every request (method, path, headers, body bytes) so tests can prove what did and did not leave the client.
import { randomBytes } from 'node:crypto'

const toBytes = async (body) => {
  if (body == null) return new Uint8Array(0)
  if (body instanceof Uint8Array) return body
  if (typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer())
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body))
}

export function createPreviewIndexFakeTransport() {
  const sessions = new Map()
  const blobs = new Map() // id → { envelope, chunks: Map(index → { ivB64, ciphertext }) }
  const requests = []
  let failNextChunkGet = null

  async function fetchJson(path, opts = {}) {
    const method = opts.method ?? 'GET'
    const bodyBytes = opts.body === undefined ? new Uint8Array(0) : await toBytes(opts.body)
    requests.push({ method, path, headers: { ...(opts.headers ?? {}) }, body: bodyBytes, transport: 'json' })
    if (opts.signal?.aborted) return { ok: false, status: 0, data: null, errorKind: 'network' }
    const m = path.match(/^(.*)\/([0-9a-f]{48})\/commit$/)
    if (method === 'POST' && m) {
      const s = sessions.get(m[2])
      if (!s || s.chunks.size !== s.meta.chunkCount) return { ok: false, status: 409, data: { code: 'UPLOAD_INCOMPLETE', upload: { uploadId: m[2], received: [...(s?.chunks.keys() ?? [])] } }, errorKind: 'server' }
      const id = randomBytes(24).toString('hex')
      const size = [...s.chunks.values()].reduce((t, c) => t + c.ciphertext.length, 0)
      const envelope = {
        id, formatVersion: 2, size, createdAt: Date.now(), contentIdB64: s.meta.contentIdB64, chunkSize: s.meta.chunkSize, chunkCount: s.meta.chunkCount,
        wrappedDekB64: s.meta.wrappedDekB64, wrapIvB64: s.meta.wrapIvB64, metaIvB64: s.meta.metaIvB64, metaB64: s.meta.metaB64,
      }
      blobs.set(id, { envelope, chunks: s.chunks, routeBase: m[1] })
      sessions.delete(m[2])
      return { ok: true, status: 201, data: { blob: { ...envelope, lifecycle: 'INDEX_STAGED' } }, errorKind: null }
    }
    if (method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(bodyBytes))
      const uploadId = randomBytes(24).toString('hex')
      sessions.set(uploadId, { meta, chunks: new Map(), routeBase: path })
      return { ok: true, status: 201, data: { upload: { uploadId, received: [], missing: Array.from({ length: meta.chunkCount }, (_, i) => i) } }, errorKind: null }
    }
    return { ok: false, status: 404, data: { code: 'NOT_FOUND' }, errorKind: 'server' }
  }

  async function sendUpload(path, opts = {}) {
    const bodyBytes = await toBytes(opts.body)
    requests.push({ method: opts.method ?? 'PUT', path, headers: { ...(opts.headers ?? {}) }, body: bodyBytes, transport: 'upload' })
    if (opts.signal?.aborted) return { ok: false, status: 0, data: null, errorKind: 'network' }
    const m = path.match(/\/([0-9a-f]{48})\/chunks\/(\d+)$/)
    const s = m && sessions.get(m[1])
    if (!s) return { ok: false, status: 404, data: { code: 'NOT_FOUND' }, errorKind: 'server' }
    s.chunks.set(Number(m[2]), { ivB64: opts.headers['X-Vault-Chunk-IV'], ciphertext: bodyBytes })
    return { ok: true, status: 200, data: { upload: { uploadId: m[1], received: [...s.chunks.keys()], missing: Array.from({ length: s.meta.chunkCount }, (_, i) => i).filter((i) => !s.chunks.has(i)) } }, errorKind: null }
  }

  async function fetchBytes(path, opts = {}) {
    requests.push({ method: 'GET', path, headers: {}, body: new Uint8Array(0), transport: 'bytes' })
    if (opts.signal?.aborted) return { ok: false, status: 0, bytes: null, headers: null, errorKind: 'network' }
    const m = path.match(/^\/api\/vault\/blobs\/([0-9a-f]{48})\/chunks\/(\d+)$/)
    const b = m && blobs.get(m[1])
    const c = b?.chunks.get(Number(m[2]))
    if (!c) return { ok: false, status: 404, bytes: null, headers: null, errorKind: 'server' }
    let bytes = new Uint8Array(c.ciphertext)
    if (failNextChunkGet) { bytes = failNextChunkGet(bytes); failNextChunkGet = null }
    return { ok: true, status: 200, bytes, headers: new Map([['X-Vault-Chunk-IV', c.ivB64]]), errorKind: null }
  }
  // Map#get is case-sensitive; mimic Headers.get
  const headersGet = (h, k) => h?.get?.(k)

  return {
    fetchJson, sendUpload, fetchBytes, requests, blobs, headersGet,
    envelopeOf: (id) => blobs.get(String(id))?.envelope ?? null,
    /** tamper with the next chunk GET (e.g. flip a byte) */
    tamperNextChunk(fn) { failNextChunkGet = fn },
    /** replace a stored envelope field (e.g. wrong contentIdB64) */
    patchEnvelope(id, patch) { const b = blobs.get(id); b.envelope = { ...b.envelope, ...patch } },
    reset() { requests.length = 0 },
  }
}
