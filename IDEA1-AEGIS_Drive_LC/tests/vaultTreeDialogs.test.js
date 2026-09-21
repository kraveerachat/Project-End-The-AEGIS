// tests/vaultTreeDialogs.test.js — AEGIS Drive (IDEA1) · PR #157 Task 6.2 · hierarchy dialogs (DG-*)
//
//   DG-1  New Folder validates locally (empty, collision) before enabling submit; submit emits createFolder
//   DG-2  Rename pre-fills the current display name; same name = no intent; collision = inline error, no intent
//   DG-3  Move picker lists only the provided active destinations, marks the current parent; submit → onMove(dest)
//   DG-4  Details shows name/type/plain size/timestamps/blob format version/cipher size — never node id/storage key
//   DG-5  Trash confirm shows the count of top-level roots and the contents-move-with-folder note
//   DG-6  Restore: one-click when the original parent is valid; chooser (root default) otherwise; collision forces chooser
//   DG-7  Conflict dialog renders the reason copy and offers retry/discard/choose-destination; never "overwrite"
//   DG-8  Permanent Delete exists with a typed-acknowledgement gate (operational only from Phase 8)
//   DG-9  all dialogs close and drop their local state when unlockedState.purge fires
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { startVaultScreenEnv, settle, click, type } from './helpers/vaultScreenHarness.js'

const t = makeT('en')
const ID = 'F'.repeat(22)

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

/** the shared type helper appends — replace the whole value through the native setter */
async function clearType(dom, input, text) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, '')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await type(dom, input, text)
}

beforeEach(() => {
  globalThis.__VAULT_BACKEND__ = makeVaultTreeBackend()
})

const DIALOGS_ID = '/src/components/vault/VaultDialogs.jsx'

const FOLDERS = [
  { nodeId: 'R'.repeat(22), name: 'Vault', depth: 0 },
  { nodeId: 'D'.repeat(22), name: 'Docs', depth: 1 },
  { nodeId: 'X'.repeat(22), name: 'X', depth: 1 },
]

test('DG-1 New Folder validates locally before enabling submit; submit emits the name', async () => {
  const { NewFolderDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(NewFolderDialog, {
      t, open: true, onClose: () => {}, siblingNames: ['Docs'],
      onSubmit: (name) => calls.push(name), unlockedState: createUnlockedVaultState(),
    }))
    const input = q('[data-testid="vault-dialog-name-input"]')
    assert.ok(input, 'the name input renders')
    const submit = q('[data-testid="vault-dialog-submit"]')
    assert.ok(submit.disabled, 'submit is disabled while the name is empty')
    await click(dom, submit)
    assert.deepEqual(calls, [], 'an empty name never submits')
    await type(dom, input, 'Docs')
    assert.ok(q('[data-testid="vault-dialog-error"]'), 'a sibling collision shows an inline error')
    assert.ok(q('[data-testid="vault-dialog-submit"]').disabled, 'a colliding name stays disabled')
    await clearType(dom, input, 'New')
    const submit2 = q('[data-testid="vault-dialog-submit"]')
    assert.ok(!submit2.disabled, 'a valid name enables submit')
    await click(dom, submit2)
    assert.deepEqual(calls, ['New'], 'submit emits the typed name')
  } finally {
    await h.unmount()
  }
})

test('DG-2 Rename pre-fills; same name is a no-op; collision shows an inline error', async () => {
  const { RenameDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(RenameDialog, {
      t, open: true, onClose: () => {}, currentName: 'Docs', siblingNames: ['Docs', 'Other'],
      onSubmit: (name) => calls.push(name), unlockedState: createUnlockedVaultState(),
    }))
    const input = q('[data-testid="vault-dialog-name-input"]')
    assert.equal(input.value, 'Docs', 'the input is pre-filled with the current name')
    const submit = q('[data-testid="vault-dialog-submit"]')
    assert.ok(submit.disabled, 'unchanged name = submit disabled (no intent)')
    await clearType(dom, input, 'DOCS')
    assert.ok(q('[data-testid="vault-dialog-error"]'), 'a case-collision shows an inline error')
    assert.ok(q('[data-testid="vault-dialog-submit"]').disabled, 'colliding rename stays disabled')
    assert.deepEqual(calls, [], 'no intent was emitted')
    await clearType(dom, input, 'Docs2')
    const submit2 = q('[data-testid="vault-dialog-submit"]')
    assert.ok(!submit2.disabled, 'a new valid name enables submit')
    await click(dom, submit2)
    assert.deepEqual(calls, ['Docs2'], 'submit emits the new name')
  } finally {
    await h.unmount()
  }
})

