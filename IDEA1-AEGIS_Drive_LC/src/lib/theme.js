export const SHELL_THEME_KEY = 'aegis_shell_theme'
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
  try {
    const source = storage ?? globalThis.localStorage
    const stored = source?.getItem(SHELL_THEME_KEY)
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
 *   2. accountTheme — ถ้าไม่มีการเลือกใหม่ ให้ค่าของบัญชีเป็นตัวตัดสิน (พฤติกรรมเดิม)
 *      ⚠️ เจตนา: การสลับบัญชีต้องไม่ทำให้บัญชีที่เพิ่งล็อกอินถูกเขียนทับ ui_theme ด้วย
 *         ธีมที่ค้างอยู่จากบัญชีก่อนหน้า ทั้งที่ผู้ใช้ไม่ได้แตะตัวเลือกธีมเลยสักครั้ง
 *   3. shellTheme — บัญชีไม่มีค่าที่ใช้ได้ (ข้อมูลเก่า/เพี้ยน) → ใช้ธีมที่ตาเห็นอยู่ต่อ
 *      แล้ว sync ขึ้นบัญชี เพื่อให้สามค่า (บัญชี · shell · ที่ render จริง) ลู่เข้าหากัน
 *   4. light — เบราว์เซอร์ใหม่เอี่ยม ไม่มีอะไรเลย (ห้ามเดาจาก OS ถ้าไม่ได้เลือก system)
 *
 * @returns {{ theme: string, source: string, persistToAccount: boolean }}
 */
export function resolveAuthenticatedTheme({ selection = null, accountTheme = null, shellTheme = null } = {}) {
  if (isValidTheme(selection)) {
    return { theme: selection, source: 'login-selection', persistToAccount: selection !== accountTheme }
  }
  if (isValidTheme(accountTheme)) {
    return { theme: accountTheme, source: 'account', persistToAccount: false }
  }
  if (isValidTheme(shellTheme)) {
    return { theme: shellTheme, source: 'shell', persistToAccount: true }
  }
  return { theme: 'light', source: 'default', persistToAccount: false }
}
