// tests/filesUploadTargeting.test.js — FILES-MANAGEMENT-UX-1 · S2 source-review corrections
//
// ⚠️ สามข้อบกพร่องที่ชุดนี้ตรึงไว้ และเหตุผลที่มันหลุดรอบแรก:
//
//    1. จอ Files ใช้เส้นทางอัปโหลด **V2** การเติม parentId ให้เฉพาะ V1 จึงไม่ได้แก้
//       อะไรเลย และ finishUploadCommit อ้างตัวแปร `parentId` ที่ไม่มีอยู่ในสโคป
//       → ทุกการ commit ไฟล์ใหม่บน Postgres จะโยน ReferenceError
//       รอบแรกไม่เจอเพราะเทสต์วิ่งในโหมดหน่วยความจำและใช้ V1
//
//    2. ปลายทางของการอัปโหลดต้องอยู่ที่ **เซสชันฝั่งเซิร์ฟเวอร์** ไม่ใช่ค่าที่แนบมาตอน
//       commit — ไม่งั้นการ refresh แล้วเลือกไฟล์ใหม่จะพาไฟล์ไปลงโฟลเดอร์ที่ผู้ใช้
//       บังเอิญเปิดอยู่ตอนนั้น แทนที่จะเป็นโฟลเดอร์ที่เขาเริ่มอัปโหลดไว้
//
//    3. การย้ายต้องตรวจปลายทางและการชนกันของชื่อ **ในธุรกรรมเดียวกับที่เขียน**
//       การตรวจนอกธุรกรรมคือช่อง TOCTOU ที่ยังเปิดอยู่จริง
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, performLogin } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-uptarget-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')

const USER_A = { username: 'user', password: 'aegis-drive-user' }
const USER_B = { username: 'admin', password: 'aegis-drive-admin' }

let server, baseUrl

before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  console.log(`[files upload targeting] database mode: ${DB_MODE}`)
})

after(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  if (usingPostgres) await closePool()
})

/* ── ตัวช่วย: เดินเส้นทาง V2 ให้ครบทุกขั้นเหมือน UI จริง ─────────────────── */

async function login(who) {
  const client = new Client(baseUrl)
  await performLogin(client, who.username, who.password)
  return client
}

const sha256Of = async (text) => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

async function makeFolder(client, name, parentId = null) {
  const res = await client.req('/api/files/folder', { method: 'POST', body: { name, parentId } })
  assert.equal(res.status, 201, `folder ${name}: ${JSON.stringify(res.data)}`)
  return res.data.file
}

/** เปิด session V2 — จุดที่ปลายทางถูกตัดสินและบันทึกไว้ฝั่งเซิร์ฟเวอร์ */
async function openSession(client, name, contents, parentId = null) {
  const body = { name, size: Buffer.byteLength(contents), sha256: await sha256Of(contents) }
  if (parentId !== undefined) body.parentId = parentId
  return client.req('/api/files/uploads', { method: 'POST', body })
}

/** อัปโหลดไฟล์ผ่านเส้นทาง V2 เต็มรูปแบบ: session → chunk → commit */
async function uploadV2(client, name, contents, parentId = null) {
  const created = await openSession(client, name, contents, parentId)
  assert.equal(created.status, 201, `session ${name}: ${JSON.stringify(created.data)}`)
  const upload = created.data.upload

  const put = await client.raw(
    `/api/files/uploads/${encodeURIComponent(upload.uploadId)}/chunks/0`,
    {
      method: 'PUT',
      body: Buffer.from(contents),
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  )
  assert.equal(put.status, 200, `chunk ${name}: ${put.status}`)

  const committed = await client.req(
    `/api/files/uploads/${encodeURIComponent(upload.uploadId)}/commit`,
    { method: 'POST' },
  )
  return { upload, committed }
}

const listAt = async (client, parentId = null) => {
  const q = parentId === null ? '/api/files' : `/api/files?parentId=${encodeURIComponent(parentId)}`
  const res = await client.req(q)
  assert.equal(res.status, 200)
  return res.data.files
}

/* ══ DEFECT 1 · ปลายทางของการอัปโหลด V2 ═════════════════════════════════ */

test('V2-1 · a new file commits at root through the real V2 path', async () => {
  const a = await login(USER_A)
  // ⚠️ นี่คือเทสต์ที่จับ ReferenceError ของ `parentId` ที่ไม่มีในสโคป — รอบแรกไม่มี
  //    เทสต์ใดเดินเส้นทาง V2 + commit ไฟล์ใหม่เลย ข้อบกพร่องจึงรอดออกไป
  const { committed } = await uploadV2(a, `v2-root-${Date.now()}.txt`, 'root bytes')
  assert.equal(committed.status, 201, JSON.stringify(committed.data))
  assert.equal(committed.data.file.kind, 'file')
  assert.equal(committed.data.file.parentId, null)
})

test('V2-2 · the upload session stores the validated destination server-side', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `v2-sess-${Date.now()}`)
  const created = await openSession(a, 'held.txt', 'x', folder.id)
  assert.equal(created.status, 201, JSON.stringify(created.data))

  const session = await store.findUploadSession(created.data.upload.uploadId, (await a.req('/api/me')).data.user.id)
  assert.ok(session, 'session ต้องมีอยู่จริง')
  assert.equal(String(session.parentId), String(folder.id), 'ปลายทางต้องถูกบันทึกไว้ที่เซสชัน')
})

