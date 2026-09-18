// tests/mediaRoutes.test.js — AEGIS Drive (IDEA1) · authenticated media derivative routes (Task 8)
//
// ⚠️ spec §14, §17: ทุก route = requireAuth + ด่านเจ้าของเดียวกับ /preview (Admin ไม่ override), ข้ามเจ้าของ/ไม่มี/
//    vault = 404 + audit DENIED (object-hiding), โฟลเดอร์ = 400, vault ไม่มีวันถึง service; binary route ต้องมี
//    v=<sha ปัจจุบัน> และ p=<profile ปัจจุบัน> ทั้งคู่ (ผิด = 404, ขาด/ผิดรูป = 400); 200/304 = ETag "<sha>-<profile>-<type>"
//    + immutable + Vary: Cookie (หรือ must-revalidate เมื่อ MEDIA_CACHE_POLICY=revalidate); ทุกอย่างที่ไม่ใช่ 200 = no-store;
//    motion รองรับ Range 206/416; pending 202 + Retry-After; retryable 503; failed 422; unsupported/disabled 415
//    service เป็น stub ที่ inject ผ่าน createApp({ mediaService }) — ไม่ต้องมี ffmpeg/sharp; PostgreSQL ผ่าน TEST_DATABASE_URL
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, DEMO_USER, DEMO_ADMIN, Client } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-routes-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')
const { mediaLimitsFromEnv } = await import('../server/config/mediaLimits.js')
const { disabledMediaService } = await import('../server/media/disabledService.js')
const { parseByteRange } = await import('../server/request/byteRange.js')

const SHA_A = 'a'.repeat(64)
const derivDir = path.join(STORAGE_ROOT, '..', `aegis-media-routes-deriv-${process.pid}`)
await fs.mkdir(derivDir, { recursive: true })
const posterPath = path.join(derivDir, 'poster.webp'); await fs.writeFile(posterPath, Buffer.from('RIFF....WEBPVP8 poster-bytes-for-tests'))
const motionPath = path.join(derivDir, 'motion.mp4'); await fs.writeFile(motionPath, Buffer.alloc(1000, 7))

/** stub service ที่สคริปต์ ServeResult / MediaInfo ได้ และบันทึกทุกการเรียก */
function stubService({ serve = {}, info = {} } = {}) {
  const serveTable = { ...serve }
  const calls = { info: [], serve: [], infoBatch: [], invalidate: [], adminStatus: 0 }
  const reasons = {}
  const svc = {
    calls, reason: null, limits: mediaLimitsFromEnv({}),
    async init() {}, async start() {}, async stop() {},
    async info(row) { calls.info.push(row); return info[String(row.id)] ?? { id: String(row.id), sourceVersion: row.sha256, profile: 'v1', status: 'PENDING', poster: { state: 'PENDING', retryAfterMs: 2000, url: null }, motion: { state: 'PENDING', url: null } } },
    async infoBatch(rows) { calls.infoBatch.push(rows.map((r) => String(r.id))); const m = new Map(); for (const r of rows) m.set(String(r.id), await svc.info(r)); return m },
    async serve(row, type, ident) { calls.serve.push({ id: String(row.id), type, ident }); const key = `${row.id}:${type}`; return typeof svc.serveTable[key] === 'function' ? svc.serveTable[key](ident) : (svc.serveTable[key] ?? { kind: 'pending', retryAfterSeconds: 3 }) },
    async scheduleForFile() { return true }, async ensure() { return true }, isPinned() { return false },
    async invalidate(sha, meta) { calls.invalidate.push({ sha, meta }); return true },
    async adminStatus() { calls.adminStatus += 1; return { enabled: true, capabilities: { ffmpeg: { ok: true } }, cache: { dir: derivDir, bytes: 1, entries: 1, highWater: 2, lowWater: 1, lastEvictionAt: null, staleProfiles: [], volume: 'volume' }, queue: { depth: 0, running: 0, byPriority: { 0: 0, 1: 0, 2: 0 } }, failures: { last24h: 0 } } },
    health() { return { enabled: true, reason: null, ffmpeg: { ok: true, version: 'x' }, sharp: { ok: true, version: 'y' }, cacheWritable: true, cacheVolume: 'volume' } },
    reasons, serveTable,
  }
  return svc
}

