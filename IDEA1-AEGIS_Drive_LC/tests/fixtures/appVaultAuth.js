// Stands in for src/lib/auth.js when the real authenticated App shell mounts the
// real Files AND the real Private Vault screen (tests/workspaceAppVaultParity.test.js).
// The menu mirrors server/rbac/permissions.js for Files + Vault, which both Admin and
// DataLake-User are authorized for — the client never infers access from the role.
import { backend, sessionUser } from './themeTransitionBackend.js'

export const APP_VAULT_NAV = [
  { id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace' },
  { id: 'files', icon: 'folder', labelKey: 'navFiles', group: 'navGroupWorkspace' },
  { id: 'vault', icon: 'vault', labelKey: 'navVault', group: 'navGroupWorkspace' },
  { id: 'settings', icon: 'settings', labelKey: 'navSettings', group: 'navGroupSystem' },
]

export async function login() {
  backend().restoreSession = true
  return { ok: true, user: sessionUser(), menu: APP_VAULT_NAV }
}

export async function fetchMe() {
  if (!backend().restoreSession) return null
  return { user: sessionUser(), menu: APP_VAULT_NAV }
}

export async function logout() {
  backend().events.push('logout')
  backend().restoreSession = false
}
