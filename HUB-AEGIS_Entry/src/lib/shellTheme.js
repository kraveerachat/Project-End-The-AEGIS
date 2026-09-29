// Shared shell storage contract. HUB has no identity, session, or auth state.
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