let servers = []
async function boot({ service, env = {} } = {}) {
  const app = createApp({ env: { ...process.env, ...env }, mediaService: service })
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  servers.push(server)
  return { app, base: `http://127.0.0.1:${server.address().port}`, service }
}
before(async () => { await initStorage() })
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  if (usingPostgres) { await query(`DELETE FROM files WHERE name LIKE 'mediaroute-%'`); await closePool() }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true }); await fs.rm(derivDir, { recursive: true, force: true })
})
let seq = 0
const uniq = (label, ext) => `mediaroute-${label}-${Date.now()}-${seq++}.${ext}`
async function upload(client, name) {
  const form = new FormData(); form.append('file', new Blob([Buffer.from(`bytes-${name}`)]), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, JSON.stringify(res.data)); return res.data.file
}
async function makeFolder(client, name) { const r = await client.req('/api/files/folder', { method: 'POST', body: { name } }); assert.equal(r.status, 201); return r.data.file }
const rawGet = (client, p, headers = {}) => client.raw(p, { headers })
const ready = (p, mime, bytes) => ({ kind: 'ready', path: p, mime, bytes, etag: null })

/* ── ownership / object hiding ──────────────────────────────────────────── */
test('MR-OWNER owner GET media-info → 200 JSON with sourceVersion/profile, no-store', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('own', 'png'))
  const res = await user.req(`/api/files/${f.id}/media-info`)
  assert.equal(res.status, 200)
  assert.equal(res.data.sourceVersion, f.sha256)
  assert.equal(res.data.profile, 'v1')
  assert.equal(res.data.status, 'PENDING')
  assert.equal(res.headers.get('cache-control'), 'private, no-store')
  assert.equal(svc.calls.info.length, 1)
  assert.equal(svc.calls.info[0].id, String(f.id))
})

test('MR-CROSS another owner\'s id → 404 on all three routes, FILE_PREVIEW DENIED audited, service never invoked', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const owner = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(owner, uniq('cross', 'gif'))
  const admin = await loginClient(base, DEMO_ADMIN.username, DEMO_ADMIN.password) // a different account (also proves no admin override)
  for (const p of [`/api/files/${f.id}/media-info`, `/api/files/${f.id}/poster?v=${f.sha256}&p=v1`, `/api/files/${f.id}/motion-preview?v=${f.sha256}&p=v1`]) {
    const res = await admin.raw(p)
    assert.equal(res.status, 404, p)
    assert.equal(res.headers.get('cache-control'), 'private, no-store', p)
  }
  assert.deepEqual([svc.calls.info.length, svc.calls.serve.length], [0, 0])
  const audit = await readAudit(50)
  const denied = audit.filter((e) => e.action === 'FILE_PREVIEW' && e.result === 'DENIED')
  assert.ok(denied.length >= 3, `DENIED audit rows: ${denied.length}`)
  const unknown = await admin.raw('/api/files/999999999/media-info')
  assert.equal(unknown.status, 404)
})

test('MR-NULLOWNER a row without an owner is 404 for everyone', { skip: usingPostgres ? false : 'seeded memory rows have no owner: covered by f05 below only when the memory seed exists' }, async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('nullowner', 'png'))
  await query('UPDATE files SET uploaded_by = NULL WHERE id = $1', [f.id])
  assert.equal((await user.raw(`/api/files/${f.id}/media-info`)).status, 404)
  assert.equal(svc.calls.info.length, 0)
})

