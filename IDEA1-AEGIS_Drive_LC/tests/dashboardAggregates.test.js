// tests/dashboardAggregates.test.js — AEGIS Drive (IDEA1) · ตัวเลขบนจอ Dashboard เป็นของจริง
//
// สิ่งที่ชุดนี้พิสูจน์ (ก่อนหน้านี้ไม่มีข้อไหนเป็นจริง):
//   A. กราฟกิจกรรม 7 วัน "ขยับตามการใช้งานจริง" — อัปโหลด/ดาวน์โหลดแล้วตัวเลขเพิ่มจริง
//      ของเดิมเป็นอาเรย์คงที่เจ็ดแถว (Tue up:42 down:118 …) ที่นิ่งเท่ากันทุกวันตลอดกาล
//   B. ไม่มีธง `projected` ที่จอวาดเป็น "การคาดการณ์" ทั้งที่ไม่มีการคาดการณ์ใด ๆ
//   C. ตัวเลขพื้นที่มาจาก statfs จริง ไม่ใช่ค่าคงที่ 342 GB / 1024 GB ที่ hard-code ไว้
//   D. จำนวนไฟล์/ลิงก์ที่เปิดอยู่ตรงกับของจริงในตาราง
//   E. เหตุการณ์ที่ "ล้มเหลว" ไม่ถูกนับเป็นกิจกรรมสำเร็จ (กราฟต้องไม่สวยเกินความจริง)
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-dash-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const store = await import('../server/db/store.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `โหมด DB ไม่ตรงกับที่ตั้งใจ — คาดว่า ${DB_MODE}`)
console.log(`[dashboard aggregates tests] database mode: ${DB_MODE}`)

let nameSeq = 0
const uniqueName = () => `dashtest-${Date.now()}-${nameSeq++}.txt`

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
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'dashtest-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  await store.__resetSharesForTests()
})

async function upload(client, content, name = uniqueName()) {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'application/octet-stream' }), name)
  const res = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(res.status, 201, `อัปโหลดล้มเหลว: ${JSON.stringify(res.data)}`)
  return res.data.file
}

const dash = async (client) => (await client.req('/api/dashboard')).data
const todayIso = () => new Date().toISOString().slice(0, 10)

// ═══ A + B. กราฟกิจกรรมเป็นของจริง ══════════════════════════════════════════════

test('กราฟ 7 วันมีโครงถูกต้อง และไม่มีธง projected ที่แต่งขึ้นอีก', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const d = await dash(c)

  assert.ok(Array.isArray(d.activity7d), 'ต้องมี activity7d')
  assert.equal(d.activity7d.length, 7, 'ต้องมีเจ็ดวันพอดี (รวมวันที่ไม่มีเหตุการณ์)')
  assert.equal('transfer7d' in d, false, 'ฟิลด์ transfer7d ที่เป็นของปลอมต้องหายไป')

  // ⚠️ วันที่ต้องเรียงเก่า→ใหม่ และวันสุดท้ายคือวันนี้ — กราฟที่ข้ามวันว่างหรือเรียงผิด
  //    ทำให้ช่วงเวลาบิดเบี้ยวและอ่านผิดโดยที่ดูเหมือนปกติ
  const dates = d.activity7d.map((r) => r.date)
  assert.deepEqual([...dates].sort(), dates, 'วันที่ต้องเรียงจากเก่าไปใหม่')
  assert.equal(dates[dates.length - 1], todayIso(), 'วันสุดท้ายต้องเป็นวันนี้')
  assert.equal(new Set(dates).size, 7, 'ต้องไม่มีวันซ้ำ')

  for (const row of d.activity7d) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็น ISO — ชื่อวันเป็นเรื่องของการแสดงผล')
    assert.equal(Number.isInteger(row.uploads), true, 'จำนวนครั้งต้องเป็นจำนวนเต็ม')
    assert.equal(Number.isInteger(row.downloads), true)
    assert.equal('projected' in row, false, 'ธง projected ต้องไม่มีอีก — ไม่เคยมีการคาดการณ์จริง')
    assert.equal('up' in row || 'down' in row, false, 'ฟิลด์ up/down (หน่วย GB ที่แต่งขึ้น) ต้องหายไป')
  }

  // ค่าที่เคย hard-code ไว้ต้องไม่โผล่มาเป็นชุดเดิมอีก
  const fake = [42, 61, 38, 74, 12, 45, 68]
  assert.notDeepEqual(d.activity7d.map((r) => r.uploads), fake, 'ชุดตัวเลขที่แต่งขึ้นเดิมต้องไม่กลับมา')
})