test('V2-3 · a session cannot be opened against a foreign or non-folder destination', async () => {
  const a = await login(USER_A)
  const b = await login(USER_B)
  const foreign = await makeFolder(b, `v2-foreign-${Date.now()}`)
  const { committed } = await uploadV2(a, `v2-notfolder-${Date.now()}.txt`, 'bytes')
  const file = committed.data.file

  assert.equal((await openSession(a, 'x.txt', 'x', foreign.id)).status, 404, 'โฟลเดอร์ของผู้อื่น = 404')
  assert.equal((await openSession(a, 'x.txt', 'x', file.id)).status, 400, 'ไฟล์ไม่ใช่โฟลเดอร์')
  assert.equal((await openSession(a, 'x.txt', 'x', 99999999)).status, 404)
})

test('V2-4 · a nested upload lands in the chosen folder, not at root', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `v2-nested-${Date.now()}`)
  const { committed } = await uploadV2(a, 'nested.txt', 'nested bytes', folder.id)

  assert.equal(committed.status, 201, JSON.stringify(committed.data))
  assert.equal(String(committed.data.file.parentId), String(folder.id))
  assert.equal((await listAt(a, folder.id)).some((f) => f.name === 'nested.txt'), true)
  assert.equal((await listAt(a)).some((f) => f.name === 'nested.txt'), false, 'ต้องไม่โผล่ที่ราก')
})

test('V2-5 · the same filename in two folders stays two distinct files', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const folder = await makeFolder(a, `v2-same-${stamp}`)

  const atRoot = await uploadV2(a, `dup-${stamp}.txt`, 'root version')
  const inFolder = await uploadV2(a, `dup-${stamp}.txt`, 'folder version', folder.id)

  assert.equal(atRoot.committed.status, 201)
  assert.equal(inFolder.committed.status, 201)
  assert.equal(inFolder.committed.data.newVersion, false, 'คนละโฟลเดอร์ = คนละไฟล์ ไม่ใช่เวอร์ชันใหม่')
  assert.notEqual(String(atRoot.committed.data.file.id), String(inFolder.committed.data.file.id))
})

test('V2-6 · re-uploading into the same folder versions that file and leaves root alone', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const folder = await makeFolder(a, `v2-ver-${stamp}`)
  const name = `ver-${stamp}.txt`

  const rootCopy = await uploadV2(a, name, 'root bytes')
  const first = await uploadV2(a, name, 'folder v1', folder.id)
  const second = await uploadV2(a, name, 'folder v2', folder.id)

  assert.equal(second.committed.status, 201, JSON.stringify(second.committed.data))
  assert.equal(second.committed.data.newVersion, true, 'โฟลเดอร์เดิม ชื่อเดิม = เวอร์ชันใหม่')
  assert.equal(String(second.committed.data.file.id), String(first.committed.data.file.id))
  assert.equal(String(second.committed.data.file.parentId), String(folder.id), 'เวอร์ชันใหม่ต้องอยู่โฟลเดอร์เดิม')

  // ไฟล์ชื่อเดียวกันที่รากต้องไม่ถูกแตะเลย
  const rootRow = (await listAt(a)).find((f) => String(f.id) === String(rootCopy.committed.data.file.id))
  assert.ok(rootRow, 'ไฟล์ที่รากยังอยู่')
  assert.equal(rootRow.sha256, rootCopy.committed.data.file.sha256, 'และไบต์ของมันไม่ถูกทับ')
})

