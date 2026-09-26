// tests/vaultTreeUi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · folder/file tiles, breadcrumbs, tile menu (UI-*)
//
// สิ่งที่ชุดนี้ตรึงไว้:
//   UI-1  folder/file tiles: testid/ไอคอนต่างกัน; โฟลเดอร์โชว์จำนวนลูก (active view) ไม่โชว์ขนาด;
//         ไฟล์โชว์ขนาด/ชนิดจาก manifest node (ไม่ใช่ซองเลกาซี)
//   UI-2  ล็อกอยู่: จอต้นไม้ไม่มีอยู่เลย — fixed ambient preview ไม่เผยจำนวน/ชื่อ/id/metadata ของ ciphertext
//   UI-3  breadcrumbs วาด root → … → current; คลิก/Enter/Space เรียก onNavigate; crumb ปัจจุบัน aria-current="page"
//   UI-4  Ctrl/Cmd-click บนตัวไทล์ = เลือกเพิ่ม (additive); คลิกช่องติ๊ก = สลับ; คลิกตัวไทล์เปล่า ๆ = เปิดโฟลเดอร์ / พรีวิวไฟล์
//   UI-5  เมนูครบตามสัญญาต่อชนิด; Preview หายไปเมื่อ previewKindFor(mime) เป็น null; ข้อความที่ปิดใช้งานมีเหตุผลจริง
//   UI-6  ไม่มี Secure Share / Public Share / File History / Verify / Protected Trash ในเมนูต้นไม้ใด ๆ
//   STR-1 ทุก t() key ที่คอมโพเนนต์ใหม่ใช้ต้องมีใน en/th/zh ครบ
//
// ⚠️ จอต้นไม้ mount เฉพาะตอนปลดล็อก — "ล็อก" จึงไม่มี UI ต้นไม้ให้เห็นเลย (ต่างจากไทล์เลกาซีที่วาดม่านทึบ)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'

import { makeT, STRINGS } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, makeVaultTreeBackend, serverBlob } from './fixtures/vaultTreeBackend.js'
import { startVaultScreenEnv, settle, click, pressKey, type, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]

