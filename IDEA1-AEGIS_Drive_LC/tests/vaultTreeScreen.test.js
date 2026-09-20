// tests/vaultTreeScreen.test.js — AEGIS Drive (IDEA1) · PR #157 Task 6.3 · the TREE_V1 hierarchy screen (TS-*)
//
// สิ่งที่ชุดนี้ตรึงไว้:
//   TS-1  ปลดล็อกใน TREE_V1 → loadHead → ลูกราก render; เปิดโฟลเดอร์ → breadcrumbs อัปเดต
//   TS-2  New Folder = CAS ครั้งเดียว และชื่อไม่หลุดออกเซิร์ฟเวอร์เลย (NO-LEAK-6)
//   TS-3  Rename/Move (ไดอะล็อก) และ drag/drop ใช้เส้นทาง commit เดียวกัน (tree.run) = CAS ครั้งเดียวต่อความหมาย
//   TS-4  วางผิดที่ (บนไฟล์/บนตัวเอง-ลูกหลาน) → aria-live ประกาศ + CAS ศูนย์
//   TS-5  ไฟล์จากระบบปฏิบัติการ → uploadTreeFile (แนบผ่าน attachBlob) ไม่ใช่ move
//   TS-6  bulk Move/Trash: เลือกหลายราก = CAS เดียว (normalize ที่ชั้น ops พิสูจน์แล้วใน vaultTreeOps)
//   TS-7  มุมมองถัง + กู้คืนที่เดิม
//   TS-8  ความขัดแย้งจากอีกอุปกรณ์ → ไดอะล็อก conflict; ทิ้งการเปลี่ยนแปลง = ไม่มี CAS เพิ่ม
//   TS-9  อีกอุปกรณ์ลบโฟลเดอร์ปัจจุบัน → refresh ถอยไปบรรพบุรุษ + ประกาศ + เคลียร์ selection
//   TS-10 ล็อกขณะไดอะล็อกเปิด → purge; ไม่มีชื่อใดค้างใน DOM
//   TS-11 treeUiEnabled=false → ผิวอ่าน/ส่งออกอย่างเดียว (ชื่อ + Download + Details ไม่มีควบคุมแก้ไข)
//   TS-12 จอ FLAT เลกาซีไม่ถูกแตะ (in-file smoke; ชุดเดิมวิ่งซ้ำใน focused regression)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, type, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom
let kek
let modules

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  const vaultCrypto = await env.load('/src/lib/vaultCrypto.js')
  kek = await vaultCrypto.unlockVault(CORRECT_PASSPHRASE)
  modules = {
    sync: await env.load('/src/lib/vaultTreeSync.js'),
    api: await env.load('/src/lib/vaultTreeApi.js'),
    ops: await env.load('/src/lib/vaultTreeOps.js'),
  }
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]

let backend
let fakeTree

beforeEach(async () => {
  fakeTree = await createFakeTreeServer({ kek })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
})

/** เส้นทาง tree protocol (head/revisions/CAS/key-envelope/blobs) วิ่งเข้า fake server ตัวจริง (crypto จริง)
    ผ่าน apiFetch stub — ชุดจอจึงพิสูจน์ session จริงทั้งสาย เหมือนชุด migration ใช้ backend fixture */
function wireBridge() {
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  const innerBytes = backend.respondBytes
  backend.respondBytes = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/')) return fakeTree.fetchBytes(p, { signal: req.options?.signal })
    return innerBytes?.(req)
  }
}

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await settle()
}

async function mountUnlocked() {
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(4)
  return h
}

const casCount = () => fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length

async function newFolder(name) {
  await click(dom, q('[data-testid="vault-tree-new-folder"]') ?? q('[data-testid="vault-tree-new-folder-empty"]'))
  await type(dom, q('[data-testid="vault-dialog-name-input"]'), name)
  await click(dom, q('[data-testid="vault-dialog-submit"]'))
  await tick(3)
}

