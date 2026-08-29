// A controllable stand-in for everything the Private Vault screen talks to.
//
// The screen's own state machine is what is under test — the blob inventory,
// the lock/unlock transition, and the delete reconciliation. Real Argon2id and
// WebCrypto are covered by tests/vaultCrypto.test.js and are deliberately not
// re-exercised here: they are slow, they need WASM, and they would hide the
// state bug behind unrelated failures.
//
// ⚠️ The fake envelope still keeps the real shape: the filename only ever lives
//    inside `metaB64`, so a zero-knowledge assertion over the DOM stays honest.

export const CORRECT_PASSPHRASE = 'correct-horse-battery-staple'

/** Fresh, empty controller. Assign it to globalThis.__VAULT_BACKEND__ per test. */
export function makeVaultBackend() {
  return {
    // what useApi('/api/vault') returns on the next render
    state: { '/api/vault': { loading: false, data: { configured: true, blobs: [] }, error: null } },
    // every request the screen made, in order
    requests: [],
    // test-supplied responders
    respond: null,
    respondBytes: null,
  }
}

const backend = () => globalThis.__VAULT_BACKEND__

/* ── fake envelope ────────────────────────────────────────────────── */

export const encodeMeta = (meta) => Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
const decodeMeta = (b64) => JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'))

/** A server blob row exactly as GET /api/vault and POST /api/vault/blobs return it. */
export function serverBlob({ id, name, type = 'image/gif', plainSize = 2048, size = 2096 }) {
  return {
    id,
    size,
    createdAt: 1_756_000_000_000,
    ivB64: 'iv', wrappedDekB64: 'dek', wrapIvB64: 'wiv', metaIvB64: 'miv',
    metaB64: encodeMeta({ name, type, size: plainSize }),
  }
}

/* ── ../lib/hooks.js ──────────────────────────────────────────────── */

export function useApi(path) {
  const ctl = backend()
  const state = ctl?.state?.[path] ?? { loading: false, data: null, error: null }
  return {
    ...state,
    retry: () => ctl?.requests.push({ path, method: 'RETRY' }),
    refresh: () => ctl?.requests.push({ path, method: 'REFRESH' }),
  }
}
export function useReducedMotion() { return true }
export function useNow() { return Date.UTC(2026, 7, 27, 9, 0, 0) }
export function useCountUp(target) { return target }

/* ── ../lib/api.js ────────────────────────────────────────────────── */

export async function apiFetch(path, options = {}) {
  const ctl = backend()
  const method = options.method ?? 'GET'
  ctl.requests.push({ path, method, body: options.body })
  const res = await ctl.respond?.({ path, method, options })
  return res ?? { ok: true, status: 204, data: null, errorKind: null }
}

export async function apiFetchBytes(path, options = {}) {
  const ctl = backend()
  ctl.requests.push({ path, method: 'GET_BYTES' })
  const res = await ctl.respondBytes?.({ path, options })
  return res ?? { ok: true, status: 200, bytes: new Uint8Array([1, 2, 3, 4]), errorKind: null }
}

export const apiUrl = (path) => path
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {}, errorKind: null } }

/* ── ../lib/vaultCrypto.js ────────────────────────────────────────── */

export const ARGON2_DEFAULTS = Object.freeze({ time: 1, memKiB: 8, parallelism: 1, hashLen: 32 })
export const KEY_BYTES = 32

const FAKE_KEK = Object.freeze({ kind: 'fake-kek' })

export async function unlockVault(passphrase) {
  // Same contract as the real module: a bad key is 'wrong-key' and nothing else.
  if (passphrase !== CORRECT_PASSPHRASE) throw new Error('wrong-key')
  return FAKE_KEK
}

export async function createVaultSetup() {
  return { saltB64: 'salt', params: ARGON2_DEFAULTS, verifier: { ivB64: 'v', ctB64: 'v' }, kek: FAKE_KEK }
}

export async function encryptFileEnvelope(kek, { name, type = '', size, bytes }) {
  return {
    ciphertext: new Uint8Array(bytes ?? []),
    ivB64: 'iv', wrappedDekB64: 'dek', wrapIvB64: 'wiv', metaIvB64: 'miv',
    metaB64: encodeMeta({ name, type, size }),
  }
}

export async function decryptBlobMeta(kek, blob) {
  if (!kek) throw new Error('no-key')
  return decodeMeta(blob?.metaB64)
}

