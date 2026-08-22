// Stands in for src/lib/auth.js during the theme-transition matrix.
import { NAV, backend, sessionUser } from './themeTransitionBackend.js'

export async function login() {
  backend().restoreSession = true
  return { ok: true, user: sessionUser(), menu: NAV }
}

export async function fetchMe() {
  if (!backend().restoreSession) return null
  return { user: sessionUser(), menu: NAV }
}

export async function logout() {
  backend().restoreSession = false
}