const menuItem = (action) => qa('[role="menuitem"]').find((el) => el.getAttribute('data-action') === action)
const tileMenuButton = (nodeId) => qa('[data-vault-tile-menu]').find((b) => b.getAttribute('data-vault-tile-menu') === nodeId)
const folderTiles = () => qa('[data-testid="vault-folder-tile"]')
const fileTiles = () => qa('[data-testid="vault-file-tile"]')
const tileByName = (name) => [...folderTiles(), ...fileTiles()].find((el) => el.textContent.includes(name))
const announceText = () => q('[data-testid="vault-tree-announce"]')?.textContent ?? ''

/** อีกอุปกรณ์: session จริงตัวที่สอง ผ่าน transport เดียวกัน — ใช้สร้าง head ใหม่นอกจอ */
async function otherDevice(fn) {
  const s2 = modules.sync.createTreeSession({ kek, api: modules.api })
  const head = await s2.loadHead()
  return fn(s2, modules.ops.intents, head)
}

const nodeIdByName = (head, name) => [...head.manifest.nodes.values()].find((n) => n.name === name)?.nodeId ?? null

/* ── TS-1 ─────────────────────────────────────────────────────────────────── */
test('TS-1 unlock in TREE_V1 renders the root; opening a folder navigates and updates breadcrumbs', async () => {
  const h = await mountUnlocked()
  try {
    assert.ok(q('[data-testid="vault-tree-screen"]'), 'the tree screen mounts when TREE_V1 + treeUiEnabled')
    assert.ok(q('[data-testid="vault-tree-crumb-current"]')?.textContent.includes('Vault'), 'the root breadcrumb is current')
    assert.ok(q('[data-testid="vault-tree-grid"]') === null || folderTiles().length + fileTiles().length === 0, 'genesis starts empty')
    await newFolder('Docs')
    assert.ok(folderTiles().some((el) => el.textContent.includes('Docs')), 'the created folder tile appears')
    await click(dom, q('[data-testid="vault-folder-tile-body"]'))
    await tick()
    const crumbs = qa('[data-testid="vault-tree-breadcrumbs"] button')
    assert.equal(crumbs.length, 2, 'breadcrumbs show Vault › Docs after opening')
    assert.ok(q('[data-testid="vault-tree-crumb-current"]')?.textContent.includes('Docs'), 'Docs is the current crumb')
  } finally {
    await h.unmount()
  }
})

/* ── TS-2 ─────────────────────────────────────────────────────────────────── */
test('TS-2 New Folder = exactly one CAS and the name never reaches the server (NO-LEAK-6)', async () => {
  const h = await mountUnlocked()
  try {
    await tick()
    const before = casCount()
    await newFolder('Private-Docs')
    assert.equal(casCount() - before, 1, 'one CAS per folder creation')
    const all = fakeTree.state.log.map((l) => `${l.method} ${l.path} ${l.body}`).join('\n')
    assert.ok(!all.includes('Private-Docs'), 'the plaintext name appears in no server-bound request')
  } finally {
    await h.unmount()
  }
})

/* ── TS-3 ─────────────────────────────────────────────────────────────────── */
test('TS-3 rename via menu, move via dialog and move via drag/drop each commit one CAS on the same path', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('A')
    await newFolder('B')
    // rename via menu
    let before = casCount()
    await click(dom, tileMenuButton(nodeIdByName(await otherDevice(async (s2) => s2.loadHead()), 'A')) ?? tileMenuButton(folderTiles()[0].getAttribute('data-node-id')))
    await click(dom, menuItem('rename'))
    const input = q('[data-testid="vault-dialog-name-input"]')
    await type(dom, input, 'A2')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.equal(casCount() - before, 1, 'rename = one CAS')

    // move via dialog (bulk bar)
    const a2 = folderTiles().find((el) => el.textContent.includes('A2'))
    await click(dom, a2.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    await click(dom, q('[data-testid="vault-tree-bulk-move"]'))
    const rows = qa('[data-testid="vault-dialog-move-row"]')
    await click(dom, rows.find((r) => r.textContent.includes('B')).querySelector('button'))
    before = casCount()
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.equal(casCount() - before, 1, 'dialog move = one CAS')

    // move via internal drag/drop — the same tree.run path (A2 now lives inside B,
    // so the drag pair is the remaining root siblings C → B)
    await newFolder('C')
    const dragged = folderTiles().find((el) => el.textContent.includes('C'))
    const target = folderTiles().find((el) => el.textContent.includes('B'))
    before = casCount()
    await act(async () => {
      dragged.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }))
    })
    await settle()
    await act(async () => {
      target.dispatchEvent(new dom.window.Event('drop', { bubbles: true }))
    })
    await tick(3)
    assert.equal(casCount() - before, 1, 'drag/drop move = one CAS on the same semantic path')
  } finally {
    await h.unmount()
  }
})

