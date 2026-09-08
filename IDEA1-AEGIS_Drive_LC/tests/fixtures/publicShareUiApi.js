// Stands in for src/lib/api.js while the Shares screen is driven for real.
//
// Only POST /api/shares matters here. It records exactly what the screen sent —
// which is the point of the URL-ownership and password tests: the assertion is
// about the request the UI composed, not about a copy of the UI's own logic.
//
// State lives on globalThis so the test file and the Vite-loaded component see
// the same object, the same trick tests/fixtures/themeTransitionBackend.js uses.

/**
 * The frozen clock tests/fixtures/mockHooks.js reports, so an expiry assertion
 * can name the exact countdown the screen must render.
 */
export const NOW = Date.UTC(2026, 7, 7, 9, 0, 0)
/** now + 2d 5h → fmtCountdown renders "2d 5h". */
export const PRIVATE_EXPIRES_AT = NOW + (2 * 86_400_000) + (5 * 3_600_000)
/** now + 3h → fmtCountdown renders "3h 00m". Deliberately unlike any form option. */
export const PUBLIC_EXPIRES_AT = NOW + (3 * 3_600_000)

/** The one share-creation response the next POST will get. */
export function shareBackend() {
  globalThis.__AEGIS_PUBLIC_SHARE_UI__ ??= resetShareBackend()
  return globalThis.__AEGIS_PUBLIC_SHARE_UI__
}

export function resetShareBackend({ createResponse } = {}) {
  globalThis.__AEGIS_PUBLIC_SHARE_UI__ = {
    /** Every body the screen POSTed to /api/shares, in order. */
    posts: [],
    createResponse: createResponse ?? {
      ok: true,
      status: 201,
      data: {
        share: {
          id: 's1', fileName: 'q4-report.pdf', hasPassword: true, scopeCidrs: [],
          // The stored expiry. The confirmation must read THIS, never the form.
          expiresAt: PRIVATE_EXPIRES_AT,
        },
        path: '/s/PrivateToken123',
      },
    },
  }
  return globalThis.__AEGIS_PUBLIC_SHARE_UI__
}

export async function apiFetch(path, options = {}) {
  const state = shareBackend()
  if (path === '/api/shares' && options.method === 'POST') {
    state.posts.push({ ...options.body })
    return state.createResponse
  }
  if (path.startsWith('/api/shares/') && options.method === 'DELETE') {
    return { ok: true, status: 200, data: { ok: true } }
  }
  return { ok: true, status: 200, data: {} }
}

// The rest of the module surface the screen imports, kept inert.
export const apiUrl = (path) => path
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'
export function registerUnauthorizedHandler() {}
export function setCsrfToken() {}
export function clearCsrfToken() {}
export async function apiUpload() { return { ok: true, status: 200, data: {} } }
export async function apiFetchBytes() { return { ok: true, status: 200, bytes: new Uint8Array() } }
