// tests/vaultPostgres.test.js — AEGIS Drive (IDEA1) · Private Vault กับ Postgres จริง
//
// ชุดนี้ต่างจาก vaultApi.test.js ตรงที่ **ไม่เชื่อ store abstraction เลย** — หลังทำ
// round trip ผ่าน HTTP แล้ว จะเปิด connection ของตัวเองไปอ่านตารางด้วย SQL ดิบ
// เพราะสิ่งที่ต้องพิสูจน์คือ "ไบต์ที่นอนอยู่ใน Postgres จริง ๆ" ไม่ใช่สิ่งที่ชั้น
// abstraction เลือกจะคืนมาให้เราดู (ถ้า store มีบั๊กหรือกรองอะไรออก เทสต์ที่อ่าน
// ผ่าน store จะมองไม่เห็น)
//
// ข้าม (skip) ทั้งไฟล์เมื่อไม่ได้ตั้ง TEST_DATABASE_URL — นักพัฒนาที่ไม่มี Docker
// ยังรัน `npm test` ได้ตามปกติ
//
// ⚠️ ต้องรันแบบ serial (`--test-concurrency=1` ตั้งไว้ใน package.json แล้ว):
//    ไฟล์นี้กับ vaultApi.test.js ใช้ "ฐานข้อมูลเดียวกัน" และต่างก็ล้างตาราง vault
//    ใน beforeEach ถ้ารันขนานกัน node:test จะแยกเป็นคนละ process ที่เขียนทับ
//    state ของกันและกัน → เทสต์ล้มแบบสุ่มโดยที่โค้ดโปรดักชันไม่ได้ผิดอะไรเลย
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { performLogin } from './helpers/testClient.mjs'

const DB_URL = process.env.TEST_DATABASE_URL
const skip = DB_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อรันกับ Postgres จริง'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-vault-pg-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (DB_URL) process.env.DATABASE_URL = DB_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { closePool } = await import('../server/db/connection.js')
const {
  createVaultSetup, unlockVault, encryptFileEnvelope,
  decryptBlobMeta, decryptFileContent, b64ToBytes,
} = await import('../src/lib/vaultCrypto.js')

const FAST = { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 }

const PASSPHRASE = 'orchid-tungsten-ledger-41-vault'
const SECRET_FILENAME = 'merger-terms_SIGNED_2026.pdf'
const SECRET_CONTENT =
  'CONFIDENTIAL MERGER TERMS. Meridian Ltd acquired for 4,200,000 THB. Authorised: Veerachat Jinapariwataporn.'
const SECRETS = [
  PASSPHRASE, SECRET_FILENAME, SECRET_CONTENT,
  'merger-terms', 'SIGNED', 'Meridian', 'CONFIDENTIAL', 'Jinapariwataporn', '4,200,000', '.pdf',
]

let server, baseUrl, sql

before(async () => {
  if (!DB_URL) return
  await initStorage()
  await initVaultStorage()
  // connection แยกของเราเอง — ไม่ใช้ pool ของแอป เพื่อให้แน่ใจว่าอ่าน "ของจริงในตาราง"
  sql = new pg.Client({ connectionString: DB_URL })
  await sql.connect()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (!DB_URL) return
  await new Promise((r) => server.close(r))
  await sql.end()
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  if (!DB_URL) return
  // ⚠️ ลำดับสำคัญ: session ของ V2 อ้างถึงแถว blob ของ V2 (committed_blob_id)
  //    และบัญชีรายการที่ชุดนี้ตรวจคือ "ทั้งห้อง" คือทั้งสองรูปแบบรวมกัน (LFT-V2-B)
  await sql.query('DELETE FROM vault_v2_upload_chunks')
  await sql.query('DELETE FROM vault_v2_upload_sessions')
  await sql.query('DELETE FROM vault_v2_blob_chunks')
  await sql.query('DELETE FROM vault_v2_blobs')
  await sql.query('DELETE FROM vault_blobs')
  await sql.query('DELETE FROM vault_meta')
  const dir = path.join(STORAGE_ROOT, 'vault')
  for (const f of await fs.readdir(dir)) await fs.rm(path.join(dir, f), { force: true })
})

