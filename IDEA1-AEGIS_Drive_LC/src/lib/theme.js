export const SHELL_THEME_KEY = 'aegis_shell_theme'
export const VALID_THEMES = new Set(['light', 'dark', 'system'])

export function readShellTheme(storage) {
  try {
    const source = storage ?? globalThis.localStorage
    const stored = source?.getItem(SHELL_THEME_KEY)
    return VALID_THEMES.has(stored) ? stored : 'light'
  } catch {
    return 'light'
  }
}

export function writeShellTheme(theme, storage) {
  if (!VALID_THEMES.has(theme)) return false
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(SHELL_THEME_KEY, theme)
    return true
  } catch {
    return false
  }
}

export function resolveTheme(theme, prefersDark = false) {
  if (theme === 'dark') return 'dark'
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return 'light'
}

export function applyThemeToDocument(theme, { root = globalThis.document?.documentElement, prefersDark = false } = {}) {
  const resolved = resolveTheme(theme, prefersDark)
  if (!root) return resolved
  root.dataset.theme = resolved
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.style.colorScheme = resolved
  return resolved
}
