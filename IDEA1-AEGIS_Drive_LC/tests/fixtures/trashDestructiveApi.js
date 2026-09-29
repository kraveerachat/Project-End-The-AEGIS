// tests/fixtures/trashDestructiveApi.js — Mock backend for Trash UI reauth and deletion tests
export const trashBackend = {
  unlocked: true,
  calls: [],
  items: [],
  purgeResult: null,
  emptyResult: null,
  listGate: null,
  listGates: [],
  listResult: null,
  statusGates: [],

  reset(overrides = {}) {
    this.unlocked = true
    this.calls = []
    this.items = []
    this.purgeResult = null
    this.emptyResult = null
    this.listGate = null
    this.listGates = []
    this.listResult = null
    this.statusGates = []
    Object.assign(this, overrides)
  },

  paths() { return this.calls.map((c) => c.path) },
}

export async function apiFetch(path, options = {}) {
  trashBackend.calls.push({ path, method: options.method ?? 'GET', body: options.body })

  if (path === '/api/trash/status') {
    const result = { ok: true, status: 200, data: { unlocked: trashBackend.unlocked }, errorKind: null }
    const gate = trashBackend.statusGates.shift()
    if (gate) await gate
    return result
  }

  if (path === '/api/trash/unlock') {
    if (options.body?.password === 'wrong-password') {
      return { ok: false, status: 401, data: null, errorKind: 'unauthorized' }
    }
    trashBackend.unlocked = true
    return { ok: true, status: 200, data: {}, errorKind: null }
  }

  if (path === '/api/trash/lock') {
    trashBackend.unlocked = false
    return { ok: true, status: 200, data: {}, errorKind: null }
  }

  if (path === '/api/trash') {
    // Snapshot when the server handles the request, not when network delivery settles.
    const result = trashBackend.listResult ?? (trashBackend.unlocked
      ? { ok: true, status: 200, data: { items: [...trashBackend.items] }, errorKind: null }
      : { ok: false, status: 423, data: null, errorKind: 'server' })
    const gate = trashBackend.listGates.shift() ?? trashBackend.listGate
    if (gate) await gate
    return result
  }

  if (path.startsWith('/api/trash/') && path.endsWith('/restore') && options.method === 'POST') {
    const id = decodeURIComponent(path.slice('/api/trash/'.length, -'/restore'.length))
    trashBackend.items = trashBackend.items.filter((item) => item.id !== id)
    return { ok: true, status: 200, data: { restoredId: id }, errorKind: null }
  }

  if (path.startsWith('/api/trash/') && options.method === 'DELETE') {
    if (trashBackend.purgeResult) return trashBackend.purgeResult
    if (options.body?.password === 'wrong-password') {
      return { ok: false, status: 401, data: null, errorKind: 'unauthorized' }
    }
    const id = decodeURIComponent(path.replace('/api/trash/', ''))
    trashBackend.items = trashBackend.items.filter((item) => item.id !== id)
    return { ok: true, status: 200, data: { ok: true }, errorKind: null }
  }

  if (path === '/api/trash/empty' && options.method === 'POST') {
    if (trashBackend.emptyResult) return trashBackend.emptyResult
    if (options.body?.password === 'wrong-password') {
      return { ok: false, status: 401, data: null, errorKind: 'unauthorized' }
    }
    const count = trashBackend.items.length
    trashBackend.items = []
    trashBackend.unlocked = false
    return { ok: true, status: 200, data: { ok: true, deletedCount: count, blockedCount: 0, busyCount: 0, remainingCount: 0 }, errorKind: null }
  }

  return { ok: true, status: 200, data: {}, errorKind: null }
}

export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export const apiUrl = (path) => path
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {} } }
export async function apiFetchBytes() { return { ok: true, status: 200, bytes: new Uint8Array() } }
