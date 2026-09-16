// tests/filesRenameMove.test.js — FILES-MANAGEMENT-UX-1 · Phases 4–7
//
// ยิงผ่าน Express app ตัวเดียวกับ production (server/app.js) — middleware ครบทุกชั้น
// ชุดเดียวกันต้องผ่านทั้งโหมดหน่วยความจำและโหมด Postgres จริง
//
// ⚠️ สามสัญญาที่ห้ามแตกไม่ว่าจะปรับอะไรทีหลัง:
//    1. **ตัวตนคงที่** — rename/move เปลี่ยนได้แค่ป้ายชื่อกับตำแหน่งเชิงตรรกะ
//       id / kind / sha256 / storage key / เวอร์ชัน / ลิงก์แชร์ ต้องเหมือนเดิมเป๊ะ
//    2. **ห้ามคัดลอกไบต์** — ไฟล์ 2 GB ต้องเปลี่ยนชื่อและย้ายเสร็จในเวลาคงที่
//       storage key เป็น UUID ทึบอยู่แล้ว การย้ายไบต์จึงไม่มีเหตุผลใดรองรับ
//    3. **ย้ายเป็นกลุ่ม = ทำทั้งหมดหรือไม่ทำเลย** — ย้ายสำเร็จ 5 จาก 6 แล้วค้าง
//       คือสถานะที่ผู้ใช้กู้คืนเองไม่ได้ และเป็นไปไม่ได้ที่จะอธิบายบนหน้าจอ
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, performLogin } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-filesmgmt-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')

const USER_A = { username: 'user', password: 'aegis-drive-user' }
const USER_B = { username: 'admin', password: 'aegis-drive-admin' }

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

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

async function login(who) {
  const client = new Client(baseUrl)
  await performLogin(client, who.username, who.password)
  return client
}

async function makeFolder(client, name, parentId = null) {
  const res = await client.req('/api/files/folder', { method: 'POST', body: { name, parentId } })
  assert.equal(res.status, 201, `create folder ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

/** อัปโหลดไฟล์จริงผ่านเส้นทาง V1 — ได้แถว metadata + ไบต์บนดิสก์จริง */
async function makeFile(client, name, contents = 'payload', parentId = null) {
  const form = new FormData()
  form.append('file', new Blob([contents]), name)
  if (parentId !== null) form.append('parentId', String(parentId))
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `upload ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const listAt = async (client, parentId = null) => {
  const q = parentId === null ? '/api/files' : `/api/files?parentId=${encodeURIComponent(parentId)}`
  const res = await client.req(q)
  assert.equal(res.status, 200)
  return res.data.files
}

const findById = async (client, id, parentId = null) =>
  (await listAt(client, parentId)).find((f) => String(f.id) === String(id)) ?? null

/* ══ Phase 4 · การมองเห็นตามลำดับชั้นจริง ════════════════════════════════ */

test('NAV 1 · the root listing shows root items and hides items inside folders', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `nav-root-${Date.now()}`)
  const child = await makeFile(a, 'inside.txt', 'x', folder.id)
  const rootFile = await makeFile(a, 'at-root.txt', 'y')

  const root = await listAt(a)
  const ids = root.map((f) => String(f.id))
  assert.ok(ids.includes(String(folder.id)), 'โฟลเดอร์อยู่ที่ราก')
  assert.ok(ids.includes(String(rootFile.id)), 'ไฟล์ที่ราก')
  assert.equal(ids.includes(String(child.id)), false, 'ไฟล์ในโฟลเดอร์ต้องไม่โผล่ที่ราก')
})

test('NAV 2 · a folder listing shows exactly its own children', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `nav-child-${Date.now()}`)
  const child = await makeFile(a, 'inside.txt', 'x', folder.id)
  await makeFile(a, 'elsewhere.txt', 'y')

  const inside = await listAt(a, folder.id)
  assert.deepEqual(inside.map((f) => String(f.id)), [String(child.id)])
})

test('NAV 3 · another user folder cannot be listed and does not leak its existence', async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const folder = await makeFolder(a, `nav-private-${Date.now()}`)

  const res = await b.req(`/api/files?parentId=${encodeURIComponent(folder.id)}`)
  assert.equal(res.status, 404, 'ของผู้อื่นต้องตอบ 404 เหมือนไม่มีอยู่ ไม่ใช่ 403')
})

