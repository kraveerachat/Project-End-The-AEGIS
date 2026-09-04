// tests/fileVersions.test.js — AEGIS Drive (IDEA1) · ประวัติไฟล์ที่กู้ข้อมูลได้จริง + Storage ที่ไม่โกหก
//
// สิ่งที่ชุดนี้พิสูจน์ (แทนจอ Snapshots เดิมที่ไม่มีข้อไหนเป็นจริงเลย):
//   A. อัปโหลดชื่อเดิมทับ → ไบต์ชุดเก่าถูกเก็บไว้จริงบนดิสก์ และอ่านกลับได้ครบทุกไบต์
//   B. กู้คืน → ไบต์ของเวอร์ชันนั้น "กลายเป็นไฟล์ปัจจุบันจริง ๆ" (ไม่ใช่แค่ธงในหน่วยความจำ
//      อย่าง rollbackTo() เดิมที่ตอบว่า restored โดยไม่คืนไบต์ของใครเลย)
//   C. กู้คืนไม่ทำลายอะไร — ไบต์ที่เป็นปัจจุบันก่อนกู้ถูกเก็บเป็นเวอร์ชัน กู้กลับได้
//   D. ประวัติเป็นของเจ้าของเท่านั้น (อ่าน/ดาวน์โหลด/กู้คืน) — ไม่มีข้อยกเว้นให้ Admin
//   E. อัปโหลดชื่อซ้ำ "ของคนอื่น" ไม่ทับไฟล์เขา (ยังเป็นสองไฟล์แยกกัน)
//   F. ย้ายเข้าถังขยะ → เก็บทุกเวอร์ชัน; ลบถาวร → ไบต์ทุกเวอร์ชันหายจากดิสก์
//   G. /api/storage คืนความจุจริงจาก statfs และประกาศสิ่งที่วัดไม่ได้ — ไม่มีดิสก์/
//      backup job ที่แต่งขึ้นหลงเหลืออยู่
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, currentPasswordOf, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-versions-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage, resolveKey, storageConfig } = await import('../server/storage/fileStore.js')
const store = await import('../server/db/store.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[file versions tests] database mode: ${DB_MODE}`)

// ⚠️ ชื่อไฟล์ต่างกันทุกเทสต์: การอัปโหลด "ชื่อเดิม" คือทริกเกอร์ของการสร้างเวอร์ชัน
//    ถ้าสองเทสต์ใช้ชื่อเดียวกัน เทสต์ที่สองจะกลายเป็นเวอร์ชันที่ N ของไฟล์เดิมจากเทสต์แรก
//    (พึ่ง beforeEach ล้างให้ก็ยังเปราะ — โหมด in-memory ไม่ได้ล้างตาราง files)
let nameSeq = 0
const uniqueName = () => `versiontest-${Date.now()}-${nameSeq++}.txt`
const V1 = 'revision one — unit cost 400.00'
const V2 = 'revision two — unit cost 412.50'
const V3 = 'revision three — unit cost 425.75'

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
  if (usingPostgres) {
    await query(`DELETE FROM files WHERE name LIKE 'versiontest-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await store.__resetFileVersionsForTests()
  if (usingPostgres) await query(`DELETE FROM files WHERE name LIKE 'versiontest-%'`)
})

async function upload(client, content, name) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `อัปโหลดล้มเหลว: ${JSON.stringify(res.data)}`)
  return res.data
}

const download = async (client, id) =>
  (await client.raw(`/api/files/${encodeURIComponent(id)}/download`)).buffer.toString('utf8')

const versionsOf = async (client, id) =>
  (await client.req(`/api/files/${encodeURIComponent(id)}/versions`)).data

/** ไฟล์ทุกไฟล์ที่อยู่ใต้ versions/ บนดิสก์จริง */
async function versionFilesOnDisk() {
  try {
    return await fs.readdir(path.join(STORAGE_ROOT, storageConfig.VERSIONS_DIR))
  } catch {
    return []
  }
}

/** จำนวนไฟล์ใน versions/ — ใช้เทียบเป็น "ส่วนต่าง" เพราะเทสต์อื่นก็ทิ้งไฟล์ไว้ที่นั่นด้วย */
const versionFileCount = async () => (await versionFilesOnDisk()).length

// ═══ A + B + C. เก็บเวอร์ชัน และกู้คืนได้จริง ═══════════════════════════════════

test('อัปโหลดชื่อเดิมทับ → เก็บไบต์ชุดเก่าไว้จริง และดาวน์โหลดเวอร์ชันเก่าได้ครบทุกไบต์', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  const name = uniqueName()
  const first = await upload(c, V1, name)
  assert.equal(first.newVersion, false, 'ครั้งแรกไม่ใช่เวอร์ชันใหม่')
  const fileId = first.file.id
  assert.equal(await download(c, fileId), V1)
  assert.equal((await versionsOf(c, fileId)).versions.length, 0, 'ยังไม่มีประวัติ')

  const second = await upload(c, V2, name)
  assert.equal(second.newVersion, true, 'อัปโหลดชื่อเดิมต้องถูกบันทึกเป็นเวอร์ชันใหม่')
  // ⚠️ ต้องเป็น "ไฟล์เดิม" ไม่ใช่ไฟล์ที่สองที่ชื่อซ้ำกัน
  assert.equal(String(second.file.id), String(fileId), 'ต้องอัปเดตแถวเดิม ไม่สร้างแถวใหม่')

  const detail = await versionsOf(c, fileId)
  assert.equal(detail.versions.length, 1, 'ต้องมีหนึ่งเวอร์ชันก่อนหน้า')
  assert.equal(detail.file.size, Buffer.byteLength(V2), 'ไฟล์ปัจจุบันคือเนื้อหาใหม่')
  assert.equal(detail.versions[0].size, Buffer.byteLength(V1), 'เวอร์ชันเก่าคือเนื้อหาเดิม')

  // ⚠️ หัวใจ: ไบต์ของเวอร์ชันเก่าต้องอ่านกลับมาได้ "ครบและถูกต้อง" ไม่ใช่แค่มีแถว
  const old = await c.raw(`/api/files/${fileId}/versions/${detail.versions[0].id}/download`)
  assert.equal(old.status, 200)
  assert.equal(old.buffer.toString('utf8'), V1, 'ไบต์ของเวอร์ชันเก่าต้องเหมือนต้นฉบับเป๊ะ')

  // และไฟล์ปัจจุบันยังเป็นเนื้อหาใหม่
  assert.equal(await download(c, fileId), V2)

  // storageKey ต้องไม่หลุดออกทาง API (รายละเอียดภายในของ Storage Layer)
  const raw = JSON.stringify(detail)
  assert.ok(!raw.includes('storageKey') && !raw.includes('versions/'), 'ห้ามคืน storage key')
})

test('กู้คืน → ไบต์ของเวอร์ชันนั้นกลายเป็นไฟล์ปัจจุบันจริง และของเดิมถูกเก็บไว้ (ย้อนได้)', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName()
  const { file } = await upload(c, V1, name)
  await upload(c, V2, name)
  await upload(c, V3, name)

  let detail = await versionsOf(c, file.id)
  assert.equal(detail.versions.length, 2, 'ต้องมีสองเวอร์ชันก่อนหน้า')
  assert.equal(await download(c, file.id), V3, 'ปัจจุบันคือ V3')

  // เวอร์ชันที่เก่าที่สุด = V1 (เรียงใหม่→เก่า)
  const v1 = detail.versions[detail.versions.length - 1]
  const restored = await c.req(`/api/files/${file.id}/versions/${v1.id}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200, `กู้คืนต้องสำเร็จ — ได้ ${JSON.stringify(restored.data)}`)

  // ⚠️ สิ่งที่ต้องพิสูจน์: "ไบต์จริงถูกกู้" ไม่ใช่แค่สถานะเปลี่ยน
  assert.equal(await download(c, file.id), V1, 'ไฟล์ปัจจุบันต้องเป็นไบต์ของ V1 จริง ๆ')
  assert.equal(restored.data.file.size, Buffer.byteLength(V1))

  // ⚠️ และต้องไม่ทำลายอะไร: V3 (ที่เคยเป็นปัจจุบัน) ต้องยังอยู่ให้ย้อนกลับได้
  detail = await versionsOf(c, file.id)
  const sizes = detail.versions.map((v) => v.size).sort((a, b) => a - b)
  assert.deepEqual(
    sizes, [Buffer.byteLength(V2), Buffer.byteLength(V3)].sort((a, b) => a - b),
    'V2 และ V3 ต้องยังอยู่เป็นเวอร์ชันก่อนหน้า',
  )

  // ย้อนกลับไป V3 ได้จริง
  const v3 = detail.versions.find((v) => v.size === Buffer.byteLength(V3))
  assert.equal((await c.req(`/api/files/${file.id}/versions/${v3.id}/restore`, { method: 'POST' })).status, 200)
  assert.equal(await download(c, file.id), V3, 'กู้กลับไป V3 ได้ = การกู้คืนย้อนกลับได้จริง')
})

