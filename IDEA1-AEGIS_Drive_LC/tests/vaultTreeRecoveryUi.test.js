// tests/vaultTreeRecoveryUi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 6.4 · recovery panel (RP-*)
//
//   RP-1  กุญแจช่องเดียวเสีย: แผงแสดงสถานะจริง + Repair → casKeyEnvelope → กลับมาแก้ไขได้เมื่อซ่อมสำเร็จเท่านั้น
//   RP-2  สองช่องเสียทั้งคู่: fail-closed — ไม่วาดต้นไม้ ไม่มีควบคุมแก้ไข
//   RP-3  blob UNREFERENCED: รายการ "กู้ไปยังห้องนิรภัย" พร้อมชื่อที่ถอดได้; เลือกโฟลเดอร์ → attach; สำเร็จ = หายจากรายการ
//   RP-4  ข้อความความปลอดภัยต้องรับความจริงเรื่อง traffic analysis — ห้ามอ้าง "zero metadata" เด็ดขาด
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, type, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')
const B2 = '2'.padEnd(22, 'B')

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

/** PR220-R2 B1: the orphan list is a compact summary until the Human expands it */
async function expandOrphans() {
  const toggle = q('[data-testid="vault-tree-orphans-toggle"]')
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') await click(dom, toggle)
}

async function mountUnlocked() {
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(4)
  return h
}

/** ทำลาย wrapped TRK ของช่องหนึ่ง/ทั้งสอง — unwrap จะเห็นช่องนั้นเป็น null */
function corruptSlot(slot) {
  fakeTree.state.envelope[slot] = {
    ...fakeTree.state.envelope[slot],
    wrappedTrkB64: Buffer.from('corrupted-wrapped-trk-bytes-!').toString('base64'),
  }
}

const casKeyEnvelopeCount = () => fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/key-envelope').length

/* ── RP-1 ─────────────────────────────────────────────────────────────────── */
test('RP-1 one damaged key slot: truthful panel, repair through casKeyEnvelope, mutations re-enabled only after repair', async () => {
  corruptSlot('recovery')
  const h = await mountUnlocked()
  try {
    const panel = q('[data-testid="vault-tree-recovery"]')
    assert.ok(panel, 'the recovery panel renders while a slot is damaged')
    assert.ok(panel.textContent.includes(t('vaultTreeKeySlotCorrupt')), 'the one-slot state copy is truthful')
    assert.ok(!qa('button').some((b) => b.textContent.trim() === t('vaultTreeNewFolderTitle')), 'mutation controls are gone while degraded')
    const before = casKeyEnvelopeCount()
    await click(dom, q('[data-testid="vault-tree-key-repair"]'))
    await tick(4)
    assert.equal(casKeyEnvelopeCount() - before, 1, 'repair issues exactly one key-envelope CAS')
    assert.ok(!q('[data-testid="vault-tree-key-repair"]'), 'the repair affordance closes after success')
    await click(dom, q('[data-testid="vault-tree-new-folder"]'))
    await type(dom, q('[data-testid="vault-dialog-name-input"]'), 'AfterRepair')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    assert.ok(qa('[data-testid="vault-folder-tile"]').some((el) => el.textContent.includes('AfterRepair')), 'mutations work again after the repair')
  } finally {
    await h.unmount()
  }
})

/* ── RP-2 ─────────────────────────────────────────────────────────────────── */
test('RP-2 both slots damaged: fail closed — no tree, no mutation controls', async () => {
  corruptSlot('primary')
  corruptSlot('recovery')
  const h = await mountUnlocked()
  try {
    const panel = q('[data-testid="vault-tree-recovery"]')
    assert.ok(panel, 'the recovery panel renders in the fail-closed state')
    assert.ok(panel.textContent.includes(t('vaultTreeKeyBothSlotsCorrupt')), 'the fail-closed copy shows')
    assert.ok(!q('[data-testid="vault-tree-grid"]') && qa('[data-testid="vault-folder-tile"]').length === 0, 'no tree is rendered')
    assert.ok(!qa('button').some((b) => b.textContent.trim() === t('vaultTreeNewFolderTitle')), 'no mutation controls')
    assert.ok(!q('[data-testid="vault-tree-key-repair"]'), 'no repair affordance when nothing can be repaired')
  } finally {
    await h.unmount()
  }
})