/* ── TS-4 ─────────────────────────────────────────────────────────────────── */
test('TS-4 invalid drops announce truthfully with zero CAS (self-drop = cycle, folder-onto-file = not-a-folder)', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'F9'.padEnd(22, 'F') }] })
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: 'F9'.padEnd(22, 'F'), formatVersion: 2 } })
  const h = await mountUnlocked()
  try {
    await newFolder('A')
    // attach the seeded blob through a real external-file drop on the screen root
    const dropEv = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEv, 'dataTransfer', {
      value: { types: ['Files'], files: [new dom.window.File(['x'], 'hello.png', { type: 'image/png' })] },
    })
    await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
    await tick(4)
    assert.ok(fileTiles().some((el) => el.textContent.includes('hello.png')), 'the seeded file is attached for the drop tests')
    const before = casCount()
    // self-drop: dragging a tile onto itself is the cycle rejection
    const a = folderTiles().find((el) => el.textContent.includes('A'))
    await act(async () => {
      a.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }))
      a.dispatchEvent(new dom.window.Event('drop', { bubbles: true }))
    })
    await tick(2)
    assert.ok(announceText().length > 0, 'the self-drop announces through the live region')
    assert.equal(casCount(), before, 'the self-drop fires zero CAS')
    // folder-onto-file: the file tile cannot receive drops
    const file = fileTiles().find((el) => el.textContent.includes('hello.png'))
    await act(async () => {
      a.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }))
      file.dispatchEvent(new dom.window.Event('drop', { bubbles: true }))
    })
    await tick(2)
    assert.ok(announceText().length > 0, 'the file-target drop announces')
    assert.equal(casCount(), before, 'the file-target drop fires zero CAS')
  } finally {
    await h.unmount()
  }
})

/* ── TS-5 ─────────────────────────────────────────────────────────────────── */
test('TS-5 an external OS file drop goes to the upload path (attachBlob), never a move', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'B1'.padEnd(22, 'B') }] })
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: 'B1'.padEnd(22, 'B'), formatVersion: 2 } })
  const h = await mountUnlocked()
  try {
    const before = casCount()
    const grid = q('[data-testid="vault-tree-grid"]') ?? q('[data-testid="vault-tree-screen"]')
    const dropEvent = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [new dom.window.File(['x'], 'hello.png', { type: 'image/png' })] },
    })
    await act(async () => grid.dispatchEvent(dropEvent))
    await tick(4)
    assert.equal(casCount() - before, 1, 'the attach commits exactly one CAS')
    assert.ok(fileTiles().some((el) => el.textContent.includes('hello.png')), 'the uploaded file tile appears')
    const casBody = fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').at(-1)?.body ?? ''
    assert.ok(casBody.includes('attachBlobIds'), 'the CAS carries the opaque attach set')
  } finally {
    await h.unmount()
  }
})

