// tests/commitCrashRecoveryPostgres.test.js — AEGIS Drive (IDEA1) · LFT-V2-A crash recovery
//
// ⚠️ สิ่งที่ชุดนี้พิสูจน์คือ "หลังโปรเซสตายกลาง commit ระบบบรรจบสู่สถานะที่จริงเสมอ"
//    ไม่ใช่ "try/catch ในคำขอเดิมเก็บกวาดได้" — สองอย่างนี้ต่างกันสิ้นเชิง
//
// วิธีจำลองการตาย: ขับ session ไปจนถึงเฟสที่ต้องการด้วย HTTP จริง แล้ว **เขียนสถานะที่
// โปรเซสที่ตายจะทิ้งไว้ลงฐานข้อมูลและดิสก์โดยตรง** (สถานะเดียวกับที่ claim/publish เขียน
// จริงทุกไบต์) จากนั้นจึงเรียกงานกู้คืนเหมือนโปรเซสใหม่ที่เพิ่งบูตขึ้นมา
// ไม่มีจุดใดที่ catch ของคำขอเดิมได้ทำงาน — นั่นคือทั้งหมดที่ทำให้เทสต์ชุดนี้มีความหมาย
//
// ⚠️ ต้องรันกับฐานข้อมูลแบบใช้แล้วทิ้งที่แยกขาด — เตรียมด้วย
//    sh scripts/pg-integration-env.sh up   แล้วส่ง TEST_DATABASE_URL ที่มันพิมพ์ออกมา
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { performLogin } from './helpers/testClient.mjs'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อรันกับ Postgres จริง (ดู scripts/pg-integration-env.sh)'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-crash-recovery-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.UPLOAD_CHUNK_SIZE_BYTES = String(8 * 1024 * 1024)
if (DB_URL) process.env.DATABASE_URL = DB_URL

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey } = await import('../server/storage/fileStore.js')
const { initUploadStaging, uploadStagingConfig } = await import('../server/storage/uploadStaging.js')
const { recoverStaleCommits } = await import('../server/storage/commitRecovery.js')
const { cleanupAbandonedUploads } = await import('../server/storage/uploadCleanup.js')
const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')

const CHUNK = TRANSFER_LIMITS.chunkSizeBytes
const SMALL = 4096

let server, baseUrl, sql
const OWNER = { username: 'user', password: 'aegis-drive-user' }

before(async () => {
  if (skip) return
  assert.equal(usingPostgres, true)
  sql = new pg.Pool({ connectionString: DB_URL, max: 4 })
  await initStorage()
  await initUploadStaging()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (skip) return
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  await sql?.end()
  if (usingPostgres) await closePool()
})

beforeEach(async () => {
  if (skip) return
  await sql.query('DELETE FROM upload_session_chunks')
  await sql.query('DELETE FROM upload_sessions')
})

class Client {
  constructor() { this.cookie = null; this.csrf = null }
  async req(pathname, { method = 'GET', body } = {}) {
    const headers = {}
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (Buffer.isBuffer(body)) { payload = body; headers['Content-Type'] = 'application/octet-stream' }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* no body */ }
    return { status: res.status, data }
  }
}

async function login() {
  const c = new Client()
  await performLogin(c, OWNER.username, OWNER.password)
  return c
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const rows = async (t, p) => (await sql.query(t, p)).rows
const partPathOf = (id) => path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, id, 'part')

function makeContent(size) {
  const block = randomBytes(64 * 1024)
  const out = Buffer.alloc(size)
  for (let o = 0; o < size; o += block.length) {
    block.copy(out, o, 0, Math.min(block.length, size - o))
    if (o + 4 <= size) out.writeUInt32BE(o >>> 0, o)
  }
  return out
}

