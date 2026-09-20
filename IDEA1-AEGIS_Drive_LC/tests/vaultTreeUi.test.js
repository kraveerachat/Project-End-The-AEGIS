// tests/vaultTreeUi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 6.1 · folder/file tiles, breadcrumbs, tile menu (UI-*)
//
// สิ่งที่ชุดนี้ตรึงไว้:
//   UI-1  folder/file tiles: testid/ไอคอนต่างกัน; โฟลเดอร์โชว์จำนวนลูก (active view) ไม่โชว์ขนาด;
//         ไฟล์โชว์ขนาด/ชนิดจาก manifest node (ไม่ใช่ซองเลกาซี)
//   UI-2  ล็อกอยู่: จอต้นไม้ไม่มีอยู่เลย — ม่านทึบแสดงแค่ `${id}.aegisenc` + ขนาด ciphertext (มรดกเดิม)
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
import { makeVaultTreeBackend, serverBlob } from './fixtures/vaultTreeBackend.js'
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
test('UI-1 folder/file tiles: distinct testids and icons; folder child count without size; file size/type from the manifest node', async () => {
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
    assert.ok(q('[data-testid="vault-folder-child-count"]'), 'the folder shows its child count')
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

/* ── UI-2 ─────────────────────────────────────────────────────────────────── */
test('UI-2 locked vault with TREE_V1 + treeUiEnabled: no tree UI exists; the locked veil shows only opaque inventory', async () => {
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlob({ id: 'lockedblob1'.padEnd(22, 'x'), name: 'secret-notes.txt', plainSize: 128, size: 256 })] },
    error: null,
  }
  globalThis.__VAULT_BACKEND__ = backend
  const { Vault } = await env.load('/src/screens/Vault.jsx')
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'a locked vault renders no tree screen')
    assert.ok(!q('[data-testid="vault-folder-tile"]') && !q('[data-testid="vault-file-tile"]'), 'locked: no tiles at all')
    const veil = doc().body.textContent
    assert.ok(veil.includes('.aegisenc'), 'the locked veil still renders the opaque inventory (`${id}.aegisenc`)')
    assert.ok(veil.includes('256'), 'the veil shows the ciphertext size')
    assert.ok(!veil.includes('secret-notes.txt'), 'no plaintext name is rendered while locked')
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
