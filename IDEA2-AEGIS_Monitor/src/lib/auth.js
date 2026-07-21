// src/lib/auth.js — AEGIS Monitor (IDEA2)
// ⚠️ ไม่มี logic เรื่อง role ฝั่ง client — ตัวห่อบาง ๆ บน api.js:
// role + เมนู/วิวถูกตัดสิน "ฝั่งเซิร์ฟเวอร์" จากฐานข้อมูล aegis_monitor เท่านั้น
// (Identity ของ Monitor แยกขาดจาก Drive และ HUB — ไม่มี SSO ใด ๆ)
import { apiFetch, setCsrfToken, clearCsrfToken } from './api.js'

/** POST /api/login — ส่งแค่ { username, password, remember } — ไม่มี role เด็ดขาด */
export async function login({ username, password, remember }) {
  const { ok, status, data } = await apiFetch('/api/login', {
    method: 'POST',
    body: { username, password, remember: Boolean(remember) },
    suppressAuthHandler: true, // 401 ที่นี่คือ "รหัสผิด" ไม่ใช่ "เซสชันหมด"
  })
  if (!ok || !data?.user) return { ok: false, status, lockedMs: data?.lockedMs ?? 0 }
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

/** POST /api/logout — ทำลายเซสชันฝั่งเซิร์ฟเวอร์ */
export async function logout() {
  await apiFetch('/api/logout', { method: 'POST', suppressAuthHandler: true })
  clearCsrfToken()
}

/**
 * GET /api/cameras — กล้องที่ "ผู้ใช้คนนี้" มองเห็นได้
 * ⚠️ ขอบเขตกรองผ่าน camera_assignment ฝั่งเซิร์ฟเวอร์แล้ว — client ไม่กรองเอง
 */
export async function fetchCameras() {
  const { ok, data } = await apiFetch('/api/cameras')
  if (!ok || !Array.isArray(data?.cameras)) return null
  return data.cameras
}
