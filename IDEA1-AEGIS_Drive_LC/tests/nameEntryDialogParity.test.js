// tests/nameEntryDialogParity.test.js — AEGIS Drive (IDEA1) · PR220-R2 A · Files/Vault create-folder parity
//
//   NED-1  Files and Vault consume ONE shared name-entry primitive (source ownership, no copied markup)
//   NED-2  Vault New Folder renders the Files presentation: label, PillInput, autofocus, equal footer, close X
//   NED-3  Enter submits only when the caller's validation says the name is valid
//   NED-4  Vault semantics stay caller-owned: NFC + case-fold sibling collision keeps submit disabled
//   NED-5  Cancel and X close without submitting; no role-specific branch exists in the primitive
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { startVaultScreenEnv, click, type, pressKey } from './helpers/vaultScreenHarness.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel) => readFileSync(path.join(rootDir, rel), 'utf8')
const t = makeT('en')

let env
let dom
before(async () => { env = await startVaultScreenEnv(); ({ dom } = env) })
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })
beforeEach(() => { globalThis.__VAULT_BACKEND__ = makeVaultTreeBackend() })

const q = (sel) => dom.window.document.querySelector(sel)
const qa = (sel) => [...dom.window.document.querySelectorAll(sel)]

async function mountVaultNewFolder({ siblingNames = [], onSubmit = () => {}, onClose = () => {} } = {}) {
  const { NewFolderDialog } = await env.load('/src/components/vault/VaultDialogs.jsx')
  const h = env.mount()
  await h.render(React.createElement(NewFolderDialog, {
    t, open: true, onClose, siblingNames, onSubmit, unlockedState: createUnlockedVaultState(),
  }))
  return h
}

/** the visual signature both surfaces must share */
function signature() {
  const dialog = q('[role="dialog"]')
  const root = dialog.querySelector('[data-name-entry-dialog]')
  const input = dialog.querySelector('input')
  const label = input && dialog.querySelector(`label[for="${input.id}"]`)
  const footer = dialog.querySelector('[data-name-entry-footer]')
  const footerButtons = footer ? [...footer.querySelectorAll('button')] : []
  return {
    root: Boolean(root),
    title: dialog.querySelector('h2')?.className ?? null,
    label: Boolean(label && label.textContent.trim()),
    inputClass: input?.className ?? null,
    footerButtons: footerButtons.map((b) => /\bflex-1\b/.test(b.className)),
    closeX: Boolean(dialog.querySelector('button[aria-label]')),
  }
}

test('NED-1 Files and Vault consume one shared name-entry dialog primitive', () => {
  const shared = src('src/components/NameEntryDialog.jsx')
  assert.match(shared, /export function NameEntryDialog\b/, 'the shared primitive exists')
  const sharedCode = shared.replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(sharedCode, /\b(user)?role\s*[!=]==|isAdmin|datalake|userId|permissions/i, 'no role-specific branch in the primitive')
  const files = src('src/screens/Files.jsx')
  assert.match(files, /import \{[^}]*\bNameEntryDialog\b[^}]*\} from '\.\.\/components\/NameEntryDialog\.jsx'/, 'Files imports the shared primitive')
  assert.doesNotMatch(files, /labelledBy="nf-title"/, 'Files no longer owns a private create-folder Modal')
  const vault = src('src/components/vault/VaultDialogs.jsx')
  assert.match(vault, /import \{[^}]*\bNameEntryDialog\b[^}]*\} from '\.\.\/NameEntryDialog\.jsx'/, 'Vault imports the shared primitive')
  const core = vault.slice(vault.indexOf('function NameDialogCore('), vault.indexOf('export function NewFolderDialog('))
  assert.match(core, /<NameEntryDialog\b/, 'NameDialogCore renders the shared primitive')
  assert.doesNotMatch(core, /<input\b|<Modal\b/, 'Vault no longer renders its own name modal or input')
})

test('NED-2 Vault New Folder renders the Files presentation', async () => {
  const h = await mountVaultNewFolder()
  try {
    const sig = signature()
    assert.equal(sig.root, true, 'shared primitive root marker is present')
    assert.equal(sig.label, true, 'a visible label is bound to the input')
    assert.match(sig.inputClass ?? '', /\brounded-full\b/, 'PillInput presentation')
    assert.match(sig.inputClass ?? '', /\bh-12\b/, 'PillInput height')
    assert.deepEqual(sig.footerButtons, [true, true], 'Cancel and Create are equal width')
    assert.equal(sig.closeX, true, 'close X is present')
    assert.equal(dom.window.document.activeElement, q('[role="dialog"] input'), 'input is autofocused')
    const create = q('[data-testid="vault-dialog-submit"]')
    assert.equal(create.disabled, true, 'Create is disabled while empty')
  } finally { await h.unmount() }
})

test('NED-3 Enter submits only when valid', async () => {
  const calls = []
  const h = await mountVaultNewFolder({ siblingNames: ['Docs'], onSubmit: (n) => calls.push(n) })
  try {
    const input = q('[role="dialog"] input')
    await pressKey(dom, 'Enter', input)
    assert.deepEqual(calls, [], 'empty Enter never submits')
    await type(dom, input, 'Docs')
    await pressKey(dom, 'Enter', input)
    assert.deepEqual(calls, [], 'colliding Enter never submits')
    await type(dom, input, '2')
    await pressKey(dom, 'Enter', input)
    assert.deepEqual(calls, ['Docs2'], 'valid Enter submits once')
  } finally { await h.unmount() }
})

test('NED-4 Vault NFC + case-fold collision stays caller-owned and disables submit', async () => {
  const h = await mountVaultNewFolder({ siblingNames: ['Café'] })
  try {
    const input = q('[role="dialog"] input')
    await type(dom, input, 'CAFÉ')
    assert.ok(q('[data-testid="vault-dialog-error"]'), 'decomposed + upper-case name collides')
    assert.equal(q('[data-testid="vault-dialog-submit"]').disabled, true)
  } finally { await h.unmount() }
})

test('NED-5 Cancel and X close without submitting', async () => {
  let closes = 0
  const calls = []
  const h = await mountVaultNewFolder({ onClose: () => { closes += 1 }, onSubmit: (n) => calls.push(n) })
  try {
    const footer = q('[data-name-entry-footer]')
    await click(dom, [...footer.querySelectorAll('button')][0])
    await click(dom, q('[role="dialog"] button[aria-label]'))
    assert.equal(closes, 2, 'Cancel and X both close')
    assert.deepEqual(calls, [])
    assert.equal(qa('[role="dialog"] [data-name-entry-footer] button').length, 2)
  } finally { await h.unmount() }
})
