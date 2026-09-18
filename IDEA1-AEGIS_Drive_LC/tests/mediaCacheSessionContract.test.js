// tests/mediaCacheSessionContract.test.js — AEGIS Drive (IDEA1) · สัญญา session ↔ browser cache ของ derivative (spec §14.6)
//
// ทำไมต้องมีไฟล์นี้: poster/motion เสิร์ฟด้วย private, max-age=31536000, immutable + Vary: Cookie — ปลอดภัยก็ต่อเมื่อ
// (1) ไม่มี cookie ก่อน login, (2) login สร้าง sid ใหม่เสมอ (regenerate), (3) logout ทำลาย session ฝั่งเซิร์ฟเวอร์ + ล้าง cookie,
// (4) sid คงที่ตลอดเซสชัน (rolling ต่ออายุอย่างเดียว) และ (5) ทุกคำขอยังผ่านด่านเจ้าของเสมอ (cache เป็นแค่ optimisation ของ
// เบราว์เซอร์ ไม่ใช่ control) — ถ้าข้อใดข้อหนึ่งล้ม MEDIA_CACHE_POLICY=revalidate ต้องกลายเป็นค่าเริ่มต้น (plan Task 9)
// ⚠️ service เป็น stub ที่คืน ready เสมอ; ไม่ต้องมี ffmpeg/sharp; memory store เพียงพอ (สัญญาเป็นเรื่องของ session ไม่ใช่ DB)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, performLogin, currentPasswordOf, DEMO_USER, DEMO_ADMIN, Client } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-session-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')
const { SESSION_COOKIE } = await import('../server/auth/session.js')

const derivDir = path.join(STORAGE_ROOT, 'deriv')
await fs.mkdir(derivDir, { recursive: true })
const posterPath = path.join(derivDir, 'poster.webp')
await fs.writeFile(posterPath, Buffer.from('RIFF....WEBPVP8 poster-bytes-session-contract'))
const posterBytes = (await fs.stat(posterPath)).size

const calls = { serve: 0 }
const service = {
  reason: null, limits: null,
  async init() {}, async start() {}, async stop() {},
  async info(row) { return { id: String(row.id), sourceVersion: row.sha256, profile: 'v1', status: 'READY', poster: {}, motion: {} } },
  async infoBatch(rows) { const m = new Map(); for (const r of rows) m.set(String(r.id), await service.info(r)); return m },
  async serve(row, type, { v, p }) { calls.serve += 1; return { kind: 'ready', path: posterPath, mime: 'image/webp', bytes: posterBytes, etag: `"${v}-${p}-${type}"` } },
  async scheduleForFile() { return true }, isPinned() { return false },
  async invalidate() { return true }, async adminStatus() { return {} },
  health() { return { enabled: true, reason: null, ffmpeg: null, sharp: null, cacheWritable: true, cacheVolume: 'unknown' } },
}

let server, base
before(async () => {
  await initStorage()
  const app = createApp({ env: process.env, mediaService: service })
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((r) => server.close(r))
  if (usingPostgres) { await query(`DELETE FROM files WHERE name LIKE 'mediasession-%'`); await closePool() }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

const COOKIE_RE = new RegExp(`${SESSION_COOKIE.replace(/\./g, '\\.')}=([^;]+)`)
const sidOf = (cookieHeader) => { const m = String(cookieHeader ?? '').match(COOKIE_RE); return m ? m[1] : null }
const setCookieSid = (headers) => (headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? null
let seq = 0
async function uploadOwned(client, ext) {
  const name = `mediasession-${Date.now()}-${seq++}.${ext}`
  const form = new FormData(); form.append('file', new Blob([Buffer.from(`bytes-${name}`)]), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, JSON.stringify(res.data)); return res.data.file
}
const posterUrl = (f) => `/api/files/${f.id}/poster?v=${f.sha256}&p=v1`
const logout = (client) => client.raw('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': client.csrf } })

test('SC-1 a pre-login request sets no session cookie (saveUninitialized: false)', async () => {
  const anon = new Client(base)
  const me = await anon.req('/api/me')
  assert.equal(me.status, 401)
  assert.equal(setCookieSid(me.headers), null, 'no Set-Cookie before login')
  const health = await anon.raw('/healthz')
  assert.equal(setCookieSid(health.headers), null, 'health check must not create a session cookie either')
  assert.equal(anon.cookie, null)
})

test('SC-2 login sets HttpOnly SameSite=Strict sid; a second login on a fresh jar yields a different sid (regenerate)', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const sidA = sidOf(a.cookie)
  assert.ok(sidA, 'login must set the session cookie')
  const b = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const sidB = sidOf(b.cookie)
  assert.ok(sidB)
  assert.notEqual(sidA, sidB, 'each login regenerates its own sid')
  // คุณสมบัติ cookie จาก login ที่สำเร็จจริง (ล็อกอินอีกครั้งด้วยรหัสที่ helper รู้แล้ว → ไม่สร้าง failed attempt)
  const c = new Client(base)
  const loginRaw = await c.req('/api/login', { method: 'POST', body: { username: DEMO_USER.username, password: currentPasswordOf(DEMO_USER.username) } })
  assert.equal(loginRaw.status, 200, JSON.stringify(loginRaw.data))
  const set = setCookieSid(loginRaw.headers)
  assert.ok(set, 'Set-Cookie on login')
  assert.match(set, /HttpOnly/i)
  assert.match(set, /SameSite=Strict/i)
  assert.notEqual(sidOf(set), sidB, 'third login differs from the second too')
  // fixation ของจริง: jar ที่ถือ sid อยู่แล้ว login อีกครั้ง → sid ต้องเปลี่ยน (regenerate) ไม่ใช่ใช้ id เดิมต่อ
  const sidC = sidOf(set)
  const again = await c.req('/api/login', { method: 'POST', body: { username: DEMO_USER.username, password: currentPasswordOf(DEMO_USER.username) } })
  assert.equal(again.status, 200)
  const setAgain = setCookieSid(again.headers)
  assert.ok(setAgain, 'a re-login on a live session must issue a new cookie')
  assert.notEqual(sidOf(setAgain), sidC, 'the pre-login sid is not carried into the new session')
})

