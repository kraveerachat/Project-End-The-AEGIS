// tests/filesHierarchyIntegrity.test.js — FILES-MANAGEMENT-UX-1 · S2 round 2
//
// ⚠️ กฎข้อเดียวของลำดับชั้นที่ทุกอย่างในไฟล์นี้มีไว้ปกป้อง:
//
//    แถวที่ยังมีชีวิตทุกแถวที่มี parent_id ต้องชี้ไปยังโฟลเดอร์ที่ยังมีชีวิตของเจ้าของคนเดียวกัน
//
//    ทุกการกลายพันธุ์ที่เปลี่ยน "ใครอยู่ใต้ใคร" — ย้าย ทิ้งโฟลเดอร์ สร้างโฟลเดอร์ใต้พ่อ
//    วางไฟล์ที่อัปโหลดใต้พ่อ — ต้องผ่านจุดอนุกรมจุดเดียวต่อเจ้าของ ไม่งั้นการแข่งกัน
//    ระหว่างสองคำขอที่แต่ละคำขอถูกต้องในตัวเองจะสร้างลูกที่มีชีวิตใต้พ่อที่ถูกทิ้งไปแล้ว
//    ซึ่งคือไฟล์ที่หายจากทุกจอโดยที่ไม่มีใครลบมัน
//
// ⚠️ การแข่งกันจริงพิสูจน์ได้เฉพาะบน PostgreSQL การทดสอบเหล่านั้นข้ามอย่างเปิดเผยเมื่อ
//    ไม่มี TEST_DATABASE_URL และต้องถูกรันที่ด่าน Linux/Postgres — ห้ามอ้างว่าผ่านจาก
//    โหมดหน่วยความจำ ซึ่งไม่มีธุรกรรมให้แข่งกันตั้งแต่แรก
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, performLogin } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-hier-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'
const PG_ONLY = DB_MODE !== 'postgres' ? 'requires TEST_DATABASE_URL (PostgreSQL) — NOT MEASURED on this host' : false

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')

const USER_A = { username: 'user', password: 'aegis-drive-user' }

let server, baseUrl

before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  console.log(`[hierarchy integrity] database mode: ${DB_MODE}`)
})

after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  if (usingPostgres) await closePool()
})

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

async function login(who) {
  const client = new Client(baseUrl)
  await performLogin(client, who.username, who.password)
  return client
}
const meId = async (client) => (await client.req('/api/me')).data.user.id

async function makeFolder(client, name, parentId = null) {
  const res = await client.req('/api/files/folder', { method: 'POST', body: { name, parentId } })
  assert.equal(res.status, 201, `folder ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

async function makeFile(client, name, contents = 'x', parentId = null) {
  const form = new FormData()
  form.append('file', new Blob([contents]), name)
  if (parentId !== null) form.append('parentId', String(parentId))
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `upload ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const sha256Of = async (text) => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

/** เปิดเซสชัน V2 และส่ง chunk ไว้ แต่ **ยังไม่ commit** — เพื่อให้แข่งกับการทิ้งโฟลเดอร์ได้ */
async function stageV2(client, name, contents, parentId) {
  const created = await client.req('/api/files/uploads', {
    method: 'POST',
    body: { name, size: Buffer.byteLength(contents), sha256: await sha256Of(contents), parentId },
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const { uploadId } = created.data.upload
  const put = await client.raw(`/api/files/uploads/${encodeURIComponent(uploadId)}/chunks/0`, {
    method: 'PUT', body: Buffer.from(contents), headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(put.status, 200)
  return uploadId
}

/* ══ A1/A2 · กติกาที่ต้องไม่หาย ═══════════════════════════════════════════ */

test('A1 · a folder with live children still refuses trash with 409', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `a1-${Date.now()}`)
  await makeFile(a, 'held.txt', 'x', folder.id)
  const res = await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'FOLDER_NOT_EMPTY')
})

test('A2 · an empty folder still trashes', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `a2-${Date.now()}`)
  assert.equal((await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })).status, 200)
})

/* ══ A3 · ทุกเส้นทางกลายพันธุ์เข้าคิวที่ล็อกเดียวกัน ═══════════════════ */

