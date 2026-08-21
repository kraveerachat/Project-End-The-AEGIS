import { applyThemeToDocument, readShellTheme } from './lib/theme.js'

const theme = readShellTheme()
const prefersDark = theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches
applyThemeToDocument(theme, { prefersDark })
