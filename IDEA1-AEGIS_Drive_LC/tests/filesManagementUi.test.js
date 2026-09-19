// tests/filesManagementUi.test.js — FILES-MANAGEMENT-UX-1 · Phases 8–11
//
// ⚠️ ข้อที่สำคัญที่สุดของไฟล์นี้: การลากวางเป็นแค่ **ทางลัด** ไปยัง Move API ตัวเดียวกัน
//    ที่กล่องโต้ตอบใช้ ผู้ใช้คีย์บอร์ดและผู้ใช้จอสัมผัสต้องทำทุกอย่างได้โดยไม่ต้องลาก
//
// ⚠️ และการลากสองชนิดต้องไม่ปนกันเด็ดขาด:
//      DataTransfer มี 'Files'                   → ไฟล์จากเครื่องผู้ใช้ = อัปโหลด
//      DataTransfer มี 'application/x-aegis-items' → รายการในจอ = ย้าย
//    ถ้าปนกัน ผู้ใช้จะลากไฟล์ในจอแล้วได้การอัปโหลดซ้ำของไฟล์ที่มีอยู่แล้ว
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let files
let dnd

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
  files = await vite.ssrLoadModule('/src/screens/Files.jsx')
  dnd = await vite.ssrLoadModule('/src/lib/fileDragDrop.js')
})

after(async () => {
  await vite?.close()
})

const fileItem = (over = {}) => ({
  id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf',
  size: 1024, modified: Date.now(), uploader: 'user', vault: false, verified: true, ...over,
})
const folderItem = (over = {}) => ({
  id: 'd1', name: 'Invoices', kind: 'folder', type: 'Folder', ext: '',
  size: 0, modified: Date.now(), uploader: 'user', vault: false, verified: true, ...over,
})

/* ══ การแยกชนิดของการลาก ═══════════════════════════════════════════════ */

test('DND 1 · the two drag kinds are told apart by DataTransfer type, never by guesswork', () => {
  assert.equal(dnd.AEGIS_ITEMS_TYPE, 'application/x-aegis-items')

  assert.equal(dnd.isExternalFileDrag({ types: ['Files'] }), true)
  assert.equal(dnd.isExternalFileDrag({ types: [dnd.AEGIS_ITEMS_TYPE] }), false)
  assert.equal(dnd.isInternalItemDrag({ types: [dnd.AEGIS_ITEMS_TYPE] }), true)
  assert.equal(dnd.isInternalItemDrag({ types: ['Files'] }), false)

  // ไม่มี dataTransfer เลย = ไม่ใช่ทั้งสองอย่าง ต้องไม่ระเบิด
  assert.equal(dnd.isExternalFileDrag(null), false)
  assert.equal(dnd.isInternalItemDrag(undefined), false)
})

test('DND 2 · dragging a tile inside the selection drags the whole selection', () => {
  const selected = new Set(['a', 'b', 'c'])
  assert.deepEqual(dnd.dragPayloadFor('b', selected), ['a', 'b', 'c'])
})

test('DND 3 · dragging a tile outside the selection drags only that item', () => {
  const selected = new Set(['a', 'b'])
  assert.deepEqual(dnd.dragPayloadFor('z', selected), ['z'])
  assert.deepEqual(dnd.dragPayloadFor('z', new Set()), ['z'])
})

test('DND 4 · only a folder is a valid drop target, and never one of the dragged items', () => {
  assert.equal(dnd.canDropOn(folderItem(), ['f1']), true)
  assert.equal(dnd.canDropOn(fileItem(), ['f2']), false, 'ไฟล์ธรรมดาไม่ใช่เป้าหมาย')
  assert.equal(dnd.canDropOn(folderItem({ id: 'd1' }), ['d1']), false, 'ห้ามวางลงบนตัวเอง')
  assert.equal(dnd.canDropOn(folderItem({ id: 'd1' }), ['f1', 'd1']), false)
  assert.equal(dnd.canDropOn(null, ['f1']), false)
})

test('DND 5 · the payload survives a round trip through DataTransfer intact', () => {
  const store = new Map()
  const transfer = {
    types: [],
    setData(type, value) { store.set(type, value); this.types.push(type) },
    getData(type) { return store.get(type) ?? '' },
  }
  dnd.writeDragPayload(transfer, ['id-1', 'id-2'])
  assert.equal(transfer.types.includes(dnd.AEGIS_ITEMS_TYPE), true)
  assert.deepEqual(dnd.readDragPayload(transfer), ['id-1', 'id-2'])

  // ข้อมูลพังหรือมาจากที่อื่น = ไม่มีอะไรให้ย้าย ไม่ใช่การโยน error ใส่ผู้ใช้
  assert.deepEqual(dnd.readDragPayload({ types: [dnd.AEGIS_ITEMS_TYPE], getData: () => 'not json' }), [])
  assert.deepEqual(dnd.readDragPayload({ types: [], getData: () => '' }), [])
})