// ── client จำลอง ────────────────────────────────────────────────────────
class Client {
  constructor() { this.cookie = null; this.csrf = null }
  async req(pathname, { method = 'GET', body, raw = false } = {}) {
    const headers = {}
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf
    let payload
    if (body instanceof FormData) payload = body
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(baseUrl + pathname, { method, headers, body: payload })
    const sc = res.headers.getSetCookie?.() ?? []
    if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ')
    if (raw) return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
    let data = null
    try { data = await res.json() } catch { /* 204 */ }
    return { status: res.status, data }
  }
  // ผ่านด่าน force-reset ของบัญชี seed ให้เอง — ดู tests/helpers/testClient.mjs
  async login(u, p) {
    await performLogin(this, u, p)
  }
}

/** setup + upload หนึ่งไฟล์ → คืนของที่ต้องใช้ตรวจต่อ */
async function seedOneFile(content = SECRET_CONTENT, name = SECRET_FILENAME) {
  const c = new Client()
  await c.login('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  const s = await c.req('/api/vault/setup', {
    method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })
  assert.equal(s.status, 201)

  const bytes = new TextEncoder().encode(content)
  const env = await encryptFileEnvelope(setup.kek, { name, type: 'application/pdf', size: bytes.length, bytes })
  const form = new FormData()
  form.append('file', new Blob([env.ciphertext], { type: 'application/octet-stream' }), 'blob.aegisenc')
  form.append('ivB64', env.ivB64)
  form.append('wrappedDekB64', env.wrappedDekB64)
  form.append('wrapIvB64', env.wrapIvB64)
  form.append('metaIvB64', env.metaIvB64)
  form.append('metaB64', env.metaB64)
  const up = await c.req('/api/vault/blobs', { method: 'POST', body: form })
  assert.equal(up.status, 201)
  return { client: c, setup, blobId: up.data.blob.id, plainBytes: bytes, name }
}

// ══════════════════════════════════════════════════════════════════════
// 1. Round-trip integrity ผ่าน Postgres จริง
// ══════════════════════════════════════════════════════════════════════

test('round trip: upload → download → ถอดแล้วได้ไบต์เดิมเป๊ะทุกไบต์', { skip }, async () => {
  const { client, blobId, plainBytes } = await seedOneFile()

  // ปลดล็อกใหม่จาก state ที่เซิร์ฟเวอร์คืนมา (ไม่ใช้ kek ตัวเดิมช่วย)
  const meta = await client.req('/api/vault')
  const kek = await unlockVault(PASSPHRASE, {
    saltB64: meta.data.saltB64, params: meta.data.params, verifier: meta.data.verifier,
  })
  const blob = meta.data.blobs[0]

  const fileMeta = await decryptBlobMeta(kek, blob)
  assert.equal(fileMeta.name, SECRET_FILENAME)
  assert.equal(fileMeta.size, plainBytes.length)

  const dl = await client.req(`/api/vault/blobs/${blobId}`, { raw: true })
  assert.equal(dl.status, 200)
  const out = await decryptFileContent(kek, blob, dl.bytes)

  assert.equal(out.length, plainBytes.length, 'ความยาวต้องตรง')
  assert.deepEqual(out, plainBytes, 'ไบต์ต้องตรงทุกตำแหน่ง')
  assert.equal(new TextDecoder().decode(out), SECRET_CONTENT)
})

test('round trip: ไฟล์ไบนารีหลายขนาด รวมไฟล์ว่าง — ผ่าน Postgres จริงทุกขนาด', { skip }, async () => {
  const c = new Client()
  await c.login('user', 'aegis-drive-user')
  const setup = await createVaultSetup(PASSPHRASE, FAST)
  await c.req('/api/vault/setup', {
    method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier },
  })

  const sizes = [0, 1, 15, 16, 17, 4096, 100_000]
  for (const n of sizes) {
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, n)))

    const env = await encryptFileEnvelope(setup.kek, { name: `f${n}.bin`, size: n, bytes })
    const form = new FormData()
    form.append('file', new Blob([env.ciphertext]), 'blob.aegisenc')
    form.append('ivB64', env.ivB64)
    form.append('wrappedDekB64', env.wrappedDekB64)
    form.append('wrapIvB64', env.wrapIvB64)
    form.append('metaIvB64', env.metaIvB64)
    form.append('metaB64', env.metaB64)
    const up = await c.req('/api/vault/blobs', { method: 'POST', body: form })
    assert.equal(up.status, 201, `upload ${n} ไบต์ล้มเหลว`)

    const dl = await c.req(`/api/vault/blobs/${up.data.blob.id}`, { raw: true })
    const out = await decryptFileContent(setup.kek, up.data.blob, dl.bytes)
    assert.deepEqual(out, bytes, `round trip เพี้ยนที่ขนาด ${n}`)

    // ขนาดที่ Postgres บันทึกต้องเป็นขนาด ciphertext จริง (plaintext + GCM tag 16)
    const { rows } = await sql.query('SELECT size_bytes FROM vault_blobs WHERE id = $1', [up.data.blob.id])
    assert.equal(Number(rows[0].size_bytes), n + 16, `size_bytes ผิดที่ขนาด ${n}`)
  }
})