test('ไบต์ของเวอร์ชันอยู่บนดิสก์จริง ไม่ได้ถูกทำสำเนาซ้ำซ้อน', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName()
  const base = await versionFileCount()

  const { file } = await upload(c, V1, name)
  assert.equal(await versionFileCount(), base, 'ยังไม่มีเวอร์ชัน = ยังไม่มีไฟล์เพิ่มใน versions/')

  await upload(c, V2, name)
  assert.equal(await versionFileCount(), base + 1, 'หนึ่งเวอร์ชัน = เพิ่มหนึ่งไฟล์')

  await upload(c, V3, name)
  assert.equal(await versionFileCount(), base + 2, 'สองเวอร์ชัน = เพิ่มสองไฟล์')

  // ⚠️ การกู้คืนใช้ rename ไม่ใช่ copy — จำนวนไฟล์รวมต้องไม่เพิ่ม (ไบต์ชุดหนึ่งมีสำเนาเดียว)
  const detail = await versionsOf(c, file.id)
  const target = detail.versions[detail.versions.length - 1]
  await c.req(`/api/files/${file.id}/versions/${target.id}/restore`, { method: 'POST' })
  assert.equal(
    await versionFileCount(), base + 2,
    'หลังกู้คืน จำนวนไฟล์ใน versions/ ต้องเท่าเดิม (ย้าย ไม่ใช่คัดลอก)',
  )
})

