// Stands in for src/lib/api.js while the Trash screen's locked state is under
// test. It behaves like the real server contract for the four routes the screen
// touches, and — the point of the fixture — it records every request, so a test
// can assert that the locked screen never asked for trash metadata at all.
export const trashBackend = {
  unlocked: false,
  calls: [],
  items: [],
  /** The answer POST /api/trash/unlock should give next. */
  unlockResult: { ok: true, status: 200, data: {}, errorKind: null },

  reset(overrides = {}) {
    this.unlocked = false
    this.calls = []
    this.items = []
    this.unlockResult = { ok: true, status: 200, data: {}, errorKind: null }
    Object.assign(this, overrides)
  },
  /** Paths requested so far, in order. */
  paths() { return this.calls.map((c) => c.path) },
  /** How many times the metadata route itself was requested. */
  metadataRequests() { return this.calls.filter((c) => c.path === '/api/trash').length },
}

export async function apiFetch(path, options = {}) {
  trashBackend.calls.push({ path, method: options.method ?? 'GET' })

  if (path === '/api/trash/status') {
    return { ok: true, status: 200, data: { unlocked: trashBackend.unlocked }, errorKind: null }
  }

  if (path === '/api/trash/unlock') {
    const result = trashBackend.unlockResult
    if (result.ok) trashBackend.unlocked = true
    return result
  }

  if (path === '/api/trash/lock') {
    trashBackend.unlocked = false
    return { ok: true, status: 200, data: {}, errorKind: null }
  }

  if (path === '/api/trash') {
    // The real route answers 423 when the step-up window is not open, and the
    // screen must never be in a position to receive anything else.
    if (!trashBackend.unlocked) return { ok: false, status: 423, data: null, errorKind: 'server' }
    return { ok: true, status: 200, data: { items: trashBackend.items }, errorKind: null }
  }

  return { ok: true, status: 200, data: {}, errorKind: null }
}

// The rest of lib/api.js's surface, kept inert for the components that import it.
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export const apiUrl = (path) => path
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {} } }
export async function apiFetchBytes() { return { ok: true, status: 200, bytes: new Uint8Array() } }