test('MR-NULLOWNER-MEMORY the in-memory seed row (no ownerId) is 404 even for a logged-in user', { skip: usingPostgres ? 'memory seed only' : false }, async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  assert.equal((await user.raw('/api/files/f05/media-info')).status, 404)
  assert.equal((await user.raw(`/api/files/f05/poster?v=${'a8c47e19d2b5f036e8a1c94d7f2b50e3d6a97b18c42f5e09d3b8a61f7c2e94d0'}&p=v1`)).status, 404)
  assert.equal(svc.calls.info.length + svc.calls.serve.length, 0)
})

test('MR-VAULT a vault row is 404 on every route and the service is never called', { skip: usingPostgres ? false : 'legacy vault rows can only be created directly in PostgreSQL (service-level vault exclusion: DS-5)' }, async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const { rows: [me] } = await query('SELECT id FROM users WHERE username = $1', [DEMO_USER.username])
  const { rows } = await query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by, kind) VALUES ($1, 'vault/00000000-0000-4000-8000-000000000001.bin', 10, $2, TRUE, TRUE, $3, 'file') RETURNING id`,
    [uniq('vault', 'jpg'), SHA_A, me.id],
  )
  const id = rows[0].id
  for (const p of [`/api/files/${id}/media-info`, `/api/files/${id}/poster?v=${SHA_A}&p=v1`, `/api/files/${id}/motion-preview?v=${SHA_A}&p=v1`]) assert.equal((await user.raw(p)).status, 404, p)
  const batch = await user.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [String(id)] } })
  assert.equal(batch.data.items[String(id)].status, 'NOT_FOUND')
  assert.deepEqual([svc.calls.info.length, svc.calls.serve.length, svc.calls.infoBatch.length], [0, 0, 0])
})

test('MR-FOLDER a folder id → 400 after the owner gate; MR-UNSUPPORTED .txt → media-info 200 UNSUPPORTED, binary 415', async () => {
  const svc = stubService({ serve: {} })
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const folder = await makeFolder(user, uniq('folder', 'd'))
  assert.equal((await user.raw(`/api/files/${folder.id}/media-info`)).status, 400)
  assert.equal((await user.raw(`/api/files/${folder.id}/poster?v=${SHA_A}&p=v1`)).status, 400)
  const txt = await upload(user, uniq('plain', 'txt'))
  svc.reasons.txt = true
  const infoRes = await user.req(`/api/files/${txt.id}/media-info`)
  assert.equal(infoRes.status, 200)
  // the service answers UNSUPPORTED for .txt (real service) — the stub is scripted to do the same here
  const svc2 = stubService({ info: { [String(txt.id)]: { id: String(txt.id), sourceVersion: txt.sha256, profile: 'v1', status: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', poster: { state: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', url: null }, motion: { state: 'UNSUPPORTED', reason: 'UNSUPPORTED_TYPE', url: null } } }, serve: { [`${txt.id}:poster`]: { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' }, [`${txt.id}:motion`]: { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' } } })
  const b2 = await boot({ service: svc2 })
  const user2 = await loginClient(b2.base, DEMO_USER.username, DEMO_USER.password)
  const i2 = await user2.req(`/api/files/${txt.id}/media-info`)
  assert.deepEqual([i2.status, i2.data.status, i2.data.reason], [200, 'UNSUPPORTED', 'UNSUPPORTED_TYPE'])
  const p2 = await user2.raw(`/api/files/${txt.id}/poster?v=${txt.sha256}&p=v1`)
  assert.equal(p2.status, 415)
  assert.equal(JSON.parse(p2.buffer.toString()).code, 'UNSUPPORTED_TYPE')
  assert.equal(p2.headers.get('cache-control'), 'private, no-store')
  assert.equal((await user2.raw(`/api/files/${txt.id}/motion-preview?v=${txt.sha256}&p=v1`)).status, 415)
})

test('MR-DISABLED disabled service: media-info UNSUPPORTED/MEDIA_DISABLED, binaries 415 MEDIA_DISABLED, batch mapped, gates still first, files API unaffected', async () => {
  const svc = disabledMediaService(mediaLimitsFromEnv({ MEDIA_ENABLED: 'false' }), 'MEDIA_DISABLED')
  const { base } = await boot({ service: svc, env: { MEDIA_ENABLED: 'false' } })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('disabled', 'png'))
  const info = await user.req(`/api/files/${f.id}/media-info`)
  assert.deepEqual([info.status, info.data.status, info.data.reason], [200, 'UNSUPPORTED', 'MEDIA_DISABLED'])
  for (const p of [`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`, `/api/files/${f.id}/motion-preview?v=${f.sha256}&p=v1`]) {
    const r = await user.raw(p)
    assert.equal(r.status, 415, p); assert.equal(JSON.parse(r.buffer.toString()).code, 'MEDIA_DISABLED'); assert.equal(r.headers.get('cache-control'), 'private, no-store')
  }
  const batch = await user.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [String(f.id)] } })
  assert.deepEqual([batch.data.items[String(f.id)].status, batch.data.items[String(f.id)].reason], ['UNSUPPORTED', 'MEDIA_DISABLED'])
  const admin = await loginClient(base, DEMO_ADMIN.username, DEMO_ADMIN.password)
  assert.equal((await admin.raw(`/api/files/${f.id}/media-info`)).status, 404, 'cross-owner gate before the disabled answer')
  const list = await user.req('/api/files'); assert.equal(list.status, 200)
  const renamed = await user.req(`/api/files/${f.id}`, { method: 'PATCH', body: { name: uniq('renamed', 'png') } }); assert.equal(renamed.status, 200)
  const dl = await user.raw(`/api/files/${f.id}/download`); assert.equal(dl.status, 200)
})

/* ── derivative binary semantics ─────────────────────────────────────────── */
test('MR-READY/ETAG/IMMUTABLE poster 200 with the full header set; If-None-Match → 304 carrying the same cache headers', async () => {
  let f
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  f = await upload(user, uniq('ready', 'png'))
  svc.serveTable = { [`${f.id}:poster`]: ready(posterPath, 'image/webp', (await fs.stat(posterPath)).size) }
  svc.serveTable[`${f.id}:poster`].etag = `"${f.sha256}-v1-poster"`
  const res = await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/webp')
  assert.equal(res.headers.get('content-length'), String((await fs.stat(posterPath)).size))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('content-disposition'), "inline; filename*=UTF-8''poster.webp")
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(res.headers.get('etag'), `"${f.sha256}-v1-poster"`)
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(res.headers.get('vary'), 'Cookie')
  assert.equal(res.buffer.toString(), (await fs.readFile(posterPath)).toString())
  const notModified = await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`, { headers: { 'If-None-Match': `"${f.sha256}-v1-poster"` } })
  assert.equal(notModified.status, 304)
  assert.equal(notModified.headers.get('etag'), `"${f.sha256}-v1-poster"`)
  assert.equal(notModified.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(notModified.headers.get('vary'), 'Cookie')
  assert.equal(notModified.buffer.length, 0)
  assert.deepEqual(svc.calls.serve.at(-1).ident, { v: f.sha256, p: 'v1' })
})

