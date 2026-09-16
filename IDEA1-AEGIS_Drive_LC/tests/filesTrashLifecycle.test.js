// tests/filesTrashLifecycle.test.js — FILES-MANAGEMENT-UX-1 · S2 round 3
//
// ⚠️ Protected Trash เกิดก่อนที่ระบบจะมีลำดับชั้นจริง ตอนนี้แถวในถังยังถือ parent_id
//    และ FK ON DELETE RESTRICT ไว้ สามสิ่งจึงต้องเปลี่ยน:
//
//    1. **กู้คืน** = การกลายพันธุ์ของลำดับชั้น ต้องเข้าคิวเดียวกับ ย้าย/ทิ้ง/วางไฟล์
//       และต้องยืนยันว่าพ่อเดิม "ยังมีชีวิต" ก่อนคืนลูกกลับมา ไม่งั้นจะได้ลูกที่มีชีวิต
//       ใต้พ่อที่อยู่ในถัง = ไฟล์ที่กู้แล้วแต่ไม่มีใครมองเห็นจากหน้า Files
//       ห้ามแอบย้ายไปราก ห้ามล้าง parent_id — ปฏิเสธตรง ๆ ให้กู้พ่อก่อน
//
//    2. **ลบถาวร** ต้องเคารพ FK: พ่อที่ยังมีลูกอ้างถึงอยู่ (แม้ลูกจะอยู่ในถัง) ลบไม่ได้
//       ต้องปฏิเสธด้วยรหัสที่อ่านรู้เรื่อง ไม่ใช่ 23503 ที่รั่วออกมาเป็น 500
//       และ "ล้างถัง" ต้องลบลูกก่อนพ่อเสมอ ไม่ใช่พึ่งลำดับเวลาที่บังเอิญถูก
//
//    3. **preflight** ต้องตรงกับ unique index จริง: PostgreSQL ถือว่า NULL ไม่เท่ากับ
//       NULL ใน UNIQUE แถวไร้เจ้าของสองแถวชื่อเดียวกันจึง "ไม่ชนกัน" ในสายตาของ index
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, currentPasswordOf, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-trashlife-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-trashlife-secret'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'
const PG_ONLY = DB_MODE !== 'postgres' ? 'requires TEST_DATABASE_URL (PostgreSQL) — NOT MEASURED on this host' : false

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')
const { runTrashAutoPurge } = await import('../server/storage/trashCleanup.js')

