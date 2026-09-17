// tests/filesKindIdentity.test.js — FILES-MANAGEMENT-UX-1 · Phase 1 + Phase 3
//
// ⚠️ บั๊กที่ชุดนี้ถอนรากถอนโคน:
//    เดิม "โฟลเดอร์" ถูกตัดสินจาก **ชื่อไฟล์** — `typeExtFromName()` บอกว่าชื่อที่ไม่มีจุด
//    คือโฟลเดอร์ ผลคือไฟล์ชื่อ `README` แสดงเป็นโฟลเดอร์ และการเปลี่ยนชื่อ `report.pdf`
//    เป็น `report` จะ "แปลงร่าง" ไฟล์เป็นโฟลเดอร์เงียบ ๆ ทั้งที่ไบต์ยังเป็น PDF อยู่
//
//    ตัวตนของ entity ต้องเป็นข้อเท็จจริงที่เก็บไว้ (`files.kind`) ไม่ใช่การเดาจากสตริง
//    นามสกุลเหลือหน้าที่เดียว: บอก "ชนิดย่อยสำหรับแสดงผล" ของสิ่งที่เป็นไฟล์อยู่แล้ว
//
// ⚠️ Phase 1 — การ backfill ต้อง **ล้มแบบปิด** ไม่ใช่เดาให้:
//    ห้ามใช้ heuristic ของนามสกุลมา backfill เพราะนั่นคือบั๊กที่กำลังลบทิ้ง
//    หลักฐานที่ใช้ได้คือ "ธรรมเนียมการสร้างแถว" ซึ่งคงทนและไม่ขึ้นกับชื่อ:
//      โฟลเดอร์ (pgCreateFolder) → path '/datalake/<name>', size 0, ไม่มี sha256
//      ไฟล์ (V1 pgRecordUpload / V2 commit) → path 'uploads/<uuid>.bin', มี sha256
//    แถวที่ไม่เข้าทั้งสองแบบ = AMBIGUOUS → หยุด ให้เจ้าของตัดสิน ไม่ใช่เดาแทน
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let vite
let classifier

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  classifier = await vite.ssrLoadModule('/server/db/legacyKindClassifier.js')
})

after(async () => {
  await vite?.close()
})

/* ── แถวดิบแบบที่อยู่ในตาราง files จริง ─────────────────────────────────── */

const uploadedRow = (over = {}) => ({
  id: 1, name: 'report.pdf', path: 'uploads/5f2c1a90-1d4e-4c8b-9a71-0b3e5d6c7a81.bin',
  size_bytes: 4_812_339, sha256: 'a'.repeat(64), ...over,
})

const folderRow = (over = {}) => ({
  id: 2, name: 'Invoices', path: '/datalake/Invoices',
  size_bytes: 0, sha256: null, ...over,
})

/* ══ Phase 1 · ตัวจำแนกแถวเก่า ═══════════════════════════════════════════ */

test('KIND 1 · an uploaded row is proven a file by its storage key, whatever it is named', () => {
  // ชื่อที่ไม่มีจุดเลย — heuristic เดิมจะเรียกมันว่าโฟลเดอร์ หลักฐานจริงบอกว่าไฟล์
  assert.equal(classifier.classifyLegacyRow(uploadedRow({ name: 'README' })), 'file')
  assert.equal(classifier.classifyLegacyRow(uploadedRow({ name: 'Makefile' })), 'file')
  assert.equal(classifier.classifyLegacyRow(uploadedRow()), 'file')
  // ไฟล์ว่าง 0 ไบต์ยังเป็นไฟล์: chunkedUpload แฮชสตริงว่างเสมอ sha จึงไม่เคยเป็น null
  assert.equal(classifier.classifyLegacyRow(uploadedRow({ size_bytes: 0, sha256: 'e'.repeat(64) })), 'file')
})

