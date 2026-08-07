// src/lib/api.js — AEGIS Drive (IDEA1) · ตัวกลาง fetch หนึ่งเดียวของแอป
// ทุก request วิ่งผ่านที่นี่ — ไม่มี URL ตายตัว (same-origin เสมอ: dev ผ่าน vite proxy,
// production ผ่าน Express ที่เสิร์ฟ dist + /api จาก origin เดียวกัน)
//
// หน้าที่:
//   - credentials: 'include' ทุกครั้ง (session cookie เป็น HttpOnly — JS ไม่แตะ)
//   - แนบ CSRF token (synchronizer) กับทุก request ที่เปลี่ยนสถานะ
//   - timeout 10 วินาที ผ่าน AbortController (+ ยกเลิกเมื่อ component unmount)
//   - normalize ผลลัพธ์เป็นรูปเดียว: { ok, status, data, errorKind }
//   - 401 interceptor: เซสชันหมดอายุ → แจ้ง App ให้เคลียร์ state กลับหน้า login
//     (ไม่มี redirect ตายตัว — App เป็นคนตัดสินว่า "กลับประตู" หน้าตาเป็นอย่างไร)

const TIMEOUT_MS = 10_000
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED'

// เติม import.meta.env.BASE_URL (Vite `base`, ดู vite.config.js) นำหน้า path
// รูท-สัมบูรณ์ทุกครั้ง — ทำให้ apiFetch('/api/x') วิ่งไปที่ '/drive/api/x' เมื่อ build
// ด้วย base '/drive/' (mount ใต้ HUB) หรือ '/api/x' เดิมเมื่อ base เป็นค่าเริ่มต้น '/'
// (dev แบบ standalone) — ไม่ต้องแก้ path ตายตัวที่จุดเรียกทุกจุดทั่วแอป
function withBase(path) {
  if (!path.startsWith('/')) return path
  return import.meta.env.BASE_URL + path.slice(1)
}

// URL เต็ม (รวม base) สำหรับกรณีที่ต้องให้ "เบราว์เซอร์" เป็นคนไปเอาเอง ไม่ใช่ fetch —
// เช่นดาวน์โหลดไฟล์ ที่ต้องให้ browser จัดการ stream + Content-Disposition เอง
// session cookie เป็น HttpOnly + SameSite=Strict และเป็น same-origin จึงถูกแนบไปให้เอง
// โดยที่ JS ไม่ต้อง (และไม่สามารถ) แตะ cookie เลย
export const apiUrl = withBase

// CSRF token — หน่วยความจำของโมดูลเท่านั้น (zero browser storage)
let csrfToken = null
export const setCsrfToken = (t) => { csrfToken = t }
export const clearCsrfToken = () => { csrfToken = null }

// 401 handler — App ลงทะเบียนไว้ตอน mount; เรียกเมื่อเซสชันหมดอายุกลางคัน
let onUnauthorized = null
export const registerUnauthorizedHandler = (fn) => { onUnauthorized = fn }

/**
 * อัปโหลด multipart ด้วย XHR เพราะ fetch ไม่มี upload-progress event ที่ใช้ได้ข้าม browser
 * ⚠️ จำนวนที่ส่งให้ UI มาจาก event.loaded/event.total เท่านั้น ถ้า browser ไม่บอก total
 * จะไม่เดาเปอร์เซ็นต์ และ CSRF/session ยังคงเป็น header + HttpOnly cookie เหมือน apiFetch
 */
export function apiUpload(path, {
  method = 'POST',
  body,
  signal,
  onProgress,
  suppressAuthHandler = false,
  timeoutMs = 10 * 60_000,
} = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', abortFromSignal)
      resolve(result)
    }
    const abortFromSignal = () => xhr.abort()

    xhr.open(method, withBase(path), true)
    xhr.withCredentials = true
    xhr.timeout = timeoutMs
    if (method !== 'GET' && csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 10_000) / 100))
      onProgress?.({ loadedBytes: event.loaded, totalBytes: event.total, percent })
    }

    xhr.onload = () => {
      let data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* body may be empty */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish({ ok: true, status: xhr.status, data, errorKind: null })
        return
      }
      if (xhr.status === 401) {
        if (!suppressAuthHandler) onUnauthorized?.()
        finish({ ok: false, status: 401, data, errorKind: 'unauthorized' })
        return
      }
      if (xhr.status === 403) {
        if (typeof data?.code === 'string' && data.code.startsWith('CSRF_')) {
          finish({ ok: false, status: 403, data, errorKind: 'csrf' })
          return
        }
        if (data?.error === PASSWORD_RESET_REQUIRED) {
          finish({ ok: false, status: 403, data, errorKind: 'password-reset-required', errorCode: PASSWORD_RESET_REQUIRED })
          return
        }
        finish({ ok: false, status: 403, data, errorKind: 'forbidden' })
        return
      }
      finish({ ok: false, status: xhr.status, data, errorKind: 'server' })
    }
    xhr.ontimeout = () => finish({ ok: false, status: 0, data: null, errorKind: 'timeout' })
    xhr.onerror = () => finish({ ok: false, status: 0, data: null, errorKind: 'network' })
    xhr.onabort = () => finish({ ok: false, status: 0, data: null, errorKind: 'network' })

    if (signal) {
      if (signal.aborted) {
        finish({ ok: false, status: 0, data: null, errorKind: 'network' })
        return
      }
      signal.addEventListener('abort', abortFromSignal, { once: true })
    }
    xhr.send(body)
  })
}

