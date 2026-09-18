// tests/filesVisualHierarchy.test.js — FILES-MANAGEMENT-UX-1 · Round 8
//
// ⚠️ สิ่งที่ Human Owner เห็นบน Production: โฟลเดอร์ `01` นอนอยู่ในกริดเดียวกับไฟล์
//    ไอคอนต่างกันแต่ "รูปร่าง" เหมือนกันทุกประการ ผู้ใช้จึงยังต้องอ่านทีละใบว่าอันไหนเปิดได้
//    ตัวตน (`kind`) ถูกเก็บแล้วในรอบก่อน รอบนี้ทำให้ตัวตนนั้น "มองเห็นได้ทางกายภาพ":
//    โฟลเดอร์อยู่ในส่วนของตัวเอง เหนือไฟล์เสมอ และมีรูปทรงกะทัดรัดที่ไม่ใช่การ์ดสื่อ
//
// ⚠️ และไฟล์ภาพ/วิดีโอปกติต้องแสดง "เนื้อใน" จริง ไม่ใช่ไอคอนทั่วไป — แต่เฉพาะไฟล์ปกติ
//    เท่านั้น: Private Vault เป็น ciphertext ที่เซิร์ฟเวอร์มองไม่เห็นเนื้อใน การให้
//    thumbnail แบบเดียวกันคือการโกหกเรื่องขอบเขตการเข้ารหัส
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let files
let view

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
  view = await vite.ssrLoadModule('/src/lib/filesView.js')
})

after(async () => {
  await vite?.close()
})

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const NOW = 1_800_000_000_000
const fileItem = (over = {}) => ({
  id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf',
  size: 1024, modified: NOW, uploader: 'user', vault: false, verified: true, ...over,
})
const folderItem = (over = {}) => ({
  id: 'd1', name: '01', kind: 'folder', type: 'Folder', ext: '',
  size: 0, modified: NOW, uploader: 'user', vault: false, verified: true, ...over,
})
const SHA_A = 'a'.repeat(64)
const image = (over = {}) => fileItem({ id: 'img1', name: 'photo.jpg', type: 'Image', ext: 'jpg', sha256: SHA_A, ...over })

const noop = () => {}
const tileMarkup = (file, extra = {}) => renderToStaticMarkup(React.createElement(files.FileTile, {
  t, file, now: NOW, selected: false, anySelected: false,
  onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false, ...extra,
}))
const folderTileMarkup = (file, extra = {}) => renderToStaticMarkup(React.createElement(files.FolderTile, {
  t, file, now: NOW, selected: false, anySelected: false,
  onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false, ...extra,
}))
const menuMarkup = (file) => renderToStaticMarkup(React.createElement(files.FileMenu, { t, file, onAction: noop, onClose: noop }))
const sectionsMarkup = (props) => renderToStaticMarkup(React.createElement(files.FilesSections, {
  t, now: NOW, view: 'grid', selectedIds: new Set(), draggingIds: [],
  onSelect: noop, onOpen: noop, onMenuAction: noop, onDragStartItem: noop, onDropItems: noop,
  onOpenDetail: noop, tileRef: () => noop, ...props,
}))

/** ตำแหน่งของ marker ใน markup — ใช้พิสูจน์ "ลำดับ" โดยไม่ผูกกับ CSS class */
const indexOf = (html, needle) => {
  const i = html.indexOf(needle)
  assert.notEqual(i, -1, `markup ต้องมี ${needle}`)
  return i
}

/* ══ R8-FOLDER — โฟลเดอร์เป็นส่วนของตัวเอง ══════════════════════════════════ */

test('R8-FOLDER-1 · items are partitioned by durable kind, never by name or extension', () => {
  const readme = fileItem({ id: 'f2', name: 'README', ext: '', type: 'File' })      // ไฟล์ไม่มีจุด
  const dotted = folderItem({ id: 'd2', name: 'v2.0' })                              // โฟลเดอร์มีจุด
  const { folders, files: plain } = view.partitionByKind([fileItem(), readme, folderItem(), dotted])
  assert.deepEqual(folders.map((x) => x.id), ['d1', 'd2'])
  assert.deepEqual(plain.map((x) => x.id), ['f1', 'f2'])
  // ไม่มีอะไรหาย ไม่มีอะไรซ้ำ
  assert.equal(folders.length + plain.length, 4)
})