// ══════════════════════════════════════════════════════════════════════
// 2. ตรวจแถวจริงใน Postgres ด้วย SQL ดิบ
// ══════════════════════════════════════════════════════════════════════

test('โครงตาราง: ไม่มีคอลัมน์ name / mime / type / key อยู่เลยตั้งแต่แรก', { skip }, async () => {
  const { rows } = await sql.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('vault_meta','vault_blobs')`,
  )
  assert.ok(rows.length > 0, 'ต้องเจอตาราง vault ใน Postgres')

  // ห้ามมีคอลัมน์ที่ "รับ plaintext ได้" อยู่ในโครงสร้างเลย — กันไว้ที่ระดับ schema
  // ไม่ใช่แค่ระดับ "ตอนนี้ยังไม่มีใครเขียนลงไป"
  const forbidden = /^(name|filename|file_name|mime|mime_type|content_type|type|ext|plaintext|content|passphrase|password|kek|dek|key|secret)$/i
  for (const r of rows) {
    assert.equal(
      forbidden.test(r.column_name), false,
      `${r.table_name} มีคอลัมน์ต้องห้าม "${r.column_name}"`,
    )
  }

  const cols = (t) => rows.filter((r) => r.table_name === t).map((r) => r.column_name).sort()
  assert.deepEqual(cols('vault_blobs'), [
    'created_at', 'id', 'iv_b64', 'meta_b64', 'meta_iv_b64',
    'size_bytes', 'storage_key', 'user_id', 'wrap_iv_b64', 'wrapped_dek_b64',
  ])
  assert.deepEqual(cols('vault_meta'), [
    'created_at', 'iterations', 'kdf', 'memory_kib',
    'parallelism', 'salt_b64', 'user_id', 'verifier_data', 'verifier_iv',
  ])
})

test('เนื้อแถวจริง: ทุกคอลัมน์ข้อความไม่มีความลับปนแม้แต่ชิ้นเดียว', { skip }, async () => {
  const { plainBytes } = await seedOneFile()

  // ดึง "ทั้งแถว" ออกมาเป็น JSON แล้วค้นหา — ครอบคลุมทุกคอลัมน์โดยไม่ต้องไล่ชื่อเอง
  const blobRows = (await sql.query('SELECT to_jsonb(t) AS j FROM vault_blobs t')).rows.map((r) => r.j)
  const metaRows = (await sql.query('SELECT to_jsonb(t) AS j FROM vault_meta t')).rows.map((r) => r.j)
  assert.equal(blobRows.length, 1)
  assert.equal(metaRows.length, 1)

  const dump = JSON.stringify({ blobRows, metaRows })
  for (const s of SECRETS) {
    assert.equal(dump.includes(s), false, `พบ "${s}" ในแถวจริงของ Postgres`)
  }

  // ตรวจเชิงบวก: คอลัมน์ที่ควรเป็น ciphertext ต้องเป็น base64 ล้วนจริง ๆ
  const b = blobRows[0]
  for (const col of ['iv_b64', 'wrapped_dek_b64', 'wrap_iv_b64', 'meta_iv_b64', 'meta_b64']) {
    assert.match(b[col], /^[A-Za-z0-9+/]+={0,2}$/, `${col} ไม่ใช่ base64`)
  }
  // storage_key เป็น UUID ทึบ ไม่มีเศษของชื่อไฟล์จริง
  assert.match(b.storage_key, /^vault\/[0-9a-f-]{36}\.aegisenc$/)
  // ขนาดที่เก็บคือขนาด ciphertext ไม่ใช่ขนาด plaintext (ขนาดจริงอยู่ใน meta_b64 ที่เข้ารหัส)
  assert.equal(Number(b.size_bytes), plainBytes.length + 16)

  // vault_meta: salt/verifier เป็น base64, พารามิเตอร์ KDF เป็นค่าที่ส่งมาเป๊ะ
  const m = metaRows[0]
  assert.equal(m.kdf, 'argon2id')
  assert.equal(m.memory_kib, FAST.memorySizeKiB)
  assert.equal(m.iterations, FAST.iterations)
  assert.equal(m.parallelism, FAST.parallelism)
  assert.match(m.salt_b64, /^[A-Za-z0-9+/]+={0,2}$/)
})

test('กุญแจในฐานข้อมูล "ใช้เปิดไฟล์ไม่ได้" — wrapped DEK ไม่ใช่ DEK', { skip }, async () => {
  const { blobId } = await seedOneFile()

  const { rows } = await sql.query(
    'SELECT storage_key, iv_b64, wrapped_dek_b64, wrap_iv_b64 FROM vault_blobs WHERE id = $1', [blobId],
  )
  const row = rows[0]

  // ciphertext จริงจากดิสก์ (สิ่งที่ผู้บุกรุกที่ยึดเซิร์ฟเวอร์ได้จะมีในมือ)
  const ct = await fs.readFile(path.join(STORAGE_ROOT, row.storage_key))

  const wrapped = b64ToBytes(row.wrapped_dek_b64)
  assert.equal(wrapped.length, 48, 'wrapped DEK = 32 ไบต์ DEK + 16 ไบต์ GCM tag')

  // สมมติผู้บุกรุกได้ "ทุกอย่างที่อยู่ในเซิร์ฟเวอร์" แล้วลองใช้ค่าในคอลัมน์กุญแจตรง ๆ
  // ทุกวิธีที่สมเหตุสมผลต้องล้มเหลว เพราะ KEK ไม่เคยเดินทางมาถึงเครื่องนี้
  const attempts = [
    wrapped.slice(0, 32),   // 32 ไบต์แรกของ wrapped DEK
    wrapped.slice(16, 48),  // 32 ไบต์ท้าย
  ]
  for (const [i, raw] of attempts.entries()) {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    await assert.rejects(
      () => crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(row.iv_b64) }, key, ct),
      `ความพยายามที่ ${i} ถอดไฟล์สำเร็จ — แปลว่ากุญแจใช้งานได้จริงอยู่ในฐานข้อมูล`,
    )
  }
})

test('ทุกแถวในทุกตารางของ aegis_drive ไม่มีความลับของ vault ปนเลย', { skip }, async () => {
  await seedOneFile()

  // ไล่ทุกคอลัมน์ชนิดข้อความของ "ทุกตาราง" ในฐาน ไม่ใช่แค่ตาราง vault —
  // เผื่อมีโค้ดที่เผลอเขียนความลับลงตารางอื่น (เช่น audit_log, files)
  const { rows: cols } = await sql.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND data_type IN ('text','character varying','character')
      ORDER BY table_name, column_name`,
  )

  let scanned = 0
  for (const { table_name, column_name } of cols) {
    const { rows } = await sql.query(
      `SELECT DISTINCT "${column_name}" AS v FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`,
    )
    for (const r of rows) {
      scanned++
      for (const s of SECRETS) {
        assert.equal(
          String(r.v).includes(s), false,
          `พบ "${s}" ใน ${table_name}.${column_name}`,
        )
      }
    }
  }
  assert.ok(scanned > 0, 'ต้องได้สแกนค่าจริงบ้าง ไม่ใช่ผ่านเพราะไม่มีข้อมูล')
  console.log(`    [scan] ตรวจค่าข้อความ ${scanned} ค่า จาก ${cols.length} คอลัมน์ — ไม่พบความลับ`)
})

