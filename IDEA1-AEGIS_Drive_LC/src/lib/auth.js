// src/lib/auth.js — AEGIS Drive (IDEA1)
// ⚠️ ไม่มี logic เรื่อง role ฝั่ง client — ตัวห่อบาง ๆ บน api.js:
// เรียก /api/login, /api/me, /api/logout แล้ว "อ่าน" คำตอบที่เซิร์ฟเวอร์ตัดสินมา
//
// role ถูกตัดสินฝั่งเซิร์ฟเวอร์จาก record ใน PostgreSQL แล้วเก็บใน session store
// (cookie เป็นแค่ session id ทึบ + HttpOnly) — JavaScript อ่าน/แก้ไม่ได้
// client ไม่เคยประกาศ role ของตัวเอง และไม่เก็บ auth state ใน local/session storage
// (aegis_shell_theme เป็นเพียง hint ด้านภาพ ไม่มี identity/role/token)
import { apiFetch, setCsrfToken, clearCsrfToken } from './api.js'

/**
 * POST /api/login — ส่งแค่ { username, password, remember }
 * ⚠️ ไม่มี role ใน body เด็ดขาด (role มาจากคำตอบของเซิร์ฟเวอร์เท่านั้น)
 */
export async function login({ username, password, remember }) {
  const { ok, status, data, errorKind } = await apiFetch('/api/login', {
    method: 'POST',
    body: { username, password, remember: Boolean(remember) },
    suppressAuthHandler: true, // 401 ที่นี่คือ "รหัสผิด" ไม่ใช่ "เซสชันหมด"
  })
  // ⚠️ ต้องส่ง errorKind ต่อขึ้นไปเสมอ — เดิมทิ้งไว้ตรงนี้ จอ Login จึงเหลือแค่
  //    "ล้มเหลว/ไม่ล้มเหลว" แล้วเดาว่าทุกความล้มเหลวคือรหัสผ่านผิด ซึ่งไม่จริง:
  //    403 (ถูกบล็อกด้วย CSRF) / timeout / network / 5xx ไม่เคยแตะรหัสผ่านเลยสักครั้ง
  if (!ok || !data?.user) {
    return { ok: false, status, errorKind, lockedMs: data?.lockedMs ?? 0 }
  }
  setCsrfToken(data.csrfToken ?? null)
  return { ok: true, user: data.user, menu: data.menu ?? [] }
}

/** GET /api/me — ผู้ใช้ปัจจุบัน + เมนูตาม role (null ถ้ายังไม่ล็อกอิน) */
export async function fetchMe() {
  const { ok, data } = await apiFetch('/api/me', { suppressAuthHandler: true })
  if (!ok || !data?.user) return null
  setCsrfToken(data.csrfToken ?? null)
  return { user: data.user, menu: data.menu ?? [] }
}

/** POST /api/logout — ทำลายเซสชันฝั่งเซิร์ฟเวอร์ + ล้าง token ในหน่วยความจำ */
export async function logout() {
  await apiFetch('/api/logout', { method: 'POST', suppressAuthHandler: true })
  clearCsrfToken()
}