test('อัปโหลดและดาวน์โหลดจริง → ตัวเลขของวันนี้เพิ่มขึ้นตามจำนวนครั้งที่ทำจริง', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)

  const before = (await dash(c)).activity7d.find((r) => r.date === todayIso())
  assert.ok(before, 'ต้องมีแถวของวันนี้')

  // อัปโหลดสองครั้ง (ไฟล์ต่างกัน) + ดาวน์โหลดสามครั้ง
  const f1 = await upload(c, 'alpha')
  const f2 = await upload(c, 'beta')
  for (let i = 0; i < 3; i++) {
    const got = await c.raw(`/api/files/${encodeURIComponent(f1.id)}/download`)
    assert.equal(got.status, 200)
  }

  const after = (await dash(c)).activity7d.find((r) => r.date === todayIso())
  assert.equal(after.uploads - before.uploads, 2, 'ต้องนับการอัปโหลดสองครั้ง')
  assert.equal(after.downloads - before.downloads, 3, 'ต้องนับการดาวน์โหลดสามครั้ง')

  // ⚠️ กราฟต้องขยับ "เพราะการใช้งาน" ไม่ใช่เพราะเวลาเดินไป — ยิงซ้ำโดยไม่ทำอะไรต้องนิ่ง
  const again = (await dash(c)).activity7d.find((r) => r.date === todayIso())
  assert.equal(again.uploads, after.uploads, 'ไม่มีการใช้งานเพิ่ม ตัวเลขต้องไม่ขยับเอง')
  assert.equal(again.downloads, after.downloads)

  await c.req(`/api/files/${encodeURIComponent(f2.id)}`, { method: 'DELETE' })
})

test('อัปโหลดทับ (เวอร์ชันใหม่) ถูกนับเป็นกิจกรรมอัปโหลดด้วย', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName()
  const before = (await dash(c)).activity7d.find((r) => r.date === todayIso())

  await upload(c, 'v1', name)
  await upload(c, 'v2', name) // FILE_VERSION_ADD

  const after = (await dash(c)).activity7d.find((r) => r.date === todayIso())
  assert.equal(
    after.uploads - before.uploads, 2,
    'การอัปโหลดเวอร์ชันใหม่ก็คือการอัปโหลด — ต้องถูกนับ ไม่ใช่หายไปเพราะใช้ action ต่างกัน',
  )
})

test('เหตุการณ์ที่ล้มเหลวไม่ถูกนับเป็นกิจกรรมสำเร็จ', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = new Client(baseUrl)
  const before = (await dash(c)).activity7d.find((r) => r.date === todayIso())

  // ดาวน์โหลดไฟล์ที่ไม่มีอยู่ (404) และคำขอที่ไม่ได้ล็อกอิน (401) — ทั้งคู่ไม่ใช่กิจกรรมสำเร็จ
  assert.equal((await c.req('/api/files/999999999/download')).status, 404)
  assert.equal((await other.req('/api/files/1/download')).status, 401)

  const after = (await dash(c)).activity7d.find((r) => r.date === todayIso())
  assert.equal(
    after.downloads, before.downloads,
    '⚠️ คำขอที่ล้มเหลวต้องไม่ทำให้กราฟดูมีกิจกรรมมากกว่าความจริง',
  )
})

// ═══ C + D. ตัวเลขพื้นที่และจำนวนเป็นของจริง ═══════════════════════════════════════

test('ตัวเลขพื้นที่มาจาก statfs จริง ไม่ใช่ค่าคงที่ 342 GB / 1024 GB เดิม', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const m = (await dash(c)).metrics

  assert.equal('storageGB' in m, false, 'ฟิลด์ storageGB (มี baseline 342 บวกอยู่) ต้องหายไป')
  assert.equal('storageTotalGB' in m, false, 'ฟิลด์ storageTotalGB (ค่าคงที่ 1024) ต้องหายไป')

  assert.ok(m.storageTotalBytes > 0, 'ความจุรวมต้องอ่านได้ในสภาพแวดล้อมของเทสต์')
  assert.ok(m.storageBytes >= 0 && m.storageBytes <= m.storageTotalBytes, 'ใช้ไปต้องไม่เกินความจุ')
  assert.notEqual(m.storageTotalBytes, 1024 * 1e9, 'ความจุต้องไม่ใช่ค่าคงที่เดิม')

  // ต้องตรงกับที่ /api/storage รายงาน — สองจอต้องไม่พูดคนละเรื่องเรื่องเดียวกัน
  const s = (await c.req('/api/storage')).data
  assert.equal(m.storageTotalBytes, s.capacityBytes.totalBytes, 'Dashboard และ Storage ต้องใช้แหล่งเดียวกัน')

  // dataLakeBytes = สิ่งที่ "แอปนี้" เก็บ ซึ่งต่างจากพื้นที่ที่ใช้ไปทั้ง volume
  assert.equal(typeof m.dataLakeBytes, 'number')
  assert.ok(m.dataLakeBytes >= 0)
})