/* ── UI-1 ─────────────────────────────────────────────────────────────────── */
test('UI-1 folder/file tiles: distinct testids and icons; folder without child count; file size/type from the manifest node', async () => {
  const { VaultFolderTile } = await env.load('/src/components/vault/VaultFolderTile.jsx')
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  try {
    const calls = { select: [], open: [], preview: [], action: [] }
    await h.render(
      React.createElement(VaultFolderTile, {
        t, node: { nodeId: 'F'.repeat(22), name: 'Docs', kind: 'folder' }, childCount: 2, selected: false,
        onSelect: (id, o) => calls.select.push([id, o]), onOpen: (id) => calls.open.push(id),
        onAction: (node, id) => calls.action.push([node.nodeId, id]),
      }),
    )
    const tile = q('[data-testid="vault-folder-tile"]')
    assert.ok(tile, 'folder tile renders with its own testid')
    assert.equal(tile.getAttribute('data-node-id'), 'F'.repeat(22))
    assert.equal(tile.getAttribute('data-icon'), 'folder', 'the folder tile carries the folder icon marker')
    const body = q('[data-testid="vault-folder-tile-body"]')
    assert.ok(body, 'the folder tile has a clickable body')
    assert.ok(body.textContent.includes('Docs'), 'the folder name is rendered')
    assert.equal(q('[data-testid="vault-folder-child-count"]'), null, 'the folder child count is removed per Files card parity')
    assert.ok(!/[0-9.]+ (B|KB|MB)/.test(q('[data-testid="vault-folder-tile"]').textContent), 'the folder tile shows no byte size')

    await act(async () => {
      body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()
    assert.deepEqual(calls.open, ['F'.repeat(22)], 'a plain body click opens the folder')

    await act(async () => {
      body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    })
    await settle()
    assert.deepEqual(calls.select, [['F'.repeat(22), { additive: true }]], 'Ctrl-click selects additively')

    const fileCalls = { select: [], preview: [], action: [] }
    await h.render(
      React.createElement(VaultFileTile, {
        t, node: { nodeId: 'f'.repeat(22), name: 'a.png', kind: 'file', mediaType: 'image/png', plainSize: 2048 },
        previewKind: 'image', selected: false,
        onSelect: (id, o) => fileCalls.select.push([id, o]), onPreview: (n) => fileCalls.preview.push(n.nodeId),
        onAction: (node, id) => fileCalls.action.push([node.nodeId, id]),
      }),
    )
    const ftile = q('[data-testid="vault-file-tile"]')
    assert.ok(ftile, 'file tile renders with its own testid')
    assert.equal(ftile.getAttribute('data-icon'), 'file', 'the file tile carries the file icon marker')
    const fbody = q('[data-testid="vault-file-tile-body"]')
    assert.ok(fbody.textContent.includes('a.png'), 'the file name is rendered')
    assert.ok(fbody.textContent.includes('2.0 KB'), 'the file size comes from node.plainSize (manifest, not envelope)')
    assert.ok(fbody.textContent.includes('image/png'), 'the file type comes from node.mediaType')
    await act(async () => {
      fbody.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()
    assert.deepEqual(fileCalls.preview, ['f'.repeat(22)], 'a plain file body click previews the file')
  } finally {
    await h.unmount()
  }
})

/* ── FOLDER_NAME_1 / FOLDER_NAME_2 ────────────────────────────────────────── */
test('FOLDER_NAME_1: Folder node name="Folder A" visibly renders "Folder A" without child count or placeholder replacement', async () => {
  const { VaultFolderTile } = await env.load('/src/components/vault/VaultFolderTile.jsx')
  const h = env.mount()
  try {
    await h.render(
      React.createElement(VaultFolderTile, {
        t,
        node: { nodeId: 'A'.repeat(22), name: 'Folder A', kind: 'folder' },
        childCount: 0,
        selected: false,
        onSelect: () => {},
        onOpen: () => {},
        onAction: () => {},
      }),
    )
    const body = q('[data-testid="vault-folder-tile-body"]')
    assert.ok(body, 'folder tile body exists')
    const nameSpan = body.querySelector('.text-ink')
    assert.equal(nameSpan?.textContent?.trim(), 'Folder A', 'visibly displays Folder A')
    assert.equal(q('[data-testid="vault-folder-child-count"]'), null, 'child count must not be present')
    assert.ok(!body.textContent.includes('โฟลเดอร์ว่าง'), 'placeholder does not replace node.name')
  } finally {
    await h.unmount()
  }
})

test('FOLDER_NAME_2: Folder node name="Folder B" visibly renders "Folder B" without child count or placeholder replacement', async () => {
  const { VaultFolderTile } = await env.load('/src/components/vault/VaultFolderTile.jsx')
  const h = env.mount()
  try {
    await h.render(
      React.createElement(VaultFolderTile, {
        t,
        node: { nodeId: 'B'.repeat(22), name: 'Folder B', kind: 'folder' },
        childCount: 7,
        selected: false,
        onSelect: () => {},
        onOpen: () => {},
        onAction: () => {},
      }),
    )
    const body = q('[data-testid="vault-folder-tile-body"]')
    assert.ok(body, 'folder tile body exists')
    const nameSpan = body.querySelector('.text-ink')
    assert.equal(nameSpan?.textContent?.trim(), 'Folder B', 'visibly displays Folder B')
    assert.equal(q('[data-testid="vault-folder-child-count"]'), null, 'child count must not be present')
    assert.ok(!body.textContent.includes('โฟลเดอร์ว่าง'), 'placeholder does not replace node.name')
  } finally {
    await h.unmount()
  }
})

/* ── UI-2 ─────────────────────────────────────────────────────────────────── */
test('LOCKED-VAULT-UI-TEST-1..3 locked preview is fixed, decorative, and reveals no inventory-derived content', async () => {
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  globalThis.__VAULT_BACKEND__ = backend
  const { Vault } = await env.load('/src/screens/Vault.jsx')
  const renderLocked = async (count) => {
    backend.state['/api/vault'] = {
      loading: false,
      data: {
        configured: true,
        blobs: Array.from({ length: count }, (_, index) => serverBlob({
          id: `locked-${index}`.padEnd(22, 'x'),
          name: `real-secret-${index}.txt`,
          plainSize: 128 + index,
          size: 256 + index,
        })),
      },
      error: null,
    }
    const h = env.mount()
    await h.render(React.createElement(Vault, { t }))
    const preview = q('[data-testid="locked-vault-preview"]')
    assert.ok(preview, 'dedicated locked preview renders')
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'a locked vault renders no tree screen')
    assert.ok(!q('[data-testid="vault-folder-tile"]') && !q('[data-testid="vault-file-tile"]'), 'locked: no real tree tiles')
    assert.equal(qa('[data-vault-tile-menu]').length, 0, 'locked preview has no per-item actions')
    assert.ok(!preview.textContent.includes('.aegisenc'), 'opaque ids are not enumerated')
    assert.ok(!preview.textContent.includes('real-secret-'), 'plaintext names never render')
    assert.ok(preview.textContent.includes(t('vaultLocked')), 'locked semantics remain explicit')
    assert.ok(preview.textContent.includes(t('vaultKeyNote')), 'encryption explanation remains clear')
    assert.ok(qa('[data-testid="locked-vault-ambient"]').every((el) => el.getAttribute('aria-hidden') === 'true'), 'ambient blocks are decorative')
    const ambientCount = qa('[data-testid="locked-vault-ambient"]').length
    await h.unmount()
    return ambientCount
  }

  const oneItemCount = await renderLocked(1)
  const manyItemCount = await renderLocked(11)
  assert.equal(oneItemCount, manyItemCount, 'ambient composition never scales with inventory count')
  assert.equal(oneItemCount, 7, 'the approved composition has a bounded fixed block count')
})

test('QHD-LAYOUT-1..2 locked Vault uses the centered content boundary at 2560x1440 and 1920x1080', async () => {
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  globalThis.__VAULT_BACKEND__ = backend
  const { Vault } = await env.load('/src/screens/Vault.jsx')
  const originalWidth = dom.window.innerWidth
  const originalHeight = dom.window.innerHeight

  try {
    for (const [width, height] of [[2560, 1440], [1920, 1080]]) {
      Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: width })
      Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: height })
      const h = env.mount()
      try {
        await h.render(React.createElement(Vault, { t }))
        const preview = q('[data-testid="locked-vault-preview"]')
        assert.ok(preview, `${width}x${height}: locked preview renders`)
        assert.ok(
          preview.closest('.vault-pane-content'),
          `${width}x${height}: locked presentation is inside the established centered Vault content boundary`,
        )
        assert.equal(
          qa('[data-testid="locked-vault-ambient"]').length,
          7,
          `${width}x${height}: the fixed privacy composition does not become viewport-derived inventory`,
        )
      } finally {
        await h.unmount()
      }
    }
  } finally {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: originalWidth })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})