/* ── RP-3 ─────────────────────────────────────────────────────────────────── */
test('RP-3 orphan blobs: decrypted names listed, recover attaches to the chosen folder and empties the list', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [serverBlobV2({ id: B2, name: 'orphan.bin', type: 'text/plain', plainSize: 64 })] })
  const h = await mountUnlocked()
  try {
    const panel = q('[data-testid="vault-tree-recovery"]')
    assert.ok(panel, 'the recovery panel renders')
    await expandOrphans()
    const orphans = q('[data-testid="vault-tree-orphans"]')
    assert.ok(orphans, 'the orphan section renders')
    assert.ok(orphans.textContent.includes('orphan.bin'), 'the decrypted orphan name is shown')
    const before = fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length
    await click(dom, q('[data-testid="vault-tree-orphan-recover"]'))
    // the destination chooser: choose the root (default pre-selected row)
    const rows = qa('[data-testid="vault-dialog-move-row"]')
    await click(dom, rows[0].querySelector('button'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(4)
    assert.equal(fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length - before, 1, 'the recover commits one CAS')
    assert.ok(qa('[data-testid="vault-file-tile"]').some((el) => el.textContent.includes('orphan.bin')), 'the recovered file appears in the vault')
    const after = q('[data-testid="vault-tree-orphans"]')
    assert.ok(!after?.textContent.includes('orphan.bin'), 'the successful attach removes the orphan from the list')
  } finally {
    await h.unmount()
  }
})

/* ── RP-4 ─────────────────────────────────────────────────────────────────── */
test('RP-4 the security copy acknowledges traffic analysis and never claims zero metadata', async () => {
  const h = await mountUnlocked()
  try {
    const panel = q('[data-testid="vault-tree-recovery"]')
    const screenText = q('[data-testid="vault-tree-screen"]')?.textContent ?? ''
    const noteText = panel?.textContent ?? screenText
    assert.ok(
      noteText.includes('traffic timing, access patterns, and encrypted sizes'),
      'the security note includes the traffic-analysis acknowledgement',
    )
    assert.ok(!noteText.toLowerCase().includes('zero metadata'), 'no "zero metadata" claim anywhere')
  } finally {
    await h.unmount()
  }
})

/* ── PR220-R1 (E): truthful orphan copy, authoritative refresh, bounded sequential bulk recovery ── */
const ORPHANS = [
  serverBlobV2({ id: 'a'.padEnd(22, 'A'), name: 'a.txt', type: 'text/plain', plainSize: 11 }),
  serverBlobV2({ id: 'b'.padEnd(22, 'B'), name: 'b.txt', type: 'text/plain', plainSize: 12 }),
  serverBlobV2({ id: 'c'.padEnd(22, 'C'), name: 'A.TXT', type: 'text/plain', plainSize: 13 }),
]
const headPosts = () => fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length
const blobLists = () => fakeTree.state.log.filter((l) => l.method === 'GET' && String(l.path).startsWith('/api/vault/tree/blobs')).length
const deletes = () => fakeTree.state.log.filter((l) => l.method === 'DELETE')
const orphanRows = () => qa('[data-testid="vault-tree-orphan-row"]')
const byLabel = (label) => qa('button').find((b) => b.getAttribute('aria-label') === label)
const buttonText = (text) => qa('button').find((b) => b.textContent.trim() === text)