test('NAV 4 · a parentId that is a file, or does not exist, is refused', async () => {
  const a = await login(USER_A)
  const file = await makeFile(a, 'not-a-folder.txt', 'x')

  assert.equal((await a.req(`/api/files?parentId=${encodeURIComponent(file.id)}`)).status, 404)
  assert.equal((await a.req('/api/files?parentId=99999999')).status, 404)
  assert.equal((await a.req('/api/files?parentId=not-an-id')).status, 404)
})

test('NAV 5 · ancestors are reported so the breadcrumb is real, not a display fiction', async () => {
  const a = await login(USER_A)
  const outer = await makeFolder(a, `nav-outer-${Date.now()}`)
  const inner = await makeFolder(a, 'inner', outer.id)

  const res = await a.req(`/api/files?parentId=${encodeURIComponent(inner.id)}`)
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.data.ancestors), 'ต้องคืนบรรพบุรุษจริงของโฟลเดอร์นี้')
  assert.deepEqual(res.data.ancestors.map((f) => String(f.id)), [String(outer.id), String(inner.id)])
})

/* ══ Phase 3 · นามสกุลไม่ใช่ตัวตนอีกต่อไป ═══════════════════════════════ */

test('KIND · an extensionless upload is a File and a dotted folder is a Folder', async () => {
  const a = await login(USER_A)
  const readme = await makeFile(a, 'README', 'hello')
  const dotted = await makeFolder(a, `Invoices.2026-${Date.now()}`)

  assert.equal(readme.kind, 'file')
  assert.equal(readme.type, 'File', 'ชื่อไม่มีจุดต้องไม่ทำให้ไฟล์กลายเป็นโฟลเดอร์')
  assert.equal(dotted.kind, 'folder')
  assert.equal(dotted.type, 'Folder', 'จุดในชื่อต้องไม่ทำให้โฟลเดอร์กลายเป็นไฟล์')
})

/* ══ Phase 5 · Rename ════════════════════════════════════════════════════ */

test('RENAME 1 · renaming a file keeps every identity fact intact', async () => {
  const a = await login(USER_A)
  const file = await makeFile(a, 'before.pdf', 'stable-bytes')

  const res = await a.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'PATCH', body: { name: 'after.pdf' } })
  assert.equal(res.status, 200, JSON.stringify(res.data))

  const after = res.data.file
  assert.equal(after.name, 'after.pdf')
  assert.equal(String(after.id), String(file.id), 'id คงเดิม')
  assert.equal(after.kind, file.kind, 'kind คงเดิม')
  assert.equal(after.sha256, file.sha256, 'ไบต์ไม่ถูกแตะ จึง sha เท่าเดิม')
  assert.equal(after.size, file.size)
  assert.equal(after.path, file.path, 'storage key ต้องไม่ขยับ — ห้ามคัดลอกไบต์')
})

test('RENAME 2 · renaming never flips kind in either direction', async () => {
  const a = await login(USER_A)
  const file = await makeFile(a, 'report.pdf', 'bytes')
  const folder = await makeFolder(a, `Keep-${Date.now()}`)

  // นี่คือบั๊กเดิมทั้งดุ้น: ตัดนามสกุลออกแล้วไฟล์เคยกลายเป็นโฟลเดอร์
  const r1 = await a.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'PATCH', body: { name: 'report' } })
  assert.equal(r1.status, 200)
  assert.equal(r1.data.file.kind, 'file')
  assert.equal(r1.data.file.type, 'File')

  const r2 = await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'PATCH', body: { name: 'Keep.2026' } })
  assert.equal(r2.status, 200)
  assert.equal(r2.data.file.kind, 'folder')
  assert.equal(r2.data.file.type, 'Folder')
})

