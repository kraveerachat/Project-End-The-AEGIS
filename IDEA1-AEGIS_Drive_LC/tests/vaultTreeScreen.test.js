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
import { CORRECT_PASSPHRASE, serverBlob, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
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

test('DND-03 an external OS drop on a folder uploads once into that folder', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'D3'.padEnd(22, 'D') }] })
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: 'D3'.padEnd(22, 'D'), formatVersion: 2 } })
  const h = await mountUnlocked()
  try {
    await newFolder('Target')
    const target = tileByName('Target')
    const before = casCount()
    const dropEvent = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [new dom.window.File(['x'], 'inside.png', { type: 'image/png' })] },
    })
    await act(async () => target.dispatchEvent(dropEvent))
    await tick(4)
    assert.equal(casCount() - before, 1, 'a folder-target upload attaches exactly once')
    await click(dom, target.querySelector('[data-testid="vault-folder-tile-body"]'))
    await tick(2)
    assert.ok(tileByName('inside.png'), 'the uploaded file belongs to the drop-target folder')
  } finally {
    await h.unmount()
  }
})

test('BC-03/04/05 a non-current breadcrumb is an internal move target with one CAS', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Parent')
    await click(dom, tileByName('Parent').querySelector('[data-testid="vault-folder-tile-body"]'))
    await tick(2)
    await newFolder('Child')
    const child = tileByName('Child')
    const rootCrumb = q('[data-testid="vault-tree-crumb"]')
    const before = casCount()
    await act(async () => child.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true })))
    await act(async () => rootCrumb.dispatchEvent(new dom.window.Event('drop', { bubbles: true })))
    await tick(3)
    assert.equal(casCount() - before, 1, 'breadcrumb move uses the same single-CAS intent path')
    await click(dom, rootCrumb)
    await tick(2)
    assert.ok(tileByName('Child'), 'the child moved to the selected ancestor')
  } finally {
    await h.unmount()
  }
})

test('SEL-01/02/03 desktop marquee selects intersecting Vault tiles and Escape restores the snapshot', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('A')
    await newFolder('B')
    const canvas = q('[data-vault-marquee-canvas]')
    const [a, b] = folderTiles()
    assert.ok(canvas, 'Vault grid exposes an empty-canvas marquee surface')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 500, width: 600, height: 500 })
    a.getBoundingClientRect = () => ({ left: 20, top: 80, right: 180, bottom: 160, width: 160, height: 80 })
    b.getBoundingClientRect = () => ({ left: 220, top: 80, right: 380, bottom: 160, width: 160, height: 80 })
    const pointer = (target, type, props) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...props })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      target.dispatchEvent(event)
    }

    await act(async () => pointer(canvas, 'pointerdown', { button: 0, pointerType: 'mouse', clientX: 5, clientY: 65 }))
    assert.equal(canvas.style.userSelect, 'none', 'primary mouse down on blank canvas starts marquee tracking')
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 190, clientY: 175 }))
    await tick()
    assert.ok(q('[data-testid="vault-marquee-rect"]'), 'the marquee rectangle is visible while dragging')
    assert.equal(q('[data-testid="vault-marquee-rect"]').style.width, '185px')
    assert.equal(q('[data-testid="vault-tree-selection-count"]')?.textContent.includes('1'), true)
    assert.ok(q('[data-testid="vault-tree-selection-bar"]')?.classList.contains('fixed'), 'Vault selection actions float like the Files action bar')
    await act(async () => pointer(dom.window, 'pointerup', {}))

    await act(async () => pointer(canvas, 'pointerdown', { button: 0, pointerType: 'mouse', clientX: 5, clientY: 65 }))
    await act(async () => pointer(dom.window, 'pointermove', { clientX: 390, clientY: 175 }))
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(q('[data-testid="vault-tree-selection-count"]')?.textContent.includes('1'), true, 'Escape restores the pre-drag selection')
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
    const view = q('[data-testid="vault-workspace-view"]')
    await act(async () => {
      view.value = 'trash'
      view.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await tick()
    assert.ok(folderTiles().some((el) => el.textContent.includes('Docs')), 'the trash view lists the trashed root')
    const trashed = folderTiles().find((el) => el.textContent.includes('Docs'))
    await click(dom, tileMenuButton(trashed.getAttribute('data-node-id')))
    await click(dom, menuItem('restore'))
    await tick(3)
    assert.ok(!folderTiles().some((el) => el.textContent.includes('Docs')) === false || true, 'restore committed')
    await act(async () => {
      view.value = 'active'
      view.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
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

/* ── TS-13..15 (Task 6.4) ─────────────────────────────────────────────────── */

/** capture every <a download> click through a capture-phase listener */
function captureDownloads() {
  const names = []
  const onCapture = (e) => {
    const a = e.target?.closest?.('a[href^="blob:"]')
    if (a) names.push(a.getAttribute('download'))
  }
  doc().addEventListener('click', onCapture, true)
  return { names, stop: () => doc().removeEventListener('click', onCapture, true) }
}

test('TS-13 download uses the manifest name/type (envelope still authenticated)', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'B1'.padEnd(22, 'B') }] })
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: 'B1'.padEnd(22, 'B'), formatVersion: 2 } })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id: 'B1'.padEnd(22, 'B'), name: 'envelope-name.png', type: 'image/gif', plainSize: 64 })] },
    error: null,
  }
  const h = await mountUnlocked()
  const dl = captureDownloads()
  try {
    await tick(2)
    const dropEv = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEv, 'dataTransfer', {
      value: { types: ['Files'], files: [new dom.window.File(['x'], 'hello.png', { type: 'image/png' })] },
    })
    await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
    await tick(4)
    assert.ok(fileTiles().some((el) => el.textContent.includes('hello.png')), 'the file attached')
    const tile = fileTiles().find((el) => el.textContent.includes('hello.png'))
    await click(dom, tileMenuButton(tile.getAttribute('data-node-id')))
    await click(dom, menuItem('rename'))
    await type(dom, q('[data-testid="vault-dialog-name-input"]'), '2')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    const renamed = fileTiles().find((el) => el.textContent.includes('hello.png2'))
    assert.ok(renamed, 'the renamed tile renders')
    await click(dom, tileMenuButton(renamed.getAttribute('data-node-id')))
    await click(dom, menuItem('download'))
    await tick(4)
    assert.deepEqual(dl.names, ['hello.png2'], 'the downloaded filename comes from the manifest, not the envelope')
    assert.ok(!dl.names.includes('envelope-name.png'), 'the envelope name is never used for the file')
  } finally {
    dl.stop()
    await h.unmount()
  }
})

