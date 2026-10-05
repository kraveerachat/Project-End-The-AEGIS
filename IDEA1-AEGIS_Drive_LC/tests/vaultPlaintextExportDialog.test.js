// tests/vaultPlaintextExportDialog.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 10c (D-3)
//
// A Vault ZIP is plaintext: the explicit confirmation states it, shows the count and size, and its
// Confirm calls onConfirm SYNCHRONOUSLY inside the click (the picker must stay in user activation).
// Cancel / Escape / the close button only close; a Vault lock closes it through the purge disposer.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { startVaultScreenEnv, pressKey } from './helpers/vaultScreenHarness.js'

const t = makeT('en')
let env
let dom
let PlaintextExportDialog
let fmtBytes

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  ;({ PlaintextExportDialog } = await env.load('/src/components/vault/VaultDialogs.jsx'))
  ;({ fmtBytes } = await env.load('/src/lib/format.js'))
})
after(async () => { await env?.stop() })

const q = (sel) => dom.window.document.querySelector(sel)

async function mountDialog() {
  const calls = []
  const disposers = []
  const unlockedState = { registerDisposer: (fn) => { disposers.push(fn); return fn } }
  const h = env.mount()
  let open = true
  const el = () => React.createElement(PlaintextExportDialog, {
    t, open, count: 7, totalBytes: 5 * 1024 * 1024, unlockedState,
    onConfirm: () => calls.push('confirm'),
    onClose: () => { calls.push('close'); open = false },
  })
  await h.render(el())
  return { h, calls, disposers, rerender: () => h.render(el()) }
}

test('DLG-1 shows the not-encrypted warning, the file count and the total size', async () => {
  const { h } = await mountDialog()
  try {
    const box = q('[data-testid="vault-zip-export"]')
    assert.ok(box)
    const text = dom.window.document.body.textContent
    assert.ok(text.includes(t('vaultZipExportTitle')))
    assert.ok(text.includes(t('vaultZipExportBody', { count: 7, size: fmtBytes(5 * 1024 * 1024) })))
    assert.ok(q('[data-testid="vault-zip-export-confirm"]').textContent.includes(t('vaultZipExportConfirm')))
  } finally { await h.unmount() }
})

test('DLG-2 Confirm calls onConfirm synchronously inside the click', async () => {
  const { h, calls } = await mountDialog()
  try {
    const btn = q('[data-testid="vault-zip-export-confirm"]')
    let syncCalls = null
    await act(async () => {
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      syncCalls = [...calls]
    })
    assert.deepEqual(syncCalls.slice(0, 1), ['confirm'], 'onConfirm ran within the click dispatch')
  } finally { await h.unmount() }
})

test('DLG-3 Cancel, Escape and the close button call onClose only', async () => {
  for (const how of ['cancel', 'escape', 'x']) {
    const { h, calls } = await mountDialog()
    try {
      if (how === 'cancel') {
        const b = [...dom.window.document.querySelectorAll('button')].find((x) => x.textContent.trim() === t('cancel'))
        await act(async () => b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      } else if (how === 'escape') {
        await pressKey(dom, 'Escape')
      } else {
        const b = q(`button[aria-label="${t('close')}"]`)
        await act(async () => b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      }
      assert.ok(calls.includes('close'), how)
      assert.ok(!calls.includes('confirm'), how)
    } finally { await h.unmount() }
  }
})

test('DLG-4 a Vault lock (purge disposer) closes the dialog', async () => {
  const { h, calls, disposers } = await mountDialog()
  try {
    assert.ok(disposers.length >= 1)
    await act(async () => { for (const d of disposers) d() })
    assert.deepEqual(calls, ['close'])
  } finally { await h.unmount() }
})
