// tests/helpers/testClient.mjs — client จำลองที่ "ถือ cookie + CSRF token เหมือนเบราว์เซอร์จริง"
// และผ่านด่าน force-reset ของบัญชี seed ให้เอง
//
// ทำไมต้องมีไฟล์นี้: seed.sql ตั้ง must_reset_password = TRUE ให้ admin/user แล้ว
// (รหัสของทั้งคู่อยู่ใน git = ความรู้สาธารณะ จึงต้องใช้ได้ครั้งเดียวเพื่อตั้งรหัสใหม่)
// ผลคือ "ล็อกอินสำเร็จ" ไม่ได้แปลว่าใช้งาน API ต่อได้อีกแล้ว — ทุก endpoint นอกจาก
// /me, /logout, /password/reset ตอบ 403 PASSWORD_RESET_REQUIRED จนกว่าจะเปลี่ยนรหัส
// ชุดทดสอบจึงต้องเดินเส้นทางเดียวกับผู้ใช้จริงวันแรก ไม่ใช่แอบปิดด่านทิ้ง
//
// ⚠️ ผลข้างเคียงที่ต้องรู้ก่อนตั้ง TEST_DATABASE_URL: ในโหมด Postgres การรีเซ็ตนี้
//    "เปลี่ยนรหัสของบัญชีเดโม่ในฐานข้อมูลนั้นจริง ๆ" (เป็น TEST_PASSWORD ด้านล่าง)
//    หลังรันเทสต์แล้ว รหัสเดโม่ที่เขียนไว้ใน seed.sql จะใช้ล็อกอินไม่ได้อีก —
//    ซึ่งถูกต้องตามการออกแบบ ไม่ใช่บั๊ก ให้ชี้ TEST_DATABASE_URL ไปที่ฐานทดสอบ
//    ของตัวเองเท่านั้น (ดูคำเตือนเดียวกันใน .env.test.example) ถ้าต้องการรหัสเดโม่
//    กลับมาให้ลบ volume แล้ว init ใหม่: docker compose down -v && docker compose up -d postgres
//
// ⚠️ จำรหัสที่ใช้ได้ไว้ในระดับ process (known) โดยเจตนา — ถ้าเดารหัสผิดทุกครั้งที่
//    ล็อกอิน ตัวนับ rate limit (5 ครั้ง/บัญชี และ 5 ครั้ง/IP ดู auth/rateLimit.js)
//    จะล็อกบัญชีกลางชุดทดสอบ แล้วเทสต์จะล้มด้วย 429 โดยที่โค้ดโปรดักชันไม่ผิดอะไร
//    ด้วย cache นี้ worst case คือพลาด 1 ครั้งต่อบัญชีต่อไฟล์เทสต์ (ต่ำกว่าเพดานชัดเจน)
import assert from 'node:assert/strict'

/** รหัสที่ชุดทดสอบตั้งให้หลังผ่านด่าน force-reset
 *  ต้องผ่านนโยบายใน POST /api/password/reset: ยาว ≥ 12, ไม่ซ้ำรหัสเดิม, ไม่เท่ากับ username */
const testPasswordFor = (username) => `aegis-test-${username}-4f19c7d2`

/** username → รหัสที่ "ใช้ได้จริง" ณ ตอนนี้ (ต่อ process — แต่ละไฟล์เทสต์แยกกัน) */
const known = new Map()