test('MR-REVALIDATE MEDIA_CACHE_POLICY=revalidate → private, max-age=0, must-revalidate with ETag and no Vary', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc, env: { MEDIA_CACHE_POLICY: 'revalidate' } })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('reval', 'png'))
  svc.serveTable = { [`${f.id}:poster`]: { ...ready(posterPath, 'image/webp', 10), etag: `"${f.sha256}-v1-poster"` } }
  const res = await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'private, max-age=0, must-revalidate')
  assert.equal(res.headers.get('etag'), `"${f.sha256}-v1-poster"`)
  assert.equal(res.headers.get('vary'), null)
})

test('MR-PENDING/RETRYABLE/FAILED status mapping: 202 + Retry-After, 503 + Retry-After, 422; all no-store', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('states', 'gif'))
  svc.serveTable = { [`${f.id}:poster`]: { kind: 'pending', retryAfterSeconds: 3 }, [`${f.id}:motion`]: { kind: 'retryable', reason: 'QUEUE_FULL', retryAfterSeconds: 15 } }
  const pending = await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`)
  assert.equal(pending.status, 202); assert.equal(pending.headers.get('retry-after'), '3'); assert.equal(pending.buffer.length, 0); assert.equal(pending.headers.get('cache-control'), 'private, no-store')
  const retry = await user.raw(`/api/files/${f.id}/motion-preview?v=${f.sha256}&p=v1`)
  assert.equal(retry.status, 503); assert.equal(retry.headers.get('retry-after'), '15'); assert.equal(retry.headers.get('cache-control'), 'private, no-store')
  svc.serveTable[`${f.id}:poster`] = { kind: 'failed', reason: 'DECODE_FAILED' }
  const failed = await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v1`)
  assert.equal(failed.status, 422); assert.equal(JSON.parse(failed.buffer.toString()).code, 'DECODE_FAILED'); assert.equal(failed.headers.get('cache-control'), 'private, no-store')
})