test('DG-3 Move picker lists only the provided destinations and marks the current parent', async () => {
  const { MoveDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(MoveDialog, {
      t, open: true, onClose: () => {}, folders: FOLDERS, movingNames: ['Docs'],
      currentParentNodeId: 'R'.repeat(22), onMove: (id) => calls.push(id),
      unlockedState: createUnlockedVaultState(),
    }))
    assert.ok(q('[data-testid="vault-dialog-moving-names"]').textContent.includes('Docs'), 'the picker shows what is being moved')
    const rows = qa('[data-testid="vault-dialog-move-row"]')
    assert.equal(rows.length, 3, 'only the provided (already filtered) destinations render')
    assert.ok(rows[0].textContent.includes('Vault'), 'the root is listed')
    assert.ok(rows.find((r) => r.getAttribute('data-current-parent') === 'true'), 'the current parent row is marked')
    assert.ok(q('[data-testid="vault-dialog-submit"]').disabled, 'submit stays disabled until a destination is chosen')
    await click(dom, rows[1].querySelector('button'))
    const submit = q('[data-testid="vault-dialog-submit"]')
    assert.ok(!submit.disabled, 'choosing a destination enables submit')
    await click(dom, submit)
    assert.deepEqual(calls, ['D'.repeat(22)], 'submit emits the chosen destination')
  } finally {
    await h.unmount()
  }
})

test('DG-4 Details shows only client-side manifest fields', async () => {
  const { DetailsDialog } = await env.load(DIALOGS_ID)
  const h = env.mount()
  try {
    const created = Date.UTC(2026, 8, 19, 9, 0, 0)
    await h.render(React.createElement(DetailsDialog, {
      t, open: true, onClose: () => {},
      node: {
        nodeId: 'N'.repeat(22), name: 'a.png', kind: 'file', mediaType: 'image/png', plainSize: 2048,
        createdAtClient: created, modifiedAtClient: created + 1000, blobRef: { formatVersion: 2, id: 'B'.repeat(22) },
        storageKey: 'sk_should_never_render',
      },
      cipherSize: 2064, unlockedState: createUnlockedVaultState(),
    }))
    const body = q('[data-testid="vault-dialog-details"]')
    assert.ok(body.textContent.includes('a.png'), 'the name renders')
    assert.ok(body.textContent.includes('image/png'), 'the type renders')
    assert.ok(body.textContent.includes('2.0 KB'), 'the plaintext size renders')
    assert.ok(body.textContent.includes(t('vaultTreeDetailsBlobFormat')), 'the blob format row renders')
    assert.ok(body.textContent.includes('2064') || body.textContent.includes(t('vaultTreeDetailsCipherSize')), 'the cipher size renders when provided')
    const text = body.textContent
    assert.ok(!text.includes('N'.repeat(22)), 'the node id is never rendered')
    assert.ok(!text.includes('sk_should_never_render'), 'the storage key is never rendered')
  } finally {
    await h.unmount()
  }
})

test('DG-5 Trash confirm shows the root count and the contents note', async () => {
  const { TrashConfirmDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(TrashConfirmDialog, {
      t, open: true, onClose: () => {}, count: 2,
      onConfirm: () => calls.push('trash'), unlockedState: createUnlockedVaultState(),
    }))
    const body = q('[data-testid="vault-dialog-trash"]')
    assert.ok(body.textContent.includes('2'), 'the count of selected roots shows')
    assert.ok(body.textContent.includes('move with them'), 'the contents-move-with-folder note shows')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    assert.deepEqual(calls, ['trash'], 'confirm emits the trash intent request')
  } finally {
    await h.unmount()
  }
})