test('RP-5 orphan copy says the upload finished but is not yet linked; Refresh is an authoritative re-list', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: ORPHANS.slice(0, 1) })
  const h = await mountUnlocked()
  try {
    await expandOrphans()
    const section = q('[data-testid="vault-tree-orphans"]')
    assert.ok(section.textContent.includes(t('vaultTreeOrphansDescription')), 'truthful explanation shown')
    assert.match(t('vaultTreeOrphansDescription'), /upload finished/i)
    assert.match(t('vaultTreeOrphansDescription'), /not yet linked/i)
    const refresh = byLabel(t('vaultTreeOrphansRefresh'))
    assert.ok(refresh, 'the icon is labelled as a refresh of the recovery list, not a repair/delete')
    const before = blobLists()
    await click(dom, refresh)
    await tick(3)
    assert.ok(blobLists() > before, 'Refresh performs a real GET /tree/blobs')
    assert.equal(orphanRows().length, 1, 'refresh never hides an orphan the server still reports')
    assert.deepEqual(deletes(), [], 'refresh deletes nothing')
  } finally {
    await h.unmount()
  }
})

test('RP-6 Recover all attaches sequentially to the Vault root; a collision stays listed with its reason; nothing deleted', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: ORPHANS })
  let inFlight = 0
  let maxInFlight = 0
  const inner = fakeTree.fetchJson.bind(fakeTree)
  fakeTree.fetchJson = async (p, opts) => {
    const isHead = opts?.method === 'POST' && p === '/api/vault/tree/head'
    if (isHead) { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight) }
    try {
      if (isHead) await new Promise((r) => setTimeout(r, 5))
      return await inner(p, opts)
    } finally { if (isHead) inFlight -= 1 }
  }
  const h = await mountUnlocked()
  try {
    await expandOrphans()
    assert.equal(orphanRows().length, 3)
    const all = buttonText(t('vaultTreeOrphanRecoverAll'))
    assert.ok(all, 'a bulk "Recover all to Vault" action exists')
    await click(dom, all)
    await tick(12)
    assert.equal(maxInFlight, 1, 'recovery is sequential — never concurrent CAS commits')
    assert.equal(headPosts(), 2, 'one CAS per successfully attached item')
    const tiles = qa('[data-testid="vault-file-tile"]').map((el) => el.textContent)
    assert.ok(tiles.some((x) => x.includes('a.txt')) && tiles.some((x) => x.includes('b.txt')), 'recovered items appear in the Vault root')
    const rows = orphanRows()
    assert.equal(rows.length, 1, 'successfully attached items disappear after the authoritative refresh')
    assert.ok(rows[0].textContent.includes('A.TXT'), 'the colliding item stays pending')
    assert.ok(rows[0].textContent.includes(t('vaultTreeOrphanPendingCollision')), 'with a visible reason')
    assert.deepEqual(deletes(), [], 'no ciphertext is deleted')
  } finally {
    await h.unmount()
  }
})

test('RP-7 Lock during bulk recovery aborts the remaining items', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: ORPHANS.slice(0, 2) })
  let release
  const gate = new Promise((r) => { release = r })
  let first = true
  const inner = fakeTree.fetchJson.bind(fakeTree)
  fakeTree.fetchJson = async (p, opts) => {
    if (opts?.method === 'POST' && p === '/api/vault/tree/head' && first) { first = false; await gate }
    return inner(p, opts)
  }
  const h = await mountUnlocked()
  try {
    await click(dom, buttonText(t('vaultTreeOrphanRecoverAll')))
    await tick(2)
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('lockVault')))
    release()
    await tick(8)
    assert.ok(headPosts() <= 1, `no further item is committed after lock (head posts: ${headPosts()})`)
    assert.ok(!doc().body.textContent.includes('b.txt'), 'no plaintext orphan names after lock')
  } finally {
    await h.unmount()
  }
})