test('V2-7 · a destination trashed mid-upload refuses the commit instead of orphaning metadata', async () => {
  const a = await login(USER_A)
  const folder = await makeFolder(a, `v2-vanish-${Date.now()}`)
  const created = await openSession(a, 'doomed.txt', 'bytes', folder.id)
  assert.equal(created.status, 201)
  const { uploadId } = created.data.upload

  const put = await a.raw(`/api/files/uploads/${encodeURIComponent(uploadId)}/chunks/0`, {
    method: 'PUT', body: Buffer.from('bytes'), headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(put.status, 200)

  // ปลายทางหายไประหว่างทาง — เป็นไปได้จริงกับไฟล์ 2 GB ที่ใช้เวลาหลายนาที
  assert.equal((await a.req(`/api/files/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })).status, 200)

  const committed = await a.req(`/api/files/uploads/${encodeURIComponent(uploadId)}/commit`, { method: 'POST' })
  assert.equal(committed.status, 409, 'ต้องปฏิเสธอย่างตรงไปตรงมา')
  assert.equal(committed.data.code, 'TARGET_GONE')

  // และต้องไม่มีแถวกำพร้าโผล่ที่ไหนเลย
  assert.equal((await listAt(a)).some((f) => f.name === 'doomed.txt'), false)
})

/* ══ DEFECT 3 · ปลายทาง + การชนกันของชื่อ ต้องอยู่ในขอบเขตอะตอมมิกจริง ══ */

test('MOVE-ATOMIC 1 · two same-named incoming items refuse the whole batch', async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const from1 = await makeFolder(a, `ma-a-${stamp}`)
  const from2 = await makeFolder(a, `ma-b-${stamp}`)
  const target = await makeFolder(a, `ma-c-${stamp}`)

  const one = await uploadV2(a, 'x.txt', 'one', from1.id)
  const two = await uploadV2(a, 'x.txt', 'two', from2.id)

  // ⚠️ ปลายทางยังไม่มี x.txt เลย การชนกันอยู่ "ภายในชุดที่ย้าย" เอง — ถ้าไม่ตรวจจุดนี้
  //    unique index จะเป็นคนจับ แล้วผู้ใช้จะได้ 500 แทนคำอธิบายที่อ่านรู้เรื่อง
  const res = await a.req('/api/files/move', {
    method: 'POST',
    body: { ids: [one.committed.data.file.id, two.committed.data.file.id], parentId: target.id },
  })
  assert.equal(res.status, 409, JSON.stringify(res.data))
  assert.equal(res.data.code, 'NAME_TAKEN')
  assert.equal((await listAt(a, target.id)).length, 0, 'ต้องไม่มีรายการใดถูกย้ายเลย')
  assert.equal((await listAt(a, from1.id)).length, 1, 'ของเดิมอยู่ครบ')
  assert.equal((await listAt(a, from2.id)).length, 1)
})

test('MOVE-ATOMIC 2 · the destination is revalidated inside the write transaction', async () => {
  const fsp = await import('node:fs/promises')
  const source = await fsp.readFile(new URL('../server/db/store.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export async function moveItems'))
  const tx = body.slice(body.indexOf('withTransaction'), body.indexOf('async function guardMoveSet'))

  // ปลายทางต้องถูกอ่าน "และล็อก" ด้วย client ของธุรกรรม ไม่ใช่ pool ภายนอก
  assert.match(tx, /client\.query\([\s\S]*?FROM files[\s\S]*?FOR UPDATE/,
    'ปลายทางต้องถูก SELECT ... FOR UPDATE ภายในธุรกรรม')
  assert.doesNotMatch(tx, /await nameTakenIn\(/,
    'การตรวจชื่อซ้ำต้องไม่วิ่งผ่าน pool นอกธุรกรรม')
  // และต้องมีการล็อกลำดับชั้นระดับผู้ใช้ เพื่อกันการย้ายสองทางพร้อมกันสร้างวงจร
  // ⚠️ รอบที่ 2 ย้ายล็อกนี้ไปเป็น helper เดียวที่ทุกการกลายพันธุ์ของลำดับชั้นใช้ร่วมกัน
  //    (ดู lockHierarchyOwner) — จุดอนุกรมต้องมีจุดเดียว ไม่ใช่ SQL ที่คัดลอกไปหลายที่
  assert.match(tx, /lockHierarchyOwner\(client, userId\)/,
    'ต้องเข้าคิวที่ล็อกลำดับชั้นต่อเจ้าของจุดเดียวกันกับ trash/create/commit')
})

test('MOVE-ATOMIC 3 · a unique-violation race is reported truthfully, not as a generic failure', async () => {
  const fsp = await import('node:fs/promises')
  const source = await fsp.readFile(new URL('../server/db/store.js', import.meta.url), 'utf8')
  // ⚠️ ต้องอยู่ใน moveItems เอง ไม่ใช่ที่อื่นในไฟล์ (มี 23505 ของ CIDR/settings อยู่แล้ว
  //    ซึ่งไม่เกี่ยวกัน) unique index คือแนวป้องกันสุดท้ายของฐานข้อมูล ถ้ามันยิงจริง
  //    ผู้ใช้ต้องได้เหตุผลเดียวกับที่ตรวจล่วงหน้าเจอ ไม่ใช่ 500 ที่อธิบายอะไรไม่ได้
  const moveBody = source.slice(
    source.indexOf('export async function moveItems'),
    source.indexOf('async function guardMoveSet'),
  )
  assert.match(moveBody, /23505/, 'moveItems ต้องแปล unique violation เป็น nameTaken')
  assert.match(moveBody, /nameTaken/)
})

/* ══ DEFECT 2 · การย้ายพร้อมกันต้องไม่สร้างวงจร ═════════════════════════ */

test('MOVE-CONCURRENT · A→B and B→A cannot both succeed', { skip: DB_MODE !== 'postgres' ? 'requires TEST_DATABASE_URL (PostgreSQL)' : false }, async () => {
  const a = await login(USER_A)
  const stamp = Date.now()
  const folderA = await makeFolder(a, `cc-a-${stamp}`)
  const folderB = await makeFolder(a, `cc-b-${stamp}`)

  const me = (await a.req('/api/me')).data.user.id
  const [r1, r2] = await Promise.all([
    store.moveItems([folderA.id], me, folderB.id),
    store.moveItems([folderB.id], me, folderA.id),
  ])

  assert.equal([r1.ok, r2.ok].filter(Boolean).length <= 1, true, 'ทั้งสองทิศทางสำเร็จพร้อมกันไม่ได้')

  // ลำดับชั้นที่เหลือต้องไม่มีวงจร และทุกอย่างยังเดินขึ้นถึงรากได้
  for (const id of [folderA.id, folderB.id]) {
    const seen = new Set()
    let cursor = id
    while (cursor != null) {
      assert.equal(seen.has(String(cursor)), false, 'ตรวจพบวงจรในลำดับชั้น')
      seen.add(String(cursor))
      cursor = (await store.findOwnItem(cursor, me))?.parentId ?? null
    }
  }
})

/* ══ Preflight · ชื่อซ้ำของข้อมูลเก่าต้องถูกรายงานก่อนย้ายสคีมา ═════════ */

test('PREFLIGHT 1 · duplicate active names are reported and block migration', async () => {
  const { legacyKindPreflight } = await import('../server/db/legacyKindClassifier.js')
  const rows = [
    { id: 1, name: 'Reports', path: '/datalake/Reports', size_bytes: 0, sha256: null, uploaded_by: 7 },
    // ⚠️ createFolder เดิมไม่เคยบังคับชื่อไม่ซ้ำ ข้อมูลเก่าจึงมีโฟลเดอร์ชื่อซ้ำได้จริง
    //    และ unique index ของ migration 010 จะทำให้การย้ายสคีมาล้มทั้งก้อน
    { id: 2, name: 'reports', path: '/datalake/reports', size_bytes: 0, sha256: null, uploaded_by: 7 },
    { id: 3, name: 'unique.txt', path: 'uploads/aaa.bin', size_bytes: 10, sha256: 'a'.repeat(64), uploaded_by: 7 },
  ]
  const report = await legacyKindPreflight({ query: async () => ({ rows }) })

  assert.equal(report.ambiguousRows, 0, 'ชนิดของทุกแถวพิสูจน์ได้')
  assert.equal(report.duplicateActiveNameGroups, 1, 'ต้องรายงานกลุ่มชื่อซ้ำ (ไม่สนตัวพิมพ์)')
  assert.equal(report.safeToMigrate, false, 'ชื่อซ้ำ = ยังย้ายสคีมาไม่ได้')
  assert.equal(report.safeToBackfill, true, 'แต่การจำแนกชนิดเองไม่ได้มีปัญหา')
  assert.equal(report.duplicateSamples[0].name.toLowerCase(), 'reports')
  assert.equal(report.duplicateSamples[0].count, 2)
})

test('PREFLIGHT 2 · a clean estate is safe to migrate, and nothing is ever auto-renamed', async () => {
  const { legacyKindPreflight } = await import('../server/db/legacyKindClassifier.js')
  const rows = [
    { id: 1, name: 'Reports', path: '/datalake/Reports', size_bytes: 0, sha256: null, uploaded_by: 7 },
    // ชื่อเดียวกันแต่คนละเจ้าของ = ไม่ชนกัน (unique index ผูกกับ uploaded_by)
    { id: 2, name: 'Reports', path: '/datalake/Reports', size_bytes: 0, sha256: null, uploaded_by: 8 },
  ]
  const report = await legacyKindPreflight({ query: async () => ({ rows }) })
  assert.equal(report.duplicateActiveNameGroups, 0)
  assert.equal(report.safeToMigrate, true)

  const fsp = await import('node:fs/promises')
  const src = await fsp.readFile(new URL('../server/db/legacyKindClassifier.js', import.meta.url), 'utf8')
  // ตรวจเฉพาะโค้ดที่รันจริง — คอมเมนต์อธิบาย FK "ON DELETE SET NULL" ไม่ใช่การกลายพันธุ์
  const executable = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(executable, /\bUPDATE\b|\bDELETE\b/i, 'preflight ต้องอ่านอย่างเดียว ห้ามแก้ข้อมูลของใคร')
})
