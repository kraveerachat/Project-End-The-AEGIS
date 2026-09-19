// tests/mediaUploadEnqueue.test.js — AEGIS Drive (IDEA1) · จัดคิว derivative "หลัง" คำตอบสำเร็จของ upload/commit/restore (plan Task 10)
//
// สัญญา: hook ถูกเรียกครั้งเดียวต่อ commit ที่สำเร็จของไฟล์ปกติ (V1 upload, V2 commit, same-name replace, version restore)
// หลัง response ปิดแล้ว (res.headersSent) — ไม่มี await ก่อนตอบ, ล้มเหลวเงียบ (log ครั้งเดียว), Vault ไม่เรียกเลย,
// ชั้น upload ไม่กรองตามชนิด media (allowlist เดียวอยู่ที่ config/previewMedia.js และ service เป็นผู้ตัดสิน) และเมื่อ
// service ปิด (MEDIA_ENABLED=false) upload/commit/restore ยังทำงานเหมือนเดิมทุกประการ
// ⚠️ ไม่มี ffmpeg/sharp: service เป็น stub; ไม่แตะโปรโตคอล/เพดาน upload (transferLimits.js ต้องไม่เปลี่ยน — UE-8)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { loginClient, DEMO_USER, Client } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-media-enqueue-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging } = await import('../server/storage/vaultStaging.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')
const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const { mediaLimitsFromEnv } = await import('../server/config/mediaLimits.js')
const { disabledMediaService } = await import('../server/media/disabledService.js')
const { PRIORITY } = await import('../server/media/queue.js')
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope } = await import('../src/lib/vaultChunkCrypto.js')

const CHUNK = TRANSFER_LIMITS.chunkSizeBytes
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** stub ที่บันทึกทุกการเรียก scheduleForFile พร้อมสถานะ response ณ เวลาที่ถูกเรียก */
function spyService({ behaviour = 'ok', hangMs = 0 } = {}) {
  const calls = []
  const svc = {
    reason: null, limits: mediaLimitsFromEnv({}), jobs: 0,
    async init() {}, async start() {}, async stop() {},
    async info(row) { return { id: String(row.id), sourceVersion: row.sha256, profile: 'v1', status: 'PENDING', poster: {}, motion: {} } },
    async infoBatch(rows) { const m = new Map(); for (const r of rows) m.set(String(r.id), await svc.info(r)); return m },
    async serve() { return { kind: 'pending', retryAfterSeconds: 2 } },
    scheduleForFile(row, priority) {
      calls.push({ id: String(row.id), sha256: row.sha256, name: row.name, priority, at: Date.now() })
      if (behaviour === 'throw') throw new Error('queue exploded (test)')
      if (behaviour === 'reject') return Promise.reject(new Error('queue rejected (test)'))
      if (hangMs) return new Promise((r) => setTimeout(() => r(true), hangMs))
      if (behaviour === 'false') return false
      svc.jobs += 1
      return true
    },
    isPinned() { return false }, async invalidate() { return true }, async adminStatus() { return {} },
    health() { return { enabled: true, reason: null, ffmpeg: null, sharp: null, cacheWritable: true, cacheVolume: 'unknown' } },
    calls,
  }
  return svc
}

const servers = []
async function boot(service, env = {}) {
  const app = createApp({ env: { ...process.env, ...env }, mediaService: service })
  // ⚠️ บันทึก headersSent ณ เวลาที่ hook ถูกเรียก — ทำผ่าน wrapper บน scheduleForFile ที่เห็น res ผ่าน closure ของ route ไม่ได้
  //    จึงใช้เวลาสัมพัทธ์แทน: hook ต้องเกิดหลัง 'finish' ซึ่งเซิร์ฟเวอร์ปล่อยหลัง client ได้ response แล้ว (ดู UE-1)
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  servers.push(server)
  return { app, base: `http://127.0.0.1:${server.address().port}` }
}
before(async () => { await initStorage(); await initVaultStorage(); await initVaultStaging() })
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r))
  if (usingPostgres) { await query(`DELETE FROM files WHERE name LIKE 'mediaenq-%'`); await closePool() }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})