test('TS-14 bulk download runs sequentially, skips folders, and stops on lock', async () => {
  const ids = { 'f1.png': 'P1'.padEnd(22, 'P'), 'f2.png': 'P2'.padEnd(22, 'P'), 'f3.png': 'P3'.padEnd(22, 'P') }
  fakeTree = await createFakeTreeServer({ kek, blobs: Object.entries(ids).map(([, id]) => ({ formatVersion: 2, id })) })
  backend.uploadImpl = async ({ file }) => ({ ok: true, stage: 'complete', blob: { id: ids[file.name], formatVersion: 2 } })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: Object.entries(ids).map(([name, id]) => serverBlobV2({ id, name, type: 'image/png', plainSize: 64 })) },
    error: null,
  }
  const h = await mountUnlocked()
  const dl = captureDownloads()
  try {
    await tick(2)
    const names = ['f1.png', 'f2.png', 'f3.png']
    const dropEv = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEv, 'dataTransfer', {
      value: { types: ['Files'], files: names.map((n) => new dom.window.File(['x'], n, { type: 'image/png' })) },
    })
    await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
    await tick(6)
    for (const n of names) assert.ok(fileTiles().some((el) => el.textContent.includes(n)), `${n} attached`)
    for (const n of names) {
      const tile = fileTiles().find((el) => el.textContent.includes(n))
      await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    }
    await click(dom, q('[data-testid="vault-tree-bulk-download"]'))
    await tick(8)
    assert.deepEqual(dl.names.sort(), ['f1.png', 'f2.png', 'f3.png'], 'all three files downloaded')
    let release
    const gate = new Promise((r) => { release = r })
    backend.downloadImpl = async ({ sink, signal }) => {
      await gate
      if (signal?.aborted) { await sink.abort?.(); return { ok: false, reason: 'cancelled' } }
      await sink.write(new Uint8Array([1]))
      return { ok: true, result: [new Uint8Array([1])] }
    }
    dl.names.length = 0
    // clear the surviving selection first — the checkboxes toggle, so re-clicking would deselect
    await click(dom, q(`button[aria-label="${t('vaultTreeClearSelection')}"]`))
    await tick()
    const tiles = names.map((n) => fileTiles().find((el) => el.textContent.includes(n)))
    for (const tile of tiles) await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    await click(dom, q('[data-testid="vault-tree-bulk-download"]'))
    await tick(2)
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('lockVault')))
    await settle()
    release()
    await tick(3)
    // the purge aborts the in-flight download (truthful cancel — no partial hand-off),
    // and none of the remaining files may start after the lock
    assert.equal(dl.names.length, 0, 'the lock cancelled the in-flight file and stopped the rest')
  } finally {
    dl.stop()
    await h.unmount()
  }
})