/* ── PR220-R2 B: compact panel, truthful collision copy, recover with a confirmed new name ── */
const nonTreePosts = () => backend.requests.filter((r) => (r.method === 'POST' || r.method === 'UPLOAD_TRANSPORT') && !String(r.path).startsWith('/api/vault/tree/'))

test('RP-8 orphans collapse into a compact "pending recovery (n)" summary until expanded', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: ORPHANS })
  const h = await mountUnlocked()
  try {
    const toggle = q('[data-testid="vault-tree-orphans-toggle"]')
    assert.ok(toggle, 'a summary toggle exists')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'collapsed by default')
    assert.ok(toggle.textContent.includes(t('vaultTreeOrphansSummary', { count: 3 })), 'summary shows the count')
    assert.equal(orphanRows().length, 0, 'rows are not rendered while collapsed')
    assert.ok(buttonText(t('vaultTreeOrphanRecoverAll')), 'Recover all stays reachable while collapsed')
    await click(dom, toggle)
    assert.equal(q('[data-testid="vault-tree-orphans-toggle"]').getAttribute('aria-expanded'), 'true')
    assert.equal(orphanRows().length, 3, 'expanding shows the details')
  } finally {
    await h.unmount()
  }
})

test('RP-9 a collision says the name already exists in this folder and offers Recover with a new name', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [ORPHANS[0], ORPHANS[2]] })
  const h = await mountUnlocked()
  try {
    await click(dom, buttonText(t('vaultTreeOrphanRecoverAll')))
    await tick(10)
    const rows = orphanRows()
    assert.equal(rows.length, 1, 'bulk leaves only the colliding item (no silent auto-rename)')
    assert.ok(rows[0].textContent.includes(t('vaultTreeOrphanPendingCollision')))
    assert.match(makeT('th')('vaultTreeOrphanPendingCollision'), /มีไฟล์ชื่อนี้อยู่ในโฟลเดอร์นี้แล้ว/)
    assert.doesNotMatch(t('vaultTreeOrphanPendingCollision'), /fail/i, 'a collision is not an upload failure')
    assert.ok(rows[0].querySelector('[data-testid="vault-tree-orphan-recover-rename"]'), 'Recover with a new name is offered')
  } finally {
    await h.unmount()
  }
})

test('RP-10 Recover with a new name: editable suggestion, commits only on confirm, attaches the existing blob', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [ORPHANS[0], ORPHANS[2]] })
  const h = await mountUnlocked()
  try {
    await click(dom, buttonText(t('vaultTreeOrphanRecoverAll')))
    await tick(10)
    const headsBefore = headPosts()
    const postsBefore = nonTreePosts().length
    await click(dom, q('[data-testid="vault-tree-orphan-recover-rename"]'))
    const input = q('[role="dialog"] input')
    assert.equal(input.value, 'A (2).TXT', 'deterministic case-fold suggestion, extension preserved')
    assert.equal(headPosts(), headsBefore, 'opening the dialog commits nothing')
    // editable: a colliding edit keeps Recover disabled
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(input, 'a.TXT'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    assert.equal(q('[data-testid="vault-dialog-submit"]').disabled, true, 'a colliding edit cannot be confirmed')
    await act(async () => { setter.call(input, 'renamed.txt'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(6)
    assert.equal(headPosts() - headsBefore, 1, 'exactly one CAS attach')
    assert.equal(nonTreePosts().length, postsBefore, 'no ciphertext re-upload')
    assert.ok(qa('[data-testid="vault-file-tile"]').some((el) => el.textContent.includes('renamed.txt')), 'recovered under the confirmed name')
    assert.equal(orphanRows().length, 0, 'the recovered orphan disappears after the authoritative refresh')
    assert.deepEqual(deletes(), [], 'nothing deleted, nothing overwritten')
  } finally {
    await h.unmount()
  }
})

/* ── D-1 PR-C Task D.2: reserved preview-index blobs are never offered; unnamed/undecryptable fail closed ── */
const ROOT_MARKER = 'application/vnd.aegis.vault-preview-index-root.v1'
const SHARD_MARKER = 'application/vnd.aegis.vault-preview-index-shard.v1'
const RESERVED = [
  serverBlobV2({ id: 'r'.padEnd(22, 'R'), name: '', type: ROOT_MARKER, plainSize: 4096 }),
  serverBlobV2({ id: 's'.padEnd(22, 'S'), name: '', type: SHARD_MARKER, plainSize: 16384 }),
  serverBlobV2({ id: 'd'.padEnd(22, 'D'), name: '', type: 'image/webp', plainSize: 900 }),
]
const UNNAMED = serverBlobV2({ id: 'u'.padEnd(22, 'U'), name: '', type: 'text/plain', plainSize: 5 })
const UNDECRYPTABLE = { ...serverBlobV2({ id: 'x'.padEnd(22, 'X'), name: 'ignored', type: 'text/plain' }), metaB64: 'bm90LWpzb24=' }

test('RP-11 reserved preview-index blobs (root, shard, derivative) are never listed; user files still are; nothing deleted', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [...RESERVED, ORPHANS[0]] })
  const h = await mountUnlocked()
  try {
    await expandOrphans()
    const rows = orphanRows()
    assert.equal(rows.length, 1, 'only the user file is offered')
    assert.ok(rows[0].textContent.includes('a.txt'))
    assert.ok(!q('[data-testid="vault-tree-orphans-toggle"]').textContent.includes('4'), 'the summary count excludes reserved blobs')
    await click(dom, buttonText(t('vaultTreeOrphanRecoverAll')))
    await tick(8)
    assert.equal(headPosts(), 1, 'recover-all attached only the user file')
    assert.deepEqual(deletes(), [])
  } finally {
    await h.unmount()
  }
})

