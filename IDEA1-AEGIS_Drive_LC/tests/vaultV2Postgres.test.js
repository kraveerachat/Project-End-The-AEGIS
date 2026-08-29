// tests/vaultV2Postgres.test.js — AEGIS Drive (IDEA1) · Private Vault V2 กับ Postgres จริง
//
// ⚠️ ชุดนี้มีอยู่เพราะบทเรียนตรง ๆ จากรอบก่อน: การพิสูจน์เฉพาะโหมด in-memory ไม่ใช่
//    หลักฐานว่าเส้นทาง production ทำงาน สิ่งที่พิสูจน์ได้ "เฉพาะกับ PostgreSQL จริง"
//    และไม่มีทางพิสูจน์ในหน่วยความจำเลยคือ:
//      1. migration ของฐานข้อมูลที่มีข้อมูลอยู่แล้ว (เพิ่มอย่างเดียว, รันซ้ำได้)
//      2. GRANT ที่ชัดแจ้ง — ALTER DEFAULT PRIVILEGES ครอบเฉพาะตารางที่ role เดียวกัน
//         เป็นคนสร้าง (บทเรียนที่วัดไว้แล้วใน PR #43)
//      3. ขอบเขตของ role: drive_app ทำ DML ได้ แต่ DDL ไม่ได้
//      4. CHECK / FK / CASCADE ที่ฐานข้อมูลบังคับเอง ไม่ใช่โค้ดแอปบังคับ
//      5. FOR UPDATE SKIP LOCKED ของงานกู้คืน — worker สองตัวพร้อมกันได้ผลเดียว
//
// ⚠️ ต้องรันกับฐานข้อมูลแบบใช้แล้วทิ้งที่แยกขาด — เตรียมด้วย
//    sh scripts/pg-integration-env.sh up   แล้วส่ง TEST_DATABASE_URL ที่มันพิมพ์ออกมา
//    ไม่ตั้ง = ข้ามทั้งไฟล์และบันทึกไว้ตามตรงว่าไม่ได้ตรวจ ไม่ใช่แกล้งผ่าน
// ⚠️ ทรัพยากรทุกชิ้นที่ไฟล์นี้สร้าง (ฐานข้อมูล probe, role probe) ถูกลบใน finally ของ
//    ตัวเอง และไม่มีคำสั่งใดแตะสิ่งที่ไฟล์นี้ไม่ได้สร้าง
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { performLogin } from './helpers/testClient.mjs'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อรันกับ Postgres จริง (ดู scripts/pg-integration-env.sh)'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-v2-pg-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
process.env.VAULT_CHUNK_PLAINTEXT_BYTES = String(8 * 1024 * 1024)
if (DB_URL) process.env.DATABASE_URL = DB_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initVaultStaging, vaultStagingConfig } = await import('../server/storage/vaultStaging.js')
const { recoverStaleVaultCommits } = await import('../server/storage/vaultCommitRecovery.js')
const { cleanupAbandonedVaultUploads } = await import('../server/storage/vaultUploadCleanup.js')
const { VAULT_TRANSFER_LIMITS, GCM_TAG_BYTES } = await import('../server/config/vaultTransferLimits.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')
const { createVaultSetup } = await import('../src/lib/vaultCrypto.js')
const { createVaultV2Envelope } = await import('../src/lib/vaultChunkCrypto.js')

const CIPHER_CHUNK = VAULT_TRANSFER_LIMITS.ciphertextChunkBytes
const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }
const PASSPHRASE = 'orchid-tungsten-ledger-41-vault'
const SECRET_FILENAME = 'board-minutes-CONFIDENTIAL.pdf'

const OWNER = { username: 'user', password: 'aegis-drive-user' }
const OTHER = { username: 'admin', password: 'aegis-drive-admin' }

const V2_TABLES = [
  'vault_v2_blobs', 'vault_v2_blob_chunks', 'vault_v2_upload_sessions', 'vault_v2_upload_chunks',
]

let server, baseUrl, sql

before(async () => {
  if (skip) return
  assert.equal(usingPostgres, true, 'ต้องเชื่อมต่อ Postgres จริง')
  await initStorage()
  await initVaultStorage()
  await initVaultStaging()
  // connection แยกของเราเอง — อ่าน "ไบต์ที่นอนอยู่ในตารางจริง" ไม่ใช่สิ่งที่ store เลือกคืนมา
  sql = new pg.Pool({ connectionString: DB_URL, max: 4 })
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
  await sql.query('DELETE FROM vault_v2_upload_chunks')
  await sql.query('DELETE FROM vault_v2_upload_sessions')
  await sql.query('DELETE FROM vault_v2_blob_chunks')
  await sql.query('DELETE FROM vault_v2_blobs')
  await sql.query('DELETE FROM vault_blobs')
  await sql.query('DELETE FROM vault_meta')
  const dir = path.join(STORAGE_ROOT, 'vault')
  for (const f of await fs.readdir(dir).catch(() => [])) {
    await fs.rm(path.join(dir, f), { recursive: true, force: true })
  }
  const staging = path.join(STORAGE_ROOT, vaultStagingConfig.STAGING_DIR)
  for (const f of await fs.readdir(staging).catch(() => [])) {
    await fs.rm(path.join(staging, f), { recursive: true, force: true })
  }
})

// ── client จำลอง ─────────────────────────────────────────────────────────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }

  async req(pathname, { method = 'GET', body, headers: extra } = {}) {
    const headers = { ...extra }
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (body instanceof Uint8Array) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = await res.json() } catch { /* 204 / octet-stream */ }
    return { status: res.status, data, headers: res.headers }
  }

  async raw(pathname) {
    const headers = this.cookie ? { cookie: this.cookie } : {}
    const res = await fetch(baseUrl + pathname, { headers })
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) }
  }
}