let server, baseUrl, seq = 0
const stamp = () => `${Date.now()}-${seq++}`

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  console.log(`[trash lifecycle] database mode: ${DB_MODE}`)
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  if (usingPostgres) {
    await query(`DELETE FROM files WHERE name LIKE 'tl-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

const login = () => loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
const meId = async (c) => (await c.req('/api/me')).data.user.id
const pw = () => currentPasswordOf(DEMO_USER.username)

async function folder(c, name, parentId = null) {
  const r = await c.req('/api/files/folder', { method: 'POST', body: { name, parentId } })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  return r.data.file
}
async function file(c, name, parentId = null, content = 'x') {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  if (parentId !== null) form.append('parentId', String(parentId))
  const r = await c.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  return r.data.file
}
const trash = async (c, id) => c.req(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
const unlock = (c) => c.req('/api/trash/unlock', { method: 'POST', body: { password: pw() } })
const restore = (c, id, name) => c.req(`/api/trash/${encodeURIComponent(id)}/restore`, { method: 'POST', body: name ? { name } : {} })
const purge = (c, id) => c.req(`/api/trash/${encodeURIComponent(id)}`, { method: 'DELETE', body: { password: pw() } })
const emptyTrash = (c) => c.req('/api/trash/empty', { method: 'POST', body: { password: pw(), confirmation: 'DELETE' } })
const listAt = async (c, parentId = null) => (await c.req(parentId === null ? '/api/files' : `/api/files?parentId=${encodeURIComponent(parentId)}`)).data.files

/* ══ DEFECT A · กู้คืนต้องเคารพลำดับชั้น ═════════════════════════════════ */

test('T1 · restoring a child before its trashed parent is refused, and nothing is orphaned', async () => {
  const c = await login()
  const me = await meId(c)
  const parent = await folder(c, `tl-t1-parent-${stamp()}`)
  const child = await file(c, `tl-t1-child-${stamp()}.txt`, parent.id)

  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200, 'พ่อว่างแล้ว ทิ้งได้')
  assert.equal((await unlock(c)).status, 200)

  const r = await restore(c, child.id)
  assert.equal(r.status, 409, JSON.stringify(r.data))
  assert.equal(r.data.code, 'PARENT_NOT_AVAILABLE')

  // ⚠️ ห้ามแอบย้ายไปราก ห้ามล้าง parent_id — ลูกต้องยังอยู่ในถังตามเดิมทุกประการ
  const still = await store.findTrashedFile(child.id, me)
  assert.ok(still, 'ลูกยังอยู่ในถัง')
  assert.equal(String(still.parentId), String(parent.id), 'parent_id ต้องไม่ถูกแตะ')
  assert.equal((await listAt(c)).some((f) => String(f.id) === String(child.id)), false, 'ต้องไม่โผล่ที่ราก')
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

test('T2 · restoring the parent first, then the child, rebuilds the original hierarchy', async () => {
  const c = await login()
  const me = await meId(c)
  const parent = await folder(c, `tl-t2-parent-${stamp()}`)
  const child = await file(c, `tl-t2-child-${stamp()}.txt`, parent.id)

  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200)
  assert.equal((await unlock(c)).status, 200)

  assert.equal((await restore(c, parent.id)).status, 200)
  const r = await restore(c, child.id)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(String(r.data.file.parentId), String(parent.id), 'ลูกกลับไปอยู่ใต้พ่อเดิม')
  assert.equal((await listAt(c, parent.id)).some((f) => String(f.id) === String(child.id)), true)
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

test('T3 · restore checks name collisions in the ORIGINAL parent, not at root', async () => {
  const c = await login()
  const s = stamp()
  const parent = await folder(c, `tl-t3-parent-${s}`)
  const name = `tl-t3-report-${s}.pdf`

  // ไฟล์ชื่อเดียวกันที่ราก — ต้องไม่ถูกนับว่าชนกับไฟล์ในโฟลเดอร์
  await file(c, name, null, 'root copy')
  const inFolder = await file(c, name, parent.id, 'folder copy')
  assert.equal((await trash(c, inFolder.id)).status, 200)
  assert.equal((await unlock(c)).status, 200)

  const ok = await restore(c, inFolder.id)
  assert.equal(ok.status, 200, `คนละโฟลเดอร์ต้องไม่ชนกัน: ${JSON.stringify(ok.data)}`)
  assert.equal(String(ok.data.file.parentId), String(parent.id))

  // ส่วนชื่อซ้ำ "ในโฟลเดอร์เดียวกัน" ต้องชน และชื่อที่แนะนำต้องว่างในโฟลเดอร์นั้น
  const dup = await file(c, `tl-t3-dup-${s}.txt`, parent.id, 'v1')
  assert.equal((await trash(c, dup.id)).status, 200)
  await file(c, `tl-t3-dup-${s}.txt`, parent.id, 'replacement')
  const conflict = await restore(c, dup.id)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.data.code, 'NAME_CONFLICT')
  assert.match(conflict.data.suggestedName, /restored/)
  const renamed = await restore(c, dup.id, conflict.data.suggestedName)
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data))
  assert.equal(String(renamed.data.file.parentId), String(parent.id), 'ชื่อที่แนะนำต้องคืนไปที่โฟลเดอร์เดิม')
})

test('T4 · concurrent restore-child vs trash-parent cannot orphan the child', { skip: PG_ONLY }, async () => {
  const c = await login()
  const me = await meId(c)
  const parent = await folder(c, `tl-t4-parent-${stamp()}`)
  const child = await file(c, `tl-t4-child-${stamp()}.txt`, parent.id)
  assert.equal((await trash(c, child.id)).status, 200)

  // ทั้งสองอย่างถูกต้องในตัวเองในวินาทีที่มันเริ่ม: พ่อว่าง (ลูกอยู่ในถัง) และลูกกู้ได้ (พ่อยังอยู่)
  const [t, r] = await Promise.all([
    store.trashFile(parent.id, me),
    store.restoreTrashedFile(child.id, me),
  ])
  const trashed = t !== null && t.code !== 'FOLDER_NOT_EMPTY'
  const restored = Boolean(r?.file)
  assert.equal(trashed && restored, false, 'ทั้งสองอย่างสำเร็จพร้อมกันไม่ได้')
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

/* ══ DEFECT B · ลบถาวรต้องเคารพ FK ══════════════════════════════════════ */

test('T5 · permanently purging a parent that still has a trashed child is refused, not a 500', async () => {
  const c = await login()
  const me = await meId(c)
  const parent = await folder(c, `tl-t5-parent-${stamp()}`)
  const child = await file(c, `tl-t5-child-${stamp()}.txt`, parent.id)
  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200)
  assert.equal((await unlock(c)).status, 200)

  const r = await purge(c, parent.id)
  assert.equal(r.status, 409, JSON.stringify(r.data))
  assert.equal(r.data.code, 'FOLDER_HAS_CHILDREN')
  assert.ok(await store.findTrashedFile(parent.id, me), 'พ่อยังอยู่ในถัง')
  assert.ok(await store.findTrashedFile(child.id, me), 'ลูกยังอยู่ในถัง')
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

test('T6 · purging the child first, then the parent, succeeds', async () => {
  const c = await login()
  const parent = await folder(c, `tl-t6-parent-${stamp()}`)
  const child = await file(c, `tl-t6-child-${stamp()}.txt`, parent.id)
  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200)
  assert.equal((await unlock(c)).status, 200)

  assert.equal((await purge(c, child.id)).status, 200)
  assert.equal((await purge(c, parent.id)).status, 200, 'ลูกหายแล้ว พ่อลบได้')
})

test('T7 · Empty Trash removes a nested tree descendants-first and finishes', async () => {
  const c = await login()
  const me = await meId(c)
  const s = stamp()
  const parent = await folder(c, `tl-t7-parent-${s}`)
  const child = await folder(c, `tl-t7-child-${s}`, parent.id)
  const leaf = await file(c, `tl-t7-leaf-${s}.txt`, child.id)

  assert.equal((await trash(c, leaf.id)).status, 200)
  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200)

  const r = await emptyTrash(c)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.ok(r.data.deletedCount >= 3, `ต้องลบครบทั้งต้นไม้ ได้ ${r.data.deletedCount}`)
  assert.equal(r.data.blockedCount ?? 0, 0, 'ต้องไม่มีอะไรค้าง')
  for (const id of [leaf.id, child.id, parent.id]) {
    assert.equal(await store.findTrashedFile(id, me, { includeExpired: true }), null, `${id} ต้องหายไปจริง`)
  }
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

test('T8 · auto-purge skips a blocked parent without abandoning the rest of the batch', async () => {
  const c = await login()
  const me = await meId(c)
  const s = stamp()
  const parent = await folder(c, `tl-t8-parent-${s}`)
  const child = await file(c, `tl-t8-child-${s}.txt`, parent.id)
  const loner = await file(c, `tl-t8-loner-${s}.txt`)
  assert.equal((await trash(c, child.id)).status, 200)
  assert.equal((await trash(c, parent.id)).status, 200)
  assert.equal((await trash(c, loner.id)).status, 200)

  // ให้ "เฉพาะพ่อกับไฟล์เดี่ยว" หมดอายุ — ลูกยังไม่หมดอายุ พ่อจึงยังลบไม่ได้
  const past = Date.now() - 1000
  assert.equal(await store.setTrashPurgeAtForTest(parent.id, past), true)
  assert.equal(await store.setTrashPurgeAtForTest(loner.id, past), true)

  const result = await runTrashAutoPurge({ limit: 25 })
  assert.equal(await store.findTrashedFile(loner.id, me, { includeExpired: true }), null, 'ไฟล์เดี่ยวที่ไม่เกี่ยวกันต้องถูกลบ')
  assert.ok(await store.findTrashedFile(parent.id, me, { includeExpired: true }), 'พ่อที่ยังมีลูกต้องถูกข้าม ไม่ใช่ทำทั้งชุดล้ม')
  assert.ok(await store.findTrashedFile(child.id, me, { includeExpired: true }), 'ลูกที่ยังไม่หมดอายุต้องไม่ถูกแตะ')
  assert.ok(result.purged >= 1)
  assert.deepEqual(await store.hierarchyInvariantViolations(me), [])
})

/* ══ DEFECT C · preflight ต้องตรงกับ unique index จริง ═══════════════════ */

const row = (over = {}) => ({ id: 1, name: 'a.pdf', path: 'uploads/a.bin', size_bytes: 5, sha256: 'a'.repeat(64), uploaded_by: 7, deleted_at: null, ...over })
async function preflight(rows) {
  const { legacyKindPreflight } = await import('../server/db/legacyKindClassifier.js')
  return legacyKindPreflight({ query: async () => ({ rows }) })
}

test('P1 · same-name active rows with the same non-null owner are a duplicate blocker', async () => {
  const r = await preflight([row({ id: 1, name: 'Dup' }), row({ id: 2, name: 'dup', path: 'uploads/b.bin' })])
  assert.equal(r.duplicateActiveNameGroups, 1)
  assert.equal(r.safeToMigrate, false)
})

test('P2 · same-name active rows with different owners are not duplicates', async () => {
  const r = await preflight([row({ id: 1 }), row({ id: 2, uploaded_by: 8, path: 'uploads/b.bin' })])
  assert.equal(r.duplicateActiveNameGroups, 0)
  assert.equal(r.safeToMigrate, true)
})

test('P3 · same-name rows with a NULL owner match the unique index, which treats NULLs as distinct', async () => {
  // ⚠️ uploaded_by เป็น ON DELETE SET NULL — เจ้าของถูกลบบัญชีแล้วแถวยังอยู่
  //    unique index (uploaded_by, COALESCE(parent_id,0), lower(name)) ไม่เคยเห็นสองแถวนี้
  //    ว่าเท่ากัน เพราะ NULL ≠ NULL การนับมันเป็นตัวบล็อกคือการปฏิเสธ migration ที่จะผ่านจริง
  const r = await preflight([
    row({ id: 1, name: 'orphan.pdf', uploaded_by: null }),
    row({ id: 2, name: 'orphan.pdf', uploaded_by: null, path: 'uploads/b.bin' }),
  ])
  assert.equal(r.duplicateActiveNameGroups, 0, 'แถวไร้เจ้าของไม่ชนกันในสายตาของ index')
  assert.equal(r.ownerlessActiveRows, 2, 'แต่ต้องรายงานให้ผู้ดูแลเห็น')
  assert.equal(r.safeToMigrate, true)
})

test('P4 · kind ambiguity on a NULL-owner row still blocks the kind migration', async () => {
  const r = await preflight([row({ id: 1, uploaded_by: null, sha256: null })])
  assert.equal(r.ambiguousRows, 1)
  assert.equal(r.safeToBackfill, false)
  assert.equal(r.safeToMigrate, false)
})