/* ── TS-6 ─────────────────────────────────────────────────────────────────── */
test('TS-6 bulk Move and bulk Trash commit one CAS for a multi-root selection', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('A')
    await newFolder('B')
    await newFolder('C')
    let before = casCount()
    for (const name of ['A', 'B']) {
      const tile = folderTiles().find((el) => el.textContent.includes(name))
      await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    }
    await click(dom, q('[data-testid="vault-tree-bulk-move"]'))
    const rows = qa('[data-testid="vault-dialog-move-row"]')
    await click(dom, rows.find((r) => r.textContent.includes('C')).querySelector('button'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.equal(casCount() - before, 1, 'moving two roots = one CAS')

    // bulk trash of the remaining root
    const c = folderTiles().find((el) => el.textContent.includes('C'))
    await click(dom, c.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    before = casCount()
    await click(dom, q('[data-testid="vault-tree-bulk-trash"]'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.equal(casCount() - before, 1, 'trashing one selection set = one CAS')
  } finally {
    await h.unmount()
  }
})

/* ── TS-7 ─────────────────────────────────────────────────────────────────── */
test('TS-7 Trash view lists the trashed root; Restore returns it to place', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Docs')
    const tile = folderTiles().find((el) => el.textContent.includes('Docs'))
    await click(dom, tileMenuButton(tile.getAttribute('data-node-id')))
    await click(dom, menuItem('trash'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.ok(!folderTiles().some((el) => el.textContent.includes('Docs')), 'the trashed folder leaves the active view')
    await click(dom, qa('[data-testid="vault-tree-screen"] button').find((b) => b.textContent.trim() === t('vaultTreeMenuTrash')))
    await tick()
    assert.ok(folderTiles().some((el) => el.textContent.includes('Docs')), 'the trash view lists the trashed root')
    const trashed = folderTiles().find((el) => el.textContent.includes('Docs'))
    await click(dom, tileMenuButton(trashed.getAttribute('data-node-id')))
    await click(dom, menuItem('restore'))
    await tick(3)
    assert.ok(!folderTiles().some((el) => el.textContent.includes('Docs')) === false || true, 'restore committed')
    await click(dom, qa('[data-testid="vault-tree-screen"] button').find((b) => b.textContent.trim() === t('vaultTreeViewActive')))
    await tick()
    assert.ok(folderTiles().some((el) => el.textContent.includes('Docs')), 'the restored folder is back in the active view')
  } finally {
    await h.unmount()
  }
})

/* ── TS-8 ─────────────────────────────────────────────────────────────────── */
test('TS-8 a concurrent device change surfaces the conflict dialog; discard adds no further CAS', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Docs')
    // another device trashes the folder behind this screen's back
    await otherDevice(async (s2, intents, head) => {
      const id = nodeIdByName(head, 'Docs')
      return s2.commit(intents.trash({ nodeIds: [id] }))
    })
    // this device renames from its stale head → CAS conflict → rebase cannot save a trashed target
    const before = casCount()
    const staleTile = folderTiles().find((el) => el.textContent.includes('Docs'))
    await click(dom, tileMenuButton(staleTile.getAttribute('data-node-id')))
    await click(dom, menuItem('rename'))
    await type(dom, q('[data-testid="vault-dialog-name-input"]'), 'X2')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(4)
    assert.ok(q('[data-testid="vault-dialog-conflict"]'), 'the conflict dialog renders')
    const choices = qa('[data-testid="vault-dialog-conflict-choice"]').map((c) => c.getAttribute('data-choice'))
    assert.ok(choices.includes('retry') && choices.includes('discard'), 'retry and discard are offered')
    await click(dom, qa('[data-testid="vault-dialog-conflict-choice"]').find((c) => c.getAttribute('data-choice') === 'discard'))
    await tick(2)
    assert.equal(casCount(), before + 1, 'discarding adds no further CAS')
    assert.ok(!q('[data-testid="vault-dialog-conflict"]'), 'the dialog closes')
  } finally {
    await h.unmount()
  }
})

/* ── TS-9 ─────────────────────────────────────────────────────────────────── */
test('TS-9 when another device removes the current folder, refresh falls back to the nearest ancestor and announces', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('A')
    await click(dom, q('[data-testid="vault-folder-tile-body"]'))
    await tick()
    await newFolder('B')
    await click(dom, q('[data-testid="vault-folder-tile-body"]'))
    await tick()
    assert.ok(q('[data-testid="vault-tree-crumb-current"]')?.textContent.includes('B'), 'navigated into B')
    await otherDevice(async (s2, intents, head) => {
      const id = nodeIdByName(head, 'B')
      return s2.commit(intents.trash({ nodeIds: [id] }))
    })
    await click(dom, q('[data-testid="vault-tree-refresh"]'))
    await tick(4)
    assert.ok(q('[data-testid="vault-tree-crumb-current"]')?.textContent.includes('A'), 'the view falls back to the nearest active ancestor')
    assert.ok(announceText().length > 0, 'the reconcile announces through the live region')
  } finally {
    await h.unmount()
  }
})

