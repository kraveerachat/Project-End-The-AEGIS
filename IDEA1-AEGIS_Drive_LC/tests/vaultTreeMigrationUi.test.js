// tests/vaultTreeMigrationUi.test.js — AEGIS Drive (IDEA1) · PR #157 Task 3.3 · migration dialog (MU-*)
//
// สิ่งที่ชุดนี้ตรึงไว้: ไดอะล็อกอัปเกรด FLAT → TREE_V1 ต้องซื่อสัตย์กับผู้ใช้และกับเซิร์ฟเวอร์
//
//   MU-1  ทางเข้า "อัปเกรดเป็นโฟลเดอร์" มีเฉพาะ FLAT + ธงเปิด + ปลดล็อกอยู่เท่านั้น
//   MU-2  ลำดับจอ: อธิบาย → จอง lease → อ่านชื่อเข้ารหัส (แสดง "จำนวน" เท่านั้น) →
//         รายชื่อชนกับช่องเปลี่ยนชื่อรายรายการ → บันทึก → เสร็จ — แต่ละสถานะมี testid ของตัวเอง
//   MU-3  ล็อกกลางไหล: ไดอะล็อกหาย ชื่อหายจาก DOM ไม่มี genesis ถึงเซิร์ฟเวอร์ และ lease ถูกละทิ้ง
//   MU-4  MIGRATING_TREE_V1 ที่มี lease คนอื่น → สถานะจริงใจ "อีกอุปกรณ์กำลังทำอยู่" พร้อมเวลาหมดอายุ;
//         lease หมดอายุ → ปุ่มทำต่อเรียก takeover (ไม่เรียก begin เด็ดขาด)
//   MU-5  TREE_LEASE_STALE ตอน commit → ข้อผิดพลาดตรงตามโค้ดจริง; ลองใหม่วิ่งซ้ำจาก state fetch
//   MU-6  TREE_V1: จอแสดง placeholder — treeUiEnabled=false ต้องบอกความจริงว่า "ยังไม่เปิดใช้"
//
// ⚠️ จังหวะทั้งหมดคุมด้วยประตูที่เทสต์เปิดเอง (ctl.holdPath/ctl.release) ไม่ใช่การหน่วงเวลา —
//    เทสต์ที่รอเวลาคือเทสต์ที่จะสั่นแบบสุ่มและบังบั๊กจริงไว้ข้างหลัง
// ⚠️ zero-knowledge: ขณะ "กำลังทำ" ห้ามมีชื่อไฟล์หลุดออกจากภูมิภาคความคืบหน้า —
//    ชื่อปรากฏได้เฉพาะในขั้นแก้ชื่อชนกัน (ขณะนั้นผู้ใช้ยังปลดล็อกอยู่และตั้งใจให้เห็น)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, makeVaultTreeBackend, v1Blob } from './fixtures/vaultTreeBackend.js'
import {
  startVaultScreenEnv, settle, click, type, byText, unlock, lockVault,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom
let Vault

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom, Vault } = env)
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
})