/** เปิด session และส่ง chunk ครบทุกก้อน — จบที่สถานะ 'open' พร้อม commit */
async function uploadReadyToCommit(client, name, content) {
  const created = await client.req('/api/files/uploads', {
    method: 'POST', body: { name, size: content.length, sha256: sha256(content) },
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const upload = created.data.upload
  for (let i = 0; i < upload.chunkCount; i += 1) {
    const slice = content.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, content.length))
    const r = await client.req(`/api/files/uploads/${upload.uploadId}/chunks/${i}`, {
      method: 'PUT', body: Buffer.from(slice),
    })
    assert.equal(r.status, 200, JSON.stringify(r.data))
  }
  return upload
}

/**
 * เขียนสถานะที่ "โปรเซสที่ตายหลังการจอง" ทิ้งไว้ — ไบต์ต่อไบต์เหมือนที่
 * claimUploadSessionForCommit() เขียนจริง แล้วอายุการจองถูกดันให้เลยสัญญาเช่าไปแล้ว
 * @returns {Promise<string>} commit_storage_key ที่ถูกบันทึกไว้
 */
async function simulateCrashAfterClaim(uploadId) {
  const key = `uploads/${randomUUID()}.bin`
  await sql.query(
    `UPDATE upload_sessions
        SET status = 'committing',
            commit_started_at = now() - interval '1 hour',
            commit_storage_key = $2,
            committed_file_id = NULL
      WHERE upload_id = $1`,
    [uploadId, key],
  )
  return key
}

/** ...และตายหลังการ rename ไปยัง key ปลายทางแล้ว แต่ก่อนเขียน metadata */
async function simulateCrashAfterPublish(uploadId) {
  const key = await simulateCrashAfterClaim(uploadId)
  await fs.rename(partPathOf(uploadId), resolveKey(key))
  return key
}

// ═════════════════════════════════════════════════════════════════════════════
// CRASH_AFTER_CLAIM / CRASH_AFTER_VERIFY
// การตรวจ (size + sha256) เป็นการอ่านล้วน ไม่เปลี่ยนสถานะใด ๆ สองเฟสนี้จึงทิ้งสถานะ
// เดียวกันไว้บนดิสก์และในฐานข้อมูล และต้องกู้คืนได้เหมือนกัน
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_CLAIM / CRASH_AFTER_VERIFY · session ถูกเปิดกลับให้ commit ใหม่ได้', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `crash-claim-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  const key = await simulateCrashAfterClaim(upload.uploadId)

  // สภาพก่อนกู้: ไบต์ยังอยู่ในพื้นที่พัก, ยังไม่มีไฟล์ปลายทาง, ยังไม่มี metadata
  assert.ok((await fs.stat(partPathOf(upload.uploadId))).isFile())
  await assert.rejects(fs.stat(resolveKey(key)))
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 0)

  const tally = await recoverStaleCommits()
  assert.equal(tally.reopened, 1, `ต้องถูกเปิดกลับหนึ่งรายการ — ได้ ${JSON.stringify(tally)}`)

  const [session] = await rows('SELECT * FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'open')
  assert.equal(session.commit_storage_key, null, 'commit intent ต้องถูกล้างเมื่อเปิดกลับ')
  assert.equal(session.commit_started_at, null)

  // RETRY_AFTER_RECOVERY — commit ใหม่ได้จริงโดยไม่ต้องอัปโหลด chunk ซ้ำ
  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  assert.equal(commit.data.sha256, sha256(content))
  const files = await rows('SELECT * FROM files WHERE name = $1', [name])
  assert.equal(files.length, 1, 'NO_DUPLICATE_FILE_ROW')
  assert.ok((await fs.readFile(resolveKey(files[0].path))).equals(content))
})