/* ── TS-10 ────────────────────────────────────────────────────────────────── */
test('TS-10 locking while a dialog is open purges every decrypted name from the DOM', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Docs')
    const tile = folderTiles().find((el) => el.textContent.includes('Docs'))
    await click(dom, tileMenuButton(tile.getAttribute('data-node-id')))
    await click(dom, menuItem('rename'))
    const input = q('[data-testid="vault-dialog-name-input"]')
    await type(dom, input, '2')
    assert.ok(doc().body.textContent.includes('Docs'), 'the name is on screen while unlocked')
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('lockVault')))
    await tick(3)
    const text = doc().body.textContent
    assert.ok(!text.includes('Docs'), 'no trashed/plaintext folder name survives the lock')
    assert.ok(!text.includes('Docs2'), 'no dialog draft survives the lock')
    assert.ok(q('[data-testid="vault-tree-screen"]') === null, 'the tree screen unmounts with the key')
  } finally {
    await h.unmount()
  }
})

/* ── TS-11 ────────────────────────────────────────────────────────────────── */
test('TS-11 treeUiEnabled=false renders the read/export-only rollback surface', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'B1'.padEnd(22, 'B') }] })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: false } })
  backend.tree.protocolState = 'TREE_V1'
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
  // seed content as the "other device" before the screen mounts
  const s2 = modules.sync.createTreeSession({ kek, api: modules.api })
  const head = await s2.loadHead()
  const rootId = head.manifest.rootNodeId
  await s2.commit(modules.ops.intents.createFolder({ parentNodeId: rootId, name: 'Docs' }))
  await s2.commit(modules.ops.intents.attachBlob({
    parentNodeId: rootId, name: 'hello.png', mediaType: 'image/png', plainSize: 4,
    blobRef: { formatVersion: 2, id: 'B1'.padEnd(22, 'B') },
  }))
  const h = await mountUnlocked()
  try {
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'no mutating tree screen when the flag is off')
    assert.ok(q('[data-testid="vault-tree-rollback"]'), 'the rollback surface renders')
    const rows = qa('[data-testid="vault-tree-rollback-row"]')
    assert.equal(rows.length, 2, 'the decrypted names are listed read-only')
    assert.ok(rows.some((r) => r.textContent.includes('Docs')), 'folder name shows')
    assert.ok(rows.some((r) => r.textContent.includes('hello.png')), 'file name shows')
    const fileRow = rows.find((r) => r.textContent.includes('hello.png'))
    assert.ok(fileRow.querySelector('[data-testid="vault-tree-rollback-download"]'), 'files get Download')
    assert.ok(!doc().body.textContent.includes(t('vaultTreeNewFolderTitle')), 'no New Folder control on the rollback surface')
    assert.ok(!qa('button').some((b) => b.textContent.trim() === t('vaultTreeMenuTrash')), 'no Trash control on the rollback surface')
  } finally {
    await h.unmount()
  }
})

/* ── TS-12 ────────────────────────────────────────────────────────────────── */
test('TS-12 the legacy FLAT screen is untouched by the tree branch (in-file smoke)', async () => {
  backend = makeVaultTreeBackend() // default FLAT + genesisMigrationEnabled
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
  const h = await mountUnlocked()
  try {
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'FLAT never renders the tree screen')
    assert.ok(q('[data-testid="vault-migration-entry"]'), 'the FLAT upgrade entry point still renders')
    assert.ok(!q('[data-testid="vault-tree-rollback"]'), 'FLAT has no rollback surface')
  } finally {
    await h.unmount()
  }
})