test('audit_log ใน Postgres: target_hash เป็น sha256 เสมอ ไม่ใช่ค่าดิบ', { skip }, async () => {
  const { client, blobId } = await seedOneFile()
  await client.req(`/api/vault/blobs/${blobId}`, { raw: true })
  await client.req('/api/vault/unlock-attempt', { method: 'POST', body: { ok: true } })

  const { rows } = await sql.query(
    `SELECT action, result, target_hash, actor_label FROM audit_log
      WHERE action LIKE 'VAULT%' ORDER BY at DESC`,
  )
  assert.ok(rows.length >= 3, `คาดว่ามี audit ของ vault อย่างน้อย 3 แถว ได้ ${rows.length}`)

  for (const r of rows) {
    if (r.target_hash !== null) assert.match(r.target_hash, /^[0-9a-f]{64}$/)
    for (const s of SECRETS) {
      assert.equal(JSON.stringify(r).includes(s), false, `audit_log มี "${s}"`)
    }
  }
  const actions = rows.map((r) => r.action)
  for (const a of ['VAULT_SETUP', 'VAULT_BLOB_ADD', 'VAULT_BLOB_READ', 'VAULT_UNLOCK']) {
    assert.ok(actions.includes(a), `audit_log ขาด ${a}`)
  }
})

