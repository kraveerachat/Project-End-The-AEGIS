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
let UploadDrawer

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
  })
  ;({ UploadDrawer } = await vite.ssrLoadModule('/src/components/UploadDrawer.jsx'))
})

after(async () => {
  await vite?.close()
})

test('Upload Drawer truthfully shows the current destination and keeps recent uploads in Files', () => {
  const html = renderToStaticMarkup(React.createElement(UploadDrawer, {
    t,
    open: true,
    destination: '/Files',
    onClose() {},
    recentFiles: [],
  }))

  assert.match(html, /role="dialog"/)
  assert.match(html, /Upload files/i)
  assert.match(html, /Destination folder/i)
  assert.match(html, /\/Files/)
  assert.match(html, /Drop files here/i)
  assert.match(html, /Choose files/i)
  assert.match(html, /Recent uploads/i)
  assert.match(html, /No uploads yet/i)
  assert.doesNotMatch(html, /0 Mbps|0 ms|0 °C/)
  // ⚠️ FILES-UPLOAD-UX-1: ลิ้นชักใหญ่เลิกเป็นจอเฝ้าคิวแล้ว ถาดมุมขวาล่างเป็นเจ้าของ
  //    เรื่องนั้นคนเดียว การมีคิวสองชุดบนจอคือที่มาของตัวเลขที่ขัดกันเอง
  assert.doesNotMatch(html, /Upload queue/i)
  assert.doesNotMatch(html, /Cancel all/i)
})

test('a queued upload is monitored by the bottom-right tray, not by the large drawer', () => {
  const html = renderToStaticMarkup(React.createElement(UploadDrawer, {
    t,
    open: false,
    destination: '/Files',
    onClose() {},
    recentFiles: [],
    initialQueue: [{ id: 'q1', name: 'report.pdf', size: 42, stage: 'waiting', progress: null }],
  }))

  assert.doesNotMatch(html, /role="dialog"/, 'ลิ้นชักใหญ่ต้องปิดอยู่')
  assert.match(html, /data-upload-tray="expanded"/)
  assert.match(html, /report\.pdf/)
  // ⚠️ ยังไม่มีไบต์ใดออกจากเครื่อง หัวถาดจึงต้องพูดว่ากำลังตรวจไฟล์ ไม่ใช่กำลังอัปโหลด
  assert.match(html, /Checking 1 file/i)
  assert.doesNotMatch(html, /Uploading 1 item/i)
  // ปุ่มซ่อนกับปุ่มยกเลิกต้องเป็นคนละคำสั่งกันเสมอ
  assert.match(html, /data-upload-tray-hide/)
  assert.match(html, /aria-label="Hide upload status"/)
})
