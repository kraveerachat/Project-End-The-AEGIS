// A stand-in for the Drive backend, small enough to reason about but honest about
// the one thing the theme-transition matrix depends on: users.ui_theme is a value
// that lives on the server, is handed to the client at login, and only changes when
// the client PATCHes /api/preferences.
//
// Both stub modules below (lib/auth.js and lib/api.js) read and write this single
// object, so a test can assert "the account preference actually converged" rather
// than "React held the right value in memory".

export function backend() {
  globalThis.__AEGIS_THEME_BACKEND__ ??= resetBackend()
  return globalThis.__AEGIS_THEME_BACKEND__
}

export function resetBackend({ account, restoreSession = false } = {}) {
  globalThis.__AEGIS_THEME_BACKEND__ = {
    // users.ui_theme / ui_language / ui_density
    account: { theme: 'light', language: 'th', density: 'comfortable', ...account },
    // true = a valid session cookie already exists (app reload / GET /api/me path)
    restoreSession,
    // every PATCH /api/preferences the client sends, in order — a duplicate or an
    // unnecessary write shows up here as an extra entry
    patches: [],
  }
  return globalThis.__AEGIS_THEME_BACKEND__
}

export const NAV = [
  { id: 'dashboard', icon: 'Home', labelKey: 'navDashboard', group: 'work' },
  { id: 'files', icon: 'Folder', labelKey: 'navFiles', group: 'work' },
  { id: 'settings', icon: 'Settings', labelKey: 'navSettings', group: 'system' },
]

export function sessionUser() {
  return {
    id: '1',
    username: 'admin',
    displayName: 'Veerachat J.',
    accountName: 'Veerachat J.',
    role: 'Admin',
    mustResetPassword: false,
    // the server always answers with a complete preference set (DEFAULT_USER_PREFERENCES)
    preferences: { ...backend().account },
  }
}