test('ลบ blob: แถวหายจาก Postgres และไฟล์หายจากดิสก์พร้อมกัน', { skip }, async () => {
  const { client, blobId } = await seedOneFile()
  const before = await sql.query('SELECT storage_key FROM vault_blobs WHERE id = $1', [blobId])
  const key = before.rows[0].storage_key
  assert.ok(await fs.stat(path.join(STORAGE_ROOT, key)).then(() => true).catch(() => false))

  const del = await client.req(`/api/vault/blobs/${blobId}`, { method: 'DELETE' })
  assert.equal(del.status, 204)

  const after = await sql.query('SELECT 1 FROM vault_blobs WHERE id = $1', [blobId])
  assert.equal(after.rowCount, 0, 'แถวต้องหายจาก Postgres')
  const exists = await fs.stat(path.join(STORAGE_ROOT, key)).then(() => true).catch(() => false)
  assert.equal(exists, false, 'ไฟล์ .aegisenc ต้องถูกลบจากดิสก์ด้วย ไม่เหลือกำพร้า')
})

test('FK cascade: ลบผู้ใช้ → vault ของเขาหายตามทั้ง meta และ blobs', { skip }, async () => {
  await seedOneFile()
  const uid = (await sql.query(`SELECT id FROM users WHERE username='user'`)).rows[0].id

  assert.equal((await sql.query('SELECT 1 FROM vault_meta WHERE user_id=$1', [uid])).rowCount, 1)

  // ลบด้วย superuser path ปกติ (ON DELETE CASCADE ต้องทำงานจริง ไม่ใช่แค่ประกาศไว้)
  await sql.query('DELETE FROM users WHERE id=$1', [uid])
  assert.equal((await sql.query('SELECT 1 FROM vault_meta WHERE user_id=$1', [uid])).rowCount, 0)
  assert.equal((await sql.query('SELECT 1 FROM vault_blobs WHERE user_id=$1', [uid])).rowCount, 0)

  // คืนสภาพให้เคสอื่น (ไฟล์นี้รันเรียงตามลำดับ)
  // ⚠️ must_reset_password = TRUE ต้องตรงกับ seed.sql เป๊ะ ๆ — hash ก้อนนี้อยู่ใน git
  //    การคืนสภาพด้วยค่า default (FALSE) จะทิ้งบัญชีที่ใช้รหัสสาธารณะได้โดยไม่มีด่าน
  //    ไว้ในฐานข้อมูลหลังเทสต์จบ = ชุดทดสอบเป็นคนเปิดช่องโหว่ที่ตัวมันเองควรกันไว้
  //    (tests/accessUsers.test.js จับกรณีนี้ได้จริงตอนรันชุดเต็มรอบที่สอง)
  await sql.query(
    `INSERT INTO users (id, username, password_hash, role, display_name, must_reset_password) VALUES
     ($1,'user','$2a$10$KvFvKFdx6OnPCjxIlwYXiOw0i0mmdmwcO1rNgHvqwtxuOgZfsVj1i','DataLake-User','Kanya Srisuwan',TRUE)`,
    [uid],
  )
})