// ═══ D + E. สิทธิ์ ═══════════════════════════════════════════════════════════════

test('ประวัติเป็นของเจ้าของเท่านั้น — Admin ก็อ่าน/ดาวน์โหลด/กู้คืนของคนอื่นไม่ได้', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const name = uniqueName()
  const { file } = await upload(owner, V1, name)
  await upload(owner, V2, name)
  const detail = await versionsOf(owner, file.id)
  const versionId = detail.versions[0].id

  // ⚠️ ไม่มีข้อยกเว้นให้ Admin — แบบแผนเดียวกับด่าน DELETE /api/files/:id
  //    ประวัติเวอร์ชันคือ "เนื้อหาของไฟล์ในอดีต" การให้อ่านได้ = ให้อ่านไฟล์ของเขา
  //    และการให้กู้คืนได้ = ให้เขียนทับไฟล์ของเขา
  assert.equal((await admin.req(`/api/files/${file.id}/versions`)).status, 404, 'Admin อ่านประวัติไม่ได้')
  assert.equal(
    (await admin.raw(`/api/files/${file.id}/versions/${versionId}/download`)).status, 404,
    'Admin ดาวน์โหลดเวอร์ชันของคนอื่นไม่ได้',
  )
  assert.equal(
    (await admin.req(`/api/files/${file.id}/versions/${versionId}/restore`, { method: 'POST' })).status, 404,
    'Admin กู้คืนไฟล์ของคนอื่นไม่ได้',
  )

  // และของจริงต้องไม่ถูกแตะเลยหลังถูกปฏิเสธ
  assert.equal(await download(owner, file.id), V2, 'ไฟล์ของเจ้าของต้องไม่เปลี่ยน')
  assert.equal((await versionsOf(owner, file.id)).versions.length, 1, 'ประวัติต้องไม่เปลี่ยน')
})

