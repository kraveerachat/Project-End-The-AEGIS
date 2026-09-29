// AEGIS CORE ENTRY UX CONTRACT — HUMAN OWNER CONTROLLED.
// Monitor Login shares HUB/Drive appearance only; this is not auth state.
// Explicit scope, RED tests, preserved auth semantics, Human/integration review required.
export const SHELL_THEME_KEY = 'aegis_shell_theme'
const LEGACY_THEME_KEY = 'aegis_theme'
const valid = new Set(['light', 'dark', 'system'])
export const isValidShellTheme = (value) => valid.has(value)

export function readShellTheme(storage = globalThis.localStorage) {
  try {
    let value = storage.getItem(SHELL_THEME_KEY)
    if (value === null) {
      const legacy = storage.getItem(LEGACY_THEME_KEY)
      if (valid.has(legacy)) {
        storage.setItem(SHELL_THEME_KEY, legacy)
        value = legacy
      }
    }
    return valid.has(value) ? value : 'light'
  } catch {
    return 'light'
  }
}

export function resolveShellTheme(theme, prefersDark) {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme === 'dark' ? 'dark' : 'light'
}