test('R8-FOLDER-2 · folders render before files in their own labelled section', () => {
  const html = sectionsMarkup({ folders: [folderItem()], files: [image(), fileItem()] })
  const foldersAt = indexOf(html, 'data-files-section="folders"')
  const filesAt = indexOf(html, 'data-files-section="files"')
  assert.ok(foldersAt < filesAt, 'ส่วนโฟลเดอร์ต้องมาก่อนส่วนไฟล์')
  // หัวข้อของแต่ละส่วนพูดชื่อส่วนจริง ๆ
  assert.ok(html.includes(t('sectionFolders')))
  assert.ok(html.includes(t('sectionFiles')))
  // ทุกไทล์ในส่วนโฟลเดอร์คือโฟลเดอร์ และไม่มีโฟลเดอร์หลุดไปอยู่ส่วนไฟล์
  const foldersHtml = html.slice(foldersAt, filesAt)
  const filesHtml = html.slice(filesAt)
  assert.equal((foldersHtml.match(/data-file-kind="folder"/g) ?? []).length, 1)
  assert.equal((foldersHtml.match(/data-file-kind="file"/g) ?? []).length, 0)
  assert.equal((filesHtml.match(/data-file-kind="file"/g) ?? []).length, 2)
  assert.equal((filesHtml.match(/data-file-kind="folder"/g) ?? []).length, 0)
})

test('R8-FOLDER-3 · the folder section uses a compact folder tile, physically unlike a file card', () => {
  const folder = folderTileMarkup(folderItem())
  const file = tileMarkup(fileItem())
  assert.match(folder, /data-tile-variant="folder-compact"/)
  assert.match(file, /data-tile-variant="file-card"/)
  // การ์ดไฟล์มีกล่อง thumbnail; ไทล์โฟลเดอร์ไม่มี — นี่คือความต่างเชิงรูปทรง ไม่ใช่แค่สีไอคอน
  assert.match(file, /data-thumb=/)
  assert.doesNotMatch(folder, /data-thumb=/)
  // แต่ยังคงเป็นเป้าวาง / เลือกได้ / มีเมนูเหมือนเดิม
  assert.match(folder, /data-file-kind="folder"/)
  assert.match(folder, /draggable="true"/)
  assert.match(folder, /role="checkbox"/)
  assert.match(folder, /aria-haspopup="menu"/)
  assert.ok(folder.includes('01'))
})

test('R8-FOLDER-4 · inside a folder the same folder-first sections apply', () => {
  const child = folderItem({ id: 'd-child', name: 'Child 02', parentId: 'd1' })
  const nested = image({ id: 'img-n', parentId: 'd1' })
  const html = sectionsMarkup({ folders: [child], files: [nested], folderId: 'd1' })
  assert.ok(indexOf(html, 'data-files-section="folders"') < indexOf(html, 'data-files-section="files"'))
  assert.ok(html.includes('Child 02'))
})

test('R8-FOLDER-5 · sorting applies inside each group and never intermixes folders with files', () => {
  const items = [
    fileItem({ id: 'fz', name: 'zeta.pdf', size: 5, modified: NOW - 1 }),
    folderItem({ id: 'db', name: 'beta', modified: NOW - 3 }),
    fileItem({ id: 'fa', name: 'alpha.pdf', size: 9, modified: NOW - 2 }),
    folderItem({ id: 'da', name: 'alpha', modified: NOW - 4 }),
  ]
  const byName = view.sectionItems(items, 'name')
  assert.deepEqual(byName.folders.map((x) => x.id), ['da', 'db'])
  assert.deepEqual(byName.files.map((x) => x.id), ['fa', 'fz'])
  const bySize = view.sectionItems(items, 'size')
  assert.deepEqual(bySize.files.map((x) => x.id), ['fa', 'fz'])
  const byModified = view.sectionItems(items, 'modified')
  assert.deepEqual(byModified.folders.map((x) => x.id), ['db', 'da'])
  assert.deepEqual(byModified.files.map((x) => x.id), ['fz', 'fa'])
})