test('อัปโหลดชื่อซ้ำกับไฟล์ของคนอื่น ไม่ทับไฟล์เขา — ยังเป็นสองไฟล์แยกกัน', async () => {
  const a = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const b = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const shared = uniqueName()
  const mine = await upload(a, V1, shared)
  // ⚠️ ถ้าเทียบด้วยชื่อไฟล์อย่างเดียว การอัปโหลดนี้จะกลายเป็นการเขียนทับไฟล์ของ a
  //    = ได้สิทธิ์เขียนไฟล์ของผู้อื่นโดยไม่ผ่านด่าน ownership ใด ๆ
  const theirs = await upload(b, V3, shared)
  assert.equal(theirs.newVersion, false, 'ต้องไม่ถือเป็นเวอร์ชันใหม่ของไฟล์คนอื่น')
  assert.notEqual(String(theirs.file.id), String(mine.file.id), 'ต้องเป็นสองแถวแยกกัน')

  assert.equal(await download(a, mine.file.id), V1, 'ไฟล์ของ a ต้องไม่ถูกแตะ')
  assert.equal((await versionsOf(a, mine.file.id)).versions.length, 0, 'a ต้องไม่มีประวัติงอกขึ้นมา')
})

// ═══ F. ถังขยะเก็บประวัติ; permanent delete จึงลบไบต์และแถว ════════════════════

test('ย้ายเข้าถังขยะเก็บทุกเวอร์ชัน และลบถาวรจึงลบไบต์ทั้งหมด', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName()
  const base = await versionFileCount()
  const { file } = await upload(c, V1, name)
  await upload(c, V2, name)
  await upload(c, V3, name)

  assert.equal(await versionFileCount(), base + 2, 'ต้องมีสองไฟล์เวอร์ชันก่อนลบ')

  assert.equal((await c.req(`/api/files/${file.id}`, { method: 'DELETE' })).status, 200)

  assert.equal(await versionFileCount(), base + 2, 'soft delete ต้องเก็บไบต์ของเวอร์ชันไว้ให้กู้คืน')
  assert.equal((await c.req(`/api/files/${file.id}/versions`)).status, 404, 'ไฟล์ในถังขยะต้องไม่โผล่ใน active history')

  const purged = await c.req(`/api/trash/${file.id}`, {
    method: 'DELETE', body: { password: currentPasswordOf(DEMO_USER.username) },
  })
  assert.equal(purged.status, 200)
  assert.equal(await versionFileCount(), base, 'ไบต์ของทุกเวอร์ชันต้องหายจากดิสก์')
})

test('endpoint snapshot ที่เป็นของปลอมต้องไม่มีอยู่อีก (404 ไม่ใช่ 200)', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  // ⚠️ /snapshots คืนแปดแถวที่ hard-code ไว้ และ rollback แค่ตั้งธง destroyed ในหน่วยความจำ
  //    โดยรายงานกลับว่า restored พร้อมจำนวน GB ที่เสียไป — ถ้ากลับมาเป็น 200 ให้ถือว่าเป็น
  //    regression ไม่ใช่ฟีเจอร์ที่ถูกเพิ่มคืน
  assert.equal((await c.req('/api/snapshots')).status, 404, '/api/snapshots ต้องไม่มีอยู่')
  assert.equal(
    (await c.req('/api/snapshots/snap-0093/rollback', { method: 'POST' })).status, 404,
    '/api/snapshots/:id/rollback ต้องไม่มีอยู่',
  )
})

// ═══ G. Storage — ของจริงเท่านั้น ═══════════════════════════════════════════════