export async function decryptFileContent(kek, blob, ciphertext) {
  if (!kek) throw new Error('no-key')
  return new Uint8Array(ciphertext ?? [])
}

export async function fileToBytes() { return new Uint8Array([1, 2, 3, 4]) }
export const bytesToB64 = (bytes) => Buffer.from(bytes).toString('base64')
export const b64ToBytes = (b64) => new Uint8Array(Buffer.from(String(b64), 'base64'))
export async function deriveKek() { return FAKE_KEK }
export async function verifyKek() { return true }
export async function unwrapDek() { return FAKE_KEK }

/* ── ../lib/vaultChunkCrypto.js (Private Vault V2) ────────────────────
   ⚠️ เหตุผลเดียวกับที่ V1 ถูก stub ไว้ที่นี่: การเข้ารหัสจริงถูกพิสูจน์แล้วใน
      tests/vaultChunkCrypto.test.js ด้วยโมดูลตัวจริง ชุด UI ไม่ควรรัน WebCrypto ซ้ำ
      เพราะมันช้าและจะบัง bug ของ state machine ไว้หลังความล้มเหลวที่ไม่เกี่ยวกัน
   ⚠️ ซองปลอมยังรักษา "รูปทรงจริง" ไว้: ชื่อไฟล์อยู่ใน metaB64 เท่านั้น การยืนยันเรื่อง
      zero-knowledge บน DOM จึงยังซื่อสัตย์ */
export const VAULT_FORMAT_V2 = 2
export const GCM_TAG_BYTES = 16

export async function decryptVaultV2Meta(kek, blob) {
  if (!kek) throw new Error('no-key')
  const meta = decodeMeta(blob?.metaB64)
  // V2 เก็บฟิลด์ชื่อ plainSize ส่วน V1 ใช้ size — คืนให้ตรงกับของจริง
  return { name: meta.name, type: meta.type, plainSize: meta.plainSize ?? meta.size }
}

/* ── ../lib/vaultChunkedUpload.js ─────────────────────────────────────
   ตัวควบคุมของเทสต์ตอบที่ path เดียวกับที่โมดูลจริงยิงไป ('/api/vault/uploads')
   จอจึงถูกทดสอบด้วย "ผลลัพธ์ของการอัปโหลด V2" ตามจริง ไม่ใช่ผลของ endpoint V1 ที่เลิกใช้ */
export async function uploadVaultFileChunked({ file, resume, onStage, onProgress, signal }) {
  const ctl = backend()
  // ⚠️ เทสต์ที่ต้องคุมจังหวะเอง (ค้างกลางคัน / ล้มเฉพาะก้อนที่ N / ยกเลิกตอนนั้นพอดี)
  //    ใส่ตัวขับของตัวเองได้ — รูปทรงของผลลัพธ์ยังเป็นสัญญาเดียวกับโมดูลจริงทุกประการ
  if (typeof ctl?.uploadImpl === 'function') {
    return ctl.uploadImpl({ file, resume, onStage, onProgress, signal })
  }
  const chunkCount = ctl?.uploadChunkCount ?? 1
  onStage?.('preparing')
  ctl.requests.push({ path: '/api/vault/uploads', method: 'POST', body: { size: file?.size ?? 0 } })

  for (let i = 0; i < chunkCount; i += 1) {
    if (signal?.aborted) return { ok: false, stage: 'cancelled', reason: 'cancelled', resume: resume ?? null }
    onStage?.('encrypting')
    onProgress?.({
      phase: 'encrypting', chunkIndex: i, chunkCount,
      transferredBytes: 0, totalBytes: file?.size ?? 0, percent: 0,
    })
    onStage?.('uploading')
    onProgress?.({
      phase: 'uploading', chunkIndex: i, chunkCount,
      transferredBytes: Math.round(((i + 1) / chunkCount) * (file?.size ?? 0)),
      totalBytes: file?.size ?? 0,
      percent: Math.round(((i + 1) / chunkCount) * 1000) / 10,
    })
  }
  if (signal?.aborted) return { ok: false, stage: 'cancelled', reason: 'cancelled', resume: resume ?? null }

  onStage?.('committing')
  const res = await ctl.respond?.({ path: '/api/vault/uploads', method: 'POST', options: {} })
  if (res && res.ok === false) {
    // ตัวควบคุมของเทสต์เลือกได้ว่าจะให้ "หยุดค้างแล้วทำต่อได้" หรือ "ล้มเหลวถาวร"
    const stage = ctl?.uploadFailureStage ?? 'failed'
    return { ok: false, stage, reason: res.data?.code ?? 'server', resume: { upload: { uploadId: 'stub-upload' } } }
  }
  onStage?.('complete')
  return { ok: true, stage: 'complete', blob: res?.data?.blob, resume: null }
}