/**
 * ดึง response แบบ "ไบต์ดิบ" (ไม่ parse JSON) — ใช้กับ ciphertext ของ Private Vault
 * ที่ต้องเอา bytes ไปถอดรหัสในเบราว์เซอร์ต่อ ไม่ใช่ให้ browser โหลดเป็นไฟล์ตรง ๆ
 * (ถ้าปล่อยให้ browser ดาวน์โหลดเอง ผู้ใช้จะได้ .aegisenc ที่เปิดไม่ได้)
 *
 * ⚠️ timeout ยาวกว่าปกติเพราะไฟล์อาจใหญ่ — แต่ยังมีเพดาน ไม่ปล่อยค้างถาวร
 * @returns {Promise<{ ok: boolean, status: number, bytes: Uint8Array|null,
 *                     errorKind: null|'timeout'|'network'|'unauthorized'|'forbidden'|'server' }>}
 */
export async function apiFetchBytes(path, { signal, timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }

  let res
  try {
    res = await fetch(withBase(path), { credentials: 'include', signal: ctrl.signal })
  } catch {
    clearTimeout(timer)
    const kind = ctrl.signal.reason === 'timeout' ? 'timeout' : 'network'
    return { ok: false, status: 0, bytes: null, errorKind: kind }
  }
  clearTimeout(timer)

  if (!res.ok) {
    if (res.status === 401) {
      onUnauthorized?.()
      return { ok: false, status: 401, bytes: null, errorKind: 'unauthorized' }
    }
    if (res.status === 403) return { ok: false, status: 403, bytes: null, errorKind: 'forbidden' }
    return { ok: false, status: res.status, bytes: null, errorKind: 'server' }
  }

  const buf = await res.arrayBuffer()
  return { ok: true, status: res.status, bytes: new Uint8Array(buf), errorKind: null }
}

/**
 * @param {string} path เช่น '/api/files'
 * @param {{ method?: string, body?: object, signal?: AbortSignal,
 *           suppressAuthHandler?: boolean }} opts
 * @returns {Promise<{ ok: boolean, status: number, data: any,
 *                     errorKind: null|'timeout'|'network'|'unauthorized'|'csrf'|'password-reset-required'|'forbidden'|'server',
 *                     errorCode?: string }>}
 */
export async function apiFetch(path, { method = 'GET', body, signal, suppressAuthHandler = false, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)
  // ผูก signal ของผู้เรียก (unmount) เข้ากับของเรา (timeout) — ยกเลิกอันใดอันหนึ่งก็หยุด
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  }

  // FormData = อัปโหลดไฟล์จริง (multipart) — ห้ามตั้ง Content-Type เอง เพราะ boundary
  // ถูกสร้างโดยเบราว์เซอร์ ถ้าเซ็ตทับ multer จะ parse ไม่ออก ส่วน CSRF token ยังแนบ
  // ทาง header เหมือนเดิม (session cookie ยัง HttpOnly — ไม่มีอะไรย้ายไป browser storage)
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData

  const headers = {}
  if (body && !isFormData) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken

  let res
  try {
    res = await fetch(withBase(path), {
      method,
      headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
      credentials: 'include',
      signal: ctrl.signal,
    })
  } catch {
    clearTimeout(timer)
    // แยก timeout ออกจาก network เพื่อให้ข้อความ error ฝั่ง UI ตรงสาเหตุ
    const kind = ctrl.signal.reason === 'timeout' ? 'timeout' : 'network'
    return { ok: false, status: 0, data: null, errorKind: kind }
  }
  clearTimeout(timer)

  let data = null
  try {
    data = await res.json()
  } catch {
    /* บาง response ไม่มี body */
  }

  if (res.ok) return { ok: true, status: res.status, data, errorKind: null }

  if (res.status === 401) {
    // เซสชันหมด/ถูกทำลายฝั่งเซิร์ฟเวอร์ — เคลียร์ state กลับประตู
    // (ยกเว้น endpoint ตรวจสถานะอย่าง /api/me ที่ 401 คือคำตอบปกติก่อน login)
    if (!suppressAuthHandler) onUnauthorized?.()
    return { ok: false, status: 401, data, errorKind: 'unauthorized' }
  }
  if (res.status === 403) {
    // ⚠️ 403 จาก CSRF ต้องแยกออกจาก 403 "ไม่มีสิทธิ์" ให้ได้ตั้งแต่ชั้นนี้ —
    // มันคือคำขอที่ถูกบล็อก "ก่อน" จะมีการตรวจตัวตนหรือสิทธิ์ใด ๆ ทั้งสิ้น
    // จอที่เรียกจึงต้องไม่มีทางเอาไปแสดงว่าเป็นความล้มเหลวของรหัสผ่าน/สิทธิ์
    if (typeof data?.code === 'string' && data.code.startsWith('CSRF_')) {
      return { ok: false, status: 403, data, errorKind: 'csrf' }
    }
    // บัญชีที่ยังใช้รหัสผ่านชั่วคราวถูกยืนยันตัวตนแล้ว แต่ยังไม่มีสิทธิ์เข้าแอป
    // เก็บรหัสนี้ไว้เป็นสถานะเฉพาะ ห้ามลดทอนเป็น forbidden จน UI แปลผิดว่า RBAC ปฏิเสธ
    if (data?.error === PASSWORD_RESET_REQUIRED) {
      return {
        ok: false,
        status: 403,
        data,
        errorKind: 'password-reset-required',
        errorCode: PASSWORD_RESET_REQUIRED,
      }
    }
    return { ok: false, status: 403, data, errorKind: 'forbidden' }
  }
  return { ok: false, status: res.status, data, errorKind: 'server' }
}
