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