async function login(who = OWNER) {
  const c = new Client()
  await performLogin(c, who.username, who.password)
  return c
}

const rows = async (t, p) => (await sql.query(t, p)).rows
const partPathOf = (id) => path.join(STORAGE_ROOT, vaultStagingConfig.STAGING_DIR, id, 'part')
const finalPathOf = (key) => path.join(STORAGE_ROOT, key)

async function setupVault(client) {
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  const res = await client.req('/api/vault/setup', {
    method: 'POST',
    body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(res.status, 201, JSON.stringify(res.data))
  return setup.kek
}

/**
 * เปิด session หนึ่งก้อนแล้วส่ง ciphertext ครบ — จบที่สถานะ 'open' พร้อม commit
 * ⚠️ ไบต์เป็นข้อมูลสุ่ม ไม่ใช่ ciphertext จริง โดยเจตนา: เซิร์ฟเวอร์ถอดรหัสไม่ได้อยู่แล้ว
 *    การพิสูจน์ว่าถอดได้จริงอยู่ใน vaultV2Api.test.js และ vaultChunkCrypto.test.js
 */
async function uploadReadyToCommit(client, kek, { ciphertextSize = 4096 + GCM_TAG_BYTES } = {}) {
  const env = await createVaultV2Envelope(kek, {
    name: SECRET_FILENAME, type: 'application/pdf', size: ciphertextSize - GCM_TAG_BYTES, chunkCount: 1,
  })
  const open = await client.req('/api/vault/uploads', {
    method: 'POST',
    body: {
      formatVersion: 2,
      contentIdB64: env.contentIdB64,
      ciphertextSize,
      chunkSize: CIPHER_CHUNK,
      chunkCount: 1,
      wrappedDekB64: env.wrappedDekB64,
      wrapIvB64: env.wrapIvB64,
      metaIvB64: env.metaIvB64,
      metaB64: env.metaB64,
    },
  })
  assert.equal(open.status, 201, JSON.stringify(open.data))
  const bytes = randomBytes(ciphertextSize)
  const put = await client.req(`/api/vault/uploads/${open.data.upload.uploadId}/chunks/0`, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Vault-Chunk-IV': randomBytes(12).toString('base64') },
  })
  assert.equal(put.status, 200, JSON.stringify(put.data))
  return { uploadId: open.data.upload.uploadId, bytes, ciphertextSize, env }
}

/** สถานะที่ "โปรเซสที่ตายหลังการจอง" ทิ้งไว้ — ไบต์ต่อไบต์เหมือนที่ claim เขียนจริง */
async function simulateCrashAfterClaim(uploadId) {
  const key = `vault/${randomUUID()}.aegisenc`
  await sql.query(
    `UPDATE vault_v2_upload_sessions
        SET status = 'committing',
            commit_started_at = now() - interval '1 hour',
            commit_storage_key = $2,
            committed_blob_id = NULL
      WHERE upload_id = $1`,
    [uploadId, key],
  )
  return key
}

/** ...และตายหลัง rename ไปยัง key ปลายทางแล้ว แต่ก่อนเขียน metadata */
async function simulateCrashAfterPublish(uploadId) {
  const key = await simulateCrashAfterClaim(uploadId)
  await fs.rename(partPathOf(uploadId), finalPathOf(key))
  return key
}

// ═════════════════════════════════════════════════════════════════════════════
// 31 · DB ↔ ดิสก์ ต้องตรงกันหลังวงจรจริง
// ═════════════════════════════════════════════════════════════════════════════
test('commit เขียนแถว blob + แถว chunk ครบใน transaction เดียว และตรงกับไฟล์บนดิสก์', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId, bytes, ciphertextSize } = await uploadReadyToCommit(owner, kek)

  const commit = await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  const blobId = commit.data.blob.id

  const [blob] = await rows('SELECT * FROM vault_v2_blobs WHERE id = $1', [blobId])
  assert.ok(blob, 'ต้องมีแถว blob จริงในตาราง')
  assert.equal(Number(blob.format_version), 2)
  assert.equal(Number(blob.ciphertext_size), ciphertextSize)
  assert.equal(Number(blob.chunk_count), 1)
  assert.ok(blob.storage_key.startsWith('vault/'), 'storage key ต้องอยู่ใต้ vault/')

  const chunkRows = await rows('SELECT * FROM vault_v2_blob_chunks WHERE blob_id = $1 ORDER BY chunk_index', [blobId])
  assert.equal(chunkRows.length, 1)
  assert.equal(Number(chunkRows[0].ciphertext_size), ciphertextSize)
  assert.equal(chunkRows[0].ciphertext_sha256.length, 64)
  assert.equal(Buffer.from(chunkRows[0].iv_b64, 'base64').length, 12)

  // ไบต์บนดิสก์ตรงกับที่ส่งไป และมีไฟล์เดียว
  const onDisk = await fs.readFile(finalPathOf(blob.storage_key))
  assert.ok(onDisk.equals(bytes), 'ไบต์ที่เก็บต้องเป็นไบต์ที่ส่งมา')
  const files = await fs.readdir(path.join(STORAGE_ROOT, 'vault'))
  assert.equal(files.length, 1)

  // session ถูกปิดและผูกกับ blob ที่มันผลิต (DURABLE_COMMIT_INTENT)
  const [session] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(session.status, 'committed')
  assert.equal(session.committed_blob_id, blobId)
  assert.equal((await rows('SELECT 1 FROM vault_v2_upload_chunks WHERE upload_id = $1', [uploadId])).length, 1)

  // ⚠️ ไม่มีคอลัมน์ใดในตาราง V2 ที่เก็บชื่อไฟล์หรือ MIME ได้เลย
  const columns = await rows(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ANY($1)`, [V2_TABLES],
  )
  const names = columns.map((c) => c.column_name)
  for (const forbidden of ['name', 'filename', 'mime_type', 'content_type', 'plain_size', 'passphrase']) {
    assert.equal(names.includes(forbidden), false, `ตาราง V2 ต้องไม่มีคอลัมน์ ${forbidden}`)
  }
  const dump = JSON.stringify([blob, ...chunkRows, session])
  for (const secret of [PASSPHRASE, SECRET_FILENAME, 'CONFIDENTIAL']) {
    assert.equal(dump.includes(secret), false, `แถวในฐานข้อมูลต้องไม่มี "${secret}"`)
  }
})

test('ลบ blob ผ่าน API เอาแถว chunk (CASCADE) และไฟล์ไปด้วย — ไม่มีของกำพร้าทั้งสองฝั่ง', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  const blob = (await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob
  const [row] = await rows('SELECT storage_key FROM vault_v2_blobs WHERE id = $1', [blob.id])

  assert.equal((await owner.req(`/api/vault/blobs/${blob.id}`, { method: 'DELETE' })).status, 204)

  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs WHERE id = $1', [blob.id])).length, 0)
  assert.equal((await rows('SELECT 1 FROM vault_v2_blob_chunks WHERE blob_id = $1', [blob.id])).length, 0,
    'แถว chunk ต้องหายตามผ่าน ON DELETE CASCADE')
  await assert.rejects(fs.stat(finalPathOf(row.storage_key)), 'ไบต์ต้องถูกลบด้วย')
  assert.deepEqual(await fs.readdir(path.join(STORAGE_ROOT, 'vault')), [])

  // session ที่เคยผลิต blob นี้ต้องไม่กลายเป็นแถวที่ชี้ไปยัง id ที่หายไป
  const [session] = await rows('SELECT committed_blob_id FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(session.committed_blob_id, null, 'ON DELETE SET NULL ต้องทำงาน')
})

test('ลบบัญชีผู้ใช้ทำให้ blob / chunk / session ของเขาหายตามทั้งหมด', { skip }, async () => {
  const [tmp] = await rows(
    `INSERT INTO users (username, password_hash, display_name)
     VALUES ($1, '$2a$10$notarealhash', 'Vault V2 Cascade Probe') RETURNING id`,
    [`v2_cascade_${Date.now()}`],
  )
  const blobId = 'b'.repeat(48)
  const uploadId = 'c'.repeat(48)
  await sql.query(
    `INSERT INTO vault_v2_blobs
       (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
     VALUES ($1, $2, $3, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b')`,
    [blobId, tmp.id, `vault/${randomUUID()}.aegisenc`],
  )
  await sql.query(
    `INSERT INTO vault_v2_blob_chunks (blob_id, chunk_index, ciphertext_size, ciphertext_sha256, iv_b64)
     VALUES ($1, 0, 50, repeat('a', 64), 'iv')`, [blobId],
  )
  await sql.query(
    `INSERT INTO vault_v2_upload_sessions
       (upload_id, user_id, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64, expires_at)
     VALUES ($1, $2, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b', now() + interval '1 day')`,
    [uploadId, tmp.id],
  )
  await sql.query(
    `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token)
     VALUES ($1, 0, 'writing', 'token')`, [uploadId],
  )

  await sql.query('DELETE FROM users WHERE id = $1', [tmp.id])

  for (const [table, col, id] of [
    ['vault_v2_blobs', 'id', blobId],
    ['vault_v2_blob_chunks', 'blob_id', blobId],
    ['vault_v2_upload_sessions', 'upload_id', uploadId],
    ['vault_v2_upload_chunks', 'upload_id', uploadId],
  ]) {
    assert.equal((await rows(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [id])).length, 0,
      `${table} ต้องไม่เหลือแถวกำพร้าที่ไม่มีเจ้าของ`)
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 32 · CHECK constraints — ฐานข้อมูลบังคับเอง ไม่ใช่แค่โค้ดแอป
// ═════════════════════════════════════════════════════════════════════════════
test('CHECK ของ V2 ปฏิเสธ format_version / status / state / แถว received ที่ไม่สมบูรณ์', { skip }, async () => {
  const [u] = await rows('SELECT id FROM users ORDER BY id LIMIT 1')
  const blobId = 'd'.repeat(48)
  const uploadId = 'e'.repeat(48)

  const insertBlob = (patch = '') => sql.query(
    `INSERT INTO vault_v2_blobs
       (id, user_id, ${patch ? 'format_version, ' : ''}storage_key, content_id_b64,
        ciphertext_size, chunk_size, chunk_count, wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
     VALUES ($1, $2, ${patch ? `${patch}, ` : ''}$3, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b')`,
    [blobId, u.id, `vault/${randomUUID()}.aegisenc`],
  )
  await assert.rejects(insertBlob('1'), /violates check constraint/, 'format_version ≠ 2 ต้องถูกปฏิเสธ')
  await assert.rejects(insertBlob('3'), /violates check constraint/)

  // ciphertext_size / chunk_size / chunk_count ต้องเป็นบวกเสมอ (ไฟล์ว่าง = 1 chunk ที่มี tag)
  for (const [col, value] of [['ciphertext_size', 0], ['chunk_size', 0], ['chunk_count', 0]]) {
    await assert.rejects(sql.query(
      `INSERT INTO vault_v2_blobs
         (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
          wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
       VALUES ($1, $2, $3, 'AAAAAAAAAAAAAAAAAAAAAA==',
               ${col === 'ciphertext_size' ? value : 100},
               ${col === 'chunk_size' ? value : 64},
               ${col === 'chunk_count' ? value : 2}, 'w', 'i', 'm', 'b')`,
      [blobId, u.id, `vault/${randomUUID()}.aegisenc`],
    ), /violates check constraint/, `${col} = ${value} ต้องถูกปฏิเสธ`)
  }

  // storage_key ต้องซ้ำไม่ได้ — สอง blob ที่ชี้ไฟล์เดียวกันคือ NO_ORPHAN ที่พังทันที
  const dupKey = `vault/${randomUUID()}.aegisenc`
  await sql.query(
    `INSERT INTO vault_v2_blobs
       (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
     VALUES ($1, $2, $3, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b')`,
    [blobId, u.id, dupKey],
  )
  await assert.rejects(sql.query(
    `INSERT INTO vault_v2_blobs
       (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
     VALUES ($1, $2, $3, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b')`,
    ['f'.repeat(48), u.id, dupKey],
  ), /duplicate key value/, 'storage_key ต้อง UNIQUE')

  // session: status นอกรายการถูกปฏิเสธ; ทั้งสี่สถานะที่ถูกต้องต้องผ่าน
  const insertSession = (status) => sql.query(
    `INSERT INTO vault_v2_upload_sessions
       (upload_id, user_id, status, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64, expires_at)
     VALUES ($1, $2, $3, 'AAAAAAAAAAAAAAAAAAAAAA==', 100, 64, 2, 'w', 'i', 'm', 'b', now() + interval '1 day')`,
    [uploadId, u.id, status],
  )
  await assert.rejects(insertSession('bogus'), /violates check constraint/)
  for (const status of ['open', 'committing', 'committed', 'aborted']) {
    await sql.query('DELETE FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
    await insertSession(status)
  }

  // chunk: state นอกรายการ, index ติดลบ, และ 'received' ที่ payload ไม่ครบ
  await assert.rejects(sql.query(
    `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token)
     VALUES ($1, 0, 'done', 't')`, [uploadId]), /violates check constraint/)
  await assert.rejects(sql.query(
    `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token)
     VALUES ($1, -1, 'writing', 't')`, [uploadId]), /violates check constraint/)

  // ⚠️ หัวใจของข้อจำกัดชดเชย: คอลัมน์ payload เป็น nullable ได้ก็เพราะ CHECK นี้
  await assert.rejects(sql.query(
    `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token, ciphertext_size)
     VALUES ($1, 1, 'received', 't', 10)`, [uploadId]),
  /vault_v2_chunk_received_is_complete/,
  'แถว received ที่ขาด sha256/iv ต้องถูกฐานข้อมูลปฏิเสธ ไม่ใช่แค่โค้ดแอป')

  // 'writing' ที่ไม่มี payload เลยต้องผ่าน — นั่นคือความหมายของสถานะนี้
  await sql.query(
    `INSERT INTO vault_v2_upload_chunks (upload_id, chunk_index, state, writer_token)
     VALUES ($1, 2, 'writing', 't')`, [uploadId])
  await sql.query(
    `INSERT INTO vault_v2_upload_chunks
       (upload_id, chunk_index, state, writer_token, ciphertext_size, ciphertext_sha256, iv_b64)
     VALUES ($1, 3, 'received', 't', 10, repeat('a', 64), 'iv')`, [uploadId])
})

// ═════════════════════════════════════════════════════════════════════════════
// 33 · ขอบเขตของ role ที่แอปใช้จริง
// ═════════════════════════════════════════════════════════════════════════════
test('role ของแอปทำ DML บนตาราง V2 ได้ครบสี่คำสั่ง แต่แก้ schema ไม่ได้เลย', { skip }, async () => {
  const [me] = await rows('SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user')
  assert.equal(me.rolsuper, false,
    `role ${me.role} ต้องไม่ใช่ superuser — เทสต์ที่รันเป็น superuser พิสูจน์ขอบเขตอะไรไม่ได้`)

  // DML ทั้งสี่คำสั่งต้องทำได้จริงทุกตาราง (ตรวจด้วยสิทธิ์ที่ประกาศ ไม่ใช่แค่ SELECT ผ่าน)
  const granted = await rows(
    `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE grantee = current_user AND table_name = ANY($1)
      GROUP BY table_name ORDER BY table_name`,
    [V2_TABLES],
  )
  assert.equal(granted.length, 4, 'ทั้งสี่ตารางต้องมีสิทธิ์ให้ role ของแอป')
  for (const r of granted) {
    assert.equal(r.privs, 'DELETE,INSERT,SELECT,UPDATE', `${r.table_name} ต้องได้ DML ครบสี่คำสั่ง`)
    for (const forbidden of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(r.privs.includes(forbidden), false, `${r.table_name} ต้องไม่ได้ ${forbidden}`)
    }
  }

  // DDL ต้องถูกปฏิเสธทุกรูปแบบ
  await assert.rejects(sql.query('CREATE TABLE vault_v2_probe (id int)'), /permission denied/)
  await assert.rejects(sql.query('ALTER TABLE vault_v2_blobs ADD COLUMN probe int'), /must be owner/)
  await assert.rejects(sql.query('DROP TABLE vault_v2_blob_chunks'), /must be owner/)
  await assert.rejects(sql.query('TRUNCATE vault_v2_upload_sessions'), /permission denied/)

  // advisory lock ที่การเขียน chunk ใช้ ต้องเรียกได้ด้วยสิทธิ์ของแอป (ไม่ต้องเป็น superuser)
  const [lock] = await rows('SELECT pg_try_advisory_lock(1234, 5678) AS ok')
  assert.equal(lock.ok, true, 'role ของแอปต้องใช้ advisory lock ได้ ไม่งั้นกติกาการเขียน chunk พังทั้งหมด')
  await sql.query('SELECT pg_advisory_unlock(1234, 5678)')
})

// ═════════════════════════════════════════════════════════════════════════════
// 34 · migration 004 — เพิ่มอย่างเดียว, รันซ้ำได้, GRANT ชัดแจ้ง
// ═════════════════════════════════════════════════════════════════════════════
// ⚠️ ต้องใช้สิทธิ์ superuser เพื่อสร้างฐานข้อมูล probe ที่แยกขาด — ตั้ง
//    AEGIS_PGTEST_SUPER_URL (สคริปต์ pg-integration-env.sh พิมพ์ให้) ไม่ตั้ง = ข้าม
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const superSkip = skip || (SUPER_URL ? false : 'ต้องตั้ง AEGIS_PGTEST_SUPER_URL เพื่อสร้างฐานข้อมูล probe')

const V2_SECTION_MARKER = '-- ── Private Vault V2 — chunked zero-knowledge transfer (LFT-V2-B)'

test('migration 004 ให้สิทธิ์ drive_app ได้แม้ถูก apply โดย superuser คนละคนกับที่ตั้ง default privileges', { skip: superSkip }, async () => {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_v2grant_${Date.now()}`
  const appRole = (await sql.query('SELECT current_user AS r')).rows[0].r
  const schemaSql = await fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
  const migrationSql = await fs.readFile(
    new URL('../server/db/migrations/004_vault_v2.sql', import.meta.url), 'utf8',
  )
  // ฐานข้อมูล "ก่อน V2" = schema.sql ตัดตรงหัวข้อ LFT-V2-B ออก (ไฟล์จริง ไม่ใช่ของปลอม)
  const preV2 = schemaSql.slice(0, schemaSql.indexOf(V2_SECTION_MARKER))
  assert.ok(preV2.length > 0, 'ต้องหาหัวข้อ LFT-V2-B ใน schema.sql เจอ')
  assert.equal(preV2.includes('vault_v2_blobs'), false, 'ส่วนที่ตัดแล้วต้องไม่มีตาราง V2 เลย')
  assert.ok(preV2.includes('vault_blobs'), 'แต่ต้องยังมีตาราง V1 อยู่ครบ')
  assert.ok(preV2.includes('upload_sessions'), 'และตารางของ LFT-V2-A ด้วย')

  const url = (db) => SUPER_URL.replace(/\/[^/]*$/, `/${db}`)
  let probe, migrator, migratorName = null
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    probe = new pg.Client({ connectionString: url(dbName) })
    await probe.connect()
    await probe.query(preV2)

    // สิทธิ์แบบ production รวม ALTER DEFAULT PRIVILEGES — ตั้งโดย "admin"
    await probe.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`)
    await probe.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`)
    await probe.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`)
    await probe.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
    )

    // ── superuser อีกใบเป็นคนรัน migration (กรณีที่ DBA ทำจริงเป็นประจำ) ──────
    migratorName = `v2_migrator_${Date.now()}`
    const migratorPw = 'probe-only-not-a-production-credential'
    await admin.query(`CREATE ROLE ${migratorName} LOGIN SUPERUSER PASSWORD '${migratorPw}'`)
    migrator = new pg.Client({ connectionString: url(dbName).replace(/:\/\/[^@]*@/, `://${migratorName}:${migratorPw}@`) })
    await migrator.connect()
    await migrator.query(migrationSql)

    const owners = await probe.query(
      `SELECT tablename, tableowner FROM pg_tables WHERE tablename = ANY($1) ORDER BY tablename`, [V2_TABLES],
    )
    assert.equal(owners.rows.length, 4, 'migration ต้องสร้างครบทั้งสี่ตาราง')
    for (const r of owners.rows) {
      assert.equal(r.tableowner, migratorName, 'ตารางต้องเป็นของ role ที่รัน migration จริง ๆ')
    }

    // ⚠️ หัวใจของชุดนี้: สิทธิ์ต้องมาถึง drive_app แม้เจ้าของตารางเป็นคนละ role
    const grantsOf = async () => (await probe.query(
      `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name = ANY($2)
        GROUP BY table_name ORDER BY table_name`,
      [appRole, V2_TABLES],
    )).rows
    const granted = await grantsOf()
    assert.equal(granted.length, 4,
      'ทั้งสี่ตารางต้องมีสิทธิ์ให้ role ของแอป — ถ้าเป็น 0 คือข้อบกพร่องของ PR #43 กลับมาแล้ว')
    for (const r of granted) {
      assert.equal(r.privs, 'DELETE,INSERT,SELECT,UPDATE', `${r.table_name} ต้องได้ DML ครบสี่คำสั่ง`)
      for (const forbidden of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal(r.privs.includes(forbidden), false, `${r.table_name} ต้องไม่ได้ ${forbidden}`)
      }
    }

    // ── รันซ้ำต้องผ่านและไม่เปลี่ยนอะไร (MIGRATION_IDEMPOTENT) ────────────────
    await migrator.query(migrationSql)
    await migrator.query(migrationSql)
    assert.deepEqual(await grantsOf(), granted, 'สิทธิ์ต้องคงเดิมหลังรันซ้ำ')
    const countAfter = await probe.query(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ANY($1)`, [V2_TABLES],
    )
    assert.equal(Number(countAfter.rows[0].n), 4, 'รันซ้ำต้องไม่สร้างตารางเพิ่ม')

    // ── เพิ่มอย่างเดียว: ตาราง V1 ต้องไม่ถูกแตะแม้แต่คอลัมน์เดียว ──────────────
    const v1 = await probe.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'vault_blobs' ORDER BY column_name`,
    )
    assert.ok(v1.rows.length > 0, 'ตาราง V1 ต้องยังอยู่')
    const ivColumn = v1.rows.find((c) => c.column_name === 'iv_b64')
    assert.ok(ivColumn, 'vault_blobs.iv_b64 ต้องยังอยู่')
    assert.equal(ivColumn.is_nullable, 'NO',
      'V1 ต้องไม่ถูกทำให้ nullable เงียบ ๆ — นั่นคือคอลัมน์ที่พิสูจน์ว่าแถว V1 เป็นข้อความ GCM ที่สมบูรณ์')
  } finally {
    await migrator?.end().catch(() => {})
    await probe?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    if (migratorName) await admin.query(`DROP ROLE IF EXISTS ${migratorName}`).catch(() => {})
    await admin.end()
  }
})

test('migration 004 ไม่แตะข้อมูล V1 ที่มีอยู่แล้วแม้แต่แถวเดียว', { skip: superSkip }, async () => {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_v2additive_${Date.now()}`
  const schemaSql = await fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
  const migrationSql = await fs.readFile(
    new URL('../server/db/migrations/004_vault_v2.sql', import.meta.url), 'utf8',
  )
  const preV2 = schemaSql.slice(0, schemaSql.indexOf(V2_SECTION_MARKER))

  let probe
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    probe = new pg.Client({ connectionString: SUPER_URL.replace(/\/[^/]*$/, `/${dbName}`) })
    await probe.connect()
    await probe.query(preV2)

    // ข้อมูล V1 จริงที่ค้างอยู่ในฐานข้อมูลก่อนอัปเกรด
    const { rows: [u] } = await probe.query(
      `INSERT INTO users (username, password_hash, display_name)
       VALUES ('v1_owner', '\$2a\$10\$notarealhash', 'V1 Owner') RETURNING id`,
    )
    await probe.query(
      `INSERT INTO vault_meta (user_id, salt_b64, verifier_iv, verifier_data)
       VALUES ($1, 'c2FsdA==', 'viv', 'vdata')`, [u.id],
    )
    const { rows: [v1] } = await probe.query(
      `INSERT INTO vault_blobs
         (user_id, storage_key, size_bytes, iv_b64, wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
       VALUES ($1, 'vault/legacy.aegisenc', 1234, 'iv', 'dek', 'wiv', 'miv', 'meta') RETURNING *`,
      [u.id],
    )

    const before = (await probe.query(
      `SELECT md5(string_agg(id::text||storage_key||size_bytes::text||iv_b64, '|' ORDER BY id)) AS f
         FROM vault_blobs`,
    )).rows[0].f

    await probe.query(migrationSql)

    const after = (await probe.query(
      `SELECT md5(string_agg(id::text||storage_key||size_bytes::text||iv_b64, '|' ORDER BY id)) AS f
         FROM vault_blobs`,
    )).rows[0].f
    assert.equal(after, before, 'แถว V1 ต้องเหมือนเดิมทุกไบต์หลัง migration')

    const [row] = (await probe.query('SELECT * FROM vault_blobs WHERE id = $1', [v1.id])).rows
    assert.deepEqual(row, v1, 'แถว V1 ต้องไม่ถูกเขียนทับ')
    assert.equal((await probe.query('SELECT count(*) AS n FROM vault_v2_blobs')).rows[0].n, '0',
      'migration ต้องไม่ย้าย blob V1 เข้ามาเป็น V2')
  } finally {
    await probe?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// 35 · CRASH_AFTER_CLAIM / CRASH_AFTER_VERIFY
// การตรวจ (size + sha256) เป็นการอ่านล้วน สองเฟสนี้จึงทิ้งสถานะเดียวกันไว้
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_CLAIM / CRASH_AFTER_VERIFY · session ถูกเปิดกลับให้ commit ใหม่ได้', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId, bytes } = await uploadReadyToCommit(owner, kek)
  const key = await simulateCrashAfterClaim(uploadId)

  assert.ok((await fs.stat(partPathOf(uploadId))).isFile())
  await assert.rejects(fs.stat(finalPathOf(key)))
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs')).length, 0)

  const tally = await recoverStaleVaultCommits()
  assert.equal(tally.reopened, 1, `ต้องถูกเปิดกลับหนึ่งรายการ — ได้ ${JSON.stringify(tally)}`)

  const [session] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(session.status, 'open')
  assert.equal(session.commit_storage_key, null, 'commit intent ต้องถูกล้างเมื่อเปิดกลับ')
  assert.equal(session.commit_started_at, null)

  // ทำต่อได้จริงโดยไม่ต้องเข้ารหัสและอัปโหลดใหม่ทั้งไฟล์
  const commit = await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  const blobs = await rows('SELECT * FROM vault_v2_blobs')
  assert.equal(blobs.length, 1, 'NO_DUPLICATE_VAULT_BLOB')
  assert.ok((await fs.readFile(finalPathOf(blobs[0].storage_key))).equals(bytes))
})

// ═════════════════════════════════════════════════════════════════════════════
// 36 · CRASH_AFTER_PUBLISH — ไบต์ถูกย้ายแล้วแต่ไม่มี metadata ชี้ถึง
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_PUBLISH · ไบต์ถูกย้ายกลับมาเป็นพื้นที่พักและ commit ใหม่ได้ ไม่มี ciphertext กำพร้า', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId, bytes } = await uploadReadyToCommit(owner, kek)
  const key = await simulateCrashAfterPublish(uploadId)

  assert.ok((await fs.stat(finalPathOf(key))).isFile())
  await assert.rejects(fs.stat(partPathOf(uploadId)))
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs WHERE storage_key = $1', [key])).length, 0)

  const tally = await recoverStaleVaultCommits()
  assert.equal(tally.reopened, 1)

  // NO_ORPHAN_VAULT_CIPHERTEXT
  await assert.rejects(fs.stat(finalPathOf(key)), 'ไบต์ต้องถูกย้ายกลับ ไม่ใช่ทิ้งไว้เป็นของกำพร้า')
  assert.ok((await fs.stat(partPathOf(uploadId))).isFile())

  const commit = await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201, JSON.stringify(commit.data))
  const blobs = await rows('SELECT * FROM vault_v2_blobs')
  assert.equal(blobs.length, 1, 'NO_DUPLICATE_VAULT_BLOB')
  assert.notEqual(blobs[0].storage_key, key, 'commit รอบใหม่เลือก key ใหม่ของตัวเอง')
  assert.ok((await fs.readFile(finalPathOf(blobs[0].storage_key))).equals(bytes))
  assert.equal((await fs.readdir(path.join(STORAGE_ROOT, 'vault'))).length, 1, 'ต้องมีไฟล์เดียว')
})

// ═════════════════════════════════════════════════════════════════════════════
// 37 · CRASH_AFTER_METADATA — เกิดไม่ได้โดยโครงสร้าง แต่ถ้าเกิดต้องปลอดภัย
// ═════════════════════════════════════════════════════════════════════════════
test('CRASH_AFTER_METADATA · แถว blob มีอยู่แล้วแต่ session ยัง committing → ปิดเป็น committed ไม่สร้างของซ้ำ', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId, ciphertextSize } = await uploadReadyToCommit(owner, kek)
  const key = await simulateCrashAfterPublish(uploadId)

  const [session] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  const blobId = 'a'.repeat(48)
  await sql.query(
    `INSERT INTO vault_v2_blobs
       (id, user_id, storage_key, content_id_b64, ciphertext_size, chunk_size, chunk_count,
        wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10)`,
    [blobId, session.user_id, key, session.content_id_b64, ciphertextSize, session.chunk_size,
      session.wrapped_dek_b64, session.wrap_iv_b64, session.meta_iv_b64, session.meta_b64],
  )

  const tally = await recoverStaleVaultCommits()
  assert.equal(tally.committed, 1, `ต้องถูกปิดเป็น committed — ได้ ${JSON.stringify(tally)}`)

  const [after] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(after.status, 'committed')
  assert.equal(after.committed_blob_id, blobId, 'ต้องผูกกับแถวที่มีอยู่แล้ว ไม่ใช่สร้างแถวใหม่')
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs')).length, 1, 'NO_DUPLICATE_VAULT_BLOB')
  assert.ok((await fs.stat(finalPathOf(key))).isFile(), 'ไบต์ที่ metadata ชี้ถึงต้องยังอยู่')
})

test('stale committing ที่ไบต์หายไปแล้ว → aborted และไม่มี metadata ชี้ไปยังไบต์ที่ไม่มีอยู่', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  const key = await simulateCrashAfterClaim(uploadId)
  await fs.rm(path.join(STORAGE_ROOT, vaultStagingConfig.STAGING_DIR, uploadId), { recursive: true, force: true })

  const tally = await recoverStaleVaultCommits()
  assert.equal(tally.aborted, 1, `ต้อง abort — ได้ ${JSON.stringify(tally)}`)

  const [session] = await rows('SELECT status FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(session.status, 'aborted')
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs WHERE storage_key = $1', [key])).length, 0,
    'NO_METADATA_TO_MISSING_CIPHERTEXT')
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs')).length, 0)

  // และไม่มีสถานะค้างที่ไม่มีใครกู้ได้ — session ที่ abort แล้วยกเลิกได้ตามปกติ
  const del = await owner.req(`/api/vault/uploads/${uploadId}`, { method: 'DELETE' })
  assert.equal(del.status, 200, 'session ที่ abort แล้วต้องไม่ค้างถาวร')
})

test('COMMIT_LEASE · commit ที่ยังทำงานอยู่ต้องไม่ถูกงานกู้คืนหรืองานเก็บกวาดแตะ', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)

  await sql.query(
    `UPDATE vault_v2_upload_sessions
        SET status = 'committing', commit_started_at = now(), commit_storage_key = $2
      WHERE upload_id = $1`,
    [uploadId, `vault/${randomUUID()}.aegisenc`],
  )

  const tally = await recoverStaleVaultCommits()
  assert.equal(tally.scanned, 0, 'commit ที่ยังทำงานอยู่ต้องไม่ถูกแม้แต่หยิบมาตรวจ')
  assert.equal(
    (await rows('SELECT status FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId]))[0].status,
    'committing', 'สถานะต้องไม่ถูกเปลี่ยน',
  )
  assert.ok((await fs.stat(partPathOf(uploadId))).isFile(), 'ไบต์ที่พักไว้ต้องไม่ถูกแตะ')

  // งานเก็บกวาดเป็นคนละงาน และต้องไม่แตะ committing แม้ session จะหมดอายุแล้ว
  await sql.query(`UPDATE vault_v2_upload_sessions SET expires_at = now() - interval '1 day' WHERE upload_id = $1`,
    [uploadId])
  await cleanupAbandonedVaultUploads({ now: Date.now() })
  assert.equal(
    (await rows('SELECT status FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId]))[0]?.status,
    'committing', 'expiry cleanup ต้องไม่แตะสถานะ committing',
  )
  assert.ok((await fs.stat(partPathOf(uploadId))).isFile())
})

test('RECOVERY_IDEMPOTENT · เรียกซ้ำแล้วไม่มีอะไรเปลี่ยนอีก', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  await simulateCrashAfterPublish(uploadId)

  const first = await recoverStaleVaultCommits()
  assert.equal(first.reopened, 1)
  const [snapshot] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await recoverStaleVaultCommits(), { reopened: 0, committed: 0, aborted: 0, scanned: 0 },
      'รอบถัดไปต้องไม่เจออะไรให้ทำ')
  }
  const [after] = await rows('SELECT * FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(after.status, snapshot.status)
  assert.equal(after.commit_storage_key, snapshot.commit_storage_key)
})

test('RECOVERY_RACE_SAFE · worker สองตัวพร้อมกัน ให้ผลกู้คืนเพียงหนึ่งเดียว', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  await simulateCrashAfterPublish(uploadId)

  const [a, b] = await Promise.all([recoverStaleVaultCommits(), recoverStaleVaultCommits()])
  assert.equal(a.reopened + b.reopened, 1, 'แถวเดียวต้องถูกกู้ครั้งเดียว')
  assert.equal(a.scanned + b.scanned, 1, 'FOR UPDATE SKIP LOCKED ต้องทำให้มีผู้กู้รายเดียวเห็นแถวนี้')

  const [session] = await rows('SELECT status FROM vault_v2_upload_sessions WHERE upload_id = $1', [uploadId])
  assert.equal(session.status, 'open')
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs')).length, 0)
})

test('blob ที่ commit สำเร็จแล้วไม่ถูกงานกู้คืนหรืองานเก็บกวาดแตะ', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  const commit = await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })
  assert.equal(commit.status, 201)
  const [before] = await rows('SELECT * FROM vault_v2_blobs')

  assert.equal((await recoverStaleVaultCommits({ leaseMs: 60_000 })).scanned, 0)
  await sql.query(`UPDATE vault_v2_upload_sessions SET expires_at = now() - interval '1 day' WHERE upload_id = $1`,
    [uploadId])
  await cleanupAbandonedVaultUploads({ now: Date.now() })

  const [after] = await rows('SELECT * FROM vault_v2_blobs')
  assert.deepEqual(after, before, 'แถว blob ต้องไม่ถูกแตะ')
  assert.ok((await fs.stat(finalPathOf(after.storage_key))).isFile(), 'ciphertext ที่เผยแพร่แล้วต้องไม่ถูกลบ')
  assert.equal((await owner.raw(`/api/vault/blobs/${before.id}/chunks/0`)).status, 200)
})

test('งานเก็บกวาดลบ session ที่ถูกทิ้งและโฟลเดอร์พักกำพร้า โดยไม่แตะ vault/ เลย', { skip }, async () => {
  const owner = await login()
  const kek = await setupVault(owner)

  const committed = await uploadReadyToCommit(owner, kek)
  await owner.req(`/api/vault/uploads/${committed.uploadId}/commit`, { method: 'POST', body: {} })
  const abandoned = await uploadReadyToCommit(owner, kek)
  await sql.query(`UPDATE vault_v2_upload_sessions SET expires_at = now() - interval '1 day' WHERE upload_id = $1`,
    [abandoned.uploadId])

  // โฟลเดอร์พักที่ไม่มีแถวใดอ้างถึงเลย (ผลของโปรเซสที่ตายก่อนเขียนแถว)
  const orphanId = randomBytes(24).toString('hex')
  await fs.mkdir(path.join(STORAGE_ROOT, vaultStagingConfig.STAGING_DIR, orphanId), { recursive: true })

  const tally = await cleanupAbandonedVaultUploads({ now: Date.now() })
  assert.equal(tally.expired, 1)
  assert.equal(tally.orphans, 1)

  assert.equal((await rows('SELECT 1 FROM vault_v2_upload_sessions WHERE upload_id = $1', [abandoned.uploadId])).length, 0)
  await assert.rejects(fs.stat(partPathOf(abandoned.uploadId)))
  await assert.rejects(fs.stat(path.join(STORAGE_ROOT, vaultStagingConfig.STAGING_DIR, orphanId)))
  assert.equal((await fs.readdir(path.join(STORAGE_ROOT, 'vault'))).length, 1,
    'ciphertext ที่เผยแพร่แล้วต้องไม่ถูกงานเก็บกวาดแตะ')
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs')).length, 1)
})

// ═════════════════════════════════════════════════════════════════════════════
// การแยกเจ้าของที่ชั้น SQL — ไม่ใช่แค่ที่ชั้น route
// ═════════════════════════════════════════════════════════════════════════════
test('การกรองเจ้าของอยู่ในคำสั่ง SQL เอง — blob ของอีกคนไม่มีทางถูกคืนมา', { skip }, async () => {
  const owner = await login(OWNER)
  const kek = await setupVault(owner)
  const { uploadId } = await uploadReadyToCommit(owner, kek)
  const blob = (await owner.req(`/api/vault/uploads/${uploadId}/commit`, { method: 'POST', body: {} })).data.blob

  const other = await login(OTHER)
  await setupVault(other)
  assert.equal((await other.raw(`/api/vault/blobs/${blob.id}/chunks/0`)).status, 404)
  assert.equal((await other.req(`/api/vault/blobs/${blob.id}`, { method: 'DELETE' })).status, 404)
  assert.deepEqual((await other.req('/api/vault')).data.blobs, [], 'บัญชีรายการของอีกคนต้องว่าง')

  // แถวยังอยู่ครบ ไม่ได้ถูกลบโดยคำขอของคนอื่น
  assert.equal((await rows('SELECT 1 FROM vault_v2_blobs WHERE id = $1', [blob.id])).length, 1)
  const [ownerRow] = await rows('SELECT user_id FROM vault_v2_blobs WHERE id = $1', [blob.id])
  const [me] = await rows('SELECT id FROM users WHERE username = $1', [OWNER.username])
  assert.equal(String(ownerRow.user_id), String(me.id))
})