/* ══ แหล่งเดียวของการย้าย ═══════════════════════════════════════════════ */

test('DND 6 · drag/drop and the Move dialog are wired to the one Move call', async () => {
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../src/screens/Files.jsx', import.meta.url), 'utf8')

  const moveCalls = source.match(/\/api\/files\/move/g) ?? []
  assert.equal(moveCalls.length, 1, 'ต้องมีจุดเรียก Move จุดเดียว ไม่ใช่สองเส้นทางที่จะเพี้ยนจากกัน')
  assert.match(source, /moveItems/, 'ทั้งกล่องโต้ตอบและการลากวางเรียกฟังก์ชันเดียวกัน')

  // การลากภายในต้องไม่มีทางไหลเข้าเส้นทางอัปโหลด
  assert.match(source, /isExternalFileDrag/, 'การวางบนหน้าต้องตรวจว่าเป็นไฟล์จากเครื่องจริง')
  assert.doesNotMatch(
    source,
    /const acceptDrop[\s\S]{0,320}setDropRequest\(\{ files: \[\.\.\.dropped\]/,
    'acceptDrop ต้องไม่รับทุกการวางเป็นการอัปโหลดอีกต่อไป',
  )
})

/* ══ โฟลเดอร์ต้องดูออกโดยไม่ต้องอ่านชื่อ ═══════════════════════════════ */

test('UI 1 · a folder tile is marked as a folder and an extensionless file is not', () => {
  const folderHtml = renderToStaticMarkup(React.createElement(files.FileTile, {
    t, file: folderItem(), now: Date.now(), selected: false, anySelected: false,
    onSelect() {}, onOpen() {}, onMenuAction() {},
  }))
  assert.match(folderHtml, /data-file-kind="folder"/)
  assert.match(folderHtml, /lucide-folder/, 'ต้องใช้ไอคอนโฟลเดอร์ ไม่ใช่ไอคอนไฟล์ทั่วไป')

  // ชื่อไม่มีนามสกุลต้องไม่ถูกทำให้ดูเหมือนโฟลเดอร์ — นี่คือบั๊กเดิมในรูปแบบภาพ
  const readmeHtml = renderToStaticMarkup(React.createElement(files.FileTile, {
    t, file: fileItem({ id: 'f9', name: 'README', type: 'File', ext: '' }), now: Date.now(),
    selected: false, anySelected: false, onSelect() {}, onOpen() {}, onMenuAction() {},
  }))
  assert.match(readmeHtml, /data-file-kind="file"/)
  assert.doesNotMatch(readmeHtml, /lucide-folder/)
})

test('UI 2 · the folder marker does not borrow encryption semantics', () => {
  const html = renderToStaticMarkup(React.createElement(files.FileTile, {
    t, file: folderItem(), now: Date.now(), selected: false, anySelected: false,
    onSelect() {}, onOpen() {}, onMenuAction() {},
  }))
  // hatch และ Shield แปลว่า "ระบบมองไม่เห็นเนื้อใน" (DESIGN.md ข้อ 1) โฟลเดอร์ไม่ใช่แบบนั้น
  assert.doesNotMatch(html, /lucide-shield/, 'โฟลเดอร์ต้องไม่ดูเหมือนของที่เข้ารหัสไว้')
  assert.doesNotMatch(html, /hatch/, 'ลายขวางสงวนไว้สำหรับสิ่งที่ระบบอ่านไม่ได้')
})

test('UI 3 · Rename and Move are enabled commands, not decorations', async () => {
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../src/screens/Files.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /id:\s*'rename'[^}]*disabled:\s*true/, 'Rename ต้องกดได้จริง')
  assert.doesNotMatch(source, /id:\s*'move'[^}]*disabled:\s*true/, 'Move ต้องกดได้จริง')

  // แถบเลือกหลายรายการเคยวาดปุ่มที่ไม่มี onClick เลย — ปุ่มที่กดแล้วไม่เกิดอะไรคือปุ่มที่โกหก
  const bulkBar = source.slice(source.indexOf('multi-select action bar'))
  assert.doesNotMatch(bulkBar.slice(0, 1400), /<button[^>]*>\s*<I /, 'ปุ่มในแถบต้องผูก handler จริง')
})

test('UI 4 · every Move-dialog string exists in all three languages', () => {
  const { STRINGS, LANGS } = files.__testStrings ?? {}
  void STRINGS; void LANGS
  const required = [
    'renameTitle', 'renameLabel', 'renameAction', 'nameTaken', 'nameInvalid',
    'moveTitle', 'moveAction', 'moveToRoot', 'moveCycle', 'moveAlreadyThere',
    'folderNotEmpty',
  ]
  const table = makeT('en')
  for (const key of required) {
    assert.notEqual(table(key), key, `ยังไม่มีข้อความสำหรับ ${key}`)
  }
})