test('DG-6 Restore: one-click when the original parent is valid; chooser otherwise or when forced', async () => {
  const { RestoreDialog } = await env.load(DIALOGS_ID)
  const h = env.mount()
  const calls = []
  try {
    await h.render(React.createElement(RestoreDialog, {
      t, open: true, onClose: () => {}, node: { nodeId: ID, name: 'Docs' },
      folders: FOLDERS, originalParentAvailable: true, collisionForced: false,
      onRestore: (dest) => calls.push(['restore', dest]), unlockedState: createUnlockedVaultState(),
    }))
    const one = q('[data-testid="vault-dialog-restore-one-click"]')
    assert.ok(one, 'one-click restore is offered when the original parent is valid')
    await click(dom, one)
    assert.deepEqual(calls, [['restore', null]], 'one-click restores to the original place')

    await h.render(React.createElement(RestoreDialog, {
      t, open: true, onClose: () => {}, node: { nodeId: ID, name: 'Docs' },
      folders: FOLDERS, originalParentAvailable: false, collisionForced: false,
      onRestore: (dest) => calls.push(['chooser', dest]), forcedReason: t('vaultTreeRestoreOriginalUnavailable'),
      unlockedState: createUnlockedVaultState(),
    }))
    assert.ok(q('[data-testid="vault-dialog-move-row"]'), 'the chooser renders when the original parent is gone')
    assert.ok(!q('[data-testid="vault-dialog-restore-one-click"]'), 'no one-click path when forced to choose')
    const rows = qa('[data-testid="vault-dialog-move-row"]')
    const rootRow = rows.find((r) => r.textContent.includes('Vault'))
    await click(dom, rootRow.querySelector('button'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    assert.deepEqual(calls[1], ['chooser', 'R'.repeat(22)], 'the chooser submits the chosen destination')

    await h.render(React.createElement(RestoreDialog, {
      t, open: true, onClose: () => {}, node: { nodeId: ID, name: 'Docs' },
      folders: FOLDERS, originalParentAvailable: true, collisionForced: true,
      onRestore: (dest) => calls.push(['forced', dest]), unlockedState: createUnlockedVaultState(),
    }))
    assert.ok(!q('[data-testid="vault-dialog-restore-one-click"]'), 'a collision forces the chooser even when the parent exists')
  } finally {
    await h.unmount()
  }
})

test('DG-7 Conflict dialog: reason copy + retry/discard/choose; never "overwrite"', async () => {
  const { ConflictDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(ConflictDialog, {
      t, open: true, onClose: () => {},
      conflict: { reason: 'TARGET_DELETED', intent: { type: 'rename' } },
      choices: ['retry', 'discard'],
      onChoice: (choice) => calls.push(choice), unlockedState: createUnlockedVaultState(),
    }))
    const body = q('[data-testid="vault-dialog-conflict"]')
    assert.ok(body.textContent.includes(t('vaultTreeConflictReason_TARGET_DELETED')), 'the rebase reason copy renders')
    const choices = qa('[data-testid="vault-dialog-conflict-choice"]')
    assert.deepEqual(choices.map((c) => c.getAttribute('data-choice')), ['retry', 'discard'], 'exactly the offered choices render')
    for (const el of choices) assert.ok(!el.textContent.toLowerCase().includes('overwrite'), 'never offers overwrite')
    await click(dom, choices[0])
    assert.deepEqual(calls, ['retry'], 'choosing emits the choice')
  } finally {
    await h.unmount()
  }
})

test('DG-8 Permanent Delete exists with a typed-acknowledgement gate', async () => {
  const { PermanentDeleteDialog } = await env.load(DIALOGS_ID)
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(PermanentDeleteDialog, {
      t, open: true, onClose: () => {}, name: 'old.txt',
      onConfirm: () => calls.push('del'), unlockedState: createUnlockedVaultState(),
    }))
    const body = q('[data-testid="vault-dialog-permanent-delete"]')
    assert.ok(body, 'the dialog renders (component exists)')
    assert.ok(body.textContent.includes('old.txt'), 'it names what is being deleted')
    const submit = q('[data-testid="vault-dialog-submit"]')
    assert.ok(submit.disabled, 'confirm is disabled before the typed acknowledgement')
    await click(dom, submit)
    assert.deepEqual(calls, [], 'no deletion without the typed name')
    const input = q('[data-testid="vault-dialog-ack-input"]')
    await type(dom, input, 'old.txt')
    assert.ok(!q('[data-testid="vault-dialog-submit"]').disabled, 'typing the exact name enables confirm')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    assert.deepEqual(calls, ['del'], 'the typed acknowledgement enables deletion')
  } finally {
    await h.unmount()
  }
})

test('DG-9 dialogs close and drop local state when unlockedState.purge fires', async () => {
  const { NewFolderDialog } = await env.load(DIALOGS_ID)
  const us = createUnlockedVaultState()
  const calls = []
  const h = env.mount()
  try {
    await h.render(React.createElement(NewFolderDialog, {
      t, open: true, onClose: () => calls.push('close'), siblingNames: [],
      onSubmit: () => {}, unlockedState: us,
    }))
    const input = q('[data-testid="vault-dialog-name-input"]')
    await type(dom, input, 'My folder')
    assert.equal(input.value, 'My folder')
    await act(async () => us.purge('MANUAL_LOCK'))
    await settle()
    assert.deepEqual(calls, ['close'], 'the purge fires onClose')
    const input2 = q('[data-testid="vault-dialog-name-input"]')
    assert.equal(input2?.value ?? '', '', 'the typed plaintext is dropped')
  } finally {
    await h.unmount()
  }
})