let backend
beforeEach(() => {
  backend = makeVaultTreeBackend()
  globalThis.__VAULT_BACKEND__ = backend
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const stepEl = (name) => q(`[data-testid="vault-migration-step-${name}"]`)
const stepState = (name) => stepEl(name)?.getAttribute('data-state') ?? null
const reqCount = (substr) => backend.requests.filter((r) => String(r.path).includes(substr)).length

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await settle()
}

const leaseReply = (blobs) => ({
  ok: true, status: 201, errorKind: null,
  data: { leaseId: 'L'.repeat(22), epoch: 1, expiresAt: Date.now() + 600_000, frozenInventoryId: 'F'.repeat(22), blobs },
})

const seedVault = (blobs) => { backend.state['/api/vault'].data = { configured: true, blobs } }

async function mountUnlocked() {
  const h = env.mount()
  await h.render(React.createElement(Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  return h
}

const INVENTORY = [
  v1Blob({ id: 'a1'.padEnd(22, 'x'), name: 'notes.txt', type: 'text/plain', plainSize: 12 }),
  v1Blob({ id: 'b2'.padEnd(22, 'x'), name: 'NOTES.TXT', type: 'text/plain', plainSize: 34 }),
  v1Blob({ id: 'c3'.padEnd(22, 'x'), name: 'readme.md', type: 'text/markdown', plainSize: 56 }),
]

// ─────────────────────────────────────────────────────────────────────────────
test('MU-1 FLAT + flag on + unlocked shows the "Upgrade to folders" entry; flag off or locked shows nothing', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    assert.ok(!q('[data-testid="vault-migration-entry"]'), 'a locked vault offers no migration entry')
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const entry = q('[data-testid="vault-migration-entry"]')
    assert.ok(entry, 'unlocked FLAT vault with the flag on shows the entry')
    assert.equal(entry.textContent.trim(), t('vaultMigrationEntry'))
  } finally {
    await h.unmount()
  }

  backend = makeVaultTreeBackend({ flags: { genesisMigrationEnabled: false } })
  globalThis.__VAULT_BACKEND__ = backend
  const h2 = env.mount()
  try {
    await h2.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.ok(!q('[data-testid="vault-migration-entry"]'), 'flag off → no entry point')
  } finally {
    await h2.unmount()
  }
})

test('MU-2 flow: explain → lease (held open) → decrypt count → collision list → rename → commit → done', async () => {
  seedVault(INVENTORY)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await click(dom, q('[data-testid="vault-migration-entry"]'))
    assert.ok(q('[data-testid="vault-migration-explain"]'), 'the flow starts with the explain state')
    assert.equal(stepState('lease'), null, 'no ledger before the user starts')

    backend.holdPath = 'migration/begin'
    await click(dom, byText(dom, 'button', t('vaultMigrationStart')))
    assert.ok(q('[data-testid="vault-migration-progress"]'), 'running state has its own region')
    assert.equal(stepState('lease'), 'current', 'lease step is current while the lease is being acquired')
    const progress = q('[data-testid="vault-migration-progress"]').textContent
    assert.ok(!progress.includes('notes.txt') && !progress.includes('NOTES.TXT'), 'no names in the progress region')

    await act(async () => backend.release(leaseReply(INVENTORY)))
    await tick()
    assert.equal(stepState('lease'), 'done')
    assert.equal(stepState('decrypt'), 'done')
    assert.equal(stepState('collisions'), 'current')
    const decryptRow = stepEl('decrypt')
    assert.ok(decryptRow.textContent.includes('3'), 'decrypt step shows the item count')
    assert.ok(!stepEl('decrypt').textContent.includes('notes.txt'), 'the count is public, the names are not')
    const list = q('[data-testid="vault-migration-collision-list"]')
    assert.ok(list, 'collision list rendered')
    const inputs = [...list.querySelectorAll('input')]
    assert.equal(inputs.length, 2, 'one rename input per affected entry')

    const target = inputs.find((i) => i.value === 'NOTES.TXT')
    assert.ok(target, 'the colliding name is editable')
    await type(dom, target, '-renamed')
    await click(dom, byText(dom, 'button', t('vaultMigrationContinue')))
    assert.ok(q('[data-testid="vault-migration-done"]'), 'done state after commit')
    assert.ok(q('[data-testid="vault-tree-placeholder"]'), 'the screen transitions to the tree placeholder')
    assert.equal(backend.tree.genesisBodies.length, 1, 'exactly one genesis commit')
    assert.equal(backend.tree.ciphertexts.length, 1, 'the revision ciphertext was uploaded')
  } finally {
    await h.unmount()
  }
})

test('MU-3 Lock during the flow: dialog closes, no names in DOM, genesis never sent, lease abandoned', async () => {
  seedVault(INVENTORY)
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await click(dom, q('[data-testid="vault-migration-entry"]'))
    backend.holdPath = 'migration/begin'
    await click(dom, byText(dom, 'button', t('vaultMigrationStart')))
    await act(async () => backend.release(leaseReply(INVENTORY)))
    await tick()
    const body = doc().body.textContent
    assert.ok(body.includes('notes.txt') && body.includes('NOTES.TXT'), 'names visible while unlocked')

    await lockVault(dom, t)
    assert.ok(!q('[data-testid="vault-migration-collision-list"]'), 'the dialog closed with the key')
    const after = doc().body.textContent
    assert.ok(!after.includes('notes.txt') && !after.includes('NOTES.TXT'), 'no plaintext names after lock')
    assert.equal(backend.tree.genesisBodies.length, 0, 'genesis was never sent')
    assert.equal(backend.tree.ciphertexts.length, 0, 'no ciphertext was published')
    assert.ok(reqCount('migration/abandon') >= 1, 'the held lease was abandoned on lock')
  } finally {
    await h.unmount()
  }
})