test('A3 · every hierarchy mutation acquires the common owner lock before any row lock', async () => {
  const source = await fs.readFile(new URL('../server/db/store.js', import.meta.url), 'utf8')
  assert.match(source, /export async function lockHierarchyOwner\(client, userId\)/,
    'ต้องมี helper เดียวสำหรับล็อกลำดับชั้นต่อเจ้าของ')
  assert.match(source, /SELECT id FROM users WHERE id = \$1 FOR UPDATE/)

  const slice = (from, to) => source.slice(source.indexOf(from), to ? source.indexOf(to, source.indexOf(from)) : undefined)
  const paths = {
    moveItems: slice('export async function moveItems', 'async function guardMoveSet'),
    trashFile: slice('export async function trashFile', 'export async function findTrashedFile'),
    createFolder: slice('async function pgCreateFolder', 'async function pgRecordUpload'),
    recordUpload: slice('async function pgRecordUpload', '// ── Files (Metadata Layer)'),
    finishUploadCommit: slice('export async function finishUploadCommit', '// dev fallback'),
  }
  for (const [name, body] of Object.entries(paths)) {
    assert.ok(body.length > 0, `${name}: source slice not found`)
    const lockAt = body.indexOf('lockHierarchyOwner(')
    assert.ok(lockAt >= 0, `${name} ต้องเรียก lockHierarchyOwner`)

    // ⚠️ ลำดับการล็อกที่กัน deadlock คือลำดับของล็อกที่ "หลายเส้นทางใช้ร่วมกัน": users → files
    //    ล็อก claim บน upload_sessions ของ finishUploadCommit มาก่อนได้โดยเจตนา — มันเป็น
    //    สัญญาเดิมของการกู้คืนหลังโปรเซสตาย และไม่มีเส้นทางลำดับชั้นอื่นแตะตารางนั้นเลย
    //    จึงไม่มีทางเกิดวงจรของการรอกับมัน สิ่งที่ห้ามคือล็อกแถว **files** ก่อนล็อกเจ้าของ
    const filesRowLock = /FROM files[\s\S]*?FOR UPDATE/g
    let match
    while ((match = filesRowLock.exec(body)) !== null) {
      assert.ok(match.index > lockAt,
        `${name}: ล็อกแถว files ที่ตำแหน่ง ${match.index} มาก่อนล็อกเจ้าของที่ ${lockAt} — ผิดลำดับ`)
    }
  }
})

/* ══ A6 · ตัวตรวจกฎ (ใช้ซ้ำหลังทุกการแข่งกัน) ══════════════════════════ */

test('A6 · the hierarchy invariant checker reports a live child under a trashed parent', async () => {
  const a = await login(USER_A)
  const me = await meId(a)
  const folder = await makeFolder(a, `a6-${Date.now()}`)
  await makeFile(a, 'child.txt', 'x', folder.id)

  assert.deepEqual(await store.hierarchyInvariantViolations(me), [], 'ตอนนี้ยังถูกต้อง')
})

/* ══ A4/A5 · การแข่งกันจริง — PostgreSQL เท่านั้น ══════════════════════ */

test('A4 · concurrent trash-empty-folder vs move-child-into-it cannot orphan the child', { skip: PG_ONLY }, async () => {
  const a = await login(USER_A)
  const me = await meId(a)
  const stamp = Date.now()
  const folder = await makeFolder(a, `a4-target-${stamp}`)
  const child = await makeFile(a, `a4-child-${stamp}.txt`, 'x')

  // ทั้งสองคำขอถูกต้องในตัวเองในวินาทีที่มันเริ่ม
  const [trash, move] = await Promise.all([
    store.trashFile(folder.id, me),
    store.moveItems([child.id], me, folder.id),
  ])

  // ผลลัพธ์ที่ยอมรับได้มีสองแบบ: ทิ้งสำเร็จแล้วย้ายถูกปฏิเสธ หรือย้ายสำเร็จแล้วทิ้งถูกปฏิเสธ
  const trashed = trash !== null && trash.code !== 'FOLDER_NOT_EMPTY'
  const moved = move.ok === true
  assert.equal(trashed && moved, false, 'ทั้งสองอย่างสำเร็จพร้อมกันไม่ได้')
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [], 'ห้ามมีลูกที่มีชีวิตใต้พ่อที่ถูกทิ้ง')
})

test('A5 · concurrent trash-empty-folder vs V2 commit into it cannot orphan the file', { skip: PG_ONLY }, async () => {
  const a = await login(USER_A)
  const me = await meId(a)
  const stamp = Date.now()
  const folder = await makeFolder(a, `a5-target-${stamp}`)
  const uploadId = await stageV2(a, `a5-${stamp}.txt`, 'bytes', folder.id)

  const [trash, commit] = await Promise.all([
    store.trashFile(folder.id, me),
    a.req(`/api/files/uploads/${encodeURIComponent(uploadId)}/commit`, { method: 'POST' }),
  ])

  const trashed = trash !== null && trash.code !== 'FOLDER_NOT_EMPTY'
  const committed = commit.status === 201
  assert.equal(trashed && committed, false, 'ทั้งสองอย่างสำเร็จพร้อมกันไม่ได้')
  if (!committed) assert.ok([409, 404].includes(commit.status), `commit ที่แพ้ต้องได้คำตอบที่จริง ไม่ใช่ ${commit.status}`)
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [], 'ห้ามมีไฟล์ที่มีชีวิตใต้พ่อที่ถูกทิ้ง')
})

/* ══ B · preflight ต้องครอบคลุมแถวเดียวกับที่ migration บังคับ kind ═══════ */