// ═════════════════════════════════════════════════════════════════════════════
// CRASH_AFTER_PUBLISH — ไบต์ถูกย้ายไปแล้ว แต่ไม่มี metadata ชี้ถึง
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_PUBLISH · ไบต์ถูกย้ายกลับมาเป็นพื้นที่พักและ commit ใหม่ได้ ไม่มีของกำพร้า', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `crash-publish-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  const key = await simulateCrashAfterPublish(upload.uploadId)

  // สภาพก่อนกู้: ไบต์อยู่ที่ key ปลายทางแล้ว, พื้นที่พักว่าง, ไม่มี metadata ชี้ถึงเลย
  assert.ok((await fs.stat(resolveKey(key))).isFile())
  await assert.rejects(fs.stat(partPathOf(upload.uploadId)))
  assert.equal((await rows('SELECT 1 FROM files WHERE path = $1', [key])).length, 0)

  const tally = await recoverStaleCommits()
  assert.equal(tally.reopened, 1)

  // NO_ORPHAN_FINAL_BYTES — ไบต์ที่ key ปลายทางต้องไม่ถูกทิ้งค้างไว้
  await assert.rejects(fs.stat(resolveKey(key)), 'ไบต์ต้องถูกย้ายกลับ ไม่ใช่ทิ้งไว้เป็นของกำพร้า')
  assert.ok((await fs.stat(partPathOf(upload.uploadId))).isFile(), 'ต้องกลับมาเป็นไฟล์ที่พักไว้')

  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  const files = await rows('SELECT * FROM files WHERE name = $1', [name])
  assert.equal(files.length, 1, 'NO_DUPLICATE_FILE_ROW')
  assert.ok((await fs.readFile(resolveKey(files[0].path))).equals(content), 'ไบต์ต้องตรงกับต้นทาง')
})