test('RENAME 3 · folders can be renamed and keep their children', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `rn-folder-${Date.now()}`)
  const child = await makeFile(a, 'child.txt', 'x', folder.id)

  const res = await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'PATCH', body: { name: 'renamed-folder' } })
  assert.equal(res.status, 200)
  assert.equal(res.data.file.name, 'renamed-folder')

  const inside = await listAt(a, folder.id)
  assert.deepEqual(inside.map((f) => String(f.id)), [String(child.id)], 'ลูกยังอยู่ที่เดิม')
})

test('RENAME 4 · blank, traversal and separator names are refused', async () => {
  const a = await login(USER_A)
  const file = await makeFile(a, 'guard.txt', 'x')
  const url = `/api/files/${encodeURIComponent(file.id)}`

  for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', '../escape', 'x\u0000y', 'x\ny']) {
    const res = await a.req(url, { method: 'PATCH', body: { name } })
    assert.equal(res.status, 400, `ชื่อ ${JSON.stringify(name)} ต้องถูกปฏิเสธ`)
  }
  assert.equal((await findById(a, file.id)).name, 'guard.txt', 'ชื่อเดิมต้องไม่ถูกแตะเลย')
})

test('RENAME 5 · a colliding name inside the same parent is refused truthfully', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const folder = await makeFolder(a, `rn-collide-${stamp}`)
  await makeFile(a, 'taken.txt', 'x', folder.id)
  const other = await makeFile(a, 'free.txt', 'y', folder.id)

  const res = await a.req(`/api/files/${encodeURIComponent(other.id)}`, { method: 'PATCH', body: { name: 'taken.txt' } })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'NAME_TAKEN')
  assert.equal((await findById(a, other.id, folder.id)).name, 'free.txt', 'ของเดิมต้องไม่เปลี่ยน')
})

test('RENAME 6 · the same name in a different parent is allowed', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const one = await makeFolder(a, `rn-p1-${stamp}`)
  const two = await makeFolder(a, `rn-p2-${stamp}`)
  await makeFile(a, 'same.txt', 'x', one.id)
  const other = await makeFile(a, 'other.txt', 'y', two.id)

  const res = await a.req(`/api/files/${encodeURIComponent(other.id)}`, { method: 'PATCH', body: { name: 'same.txt' } })
  assert.equal(res.status, 200, 'คนละโฟลเดอร์ = ไม่ชนกัน')
})

test("RENAME 7 · another user's item is not renameable and reports 404", async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const file = await makeFile(a, 'mine.txt', 'x')

  const res = await b.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'PATCH', body: { name: 'stolen.txt' } })
  assert.equal(res.status, 404)
  assert.equal((await findById(a, file.id)).name, 'mine.txt')
})

test('RENAME 8 · versions and share links survive a rename untouched', async () => {
  const a = await login(USER_A)
  const file = await makeFile(a, 'shared.txt', 'v1')
  await makeFile(a, 'shared.txt', 'v2') // อัปโหลดทับ = สร้างเวอร์ชัน

  const share = await a.req('/api/shares', {
    method: 'POST',
    body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(share.status, 201, JSON.stringify(share.data))

  const before = await a.req(`/api/files/${encodeURIComponent(file.id)}/versions`)
  assert.equal(before.status, 200)

  const res = await a.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'PATCH', body: { name: 'renamed-shared.txt' } })
  assert.equal(res.status, 200)

  const after = await a.req(`/api/files/${encodeURIComponent(file.id)}/versions`)
  assert.equal(after.status, 200)
  assert.equal(after.data.versions.length, before.data.versions.length, 'ประวัติเวอร์ชันต้องไม่หาย')

  const shares = await a.req('/api/shares')
  assert.equal(shares.data.shares.some((s) => String(s.fileId) === String(file.id)), true, 'ลิงก์แชร์ยังผูกกับไฟล์เดิม')
})

/* ══ Phase 6 · Move ══════════════════════════════════════════════════════ */

test('MOVE 1 · a single file moves into a folder with no byte copy', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `mv-one-${Date.now()}`)
  const file = await makeFile(a, 'movable.txt', 'bytes')

  const res = await a.req('/api/files/move', { method: 'POST', body: { ids: [file.id], parentId: folder.id } })
  assert.equal(res.status, 200, JSON.stringify(res.data))

  const moved = await findById(a, file.id, folder.id)
  assert.ok(moved, 'ต้องอยู่ในโฟลเดอร์ปลายทาง')
  assert.equal(moved.path, file.path, 'storage key เดิม = ไม่มีการคัดลอกไบต์')
  assert.equal(moved.sha256, file.sha256)
  assert.equal(String(moved.id), String(file.id))
  assert.equal((await findById(a, file.id)), null, 'ต้องไม่ค้างอยู่ที่รากอีก')
})