export async function cancelVaultUploadSession() { return true }
export async function fetchVaultTransferLimits() {
  return { formatVersion: 2, plaintextChunkBytes: 16 * 1024 * 1024, maxLogicalFileBytes: 5 * 1024 ** 3 }
}

/* ── ../lib/vaultChunkedDownload.js ───────────────────────────────────
   ⚠️ วนขอทีละ chunk จริง ๆ ผ่านตัวควบคุมของเทสต์ เพื่อให้ชุด UI ยืนยันได้ว่าจอ
      "ขอทีละก้อน" ไม่ใช่ก้อนเดียวจบ (ตรรกะจริงถูกพิสูจน์ที่ vaultChunkedDownloadClient) */
export const MAX_BUFFERED_PLAINTEXT_BYTES = 64 * 1024 * 1024

export function supportsStreamingFileSink() {
  return backend()?.streamingSink === true
}

export function createFileSystemSink(writable) {
  return {
    kind: 'filesystem',
    async write(bytes) { await writable.write(bytes) },
    async close() { await writable.close() },
    async abort() { await writable.abort?.() },
  }
}

export function createBufferedSink({ limitBytes = MAX_BUFFERED_PLAINTEXT_BYTES } = {}) {
  let parts = []
  let total = 0
  return {
    kind: 'buffered',
    async write(bytes) {
      total += bytes.length
      if (total > limitBytes) {
        parts = []
        throw Object.assign(new Error('buffered sink limit exceeded'), { code: 'BUFFER_LIMIT' })
      }
      parts.push(bytes)
    },
    async close() { return parts },
    async abort() { parts = [] },
  }
}

export async function downloadVaultV2({ blob, sink, onProgress, signal }) {
  const ctl = backend()
  if (typeof ctl?.downloadImpl === 'function') {
    return ctl.downloadImpl({ blob, sink, onProgress, signal })
  }
  const chunkCount = Number(blob?.chunkCount ?? 1)
  let bytesWritten = 0
  for (let index = 0; index < chunkCount; index += 1) {
    if (signal?.aborted) {
      await sink.abort?.()
      return { ok: false, reason: 'cancelled', chunksRead: index, bytesWritten }
    }
    const path = `/api/vault/blobs/${blob.id}/chunks/${index}`
    ctl.requests.push({ path, method: 'GET_BYTES' })
    const res = await ctl.respondBytes?.({ path, options: {} })
    if (res && res.ok === false) {
      await sink.abort?.()
      return { ok: false, reason: res.reason ?? 'fetch', chunksRead: index, bytesWritten }
    }
    const bytes = res?.bytes ?? new Uint8Array([1, 2, 3, 4])
    await sink.write(bytes)
    bytesWritten += bytes.length
    onProgress?.({
      chunkIndex: index, chunkCount, bytesWritten,
      totalBytes: bytesWritten, percent: Math.round(((index + 1) / chunkCount) * 1000) / 10,
    })
  }
  const result = await sink.close()
  return { ok: true, chunksRead: chunkCount, bytesWritten, meta: decodeMeta(blob?.metaB64), result }
}

export function estimatedPlainSize(blob) {
  return Math.max(0, Number(blob.size) - Number(blob.chunkCount) * GCM_TAG_BYTES)
}

/** แถว blob V2 อย่างที่ GET /api/vault และ commit คืนกลับมาจริง ๆ */
export function serverBlobV2({ id, name, type = 'image/gif', plainSize = 2048, chunkCount = 1, size = 2064 }) {
  return {
    id,
    formatVersion: 2,
    size,
    createdAt: 1_756_000_000_000,
    contentIdB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
    chunkSize: 16 * 1024 * 1024 + 16,
    chunkCount,
    wrappedDekB64: 'dek', wrapIvB64: 'wiv', metaIvB64: 'miv',
    metaB64: encodeMeta({ name, type, plainSize }),
  }
}