let seq = 0
const uniq = (label, ext) => `mediaenq-${label}-${Date.now()}-${seq++}.${ext}`
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

async function uploadV1(client, name, bytes = Buffer.from(`bytes-${name}`)) {
  const form = new FormData(); form.append('file', new Blob([bytes]), name)
  const started = Date.now()
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  return { ...res, elapsedMs: Date.now() - started, bytes }
}
async function uploadV2(client, name, content) {
  const open = await client.req('/api/files/uploads', { method: 'POST', body: { name, size: content.length, sha256: sha256(content) } })
  assert.equal(open.status, 201, JSON.stringify(open.data))
  const upload = open.data.upload
  for (let i = 0; i < upload.chunkCount; i += 1) {
    const part = content.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, content.length))
    const put = await client.raw(`/api/files/uploads/${upload.uploadId}/chunks/${i}`, { method: 'PUT', body: part, headers: { 'Content-Type': 'application/octet-stream' } })
    assert.equal(put.status, 200, put.buffer.toString())
  }
  return client.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
}

test('UE-1 V1 upload .png → 201 unchanged; scheduleForFile once with the committed row at priority UPLOAD, after the response', async () => {
  const svc = spyService()
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const name = uniq('v1', 'png')
  const res = await uploadV1(user, name)
  const respondedAt = Date.now()
  assert.equal(res.status, 201, JSON.stringify(res.data))
  assert.deepEqual(Object.keys(res.data).sort(), ['file', 'newVersion'])
  assert.equal(res.data.newVersion, false)
  await settle()
  assert.equal(svc.calls.length, 1, 'exactly one schedule call')
  const call = svc.calls[0]
  assert.equal(call.id, String(res.data.file.id))
  assert.equal(call.sha256, res.data.file.sha256)
  assert.equal(call.sha256, sha256(res.bytes))
  assert.equal(call.name, name)
  assert.equal(call.priority, PRIORITY.UPLOAD)
  assert.ok(call.at >= respondedAt - 5, `hook ran after the client received the response (hook ${call.at}, response ${respondedAt})`)
  assert.equal(svc.jobs, 1)
})

test('UE-2 V2 init/chunk/commit .gif → 201 unchanged; scheduleForFile once after the response', async () => {
  const svc = spyService()
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const content = randomBytes(CHUNK + 1234)
  const name = uniq('v2', 'gif')
  const commit = await uploadV2(user, name, content)
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  assert.deepEqual(Object.keys(commit.data).sort(), ['file', 'newVersion', 'sha256'])
  assert.equal(commit.data.sha256, sha256(content))
  await settle()
  assert.equal(svc.calls.length, 1)
  assert.equal(svc.calls[0].id, String(commit.data.file.id))
  assert.equal(svc.calls[0].sha256, sha256(content))
  assert.equal(svc.calls[0].priority, PRIORITY.UPLOAD)
})

test('UE-3 version restore → 200 unchanged; scheduleForFile once with the row carrying the restored sha256', async () => {
  const svc = spyService()
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const name = uniq('restore', 'webp')
  const v1 = await uploadV1(user, name, Buffer.from('first-version-bytes'))
  assert.equal(v1.status, 201)
  const v2 = await uploadV1(user, name, Buffer.from('second-version-bytes-longer'))
  assert.equal(v2.status, 201)
  assert.equal(v2.data.newVersion, true)
  await settle()
  assert.equal(svc.calls.length, 2, 'both commits scheduled')
  const versions = await user.req(`/api/files/${v2.data.file.id}/versions`)
  assert.equal(versions.status, 200)
  const older = versions.data.versions.find((v) => v.sha256 === sha256(Buffer.from('first-version-bytes')))
  assert.ok(older, `older version listed: ${JSON.stringify(versions.data)}`)
  const restore = await user.req(`/api/files/${v2.data.file.id}/versions/${older.id}/restore`, { method: 'POST' })
  assert.equal(restore.status, 200, JSON.stringify(restore.data))
  assert.deepEqual(Object.keys(restore.data).sort(), ['file', 'restoredFromVersionId'])
  assert.equal(restore.data.file.sha256, sha256(Buffer.from('first-version-bytes')))
  await settle()
  assert.equal(svc.calls.length, 3)
  assert.equal(svc.calls[2].id, String(v2.data.file.id))
  assert.equal(svc.calls[2].sha256, sha256(Buffer.from('first-version-bytes')))
  assert.equal(svc.calls[2].priority, PRIORITY.UPLOAD)
})

