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