test('MOVE 2 · several selected files move together, and back to root', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `mv-bulk-${Date.now()}`)
  const one = await makeFile(a, 'bulk-1.txt', 'a')
  const two = await makeFile(a, 'bulk-2.txt', 'b')

  const into = await a.req('/api/files/move', { method: 'POST', body: { ids: [one.id, two.id], parentId: folder.id } })
  assert.equal(into.status, 200)
  assert.equal((await listAt(a, folder.id)).length, 2)

  const back = await a.req('/api/files/move', { method: 'POST', body: { ids: [one.id, two.id], parentId: null } })
  assert.equal(back.status, 200, 'ย้ายกลับไปรากได้')
  assert.equal((await listAt(a, folder.id)).length, 0)
})

test('MOVE 3 · a folder moves into another folder, carrying its subtree', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const target = await makeFolder(a, `mv-target-${stamp}`)
  const moving = await makeFolder(a, `mv-moving-${stamp}`)
  const child = await makeFile(a, 'carried.txt', 'x', moving.id)

  const res = await a.req('/api/files/move', { method: 'POST', body: { ids: [moving.id], parentId: target.id } })
  assert.equal(res.status, 200, JSON.stringify(res.data))

  assert.ok(await findById(a, moving.id, target.id), 'โฟลเดอร์อยู่ในปลายทางแล้ว')
  const inside = await listAt(a, moving.id)
  assert.deepEqual(inside.map((f) => String(f.id)), [String(child.id)], 'ลูกติดไปด้วยโดยไม่ต้องย้ายทีละตัว')
})

test('MOVE 4 · a folder cannot be moved into itself or into its own descendant', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const outer = await makeFolder(a, `mv-cycle-${stamp}`)
  const inner = await makeFolder(a, 'inner', outer.id)
  const deepest = await makeFolder(a, 'deepest', inner.id)

  const intoSelf = await a.req('/api/files/move', { method: 'POST', body: { ids: [outer.id], parentId: outer.id } })
  assert.equal(intoSelf.status, 409)
  assert.equal(intoSelf.data.code, 'MOVE_CYCLE')

  const intoChild = await a.req('/api/files/move', { method: 'POST', body: { ids: [outer.id], parentId: inner.id } })
  assert.equal(intoChild.status, 409)
  assert.equal(intoChild.data.code, 'MOVE_CYCLE')

  const intoGrandchild = await a.req('/api/files/move', { method: 'POST', body: { ids: [outer.id], parentId: deepest.id } })
  assert.equal(intoGrandchild.status, 409, 'ลูกหลานชั้นลึกก็ต้องกันได้')
  assert.equal(intoGrandchild.data.code, 'MOVE_CYCLE')

  assert.ok(await findById(a, outer.id), 'โครงสร้างเดิมต้องไม่ถูกแตะเลย')
})

test('MOVE 5 · moving into the parent an item already has is refused truthfully', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `mv-noop-${Date.now()}`)
  const file = await makeFile(a, 'already.txt', 'x', folder.id)

  const res = await a.req('/api/files/move', { method: 'POST', body: { ids: [file.id], parentId: folder.id } })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'ALREADY_THERE', 'ต้องบอกความจริง ไม่ใช่แกล้งรายงานว่าสำเร็จ')
})

test('MOVE 6 · a target that is a file, missing, or owned by someone else is refused', async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const file = await makeFile(a, 'mv-src.txt', 'x')
  const notFolder = await makeFile(a, 'mv-notfolder.txt', 'y')
  const foreign = await makeFolder(b, `mv-foreign-${Date.now()}`)

  assert.equal((await a.req('/api/files/move', { method: 'POST', body: { ids: [file.id], parentId: notFolder.id } })).status, 400)
  assert.equal((await a.req('/api/files/move', { method: 'POST', body: { ids: [file.id], parentId: 99999999 } })).status, 404)
  assert.equal((await a.req('/api/files/move', { method: 'POST', body: { ids: [file.id], parentId: foreign.id } })).status, 404)
  assert.ok(await findById(a, file.id), 'ยังอยู่ที่ราก ไม่ถูกย้ายไปไหน')
})