test('MR-STALE_V / MR-UNKNOWN_P / MR-MISSING: identity validation before the service; 404 for stale v or non-current p, 400 when missing or malformed', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('ident', 'png'))
  const before = svc.calls.serve.length
  assert.equal((await user.raw(`/api/files/${f.id}/poster?v=${'b'.repeat(64)}&p=v1`)).status, 404, 'stale source sha')
  assert.equal((await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v0`)).status, 404, 'old profile')
  assert.equal((await user.raw(`/api/files/${f.id}/poster?v=${f.sha256}&p=v99`)).status, 404, 'unknown profile')
  assert.equal(svc.calls.serve.length, before, 'stale/unknown identities never reach the service')
  for (const p of [`/api/files/${f.id}/poster`, `/api/files/${f.id}/poster?v=${f.sha256}`, `/api/files/${f.id}/poster?p=v1`, `/api/files/${f.id}/poster?v=${'a'.repeat(63)}&p=v1`, `/api/files/${f.id}/poster?v=${'G'.repeat(64)}&p=v1`, `/api/files/${f.id}/motion-preview?v=${f.sha256}&p=`]) {
    const r = await user.raw(p)
    assert.equal(r.status, 400, p); assert.equal(r.headers.get('cache-control'), 'private, no-store', p)
  }
  assert.equal(svc.calls.serve.length, before)
})

test('MR-RANGE motion-preview: single byte range 206 with Content-Range, unsatisfiable 416, invalid syntax → 200 full; Accept-Ranges bytes', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('range', 'mp4'))
  const size = (await fs.stat(motionPath)).size
  svc.serveTable = { [`${f.id}:motion`]: { ...ready(motionPath, 'video/mp4', size), etag: `"${f.sha256}-v1-motion"` } }
  const url = `/api/files/${f.id}/motion-preview?v=${f.sha256}&p=v1`
  const part = await user.raw(url, { headers: { Range: 'bytes=0-99' } })
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`); assert.equal(part.buffer.length, 100)
  assert.equal(part.headers.get('accept-ranges'), 'bytes'); assert.equal(part.headers.get('content-type'), 'video/mp4')
  assert.equal(part.headers.get('cache-control'), 'private, max-age=31536000, immutable'); assert.equal(part.headers.get('etag'), `"${f.sha256}-v1-motion"`)
  const tail = await user.raw(url, { headers: { Range: 'bytes=-10' } })
  assert.equal(tail.status, 206); assert.equal(tail.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`)
  const bad = await user.raw(url, { headers: { Range: `bytes=${size}-` } })
  assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), `bytes */${size}`)
  const full = await user.raw(url, { headers: { Range: 'bytes=abc' } })
  assert.equal(full.status, 200); assert.equal(full.buffer.length, size)
  assert.equal(full.headers.get('content-disposition'), "inline; filename*=UTF-8''motion.mp4")
  // the shared helper is byte-for-byte the preview route's contract
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=abc', 1000), null)
})

test('MR-BATCH ≤ 64 ids, per-id object hiding, CSRF enforced, malformed body 400', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const owner = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(base, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const mine = await upload(owner, uniq('batch-mine', 'png'))
  const theirs = await upload(other, uniq('batch-theirs', 'png'))
  const folder = await makeFolder(owner, uniq('batch-folder', 'd'))
  const res = await owner.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [String(mine.id), String(theirs.id), String(folder.id), 'nope', '999999999'] } })
  assert.equal(res.status, 200)
  assert.equal(res.data.items[String(mine.id)].status, 'PENDING')
  for (const id of [String(theirs.id), String(folder.id), 'nope', '999999999']) assert.deepEqual(res.data.items[id], { status: 'NOT_FOUND' }, id)
  assert.deepEqual(svc.calls.infoBatch.at(-1), [String(mine.id)], 'only owned normal files reach the service')
  assert.equal(res.headers.get('cache-control'), 'private, no-store')
  const tooMany = await owner.req('/api/files/media-info/batch', { method: 'POST', body: { ids: Array.from({ length: 65 }, (_, i) => String(i + 1)) } })
  assert.equal(tooMany.status, 400)
  assert.equal((await owner.req('/api/files/media-info/batch', { method: 'POST', body: { ids: 'x' } })).status, 400)
  assert.equal((await owner.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [1, 2] } })).status, 400, 'ids must be strings')
  // CSRF: same cookie, no token → 403 from the shared csrf gate
  const noToken = new Client(base); noToken.cookie = owner.cookie
  const csrf = await noToken.req('/api/files/media-info/batch', { method: 'POST', body: { ids: [String(mine.id)] } })
  assert.equal(csrf.status, 403)
  const audit = await readAudit(50)
  assert.ok(audit.some((e) => e.action === 'FILE_PREVIEW' && e.result === 'DENIED'), 'cross-owner id in the batch is audited')
})

test('MR-NOHASHROUTE no bare-hash route exists', async () => {
  const { base } = await boot({ service: stubService() })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  for (const p of [`/api/media/${SHA_A}/poster`, `/api/files/by-sha/${SHA_A}`, `/api/media-cache/${SHA_A}`]) assert.equal((await user.raw(p)).status, 404, p)
})

test('MR-ADMIN status is Admin-only and aggregate; invalidate validates the sha and audits; users get 403', async () => {
  const svc = stubService()
  const { base } = await boot({ service: svc })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(base, DEMO_ADMIN.username, DEMO_ADMIN.password)
  assert.equal((await user.raw('/api/admin/media-cache/status')).status, 403)
  const st = await admin.req('/api/admin/media-cache/status')
  assert.equal(st.status, 200); assert.equal(st.data.enabled, true); assert.ok(st.data.cache && st.data.queue)
  assert.ok(!JSON.stringify(st.data).includes('name'))
  assert.equal((await user.req(`/api/admin/media-cache/entries/${SHA_A}`, { method: 'DELETE' })).status, 403)
  assert.equal((await admin.req('/api/admin/media-cache/entries/not-a-sha', { method: 'DELETE' })).status, 400)
  const del = await admin.req(`/api/admin/media-cache/entries/${SHA_A}`, { method: 'DELETE' })
  assert.equal(del.status, 204)
  assert.equal(svc.calls.invalidate.at(-1).sha, SHA_A)
  const audit = await readAudit(20)
  assert.ok(audit.some((e) => e.action === 'MEDIA_CACHE_INVALIDATE'), 'invalidation audited')
})

test('MR-PREVIEW-UNCHANGED the original /preview route still serves originals with no-store and Range (regression sentinel)', async () => {
  const { base } = await boot({ service: stubService() })
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const f = await upload(user, uniq('orig', 'png'))
  const res = await user.raw(`/api/files/${f.id}/preview`, { headers: { Range: 'bytes=0-3' } })
  assert.equal(res.status, 206); assert.equal(res.headers.get('cache-control'), 'private, no-store'); assert.equal(res.buffer.length, 4)
})
