// tests/fixtures/trashDestructiveApi.js — Mock backend for Trash UI reauth and deletion tests
export const trashBackend = {
  unlocked: true,
  calls: [],
  items: [],
  purgeResult: null,
  emptyResult: null,

  reset(overrides = {}) {
    this.unlocked = true
    this.calls = []
    this.items = []
    this.purgeResult = null
    this.emptyResult = null
    Object.assign(this, overrides)
  },

  paths() { return this.calls.map((c) => c.path) },
}

export async function apiFetch(path, options = {}) {
  trashBackend.calls.push({ path, method: options.method ?? 'GET', body: options.body })

  if (path === '/api/trash/status') {
    return { ok: true, status: 200, data: { unlocked: trashBackend.unlocked }, errorKind: null }
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
    if (!trashBackend.unlocked) return { ok: false, status: 423, data: null, errorKind: 'server' }
    return { ok: true, status: 200, data: { items: [...trashBackend.items] }, errorKind: null }
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
    return { ok: true, status: 200, data: { deletedId: id }, errorKind: null }
  }

  if (path === '/api/trash/empty' && options.method === 'POST') {
    if (trashBackend.emptyResult) return trashBackend.emptyResult
    if (options.body?.password === 'wrong-password') {
      return { ok: false, status: 401, data: null, errorKind: 'unauthorized' }
    }
    const count = trashBackend.items.length
    trashBackend.items = []
    trashBackend.unlocked = false
    return { ok: true, status: 200, data: { deletedCount: count }, errorKind: null }
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