test('KIND 2 · a created folder is proven a folder by its creation convention, dots and all', () => {
  assert.equal(classifier.classifyLegacyRow(folderRow()), 'folder')
  // ชื่อมีจุด — heuristic เดิมจะเรียกมันว่า Archive หลักฐานจริงบอกว่าโฟลเดอร์
  assert.equal(classifier.classifyLegacyRow(folderRow({ name: 'Invoices.2026', path: '/datalake/Invoices.2026' })), 'folder')
})

test('KIND 3 · anything that matches neither convention is ambiguous, never guessed', () => {
  // path ของอัปโหลดแต่ไม่มี sha — พิสูจน์ไม่ได้ว่าไบต์คืออะไร
  assert.equal(classifier.classifyLegacyRow(uploadedRow({ sha256: null })), 'ambiguous')
  // ไม่ใช่ path อัปโหลด แต่มีขนาด — ไม่ใช่โฟลเดอร์ที่ระบบนี้เคยสร้าง
  assert.equal(classifier.classifyLegacyRow(folderRow({ size_bytes: 1024 })), 'ambiguous')
  // ไม่ใช่ path อัปโหลด แต่มี sha
  assert.equal(classifier.classifyLegacyRow(folderRow({ sha256: 'b'.repeat(64) })), 'ambiguous')
  assert.equal(classifier.classifyLegacyRow({ id: 9, name: 'x', path: null, size_bytes: 0, sha256: null }), 'ambiguous')
})

test('KIND 4 · the preflight counts every row and never uses the filename as evidence', async () => {
  const rows = [
    uploadedRow({ id: 1, name: 'README' }),          // file (ไม่มีนามสกุล)
    uploadedRow({ id: 2, name: 'a.pdf' }),           // file
    folderRow({ id: 3, name: 'Invoices.2026' }),     // folder (มีจุด)
    folderRow({ id: 4, name: 'Reports' }),           // folder
    uploadedRow({ id: 5, sha256: null }),            // ambiguous
  ]
  const report = await classifier.legacyKindPreflight({ query: async () => ({ rows }) })

  assert.equal(report.totalRows, 5)
  assert.equal(report.provenFiles, 2)
  assert.equal(report.provenFolders, 2)
  assert.equal(report.ambiguousRows, 1)
  assert.equal(report.safeToBackfill, false, 'มีแถวกำกวม = ยังห้าม backfill')
})

test('KIND 5 · the preflight reports ambiguous rows for review without leaking content or secrets', async () => {
  const rows = [uploadedRow({ id: 77, name: 'payroll-2026.xlsx', sha256: null })]
  const report = await classifier.legacyKindPreflight({ query: async () => ({ rows }) })

  assert.equal(report.ambiguousRows, 1)
  const [sample] = report.ambiguousSamples
  assert.equal(sample.id, 77)
  // ⚠️ ต้องพอให้เจ้าของตัดสินได้ แต่ห้ามเป็นช่องทางรั่วของ checksum หรือตำแหน่งไบต์จริง
  assert.equal(sample.hasSha, false)
  assert.equal(sample.sizeBytes, 4_812_339)
  assert.equal(typeof sample.pathPrefix, 'string')
  assert.equal(Object.hasOwn(sample, 'sha256'), false, 'ห้ามคืน checksum ดิบ')
  assert.equal(Object.hasOwn(sample, 'path'), false, 'ห้ามคืน storage key เต็ม')
})

test('KIND 6 · a clean estate is explicitly declared safe to backfill', async () => {
  const rows = [uploadedRow({ id: 1 }), folderRow({ id: 2 })]
  const report = await classifier.legacyKindPreflight({ query: async () => ({ rows }) })
  assert.equal(report.ambiguousRows, 0)
  assert.deepEqual(report.ambiguousSamples, [])
  assert.equal(report.safeToBackfill, true)
})

/* ══ Phase 2 · การย้ายสคีมาต้องล้มแบบปิด ════════════════════════════════ */

