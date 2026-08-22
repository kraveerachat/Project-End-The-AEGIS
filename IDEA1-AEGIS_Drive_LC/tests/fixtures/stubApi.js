// Stands in for src/lib/api.js during the theme-transition matrix.
// PATCH /api/preferences is the only route that matters here, and it behaves like
// the real one: it validates nothing the client cannot already send, stores the
// result, and echoes the stored preferences back.
import { backend } from './themeTransitionBackend.js'

export async function apiFetch(path, options = {}) {
  if (path === '/api/preferences' && options.method === 'PATCH') {
    const state = backend()
    state.patches.push({ ...options.body })
    state.account = { ...state.account, ...options.body }
    return { ok: true, status: 200, data: { preferences: { ...state.account } } }
  }
  return { ok: true, status: 200, data: {} }
}

// Everything else the shell's components import from lib/api.js, kept inert.
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export const apiUrl = (path) => path
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {} } }
export async function apiFetchBytes() { return { ok: true, status: 200, bytes: new Uint8Array() } }