test("MOVE 7 · moving another user's item is refused and changes nothing", async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const mine = await makeFile(a, 'mv-mine.txt', 'x')
  const theirFolder = await makeFolder(b, `mv-theirs-${Date.now()}`)

  const res = await b.req('/api/files/move', { method: 'POST', body: { ids: [mine.id], parentId: theirFolder.id } })
  assert.equal(res.status, 404)
  assert.ok(await findById(a, mine.id), 'ไฟล์ของ A ยังอยู่ที่เดิม')
})

test('MOVE 8 · a bulk move is all-or-nothing: one bad item moves none of them', async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const stamp = Date.now()
  const folder = await makeFolder(a, `mv-atomic-${stamp}`)
  const good1 = await makeFile(a, 'atomic-1.txt', 'a')
  const good2 = await makeFile(a, 'atomic-2.txt', 'b')
  const foreign = await makeFile(b, 'atomic-foreign.txt', 'c')

  const res = await a.req('/api/files/move', {
    method: 'POST',
    body: { ids: [good1.id, good2.id, foreign.id], parentId: folder.id },
  })
  assert.equal(res.status, 404, 'มีรายการที่ไม่ใช่ของผู้เรียก = ปฏิเสธทั้งชุด')

  assert.equal((await listAt(a, folder.id)).length, 0, 'ต้องไม่มีรายการใดถูกย้ายเลย')
  assert.ok(await findById(a, good1.id), 'ของดีต้องยังอยู่ที่เดิม')
  assert.ok(await findById(a, good2.id))
})

test('MOVE 9 · a collision in the target folder blocks the whole move before any mutation', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const folder = await makeFolder(a, `mv-collide-${stamp}`)
  await makeFile(a, 'dup.txt', 'existing', folder.id)
  const incoming = await makeFile(a, 'dup.txt', 'incoming')
  const innocent = await makeFile(a, 'innocent.txt', 'x')

  const res = await a.req('/api/files/move', {
    method: 'POST',
    body: { ids: [innocent.id, incoming.id], parentId: folder.id },
  })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'NAME_TAKEN')
  assert.ok(await findById(a, innocent.id), 'รายการที่ไม่ได้ชนก็ต้องไม่ถูกย้าย')
  assert.equal((await listAt(a, folder.id)).length, 1, 'ปลายทางต้องมีของเดิมเท่านั้น')
})

/* ══ Phase 7 · การลบต้องไม่ทำให้ลูกกำพร้า ═══════════════════════════════ */

test('DELETE 1 · trashing a folder that still holds live children is refused', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `del-nonempty-${Date.now()}`)
  const child = await makeFile(a, 'held.txt', 'x', folder.id)

  const res = await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })
  assert.equal(res.status, 409)
  assert.equal(res.data.code, 'FOLDER_NOT_EMPTY')

  assert.ok(await findById(a, folder.id), 'โฟลเดอร์ยังอยู่')
  assert.ok(await findById(a, child.id, folder.id), 'และลูกต้องไม่กลายเป็นของกำพร้า')
})

test('DELETE 2 · an empty folder still deletes, and a folder emptied first becomes deletable', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const empty = await makeFolder(a, `del-empty-${stamp}`)
  assert.equal((await a.req(`/api/files/${encodeURIComponent(empty.id)}`, { method: 'DELETE' })).status, 200)

  const folder = await makeFolder(a, `del-emptied-${stamp}`)
  const child = await makeFile(a, 'temp.txt', 'x', folder.id)
  assert.equal((await a.req(`/api/files/${encodeURIComponent(child.id)}`, { method: 'DELETE' })).status, 200)
  assert.equal(
    (await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })).status, 200,
    'ย้าย/ลบลูกออกหมดแล้วต้องลบโฟลเดอร์ได้',
  )
})
