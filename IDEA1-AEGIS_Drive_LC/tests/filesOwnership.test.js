// tests/filesOwnership.test.js — AEGIS Drive (IDEA1) · ด่าน ownership ของ DELETE /api/files/:id
//
// ยิงผ่าน Express app "ตัวเดียวกับที่รันใน production" (server/app.js) — middleware ทุกชั้น
// (securityHeaders / session / CSRF / requireAuth) ทำงานจริง ไม่มีการ mock
// แบบแผนเดียวกับ tests/vaultApi.test.js
//
// สิ่งที่ชุดนี้พิสูจน์ (บั๊กจริงที่เคยมี: requireAuth เพียงลำพังไม่ได้ตรวจว่าไฟล์เป็นของใคร):
//   1. ผู้ใช้ B ลบไฟล์ของผู้ใช้ A ไม่ได้ → 403
//   2. เมื่อถูกปฏิเสธแล้ว **ไฟล์ยังอยู่จริงทั้งแถว metadata และ bytes บนดิสก์**
//      (403 ที่ลบของจริงไปแล้วก็ไร้ความหมาย — ต้องพิสูจน์ทั้งสองชั้น)
//   3. เจ้าของตัวจริงลบได้ปกติ (ด่านใหม่ไม่ได้พังฟีเจอร์)
//   4. Admin ก็ลบไฟล์ของผู้อื่นไม่ได้ — ตรงตาม rbac/permissions.js ที่ระบุว่าสอง role
//      จัดการไฟล์ได้ "เท่ากัน" (Admin ได้เพิ่มแค่จอ governance ไม่ใช่สิทธิ์เหนือไฟล์คนอื่น)
//   5. ความพยายามที่ถูกปฏิเสธถูกบันทึกลง audit เป็น DENIED (มองเห็นได้ในจอ Audit)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// STORAGE_ROOT ต้องถูกตั้ง "ก่อน" import โมดูลที่อ่านค่านี้ตอน module-load
const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-files-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