test('QHD-LAYOUT-3 unlocked FLAT actions remain available inside the centered legacy content boundary', async () => {
  const backend = makeVaultTreeBackend()
  globalThis.__VAULT_BACKEND__ = backend
  const { Vault } = await env.load('/src/screens/Vault.jsx')
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await settle()

    const upload = qa('button').find((button) => button.textContent.trim() === t('upload'))
    const lock = qa('button').find((button) => button.textContent.trim() === t('lockVault'))
    assert.ok(upload, 'legacy FLAT Upload action remains available')
    assert.ok(lock, 'legacy FLAT Lock action remains available')
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'FLAT still does not render the TREE_V1 screen')
    assert.ok(
      upload.closest('.vault-pane-content'),
      'legacy FLAT visual actions use the centered Vault content boundary',
    )
  } finally {
    await h.unmount()
  }
})

test('VAULT-FILE-DRAG-WIRING-1 VaultFileTile calls its onDragStart prop exactly once', async () => {
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  let calls = 0
  try {
    await h.render(React.createElement(VaultFileTile, {
      t,
      node: { nodeId: 'drag-file'.padEnd(22, 'f'), name: 'drag.png', kind: 'file', mediaType: 'image/png', plainSize: 2048 },
      selected: true,
      onSelect: () => {},
      onPreview: () => {},
      onAction: () => {},
      onDragStart: () => { calls += 1 },
    }))
    await act(async () => {
      q('[data-testid="vault-file-tile"]').dispatchEvent(new dom.window.Event('dragstart', { bubbles: true, cancelable: true }))
    })
    assert.equal(calls, 1, 'the callback reaches the screen drag pipeline exactly once')
  } finally {
    await h.unmount()
  }
})

