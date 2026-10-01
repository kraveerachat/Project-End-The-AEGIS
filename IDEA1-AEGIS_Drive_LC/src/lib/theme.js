export const SHELL_THEME_KEY = 'aegis_shell_theme'
export const LEGACY_THEME_KEY = 'aegis_theme'
export const VALID_THEMES = new Set(['light', 'dark', 'system'])

export const isValidTheme = (theme) => VALID_THEMES.has(theme)

/**
 * ค่าที่ "มีอยู่จริง" ใน shell hint — null แปลว่าไม่เคยมีการเลือกธีมในเบราว์เซอร์นี้เลย
 *
 * ⚠️ ต่างจาก readShellTheme() ตรงที่ "ไม่มีค่า" กับ "เลือก light ไว้" ไม่ถูกยุบเป็นค่าเดียวกัน
 *    — resolveAuthenticatedTheme() ต้องแยกสองกรณีนี้ออกจากกันจึงจะตัดสิน precedence ได้ถูก
 *    (ดู §9 ของสัญญาธีม: no theme ever selected / persisted shell theme / explicit selection)
 */
export function readStoredShellTheme(storage) {
  // AEGIS CORE ENTRY UX CONTRACT — HUMAN OWNER CONTROLLED.
  // Canonical shell value wins. Adopt legacy only once when canonical is absent;
  // never keep two authorities. Explicit scope, RED tests, Human review required.
  try {
    const source = storage ?? globalThis.localStorage
    let stored = source?.getItem(SHELL_THEME_KEY)
    if (stored === null) {
      const legacy = source?.getItem(LEGACY_THEME_KEY)
      if (isValidTheme(legacy)) {
        source?.setItem(SHELL_THEME_KEY, legacy)
        stored = legacy
      }
    }
    return isValidTheme(stored) ? stored : null
  } catch {
    return null
  }
}

export function readShellTheme(storage) {
  return readStoredShellTheme(storage) ?? 'light'
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

/**
 * ธีมของ "ช่วงเปลี่ยนผ่าน unauthenticated → authenticated" — จุดเดียวที่ตัดสินเรื่องนี้
 *
 * ลำดับความสำคัญ (precedence model เดียวของทั้งแอป — Login.jsx/App.jsx/Settings.jsx
 * ต้องเดินตามนี้ทั้งหมด ห้ามมีใครเขียนธีมสวนทางเอง):
 *
 *   1. selection — ธีมที่ผู้ใช้ "เพิ่งเลือกเอง" บนหน้า Login ในเซสชันที่ยังไม่ล็อกอินนี้
 *      ชนะเสมอ และถูก sync กลับไปเป็น users.ui_theme หลังล็อกอินสำเร็จ
 *      ⚠️ นี่คือหัวใจของบั๊กที่แก้: ตัวเลือกธีมบนหน้า Login เป็น "การตั้งค่าจริงของผู้ใช้"
 *         ไม่ใช่ของประดับ — ค่า ui_theme เก่าที่ค้างอยู่ในบัญชีห้ามทับสิ่งที่ผู้ใช้เพิ่งกด
 *   2. logoutTheme — ธีมที่บัญชีเดียวกันเพิ่งออกจากระบบมา ใช้ครั้งเดียวเพื่อปิดช่องว่าง
 *      ระหว่างธีมที่เห็นจริงกับ ui_theme ที่อาจยังเป็นค่าเก่า ห้ามใช้กับบัญชีอื่น
 *   3. shellTheme — R4 protected entry contract: Welcome/Hub/Drive Login appearance
 *      continues into Dashboard, including when the account has a stale ui_theme.
 *      Sync the selected shell value to that account only after real auth succeeds.
 *   4. accountTheme — fallback only when no shell preference exists.
 *   5. light — fresh browser with no valid shell or account theme.
 *
 * @returns {{ theme: string, source: string, persistToAccount: boolean }}
 */
export function resolveAuthenticatedTheme({
  selection = null,
  logoutTheme = null,
  accountTheme = null,
  shellTheme = null,
} = {}) {
  if (isValidTheme(selection)) {
    return { theme: selection, source: 'login-selection', persistToAccount: selection !== accountTheme }
  }
  if (isValidTheme(logoutTheme)) {
    return { theme: logoutTheme, source: 'logout-continuity', persistToAccount: logoutTheme !== accountTheme }
  }
  if (isValidTheme(shellTheme)) {
    return { theme: shellTheme, source: 'shell', persistToAccount: shellTheme !== accountTheme }
  }
  if (isValidTheme(accountTheme)) {
    return { theme: accountTheme, source: 'account', persistToAccount: false }
  }
  return { theme: 'light', source: 'default', persistToAccount: false }
}