test('KIND 7 · the migration refuses to finish while any row has an unresolved kind', async () => {
  const fs = await import('node:fs/promises')
  const sql = await fs.readFile(new URL('../server/db/migrations/010_files_kind_parent.sql', import.meta.url), 'utf8')

  // ⚠️ ข้อบังคับของ Phase 1: ถ้า backfill แล้วยังมี kind IS NULL เหลืออยู่ การย้ายสคีมา
  //    ต้องระเบิดทิ้งทั้ง transaction ไม่ใช่ปล่อยแถวที่เดาผิดเข้าสู่ production เงียบ ๆ
  assert.match(sql, /RAISE EXCEPTION/i, 'ต้องมีการหยุดแบบล้มปิดเมื่อจำแนกไม่ครบ')
  assert.match(sql, /kind IS NULL/i)
  assert.match(sql, /ALTER TABLE files\s+ADD COLUMN[\s\S]*kind/i)
  assert.match(sql, /parent_id[\s\S]*REFERENCES files\s*\(\s*id\s*\)[\s\S]*ON DELETE RESTRICT/i)
  assert.match(sql, /CHECK\s*\(\s*kind IN \('file',\s*'folder'\)\s*\)/i)
  assert.match(sql, /SET NOT NULL/i)
  assert.match(sql, /CREATE INDEX[\s\S]*parent_id/i)
  // และต้องไม่ backfill ด้วย heuristic ของนามสกุล ซึ่งคือบั๊กที่กำลังลบทิ้ง
  assert.doesNotMatch(sql, /position\('\.'|strpos\([^)]*'\.'|name LIKE '%\.%'/i,
    'ห้าม backfill จากชื่อไฟล์ — นั่นคือ heuristic ที่งานนี้กำลังกำจัด')
})

/* ══ Round 5 · หลักฐานโฟลเดอร์ต้องเป็น "เชิงบวก" ไม่ใช่แค่ไม่ใช่ไฟล์ ══════════
 *
 * ⚠️ ข้อบกพร่องที่ชุดนี้ปิด: ตัวจำแนกเดิมยอมรับ path ใด ๆ ที่ไม่ได้อยู่ใต้ uploads/
 *    ว่าเป็นโฟลเดอร์ นั่นคือหลักฐานเชิงลบ — "ไม่ใช่ไฟล์" ไม่ได้แปลว่า "เป็นโฟลเดอร์"
 *    แถวอย่าง path='legacy/unknown' size 0 sha NULL ไม่เข้ากับธรรมเนียมการสร้าง
 *    แบบใดเลย และเราไม่รู้ว่าใน Production มีแถวแบบนี้หรือไม่ (ยังไม่ได้วัด)
 *    หลักฐานโฟลเดอร์ที่พิสูจน์ได้จริงมีแบบเดียว: path ที่ pgCreateFolder เขียนเอง
 */

const provenFolderPath = '/datalake/'

test('KIND 8 · only the exact folder creation convention proves a folder; every other non-upload path is ambiguous', () => {
  const bare = { id: 3, name: 'unknown' }
  // (1) ไฟล์: storage key ของการอัปโหลด + checksum
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: 'uploads/9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d.bin', size_bytes: 12, sha256: 'c'.repeat(64) }), 'file')
  // (2) โฟลเดอร์: path ตามธรรมเนียม pgCreateFolder เท่านั้น
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: '/datalake/folder', size_bytes: 0, sha256: null }), 'folder')
  // (3) path ที่ไม่ใช่ทั้ง uploads/ และ /datalake/ — ห้ามกลายเป็นโฟลเดอร์เงียบ ๆ
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: 'legacy/unknown', size_bytes: 0, sha256: null }), 'ambiguous')
  // (4) path อื่นที่ขึ้นต้นด้วย / ก็ไม่ใช่หลักฐาน
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: '/other/path', size_bytes: 0, sha256: null }), 'ambiguous')
  // (5) path หายไป
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: null, size_bytes: 0, sha256: null }), 'ambiguous')
  // (6) path ว่าง
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: '', size_bytes: 0, sha256: null }), 'ambiguous')
  // (7) path ถูกแต่มีขนาด — โฟลเดอร์ไม่มีไบต์
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: '/datalake/foo', size_bytes: 1024, sha256: null }), 'ambiguous')
  // (8) path ถูกแต่มี checksum — โฟลเดอร์ไม่เคยถูกแฮช
  assert.equal(classifier.classifyLegacyRow({ ...bare, path: '/datalake/foo', size_bytes: 0, sha256: 'd'.repeat(64) }), 'ambiguous')
  // ตัวจำแนกต้องประกาศคำนำหน้าที่ใช้ เพื่อให้ migration ตรึงค่าเดียวกันได้
  assert.equal(classifier.FOLDER_PATH_PREFIX, provenFolderPath)
})