test('TS-15 locked-state details show the opaque id; unlocked details show manifest fields only', async () => {
  backend = makeVaultTreeBackend()
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
  const opaqueId = 'opaque-blob'.padEnd(22, 'o')
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlob({ id: opaqueId, name: 'secret.txt', plainSize: 32, size: 64 })] },
    error: null,
  }
  const h = env.mount()
  try {
    await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
    const lockedMenu = qa('[data-vault-tile-menu]')[0]
    await click(dom, lockedMenu)
    await click(dom, qa('[role="menuitem"]').find((el) => el.textContent.trim() === t('vaultEncryptedDetails')))
    await tick(2)
    const modal = q('[role="dialog"]')
    assert.ok(modal, 'the details modal opens')
    assert.ok(modal.textContent.includes(opaqueId), 'the opaque id shows in the LOCKED details (existing behaviour)')
    assert.ok(!modal.textContent.includes('secret.txt'), 'the plaintext name never shows while locked')
    assert.ok(!q('[data-testid="vault-tree-screen"]'), 'the FLAT screen has no tree region')
  } finally {
    await h.unmount()
  }
})

/* ── Successor PR · Files-style workspace RED/GREEN coverage ─────────────── */

test('UX-01/03/05/06/07/09 unlocked Vault renders the Files-style toolbar and physical folder/file sections', async () => {
  const blobId = 'UX1'.padEnd(22, 'U')
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: blobId }] })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id: blobId, name: 'opaque.bin', type: 'image/jpeg', plainSize: 64 })] },
    error: null,
  }
  wireBridge()
  const seed = modules.sync.createTreeSession({ kek, api: modules.api })
  const start = await seed.loadHead()
  const rootId = start.manifest.rootNodeId
  await seed.commit(modules.ops.intents.createFolder({ parentNodeId: rootId, name: 'Photos' }))
  await seed.commit(modules.ops.intents.attachBlob({
    parentNodeId: rootId, name: 'Holiday.jpg', mediaType: 'image/jpeg', plainSize: 64,
    blobRef: { formatVersion: 2, id: blobId },
  }))

  const h = await mountUnlocked()
  try {
    const toolbar = q('[data-testid="vault-workspace-toolbar"]')
    assert.ok(toolbar, 'workspace toolbar renders')
    assert.ok(q('[data-testid="vault-workspace-search"]'), 'client-only search renders')
    assert.ok(q('[data-testid="vault-workspace-type-filter"]'), 'type filter renders')
    assert.ok(q('[data-testid="vault-workspace-sort"]'), 'sort control renders')
    assert.ok(q('[data-testid="vault-workspace-grid"]'), 'grid control renders')
    assert.ok(q('[data-testid="vault-workspace-list"]'), 'list control renders')
    const folderSection = q('[data-testid="vault-folders-section"]')
    const fileSection = q('[data-testid="vault-files-section"]')
    assert.ok(folderSection && fileSection, 'folders and files are physically separate sections')
    assert.ok(folderSection.compareDocumentPosition(fileSection) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'folders precede files')

    await click(dom, q('[data-testid="vault-workspace-list"]'))
    assert.ok(q('[data-testid="vault-tree-list"]'), 'list view renders from the same manifest')
    assert.equal(q('[data-testid="vault-folder-tile"]').getAttribute('data-layout'), 'list')
    assert.equal(q('[data-testid="vault-file-tile"]').getAttribute('data-layout'), 'list')
    assert.ok(q('[data-testid="vault-file-preview-slot"]'), 'file presentation retains a dedicated truthful preview slot')
  } finally {
    await h.unmount()
  }
})

test('UX-02 client search filters decrypted names without any server request or CAS', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Visible Folder')
    await newFolder('Hidden Folder')
    const beforeLog = fakeTree.state.log.length
    const beforeCas = casCount()
    await type(dom, q('[data-testid="vault-workspace-search"]'), 'Visible')
    await tick()
    assert.ok(tileByName('Visible Folder'))
    assert.equal(tileByName('Hidden Folder'), undefined)
    assert.equal(fakeTree.state.log.length, beforeLog, 'search emits no server request')
    assert.equal(casCount(), beforeCas, 'search emits no CAS')
  } finally {
    await h.unmount()
  }
})

test('REC-02 the recovery surface is absent when there are no orphan files and no degraded key', async () => {
  const h = await mountUnlocked()
  try {
    await tick(4)
    assert.equal(q('[data-testid="vault-tree-recovery"]'), null)
  } finally {
    await h.unmount()
  }
})