test('R8-FOLDER-6 · search and type filter keep section identity; an empty section is hidden', () => {
  const items = [folderItem({ name: 'invoices' }), fileItem({ name: 'invoice-2026.pdf' }), image()]
  const hit = view.filterItems(items, { query: 'invoice', typeFilter: 'all' })
  const sections = view.sectionItems(hit, 'name')
  assert.deepEqual(sections.folders.map((x) => x.name), ['invoices'])
  assert.deepEqual(sections.files.map((x) => x.name), ['invoice-2026.pdf'])

  // กรองตามชนิด "Image" → ไม่มีโฟลเดอร์เหลือ → ส่วนโฟลเดอร์ต้องหายไป ไม่ใช่โชว์หัวข้อเปล่า
  const onlyImages = view.sectionItems(view.filterItems(items, { query: '', typeFilter: 'Image' }), 'name')
  assert.equal(onlyImages.folders.length, 0)
  const html = sectionsMarkup({ folders: onlyImages.folders, files: onlyImages.files })
  assert.doesNotMatch(html, /data-files-section="folders"/)
  assert.match(html, /data-files-section="files"/)
})

test('R8-FOLDER-7 · list view is folder-first and visibly grouped too', () => {
  const html = sectionsMarkup({ view: 'list', folders: [folderItem()], files: [fileItem()] })
  const foldersAt = indexOf(html, 'data-files-section-row="folders"')
  const filesAt = indexOf(html, 'data-files-section-row="files"')
  const folderRow = indexOf(html, 'data-file-kind="folder"')
  const fileRow = indexOf(html, 'data-file-kind="file"')
  assert.ok(foldersAt < folderRow && folderRow < filesAt && filesAt < fileRow)
})

/* ══ R8-PREVIEW — thumbnail และคำสั่ง Preview ═══════════════════════════════ */

test('R8-PREVIEW-1 · a supported normal image is a media tile: its thumbnail comes from the server poster derivative, never the preview route', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp']) {
    const f = image({ id: `i-${ext}`, name: `pic.${ext}`, ext })
    assert.equal(view.previewKindFor(f), 'image', ext)
    const html = tileMarkup(f)
    // SSR/ก่อน media-info: กล่อง media thumb + ไอคอน — ไม่มี <img> ที่ชี้ไปต้นฉบับ (poster src มาจาก media-info ตอน hydrate)
    assert.match(html, /data-media-thumb=""/)
    assert.match(html, /data-thumb="icon"/)
    assert.doesNotMatch(html, /\/api\/files\/[^"]*\/preview/, ext)
  }
  // ไม่มี path บนดิสก์รั่วออกมาใน markup
  assert.doesNotMatch(tileMarkup(image({ path: 'uploads/secret.bin' })), /uploads\//)
})

test('R8-PREVIEW-2 · GIF is a previewable image and is rendered as an image, not transcoded', async () => {
  const gif = image({ id: 'g1', name: 'loop.gif', ext: 'gif' })
  assert.equal(view.previewKindFor(gif), 'image')
  // Round 9/Tranche B: การ์ดตอนไม่ชี้เป็น poster นิ่งจากเซิร์ฟเวอร์ (ไม่โหลด GIF ที่เคลื่อนไหว) — ดู filesInteractionPolish R9-MOTION-6/7
  const idle = tileMarkup(gif)
  assert.match(idle, /data-thumb="icon"/)
  assert.match(idle, />GIF</, 'ป้าย GIF บอกความจริงก่อน poster มา')
  assert.doesNotMatch(idle, /<img/)
  // GIF จริงถูกส่งเป็นภาพตรง ๆ จากเส้นทาง preview (ไม่แปลงไฟล์) — Preview modal แสดงมันเป็น <img>
  const env = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(React.createElement(files.FilePreviewModal, { t, file: gif, onClose: noop, onDownload: noop })) })
    assert.equal(document.querySelector('[role="dialog"] img')?.getAttribute('src'), '/api/files/g1/preview')
    await act(async () => root.unmount())
  } finally {
    env.restore()
  }
})