test('SC-3 poster as the owner → 200 with Vary: Cookie; a repeat with If-None-Match → 304 and the server still runs the gate + service', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await uploadOwned(a, 'png')
  const before = calls.serve
  const r1 = await a.raw(posterUrl(f))
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('vary'), 'Cookie')
  assert.equal(r1.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  const etag = r1.headers.get('etag')
  assert.equal(etag, `"${f.sha256}-v1-poster"`)
  const r2 = await a.raw(posterUrl(f), { headers: { 'If-None-Match': etag } })
  assert.equal(r2.status, 304)
  assert.equal(r2.headers.get('vary'), 'Cookie')
  assert.equal(r2.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  // service ถูกเรียกก็ต่อเมื่อผ่านด่านเจ้าของแล้ว — สองครั้ง = ด่านรันทุกคำขอ ไม่มี short-circuit ฝั่งเซิร์ฟเวอร์
  assert.equal(calls.serve - before, 2)
})

test('SC-4 logout clears the cookie (Max-Age=0 / past Expires); the same poster URL without a cookie → 401 no-store', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await uploadOwned(a, 'png')
  assert.equal((await a.raw(posterUrl(f))).status, 200)
  const out = await logout(a)
  assert.ok([200, 204].includes(out.status), `logout status ${out.status}`)
  const cleared = setCookieSid(out.headers)
  assert.ok(cleared, 'logout must send a clearing Set-Cookie')
  assert.ok(/Max-Age=0/i.test(cleared) || /Expires=Thu, 01 Jan 1970/i.test(cleared), cleared)
  const anon = new Client(base)
  const r = await anon.raw(posterUrl(f))
  assert.equal(r.status, 401)
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
})

test('SC-5 replaying the old sid after logout → 401 (destroyed server-side, not merely cleared client-side)', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await uploadOwned(a, 'png')
  const oldCookie = a.cookie
  assert.ok(sidOf(oldCookie))
  const out = await logout(a)
  assert.ok([200, 204].includes(out.status))
  const replay = new Client(base)
  replay.cookie = oldCookie
  const r = await replay.raw(posterUrl(f))
  assert.equal(r.status, 401)
  assert.equal((await replay.req('/api/me')).status, 401)
})

test('SC-6 user B on the same browser after A logs out → same URL is 404 + FILE_PREVIEW DENIED; B sid ≠ A sid; service untouched', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await uploadOwned(a, 'png')
  const sidA = sidOf(a.cookie)
  const out = await logout(a)
  assert.ok([200, 204].includes(out.status))
  const jar = new Client(base) // jar ถูกล้างโดย logout แล้ว
  await performLogin(jar, DEMO_ADMIN.username, DEMO_ADMIN.password) // B (Admin — พิสูจน์ด้วยว่าไม่มี admin override)
  const sidB = sidOf(jar.cookie)
  assert.ok(sidB)
  assert.notEqual(sidB, sidA)
  const before = calls.serve
  const deniedBefore = (await readAudit(200)).filter((e) => e.action === 'FILE_PREVIEW' && e.result === 'DENIED').length
  const r = await jar.raw(posterUrl(f))
  assert.equal(r.status, 404)
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
  assert.equal(calls.serve, before, 'service never consulted for a non-owner')
  const deniedAfter = (await readAudit(200)).filter((e) => e.action === 'FILE_PREVIEW' && e.result === 'DENIED').length
  assert.equal(deniedAfter, deniedBefore + 1, 'exactly one new FILE_PREVIEW DENIED audit row')
})

test('SC-7 rolling: consecutive requests keep the same sid (only expiry refreshes) — the Vary key is stable within a session', async () => {
  const a = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await uploadOwned(a, 'png')
  const sid0 = sidOf(a.cookie)
  const r1 = await a.raw(posterUrl(f))
  const r2 = await a.raw(posterUrl(f))
  for (const r of [r1, r2]) {
    assert.equal(r.status, 200)
    const set = setCookieSid(r.headers)
    if (set) assert.equal(sidOf(set), sid0, 'rolling refresh must not change the sid')
  }
  assert.equal((await a.req('/api/me')).status, 200)
  assert.equal(sidOf(a.cookie), sid0)
})

test('SC-8 static contract: establishSession regenerates; destroySession destroys + clears the cookie; cookie flags pinned', async () => {
  const src = await fs.readFile(new URL('../server/auth/session.js', import.meta.url), 'utf8')
  const estStart = src.indexOf('export function establishSession')
  assert.ok(estStart >= 0)
  const estEnd = src.indexOf('\nexport ', estStart + 10)
  const establish = src.slice(estStart, estEnd > 0 ? estEnd : undefined)
  assert.match(establish, /req\.session\.regenerate\(/)
  const desStart = src.indexOf('export function destroySession')
  assert.ok(desStart >= 0)
  const desEnd = src.indexOf('\nexport ', desStart + 10)
  const destroy = src.slice(desStart, desEnd > 0 ? desEnd : undefined)
  assert.match(destroy, /req\.session\.destroy\(/)
  assert.match(destroy, /res\.clearCookie\(SESSION_COOKIE\)/)
  assert.match(src, /saveUninitialized:\s*false/)
  assert.match(src, /rolling:\s*true/)
  assert.match(src, /httpOnly:\s*true/)
  assert.match(src, /sameSite:\s*'strict'/)
})