export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.cookie = null
    this.csrf = null
  }

  async req(pathname, { method = 'GET', body, headers: extraHeaders } = {}) {
    const headers = { ...extraHeaders }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf

    let payload
    if (body instanceof FormData) payload = body
    else if (typeof body === 'string') {
      // ส่งดิบ ๆ — ผู้เรียกตั้ง Content-Type เอง (ใช้กับฟอร์ม urlencoded ของหน้าไถ่ลิงก์
      // ซึ่งเป็น request แบบที่เบราว์เซอร์ยิงจริงเมื่อกด submit ไม่ใช่ JSON จาก fetch ของแอป)
      payload = body
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const res = await fetch(this.baseUrl + pathname, { method, headers, body: payload, redirect: 'manual' })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')

    let data = null
    try { data = await res.json() } catch { /* ไม่มี body JSON — ปกติสำหรับ 204/ไฟล์ */ }
    return { status: res.status, data, headers: res.headers }
  }

  /** เหมือน req แต่คืน bytes ดิบ — ใช้กับ endpoint ดาวน์โหลดไฟล์ */
  async raw(pathname, { method = 'GET', headers: extraHeaders, body } = {}) {
    const headers = { ...extraHeaders }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    const res = await fetch(this.baseUrl + pathname, { method, headers, body, redirect: 'manual' })
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) }
  }

  /**
   * ส่งฟอร์ม urlencoded แล้วคืน bytes ดิบ — เลียนแบบเบราว์เซอร์กด submit บนหน้า /s/:token
   * (ที่นั่นไม่มี session และไม่มี CSRF token ให้แนบ — ดูเหตุผลใน server/routes/share.js)
   */
  rawPost(pathname, formBody) {
    return this.raw(pathname, {
      method: 'POST',
      body: formBody,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  }
}

/**
 * ล็อกอิน client ตัวใดก็ได้ที่มี .req(path, { method, body }) และฟิลด์ .csrf
 * (ไฟล์เทสต์เดิมมี Client ของตัวเองที่ต่างกันเล็กน้อย — ฟังก์ชันนี้จึงรับ client เข้ามา
 *  แทนที่จะบังคับให้ทุกไฟล์เปลี่ยนไปใช้คลาสเดียวกันในคอมมิตนี้)
 * หลังคืนค่า client จะ "พร้อมใช้ API ทุกเส้นทาง" คือผ่านด่าน force-reset แล้วถ้าติด
 * @returns {Promise<object>} body ของ /api/login (หรือของ /me หลังรีเซ็ต)
 */
export async function performLogin(client, username, seedPassword) {
  const cached = known.get(username)
  // ลองรหัสที่รู้ว่าใช้ได้ก่อน — ไม่สร้าง failed attempt ให้ rate limit นับโดยไม่จำเป็น
  // แต่ยัง fallback ต่อได้ถ้ามันใช้ไม่ได้แล้ว: มีเทสต์ที่ลบแล้วสร้างแถว users ใหม่
  // ระหว่างทาง (ดู FK cascade ใน vaultPostgres.test.js) ทำให้รหัสย้อนกลับเป็นของ seed
  // — ถ้า cache ผิดแล้วยอมแพ้ทันที เทสต์จะล้มด้วยเหตุผลที่ไม่เกี่ยวกับโค้ดโปรดักชันเลย
  const candidates = [...new Set([...(cached ? [cached] : []), seedPassword, testPasswordFor(username)])]

  let res = null
  let used = null
  for (const pw of candidates) {
    res = await client.req('/api/login', { method: 'POST', body: { username, password: pw } })
    if (res.status === 200) { used = pw; break }
  }
  assert.equal(res.status, 200, `login ล้มเหลวสำหรับ ${username} — ได้ ${res.status}: ${JSON.stringify(res.data)}`)

  client.csrf = res.data.csrfToken
  assert.ok(client.csrf, 'server ต้องคืน CSRF token หลัง login')

  // ติดด่าน force-reset (บัญชี seed ครั้งแรก) → เปลี่ยนรหัสให้เรียบร้อยก่อนใช้งานต่อ
  if (res.data.user?.mustResetPassword) {
    const next = testPasswordFor(username)
    const reset = await client.req('/api/password/reset', {
      method: 'POST',
      body: { currentPassword: used, newPassword: next },
    })
    assert.equal(reset.status, 200, `force-reset ล้มเหลวสำหรับ ${username}: ${JSON.stringify(reset.data)}`)
    used = next
  }

  known.set(username, used)
  return res.data
}

/** สร้าง Client ใหม่ + ล็อกอิน (สำหรับไฟล์เทสต์ที่ใช้ Client ของ helper นี้) */
export async function loginClient(baseUrl, username, seedPassword) {
  const c = new Client(baseUrl)
  await performLogin(c, username, seedPassword)
  return c
}

/** รหัสที่ใช้ได้จริงของบัญชีนี้ ณ ตอนนี้ — เทสต์ที่ต้องล็อกอินซ้ำเองใช้ค่านี้ */
export const currentPasswordOf = (username) => known.get(username) ?? null

/** บัญชีเดโม่สองใบที่ทุกไฟล์เทสต์ใช้ร่วมกัน — คนละ role โดยเจตนา */
export const DEMO_ADMIN = { username: 'admin', password: 'aegis-drive-admin' }
export const DEMO_USER = { username: 'user', password: 'aegis-drive-user' }