test('GET /api/storage คืนความจุจริงจาก statfs และไม่มีดิสก์/backup ที่แต่งขึ้น', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const res = await c.req('/api/storage')
  assert.equal(res.status, 200)
  const d = res.data

  // ── ความจุต้องเป็นค่าจริงของ mount ที่ STORAGE_ROOT อยู่
  assert.ok(d.capacityBytes, 'ต้องอ่านความจุได้ในสภาพแวดล้อมของเทสต์')
  assert.ok(d.capacityBytes.totalBytes > 0, 'ความจุรวมต้องมากกว่าศูนย์')
  assert.ok(d.capacityBytes.freeBytes >= 0)
  assert.equal(
    d.capacityBytes.usedBytes, d.capacityBytes.totalBytes - d.capacityBytes.freeBytes,
    'used ต้องเป็นผลจาก total-free ไม่ใช่ค่าที่ตั้งแยก',
  )
  // ⚠️ ค่าคงที่ที่เคย hard-code ไว้ต้องหายไป: 1024 GB total และ 342 GB baseline
  assert.notEqual(d.capacityBytes.totalBytes, 1024 * 1e9, 'ความจุรวมต้องไม่ใช่ค่าคงที่ 1024 GB เดิม')

  // ── สิ่งที่วัดไม่ได้ต้องถูกประกาศ ไม่ใช่เติมค่าให้
  //    (ในสภาพแวดล้อมของเทสต์ไม่มี host agent ทั้งสองตัว — เหตุผลจึงเป็น agent-unreachable
  //     ไม่ใช่ needs-host-access เดิม เพราะตอนนี้มีเส้นทางวัดจริงผ่าน agent ที่แยกสิทธิ์แล้ว)
  assert.equal(d.unavailable.diskHealth, 'agent-unreachable')
  assert.equal(d.unavailable.raid, 'not-configured')
  assert.equal(d.unavailable.backups, 'agent-unreachable')
  assert.equal(d.diskHealth.available, false)
  assert.equal(d.diskHealth.status, 'UNKNOWN', 'no evidence is UNKNOWN, never HEALTHY')
  assert.equal(d.raid.status, 'NOT_CONFIGURED')
  assert.equal(d.backup.available, false)
  assert.equal(d.backup.risk, 'UNKNOWN')
  assert.equal(d.backup.successRate30d, null, 'no jobs = unavailable, not 0% and not 100%')

  // ── ฮาร์ดแวร์และ backup job ที่แต่งขึ้นต้องไม่กลับมา
  const dump = JSON.stringify(d)
  for (const fake of ['WD Red Pro', 'WD-WX32DA8L7K4N', 'WD-WX32DA8L2C9F', 'PASSED',
    'Nightly incremental', 'offsite-tape', 'LTO-9', 'edge-site-B', 'PostgreSQL WAL archive']) {
    assert.ok(!dump.includes(fake), `'${fake}' คือข้อมูลที่แต่งขึ้นและถูกถอดออกแล้ว`)
  }
  assert.equal('disks' in d, false, 'ต้องไม่มีฟิลด์ disks อีก')
  assert.equal('backups' in d, false, 'ต้องไม่มีฟิลด์ backups อีก')
})

test('การแบ่งพื้นที่ตามหมวดมาจากขนาดไฟล์จริง (อัปโหลดแล้วตัวเลขขยับตามจริง)', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const before = (await c.req('/api/storage')).data.usage

  const bulk = 'x'.repeat(50_000)
  const pdfName = `versiontest-${Date.now()}-report.pdf`
  await upload(c, bulk, pdfName) // นับเป็นหมวด docs
  const afterDocs = (await c.req('/api/storage')).data.usage
  assert.equal(
    afterDocs.docs - before.docs, Buffer.byteLength(bulk),
    'หมวด docs ต้องเพิ่มขึ้นเท่ากับขนาดไฟล์ที่อัปโหลดจริง',
  )

  // อัปโหลดทับ → ขนาดของเวอร์ชันเก่าต้องไปโผล่ในหมวด versions ไม่ใช่หายไปเงียบ ๆ
  await upload(c, bulk + bulk, pdfName)
  const afterVersion = (await c.req('/api/storage')).data.usage
  assert.equal(
    afterVersion.versions - before.versions, Buffer.byteLength(bulk),
    'พื้นที่ที่ประวัติเวอร์ชันกินต้องถูกนับและแสดงแยก',
  )
})