// ═════════════════════════════════════════════════════════════════════════════
// CRASH_AFTER_METADATA — เกิดไม่ได้โดยโครงสร้าง แต่ต้องพิสูจน์ว่าถ้าเกิดก็ปลอดภัย
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_METADATA · แถว files ชี้ที่ key แล้วแต่ session ยัง committing → ปิดเป็น committed ไม่สร้างไฟล์ซ้ำ', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `crash-metadata-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  const key = await simulateCrashAfterPublish(upload.uploadId)

  // เขียนแถว metadata ด้วยมือแล้วปล่อย session ไว้ที่ committing — สภาพที่จะเกิดถ้า
  // metadata กับ status ไม่ได้อยู่ใน transaction เดียวกัน (ซึ่งตอนนี้อยู่แล้ว)
  const [{ id: userId }] = await rows('SELECT id FROM users WHERE username = $1', [OWNER.username])
  const [inserted] = await rows(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by)
     VALUES ($1, $2, $3, $4, false, true, $5) RETURNING id`,
    [name, key, content.length, sha256(content), userId],
  )

  const tally = await recoverStaleCommits()
  assert.equal(tally.committed, 1, `ต้องถูกปิดเป็น committed — ได้ ${JSON.stringify(tally)}`)

  const [session] = await rows('SELECT * FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'committed')
  assert.equal(String(session.committed_file_id), String(inserted.id),
    'ต้องผูก session เข้ากับแถวที่มีอยู่แล้ว ไม่ใช่สร้างแถวใหม่')

  const files = await rows('SELECT id FROM files WHERE name = $1', [name])
  assert.equal(files.length, 1, 'NO_DUPLICATE_FILE_ROW — ต้องไม่เกิดไฟล์ที่สอง')
  assert.ok((await fs.stat(resolveKey(key))).isFile(), 'ไบต์ที่ metadata ชี้ถึงต้องยังอยู่')
})

// ═════════════════════════════════════════════════════════════════════════════
// ไบต์หายจริง → ต้อง abort อย่างซื่อสัตย์ ห้ามประกาศว่า committed
// ═════════════════════════════════════════════════════════════════════════════
test('stale committing ที่ไบต์หายไปแล้ว → aborted และไม่มี metadata ชี้ไปยังไบต์ที่ไม่มีอยู่', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `crash-lost-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  const key = await simulateCrashAfterClaim(upload.uploadId)
  // ไบต์หายทั้งสองที่ (ดิสก์เสีย / ถูกลบนอกระบบ)
  await fs.rm(path.join(STORAGE_ROOT, uploadStagingConfig.STAGING_DIR, upload.uploadId), { recursive: true, force: true })

  const tally = await recoverStaleCommits()
  assert.equal(tally.aborted, 1, `ต้อง abort — ได้ ${JSON.stringify(tally)}`)

  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'aborted')
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 0,
    'NO_METADATA_TO_MISSING_BYTES')
  assert.equal((await rows('SELECT 1 FROM files WHERE path = $1', [key])).length, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// COMMIT_LEASE — commit ที่ยังทำงานอยู่ต้องไม่ถูกแตะ
// ═════════════════════════════════════════════════════════════════════════════
test('COMMIT_LEASE · session ที่เพิ่งเริ่ม commit ยังไม่เลยสัญญาเช่า ต้องไม่ถูกกู้คืน', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const upload = await uploadReadyToCommit(owner, `lease-${Date.now()}.bin`, content)

  // จองสด ๆ — commit_started_at = now() คือ commit ที่ "กำลังทำงานอยู่จริง"
  await sql.query(
    `UPDATE upload_sessions SET status='committing', commit_started_at = now(),
            commit_storage_key = $2 WHERE upload_id = $1`,
    [upload.uploadId, `uploads/${randomUUID()}.bin`],
  )

  const tally = await recoverStaleCommits()
  assert.equal(tally.scanned, 0, 'commit ที่ยังทำงานอยู่ต้องไม่ถูกแม้แต่หยิบมาตรวจ')
  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'committing', 'สถานะต้องไม่ถูกเปลี่ยน')
  assert.ok((await fs.stat(partPathOf(upload.uploadId))).isFile(), 'ไบต์ที่พักไว้ต้องไม่ถูกแตะ')

  // และงานเก็บกวาดปกติก็ยังต้องไม่แตะมันด้วย แม้จะหมดอายุแล้ว (คนละงานกัน)
  await sql.query(`UPDATE upload_sessions SET expires_at = now() - interval '1 day' WHERE upload_id = $1`,
    [upload.uploadId])
  await cleanupAbandonedUploads({ now: Date.now() })
  const [after] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(after?.status, 'committing', 'expiry cleanup ต้องไม่แตะสถานะ committing')
  assert.ok((await fs.stat(partPathOf(upload.uploadId))).isFile())
})

// ═════════════════════════════════════════════════════════════════════════════
// RECOVERY_IDEMPOTENT · RECOVERY_RACE_SAFE · COMMITTED_FILE_SURVIVES_RECOVERY
// ═════════════════════════════════════════════════════════════════════════════
test('RECOVERY_IDEMPOTENT · เรียกซ้ำแล้วไม่มีอะไรเปลี่ยนอีก', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `idem-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  await simulateCrashAfterPublish(upload.uploadId)

  const first = await recoverStaleCommits()
  assert.equal(first.reopened, 1)
  const snapshot = (await rows('SELECT * FROM upload_sessions WHERE upload_id = $1', [upload.uploadId]))[0]

  for (let i = 0; i < 3; i += 1) {
    const again = await recoverStaleCommits()
    assert.deepEqual(again, { reopened: 0, committed: 0, aborted: 0, scanned: 0 },
      'รอบถัดไปต้องไม่เจออะไรให้ทำ')
  }
  const after = (await rows('SELECT * FROM upload_sessions WHERE upload_id = $1', [upload.uploadId]))[0]
  assert.equal(after.status, snapshot.status)
  assert.equal(after.commit_storage_key, snapshot.commit_storage_key)
})

test('RECOVERY_RACE_SAFE · worker สองตัวพร้อมกัน ให้ผลกู้คืนเพียงหนึ่งเดียว', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `race-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  await simulateCrashAfterPublish(upload.uploadId)

  const [a, b] = await Promise.all([recoverStaleCommits(), recoverStaleCommits()])
  const totalReopened = a.reopened + b.reopened
  const totalScanned = a.scanned + b.scanned
  assert.equal(totalReopened, 1, `แถวเดียวต้องถูกกู้ครั้งเดียว — ได้ ${totalReopened}`)
  assert.equal(totalScanned, 1, 'FOR UPDATE SKIP LOCKED ต้องทำให้มีผู้กู้รายเดียวเห็นแถวนี้')

  const [session] = await rows('SELECT status FROM upload_sessions WHERE upload_id = $1', [upload.uploadId])
  assert.equal(session.status, 'open')
  assert.equal((await rows('SELECT 1 FROM files WHERE name = $1', [name])).length, 0)
})