test('UE-4 the response never waits: scheduleForFile hangs 2000 ms → 201 in < 500 ms', async () => {
  const svc = spyService({ hangMs: 2000 })
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const res = await uploadV1(user, uniq('hang', 'png'))
  assert.equal(res.status, 201)
  assert.ok(res.elapsedMs < 500, `upload took ${res.elapsedMs} ms`)
  await settle()
  assert.equal(svc.calls.length, 1)
})

test('UE-5 scheduling failure is harmless: sync throw and async rejection → upload still 201, error logged once, audit unchanged', async () => {
  for (const behaviour of ['throw', 'reject']) {
    const svc = spyService({ behaviour })
    const { base } = await boot(svc)
    const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
    const logged = []
    const orig = console.error
    console.error = (...args) => { logged.push(args.map(String).join(' ')) }
    let res
    try {
      res = await uploadV1(user, uniq(behaviour, 'png'))
      await settle(120)
    } finally { console.error = orig }
    assert.equal(res.status, 201, behaviour)
    assert.equal(svc.calls.length, 1, behaviour)
    const mediaLogs = logged.filter((l) => l.includes('[media]'))
    assert.equal(mediaLogs.length, 1, `${behaviour}: one [media] error line, got ${JSON.stringify(logged)}`)
    const audit = await readAudit(10)
    const last = audit.find((e) => e.action === 'FILE_UPLOAD')
    assert.ok(last && last.result === 'OK', 'FILE_UPLOAD audit remains OK')
  }
})

test('UE-6 Vault V2 commit never calls the hook (route untouched); static scan of vaultUploads.js', async () => {
  const svc = spyService()
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
  const setup = await createVaultSetup('zebra-glacier-nominal-77-vault', FAST)
  const setupRes = await user.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })
  assert.ok([201, 409].includes(setupRes.status), JSON.stringify(setupRes.data))
  if (setupRes.status === 201) {
    const ciphertextSize = 1024 + GCM_TAG_BYTES
    const env = await createVaultV2Envelope(setup.kek, { name: 'mediaenq-vault.png', type: 'image/png', size: ciphertextSize - GCM_TAG_BYTES, chunkCount: 1 })
    const open = await user.req('/api/vault/uploads', { method: 'POST', body: {
      formatVersion: 2, contentIdB64: env.contentIdB64, chunkSize: VAULT_TRANSFER_LIMITS.ciphertextChunkBytes,
      wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
      ciphertextSize, chunkCount: 1,
    } })
    assert.equal(open.status, 201, JSON.stringify(open.data))
    const put = await user.raw(`/api/vault/uploads/${open.data.upload.uploadId}/chunks/0`, { method: 'PUT', body: randomBytes(ciphertextSize), headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') } })
    assert.equal(put.status, 200, put.buffer.toString())
    const commit = await user.req(`/api/vault/uploads/${open.data.upload.uploadId}/commit`, { method: 'POST', body: {} })
    assert.equal(commit.status, 201, JSON.stringify(commit.data))
    await settle()
    assert.equal(svc.calls.length, 0, 'vault commit never schedules derivatives')
  } else {
    test.diagnostic?.('vault already configured for this account in the shared database — behavioural vault leg skipped, static scan still enforced')
  }
  const vaultSrc = await fs.readFile(new URL('../server/routes/vaultUploads.js', import.meta.url), 'utf8')
  assert.doesNotMatch(vaultSrc, /scheduleDerivativesAfterResponse|mediaService|media\.js/)
})