test('R8-PREVIEW-3 · an unsupported type keeps the type icon and never requests bytes', () => {
  for (const f of [fileItem(), fileItem({ id: 'z', name: 'a.zip', ext: 'zip', type: 'Archive' }), fileItem({ id: 's', name: 'a.svg', ext: 'svg', type: 'File' })]) {
    assert.equal(view.previewKindFor(f), null, f.name)
    const html = tileMarkup(f)
    assert.match(html, /data-thumb="icon"/)
    assert.doesNotMatch(html, /<img/)
    assert.doesNotMatch(html, /<video/)
  }
})

test('R8-PREVIEW-3b · a video tile never references the original: idle poster + motion proxy come from media-info, no eager download', () => {
  const clip = fileItem({ id: 'v1', name: 'clip.mp4', ext: 'mp4', type: 'Video', sha256: SHA_A })
  assert.equal(view.previewKindFor(clip), 'video')
  const html = tileMarkup(clip)
  assert.match(html, /data-media-thumb=""/)
  assert.match(html, />VIDEO</)
  assert.doesNotMatch(html, /<video/, 'ไม่มี <video> จนกว่า scheduler จะปล่อย slot ให้ proxy')
  assert.doesNotMatch(html, /\/api\/files\/v1\/preview/)
})

test('R8-PREVIEW-4 · when the poster derivative fails to load the tile falls back to the type icon', async () => {
  const env = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('root'))
    await act(async () => {
      root.render(React.createElement(files.FileTile, {
        t, file: image(), now: NOW, selected: false, anySelected: false,
        onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false,
      }))
      await new Promise((r) => setTimeout(r, 30))
    })
    const img = document.querySelector('img')
    assert.ok(img, 'ต้องเริ่มจากการพยายามแสดง poster จริง')
    assert.ok(img.getAttribute('src').includes('/poster?'))
    await act(async () => {
      img.dispatchEvent(new env.dom.window.Event('error', { bubbles: false }))
    })
    assert.equal(document.querySelector('img'), null, 'ภาพที่โหลดไม่ได้ต้องถูกถอดออก')
    assert.equal(document.querySelector('[data-thumb="icon"]')?.tagName, 'DIV')
    assert.ok(document.querySelector('[data-thumb="icon"] svg'), 'ต้องกลับไปเป็นไอคอนชนิดไฟล์')
    await act(async () => root.unmount())
  } finally {
    env.restore()
  }
})

test('R8-PREVIEW-5 · a Private Vault item never gets a normal plaintext preview', () => {
  const vaulted = image({ id: 'vv', vault: true })
  assert.equal(view.previewKindFor(vaulted), null)
  const html = tileMarkup(vaulted)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /\/preview/)
  assert.match(html, /hatch/, 'ภาษาภาพของ Vault (hatch) ต้องคงอยู่')
  assert.doesNotMatch(menuMarkup(vaulted), new RegExp(t('preview')))
  const vaultVideo = fileItem({ id: 'vv2', name: 'c.mp4', ext: 'mp4', type: 'Video', vault: true })
  assert.equal(view.previewKindFor(vaultVideo), null)
})

test('R8-PREVIEW-6 · the three-dot menu offers Preview only for previewable normal files', () => {
  assert.match(menuMarkup(image()), new RegExp(`>${t('preview')}<`), 'ภาพปกติต้องมี Preview')
  assert.match(menuMarkup(fileItem({ id: 'v', name: 'c.mp4', ext: 'mp4', type: 'Video' })), new RegExp(`>${t('preview')}<`))
  assert.doesNotMatch(menuMarkup(fileItem()), new RegExp(`>${t('preview')}<`), 'PDF ยังไม่มี Preview')
  // คำสั่งเดิมยังครบ
  const html = menuMarkup(image())
  for (const key of ['download', 'rename', 'move', 'createSecureShare', 'viewHistory', 'verifySha', 'viewMetadata', 'delete']) {
    assert.ok(html.includes(t(key)), key)
  }
  // Preview อยู่ก่อน Download — "ดู" มาก่อน "เอาออกไป"
  assert.ok(indexOf(html, `>${t('preview')}<`) < indexOf(html, `>${t('download')}<`))
})