test('KIND 9 · migration 010 and the classifier use the same positive folder predicate', async () => {
  const fs = await import('node:fs/promises')
  const sql = await fs.readFile(new URL('../server/db/migrations/010_files_kind_parent.sql', import.meta.url), 'utf8')
  // ตรวจเฉพาะ SQL ที่รันจริง — คอมเมนต์อธิบายกติกาเก่าไม่ใช่ predicate
  const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

  const folderUpdate = executable.match(/UPDATE files\s+SET kind = 'folder'\s+WHERE([\s\S]*?);/i)
  assert.ok(folderUpdate, 'ต้องมี backfill สำหรับโฟลเดอร์')
  const predicate = folderUpdate[1]
  // predicate เชิงบวก: คำนำหน้าเดียวกับ classifier ตัวต่อตัว
  assert.match(predicate, new RegExp(`path LIKE '${classifier.FOLDER_PATH_PREFIX.replace(/\//g, '\/')}%'`),
    'โฟลเดอร์ต้องพิสูจน์จาก path ตามธรรมเนียม pgCreateFolder เท่านั้น')
  assert.match(predicate, /size_bytes = 0/)
  assert.match(predicate, /sha256 IS NULL/)
  // ห้ามหลักฐานเชิงลบ: "ไม่ใช่ storage key ของการอัปโหลด" ไม่ได้พิสูจน์อะไร
  assert.doesNotMatch(predicate, /NOT LIKE/i, 'ห้ามจำแนกโฟลเดอร์จากการ "ไม่ใช่ไฟล์"')
  assert.doesNotMatch(executable, /NOT LIKE 'uploads\/%'/i)

  const fileUpdate = executable.match(/UPDATE files\s+SET kind = 'file'\s+WHERE([\s\S]*?);/i)
  assert.ok(fileUpdate)
  assert.match(fileUpdate[1], new RegExp(`path LIKE '${classifier.UPLOAD_KEY_PREFIX}%'`))
  assert.match(fileUpdate[1], /sha256 IS NOT NULL/)
})

test('KIND 10 · an unknown non-upload path is ambiguous and blocks both backfill and migration', async () => {
  const rows = [
    uploadedRow({ id: 1, uploaded_by: 7, deleted_at: null }),
    folderRow({ id: 2, uploaded_by: 7, deleted_at: null }),
    { id: 3, name: 'unknown', path: 'legacy/unknown', size_bytes: 0, sha256: null, uploaded_by: 7, deleted_at: null },
  ]
  const report = await classifier.legacyKindPreflight({ query: async () => ({ rows }) })
  assert.equal(report.provenFiles, 1)
  assert.equal(report.provenFolders, 1)
  assert.equal(report.ambiguousRows, 1)
  assert.equal(report.duplicateActiveNameGroups, 0)
  assert.equal(report.safeToBackfill, false, 'แถวที่พิสูจน์ไม่ได้ = ห้าม backfill')
  assert.equal(report.safeToMigrate, false, 'และห้ามย้ายสคีมา แม้ชื่อจะไม่ซ้ำเลย')
  assert.equal(report.ambiguousSamples[0].id, 3)
  assert.equal(report.ambiguousSamples[0].pathPrefix, 'legacy/')
})
