// src/lib/api.js — AEGIS Monitor (IDEA2) · ตัวกลาง fetch หนึ่งเดียวของ console
// same-origin เสมอ (dev: vite proxy → :8002; prod: Express เสิร์ฟ dist + /api)
// - credentials: 'include' ทุกครั้ง (session cookie เป็น HttpOnly)
// - CSRF token (synchronizer) แนบกับทุก request ที่เปลี่ยนสถานะ — เก็บใน memory เท่านั้น
// - timeout 10s ผ่าน AbortController + ยกเลิกเมื่อ component unmount
// - 401 กลางคัน → แจ้ง App เคลียร์เซสชันกลับหน้า login (ไม่ค้างจอ)

const TIMEOUT_MS = 10_000

// เติม import.meta.env.BASE_URL (Vite `base`, ดู vite.config.js) นำหน้า path
// รูท-สัมบูรณ์ทุกครั้ง — ทำให้ apiFetch('/api/x') วิ่งไปที่ '/monitor/api/x' เมื่อ build
// ด้วย base '/monitor/' (mount ใต้ HUB) หรือ '/api/x' เดิมเมื่อ base เป็นค่าเริ่มต้น '/'
function withBase(path) {
  if (!path.startsWith('/')) return path
  return import.meta.env.BASE_URL + path.slice(1)
}

let csrfToken = null
export const setCsrfToken = (t) => { csrfToken = t }
export const clearCsrfToken = () => { csrfToken = null }

let onUnauthorized = null
export const registerUnauthorizedHandler = (fn) => { onUnauthorized = fn }

export async function apiFetch(path, { method = 'GET', body, signal, suppressAuthHandler = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS)
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }

  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken

  let res
  try {
    res = await fetch(withBase(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: ctrl.signal,
    })
  } catch {
    clearTimeout(timer)
    const kind = ctrl.signal.reason === 'timeout' ? 'timeout' : 'network'
    return { ok: false, status: 0, data: null, errorKind: kind }
  }
  clearTimeout(timer)

  let data = null
  try {
    data = await res.json()
  } catch { /* no body */ }

  if (res.ok) return { ok: true, status: res.status, data, errorKind: null }
  if (res.status === 401) {
    if (!suppressAuthHandler) onUnauthorized?.()
    return { ok: false, status: 401, data, errorKind: 'unauthorized' }
  }
  if (res.status === 403) return { ok: false, status: 403, data, errorKind: 'forbidden' }
  return { ok: false, status: res.status, data, errorKind: 'server' }
}