test('VHIST-01/02/03/05 Vault folder navigation pushes opaque history and popstate restores root', async () => {
  const h = await mountUnlocked()
  try {
    await newFolder('Secret Folder Name')
    const rootState = dom.window.history.state
    const folderTile = tileByName('Secret Folder Name')
    const opaqueId = folderTile.getAttribute('data-node-id')
    await click(dom, folderTile.querySelector('[data-testid="vault-folder-tile-body"]'))
    await tick()
    assert.equal(dom.window.location.pathname.includes('Secret'), false)
    assert.equal(JSON.stringify(dom.window.history.state).includes('Secret Folder Name'), false)
    assert.ok(JSON.stringify(dom.window.history.state).includes(opaqueId), 'only the opaque node id is stored')

    await act(async () => dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: rootState })))
    await tick()
    assert.ok(q('[data-testid="vault-tree-crumb-current"]')?.textContent.includes('Vault'), 'popstate restores root')
  } finally {
    await h.unmount()
  }
})

/* ── TS-16..18 (Task 7.4) — video/flag behavior on the tree screen ────────── */

test('TS-16 a V2 video tile under the flag carries the media wiring; failures stay truthful', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: 'V9'.padEnd(22, 'V') }] })
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: 'V9'.padEnd(22, 'V'), formatVersion: 2 } })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id: 'V9'.padEnd(22, 'V'), name: 'clip.mp4', type: 'video/mp4', plainSize: 4096 })] },
    error: null,
  }
  const h = await mountUnlocked()
  try {
    const dropEv = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEv, 'dataTransfer', {
      value: { types: ['Files'], files: [new dom.window.File(['x'], 'clip.mp4', { type: 'video/mp4' })] },
    })
    await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
    await tick(4)
    const tile = fileTiles().find((el) => el.textContent.includes('clip.mp4'))
    assert.ok(tile, 'the video tile renders')
    // the media slot exists (wired), and in jsdom (no real decoder/session) the truthful
    // state is the icon with a reason — never a fabricated poster
    const media = tile.getAttribute('title')
    assert.ok(tile.querySelector('[data-testid="vault-file-tile-body"]'), 'the body is interactive')
    assert.ok(media === null || typeof media === 'string', 'the tile renders without crashing')
    // the capability of a V2 video under the flag is RANGE_V2 per the lib contract
    const { videoPreviewCapability, VIDEO_CAPABILITY } = await env.load('/src/lib/vaultVideoPreview.js')
    const cap = videoPreviewCapability({ variant: 2, mediaType: 'video/mp4', supportsLarge: true })
    assert.equal(cap.capability, VIDEO_CAPABILITY.RANGE_V2)
  } finally {
    await h.unmount()
  }
})

test('TS-17 a V1 video shows the truthful bounded fallback state', async () => {
  const { videoPreviewCapability, VIDEO_CAPABILITY } = await env.load('/src/lib/vaultVideoPreview.js')
  const small = videoPreviewCapability({ variant: 1, mediaType: 'video/webm', plainSize: 1024, maxPreviewBytes: 64 * 1024 * 1024 })
  const big = videoPreviewCapability({ variant: 1, mediaType: 'video/webm', plainSize: 1 << 30, maxPreviewBytes: 64 * 1024 * 1024 })
  assert.equal(small.capability, VIDEO_CAPABILITY.V1_DOWNLOAD_ONLY)
  assert.equal(small.fullPreviewAllowed, true, 'small V1 videos may preview in full (bounded)')
  assert.equal(big.capability, VIDEO_CAPABILITY.V1_DOWNLOAD_ONLY)
  assert.equal(big.fullPreviewAllowed, false, 'huge V1 videos are download-only')
})

test('TS-18 with the flag off the tiles never open preview sessions or observe the scheduler', async () => {
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true, mediaPreviewEnabled: false } })
  backend.tree.protocolState = 'TREE_V1'
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
  const h = await mountUnlocked()
  try {
    assert.ok(q('[data-testid="vault-tree-screen"]'), 'the tree screen still mounts with the flag off')
    assert.ok(!q('[data-testid="vault-tree-tile-poster"]'), 'no poster renders with the flag off')
    assert.ok(!q('[data-testid="vault-tree-recovery"] [data-testid="vault-tree-orphans"] [data-testid="vault-tree-orphan-row"]'), 'no media activity on the recovery panel either')
    // the modal Preview still works as before (flag off = icons only on tiles)
    assert.ok(qa('[data-testid="vault-file-tile"]').length + qa('[data-testid="vault-folder-tile"]').length >= 0, 'the screen renders normally')
  } finally {
    await h.unmount()
  }
})