test('UE-7 unsupported .txt → hook still called once (no media-type logic in upload code); service decides (false, zero jobs); body unchanged', async () => {
  const svc = spyService({ behaviour: 'false' })
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const name = uniq('plain', 'txt')
  const res = await uploadV1(user, name)
  assert.equal(res.status, 201)
  assert.deepEqual(Object.keys(res.data).sort(), ['file', 'newVersion'])
  await settle()
  assert.equal(svc.calls.length, 1)
  assert.equal(svc.calls[0].name, name)
  assert.equal(svc.jobs, 0)
  // ชั้น upload ไม่มี allowlist ของตัวเอง — สแกน source ทั้ง api.js และ uploads.js
  for (const f of ['../server/routes/api.js', '../server/routes/uploads.js']) {
    const src = await fs.readFile(new URL(f, import.meta.url), 'utf8')
    const hookLines = src.split('\n').filter((l) => l.includes('scheduleDerivativesAfterResponse(req'))
    assert.ok(hookLines.length >= 1, `${f} calls the hook`)
    for (const l of hookLines) assert.doesNotMatch(l, /isPreviewableExtension|PREVIEW_MIME|previewExtForName|\.(png|gif|webp|mp4)/)
  }
})

test('UE-10 disabled service: V1 upload, V2 commit and restore unchanged; hook called once each and returns false; no job', async () => {
  const limits = mediaLimitsFromEnv({ MEDIA_ENABLED: 'false' })
  const disabled = disabledMediaService(limits, 'MEDIA_DISABLED')
  let calls = 0
  const orig = disabled.scheduleForFile
  const wrapped = { ...disabled, scheduleForFile(row, p) { calls += 1; return orig.call(disabled, row, p) } }
  const { base } = await boot(wrapped)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const name = uniq('disabled', 'png')
  const v1 = await uploadV1(user, name, Buffer.from('one'))
  assert.equal(v1.status, 201); assert.deepEqual(Object.keys(v1.data).sort(), ['file', 'newVersion'])
  const content = randomBytes(2048)
  const c2 = await uploadV2(user, uniq('disabled-v2', 'gif'), content)
  assert.equal(c2.status, 201); assert.deepEqual(Object.keys(c2.data).sort(), ['file', 'newVersion', 'sha256'])
  const v2 = await uploadV1(user, name, Buffer.from('two'))
  assert.equal(v2.status, 201)
  const versions = await user.req(`/api/files/${v2.data.file.id}/versions`)
  const older = versions.data.versions.find((v) => v.sha256 === sha256(Buffer.from('one')))
  const restore = await user.req(`/api/files/${v2.data.file.id}/versions/${older.id}/restore`, { method: 'POST' })
  assert.equal(restore.status, 200); assert.deepEqual(Object.keys(restore.data).sort(), ['file', 'restoredFromVersionId'])
  await settle()
  assert.equal(calls, 4, 'V1 + V2 + replace + restore')
  assert.equal(await disabled.scheduleForFile({ id: 'x' }, PRIORITY.UPLOAD), false)
})

test('UE-8 protocol unchanged: transferLimits.js identical to origin/main and the upload routes carry no await on the hook', async () => {
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  let diff = ''
  try { diff = execFileSync('git', ['diff', '--stat', 'origin/main', '--', 'server/config/transferLimits.js'], { cwd: repoRoot, encoding: 'utf8' }) }
  catch (err) { test.diagnostic?.(`git unavailable: ${err.message}`); return }
  assert.equal(diff.trim(), '', 'server/config/transferLimits.js must not change')
  for (const f of ['../server/routes/api.js', '../server/routes/uploads.js']) {
    const src = await fs.readFile(new URL(f, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /await\s+scheduleDerivativesAfterResponse/)
  }
})

test('UE-9 same-name replace (V1) → hook called with the NEW sha256', async () => {
  const svc = spyService()
  const { base } = await boot(svc)
  const user = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
  const name = uniq('replace', 'jpg')
  const a = await uploadV1(user, name, Buffer.from('alpha-bytes'))
  assert.equal(a.status, 201)
  const b = await uploadV1(user, name, Buffer.from('beta-bytes-are-different'))
  assert.equal(b.status, 201)
  assert.equal(b.data.newVersion, true)
  assert.equal(b.data.file.id, a.data.file.id)
  await settle()
  assert.equal(svc.calls.length, 2)
  assert.equal(svc.calls[1].id, String(a.data.file.id))
  assert.equal(svc.calls[1].sha256, sha256(Buffer.from('beta-bytes-are-different')))
  assert.notEqual(svc.calls[1].sha256, svc.calls[0].sha256)
})