test('RP-12 an unnamed blob is recovered only with an explicit, non-empty user-entered name (no default from metadata)', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [UNNAMED] })
  const h = await mountUnlocked()
  try {
    await expandOrphans()
    assert.equal(orphanRows().length, 1, 'the unnamed user file stays listed')
    const headsBefore = headPosts()
    await click(dom, q('[data-testid="vault-tree-orphan-recover"]'))
    await click(dom, qa('[data-testid="vault-dialog-move-row"]')[0].querySelector('button'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    const input = q('[role="dialog"] input')
    assert.ok(input, 'a name dialog opens instead of committing')
    assert.equal(input.value, '', 'no invented default name')
    assert.equal(q('[data-testid="vault-dialog-submit"]').disabled, true, 'an empty name cannot be confirmed')
    assert.equal(headPosts(), headsBefore, 'nothing committed yet')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(input, 'recovered-notes.txt'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(6)
    assert.equal(headPosts() - headsBefore, 1)
    assert.ok(qa('[data-testid="vault-file-tile"]').some((el) => el.textContent.includes('recovered-notes.txt')))
    assert.deepEqual(deletes(), [])
  } finally {
    await h.unmount()
  }
})

test('RP-13 recover-all never auto-names unnamed or undecryptable blobs: they stay listed (NAME_REQUIRED), no CAS for them', async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [UNNAMED, UNDECRYPTABLE, ORPHANS[1]] })
  const h = await mountUnlocked()
  try {
    await expandOrphans()
    assert.equal(orphanRows().length, 3)
    await click(dom, buttonText(t('vaultTreeOrphanRecoverAll')))
    await tick(10)
    assert.equal(headPosts(), 1, 'only the named file was attached')
    const rows = orphanRows()
    assert.equal(rows.length, 2)
    for (const r of rows) assert.ok(r.textContent.includes('NAME_REQUIRED'), r.textContent)
    assert.ok(!qa('[data-testid="vault-file-tile"]').some((el) => /orphan-/.test(el.textContent)), 'no "orphan-…" default name was invented')
    assert.deepEqual(deletes(), [])
  } finally {
    await h.unmount()
  }
})