test('R8-PREVIEW-7 · Preview opens a real preview dialog with the media, not a download', async () => {
  const env = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('root'))
    // 1) เมนูส่งคำสั่ง 'preview' ออกมา
    const actions = []
    await act(async () => {
      root.render(React.createElement(files.FileMenu, { t, file: image(), onAction: (a) => actions.push(a), onClose: noop }))
    })
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === t('preview'))
    assert.ok(item, 'ต้องมีรายการ Preview ในเมนู')
    await act(async () => { item.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(actions, ['preview'])
    assert.equal(document.querySelector('a[download]'), null, 'ต้องไม่กลายเป็นการดาวน์โหลด')

    // 2) กล่อง Preview เป็น dialog จริง แสดงภาพจากเส้นทาง preview พร้อมปุ่มปิด
    let closed = 0
    await act(async () => {
      root.render(React.createElement(files.FilePreviewModal, { t, file: image(), onClose: () => { closed += 1 }, onDownload: noop }))
    })
    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog, 'ต้องเป็น dialog')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    const img = dialog.querySelector('img')
    assert.ok(img && img.getAttribute('src') === '/api/files/img1/preview')
    assert.ok(dialog.querySelector('[role="status"]'), 'ต้องมีสถานะกำลังโหลดที่พูดความจริง')
    // โหลดสำเร็จ → สถานะหาย; ล้มเหลว → alert ที่พูดความจริง
    await act(async () => { img.dispatchEvent(new env.dom.window.Event('load')) })
    assert.equal(dialog.querySelector('[role="status"]'), null)
    await act(async () => { img.dispatchEvent(new env.dom.window.Event('error')) })
    assert.ok(dialog.querySelector('[role="alert"]'), 'ล้มเหลวต้องบอก ไม่ใช่ค้างว่างเปล่า')
    // ปุ่มปิดชัดเจน + Escape
    const closeBtn = [...dialog.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === t('close'))
    assert.ok(closeBtn, 'ต้องมีปุ่มปิดที่มองเห็น')
    await act(async () => { closeBtn.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(closed, 1)
    await act(async () => { window.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Escape' })) })
    assert.equal(closed, 2, 'Escape ต้องปิดได้')
    await act(async () => root.unmount())
  } finally {
    env.restore()
  }
})

test('R8-PREVIEW-7b · a video preview uses a bounded player, with controls and no autoplay', async () => {
  const clip = fileItem({ id: 'v1', name: 'clip.mp4', ext: 'mp4', type: 'Video' })
  const env = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(document.getElementById('root'))
    await act(async () => {
      root.render(React.createElement(files.FilePreviewModal, { t, file: clip, onClose: noop, onDownload: noop }))
    })
    const video = document.querySelector('[role="dialog"] video')
    assert.ok(video, 'ต้องมี <video> ใน dialog')
    assert.equal(video.hasAttribute('controls'), true)
    assert.equal(video.getAttribute('preload'), 'metadata')
    assert.equal(video.hasAttribute('autoplay'), false)
    assert.equal(video.getAttribute('src'), '/api/files/v1/preview')
    await act(async () => root.unmount())
  } finally {
    env.restore()
  }
})

test('R8-PREVIEW-8 · a folder has no Preview action and no thumbnail request', () => {
  assert.equal(view.previewKindFor(folderItem()), null)
  assert.doesNotMatch(menuMarkup(folderItem()), new RegExp(`>${t('preview')}<`))
  assert.doesNotMatch(folderTileMarkup(folderItem()), /\/preview|<img|<video/)
})

test('R8-STRINGS · every new Files string exists in all three languages', () => {
  for (const key of ['sectionFolders', 'sectionFiles', 'previewLoading', 'previewUnavailable']) {
    for (const lang of LANGS) {
      assert.equal(typeof STRINGS[lang][key], 'string', `${lang}.${key}`)
      assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key}`)
    }
  }
})

/* ══ Round 8 · review correction 1 ═════════════════════════════════════════ */

async function mountRoot() {
  const env = installDom()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const render = (el) => act(async () => { root.render(el) })
  const fire = (node, type, Ctor = env.dom.window.Event) => act(async () => { node.dispatchEvent(new Ctor(type, { bubbles: true })) })
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  return { env, root, render, fire, settle, unmount: async () => { await act(async () => root.unmount()); env.restore() } }
}

test('R8-SR1 · the preview dialog resets its lifecycle when the previewed file changes (same instance)', async () => {
  const m = await mountRoot()
  try {
    const A = image({ id: 'a1', name: 'a.jpg' })
    const B = image({ id: 'b1', name: 'b.png', ext: 'png' })
    const modal = (file) => React.createElement(files.FilePreviewModal, { t, file, onClose: noop, onDownload: noop })
    const dialog = () => document.querySelector('[role="dialog"]')
    const phase = () => dialog().querySelector('[data-file-preview-phase]')?.getAttribute('data-file-preview-phase')

    // A ล้มเหลว
    await m.render(modal(A))
    await m.fire(dialog().querySelector('img'), 'error')
    assert.ok(dialog().querySelector('[role="alert"]'), 'A ต้องอยู่ในสถานะล้มเหลว')

    // ปิด (file=null) แล้วเปิด B บน instance เดิม — ต้องกลับไป loading ไม่ใช่ค้าง failed ของ A
    await m.render(modal(null))
    await m.render(modal(B))
    assert.equal(dialog().querySelector('[role="alert"]'), null, 'สถานะล้มเหลวของ A ต้องไม่รั่วมาที่ B')
    assert.ok(dialog().querySelector('[role="status"]'), 'B ต้องเริ่มที่ loading')
    const imgB = dialog().querySelector('img')
    assert.equal(imgB?.getAttribute('src'), '/api/files/b1/preview')
    await m.fire(imgB, 'load')
    assert.equal(dialog().querySelector('[role="status"]'), null)
    assert.equal(phase(), 'ready')

    // B ready → A อีกครั้ง → ต้อง loading อีกครั้ง (ไม่ข้ามสถานะโหลดเพราะเคย ready)
    await m.render(modal(A))
    assert.ok(dialog().querySelector('[role="status"]'), 'สลับไฟล์แล้วต้อง loading ใหม่')
    assert.equal(phase(), 'loading')
    assert.equal(dialog().querySelector('img')?.getAttribute('src'), '/api/files/a1/preview')

    // เปลี่ยนชื่อไฟล์เดิม (id เดิม, นามสกุลใหม่ = ตัวตนของ preview เปลี่ยน) → loading ใหม่เช่นกัน
    await m.fire(dialog().querySelector('img'), 'load')
    assert.equal(phase(), 'ready')
    await m.render(modal({ ...A, name: 'a-renamed.webp', ext: 'webp' }))
    assert.equal(phase(), 'loading')
  } finally {
    await m.unmount()
  }
})

test('R8-SR1B · a failed poster is retried only when the content identity changes', async () => {
  const m = await mountRoot()
  try {
    const A = image({ id: 'a1', name: 'a.jpg' })
    const tile = (file) => React.createElement(files.FileTile, {
      t, file, now: NOW, selected: false, anySelected: false,
      onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false,
    })
    await m.render(tile(A)); await m.settle()
    await m.fire(document.querySelector('img'), 'error')
    assert.ok(document.querySelector('[data-thumb="icon"]'), 'ล้มเหลว → ไอคอน')

    // ไฟล์เดิมทุกประการ re-render / เปลี่ยนชื่อ → ยังเป็นไอคอน ไม่วนขอทรัพยากรที่พังซ้ำ
    await m.render(tile({ ...A })); await m.settle()
    await m.render(tile({ ...A, modified: NOW + 1, name: 'renamed.jpg' })); await m.settle()
    assert.equal(document.querySelector('img'), null, 'ต้องไม่ retry ทรัพยากรเดิมที่พังอยู่')

    // ตัวตนของเนื้อหาเปลี่ยน (sha ใหม่ = แทนที่/กู้เวอร์ชัน) → ลองแสดงภาพอีกครั้ง
    await m.render(tile({ ...A, sha256: 'b'.repeat(64) })); await m.settle()
    assert.ok(document.querySelector('img'), 'ตัวตนใหม่ต้องได้โอกาสโหลดใหม่')
    await m.fire(document.querySelector('img'), 'load')
    assert.equal(document.querySelector('[data-thumb]')?.getAttribute('data-thumb'), 'poster')
  } finally {
    await m.unmount()
  }
})

test('R8-SR2 · list view three-dot opens the same FileMenu as grid, with the same Preview rules', async () => {
  const m = await mountRoot()
  try {
    const folder = folderItem()
    const img = image()
    const pdf = fileItem()
    const vaulted = image({ id: 'vv', name: 'v.jpg', vault: true })
    const opened = []
    const actions = []
    const Mouse = m.env.dom.window.MouseEvent
    await m.render(React.createElement(files.FilesSections, {
      t, now: NOW, view: 'list', folders: [folder], files: [img, pdf, vaulted], selectedIds: new Set(), draggingIds: [],
      onSelect: noop, onOpen: (f) => opened.push(f.id), onMenuAction: (a, f) => actions.push([a, f.id]),
      onDragStartItem: noop, onDropItems: noop, tileRef: () => noop,
    }))
    // ลำดับส่วนยังเป็นโฟลเดอร์ก่อนไฟล์
    const rows = [...document.querySelectorAll('tbody tr')]
    assert.equal(rows[0].getAttribute('data-files-section-row'), 'folders')
    assert.equal(rows[1].getAttribute('data-file-kind'), 'folder')
    assert.equal(rows[2].getAttribute('data-files-section-row'), 'files')

    const triggerOf = (name) => {
      const row = [...document.querySelectorAll('tr[data-file-kind]')].find((r) => r.textContent.includes(name))
      assert.ok(row, `row ${name}`)
      const btn = row.querySelector('button[aria-haspopup="menu"]')
      assert.ok(btn, `three-dot trigger for ${name}`)
      return btn
    }
    const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.trim())

    // ภาพปกติ: เปิดเมนู → Preview อยู่แรก → กด → onMenuAction('preview', file) และแถวไม่ถูก "เปิด"
    await m.fire(triggerOf(img.name), 'click', Mouse)
    assert.equal(menuItems()[0], t('preview'))
    assert.ok(menuItems().includes(t('download')) && menuItems().includes(t('viewMetadata')))
    const previewItem = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.trim() === t('preview'))
    await m.fire(previewItem, 'click', Mouse)
    assert.deepEqual(actions, [['preview', img.id]])
    assert.deepEqual(opened, [], 'การใช้เมนูต้องไม่เปิดไฟล์/โฟลเดอร์')
    assert.equal(document.querySelector('[role="menu"]'), null, 'เมนูต้องปิดหลังเลือกคำสั่ง')

    // PDF: ไม่มี Preview แต่มีคำสั่งอื่นครบ
    await m.fire(triggerOf(pdf.name), 'click', Mouse)
    assert.ok(!menuItems().includes(t('preview')))
    assert.ok(menuItems().includes(t('verifySha')))
    await m.fire(triggerOf(pdf.name), 'click', Mouse) // toggle ปิด
    assert.equal(document.querySelector('[role="menu"]'), null)

    // โฟลเดอร์: ไม่มี Preview ไม่มี Download
    await m.fire(triggerOf(folder.name), 'click', Mouse)
    assert.ok(!menuItems().includes(t('preview')) && !menuItems().includes(t('download')))
    assert.ok(menuItems().includes(t('rename')))
    await m.fire(triggerOf(folder.name), 'click', Mouse)

    // Vault: ไม่มี Preview แบบ plaintext
    await m.fire(triggerOf(vaulted.name), 'click', Mouse)
    assert.ok(!menuItems().includes(t('preview')))
    assert.deepEqual(opened, [])
  } finally {
    await m.unmount()
  }
})

/* ── jsdom ────────────────────────────────────────────────────────────────── */

const mediaInfoFor = (id) => ({
  id, sourceVersion: SHA_A, profile: 'v1', family: 'png', animated: false, status: 'READY',
  poster: { state: 'READY', url: `/api/files/${id}/poster?v=${SHA_A}&p=v1`, mime: 'image/webp' }, motion: { state: 'UNSUPPORTED', reason: 'NOT_ANIMATED', url: null },
})
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    // Tranche B: ไทล์ถาม media-info (batch) — จำลองคำตอบ READY; jsdom ไม่ดึง <img> จริง
    fetch: async (url, opts = {}) => {
      if (String(url).endsWith('/api/files/media-info/batch')) {
        const items = {}
        for (const id of JSON.parse(opts.body).ids) items[id] = mediaInfoFor(id)
        return { ok: true, status: 200, json: async () => ({ items }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return {
    dom,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}