test('จำนวนไฟล์และลิงก์ที่เปิดอยู่ตรงกับของจริง (สร้างแล้วตัวเลขขยับตาม)', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const before = (await dash(c)).metrics

  const file = await upload(c, 'metrics probe')
  const afterUpload = (await dash(c)).metrics
  assert.equal(afterUpload.files - before.files, 1, 'จำนวนไฟล์ต้องเพิ่มหนึ่ง')
  assert.equal(
    afterUpload.dataLakeBytes - before.dataLakeBytes, Buffer.byteLength('metrics probe'),
    'ขนาดรวมต้องเพิ่มเท่าขนาดไฟล์จริง',
  )

  const share = await c.req('/api/shares', {
    method: 'POST', body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(share.status, 201)
  const afterShare = (await dash(c)).metrics
  assert.equal(afterShare.activeShares - before.activeShares, 1, 'ลิงก์ที่เปิดอยู่ต้องเพิ่มหนึ่ง')

  // เพิกถอนแล้วต้องลดลง — "ลิงก์ที่เปิดอยู่" ต้องหมายความอย่างนั้นจริง
  await c.req(`/api/shares/${share.data.share.id}`, { method: 'DELETE' })
  const afterRevoke = (await dash(c)).metrics
  assert.equal(afterRevoke.activeShares, before.activeShares, 'เพิกถอนแล้วต้องไม่ถูกนับอีก')

  await c.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
  assert.equal((await dash(c)).metrics.files, before.files, 'ลบไฟล์แล้วจำนวนต้องกลับเท่าเดิม')
})

test('ลิงก์ที่หมดอายุไม่ถูกนับหรือส่งเป็น active share', {
  skip: usingPostgres ? false : 'ต้องเลื่อน expires_at ในฐานทดสอบเพื่อพิสูจน์ expiry โดยไม่รอจริง',
}, async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(c, 'expired share count probe')
  const created = await c.req('/api/shares', {
    method: 'POST', body: { fileId: file.id, expiry: '1h', authType: 'none', scope: 'any' },
  })
  assert.equal(created.status, 201)

  await query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [created.data.share.id])

  const dashboard = await dash(c)
  assert.equal(
    dashboard.shares.some((s) => String(s.id) === String(created.data.share.id)),
    false,
    'Dashboard active-link sample ต้องไม่รวมลิงก์หมดอายุ',
  )
  const listed = await c.req('/api/shares')
  assert.equal(
    listed.data.shares.some((s) => String(s.id) === String(created.data.share.id)),
    false,
    'หน้าลิงก์ที่ใช้งานอยู่ต้องไม่คืนลิงก์หมดอายุ',
  )

  await c.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})

test('recentFiles มาจากไฟล์จริง และไม่มีชื่อไฟล์เดโม่ที่เคย hard-code ไว้', async () => {
  const c = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName()
  await upload(c, 'recent probe', name)

  const d = await dash(c)
  assert.ok(Array.isArray(d.recentFiles))
  assert.ok(d.recentFiles.length <= 5, 'คืนไม่เกินห้ารายการ')
  assert.ok(d.recentFiles.some((f) => f.name === name), 'ไฟล์ที่เพิ่งอัปโหลดต้องอยู่ในรายการล่าสุด')

  if (usingPostgres) {
    // ชื่อไฟล์เดโม่ที่อยู่ในอาเรย์ in-memory ของ store.js ต้องไม่โผล่ในโหมด Postgres
    const dump = JSON.stringify(d.recentFiles)
    for (const fake of ['Q2-2026_Financial-Report_FINAL', 'network-topology_edge-site-A', 'factory-cam_incident']) {
      assert.ok(!dump.includes(fake), `'${fake}' เป็นแถวเดโม่ของโหมด dev — ต้องไม่โผล่ในโหมด Postgres`)
    }
  }
})
