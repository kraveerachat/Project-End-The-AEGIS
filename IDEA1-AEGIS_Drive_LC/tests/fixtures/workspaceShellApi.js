// Stands in for src/lib/api.js when the real authenticated App shell mounts the
// real Files screen (tests/workspaceMarqueeApp.test.js). The real lib/hooks.js
// useApi runs unchanged on top of this stub, so Files reaches its production
// render path from a genuine GET /api/files answer instead of a mocked hook.
// Everything else the shell polls answers with an inert, successful empty body.

export function workspaceFiles() {
  return globalThis.__AEGIS_WORKSPACE_FILES__ ?? []
}

export async function apiFetch(path) {
  const route = String(path)
  if (route === '/api/files' || route.startsWith('/api/files?')) {
    return { ok: true, status: 200, data: { files: workspaceFiles() }, errorKind: null }
  }
  // a wired production platform (PostgreSQL), so screens are not in placeholder mode
  if (route === '/healthz') return { ok: true, status: 200, data: { ok: true, db: 'postgres' }, errorKind: null }
  return { ok: true, status: 200, data: {}, errorKind: null }
}

export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export const apiUrl = (path) => path
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {} } }
export async function apiFetchBytes() { return { ok: true, status: 200, bytes: new Uint8Array() } }