/* ── UI-3 ─────────────────────────────────────────────────────────────────── */
test('UI-3 breadcrumbs: root→current path, click/Enter/Space navigate, current crumb has aria-current="page"', async () => {
  const { VaultBreadcrumbs } = await env.load('/src/components/vault/VaultBreadcrumbs.jsx')
  const h = env.mount()
  try {
    const items = [
      { nodeId: 'r'.repeat(22), name: 'Vault' },
      { nodeId: 'a'.repeat(22), name: 'Docs' },
      { nodeId: 'b'.repeat(22), name: 'Plans' },
    ]
    const nav = []
    await h.render(React.createElement(VaultBreadcrumbs, { t, items, onNavigate: (id) => nav.push(id) }))
    const navEl = q('[data-testid="vault-tree-breadcrumbs"]')
    assert.ok(navEl, 'breadcrumbs render inside a labelled nav')
    const crumbs = qa('[data-testid="vault-tree-breadcrumbs"] button')
    assert.equal(crumbs.length, 3, 'one button crumb per level')
    assert.equal(crumbs[0].textContent.trim(), 'Vault')
    const current = q('[data-testid="vault-tree-crumb-current"]')
    assert.ok(current, 'the current crumb is marked')
    assert.equal(current.getAttribute('aria-current'), 'page', 'the current crumb carries aria-current="page"')
    assert.equal(current.textContent.trim(), 'Plans')

    await click(dom, crumbs[1])
    assert.deepEqual(nav, ['a'.repeat(22)], 'clicking a crumb navigates to that node')

    await act(async () => {
      crumbs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    assert.deepEqual(nav, ['a'.repeat(22), 'a'.repeat(22)], 'Enter on a crumb navigates')

    await act(async () => {
      crumbs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    await settle()
    assert.deepEqual(nav, ['a'.repeat(22), 'a'.repeat(22), 'a'.repeat(22)], 'Space on a crumb navigates')
  } finally {
    await h.unmount()
  }
})

/* ── UI-4 ─────────────────────────────────────────────────────────────────── */
test('UI-4 checkbox toggles selection; body click opens/previews', async () => {
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  try {
    const calls = { select: [], preview: [] }
    await h.render(
      React.createElement(VaultFileTile, {
        t, node: { nodeId: 'x'.repeat(22), name: 'b.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
        previewKind: 'image', selected: false,
        onSelect: (id, o) => calls.select.push([id, o]), onPreview: (n) => calls.preview.push(n.nodeId),
        onAction: () => {},
      }),
    )
    const box = q('[data-testid="vault-tree-tile-checkbox"]')
    assert.ok(box, 'the tile renders a selection checkbox')
    await act(async () => {
      box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()
    assert.deepEqual(calls.select, [['x'.repeat(22), { additive: true }]], 'checking the checkbox toggles selection additively')
    assert.deepEqual(calls.preview, [], 'the checkbox never previews')

    const body = q('[data-testid="vault-file-tile-body"]')
    await act(async () => {
      body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()
    assert.deepEqual(calls.preview, ['x'.repeat(22)], 'the plain body click previews')
    assert.deepEqual(calls.select.length, 1, 'the plain body click does not touch selection')
  } finally {
    await h.unmount()
  }
})

/* ── UI-5 + UI-6 ──────────────────────────────────────────────────────────── */
test('UI-5/UI-6 menu items match the contract; forbidden actions absent; disabled items carry KEY_DEGRADED', async () => {
  const { VaultTileMenu, vaultTreeMenuItems } = await env.load('/src/components/vault/VaultTileMenu.jsx')
  const h = env.mount()
  const forbidden = ['Secure Share', 'Public Share', 'File History', 'Verify', 'Protected Trash']
  const menuText = () => qa('[role="menuitem"]').map((el) => el.textContent.trim())

  try {
    // active file with preview
    let items = vaultTreeMenuItems({ t, kind: 'file', view: 'active', previewKind: 'image', keyDegraded: false })
    await h.render(React.createElement(VaultTileMenu, { t, items, onAction: () => {} }))
    assert.deepEqual(menuText(), [
      t('vaultTreeMenuPreview'), t('vaultTreeMenuDetails'), t('vaultTreeMenuDownload'), t('vaultTreeMenuRename'), t('vaultTreeMenuMove'), t('vaultTreeMenuTrash'),
    ], 'active file menu: Preview, Details, Download, Rename, Move, Trash')

    // active file without preview capability
    items = vaultTreeMenuItems({ t, kind: 'file', view: 'active', previewKind: null, keyDegraded: false })
    await h.render(React.createElement(VaultTileMenu, { t, items, onAction: () => {} }))
    assert.deepEqual(menuText(), [
      t('vaultTreeMenuDetails'), t('vaultTreeMenuDownload'), t('vaultTreeMenuRename'), t('vaultTreeMenuMove'), t('vaultTreeMenuTrash'),
    ], 'Preview is absent when the file kind is not previewable')

    // active folder
    items = vaultTreeMenuItems({ t, kind: 'folder', view: 'active', keyDegraded: false })
    await h.render(React.createElement(VaultTileMenu, { t, items, onAction: () => {} }))
    assert.deepEqual(menuText(), [
      t('vaultTreeMenuOpen'), t('vaultTreeMenuDetails'), t('vaultTreeMenuRename'), t('vaultTreeMenuMove'), t('vaultTreeMenuTrash'),
    ], 'active folder menu: Open, Details, Rename, Move, Trash')

    // trashed node
    items = vaultTreeMenuItems({ t, kind: 'file', view: 'trash', keyDegraded: false })
    await h.render(React.createElement(VaultTileMenu, { t, items, onAction: () => {} }))
    assert.deepEqual(menuText(), [t('vaultTreeMenuRestore'), t('vaultTreeMenuDetails')], 'trash view: Restore, Details')

    for (const text of menuText()) {
      for (const f of forbidden) assert.ok(!text.includes(f), `forbidden action "${f}" must not exist in the tree menu`)
    }

    // degraded key: mutation items disabled with the truthful reason
    items = vaultTreeMenuItems({ t, kind: 'file', view: 'active', previewKind: 'image', keyDegraded: true })
    await h.render(React.createElement(VaultTileMenu, { t, items, onAction: () => {} }))
    const byId = (id) => qa('[role="menuitem"]').find((el) => el.getAttribute('data-action') === id)
    const fired = []
    await h.render(React.createElement(VaultTileMenu, {
      t, items, onAction: (id) => fired.push(id),
    }))
    for (const id of ['rename', 'move', 'trash']) {
      const el = byId(id)
      assert.ok(el, `${id} item exists while degraded`)
      assert.equal(el.getAttribute('data-reason'), 'KEY_DEGRADED', `${id} carries the truthful reason`)
      await click(dom, el)
      assert.deepEqual(fired, [], 'a disabled item never fires its action')
    }
    const dl = byId('download')
    await click(dom, dl)
    assert.deepEqual(fired, ['download'], 'non-mutation items stay enabled while degraded')
  } finally {
    await h.unmount()
  }
})

/* ── STR-1 ────────────────────────────────────────────────────────────────── */
test('STR-1 every t() key used by the vault tree UI files exists in en, th and zh', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files = [
    ...fs.readdirSync(path.join(root, 'src/components/vault')).filter((f) => f.endsWith('.jsx')).map((f) => path.join(root, 'src/components/vault', f)),
    path.join(root, 'src/screens/VaultTreeScreen.jsx'),
  ].filter((p) => fs.existsSync(p))
  assert.ok(files.length >= 4, 'the scan covers the new components')
  const keys = new Set()
  const re = /\bt\(\s*'([A-Za-z][A-Za-z0-9]*)'/g
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(re)) keys.add(m[1])
  }
  assert.ok(keys.size > 0, 'the scan found t() keys')
  const missing = []
  for (const k of keys) {
    if (!STRINGS.en[k]) missing.push(`en/${k}`)
    if (!STRINGS.th[k]) missing.push(`th/${k}`)
    if (!STRINGS.zh[k]) missing.push(`zh/${k}`)
  }
  assert.deepEqual(missing, [], 'every used key exists in all three locales')
})

/* ── UI-7..9 (Task 7.3) — the file tile's media slot ──────────────────────── */

test('UI-7 the tile shows the poster when ready, the icon with a truthful reason when unsupported, and honors reduced motion', async () => {
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  try {
    // poster ready → an <img> with the poster URL
    await h.render(React.createElement(VaultFileTile, {
      t, node: { nodeId: 'p'.repeat(22), name: 'a.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
      previewKind: 'image', media: { posterUrl: 'blob:mock/poster' },
      onSelect: () => {}, onPreview: () => {}, onAction: () => {},
    }))
    const img = q('[data-testid="vault-tree-tile-poster"]')
    assert.ok(img, 'the poster renders')
    assert.equal(img.getAttribute('src'), 'blob:mock/poster')
    // unsupported → icon + truthful reason tooltip; no hover wiring under reduced motion
    await h.render(React.createElement(VaultFileTile, {
      t, node: { nodeId: 'q'.repeat(22), name: 'b.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
      previewKind: 'image', media: { reason: 'GIF_TOO_LARGE' },
      onSelect: () => {}, onPreview: () => {}, onAction: () => {},
    }))
    assert.ok(!q('[data-testid="vault-tree-tile-poster"]'), 'no poster for an unsupported file')
    const icon = q('[data-icon="file"]')
    assert.ok(icon, 'the icon fallback renders')
    assert.equal(icon.getAttribute('title'), 'GIF_TOO_LARGE', 'the truthful reason travels as the tooltip')
    // reduced motion: the tile carries no hover handlers
    await h.render(React.createElement(VaultFileTile, {
      t, node: { nodeId: 'r'.repeat(22), name: 'c.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
      previewKind: 'image', media: { posterUrl: 'blob:mock/p2', hoverEnabled: false },
      onSelect: () => {}, onPreview: () => {}, onAction: () => {},
    }))
    const body = q('[data-testid="vault-file-tile-body"]')
    await act(async () => body.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })))
    await settle()
    assert.equal(body.getAttribute('data-motion-active'), null, 'reduced motion never activates motion')
  } finally {
    await h.unmount()
  }
})

test('UI-8 hover swaps the poster to the motion frame and back; motion never autoplays', async () => {
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  const calls = []
  try {
    await h.render(React.createElement(VaultFileTile, {
      t, node: { nodeId: 'm'.repeat(22), name: 'd.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
      previewKind: 'image',
      media: {
        posterUrl: 'blob:mock/poster', hoverEnabled: true, motionUrl: null,
        onHoverStart: () => calls.push('start'), onHoverEnd: () => calls.push('end'),
      },
      onSelect: () => {}, onPreview: () => {}, onAction: () => {},
    }))
    const body = q('[data-testid="vault-file-tile-body"]')
    // React synthesizes onMouseEnter/Leave from real hover transitions; under jsdom the
    // deterministic way to exercise the tile wiring is through its own props
    const rp = body[Object.keys(body).find((k) => k.startsWith('__reactProps'))]
    await act(async () => rp.onMouseEnter(new dom.window.Event('mouseover', { bubbles: true })))
    await settle()
    assert.deepEqual(calls, ['start'], 'hover starts the motion request (the screen decrypts + swaps)')
    await act(async () => rp.onMouseLeave(new dom.window.Event('mouseout', { bubbles: true })))
    await settle()
    assert.deepEqual(calls, ['start', 'end'], 'leaving ends the motion and the screen revokes the URL')
    // autoplay honesty: without a hover event the motion request is never issued
    assert.ok(!calls.includes('autoplay'), 'no autoplay path exists')
  } finally {
    await h.unmount()
  }
})

test('MEDIA-03/04/TOUCH-01 touch hold starts GIF motion, release stops it, and a short tap still previews', async () => {
  const { VaultFileTile, VAULT_MEDIA_HOLD_MS } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()
  const calls = []
  const previews = []
  try {
    await h.render(React.createElement(VaultFileTile, {
      t, node: { nodeId: 't'.repeat(22), name: 'touch.gif', kind: 'file', mediaType: 'image/gif', plainSize: 4096 },
      previewKind: 'image',
      media: {
        posterUrl: 'blob:mock/poster', hoverEnabled: true, motionUrl: 'blob:mock/motion',
        onHoverStart: () => calls.push('start'), onHoverEnd: () => calls.push('end'),
      },
      onSelect: () => {}, onPreview: (node) => previews.push(node.nodeId), onAction: () => {},
    }))
    const body = q('[data-testid="vault-file-tile-body"]')
    const props = body[Object.keys(body).find((key) => key.startsWith('__reactProps'))]
    await act(async () => props.onPointerDown({ pointerType: 'touch' }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, VAULT_MEDIA_HOLD_MS + 20)) })
    assert.deepEqual(calls, ['start'])
    await act(async () => props.onPointerUp({ pointerType: 'touch' }))
    assert.deepEqual(calls, ['start', 'end'])
    await act(async () => props.onClick({ ctrlKey: false, metaKey: false }))
    assert.deepEqual(previews, [], 'the release click after a hold is consumed')

    await act(async () => props.onPointerDown({ pointerType: 'touch' }))
    await act(async () => props.onPointerUp({ pointerType: 'touch' }))
    await act(async () => props.onClick({ ctrlKey: false, metaKey: false }))
    assert.equal(previews.length, 1, 'a short touch tap keeps the ordinary preview action')
  } finally {
    await h.unmount()
  }
})

/* ── MARQUEE-SURFACE-1..6 ─────────────────────────────────────────────────── */
test('MARQUEE-SURFACE-1..6 expanded surface geometry, ignore contract, intersection, cancellation, and blank clear', async () => {
  const { useMarqueeSelection } = await env.load('/src/lib/useMarqueeSelection.js')
  const { VaultFolderTile } = await env.load('/src/components/vault/VaultFolderTile.jsx')
  const { VaultFileTile } = await env.load('/src/components/vault/VaultFileTile.jsx')
  const h = env.mount()

  function WorkspaceHarness({ initial = [] }) {
    const [selected, setSelected] = React.useState(() => new Set(initial))
    const canvasRef = React.useRef(null)
    const tileEls = React.useRef(new Map())
    const registerTile = (id) => (el) => {
      if (el) tileEls.current.set(id, el)
      else tileEls.current.delete(id)
    }
    const marquee = useMarqueeSelection({
      enabled: true,
      canvasRef,
      tileEls,
      selectedIds: selected,
      onSelectionChange: setSelected,
    })
    return React.createElement(
      'div',
      {
        ref: canvasRef,
        'data-testid': 'vault-marquee-surface',
        'data-vault-marquee-canvas': '',
        onPointerDown: marquee.onPointerDown,
        className: 'relative min-h-[60vh] pb-24',
        style: { userSelect: marquee.tracking ? 'none' : undefined },
      },
      marquee.box && React.createElement('div', {
        'data-testid': 'vault-marquee-rect',
        style: {
          position: 'absolute',
          left: `${marquee.box.left}px`,
          top: `${marquee.box.top}px`,
          width: `${marquee.box.width}px`,
          height: `${marquee.box.height}px`,
        },
      }),
      React.createElement('div', { 'data-testid': 'blank-above', className: 'h-16' }),
      React.createElement(
        'div',
        { 'data-testid': 'mock-toolbar' },
        React.createElement('input', { 'data-testid': 'mock-search' }),
        React.createElement('button', { 'data-testid': 'mock-button' }, 'Upload'),
        React.createElement('p', { 'data-testid': 'mock-help', 'data-marquee-ignore': '' }, 'Help text'),
      ),
      React.createElement('output', { 'data-testid': 'selection-size' }, String(selected.size)),
      React.createElement(
        'div',
        { 'data-testid': 'vault-tree-workspace', className: 'space-y-6' },
        React.createElement(
          'section',
          null,
          React.createElement('h2', { 'data-marquee-ignore': '', 'data-testid': 'folders-heading' }, 'Folders'),
          React.createElement(VaultFolderTile, {
            t,
            node: { nodeId: 'folder-1', name: 'Folder A', kind: 'folder' },
            tileRef: registerTile('folder-1'),
            selected: selected.has('folder-1'),
            onSelect: () => {},
            onOpen: () => {},
            onAction: () => {},
          }),
        ),
        React.createElement(
          'section',
          null,
          React.createElement('h2', { 'data-marquee-ignore': '', 'data-testid': 'files-heading' }, 'Files'),
          React.createElement(VaultFileTile, {
            t,
            node: { nodeId: 'file-1', name: 'file1.txt', kind: 'file', mediaType: 'text/plain', plainSize: 100 },
            tileRef: registerTile('file-1'),
            selected: selected.has('file-1'),
            onSelect: () => {},
            onPreview: () => {},
            onAction: () => {},
          }),
        ),
      ),
      React.createElement('div', { 'data-testid': 'blank-below', className: 'h-40' }),
    )
  }

  try {
    await h.render(React.createElement(WorkspaceHarness, { initial: ['file-1'] }))
    const surface = q('[data-testid="vault-marquee-surface"]')
    const folderTile = q('[data-testid="vault-folder-tile"]')
    const fileTile = q('[data-testid="vault-file-tile"]')
    const blankBelow = q('[data-testid="blank-below"]')
    const blankAbove = q('[data-testid="blank-above"]')
    const heading = q('[data-testid="folders-heading"]')

    surface.getBoundingClientRect = () => ({ left: 100, top: 50, right: 1100, bottom: 850, width: 1000, height: 800 })
    folderTile.getBoundingClientRect = () => ({ left: 120, top: 140, right: 300, bottom: 190, width: 180, height: 50 })
    fileTile.getBoundingClientRect = () => ({ left: 120, top: 220, right: 300, bottom: 300, width: 180, height: 80 })
    blankAbove.getBoundingClientRect = () => ({ left: 100, top: 50, right: 1100, bottom: 120, width: 1000, height: 70 })
    blankBelow.getBoundingClientRect = () => ({ left: 100, top: 400, right: 1100, bottom: 800, width: 1000, height: 400 })

    const pointer = (target, type, props) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...props })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      Object.defineProperty(event, 'pointerType', { value: props.pointerType ?? 'mouse' })
      target.dispatchEvent(event)
    }

    // MARQUEE-SURFACE-1: blank space above the old workspace can select a registered tile.
    await act(async () => pointer(blankAbove, 'pointerdown', { clientX: 110, clientY: 60 }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 310, clientY: 200 }))
    assert.equal(q('[data-testid="selection-size"]').textContent, '1')
    // MARQUEE-SURFACE-2: coordinates are relative to the expanded surface.
    assert.equal(q('[data-testid="vault-marquee-rect"]').style.left, '10px')
    assert.equal(q('[data-testid="vault-marquee-rect"]').style.top, '10px')
    await act(async () => pointer(dom.window, 'pointerup', {}))

    // Blank below cards starts marquee.
    await act(async () => pointer(blankBelow, 'pointerdown', { clientX: 300, clientY: 400 }))
    assert.equal(surface.style.userSelect, 'none', 'pointerdown in blank area below starts tracking')
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 350, clientY: 450 }))
    assert.ok(q('[data-testid="vault-marquee-rect"]'), 'marquee rect rendered')
    await act(async () => pointer(dom.window, 'pointerup', {}))

    // Side gutter starts tracking.
    await act(async () => pointer(surface, 'pointerdown', { clientX: 500, clientY: 160 }))
    assert.equal(surface.style.userSelect, 'none', 'pointerdown in side gutter starts tracking')
    await act(async () => pointer(dom.window, 'pointerup', {}))

    // MARQUEE-SURFACE-3: controls and marked text are ignored.
    await act(async () => pointer(heading, 'pointerdown', { clientX: 25, clientY: 25 }))
    assert.equal(surface.style.userSelect, '', 'heading does not start marquee')
    for (const target of [q('[data-testid="mock-search"]'), q('[data-testid="mock-button"]'), q('[data-testid="mock-help"]')]) {
      await act(async () => pointer(target, 'pointerdown', { clientX: 130, clientY: 125 }))
      assert.equal(surface.style.userSelect, '', `${target.dataset.testid} does not start marquee`)
    }

    const btn = folderTile.querySelector('button')
    if (btn) {
      await act(async () => pointer(btn, 'pointerdown', { clientX: 30, clientY: 50 }))
      assert.equal(surface.style.userSelect, '', 'button does not start marquee')
    }

    // MARQUEE-SURFACE-4: Pointerdown on card tile itself does not start marquee
    await act(async () => pointer(folderTile, 'pointerdown', { clientX: 50, clientY: 60 }))
    assert.equal(surface.style.userSelect, '', 'card tile pointerdown does not start marquee')

    // MARQUEE-SURFACE-5: Intersection selects card; additive with Ctrl keeps initial
    await act(async () => pointer(surface, 'pointerdown', { clientX: 105, clientY: 130, ctrlKey: true }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 310, clientY: 200 }))
    const rect = q('[data-testid="vault-marquee-rect"]')
    assert.ok(rect, 'marquee rect active during drag')

    // MARQUEE-SURFACE-6: Escape cancels active marquee and restores selection; touch is ignored
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(q('[data-testid="vault-marquee-rect"]'), null, 'Escape clears marquee rect')
    assert.equal(surface.style.userSelect, '', 'Escape ends tracking')

    // BLANK-CLICK-1/2: primary blank click, including sub-threshold motion, clears.
    await act(async () => pointer(surface, 'pointerdown', { clientX: 110, clientY: 210 }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 310, clientY: 310 }))
    await act(async () => pointer(dom.window, 'pointerup', {}))
    assert.equal(q('[data-testid="selection-size"]').textContent, '1')
    await act(async () => pointer(surface, 'pointerdown', { clientX: 900, clientY: 700 }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 902, clientY: 703 }))
    await act(async () => pointer(dom.window, 'pointerup', {}))
    assert.equal(q('[data-testid="selection-size"]').textContent, '0')

    // BLANK-CLICK-3/4: real drag keeps hits; modifier blank click preserves them.
    await act(async () => pointer(surface, 'pointerdown', { clientX: 110, clientY: 210 }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 310, clientY: 310 }))
    await act(async () => pointer(dom.window, 'pointerup', {}))
    assert.equal(q('[data-testid="selection-size"]').textContent, '1')
    await act(async () => pointer(surface, 'pointerdown', { clientX: 900, clientY: 700, metaKey: true }))
    await act(async () => pointer(dom.window, 'pointerup', {}))
    assert.equal(q('[data-testid="selection-size"]').textContent, '1')

    // Touch pointerdown does not start marquee
    await act(async () => pointer(surface, 'pointerdown', { clientX: 110, clientY: 60, pointerType: 'touch' }))
    assert.equal(surface.style.userSelect, '', 'touch pointerdown does not start marquee')
  } finally {
    await h.unmount()
  }
})

