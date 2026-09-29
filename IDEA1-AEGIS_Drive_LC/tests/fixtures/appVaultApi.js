// Stands in for src/lib/api.js (every specifier form) when the real App shell mounts
// the real Files and the real Private Vault (tests/workspaceAppVaultParity.test.js).
//
// The REAL lib/hooks.js useApi runs on top of this transport, so both screens reach
// their production render path from a genuine request/answer:
//   /api/files…        → the workspace file rows (Files)
//   /healthz           → a wired PostgreSQL platform (no placeholder mode)
//   /api/vault…        → the Vault controller (tests/fixtures/vaultScreenBackend.js +
//                        vaultTreeBackend.js), GETs of a path the controller models in
//                        `state` answer from that state; everything else goes to `respond`
//   anything else      → an inert, successful empty body
// The Vault crypto/upload modules keep resolving to vaultScreenBackend.js (same as the
// Vault screen harness), so everything they export is re-exported here unchanged.
import * as vault from './vaultScreenBackend.js'

export * from './vaultScreenBackend.js'

export function workspaceFiles() {
  return globalThis.__AEGIS_WORKSPACE_FILES__ ?? []
}

export async function apiFetch(path, options = {}) {
  const route = String(path)
  if (route === '/api/files' || route.startsWith('/api/files?')) {
    return { ok: true, status: 200, data: { files: workspaceFiles() }, errorKind: null }
  }
  if (route === '/healthz') return { ok: true, status: 200, data: { ok: true, db: 'postgres' }, errorKind: null }
  const ctl = globalThis.__VAULT_BACKEND__
  if (ctl && route.startsWith('/api/vault')) {
    const method = options.method ?? 'GET'
    const modelled = ctl.state?.[route]
    if (method === 'GET' && modelled) {
      ctl.requests.push({ path: route, method })
      return modelled.error
        ? { ok: false, status: 500, data: null, errorKind: modelled.error }
        : { ok: true, status: 200, data: modelled.data, errorKind: null }
    }
    return vault.apiFetch(path, options)
  }
  return { ok: true, status: 200, data: {}, errorKind: null }
}
