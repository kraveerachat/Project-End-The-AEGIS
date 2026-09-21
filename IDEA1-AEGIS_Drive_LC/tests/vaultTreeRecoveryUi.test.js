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