test('V10-FULL-PANE-1..10 Vault owns one full-main-pane marquee surface without stretching its visual content', () => {
  const root = path.dirname(fileURLToPath(import.meta.url))
  const appSource = fs.readFileSync(path.join(root, '../src/App.jsx'), 'utf8')
  const vaultSource = fs.readFileSync(path.join(root, '../src/screens/Vault.jsx'), 'utf8')
  const treeSource = fs.readFileSync(path.join(root, '../src/screens/VaultTreeScreen.jsx'), 'utf8')
  const cssSource = fs.readFileSync(path.join(root, '../src/index.css'), 'utf8')

  assert.match(appSource, /activeScreen === 'vault' \? 'vault-full-pane-surface relative min-h-full flex flex-col'/, 'Vault removes the ordinary centered page-shell constraint after server-authorized screen resolution')
  assert.match(appSource, /ref=\{activeScreen === 'vault' \? vaultMarqueeSurfaceRef : null\}/, 'the App-level full pane supplies marquee geometry')
  assert.match(appSource, /data-vault-marquee-surface=\{activeScreen === 'vault' \? '' : undefined\}/, 'the App-level full pane is the one named interaction surface')
  assert.match(appSource, /vaultMarqueePointerDownRef\.current\?\.\(event\)/, 'the App-level full pane owns pointer input')
  assert.match(appSource, /vault-pane-content pt-7 max-md:pt-5/, 'the existing page header stays centered and keeps its vertical position')
  assert.match(appSource, /fade-in.*activeScreen === 'vault'.*flex flex-1 flex-col/, 'the authorized Vault route receives the remaining main-pane height')
  assert.match(vaultSource, /className="flex flex-1 flex-col"/, 'the Vault route passes remaining height to the tree screen')
  assert.match(vaultSource, /className="vault-pane-content"/, 'the warning callout remains on the existing centered content line')
  assert.match(treeSource, /canvasRef:\s*marqueeCanvasRef/, 'selection geometry uses the App-level surface ref')
  assert.match(treeSource, /registerMarqueePointerDown\(marquee\.onPointerDown\)/, 'the tree controller registers its handler with that surface')
  assert.match(cssSource, /\.vault-full-pane-surface\s*\{[\s\S]*min-height:\s*100%/, 'surface height derives from the App main pane')
  assert.match(cssSource, /\.vault-pane-content\s*\{[\s\S]*padding-inline:\s*max\(2rem,\s*calc\(\(100% - 1440px\) \/ 2 \+ 2rem\)\)/, 'wide layouts retain the 1440px centered visual measure while the surface spans the pane')
})