// ตั้ง TEST_DATABASE_URL → รันกับ Postgres จริง (production code path)
// ไม่ตั้ง → dev fallback ในหน่วยความจำ · ชุดเดียวกันต้องผ่านทั้งสองโหมด
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey } = await import('../server/storage/fileStore.js')
const { readAudit, usingPostgres, closePool } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[files ownership tests] database mode: ${DB_MODE}`)

// บัญชีเดโม่สองคน — คนละ role กันโดยเจตนา เพื่อให้เคส "Admin ก็ไม่มีสิทธิ์" ถูกทดสอบด้วย
const USER_A = { username: 'user', password: 'aegis-drive-user' }   // DataLake-User (เจ้าของไฟล์)
const USER_B = { username: 'admin', password: 'aegis-drive-admin' } // Admin (ผู้บุกรุก)

let server, baseUrl

before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  if (usingPostgres) await closePool()
})

// ── client จำลอง: ถือ cookie + CSRF token เหมือนเบราว์เซอร์จริง ───────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }

  async req(pathname, { method = 'GET', body } = {}) {
    const headers = {}
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (body instanceof FormData) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }

    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* ไม่มี body */ }
    return { status: res.status, data }
  }

  async login({ username, password }) {
    const res = await this.req('/api/login', { method: 'POST', body: { username, password } })
    assert.equal(res.status, 200, `login ล้มเหลวสำหรับ ${username}`)
    this.csrf = res.data.csrfToken
    assert.ok(this.csrf, 'server ต้องคืน CSRF token หลัง login')
    return res.data
  }
}

const loginAs = async (who) => { const c = new Client(); await c.login(who); return c }

/** อัปโหลดไฟล์จริงผ่าน multipart — bytes ลงดิสก์จริง เหมือนที่เบราว์เซอร์ทำ */
async function uploadFile(client, { name, content }) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  form.append('name', name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `อัปโหลดล้มเหลว: ${JSON.stringify(res.data)}`)
  return res.data.file
}

/** ไฟล์นี้ยังมี bytes อยู่บน Storage Layer จริงไหม (ไม่ผ่าน API — อ่านดิสก์ตรง ๆ) */
async function bytesExistOnDisk(storageKey) {
  const abs = resolveKey(storageKey)
  if (!abs) return false
  try { return (await fs.stat(abs)).isFile() } catch { return false }
}

const findById = (list, id) => list.find((f) => String(f.id) === String(id)) ?? null

// ═══ เคสหลัก: A ลบไฟล์ของ B ไม่ได้ ══════════════════════════════════════════
test('ผู้ใช้อื่นลบไฟล์ของเจ้าของไม่ได้ → 403 และไฟล์ยังอยู่ครบทั้ง metadata และ bytes', async () => {
  const alice = await loginAs(USER_A)
  const bob = await loginAs(USER_B)

  const file = await uploadFile(alice, {
    name: 'alice-private-notes.txt',
    content: 'ownership boundary probe — must survive a cross-user delete attempt',
  })
  assert.ok(file?.id, 'อัปโหลดต้องคืนแถวไฟล์')

  // ยืนยัน "ก่อน" ว่า bytes อยู่บนดิสก์จริง ไม่ใช่แค่แถวใน DB
  assert.equal(await bytesExistOnDisk(file.path), true, 'ต้องมี bytes บนดิสก์ก่อนเริ่มทดสอบ')

  // ── การโจมตี: bob (ไม่ใช่เจ้าของ) สั่งลบไฟล์ของ alice ──
  const del = await bob.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })

  assert.equal(del.status, 403, `ต้องได้ 403 ไม่ใช่ ${del.status} — ได้ body: ${JSON.stringify(del.data)}`)
  assert.equal(del.data?.error, 'Forbidden')

  // ── ที่สำคัญกว่าสถานะ: ของจริงต้องไม่ถูกลบ ──
  const afterList = await alice.req('/api/files')
  assert.ok(findById(afterList.data.files, file.id), 'แถว metadata ต้องยังอยู่หลังถูกปฏิเสธ')
  assert.equal(await bytesExistOnDisk(file.path), true, 'bytes บนดิสก์ต้องยังอยู่หลังถูกปฏิเสธ')

  // เจ้าของตัวจริงยังลบได้ปกติ — ด่านใหม่ต้องไม่พังฟีเจอร์
  const ownDel = await alice.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
  assert.equal(ownDel.status, 200, 'เจ้าของต้องลบไฟล์ตัวเองได้')
  assert.equal(await bytesExistOnDisk(file.path), false, 'ลบสำเร็จแล้ว bytes ต้องหายไปจากดิสก์ด้วย')

  const finalList = await alice.req('/api/files')
  assert.equal(findById(finalList.data.files, file.id), null, 'แถว metadata ต้องหายไปหลังเจ้าของลบ')
})

// ═══ ทิศทางกลับกัน: Admin ก็ไม่มีสิทธิ์เหนือไฟล์ของผู้อื่น ══════════════════════
test('Admin ลบไฟล์ของ DataLake-User ไม่ได้ (สอง role จัดการไฟล์เท่ากันตาม permissions.js)', async () => {
  const bob = await loginAs(USER_B)   // Admin — เป็นเจ้าของไฟล์รอบนี้
  const alice = await loginAs(USER_A) // DataLake-User — ผู้บุกรุกรอบนี้

  const file = await uploadFile(bob, { name: 'admin-owned.txt', content: 'owned by the admin account' })

  const del = await alice.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
  assert.equal(del.status, 403, 'DataLake-User ต้องลบไฟล์ของ Admin ไม่ได้')
  assert.equal(await bytesExistOnDisk(file.path), true, 'bytes ต้องยังอยู่')

  // เก็บกวาด: เจ้าของลบเอง
  const ownDel = await bob.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
  assert.equal(ownDel.status, 200)
})

// ═══ ไฟล์ที่ไม่มีอยู่ ยังต้องเป็น 404 ไม่ใช่ 403 ═══════════════════════════════
test('ไฟล์ที่ไม่มีอยู่ → 404 (ด่าน ownership ไม่กลืนเคส not-found)', async () => {
  const alice = await loginAs(USER_A)
  const res = await alice.req('/api/files/999999999', { method: 'DELETE' })
  assert.equal(res.status, 404)
})

// ═══ audit ต้องเห็นความพยายามที่ถูกปฏิเสธ ═════════════════════════════════════
test('ความพยายามลบข้ามเจ้าของถูกบันทึกลง audit เป็น DENIED', async () => {
  const alice = await loginAs(USER_A)
  const bob = await loginAs(USER_B)

  const file = await uploadFile(alice, { name: 'audited-denial.txt', content: 'x' })
  const del = await bob.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
  assert.equal(del.status, 403)

  const events = await readAudit(50)
  const label = (e) => e.actor_label ?? e.actorLabel
  const denied = events.find(
    (e) => e.action === 'FILE_DELETE' && e.result === 'DENIED' && label(e) === USER_B.username,
  )
  assert.ok(denied, 'audit ต้องมีแถว FILE_DELETE / DENIED ของผู้ที่พยายามลบ')

  await alice.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})