test('COMMITTED_FILE_SURVIVES_RECOVERY · ไฟล์ที่ commit สำเร็จแล้วไม่ถูกงานกู้คืนแตะ', { skip }, async () => {
  const owner = await login()
  const content = makeContent(SMALL)
  const name = `survive-${Date.now()}.bin`
  const upload = await uploadReadyToCommit(owner, name, content)
  const commit = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit.status, 201)
  const before = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]

  const tally = await recoverStaleCommits({ leaseMs: 60_000 })
  assert.equal(tally.scanned, 0, 'session ที่ commit แล้วไม่ควรถูกหยิบมาตรวจเลย')

  const after = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]
  assert.equal(after.id, before.id)
  assert.equal(after.path, before.path)
  assert.ok((await fs.readFile(resolveKey(after.path))).equals(content))
  const [session] = await rows('SELECT status, committed_file_id FROM upload_sessions WHERE upload_id = $1',
    [upload.uploadId])
  assert.equal(session.status, 'committed')
  assert.equal(String(session.committed_file_id), String(before.id),
    'DURABLE_COMMIT_INTENT — session ต้องบันทึกว่าตัวเองผลิตแถวไหน')
})

// ═════════════════════════════════════════════════════════════════════════════
// SAME_NAME_VERSION_CRASH_SAFE
// เดิม commit ของชื่อซ้ำเรียก moveToVersions() ก่อนเขียน metadata — ถ้าโปรเซสตายตรงนั้น
// files.path จะชี้ไปยัง key ที่ไม่มีไฟล์อยู่แล้ว = ไฟล์เดิมของผู้ใช้อ่านไม่ได้
// ตอนนี้ไบต์เดิมไม่ถูกย้ายเลย ช่วงเวลานั้นจึงหายไปทั้งช่วง
// ═════════════════════════════════════════════════════════════════════════════
test('SAME_NAME_VERSION_CRASH_SAFE · ตายกลาง commit ของชื่อซ้ำ ไฟล์เดิมยังอ่านได้ครบ', { skip }, async () => {
  const owner = await login()
  const name = `version-crash-${Date.now()}.bin`
  const v1 = makeContent(SMALL)
  const v2 = makeContent(SMALL + 64)

  // เวอร์ชันแรก commit สำเร็จปกติ
  const first = await uploadReadyToCommit(owner, name, v1)
  assert.equal((await owner.req(`/api/files/uploads/${first.uploadId}/commit`, { method: 'POST' })).status, 201)
  const original = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]

  // เวอร์ชันที่สองของชื่อเดียวกัน — ตายหลัง publish แต่ก่อนเขียน metadata
  const second = await uploadReadyToCommit(owner, name, v2)
  const key2 = await simulateCrashAfterPublish(second.uploadId)

  // ⚠️ ข้อพิสูจน์หลัก: ไฟล์เดิมของผู้ใช้ต้อง "ยังอ่านได้" ณ วินาทีนี้
  const stillThere = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]
  assert.equal(stillThere.path, original.path, 'files.path ต้องยังชี้ไปยังไบต์ชุดเดิม')
  assert.ok((await fs.readFile(resolveKey(stillThere.path))).equals(v1),
    'ไบต์ของไฟล์เดิมต้องยังอยู่ครบ — นี่คือช่องที่ moveToVersions() เคยเปิดไว้')
  const dl = await fetch(`${baseUrl}/api/files/${stillThere.id}/download`, { headers: { cookie: owner.cookie } })
  assert.equal(dl.status, 200, 'ดาวน์โหลดไฟล์เดิมต้องยังทำงานได้ระหว่างที่ commit ค้าง')
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(v1))

  // กู้คืนแล้ว commit ใหม่ให้จบ
  assert.equal((await recoverStaleCommits()).reopened, 1)
  await assert.rejects(fs.stat(resolveKey(key2)), 'ไบต์ของเวอร์ชันที่ยังไม่สำเร็จต้องไม่ค้างเป็นของกำพร้า')
  const retry = await owner.req(`/api/files/uploads/${second.uploadId}/commit`, { method: 'POST' })
  assert.equal(retry.status, 201, JSON.stringify(retry.data))
  assert.equal(retry.data.newVersion, true)

  // ปลายทาง: หนึ่งแถวใน files ชี้ไบต์ใหม่ + หนึ่งเวอร์ชันชี้ไบต์เดิม ทั้งคู่มีอยู่จริง
  const finalRows = await rows('SELECT * FROM files WHERE name = $1', [name])
  assert.equal(finalRows.length, 1, 'NO_DUPLICATE_FILE_ROW')
  assert.ok((await fs.readFile(resolveKey(finalRows[0].path))).equals(v2))
  const versions = await rows('SELECT * FROM file_versions WHERE file_id = $1', [finalRows[0].id])
  assert.equal(versions.length, 1)
  assert.equal(versions[0].storage_key, original.path, 'เวอร์ชันเก่าต้องชี้ไปยัง key เดิมของมัน')
  assert.ok((await fs.readFile(resolveKey(versions[0].storage_key))).equals(v1),
    'ไบต์ของเวอร์ชันเก่าต้องยังอ่านได้ — ห้ามหายไปเพราะการย้ายไฟล์')
})