test('MU-4 foreign lease → truthful remote state with expiry; expired → Resume calls takeover, never begin', async () => {
  backend.tree.protocolState = 'MIGRATING_TREE_V1'
  backend.tree.lease = { held: true, epoch: 2, expiresAt: Date.now() + 600_000 }
  const h1 = env.mount()
  try {
    await h1.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const remote = q('[data-testid="vault-migration-remote"]')
    assert.ok(remote, 'auto-opened in the truthful "another device" state')
    assert.ok(q('[data-testid="vault-migration-remote-until"]'), 'the lease expiry is shown')
    assert.ok(!q('input[data-testid^="vault-migration-rename-"]'), 'no rename inputs in the remote state')
    assert.equal(reqCount('migration/begin') + reqCount('migration/takeover'), 0, 'nothing starts on its own')
  } finally {
    await h1.unmount()
  }

  backend = makeVaultTreeBackend()
  globalThis.__VAULT_BACKEND__ = backend
  seedVault(INVENTORY.slice(0, 1))
  backend.tree.protocolState = 'MIGRATING_TREE_V1'
  backend.tree.lease = { held: true, epoch: 2, expiresAt: Date.now() - 1_000 }
  const h2 = env.mount()
  try {
    await h2.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const resume = byText(dom, 'button', t('vaultMigrationResume'))
    assert.ok(resume, 'an expired lease offers Resume')
    await click(dom, resume)
    await tick()
    assert.ok(q('[data-testid="vault-migration-done"]'), 'the flow finished through the takeover')
    assert.equal(reqCount('migration/takeover'), 1, 'takeover called once')
    assert.equal(reqCount('migration/begin'), 0, 'begin is never called on resume')
    assert.equal(backend.tree.genesisBodies.length, 1)
  } finally {
    await h2.unmount()
  }
})

test('MU-5 TREE_LEASE_STALE at commit → truthful error; retry re-runs from the state fetch and succeeds', async () => {
  seedVault(INVENTORY.slice(0, 1))
  backend.tree.failGenesisCode = 'TREE_LEASE_STALE'
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await click(dom, q('[data-testid="vault-migration-entry"]'))
    await click(dom, byText(dom, 'button', t('vaultMigrationStart')))
    await tick()
    const err = q('[data-testid="vault-migration-error"]')
    assert.ok(err, 'the error state is shown')
    assert.ok(err.textContent.includes('TREE_LEASE_STALE'), 'the error names the real server code')
    assert.equal(stepState('commit'), 'current')
    assert.equal(backend.tree.genesisBodies.length, 0, 'the failed genesis was rejected')

    backend.tree.failGenesisCode = null
    await click(dom, byText(dom, 'button', t('vaultMigrationRetry')))
    await tick()
    assert.ok(q('[data-testid="vault-migration-done"]'), 'the retry finishes the flow')
    assert.ok(reqCount('tree/state') >= 2, 'the retry re-runs from the state fetch')
    assert.equal(reqCount('tree/genesis'), 2, 'genesis attempted twice (409, then success)')
    assert.equal(reqCount('migration/begin'), 1, 'no second begin — our lease is still valid')
    assert.equal(backend.tree.genesisBodies.length, 1)
  } finally {
    await h.unmount()
  }
})

test('MU-6 TREE_V1 screen: placeholder replaces the migration entry; truthful copy when the tree UI is off', async () => {
  backend.tree.protocolState = 'TREE_V1'
  backend.tree.head = { revisionId: 'r'.repeat(22), generation: 1 }
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    const ph = q('[data-testid="vault-tree-placeholder"]')
    assert.ok(ph, 'the tree placeholder is shown')
    assert.equal(ph.textContent.trim(), t('vaultMigrationNoTreeUi'), 'the copy admits the folder view is not enabled')
    assert.ok(!q('[data-testid="vault-migration-entry"]'), 'no migration entry in TREE_V1')
  } finally {
    await h.unmount()
  }
})