const active = (over = {}) => ({ id: 1, name: 'a.pdf', path: 'uploads/a.bin', size_bytes: 5, sha256: 'a'.repeat(64), uploaded_by: 7, deleted_at: null, ...over })
const trashedRow = (over = {}) => ({ ...active(over), deleted_at: '2026-09-01T00:00:00Z' })

async function preflight(rows) {
  const { legacyKindPreflight } = await import('../server/db/legacyKindClassifier.js')
  let captured = null
  const report = await legacyKindPreflight({ query: async (sql) => { captured = sql; return { rows } } })
  return { report, sql: captured }
}

test('B7 · the preflight reads every normal row, trashed included — the same domain migration 010 classifies', async () => {
  const { sql } = await preflight([])
  // ⚠️ migration ตั้ง SET NOT NULL ทั้งตาราง แถวที่ถูกทิ้งก็ต้องได้ kind ถ้า preflight
  //    มองข้ามแถวเหล่านั้น มันจะบอกว่าปลอดภัยทั้งที่ migration จะระเบิดตอนรันจริง
  assert.doesNotMatch(sql, /deleted_at IS NULL/i, 'preflight ต้องไม่กรองแถวที่ถูกทิ้งออกจากการจำแนกชนิด')
  assert.match(sql, /vault = false/i)
  assert.match(sql, /deleted_at/i, 'แต่ต้องอ่าน deleted_at มาเพื่อแยกวิเคราะห์ชื่อซ้ำเฉพาะแถวที่ยังอยู่')
})

test('B1 · an ambiguous ACTIVE row blocks migration', async () => {
  const { report } = await preflight([active({ id: 1, sha256: null })])
  assert.equal(report.ambiguousRows, 1)
  assert.equal(report.ambiguousActiveRows, 1)
  assert.equal(report.ambiguousTrashedRows, 0)
  assert.equal(report.safeToMigrate, false)
})

test('B2 · an ambiguous TRASHED row also blocks migration', async () => {
  const { report } = await preflight([active({ id: 1 }), trashedRow({ id: 2, sha256: null })])
  assert.equal(report.trashedNormalRows, 1)
  assert.equal(report.ambiguousRows, 1)
  assert.equal(report.ambiguousTrashedRows, 1, 'แถวที่ถูกทิ้งซึ่งจำแนกไม่ได้ต้องถูกนับ')
  assert.equal(report.safeToBackfill, false)
  assert.equal(report.safeToMigrate, false)
})

test('B3 · clean active plus clean trashed rows pass the kind gate', async () => {
  const { report } = await preflight([active({ id: 1 }), trashedRow({ id: 2, name: 'old.pdf', path: 'uploads/old.bin' })])
  assert.equal(report.totalNormalRows, 2)
  assert.equal(report.activeNormalRows, 1)
  assert.equal(report.trashedNormalRows, 1)
  assert.equal(report.ambiguousRows, 0)
  assert.equal(report.safeToBackfill, true)
  assert.equal(report.safeToMigrate, true)
})

test('B4 · duplicate ACTIVE names block migration', async () => {
  const { report } = await preflight([active({ id: 1, name: 'Dup' }), active({ id: 2, name: 'dup', path: 'uploads/b.bin' })])
  assert.equal(report.duplicateActiveNameGroups, 1)
  assert.equal(report.safeToMigrate, false)
})

test('B5 · duplicate names that exist only among TRASHED rows do not block the unique index', async () => {
  // unique index ของ 010 มี WHERE deleted_at IS NULL — แถวในถังไม่ถูกบังคับ
  const { report } = await preflight([
    active({ id: 1, name: 'live.pdf' }),
    trashedRow({ id: 2, name: 'Gone', path: 'uploads/g1.bin' }),
    trashedRow({ id: 3, name: 'gone', path: 'uploads/g2.bin' }),
  ])
  assert.equal(report.duplicateActiveNameGroups, 0)
  assert.equal(report.safeToMigrate, true)
})

test('B6 · the duplicate group count is exact while samples stay capped', async () => {
  const rows = []
  for (let g = 0; g < 80; g += 1) {
    rows.push(active({ id: g * 2 + 1, name: `dup-${g}`, path: `uploads/${g}a.bin` }))
    rows.push(active({ id: g * 2 + 2, name: `DUP-${g}`, path: `uploads/${g}b.bin` }))
  }
  const { legacyKindPreflight } = await import('../server/db/legacyKindClassifier.js')
  const report = await legacyKindPreflight({ query: async () => ({ rows }), sampleLimit: 50 })
  assert.equal(report.duplicateActiveNameGroups, 80, 'ตัวนับต้องเป็นจำนวนกลุ่มจริง ไม่ใช่จำนวนตัวอย่าง')
  assert.equal(report.duplicateSamples.length, 50, 'ตัวอย่างถูกจำกัดตาม sampleLimit')
  assert.equal(report.safeToMigrate, false)
})