test('SAME_NAME_VERSION_CRASH_SAFE · ทุกแถวใน files และ file_versions ชี้ไปยังไบต์ที่มีอยู่จริง', { skip }, async () => {
  const owner = await login()
  const name = `version-integrity-${Date.now()}.bin`

  // สามรุ่นซ้อนกัน โดยรุ่นกลางตายหลัง publish แล้วถูกกู้คืน
  for (let round = 0; round < 3; round += 1) {
    const content = makeContent(SMALL + round * 32)
    const upload = await uploadReadyToCommit(owner, name, content)
    if (round === 1) {
      await simulateCrashAfterPublish(upload.uploadId)
      assert.equal((await recoverStaleCommits()).reopened, 1)
    }
    const res = await owner.req(`/api/files/uploads/${upload.uploadId}/commit`, { method: 'POST' })
    assert.equal(res.status, 201, `round ${round}: ${JSON.stringify(res.data)}`)
  }

  const [file] = await rows('SELECT * FROM files WHERE name = $1', [name])
  const versions = await rows('SELECT * FROM file_versions WHERE file_id = $1 ORDER BY created_at', [file.id])
  assert.equal(versions.length, 2, 'ต้องมีสองเวอร์ชันเก่า')

  // NO_METADATA_TO_MISSING_BYTES — ทุก key ที่ metadata อ้างถึงต้องมีไฟล์อยู่จริง
  for (const key of [file.path, ...versions.map((v) => v.storage_key)]) {
    await fs.access(resolveKey(key))
  }
  // และไม่มี key ซ้ำกันระหว่างไฟล์ปัจจุบันกับเวอร์ชันเก่า
  const keys = [file.path, ...versions.map((v) => v.storage_key)]
  assert.equal(new Set(keys).size, keys.length, 'ทุก key ต้องไม่ซ้ำกัน')
})


// ═════════════════════════════════════════════════════════════════════════════
// รายละเอียดการจัดเก็บ: เวอร์ชันที่ V2 สร้าง "ไม่ถูกย้าย" ไบต์ จึงยังอยู่ใต้ uploads/
//
// ⚠️ นี่คือผลข้างเคียงโดยตรงของการปิดช่องโหว่ same-name — และเป็นสิ่งที่ต้องตรึงไว้
//    ด้วยเทสต์ ไม่ใช่ปล่อยให้เป็นความรู้ที่อยู่ในหัวคน: ถ้าวันหนึ่งมีใครเขียนโค้ดที่
//    "สันนิษฐานว่า key ของทุกเวอร์ชันขึ้นต้นด้วย versions/" เทสต์ชุดนี้ต้องแดงทันที
//    ผู้บริโภคทุกตัวต้อง resolve จาก key ที่ "เก็บไว้จริง" เท่านั้น ไม่ใช่จาก prefix
// ═════════════════════════════════════════════════════════════════════════════
test('V2_VERSION_KEY_RESOLVED_NOT_ASSUMED · เวอร์ชันที่ยังอยู่ใต้ uploads/ ดาวน์โหลดและกู้คืนได้ครบ', { skip }, async () => {
  const owner = await login()
  const name = `version-key-shape-${Date.now()}.bin`
  const v1 = makeContent(SMALL)
  const v2 = makeContent(SMALL + 128)

  const first = await uploadReadyToCommit(owner, name, v1)
  assert.equal((await owner.req(`/api/files/uploads/${first.uploadId}/commit`, { method: 'POST' })).status, 201)
  const original = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]

  const second = await uploadReadyToCommit(owner, name, v2)
  const commit2 = await owner.req(`/api/files/uploads/${second.uploadId}/commit`, { method: 'POST' })
  assert.equal(commit2.status, 201, JSON.stringify(commit2.data))
  assert.equal(commit2.data.newVersion, true)

  const file = (await rows('SELECT * FROM files WHERE name = $1', [name]))[0]
  const [version] = await rows('SELECT * FROM file_versions WHERE file_id = $1', [file.id])

  // ── รูปร่างของ key ที่ตรึงไว้ ────────────────────────────────────────────────
  // เส้นทาง V2 ไม่ย้ายไบต์เลย เวอร์ชันเก่าจึงยังถือ key เดิมของมันซึ่งอยู่ใต้ uploads/
  assert.equal(version.storage_key, original.path)
  assert.ok(version.storage_key.startsWith('uploads/'),
    'เวอร์ชันที่ V2 สร้างยังอยู่ใต้ uploads/ โดยเจตนา (ไม่มีการ rename)')
  assert.ok(!version.storage_key.startsWith('versions/'),
    'ถ้าข้อนี้แดง แปลว่าพฤติกรรมเปลี่ยน — ต้องทบทวนบันทึกการออกแบบก่อนแก้เทสต์')

  // ── ผู้บริโภคที่ 1: ดาวน์โหลดไฟล์ปัจจุบัน ต้องได้ไบต์ชุดใหม่ ────────────────
  const cur = await fetch(`${baseUrl}/api/files/${file.id}/download`, { headers: { cookie: owner.cookie } })
  assert.equal(cur.status, 200)
  assert.ok(Buffer.from(await cur.arrayBuffer()).equals(v2))

  // ── ผู้บริโภคที่ 2: รายการเวอร์ชัน + ดาวน์โหลดเวอร์ชันเก่าผ่าน API จริง ─────
  const listed = await owner.req(`/api/files/${file.id}/versions`)
  assert.equal(listed.status, 200)
  assert.equal(listed.data.versions.length, 1)
  const versionId = listed.data.versions[0].id

  const old = await fetch(`${baseUrl}/api/files/${file.id}/versions/${versionId}/download`,
    { headers: { cookie: owner.cookie } })
  assert.equal(old.status, 200, 'ดาวน์โหลดเวอร์ชันต้องทำงานกับ key ใต้ uploads/ ได้เหมือนกัน')
  assert.ok(Buffer.from(await old.arrayBuffer()).equals(v1))

  // ── ผู้บริโภคที่ 3: restore เวอร์ชันที่อยู่ใต้ uploads/ ──────────────────────
  const restored = await owner.req(`/api/files/${file.id}/versions/${versionId}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200, JSON.stringify(restored.data))

  const afterCur = await fetch(`${baseUrl}/api/files/${file.id}/download`, { headers: { cookie: owner.cookie } })
  assert.equal(afterCur.status, 200)
  assert.ok(Buffer.from(await afterCur.arrayBuffer()).equals(v1), 'ไบต์ที่กู้คืนมาต้องเป็นเวอร์ชันเก่าจริง')

  // ไบต์ชุดที่เพิ่งถูกแทนที่กลายเป็นเวอร์ชันใหม่ และดาวน์โหลดได้ (คราวนี้ key อยู่ใต้ versions/)
  const after = await owner.req(`/api/files/${file.id}/versions`)
  assert.equal(after.data.versions.length, 1)
  const archivedId = after.data.versions[0].id
  const archived = await fetch(`${baseUrl}/api/files/${file.id}/versions/${archivedId}/download`,
    { headers: { cookie: owner.cookie } })
  assert.equal(archived.status, 200)
  assert.ok(Buffer.from(await archived.arrayBuffer()).equals(v2))

  // ── NO_METADATA_TO_MISSING_BYTES ยังจริงหลังจบทุกขั้น ───────────────────────
  const [finalFile] = await rows('SELECT * FROM files WHERE name = $1', [name])
  const finalVersions = await rows('SELECT * FROM file_versions WHERE file_id = $1', [finalFile.id])
  for (const key of [finalFile.path, ...finalVersions.map((v) => v.storage_key)]) {
    await fs.access(resolveKey(key))
  }
})
// ═════════════════════════════════════════════════════════════════════════════
// การกู้คืนต้องไม่แตะ session ของงานเก็บกวาด และกลับกัน
// ═════════════════════════════════════════════════════════════════════════════
test('งานกู้คืนกับงานเก็บกวาดไม่แตะแถวของกันและกัน', { skip }, async () => {
  const owner = await login()
  const abandoned = await uploadReadyToCommit(owner, `sep-abandoned-${Date.now()}.bin`, makeContent(SMALL))
  const crashed = await uploadReadyToCommit(owner, `sep-crashed-${Date.now()}.bin`, makeContent(SMALL))
  await simulateCrashAfterClaim(crashed.uploadId)
  await sql.query(`UPDATE upload_sessions SET expires_at = now() - interval '1 day'`)

  // กู้คืนก่อน — ต้องแตะเฉพาะแถวที่ committing
  const recovery = await recoverStaleCommits()
  assert.equal(recovery.scanned, 1)
  assert.equal((await rows('SELECT 1 FROM upload_sessions WHERE upload_id = $1', [abandoned.uploadId])).length, 1,
    'งานกู้คืนต้องไม่ลบ session ที่ผู้ใช้ทิ้งไว้')

  // เก็บกวาดตามหลัง — ตอนนี้ทั้งคู่เป็น open และหมดอายุแล้ว จึงถูกเก็บกวาดทั้งคู่ตามกติกา
  const cleanup = await cleanupAbandonedUploads({ now: Date.now() })
  assert.ok(cleanup.expired >= 1)
  assert.equal((await rows('SELECT 1 FROM upload_sessions WHERE upload_id = $1', [abandoned.uploadId])).length, 0)
})
